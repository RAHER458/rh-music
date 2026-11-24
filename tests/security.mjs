/**
 * RH—MUSIC security regression tests.
 * Проверяют жёсткие правила безопасности, зафиксированные в коде.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const http = read('worker/src/http.js');
const auth = read('worker/src/auth.js');
const index = read('worker/src/index.js');
const store = read('worker/src/store.js');
const music = read('worker/src/music.js');
const oauth = read('worker/src/oauth.js');
const headers = read('web/_headers');
const app = read('web/app.js');

let passed = 0;
const failures = [];
const check = (name, ok) => { if (ok) passed++; else { failures.push(name); console.error('  ✗', name); } };
console.log('RH—MUSIC · security tests\n');

/* 1. Секреты только на сервере */
check('в браузерном коде нет ZVUK_TOKEN/ключей', !/ZVUK_TOKEN|client_secret|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|cfat_[A-Za-z0-9]{20,}/.test(app));
check('токен Zvuk читается только Worker-ом', /env\.ZVUK_TOKEN/.test(read('worker/src/zvuk.js') + index) && !/env\.ZVUK_TOKEN/.test(app));

/* 2. Пароли — только хеш */
check('PBKDF2-SHA256 100 000 + HMAC-pepper', /PASSWORD_ITERATIONS = 100000/.test(auth) && /PBKDF2/.test(http) && /PASSWORD_PEPPER/.test(http + auth));
check('пароль не хранится и не логируется открытым', !/password_hash\s*=\s*password/.test(auth) && /hashPassword/.test(auth));
check('старые хеши без pepper апгрейдятся при входе', /PASSWORD_PEPPER/.test(auth) && /upgradedSalt/.test(auth));
check('смена пароля завершает остальные сессии', /deleteOtherSessions/.test(auth) && /deleteOtherSessions/.test(store));

/* 3. Сессии — только в cookie с флагами */
check('cookie сессии только HttpOnly/Secure/SameSite', /\$\{SESSION_COOKIE\}=/.test(http) && /HttpOnly/.test(http) && /Secure/.test(http) && /SameSite=Lax/.test(http));
check('cookie с префиксом __Host-', /SESSION_COOKIE = '__Host-rh_session'/.test(http));
check('сессия хранится как SHA-256 хеш', /sha256Hex\(token\)/.test(auth) && /token_hash/.test(store) && /INSERT INTO sessions \(id, user_id, token_hash/.test(store));

/* 4. Серверная валидация */
check('регистрация валидируется на сервере', /validateRegistration/.test(http) && /EMAIL_RE/.test(http) && /USERNAME_RE/.test(http));
check('минимальная длина пароля 10+', /pass\.length < 10/.test(http));
check('трек санитизируется на сервере', /sanitizeTrack/.test(music) && /ID_RE/.test(http));
check('плейлисты валидируются на сервере', /sanitizeTitle/.test(music) && /description.*slice\(0, 400\)/.test(music));

/* 5. Только параметризованный SQL */
const sqlInterpolation = /prepare\(\s*`[^`]*\$\{/.test(store + read('worker/src/auth.js') + music + oauth + read('worker/src/recommend.js') + read('worker/src/home.js') + read('worker/src/popular.js') + read('worker/src/lyrics.js') + read('worker/src/words.js'));
check('нет склейки SQL-строк', !sqlInterpolation);
check('D1-запросы идут через bind', /prepare\(sql\)\.bind/.test(store) && /\.bind\(/.test(store));

/* 6. XSS */
const unsafe = app.split('\n').filter((line) => /\$\{[^}]*\.(title|artist|album|name|displayName|username|description)[^}]*\}/.test(line) && !/esc\(/.test(line) && !/text:/.test(line) && !/\.length/.test(line));
check('весь пользовательский текст экранируется', /const esc =/.test(app) && unsafe.length === 0);

/* 7. CSRF */
check('CSRF: Origin + X-RH-Request', /export function requireCsrf/.test(http) && /X-RH-Request/.test(http));
check('CSRF: отклонение cross-site', /Sec-Fetch-Site/.test(http) && /'cross-site'/.test(http));
check('все изменяющие маршруты вызывают requireCsrf', (music.match(/requireCsrf\(request, env\)/g) || []).length >= 10 && (auth.match(/requireCsrf\(request, env\)/g) || []).length >= 7);

/* 8. HTTPS */
check('HTTP-запросы перенаправляются на HTTPS', /status: 301/.test(index) && /url\.protocol = 'https:'/.test(index));
check('мутации требуют HTTPS (кроме localhost)', /HTTPS_REQUIRED/.test(http) && /isLocalhost/.test(http));

/* 9. Заголовки безопасности */
check('HSTS включён', /Strict-Transport-Security: max-age=31536000/.test(headers));
check('CSP включён и запрещает frame-ancestors', /Content-Security-Policy:/.test(headers) && /frame-ancestors 'none'/.test(headers));
check('X-Frame-Options и nosniff', /X-Frame-Options: DENY/.test(headers) && /X-Content-Type-Options: nosniff/.test(headers));
check('Referrer-Policy и Permissions-Policy', /Referrer-Policy/.test(headers) && /Permissions-Policy/.test(headers));
check('заголовки безопасности дублируются Worker-ом', /securityHeaders/.test(http) && /securityHeaders\(\)/.test(index));

/* 10. CORS */
check('CORS только для SITE_URL/ALLOWED_ORIGINS', /env\.SITE_URL/.test(http) && /ALLOWED_ORIGINS/.test(http));
check('CORS без wildcard и без workers.dev', !/Access-Control-Allow-Origin'\] = '\*'/.test(http) && !/workers\\.dev/.test(http) && !/localhost.*ORIGIN_PATTERNS/.test(http));

/* 11. Лимиты */
check('лимиты входа и регистрации по IP', /LIMITS = \{/.test(auth) && /enforceRateLimit/.test(auth));
check('лимит на все изменяющие запросы', /enforceWriteLimit/.test(index) && /countAttempts\(env, ip, 'write'/.test(index));
check('IP берётся только из CF-Connecting-IP', /CF-Connecting-IP/.test(http) && !/X-Forwarded-For/.test(http));

/* 12. Админка отсутствует */
check('в проекте нет админ-маршрутов', !/admin/i.test(index + http + auth + music));

/* 13. Файлы/оплата отсутствуют, внешние URL проверяются */
check('прокси картинок разрешает только CDN Zvuk', /CDN_IMAGE_HOST/.test(index) && /FORBIDDEN_HOST/.test(index));
check('нет приёма пользовательских файлов', !/multipart\/form-data|request\.formData\(/.test(index + http + music));

/* 14/17. Отладка и утечки */
check('debug-логи только на localhost', /RH_DEBUG/.test(app) && !/console\.info\('\[RH-MUSIC\] build'/.test(app));
check('500-ошибки не отдают внутренние детали', /apiErr\.status >= 500 \? null : apiErr\.detail/.test(index) && /INTERNAL/.test(index));
check('health не раскрывает счётчик пользователей', !/COUNT\(\*\) AS users/.test(index) && !/tokenConfigured/.test(index));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
