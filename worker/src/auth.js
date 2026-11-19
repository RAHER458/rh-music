/**
 * Аккаунты и сессии: регистрация, вход, выход, профиль, смена пароля.
 *
 * Безопасность:
 *  • PBKDF2-SHA256, индивидуальная соль, хеш никогда не покидает сервер;
 *  • сессия — случайный токен в HttpOnly/Secure/SameSite=Lax cookie, в D1 хранится только SHA-256 хеш;
 *  • CSRF — проверка Origin + обязательный заголовок X-RH-Request;
 *  • ограничение частоты попыток входа и регистрации по IP;
 *  • все входные данные валидируются на сервере.
 */

import {
  ApiError, json, readJson, requireCsrf, hashPassword, randomHex, sha256Hex,
  sessionCookie, clearCookie, parseCookies, validateRegistration, timingSafeEqual,
  normalizeEmail,
} from './http.js';
import * as store from './store.js';

const PASSWORD_ITERATIONS = 100000;
const SESSION_COOKIE = 'rh_session';
const SESSION_DAYS = 30;
const SESSION_TOUCH_MINUTES = 10;

const LIMITS = {
  register: { max: 6, windowMinutes: 30 },
  login: { max: 12, windowMinutes: 15 },
};

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'unknown';
}

async function enforceRateLimit(env, request, action) {
  const rule = LIMITS[action];
  if (!rule) return;
  const ip = clientIp(request);
  const attempts = await store.countAttempts(env, ip, action, rule.windowMinutes);
  if (attempts >= rule.max) {
    throw new ApiError(429, 'RATE_LIMITED',
      'Слишком много попыток. Попробуйте позже.', `Лимит: ${rule.max} за ${rule.windowMinutes} мин.`);
  }
}

async function noteAttempt(env, request, action) {
  await store.logAttempt(env, clientIp(request), action);
  if (Math.random() < 0.05) await store.pruneAttempts(env);
}

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name || row.username,
    createdAt: row.created_at,
  };
}

/** Текущий пользователь по cookie. Возвращает null для гостя. */
export async function currentUser(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token || token.length < 20) return null;

  const tokenHash = await sha256Hex(token);
  const session = await store.findSession(env, tokenHash);
  if (!session) return null;

  const lastSeen = Date.parse(session.expires_at) - SESSION_DAYS * 86400000;
  if (Date.now() - lastSeen > SESSION_TOUCH_MINUTES * 60000) {
    await store.touchSession(env, session.session_id).catch(() => {});
  }

  return {
    id: session.user_id,
    username: session.username,
    email: session.email,
    display_name: session.display_name,
    created_at: session.created_at,
    sessionId: session.session_id,
    tokenHash,
  };
}

export async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Требуется вход в аккаунт.');
  return user;
}

async function createSessionResponse(env, request, user, extra = {}) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await store.insertSession(env, {
    id: randomHex(16),
    userId: user.id,
    tokenHash,
    expiresAt,
    userAgent: request.headers.get('User-Agent') || '',
    ip: clientIp(request),
  });
  return json(
    { ok: true, user: publicUser(user), ...extra },
    200,
    { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) },
  );
}

/* ───────────────────────────── регистрация ───────────────────────────── */

export async function handleRegister(request, env) {
  requireCsrf(request);
  await enforceRateLimit(env, request, 'register');

  const body = await readJson(request);
  const check = validateRegistration({
    username: body.username,
    email: body.email,
    password: body.password,
    confirm: body.confirmPassword ?? body.confirm,
  });

  if (!check.ok) {
    await noteAttempt(env, request, 'register');
    throw new ApiError(400, 'VALIDATION', check.errors[0], check.errors.join(' '));
  }

  const { username, email, password } = check.values;
  const existingEmail = await store.findUserByEmailOrName(env, email, '');
  if (existingEmail) throw new ApiError(409, 'EMAIL_TAKEN', 'Этот email уже зарегистрирован.');
  const existingName = await store.findUserByEmailOrName(env, '', username);
  if (existingName) throw new ApiError(409, 'USERNAME_TAKEN', 'Такое имя пользователя уже занято.');

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt, PASSWORD_ITERATIONS);
  const id = await store.insertUser(env, { username, email, hash, salt, iterations: PASSWORD_ITERATIONS });
  await noteAttempt(env, request, 'register');

  const user = { id, username, email, display_name: username, created_at: new Date().toISOString() };
  return createSessionResponse(env, request, user, { created: true });
}

/* ───────────────────────────── вход ───────────────────────────── */

export async function handleLogin(request, env) {
  requireCsrf(request);
  await enforceRateLimit(env, request, 'login');

  const body = await readJson(request);
  const login = String(body.login || body.email || '').trim();
  const password = String(body.password || '');
  if (!login || !password) throw new ApiError(400, 'VALIDATION', 'Укажите логин и пароль.');

  const row = await store.findUserByLogin(env, normalizeEmail(login));
  const genericError = new ApiError(401, 'BAD_CREDENTIALS', 'Неверный логин или пароль.');

  if (!row) {
    await noteAttempt(env, request, 'login');
    // Выравниваем время ответа, чтобы нельзя было определить существование аккаунта.
    await hashPassword(password, '00'.repeat(16), PASSWORD_ITERATIONS);
    throw genericError;
  }

  const hash = await hashPassword(password, row.password_salt, row.iterations || PASSWORD_ITERATIONS);
  if (!timingSafeEqual(hash, row.password_hash)) {
    await noteAttempt(env, request, 'login');
    throw genericError;
  }

  await noteAttempt(env, request, 'login');
  return createSessionResponse(env, request, row);
}

/* ───────────────────────────── выход ───────────────────────────── */

export async function handleLogout(request, env) {
  requireCsrf(request);
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    const tokenHash = await sha256Hex(token);
    await store.deleteSession(env, tokenHash);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

/* ───────────────────────────── профиль ───────────────────────────── */

export async function handleMe(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ ok: true, user: null });
  const [libraryCount, stats, preferences] = await Promise.all([
    store.libraryCount(env, user.id),
    store.userHistoryStats(env, user.id),
    store.getPreferences(env, user.id),
  ]);
  return json({
    ok: true,
    user: publicUser(user),
    stats: {
      library: libraryCount,
      plays: (stats && stats.plays) || 0,
      tracks: (stats && stats.tracks) || 0,
      lastPlayedAt: (stats && stats.lastAt) || null,
    },
    preferences: { repeat: preferences.repeat_mode, shuffle: !!preferences.shuffle },
  });
}

export async function handleUpdateProfile(request, env) {
  requireCsrf(request);
  const user = await requireUser(request, env);
  const body = await readJson(request);

  const displayName = body.displayName == null ? null : String(body.displayName).trim().slice(0, 40);
  const email = body.email == null ? null : normalizeEmail(body.email);

  if (displayName !== null && displayName.length < 2) {
    throw new ApiError(400, 'VALIDATION', 'Имя слишком короткое.');
  }
  if (email !== null) {
    if (!/^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
      throw new ApiError(400, 'VALIDATION', 'Укажите корректный email.');
    }
    const existing = await store.findUserByEmailOrName(env, email, '');
    if (existing && existing.id !== user.id) throw new ApiError(409, 'EMAIL_TAKEN', 'Этот email уже занят.');
  }

  await store.updateUser(env, user.id, { displayName, email });
  const updated = await store.findUserById(env, user.id);
  return json({ ok: true, user: publicUser(updated) });
}

export async function handleChangePassword(request, env) {
  requireCsrf(request);
  const user = await requireUser(request, env);
  const body = await readJson(request);

  const current = String(body.currentPassword || '');
  const next = String(body.newPassword || '');
  if (next.length < 8 || !/[A-Za-zА-Яа-я]/.test(next) || !/[0-9]/.test(next)) {
    throw new ApiError(400, 'VALIDATION', 'Новый пароль: минимум 8 символов, буквы и цифры.');
  }

  const row = await store.findUserById(env, user.id);
  const full = await store.findUserByLogin(env, row.email);
  const hash = await hashPassword(current, full.password_salt, full.iterations || PASSWORD_ITERATIONS);
  if (!timingSafeEqual(hash, full.password_hash)) {
    throw new ApiError(401, 'BAD_CREDENTIALS', 'Текущий пароль указан неверно.');
  }

  const salt = randomHex(16);
  const newHash = await hashPassword(next, salt, PASSWORD_ITERATIONS);
  await store.updatePassword(env, user.id, { hash: newHash, salt, iterations: PASSWORD_ITERATIONS });
  return json({ ok: true });
}

export async function handleDeleteAccount(request, env) {
  requireCsrf(request);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const password = String(body.password || '');

  const full = await store.findUserByLogin(env, user.email);
  const hash = await hashPassword(password, full.password_salt, full.iterations || PASSWORD_ITERATIONS);
  if (!timingSafeEqual(hash, full.password_hash)) {
    throw new ApiError(401, 'BAD_CREDENTIALS', 'Пароль указан неверно.');
  }

  await store.deleteAllUserData(env, user.id);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

export async function handlePreferences(request, env) {
  requireCsrf(request);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const repeat = ['off', 'all', 'one'].includes(body.repeat) ? body.repeat : 'off';
  await store.savePreferences(env, user.id, { repeat, shuffle: !!body.shuffle });
  return json({ ok: true, preferences: { repeat, shuffle: !!body.shuffle } });
}