/**
 * Внешняя авторизация RH—MUSIC: Google, VK ID, Apple ID.
 *
 * Принципы:
 *  • внутренний аккаунт всегда users.id, провайдер — лишь один из способов входа;
 *  • личность подтверждает только сервер: ID Token проверяется по JWKS (подпись,
 *    iss, aud, exp, nonce), коды VK/Apple обмениваются на сервере;
 *  • state/nonce одноразовые (таблица oauth_states), PKCE для VK;
 *  • email сам по себе НЕ объединяет аккаунты — только явная привязка после входа;
 *  • после проверки выдаётся обычная серверная сессия RH—MUSIC (HttpOnly cookie).
 *
 * Секреты провайдеров живут только в переменных окружения Worker.
 */

import {
  ApiError, json, readJson, requireCsrf, randomHex, sha256Hex, normalizeEmail,
  base64urlEncodeText, base64urlDecodeText, pemToBuffer, originAllowed,
} from './http.js';
import * as store from './store.js';
import { currentUser, requireUser, issueSession, publicUser, requireReauth } from './auth.js';

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_JWKS = 'https://appleid.apple.com/auth/keys';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const APPLE_ISSUER = 'https://appleid.apple.com';

const STATE_TTL_SECONDS = 600;
const PROVIDERS = ['google', 'vk', 'apple'];

/* ───────────────────────────── конфигурация ───────────────────────────── */

function siteOrigin(request, env) {
  const configured = String(env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const origin = new URL(request.url).origin;
  return originAllowed(origin) ? origin : 'https://rh-music.pages.dev';
}

export function providerConfig(env, request) {
  const base = siteOrigin(request, env);
  return {
    google: {
      id: 'google',
      title: 'Google',
      clientId: env.GOOGLE_CLIENT_ID || null,
      enabled: !!env.GOOGLE_CLIENT_ID,
      redirectUri: base + '/api/auth/oauth/google/callback',
    },
    vk: {
      id: 'vk',
      title: 'VK ID',
      clientId: env.VK_CLIENT_ID || null,
      enabled: !!(env.VK_CLIENT_ID && env.VK_CLIENT_SECRET),
      redirectUri: base + '/api/auth/oauth/vk/callback',
    },
    apple: {
      id: 'apple',
      title: 'Apple',
      clientId: env.APPLE_CLIENT_ID || null,
      enabled: !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY),
      redirectUri: base + '/api/auth/oauth/apple/callback',
    },
  };
}

function providerOrThrow(config, id) {
  const provider = config[id];
  if (!provider) throw new ApiError(404, 'UNKNOWN_PROVIDER', 'Неизвестный способ входа.');
  if (!provider.enabled) {
    throw new ApiError(503, 'PROVIDER_DISABLED',
      'Этот способ входа пока не подключён: не заданы ключи приложения.');
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

/**
 * Полная серверная проверка ID Token: подпись по JWKS, issuer, audience, сроки,
 * nonce и (для Google) подтверждённый email.
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
    throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Провайдер не подтвердил email.');
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
  // Скрытый email Apple или занятый адрес: внутренний адрес-заглушка,
  // настоящий email провайдера остаётся в oauth_identities.provider_email.
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

/**
 * Находит или создаёт внутренний аккаунт для подтверждённой личности.
 * Возвращает { user, created }.
 */
async function resolveAccount(env, provider, profile, { linkUserId = null } = {}) {
  const subject = String(profile.subject || '');
  if (!subject) throw new ApiError(401, 'NO_SUBJECT', 'Провайдер не сообщил идентификатор пользователя.');

  const existing = await store.findIdentity(env, provider, subject);

  if (linkUserId) {
    if (existing && Number(existing.user_id) !== Number(linkUserId)) {
      throw new ApiError(409, 'IDENTITY_TAKEN',
        'Этот аккаунт уже привязан к другому пользователю RH—MUSIC.');
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
    const user = {
      id: existing.user_id,
      username: existing.username,
      email: existing.email,
      display_name: existing.display_name,
      created_at: existing.user_created_at,
    };
    return { user, created: false };
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

/* ───────────────────────────── выдача ответов ───────────────────────────── */

function redirect(url, cookie) {
  const headers = { Location: url, 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

function siteRedirect(request, env, query) {
  return siteOrigin(request, env) + '/#/login?' + query;
}

function failRedirect(request, env, code, extra = '') {
  return redirect(siteRedirect(request, env, `oauth=error&code=${encodeURIComponent(code)}${extra}`));
}

/* ───────────────────────────── состояния ───────────────────────────── */

async function createState(env, { provider, mode, linkUserId, redirectUri }) {
  const state = randomHex(24);
  const nonce = randomHex(24);
  const codeVerifier = provider === 'vk' ? randomHex(32) : null;
  const deviceId = provider === 'vk' ? randomHex(8) : null;
  await store.insertOAuthState(env, {
    state,
    provider,
    mode,
    nonce,
    codeVerifier: codeVerifier ? JSON.stringify({ v: codeVerifier, d: deviceId }) : null,
    redirectUri,
    linkUserId,
    ttlSeconds: STATE_TTL_SECONDS,
  });
  return { state, nonce, codeVerifier, deviceId };
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ───────────────────────────── Google ───────────────────────────── */

export async function handleGoogleLogin(request, env) {
  requireCsrf(request);
  const config = providerConfig(env, request);
  const provider = providerOrThrow(config, 'google');

  const body = await readJson(request);
  const state = String(body.state || '');
  const credential = String(body.credential || '');
  if (!state || !credential) throw new ApiError(400, 'VALIDATION', 'Не передан токен Google.');

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
  const session = await issueSession(env, request, user);
  await store.addReauth(env, user.id, 'google').catch(() => {});

  return json(
    {
      ok: true,
      user: publicUser(user),
      created: !!created,
      linked: !!linked,
      provider: 'google',
    },
    200,
    { 'Set-Cookie': session.cookie },
  );
}

/* ───────────────────────────── VK ID ───────────────────────────── */

export async function handleVkStart(request, env) {
  requireCsrf(request);
  const config = providerConfig(env, request);
  const provider = providerOrThrow(config, 'vk');

  const body = await readJson(request).catch(() => ({}));
  const mode = body.mode === 'link' ? 'link' : 'login';
  const user = await currentUser(request, env);
  if (mode === 'link' && !user) throw new ApiError(401, 'UNAUTHORIZED', 'Требуется вход в аккаунт.');

  const { state, codeVerifier, deviceId } = await createState(env, {
    provider: 'vk',
    mode,
    linkUserId: mode === 'link' ? user.id : null,
    redirectUri: provider.redirectUri,
  });

  const url = new URL('https://id.vk.com/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', provider.redirectUri);
  url.searchParams.set('scope', 'email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await pkceChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('device_id', deviceId);
  url.searchParams.set('v', '2.1');

  return json({ ok: true, url: url.toString(), state });
}

export async function handleVkCallback(request, env, url) {
  const config = providerConfig(env, request);
  const state = String(url.searchParams.get('state') || '');
  const code = String(url.searchParams.get('code') || '');
  const deviceIdParam = String(url.searchParams.get('device_id') || '');
  const error = url.searchParams.get('error');

  if (error) return failRedirect(request, env, 'vk_denied');
  if (!state || !code) return failRedirect(request, env, 'vk_failed');

  const row = await store.consumeOAuthState(env, state);
  if (!row || row.provider !== 'vk') return failRedirect(request, env, 'state_expired');

  const config2 = config.vk;
  if (!config2.enabled) return failRedirect(request, env, 'provider_disabled');

  let packed = {};
  try { packed = JSON.parse(row.code_verifier || '{}'); } catch { packed = {}; }

  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('code', code);
  form.set('client_id', config2.clientId);
  form.set('client_secret', env.VK_CLIENT_SECRET);
  form.set('code_verifier', packed.v || '');
  form.set('redirect_uri', row.redirect_uri || config2.redirectUri);
  form.set('device_id', deviceIdParam || packed.d || '');

  let tokens;
  try {
    const response = await fetch('https://id.vk.com/oauth2/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    tokens = await response.json();
    if (!response.ok || tokens.error) throw new Error('exchange failed');
  } catch {
    return failRedirect(request, env, 'vk_exchange');
  }

  const subject = String(tokens.user_id || '');
  if (!subject) return failRedirect(request, env, 'vk_failed');

  let profile = { subject, email: '', name: '', username: 'vk' + subject };
  try {
    const infoForm = new URLSearchParams();
    infoForm.set('access_token', tokens.access_token);
    infoForm.set('client_id', config2.clientId);
    const infoResponse = await fetch('https://id.vk.com/oauth2/user_info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: infoForm.toString(),
    });
    const info = await infoResponse.json();
    const user = info.user || {};
    profile = {
      subject,
      email: user.email || '',
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || '',
      username: user.email ? String(user.email).split('@')[0] : 'vk' + subject,
    };
  } catch { /* профиль не обязателен: subject уже получен */ }

  const linkUserId = row.mode === 'link' ? Number(row.link_user_id) : null;
  try {
    const { user, created } = await resolveAccount(env, 'vk', profile, { linkUserId });
    const session = await issueSession(env, request, user);
    await store.addReauth(env, user.id, 'vk').catch(() => {});
    const target = linkUserId
      ? siteOrigin(request, env) + '/#/account?linked=vk'
      : siteOrigin(request, env) + '/#/' + (created ? '?welcome=1' : '');
    return redirect(target, session.cookie);
  } catch (err) {
    const codeName = err instanceof ApiError ? err.code : 'server';
    return failRedirect(request, env, codeName === 'IDENTITY_TAKEN' ? 'identity_taken' : 'server');
  }
}

/* ───────────────────────────── Apple ───────────────────────────── */

export async function handleAppleStart(request, env) {
  requireCsrf(request);
  const config = providerConfig(env, request);
  const provider = providerOrThrow(config, 'apple');

  const body = await readJson(request).catch(() => ({}));
  const mode = body.mode === 'link' ? 'link' : 'login';
  const user = await currentUser(request, env);
  if (mode === 'link' && !user) throw new ApiError(401, 'UNAUTHORIZED', 'Требуется вход в аккаунт.');

  const { state, nonce } = await createState(env, {
    provider: 'apple',
    mode,
    linkUserId: mode === 'link' ? user.id : null,
    redirectUri: provider.redirectUri,
  });

  const url = new URL('https://appleid.apple.com/auth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', provider.redirectUri);
  url.searchParams.set('scope', 'name email');
  url.searchParams.set('response_mode', 'form_post');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);

  return json({ ok: true, url: url.toString(), state });
}

async function appleClientSecret(env, provider) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: env.APPLE_KEY_ID };
  const payload = {
    iss: env.APPLE_TEAM_ID,
    iat: now,
    exp: now + 600,
    aud: 'https://appleid.apple.com',
    sub: provider.clientId,
  };
  const unsigned = base64urlEncodeText(JSON.stringify(header)) + '.' + base64urlEncodeText(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuffer(env.APPLE_PRIVATE_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  let binary = '';
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  const sig = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return unsigned + '.' + sig;
}

export async function handleAppleCallback(request, env) {
  const config = providerConfig(env, request);
  const provider = config.apple;

  let body = {};
  const contentType = request.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await request.text();
      body = Object.fromEntries(new URLSearchParams(text));
    } else {
      body = await readJson(request);
    }
  } catch {
    body = {};
  }

  const state = String(body.state || '');
  const code = String(body.code || '');
  const idToken = String(body.id_token || '');
  if (body.error) return failRedirect(request, env, 'apple_denied');
  if (!state) return failRedirect(request, env, 'state_expired');

  const row = await store.consumeOAuthState(env, state);
  if (!row || row.provider !== 'apple') return failRedirect(request, env, 'state_expired');
  if (!provider.enabled) return failRedirect(request, env, 'provider_disabled');

  let payload = null;
  if (idToken) {
    try {
      payload = await verifyIdToken(idToken, {
        jwksUrl: APPLE_JWKS,
        issuers: [APPLE_ISSUER],
        audience: provider.clientId,
        nonce: row.nonce,
      });
    } catch {
      return failRedirect(request, env, 'apple_token');
    }
  } else if (code) {
    try {
      const form = new URLSearchParams();
      form.set('grant_type', 'authorization_code');
      form.set('code', code);
      form.set('redirect_uri', row.redirect_uri || provider.redirectUri);
      form.set('client_id', provider.clientId);
      form.set('client_secret', await appleClientSecret(env, provider));
      const response = await fetch('https://appleid.apple.com/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      });
      const tokens = await response.json();
      if (!response.ok || !tokens.id_token) throw new Error('exchange failed');
      payload = await verifyIdToken(tokens.id_token, {
        jwksUrl: APPLE_JWKS,
        issuers: [APPLE_ISSUER],
        audience: provider.clientId,
        nonce: row.nonce,
      });
    } catch {
      return failRedirect(request, env, 'apple_exchange');
    }
  } else {
    return failRedirect(request, env, 'apple_failed');
  }

  let name = '';
  if (body.user) {
    try {
      const parsed = JSON.parse(body.user);
      name = [parsed.name && parsed.name.firstName, parsed.name && parsed.name.lastName].filter(Boolean).join(' ');
    } catch { /* Apple присылает user только при первом входе */ }
  }

  const profile = {
    subject: String(payload.sub || ''),
    email: payload.email || '',
    name,
    username: (payload.email || '').split('@')[0] || 'apple',
  };

  const linkUserId = row.mode === 'link' ? Number(row.link_user_id) : null;
  try {
    const { user, created } = await resolveAccount(env, 'apple', profile, { linkUserId });
    const session = await issueSession(env, request, user);
    await store.addReauth(env, user.id, 'apple').catch(() => {});
    const target = linkUserId
      ? siteOrigin(request, env) + '/#/account?linked=apple'
      : siteOrigin(request, env) + '/#/' + (created ? '?welcome=1' : '');
    return redirect(target, session.cookie);
  } catch (err) {
    const codeName = err instanceof ApiError ? err.code : 'server';
    return failRedirect(request, env, codeName === 'IDENTITY_TAKEN' ? 'identity_taken' : 'server');
  }
}

/* ───────────────────────────── состояние входов ───────────────────────────── */

export async function handleProviders(request, env) {
  const config = providerConfig(env, request);
  return json({
    ok: true,
    providers: PROVIDERS.map((id) => ({
      id,
      title: config[id].title,
      enabled: config[id].enabled,
      // Публичный client_id нужен Google Identity Services на клиенте.
      clientId: id === 'google' ? config[id].clientId : null,
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

export async function handleUnlink(request, env) {
  requireCsrf(request);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const provider = String(body.provider || '');
  if (!PROVIDERS.includes(provider)) throw new ApiError(400, 'BAD_PROVIDER', 'Неизвестный способ входа.');

  await requireReauth(env, user, body);

  const [identities, password] = await Promise.all([
    store.listIdentities(env, user.id),
    store.hasPassword(env, user.id),
  ]);
  const has = identities.some((row) => row.provider === provider);
  if (!has) throw new ApiError(404, 'NOT_LINKED', 'Этот способ входа не привязан.');

  const remaining = identities.filter((row) => row.provider !== provider).length + (password ? 1 : 0);
  if (remaining < 1) {
    throw new ApiError(409, 'LAST_METHOD',
      'Это последний способ входа. Сначала привяжите другой или задайте пароль.');
  }

  await store.deleteIdentity(env, user.id, provider);
  return json({ ok: true, removed: provider });
}

/** Одноразовый nonce для Google Identity Services (и для входа, и для привязки). */
export async function handleGoogleNonce(request, env) {
  requireCsrf(request);
  const config = providerConfig(env, request);
  providerOrThrow(config, 'google');
  const body = await readJson(request).catch(() => ({}));
  const mode = body.mode === 'link' ? 'link' : 'login';
  const user = await currentUser(request, env);
  if (mode === 'link' && !user) throw new ApiError(401, 'UNAUTHORIZED', 'Требуется вход в аккаунт.');

  const { state, nonce } = await createState(env, {
    provider: 'google',
    mode,
    linkUserId: mode === 'link' ? user.id : null,
    redirectUri: config.google.redirectUri,
  });
  return json({ ok: true, state, nonce, mode });
}