/**
 * Тесты внешней авторизации RH—MUSIC (Google Identity Services).
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
import { readFileSync, readdirSync } from 'node:fs';
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
  const files = readdirSync(join(root, 'worker/migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
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

const env = {
  DB: D1,
  SITE_URL: 'https://rh-music.pages.dev',
  GOOGLE_CLIENT_ID: 'test-google-client.apps.googleusercontent.com',
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

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  fetchLog.push(url);
  if (url.includes('googleapis.com/oauth2')) {
    return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};

/* ───────────────────────────── импорт воркера ───────────────────────────── */

const oauth = await import(join(root, 'worker/src/oauth.js'));
const auth = await import(join(root, 'worker/src/auth.js'));
const store = await import(join(root, 'worker/src/store.js'));

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
  const match = /((?:__Host-)?rh_session)=([^;]+)/.exec(raw);
  return match ? match[1] + '=' + match[2] : null;
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
  check('cookie сессии очищается', /(?:__Host-)?rh_session=;/.test(response.headers.get('Set-Cookie') || ''));

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

/* ───────────────────────────── 8. Google: совпадение email и негативные сценарии ───────────────────────────── */

async function googleAuth(sub, email, { cookie, mode = 'login', emailVerified = true, state = null, credential = null } = {}) {
  let gate = null;
  if (!credential || state === null) {
    gate = await (await oauth.handleGoogleNonce(
      request('/api/auth/oauth/google/nonce', { body: { mode }, cookie }), env)).json();
  }
  const token = credential || await signJwt(googleClaims({
    nonce: gate.nonce, sub, email, email_verified: emailVerified,
  }));
  try {
    const response = await oauth.handleGoogleLogin(
      request('/api/auth/oauth/google', { body: { state: state === null ? gate.state : state, credential: token }, cookie }), env);
    return { status: response.status, json: await response.json(), cookie: cookieOf(response) };
  } catch (error) {
    return { status: error.status || 500, json: { error: { code: error.code, message: error.message } }, cookie: null };
  }
}

{
  const sameEmail = 'collision@example.com';
  const reg = await auth.handleRegister(request('/api/auth/register', {
    body: { username: 'collision', email: sameEmail, password: 'StrongPass1', confirmPassword: 'StrongPass1' },
  }), env);
  const emailUser = (await reg.json()).user.id;

  // Google с тем же email НЕ входит в email-аккаунт и не привязывается к нему.
  const google = await googleAuth('google-collision-sub', sameEmail);
  check('Google с совпадающим email создаёт отдельный аккаунт',
    google.status === 200 && google.json.user.id !== emailUser, JSON.stringify(google.json));
  const googleUser = google.json.user.id;
  check('Google-аккаунт не получил email существующего пользователя',
    google.json.user.email !== sameEmail, google.json.user.email);
  check('к email-аккаунту ничего не привязалось',
    (await one('SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?1', emailUser)).n === 0);
  check('email-аккаунт не изменён',
    (await one('SELECT email FROM users WHERE id = ?1', emailUser)).email === sameEmail);

  // Повторный вход тем же Google — тот же аккаунт, без дубликатов.
  const usersBefore = (await one('SELECT COUNT(*) AS n FROM users')).n;
  const again = await googleAuth('google-collision-sub', sameEmail);
  check('повторный Google-вход остаётся в своём аккаунте', again.json.user.id === googleUser);
  check('дубликат пользователя не создан',
    (await one('SELECT COUNT(*) AS n FROM users')).n === usersBefore, `было ${usersBefore}`);

  // Негативные сценарии.
  check('Google с email_verified=false отклоняется',
    (await googleAuth('google-unverified', 'u@example.com', { emailVerified: false })).json.error.code === 'EMAIL_NOT_VERIFIED');
  check('credential без state отклоняется',
    (await googleAuth('google-nostate', 'n@example.com', { state: '', credential: 'x.y.z' })).json.error.code === 'VALIDATION');
  const bogus = await signJwt(googleClaims({ nonce: 'nope', sub: 'google-bogus', email: 'b@example.com' }));
  check('несуществующий state отклоняется',
    (await googleAuth('google-bogus', 'b@example.com', { state: 'deadbeefdeadbeef', credential: bogus })).json.error.code === 'BAD_STATE');

  // Replay: тот же state и credential второй раз не проходят.
  const gate = await (await oauth.handleGoogleNonce(
    request('/api/auth/oauth/google/nonce', { body: { mode: 'login' } }), env)).json();
  const token = await signJwt(googleClaims({ nonce: gate.nonce, sub: 'google-replay', email: 'r@example.com' }));
  const first = await googleAuth('google-replay', 'r@example.com', { state: gate.state, credential: token });
  const second = await googleAuth('google-replay', 'r@example.com', { state: gate.state, credential: token });
  check('первый вход по credential проходит', first.json.ok === true);
  check('повторная отправка того же state/credential отклоняется',
    second.json.error && second.json.error.code === 'BAD_STATE', JSON.stringify(second.json));

  // Провайдер не настроен — честная ошибка, без «имитации» входа.
  let disabled = null;
  try {
    await oauth.handleGoogleNonce(request('/api/auth/oauth/google/nonce', { body: { mode: 'login' } }),
      { ...env, GOOGLE_CLIENT_ID: undefined });
  } catch (error) { disabled = error; }
  check('без GOOGLE_CLIENT_ID вход отключён (503)', disabled && disabled.code === 'PROVIDER_DISABLED', disabled && disabled.code);

  const providers = await (await oauth.handleProviders(request('/api/auth/providers', { method: 'GET' }), env)).json();
  check('список провайдеров содержит только Google',
    providers.providers.length === 1 && providers.providers[0].id === 'google', JSON.stringify(providers));
}

/* ───────────────────────────── 9. Последний способ входа ───────────────────────────── */

{
  // OAuth-аккаунт только с Google: отвязать единственный способ нельзя.
  const solo = await googleAuth('solo-google-sub', 'solo@example.com');
  const soloCookie = solo.cookie;
  const soloId = solo.json.user.id;

  const refreshReauth = async (cookie, sub, email) => {
    const gate = await (await oauth.handleGoogleNonce(
      request('/api/auth/oauth/google/nonce', { body: { mode: 'link' }, cookie }), env)).json();
    const credential = await signJwt(googleClaims({ nonce: gate.nonce, sub, email }));
    await oauth.handleGoogleLogin(request('/api/auth/oauth/google', {
      body: { state: gate.state, credential }, cookie,
    }), env);
  };

  await refreshReauth(soloCookie, 'solo-google-sub', 'solo@example.com');
  let lastMethod = null;
  try {
    await oauth.handleUnlink(request('/api/auth/identities/unlink', { body: { provider: 'google' }, cookie: soloCookie }), env);
  } catch (error) { lastMethod = error; }
  check('единственный способ входа нельзя отвязать',
    lastMethod && lastMethod.code === 'LAST_AUTH_METHOD', lastMethod && lastMethod.code);
  check('привязка осталась на месте',
    (await one('SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?1', soloId)).n === 1);

  // Две Google-идентичности без пароля: отвязка тоже запрещена, ничего не удаляется.
  await refreshReauth(soloCookie, 'solo-google-second', 'solo2@example.com');
  check('вторая Google-идентичность привязана',
    (await one('SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?1', soloId)).n === 2);
  await store.addReauth(env, soloId, 'provider');
  let lastMethod2 = null;
  try {
    await oauth.handleUnlink(request('/api/auth/identities/unlink', { body: { provider: 'google' }, cookie: soloCookie }), env);
  } catch (error) { lastMethod2 = error; }
  check('две OAuth-идентичности без пароля тоже нельзя отвязать',
    lastMethod2 && lastMethod2.code === 'LAST_AUTH_METHOD', lastMethod2 && lastMethod2.code);
  check('обе привязки сохранены',
    (await one('SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?1', soloId)).n === 2);

  // Аккаунт с паролем: Google привязывается и отвязывается свободно.
  const reg = await auth.handleRegister(request('/api/auth/register', {
    body: { username: 'withpass', email: 'withpass@example.com', password: 'StrongPass1', confirmPassword: 'StrongPass1' },
  }), env);
  const passUser = (await reg.json()).user.id;
  const passCookie = cookieOf(reg);
  const gate = await (await oauth.handleGoogleNonce(
    request('/api/auth/oauth/google/nonce', { body: { mode: 'link' }, cookie: passCookie }), env)).json();
  const credential = await signJwt(googleClaims({ nonce: gate.nonce, sub: 'pass-google-sub', email: 'pass-google@example.com' }));
  const linked = await (await oauth.handleGoogleLogin(request('/api/auth/oauth/google', {
    body: { state: gate.state, credential }, cookie: passCookie,
  }), env)).json();
  check('Google привязывается к аккаунту с паролем', linked.linked === true && linked.user.id === passUser);
  const unlinked = await (await oauth.handleUnlink(request('/api/auth/identities/unlink', {
    body: { provider: 'google', password: 'StrongPass1' }, cookie: passCookie,
  }), env)).json();
  check('Google отвязывается, пока остаётся пароль', unlinked.ok === true && unlinked.removed === 'google');
  check('привязок не осталось',
    (await one('SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?1', passUser)).n === 0);

  // Параллельная отвязка: второй запрос не должен оставить аккаунт без входа.
  const gate2 = await (await oauth.handleGoogleNonce(
    request('/api/auth/oauth/google/nonce', { body: { mode: 'link' }, cookie: passCookie }), env)).json();
  const credential2 = await signJwt(googleClaims({ nonce: gate2.nonce, sub: 'parallel-google-sub', email: 'parallel@example.com' }));
  await oauth.handleGoogleLogin(request('/api/auth/oauth/google', {
    body: { state: gate2.state, credential: credential2 }, cookie: passCookie,
  }), env);
  const attempt = () => oauth.handleUnlink(request('/api/auth/identities/unlink', {
    body: { provider: 'google', password: 'StrongPass1' }, cookie: passCookie,
  }), env).then(() => 'ok').catch((error) => error.code);
  const results = await Promise.all([attempt(), attempt()]);
  check('параллельная отвязка не оставляет аккаунт без способа входа',
    (await one('SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?1', passUser)).n === 0
    && (await one('SELECT password_hash FROM users WHERE id = ?1', passUser)).password_hash !== '',
    JSON.stringify(results));
  check('ровно один параллельный запрос выполнен',
    results.filter((item) => item === 'ok').length === 1
    && results.every((item) => item === 'ok' || item === 'LAST_AUTH_METHOD' || item === 'NOT_LINKED'),
    JSON.stringify(results));
}

/* ───────────────────────────── 10. Повторная аутентификация ───────────────────────────── */

{
  const account = await googleAuth('reauth-sub', 'reauth@example.com');
  const id = account.json.user.id;
  const cookie = account.cookie;

  await store.addReauth(env, id, 'provider');
  await D1.prepare('UPDATE reauth_events SET created_at = ?1 WHERE user_id = ?2')
    .bind(new Date(Date.now() - 6 * 60000).toISOString(), id).run();
  let expired = null;
  try {
    await oauth.handleUnlink(request('/api/auth/identities/unlink', { body: { provider: 'google' }, cookie }), env);
  } catch (error) { expired = error; }
  check('подтверждение старше 5 минут не принимается',
    expired && expired.code === 'REAUTH_REQUIRED', expired && expired.code);

  await store.addReauth(env, id, 'provider');
  const firstUse = await store.consumeReauth(env, id, 300);
  const secondUse = await store.consumeReauth(env, id, 300);
  check('reauth-событие одноразовое', !!firstUse && secondUse === null, String(firstUse) + '/' + String(secondUse));

  const otherAccount = await googleAuth('reauth-other-sub', 'reauth-other@example.com');
  const otherId = otherAccount.json.user.id;
  await store.addReauth(env, id, 'provider');
  const before = await one('SELECT COUNT(*) AS n FROM reauth_events WHERE user_id = ?1 AND used_at IS NULL', id);
  await store.consumeReauth(env, otherId, 300);
  const after = await one('SELECT COUNT(*) AS n FROM reauth_events WHERE user_id = ?1 AND used_at IS NULL', id);
  check('reauth другого пользователя недоступен', before.n === after.n && after.n >= 1, `${before.n} → ${after.n}`);

  let noReauthDelete = null;
  try {
    await auth.handleDeleteAccount(request('/api/auth/account', {
      method: 'DELETE', body: { confirm: 'DELETE' }, cookie: otherAccount.cookie,
    }), env);
  } catch (error) { noReauthDelete = error; }
  check('удаление OAuth-аккаунта без свежего подтверждения отклоняется',
    noReauthDelete && noReauthDelete.code === 'REAUTH_REQUIRED', noReauthDelete && noReauthDelete.code);

  const fresh = await googleAuth('reauth-other-sub', 'reauth-other@example.com');
  const deleted = await auth.handleDeleteAccount(request('/api/auth/account', {
    method: 'DELETE', body: { confirm: 'DELETE' }, cookie: fresh.cookie,
  }), env);
  check('после повторного входа через Google удаление работает', deleted.status === 200);
  check('аккаунт удалён из D1', (await one('SELECT COUNT(*) AS n FROM users WHERE id = ?1', otherId)).n === 0);
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