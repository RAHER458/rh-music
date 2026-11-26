/* ==========================================================================
   RH—MUSIC · клиент сервиса
   Mobile-first SPA: каталог, аккаунт, библиотека, плейлисты, история, рекомендации.
   Аудио всегда запрашивается в качестве MID.
   ========================================================================== */
'use strict';

window.RH_BUILD = 'neural-2026-11-22-1';
const RH_DEBUG = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

const API = ''; // тот же домен, что и сайт (прокси Pages → Worker)

const $ = (id) => document.getElementById(id);

const audio = $('audio');
const page = $('main');
const player = $('player');
const nowPlaying = $('nowPlaying');
const drawer = $('drawer');
const sheet = $('sheet');
const sheetPanel = $('sheetPanel');
const scrim = $('scrim');
const toastEl = $('toast');
const tabbar = $('tabbar');

const S = {
  route: 'home',
  user: null,
  libraryIds: new Set(),
  playlists: [],
  lists: {},
  search: { tracks: emptyPage(), artists: emptyPage(), albums: emptyPage(), requestId: 0 },
  recommendations: null,
  recommendationsAt: 0,
  home: null,
  homeAt: 0,
  providers: null,
  identities: null,
  security: null,
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
  npOpen: false,
  drawerOpen: false,
  sheetOpen: false,
  lyricsOpen: false,
  queueTab: 'queue',
  recentSearches: readJson('rh_searches_v1', []),
  playback: { historyId: null, trackId: null, pending: 0, lastTick: 0, completed: false, source: 'player' },
  restorePosition: 0,
  restoreTrackId: null,
  lastStateSave: 0,
  playerHidden: false,
  volume: 1,
  muted: false,
  queueOpen: false,
  discoveryLoadedFor: null,
};

function emptyPage() { return { items: [], total: 0, next: null, cursor: null }; }

/* ───────────────────────────── утилиты ───────────────────────────── */

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE[ch]);

function fmt(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '0:00';
  const total = Math.floor(n);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function fmtDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  const days = Math.floor(diff / 86400000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 7) return days + ' дн. назад';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function pic(url, size) {
  if (!url) return '';
  return API + '/api/img?u=' + encodeURIComponent(url) + '&size=' + (size || 300);
}

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.2c0-1 1.1-1.6 2-1.1l9.4 6.3a1.3 1.3 0 0 1 0 2.2L10 19c-.9.5-2-.1-2-1.1V5.2Z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M14.7 4.3a1 1 0 0 1 0 1.4L8.4 12l6.3 6.3a1 1 0 1 1-1.4 1.4l-7-7a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 1.4 0Z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 18.5a3.5 3.5 0 1 1-2-3.16V6.4a1 1 0 0 1 .76-.97l9-2.25A1 1 0 0 1 18 4.15v10.1a3.5 3.5 0 1 1-2-3.16V8.3l-7 1.75v8.45Z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M10.5 3a7.5 7.5 0 1 1-4.6 13.4l-3.2 3.2a1 1 0 1 1-1.4-1.4l3.2-3.2A7.5 7.5 0 0 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.3-9A5.2 5.2 0 0 1 12 6.6 5.2 5.2 0 0 1 21.3 12c-1.8 4.4-9.3 9-9.3 9Z"/></svg>',
  heartFilled: '<svg viewBox="0 0 24 24"><path d="M12 20.6S5.2 16.4 3.4 12.2A4.9 4.9 0 0 1 12 7.4a4.9 4.9 0 0 1 8.6 4.8c-1.8 4.2-8.6 8.4-8.6 8.4Z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="M6 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 4.5a1 1 0 0 0-1 1V13a1 1 0 1 0 2 0V8.5a1 1 0 0 0-1-1Zm0 8.7a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 4a1 1 0 0 1 1 1v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5a1 1 0 0 1 1-1Z"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M4 6a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Zm0 6a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Zm0 6a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M10 3h4a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7H5a1 1 0 0 1 0-2h4V4a1 1 0 0 1 1-1Zm-2 5v11h8V8H8Z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 17.2 15.6 5.6l2.8 2.8L6.8 20H4v-2.8ZM17 4.2l1.3-1.3a1.5 1.5 0 0 1 2.1 0l1.7 1.7a1.5 1.5 0 0 1 0 2.1L20.8 8 17 4.2Z"/></svg>',
  user: '<svg viewBox="0 0 24 24"><path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.1 0-7.5 2.3-7.5 5.1 0 .5.4.9.9.9h13.2c.5 0 .9-.4.9-.9 0-2.8-3.4-5.1-7.5-5.1Z"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 7.5 18.4 14a1.2 1.2 0 0 1-1.7 1.7L12 10.9l-4.7 4.8A1.2 1.2 0 0 1 5.6 14L12 7.5Z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 16.5 5.6 10a1.2 1.2 0 0 1 1.7-1.7l4.7 4.7 4.7-4.7A1.2 1.2 0 0 1 18.4 10L12 16.5Z"/></svg>',
  logout: '<svg viewBox="0 0 24 24"><path d="M10 4a1 1 0 0 1 0 2H6v12h4a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5Zm6.3 3.3a1 1 0 0 1 1.4 0l4 4a1 1 0 0 1 0 1.4l-4 4a1 1 0 0 1-1.4-1.4l2.3-2.3H11a1 1 0 1 1 0-2h7.6l-2.3-2.3a1 1 0 0 1 0-1.4Z"/></svg>',
};

let toastTimer = null;
function toast(message, kind = 'error') {
  // Зелёные успех-уведомления убраны: визуальная обратная связь
  // остаётся у кнопок и состояний, без всплывающих подписей.
  if (kind === 'ok') return;
  toastEl.textContent = message;
  toastEl.className = 'toast';
  if (kind === 'info') toastEl.classList.add('is-info');
  if (kind === 'ok') toastEl.classList.add('is-ok');
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 3600);
}

/* ───────────────────────────── API ───────────────────────────── */

async function api(path, { method = 'GET', body, csrf = false, keepalive = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf || method !== 'GET') headers['X-RH-Request'] = '1';

  const response = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    keepalive,
  });

  let payload = null;
  try { payload = await response.json(); } catch { /* ignore */ }

  if (response.status === 401) {
    setUser(null);
    const error = new Error((payload && payload.error && payload.error.message) || 'Требуется вход');
    error.status = 401;
    throw error;
  }
  if (!response.ok || !payload || payload.ok === false) {
    const error = new Error((payload && payload.error && payload.error.message) || ('Ошибка ' + response.status));
    error.status = response.status;
    error.code = payload && payload.error && payload.error.code;
    throw error;
  }
  return payload;
}

/* ───────────────────────────── аккаунт ───────────────────────────── */

function setUser(user) {
  S.user = user;
  const name = user ? (user.displayName || user.username) : 'Гость';
  $('sideName').textContent = name;
  $('sideSub').textContent = user ? user.email : 'Войти или создать аккаунт';
  $('sideAvatar').textContent = name.slice(0, 1).toUpperCase();
  $('topAvatar').textContent = name.slice(0, 1).toUpperCase();
  if (!user) {
    S.libraryIds = new Set();
    S.playlists = [];
  }
  if (window.RH_SETTINGS && typeof window.RH_SETTINGS.syncUser === 'function') {
    window.RH_SETTINGS.syncUser(user);
  }
}

async function refreshMe() {
  try {
    const data = await api('/api/auth/me');
    setUser(data.user);
    if (data.user) {
      S.repeat = data.preferences.repeat || 'off';
      S.shuffle = !!data.preferences.shuffle;
      await Promise.all([refreshLibraryIds(), refreshPlaylists()]);
    }
    return data;
  } catch {
    setUser(null);
    return { user: null };
  }
}

async function refreshLibraryIds() {
  if (!S.user) return;
  try {
    const data = await api('/api/library/ids');
    S.libraryIds = new Set(data.ids.map(String));
  } catch { /* ignore */ }
}

async function refreshPlaylists() {
  if (!S.user) { S.playlists = []; renderSidePlaylists(); return; }
  try {
    const data = await api('/api/playlists');
    S.playlists = data.items || [];
  } catch { S.playlists = []; }
  renderSidePlaylists();
}

function renderSidePlaylists() {
  const box = $('sidePlaylists');
  if (!box) return;
  if (!S.user) { box.innerHTML = '<div class="recent-sub" style="padding:6px 8px">Войдите, чтобы создавать плейлисты</div>'; return; }
  if (!S.playlists.length) { box.innerHTML = '<div class="recent-sub" style="padding:6px 8px">Плейлистов пока нет</div>'; return; }
  box.innerHTML = S.playlists.slice(0, 8).map((playlist) => `
    <a class="side-playlist" href="#/playlist/${playlist.id}" data-link>
      <span class="avatar" style="width:22px;height:22px;font-size:10px">${esc((playlist.title || '?').slice(0, 1))}</span>
      <span>${esc(playlist.title)}</span>
    </a>`).join('');
}

function requireAuth(message = 'Войдите, чтобы пользоваться библиотекой и плейлистами.') {
  if (S.user) return true;
  sheetOpen(`
    <h2 class="sheet-title">Нужен аккаунт</h2>
    <p class="sheet-sub">${esc(message)}</p>
    <div class="sheet-actions">
      <a class="sheet-item" href="#/login" data-link data-close-sheet>${ICONS.user} Войти</a>
      <a class="sheet-item" href="#/register" data-link data-close-sheet>${ICONS.plus} Создать аккаунт</a>
    </div>`);
  return false;
}

/* ───────────────────────────── шаблоны ───────────────────────────── */

function trackRow(track, index, listName, position, options = {}) {
  const isCurrent = S.current && String(S.current.id) === String(track.id);
  const saved = S.libraryIds.has(String(track.id));
  const sub = [
    track.artist
      ? (track.artistId ? `<a href="#/artist/${esc(track.artistId)}" data-link>${esc(track.artist)}</a>` : esc(track.artist))
      : '',
    track.album ? esc(track.album) : '',
  ].filter(Boolean).join(' · ');

  return `
    <article class="track${isCurrent ? ' is-current' : ''}" data-action="play" data-list="${esc(listName)}" data-index="${index}" data-track-id="${esc(track.id)}">
      <span class="track-index">${position ? String(position).padStart(2, '0') : '•'}</span>
      <span class="cover">
        ${track.cover ? `<img src="${esc(pic(track.cover, 160))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        <span class="cover-fallback">♪</span>
      </span>
      <span class="track-meta">
        <span class="track-title">${esc(track.title)}</span>
        <span class="track-sub">${sub}</span>
      </span>
      <span class="track-dur">${fmt(track.duration)}</span>
      <span class="track-actions">
        <button class="row-btn${saved ? ' is-on' : ''}" type="button" data-action="toggle-save" data-list="${esc(listName)}" data-index="${index}" aria-label="${saved ? 'Убрать из библиотеки' : 'Сохранить в библиотеку'}">
          ${saved ? ICONS.heartFilled : ICONS.heart}
        </button>
        <button class="row-btn" type="button" data-action="track-menu" data-list="${esc(listName)}" data-index="${index}" aria-label="Действия с треком">
          ${ICONS.more}
        </button>
      </span>
    </article>`;
}

function trackList(tracks, listName, numbered = false, options = {}) {
  if (!tracks.length) return '';
  return `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, listName, numbered ? i + 1 : null, options)).join('')}</div>`;
}

function artistCard(artist) {
  return `
    <a class="card" href="#/artist/${esc(artist.id)}" data-link>
      <span class="card-art round">
        ${artist.cover ? `<img src="${esc(pic(artist.cover, 300))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        <span class="cover-fallback">♪</span>
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
    <a class="card" href="#/album/${esc(album.id)}" data-link>
      <span class="card-art">
        ${album.cover ? `<img src="${esc(pic(album.cover, 300))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        <span class="cover-fallback">♪</span>
        <button class="card-play" type="button" data-action="play-album" data-id="${esc(album.id)}" aria-label="Включить ${esc(album.title)}">${ICONS.play}</button>
      </span>
      <span>
        <span class="card-title">${esc(album.title)}</span>
        <span class="card-sub">${esc(sub || 'Альбом')}</span>
      </span>
    </a>`;
}

function section(title, body, { count = '', sub = '', key = '' } = {}) {
  return `
    <section class="section"${key ? ` data-section="${esc(key)}"` : ''}>
      <div class="section-head">
        <div>
          <h2 class="section-title">${esc(title)}</h2>
          ${sub ? `<p class="section-sub">${esc(sub)}</p>` : ''}
        </div>
        ${count ? `<span class="section-count">${esc(count)}</span>` : ''}
      </div>
      ${body}
    </section>`;
}

function skeletonTracks(count = 6) {
  return `<div class="track-list">${Array.from({ length: count }, () => `
    <div class="skeleton-row">
      <div class="sk sk-art"></div>
      <div><div class="sk sk-line" style="width:56%"></div><div class="sk sk-line short" style="margin-top:8px"></div></div>
      <div class="sk sk-line" style="width:28px"></div>
    </div>`).join('')}</div>`;
}

function skeletonCards(count = 6) {
  return `<div class="grid-cards">${Array.from({ length: count }, () => '<div class="sk sk-card"></div>').join('')}</div>`;
}

function emptyState(title, text, icon = 'note', hint = '', actions = '') {
  return `
    <div class="empty">
      <div class="empty-ico">${ICONS[icon] || ICONS.note}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
      ${actions ? `<div class="empty-actions">${actions}</div>` : ''}
    </div>`;
}

/* ───────────────────────────── главная и рекомендации ───────────────────────────── */

const SECTION_TITLES = [
  [/^\/(home)?$/, 'Главная'],
  [/^\/search/, 'Поиск'],
  [/^\/for-you/, 'Рекомендации'],
  [/^\/library/, 'Моя музыка'],
  [/^\/favorites/, 'Любимые треки'],
  [/^\/albums/, 'Альбомы'],
  [/^\/artists/, 'Исполнители'],
  [/^\/playlists/, 'Плейлисты'],
  [/^\/playlist\/\d+/, 'Плейлист'],
  [/^\/catalog\/playlist\/\d+/, 'Плейлист каталога'],
  [/^\/history|^\/recent/, 'История прослушивания'],
  [/^\/artist\/\d+/, 'Исполнитель'],
  [/^\/album\/\d+/, 'Альбом'],
  [/^\/account/, 'Аккаунт'],
  [/^\/settings/, 'Настройки'],
  [/^\/login/, 'Вход'],
  [/^\/register/, 'Регистрация'],
];

function updateSectionTitle(path) {
  const el = $('pageTitle');
  if (!el) return;
  const hit = SECTION_TITLES.find(([re]) => re.test(path));
  el.textContent = hit ? hit[1] : 'RH—MUSIC';
}

function setNav(name) {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    const active = !!name && el.dataset.nav === name;
    el.classList.toggle('is-active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}

async function loadRecommendations(force = false) {
  if (!S.user) { S.recommendations = null; return null; }
  if (window.RH_SETTINGS && !window.RH_SETTINGS.get('personalization')) { S.recommendations = null; return null; }
  if (!force && S.recommendations && Date.now() - S.recommendationsAt < 60000) return S.recommendations;
  const data = await api('/api/recommendations');
  S.recommendations = data;
  S.recommendationsAt = Date.now();
  return data;
}

/* ───────────────────────────── витрина ───────────────────────────── */

function playlistCard(playlist) {
  const minutes = playlist.duration ? Math.round(playlist.duration / 60) : 0;
  const sub = playlist.description || (minutes ? minutes + ' мин' : 'Плейлист');
  return `
    <a class="card" href="#/catalog/playlist/${esc(playlist.id)}" data-link>
      <span class="card-art">
        ${playlist.cover ? `<img src="${esc(pic(playlist.cover, 300))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        <span class="cover-fallback">♪</span>
        <button class="card-play" type="button" data-action="play-catalog-playlist" data-id="${esc(playlist.id)}" aria-label="Включить ${esc(playlist.title)}">${ICONS.play}</button>
      </span>
      <span>
        <span class="card-title">${esc(playlist.title)}</span>
        <span class="card-sub">${esc(sub)}</span>
      </span>
    </a>`;
}

function carousel(items, renderItem) {
  return `<div class="carousel">${items.map(renderItem).join('')}</div>`;
}

async function loadHome(force = false) {
  if (!force && S.home && Date.now() - S.homeAt < 120000) return S.home;
  const data = await api('/api/home');
  S.home = data;
  S.homeAt = Date.now();
  return data;
}

function trackCard(track, index, listName) {
  const sub = [track.artist, track.album].filter(Boolean).join(' · ');
  return `<article class="card track-card" data-action="play" data-list="${esc(listName)}" data-index="${index}" data-track-id="${esc(track.id)}">
    <span class="card-art">
      ${track.cover ? `<img src="${esc(pic(track.cover, 300))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
      <span class="cover-fallback">♪</span>
      <span class="card-play" aria-hidden="true">${ICONS.play}</span>
    </span>
    <span class="card-title">${esc(track.title)}</span>
    ${sub ? `<span class="card-sub">${esc(sub)}</span>` : ''}
  </article>`;
}

function trackCards(items, listName) {
  const tracks = (Array.isArray(items) ? items : []).slice(0, 10);
  S.lists[listName] = tracks;
  return `<div class="carousel">${tracks.map((track, index) => trackCard(track, index, listName)).join('')}</div>`;
}

function compactCarousel(items, renderItem) {
  return `<div class="carousel">${(Array.isArray(items) ? items : []).slice(0, 10).map(renderItem).join('')}</div>`;
}

async function renderShowcase() {
  S.route = 'home';
  setNav('home');
  document.title = 'RH—MUSIC';

  if (!S.home) {
    page.innerHTML = `
      <div class="hero-skeleton"><div class="sk sk-hero"></div></div>
      ${skeletonCards(4)}`;
  }

  let data;
  const extras = [];
  try {
    const [home, history, personal] = await Promise.all([
      loadHome(true),
      (async () => {
        if (!S.user) return [];
        try { const page = await api('/api/history?limit=12'); return page.items || []; } catch { return []; }
      })(),
      (async () => {
        if (!S.user) return null;
        try { const page = await loadRecommendations(); return (page && page.sections || []).find((item) => item && item.items && item.items.length); } catch { return null; }
      })(),
    ]);
    data = home;
    if (history.length) extras.push({ key: 'home-recent', type: 'tracks', displayTitle: 'Недавно прослушано', items: history.slice(0, 12) });
    if (personal && personal.items && personal.items.length) {
      extras.push({ ...personal, key: 'home-personal-' + (personal.key || 'mix'), displayTitle: personal.title || 'Для вас' });
    }
  } catch (error) {
    page.innerHTML = emptyState('Витрина недоступна', error.message, 'alert',
      'Общий контент каталога временно не отвечает — попробуйте обновить страницу.',
      '<button class="btn btn-ghost" type="button" data-action="reload-home">Обновить</button>');
    return;
  }

  const sections = (data.sections || []).filter((block) => block && block.type !== 'banner');
  const hero = data.hero || null;
  let popular = null;
  try { popular = await api('/api/popular'); } catch { popular = null; }
  const heroBlock = hero ? `
    <div class="hero home-hero">
      <div class="hero-art">
        ${hero.cover ? `<img src="${esc(pic(hero.cover, 600))}" alt="" decoding="async" onerror="this.remove()">` : ''}
        <span class="cover-fallback big">RH</span>
      </div>
      <div class="hero-info">
        <span class="hero-kicker">Подборка дня</span>
        <h1 class="hero-title">${esc(hero.title)}</h1>
        ${hero.description ? `<p class="hero-sub">${esc(hero.description)}</p>` : ''}
        <div class="hero-actions">
          <a class="btn btn-primary" href="#/catalog/playlist/${esc(hero.id)}" data-link>${ICONS.play} Слушать</a>
        </div>
      </div>
    </div>` : '';

  // Витрина — это короткий обзор, а не каталог. Показываем только
  // четыре смысловые подборки, остальные данные не раздувают страницу.
  const wanted = [
    { key: 'content-1124972', type: 'tracks', title: 'Сейчас в тренде' },
    { key: 'top-new-playlists', type: 'playlists', title: 'Плейлисты' },
    { key: 'new-releases', type: 'albums', title: 'Новые релизы' },
    { key: 'content-1062105', type: 'tracks', title: 'Топ 100' },
  ];
  const chosen = extras.slice(0, 2);
  const usedKeys = new Set(chosen.map((item) => item.key));
  for (const want of wanted) {
    if (chosen.length >= 5) break;
    let block = sections.find((item) => item.key === want.key && item.type === want.type);
    if (!block) block = sections.find((item) => item.type === want.type && !usedKeys.has(item.key));
    if (!block || usedKeys.has(block.key)) continue;
    usedKeys.add(block.key);
    chosen.push({ ...block, displayTitle: want.title });
  }
  if (chosen.length < 3) {
    for (const block of sections) {
      if (chosen.length >= 5) break;
      if (usedKeys.has(block.key) || block.type === 'artists') continue;
      usedKeys.add(block.key);
      chosen.push(block);
    }
  }

  const blocks = chosen.map((block, index) => {
    const listKey = 'home_' + block.key;
    if (block.type === 'playlists') {
      return section(block.displayTitle || block.title, compactCarousel(block.items, playlistCard), { sub: index === 0 ? 'Подборки для настроения' : '', key: block.key });
    }
    if (block.type === 'albums') {
      return section(block.displayTitle || block.title, compactCarousel(block.items, albumCard), { sub: index === 0 ? 'Свежие пластинки' : '', key: block.key });
    }
    if (block.type === 'artists') {
      if ((block.items || []).length < 2) return '';
      return section(block.displayTitle || block.title, compactCarousel(block.items, artistCard), { key: block.key });
    }
    return section(block.displayTitle || block.title, trackCards(block.items, listKey), { key: block.key });
  }).filter(Boolean);

  const popularBlock = (() => {
    const sectionData = (popular && popular.sections || []).find((block) => block && block.items && block.items.length);
    if (!sectionData) return '';
    const items = sectionData.items.slice(0, 10);
    let html = '';
    if (sectionData.type === 'playlists') html = compactCarousel(items, playlistCard);
    else if (sectionData.type === 'albums') html = compactCarousel(items, albumCard);
    else if (sectionData.type === 'artists') html = compactCarousel(items, artistCard);
    else html = trackCards(items, 'home_popular');
    return section('Популярное', html, { sub: sectionData.title || 'Обновляется ежедневно' });
  })();

  page.innerHTML = `
    <div class="page-head home-head">
      <div>
        <h1 class="page-title">${S.user ? 'Привет, ' + esc(S.user.displayName || S.user.username) : 'Главная'}</h1>
        <p class="page-sub">Подборка дня, новинки и плейлисты — без длинных списков.</p>
      </div>
      <button class="btn btn-ghost home-search" type="button" data-action="focus-search">${ICONS.search || ''} Найти музыку</button>
    </div>
    <div id="waveSlot"></div>
    ${popularBlock}
    ${heroBlock}
    ${blocks.join('')}
  `;
  if (window.RH_WAVE) window.RH_WAVE.mount();
}

/* ───────────────────────────── персональные рекомендации ───────────────────────────── */

async function renderRecommendations() {
  S.route = 'for-you';
  setNav('for-you');
  document.title = 'Рекомендации — RH—MUSIC';

  if (!S.user) {
    page.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Рекомендации</h1><p class="page-sub">Индивидуальная подборка по вашей истории</p></div></div>
      ${emptyState('Войдите в аккаунт', 'Рекомендации строятся только по вашей истории прослушиваний, библиотеке и плейлистам.',
        'user', 'Без аккаунта доступна витрина, поиск и воспроизведение музыки.',
        `<a class="btn btn-primary" href="#/login" data-link>Войти</a><a class="btn btn-ghost" href="#/register" data-link>Создать аккаунт</a>`)}
    `;
    return;
  }

  page.innerHTML = `<div class="page-head"><div><div class="sk sk-line" style="width:220px;height:24px"></div></div></div>${skeletonCards(4)}`;
  let data;
  try {
    data = await loadRecommendations(true);
  } catch (error) {
    page.innerHTML = emptyState('Не удалось загрузить рекомендации', error.message, 'alert', 'Попробуйте обновить позже.');
    return;
  }

  const sections = (data && data.sections) || [];
  if (!sections.length) {
    page.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Рекомендации</h1><p class="page-sub">Пока недостаточно данных</p></div></div>
      <div class="notice"><span>${ICONS.note}</span><span>Послушайте несколько треков и добавьте любимые в «Мою музыку» — подборки появятся постепенно.</span></div>
      ${emptyState('Ничего не прослушано', 'Включите любой трек — раздел начнёт наполняться.', 'search', '', '<a class="btn btn-primary" href="#/search" data-link>Найти музыку</a>')}
    `;
    return;
  }

  // Рекомендации — три короткие полки, а не бесконечная лента.
  const chosen = sections.slice(0, 3);
  const blocks = chosen.map((sectionData, index) => {
    const listKey = 'rec_' + sectionData.key;
    const items = (sectionData.items || []).slice(0, 10);
    if (sectionData.type === 'albums') {
      return section(sectionData.title, compactCarousel(items, albumCard), { sub: index === 0 ? 'Собрано по вашим прослушиваниям' : '', key: sectionData.key });
    }
    return section(sectionData.title, trackCards(items, listKey), { sub: index === 0 ? 'Следующие треки для вас' : '', key: sectionData.key });
  });

  const stats = data.plays
    ? `<span class="rec-stat">${Number(data.tracks) || 0} треков</span><span class="rec-stat">${Number(data.plays) || 0} прослушиваний</span>`
    : '<span class="rec-stat">Начните слушать — подборки обновятся</span>';

  page.innerHTML = `
    <div class="page-head rec-head">
      <div>
        <h1 class="page-title">Рекомендации</h1>
        <p class="page-sub">Короткая персональная подборка</p>
      </div>
      <div class="rec-stats">${stats}</div>
    </div>
    ${blocks.join('')}
  `;
}

/* ───────────────────────────── плейлист каталога ───────────────────────────── */

async function renderCatalogPlaylist(id) {
  S.route = 'catalog-playlist';
  setNav('home');
  page.innerHTML = '<div class="page-head"><div class="sk sk-line" style="width:40%;height:26px"></div></div>' + skeletonTracks(8);

  let data;
  try {
    data = await api('/api/playlist/' + encodeURIComponent(id));
  } catch (error) {
    page.innerHTML = emptyState('Плейлист недоступен', error.message, 'alert');
    return;
  }

  const playlist = data.playlist;
  const tracks = data.tracks || [];
  document.title = playlist.title + ' — RH—MUSIC';
  S.lists.catalogTracks = tracks;

  page.innerHTML = `
    <div class="page-head playlist-head">
      <div class="playlist-cover">
        ${playlist.cover ? `<img src="${esc(pic(playlist.cover, 400))}" alt="" decoding="async" onerror="this.remove()">` : ''}
        <span class="cover-fallback big">RH</span>
      </div>
      <div class="playlist-head-text">
        <span class="kicker">Плейлист каталога</span>
        <h1 class="page-title">${esc(playlist.title)}</h1>
        <p class="page-sub">${esc(playlist.description || '')}</p>
        <p class="page-sub">${tracks.length} ${tracks.length === 1 ? 'трек' : 'треков'}${playlist.duration ? ' · ' + fmt(playlist.duration) : ''}</p>
        ${tracks.length ? `<div class="playlist-actions">
          <button class="btn btn-primary" type="button" data-action="play-all" data-list="catalogTracks">${ICONS.play} Слушать</button>
          <button class="btn btn-ghost" type="button" data-action="shuffle-list" data-list="catalogTracks">${ICONS.shuffle || ICONS.play} Перемешать</button>
        </div>` : ''}
      </div>
    </div>
    ${tracks.length ? trackList(tracks, 'catalogTracks', true) : emptyState('Пусто', 'В этом плейлисте нет доступных треков.', 'note')}
  `;
}

/* ───────────────────────────── поиск ───────────────────────────── */

function saveRecentSearch(query) {
  if (!query) return;
  S.recentSearches = [query, ...S.recentSearches.filter((q) => q.toLowerCase() !== query.toLowerCase())].slice(0, 8);
  writeJson('rh_searches_v1', S.recentSearches);
}

async function renderSearch({ focus = false } = {}) {
  S.route = 'search';
  setNav('search');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const query = (params.get('q') || '').trim();
  const type = ['all', 'tracks', 'artists', 'albums'].includes(params.get('type')) ? params.get('type') : 'all';
  S.query = query;
  S.type = type;
  document.title = query ? query + ' — RH—MUSIC' : 'Поиск — RH—MUSIC';

  const tabs = [['all', 'Всё'], ['tracks', 'Треки'], ['artists', 'Исполнители'], ['albums', 'Альбомы']];

  page.innerHTML = `
    <div class="search-screen">
      <div class="search-field${query ? ' has-value' : ''}" id="searchField">
        <svg class="search-ico" viewBox="0 0 24 24"><path d="M10.5 3a7.5 7.5 0 1 1-4.6 13.4l-3.2 3.2a1 1 0 1 1-1.4-1.4l3.2-3.2A7.5 7.5 0 0 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"/></svg>
        <input id="searchInput" type="search" placeholder="Треки, исполнители, альбомы" enterkeyhint="search"
               autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(query)}" aria-label="Поиск музыки">
        <button class="search-clear" id="searchClearInline" type="button" aria-label="Очистить">✕</button>
      </div>
      <div class="search-tabs">
        ${tabs.map(([value, label]) => `<button class="chip${type === value ? ' is-active' : ''}" type="button" data-action="set-type" data-type="${value}">${label}</button>`).join('')}
      </div>
      <div id="searchResults"></div>
    </div>`;

  const input = $('searchInput');
  if (focus && !query) {
    setTimeout(() => input.focus({ preventScroll: true }), 60);
  }
  $('searchClearInline').addEventListener('click', () => {
    input.value = '';
    $('searchField').classList.remove('has-value');
    input.focus();
    S.search.requestId++;
    renderSearchBody('', type);
  });
  input.addEventListener('input', () => {
    $('searchField').classList.toggle('has-value', input.value.length > 0);
    liveSearch(input.value.trim());
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
      runSearch(input.value.trim(), type, { push: true });
    }
  });

  await renderSearchBody(query, type);
}

function renderSearchBody(query, type) {
  const box = $('searchResults');
  if (!box) return;

  if (!query) {
    const recent = S.recentSearches;
    box.innerHTML = recent.length
      ? section('Недавние запросы', `<div class="chips">${recent.map((q) => `<button class="chip" type="button" data-action="quick" data-query="${esc(q)}">${esc(q)}</button>`).join('')}</div>`)
      : emptyState('Найдите музыку', 'Введите название трека, имя исполнителя или альбома. Поиск идёт по всему каталогу.', 'search', 'Начните вводить — результаты появятся автоматически.');
    return;
  }

  box.innerHTML = skeletonTracks(5);

  const requestId = ++S.search.requestId;
  api('/api/search?q=' + encodeURIComponent(query) + '&type=' + type + '&limit=20')
    .then((data) => {
      if (requestId !== S.search.requestId) return;
      S.search.tracks = data.tracks || emptyPage();
      S.search.artists = data.artists || emptyPage();
      S.search.albums = data.albums || emptyPage();
      S.lists.searchTracks = S.search.tracks.items;
      S.lists.searchArtists = S.search.artists.items;
      S.lists.searchAlbums = S.search.albums.items;
      saveRecentSearch(query);
      renderSearchResults(query, type);
    })
    .catch((error) => {
      if (requestId !== S.search.requestId) return;
      box.innerHTML = emptyState('Не удалось выполнить поиск', error.message, 'alert');
    });
}

function renderSearchResults(query, type) {
  const box = $('searchResults');
  if (!box) return;
  const t = S.search.tracks;
  const a = S.search.artists;
  const al = S.search.albums;
  const blocks = [];

  if (type !== 'artists' && type !== 'albums' && t.items.length) {
    S.lists.searchTracks = t.items;
    blocks.push(section('Треки', trackList(t.items, 'searchTracks'), { count: t.total ? String(t.total) : '' })
      + (t.next ? '<button class="more-btn" type="button" data-action="more">Показать ещё</button>' : ''));
  }
  if (type !== 'tracks' && type !== 'albums' && a.items.length) {
    S.lists.searchArtists = a.items;
    blocks.push(section('Исполнители', `<div class="grid-cards">${a.items.map(artistCard).join('')}</div>`, { count: String(a.total || a.items.length) }));
  }
  if (type !== 'tracks' && type !== 'artists' && al.items.length) {
    S.lists.searchAlbums = al.items;
    blocks.push(section('Альбомы', `<div class="grid-cards">${al.items.map(albumCard).join('')}</div>`, { count: String(al.total || al.items.length) }));
  }

  box.innerHTML = blocks.length
    ? blocks.join('')
    : emptyState('Ничего не найдено', `По запросу «${query}» ничего нет. Попробуйте другое название.`, 'search');
}

const liveSearch = debounce((query) => {
  if (S.route !== 'search') return;
  if (query.length === 0) { history.replaceState(null, '', '#/search'); renderSearchBody('', S.type); return; }
  if (query.length < 2) return;
  history.replaceState(null, '', '#/search?q=' + encodeURIComponent(query) + '&type=' + S.type);
  S.query = query;
  renderSearchBody(query, S.type);
}, 150);

async function runSearch(query, type, { push = false } = {}) {
  const hash = '#/search?q=' + encodeURIComponent(query) + '&type=' + (type || 'all');
  if (push) { if (location.hash === hash) route(); else location.hash = hash; return; }
  history.replaceState(null, '', hash);
  S.query = query;
  S.type = type || 'all';
  await renderSearchBody(query, S.type);
}

async function loadMoreResults() {
  if (!S.search.tracks.next) return;
  const button = page.querySelector('[data-action="more"]');
  if (button) { button.disabled = true; button.textContent = 'Загружаю…'; }
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(S.query) + '&type=tracks&limit=20&cursor=' + encodeURIComponent(S.search.tracks.cursor));
    const items = (data.tracks && data.tracks.items) || [];
    const offset = S.search.tracks.items.length;
    S.search.tracks.items = S.search.tracks.items.concat(items);
    S.search.tracks.next = data.tracks ? data.tracks.next : null;
    S.search.tracks.cursor = data.tracks ? data.tracks.cursor : null;
    S.lists.searchTracks = S.search.tracks.items;
    const list = page.querySelector('#searchResults .track-list');
    if (list) list.insertAdjacentHTML('beforeend', items.map((t, i) => trackRow(t, offset + i, 'searchTracks')).join(''));
    if (button) {
      if (S.search.tracks.next) { button.disabled = false; button.textContent = 'Показать ещё'; }
      else button.remove();
    }
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = 'Показать ещё'; }
  }
}

/* ───────────────────────────── библиотека ───────────────────────────── */

async function renderLibrary(options = {}) {
  const opts = {
    route: 'library', nav: 'library', title: 'Моя музыка',
    sub: 'Личная библиотека сохраняется в вашем аккаунте',
    heading: 'Моя музыка',
    ...options,
  };
  S.route = opts.route;
  setNav(opts.nav);
  document.title = opts.title + ' — RH—MUSIC';

  if (!S.user) {
    page.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">${esc(opts.heading)}</h1><p class="page-sub">${esc(opts.sub)}</p></div></div>
      ${emptyState('Войдите в аккаунт', 'Сохранённые треки привязаны к аккаунту и доступны с любого устройства.',
        'heart', '', '<a class="btn btn-primary" href="#/login" data-link>Войти</a><a class="btn btn-ghost" href="#/register" data-link>Регистрация</a>')}`;
    return;
  }

  page.innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">${esc(opts.heading)}</h1><p class="page-sub" id="libCount">Загружаю…</p></div>
    </div>
    <div class="search-field" id="libSearchField" style="position:static;margin-bottom:10px">
      <svg class="search-ico" viewBox="0 0 24 24"><path d="M10.5 3a7.5 7.5 0 1 1-4.6 13.4l-3.2 3.2a1 1 0 1 1-1.4-1.4l3.2-3.2A7.5 7.5 0 0 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"/></svg>
      <input id="libSearch" type="search" placeholder="Поиск в моей музыке" autocapitalize="off" autocorrect="off" aria-label="Поиск в библиотеке">
    </div>
    <div class="chips" style="margin-bottom:12px">
      <button class="chip is-active" type="button" data-action="lib-sort" data-sort="recent">Сначала новые</button>
      <button class="chip" type="button" data-action="lib-sort" data-sort="title">По названию</button>
      <button class="chip" type="button" data-action="lib-sort" data-sort="artist">По исполнителю</button>
      <button class="chip" type="button" data-action="play-all" data-list="library">▶ Слушать</button>
      <a class="chip" href="#/recent" data-link>История</a>
    </div>
    <div id="libBody"></div>`;

  const input = $('libSearch');
  input.addEventListener('input', debounce(() => loadLibrary(input.value.trim(), S.librarySort || 'recent'), 300));
  // Библиотека могла измениться в другой вкладке или в плеере — обновляем отметки ♥.
  await refreshLibraryIds();
  await loadLibrary('', 'recent');
}

async function loadLibrary(query = '', sort = 'recent') {
  S.librarySort = sort;
  const box = $('libBody');
  if (!box) return;
  box.innerHTML = skeletonTracks(6);
  try {
    const data = await api('/api/library?q=' + encodeURIComponent(query) + '&sort=' + sort + '&limit=200');
    S.lists.library = data.items;
    $('libCount').textContent = data.total
      ? `${data.total} ${data.total % 10 === 1 && data.total % 100 !== 11 ? 'композиция' : (data.total % 10 >= 2 && data.total % 10 <= 4 && (data.total % 100 < 10 || data.total % 100 >= 20) ? 'композиции' : 'композиций')} в библиотеке`
      : 'Пока пусто';
    box.innerHTML = data.items.length
      ? trackList(data.items, 'library', true)
      : emptyState(query ? 'Ничего не найдено' : 'Библиотека пуста',
        query ? 'Попробуйте изменить запрос.' : 'Нажимайте ♥ рядом с треком, чтобы сохранить его сюда.',
        'heart', '', '<a class="btn btn-primary" href="#/search" data-link>Найти музыку</a>');
  } catch (error) {
    box.innerHTML = emptyState('Не удалось загрузить', error.message, 'alert');
  }
}

async function toggleSave(track) {
  if (!requireAuth('Сохранение треков доступно после входа.')) return;
  const id = String(track.id);
  const saved = S.libraryIds.has(id);
  try {
    if (saved) {
      await api('/api/library/' + encodeURIComponent(id), { method: 'DELETE' });
      S.libraryIds.delete(id);
      toast('Удалено из моей музыки', 'info');
    } else {
      await api('/api/library', { method: 'POST', body: { track } });
      S.libraryIds.add(id);
      toast('Добавлено в мою музыку', 'ok');
    }
    refreshRowStates();
    updateNpLike();
    if (S.route === 'library') loadLibrary($('libSearch') ? $('libSearch').value.trim() : '', S.librarySort || 'recent');
  } catch (error) {
    toast(error.message);
  }
}

function refreshRowStates() {
  document.querySelectorAll('[data-action="toggle-save"]').forEach((button) => {
    const list = S.lists[button.dataset.list];
    const index = Number(button.dataset.index);
    const track = list && list[index];
    if (!track) return;
    const saved = S.libraryIds.has(String(track.id));
    button.classList.toggle('is-on', saved);
    button.innerHTML = saved ? ICONS.heartFilled : ICONS.heart;
  });
}

/* ───────────────────────────── альбомы и исполнители библиотеки ───────────────────────────── */

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

async function loadLibraryGroups() {
  const data = await api('/api/library?limit=500&sort=recent');
  const items = data.items || [];
  const albums = new Map();
  const artists = new Map();

  for (const track of items) {
    const albumKey = track.albumId ? 'id:' + track.albumId : 'name:' + (track.album || track.title || '');
    if (!albums.has(albumKey)) {
      albums.set(albumKey, {
        key: albumKey,
        id: track.albumId || null,
        title: track.album || track.title || 'Без альбома',
        artist: track.artist || '',
        artistId: track.artistId || null,
        cover: track.cover || null,
        tracks: [],
      });
    }
    albums.get(albumKey).tracks.push(track);

    if (track.artist || track.artistId) {
      const artistKey = track.artistId ? 'id:' + track.artistId : 'name:' + track.artist;
      if (!artists.has(artistKey)) {
        artists.set(artistKey, {
          key: artistKey,
          id: track.artistId || null,
          title: track.artist || 'Неизвестный исполнитель',
          cover: track.cover || null,
          tracks: [],
        });
      }
      artists.get(artistKey).tracks.push(track);
    }
  }

  return { items, albums: [...albums.values()], artists: [...artists.values()] };
}

function groupPlayButton(group, listName) {
  S.lists[listName] = group.tracks;
  return `<button class="card-play" type="button" data-action="play-all" data-list="${esc(listName)}" aria-label="Слушать ${esc(group.title)}">${ICONS.play}</button>`;
}

async function renderAlbums() {
  S.route = 'albums';
  setNav('albums');
  document.title = 'Альбомы — RH—MUSIC';

  if (!S.user) {
    page.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Альбомы</h1><p class="page-sub">Альбомы из вашей библиотеки</p></div></div>
      ${emptyState('Войдите в аккаунт', 'Альбомы собираются из треков, сохранённых в «Мою музыку».', 'user', '',
        '<a class="btn btn-primary" href="#/login" data-link>Войти</a><a class="btn btn-ghost" href="#/register" data-link>Регистрация</a>')}`;
    return;
  }

  page.innerHTML = `<div class="page-head"><div><h1 class="page-title">Альбомы</h1><p class="page-sub" id="libCount">Загружаю...</p></div></div>` + skeletonCards(8);

  let groups;
  try {
    groups = await loadLibraryGroups();
  } catch (error) {
    page.innerHTML = emptyState('Не удалось загрузить альбомы', error.message, 'alert');
    return;
  }

  if (!groups.albums.length) {
    page.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Альбомы</h1><p class="page-sub">Пока пусто</p></div></div>
      ${emptyState('Альбомов нет', 'Сохраняйте треки в «Мою музыку» — альбомы появятся здесь автоматически.', 'note', '',
        '<a class="btn btn-primary" href="#/search" data-link>Найти музыку</a>')}`;
    return;
  }

  const cards = groups.albums.map((album) => {
    const listName = 'album_' + album.key.replace(/[^a-zA-Z0-9]/g, '');
    const sub = [album.artist, album.tracks.length + ' ' + plural(album.tracks.length, 'трек', 'трека', 'треков')]
      .filter(Boolean).join(' · ');
    const inner = `
      <span class="card-art">
        ${album.cover ? `<img src="${esc(pic(album.cover, 300))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        <span class="cover-fallback">♪</span>
        ${groupPlayButton(album, listName)}
      </span>
      <span>
        <span class="card-title">${esc(album.title)}</span>
        <span class="card-sub">${esc(sub)}</span>
      </span>`;
    return album.id
      ? `<a class="card" href="#/album/${esc(album.id)}" data-link>${inner}</a>`
      : `<div class="card">${inner}</div>`;
  }).join('');

  page.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">Альбомы</h1>
        <p class="page-sub">${groups.albums.length} ${plural(groups.albums.length, 'альбом', 'альбома', 'альбомов')} из вашей библиотеки</p>
      </div>
      <button class="btn btn-ghost" type="button" data-action="shuffle-all-library">${ICONS.play} Перемешать всё</button>
    </div>
    <div class="grid-cards">${cards}</div>`;
}

async function renderArtists() {
  S.route = 'artists';
  setNav('artists');
  document.title = 'Исполнители — RH—MUSIC';

  if (!S.user) {
    page.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Исполнители</h1><p class="page-sub">Исполнители из вашей библиотеки</p></div></div>
      ${emptyState('Войдите в аккаунт', 'Исполнители собираются из треков, сохранённых в «Мою музыку».', 'user', '',
        '<a class="btn btn-primary" href="#/login" data-link>Войти</a><a class="btn btn-ghost" href="#/register" data-link>Регистрация</a>')}`;
    return;
  }

  page.innerHTML = `<div class="page-head"><div><h1 class="page-title">Исполнители</h1><p class="page-sub" id="libCount">Загружаю...</p></div></div>` + skeletonCards(8);

  let groups;
  try {
    groups = await loadLibraryGroups();
  } catch (error) {
    page.innerHTML = emptyState('Не удалось загрузить исполнителей', error.message, 'alert');
    return;
  }

  if (!groups.artists.length) {
    page.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Исполнители</h1><p class="page-sub">Пока пусто</p></div></div>
      ${emptyState('Исполнителей нет', 'Сохраняйте треки — исполнители появятся здесь автоматически.', 'note', '',
        '<a class="btn btn-primary" href="#/search" data-link>Найти музыку</a>')}`;
    return;
  }

  const cards = groups.artists.map((artist) => {
    const listName = 'artist_' + artist.key.replace(/[^a-zA-Z0-9]/g, '');
    const sub = artist.tracks.length + ' ' + plural(artist.tracks.length, 'трек', 'трека', 'треков');
    const inner = `
      <span class="card-art round">
        ${artist.cover ? `<img src="${esc(pic(artist.cover, 300))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        <span class="cover-fallback">♪</span>
        ${groupPlayButton(artist, listName)}
      </span>
      <span>
        <span class="card-title">${esc(artist.title)}</span>
        <span class="card-sub">${esc(sub)}</span>
      </span>`;
    return artist.id
      ? `<a class="card" href="#/artist/${esc(artist.id)}" data-link>${inner}</a>`
      : `<div class="card">${inner}</div>`;
  }).join('');

  page.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">Исполнители</h1>
        <p class="page-sub">${groups.artists.length} ${plural(groups.artists.length, 'исполнитель', 'исполнителя', 'исполнителей')} в библиотеке</p>
      </div>
    </div>
    <div class="grid-cards">${cards}</div>`;
}

/* ───────────────────────────── плейлисты ───────────────────────────── */

async function renderPlaylists() {
  S.route = 'playlists';
  setNav('playlists');
  document.title = 'Плейлисты — RH—MUSIC';

  if (!S.user) {
    page.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Плейлисты</h1><p class="page-sub">Личные подборки в вашем аккаунте</p></div></div>
      ${emptyState('Войдите в аккаунт', 'Плейлисты сохраняются в аккаунте и доступны с любого устройства.',
        'list', '', '<a class="btn btn-primary" href="#/login" data-link>Войти</a><a class="btn btn-ghost" href="#/register" data-link>Регистрация</a>')}`;
    return;
  }

  page.innerHTML = '<div class="page-head"><div><h1 class="page-title">Плейлисты</h1><p class="page-sub">Загружаю…</p></div></div>';
  await refreshPlaylists();
  renderPlaylistsList();
}

function renderPlaylistsList() {
  const rows = S.playlists.map((playlist) => `
    <a class="playlist-row" href="#/playlist/${playlist.id}" data-link>
      <span class="pl-art">
        ${playlist.cover ? `<img src="${esc(pic(playlist.cover, 160))}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        <span class="cover-fallback">${playlist.trackCount ? '♪' : '＋'}</span>
      </span>
      <span>
        <span class="pl-title">${esc(playlist.title)}</span>
        <span class="pl-sub">${playlist.trackCount ? playlist.trackCount + ' треков' : 'Пустой плейлист'}${playlist.leadArtist ? ' · ' + esc(playlist.leadArtist) : ''}</span>
      </span>
      <button class="row-btn" type="button" data-action="playlist-menu" data-id="${esc(playlist.id)}" aria-label="Действия">${ICONS.more}</button>
    </a>`).join('');

  page.innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">Плейлисты</h1><p class="page-sub">${S.playlists.length ? S.playlists.length + ' шт.' : 'Пока нет плейлистов'}</p></div>
      <button class="btn btn-primary" type="button" data-action="create-playlist">${ICONS.plus} Создать</button>
    </div>
    ${S.playlists.length ? rows : emptyState('Плейлистов пока нет', 'Создайте первый плейлист и добавляйте в него треки из поиска, библиотеки или плеера.', 'list', '', '<button class="btn btn-primary" type="button" data-action="create-playlist">Создать плейлист</button>')}`;
}

async function renderPlaylist(id) {
  S.route = 'playlist';
  setNav('playlists');
  page.innerHTML = skeletonTracks(5);
  try {
    const data = await api('/api/playlists/' + encodeURIComponent(id));
    const playlist = data.playlist;
    S.lists.playlistTracks = playlist.tracks;
    document.title = playlist.title + ' — RH—MUSIC';
    const totalSeconds = playlist.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);

    page.innerHTML = `
      <a class="back-link" href="#/playlists" data-link>${ICONS.back} Плейлисты</a>
      <section class="detail">
        <div class="detail-art">
          ${playlist.tracks[0] && playlist.tracks[0].cover
            ? `<img class="cover-in" src="${esc(pic(playlist.tracks[0].cover, 400))}" alt="" onerror="this.remove()">`
            : `<span class="cover-fallback big">＋</span>`}
        </div>
        <div class="detail-body">
          <div class="detail-kicker">Плейлист</div>
          <h2 class="detail-title">${esc(playlist.title)}</h2>
          <div class="detail-sub">
            <span>${playlist.tracks.length} треков</span>
            ${totalSeconds ? '<span class="detail-sep"></span><span>' + Math.round(totalSeconds / 60) + ' мин</span>' : ''}
          </div>
          ${playlist.description ? `<p class="detail-desc">${esc(playlist.description)}</p>` : ''}
          <div class="detail-actions">
            ${playlist.tracks.length ? `<button class="btn btn-primary" type="button" data-action="play-all" data-list="playlistTracks">${ICONS.play} Слушать</button>` : ''}
            ${playlist.tracks.length ? '<button class="btn btn-ghost" type="button" data-action="shuffle-list" data-list="playlistTracks">Перемешать</button>' : ''}
            <button class="btn btn-ghost" type="button" data-action="playlist-menu" data-id="${esc(playlist.id)}">Изменить</button>
          </div>
        </div>
      </section>
      ${playlist.tracks.length
        ? section('Треки', `<div class="track-list" id="playlistTracks">${playlist.tracks.map((t, i) => reorderRow(t, i)).join('')}</div>`, { count: String(playlist.tracks.length) })
        : emptyState('Плейлист пуст', 'Добавляйте треки через меню «⋯» в поиске, библиотеке или плеере.', 'plus')}`;
    window.scrollTo({ top: 0 });
  } catch (error) {
    page.innerHTML = emptyState('Плейлист недоступен', error.message, 'alert');
  }
}

function reorderRow(track, index) {
  const row = trackRow(track, index, 'playlistTracks', index + 1);
  return row.replace('<span class="track-index">', `<span class="reorder-controls" data-index="${index}">
      <button type="button" data-action="move-up" data-index="${index}" ${index === 0 ? 'disabled' : ''} aria-label="Выше">${ICONS.up}</button>
      <button type="button" data-action="move-down" data-index="${index}" aria-label="Ниже">${ICONS.down}</button>
    </span><span class="track-index">`);
}

async function movePlaylistTrack(playlistId, index, delta) {
  const tracks = S.lists.playlistTracks;
  if (!tracks) return;
  const target = index + delta;
  if (target < 0 || target >= tracks.length) return;
  const reordered = tracks.slice();
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  S.lists.playlistTracks = reordered;
  try {
    await api('/api/playlists/' + encodeURIComponent(playlistId) + '/order', {
      method: 'PATCH',
      body: { trackIds: reordered.map((t) => String(t.id)) },
    });
    renderPlaylist(playlistId);
  } catch (error) {
    toast(error.message);
  }
}

/* ───────────────────────────── история ───────────────────────────── */

async function renderRecent(mode = 'history') {
  S.route = mode;
  setNav('history');
  document.title = 'История прослушивания — RH—MUSIC';

  if (!S.user) {
    page.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">История прослушивания</h1><p class="page-sub">Что вы слушали последним</p></div></div>
      ${emptyState('Войдите в аккаунт', 'История прослушивания сохраняется в вашем аккаунте.', 'user', '',
        '<a class="btn btn-primary" href="#/login" data-link>Войти</a>')}`;
    return;
  }

  page.innerHTML = '<div class="page-head"><div><h1 class="page-title">Недавние</h1><p class="page-sub">Загружаю…</p></div></div>' + skeletonTracks(6);
  try {
    const data = await api('/api/history?limit=60');
    S.lists.history = data.items;
    page.innerHTML = `
      <div class="page-head">
        <div><h1 class="page-title">История прослушивания</h1><p class="page-sub">${data.items.length ? data.items.length + ' треков в истории' : 'История пока пуста'}</p></div>
        ${data.items.length ? '<button class="btn btn-ghost" type="button" data-action="play-all" data-list="history">▶ Слушать</button>' : ''}
      </div>
      ${data.items.length
        ? trackList(data.items.map((item) => ({ ...item, playedAtLabel: fmtDate(item.playedAt) })), 'history', false)
        : emptyState('История пуста', 'Здесь появятся треки, которые вы слушали. История используется для персональных рекомендаций.', 'note', '', '<a class="btn btn-primary" href="#/search" data-link>Найти музыку</a>')}`;
  } catch (error) {
    page.innerHTML = emptyState('Не удалось загрузить историю', error.message, 'alert');
  }
}

/* ───────────────────────────── артист / альбом ───────────────────────────── */

async function renderArtist(id) {
  S.route = 'artist';
  setNav(null);
  page.innerHTML = skeletonTracks(5);
  try {
    const data = await api('/api/artist/' + encodeURIComponent(id));
    const artist = data.artist;
    const tracks = data.tracks || [];
    const albums = data.albums || [];
    const related = data.related || [];
    S.lists.artistTracks = tracks;
    S.lists.artistRelated = related;
    document.title = artist.title + ' — RH—MUSIC';

    page.innerHTML = `
      <button class="back-link" type="button" data-action="back">${ICONS.back} Назад</button>
      <section class="detail">
        <div class="detail-art round">
          ${artist.cover ? `<img class="cover-in" src="${esc(pic(artist.cover, 600))}" alt="" onerror="this.remove()">` : ''}
          <span class="cover-fallback">♪</span>
        </div>
        <div class="detail-body">
          <div class="detail-kicker">Исполнитель</div>
          <h2 class="detail-title">${esc(artist.title)}</h2>
          <div class="detail-sub">
            <span>${tracks.length} треков</span>
            ${albums.length ? '<span class="detail-sep"></span><span>' + albums.length + ' релизов</span>' : ''}
          </div>
          ${artist.description ? `<p class="detail-desc">${esc(artist.description)}</p>` : ''}
          <div class="detail-actions">
            ${tracks.length ? `<button class="btn btn-primary" type="button" data-action="play-all" data-list="artistTracks">${ICONS.play} Слушать</button>` : ''}
            ${tracks.length ? '<button class="btn btn-ghost" type="button" data-action="shuffle-list" data-list="artistTracks">Перемешать</button>' : ''}
          </div>
        </div>
      </section>
      ${tracks.length ? section('Популярные треки', trackList(tracks, 'artistTracks', true), { count: String(tracks.length) }) : ''}
      ${albums.length ? section('Релизы', `<div class="grid-cards">${albums.map(albumCard).join('')}</div>`, { count: String(albums.length) }) : ''}
      ${related.length ? section('Похожие исполнители', `<div class="grid-cards">${related.map(artistCard).join('')}</div>`) : ''}
      ${!tracks.length && !albums.length ? emptyState('Нет данных', 'Каталог не вернул треки для этого исполнителя.') : ''}`;
    window.scrollTo({ top: 0 });
  } catch (error) {
    page.innerHTML = emptyState('Исполнитель недоступен', error.message, 'alert');
  }
}

async function renderAlbum(id) {
  S.route = 'album';
  setNav(null);
  page.innerHTML = skeletonTracks(6);
  try {
    const data = await api('/api/album/' + encodeURIComponent(id));
    const album = data.album;
    const tracks = data.tracks || [];
    S.lists.albumTracks = tracks;
    document.title = album.title + ' — RH—MUSIC';
    const kind = album.type === 'single' ? 'Сингл' : album.type === 'ep' ? 'EP' : 'Альбом';

    page.innerHTML = `
      <button class="back-link" type="button" data-action="back">${ICONS.back} Назад</button>
      <section class="detail">
        <div class="detail-art">
          ${album.cover ? `<img class="cover-in" src="${esc(pic(album.cover, 600))}" alt="" onerror="this.remove()">` : ''}
          <span class="cover-fallback">♪</span>
        </div>
        <div class="detail-body">
          <div class="detail-kicker">${esc(kind)}</div>
          <h2 class="detail-title">${esc(album.title)}</h2>
          <div class="detail-sub">
            ${album.artistId ? `<a href="#/artist/${esc(album.artistId)}" data-link>${esc(album.artist)}</a>` : `<span>${esc(album.artist)}</span>`}
            ${album.year ? `<span class="detail-sep"></span><span>${esc(album.year)}</span>` : ''}
            ${tracks.length ? `<span class="detail-sep"></span><span>${tracks.length} треков</span>` : ''}
          </div>
          <div class="detail-actions">
            ${tracks.length ? `<button class="btn btn-primary" type="button" data-action="play-all" data-list="albumTracks">${ICONS.play} Слушать альбом</button>` : ''}
            ${tracks.length ? '<button class="btn btn-ghost" type="button" data-action="shuffle-list" data-list="albumTracks">Перемешать</button>' : ''}
          </div>
        </div>
      </section>
      ${tracks.length ? section('Треки', trackList(tracks, 'albumTracks', true), { count: String(tracks.length) }) : ''}`;
    window.scrollTo({ top: 0 });
  } catch (error) {
    page.innerHTML = emptyState('Альбом недоступен', error.message, 'alert');
  }
}

/* ───────────────────────────── аккаунт ───────────────────────────── */

const PROVIDER_LABEL = { google: 'Google' };

function providerGlyph(id) {
  if (id !== 'google') return '';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.06-1.4-.18-2.05H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.75 3-4.3 3-7.35Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.6-2.43l-3.2-2.5c-.9.6-2.05.95-3.4.95-2.6 0-4.8-1.75-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9l3.3-2.6Z"/><path fill="#EA4335" d="M12 6.05c1.47 0 2.8.5 3.83 1.5l2.85-2.85A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.9 5.5l3.3 2.6C7.2 7.8 9.4 6.05 12 6.05Z"/></svg>';
}

async function loadProviders(force = false) {
  if (S.providers && !force) return S.providers;
  try {
    const data = await api('/api/auth/providers');
    S.providers = data.providers || [];
  } catch {
    S.providers = [];
  }
  return S.providers;
}

/** Разметка блока внешнего входа: только Google. */
function providerBlock(mode = 'login') {
  return `
    <div class="provider-list">
      <div class="google-slot" id="googleSlot" data-mode="${esc(mode)}"></div>
      <p class="provider-status" id="googleStatus" hidden></p>
    </div>
    <div class="auth-sep"><span>или по email</span></div>`;
}

let gisPromise = null;
function loadGoogleSdk() {
  if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => { gisPromise = null; reject(new Error('Не удалось загрузить вход через Google')); };
      document.head.appendChild(script);
    });
  }
  return gisPromise;
}

/** Состояние одного Google-входа: защита от двойной отправки и повторного credential. */
const googleFlow = { mode: 'login', state: null, nonce: null, clientId: null, busy: false, lastCredential: null };

function setGoogleStatus(kind, text) {
  const el = $('googleStatus');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-ok', kind === 'ok');
  el.classList.toggle('is-loading', kind === 'loading');
}

async function fetchGoogleGate(mode) {
  try {
    const gate = await api('/api/auth/oauth/google/nonce', { method: 'POST', body: { mode } });
    googleFlow.state = gate.state;
    googleFlow.nonce = gate.nonce;
    return gate;
  } catch (error) {
    setGoogleStatus('error', error.message);
    return null;
  }
}

function renderGoogleButton(mode) {
  const slot = $('googleSlot');
  if (!slot || !window.google || !window.google.accounts || !window.google.accounts.id) return;
  try {
    window.google.accounts.id.renderButton(slot, {
      theme: 'filled_black',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      logo_alignment: 'left',
      width: Math.min(320, Math.max(200, slot.clientWidth || 280)),
    });
  } catch { /* кнопку можно нарисовать повторно */ }
  void mode;
}

async function handleGoogleCredential(response) {
  if (!response || !response.credential) return;
  // Двойная отправка и повторная обработка одного и того же credential запрещены.
  if (googleFlow.busy) return;
  if (googleFlow.lastCredential === response.credential) return;
  googleFlow.busy = true;
  googleFlow.lastCredential = response.credential;
  setGoogleStatus('loading', 'Проверяем вход через Google…');

  try {
    const data = await api('/api/auth/oauth/google', {
      method: 'POST',
      body: { state: googleFlow.state, credential: response.credential },
    });
    setGoogleStatus('ok', data.linked ? 'Google привязан' : 'Вход выполнен');
    setUser(data.user);
    await afterLogin();
    toast(data.linked ? 'Аккаунт Google привязан' : 'Вы вошли через Google', 'ok');
    if (data.linked || googleFlow.mode === 'link') {
      sheetClose();
      if (S.route === 'account') renderAccount();
      else go('/account');
    } else {
      go('/');
    }
  } catch (error) {
    setGoogleStatus('error', error.message);
    toast(error.message);
    // state одноразовый: готовим новый, чтобы следующая попытка не упиралась в «устарело».
    const gate = await fetchGoogleGate(googleFlow.mode);
    if (gate && window.google && window.google.accounts && window.google.accounts.id) {
      window.google.accounts.id.initialize({
        client_id: googleFlow.clientId,
        nonce: gate.nonce,
        ux_mode: 'popup',
        callback: handleGoogleCredential,
      });
    }
  } finally {
    googleFlow.busy = false;
  }
}

/** Монтирует официальную кнопку Google Identity Services в слот. */
async function mountGoogleButton(mode = 'login') {
  const slot = $('googleSlot');
  if (!slot) return;
  await loadProviders();
  const entry = (S.providers || []).find((item) => item.id === 'google');
  if (!entry) return;
  googleFlow.mode = mode;
  googleFlow.clientId = entry.clientId || null;

  if (!entry.enabled) {
    setGoogleStatus('error', 'Вход через Google пока недоступен: на сервере не задан Client ID.');
    return;
  }

  setGoogleStatus('loading', 'Загружаем вход через Google…');
  try {
    await loadGoogleSdk();
  } catch (error) {
    setGoogleStatus('error', error.message);
    return;
  }

  const gate = await fetchGoogleGate(mode);
  if (!gate) return;

  window.google.accounts.id.initialize({
    client_id: entry.clientId,
    nonce: gate.nonce,
    ux_mode: 'popup',
    callback: handleGoogleCredential,
  });
  renderGoogleButton(mode);
  setGoogleStatus('idle', '');

  // One Tap — только на широких экранах, где он не мешает кнопке и не спорит с мобильным Safari.
  if (window.matchMedia && window.matchMedia('(min-width: 700px)').matches) {
    try { window.google.accounts.id.prompt(); } catch { /* One Tap может быть недоступен */ }
  }
}

/* Привязка Google к уже открытому аккаунту — в той же шторке. */
function openGoogleLinkSheet() {
  sheetOpen(`
    <h2 class="sheet-title">Привязать Google</h2>
    <p class="sheet-sub">Выберите Google-аккаунт — он станет ещё одним способом входа в этот аккаунт RH—MUSIC.</p>
    ${providerBlock('link')}
    <p class="hint">Если этот Google-аккаунт уже привязан к другому пользователю, привязка будет отклонена.</p>
  `);
  mountGoogleButton('link');
}

const OAUTH_ERRORS = {
  state_expired: 'Запрос входа устарел. Попробуйте снова.',
  identity_taken: 'Этот аккаунт Google уже привязан к другому пользователю RH—MUSIC.',
  provider_disabled: 'Вход через Google ещё не настроен на сервере.',
};

function oauthErrorFromHash() {
  const hash = location.hash.replace(/^#/, '');
  const queryIndex = hash.indexOf('?');
  if (queryIndex < 0) return null;
  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  if (params.get('oauth') !== 'error') return null;
  return params.get('code') || 'unknown';
}

function consumeOauthNotice() {
  const code = oauthErrorFromHash();
  if (!code) return;
  toast(OAUTH_ERRORS[code] || 'Не удалось войти через Google.', 'error');
  history.replaceState(null, '', '#/login');
}

function authFormTemplate({ mode }) {
  const isRegister = mode === 'register';
  return `
    <div class="auth-card">
      <div class="auth-head">
        <span class="logo" style="margin:0 auto">RH</span>
        <h1>${isRegister ? 'Создать аккаунт' : 'Вход в RH—MUSIC'}</h1>
        <p>${isRegister ? 'Библиотека, плейлисты и персональные рекомендации' : 'Продолжите слушать со своей библиотекой'}</p>
      </div>
      ${providerBlock('login')}
      <form id="authForm" novalidate>
        ${isRegister ? `
        <div class="field">
          <label for="af-username">Имя пользователя</label>
          <input id="af-username" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="например, rockfan">
          <span class="hint">3–24 символа: латиница, цифры, «_», «.», «-»</span>
        </div>` : ''}
        <div class="field">
          <label for="af-login">${isRegister ? 'Email' : 'Email или имя пользователя'}</label>
          <input id="af-login" name="login" type="${isRegister ? 'email' : 'text'}" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="you@example.com">
        </div>
        <div class="field">
          <label for="af-password">Пароль</label>
          <input id="af-password" name="password" type="password" autocomplete="${isRegister ? 'new-password' : 'current-password'}" placeholder="••••••••" ${isRegister ? 'minlength="10"' : ''}>
          ${isRegister ? '<span class="hint">Минимум 10 символов, буквы и цифры</span>' : ''}
        </div>
        ${isRegister ? `
        <div class="field">
          <label for="af-confirm">Повторите пароль</label>
          <input id="af-confirm" name="confirm" type="password" autocomplete="new-password" placeholder="••••••••">
        </div>` : ''}
        <button class="btn btn-primary btn-block" type="submit" id="authSubmit">${isRegister ? 'Зарегистрироваться' : 'Войти'}</button>
      </form>
      <div class="auth-switch">
        ${isRegister
          ? 'Уже есть аккаунт? <a href="#/login" data-link>Войти</a>'
          : 'Нет аккаунта? <a href="#/register" data-link>Зарегистрироваться</a>'}
      </div>
      <p class="hint" style="text-align:center;margin-top:12px">Пароли хранятся только в виде хеша PBKDF2-SHA256. Сессия — в защищённой HttpOnly cookie.</p>
    </div>`;
}

async function renderLogin({ focus = false } = {}) {
  S.route = 'login';
  setNav(null);
  document.title = 'Вход — RH—MUSIC';
  await loadProviders();
  page.innerHTML = authFormTemplate({ mode: 'login' });
  bindAuthForm('login', focus);
  mountGoogleButton('login');
  consumeOauthNotice();
}

async function renderRegister({ focus = false } = {}) {
  S.route = 'register';
  setNav(null);
  document.title = 'Регистрация — RH—MUSIC';
  await loadProviders();
  page.innerHTML = authFormTemplate({ mode: 'register' });
  bindAuthForm('register', focus);
  mountGoogleButton('register');
}

function bindAuthForm(mode, focus) {
  const form = $('authForm');
  const submit = $('authSubmit');
  if (focus) setTimeout(() => $('af-login')?.focus({ preventScroll: true }), 80);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    const originalText = submit.textContent;
    submit.textContent = 'Подождите…';

    try {
      if (mode === 'register') {
        const payload = {
          username: $('af-username').value.trim(),
          email: $('af-login').value.trim(),
          password: $('af-password').value,
          confirmPassword: $('af-confirm').value,
        };
        const data = await api('/api/auth/register', { method: 'POST', body: payload });
        setUser(data.user);
        await afterLogin();
        toast('Аккаунт создан. Добро пожаловать!', 'ok');
        go('/home');
      } else {
        const data = await api('/api/auth/login', {
          method: 'POST',
          body: { login: $('af-login').value.trim(), password: $('af-password').value },
        });
        setUser(data.user);
        await afterLogin();
        toast('Вы вошли как ' + (data.user.displayName || data.user.username), 'ok');
        go('/home');
      }
    } catch (error) {
      toast(error.message);
      submit.disabled = false;
      submit.textContent = originalText;
    }
  });
}

async function afterLogin() {
  await Promise.all([refreshLibraryIds(), refreshPlaylists()]);
  S.recommendations = null;
  S.security = null;
  S.identities = null;
}

async function renderAccount(options = {}) {
  const settings = !!options.settings;
  S.route = settings ? 'settings' : 'account';
  setNav(null);
  document.title = (settings ? 'Настройки' : 'Аккаунт') + ' — RH—MUSIC';

  if (!S.user) { renderLogin(); return; }

  page.innerHTML = '<div class="page-head"><div><h1 class="page-title">' + (settings ? 'Настройки' : 'Аккаунт') + '</h1></div></div>' + skeletonTracks(3);

  let data;
  try {
    data = await api('/api/auth/me');
  } catch (error) {
    page.innerHTML = emptyState('Не удалось загрузить профиль', error.message, 'alert');
    return;
  }

  setUser(data.user);
  S.security = data.security || { password: false, methods: [] };
  S.identities = S.security.methods || [];

  const user = data.user;
  const name = user.displayName || user.username;
  const hasPassword = !!S.security.password;
  const currentMethod = S.security.currentMethod || null;
  const methods = S.identities;
  const totalMethods = methods.length + (hasPassword ? 1 : 0);

  const providerRows = ['google'].map((id) => {
    const linked = methods.find((method) => method.provider === id);
    const label = PROVIDER_LABEL[id] || id;
    const canUnlink = linked && totalMethods > 1;
    return `
      <div class="login-row">
        <span class="login-glyph">${providerGlyph(id)}</span>
        <span class="login-text">
          <b>${esc(label)}</b>
          <small>${linked ? esc(linked.email || 'привязан') : 'не привязан'}</small>
        </span>
        ${linked
          ? (canUnlink
            ? `<button class="btn-mini" type="button" data-action="unlink-provider" data-provider="${esc(id)}">Отвязать</button>`
            : '<span class="badge">единственный</span>')
          : `<button class="btn-mini primary" type="button" data-action="link-google">Привязать</button>`}
        ${linked && currentMethod === id ? '<span class="badge ok">текущий вход</span>' : ''}
      </div>`;
  }).join('');

  page.innerHTML = `
    <div class="page-head"><div><h1 class="page-title">${settings ? 'Настройки' : 'Аккаунт'}</h1><p class="page-sub">Профиль, способы входа и удаление аккаунта</p></div></div>

    <div class="profile-head">
      <div class="profile-avatar">${esc(name.slice(0, 1))}</div>
      <div>
        <div class="profile-name">${esc(name)}</div>
        <div class="profile-mail">${esc(user.email)}</div>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat"><b>${data.stats.library}</b><span>в библиотеке</span></div>
      <div class="stat"><b>${data.stats.tracks}</b><span>треков в истории</span></div>
      <div class="stat"><b>${data.stats.plays}</b><span>прослушиваний</span></div>
    </div>

    <section class="section">
      <div class="section-head">
        <div>
          <h2 class="section-title">Способы входа</h2>
          <p class="section-sub">Один аккаунт RH—MUSIC, несколько способов входа</p>
        </div>
      </div>
      <div class="login-list">
        <div class="login-row">
          <span class="login-glyph">${ICONS.user}</span>
          <span class="login-text">
            <b>Email и пароль</b>
            <small>${hasPassword ? esc(user.email) : 'пароль не задан'}</small>
          </span>
          <span class="badge ${hasPassword ? 'ok' : ''}">${hasPassword ? 'включён' : 'нет'}</span>
          ${hasPassword && currentMethod === 'password' ? '<span class="badge ok">текущий вход</span>' : ''}
        </div>
        ${providerRows}
      </div>
      <p class="hint">Привязать новый способ можно только из этого аккаунта. Если внешний аккаунт уже принадлежит другому пользователю, привязка будет отклонена — мы не объединяем аккаунты по совпадению email.</p>
    </section>

    <div class="list-block">
      <button class="sheet-item" type="button" data-action="edit-profile">${ICONS.edit} Изменить профиль</button>
      ${hasPassword ? `<button class="sheet-item" type="button" data-action="change-password">${ICONS.user} Сменить пароль</button>` : ''}
      <button class="sheet-item" type="button" data-action="logout">${ICONS.logout} Выйти из аккаунта</button>
    </div>

    ${settings ? equalizerSettingsHTML() : ''}

    <section class="section danger-zone">
      <div class="section-head">
        <div>
          <h2 class="section-title">Удаление аккаунта</h2>
          <p class="section-sub">Удаляются профиль, библиотека, плейлисты, история и рекомендации</p>
        </div>
      </div>
      <button class="btn btn-danger btn-block" type="button" data-action="delete-account">${ICONS.trash} Удалить аккаунт</button>
      <p class="hint">После удаления вход тем же способом создаст новый чистый аккаунт — старые данные не восстанавливаются.</p>
    </section>

    <p class="hint">Пароль, токены провайдеров и сессии хранятся на сервере. В браузере нет ни пароля, ни токенов — только защищённая HttpOnly cookie.</p>
  `;
  refreshSmartMixUI();
}

function openUnlinkSheet(provider) {
  const label = PROVIDER_LABEL[provider] || provider;
  const hasPassword = !!(S.security && S.security.password);
  sheetOpen(`
    <h2 class="sheet-title">Отвязать ${esc(label)}?</h2>
    <p class="sheet-sub">Способ входа перестанет работать для этого аккаунта. Остальные способы останутся.</p>
    ${hasPassword
      ? `<div class="field"><label for="unlink-pw">Подтвердите паролем</label><input id="unlink-pw" type="password" autocomplete="current-password"></div>`
      : `<div class="notice"><span>${ICONS.user}</span><span>У аккаунта нет пароля. Подтвердите личность повторным входом через любой привязанный сервис, затем повторите отвязку.</span></div>`}
    <div class="sheet-actions">
      <button class="btn btn-danger btn-block" type="button" data-action="confirm-unlink" data-provider="${esc(provider)}">Отвязать</button>
      <button class="btn btn-ghost btn-block" type="button" data-action="close-sheet">Отмена</button>
    </div>
  `);
}

function openDeleteSheet() {
  const hasPassword = !!(S.security && S.security.password);
  sheetOpen(`
    <h2 class="sheet-title">Удалить аккаунт?</h2>
    <p class="sheet-sub">Действие необратимо. Будут удалены:</p>
    <ul class="danger-list">
      <li>профиль и все способы входа (Google и пароль);</li>
      <li>личная библиотека «Моя музыка»;</li>
      <li>все созданные плейлисты и их треки;</li>
      <li>история прослушиваний и профиль рекомендаций;</li>
      <li>настройки и все активные сессии.</li>
    </ul>
    <p class="sheet-sub">Музыкальный каталог и данные других пользователей не затрагиваются.</p>
    <div class="field">
      <label for="del-confirm">Введите УДАЛИТЬ для подтверждения</label>
      <input id="del-confirm" type="text" autocomplete="off" autocapitalize="characters" placeholder="УДАЛИТЬ">
    </div>
    ${hasPassword
      ? `<div class="field"><label for="del-pw">Текущий пароль</label><input id="del-pw" type="password" autocomplete="current-password"></div>`
      : `<div class="notice"><span>${ICONS.user}</span><span>Подтвердите личность повторным входом через привязанный сервис — после этого удаление станет доступно.</span></div>`}
    <div class="sheet-actions">
      <button class="btn btn-danger btn-block" type="button" data-action="confirm-delete">Удалить аккаунт навсегда</button>
      <button class="btn btn-ghost btn-block" type="button" data-action="close-sheet">Отмена</button>
    </div>
  `);
}

/* ───────────────────────────── листы действий ───────────────────────────── */

function sheetOpen(html) {
  sheetPanel.style.transform = '';
  sheetPanel.classList.remove('is-dragging');
  sheetPanel.innerHTML = `
    <div class="sheet-grab" data-sheet-grab aria-hidden="true"><span></span></div>
    <button class="sheet-close" type="button" data-sheet-close aria-label="Закрыть">
      <svg viewBox="0 0 24 24"><path d="M6.2 6.2a1 1 0 0 1 1.4 0L12 10.6l4.4-4.4a1 1 0 1 1 1.4 1.4L13.4 12l4.4 4.4a1 1 0 0 1-1.4 1.4L12 13.4l-4.4 4.4a1 1 0 0 1-1.4-1.4L10.6 12 6.2 7.6a1 1 0 0 1 0-1.4Z"/></svg>
    </button>
    ${html}`;
  sheet.classList.add('is-open');
  sheet.setAttribute('aria-hidden', 'false');
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('is-open'));
  S.sheetOpen = true;
  document.body.classList.add('is-locked');
}

function sheetClose() {
  sheet.classList.remove('is-open');
  sheet.setAttribute('aria-hidden', 'true');
  sheetPanel.classList.remove('is-dragging');
  sheetPanel.style.transform = '';
  S.sheetOpen = false;
  S.sheetTrack = null;
  if (!S.drawerOpen && !S.npOpen) hideScrim();
  document.body.classList.toggle('is-locked', S.drawerOpen || S.npOpen);
}

/**
 * Решение о закрытии по жесту: либо достаточная дистанция, либо достаточная
 * скорость. Чистая функция — используется и панелью, и мини-плеером.
 */
function swipeCloses(dy, velocity, distance = 90, speed = 0.5) {
  const delta = Number(dy);
  if (!Number.isFinite(delta) || delta <= 0) return false;
  if (delta >= distance) return true;
  return Number(velocity) >= speed && delta >= 24;
}

function bindDragToClose(container, handle, onClose, options = {}) {
  if (!container || !handle) return;
  const distance = Number(options.distance) || 90;
  const speed = Number(options.speed) || 0.45;
  let drag = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    if (event.target.closest && event.target.closest('button, a, input, select, textarea')) return;
    drag = { id: event.pointerId, y: event.clientY, t: performance.now(), dy: 0 };
    container.classList.add('is-dragging');
    try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  });
  handle.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dy = Math.max(0, event.clientY - drag.y);
    drag.dy = dy;
    container.style.transform = dy ? `translateY(${dy}px)` : '';
  }, { passive: true });
  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { dy, t, id } = drag;
    drag = null;
    container.classList.remove('is-dragging');
    try { handle.releasePointerCapture(id); } catch { /* ignore */ }
    const velocity = dy / Math.max(1, performance.now() - t);
    if (swipeCloses(dy, velocity, distance, speed)) {
      container.style.transform = 'translateY(110%)';
      window.setTimeout(() => { container.style.transform = ''; onClose(); }, 170);
    } else {
      container.style.transform = '';
    }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function hideScrim() {
  scrim.classList.remove('is-open');
  setTimeout(() => { if (!S.sheetOpen && !S.drawerOpen && !S.npOpen) scrim.hidden = true; }, 260);
}

function openTrackMenu(track) {
  const saved = S.libraryIds.has(String(track.id));
  sheetOpen(`
    <h2 class="sheet-title">${esc(track.title)}</h2>
    <p class="sheet-sub">${esc(track.artist || '')}${track.album ? ' · ' + esc(track.album) : ''}</p>
    <div class="sheet-actions">
      <button class="sheet-item" type="button" data-action="sheet-play">${ICONS.play} Воспроизвести</button>
      <button class="sheet-item" type="button" data-action="sheet-toggle-save" data-id="${esc(track.id)}">
        ${saved ? ICONS.heartFilled : ICONS.heart} ${saved ? 'Убрать из моей музыки' : 'Сохранить в мою музыку'}
      </button>
      <button class="sheet-item" type="button" data-action="sheet-add-playlist" data-id="${esc(track.id)}">${ICONS.list} Добавить в плейлист</button>
      ${track.artistId ? `<a class="sheet-item" href="#/artist/${esc(track.artistId)}" data-link data-close-sheet>${ICONS.user} Перейти к исполнителю</a>` : ''}
      ${track.albumId ? `<a class="sheet-item" href="#/album/${esc(track.albumId)}" data-link data-close-sheet>${ICONS.note} Открыть альбом</a>` : ''}
    </div>`);
  S.sheetTrack = track;
}

async function openPlaylistPicker(track) {
  if (!requireAuth('Плейлисты доступны после входа.')) return;
  await refreshPlaylists();
  sheetOpen(`
    <h2 class="sheet-title">В какой плейлист?</h2>
    <p class="sheet-sub">${esc(track.title)}</p>
    <div class="sheet-actions">
      ${S.playlists.map((playlist) => `<button class="sheet-item" type="button" data-action="sheet-add-to" data-playlist="${esc(playlist.id)}">${ICONS.list} ${esc(playlist.title)} <span class="section-count" style="margin-left:auto">${playlist.trackCount}</span></button>`).join('')}
      <button class="sheet-item" type="button" data-action="create-playlist" data-with-track="1">${ICONS.plus} Новый плейлист</button>
    </div>`);
  S.sheetTrack = track;
}

function openCreatePlaylist(withTrack = false) {
  if (!requireAuth('Плейлисты доступны после входа.')) return;
  sheetOpen(`
    <h2 class="sheet-title">Новый плейлист</h2>
    <form id="plForm">
      <div class="field">
        <label for="pl-title">Название</label>
        <input id="pl-title" maxlength="120" placeholder="Например, Дорога" required>
      </div>
      <div class="field">
        <label for="pl-desc">Описание <span class="hint">(необязательно)</span></label>
        <textarea id="pl-desc" rows="2" maxlength="400" placeholder="Для чего этот плейлист"></textarea>
      </div>
      <button class="btn btn-primary btn-block" type="submit" id="plSubmit">Создать</button>
    </form>`);
  S.createWithTrack = withTrack ? S.sheetTrack : null;
  $('plForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('plSubmit');
    submit.disabled = true;
    try {
      const data = await api('/api/playlists', {
        method: 'POST',
        body: { title: $('pl-title').value.trim(), description: $('pl-desc').value.trim() },
      });
      if (S.createWithTrack) {
        await api('/api/playlists/' + data.id + '/tracks', { method: 'POST', body: { track: S.createWithTrack } });
      }
      await refreshPlaylists();
      sheetClose();
      toast('Плейлист создан', 'ok');
      if (S.route === 'playlists') renderPlaylistsList();
      else if (S.route === 'playlist') renderPlaylist(data.id);
      else go('/playlist/' + data.id);
    } catch (error) {
      toast(error.message);
      submit.disabled = false;
    }
  });
}

function openPlaylistMenu(playlistId) {
  const playlist = S.playlists.find((p) => String(p.id) === String(playlistId));
  if (!playlist) return;
  sheetOpen(`
    <h2 class="sheet-title">${esc(playlist.title)}</h2>
    <p class="sheet-sub">${playlist.trackCount} треков</p>
    <div class="sheet-actions">
      <a class="sheet-item" href="#/playlist/${esc(playlist.id)}" data-link data-close-sheet>${ICONS.play} Открыть плейлист</a>
      <button class="sheet-item" type="button" data-action="playlist-rename">${ICONS.edit} Переименовать</button>
      <button class="sheet-item" type="button" data-action="playlist-edit-desc">${ICONS.note} Изменить описание</button>
      <button class="sheet-item is-danger" type="button" data-action="playlist-delete">${ICONS.trash} Удалить плейлист</button>
    </div>`);
  S.sheetPlaylist = playlist;
}

function openPrompt({ title, label, value = '', multiline = false, confirmLabel = 'Сохранить', onConfirm }) {
  sheetOpen(`
    <h2 class="sheet-title">${esc(title)}</h2>
    <form id="promptForm">
      <div class="field">
        <label for="promptValue">${esc(label)}</label>
        ${multiline
          ? `<textarea id="promptValue" rows="3" maxlength="400">${esc(value)}</textarea>`
          : `<input id="promptValue" maxlength="120" value="${esc(value)}" required>`}
      </div>
      <button class="btn btn-primary btn-block" type="submit">${esc(confirmLabel)}</button>
    </form>`);
  setTimeout(() => $('promptValue')?.focus({ preventScroll: true }), 80);
  $('promptForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await onConfirm($('promptValue').value.trim());
  });
}

function openConfirm({ title, text, confirmLabel = 'Удалить', onConfirm }) {
  sheetOpen(`
    <h2 class="sheet-title">${esc(title)}</h2>
    <p class="sheet-sub">${esc(text)}</p>
    <div class="sheet-actions">
      <button class="sheet-item is-danger" type="button" id="confirmYes">${ICONS.trash} ${esc(confirmLabel)}</button>
      <button class="sheet-item" type="button" data-action="sheet-close">Отмена</button>
    </div>`);
  $('confirmYes').addEventListener('click', async () => {
    try { await onConfirm(); } catch (error) { toast(error.message); }
  });
}

/* ───────────────────────────── плеер ───────────────────────────── */

function setQueue(tracks, index) {
  S.queue = Array.isArray(tracks) ? tracks.slice() : [];
  S.originalQueue = null;
  S.index = index;
  if (window.RH_SMARTMIX) window.RH_SMARTMIX.onQueue();
}

function isSoundCloudTrack(track) {
  return !!(track && (track.source === 'soundcloud' || /^sc:/i.test(String(track.id || ''))));
}

function soundCloudMediaId(track) {
  return String(track && track.id ? track.id : '').replace(/^sc:/i, '');
}

function streamUrl(track) {
  if (isSoundCloudTrack(track)) {
    // Тот же origin: Worker отдаёт m3u8 (или 302 на progressive-CDN),
    // поэтому <audio> и hls.js не зависят от CORS JSON-API.
    return API + '/api/sc/play/' + encodeURIComponent(soundCloudMediaId(track));
  }
  // Качество всегда MID (128 kbps) — пользователь его не выбирает.
  return API + '/api/stream/' + encodeURIComponent(track.id) + '?quality=mid';
}

function streamUrlWithCacheBust(track) {
  const url = streamUrl(track);
  return url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
}

/* ── HLS: Safari играет нативно, Chrome — через hls.js ─────────────── */
let activeHls = null;
let activeScBlobUrl = null;

function destroyActiveHls() {
  if (!activeHls) return;
  try { activeHls.destroy(); } catch { /* ignore */ }
  activeHls = null;
}

function nativeHlsPlayback() {
  try { return !!audio.canPlayType('application/vnd.apple.mpegurl'); } catch { return false; }
}

/**
 * Ставит источник трека в <audio>. Для SoundCloud HLS на не-Safari
 * подключается hls.js; для каталога остаётся прежний <audio src>.
 */
function applyAudioSource(track, { autoplay = false, onError = null } = {}) {
  destroyActiveHls();
  if (activeScBlobUrl) { try { URL.revokeObjectURL(activeScBlobUrl); } catch { /* ignore */ } activeScBlobUrl = null; }
  if (!track) return;
  try {
    if (isSoundCloudTrack(track)) audio.dataset.beatSrc = streamUrl(track);
    else delete audio.dataset.beatSrc;
  } catch { /* ignore */ }
  const useHlsJs = isSoundCloudTrack(track) && !nativeHlsPlayback() && window.Hls && window.Hls.isSupported();
  if (useHlsJs) {
    activeHls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
    activeHls.attachMedia(audio);
    activeHls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      if (autoplay) audio.play().catch((error) => { if (onError) onError(error); });
    });
    activeHls.on(window.Hls.Events.ERROR, (event, data) => {
      if (data && data.fatal) {
        destroyActiveHls();
        if (onError) onError(new Error('hls_fatal_' + (data.type || 'error')));
      }
    });
    activeHls.loadSource(streamUrl(track));
    return;
  }
  audio.src = streamUrl(track);
  audio.load();
  if (autoplay) audio.play().catch((error) => { if (onError) onError(error); });
}

function restoreStandardSource(resumeAt = 0) {
  if (!S.current) return;
  applyAudioSource(S.current, { autoplay: true });
  if (resumeAt > 0) {
    audio.addEventListener('loadedmetadata', () => {
      try { audio.currentTime = resumeAt; } catch { /* ignore */ }
    }, { once: true });
  }
}

function syncLyricsTrack(track) {
  if (window.RH_LYRICS) window.RH_LYRICS.setTrack(track || null);
}

/* ── Байты аудио для AutoMix: MP3 напрямую, HLS — init + fMP4-сегменты ── */
async function fetchHlsAudioBytes(url, depth = 0) {
  if (depth > 2) throw new Error('hls_playlist_depth');
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('hls_http_' + response.status);
  const contentType = String(response.headers.get('content-type') || '');
  // Некоторые треки SoundCloud отдают progressive MP3 через тот же /api/sc/play.
  if (contentType && !/mpegurl|m3u8/i.test(contentType)) return response.arrayBuffer();
  const text = await response.text();
  if (!/^#EXTM3U/m.test(text.trim())) return new TextEncoder().encode(text).buffer;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('hls_empty');
  if (lines.some((line) => line.startsWith('#EXT-X-STREAM-INF'))) {
    const variant = lines.find((line) => !line.startsWith('#'));
    if (!variant) throw new Error('hls_variant');
    return fetchHlsAudioBytes(new URL(variant, url).href, depth + 1);
  }
  const mapLine = lines.find((line) => line.startsWith('#EXT-X-MAP:'));
  const mapMatch = mapLine && mapLine.match(/URI="([^"]+)"/);
  const init = mapMatch ? new URL(mapMatch[1], url).href : null;
  const segments = lines.filter((line) => !line.startsWith('#')).map((line) => new URL(line, url).href);
  if (!segments.length || segments.length > 240) throw new Error('hls_segments');
  const parts = [];
  const read = async (href) => {
    const res = await fetch(href, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('hls_segment_' + res.status);
    return new Uint8Array(await res.arrayBuffer());
  };
  if (init) parts.push(await read(init));
  parts.push(...await Promise.all(segments.map(read)));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  if (total > 24 * 1024 * 1024) throw new Error('hls_too_large');
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { merged.set(part, offset); offset += part.length; }
  return merged.buffer;
}

async function fetchAudioBytes(track, url = streamUrl(track)) {
  if (isSoundCloudTrack(track)) return fetchHlsAudioBytes(url);
  const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'audio/mpeg' } });
  if (!response.ok) throw new Error('stream HTTP ' + response.status);
  return response.arrayBuffer();
}


/* ───────────────────────── RH Smart Mix (UI и мост к движку) ───────────────────────── */

function smartMixBarsLabel(bars) {
  const n = Number(bars);
  if (n === 4) return '4 такта';
  if (n === 16) return '16 тактов';
  return '8 тактов';
}

function smartMixControlsHTML() {
  const settings = window.RH_SMARTMIX
    ? window.RH_SMARTMIX.getSettings()
    : { enabled: false, bars: 8 };
  const presets = [4, 8, 16].map((bars) => `
    <button class="chip${settings.bars === bars ? ' is-active' : ''}" type="button"
            data-action="smartmix-bars" data-bars="${bars}" data-smartmix-preset="${bars}"
            aria-pressed="${settings.bars === bars ? 'true' : 'false'}">${smartMixBarsLabel(bars)}</button>`).join('');
  return `
    <div class="smartmix-row">
      <div class="smartmix-text">
        <b>RH Smart Mix</b>
        <small data-smartmix-state>${settings.enabled ? `Включены · ${smartMixBarsLabel(settings.bars)}` : 'Выключены'}</small>
      </div>
      <button class="btn-mini" type="button" data-action="smartmix-toggle" data-smartmix-toggle
              aria-pressed="${settings.enabled ? 'true' : 'false'}">${settings.enabled ? 'Выключить' : 'Включить'}</button>
    </div>
    <div class="smartmix-presets" role="group" aria-label="Длина перехода">${presets}</div>
    <div class="smartmix-subrow">
      <button class="chip${settings.preload ? ' is-active' : ''}" type="button"
              data-action="smartmix-preload" data-smartmix-preload aria-pressed="${settings.preload ? 'true' : 'false'}">Предзагрузка: ${settings.preload ? 'вкл' : 'выкл'}</button>
    </div>
    <p class="hint" data-smartmix-hint>Сведение по битам и фразам: следующий трек входит заранее, бас меняется в музыкальный момент.</p>`;
}

function smartMixSettingsHTML() {
  return `
    <section class="section">
      <div class="section-head">
        <div>
          <h2 class="section-title">Музыкальные переходы</h2>
          <p class="section-sub">RH Smart Mix</p>
        </div>
      </div>
      <div class="smartmix-card">${smartMixControlsHTML()}</div>
    </section>`;
}

function equalizerControlsHTML() {
  const state = window.RH_EQUALIZER
    ? window.RH_EQUALIZER.getState()
    : { enabled: false, preset: 'flat', gains: new Array(10).fill(0), supported: null };
  const labels = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
  const presets = ['flat', 'pop', 'rock', 'jazz', 'classical', 'electronic', 'hiphop', 'vocal']
    .map((name) => `<button class="chip${state.preset === name ? ' is-active' : ''}" type="button" data-action="equalizer-preset" data-preset="${name}" aria-pressed="${state.preset === name ? 'true' : 'false'}">${name === 'flat' ? 'Ровно' : name[0].toUpperCase() + name.slice(1)}</button>`)
    .join('');
  const bands = state.gains.map((gain, index) => `
    <label class="eq-band">
      <input type="range" min="-12" max="12" step="1" value="${Number(gain) || 0}" data-action="equalizer-band" data-band="${index}" aria-label="${labels[index]} Гц">
      <span>${labels[index]}</span>
    </label>`).join('');
  const disabled = state.supported === false;
  return `
    <div class="equalizer-row">
      <div class="equalizer-text">
        <b>Эквалайзер</b>
        <small data-equalizer-state>${disabled ? 'Недоступен: аудиограф занят' : state.enabled ? 'Включён' : 'Выключен'}</small>
      </div>
      <button class="btn-mini" type="button" data-action="equalizer-toggle" aria-pressed="${state.enabled ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}>${state.enabled ? 'Выключить' : 'Включить'}</button>
    </div>
    <div class="equalizer-presets" role="group" aria-label="Пресеты эквалайзера">${presets}</div>
    <div class="equalizer-bands" role="group" aria-label="Частотные полосы">${bands}</div>
    <p class="hint" data-equalizer-hint>${disabled ? 'Другой аудиограф уже использует этот элемент. Перезагрузите страницу и включите эквалайзер первым.' : 'Настройте полосы вручную или выберите пресет: Pop, Rock, Jazz, Classical, Electronic, Hip-Hop, Vocal.'}</p>`;
}

function equalizerSettingsHTML() {
  return `
    <section class="section">
      <div class="section-head">
        <div>
          <h2 class="section-title">Эквалайзер</h2>
          <p class="section-sub">Настройка звука под жанр или наушники</p>
        </div>
      </div>
      <div class="equalizer-card">${equalizerControlsHTML()}</div>
    </section>`;
}

function refreshEqualizerUI() {
  const state = window.RH_EQUALIZER ? window.RH_EQUALIZER.getState() : null;
  if (!state) return;
  document.querySelectorAll('[data-action="equalizer-toggle"]').forEach((el) => {
    el.textContent = state.enabled ? 'Выключить' : 'Включить';
    el.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
    el.disabled = state.supported === false;
  });
  document.querySelectorAll('[data-equalizer-state]').forEach((el) => {
    el.textContent = state.supported === false ? 'Недоступен: аудиограф занят' : state.enabled ? 'Включён' : 'Выключен';
  });
  document.querySelectorAll('[data-action="equalizer-preset"]').forEach((el) => {
    const active = el.dataset.preset === state.preset;
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-action="equalizer-band"]').forEach((el) => {
    const index = Number(el.dataset.band);
    el.value = String(state.gains[index] || 0);
  });
  for (const id of ['equalizerBtn', 'npEqualizer']) {
    const button = $(id);
    if (button) button.classList.toggle('is-on', state.enabled);
  }
}

function openEqualizerSheet() {
  sheetOpen(`
    <h2 class="sheet-title">Эквалайзер</h2>
    <p class="sheet-sub">Настройка звука: 10 полос, ручной режим и жанровые пресеты.</p>
    <div class="equalizer-card">${equalizerControlsHTML()}</div>
  `);
  refreshEqualizerUI();
}

function refreshSmartMixUI() {
  const info = window.RH_SMARTMIX ? window.RH_SMARTMIX.getState() : null;
  const settings = info ? info.settings : { enabled: false, bars: 8 };
  const supported = info ? info.supported : null;
  const pressed = settings.enabled ? 'true' : 'false';
  document.querySelectorAll('[data-smartmix-toggle]').forEach((el) => {
    el.textContent = settings.enabled ? 'Выключить' : 'Включить';
    el.setAttribute('aria-pressed', pressed);
    el.classList.toggle('is-on', settings.enabled);
  });
  document.querySelectorAll('[data-smartmix-state]').forEach((el) => {
    el.textContent = settings.enabled ? `Включены · ${smartMixBarsLabel(settings.bars)}` : 'Выключены';
  });
  document.querySelectorAll('[data-smartmix-preload]').forEach((el) => {
    const on = settings.preload !== false;
    el.textContent = `Предзагрузка: ${on ? 'вкл' : 'выкл'}`;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  document.querySelectorAll('[data-smartmix-preset]').forEach((el) => {
    const active = Number(el.dataset.smartmixPreset) === Number(settings.bars);
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-smartmix-hint]').forEach((el) => {
    el.textContent = supported === false
      ? 'Упрощённый режим без эквалайзера: темп и фраза выравниваются, если это возможно.'
      : settings.enabled
        ? 'Следующий трек входит на границе фразы, темп выравнивается мягко, бас меняется в музыкальный момент.'
        : 'Выключено. Включите, чтобы треки переходили с музыкальным сведением.';
  });
  const button = $('smartmixBtn');
  if (button) {
    button.classList.toggle('is-on', settings.enabled);
    button.setAttribute('aria-pressed', pressed);
  }
  const chip = $('npSmartMix');
  if (chip) chip.classList.toggle('is-on', settings.enabled);
}

function openSmartMixSheet() {
  sheetOpen(`
    <h2 class="sheet-title">Музыкальные переходы</h2>
    <p class="sheet-sub">RH Smart Mix сводит треки по ритму и музыкальным фразам, а не просто затуханием громкости.</p>
    <div class="smartmix-card">${smartMixControlsHTML()}</div>
    <p class="hint" data-smartmix-hint></p>
  `);
  refreshSmartMixUI();
}

function toggleSmartMix() {
  if (!window.RH_SMARTMIX) return;
  const current = window.RH_SMARTMIX.getSettings();
  const next = !current.enabled;
  window.RH_SMARTMIX.setSettings({ enabled: next });
  refreshSmartMixUI();
  if (next) {
    window.RH_SMARTMIX.warm().then((ok) => {
      refreshSmartMixUI();
      if (!ok) toast('Упрощённый режим: без эквалайзера', 'info');
    }).catch(() => {});
  }
}

function setSmartMixBars(bars) {
  if (!window.RH_SMARTMIX) return;
  window.RH_SMARTMIX.setSettings({ bars: Number(bars) });
  refreshSmartMixUI();
}

function toggleSmartMixPreload() {
  if (!window.RH_SMARTMIX) return;
  const settings = window.RH_SMARTMIX.getSettings();
  window.RH_SMARTMIX.setSettings({ preload: !settings.preload });
  refreshSmartMixUI();
}

function smartMixState() {
  return {
    current: S.current,
    index: S.index,
    queue: S.queue,
    repeat: S.repeat,
    paused: audio.paused,
    currentTime: audio.currentTime || 0,
    duration: Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : (S.current ? Number(S.current.duration) || 0 : 0),
    volume: S.volume,
    muted: S.muted,
  };
}

let smartMixAdoptionToken = 0;
let smartMixAdopting = false;

function smartMixHandoffActive() {
  if (!window.RH_SMARTMIX || typeof window.RH_SMARTMIX.getState !== 'function') return false;
  try {
    const state = window.RH_SMARTMIX.getState();
    return !!(state && state.phase === 'handoff');
  } catch {
    return false;
  }
}

function smartMixAdoptFailure(reason, retryable) {
  return { ok: false, reason: reason || 'adopt_failed', retryable: retryable !== false };
}

/**
 * Передаёт Smart Mix-трек основному <audio>. Состояние интерфейса меняется
 * сразу (mix уже играет этот трек), а успехом считается только подтверждённая
 * стабильность: буфер около целевой позиции, playing, рост currentTime и
 * отсутствие повторного stall.
 *
 * options.retry === true используется движком для одной повторной попытки:
 * src уже установлен, повторный load() запрещён.
 */
async function adoptSmartMixTrack(index, position, options = {}) {
  if (index < 0 || index >= S.queue.length) return smartMixAdoptFailure('bad_index', false);
  const resume = options.retry === true || options.resume === true;
  const track = S.queue[index];
  if (isSoundCloudTrack(track)) return smartMixAdoptFailure('unsupported_source', false);
  const token = ++smartMixAdoptionToken;

  if (resume && (!S.current || String(S.current.id) !== String(track.id) || !audio.src)) {
    return smartMixAdoptFailure('stale_retry', true);
  }

  if (!resume) {
    flushPlayback(true);
    S.index = index;
    S.current = track;
    S.retried = false;
    updateNowPlayingMeta(track);
    syncLyricsTrack(track);
    renderQueue();
    markCurrentRow();
    S.loading = true;
    updateTransport();
    // load() может вызвать pause старого источника: это внутренняя операция,
    // а не пользовательская пауза.
    smartMixAdopting = true;
    applyAudioSource(track, { autoplay: false });
  } else {
    smartMixAdopting = true;
  }

  const expectedSrc = audio.src;
  try {
    const handoff = window.RH_SMARTMIX && window.RH_SMARTMIX._internal;
    if (!handoff || typeof handoff.adoptPrimary !== 'function') {
      return smartMixAdoptFailure('handoff_unavailable', false);
    }
    const result = await handoff.adoptPrimary(audio, {
      position,
      signal: options.signal,
      livePosition: options.livePosition,
      onStage: options.onStage,
      expectedSrc,
    });
    if (token !== smartMixAdoptionToken || (options.signal && options.signal.aborted)) {
      return smartMixAdoptFailure('cancelled', false);
    }
    if (!result || !result.ok) {
      S.loading = false;
      updateTransport();
      return {
        ok: false,
        reason: (result && result.reason) || 'adopt_failed',
        retryable: !result || result.retryable !== false,
        ahead: result && result.ahead,
      };
    }
    if (!resume || !S.playback || String(S.playback.trackId) !== String(track.id)) {
      startPlaybackSession(track, 'smartmix');
    }
    savePlayerState(audio.currentTime);
    S.loading = false;
    S.playing = true;
    updateTransport();
    markCurrentRow();
    return { ok: true, reason: 'stable', position: audio.currentTime, ahead: result.ahead };
  } catch (error) {
    S.loading = false;
    updateTransport();
    return smartMixAdoptFailure(error && error.name === 'AbortError' ? 'cancelled' : 'adopt_exception', false);
  } finally {
    // Одновременно выполняется только один adopt; старый вызов обязан снять
    // защитный флаг даже если пользователь уже переключил трек.
    smartMixAdopting = false;
  }
}

/** Резервный режим: звучит engine.mix, основной источник ещё не стабилен. */
function onSmartMixFallback(index, position) {
  if (!S.current || (index >= 0 && index !== S.index)) return;
  S.loading = false;
  S.playing = true;
  updateTransport();
  markCurrentRow();
  if (!S.playback || String(S.playback.trackId) !== String(S.current.id)) {
    startPlaybackSession(S.current, 'smartmix');
  }
  savePlayerState(position);
}

/** Отмена handoff не должна оставлять кнопки в состоянии «играет». */
function onSmartMixCancelled() {
  S.loading = false;
  S.playing = !audio.paused;
  updateTransport();
  markCurrentRow();
}

let aiSavedSmartMix = false;

function applyAiMixTimeline(info) {
  const mix = info && info.mix ? info.mix : null;
  const duration = S.current ? Number(S.current.duration) || 0 : (Number.isFinite(audio.duration) ? audio.duration : 0);
  const start = mix && duration > 0 ? Math.max(0, Math.min(100, (mix.startAt / duration) * 100)) : 0;
  const width = mix && duration > 0 ? Math.max(0, Math.min(100 - start, (mix.durationSec / duration) * 100)) : 0;
  const progress = mix && Number.isFinite(mix.progress) ? Math.max(0, Math.min(100, mix.progress * 100)) : 0;
  document.querySelectorAll('.player-progress, .np-progress').forEach((el) => {
    el.style.setProperty('--mix-start', start + '%');
    el.style.setProperty('--mix-width', width + '%');
    el.style.setProperty('--mix-progress', progress + '%');
    el.style.setProperty('--mix-opacity', mix ? '1' : '0');
  });
  const badge = $('aiMixStatus');
  if (badge) {
    if (mix && mix.incoming && (info.phase === 'MIXING' || info.phase === 'PREPARING')) {
      badge.hidden = false;
      badge.textContent = info.phase === 'MIXING'
        ? 'MIXING · ' + (S.current ? S.current.title : '') + ' → ' + mix.incoming.title
        : 'NEXT · ' + mix.incoming.title;
    } else {
      badge.hidden = true;
      badge.textContent = '';
    }
  }
}

const aiDiagState = { events: [], last: '' };
let aiLastPhase = '';
function aiDiag(event, extra = {}) {
  try {
    const info = window.RH_AI_AUTOMIX && window.RH_AI_AUTOMIX.getState ? window.RH_AI_AUTOMIX.getState() : null;
    aiDiagState.events.push({
      at: new Date().toISOString(), event,
      phase: info ? info.phase : null,
      preparing: info ? !!info.preparing : null,
      pausedAI: info ? !!info.paused : null,
      owns: info ? !!info.ownsPlayback : null,
      playing: S.playing, nativePaused: audio ? !!audio.paused : null,
      nativeTime: audio ? Number(audio.currentTime.toFixed(3)) : null,
      deckA: info && info.deckA ? { time: info.deckA.time, duration: info.deckA.duration, paused: info.deckA.paused } : null,
      deckB: info && info.deckB ? { time: info.deckB.time, duration: info.deckB.duration, paused: info.deckB.paused } : null,
      mix: info && info.mix ? { startAt: info.mix.startAt, durationSec: info.mix.durationSec, progress: info.mix.progress, strategy: info.mix.strategy } : null,
      ...extra,
    });
    if (aiDiagState.events.length > 300) aiDiagState.events.shift();
  } catch (_) {}
}
window.RH_AI_DIAG = {
  events: aiDiagState.events,
  dump() { return JSON.parse(JSON.stringify(aiDiagState.events)); },
  clear() { aiDiagState.events.length = 0; },
};

function aiOwnsPlayback() {
  return !!(window.RH_AI_AUTOMIX && typeof window.RH_AI_AUTOMIX.ownsPlayback === 'function' && window.RH_AI_AUTOMIX.ownsPlayback());
}

const aiRingAnim = {
  raf: 0, target: 0, display: 0, last: 0, key: '', mixKey: '',
  completing: false, flashUntil: 0,
};

function renderAiRing(value) {
  const progress = Math.max(0, Math.min(1, Number(value) || 0));
  aiRingAnim.display = progress;
  document.querySelectorAll('.np-play-wrap').forEach((el) => {
    el.style.setProperty('--np-mix-progress', progress.toFixed(4));
  });
}

function stopAiRingAnimation() {
  if (aiRingAnim.raf) cancelAnimationFrame(aiRingAnim.raf);
  aiRingAnim.raf = 0;
  aiRingAnim.last = 0;
}

function finishAiRing() {
  if (!aiRingAnim.completing) return;
  aiRingAnim.completing = false;
  stopAiRingAnimation();
  renderAiRing(1);
  aiRingAnim.flashUntil = Date.now() + 650;
  document.body.dataset.aiRingDone = '1';
  setTimeout(() => {
    document.body.dataset.aiRingDone = '';
    aiRingAnim.flashUntil = 0;
    if (!window.RH_AI_AUTOMIX || window.RH_AI_AUTOMIX.getState().phase !== 'MIXING') {
      document.body.dataset.aiPhase = '';
    }
  }, 650);
}

function tickAiRing(now) {
  aiRingAnim.raf = 0;
  if (!aiRingAnim.last) aiRingAnim.last = now;
  const dt = Math.min(0.04, Math.max(0, (now - aiRingAnim.last) / 1000));
  aiRingAnim.last = now;
  const target = aiRingAnim.target;
  const gap = target - aiRingAnim.display;
  // Frame-rate independent exponential smoothing. A larger target jump is
  // followed faster so the ring never lags audibly behind the transition.
  const tau = Math.abs(gap) > 0.15 ? 0.055 : 0.11;
  const alpha = 1 - Math.exp(-dt / tau);
  let next = aiRingAnim.display + Math.max(-0.08, Math.min(0.08, gap * alpha));
  if (Math.abs(target - next) < 0.0005) next = target;
  renderAiRing(next);
  if (target >= 0.999 && next >= 0.999) { finishAiRing(); return; }
  if (aiRingAnim.target > next || aiRingAnim.completing) {
    aiRingAnim.raf = requestAnimationFrame(tickAiRing);
  } else {
    aiRingAnim.display = target;
  }
}

function startAiRingAnimation() {
  if (aiRingAnim.raf) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    renderAiRing(aiRingAnim.target);
    if (aiRingAnim.target >= 0.999) finishAiRing();
    return;
  }
  aiRingAnim.last = 0;
  aiRingAnim.raf = requestAnimationFrame(tickAiRing);
}

function setAiRingTarget(progress, mixKey, paused) {
  const target = Math.max(0, Math.min(1, Number(progress) || 0));
  if (mixKey !== aiRingAnim.mixKey) {
    aiRingAnim.mixKey = mixKey;
    aiRingAnim.display = target;
    aiRingAnim.target = target;
    renderAiRing(target);
  } else {
    aiRingAnim.target = target;
  }
  if (paused || document.visibilityState === 'hidden') { stopAiRingAnimation(); return; }
  if (target <= aiRingAnim.display + 0.0001 && !aiRingAnim.completing) {
    stopAiRingAnimation();
    renderAiRing(target);
    return;
  }
  startAiRingAnimation();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { stopAiRingAnimation(); return; }
  if (window.RH_AI_AUTOMIX && window.RH_AI_AUTOMIX.getState().phase === 'MIXING') refreshAiAutoMixUI();
});

function refreshAiAutoMixUI() {
  const info = window.RH_AI_AUTOMIX ? window.RH_AI_AUTOMIX.getState() : null;
  const phase = info ? info.phase : 'OFF';
  const active = !!(info && info.active);
  const blocked = isSoundCloudTrack(S.current);
  const label = phase === 'OFF' ? 'AutoMix RH AI' : phase === 'READY' ? 'AutoMix RH AI · Ready' : phase === 'MIXING' ? 'AutoMix RH AI · Mixing' : 'AutoMix RH AI · ' + phase;
  if (active && window.RH_SMARTMIX) {
    try {
      if (window.RH_SMARTMIX.getSettings().enabled) { aiSavedSmartMix = true; window.RH_SMARTMIX.setSettings({ enabled: false }); }
    } catch (_) {}
  } else if (!active && aiSavedSmartMix && window.RH_SMARTMIX) {
    aiSavedSmartMix = false;
    try { window.RH_SMARTMIX.setSettings({ enabled: true }); } catch (_) {}
  }
  if (blocked && active) {
    try { window.RH_AI_AUTOMIX.disable(); } catch (_) {}
  }
  document.querySelectorAll('[data-action="ai-automix-toggle"]').forEach((el) => {
    el.classList.toggle('is-on', active);
    el.classList.toggle('is-disabled', blocked);
    el.classList.toggle('is-unavailable', blocked);
    el.disabled = blocked;
    el.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    el.setAttribute('aria-pressed', active ? 'true' : 'false');
    el.dataset.phase = phase;
    if (blocked) el.title = 'Недоступно для этой композиции';
    else el.removeAttribute('title');
    if (el.id === 'npAiAutomix') {
      el.setAttribute('aria-label', blocked ? 'Недоступно для этой композиции' : (label || 'AutoMix RH AI'));
      el.dataset.label = blocked ? '' : (label || '');
    }
  });
  if (phase === 'DEGRADED' && aiLastPhase !== 'DEGRADED' && info && info.error) {
    toast('AutoMix: ' + info.error, 'error');
  }
  const mix = info && info.mix ? info.mix : null;
  const justFinished = aiLastPhase === 'MIXING' && phase === 'ACTIVE' && active;
  const mixProgress = mix ? Math.max(0, Math.min(1, Number(mix.progress) || 0)) : 0;
  const mixKey = mix ? [mix.startAt, mix.durationSec, mix.strategy].join(':') : 'none';
  if (justFinished && !aiRingAnim.completing) {
    aiRingAnim.completing = true;
    aiRingAnim.target = 1;
  }
  if (phase === 'MIXING') {
    aiRingAnim.completing = false;
    document.body.dataset.aiRingDone = '';
    setAiRingTarget(mixProgress, mixKey, !!info.paused);
  } else if (aiRingAnim.completing || Date.now() < aiRingAnim.flashUntil) {
    // Keep the ring visible while it animates to 100% and flashes.
    if (document.body.dataset.aiRingDone) {
      // flash is running
    } else {
      startAiRingAnimation();
    }
  } else {
    stopAiRingAnimation();
    aiRingAnim.target = 0;
    renderAiRing(0);
  }
  const ringPhase = active && (phase === 'MIXING' || aiRingAnim.completing || Date.now() < aiRingAnim.flashUntil) ? 'MIXING' : (active ? (info && info.preparing ? 'PREPARING' : phase) : '');
  aiLastPhase = phase;
  document.body.dataset.aiPhase = ringPhase;
  document.body.dataset.aiRingDone = document.body.dataset.aiRingDone || '';
  document.body.style.setProperty('--ai-ring-color', phase === 'MIXING' ? '#9B6BFF' : phase === 'PREPARING' || phase === 'ANALYZING' ? '#6C8CFF' : phase === 'DEGRADED' ? '#FFB35C' : '#7CFFCB');
  applyAiMixTimeline(info);
  renderAiNextWidget(info);
  renderAiDiagnostics(info);
  const button = $('aiAutomixBtn');
  if (button) button.title = label;
  if (info && info.ownsPlayback) updateTransport();
  const diagKey = phase + ':' + (mix ? mix.progress + ':' + mix.strategy : '-') + ':' + (info && info.preparing ? 'prep' : '');
  if (diagKey !== aiDiagState.last) { aiDiagState.last = diagKey; aiDiag('ai_state'); }
}

function renderAiNextWidget(info) {
  const widget = $('aiNextWidget');
  if (!widget) return;
  const next = info && info.nextTrack;
  if (!info || !info.active || !next) { widget.hidden = true; return; }
  widget.hidden = false;
  const title = $('aiNextTitle'); const artist = $('aiNextArtist');
  const cover = $('aiNextCover'); const status = $('aiNextStatus'); const timer = $('aiNextTimer');
  if (title) title.textContent = next.title || '—';
  if (artist) artist.textContent = next.artist || '';
  if (cover) {
    if (next.cover) { cover.src = pic(next.cover, 160); cover.hidden = false; }
    else { cover.removeAttribute('src'); cover.hidden = true; }
  }
  const owned = !!info.ownsPlayback;
  const position = owned && info.deckA ? Number(info.deckA.time) || 0 : (audio.currentTime || 0);
  const paused = owned && info.deckA ? !!info.deckA.paused : !!audio.paused;
  const startAt = info.mix ? Number(info.mix.startAt) : NaN;
  let label = 'Анализ структуры';
  let timerText = '—';
  if (info.phase === 'ANALYZING') label = 'Анализ трека';
  else if (info.phase === 'PREPARING' || info.preparing) label = 'Подготовка перехода';
  else if (info.phase === 'MIXING') { label = 'Выполнение перехода'; timerText = 'MIX'; }
  else if (Number.isFinite(startAt)) {
    label = paused ? 'Пауза' : 'Переход подготовлен';
    const remain = Math.max(0, startAt - position);
    timerText = 'Переход через ' + fmt(remain);
  } else if (info.phase === 'DEGRADED') label = 'Ошибка обработки';
  if (status) status.textContent = label;
  if (timer) timer.textContent = timerText;
  widget.classList.toggle('is-paused', paused);
  widget.classList.toggle('is-mixing', info.phase === 'MIXING');
  widget.setAttribute('aria-label', 'Neural AI: ' + (next.title || 'следующий трек') + '. ' + label + ' ' + timerText);
}

function aiSeekToTransition() {
  const ai = window.RH_AI_AUTOMIX;
  if (!ai) return;
  const info = ai.getState();
  if (!info || !info.mix || !Number.isFinite(Number(info.mix.startAt))) return;
  const target = Math.max(0, Number(info.mix.startAt) - 5);
  if (typeof ai.seekToTransitionLead === 'function' && ai.seekToTransitionLead(5)) {
    refreshAiAutoMixUI();
    return;
  }
  const wasPaused = audio.paused;
  try {
    const limit = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.max(0, audio.duration - 0.5) : target;
    audio.currentTime = Math.min(target, limit);
  } catch (_) {}
  if (wasPaused) { try { audio.pause(); } catch (_) {} }
  syncSeek(audio.currentTime || 0, audio.duration || 0);
  refreshAiAutoMixUI();
}

function aiDiagRows(host, rows) {
  if (!host) return;
  host.innerHTML = rows.map(([key, value]) => `<dt>${key}</dt><dd title="${String(value == null ? '' : value).replace(/"/g, '&quot;')}">${value == null || value === '' ? '—' : value}</dd>`).join('');
}
function aiAnalysisRows(analysis, label) {
  if (!analysis) return [[label, 'нет данных']];
  const bpm = analysis.bpm == null ? null : Number(analysis.bpm).toFixed(1);
  const conf = analysis.bpmConfidence == null ? null : (analysis.bpmConfidence * 100).toFixed(0) + '%';
  const keyConf = analysis.keyConfidence == null ? null : (analysis.keyConfidence * 100).toFixed(0) + '%';
  const grid = analysis.grid ? `${analysis.grid.beats} beats · ${analysis.grid.downbeats} downbeats · phrase ${analysis.grid.phraseBars ?? '—'}` : 'нет';
  const bands = analysis.bands ? `L${(analysis.bands.low * 100).toFixed(0)} M${(analysis.bands.mid * 100).toFixed(0)} H${(analysis.bands.high * 100).toFixed(0)}` : null;
  const sections = analysis.sections && analysis.sections.length
    ? analysis.sections.slice(0, 5).map((section) => `${section.kind}@${Math.round(section.start)}s`).join(' · ')
    : 'нет';
  const vocal = analysis.vocal ? `risk ${(analysis.vocal.risk * 100).toFixed(0)}% · ${analysis.vocal.regions?.length ?? 0} regions` : (analysis.vocalRisk != null ? `risk ${(analysis.vocalRisk * 100).toFixed(0)}%` : null);
  return [
    ['BPM', bpm], ['BPM conf', conf], ['Grid', grid], ['Key', analysis.key], ['Camelot', analysis.camelot], ['Key conf', keyConf],
    ['Meter', analysis.meter ? `${analysis.meter.beatsPerBar}/4 (${(analysis.meter.confidence * 100).toFixed(0)}%)` : 'нет'],
    ['Energy', analysis.energy == null ? null : analysis.energy.toFixed(2)],
    ['Bands', bands], ['Vocal', vocal], ['Sections', sections],
    ['Warnings', (analysis.warnings || []).slice(0, 2).join('; ') || 'нет'],
  ];
}
function renderAiDiagnostics(info) {
  const panel = $('aiDiagPanel');
  if (!panel || panel.hidden) return;
  const plan = info && info.planSummary;
  aiDiagRows($('aiDiagA'), aiAnalysisRows(info && info.analysisA, 'A'));
  aiDiagRows($('aiDiagB'), aiAnalysisRows(info && info.analysisB, 'B'));
  const rows = plan ? [
    ['Strategy', plan.strategy],
    ['Min allowed', plan.minAllowedStart == null ? null : Number(plan.minAllowedStart).toFixed(2) + ' s (' + Math.round((plan.minProgressRatio || 0) * 100) + '%)'],
    ['Start A', Number(plan.startAt).toFixed(2) + ' s'],
    ['End A', Number(plan.outEnd).toFixed(2) + ' s'],
    ['Entry B', Number(plan.inStart).toFixed(2) + ' s'],
    ['Sections', plan.outSection && plan.inSection ? plan.outSection + ' → ' + plan.inSection : null],
    ['Phrase/Bar', (plan.phraseAligned ? 'phrase aligned' : 'internal phrase') + (plan.barAligned === false ? ' · bar off' : '')],
    ['Early rejected', plan.rejectedEarlyCandidates == null ? null : String(plan.rejectedEarlyCandidates)],
    ['Duration', `${Number(plan.durationSec).toFixed(1)} s / ${plan.durationBeats} beats`],
    ['Target BPM', Number(plan.bpmTarget).toFixed(1)],
    ['Rate A/B', `${Number(plan.rateOut).toFixed(3)} / ${Number(plan.rateIn).toFixed(3)}`],
    ['Score', Number(plan.score).toFixed(3)],
    ['Window', plan.window ? `${plan.window.score?.toFixed?.(2) ?? plan.window.score} · ${plan.window.uncertainty}` : null],
    ['Evidence', plan.window && Array.isArray(plan.window.evidence) ? plan.window.evidence.join(', ') : null],
    ['Deck B', info.deckBReady ? 'готов' : 'нет данных'],
    ['Sync', info.mix ? `${Number(info.mix.progress * 100).toFixed(0)}%` : 'ожидание'],
    ['Reason', (plan.reasons || []).slice(0, 3).join(' · ')],
    ['Warnings', (plan.warnings || []).slice(0, 2).join('; ') || 'нет'],
  ] : [['Plan', 'нет рассчитанного перехода']];
  aiDiagRows($('aiDiagT'), rows);
  const learning = info && info.learning;
  const last = info && info.lastTransition;
  const learnRows = learning ? [
    ['Status', learning.transitions ? 'обучение активно' : 'накапливает данные'],
    ['Version', learning.version + ' · model ' + learning.modelVersion],
    ['Transitions', String(learning.transitions)],
    ['Success / fail', `${learning.successful} / ${learning.failed}`],
    ['Avg quality', learning.averageQuality == null ? null : (learning.averageQuality * 100).toFixed(0) + '%'],
    ['Recent quality', learning.recentQuality == null ? null : (learning.recentQuality * 100).toFixed(0) + '%'],
    ['Timing', learning.timingQuality == null ? null : (learning.timingQuality * 100).toFixed(0) + '%'],
    ['Beatmatching', learning.beatQuality == null ? null : (learning.beatQuality * 100).toFixed(0) + '%'],
    ['Harmonic', learning.harmonicQuality == null ? null : (learning.harmonicQuality * 100).toFixed(0) + '%'],
    ['Energy', learning.energyQuality == null ? null : (learning.energyQuality * 100).toFixed(0) + '%'],
    ['Audio', learning.audioQuality == null ? null : (learning.audioQuality * 100).toFixed(0) + '%'],
    ['Early errors', String(learning.earlyErrors)],
    ['Late errors', String(learning.lateErrors)],
    ['Learning conf', (learning.learningConfidence * 100).toFixed(0) + '%'],
    ['Rollbacks', String(learning.rollbacks)],
    ['Last update', learning.updatedAt ? new Date(learning.updatedAt).toLocaleTimeString() : '—'],
    ['This transition', last ? `${(last.quality * 100).toFixed(0)}% · ${last.strategy}${last.userFeedback ? ' · ' + last.userFeedback : ''}` : 'ещё не исполнялся'],
    ['Strategy perf', Object.entries(learning.strategyPerformance || {}).slice(0, 3).map(([name, value]) => `${name}:${(value.mean * 100).toFixed(0)}%(${value.count})`).join(' · ') || null],
  ] : [['Learning', 'модуль не загружен']];
  aiDiagRows($('aiDiagLearn'), learnRows);
}
function adoptAiTrack(track, strategy, label = 'AutoMix RH AI', options = {}) {
  if (!track) return;
  if (isSoundCloudTrack(track)) {
    if (window.RH_AI_AUTOMIX) window.RH_AI_AUTOMIX.disable();
    return;
  }
  aiDiag('adopt', { adopted: String(track.id), strategy: strategy || null });
  const index = S.queue.findIndex((item) => String(item.id) === String(track.id));
  if (index >= 0) S.index = index;
  S.current = track;
  S.playing = true;
  S.loading = false;

  const sameSession = S.playback
    && String(S.playback.trackId) === String(track.id)
    && S.playback.source === 'automix';
  if (!sameSession) {
    flushPlayback(true);
    startPlaybackSession(track, 'automix');
  }

  updateNowPlayingMeta(track);
  renderCompactTrack(track);
  syncLyricsTrack(track);
  renderQueue();
  markCurrentRow();
  savePlayerState(0);
  $('npCur').textContent = '0:00';
  $('npDur').textContent = fmt(track.duration);
  syncSeek(0, Number(track.duration) || 0);
  updateTransport();
  if (!options.silent) toast(label + ': ' + track.title + (strategy ? ' · ' + strategy : ''), 'info');
  refreshAiAutoMixUI();
}

function initAiAutoMix() {
  if (!window.RH_AI_AUTOMIX) return;
  const aiDiagToggle = $('aiDiagToggle');
  const aiDiagPanel = $('aiDiagPanel');
  if (aiDiagToggle && aiDiagPanel && !aiDiagToggle.dataset.bound) {
    aiDiagToggle.dataset.bound = '1';
    aiDiagToggle.addEventListener('click', () => {
      const open = aiDiagPanel.hidden;
      aiDiagPanel.hidden = !open;
      aiDiagToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      aiDiagToggle.classList.toggle('is-on', open);
      renderAiDiagnostics(window.RH_AI_AUTOMIX.getState());
    });
  }
  const aiFeedback = $('aiFeedback');
  if (aiFeedback && !aiFeedback.dataset.bound) {
    aiFeedback.dataset.bound = '1';
    aiFeedback.addEventListener('click', (event) => {
      const button = event.target.closest('[data-feedback]');
      if (!button || !window.RH_AI_AUTOMIX) return;
      const record = window.RH_AI_AUTOMIX.feedback(button.dataset.feedback);
      if (record) button.classList.add('is-sent');
      renderAiDiagnostics(window.RH_AI_AUTOMIX.getState());
    });
  }
  const aiDiagClose = $('aiDiagClose');
  if (aiDiagClose && !aiDiagClose.dataset.bound) {
    aiDiagClose.dataset.bound = '1';
    aiDiagClose.addEventListener('click', () => { if (aiDiagPanel) aiDiagPanel.hidden = true; if (aiDiagToggle) { aiDiagToggle.setAttribute('aria-expanded', 'false'); aiDiagToggle.classList.remove('is-on'); } });
  }
    const aiNextWidget = $('aiNextWidget');
  if (aiNextWidget && !aiNextWidget.dataset.bound) {
    aiNextWidget.dataset.bound = '1';
    aiNextWidget.addEventListener('click', aiSeekToTransition);
    aiNextWidget.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); aiSeekToTransition(); }
    });
  }
  if (window.RH_LYRICS) {
    window.RH_LYRICS.setPositionProvider(() => {
      const ai = window.RH_AI_AUTOMIX;
      if (ai && typeof ai.ownsPlayback === 'function' && ai.ownsPlayback()) {
        const state = ai.getState();
        const deck = state && state.deckA;
        if (deck && Number.isFinite(deck.time)) return deck.time;
      }
      return null;
    });
    window.RH_LYRICS.setSeekHandler((seconds) => {
      const ai = window.RH_AI_AUTOMIX;
      if (ai && typeof ai.ownsPlayback === 'function' && ai.ownsPlayback()) {
        ai.seek(seconds);
        return;
      }
      try { audio.currentTime = seconds; } catch { /* ignore */ }
    });
  }
  window.RH_AI_AUTOMIX.init({
    getState: () => {
      const ai = window.RH_AI_AUTOMIX;
      const owned = !!(ai && typeof ai.ownsPlayback === 'function' && ai.ownsPlayback());
      const deck = owned ? ai.getState().deckA : null;
      const aiQueue = Array.isArray(S.queue) ? S.queue.filter((item) => !isSoundCloudTrack(item)) : [];
      const aiIndex = S.current && !isSoundCloudTrack(S.current) ? aiQueue.findIndex((item) => String(item.id) === String(S.current.id)) : -1;
      return {
        current: isSoundCloudTrack(S.current) ? null : S.current,
        index: aiIndex,
        queue: aiQueue,
        paused: deck ? !!deck.paused : audio.paused,
        currentTime: deck ? deck.time : (audio.currentTime || 0),
        duration: deck ? deck.duration : (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (S.current ? Number(S.current.duration) || 0 : 0)),
        volume: S.volume,
        muted: S.muted,
      };
    },
    streamUrl,
    fetchAudioBytes,
    getAudio: () => audio,
    onState: refreshAiAutoMixUI,
    onToast: toast,
    getFallbackTracks: async () => {
      if (!S.user) return [];
      const data = await loadRecommendations();
      const out = [];
      const seen = new Set();
      for (const sectionData of (data && data.sections) || []) {
        for (const item of (sectionData && sectionData.items) || []) {
          if (!item || !item.id || !item.title || !item.artist) continue;
          if (isSoundCloudTrack(item)) continue;
          if (seen.has(String(item.id))) continue;
          seen.add(String(item.id));
          out.push(item);
        }
      }
      return out;
    },
    onAdopt: (track, strategy) => adoptAiTrack(track, strategy, 'AutoMix RH AI', { silent: true }),
    onExit: (info) => {
      S.loading = false;
      S.playing = false;
      updateTransport();
      if (S.current) {
        const resumeAt = info && Number.isFinite(info.position) ? info.position : 0;
        restoreStandardSource(resumeAt);
        updateTransport();
      }
    },
    log: (message) => { if (RH_DEBUG) console.debug('[AutoMix RH AI]', message); },
  });
  refreshAiAutoMixUI();
  if (!window.__rhAiTimelineTimer) {
    window.__rhAiTimelineTimer = setInterval(() => {
      const ai = window.RH_AI_AUTOMIX;
      if (!ai || !ai.ownsPlayback || !ai.ownsPlayback()) return;
      const info = ai.getState();
      const deck = info.deckA;
      if (deck) {
        syncSeek(deck.time, deck.duration);
        $('npCur').textContent = fmt(deck.time);
        $('npDur').textContent = fmt(deck.duration);
      }
      if (window.RH_LYRICS) window.RH_LYRICS.refresh();
      // Страховка: если автопереход прошел, а текст еще от прошлого трека,
      // подтягиваем слова для активной деки AutoMix.
      const activeTrack = info.activeTrack;
      if (activeTrack && (!S.current || String(activeTrack.id) !== String(S.current.id)) && window.RH_LYRICS) {
        syncLyricsTrack(activeTrack);
      }
      refreshAiAutoMixUI();
    }, 250);
  }
}

function applyBetaTimeline(info) {
  const plan = info && info.plan ? info.plan : null;
  const duration = info && info.duration ? info.duration : (S.current ? Number(S.current.duration) || 0 : 0);
  const start = plan && duration > 0 ? Math.max(0, Math.min(100, plan.startAt / duration * 100)) : 0;
  const width = plan && duration > 0 ? Math.max(0, Math.min(100 - start, plan.durationSec / duration * 100)) : 0;
  const progress = plan && info.position != null ? Math.max(0, Math.min(1, (info.position - plan.startAt) / Math.max(0.1, plan.durationSec))) : 0;
  document.querySelectorAll('.player-progress, .np-progress').forEach((el) => {
    el.style.setProperty('--beta-mix-start', start + '%');
    el.style.setProperty('--beta-mix-width', width + '%');
    el.style.setProperty('--beta-mix-progress', (progress * 100) + '%');
    el.style.setProperty('--beta-mix-opacity', plan ? '1' : '0');
  });
  const badge = $('betaMixStatus');
  if (badge) {
    if (plan && info.active && (info.phase === 'MIXING' || info.phase === 'READY' || info.phase === 'ACTIVE')) {
      badge.hidden = false;
      badge.textContent = info.phase === 'MIXING'
        ? 'BETA MIXING · ' + (info.activeTrack ? info.activeTrack.title : '') + ' → ' + (info.nextTrack ? info.nextTrack.title : '')
        : 'BETA NEXT · ' + (info.nextTrack ? info.nextTrack.title : '') + ' · ' + plan.strategy;
    } else { badge.hidden = true; badge.textContent = ''; }
  }
}

function drawBetaWave(info) {
  const box = $('betaViz');
  if (!box) return;
  const beta = window.RH_AI_MIX_BETA;
  if (!beta || !info || !info.active) { box.hidden = true; return; }
  const viz = beta.getVisualization ? beta.getVisualization() : null;
  if (!viz || !viz.outPeaks) { box.hidden = true; return; }
  box.hidden = false;
  const draw = (id, peaks, position, duration, color) => {
    const canvas = $(id); if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const w = canvas.width, h = canvas.height; ctx.clearRect(0, 0, w, h);
    const bars = Math.min(320, peaks.length);
    for (let i = 0; i < bars; i += 1) {
      const p = peaks[Math.floor(i / bars * peaks.length)] || 0;
      const bh = Math.max(1, p * h * 0.92);
      ctx.fillStyle = color; ctx.fillRect(i * (w / bars), (h - bh) / 2, Math.max(1, w / bars - 1), bh);
    }
    if (duration > 0) {
      const x = Math.max(0, Math.min(w, (position / duration) * w));
      ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.fillRect(x, 0, 1.5, h);
    }
  };
  const duration = info.plan ? (S.current ? Number(S.current.duration) || 0 : 0) : (info.duration || 0);
  draw('betaWaveOut', viz.outPeaks, viz.outPosition, duration || (S.current ? Number(S.current.duration) || 0 : 0), 'rgba(255,120,70,.85)');
  if (viz.inPeaks) draw('betaWaveIn', viz.inPeaks, viz.inPosition, info.nextTrack ? Number(info.nextTrack.duration) || 0 : 0, 'rgba(120,170,255,.75)');
}

function refreshAiMixBetaUI() {
  const info = window.RH_AI_MIX_BETA ? window.RH_AI_MIX_BETA.getState() : null;
  const phase = info ? info.phase : 'OFF';
  const active = !!(info && info.active);
  document.querySelectorAll('[data-action="ai-mix-beta-toggle"]').forEach((el) => {
    el.classList.toggle('is-on', active);
    el.setAttribute('aria-pressed', active ? 'true' : 'false');
    el.dataset.phase = phase;
    if (el.id === 'npAiMixBeta') el.textContent = phase === 'OFF' ? 'AI Mix Beta' : 'Beta ' + phase;
  });
  applyBetaTimeline(info);
  drawBetaWave(info);
}

function initAiMixBeta() {
  if (!window.RH_AI_MIX_BETA) return;
  window.RH_AI_MIX_BETA.init({
    getState: () => {
      const beta = window.RH_AI_MIX_BETA;
      const owned = !!(beta && beta.ownsPlayback());
      const st = owned ? beta.getState() : null;
      return {
        current: S.current, index: S.index, queue: S.queue,
        paused: owned ? (st ? st.phase === 'READY' || st.phase === 'OFF' : false) : audio.paused,
        currentTime: owned && st ? st.position : (audio.currentTime || 0),
        duration: owned && st && st.duration ? st.duration : (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (S.current ? Number(S.current.duration) || 0 : 0)),
        volume: S.volume, muted: S.muted,
      };
    },
    streamUrl,
    getAudio: () => audio,
    onState: refreshAiMixBetaUI,
    onToast: toast,
    onAdopt: (track, strategy) => adoptAiTrack(track, strategy, 'AI Mix Beta'),
    onExit: (info) => {
      S.loading = false; S.playing = false; updateTransport();
      if (S.current) {
        const resumeAt = info && Number.isFinite(info.position) ? info.position : 0;
        restoreStandardSource(resumeAt);
        updateTransport();
      }
    },
    log: (message) => { if (RH_DEBUG) console.debug('[AI Mix Beta]', message); },
  });
  refreshAiMixBetaUI();
  if (!window.__rhBetaVizTimer) {
    window.__rhBetaVizTimer = setInterval(() => {
      const beta = window.RH_AI_MIX_BETA;
      if (!beta || !beta.ownsPlayback || !beta.ownsPlayback()) return;
      const info = beta.getState();
      if (info.position != null) { syncSeek(info.position, info.duration || 0); $('npCur').textContent = fmt(info.position); $('npDur').textContent = fmt(info.duration || 0); }
      refreshAiMixBetaUI();
    }, 250);
  }
}

function refreshAutoMix2UI() {
  const info = window.RH_AUTOMIX2 ? window.RH_AUTOMIX2.getState() : null;
  const phase = info ? info.phase : 'OFF';
  const active = !!(info && info.active);
  document.querySelectorAll('[data-action="automix2-toggle"]').forEach((el) => {
    el.classList.toggle('is-on', active);
    el.setAttribute('aria-pressed', active ? 'true' : 'false');
    el.dataset.phase = phase;
    if (el.id === 'npAutoMix2') el.textContent = phase === 'OFF' ? 'Auto Mix Beta 2.0' : (info && info.error ? '2.0 ' + phase + ' · ' + String(info.error).slice(0, 80) : '2.0 ' + phase);
  });
}

function initAutoMix2() {
  if (!window.RH_AUTOMIX2) return;
  window.RH_AUTOMIX2.init({
    getState: () => {
      const a = window.RH_AUTOMIX2;
      const owned = !!(a && a.ownsPlayback());
      const st = owned ? a.getState() : null;
      return {
        current: S.current, index: S.index, queue: S.queue,
        paused: owned && st ? !!st.paused : audio.paused,
        currentTime: owned && st ? st.position : (audio.currentTime || 0),
        duration: owned && st && st.duration ? st.duration : (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (S.current ? Number(S.current.duration) || 0 : 0)),
        volume: S.volume, muted: S.muted,
      };
    },
    streamUrl,
    getAudio: () => audio,
    onState: refreshAutoMix2UI,
    onToast: toast,
    onAdopt: (track, strategy) => adoptAiTrack(track, strategy, 'Auto Mix Beta 2.0'),
    onExit: (info) => {
      S.loading = false; S.playing = false; updateTransport();
      if (S.current) {
        const resumeAt = info && Number.isFinite(info.position) ? info.position : 0;
        restoreStandardSource(resumeAt);
        updateTransport();
      }
    },
    log: (message) => { if (RH_DEBUG) console.debug('[AutoMix2]', message); },
  });
  refreshAutoMix2UI();
}

function initSmartMix() {
  if (!window.RH_SMARTMIX) return;
  window.RH_SMARTMIX.init({
    getState: smartMixState,
    getAudio: () => audio,
    streamUrl,
    adoptTrack: adoptSmartMixTrack,
    onHandoffFallback: onSmartMixFallback,
    onHandoffCancelled: onSmartMixCancelled,
    toast,
    onChange: refreshSmartMixUI,
  });
  // Smart Mix удалён из интерфейса. Гасим сохранённое состояние, чтобы старый
  // граф не занимал <audio> и не конфликтовал с эквалайзером.
  try { window.RH_SMARTMIX.setSettings({ enabled: false, preload: false }); } catch { /* ignore */ }
  refreshSmartMixUI();
}

const PLAYER_STATE_KEY = 'rh_player_v1';

/**
 * Показывать ли мини-плеер. Источник истины — выбранный трек в состоянии
 * приложения, а не наличие HTML-элемента или старое название в разметке.
 */
function hasSelectedTrack(state = S) {
  const track = state && state.current;
  return !!(track && track.id && String(track.id).length > 0);
}

function shouldShowPlayer(state = S) {
  if (!hasSelectedTrack(state)) return false;
  // Ручное скрытие важнее состояния воспроизведения: пауза его не отменяет.
  if (state.playerHidden) return false;
  return true;
}

/**
 * Прячет/показывает плеер и освобождает место под ним.
 * На десктопе панель постоянная (как в Koel/Spotify): даже без выбранного трека
 * она остаётся на месте и не перекрывает контент, потому что страница резервирует
 * её высоту. На телефоне пустая панель по-прежнему скрыта.
 */
let playerHideTimer = 0;

function computedPlayerVisible() {
  const authRoute = S.route === 'login' || S.route === 'register';
  const emptyDesktopBar = isDesktop() && !authRoute && !S.playerHidden && !hasSelectedTrack();
  return shouldShowPlayer() || emptyDesktopBar;
}

function syncPlayerVisibility() {
  const visible = computedPlayerVisible();
  const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!visible && reducedMotion) {
    player.hidden = !visible;
    player.classList.add('is-hidden');
    document.body.classList.remove('has-player');
    updateCompactPlayer();
    syncLayoutHeight();
    return;
  }
  if (visible) {
    if (playerHideTimer) { clearTimeout(playerHideTimer); playerHideTimer = 0; }
    const wasHidden = player.hidden;
    player.hidden = false;
    if (wasHidden) void player.offsetWidth;
    player.classList.remove('is-hidden');
  } else {
    player.classList.add('is-hidden');
    if (!player.hidden && !playerHideTimer) {
      playerHideTimer = setTimeout(() => {
        playerHideTimer = 0;
        if (!computedPlayerVisible()) player.hidden = true;
      }, 340);
    }
  }
  document.body.classList.toggle('has-player', visible);
  updateCompactPlayer();
  syncLayoutHeight();
}

/** Показывает компактный плеер в шапке, когда нижний скрыт. */
function updateCompactPlayer() {
  const box = $('miniNow');
  if (!box) return;
  const show = S.playerHidden && hasSelectedTrack();
  box.hidden = !show;
  document.body.classList.toggle('has-mini-now', show);
  if (show) renderCompactTrack(S.current);
}

/**
 * Заполняет компактный блок: обложка, название, исполнитель.
 * Бегущая строка включается только если текст не помещается.
 */
let compactRenderId = 0;

function renderCompactTrack(track) {
  if (!track) return;
  const cover = $('miniNowCover');
  if (cover) {
    if (track.cover) { cover.src = pic(track.cover, 120); cover.hidden = false; }
    else { cover.removeAttribute('src'); cover.hidden = true; }
  }
  const artist = $('miniNowArtist');
  if (artist) {
    artist.textContent = track.artist || '';
    artist.hidden = !track.artist;
  }

  const box = $('miniNow');
  const run = $('miniNowRun');
  const wrap = $('miniNowTitleWrap');
  if (!box || !run) return;
  const title = track.title || 'Без названия';

  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  run.style.animationDuration = '';
  box.classList.remove('is-scrolling');
  run.innerHTML = `<span class="mini-now-line">${esc(title)}</span>`;

  const renderId = ++compactRenderId;

  // Замер синхронный: clientWidth/offsetWidth сами вызывают layout, и результат
  // не зависит от кадров анимации (которые могут не прийти в фоновой вкладке).
  const measure = () => {
    if (renderId !== compactRenderId || box.hidden || reduced) return;
    const available = wrap ? wrap.clientWidth : 0;
    const line = run.firstElementChild;
    const textWidth = line ? Math.max(0, line.offsetWidth - 26) : 0;
    if (available <= 0) return;
    if (textWidth > available + 1) {
      run.innerHTML = `<span class="mini-now-line">${esc(title)}</span><span class="mini-now-line" aria-hidden="true">${esc(title)}</span>`;
      run.style.animationDuration = Math.max(7, Math.min(24, (textWidth + 26) / 34)).toFixed(1) + 's';
      box.classList.add('is-scrolling');
    }
  };
  measure();
  // Если блок только что показан и ширина ещё не посчитана — один повторный замер.
  if (wrap && wrap.clientWidth <= 0) requestAnimationFrame(measure);
}

/**
 * Скрывает панель плеера, НЕ трогая воспроизведение: аудио, очередь, позиция
 * и сохранённое состояние остаются как были.
 */
function hidePlayer(notify = true) {
  if (!hasSelectedTrack()) return;
  S.playerHidden = true;
  player.style.transform = '';
  player.classList.remove('is-dragging');
  syncPlayerVisibility();
  if (notify) toast('Плеер скрыт — управление в шапке.', 'info');
}

function showPlayer() {
  S.playerHidden = false;
  player.style.transform = '';
  player.classList.remove('is-dragging');
  syncPlayerVisibility();
}

function savePlayerState(position) {
  try {
    // Ручное скрытие панели не должно стирать сохранённый трек и позицию.
    if (!hasSelectedTrack()) { localStorage.removeItem(PLAYER_STATE_KEY); return; }
    const queue = (S.queue.length ? S.queue : [S.current]).slice(0, 80);
    let offset = Math.max(0, Math.round(Number(position != null ? position : audio.currentTime) || 0));
    // Пока трек после перезагрузки ещё не запущен, позиция берётся из
    // восстановленного состояния, а не из пустого <audio> (0:00).
    if (offset === 0 && S.restorePosition > 0 && !audio.currentSrc) offset = Math.round(S.restorePosition);
    writeJson(PLAYER_STATE_KEY, {
      track: S.current,
      index: S.index,
      queue,
      position: offset,
      shuffle: !!S.shuffle,
      repeat: S.repeat,
      savedAt: Date.now(),
    });
  } catch { /* localStorage может быть недоступен */ }
}

function clearPlayerState() {
  try { localStorage.removeItem(PLAYER_STATE_KEY); } catch { /* ignore */ }
}

/**
 * Восстанавливает последний выбранный трек (без автозапуска).
 * Возвращает false, если сохранённое состояние непригодно.
 */
function restorePlayerState() {
  const saved = readJson(PLAYER_STATE_KEY, null);
  if (!saved || !saved.track || !saved.track.id || !saved.track.title) return false;
  const queue = Array.isArray(saved.queue) && saved.queue.length
    ? saved.queue.filter((item) => item && item.id && item.title).slice(0, 80)
    : [saved.track];
  if (!queue.length) { clearPlayerState(); return false; }

  let index = Number(saved.index);
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) index = 0;

  S.queue = queue;
  S.index = index;
  S.current = queue[index];
  S.shuffle = !!saved.shuffle;
  S.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
  S.restorePosition = Math.max(0, Number(saved.position) || 0);
  S.restoreTrackId = String(S.current.id);
  S.lastStateSave = Date.now();

  updateNowPlayingMeta(S.current);
  syncLyricsTrack(S.current);
  renderQueue();
  updateTransport();

  if (S.restorePosition > 0) {
    const duration = Number(S.current.duration) || 0;
    $('npCur').textContent = fmt(S.restorePosition);
    if (duration > 0) syncSeek(S.restorePosition, duration);
  }
  return true;
}

/* ───────────────────────────── громкость ───────────────────────────── */

function applyVolume() {
  audio.volume = S.muted ? 0 : S.volume;
  if (window.RH_SMARTMIX && typeof window.RH_SMARTMIX.setVolume === 'function') {
    window.RH_SMARTMIX.setVolume(S.muted ? 0 : S.volume);
  }
  const el = $('volume');
  const percent = Math.round((S.muted ? 0 : S.volume) * 100);
  if (el) {
    el.value = String(percent);
    el.style.setProperty('--vol-fill', percent + '%');
    el.classList.toggle('is-muted', S.muted || S.volume === 0);
  }
  const btn = $('volumeBtn');
  if (btn) {
    btn.classList.toggle('is-muted', S.muted || S.volume === 0);
    btn.setAttribute('aria-label', S.muted ? 'Включить звук' : 'Выключить звук');
  }
  writeJson('rh_volume_v1', { volume: S.volume, muted: S.muted });
}

function restoreVolume() {
  const saved = readJson('rh_volume_v1', null);
  if (saved && Number.isFinite(Number(saved.volume))) {
    S.volume = Math.min(1, Math.max(0, Number(saved.volume)));
    S.muted = !!saved.muted;
  }
  applyVolume();
}

function updateTransport() {
  if (aiOwnsPlayback()) {
    const ai = window.RH_AI_AUTOMIX.getState();
    S.playing = !ai.paused;
    S.loading = ai.phase === 'LOADING' || ai.phase === 'ANALYZING' || ai.phase === 'PREPARING';
  }
  const hasTrack = !!S.current;
  ['play', 'playMini', 'npPlay'].forEach((id) => { const el = $(id); if (el) el.disabled = !hasTrack; });
  ['prev', 'next', 'npPrev', 'npNext'].forEach((id) => { const el = $(id); if (el) el.disabled = !S.queue.length; });
  ['seekMini', 'seekBig'].forEach((id) => { const el = $(id); if (el) el.disabled = !hasTrack; });
  player.classList.toggle('is-playing', S.playing);
  player.classList.toggle('is-loading', S.loading);
  const mini = $('miniNow');
  if (mini) {
    mini.classList.toggle('is-playing', S.playing);
    mini.classList.toggle('is-loading', S.loading);
    const miniPlay = $('miniNowPlay');
    if (miniPlay) {
      miniPlay.disabled = !hasTrack;
      miniPlay.setAttribute('aria-label', S.playing ? 'Пауза' : 'Воспроизвести');
    }
  }
  nowPlaying.classList.toggle('is-playing', S.playing);
  nowPlaying.classList.toggle('is-loading', S.loading);
  $('shuffle').classList.toggle('is-on', S.shuffle);
  const npShuffle = $('npShuffle'); if (npShuffle) npShuffle.classList.toggle('is-on', S.shuffle);
  const npRepeat = $('npRepeat'); if (npRepeat) { npRepeat.classList.toggle('is-on', S.repeat !== 'off'); npRepeat.classList.toggle('is-one', S.repeat === 'one'); }
  ['repeat'].forEach((id) => {
    const el = $(id);
    el.classList.toggle('is-on', S.repeat !== 'off');
    el.classList.toggle('is-one', S.repeat === 'one');
  });
  syncPlayerVisibility();
}

let npLastTrackId = '';
let npCoverToken = 0;
let npTextTimer = 0;
let npTextToken = 0;

function npReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

let npTitleMeasureToken = 0;

function marqueeTextWidth(el, title) {
  try {
    const cs = getComputedStyle(el);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return Math.ceil(ctx.measureText(title).width) + 34;
  } catch {
    return el.offsetWidth;
  }
}

function applyMarquee(el, title, kind) {
  if (!el) return;
  const runClass = kind + '-run';
  const lineClass = kind + '-line';
  el.classList.remove('is-scrolling');
  el.innerHTML = `<span class="${runClass}"><span class="${lineClass}">${esc(title)}</span></span>`;
  const measure = () => {
    const run = el.querySelector('.' + runClass);
    const line = el.querySelector('.' + lineClass);
    if (!run || !line || el.clientWidth <= 0) return;
    const width = marqueeTextWidth(line, title);
    if (width <= el.clientWidth + 1 || npReducedMotion()) return;
    run.innerHTML = `<span class="${lineClass}">${esc(title)}</span><span class="${lineClass}" aria-hidden="true">${esc(title)}</span>`;
    run.style.animationDuration = Math.max(8, Math.min(24, width / 34)).toFixed(1) + 's';
    el.classList.add('is-scrolling');
  };
  requestAnimationFrame(measure);
  setTimeout(measure, 120);
}

function applyNpTitle(track) {
  applyMarquee($('npTitle'), track ? (track.title || 'Без названия') : 'Ничего не играет', 'np-title');
}

function applyNpSong(track) {
  applyMarquee($('npSong'), track ? (track.title || 'Без названия') : 'Ничего не играет', 'np-song');
}

function applyNpText(track) {
  applyNpTitle(track);
  $('npArtist').innerHTML = track && track.artistId
    ? `<a href="#/artist/${esc(track.artistId)}" data-link>${esc(track.artist || 'Неизвестный исполнитель')}</a>`
    : esc(track ? (track.artist || 'Неизвестный исполнитель') : 'Выберите трек');
  applyNpSong(track);
  $('npSinger').textContent = track ? (track.artist || 'Неизвестный исполнитель') : 'Выберите трек';
}

let npCinemaTimer = 0;

function triggerNpBurst(art) {
  if (!art || npReducedMotion()) return;
  art.classList.remove('is-burst');
  void art.offsetWidth;
  art.classList.add('is-burst');
  if (npCinemaTimer) clearTimeout(npCinemaTimer);
  npCinemaTimer = setTimeout(() => {
    npCinemaTimer = 0;
    art.classList.remove('is-burst');
  }, 2050);
}

function setNpPalette(art, image) {
  if (!art || !image || npReducedMotion()) return;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 24; canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(image, 0, 0, 24, 24);
    const data = ctx.getImageData(0, 0, 24, 24).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const rr = data[i], gg = data[i + 1], bb = data[i + 2];
      const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
      if (max < 70 || max - min < 12) continue;
      r += rr; g += gg; b += bb; n++;
    }
    if (!n) return;
    if (window.RH_SETTINGS && !window.RH_SETTINGS.get('dynamicCover')) return;
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    // Keep the cinematic palette inside RH-MUSIC's cool range.
    const boost = (v) => Math.max(64, Math.min(235, Math.round(v * 1.35)));
    art.style.setProperty('--np-glow-rgb', `${boost(r)}, ${boost(g)}, ${boost(b)}`);
    art.style.setProperty('--np-glow2-rgb', `${Math.min(255, boost(b) + 24)}, ${Math.max(40, boost(g) - 18)}, ${Math.min(255, boost(r) + 30)}`);
  } catch (_) { /* canvas can be tainted by a cross-origin cover; keep default palette */ }
}

function startNpCinema(track) {
  const art = $('npArt');
  if (!art || npReducedMotion()) return;
  art.classList.remove('is-cinema', 'is-burst');
  document.querySelectorAll('.np-cover-layer').forEach((img) => img.classList.remove('is-cinema-in'));
  art.style.removeProperty('--np-glow-rgb');
  art.style.removeProperty('--np-glow2-rgb');
  void art.offsetWidth;
  art.classList.add('is-cinema');
}

function animateNpText(track) {
  // Data is authoritative: apply it before any reveal animation starts.
  applyNpText(track);
  const info = document.querySelector('.np-info');
  if (!info || npReducedMotion()) { info?.classList.remove('is-changing', 'is-cinema-text'); return; }
  const token = ++npTextToken;
  info.classList.remove('is-changing', 'is-cinema-text');
  void info.offsetWidth;
  info.classList.add('is-cinema-text');
  if (npTextTimer) clearTimeout(npTextTimer);
  npTextTimer = setTimeout(() => {
    npTextTimer = 0;
    if (token === npTextToken) info.classList.remove('is-cinema-text');
  }, 2400);
}

function animateNpCover(track) {
  const first = $('npBigCover');
  const second = $('npBigCoverNext');
  if (!first || !second) return;
  const token = ++npCoverToken;
  const current = first.classList.contains('is-active') ? first : second.classList.contains('is-active') ? second : null;

  const showFallback = () => {
    first.classList.remove('is-active', 'is-leaving', 'is-cinema-in');
    second.classList.remove('is-active', 'is-leaving', 'is-cinema-in');
    first.removeAttribute('src');
    second.removeAttribute('src');
    triggerNpBurst($('npArt'));
  };

  if (!track || !track.cover) { showFallback(); return; }

  const url = pic(track.cover, 640);
  const target = current === first ? second : first;
  if (current && current.getAttribute('src') === url && current.complete) return;

  // Switch metadata/cover immediately. If the image is not decoded yet, the
  // existing fallback stays visible instead of leaving the previous cover
  // under the new track title.
  target.classList.remove('is-leaving', 'is-cinema-in');
  target.src = url;
  target.classList.add('is-active', 'is-cinema-in');
  target.setAttribute('aria-hidden', 'false');
  if (current) {
    current.classList.remove('is-active', 'is-cinema-in');
    current.classList.add('is-leaving');
    current.setAttribute('aria-hidden', 'true');
    setTimeout(() => { if (token === npCoverToken) current.classList.remove('is-leaving'); }, 1200);
  }
  triggerNpBurst($('npArt'));

  const onReady = () => {
    if (token !== npCoverToken) return;
    try { setNpPalette($('npArt'), target); } catch (_) {}
  };
  if (target.complete && target.naturalWidth > 0) onReady();
  else {
    target.onload = onReady;
    target.onerror = () => { if (token === npCoverToken) showFallback(); };
  }
}

function updateNowPlayingMeta(track) {
  const sameTrack = !!track && String(track.id) === String(npLastTrackId);
  npLastTrackId = track ? String(track.id) : '';
  if (!sameTrack) startNpCinema(track);
  if (sameTrack) applyNpText(track); else animateNpText(track);
  animateNpCover(track);

  const mini = $('npCover');
  if (mini) {
    mini.classList.remove('is-loaded');
    mini.removeAttribute('src');
    if (track && track.cover) {
      mini.onload = () => mini.classList.add('is-loaded');
      mini.src = pic(track.cover, 160);
    }
  }
  updateAmbient(track ? track.cover : null);
  $('npDur').textContent = fmt(track ? track.duration : 0);
  $('npCur').textContent = '0:00';
  syncSeek(0, 0);
  updateNpLike();
  renderCompactTrack(track);

  if ('mediaSession' in navigator && track && (!window.RH_SETTINGS || window.RH_SETTINGS.get('mediaSession'))) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        artwork: track.cover ? [
          { src: pic(track.cover, 512), sizes: '512x512', type: 'image/jpeg' },
        ] : [],
      });
    } catch { /* ignore */ }
  }
}

function updateNpLike() {
  const saved = !!(S.current && S.libraryIds.has(String(S.current.id)));
  const button = $('npLike');
  if (button) {
    button.innerHTML = saved ? ICONS.heartFilled : ICONS.heart;
    button.setAttribute('aria-label', saved ? 'Убрать из библиотеки' : 'Сохранить в библиотеку');
    button.classList.toggle('is-on', saved);
  }
  const playerLike = $('playerLike');
  if (playerLike) {
    playerLike.classList.toggle('is-on', saved);
    playerLike.disabled = !S.current;
    playerLike.setAttribute('aria-label', saved ? 'Убрать из библиотеки' : 'Сохранить в библиотеку');
  }
  const qpLike = $('qpLike');
  if (qpLike) qpLike.textContent = saved ? 'В моей музыке' : 'В библиотеку';
}

function syncSeek(current, duration) {
  const percent = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  ['seekMini', 'seekBig'].forEach((id) => {
    const el = $(id);
    if (!el || S.seeking) return;
    el.value = String(Math.round(percent * 10));
    el.style.setProperty('--fill', percent + '%');
  });
  $('npCur').textContent = fmt(current);
  if (duration > 0) $('playerTime').textContent = `${fmt(current)} / ${fmt(duration)}`;
}

async function updateAmbient(coverUrl) {
  if (!coverUrl) return;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = pic(coverUrl, 64);
    await (img.decode ? img.decode() : new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; }));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 20;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 20, 20);
    const { data } = ctx.getImageData(0, 0, 20, 20);
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    if (!n) return;
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    document.documentElement.style.setProperty('--ambient-1', `rgba(${r}, ${g}, ${b}, 0.42)`);
    document.documentElement.style.setProperty('--ambient-2', `rgba(${Math.round(b * 0.9 + 40)}, ${Math.round(r * 0.7 + 30)}, ${Math.min(255, Math.round(g * 0.8 + 90))}, 0.32)`);
  } catch { /* остаются базовые свечения */ }
}

function playIndex(index, { autoplay = true, source = 'player', reveal = true } = {}) {
  if (index < 0 || index >= S.queue.length) return;
  smartMixAdoptionToken += 1;
  flushPlayback(true);
  S.index = index;
  const track = S.queue[index];
  S.current = track;
  S.retried = false;
  S.scFallbackTried = false;
  // Раскрываем нижний плеер только при осознанном выборе трека,
  // а не при возобновлении из компактного блока или Media Session.
  if (reveal) S.playerHidden = false;

  updateNowPlayingMeta(track);
  syncLyricsTrack(track);
  renderQueue();
  markCurrentRow();
  S.loading = true;
  updateTransport();

  if (window.RH_AI_AUTOMIX && window.RH_AI_AUTOMIX.ownsPlayback && window.RH_AI_AUTOMIX.ownsPlayback()) {
    window.RH_AI_AUTOMIX.releaseToStandard(false);
  }

  // Продолжение с места, где остановились после перезагрузки страницы.
  // Только для того же трека: иначе новая песня начиналась бы с чужой секунды.
  if (S.restorePosition > 0 && S.restoreTrackId && String(track.id) === String(S.restoreTrackId)) {
    const target = S.restorePosition;
    S.restorePosition = 0;
    S.restoreTrackId = null;
    const resume = () => {
      try {
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        audio.currentTime = duration > 1 ? Math.min(target, duration - 0.5) : target;
      } catch { /* ignore */ }
      audio.removeEventListener('loadedmetadata', resume);
    };
    audio.addEventListener('loadedmetadata', resume);
  } else if (S.restorePosition > 0) {
    S.restorePosition = 0;
    S.restoreTrackId = null;
  }

  const autoplayError = (error) => {
    S.loading = false;
    updateTransport();
    if (error && error.name === 'NotAllowedError') toast('Нажмите Play, чтобы разрешить воспроизведение', 'info');
    else if (error && error.name !== 'AbortError') handleAudioFailure(error.message);
  };
  applyAudioSource(track, { autoplay, onError: autoplayError });
  if (window.RH_SMARTMIX) {
    if (isSoundCloudTrack(track)) {
      try { if (window.RH_SMARTMIX.getSettings().enabled) window.RH_SMARTMIX.setSettings({ enabled: false }); } catch (_) {}
    } else {
      window.RH_SMARTMIX.onTrack();
    }
  }
  startPlaybackSession(track, source);
  savePlayerState(0);
  if (window.RH_AI_AUTOMIX && window.RH_AI_AUTOMIX.isActive() && !isSoundCloudTrack(track)) window.RH_AI_AUTOMIX.onTrackStarted(track);
  if (isSoundCloudTrack(track) && window.RH_AI_AUTOMIX && window.RH_AI_AUTOMIX.isActive()) window.RH_AI_AUTOMIX.disable();
  refreshAiAutoMixUI();
}

async function playSoundCloudFallback(track) {
  if (!track || !isSoundCloudTrack(track)) return false;
  if (S.scFallbackTried) return false;
  S.scFallbackTried = true;
  S.loading = true;
  updateTransport();
  try {
    // Safari иногда не открывает fMP4-HLS напрямую. Собираем init + сегменты
    // в один MP4-blob и отдаём его тому же <audio>.
    const response = await fetch(API + '/api/sc/audio/' + encodeURIComponent(soundCloudMediaId(track)), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('sc_audio_' + response.status);
    const bytes = await response.arrayBuffer();
    if (!bytes || !bytes.byteLength) throw new Error('empty_stream');
    if (activeScBlobUrl) { try { URL.revokeObjectURL(activeScBlobUrl); } catch { /* ignore */ } }
    activeScBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mp4' }));
    audio.src = activeScBlobUrl;
    audio.load();
    // На iOS после асинхронной загрузки play() может требовать ещё один тап.
    try { await audio.play(); } catch { /* пользователь нажмёт Play */ }
    S.loading = false;
    S.playing = !audio.paused;
    updateTransport();
    return true;
  } catch (error) {
    S.loading = false;
    updateTransport();
    return false;
  }
}

function handleAudioFailure(detail) {
  if (!S.current) return;
  if (isSoundCloudTrack(S.current) && !S.scFallbackTried) {
    playSoundCloudFallback(S.current).then((ok) => {
      if (!ok) toast('Не удалось воспроизвести трек. Попробуйте другой.');
    });
    return;
  }
  if (!S.retried) {
    // Повтор через тот же прокси с обходом кэша: подписанная ссылка запрашивается заново.
    S.retried = true;
    applyAudioSource(S.current, {
      autoplay: true,
      onError: () => {
        S.loading = false;
        updateTransport();
        toast('Не удалось воспроизвести трек. Попробуйте другой.');
      },
    });
    return;
  }
  S.loading = false;
  S.playing = false;
  updateTransport();
  toast('Не удалось воспроизвести трек. Попробуйте другой.');
}

function togglePlay() {
  if (window.RH_AI_AUTOMIX && window.RH_AI_AUTOMIX.ownsPlayback && window.RH_AI_AUTOMIX.ownsPlayback()) {
    const state = window.RH_AI_AUTOMIX.getState();
    if (state.phase === 'MIXING') return;
    if (S.playing) {
      window.RH_AI_AUTOMIX.pause();
      S.playing = false;
    } else {
      window.RH_AI_AUTOMIX.resume();
      S.playing = true;
    }
    updateTransport();
    return;
  }
  if (!S.current) return;
  if (!audio.src) return playIndex(S.index >= 0 ? S.index : 0, { reveal: false });
  if (window.RH_SMARTMIX && window.RH_SMARTMIX.isPlaying && window.RH_SMARTMIX.isPlaying()) {
    // Пользовательская пауза важнее внутреннего состояния handoff/fallback:
    // сначала останавливаем переход и mix, затем основной элемент.
    window.RH_SMARTMIX.cancel('pause');
    try { audio.pause(); } catch { /* ignore */ }
    S.loading = false;
    S.playing = false;
    updateTransport();
    markCurrentRow();
    return;
  }
  if (audio.paused) {
    S.loading = true;
    updateTransport();
    audio.play().catch((error) => {
      S.loading = false;
      updateTransport();
      if (error.name !== 'AbortError') handleAudioFailure(error.message);
    });
  } else {
    if (window.RH_SMARTMIX) window.RH_SMARTMIX.cancel('pause');
    audio.pause();
    S.loading = false;
    S.playing = false;
    updateTransport();
    markCurrentRow();
  }
}

function nextTrack(auto = false) {
  if (!S.queue.length) return;
  if (window.RH_SMARTMIX) window.RH_SMARTMIX.cancel('next');
  if (auto && S.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  const next = S.index + 1;
  if (next >= S.queue.length) {
    if (auto && S.repeat === 'off') { S.playing = false; updateTransport(); return; }
    return playIndex(0, { reveal: false });
  }
  playIndex(next, { reveal: false });
}

function prevTrack() {
  if (!S.queue.length) return;
  if (window.RH_SMARTMIX) window.RH_SMARTMIX.cancel('prev');
  if (audio.currentTime > 4) { audio.currentTime = 0; return; }
  playIndex(S.index <= 0 ? S.queue.length - 1 : S.index - 1, { reveal: false });
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
  if (window.RH_SMARTMIX) window.RH_SMARTMIX.onQueue();
  renderQueue();
  updateTransport();
  savePreferences();
}

function cycleRepeat() {
  S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
  updateTransport();
  savePreferences();
  toast(S.repeat === 'off' ? 'Повтор выключен' : S.repeat === 'all' ? 'Повтор очереди' : 'Повтор трека', 'info');
}

const savePreferences = debounce(() => {
  if (!S.user) return;
  api('/api/me/preferences', { method: 'PATCH', body: { repeat: S.repeat, shuffle: S.shuffle } }).catch(() => {});
}, 800);

/* ───────────────────────────── история прослушивания ───────────────────────────── */

function startPlaybackSession(track, source) {
  S.playback = { historyId: null, trackId: String(track.id), pending: 0, lastTick: audio.currentTime, completed: false, source };
  if (!S.user) return;
  if (window.RH_SETTINGS && !window.RH_SETTINGS.get('saveHistory')) { S.playback.historyId = null; return; }
  api('/api/history', { method: 'POST', body: { track, source } })
    .then((data) => { if (S.playback.trackId === String(track.id)) S.playback.historyId = data.id; })
    .catch(() => {});
}

function flushPlayback(force = false, completed = false) {
  const session = S.playback;
  if (!S.user || !session.historyId) return;
  const listened = Math.round(session.pending);
  if (!force && listened < 20) return;
  if (listened <= 0 && !completed) return;
  session.pending = 0;
  if (completed) session.completed = true;
  api('/api/history/' + session.historyId, {
    method: 'PATCH',
    body: { listenedSeconds: listened, completed: session.completed || completed },
    keepalive: true,
  }).catch(() => {});
}

/* ───────────────────────────── очередь ───────────────────────────── */

function renderQueue() {
  const body = $('drawerBody');
  const npList = $('npQueueList');
  const sub = $('drawerSub');
  if (sub) sub.textContent = S.queue.length ? `${S.queue.length} треков${S.shuffle ? ' · перемешано' : ''}` : 'Очередь пуста';
  if (!S.queue.length) {
    if (body) body.innerHTML = S.drawerOpen ? emptyState('Очередь пуста', 'Включите трек — очередь заполнится автоматически.') : '';
    if (npList) npList.innerHTML = '';
    return;
  }
  S.lists.queue = S.queue;
  const html = `<div class="track-list">${S.queue.map((t, i) => trackRow(t, i, 'queue', i + 1)).join('')}</div>`;
  if (body) body.innerHTML = S.drawerOpen ? html : '';
  if (npList) npList.innerHTML = S.npOpen ? `<div class="section-title" style="margin:8px 0 6px">Очередь · ${S.queue.length}</div>${html}` : '';
  renderQueuePanel();
}

/* ───────────────────────────── правая панель очереди ───────────────────────────── */

function renderQueuePanel() {
  const list = $('qpList');
  if (!list) return;
  const track = S.current;
  const title = $('qpTitle');
  const artist = $('qpArtist');
  if (title) title.textContent = track ? track.title : 'Ничего не играет';
  if (artist) artist.textContent = track ? (track.artist || 'Неизвестный исполнитель') : 'Выберите трек';

  const cover = $('qpCover');
  if (cover) {
    if (track && track.cover) { cover.src = pic(track.cover, 400); cover.hidden = false; }
    else { cover.removeAttribute('src'); cover.hidden = true; }
  }
  const count = $('qpCount');
  if (count) count.textContent = String(S.queue.length);

  if (!S.queue.length) {
    list.innerHTML = '<div class="recent-sub" style="padding:8px 8px 0">Очередь пуста</div>';
    return;
  }
  S.lists.queue = S.queue;
  list.innerHTML = S.queue.map((t, i) => {
    const isCurrent = track && String(track.id) === String(t.id);
    return `
      <button class="queue-panel-row${isCurrent ? ' is-current' : ''}" type="button"
              data-action="play" data-list="queue" data-index="${i}">
        <span class="qp-cover">
          ${t.cover ? `<img src="${esc(pic(t.cover, 120))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        </span>
        <span class="qp-meta">
          <span class="qp-name">${esc(t.title)}</span>
          <span class="qp-artist">${esc(t.artist || '')}</span>
        </span>
        <span class="qp-index">${isCurrent ? '♪' : i + 1}</span>
      </button>`;
  }).join('');
}

/**
 * Текущая интерфейсная среда. Определяется один раз по признакам устройства
 * (web/device.js) и не зависит от ширины окна: телефон в ландшафте и планшет
 * остаются в Mobile UI.
 */
function isDesktop() {
  if (window.RH_UI && typeof window.RH_UI.isDesktop === 'function') return window.RH_UI.isDesktop();
  const attr = document.documentElement.dataset.ui;
  if (attr) return attr === 'desktop';
  // device.js не загрузился — ведём себя как прежняя адаптивная версия,
  // чтобы на широком экране десктопный интерфейс не пропадал.
  return !!(window.matchMedia && window.matchMedia('(min-width: 1024px)').matches);
}

function currentUi() {
  return document.documentElement.dataset.ui === 'mobile' ? 'mobile' : 'desktop';
}

/**
 * Единственная точка управления правой панелью.
 * Видимость задаётся классом body.queue-open (CSS), атрибут hidden дублирует
 * состояние для доступности. Никакой другой код не имеет права открывать
 * панель — она не появляется сама при воспроизведении, паузе, смене трека
 * или переходе между разделами.
 */
function openQueuePanel(open = true) {
  S.queueOpen = !!open;
  const panel = $('queuePanel');
  if (panel) panel.hidden = !S.queueOpen;
  const toggle = $('queueToggle');
  if (toggle) toggle.setAttribute('aria-pressed', S.queueOpen ? 'true' : 'false');
  document.body.classList.toggle('queue-open', S.queueOpen);
  if (S.queueOpen) {
    setQueueTab(S.queueTab);
    renderQueuePanel();
  }
  setLyricsPressed();
  syncLayoutHeight();
}

/**
 * Вкладка правой панели: «Очередь» или «Текст».
 * Вкладка — часть существующей панели: сама очередь не удаляется и не
 * заменяется, меняется только видимая часть на десктопе.
 */
function setQueueTab(tab = 'queue') {
  const next = tab === 'lyrics' ? 'lyrics' : 'queue';
  S.queueTab = next;
  const panel = $('queuePanel');
  if (panel) panel.classList.toggle('is-lyrics', next === 'lyrics');
  const pane = $('lyricsPane');
  if (pane) pane.hidden = next !== 'lyrics';
  const queueTab = $('qpTabQueue');
  const lyricsTab = $('qpTabLyrics');
  if (queueTab) {
    queueTab.classList.toggle('is-active', next === 'queue');
    queueTab.setAttribute('aria-selected', next === 'queue' ? 'true' : 'false');
  }
  if (lyricsTab) {
    lyricsTab.classList.toggle('is-active', next === 'lyrics');
    lyricsTab.setAttribute('aria-selected', next === 'lyrics' ? 'true' : 'false');
  }
  setLyricsPressed();
  if (next === 'lyrics' && window.RH_LYRICS) {
    window.RH_LYRICS.ensure();
    requestAnimationFrame(() => window.RH_LYRICS.refresh());
  }
}

function setLyricsPressed() {
  const button = $('playerLyrics');
  if (button) {
    const active = isDesktop()
      ? (S.queueOpen && S.queueTab === 'lyrics')
      : S.lyricsOpen;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.classList.toggle('is-on', active);
  }
  const chip = $('npLyrics');
  if (chip) chip.classList.toggle('is-on', S.lyricsOpen);
}

/* Свайп вниз по шапке слоя текста закрывает его; содержимое прокручивается
   свободно, поэтому жест живёт только на шапке и не конфликтует со скроллом. */
let lyricsDrag = null;
bindDragToClose($('nowPlaying'), $('nowPlaying').querySelector('.np-top'), () => openNowPlaying(false));
bindDragToClose($('queuePanel'), $('queuePanel').querySelector('.queue-panel-head'), () => openQueuePanel(false));
bindDragToClose($('drawer'), $('drawer').querySelector('.drawer-head'), () => openDrawer(false));

const lyricsSheetEl = $('lyricsSheet');
if (lyricsSheetEl) {
  const head = lyricsSheetEl.querySelector('.lyrics-sheet-head');
  head.addEventListener('pointerdown', (event) => {
    if (!S.lyricsOpen || event.button > 0) return;
    lyricsDrag = { id: event.pointerId, y: event.clientY, dy: 0 };
    lyricsSheetEl.classList.add('is-dragging');
    try { head.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  });
  head.addEventListener('pointermove', (event) => {
    if (!lyricsDrag || event.pointerId !== lyricsDrag.id) return;
    const dy = Math.max(0, event.clientY - lyricsDrag.y);
    lyricsDrag.dy = dy;
    lyricsSheetEl.style.transform = dy ? `translateY(${dy}px)` : '';
  }, { passive: true });
  const endLyricsDrag = (event) => {
    if (!lyricsDrag || event.pointerId !== lyricsDrag.id) return;
    const dy = lyricsDrag.dy;
    lyricsDrag = null;
    lyricsSheetEl.classList.remove('is-dragging');
    lyricsSheetEl.style.transform = '';
    if (dy > 90) openLyricsSheet(false);
  };
  head.addEventListener('pointerup', endLyricsDrag);
  head.addEventListener('pointercancel', endLyricsDrag);
}

/** Единая точка открытия текста: на десктопе — вкладка панели, на телефоне — слой. */
function toggleLyrics() {
  if (isDesktop()) {
    if (S.queueOpen && S.queueTab === 'lyrics') { openQueuePanel(false); return; }
    openQueuePanel(true);
    setQueueTab('lyrics');
    return;
  }
  openLyricsSheet(!S.lyricsOpen);
}

function openLyricsSheet(open = true) {
  S.lyricsOpen = !!open;
  const section = $('lyricsSheet');
  if (section) {
    section.classList.toggle('is-open', open);
    section.setAttribute('aria-hidden', open ? 'false' : 'true');
    section.style.transform = '';
    section.classList.remove('is-dragging');
  }
  document.body.classList.toggle('lyrics-open', S.lyricsOpen);
  setLyricsPressed();
  if (S.lyricsOpen && window.RH_LYRICS) {
    window.RH_LYRICS.ensure();
    requestAnimationFrame(() => window.RH_LYRICS.refresh());
  }
}

function closeQueuePanel() {
  if (S.queueOpen) openQueuePanel(false);
}

function toggleQueue(force) {
  if (isDesktop()) {
    const open = force === undefined ? !S.queueOpen : force;
    // Кнопка очереди всегда показывает очередь, даже если панель осталась
    // на вкладке «Текст» с прошлого раза.
    if (open) S.queueTab = 'queue';
    openQueuePanel(open);
    return;
  }
  // На телефоне та же кнопка управляет очередью в шторке.
  closeQueuePanel();
  openDrawer(force === undefined ? !S.drawerOpen : force);
}

function openNowPlaying(open = true) {
  S.npOpen = open;
  nowPlaying.classList.toggle('is-open', open);
  nowPlaying.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open && S.current) {
    // Ширина заголовка появляется только после раскрытия оверлея.
    requestAnimationFrame(() => { applyNpTitle(S.current); applyNpSong(S.current); });
  }
  if (open) { scrim.hidden = false; requestAnimationFrame(() => scrim.classList.add('is-open')); }
  else if (!S.drawerOpen && !S.sheetOpen) hideScrim();
  document.body.classList.toggle('is-locked', open || S.drawerOpen || S.sheetOpen);
  // Safari/WebKit иногда рисует полосы с backdrop-filter выше полноэкранного плеера —
  // на время показа «Сейчас играет» убираем мини-плеер и таббар из отрисовки.
  document.body.classList.toggle('np-open', open);
  renderQueue();
}

function openDrawer(open = true) {
  S.drawerOpen = open;
  drawer.classList.toggle('is-open', open);
  drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open) { scrim.hidden = false; requestAnimationFrame(() => scrim.classList.add('is-open')); }
  else if (!S.npOpen && !S.sheetOpen) hideScrim();
  document.body.classList.toggle('is-locked', open || S.npOpen || S.sheetOpen);
  renderQueue();
}

/* ───────────────────────────── «Моя волна» ───────────────────────────── */

window.RH_WAVE_BRIDGE = {
  play(items, settings) {
    const clean = [];
    const seen = new Set();
    for (const item of items || []) {
      if (!item || !item.id || !item.title || !item.artist) continue;
      const id = String(item.id);
      if (seen.has(id)) continue;
      seen.add(id);
      clean.push(item);
    }
    if (!clean.length) throw new Error('Волна не вернула треки.');
    S.queue = clean;
    S.index = 0;
    S.playerHidden = false;
    if (window.RH_WAVE) { window.RH_WAVE.settings = { ...window.RH_WAVE.settings, ...(settings || {}) }; }
    playIndex(0, { source: 'wave', reveal: false });
  },
  append(items) {
    let added = 0;
    for (const item of items || []) {
      if (!item || !item.id || !item.title || !item.artist) continue;
      if (S.queue.some((row) => String(row.id) === String(item.id))) continue;
      S.queue.push(item);
      added += 1;
    }
    if (added) renderQueue();
    return added;
  },
  getState() {
    return {
      currentId: S.current ? String(S.current.id) : null,
      index: S.index,
      queue: (S.queue || []).map((item) => ({ id: item.id, title: item.title, artist: item.artist })),
      playing: !audio.paused,
      currentTime: audio.currentTime || 0,
      duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (S.current ? Number(S.current.duration) || 0 : 0),
      currentArtist: S.current ? S.current.artist : '',
      currentTitle: S.current ? S.current.title : '',
    };
  },
  toast: (message, kind) => toast(message, kind || 'info'),
  likeCurrent: () => { const button = document.getElementById('npLike'); if (button) button.click(); },
  next: () => nextTrack(false),
};

/* ───────────────────────────── роутер ───────────────────────────── */

function go(hash) {
  const target = hash.startsWith('#') ? hash : '#' + hash;
  if (location.hash === target) route();
  else location.hash = target;
}

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const path = hash.split('?')[0];
  let m;
  // При входе и переходах всегда показываем начало страницы. Иначе iOS
  // восстанавливает старую прокрутку (например, на «Топ 100» с BEARWOLF).
  try {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  } catch { /* ignore */ }
  // Смена вкладки должна закрывать клавиатуру: иначе iOS оставляет её открытой
  // и поднимает нижнюю панель вкладок на всех следующих экранах.
  const activeEl = document.activeElement;
  if (activeEl && typeof activeEl.blur === 'function'
      && activeEl.matches && activeEl.matches('input, textarea, select, [contenteditable="true"]')) {
    activeEl.blur();
  }
  window.scrollTo(0, 0);

  document.body.classList.toggle('auth-route', path === '/login' || path === '/register');
  // Все полноэкранные слои закрываются при смене маршрута: иначе текст песни,
  // очередь или Now Playing могут остаться поверх новой страницы.
  if (S.lyricsOpen) openLyricsSheet(false);
  if (S.sheetOpen) sheetClose();
  if (S.drawerOpen) openDrawer(false);
  if (S.npOpen) openNowPlaying(false);
  if (S.queueOpen) closeQueuePanel();

  updateSectionTitle(path);

  if (path === '/' || path === '/home') return renderShowcase();
  if (path === '/for-you') return renderRecommendations();
  if ((m = path.match(/^\/catalog\/playlist\/(\d+)$/))) return renderCatalogPlaylist(m[1]);
  if (path === '/search') return renderSearch();
  if (path === '/library') return renderLibrary();
  if (path === '/favorites') return renderLibrary({ route: 'favorites', nav: 'favorites', title: 'Любимые треки', heading: 'Любимые треки', sub: 'Треки, которые вы сохранили в «Мою музыку»' });
  if (path === '/albums') return renderAlbums();
  if (path === '/artists') return renderArtists();
  if (path === '/playlists') return renderPlaylists();
  if ((m = path.match(/^\/playlist\/(\d+)$/))) return renderPlaylist(m[1]);
  if (path === '/history' || path === '/recent') return renderRecent('history');
  if (path === '/login') return renderLogin();
  if (path === '/register') return renderRegister();
  if (path === '/settings' || path.startsWith('/settings/')) {
    if (window.RH_SETTINGS) return window.RH_SETTINGS.render(path);
  }
  if (path === '/settings') return renderAccount({ settings: true });
  if (path === '/account') return renderAccount();
  if ((m = path.match(/^\/artist\/(\d+)$/))) return renderArtist(m[1]);
  if ((m = path.match(/^\/album\/(\d+)$/))) return renderAlbum(m[1]);
  return renderShowcase();
}

/* ───────────────────────────── события ───────────────────────────── */

window.addEventListener('rh-toast', (event) => {
  const detail = event && event.detail ? event.detail : {};
  if (detail.message) toast(detail.message, detail.kind || 'info');
});

document.addEventListener('input', (event) => {
  const band = event.target.closest && event.target.closest('[data-action="equalizer-band"]');
  if (!band || !window.RH_EQUALIZER) return;
  window.RH_EQUALIZER.setBand(Number(band.dataset.band), band.value);
});

document.addEventListener('click', async (event) => {
  const closeSheetTarget = event.target.closest('[data-close-sheet], [data-sheet-close]');
  if (closeSheetTarget) { sheetClose(); return; }

  const link = event.target.closest('[data-link]');
  if (link) {
    if (S.sheetOpen) sheetClose();
    return; // навигация по href
  }

  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  if (action === 'play') {
    const list = S.lists[target.dataset.list];
    const index = Number(target.dataset.index);
    const track = list && list[index];
    if (!track) return;
    const same = S.current && String(S.current.id) === String(track.id);
    if (same && !audio.paused) { audio.pause(); return; }
    if (same && audio.paused && audio.src) { togglePlay(); return; }
    setQueue(list, index);
    playIndex(index, { source: S.route === 'playlist' ? 'playlist' : S.route });
    return;
  }

  if (action === 'play-all' || action === 'shuffle-list') {
    const list = S.lists[target.dataset.list];
    if (!list || !list.length) return;
    setQueue(list, 0);
    if (action === 'shuffle-list') { S.shuffle = true; toggleShuffle(); }
    playIndex(0);
    return;
  }

  if (action === 'shuffle-all-library') {
    api('/api/library?limit=200&sort=recent')
      .then((data) => {
        const tracks = data.items || [];
        if (!tracks.length) throw new Error('В библиотеке пока нет треков');
        S.lists.libraryShuffle = tracks;
        setQueue(tracks, 0);
        if (!S.shuffle) toggleShuffle();
        playIndex(0);
      })
      .catch((error) => toast(error.message));
    return;
  }

  if (action === 'queue-toggle') { toggleQueue(); return; }
  if (action === 'queue-close') { openQueuePanel(false); return; }
  if (action === 'focus-search') {
    if (isDesktop()) { const input = $('q'); if (input) { input.focus(); input.select(); } }
    else location.hash = '#/search';
    return;
  }
  if (action === 'ai-automix-toggle') {
    if (isSoundCloudTrack(S.current)) return;
    if (window.RH_AI_AUTOMIX) window.RH_AI_AUTOMIX.toggle();
    refreshAiAutoMixUI();
    return;
  }
  if (action === 'equalizer-open') { openEqualizerSheet(); return; }
  if (action === 'equalizer-toggle') { if (window.RH_EQUALIZER) window.RH_EQUALIZER.toggle(); refreshEqualizerUI(); return; }
  if (action === 'equalizer-preset') { if (window.RH_EQUALIZER) window.RH_EQUALIZER.setPreset(target.dataset.preset); refreshEqualizerUI(); return; }
  if (action === 'lyrics-toggle') { toggleLyrics(); return; }
  if (action === 'lyrics-beta-toggle') {
    if (window.RH_LYRICS_BETA) window.RH_LYRICS_BETA.toggle();
    return;
  }

  if (action === 'lyrics-open') {
    if (isDesktop()) toggleLyrics();
    else openLyricsSheet(true);
    return;
  }
  if (action === 'lyrics-close') { openLyricsSheet(false); return; }
  if (action === 'drawer-close') { openDrawer(false); return; }

  if (action === 'reload-home') { S.home = null; renderShowcase(); return; }

  if (action === 'genre') {
    go('/search?q=' + encodeURIComponent(target.dataset.query || '') + '&type=all');
    return;
  }

  if (action === 'play-catalog-playlist') {
    event.preventDefault();
    event.stopPropagation();
    const id = target.dataset.id;
    api('/api/playlist/' + encodeURIComponent(id))
      .then((data) => {
        if (!data.tracks || !data.tracks.length) throw new Error('В плейлисте нет доступных треков');
        S.lists.catalogQuick = data.tracks;
        setQueue(data.tracks, 0);
        playIndex(0, { source: 'playlist' });
      })
      .catch((error) => toast(error.message));
    return;
  }

  if (action === 'link-google') {
    openGoogleLinkSheet();
    return;
  }

  if (action === 'unlink-provider') {
    openUnlinkSheet(target.dataset.provider);
    return;
  }

  if (action === 'play-album') {
    event.preventDefault();
    const id = target.dataset.id;
    api('/api/album/' + encodeURIComponent(id))
      .then((data) => {
        if (!data.tracks || !data.tracks.length) throw new Error('В альбоме нет доступных треков');
        S.lists.albumQuick = data.tracks;
        setQueue(data.tracks, 0);
        playIndex(0);
      })
      .catch((error) => toast(error.message));
    return;
  }

  if (action === 'toggle-save') {
    const list = S.lists[target.dataset.list];
    const index = Number(target.dataset.index);
    if (list && list[index]) toggleSave(list[index]);
    return;
  }

  if (action === 'track-menu') {
    const list = S.lists[target.dataset.list];
    const index = Number(target.dataset.index);
    if (list && list[index]) openTrackMenu(list[index]);
    return;
  }

  if (action === 'quick') {
    go('/search?q=' + encodeURIComponent(target.dataset.query) + '&type=all');
    return;
  }

  if (action === 'set-type') {
    const type = target.dataset.type;
    if (S.query) go('/search?q=' + encodeURIComponent(S.query) + '&type=' + type);
    else { S.type = type; renderSearch(); }
    return;
  }

  if (action === 'more') { loadMoreResults(); return; }

  if (action === 'lib-sort') {
    page.querySelectorAll('[data-action="lib-sort"]').forEach((el) => el.classList.toggle('is-active', el === target));
    loadLibrary($('libSearch') ? $('libSearch').value.trim() : '', target.dataset.sort);
    return;
  }

  if (action === 'back') {
    if (history.length > 1) history.back();
    else go('/home');
    return;
  }

  if (action === 'sheet-close') { sheetClose(); return; }

  if (action === 'sheet-play') {
    if (S.sheetTrack) { setQueue([S.sheetTrack], 0); playIndex(0, { source: 'sheet' }); }
    sheetClose();
    return;
  }

  if (action === 'sheet-toggle-save') {
    const track = S.sheetTrack;
    sheetClose();
    if (track) toggleSave(track);
    return;
  }

  if (action === 'sheet-add-playlist') {
    const track = S.sheetTrack;
    if (track) openPlaylistPicker(track);
    return;
  }

  if (action === 'sheet-add-to') {
    const track = S.sheetTrack;
    const playlistId = target.dataset.playlist;
    if (!track) return;
    api('/api/playlists/' + encodeURIComponent(playlistId) + '/tracks', { method: 'POST', body: { track } })
      .then((data) => {
        toast(data.duplicate ? 'Трек уже в этом плейлисте' : 'Добавлено в плейлист', data.duplicate ? 'info' : 'ok');
        refreshPlaylists();
        sheetClose();
      })
      .catch((error) => toast(error.message));
    return;
  }

  if (action === 'create-playlist') {
    openCreatePlaylist(target.dataset.withTrack === '1');
    return;
  }

  if (action === 'playlist-menu') {
    openPlaylistMenu(target.dataset.id);
    return;
  }

  if (action === 'playlist-rename') {
    const playlist = S.sheetPlaylist;
    openPrompt({
      title: 'Переименовать',
      label: 'Новое название',
      value: playlist.title,
      onConfirm: async (value) => {
        await api('/api/playlists/' + playlist.id, { method: 'PATCH', body: { title: value } });
        sheetClose();
        await refreshPlaylists();
        toast('Название обновлено', 'ok');
        if (S.route === 'playlist') renderPlaylist(playlist.id); else renderPlaylistsList();
      },
    });
    return;
  }

  if (action === 'playlist-edit-desc') {
    const playlist = S.sheetPlaylist;
    openPrompt({
      title: 'Описание',
      label: 'Описание плейлиста',
      value: playlist.description || '',
      multiline: true,
      onConfirm: async (value) => {
        await api('/api/playlists/' + playlist.id, { method: 'PATCH', body: { description: value } });
        sheetClose();
        await refreshPlaylists();
        toast('Описание обновлено', 'ok');
        if (S.route === 'playlist') renderPlaylist(playlist.id); else renderPlaylistsList();
      },
    });
    return;
  }

  if (action === 'playlist-delete') {
    const playlist = S.sheetPlaylist;
    openConfirm({
      title: 'Удалить плейлист?',
      text: `«${playlist.title}» будет удалён. Треки останутся в каталоге и в вашей библиотеке.`,
      onConfirm: async () => {
        await api('/api/playlists/' + playlist.id, { method: 'DELETE' });
        sheetClose();
        await refreshPlaylists();
        toast('Плейлист удалён', 'info');
        go('/playlists');
      },
    });
    return;
  }

  if (action === 'move-up' || action === 'move-down') {
    const index = Number(target.dataset.index);
    const playlistId = location.hash.split('/').pop();
    movePlaylistTrack(playlistId, index, action === 'move-up' ? -1 : 1);
    return;
  }

  if (action === 'logout') {
    api('/api/auth/logout', { method: 'POST' })
      .then(() => { setUser(null); S.recommendations = null; toast('Вы вышли из аккаунта', 'info'); go('/home'); })
      .catch((error) => toast(error.message));
    return;
  }

  if (action === 'edit-profile') {
    const user = S.user;
    sheetOpen(`
      <h2 class="sheet-title">Профиль</h2>
      <form id="profileForm">
        <div class="field">
          <label for="pf-name">Имя в профиле</label>
          <input id="pf-name" maxlength="40" value="${esc(user.displayName || user.username)}">
        </div>
        <div class="field">
          <label for="pf-email">Email</label>
          <input id="pf-email" type="email" value="${esc(user.email)}">
        </div>
        <button class="btn btn-primary btn-block" type="submit">Сохранить</button>
      </form>`);
    $('profileForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const data = await api('/api/auth/profile', {
          method: 'PATCH',
          body: { displayName: $('pf-name').value.trim(), email: $('pf-email').value.trim() },
        });
        setUser(data.user);
        sheetClose();
        toast('Профиль обновлён', 'ok');
        renderAccount();
      } catch (error) { toast(error.message); }
    });
    return;
  }

  if (action === 'change-password') {
    sheetOpen(`
      <h2 class="sheet-title">Смена пароля</h2>
      <form id="pwForm">
        <div class="field"><label for="pw-cur">Текущий пароль</label><input id="pw-cur" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="pw-new">Новый пароль</label><input id="pw-new" type="password" autocomplete="new-password" minlength="10"><span class="hint">Минимум 10 символов, буквы и цифры</span></div>
        <button class="btn btn-primary btn-block" type="submit">Сменить пароль</button>
      </form>`);
    $('pwForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/api/auth/password', { method: 'POST', body: { currentPassword: $('pw-cur').value, newPassword: $('pw-new').value } });
        sheetClose();
        toast('Пароль изменён', 'ok');
      } catch (error) { toast(error.message); }
    });
    return;
  }

  if (action === 'delete-account') { openDeleteSheet(); return; }

  if (action === 'confirm-delete') {
    const confirm = String(($('del-confirm') || {}).value || '').trim().toUpperCase();
    const password = String(($('del-pw') || {}).value || '');
    if (confirm !== 'УДАЛИТЬ' && confirm !== 'DELETE') {
      toast('Введите слово УДАЛИТЬ для подтверждения');
      return;
    }
    try {
      await api('/api/auth/account', { method: 'DELETE', body: { confirm: 'DELETE', password } });
      sheetClose();
      setUser(null);
      S.home = null;
      S.recommendations = null;
      S.security = null;
      S.identities = null;
      S.libraryIds = new Set();
      S.playlists = [];
      S.queue = [];
      S.current = null;
      S.index = -1;
      syncLyricsTrack(null);
      S.lists = {};
      S.restorePosition = 0;
      clearPlayerState();
      updateTransport();
      try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* ignore */ }
      renderSidePlaylists();
      toast('Аккаунт и все данные удалены', 'ok');
      go('/login');
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  if (action === 'confirm-unlink') {
    const provider = target.dataset.provider;
    const password = String(($('unlink-pw') || {}).value || '');
    try {
      await api('/api/auth/identities/unlink', { method: 'POST', body: { provider, password } });
      sheetClose();
      toast('Способ входа отвязан', 'ok');
      renderAccount();
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  if (action === 'close-sheet') { sheetClose(); return; }
});

/* форма поиска в топбаре (десктоп) */
$('searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('q').value.trim();
  if (!query) return;
  go('/search?q=' + encodeURIComponent(query) + '&type=all');
});
$('q').addEventListener('input', () => {
  document.querySelector('.searchbar').classList.toggle('has-value', $('q').value.length > 0);
});
$('searchClear').addEventListener('click', () => {
  $('q').value = '';
  document.querySelector('.searchbar').classList.remove('has-value');
  $('q').focus();
});

/* кнопки плеера */
$('play').addEventListener('click', togglePlay);
$('playMini').addEventListener('click', togglePlay);
$('npPlay').addEventListener('click', togglePlay);
$('next').addEventListener('click', () => nextTrack(false));
$('npNext').addEventListener('click', () => nextTrack(false));
$('prev').addEventListener('click', prevTrack);
$('npPrev').addEventListener('click', prevTrack);
$('shuffle').addEventListener('click', toggleShuffle);
$('npShuffle').addEventListener('click', toggleShuffle);
$('npRepeat').addEventListener('click', cycleRepeat);
$('repeat').addEventListener('click', cycleRepeat);
$('npOpen').addEventListener('click', () => openNowPlaying(true));

$('npQueue').addEventListener('click', () => toggleQueue(true));
['qpTabQueue', 'qpTabLyrics'].forEach((id) => {
  const tab = $(id);
  if (tab) tab.addEventListener('click', () => setQueueTab(id === 'qpTabLyrics' ? 'lyrics' : 'queue'));
});
/* Кнопка закрытия шторки очереди обрабатывается делегированно (data-action). */
$('accountBtn').addEventListener('click', () => {
  if (S.user) go('/account');
  else go('/login');
});
$('npLike').addEventListener('click', () => { if (S.current) { toggleSave(S.current); updateNpLike(); } });
$('npAdd').addEventListener('click', () => { if (S.current) openPlaylistPicker(S.current); });

scrim.addEventListener('click', () => {
  if (S.sheetOpen) sheetClose();
  if (S.drawerOpen) openDrawer(false);
  if (S.npOpen && !S.drawerOpen) openNowPlaying(false);
});

/* поиск/плеер: клавиатура на десктопе */
document.addEventListener('keydown', (event) => {
  // Escape закрывает оверлеи всегда, в том числе когда фокус в поле ввода.
  if (event.key === 'Escape') {
    if (S.lyricsOpen) openLyricsSheet(false);
    else if (S.sheetOpen) sheetClose();
    else if (S.drawerOpen) openDrawer(false);
    else if (S.npOpen) openNowPlaying(false);
    else if (S.queueOpen) closeQueuePanel();
    return;
  }
  const tag = (event.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if ((event.key === 'l' || event.key === 'L') && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    toggleLyrics();
    return;
  }
  if (event.key === ' ' && tag !== 'button') {
    // Пробел на строке текста — переход к этой строке, а не Play/Pause.
    if (event.target.closest && event.target.closest('.lyrics-line')) return;
    event.preventDefault();
    togglePlay();
  }
});

/* ───────────────────────────── жесты ───────────────────────────── */

/* Свайп вниз по ручке bottom sheet. Только ручка — содержимое прокручивается свободно. */
let sheetDrag = null;
sheetPanel.addEventListener('pointerdown', (event) => {
  if (!S.sheetOpen || !event.target.closest('[data-sheet-grab]')) return;
  sheetDrag = { id: event.pointerId, y: event.clientY, t: performance.now(), dy: 0 };
  sheetPanel.classList.add('is-dragging');
  try { sheetPanel.setPointerCapture(event.pointerId); } catch { /* ignore */ }
});
sheetPanel.addEventListener('pointermove', (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.id) return;
  const dy = Math.max(0, event.clientY - sheetDrag.y);
  sheetDrag.dy = dy;
  sheetPanel.style.transform = dy ? `translateY(${dy}px)` : '';
}, { passive: true });
function endSheetDrag(event) {
  if (!sheetDrag || event.pointerId !== sheetDrag.id) return;
  const { dy, t, id } = sheetDrag;
  sheetDrag = null;
  sheetPanel.classList.remove('is-dragging');
  try { sheetPanel.releasePointerCapture(id); } catch { /* ignore */ }
  const velocity = dy / Math.max(1, performance.now() - t);
  if (swipeCloses(dy, velocity, 84, 0.45)) {
    sheetPanel.style.transform = 'translateY(110%)';
    setTimeout(() => {
      sheetPanel.style.transform = '';
      sheetClose();
    }, 170);
  } else {
    sheetPanel.style.transform = '';
  }
}
sheetPanel.addEventListener('pointerup', endSheetDrag);
sheetPanel.addEventListener('pointercancel', endSheetDrag);

/* Свайп вниз по мини-плееру скрывает панель, не останавливая воспроизведение. */
let playerDrag = null;
let suppressPlayerClick = false;
player.addEventListener('pointerdown', (event) => {
  if (!shouldShowPlayer()) return;
  if (event.target.closest('input, .seek, .player-hide, .player-desktop-controls, .play-mobile')) return;
  playerDrag = { id: event.pointerId, y: event.clientY, t: performance.now(), dy: 0, moved: false };
  player.classList.add('is-dragging');
  try { player.setPointerCapture(event.pointerId); } catch { /* ignore */ }
});
player.addEventListener('pointermove', (event) => {
  if (!playerDrag || event.pointerId !== playerDrag.id) return;
  const dy = Math.max(0, event.clientY - playerDrag.y);
  playerDrag.dy = dy;
  if (dy > 6) playerDrag.moved = true;
  player.style.transform = dy ? `translateY(${dy}px)` : '';
}, { passive: true });
function endPlayerDrag(event) {
  if (!playerDrag || event.pointerId !== playerDrag.id) return;
  const { dy, t, id, moved } = playerDrag;
  playerDrag = null;
  player.classList.remove('is-dragging');
  try { player.releasePointerCapture(id); } catch { /* ignore */ }
  const velocity = dy / Math.max(1, performance.now() - t);
  if (moved && swipeCloses(dy, velocity, 56, 0.45)) {
    suppressPlayerClick = true;
    player.style.transform = '';
    hidePlayer();
  } else {
    player.style.transform = '';
  }
}
player.addEventListener('pointerup', endPlayerDrag);
player.addEventListener('pointercancel', endPlayerDrag);
player.addEventListener('click', (event) => {
  if (!suppressPlayerClick) return;
  suppressPlayerClick = false;
  event.stopPropagation();
  event.preventDefault();
}, true);

$('playerHide').addEventListener('click', () => hidePlayer());
/* ── Десктопные элементы: панели, навигация, громкость ── */
const sidebarToggle = $('sidebarToggle');
if (sidebarToggle) {
  sidebarToggle.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-collapsed');
    writeJson('rh_layout_v1', { sidebarCollapsed: document.body.classList.contains('sidebar-collapsed') });
    syncLayoutHeight();
  });
}
function bindClick(id, handler) { const el = $(id); if (el) el.addEventListener('click', handler); }

bindClick('navBack', () => history.back());
bindClick('navForward', () => history.forward());
/* Кнопки панели очереди обрабатываются делегированно (data-action), чтобы
   закрытие работало даже при сбое прямой привязки. */
bindClick('playerLike', () => { if (S.current) toggleSave(S.current); });
bindClick('qpLike', () => { if (S.current) { toggleSave(S.current); updateNpLike(); } });
bindClick('qpAdd', () => { if (S.current) openPlaylistPicker(S.current); });
bindClick('volumeBtn', () => { S.muted = !S.muted; applyVolume(); });

const volumeInput = $('volume');
if (volumeInput) {
  volumeInput.addEventListener('input', (event) => {
    S.volume = Math.min(1, Math.max(0, Number(event.target.value) / 100));
    S.muted = false;
    applyVolume();
  });
}

$('miniNowOpen').addEventListener('click', () => showPlayer());
$('miniNowPlay').addEventListener('click', (event) => {
  event.stopPropagation();
  togglePlay();
});

/* Смена интерфейсной среды (поворот/подключение мыши/принудительный выбор):
   закрываем оверлей чужой среды и перерисовываем текущий раздел. Трек, очередь,
   позиция и аудиопоток не затрагиваются — они общие для обеих сред. */
document.addEventListener('rh:ui-change', () => {
  if (isDesktop()) {
    if (S.drawerOpen) openDrawer(false);
  } else if (S.queueOpen) {
    closeQueuePanel();
  }
  if (isDesktop() && S.lyricsOpen) openLyricsSheet(false);
  if (!isDesktop() && S.queueTab === 'lyrics' && S.queueOpen) closeQueuePanel();
  updateTransport();
  renderQueue();
  route();
});

/* Клик вне правой панели закрывает её (кнопки-переключатели исключены). */
document.addEventListener('click', (event) => {
  if (!S.queueOpen) return;
  const panel = $('queuePanel');
  if (!panel) return;
  // composedPath фиксируется на момент события: клик по строке очереди
  // перерисовывает список, и обычный contains(event.target) уже не сработал бы.
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  if (path.indexOf(panel) !== -1 || panel.contains(event.target)) return;
  if (event.target.closest && event.target.closest('[data-action="queue-toggle"], [data-action="lyrics-toggle"], #npQueue')) return;
  closeQueuePanel();
});

/* Панель — десктопная: при сужении окна убираем её, чтобы не висел оверлей. */
window.addEventListener('resize', () => {
  if (!isDesktop() && S.queueOpen) closeQueuePanel();
  if (isDesktop() && S.drawerOpen) openDrawer(false);
});

/* ───────────────────────────── аудио-события ───────────────────────────── */

audio.addEventListener('loadstart', () => { S.loading = true; updateTransport(); });
audio.addEventListener('waiting', () => { S.loading = true; updateTransport(); });
audio.addEventListener('canplay', () => { S.loading = false; updateTransport(); });
audio.addEventListener('playing', () => {
  aiDiag('native_playing');
  if (aiOwnsPlayback()) return;
  S.loading = false;
  S.playing = true;
  if (window.RH_SMARTMIX) window.RH_SMARTMIX.warm();
  S.playback.lastTick = audio.currentTime;
  updateTransport();
  markCurrentRow();
});
audio.addEventListener('pause', () => {
  aiDiag('native_pause');
  if (aiOwnsPlayback()) return;
  if (smartMixAdopting) return;
  S.playing = false;
  updateTransport();
  markCurrentRow();
  flushPlayback(true);
});
audio.addEventListener('ended', () => {
  aiDiag('native_ended');
  if (aiOwnsPlayback()) return;
  S.playback.completed = true;
  flushPlayback(true, true);
  nextTrack(true);
});
audio.addEventListener('error', () => {
  if (aiOwnsPlayback()) return;
  if (smartMixAdopting || smartMixHandoffActive()) return;
  if (audio.error && audio.error.code === 1) return;
  handleAudioFailure(audio.error ? 'код ' + audio.error.code : null);
});

audio.addEventListener('pause', () => {
  if (aiOwnsPlayback()) return;
  if (smartMixAdopting) return;
  if (window.RH_SMARTMIX && window.RH_SMARTMIX.isPlaying()) window.RH_SMARTMIX.cancel('pause');
});

audio.addEventListener('pause', () => { if (!smartMixAdopting && !aiOwnsPlayback()) savePlayerState(); });

audio.addEventListener('seeking', () => {
  aiDiag('native_seeking');
  if (aiOwnsPlayback()) return;
  if (smartMixAdopting || smartMixHandoffActive()) return;
  if (window.RH_SMARTMIX) window.RH_SMARTMIX.cancel('seek');
});

audio.addEventListener('timeupdate', () => {
  if (aiOwnsPlayback()) return;
  const current = audio.currentTime || 0;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (S.current ? S.current.duration : 0);
  if (!S.seeking) syncSeek(current, duration);

  const delta = current - (S.playback.lastTick || 0);
  if (delta > 0 && delta < 5) S.playback.pending += delta;
  S.playback.lastTick = current;
  if (S.playback.pending >= 25) flushPlayback(true);

  if (Date.now() - (S.lastStateSave || 0) > 10000) {
    S.lastStateSave = Date.now();
    savePlayerState(current);
  }

  if (window.RH_SMARTMIX) window.RH_SMARTMIX.onTime(smartMixState());

  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && duration > 0
      && (!window.RH_SETTINGS || window.RH_SETTINGS.get('mediaSession'))) {
    try {
      navigator.mediaSession.setPositionState({ duration, position: Math.min(current, duration), playbackRate: 1 });
    } catch { /* ignore */ }
  }
});

audio.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    $('npDur').textContent = fmt(audio.duration);
    syncSeek(audio.currentTime || 0, audio.duration);
  }
});

['seekMini', 'seekBig'].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', () => {
    S.seeking = true;
    const percent = Number(el.value) / 10;
    ['seekMini', 'seekBig'].forEach((other) => $(other).style.setProperty('--fill', percent + '%'));
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (S.current ? S.current.duration : 0);
    $('npCur').textContent = fmt(duration * percent / 100);
  });
  el.addEventListener('change', () => {
    if (window.RH_SMARTMIX) window.RH_SMARTMIX.cancel('seek');
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (S.current ? S.current.duration : 0);
    const target = (Number(el.value) / 1000) * duration;
    if (window.RH_AI_AUTOMIX && window.RH_AI_AUTOMIX.ownsPlayback && window.RH_AI_AUTOMIX.ownsPlayback()) {
      if (duration > 0) window.RH_AI_AUTOMIX.seek(target);
    } else {
      if (window.RH_AI_AUTOMIX && window.RH_AI_AUTOMIX.isActive && window.RH_AI_AUTOMIX.isActive()) {
        window.RH_AI_AUTOMIX.invalidatePlan();
      }
      if (duration > 0) audio.currentTime = target;
    }
    S.seeking = false;
    S.playback.lastTick = target;
  });
});

if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => {
      if (window.RH_SMARTMIX) window.RH_SMARTMIX.cancel('pause');
      audio.pause();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(false));
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (window.RH_SMARTMIX) window.RH_SMARTMIX.cancel('seek');
      if (d && Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime;
    });
  } catch { /* ignore */ }
}

document.addEventListener('visibilitychange', () => { if (document.hidden) flushPlayback(true); });
window.addEventListener('pagehide', () => { flushPlayback(true); savePlayerState(); });

/* ───────────────────────────── вспомогательное ───────────────────────────── */

function markCurrentRow() {
  document.querySelectorAll('.track').forEach((row) => {
    const isCurrent = S.current && row.dataset.trackId === String(S.current.id);
    row.classList.toggle('is-current', !!isCurrent);
  });
}

function syncLayoutHeight() {
  // Источник истины — фактическая видимость панели, а не наличие трека:
  // на десктопе панель постоянная и занимает своё место даже пустой.
  const hidden = player.hidden || getComputedStyle(player).display === 'none';
  const playerHeight = hidden ? 0 : Math.round(player.getBoundingClientRect().height || 0);
  document.documentElement.style.setProperty('--player-h', playerHeight + 'px');
}

window.addEventListener('hashchange', route);
window.addEventListener('resize', () => {
  syncLayoutHeight();
  if (S.current) { applyNpTitle(S.current); applyNpSong(S.current); }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.current) { applyNpTitle(S.current); applyNpSong(S.current); }
});

if ('ResizeObserver' in window) new ResizeObserver(syncLayoutHeight).observe(player);

/* ───────────────────────────── старт ───────────────────────────── */

function isStandaloneApp() {
  return window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

function normalizeLaunchRoute() {
  // На iOS PWA при запуске восстанавливается последний URL, например
  // #/artist/<id>. Пользователь ждёт Главную, а не случайную страницу артиста.
  if (!isStandaloneApp()) return;
  if (window.RH_SETTINGS && !window.RH_SETTINGS.get('openHomeOnLaunch')) return;
  const hash = location.hash || '';
  if (!hash || hash === '#/' || hash === '#/home') return;
  try { history.replaceState(null, '', '#/home'); } catch { location.hash = '#/home'; }
  window.scrollTo(0, 0);
}

// iOS часто не перезагружает PWA, а возвращает её из фона со старым URL.
// После заметной паузы показываем Главную, чтобы приложение открывалось
// предсказуемо, а не на странице артиста из прошлой сессии.
let pwaHiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pwaHiddenAt = Date.now(); return; }
  if (!isStandaloneApp() || !pwaHiddenAt) return;
  const hiddenFor = Date.now() - pwaHiddenAt;
  pwaHiddenAt = 0;
  if (hiddenFor < 20000) return;
  const hash = location.hash || '';
  if (!hash || hash === '#/' || hash === '#/home') { window.scrollTo(0, 0); return; }
  try { history.replaceState(null, '', '#/home'); } catch { location.hash = '#/home'; }
  route();
  window.scrollTo(0, 0);
});

(async function boot() {
  normalizeLaunchRoute();
  setUser(null);
  syncLayoutHeight();
  updateTransport();
  renderQueue();
  renderSidePlaylists();
  restoreVolume();
  const layout = readJson('rh_layout_v1', null);
  if (layout && layout.sidebarCollapsed) document.body.classList.add('sidebar-collapsed');
  if (!window.RH_SETTINGS || window.RH_SETTINGS.get('resumePlayback')) restorePlayerState();
  else clearPlayerState();
  initSmartMix();
  // Восстанавливаем Smart Mix из Settings Center и сразу включаем предзагрузку.
  if (window.RH_SETTINGS && window.RH_SETTINGS.get('smartmix') && window.RH_SMARTMIX) {
    try { window.RH_SMARTMIX.setSettings({ enabled: true, preload: true }); } catch { /* ignore */ }
  }
  if (window.RH_EQUALIZER) { window.RH_EQUALIZER.init(); refreshEqualizerUI(); }
  initAiAutoMix();
  if (window.RH_SMARTMIX) window.RH_SMARTMIX.onTrack();
  updateTransport();
  await refreshMe();
  await loadProviders();
  route();
})();
/* Мобильная тактильная подсветка: :active в iOS срабатывает не на всех
   контейнерах, поэтому явно помечаем нажатый элемент на pointerdown. */
(() => {
  let timer = 0;
  const clear = () => {
    document.querySelectorAll('.is-pressed').forEach((el) => el.classList.remove('is-pressed'));
  };
  document.addEventListener('pointerdown', (event) => {
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return;
    const el = event.target.closest && event.target.closest('a, button, .track, .card, .side-item, .tab, .chip, .sheet-item');
    if (!el || el.disabled) return;
    clear();
    el.classList.add('is-pressed');
    clearTimeout(timer);
    timer = setTimeout(clear, 260);
  }, { passive: true });
  document.addEventListener('pointerup', () => { clearTimeout(timer); timer = setTimeout(clear, 80); }, { passive: true });
  document.addEventListener('pointercancel', clear, { passive: true });
  window.addEventListener('scroll', clear, { passive: true });
})();
