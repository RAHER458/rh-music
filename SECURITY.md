# RH—MUSIC · отчёт по безопасности

Дата аудита: 24 ноября 2026. Аудит и правки выполнены по 17 требованиям
заказчика перед запуском. Ниже — что найдено, что исправлено и что осталось
на стороне настроек Cloudflare.

## Итоговая таблица

| № | Требование | Состояние | Что сделано |
|---|---|---|---|
| 1 | Ключи API только на сервере | ✅ | `ZVUK_TOKEN` и `PASSWORD_PEPPER` — секреты Worker, в браузере ключей нет |
| 2 | Пароли только хешем | ✅ | PBKDF2-SHA256 100 000 итераций (максимум Workers) + HMAC-SHA256 pepper |
| 3 | Сессии в HttpOnly/Secure/SameSite cookie | ✅ | `__Host-rh_session`, HttpOnly, Secure, SameSite=Lax, Priority=High |
| 4 | Проверка всех данных на сервере | ✅ | Валидация регистрации, профиля, плейлистов, треков, истории, лимитов |
| 5 | Параметризованный SQL | ✅ | Только `prepare().bind()`, проверено по всем worker-модулям |
| 6 | XSS-экранирование | ✅ | `esc()` для всего пользовательского текста, CSP без `unsafe-inline` для скриптов |
| 7 | CSRF | ✅ | `X-RH-Request` + Origin + `Sec-Fetch-Site`; HTTPS для мутаций |
| 8 | HTTPS везде | ⚠️ | Worker перенаправляет HTTP→HTTPS; для Pages нужно включить «Always Use HTTPS» (см. остаточные риски) |
| 9 | Заголовки безопасности | ✅ | HSTS, CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP |
| 10 | CORS только свой домен | ✅ | Только `SITE_URL` и `ALLOWED_ORIGINS`; wildcard убран |
| 11 | Лимиты на вход и формы | ✅ | Вход/регистрация по IP в D1 + общий лимит на все изменяющие запросы |
| 12 | Админка спрятана и закрыта | ✅ | Админ-маршрутов в проекте нет |
| 13 | Файлы: тип и размер | ✅ | Загрузки файлов отсутствуют; прокси картинок принимает только CDN Zvuk; JSON ≤ 20 КБ |
| 14 | Цена/оплата только на сервере | ✅ | Оплаты в проекте нет |
| 15 | Отладка выключена на проде | ✅ | `console.debug` только на localhost, `console.info` убран |
| 16 | Зависимости обновлены / лишние удалены | ✅ | npm-зависимостей нет вообще (нет `package.json`) |
| 17 | Ключи в истории гита | ✅ | Полный скан всех 154 коммитов — утечек не найдено |

Легенда: ✅ — исправлено/соответствует, ⚠️ — требует настройки в Cloudflare.

## Что именно изменено

### Ключи и секреты

- В браузерном коде нет `ZVUK_TOKEN`, `client_secret`, PAT и любых API-ключей.
- `ZVUK_TOKEN` читается только Worker-ом (`worker/src/zvuk.js`).
- Добавлен секрет `PASSWORD_PEPPER` — случайные 32 байта, хранится только
  в Cloudflare Worker secrets и никогда не попадает в БД.

### Пароли

Cloudflare Workers WebCrypto **не поддерживает bcrypt и argon2**, а PBKDF2
жёстко ограничен 100 000 итераций (`Pbkdf2 failed: iteration counts above
100000 are not supported`). Поэтому:

- PBKDF2-SHA256, 100 000 итераций — максимально возможное значение;
- поверх PBKDF2 считается HMAC-SHA256 с секретом `PASSWORD_PEPPER`;
- украденная база D1 без pepper не позволяет проверять пароли офлайн;
- старые хеши без pepper продолжают работать и автоматически
  перевыпускаются с pepper при первом успешном входе;
- смена пароля завершает все остальные сессии пользователя;
- минимальная длина пароля поднята до 10 символов, UI-подсказки обновлены.

### Сессии

- cookie: `__Host-rh_session` — только HTTPS, `Path=/`, без `Domain`;
- флаги `HttpOnly; Secure; SameSite=Lax; Priority=High; Max-Age=30 дней`;
- в D1 хранится только SHA-256 хеш токена;
- logout удаляет сессию, очищает cookie;
- смена пароля отзывает остальные сессии.

### CSRF и Origin

- на всех изменяющих маршрутах обязателен заголовок `X-RH-Request: 1`;
- Origin проверяется по списку `SITE_URL` + `ALLOWED_ORIGINS`;
- `Sec-Fetch-Site: cross-site` отклоняется;
- мутации принимаются только по HTTPS (кроме localhost для разработки).

### Заголовки безопасности

Проставляются Worker-ом и Pages Function `web/_worker.js`:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin-allow-popups
Cross-Origin-Resource-Policy: same-origin
Content-Security-Policy: default-src 'self'; script-src 'self' https://accounts.google.com;
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://cdn-image.zvuk.com https://*.zvuk.com https://*.googleusercontent.com;
  media-src 'self' blob:; connect-src 'self' https://accounts.google.com; worker-src 'self' blob:;
  frame-src https://accounts.google.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'
```

Статика больше не отдаёт `Access-Control-Allow-Origin: *`.

### CORS

- разрешён только origin из `env.SITE_URL` и `env.ALLOWED_ORIGINS`;
- wildcard и паттерн `*.workers.dev`/`localhost` в продакшене убраны;
- для одного и того же домена CORS вообще не требуется — API идёт через
  Pages Function `/api`.

### Лимиты

- вход: 12 попыток / 15 минут на IP;
- регистрация: 6 попыток / 30 минут на IP;
- все изменяющие запросы: 60/мин на изолят и 300/5 мин на IP в D1;
- IP берётся только из `CF-Connecting-IP` (подмена `X-Forwarded-For` не работает).

### Ошибки и отладка

- для 5xx клиенту возвращается обобщённое сообщение без деталей;
- внутренние сообщения пишутся только в `console.error` Worker-а;
- `/api/health` без `probe` не раскрывает ничего лишнего;
- с `probe=1` возвращает только `ok/elapsedMs` и `database.ok` — без счётчика
  пользователей и текстов ошибок.

### Админка, файлы, оплата

- админ-маршрутов нет;
- загрузки файлов нет; прокси обложек разрешён только для `cdn-image.zvuk.com`;
- платежей и цен в проекте нет.

### Зависимости

`package.json` и npm-зависимостей в проекте нет: Worker и фронтенд — обычные
ES-модули и файлы. `npm audit` неприменим, обновлять/удалять нечего.

### Git-история

Проверены все 154 коммита (`git rev-list --all` + `git grep` по шаблонам
`ghp_`, `cfat_`, `AIza`, `sk-`, `ZVUK_TOKEN=`, приватные ключи). Утечек нет.
В `.gitignore` уже исключены `.env`, `.dev.vars`, `*.local`, `node_modules/`.

## Как проверяли «взломом» (production)

| Проверка | Результат |
|---|---|
| POST без `X-RH-Request` | `403 CSRF` |
| POST с `Origin: evil.example` + cross-site | `403 BAD_ORIGIN` |
| CORS с чужого origin | `Access-Control-Allow-Origin` не выдаётся |
| Чтение чужого плейлиста без cookie | `401` |
| `/api/library` без cookie | `401` |
| SQLi в поиске и пути плейлиста | параметризовано, инъекция не проходит |
| Ошибка неизвестного маршрута | `404` без деталей |
| Внутренняя ошибка | `500` с `detail: null` |
| Регистрация с паролем 6 символов | `400 VALIDATION` |
| Сессионная cookie | `__Host-rh_session; HttpOnly; Secure; SameSite=Lax; Priority=High` |
| Пачка неверных входов | после лимита `429 RATE_LIMITED` |
| Заголовки сайта и API | HSTS, CSP, XFO, nosniff, Referrer-Policy на месте |
| Google GIS под CSP | кнопка входа рендерится, ошибок CSP нет |
| `/api/health` | отдаёт минимум, счётчика пользователей нет |

## Остаточные риски и что сделать в Cloudflare

1. **«Always Use HTTPS» для Pages.** Pages Function видит уже https-запрос,
   поэтому `http://rh-music.pages.dev` сейчас отвечает `200`, а не редиректом.
   Включите в Cloudflare: Pages → проект `rh-music` → Settings/Domains →
   Always Use HTTPS (или соответствующую настройку custom domain).
   Браузер дополнительно защищён HSTS после первого HTTPS-визита.
2. **Direct `workers.dev` включён.** Нужен, потому что Pages Function ходит
   в Worker по этому адресу. Cookie туда не отправляются (другой домен),
   CORS сужен, лимиты включены. При переходе на service bindings/route можно
   будет выключить `workers_dev`.
3. **PBKDF2 100 000 — потолок Workers.** Это компенсировано HMAC-pepper.
   При переезде на собственный сервер имеет смысл заменить на Argon2id.
4. **Секреты нужно перевыпустить, если они светились.** Если
   `ZVUK_TOKEN`, GitHub PAT или Cloudflare API token когда-либо попадали в
   чат/логи — перевыпустите их. В репозитории и истории гита утечек нет.
5. **`PASSWORD_PEPPER` не хранится в git.** При переустановке окружения
   задайте его заново через Cloudflare Secrets. Ротация pepper не ломает
   вход: старые хеши проверяются и апгрейдятся при следующем входе.

## Использование в дальнейшем

- не добавлять `createMediaElementSource` на основной `<audio>` второй раз;
- не ослаблять CSP без необходимости; если добавляется внешний скрипт —
  вносить его в `script-src` осознанно;
- не возвращать wildcard в CORS;
- не логировать пароли, токены и cookie;
- перед каждым деплоем: `tests/security.mjs` + полный прогон тестов.
