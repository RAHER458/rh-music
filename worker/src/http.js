/**
 * HTTP-утилиты, криптография и валидация для RH—MUSIC Worker.
 */

export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail || null;
  }
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function fail(status, code, message, detail) {
  return json({ ok: false, error: { code, message, detail: detail || null } }, status);
}

/* ───────────────────────────── CORS ───────────────────────────── */

function allowedOrigins(env) {
  const list = [];
  const site = env && env.SITE_URL ? String(env.SITE_URL).trim().replace(/\/+$/, '') : '';
  if (site) list.push(site);
  if (env && env.ALLOWED_ORIGINS) {
    for (const item of String(env.ALLOWED_ORIGINS).split(',')) {
      const value = item.trim().replace(/\/+$/, '');
      if (value) list.push(value);
    }
  }
  return list;
}

export function originAllowed(origin, env) {
  if (!origin) return false;
  let normalized = origin;
  try { normalized = new URL(origin).origin; } catch { return false; }
  return allowedOrigins(env).includes(normalized);
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, X-RH-Request',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (originAllowed(origin, env)) headers['Access-Control-Allow-Origin'] = new URL(origin).origin;
  return headers;
}

/** Заголовки безопасности для всех ответов Worker (API и служебных). */
export function securityHeaders() {
  return {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

export function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  return 'unknown';
}

/* ───────────────────────────── cookies ───────────────────────────── */

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export const SESSION_COOKIE = '__Host-rh_session';

export function sessionCookie(token, maxAgeSeconds) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Priority=High',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return attrs.join('; ');
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/* ───────────────────────────── криптография ───────────────────────────── */

export function bytesToHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function randomHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2 !== 0 || !clean) return new Uint8Array(0);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * PBKDF2-SHA256. Cloudflare Workers WebCrypto не поддерживает bcrypt/argon2,
 * и жёстко ограничивает PBKDF2 100 000 итераций — это максимум и используется.
 * Дополнительно хеш можно «поперчить» HMAC-SHA256 секретом PASSWORD_PEPPER:
 * без него украденная база не даёт проверять пароли офлайн.
 */
export async function hashPassword(password, saltHex, iterations, pepperHex = '') {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const salt = hexToBytes(saltHex);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  const derived = bytesToHex(new Uint8Array(bits));
  if (!pepperHex) return derived;
  const pepperKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(pepperHex),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', pepperKey, new TextEncoder().encode(derived));
  return bytesToHex(new Uint8Array(signature));
}

export function timingSafeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/* ───────────────────────────── base64url и PEM (JWT/OAuth) ───────────────────────────── */

export function bytesToBase64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64urlDecodeText(value) {
  return new TextDecoder().decode(base64urlToBytes(value));
}

export function base64urlEncodeText(text) {
  return bytesToBase64url(new TextEncoder().encode(text));
}

/** PEM (BEGIN PRIVATE KEY / BEGIN CERTIFICATE) → ArrayBuffer. */
export function pemToBuffer(pem) {
  const body = String(pem || '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('empty pem');
  return base64urlToBytes(body.replace(/\+/g, '-').replace(/\//g, '_')).buffer;
}

/* ───────────────────────────── валидация ───────────────────────────── */

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateRegistration({ username, email, password, confirm }) {
  const name = String(username || '').trim();
  const mail = normalizeEmail(email);
  const pass = String(password || '');
  const conf = String(confirm || '');

  const errors = [];
  if (!USERNAME_RE.test(name)) {
    errors.push('Имя пользователя: 3–24 символа, латиница, цифры, «_», «.», «-».');
  }
  if (!EMAIL_RE.test(mail) || mail.length > 190) errors.push('Укажите корректный email.');
  if (pass.length < 10) errors.push('Пароль должен содержать минимум 10 символов.');
  if (pass.length > 200) errors.push('Пароль слишком длинный.');
  if (pass !== conf) errors.push('Пароли не совпадают.');
  if (!/[A-Za-zА-Яа-я]/.test(pass) || !/[0-9]/.test(pass)) {
    errors.push('Пароль должен содержать буквы и цифры.');
  }
  return { ok: errors.length === 0, errors, values: { username: name, email: mail, password: pass } };
}

export async function readJson(request, limit = 20000) {
  const text = await request.text();
  if (text.length > limit) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Слишком большой запрос.');
  try {
    const parsed = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object') throw new Error('not object');
    return parsed;
  } catch {
    throw new ApiError(400, 'BAD_JSON', 'Некорректный формат запроса.');
  }
}

/* ───────────────────────────── метаданные трека ───────────────────────────── */

const ID_RE = /^(?:[0-9]{1,20}|sc:[0-9]{1,20})$/i;

export function sanitizeTrack(input) {
  if (!input || typeof input !== 'object') throw new ApiError(400, 'BAD_TRACK', 'Не передан трек.');
  const id = String(input.id || '');
  if (!ID_RE.test(id)) throw new ApiError(400, 'BAD_TRACK_ID', 'Некорректный идентификатор трека.');
  const str = (value, max) => {
    const s = value == null ? '' : String(value).slice(0, max).trim();
    return s;
  };
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n) : 0;
  };
  return {
    id,
    title: str(input.title, 300) || 'Без названия',
    artist: str(input.artist, 300),
    artistId: ID_RE.test(String(input.artistId || '')) ? String(input.artistId) : null,
    album: str(input.album, 300),
    albumId: ID_RE.test(String(input.albumId || '')) ? String(input.albumId) : null,
    cover: /^(https:\/\/cdn-image\.zvuk\.com\/|https:\/\/[a-z0-9-]+\.sndcdn\.com\/)/i.test(String(input.cover || '')) ? str(input.cover, 500) : null,
    duration: num(input.duration),
  };
}

export function requireSameOrigin(request, env) {
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite === 'cross-site') {
    throw new ApiError(403, 'BAD_ORIGIN', 'Запрос с недопустимого источника отклонён.');
  }
  const origin = request.headers.get('Origin');
  if (!origin) return; // внебраузерные клиенты без Origin, cookie всё ещё SameSite=Lax
  if (!originAllowed(origin, env)) {
    throw new ApiError(403, 'BAD_ORIGIN', 'Запрос с недопустимого источника отклонён.');
  }
}

export function requireCsrf(request, env) {
  requireSameOrigin(request, env);
  if (request.headers.get('X-RH-Request') !== '1') {
    throw new ApiError(403, 'CSRF', 'Отсутствует защитный заголовок запроса.');
  }
  if (!isHttps(request) && !isLocalhost(request)) {
    throw new ApiError(403, 'HTTPS_REQUIRED', 'Изменяющие запросы принимаются только по HTTPS.');
  }
}

export function isLocalhost(request) {
  try {
    const host = new URL(request.url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function isHttps(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}