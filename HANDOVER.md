# RH—MUSIC · инструкция для агента и разработчика

Этот файл — точка входа для нового агента/разработчика после сброса контекста
(например, после переустановки Fish Pocket). Прочитай его целиком, затем README.md
и профильные доки в `docs/`.

---

## 1. Что такое RH—MUSIC

RH—MUSIC — музыкальный веб-сервис с собственным плеером, аккаунтами, библиотекой,
плейлистами, историей, персональными рекомендациями, синхронизированным текстом,
эквалайзером, визуализацией обложки под бит и AI-переходами между треками.

- Сайт (production): https://rh-music.pages.dev
- API (тот же домен): https://rh-music.pages.dev/api
- Worker напрямую: https://rh-music-api.rh-launcher.workers.dev
- Репозиторий: https://github.com/RAHER458/rh-music
- Ветка production: `main`
- Cloudflare account id: `cbc0aa4d086170fb101f477ebedd4d29`
- Для агента: начни с этого файла, затем README.md.

Главные принципы продукта:

- мобильная версия — основная, десктоп — полноценный, а не растянутый мобильный;
- никаких выдуманных данных: нет синхронизации — так и написано, нет бита — нет пульса;
- аудио не переподключается без необходимости, второй плеер не создаётся;
- визуальный язык RH—MUSIC: тёмный графит, сине-фиолетовые акценты, крупные строки.

---

## 2. Архитектура

```
iPhone / браузер
      │  HTML + CSS + JS  (Cloudflare Pages: rh-music.pages.dev)
      │  /api/*  ──►  Pages Function web/_worker.js  ──►  Worker rh-music-api
      ▼
Cloudflare Worker rh-music-api
      ├── каталог Zvuk: GraphQL (секрет ZVUK_TOKEN) → подписанный MP3 → Range/206
      ├── тексты: Zvuk / LRCLIB / LiriQo (кеш в Worker)
      └── данные сервиса: Cloudflare D1
            (аккаунты, сессии, библиотека, плейлисты,
             история, рекомендации, снимок Popular, OAuth)
```

### Почему `/api` идёт через Pages

Сессионная cookie должна быть **first-party**: iOS Safari блокирует сторонние cookie.
Поэтому `web/_worker.js` — Pages Function — проксирует `/api/*` в Worker
`rh-music-api`. Статика остаётся на Pages. **Это критично, не удалять и не менять
на прямые запросы к `*.workers.dev`.**

### Что где живёт

| Слой | Где | Что делает |
|---|---|---|
| Frontend | `web/` | SPA без сборщика: HTML, CSS, обычный JS |
| Pages Function | `web/_worker.js` | прокси `/api/*` → Worker, `env.ASSETS` для статики |
| Worker | `worker/src/*.js` | API, авторизация, музыка, тексты, рекомендации |
| БД | Cloudflare D1 `rh-music-db` | пользователи, библиотека, плейлисты, история, тексты-кеш и т.д. |
| Cron | Worker trigger `0 4 * * *` | обновление Popular-снимка |

### Frontend-файлы

| Файл | Назначение |
|---|---|
| `web/index.html` | разметка, шаблоны, подключение скриптов с `?v=releaseN` |
| `web/app.js` | основная логика SPA: роутинг, плеер, очередь, библиотека, плейлисты, авторизация, UI |
| `web/styles.css` | вся стилизация, адаптив, анимации |
| `web/device.js` | определяет mobile/desktop UI (`data-ui`) |
| `web/lyrics.js` | движок текста: загрузка, подсветка, прокрутка, кеш |
| `web/lyrics-beta.js` | режим «Текст» вместо обложки в Now Playing (основной текстовый режим) |
| `web/equalizer.js` | 10-полосный эквалайзер, пресеты, Web Audio-граф |
| `web/beat-cover.js` | пульсация обложки под бит (captureStream или offline-анализ) |
| `web/smartmix.js` | старый RH Smart Mix. Из UI убран, оставлен в коде, **не включать** |
| `web/ai-automix/controller.js` | связка AI AutoMix с плеером RH—MUSIC |
| `web/ai-automix/automix-engine.js` | вендорный аудиодвижок AI (свои технические деки) |
| `web/time-stretch-worklet.js` | AudioWorklet для темпа AI |
| `web/_headers` | `Cache-Control: no-cache` для Pages |

Сборки нет: правишь файл — он уезжает как есть. Node нужен только для скриптов
деплоя и тестов (только встроенные модули).

### Worker-файлы

| Файл | Назначение |
|---|---|
| `worker/src/index.js` | роутер `/api/*` |
| `worker/src/http.js` | JSON-ответы, ошибки, CSRF/Origin, CORS |
| `worker/src/zvuk.js` | GraphQL-запросы Zvuk, нормализация треков/артистов/релизов |
| `worker/src/auth.js` | регистрация, вход, сессии, профиль, пароль, reauth |
| `worker/src/oauth.js` | Google Identity Services, привязка/отвязка провайдера |
| `worker/src/music.js` | библиотека, плейлисты, история |
| `worker/src/recommend.js` | персональные рекомендации |
| `worker/src/home.js` | витрина главной и плейлист каталога |
| `worker/src/popular.js` | снимок Popular и cron-обновление |
| `worker/src/lyrics.js` | тексты Zvuk → LRCLIB, нормализация, кеш |
| `worker/src/words.js` | word-level метки LiriQo + сверка |
| `worker/src/store.js` | доступ к D1 |

### D1

База: `rh-music-db`, id `164c51cd-2899-4daf-a669-a837f7a460b1`.
Миграции: `worker/migrations/*.sql`, применяются `scripts/db-migrate.mjs`.
Схема и таблицы описаны в README. Миграции только **аддитивные**: новые таблицы/AFTER-колонки,
без разрушения существующих данных.

---

## 3. Cloudflare: что где настроено

### Pages

- проект: `rh-music`
- production branch: `main`
- production URL: https://rh-music.pages.dev
- деплой: `scripts/deploy-pages.mjs` (Direct Upload API, без wrangler)
- `web/_worker.js` уезжает как Pages Function advanced mode
- `_headers`: no-cache

Деплой фронтенда:

```bash
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_ACCOUNT_ID=... \
PAGES_PROJECT=rh-music \
PAGES_BRANCH=main \
node scripts/deploy-pages.mjs
```

### Worker

- имя: `rh-music-api`
- `worker/wrangler.toml` — справочный, деплой идёт через API-скрипт
- D1 binding: `DB`
- Cron: `0 4 * * *`
- публичные переменные: `SERVICE_NAME`, `SITE_URL`, `GOOGLE_CLIENT_ID`
- секрет: `ZVUK_TOKEN`

Деплой Worker:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/deploy-worker.mjs
# при первой установке секрета:
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ZVUK_TOKEN=... node scripts/deploy-worker.mjs
```

`deploy-worker.mjs` при обновлении кода **не перезаписывает секрет** (`keep_bindings`).
Для смены секрета нужен `REPLACE_SECRET=1` и явное понимание, что делаешь.

### D1

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=164c51cd-2899-4daf-a669-a837f7a460b1 \
  node scripts/db-migrate.mjs
```

### Google OAuth

- секрет Google не нужен: используется Google Identity Services и публичный Client ID;
- `GOOGLE_CLIENT_ID` задаётся как plain var Worker;
- `SITE_URL` — публичный адрес сайта;
- `/api/auth/providers` сообщает фронтенду, включён ли Google;
- ID Token проверяется на сервере по JWKS, `email_verified` обязателен.

### Чего нельзя делать с Cloudflare

- коммитить `ZVUK_TOKEN` и любые токены;
- печатать секреты в логах/ответах;
- удалять Pages Function `/api` proxy;
- менять production branch без необходимости;
- применять миграции, которые дропают таблицы/колонки.

---

## 4. GitHub

- репозиторий: `RAHER458/rh-music`
- production branch: `main`
- push через PAT (не хранить в файлах):

```bash
git push https://<user>:<token>@github.com/RAHER458/rh-music.git main
```

Правила:

- перед push — `git status` и `git log -1`;
- не коммитить токены, секреты, временные логи, чужие файлы;
- осмысленный commit message (`fix(...)`, `feat(...)`, `chore(...)`);
- production-деплой только после тестов;
- в ответах агента всегда указывать SHA и предыдущий SHA для отката.

---

## 5. Тесты

Тесты статические/поведенческие, без внешней инфраструктуры:

```bash
cd /home/dsh/Documents/RH-MUSIC/music
for f in tests/*.mjs; do
  case "$f" in *integration*) continue;; esac
  node "$f" || echo "FAIL $f"
done
```

Важные наборы:

- `tests/lyrics.mjs`, `lyrics-ui.mjs`, `lyrics-visualizer.mjs`, `lyrics-beta.mjs`, `words.mjs`
- `tests/ai-automix.mjs`, `ai-mix-beta.mjs`, `automix2.mjs`
- `tests/smartmix*.mjs`, `smartmix-ui.mjs`
- `tests/ui.mjs`, `ui-mode.mjs`, `player.mjs`, `queue-panel.mjs`, `queue-drawer.mjs`
- `tests/beat-cover.mjs`, `oauth.mjs`, `motion.mjs`, `np-transition.mjs`, `playback-restore.mjs`

Известный флейк: `tests/smartmix.mjs` иногда падает на проверке «BPM: шум не даёт уверенного
темпа» (~1 из 3 запусков). Это шумовая проверка, не связана с UI. Перезапусти 2–3 раза.

---

## 6. Текущее состояние (актуально на последний коммит)

- main SHA: `06eeb53` (проверь `git log -1` — мог уйти вперёд)
- версии ассетов в `index.html`: `?v=release10`
- production Pages deployment: `5542c66b-...`
- production URL: https://rh-music.pages.dev

Перед деплоем всегда проверяй:

```bash
git log --oneline -3
git status --short
```

и поднимай версию ассетов `releaseN+1` в `web/index.html` (все `<script>` и `<link>`),
иначе браузер отдаст старый JS/CSS из кеша.

---

## 7. Правила работы с аудио (самое важное)

1. **Один основной `<audio id="audio">`.** Второй пользовательский плеер не создавать.
2. **`createMediaElementSource` на основном `<audio>` можно вызвать только один раз.**
   Сейчас это делает `web/equalizer.js` — и только когда пользователь вручную включает
   эквалайзер. Smart Mix удалён из UI; AI AutoMix использует **свои технические деки**.
   Не добавляй второй `createMediaElementSource` на `#audio` — звук пропадёт/плеер сломается.
3. **Никаких AudioContext на старте.** `AudioContext` создаётся только по жесту
   пользователя (Play/включение эквалайзера). Иначе контекст в `suspended` и звук глушится.
4. **Эквалайзер не подключается автоматически.** `RH_EQUALIZER.init()` выставляет
   `enabled=false`; включает пользователь вручную во время воспроизведения.
5. **Beat Reactive Cover** не использует `MediaElementSource`: только
   `audio.captureStream()` + `AnalyserNode`, а при отсутствии — офлайн-декодирование
   и карта ударов. Звук не переподключать.
6. **Текст и AI.** Синхронизация берёт время через `RH_LYRICS.setPositionProvider`.
   Если AutoMix владеет воспроизведением, провайдер возвращает время деки;
   если `null` — обязательно падать на `audio.currentTime`, а не на `0`.
7. **AI AutoMix** при выключении обязан полностью освобождать движок
   (`teardownEngine`, `engine=null`, `ctx=null`, `decks=null`), иначе кнопка не включится
   повторно без перезагрузки. Включение защищено `planEpoch`.
8. **DEGRADED AutoMix** автоматически выключается; пользователь может запустить снова.

---

## 8. Правила по тексту

- Источники: Zvuk (LRC/line) → LRCLIB (сверка по длительности/версии) → word-level LiriQo.
- Текст чужой песни показывать нельзя: обязательна сверка по метаданным/тексту.
- Нет таймингов — показывать обычный текст без ложной подсветки.
- Кнопка «Текст» блокируется, если синхронизированного текста нет; при нажатии
  на заблокированную — ничего не открывается.
- Режим «Текст» в Now Playing показывает текущую строку вместо обложки, с blur-входом
  снизу и уходом вверх; word-level заливается через `--p`.
- `sort`/источники и кеши описаны в `docs/lyrics.md`.
- Не добавлять новых провайдеров текста без проверки их доступности и лицензий.

---

## 9. UI-правила

- Нижние панели/окна закрываются drag-handle (свайп вниз) и кнопками очереди;
  крестики удалены. Зона жеста — вся шапка соответствующего окна, кнопки внутри
  исключены.
- Иконки без текстовых подписей; подписи остаются в `aria-label`.
- Now Playing: без списка очереди, действия прижаты к низу; shuffle/repeat — слева/справа
  от prev/next; состояние подсвечивается свечением/обводкой/яркостью.
- Зелёные success-тосты убраны; info/error остаются.
- Мобильный текст — самостоятельный слой с автозакрытием свайпом; автопрокрутка
  останавливается при ручном чтении и возобновляется после паузы.
- Ничего не переделывать «на глаз»: сохранять существующий дизайн и структуру DOM.

---

## 10. Чеклист нового агента после сброса контекста

1. Прочитать этот файл, `README.md`, `docs/lyrics.md`, `docs/smartmix.md`,
   `docs/ai-mix-beta.md`, `docs/automix2.md`.
2. Проверить, что ты в правильной папке: `cd /home/dsh/Documents/RH-MUSIC/music`.
3. `git fetch origin && git log --oneline -3 && git status --short`.
4. Запустить тесты (см. §5); для smartmix — 2–3 раза.
5. Спросить у пользователя токены (Cloudflare API token, account id, ZVUK_TOKEN),
   **не хранить их в репозитории**.
6. Любые изменения: минимальные, с тестами, с поднятием `releaseN`.
7. Перед деплоем всегда иметь сохранённый предыдущий SHA для отката.
8. После деплоя проверить production: `/api/health?probe=1`, загрузку сайта,
   воспроизведение, текст, AutoMix, эквалайзер.

---

## 11. Деплой и откат

Фронтенд:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
PAGES_PROJECT=rh-music PAGES_BRANCH=main \
node scripts/deploy-pages.mjs
```

Worker:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/deploy-worker.mjs
```

Откат:

```bash
git checkout <предыдущий SHA> -- web/        # или reset/ветка
CLOUDFLARE_API_TOKEN=... ... node scripts/deploy-pages.mjs
```

Простой откат фронтенда — вернуть предыдущий коммит и передеплоить Pages.
Worker откатывается повторным деплоем старого `worker/src`.

---

## 12. Чего категорически не делать

- не переписывать аудиодвижок и не создавать второй `<audio>`;
- не вызывать повторно `createMediaElementSource` на `#audio`;
- не включать Smart Mix обратно без явного запроса пользователя;
- не синхронизировать текст по BPM/таймеру и не выдумывать тайминги;
- не показывать текст другой песни;
- не добавлять платные/DRM-источники и обходы защиты;
- не логировать и не коммитить секреты;
- не ломать `/api` proxy, OAuth, D1, AI AutoMix, Smart Mix (даже отключённый), очередь и поиск;
- не менять production без запроса пользователя;
- не удалять тесты и не «чинить» падающие тесты без причины.

---

## 13. Быстрые факты для ответов пользователю

- production: https://rh-music.pages.dev
- Worker: `rh-music-api`
- Pages project: `rh-music`
- D1: `rh-music-db` / `164c51cd-2899-4daf-a669-a837f7a460b1`
- репозиторий: `RAHER458/rh-music`, ветка `main`
- cron: `0 4 * * *`
- качество аудио: только MID (MP3 128 kbps), переключателя качества нет
- язык интерфейса: русский
