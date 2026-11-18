/* ==========================================================================
   RH—MUSIC · клиент Zvuk через Cloudflare Worker
   Архитектура: hash-роутер + vanilla JS, без сборки и зависимостей.
   Worker и его маршруты не изменяются.
   ========================================================================== */
'use strict';

const DEFAULT_API = 'https://rh-music-api.rh-launcher.workers.dev';

const API = (() => {
  const fromQuery = new URLSearchParams(location.search).get('api');
  if (fromQuery) {
    try { localStorage.setItem('rh_api', fromQuery); } catch { /* ignore */ }
    return fromQuery.replace(/\/+$/, '');
  }
  try {
    const saved = localStorage.getItem('rh_api');
    if (saved) return saved.replace(/\/+$/, '');
  } catch { /* ignore */ }
  return DEFAULT_API;
})();

const $ = (id) => document.getElementById(id);

const audio = $('audio');
const page = $('main');
const player = $('player');
const nowPlaying = $('nowPlaying');
const drawer = $('drawer');
const scrim = $('scrim');
const toastEl = $('toast');

const S = {
  route: 'home',
  query: '',
  type: 'all',
  lists: {},
  search: { tracks: emptyPage(), artists: emptyPage(), albums: emptyPage(), cursor: null, requestId: 0 },
  discovery: null,
  discoveryPromise: null,
  queue: [],
  originalQueue: null,
  index: -1,
  current: null,
  playing: false,
  loading: false,
  seeking: false,
  retried: false,
  shuffle: false,
  repeat: 'off',
  quality: readPref('rh_quality', 'mid') === 'high' ? 'high' : 'mid',
  volume: Number(readPref('rh_volume', '1')),
  muted: false,
  npOpen: false,
  drawerOpen: false,
};

function emptyPage() { return { items: [], total: 0, next: null, cursor: null }; }

function readPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function writePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

/* ───────────────────────────── утилиты ───────────────────────────── */

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE[ch]);

function fmt(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '0:00';
  const total = Math.floor(n);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function pic(url, size) {
  if (!url) return '';
  return API + '/api/img?u=' + encodeURIComponent(url) + '&size=' + (size || 300);
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.2c0-1 1.1-1.6 2-1.1l9.4 6.3a1.3 1.3 0 0 1 0 2.2L10 19c-.9.5-2-.1-2-1.1V5.2Z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M14.7 4.3a1 1 0 0 1 0 1.4L8.4 12l6.3 6.3a1 1 0 1 1-1.4 1.4l-7-7a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 1.4 0Z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 18.5a3.5 3.5 0 1 1-2-3.16V6.4a1 1 0 0 1 .76-.97l9-2.25A1 1 0 0 1 18 4.15v10.1a3.5 3.5 0 1 1-2-3.16V8.3l-7 1.75v8.45Z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M10.5 3a7.5 7.5 0 1 1-4.6 13.4l-3.2 3.2a1 1 0 1 1-1.4-1.4l3.2-3.2A7.5 7.5 0 0 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.3-9A5.2 5.2 0 0 1 12 6.6 5.2 5.2 0 0 1 21.3 12c-1.8 4.4-9.3 9-9.3 9Z"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 4.5a1 1 0 0 0-1 1V13a1 1 0 1 0 2 0V8.5a1 1 0 0 0-1-1Zm0 8.7a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z"/></svg>',
};

let toastTimer = null;
function toast(message, kind = 'error') {
  toastEl.textContent = message;
  toastEl.classList.toggle('is-info', kind === 'info');
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 4200);
}

async function api(path, options = {}) {
  const response = await fetch(API + path, { headers: { Accept: 'application/json' }, signal: options.signal });
  let payload = null;
  try { payload = await response.json(); } catch { /* ignore */ }
  if (!response.ok || !payload || payload.ok === false) {
    const message = (payload && payload.error && payload.error.message) || ('Сервер вернул HTTP ' + response.status);
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/* ───────────────────────────── локальные данные ───────────────────────────── */

const RECENT_KEY = 'rh_recent_v1';
const DISCOVERY_KEY = 'rh_discovery_v2';
const DISCOVERY_TTL = 30 * 60 * 1000;

function readRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

function pushRecent(item) {
  if (!item || !item.id) return;
  const list = readRecent().filter((x) => !(x.id === item.id && x.kind === item.kind));
  list.unshift(item);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* ignore */ }
  renderRecent();
}

function renderRecent() {
  const box = $('recentList');
  if (!box) return;
  const list = readRecent();
  if (!list.length) {
    box.innerHTML = '<div class="recent-sub" style="padding:6px 8px">Здесь появятся открытые исполнители и альбомы.</div>';
    return;
  }
  box.innerHTML = list.map((item) => `
    <a class="recent-item" href="#/${item.kind === 'artist' ? 'artist' : 'album'}/${esc(item.id)}" data-action="link">
      <span class="recent-thumb${item.kind === 'artist' ? ' round' : ''}">
        ${item.cover ? `<img src="${esc(pic(item.cover, 80))}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      </span>
      <span class="recent-meta">
        <span class="recent-title">${esc(item.title)}</span>
        <span class="recent-sub">${item.kind === 'artist' ? 'Исполнитель' : 'Альбом'}</span>
      </span>
    </a>`).join('');
}

/* ───────────────────────────── шаблоны ───────────────────────────── */

function trackRow(track, index, listName, position) {
  const isCurrent = S.current && String(S.current.id) === String(track.id);
  const showEq = isCurrent && S.playing;
  const sub = [
    track.artist
      ? (track.artistId
        ? `<a href="#/artist/${esc(track.artistId)}" data-action="link">${esc(track.artist)}</a>`
        : esc(track.artist))
      : '',
    track.album ? esc(track.album) : '',
  ].filter(Boolean).join(' · ');

  return `
    <article class="track${isCurrent ? ' is-current' : ''}" data-action="play" data-list="${esc(listName)}" data-index="${index}" data-track-id="${esc(track.id)}">
      <span class="track-index">${position ? String(position).padStart(2, '0') : '•'}</span>
      <span class="cover">
        ${track.cover ? `<img src="${esc(pic(track.cover, 160))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        <span class="fallback">♪</span>
      </span>
      <span class="track-meta">
        <span class="track-title">${esc(track.title)}</span>
        <span class="track-sub">${sub}</span>
      </span>
      <span class="track-dur">${fmt(track.duration)}</span>
      <button class="track-play" type="button" data-action="play" data-list="${esc(listName)}" data-index="${index}" aria-label="Воспроизвести ${esc(track.title)}">
        ${showEq ? '<span class="eq"><i></i><i></i><i></i><i></i></span>' : ICONS.play}
      </button>
    </article>`;
}

function trackList(tracks, listName, numbered = false) {
  return `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, listName, numbered ? i + 1 : null)).join('')}</div>`;
}

function artistCard(artist, listName, index) {
  return `
    <a class="card" href="#/artist/${esc(artist.id)}" data-action="open-artist" data-id="${esc(artist.id)}" data-list="${esc(listName || '')}" data-index="${index ?? ''}">
      <span class="card-art round">
        ${artist.cover ? `<img src="${esc(pic(artist.cover, 300))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        <button class="card-play" type="button" data-action="play-artist" data-id="${esc(artist.id)}" aria-label="Включить ${esc(artist.title)}">${ICONS.play}</button>
      </span>
      <span>
        <span class="card-title">${esc(artist.title)}</span>
        <span class="card-sub">Исполнитель</span>
      </span>
    </a>`;
}

function albumCard(album) {
  const sub = [album.artist, album.year].filter(Boolean).join(' · ');
  return `
    <a class="card" href="#/album/${esc(album.id)}" data-action="open-album" data-id="${esc(album.id)}">
      <span class="card-art">
        ${album.cover ? `<img src="${esc(pic(album.cover, 300))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        <button class="card-play" type="button" data-action="play-album" data-id="${esc(album.id)}" aria-label="Включить ${esc(album.title)}">${ICONS.play}</button>
      </span>
      <span>
        <span class="card-title">${esc(album.title)}</span>
        <span class="card-sub">${esc(sub || 'Альбом')}</span>
      </span>
    </a>`;
}

function section(title, body, { count = '', badge = '', sub = '' } = {}) {
  return `
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">${esc(title)}${badge ? `<span class="badge">${esc(badge)}</span>` : ''}</h2>
        ${count ? `<span class="section-count">${esc(count)}</span>` : ''}
      </div>
      ${sub ? `<p class="section-sub">${esc(sub)}</p>` : ''}
      ${body}
    </section>`;
}

function skeletonTracks(count = 6) {
  return `<div class="track-list">${Array.from({ length: count }, () => `
    <div class="skeleton-row">
      <div class="sk sk-art"></div>
      <div><div class="sk sk-line" style="width:56%"></div><div class="sk sk-line short" style="margin-top:8px"></div></div>
      <div class="sk sk-line" style="width:34px"></div>
    </div>`).join('')}</div>`;
}

function skeletonCards(count = 6) {
  return `<div class="grid-cards">${Array.from({ length: count }, () => `<div class="sk sk-card"></div>`).join('')}</div>`;
}

function emptyState(title, text, icon = 'note', hint = '') {
  return `
    <div class="empty">
      <div class="empty-ico">${ICONS[icon] || ICONS.note}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
    </div>`;
}

/* ───────────────────────────── подборки (реальные данные Zvuk) ───────────────────────────── */

const SEEDS = {
  artists: ['Кино', 'Miyagi', 'Zivert', 'Баста', 'Imagine Dragons', 'Metallica', 'Король и Шут', 'Три дня дождя'],
  albums: ['Группа крови Кино', 'Nevermind Nirvana', 'Evolve Imagine Dragons', 'Акустический альбом Король и Шут', 'Random Access Memories', 'Звезда по имени Солнце'],
  tracks: ['хиты', 'русский рок', 'зарубежные хиты', 'танцевальная музыка'],
};

const QUICK_QUERIES = ['Кино — Группа крови', 'Король и Шут — Лесник', 'Metallica', 'Miyagi', 'Imagine Dragons', 'Zivert', 'Баста', 'Скриптонит'];

async function pool(tasks, limit = 4) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      try { results[i] = await tasks[i](); } catch { results[i] = null; }
    }
  });
  await Promise.all(workers);
  return results;
}

function uniqueBy(items, key = 'id') {
  const seen = new Set();
  return items.filter((item) => {
    if (!item || !item[key] || seen.has(String(item[key]))) return false;
    seen.add(String(item[key]));
    return true;
  });
}

async function loadDiscovery() {
  if (S.discovery) return S.discovery;
  if (S.discoveryPromise) return S.discoveryPromise;

  try {
    const cached = JSON.parse(sessionStorage.getItem(DISCOVERY_KEY) || 'null');
    if (cached && cached.time && Date.now() - cached.time < DISCOVERY_TTL && cached.data) {
      S.discovery = cached.data;
      return S.discovery;
    }
  } catch { /* ignore */ }

  S.discoveryPromise = (async () => {
    const [artists, albums, tracks] = await Promise.all([
      pool(SEEDS.artists.map((name) => async () => {
        const data = await api('/api/search?q=' + encodeURIComponent(name) + '&type=artists&limit=2');
        return (data.artists && data.artists.items) || [];
      }), 4),
      pool(SEEDS.albums.map((name) => async () => {
        const data = await api('/api/search?q=' + encodeURIComponent(name) + '&type=albums&limit=2');
        return (data.albums && data.albums.items) || [];
      }), 4),
      pool(SEEDS.tracks.map((name) => async () => {
        const data = await api('/api/search?q=' + encodeURIComponent(name) + '&type=tracks&limit=8');
        return (data.tracks && data.tracks.items) || [];
      }), 3),
    ]);

    const data = {
      artists: uniqueBy(artists.flat()).slice(0, 12),
      albums: uniqueBy(albums.flat()).slice(0, 12),
      tracks: uniqueBy(tracks.flat()).slice(0, 24),
      updatedAt: new Date().toISOString(),
    };

    S.discovery = data;
    try { sessionStorage.setItem(DISCOVERY_KEY, JSON.stringify({ time: Date.now(), data })); } catch { /* ignore */ }
    return data;
  })();

  try {
    return await S.discoveryPromise;
  } finally {
    S.discoveryPromise = null;
  }
}

/* ───────────────────────────── главная ───────────────────────────── */

function homeSkeleton() {
  return `
    <section class="hero">
      <div class="hero-kicker"><span class="dot-live"></span> Каталог Zvuk · поток 128 кбит/с</div>
      <h1>Слушайте музыку <em>без границ</em></h1>
      <p>Поиск по миллионам треков, исполнителям и альбомам Zvuk. Нажмите Play — и музыка зазвучит прямо здесь.</p>
      <div class="chips">${QUICK_QUERIES.slice(0, 5).map((q) => `<button class="chip" type="button" data-action="quick" data-query="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    </section>
    ${section('Популярные исполнители', skeletonCards(6), { badge: 'Zvuk' })}
    ${section('Треки для вас', skeletonTracks(6), { badge: 'Zvuk' })}`;
}

async function renderHome() {
  setNav('home');
  S.route = 'home';
  document.title = 'RH—MUSIC — музыка из каталога Zvuk';
  page.innerHTML = homeSkeleton();

  let data;
  try {
    data = await loadDiscovery();
  } catch (error) {
    page.innerHTML = `
      <section class="hero">
        <div class="hero-kicker">RH—MUSIC</div>
        <h1>Не удалось загрузить <em>подборки</em></h1>
        <p>${esc(error.message)}</p>
        <div class="chips">${QUICK_QUERIES.slice(0, 4).map((q) => `<button class="chip" type="button" data-action="quick" data-query="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      </section>`;
    return;
  }

  S.lists.homeTracks = data.tracks;
  S.lists.homeArtists = data.artists;
  S.lists.homeAlbums = data.albums;

  page.innerHTML = `
    <section class="hero">
      <div class="hero-kicker"><span class="dot-live"></span> Каталог Zvuk · поток 128 кбит/с</div>
      <h1>Слушайте музыку <em>без границ</em></h1>
      <p>Поиск по каталогу Zvuk, персональные подборки и плеер, который работает прямо в браузере — на компьютере и на iPhone.</p>
      <div class="chips">
        ${QUICK_QUERIES.map((q) => `<button class="chip" type="button" data-action="quick" data-query="${esc(q)}">${esc(q)}</button>`).join('')}
      </div>
    </section>

    ${section('Популярные исполнители', `<div class="grid-cards">${data.artists.map((a, i) => artistCard(a, 'homeArtists', i)).join('')}</div>`,
      { badge: 'Zvuk', sub: 'Реальные результаты каталога по популярным запросам' })}

    ${section('Треки для вас',
      data.tracks.length
        ? trackList(data.tracks.slice(0, 12), 'homeTracks')
        : emptyState('Пока пусто', 'Каталог не вернул треки для подборки.'),
      { badge: 'Zvuk', count: String(data.tracks.length) })}

    ${section('Альбомы', `<div class="grid-cards">${data.albums.map(albumCard).join('')}</div>`,
      { badge: 'Zvuk', sub: 'Альбомы, найденные в каталоге Zvuk' })}

    <p class="section-sub">Данные: Zvuk GraphQL через Worker rh-music-api · обновлено ${esc(new Date(data.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))}</p>
  `;
}

/* ───────────────────────────── коллекции (Треки/Исполнители/Альбомы) ───────────────────────────── */

async function renderCollection(kind) {
  const titles = { tracks: 'Треки', artists: 'Исполнители', albums: 'Альбомы' };
  setNav(kind);
  S.route = kind;
  document.title = titles[kind] + ' — RH—MUSIC';
  page.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">${titles[kind]}</h1>
        <p class="page-sub">Подборка из каталога Zvuk по популярным запросам</p>
      </div>
      <div class="chips">${SEEDS[kind].slice(0, 6).map((q) => `<button class="chip" type="button" data-action="quick" data-query="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    </div>
    ${kind === 'tracks' ? skeletonTracks(8) : skeletonCards(8)}`;

  let data;
  try {
    data = await loadDiscovery();
  } catch (error) {
    page.innerHTML = emptyState('Не удалось загрузить подборку', error.message, 'alert', 'Проверьте соединение и попробуйте снова.');
    return;
  }

  if (kind === 'tracks') {
    S.lists.collectionTracks = data.tracks;
    page.innerHTML = `
      <div class="page-head">
        <div>
          <h1 class="page-title">Треки</h1>
          <p class="page-sub">${data.tracks.length} композиций из каталога Zvuk</p>
        </div>
        <div class="chips">
          <button class="chip" type="button" data-action="play-all" data-list="collectionTracks">▶ Слушать всё</button>
          ${SEEDS.tracks.map((q) => `<button class="chip" type="button" data-action="quick" data-query="${esc(q)}">${esc(q)}</button>`).join('')}
        </div>
      </div>
      ${trackList(data.tracks, 'collectionTracks', true)}`;
    return;
  }

  const items = kind === 'artists' ? data.artists : data.albums;
  S.lists['collection' + (kind === 'artists' ? 'Artists' : 'Albums')] = items;
  page.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">${titles[kind]}</h1>
        <p class="page-sub">${items.length} из каталога Zvuk</p>
      </div>
      <div class="chips">${SEEDS[kind].slice(0, 6).map((q) => `<button class="chip" type="button" data-action="quick" data-query="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    </div>
    <div class="grid-cards">
      ${items.map((item, i) => (kind === 'artists' ? artistCard(item, 'collectionArtists', i) : albumCard(item))).join('')}
    </div>`;
}

/* ───────────────────────────── поиск ───────────────────────────── */

function searchSkeleton(type) {
  if (type === 'tracks' || type === 'all') return skeletonTracks(7);
  return skeletonCards(8);
}

async function runSearch({ silent = false } = {}) {
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const query = (params.get('q') || '').trim();
  const type = ['all', 'tracks', 'artists', 'albums'].includes(params.get('type')) ? params.get('type') : 'all';

  S.query = query;
  S.type = type;
  S.route = 'search';
  setNav('search');
  $('q').value = query;
  updateSearchClear();

  if (!query) {
    S.lists.searchTracks = [];
    page.innerHTML = `
      <div class="page-head">
        <div>
          <h1 class="page-title">Поиск</h1>
          <p class="page-sub">Треки, исполнители и альбомы каталога Zvuk</p>
        </div>
      </div>
      <div class="chips" style="margin-bottom:20px">
        <button class="chip is-active" type="button" data-action="set-type" data-type="all">Всё</button>
        <button class="chip" type="button" data-action="set-type" data-type="tracks">Треки</button>
        <button class="chip" type="button" data-action="set-type" data-type="artists">Исполнители</button>
        <button class="chip" type="button" data-action="set-type" data-type="albums">Альбомы</button>
      </div>
      ${emptyState('Начните с поиска', 'Введите название трека, имя исполнителя или альбома — например, «Кино — Группа крови».', 'search',
        'Данные приходят напрямую из каталога Zvuk.')}
      <div class="chips" style="justify-content:center">
        ${QUICK_QUERIES.slice(0, 6).map((q) => `<button class="chip" type="button" data-action="quick" data-query="${esc(q)}">${esc(q)}</button>`).join('')}
      </div>`;
    document.title = 'Поиск — RH—MUSIC';
    return;
  }

  document.title = query + ' — RH—MUSIC';

  const soft = silent || S.softRender;
  if (!soft) {
    page.innerHTML = `
      <div class="page-head">
        <div>
          <h1 class="page-title">«${esc(query)}»</h1>
          <p class="page-sub">Ищем в каталоге Zvuk…</p>
        </div>
        ${typeTabs(type)}
      </div>
      ${searchSkeleton(type)}`;
  }

  const requestId = ++S.search.requestId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const data = await api(
      '/api/search?q=' + encodeURIComponent(query) + '&type=' + type + '&limit=20',
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (requestId !== S.search.requestId) return;

    S.search.tracks = data.tracks || emptyPage();
    S.search.artists = data.artists || emptyPage();
    S.search.albums = data.albums || emptyPage();
    S.search.cursor = S.search.tracks.cursor || null;
    S.lists.searchTracks = S.search.tracks.items;
    S.lists.searchArtists = S.search.artists.items;
    S.lists.searchAlbums = S.search.albums.items;

    renderSearchResults(query, type);
  } catch (error) {
    clearTimeout(timer);
    if (requestId !== S.search.requestId) return;
    if (error.name === 'AbortError') return;
    page.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">«${esc(query)}»</h1></div>${typeTabs(type)}</div>
      ${emptyState('Не удалось выполнить поиск', error.message, 'alert', 'Проверьте соединение и попробуйте снова.')}`;
  }
}

function typeTabs(active) {
  const tabs = [['all', 'Всё'], ['tracks', 'Треки'], ['artists', 'Исполнители'], ['albums', 'Альбомы']];
  return `<div class="chips" id="tabs">${tabs.map(([value, label]) =>
    `<button class="chip${active === value ? ' is-active' : ''}" type="button" data-action="set-type" data-type="${value}">${label}</button>`).join('')}</div>`;
}

function renderSearchResults(query, type) {
  const blocks = [];
  const t = S.search.tracks;
  const a = S.search.artists;
  const al = S.search.albums;

  if (type !== 'artists' && type !== 'albums' && t.items.length) {
    const more = t.next
      ? `<button class="more-btn" type="button" data-action="more">Показать ещё</button>`
      : '';
    blocks.push(section('Треки', trackList(t.items, 'searchTracks'), { count: t.total ? t.total.toLocaleString('ru-RU') : '' }) + more);
  }
  if (type !== 'tracks' && type !== 'albums' && a.items.length) {
    blocks.push(section('Исполнители', `<div class="grid-cards">${a.items.map(artistCard).join('')}</div>`, { count: String(a.total || a.items.length) }));
  }
  if (type !== 'tracks' && type !== 'artists' && al.items.length) {
    blocks.push(section('Альбомы', `<div class="grid-cards">${al.items.map(albumCard).join('')}</div>`, { count: String(al.total || al.items.length) }));
  }

  const body = blocks.length
    ? blocks.join('')
    : emptyState('Ничего не найдено', `По запросу «${query}» в каталоге Zvuk нет результатов.`, 'search', 'Попробуйте другое название или имя исполнителя.');

  page.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">«${esc(query)}»</h1>
        <p class="page-sub">${type === 'all' ? 'Общий поиск по каталогу Zvuk' : 'Поиск по каталогу Zvuk'}</p>
      </div>
      ${typeTabs(type)}
    </div>
    ${body}`;
}

async function loadMore() {
  if (!S.search.tracks.next) return;
  const button = page.querySelector('[data-action="more"]');
  if (button) { button.disabled = true; button.textContent = 'Загружаю…'; }

  try {
    const data = await api('/api/search?q=' + encodeURIComponent(S.query) + '&type=tracks&limit=20&cursor=' + encodeURIComponent(S.search.tracks.cursor));
    const items = (data.tracks && data.tracks.items) || [];
    S.search.tracks.items = S.search.tracks.items.concat(items);
    S.search.tracks.next = data.tracks ? data.tracks.next : null;
    S.search.tracks.cursor = data.tracks ? data.tracks.cursor : null;
    S.lists.searchTracks = S.search.tracks.items;

    const list = page.querySelector('.track-list');
    if (list) {
      const offset = S.search.tracks.items.length - items.length;
      list.insertAdjacentHTML('beforeend', items.map((t, i) => trackRow(t, offset + i, 'searchTracks')).join(''));
    }
    if (button) {
      if (S.search.tracks.next) { button.disabled = false; button.textContent = 'Показать ещё'; }
      else button.remove();
    }
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = 'Показать ещё'; }
  }
}

/* ───────────────────────────── артист / альбом ───────────────────────────── */

async function renderArtist(id) {
  S.route = 'artist';
  setNav(null);
  page.innerHTML = skeletonTracks(6);

  try {
    const data = await api('/api/artist/' + encodeURIComponent(id));
    const artist = data.artist;
    const tracks = data.tracks || [];
    const albums = data.albums || [];
    S.lists.artistTracks = tracks;
    S.lists.artistAlbums = albums;

    document.title = artist.title + ' — RH—MUSIC';
    pushRecent({ kind: 'artist', id: artist.id, title: artist.title, cover: artist.cover });

    page.innerHTML = `
      <button class="back-link" type="button" data-action="back">${ICONS.back} Назад</button>
      <section class="detail">
        <div class="detail-art round">
          ${artist.cover ? `<img class="cover-in" src="${esc(pic(artist.cover, 600))}" alt="" onerror="this.remove()">` : ''}
        </div>
        <div class="detail-body">
          <div class="detail-kicker">Исполнитель</div>
          <h2 class="detail-title">${esc(artist.title)}</h2>
          <div class="detail-sub">
            <span>${tracks.length ? tracks.length + ' популярных треков' : 'Треки в каталоге'}</span>
            ${albums.length ? '<span class="detail-sep"></span><span>' + albums.length + ' релизов</span>' : ''}
          </div>
          ${artist.description ? `<p class="detail-desc">${esc(artist.description)}</p>` : ''}
          <div class="detail-actions">
            ${tracks.length ? `<button class="btn btn-primary" type="button" data-action="play-all" data-list="artistTracks">${ICONS.play} Слушать</button>` : ''}
            <button class="btn btn-ghost" type="button" data-action="quick" data-query="${esc(artist.title)}">Найти все треки</button>
          </div>
        </div>
      </section>
      ${tracks.length ? section('Популярные треки', trackList(tracks, 'artistTracks', true), { count: String(tracks.length) }) : ''}
      ${albums.length ? section('Релизы', `<div class="grid-albums">${albums.map(albumCard).join('')}</div>`, { count: String(albums.length) }) : ''}
      ${!tracks.length && !albums.length ? emptyState('Пока пусто', 'Каталог не вернул данные для этого исполнителя.') : ''}`;
    window.scrollTo({ top: 0 });
  } catch (error) {
    page.innerHTML = emptyState('Исполнитель недоступен', error.message, 'alert');
  }
}

async function renderAlbum(id) {
  S.route = 'album';
  setNav(null);
  page.innerHTML = skeletonTracks(7);

  try {
    const data = await api('/api/album/' + encodeURIComponent(id));
    const album = data.album;
    const tracks = data.tracks || [];
    S.lists.albumTracks = tracks;

    document.title = album.title + ' — RH—MUSIC';
    pushRecent({ kind: 'album', id: album.id, title: album.title, cover: album.cover });

    const kind = album.type === 'single' ? 'Сингл' : album.type === 'ep' ? 'EP' : 'Альбом';
    page.innerHTML = `
      <button class="back-link" type="button" data-action="back">${ICONS.back} Назад</button>
      <section class="detail">
        <div class="detail-art">
          ${album.cover ? `<img class="cover-in" src="${esc(pic(album.cover, 600))}" alt="" onerror="this.remove()">` : ''}
        </div>
        <div class="detail-body">
          <div class="detail-kicker">${esc(kind)}</div>
          <h2 class="detail-title">${esc(album.title)}</h2>
          <div class="detail-sub">
            ${album.artistId ? `<a href="#/artist/${esc(album.artistId)}" data-action="link">${esc(album.artist)}</a>` : `<span>${esc(album.artist)}</span>`}
            ${album.year ? `<span class="detail-sep"></span><span>${esc(album.year)}</span>` : ''}
            ${tracks.length ? `<span class="detail-sep"></span><span>${tracks.length} треков</span>` : ''}
          </div>
          <div class="detail-actions">
            ${tracks.length ? `<button class="btn btn-primary" type="button" data-action="play-all" data-list="albumTracks">${ICONS.play} Слушать альбом</button>` : ''}
          </div>
        </div>
      </section>
      ${tracks.length ? section('Треки', trackList(tracks, 'albumTracks', true), { count: String(tracks.length) }) : ''}`;
    window.scrollTo({ top: 0 });
  } catch (error) {
    page.innerHTML = emptyState('Альбом недоступен', error.message, 'alert');
  }
}

/* ───────────────────────────── моя музыка (заглушка) ───────────────────────────── */

function renderLibrary() {
  setNav('library');
  S.route = 'library';
  document.title = 'Моя музыка — RH—MUSIC';
  const recent = readRecent();
  page.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">Моя музыка</h1>
        <p class="page-sub">Раздел готовится: здесь появятся избранное, плейлисты и история прослушиваний</p>
      </div>
    </div>
    ${emptyState('Пока ничего нет', 'Мы не создаём плейлисты и не храним библиотеку: этот раздел появится позже.', 'heart',
      'Сейчас можно слушать подборки и искать любую музыку в каталоге Zvuk.')}
    ${recent.length ? section('Недавно открывали', `<div class="grid-cards">${recent.map((item) => item.kind === 'artist'
      ? `<a class="card" href="#/artist/${esc(item.id)}" data-action="link">
           <span class="card-art round">${item.cover ? `<img src="${esc(pic(item.cover, 300))}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
           <span><span class="card-title">${esc(item.title)}</span><span class="card-sub">Исполнитель</span></span>
         </a>`
      : albumCard({ id: item.id, title: item.title, cover: item.cover, artist: '', year: '' })).join('')}</div>`) : ''}`;
}

/* ───────────────────────────── навигация ───────────────────────────── */

function setNav(name) {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.classList.toggle('is-active', !!name && el.dataset.nav === name);
  });
}

function go(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : '#' + hash;
  if (replace && location.hash.startsWith('#/search') && target.startsWith('#/search')) {
    history.replaceState(null, '', target);
    S.softRender = true;
    route();
    S.softRender = false;
    return;
  }
  if (location.hash === target) route();
  else location.hash = target;
}

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const path = hash.split('?')[0];
  let m;

  if (path === '/' || path === '/home') return renderHome();
  if (path === '/tracks') return renderCollection('tracks');
  if (path === '/artists') return renderCollection('artists');
  if (path === '/albums') return renderCollection('albums');
  if (path === '/library') return renderLibrary();
  if (path === '/search') return runSearch();
  if ((m = path.match(/^\/artist\/(\d+)$/))) return renderArtist(m[1]);
  if ((m = path.match(/^\/album\/(\d+)$/))) return renderAlbum(m[1]);
  return renderHome();
}

/* ───────────────────────────── плеер ───────────────────────────── */

function streamUrl(track, quality) {
  return API + '/api/stream/' + encodeURIComponent(track.id) + '?quality=' + (quality || S.quality);
}

function setQueue(tracks, index) {
  S.queue = Array.isArray(tracks) ? tracks.slice() : [];
  S.originalQueue = null;
  S.index = index;
}

function updateTransportState() {
  const hasTrack = !!S.current;
  ['play', 'playMini', 'npPlay'].forEach((id) => { const el = $(id); if (el) el.disabled = !hasTrack; });
  ['prev', 'next', 'npPrev', 'npNext'].forEach((id) => { const el = $(id); if (el) el.disabled = !S.queue.length; });
  ['seek', 'seekMini', 'seekBig'].forEach((id) => { const el = $(id); if (el) el.disabled = !hasTrack; });
  player.classList.toggle('is-playing', S.playing);
  nowPlaying.classList.toggle('is-playing', S.playing);
  player.classList.toggle('is-loading', S.loading);
  nowPlaying.classList.toggle('is-loading', S.loading);
  $('shuffle').classList.toggle('is-on', S.shuffle);
  $('npShuffle').classList.toggle('is-on', S.shuffle);
  const repeatOn = S.repeat !== 'off';
  ['repeat', 'npRepeat'].forEach((id) => {
    const el = $(id);
    el.classList.toggle('is-on', repeatOn);
    el.classList.toggle('is-one', S.repeat === 'one');
  });
}

function updateNowPlayingMeta(track) {
  $('npTitle').textContent = track ? track.title : 'Ничего не играет';
  const artistEl = $('npArtist');
  artistEl.innerHTML = track && track.artistId
    ? `<a href="#/artist/${esc(track.artistId)}" data-action="link">${esc(track.artist || 'Неизвестный исполнитель')}</a>`
    : esc(track ? (track.artist || 'Неизвестный исполнитель') : 'Выберите трек');

  $('npSong').textContent = track ? track.title : 'Ничего не играет';
  $('npSinger').textContent = track ? (track.artist || 'Неизвестный исполнитель') : 'Выберите трек';
  $('npSong').href = track ? '#/home' : '#/home';
  $('npSinger').href = track && track.artistId ? `#/artist/${track.artistId}` : '#/home';
  $('npArtistLink').textContent = 'Исполнитель';
  $('npAlbumLink').textContent = 'Альбом';
  $('npArtistLink').dataset.id = track && track.artistId ? track.artistId : '';
  $('npAlbumLink').dataset.id = track && track.albumId ? track.albumId : '';

  const mini = $('npCover');
  const big = $('npBigCover');
  [mini, big].forEach((img) => { img.classList.remove('is-loaded'); img.removeAttribute('src'); });
  if (track && track.cover) {
    const src = pic(track.cover, 640);
    big.onload = () => big.classList.add('is-loaded');
    big.onerror = () => big.classList.remove('is-loaded');
    big.src = src;
    const miniSrc = pic(track.cover, 160);
    mini.onload = () => mini.classList.add('is-loaded');
    mini.onerror = () => mini.classList.remove('is-loaded');
    mini.src = miniSrc;
  }
  updateAmbient(track ? track.cover : null);

  $('tDur').textContent = fmt(track ? track.duration : 0);
  $('npDur').textContent = fmt(track ? track.duration : 0);
  $('tCur').textContent = '0:00';
  $('npCur').textContent = '0:00';
  syncSeek(0, 0);

  if ('mediaSession' in navigator && track) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        artwork: track.cover ? [
          { src: pic(track.cover, 512), sizes: '512x512', type: 'image/jpeg' },
          { src: pic(track.cover, 256), sizes: '256x256', type: 'image/jpeg' },
        ] : [],
      });
    } catch { /* ignore */ }
  }
}

function syncSeek(current, duration) {
  const percent = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const value = String(Math.round(percent * 10));
  ['seek', 'seekMini', 'seekBig'].forEach((id) => {
    const el = $(id);
    if (!el || S.seeking) return;
    el.value = value;
    el.style.setProperty('--fill', percent + '%');
  });
  $('tCur').textContent = fmt(current);
  $('npCur').textContent = fmt(current);
}

function playIndex(index, { autoplay = true } = {}) {
  if (index < 0 || index >= S.queue.length) return;
  S.index = index;
  const track = S.queue[index];
  S.current = track;
  S.retried = false;

  updateNowPlayingMeta(track);
  renderQueue();
  markCurrentRow();
  S.loading = true;
  updateTransportState();

  audio.src = streamUrl(track);
  audio.load();

  if (autoplay) {
    const promise = audio.play();
    if (promise && promise.catch) {
      promise.catch((error) => {
        S.loading = false;
        updateTransportState();
        if (error && error.name === 'NotAllowedError') toast('Нажмите Play, чтобы разрешить воспроизведение', 'info');
        else if (error && error.name !== 'AbortError') handleAudioFailure(error.message);
      });
    }
  }
}

function handleAudioFailure(detail) {
  if (!S.current) return;
  if (!S.retried) {
    S.retried = true;
    api('/api/track/' + encodeURIComponent(S.current.id) + '/stream?quality=' + S.quality)
      .then((data) => {
        if (!data || !data.url) throw new Error('нет адреса потока');
        audio.src = data.url;
        audio.load();
        return audio.play();
      })
      .catch((error) => {
        S.loading = false;
        updateTransportState();
        toast('Не удалось воспроизвести: ' + (error.message || detail || 'ошибка аудио'));
      });
    return;
  }
  S.loading = false;
  S.playing = false;
  updateTransportState();
  toast('Не удалось воспроизвести трек. Попробуйте другой или повторите позже.');
}

function togglePlay() {
  if (!S.current) return;
  if (!audio.src) return playIndex(S.index >= 0 ? S.index : 0);
  if (audio.paused) {
    S.loading = true;
    updateTransportState();
    audio.play().catch((error) => {
      S.loading = false;
      updateTransportState();
      if (error.name !== 'AbortError') handleAudioFailure(error.message);
    });
  } else {
    audio.pause();
  }
}

function nextTrack(auto = false) {
  if (!S.queue.length) return;
  if (auto && S.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  const next = S.index + 1;
  if (next >= S.queue.length) {
    if (auto && S.repeat === 'off') { S.playing = false; updateTransportState(); return; }
    return playIndex(0);
  }
  playIndex(next);
}

function prevTrack() {
  if (!S.queue.length) return;
  if (audio.currentTime > 4) { audio.currentTime = 0; return; }
  playIndex(S.index <= 0 ? S.queue.length - 1 : S.index - 1);
}

function toggleShuffle() {
  S.shuffle = !S.shuffle;
  if (S.shuffle) {
    S.originalQueue = S.queue.slice();
    const current = S.queue[S.index];
    const rest = S.queue.filter((_, i) => i !== S.index).sort(() => Math.random() - 0.5);
    S.queue = current ? [current, ...rest] : rest;
    S.index = current ? 0 : -1;
  } else if (S.originalQueue) {
    const currentId = S.current ? String(S.current.id) : null;
    S.queue = S.originalQueue;
    S.index = currentId ? S.queue.findIndex((t) => String(t.id) === currentId) : -1;
    S.originalQueue = null;
  }
  renderQueue();
  updateTransportState();
  toast(S.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено', 'info');
}

function cycleRepeat() {
  S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
  updateTransportState();
  toast(S.repeat === 'off' ? 'Повтор выключен' : S.repeat === 'all' ? 'Повтор всей очереди' : 'Повтор одного трека', 'info');
}

function cycleQuality() {
  S.quality = S.quality === 'mid' ? 'high' : 'mid';
  writePref('rh_quality', S.quality);
  updateQualityButtons();
  if (S.current) {
    const position = audio.currentTime || 0;
    S.retried = false;
    S.loading = true;
    updateTransportState();
    audio.src = streamUrl(S.current);
    audio.load();
    const resume = () => {
      audio.removeEventListener('loadedmetadata', resume);
      if (position > 1) audio.currentTime = position;
      audio.play().catch(() => {});
    };
    audio.addEventListener('loadedmetadata', resume);
  }
  toast('Качество: ' + (S.quality === 'mid' ? 'MID · MP3 128 кбит/с' : 'HIGH · MP3 320 кбит/с'), 'info');
}

function updateQualityButtons() {
  const label = S.quality === 'mid' ? 'MID' : 'HIGH';
  const rate = S.quality === 'mid' ? '128' : '320';
  ['quality', 'npQuality'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.dataset.q = S.quality;
    el.innerHTML = `${label}<span>${rate}</span>`;
  });
}

async function updateAmbient(coverUrl) {
  if (!coverUrl) return;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.src = pic(coverUrl, 64);
    if (img.decode) await img.decode();
    else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 24, 24);
    const { data } = ctx.getImageData(0, 0, 24, 24);

    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    if (!n) return;
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);

    const boost = (value, factor) => Math.min(255, Math.round(128 + (value - 128) * factor));
    r = boost(r, 1.35); g = boost(g, 1.35); b = boost(b, 1.35);

    const root = document.documentElement.style;
    root.setProperty('--ambient-1', `rgba(${r}, ${g}, ${b}, 0.42)`);
    root.setProperty('--ambient-2', `rgba(${Math.round(b * 0.9 + 40)}, ${Math.round(r * 0.7 + 30)}, ${Math.min(255, Math.round(g * 0.8 + 90))}, 0.34)`);
  } catch { /* остаются базовые свечения */ }
}

/* ───────────────────────────── очередь ───────────────────────────── */

function renderQueue() {
  const body = $('drawerBody');
  const npList = $('npQueueList');
  const sub = $('drawerSub');
  if (sub) sub.textContent = S.queue.length ? `${S.queue.length} треков${S.shuffle ? ' · перемешано' : ''}` : 'Очередь пуста';

  if (!S.queue.length) {
    const empty = emptyState('Очередь пуста', 'Включите любой трек — очередь заполнится автоматически.');
    if (body) body.innerHTML = S.drawerOpen ? empty : '';
    if (npList) npList.innerHTML = '';
    return;
  }

  S.lists.queue = S.queue;
  const html = trackList(S.queue, 'queue', true);
  // Очередь рисуем только в открытой поверхности — не держим лишний DOM на мобильных.
  if (body) body.innerHTML = S.drawerOpen ? html : '';
  if (npList) npList.innerHTML = S.npOpen ? `<div class="section-title" style="margin:6px 0 8px">Очередь · ${S.queue.length}</div>${html}` : '';
}

function openNowPlaying(open = true) {
  S.npOpen = open;
  nowPlaying.classList.toggle('is-open', open);
  nowPlaying.setAttribute('aria-hidden', open ? 'false' : 'true');
  document.body.classList.toggle('is-locked', open || S.drawerOpen);
  renderQueue();
}

function openDrawer(open = true) {
  S.drawerOpen = open;
  drawer.classList.toggle('is-open', open);
  drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  renderQueue();
  scrim.hidden = !(open || (S.npOpen && window.innerWidth <= 768));
  scrim.classList.toggle('is-open', !scrim.hidden);
  document.body.classList.toggle('is-locked', open || S.npOpen);
}

/* ───────────────────────────── события плеера ───────────────────────────── */

audio.addEventListener('loadstart', () => { S.loading = true; updateTransportState(); });
audio.addEventListener('waiting', () => { S.loading = true; updateTransportState(); });
audio.addEventListener('canplay', () => { S.loading = false; updateTransportState(); });
audio.addEventListener('playing', () => { S.loading = false; S.playing = true; updateTransportState(); markCurrentRow(); renderQueue(); });
audio.addEventListener('pause', () => { S.playing = false; updateTransportState(); markCurrentRow(); });
audio.addEventListener('ended', () => nextTrack(true));
audio.addEventListener('error', () => {
  if (audio.error && audio.error.code === 1) return;
  handleAudioFailure(audio.error ? 'код ' + audio.error.code : null);
});

audio.addEventListener('timeupdate', () => {
  if (S.seeking) return;
  const current = audio.currentTime || 0;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (S.current ? S.current.duration : 0);
  syncSeek(current, duration);
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && duration > 0) {
    try {
      navigator.mediaSession.setPositionState({ duration, position: Math.min(current, duration), playbackRate: 1 });
    } catch { /* ignore */ }
  }
});

audio.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    $('tDur').textContent = fmt(audio.duration);
    $('npDur').textContent = fmt(audio.duration);
  }
});

audio.volume = Math.min(1, Math.max(0, S.volume));

['seek', 'seekMini', 'seekBig'].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', () => {
    S.seeking = true;
    const percent = Number(el.value) / 10;
    ['seek', 'seekMini', 'seekBig'].forEach((other) => $(other).style.setProperty('--fill', percent + '%'));
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (S.current ? S.current.duration : 0);
    $('tCur').textContent = fmt(duration * percent / 100);
    $('npCur').textContent = fmt(duration * percent / 100);
  });
  el.addEventListener('change', () => {
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (S.current ? S.current.duration : 0);
    if (duration > 0) audio.currentTime = (Number(el.value) / 1000) * duration;
    S.seeking = false;
  });
});

$('volume').addEventListener('input', (event) => {
  S.volume = Number(event.target.value) / 100;
  S.muted = S.volume === 0;
  audio.volume = S.volume;
  player.classList.toggle('is-muted', S.muted);
  writePref('rh_volume', S.volume);
});

$('mute').addEventListener('click', () => {
  S.muted = !S.muted;
  audio.volume = S.muted ? 0 : (S.volume || 0.8);
  player.classList.toggle('is-muted', S.muted);
  toast(S.muted ? 'Звук выключен' : 'Звук включён', 'info');
});

if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(false));
    navigator.mediaSession.setActionHandler('seekto', (d) => { if (d && Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime; });
    navigator.mediaSession.setActionHandler('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
    navigator.mediaSession.setActionHandler('seekforward', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });
  } catch { /* ignore */ }
}

/* ───────────────────────────── делегирование событий ───────────────────────────── */

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  if (action === 'link') return;

  if (action === 'play') {
    const list = S.lists[target.dataset.list];
    const index = Number(target.dataset.index);
    if (!list || !list[index]) return;
    const same = S.current && String(S.current.id) === String(list[index].id);
    if (same && !audio.paused) { audio.pause(); return; }
    if (same && audio.paused && audio.src) { togglePlay(); return; }
    setQueue(list, index);
    playIndex(index);
    return;
  }

  if (action === 'play-all') {
    const list = S.lists[target.dataset.list];
    if (!list || !list.length) return;
    setQueue(list, 0);
    playIndex(0);
    return;
  }

  if (action === 'play-artist' || action === 'play-album') {
    event.preventDefault();
    event.stopPropagation();
    const isArtist = action === 'play-artist';
    const id = target.dataset.id;
    target.setAttribute('disabled', 'disabled');
    api(isArtist ? '/api/artist/' + encodeURIComponent(id) : '/api/album/' + encodeURIComponent(id))
      .then((data) => {
        const list = isArtist ? (data.tracks || []) : (data.tracks || []);
        if (!list.length) throw new Error('Нет доступных треков');
        S.lists.__card = list;
        setQueue(list, 0);
        playIndex(0);
      })
      .catch((error) => toast(error.message))
      .finally(() => target.removeAttribute('disabled'));
    return;
  }

  if (action === 'quick') {
    go('/search?q=' + encodeURIComponent(target.dataset.query) + '&type=all');
    return;
  }

  if (action === 'set-type') {
    const query = $('q').value.trim() || S.query;
    const type = target.dataset.type;
    if (!query) {
      page.querySelectorAll('[data-action="set-type"]').forEach((el) => el.classList.toggle('is-active', el === target));
      S.type = type;
      return;
    }
    go('/search?q=' + encodeURIComponent(query) + '&type=' + type);
    return;
  }

  if (action === 'more') { loadMore(); return; }

  if (action === 'back') {
    if (history.length > 1) history.back();
    else go('/home');
    return;
  }

  if (action === 'open-artist') return;
  if (action === 'open-album') return;
});

$('searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('q').value.trim();
  if (!query) { $('q').focus(); return; }
  go('/search?q=' + encodeURIComponent(query) + '&type=' + S.type);
});

function updateSearchClear() {
  const bar = document.querySelector('.searchbar');
  bar.classList.toggle('has-value', $('q').value.length > 0);
}

const liveSearch = debounce(() => {
  const query = $('q').value.trim();
  if (query.length < 2) { updateSearchClear(); return; }
  if (S.route !== 'search') return;
  go('/search?q=' + encodeURIComponent(query) + '&type=' + S.type, { replace: true });
}, 420);

$('q').addEventListener('input', () => { updateSearchClear(); liveSearch(); });

$('searchClear').addEventListener('click', () => {
  $('q').value = '';
  updateSearchClear();
  if (S.route === 'search') go('/search');
  $('q').focus();
});

$('play').addEventListener('click', togglePlay);
$('playMini').addEventListener('click', togglePlay);
$('npPlay').addEventListener('click', togglePlay);
$('next').addEventListener('click', () => nextTrack(false));
$('npNext').addEventListener('click', () => nextTrack(false));
$('prev').addEventListener('click', prevTrack);
$('npPrev').addEventListener('click', prevTrack);
$('shuffle').addEventListener('click', toggleShuffle);
$('npShuffle').addEventListener('click', toggleShuffle);
$('repeat').addEventListener('click', cycleRepeat);
$('npRepeat').addEventListener('click', cycleRepeat);
$('quality').addEventListener('click', cycleQuality);
$('npQuality').addEventListener('click', cycleQuality);

$('npOpen').addEventListener('click', () => openNowPlaying(true));
$('npClose').addEventListener('click', () => openNowPlaying(false));
$('npQueue').addEventListener('click', () => openDrawer(true));
$('queueBtn').addEventListener('click', () => openDrawer(true));
$('topQueue').addEventListener('click', () => openDrawer(true));
$('drawerClose').addEventListener('click', () => openDrawer(false));
scrim.addEventListener('click', () => { openDrawer(false); openNowPlaying(false); });

$('npArtistLink').addEventListener('click', () => {
  const id = $('npArtistLink').dataset.id;
  if (!id) { toast('Исполнитель не указан', 'info'); return; }
  openNowPlaying(false);
  go('/artist/' + id);
});

$('npAlbumLink').addEventListener('click', () => {
  const id = $('npAlbumLink').dataset.id;
  if (!id) { toast('Альбом не указан', 'info'); return; }
  openNowPlaying(false);
  go('/album/' + id);
});

document.addEventListener('keydown', (event) => {
  const tag = (event.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (event.key === ' ' && tag !== 'button') { event.preventDefault(); togglePlay(); }
  else if (event.key === 'ArrowRight' && event.shiftKey) { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); }
  else if (event.key === 'ArrowLeft' && event.shiftKey) { audio.currentTime = Math.max(0, audio.currentTime - 5); }
  else if (event.key === 'Escape') { openDrawer(false); openNowPlaying(false); }
});

window.addEventListener('hashchange', route);
window.addEventListener('resize', syncPlayerHeight);

/* ───────────────────────────── старт ───────────────────────────── */

function syncPlayerHeight() {
  const height = player.getBoundingClientRect().height || 96;
  document.documentElement.style.setProperty('--player-h', Math.round(height) + 'px');
}

if ('ResizeObserver' in window) new ResizeObserver(syncPlayerHeight).observe(player);

function markCurrentRow() {
  document.querySelectorAll('.track').forEach((row) => {
    const isCurrent = S.current && row.dataset.trackId === String(S.current.id);
    row.classList.toggle('is-current', !!isCurrent);
    const button = row.querySelector('.track-play');
    if (!button) return;
    if (isCurrent && S.playing) {
      button.innerHTML = '<span class="eq"><i></i><i></i><i></i><i></i></span>';
    } else if (button.querySelector('.eq')) {
      button.innerHTML = ICONS.play;
    }
  });
}

updateQualityButtons();
renderRecent();
drawer.setAttribute('aria-hidden', 'true');
nowPlaying.setAttribute('aria-hidden', 'true');
syncPlayerHeight();
updateTransportState();
renderQueue();
route();

setTimeout(() => { try { loadDiscovery(); } catch { /* ignore */ } }, 1200);