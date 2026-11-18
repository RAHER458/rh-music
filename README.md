# RH—MUSIC

Веб-плеер, который ищет и воспроизводит музыку из каталога **Zvuk.com**: поиск по трекам,
исполнителям и альбомам, обложки, страницы артистов и альбомов, потоковое воспроизведение
(MP3 128 кбит/с по умолчанию, 320 кбит/с по переключателю) прямо в браузере.

* **Сайт:** https://rh-music.pages.dev
* **API (Cloudflare Worker):** https://rh-music-api.rh-launcher.workers.dev
* **Репозиторий:** https://github.com/RAHER458/rh-music

## Архитектура

```
iPhone / браузер
      │  HTML + CSS + JS (Cloudflare Pages: rh-music.pages.dev)
      ▼
Cloudflare Worker  rh-music-api
      │  GraphQL (X-Auth-Token из секрета ZVUK_TOKEN)
      ▼
zvuk.com/api/v1/graphql ──► mediaContents ──► подписанный MP3 (cdn*.zvuk.com)
```

* Токен Zvuk живёт **только** в секрете Worker `ZVUK_TOKEN`. В репозитории, в браузере и в
  ответах API его нет.
* Аудио идёт через Worker (`/api/stream/:id`), поэтому подписанные ссылки не попадают в DOM,
  а Range-запросы (перемотка) работают как обычно.

## Структура

```
web/                 статический фронтенд (Pages)
  index.html         разметка: поиск, вкладки, плеер
  styles.css         тёмная тема #0A0B10 / панели #151A2C, адаптив под iPhone
  app.js             поиск, роутер, плеер, очередь, Media Session
worker/
  src/index.js       Cloudflare Worker: GraphQL-прокси, стрим, прокси обложек
  wrangler.toml      конфигурация для wrangler
scripts/
  deploy-worker.mjs  деплой Worker через Cloudflare API (без wrangler)
  deploy-pages.mjs   деплой статики на Pages (Direct Upload API)
.github/workflows/deploy.yml   автоматический деплой из GitHub Actions
```

## API Worker

| Метод | Маршрут | Назначение |
|---|---|---|
| GET | `/api/health?probe=1` | состояние сервиса и проверка каталога |
| GET | `/api/search?q=&type=all\|tracks\|artists\|albums&limit=&cursor=` | общий поиск |
| GET | `/api/search/tracks?q=&cursor=` | только треки (с пагинацией) |
| GET | `/api/search/artists?q=` | только исполнители |
| GET | `/api/search/albums?q=` | только альбомы |
| GET | `/api/track/:id` | информация о треке |
| GET | `/api/track/:id/stream?quality=mid\|high` | JSON с подписанным адресом |
| GET | `/api/stream/:id?quality=mid\|high` | аудиопоток (Range passthrough) |
| GET | `/api/artist/:id` | исполнитель: описание, популярные треки, релизы |
| GET | `/api/album/:id` | альбом и его треки |
| GET | `/api/img?u=&size=` | прокси и кэш обложек (только `cdn-image.zvuk.com`) |
| GET | `/api/diag/stream/:id` | диагностика доступности CDN (без аудио) |

CORS: разрешены `https://rh-music.pages.dev`, превью-домены проекта и `localhost`.
Ответы с ошибками единообразны: `{ "ok": false, "error": { "code", "message" } }`.

## Деплой

Нужны переменные окружения (не коммитить!):

```bash
export CLOUDFLARE_API_TOKEN=...    # Workers Scripts:Edit, Pages:Edit
export CLOUDFLARE_ACCOUNT_ID=...
export ZVUK_TOKEN=...              # токен Zvuk (X-Auth-Token)
```

```bash
# Worker + секрет
node scripts/deploy-worker.mjs

# фронтенд на Pages
node scripts/deploy-pages.mjs
```

Или через wrangler:

```bash
cd worker
wrangler deploy
wrangler secret put ZVUK_TOKEN
```

Автодеплой: `.github/workflows/deploy.yml` (workflow_dispatch или пуш в `main`).
В настройках репозитория нужно добавить секреты `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` и `ZVUK_TOKEN`.

## Интерфейс (Dark Liquid Glass)

* **Desktop (≥1024px):** постоянный стеклянный Sidebar (Главная, Поиск, Треки, Исполнители, Альбомы, Моя музыка, «Недавние»),
  верхняя панель поиска, адаптивные сетки карточек, широкая панель плеера снизу (обложка, транспорт, прогресс, качество,
  громкость, очередь).
* **Mobile (≤768px):** компактная стеклянная панель плеера над safe-area и полноэкранный **Now Playing**
  (большая обложка, перемотка, транспорт, качество, очередь). Учитываются `viewport-fit=cover`,
  `env(safe-area-inset-*)`, `100dvh`; горизонтальной прокрутки нет.
* **Палитра:** фон `#0A0B10`, вторичный `#101426`, стекло `rgba(255,255,255,0.055)`, панели `rgba(21,26,44,0.72)`,
  границы `rgba(255,255,255,0.09)`, текст `#F2F5FF` / `#929BB7`, акценты `#6C8CFF` и `#A855F7`,
  градиент `linear-gradient(135deg, #5B7CFF, #A855F7)`.
* **Эффекты:** `backdrop-filter` только на крупных поверхностях (sidebar, топбар, плеер, Now Playing, очередь),
  локальные свечения и градиент, вычисляемый **по обложке текущего трека**, fade-up появления, hover-подсветка,
  мягкая смена обложки, анимированный эквалайзер. Всё уважает `prefers-reduced-motion`.
* **Данные главной страницы — реальные ответы Zvuk** (поиск по популярным запросам), без выдуманных треков.

## Лицензии референсов

Изучались как источники идей (код не переносился):

| Репозиторий | Лицензия | Что взято |
|---|---|---|
| id-fant/apple-music-liquidglass | нет лицензии | идеи Liquid Glass, Now Playing, градиенты от обложек |
| beanoapt/motion-flow | нет лицензии | идеи стеклянной карточки плеера и эквалайзера |
| manohar-lab/music_player | нет лицензии | идея компоновки Desktop Sidebar + нижний плеер |
| bakeolam-beep/music-player-ui | NOASSERTION | идеи glassmorphism и адаптивной сетки |
| ardianryan/Convx-Web | **GPL-3.0** | только визуальные принципы, код не копировался |

## Возможности

* Поиск по каталогу Zvuk: треки, исполнители, альбомы, подгрузка следующих страниц.
* Страница исполнителя (описание, популярные треки, релизы) и страница альбома.
* Плеер: play/pause, следующий/предыдущий, перемотка, текущее время и длительность,
  автопереход по окончании, индикация загрузки, обработка ошибок с повторным запросом
  потока, качество MID/HIGH, Media Session (экран блокировки).
* Тёмный интерфейс, адаптивная вёрстка под iPhone (safe-area, фиксированный плеер,
  отсутствие горизонтальной прокрутки).

## Ограничения

* Проект неофициальный и не связан с Zvuk.com; для доступа нужен собственный токен Zvuk.
* Качество `high` (320 кбит/с) доступно, если это позволяет подписка владельца токена.
* Публичная демонстрация использует токен владельца аккаунта; для своего развёртывания
  задайте собственный `ZVUK_TOKEN`.
