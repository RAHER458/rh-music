/**
 * Внешняя авторизация RH—MUSIC — только Google (Google Identity Services).
 *
 * Как это работает:
 *  1. frontend получает Google ID Token через GIS и передаёт credential на сервер;
 *  2. сервер сам проверяет подпись по официальным JWKS Google, issuer, audience,
 *     сроки, nonce и подтверждение email;
 *  3. по паре (provider, provider_subject) находится существующий аккаунт RH—MUSIC
 *     или создаётся новый;
 *  4. выдаётся обычная серверная сессия RH—MUSIC (HttpOnly cookie).
 *
 * Принципы:
 *  • внутренний аккаунт всегда users.id, Google — лишь способ входа;
 *  • state/nonce одноразовые (таблица oauth_states) — защита от replay и CSRF;
 *  • email сам по себе НЕ объединяет аккаунты — только явная привязка из сессии;
 *  • приватные данные и токены провайдера остаются на сервере.
 */

import {
  ApiError, json, readJson, requireCsrf, randomHex, sha256Hex, normalizeEmail,
  base64urlDecodeText,
} from './http.js';
import * as store from './store.js';
import { currentUser, requireUser, issueSession, publicUser, requireReauth } from './auth.js';

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

const STATE_TTL_SECONDS = 600;
const PROVIDERS = ['google'];

/* ───────────────────────────── конфигурация ───────────────────────────── */

export function providerConfig(env) {
  return {
    google: {
      id: 'google',
      title: 'Google',
      clientId: env.GOOGLE_CLIENT_ID || null,
      enabled: !!env.GOOGLE_CLIENT_ID,
    },
  };
}

function providerOrThrow(config, id) {
  const provider = config[id];
  if (!provider) throw new ApiError(404, 'UNKNOWN_PROVIDER', 'Неизвестный способ входа.');
  if (!provider.enabled) {
    throw new ApiError(503, 'PROVIDER_DISABLED',
      'Вход через Google пока не подключён: на сервере не задан GOOGLE_CLIENT_ID.');
  }
  return provider;
}

/* ───────────────────────────── JWT / JWKS ───────────────────────────── */

const jwksCache = new Map();

async function getJwks(url) {
  const hit = jwksCache.get(url);
  if (hit && Date.now() - hit.at < 3600_000) return hit.keys;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new ApiError(502, 'JWKS_UNAVAILABLE', 'Не удалось получить ключи провайдера.');
  const body = await response.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(url, { at: Date.now(), keys });
  return keys;
}

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new ApiError(401, 'BAD_TOKEN', 'Некорректный токен провайдера.');
  let header;
  let payload;
  try {
    header = JSON.parse(base64urlDecodeText(parts[0]));
    payload = JSON.parse(base64urlDecodeText(parts[1]));
  } catch {
    throw new ApiError(401, 'BAD_TOKEN', 'Некорректный токен провайдера.');
  }
  return { header, payload, parts };
}

function base64urlToBytesSafe(value) {
  try {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

async function verifySignature(header, parts, keys) {
  const candidate = keys.filter((key) => key && key.kid === header.kid);
  const list = candidate.length ? candidate : keys;
  const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const signature = base64urlToBytesSafe(parts[2]);

  for (const jwk of list) {
    try {
      if (header.alg === 'RS256' && jwk.kty === 'RSA') {
        const key = await crypto.subtle.importKey(
          'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
        );
        if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data)) return true;
      } else if (header.alg === 'ES256' && jwk.kty === 'EC') {
        const key = await crypto.subtle.importKey(
          'jwk', jwk, { name: 'ECDSA', namedCurve: jwk.crv || 'P-256' }, false, ['verify'],
        );
        if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data)) return true;
      }
    } catch { /* пробуем следующий ключ */ }
  }
  return false;
}

/**
 * Полная серверная проверка Google ID Token: подпись по JWKS, issuer, audience,
 * сроки, nonce и подтверждённый email. Экспортируется для тестов.
 */
export async function verifyIdToken(token, { jwksUrl, issuers, audience, nonce, requireVerifiedEmail = false, skewSeconds = 90 }) {
  const { header, payload, parts } = decodeJwt(token);
  if (header.alg !== 'RS256' && header.alg !== 'ES256') {
    throw new ApiError(401, 'BAD_ALG', 'Неподдерживаемый алгоритм подписи токена.');
  }
  if (header.typ && String(header.typ).toLowerCase() !== 'jwt') {
    throw new ApiError(401, 'BAD_TOKEN', 'Некорректный тип токена.');
  }

  const keys = await getJwks(jwksUrl);
  if (!(await verifySignature(header, parts, keys))) {
    throw new ApiError(401, 'BAD_SIGNATURE', 'Подпись токена провайдера не подтверждена.');
  }

  const now = Math.floor(Date.now() / 1000);
  const iss = String(payload.iss || '');
  if (!issuers.includes(iss)) throw new ApiError(401, 'BAD_ISSUER', 'Токен выдан неизвестным издателем.');

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.map(String).includes(String(audience))) {
    throw new ApiError(401, 'BAD_AUDIENCE', 'Токен выдан для другого приложения.');
  }

  if (!payload.exp || Number(payload.exp) + skewSeconds < now) {
    throw new ApiError(401, 'EXPIRED', 'Срок действия токена истёк.');
  }
  if (payload.iat && Number(payload.iat) - skewSeconds > now) {
    throw new ApiError(401, 'BAD_IAT', 'Некорректное время выпуска токена.');
  }
  if (payload.nbf && Number(payload.nbf) - skewSeconds > now) {
    throw new ApiError(401, 'NOT_YET_VALID', 'Токен ещё не вступил в силу.');
  }

  if (nonce) {
    const tokenNonce = String(payload.nonce || '');
    const hashed = await sha256Hex(nonce);
    if (tokenNonce !== nonce && tokenNonce !== hashed) {
      throw new ApiError(401, 'BAD_NONCE', 'Не совпал одноразовый параметр входа.');
    }
  }

  if (requireVerifiedEmail && payload.email_verified === false) {
    throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Google не подтвердил email.');
  }

  return payload;
}

/* ───────────────────────────── аккаунт по внешнему профилю ───────────────────────────── */

async function uniqueUsername(env, desired) {
  const base = String(desired || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '')
    .replace(/^[._-]+/, '')
    .slice(0, 18) || 'listener';
  const safe = base.length >= 3 ? base : 'user';
  for (let i = 0; i < 40; i++) {
    const candidate = i === 0 ? safe : `${safe}${i + 1}`;
    if (!(await store.usernameTaken(env, candidate))) return candidate;
  }
  return `user${randomHex(3)}`;
}

async function pickEmail(env, provider, profile) {
  const email = normalizeEmail(profile.email || '');
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !(await store.emailTaken(env, email))) {
    return email;
  }
  // Совпал с чужим адресом: внутренний адрес-заглушка, настоящий email
  // остаётся в oauth_identities.provider_email. Аккаунты по email НЕ объединяются.
  const hash = (await sha256Hex(provider + ':' + profile.subject)).slice(0, 10);
  return `${provider}-${hash}@users.rh-music.local`;
}

function displayNameFrom(profile) {
  const name = String(profile.name || '').trim();
  if (name) return name.slice(0, 40);
  const email = String(profile.email || '').trim();
  if (email.includes('@')) return email.split('@')[0].slice(0, 40);
  return 'Слушатель';
}

/** Находит или создаёт внутренний аккаунт для подтверждённой личности Google. */
async function resolveAccount(env, provider, profile, { linkUserId = null } = {}) {
  const subject = String(profile.subject || '');
  if (!subject) throw new ApiError(401, 'NO_SUBJECT', 'Google не сообщил идентификатор пользователя.');

  const existing = await store.findIdentity(env, provider, subject);

  if (linkUserId) {
    if (existing && Number(existing.user_id) !== Number(linkUserId)) {
      throw new ApiError(409, 'IDENTITY_TAKEN',
        'Этот аккаунт Google уже привязан к другому пользователю RH—MUSIC.');
    }
    if (!existing) {
      await store.insertIdentity(env, {
        userId: linkUserId,
        provider,
        subject,
        email: profile.email || null,
        name: profile.name || null,
      });
    }
    const user = await store.findUserById(env, linkUserId);
    if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'Аккаунт не найден.');
    return { user, created: false, linked: !existing };
  }

  if (existing) {
    await store.touchIdentity(env, provider, subject, { email: profile.email, name: profile.name });
    return {
      user: {
        id: existing.user_id,
        username: existing.username,
        email: existing.email,
        display_name: existing.display_name,
        created_at: existing.user_created_at,
      },
      created: false,
    };
  }

  const username = await uniqueUsername(env, profile.username || profile.name || profile.email);
  const email = await pickEmail(env, provider, profile);
  const displayName = displayNameFrom(profile);
  const id = await store.insertOAuthUser(env, { username, email, displayName });
  await store.insertIdentity(env, {
    userId: id,
    provider,
    subject,
    email: profile.email || null,
    name: profile.name || null,
  });
  return {
    user: { id, username, email, display_name: displayName, created_at: new Date().toISOString() },
    created: true,
  };
}

/* ───────────────────────────── состояния (nonce/CSRF) ───────────────────────────── */

async function createState(env, { provider, mode, linkUserId }) {
  const state = randomHex(24);
  const nonce = randomHex(24);
  await store.insertOAuthState(env, {
    state,
    provider,
    mode,
    nonce,
    codeVerifier: null,
    redirectUri: null,
    linkUserId,
    ttlSeconds: STATE_TTL_SECONDS,
  });
  return { state, nonce };
}

/* ───────────────────────────── Google ───────────────────────────── */

/** Одноразовый nonce для Google Identity Services (и для входа, и для привязки). */
export async function handleGoogleNonce(request, env) {
  requireCsrf(request, env);
  const config = providerConfig(env);
  providerOrThrow(config, 'google');

  const body = await readJson(request).catch(() => ({}));
  const mode = body.mode === 'link' ? 'link' : 'login';
  const user = await currentUser(request, env);
  if (mode === 'link' && !user) throw new ApiError(401, 'UNAUTHORIZED', 'Требуется вход в аккаунт.');

  const { state, nonce } = await createState(env, {
    provider: 'google',
    mode,
    linkUserId: mode === 'link' ? user.id : null,
  });
  return json({ ok: true, state, nonce, mode });
}

/** Вход или привязка по Google ID Token, полученному на клиенте. */
export async function handleGoogleLogin(request, env) {
  requireCsrf(request, env);
  const config = providerConfig(env);
  const provider = providerOrThrow(config, 'google');

  const body = await readJson(request);
  const state = String(body.state || '');
  const credential = String(body.credential || '');
  if (!state || !credential) throw new ApiError(400, 'VALIDATION', 'Не передан токен Google.');

  // state одноразовый: повторная отправка того же credential не пройдёт.
  const row = await store.consumeOAuthState(env, state);
  if (!row || row.provider !== 'google') {
    throw new ApiError(400, 'BAD_STATE', 'Запрос входа устарел. Попробуйте снова.');
  }

  const payload = await verifyIdToken(credential, {
    jwksUrl: GOOGLE_JWKS,
    issuers: GOOGLE_ISSUERS,
    audience: provider.clientId,
    nonce: row.nonce,
    requireVerifiedEmail: true,
  });

  const profile = {
    subject: String(payload.sub || ''),
    email: payload.email || '',
    name: payload.name || '',
    username: (payload.email || '').split('@')[0],
  };

  const linkUserId = row.mode === 'link' ? Number(row.link_user_id) : null;
  if (linkUserId) {
    const current = await currentUser(request, env);
    if (!current || current.id !== linkUserId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Сессия истекла, повторите привязку.');
    }
  }

  const { user, created, linked } = await resolveAccount(env, 'google', profile, { linkUserId });
  const session = await issueSession(env, request, user, 'google');
  await store.addReauth(env, user.id, 'google').catch(() => {});

  return json(
    { ok: true, user: publicUser(user), created: !!created, linked: !!linked, provider: 'google' },
    200,
    { 'Set-Cookie': session.cookie },
  );
}

/* ───────────────────────────── состояние входов ───────────────────────────── */

export async function handleProviders(request, env) {
  const config = providerConfig(env);
  return json({
    ok: true,
    providers: PROVIDERS.map((id) => ({
      id,
      title: config[id].title,
      enabled: config[id].enabled,
      // Публичный client_id нужен Google Identity Services на клиенте.
      clientId: config[id].clientId,
    })),
  });
}

export async function handleIdentities(request, env) {
  const user = await requireUser(request, env);
  const [identities, password] = await Promise.all([
    store.listIdentities(env, user.id),
    store.hasPassword(env, user.id),
  ]);
  return json({
    ok: true,
    password,
    identities: identities.map((row) => ({
      provider: row.provider,
      email: row.email,
      name: row.name,
      linkedAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
    })),
  });
}

/**
 * Отвязка способа входа. Проверка «не последний способ» выполняется атомарно
 * в самом запросе к D1: удаление происходит только если остаётся другой
 * провайдер или пароль. Повторная аутентификация обязательна.
 */
export async function handleUnlink(request, env) {
  requireCsrf(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const provider = String(body.provider || '');
  if (!PROVIDERS.includes(provider)) throw new ApiError(400, 'BAD_PROVIDER', 'Неизвестный способ входа.');

  await requireReauth(env, user, body);

  const before = await store.listIdentities(env, user.id);
  if (!before.some((row) => row.provider === provider)) {
    throw new ApiError(404, 'NOT_LINKED', 'Этот способ входа не привязан.');
  }

  const removed = await store.unlinkIfNotLast(env, user.id, provider);
  if (!removed) {
    throw new ApiError(409, 'LAST_AUTH_METHOD',
      'Это последний способ входа. Сначала привяжите Google или задайте пароль.');
  }

  const [identities, password] = await Promise.all([
    store.listIdentities(env, user.id),
    store.hasPassword(env, user.id),
  ]);
  return json({
    ok: true,
    removed: provider,
    password,
    identities: identities.map((row) => ({
      provider: row.provider,
      email: row.email,
      name: row.name,
      linkedAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
    })),
  });
}