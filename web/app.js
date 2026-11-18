/* RH—MUSIC — клиент Zvuk через Cloudflare Worker */
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
const main = $('main');
const player = $('player');
const seek = $('seek');
const toastEl = $('toast');

const S = {
  query: '',
  type: 'all',
  view: 'home',
  lists: {},
  tracks: { items: [], total: 0, next: null, cursor: null },
  artists: { items: [], total: 0 },
  albums: { items: [], total: 0 },
  queue: [],
  queueIndex: -1,
  current: null,
  quality: (() => {
    try { return localStorage.getItem('rh_quality') === 'high' ? 'high' : 'mid'; }
    catch { return 'mid'; }
  })(),
  playing: false,
  loading: false,
  seeking: false,
  retried: false,
  requestId: 0,
};

/* ------------------------------------------------------------------ */
/* Утилиты                                                             */
/* ------------------------------------------------------------------ */

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE[ch]);

function fmt(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '0:00';
  const total = Math.floor(n);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function pic(url, size) {
  if (!url) return '';
  return API + '/api/img?u=' + encodeURIComponent(url) + '&size=' + (size || 300);
}

function icon(name) {
  const icons = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.2c0-1 1.1-1.6 2-1.1l9.4 6.3a1.3 1.3 0 0 1 0 2.2L10 19c-.9.5-2-.1-2-1.1V5.2Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5a1.5 1.5 0 0 1 3 0v14a1.5 1.5 0 0 1-3 0V5Zm7 0a1.5 1.5 0 0 1 3 0v14a1.5 1.5 0 0 1-3 0V5Z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M14.7 4.3a1 1 0 0 1 0 1.4L8.4 12l6.3 6.3a1 1 0 1 1-1.4 1.4l-7-7a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 1.4 0Z"/></svg>',
  };
  return icons[name] || '';
}

let toastTimer = null;
function toast(message, kind = 'error') {
  toastEl.textContent = message;
  toastEl.classList.toggle('is-info', kind === 'info');
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 4200);
}

async function api(path) {
  const response = await fetch(API + path, { headers: { 'Accept': 'application/json' } });
  let payload = null;
  try { payload = await response.json(); } catch { /* ignore */ }
  if (!response.ok || !payload || payload.ok === false) {
    const message = (payload && payload.error && payload.error.message)
      || ('Сервер вернул HTTP ' + response.status);
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/* ------------------------------------------------------------------ */
/* Разметка                                                            */
/* ------------------------------------------------------------------ */

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
      <div class="cover">
        ${track.cover ? `<img src="${esc(pic(track.cover, 160))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        <span class="cover-fallback">${position ? String(position).padStart(2, '0') : '♪'}</span>
      </div>
      <div class="track-meta">
        <div class="track-title">${esc(track.title)}</div>
        <div class="track-sub">${sub}</div>
      </div>
      <div class="track-dur">${fmt(track.duration)}</div>
      <button class="track-play" type="button" data-action="play" data-list="${esc(listName)}" data-index="${index}" aria-label="Воспроизвести ${esc(track.title)}">
        ${showEq ? '<span class="eq"><i></i><i></i><i></i></span>' : icon('play')}
      </button>
    </article>`;
}

function artistCard(artist) {
  return `
    <a class="card" href="#/artist/${esc(artist.id)}" data-action="link">
      <span class="card-art round">
        ${artist.cover ? `<img src="${esc(pic(artist.cover, 300))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
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
    <a class="card" href="#/album/${esc(album.id)}" data-action="link">
      <span class="card-art">
        ${album.cover ? `<img src="${esc(pic(album.cover, 300))}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
      </span>
      <span>
        <span class="card-title">${esc(album.title)}</span>
        <span class="card-sub">${esc(sub || 'Альбом')}</span>
      </span>
    </a>`;
}

function section(title, count, body, extra = '') {
  return `
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">${esc(title)}</h2>
        ${count ? `<span class="section-count">${esc(count)}</span>` : ''}
      </div>
      ${body}
      ${extra}
    </section>`;
}

function skeleton(count = 6) {
  return `<div class="skeleton">${Array.from({ length: count }).map(() => `
    <div class="sk-row">
      <div class="sk sk-art"></div>
      <div>
        <div class="sk sk-line" style="width:58%"></div>
        <div class="sk sk-line short" style="margin-top:7px"></div>
      </div>
      <div class="sk sk-line" style="width:34px"></div>
    </div>`).join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* Главная и поиск                                                     */
/* ------------------------------------------------------------------ */

const PRESETS = ['Кино — Группа крови', 'Король и Шут — Лесник', 'Metallica', 'Miyagi', 'Imagine Dragons', 'Руки Вверх'];

function renderHome() {
  S.view = 'home';
  document.title = 'RH—MUSIC';
  $('brandSub').textContent = 'каталог Zvuk';
  main.innerHTML = `
    <section class="hero">
      <h2>Музыка из каталога <em>Zvuk</em></h2>
      <p>Найдите любой трек, исполнителя или альбом и слушайте прямо здесь — без переходов и установки приложений.</p>
      <div class="chips">
        ${PRESETS.map((p) => `<button class="chip" type="button" data-action="preset" data-query="${esc(p)}">${esc(p)}</button>`).join('')}
      </div>
    </section>`;
  window.scrollTo({ top: 0 });
}

async function runSearch() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const query = (params.get('q') || '').trim();
  const type = ['all', 'tracks', 'artists', 'albums'].includes(params.get('type')) ? params.get('type') : 'all';

  S.query = query;
  S.type = type;
  S.view = 'search';

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.type === type);
  });

  if (!query) {
    renderHome();
    return;
  }

  $('q').value = query;
  $('brandSub').textContent = 'результаты поиска';
  document.title = query + ' — RH—MUSIC';
  main.innerHTML = `<section class="section"><div class="section-head"><h2 class="section-title">Ищем «${esc(query)}»</h2></div>${skeleton()}</section>`;

  const requestId = ++S.requestId;
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(query) + '&type=' + type + '&limit=20');
    if (requestId !== S.requestId) return;

    S.tracks = data.tracks || { items: [], total: 0, next: null, cursor: null };
    S.artists = data.artists || { items: [], total: 0 };
    S.albums = data.albums || { items: [], total: 0 };
    S.lists.searchTracks = S.tracks.items;

    renderSearchResults();
  } catch (error) {
    if (requestId !== S.requestId) return;
    main.innerHTML = `
      <section class="section">
        <div class="state">
          <h3>Не удалось выполнить поиск</h3>
          <p>${esc(error.message)}</p>
          <p class="hint">Проверьте соединение и попробуйте снова.</p>
        </div>
      </section>`;
  }
}

function renderSearchResults() {
  const parts = [];
  const hasTracks = S.tracks.items.length > 0;
  const hasArtists = S.artists.items.length > 0;
  const hasAlbums = S.albums.items.length > 0;

  if (hasTracks && S.type !== 'artists' && S.type !== 'albums') {
    const more = S.tracks.next
      ? `<button class="more" type="button" data-action="more">Показать ещё</button>`
      : '';
    parts.push(section(
      'Треки',
      S.tracks.total ? S.tracks.total.toLocaleString('ru-RU') : '',
      `<div class="track-list">${S.tracks.items.map((t, i) => trackRow(t, i, 'searchTracks')).join('')}</div>`,
      more,
    ));
  }

  if (hasArtists && S.type !== 'tracks' && S.type !== 'albums') {
    parts.push(section(
      'Исполнители',
      S.artists.total || '',
      `<div class="card-grid">${S.artists.items.map(artistCard).join('')}</div>`,
    ));
  }

  if (hasAlbums && S.type !== 'tracks' && S.type !== 'artists') {
    parts.push(section(
      'Альбомы',
      S.albums.total || '',
      `<div class="card-grid">${S.albums.items.map(albumCard).join('')}</div>`,
    ));
  }

  if (!parts.length) {
    parts.push(`
      <section class="section">
        <div class="state">
          <h3>Ничего не найдено</h3>
          <p>По запросу «${esc(S.query)}» в каталоге Zvuk нет результатов. Попробуйте другое название или имя исполнителя.</p>
        </div>
      </section>`);
  }

  main.innerHTML = parts.join('');
}

async function loadMore() {
  if (!S.tracks.next) return;
  const button = main.querySelector('[data-action="more"]');
  if (button) {
    button.disabled = true;
    button.textContent = 'Загружаю…';
  }
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(S.query) + '&type=tracks&limit=20&cursor=' + encodeURIComponent(S.tracks.cursor));
    const items = (data.tracks && data.tracks.items) || [];
    S.tracks.items = S.tracks.items.concat(items);
    S.tracks.next = data.tracks ? data.tracks.next : null;
    S.tracks.cursor = data.tracks ? data.tracks.cursor : null;
    S.lists.searchTracks = S.tracks.items;

    const trackList = main.querySelector('.track-list');
    if (trackList) {
      trackList.insertAdjacentHTML('beforeend',
        items.map((t, i) => trackRow(t, S.tracks.items.length - items.length + i, 'searchTracks')).join(''));
    }
    if (!S.tracks.next && button) button.remove();
    else if (button) {
      button.disabled = false;
      button.textContent = 'Показать ещё';
    }
  } catch (error) {
    toast(error.message);
    if (button) {
      button.disabled = false;
      button.textContent = 'Показать ещё';
    }
  }
}

/* ------------------------------------------------------------------ */
/* Исполнитель и альбом                                                */
/* ------------------------------------------------------------------ */

async function renderArtist(id) {
  S.view = 'artist';
  main.innerHTML = `<section class="section">${skeleton(5)}</section>`;
  try {
    const data = await api('/api/artist/' + encodeURIComponent(id));
    const artist = data.artist;
    const tracks = data.tracks || [];
    const albums = data.albums || [];

    S.lists.artistTracks = tracks;
    document.title = artist.title + ' — RH—MUSIC';
    $('brandSub').textContent = 'исполнитель';

    main.innerHTML = `
      <button class="back" type="button" data-action="back">${icon('back')} Назад</button>
      <section class="detail">
        <div class="detail-art round">
          ${artist.cover ? `<img src="${esc(pic(artist.cover, 600))}" alt="" onerror="this.remove()">` : ''}
        </div>
        <div class="detail-body">
          <div class="detail-kicker">Исполнитель</div>
          <h2 class="detail-title">${esc(artist.title)}</h2>
          <div class="detail-sub">${tracks.length ? tracks.length + ' популярных треков' : 'Треки в каталоге'}</div>
          ${artist.description ? `<p class="detail-desc">${esc(artist.description)}</p>` : ''}
          <div class="detail-actions">
            ${tracks.length ? `<button class="btn btn-primary" type="button" data-action="play-all" data-list="artistTracks">${icon('play')} Слушать</button>` : ''}
            <button class="btn btn-ghost" type="button" data-action="search-artist" data-query="${esc(artist.title)}">Все треки</button>
          </div>
        </div>
      </section>
      ${tracks.length ? section('Популярное', String(tracks.length),
        `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, 'artistTracks')).join('')}</div>`) : ''}
      ${albums.length ? section('Релизы', String(albums.length),
        `<div class="card-grid">${albums.map(albumCard).join('')}</div>`) : ''}
      ${!tracks.length && !albums.length ? `<div class="state"><h3>Пока пусто</h3><p>Каталог не вернул треки для этого исполнителя.</p></div>` : ''}
    `;
    window.scrollTo({ top: 0 });
  } catch (error) {
    main.innerHTML = `<section class="section"><div class="state"><h3>Исполнитель недоступен</h3><p>${esc(error.message)}</p></div></section>`;
  }
}

async function renderAlbum(id) {
  S.view = 'album';
  main.innerHTML = `<section class="section">${skeleton(6)}</section>`;
  try {
    const data = await api('/api/album/' + encodeURIComponent(id));
    const album = data.album;
    const tracks = data.tracks || [];
    S.lists.albumTracks = tracks;

    document.title = album.title + ' — RH—MUSIC';
    $('brandSub').textContent = 'альбом';

    const sub = [
      album.artistId ? `<a href="#/artist/${esc(album.artistId)}" data-action="link">${esc(album.artist)}</a>` : esc(album.artist),
      album.year,
      tracks.length ? tracks.length + ' треков' : '',
    ].filter(Boolean).join(' · ');

    main.innerHTML = `
      <button class="back" type="button" data-action="back">${icon('back')} Назад</button>
      <section class="detail">
        <div class="detail-art">
          ${album.cover ? `<img src="${esc(pic(album.cover, 600))}" alt="" onerror="this.remove()">` : ''}
        </div>
        <div class="detail-body">
          <div class="detail-kicker">${album.type === 'single' ? 'Сингл' : album.type === 'ep' ? 'EP' : 'Альбом'}</div>
          <h2 class="detail-title">${esc(album.title)}</h2>
          <div class="detail-sub">${sub}</div>
          <div class="detail-actions">
            ${tracks.length ? `<button class="btn btn-primary" type="button" data-action="play-all" data-list="albumTracks">${icon('play')} Слушать альбом</button>` : ''}
          </div>
        </div>
      </section>
      ${tracks.length ? section('Треки', String(tracks.length),
        `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, 'albumTracks', i + 1)).join('')}</div>`) : ''}
    `;
    window.scrollTo({ top: 0 });
  } catch (error) {
    main.innerHTML = `<section class="section"><div class="state"><h3>Альбом недоступен</h3><p>${esc(error.message)}</p></div></section>`;
  }
}

/* ------------------------------------------------------------------ */
/* Роутер                                                              */
/* ------------------------------------------------------------------ */

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const path = hash.split('?')[0];

  if (path === '/' || path === '') return renderHome();

  let m;
  if ((m = path.match(/^\/artist\/(\d+)$/))) return renderArtist(m[1]);
  if ((m = path.match(/^\/album\/(\d+)$/))) return renderAlbum(m[1]);
  if (path === '/search') return runSearch();

  return renderHome();
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/* ------------------------------------------------------------------ */
/* Плеер                                                               */
/* ------------------------------------------------------------------ */

function setQueue(tracks, index) {
  S.queue = Array.isArray(tracks) ? tracks.slice() : [];
  S.queueIndex = index;
}

function streamUrl(track, quality) {
  return API + '/api/stream/' + encodeURIComponent(track.id) + '?quality=' + (quality || S.quality);
}

function updatePlayerMeta(track) {
  $('npTitle').textContent = track ? track.title : 'Ничего не играет';
  const artistEl = $('npArtist');
  if (track && track.artistId) {
    artistEl.innerHTML = `<a href="#/artist/${esc(track.artistId)}" data-action="link">${esc(track.artist || 'Неизвестный исполнитель')}</a>`;
  } else {
    artistEl.textContent = track ? (track.artist || 'Неизвестный исполнитель') : 'Выберите трек в результатах';
  }

  const img = $('npCover');
  const fallback = $('npCoverWrap').querySelector('.np-cover-fallback');
  img.classList.remove('is-loaded');
  if (track && track.cover) {
    img.onload = () => img.classList.add('is-loaded');
    img.onerror = () => { img.removeAttribute('src'); img.classList.remove('is-loaded'); };
    img.src = pic(track.cover, 160);
    img.alt = track.title || '';
    if (fallback) fallback.style.display = '';
  } else {
    img.removeAttribute('src');
    img.alt = '';
    if (fallback) fallback.style.display = '';
  }

  $('tCur').textContent = '0:00';
  $('tDur').textContent = fmt(track ? track.duration : 0);
  seek.value = '0';
  seek.style.setProperty('--fill', '0%');
  seek.disabled = !track;

  $('prev').disabled = !S.queue.length;
  $('next').disabled = !S.queue.length;
  $('play').disabled = !track;

  if ('mediaSession' in navigator && track) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        artwork: track.cover ? [{ src: pic(track.cover, 512), sizes: '512x512', type: 'image/jpeg' }] : [],
      });
    } catch { /* ignore */ }
  }
}

function setLoading(value) {
  S.loading = value;
  player.classList.toggle('is-loading', value);
}

function setPlaying(value) {
  S.playing = value;
  player.classList.toggle('is-playing', value);
  const btn = $('play');
  btn.setAttribute('aria-label', value ? 'Пауза' : 'Воспроизвести');
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = value ? 'playing' : 'paused';
  }
  markCurrentRow();
}

function markCurrentRow() {
  document.querySelectorAll('.track').forEach((row) => {
    const isCurrent = S.current && row.dataset.trackId === String(S.current.id);
    row.classList.toggle('is-current', !!isCurrent);
    const btn = row.querySelector('.track-play');
    if (!btn) return;
    if (isCurrent && S.playing) {
      btn.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>';
    } else if (btn.querySelector('.eq')) {
      btn.innerHTML = icon('play');
    }
  });
}

function playIndex(index, autoplay = true) {
  if (index < 0 || index >= S.queue.length) return;
  S.queueIndex = index;
  const track = S.queue[index];
  S.current = track;
  S.retried = false;

  updatePlayerMeta(track);
  setLoading(true);

  audio.src = streamUrl(track);
  audio.load();

  if (autoplay) {
    const promise = audio.play();
    if (promise && promise.catch) {
      promise.catch((error) => {
        setLoading(false);
        if (error && error.name === 'NotAllowedError') {
          toast('Нажмите Play, чтобы разрешить воспроизведение', 'info');
        } else if (error && error.name !== 'AbortError') {
          handleAudioFailure(error.message);
        }
      });
    }
  }
}

function handleAudioFailure(detail) {
  if (!S.current) return;

  if (!S.retried) {
    S.retried = true;
    // Подписанный адрес мог истечь или не отдаться через прокси — пробуем напрямую.
    api('/api/track/' + encodeURIComponent(S.current.id) + '/stream?quality=' + S.quality)
      .then((data) => {
        if (!data || !data.url) throw new Error('нет адреса потока');
        audio.src = data.url;
        audio.load();
        return audio.play();
      })
      .catch((error) => {
        setLoading(false);
        toast('Не удалось воспроизвести: ' + (error.message || detail || 'ошибка аудио'));
      });
    return;
  }

  setLoading(false);
  setPlaying(false);
  toast('Не удалось воспроизвести трек. Попробуйте другой или повторите позже.');
}

function togglePlay() {
  if (!S.current) return;
  if (!audio.src) {
    playIndex(S.queueIndex >= 0 ? S.queueIndex : 0);
    return;
  }
  if (audio.paused) {
    setLoading(true);
    audio.play().catch((error) => {
      setLoading(false);
      if (error.name !== 'AbortError') handleAudioFailure(error.message);
    });
  } else {
    audio.pause();
  }
}

function nextTrack(auto = false) {
  if (!S.queue.length) return;
  const next = (S.queueIndex + 1) % S.queue.length;
  if (auto && next === 0 && S.queue.length === 1) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  playIndex(next);
}

function prevTrack() {
  if (!S.queue.length) return;
  if (audio.currentTime > 4) {
    audio.currentTime = 0;
    return;
  }
  const prev = (S.queueIndex - 1 + S.queue.length) % S.queue.length;
  playIndex(prev);
}

/* ------------------------------------------------------------------ */
/* События плеера                                                      */
/* ------------------------------------------------------------------ */

audio.addEventListener('loadstart', () => setLoading(true));
audio.addEventListener('waiting', () => setLoading(true));
audio.addEventListener('canplay', () => setLoading(false));
audio.addEventListener('playing', () => { setLoading(false); setPlaying(true); });
audio.addEventListener('pause', () => setPlaying(false));
audio.addEventListener('ended', () => nextTrack(true));
audio.addEventListener('error', () => {
  if (audio.error && audio.error.code === 1) return; // прервано новым src
  handleAudioFailure(audio.error ? 'код ' + audio.error.code : null);
});

audio.addEventListener('timeupdate', () => {
  if (S.seeking) return;
  const current = audio.currentTime || 0;
  $('tCur').textContent = fmt(current);
  const duration = Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : (S.current ? S.current.duration : 0);
  if (duration > 0) {
    const percent = Math.min(100, (current / duration) * 100);
    seek.value = String(Math.round(percent * 10));
    seek.style.setProperty('--fill', percent + '%');
  }
});

audio.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    $('tDur').textContent = fmt(audio.duration);
  }
});

seek.addEventListener('input', () => {
  S.seeking = true;
  seek.style.setProperty('--fill', (Number(seek.value) / 10) + '%');
});

seek.addEventListener('change', () => {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : (S.current ? S.current.duration : 0);
  if (duration > 0) {
    audio.currentTime = (Number(seek.value) / 1000) * duration;
  }
  S.seeking = false;
});

$('play').addEventListener('click', togglePlay);
$('next').addEventListener('click', () => nextTrack(false));
$('prev').addEventListener('click', prevTrack);

$('quality').addEventListener('click', () => {
  S.quality = S.quality === 'mid' ? 'high' : 'mid';
  try { localStorage.setItem('rh_quality', S.quality); } catch { /* ignore */ }
  updateQualityButton();
  if (S.current) {
    const position = audio.currentTime || 0;
    S.retried = false;
    setLoading(true);
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
});

function updateQualityButton() {
  const button = $('quality');
  button.dataset.q = S.quality;
  button.innerHTML = (S.quality === 'mid' ? 'MID<span>128</span>' : 'HIGH<span>320</span>');
}

if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(false));
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details && Number.isFinite(details.seekTime)) audio.currentTime = details.seekTime;
    });
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Общие события интерфейса                                            */
/* ------------------------------------------------------------------ */

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  if (action === 'link') return; // обычный переход по ссылке

  if (action === 'home') {
    event.preventDefault();
    go('/');
    return;
  }

  if (action === 'play') {
    const listName = target.dataset.list;
    const index = Number(target.dataset.index);
    const list = S.lists[listName];
    if (!list || !list[index]) return;
    if (S.current && String(S.current.id) === String(list[index].id) && !audio.paused) {
      audio.pause();
      return;
    }
    if (S.current && String(S.current.id) === String(list[index].id) && audio.paused && audio.src) {
      togglePlay();
      return;
    }
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

  if (action === 'preset') {
    const query = target.dataset.query;
    go('/search?q=' + encodeURIComponent(query) + '&type=all');
    return;
  }

  if (action === 'search-artist') {
    go('/search?q=' + encodeURIComponent(target.dataset.query) + '&type=tracks');
    return;
  }

  if (action === 'more') {
    loadMore();
    return;
  }

  if (action === 'back') {
    if (history.length > 1) history.back();
    else go('/');
  }
});

$('searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('q').value.trim();
  if (!query) {
    $('q').focus();
    return;
  }
  go('/search?q=' + encodeURIComponent(query) + '&type=' + S.type);
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const type = tab.dataset.type;
    const query = $('q').value.trim() || S.query;
    if (!query) return;
    go('/search?q=' + encodeURIComponent(query) + '&type=' + type);
  });
});

window.addEventListener('hashchange', route);

/* ------------------------------------------------------------------ */
/* Старт                                                               */
/* ------------------------------------------------------------------ */

function syncPlayerHeight() {
  const height = player.getBoundingClientRect().height || 108;
  document.documentElement.style.setProperty('--player-h', Math.round(height) + 'px');
}

if ('ResizeObserver' in window) {
  new ResizeObserver(syncPlayerHeight).observe(player);
}

updateQualityButton();
syncPlayerHeight();
route();