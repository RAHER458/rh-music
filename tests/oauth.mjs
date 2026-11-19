/**
 * Тесты внешней авторизации RH—MUSIC (Google / VK ID / Apple ID).
 *
 * Запуск:  node tests/oauth.mjs
 *
 * Тесты работают на реальном SQLite (node:sqlite) с настоящими миграциями и
 * реальными обработчиками Worker. Провайдеры подменяются на уровне fetch:
 * JWKS отдаёт локально сгенерированный ключ, ID Token подписывается им же.
 * Так проверяется именно серверная логика проверки подписи/iss/aud/exp/nonce,
 * привязки и удаления — без сетевых секретов и без «фальшивого» входа.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/* ───────────────────────────── D1-совместимая обёртка ───────────────────────────── */

function makeD1(file = ':memory:') {
  const db = new DatabaseSync(file);
  const wrap = (sql) => {
    const stmt = db.prepare(sql);
    return {
      bind: (...params) => ({
        run: async () => {
          const r = stmt.run(...params);
          return { meta: { changes: Number(r.changes || 0), last_row_id: Number(r.lastInsertRowid || 0) } };
        },
        first: async () => stmt.get(...params) || null,
        all: async () => ({ results: stmt.all(...params) }),
        __stmt: stmt,
        __params: params,
      }),
      run: async () => {
        const r = stmt.run();
        return { meta: { changes: Number(r.changes || 0), last_row_id: Number(r.lastInsertRowid || 0) } };
      },
    };
  };
  return {
    db,
    prepare: (sql) => wrap(sql),
    batch: async (statements) => {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    exec: (sql) => db.exec(sql),
  };
}

function applyMigrations(D1) {
  for (const file of ['0001_init.sql', '0002_oauth_home.sql']) {
    const sql = readFileSync(join(root, 'worker/migrations', file), 'utf8');
    for (const statement of sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*(?:\r?\n|$)/)) {
      const trimmed = statement.trim();
      if (trimmed) D1.exec(trimmed);
    }
  }
}

/* ───────────────────────────── окружение ───────────────────────────── */

const D1 = makeD1();
applyMigrations(D1);

// Настоящий P-256 ключ для подписи Apple client_secret (как .p8 из Apple Developer).
const APPLE_KEY = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const applePkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', APPLE_KEY.privateKey)).toString('base64');
const APPLE_PEM = '-----BEGIN PRIVATE KEY-----\n' +
  applePkcs8.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';

const env = {
  DB: D1,
  SITE_URL: 'https://rh-music.pages.dev',
  GOOGLE_CLIENT_ID: 'test-google-client.apps.googleusercontent.com',
  VK_CLIENT_ID: '51999999',
  VK_CLIENT_SECRET: 'test-vk-secret',
  APPLE_CLIENT_ID: 'com.rh.music.service',
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_KEY_ID: 'KEY1234567',
  APPLE_PRIVATE_KEY: APPLE_PEM,
};

/* ───────────────────────────── ключи и JWT ───────────────────────────── */

const RSA = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', RSA.publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };

const OTHER = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');

async function signJwt(payload, { key = RSA.privateKey, kid = 'test-kid', alg = 'RS256' } = {}) {
  const header = b64u(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const data = new TextEncoder().encode(header + '.' + body);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data);
  return header + '.' + body + '.' + b64u(new Uint8Array(signature));
}

const now = () => Math.floor(Date.now() / 1000);

function googleClaims(overrides = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: env.GOOGLE_CLIENT_ID,
    sub: 'google-subject-1',
    email: 'oauth.user@example.com',
    email_verified: true,
    name: 'OAuth User',
    iat: now(),
    exp: now() + 3600,
    ...overrides,
  };
}

/* ───────────────────────────── подмена fetch ───────────────────────────── */

let fetchLog = [];
let vkTokenResponse = { access_token: 'vk-access', refresh_token: 'vk-refresh', user_id: '777001', expires_in: 3600 };
let vkUserInfo = { user: { user_id: 777001, first_name: 'Иван', last_name: 'Тестов', email: '' } };
let appleIdTokenFactory = null;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  fetchLog.push(url);
  if (url.includes('googleapis.com/oauth2')) {
    return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('appleid.apple.com/auth/keys')) {
    return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('id.vk.com/oauth2/auth')) {
    return new Response(JSON.stringify(vkTokenResponse), { headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('id.vk.com/oauth2/user_info')) {
    return new Response(JSON.stringify(vkUserInfo), { headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('appleid.apple.com/auth/token')) {
    const idToken = await appleIdTokenFactory();
    return new Response(JSON.stringify({ id_token: idToken, access_token: 'apple-access' }), { headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};

/* ───────────────────────────── импорт воркера ───────────────────────────── */

const oauth = await import(join(root, 'worker/src/oauth.js'));
const auth = await import(join(root, 'worker/src/auth.js'));

/* ───────────────────────────── утилиты теста ───────────────────────────── */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, extra = '') {
  if (condition) { passed++; return; }
  failed++;
  failures.push(name + (extra ? ' — ' + extra : ''));
  console.error('  ✗', name, extra);
}

function request(path, { method = 'POST', body, cookie } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-RH-Request': '1',
    Origin: 'https://rh-music.pages.dev',
    'CF-Connecting-IP': '203.0.113.7',
  };
  if (cookie) headers.Cookie = cookie;
  return new Request('https://rh-music.pages.dev' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieOf(response) {
  const raw = response.headers.get('Set-Cookie') || '';
  const match = /rh_session=([^;]+)/.exec(raw);
  return match ? 'rh_session=' + match[1] : null;
}

const rows = (sql, ...params) => {
  const stmt = D1.prepare(sql);
  return stmt.bind(...params).all().then((r) => r.results);
};
const one = (sql, ...params) => D1.prepare(sql).bind(...params).first();

console.log('RH—MUSIC · тесты внешней авторизации\n');

/* ───────────────────────────── 1. Проверка ID Token ───────────────────────────── */

{
  const nonce = 'nonce-abc';
  const token = await signJwt(googleClaims({ nonce }));
  const payload = await oauth.verifyIdToken(token, {
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['accounts.google.com', 'https://accounts.google.com'],
    audience: env.GOOGLE_CLIENT_ID,
    nonce,
  });
  check('валидный Google ID Token принимается', payload.sub === 'google-subject-1');

  const badKeyToken = await signJwt(googleClaims({ nonce }), { key: OTHER.privateKey });
  let error = null;
  try {
    await oauth.verifyIdToken(badKeyToken, {
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: ['https://accounts.google.com'], audience: env.GOOGLE_CLIENT_ID, nonce,
    });
  } catch (e) { error = e; }
  check('подпись чужим ключом отклоняется', error && error.code === 'BAD_SIGNATURE', error && error.code);

  const wrongAud = await signJwt(googleClaims({ nonce, aud: 'evil-client' }));
  error = null;
  try {
    await oauth.verifyIdToken(wrongAud, {
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: ['https://accounts.google.com'], audience: env.GOOGLE_CLIENT_ID, nonce,
    });
  } catch (e) { error = e; }
  check('чужой audience отклоняется', error && error.code === 'BAD_AUDIENCE', error && error.code);

  const wrongIss = await signJwt(googleClaims({ nonce, iss: 'https://evil.example' }));
  error = null;
  try {
    await oauth.verifyIdToken(wrongIss, {
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: ['https://accounts.google.com'], audience: env.GOOGLE_CLIENT_ID, nonce,
    });
  } catch (e) { error = e; }
  check('чужой issuer отклоняется', error && error.code === 'BAD_ISSUER', error && error.code);

  const expired = await signJwt(googleClaims({ nonce, exp: now() - 3600, iat: now() - 7200 }));
  error = null;
  try {
    await oauth.verifyIdToken(expired, {
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: ['https://accounts.google.com'], audience: env.GOOGLE_CLIENT_ID, nonce,
    });
  } catch (e) { error = e; }
  check('просроченный токен отклоняется', error && error.code === 'EXPIRED', error && error.code);

  const wrongNonce = await signJwt(googleClaims({ nonce: 'other-nonce' }));
  error = null;
  try {
    await oauth.verifyIdToken(wrongNonce, {
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: ['https://accounts.google.com'], audience: env.GOOGLE_CLIENT_ID, nonce,
    });
  } catch (e) { error = e; }
  check('чужой nonce отклоняется', error && error.code === 'BAD_NONCE', error && error.code);

  const unverified = await signJwt(googleClaims({ nonce, email_verified: false }));
  error = null;
  try {
    await oauth.verifyIdToken(unverified, {
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: ['https://accounts.google.com'], audience: env.GOOGLE_CLIENT_ID, nonce, requireVerifiedEmail: true,
    });
  } catch (e) { error = e; }
  check('неподтверждённый email отклоняется', error && error.code === 'EMAIL_NOT_VERIFIED', error && error.code);
}

/* ───────────────────────────── 2. Google: вход и повторный вход ───────────────────────────── */

let googleUserId = null;
let googleCookie = null;

{
  const gate = await oauth.handleGoogleNonce(request('/api/auth/oauth/google/nonce', { body: { mode: 'login' } }), env);
  const gateJson = await gate.json();
  check('nonce выдаётся', gateJson.ok && gateJson.state && gateJson.nonce);

  const credential = await signJwt(googleClaims({ nonce: gateJson.nonce }));
  const response = await oauth.handleGoogleLogin(request('/api/auth/oauth/google', { body: { state: gateJson.state, credential } }), env);
  const json = await response.json();
  check('первый вход через Google создаёт аккаунт', response.status === 200 && json.ok && json.created === true, JSON.stringify(json));
  googleUserId = json.user && json.user.id;
  googleCookie = cookieOf(response);
  check('выдана серверная сессия RH—MUSIC', !!googleCookie);

  const identity = await one('SELECT * FROM oauth_identities WHERE provider = ?1 AND provider_subject = ?2', 'google', 'google-subject-1');
  check('создана привязка oauth_identities', !!identity && identity.user_id === googleUserId);

  const user = await one('SELECT * FROM users WHERE id = ?1', googleUserId);
  check('у OAuth-аккаунта нет пароля', user && user.password_hash === '');

  // Повторный вход тем же Google — тот же аккаунт, без дубликата.
  const gate2 = await (await oauth.handleGoogleNonce(request('/api/auth/oauth/google/nonce', { body: { mode: 'login' } }), env)).json();
  const credential2 = await signJwt(googleClaims({ nonce: gate2.nonce }));
  const response2 = await oauth.handleGoogleLogin(request('/api/auth/oauth/google', { body: { state: gate2.state, credential: credential2 } }), env);
  const json2 = await response2.json();
  check('повторный вход через Google — тот же аккаунт', json2.user && json2.user.id === googleUserId, JSON.stringify(json2.user));
  const userCount = await one('SELECT COUNT(*) AS n FROM users');
  check('дубликат пользователя не создан', userCount.n === 1, 'users=' + userCount.n);

  // Replay того же state.
  const gate3 = await (await oauth.handleGoogleNonce(request('/api/auth/oauth/google/nonce', { body: { mode: 'login' } }), env)).json();
  const credential3 = await signJwt(googleClaims({ nonce: gate3.nonce }));
  await oauth.handleGoogleLogin(request('/api/auth/oauth/google', { body: { state: gate3.state, credential: credential3 } }), env);
  let replayError = null;
  try {
    await oauth.handleGoogleLogin(request('/api/auth/oauth/google', { body: { state: gate3.state, credential: credential3 } }), env);
  } catch (e) { replayError = e; }
  check('повторное использование state отклоняется', replayError && replayError.code === 'BAD_STATE', replayError && replayError.code);
}

/* ───────────────────────────── 3. Email-аккаунт и привязка Google ───────────────────────────── */

let emailUserId = null;
let emailCookie = null;

{
  const response = await auth.handleRegister(request('/api/auth/register', {
    body: {
      username: 'emaillink',
      email: 'emaillink@example.com',
      password: 'StrongPass1',
      confirmPassword: 'StrongPass1',
    },
  }), env);
  const json = await response.json();
  check('регистрация по email работает', response.status === 200 && json.ok, JSON.stringify(json.error || ''));
  emailUserId = json.user && json.user.id;
  emailCookie = cookieOf(response);

  // Привязка Google к открытому аккаунту.
  const gate = await (await oauth.handleGoogleNonce(
    request('/api/auth/oauth/google/nonce', { body: { mode: 'link' }, cookie: emailCookie }), env)).json();
  const credential = await signJwt(googleClaims({ nonce: gate.nonce, sub: 'google-subject-2', email: 'linked@example.com' }));
  const linkResponse = await oauth.handleGoogleLogin(
    request('/api/auth/oauth/google', { body: { state: gate.state, credential }, cookie: emailCookie }), env);
  const linkJson = await linkResponse.json();
  check('Google привязывается к текущему аккаунту', linkJson.ok && linkJson.user.id === emailUserId, JSON.stringify(linkJson));
  const linked = await one('SELECT * FROM oauth_identities WHERE provider = ?1 AND provider_subject = ?2', 'google', 'google-subject-2');
  check('привязка принадлежит email-аккаунту', linked && linked.user_id === emailUserId);

  // Попытка привязать тот же Google к другому аккаунту.
  const other = await auth.handleRegister(request('/api/auth/register', {
    body: { username: 'otheruser', email: 'other@example.com', password: 'StrongPass1', confirmPassword: 'StrongPass1' },
  }), env);
  const otherJson = await other.json();
  const otherCookie = cookieOf(other);
  const gate2 = await (await oauth.handleGoogleNonce(
    request('/api/auth/oauth/google/nonce', { body: { mode: 'link' }, cookie: otherCookie }), env)).json();
  const credential2 = await signJwt(googleClaims({ nonce: gate2.nonce, sub: 'google-subject-2', email: 'linked@example.com' }));
  let conflict = null;
  try {
    await oauth.handleGoogleLogin(
      request('/api/auth/oauth/google', { body: { state: gate2.state, credential: credential2 }, cookie: otherCookie }), env);
  } catch (e) { conflict = e; }
  check('чужую привязку привязать нельзя', conflict && conflict.code === 'IDENTITY_TAKEN', conflict && conflict.code);

  // Вход через Google-subject-2 должен попасть в email-аккаунт, а не в other.
  const gate3 = await (await oauth.handleGoogleNonce(request('/api/auth/oauth/google/nonce', { body: { mode: 'login' } }), env)).json();
  const credential3 = await signJwt(googleClaims({ nonce: gate3.nonce, sub: 'google-subject-2', email: 'linked@example.com' }));
  const login = await (await oauth.handleGoogleLogin(
    request('/api/auth/oauth/google', { body: { state: gate3.state, credential: credential3 } }), env)).json();
  check('вход по привязанному Google попадает в тот же аккаунт', login.user.id === emailUserId);
  check('второй аккаунт не затронут', !!otherJson.user && otherJson.user.id !== emailUserId);
}

/* ───────────────────────────── 4. Привязка и отвязка: правила ───────────────────────────── */

{
  const identities = await (await oauth.handleIdentities(request('/api/auth/identities', { method: 'GET', cookie: emailCookie }), env)).json();
  check('список способов входа отдаётся', identities.ok && identities.password === true && identities.identities.length === 1);

  // Отвязка без пароля — требуем reauth.
  let noReauth = null;
  try {
    await oauth.handleUnlink(request('/api/auth/identities/unlink', { body: { provider: 'google' }, cookie: emailCookie }), env);
  } catch (e) { noReauth = e; }
  check('отвязка без подтверждения отклоняется', noReauth && noReauth.code === 'REAUTH_REQUIRED', noReauth && noReauth.code);

  // Отвязка с паролем работает, потому что остаётся email-вход.
  const removed = await (await oauth.handleUnlink(
    request('/api/auth/identities/unlink', { body: { provider: 'google', password: 'StrongPass1' }, cookie: emailCookie }), env)).json();
  check('отвязка с подтверждением работает', removed.ok && removed.removed === 'google', JSON.stringify(removed));
  const left = await one('SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?1', emailUserId);
  check('привязка удалена', left.n === 0);
}

/* ───────────────────────────── 5. VK ID ───────────────────────────── */

{
  const start = await (await oauth.handleVkStart(request('/api/auth/oauth/vk/start', { body: { mode: 'login' } }), env)).json();
  check('VK: ссылка авторизации сформирована', start.ok && start.url.includes('id.vk.com/authorize'));
  const startUrl = new URL(start.url);
  check('VK: state и PKCE присутствуют',
    !!startUrl.searchParams.get('state') && startUrl.searchParams.get('code_challenge_method') === 'S256');
  check('VK: redirect_uri фиксирован', startUrl.searchParams.get('redirect_uri') === 'https://rh-music.pages.dev/api/auth/oauth/vk/callback');

  const callbackUrl = new URL('https://rh-music.pages.dev/api/auth/oauth/vk/callback');
  callbackUrl.searchParams.set('code', 'vk-code');
  callbackUrl.searchParams.set('state', startUrl.searchParams.get('state'));
  const response = await oauth.handleVkCallback(request(callbackUrl.pathname + callbackUrl.search, { method: 'GET' }), env, callbackUrl);
  check('VK: callback выдаёт сессию', response.status === 302 && !!cookieOf(response));
  const vkIdentity = await one('SELECT * FROM oauth_identities WHERE provider = ?1 AND provider_subject = ?2', 'vk', '777001');
  check('VK: создана привязка по устойчивому user_id', !!vkIdentity);

  // Replay того же state.
  const replay = await oauth.handleVkCallback(request(callbackUrl.pathname + callbackUrl.search, { method: 'GET' }), env, callbackUrl);
  check('VK: повторный callback отклоняется', replay.headers.get('Location').includes('oauth=error'), replay.headers.get('Location'));

  // Повторный вход тем же VK — тот же аккаунт.
  const start2 = await (await oauth.handleVkStart(request('/api/auth/oauth/vk/start', { body: { mode: 'login' } }), env)).json();
  const url2 = new URL(start2.url);
  const cb2 = new URL('https://rh-music.pages.dev/api/auth/oauth/vk/callback');
  cb2.searchParams.set('code', 'vk-code-2');
  cb2.searchParams.set('state', url2.searchParams.get('state'));
  await oauth.handleVkCallback(request(cb2.pathname + cb2.search, { method: 'GET' }), env, cb2);
  const vkUsers = await one('SELECT COUNT(*) AS n FROM users WHERE id = ?1', vkIdentity.user_id);
  check('VK: повторный вход не создал дубликат', vkUsers.n === 1);
}

/* ───────────────────────────── 6. Apple ID ───────────────────────────── */

{
  appleIdTokenFactory = async () => signJwt({
    iss: 'https://appleid.apple.com',
    aud: env.APPLE_CLIENT_ID,
    sub: 'apple-subject-1',
    email: 'relay@privaterelay.appleid.com',
    email_verified: 'true',
    iat: now(),
    exp: now() + 3600,
    nonce: 'pending',
  });

  const start = await (await oauth.handleAppleStart(request('/api/auth/oauth/apple/start', { body: { mode: 'login' } }), env)).json();
  check('Apple: ссылка авторизации сформирована', start.ok && start.url.includes('appleid.apple.com/auth/authorize'));
  const startUrl = new URL(start.url);
  check('Apple: response_mode=form_post и nonce', startUrl.searchParams.get('response_mode') === 'form_post' && !!startUrl.searchParams.get('nonce'));

  // Apple присылает form_post. Подписываем id_token с тем же nonce.
  const nonce = startUrl.searchParams.get('nonce');
  appleIdTokenFactory = async () => signJwt({
    iss: 'https://appleid.apple.com',
    aud: env.APPLE_CLIENT_ID,
    sub: 'apple-subject-1',
    email: 'relay@privaterelay.appleid.com',
    email_verified: 'true',
    iat: now(),
    exp: now() + 3600,
    nonce,
  });
  const form = new URLSearchParams({ state: startUrl.searchParams.get('state'), code: 'apple-code' });
  const formRequest = new Request('https://rh-music.pages.dev/api/auth/oauth/apple/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://appleid.apple.com' },
    body: form.toString(),
  });
  const response = await oauth.handleAppleCallback(formRequest, env);
  check('Apple: callback выдаёт сессию', response.status === 302 && !!cookieOf(response), response.headers.get('Location'));
  const appleIdentity = await one('SELECT * FROM oauth_identities WHERE provider = ?1 AND provider_subject = ?2', 'apple', 'apple-subject-1');
  check('Apple: привязка по subject, а не по email', !!appleIdentity);
  const appleUser = await one('SELECT * FROM users WHERE id = ?1', appleIdentity.user_id);
  check('Apple: скрытый email сохранён как есть', appleUser.email === 'relay@privaterelay.appleid.com');
  check('Apple: публичного пароля нет', appleUser.password_hash === '');
}

/* ───────────────────────────── 7. Удаление и чистая повторная регистрация ───────────────────────────── */

{
  // Наполняем аккаунт данными.
  await D1.prepare('INSERT INTO library_tracks (user_id, track_id, title, added_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(emailUserId, '111', 'Трек', new Date().toISOString()).run();
  await D1.prepare('INSERT INTO playlists (user_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)')
    .bind(emailUserId, 'Плейлист', new Date().toISOString()).run();
  const playlistId = (await one('SELECT id FROM playlists WHERE user_id = ?1', emailUserId)).id;
  await D1.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position, title, added_at) VALUES (?1, ?2, 1, ?3, ?4)')
    .bind(playlistId, '111', 'Трек', new Date().toISOString()).run();
  await D1.prepare('INSERT INTO listening_history (user_id, track_id, started_at) VALUES (?1, ?2, ?3)')
    .bind(emailUserId, '111', new Date().toISOString()).run();
  await D1.prepare('INSERT INTO user_track_affinity (user_id, track_id, plays, first_played_at, last_played_at) VALUES (?1, ?2, 1, ?3, ?3)')
    .bind(emailUserId, '111', new Date().toISOString()).run();
  await D1.prepare('INSERT INTO oauth_identities (user_id, provider, provider_subject, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)')
    .bind(emailUserId, 'google', 'google-subject-3', new Date().toISOString()).run();
  await D1.prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?4, ?5)')
    .bind('sess-old', emailUserId, 'hash-old', new Date().toISOString(), new Date(Date.now() + 86400000).toISOString()).run();

  // Удаление без подтверждения.
  let noConfirm = null;
  try {
    await auth.handleDeleteAccount(request('/api/auth/account', { method: 'DELETE', body: { password: 'StrongPass1' }, cookie: emailCookie }), env);
  } catch (e) { noConfirm = e; }
  check('удаление без подтверждения отклоняется', noConfirm && noConfirm.code === 'CONFIRM_REQUIRED', noConfirm && noConfirm.code);

  // Удаление с неверным паролем.
  let badPass = null;
  try {
    await auth.handleDeleteAccount(request('/api/auth/account', {
      method: 'DELETE', body: { confirm: 'DELETE', password: 'wrong' }, cookie: emailCookie,
    }), env);
  } catch (e) { badPass = e; }
  check('удаление с неверным паролем отклоняется', badPass && badPass.code === 'BAD_CREDENTIALS', badPass && badPass.code);

  const response = await auth.handleDeleteAccount(request('/api/auth/account', {
    method: 'DELETE', body: { confirm: 'DELETE', password: 'StrongPass1' }, cookie: emailCookie,
  }), env);
  const json = await response.json();
  check('удаление с подтверждением работает', response.status === 200 && json.deleted === true);
  check('cookie сессии очищается', /rh_session=;/.test(response.headers.get('Set-Cookie') || ''));

  const checks = {
    users: await one('SELECT COUNT(*) AS n FROM users WHERE id = ?1', emailUserId),
    library: await one('SELECT COUNT(*) AS n FROM library_tracks WHERE user_id = ?1', emailUserId),
    playlists: await one('SELECT COUNT(*) AS n FROM playlists WHERE user_id = ?1', emailUserId),
    playlistTracks: await one('SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?1', playlistId),
    history: await one('SELECT COUNT(*) AS n FROM listening_history WHERE user_id = ?1', emailUserId),
    affinity: await one('SELECT COUNT(*) AS n FROM user_track_affinity WHERE user_id = ?1', emailUserId),
    identities: await one('SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?1', emailUserId),
    sessions: await one('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1', emailUserId),
    preferences: await one('SELECT COUNT(*) AS n FROM user_preferences WHERE user_id = ?1', emailUserId),
  };
  for (const [name, row] of Object.entries(checks)) {
    check('после удаления нет строк: ' + name, row.n === 0, 'n=' + row.n);
  }

  // Старая сессия не работает.
  const stale = await auth.currentUser(request('/api/auth/me', { method: 'GET', cookie: emailCookie }), env);
  check('старая сессия больше не действует', stale === null);

  // Повторный вход через тот же Google создаёт НОВЫЙ аккаунт.
  googleUserId = null;
  const gate = await (await oauth.handleGoogleNonce(request('/api/auth/oauth/google/nonce', { body: { mode: 'login' } }), env)).json();
  const credential = await signJwt(googleClaims({ nonce: gate.nonce, sub: 'google-subject-3', email: 'linked@example.com' }));
  const relogin = await (await oauth.handleGoogleLogin(
    request('/api/auth/oauth/google', { body: { state: gate.state, credential } }), env)).json();
  check('повторная регистрация через тот же Google создаёт новый аккаунт',
    relogin.created === true && relogin.user.id !== emailUserId, JSON.stringify({ created: relogin.created, id: relogin.user.id }));
  const newId = relogin.user.id;
  const fresh = {
    library: await one('SELECT COUNT(*) AS n FROM library_tracks WHERE user_id = ?1', newId),
    playlists: await one('SELECT COUNT(*) AS n FROM playlists WHERE user_id = ?1', newId),
    history: await one('SELECT COUNT(*) AS n FROM listening_history WHERE user_id = ?1', newId),
    affinity: await one('SELECT COUNT(*) AS n FROM user_track_affinity WHERE user_id = ?1', newId),
  };
  for (const [name, row] of Object.entries(fresh)) {
    check('новый аккаунт чист: ' + name, row.n === 0, 'n=' + row.n);
  }
  const identity = await one('SELECT * FROM oauth_identities WHERE provider = ?1 AND provider_subject = ?2', 'google', 'google-subject-3');
  check('привязка пересоздана на новый аккаунт', identity && identity.user_id === newId);

  // Данные другого пользователя не затронуты.
  const other = await one('SELECT COUNT(*) AS n FROM users WHERE username = ?1', 'otheruser');
  check('второй аккаунт не затронут удалением', other.n === 1);
}

/* ───────────────────────────── итог ───────────────────────────── */

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
if (failed) {
  console.log('Провалы:');
  for (const item of failures) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('Все проверки пройдены.');
}