/**
 * RH—MUSIC API — Cloudflare Worker
 *
 *  • медиа-часть: прокси каталога, поиск, поток (Range/206), обложки — без изменений в поведении;
 *  • аккаунты, библиотека, плейлисты, история и рекомендации — на Cloudflare D1.
 *
 * Токен каталога живёт только в секрете окружения ZVUK_TOKEN и никогда не попадает в ответы.
 */

import { ApiError, json, fail, corsHeaders, sanitizeTrack, readJson, json as jsonResponse } from './http.js';
import {
  gql, Q, pageOf, normalizeTrack, normalizeArtist, normalizeRelease,
  MAX_LIMIT, DEFAULT_LIMIT, CDN_IMAGE_HOST,
} from './zvuk.js';
import {
  handleRegister, handleLogin, handleLogout, handleMe, handleUpdateProfile,
  handleChangePassword, handleDeleteAccount, handlePreferences, handleReauth, requireUser,
} from './auth.js';
import {
  handleLibraryList, handleLibraryIds, handleLibraryAdd, handleLibraryRemove,
  handlePlaylistsList, handlePlaylistGet, handlePlaylistCreate, handlePlaylistUpdate,
  handlePlaylistDelete, handlePlaylistAddTrack, handlePlaylistRemoveTrack, handlePlaylistReorder,
  handleHistoryStart, handleHistoryUpdate, handleHistoryRecent,
} from './music.js';
import { handleRecommendations } from './recommend.js';
import { handleHome, handleCatalogPlaylist } from './home.js';
import {
  handleProviders, handleIdentities, handleUnlink, handleGoogleNonce,
  handleGoogleLogin, handleVkStart, handleVkCallback, handleAppleStart, handleAppleCallback,
} from './oauth.js';

const ID_RE = /^[0-9]{1,20}$/;

/* ───────────────────────────── валидация параметров ───────────────────────────── */

function validId(raw) {
  if (!raw || !ID_RE.test(raw)) throw new ApiError(400, 'BAD_ID', 'Некорректный идентификатор.');
  return raw;
}

function parseQuery(url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) throw new ApiError(400, 'EMPTY_QUERY', 'Введите поисковый запрос.');
  if (q.length > 160) throw new ApiError(400, 'LONG_QUERY', 'Слишком длинный запрос.');
  return q;
}

function parseLimit(url, fallback = DEFAULT_LIMIT) {
  const raw = Number(url.searchParams.get('limit'));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

function parseCursor(url) {
  const raw = url.searchParams.get('cursor');
  if (!raw) return null;
  if (raw.length > 512 || !/^[A-Za-z0-9+/=_-]+$/.test(raw)) {
    throw new ApiError(400, 'BAD_CURSOR', 'Некорректная страница результатов.');
  }
  return raw;
}

function parseQuality(url) {
  // Качество фиксировано: только MID (128 kbps).
  void url;
  return 'mid';
}

/* ───────────────────────────── медиа-обработчики ───────────────────────────── */

async function handleSearch(env, url, type) {
  const query = parseQuery(url);
  const limit = parseLimit(url);
  const cursor = parseCursor(url);

  if (type === 'tracks') {
    const data = await gql(env, Q.searchTracks, 'searchTracks', { query, limit, cursor });
    return json({ ok: true, type, query, tracks: pageOf(data.search && data.search.tracks, normalizeTrack, 300) });
  }
  if (type === 'artists') {
    const data = await gql(env, Q.searchArtists, 'searchArtists', { query, limit, cursor });
    return json({ ok: true, type, query, artists: pageOf(data.search && data.search.artists, normalizeArtist, 400) });
  }
  if (type === 'albums') {
    const data = await gql(env, Q.searchReleases, 'searchReleases', { query, limit, cursor });
    return json({ ok: true, type, query, albums: pageOf(data.search && data.search.releases, normalizeRelease, 400) });
  }

  const data = await gql(env, Q.searchAll, 'searchAll', {
    query,
    limit: Math.min(limit, 20),
    tracks: true,
    artists: true,
    releases: true,
    trackCursor: cursor,
    artistsCursor: null,
    releasesCursor: null,
  });
  const s = data.search || {};
  return json({
    ok: true,
    type: 'all',
    query,
    tracks: pageOf(s.tracks, normalizeTrack, 300),
    artists: pageOf(s.artists, normalizeArtist, 400),
    albums: pageOf(s.releases, normalizeRelease, 400),
  });
}

async function handleTrack(env, id) {
  const data = await gql(env, Q.track, 'getTracks', { ids: [id] });
  const found = (data.getTracks || []).find((item) => item && item.id);
  if (!found) throw new ApiError(404, 'TRACK_NOT_FOUND', 'Композиция не найдена.');
  return json({ ok: true, track: normalizeTrack(found, 400) });
}

async function streamFor(env, id, quality) {
  const data = await gql(env, Q.stream, 'getStream', { ids: [id] });
  const items = data.mediaContents || [];
  const item = items.find((x) => x && x.__typename === 'Track' && x.stream)
    || items.find((x) => x && x.stream);
  if (!item || !item.stream) throw new ApiError(404, 'STREAM_NOT_FOUND', 'Поток недоступен для этой композиции.');
  const stream = item.stream;
  const url = quality === 'high' ? (stream.high || stream.mid) : (stream.mid || stream.high);
  if (!url) throw new ApiError(404, 'STREAM_NOT_FOUND', 'Каталог не выдал адрес потока.');
  return { url, quality, expiresAt: stream.expire || null, expireDelta: stream.expireDelta || null };
}

async function handleStreamInfo(env, id, url) {
  const info = await streamFor(env, id, parseQuality(url));
  return json({ ok: true, id, quality: info.quality, expiresAt: info.expiresAt, expireDelta: info.expireDelta, url: info.url });
}

async function handleStreamProxy(request, env, id, url) {
  const info = await streamFor(env, id, parseQuality(url));

  const headers = new Headers();
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let upstream;
  try {
    upstream = await fetch(info.url, { method: 'GET', headers, redirect: 'follow', signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new ApiError(504, 'CDN_TIMEOUT', 'Аудио-сервер не ответил вовремя.');
    throw new ApiError(502, 'CDN_FETCH', 'Не удалось получить аудиопоток.', err && err.message ? String(err.message) : null);
  }
  clearTimeout(timer);

  if (!upstream.ok && upstream.status !== 206) {
    throw new ApiError(502, 'CDN_HTTP', 'Аудио-сервер вернул HTTP ' + upstream.status + '.');
  }

  const out = new Headers();
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set('Cache-Control', 'no-store');
  out.set('X-Content-Type-Options', 'nosniff');

  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
}

async function handleArtist(env, id) {
  const data = await gql(env, Q.artist, 'getArtist', {
    ids: [id],
    withReleases: true,
    withPopTracks: true,
    withDescription: true,
    withRelated: true,
    releasesLimit: 30,
    tracksLimit: 30,
    relatedLimit: 12,
  });
  const a = (data.getArtists || []).find((item) => item && item.id);
  if (!a) throw new ApiError(404, 'ARTIST_NOT_FOUND', 'Исполнитель не найден.');
  return json({
    ok: true,
    artist: {
      ...normalizeArtist(a, 600),
      banner: a.secondImage && a.secondImage.src ? String(a.secondImage.src).replace('{size}', '800') : null,
    },
    tracks: (a.popularTracks || []).map((t) => normalizeTrack(t, 300)),
    albums: (a.releases || []).map((r) => normalizeRelease(r, 400)),
    related: (a.relatedArtists || []).map((x) => normalizeArtist(x, 300)),
  });
}

async function handleAlbum(env, id) {
  const data = await gql(env, Q.release, 'getRelease', { ids: [id] });
  const r = (data.getReleases || []).find((item) => item && item.id);
  if (!r) throw new ApiError(404, 'ALBUM_NOT_FOUND', 'Альбом не найден.');
  return json({ ok: true, album: normalizeRelease(r, 600), tracks: (r.tracks || []).map((t) => normalizeTrack(t, 300)) });
}

async function handleImage(request, url) {
  const raw = url.searchParams.get('u');
  if (!raw) throw new ApiError(400, 'NO_URL', 'Не передан адрес обложки.');

  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new ApiError(400, 'BAD_URL', 'Некорректный адрес обложки.');
  }
  if (target.protocol !== 'https:' || target.hostname !== CDN_IMAGE_HOST) {
    throw new ApiError(403, 'FORBIDDEN_HOST', 'Обложки с этого хоста не проксируются.');
  }

  const size = Math.min(Math.max(Number(url.searchParams.get('size')) || 300, 40), 1200);
  const targetUrl = new URL(target.toString());
  if (targetUrl.searchParams.has('size')) targetUrl.searchParams.set('size', String(size));

  const cache = caches.default;
  const cacheKey = new Request(targetUrl.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set('X-Cache', 'HIT');
    return hit;
  }

  const upstream = await fetch(targetUrl.toString(), {
    headers: {
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Referer': 'https://zvuk.com/',
    },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });
  if (!upstream.ok) throw new ApiError(502, 'IMAGE_HTTP', 'Обложка недоступна (' + upstream.status + ').');

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=604800, immutable');
  const length = upstream.headers.get('Content-Length');
  if (length) headers.set('Content-Length', length);

  const response = new Response(upstream.body, { status: 200, headers });
  try {
    await cache.put(cacheKey, response.clone());
  } catch { /* кэш недоступен — не критично */ }
  return response;
}

async function handleDiagStream(env, id, url) {
  const info = await streamFor(env, id, parseQuality(url));
  const started = Date.now();
  let head;
  try {
    head = await fetch(info.url, { method: 'GET', headers: { Range: 'bytes=0-2047' }, redirect: 'follow' });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err), elapsedMs: Date.now() - started }, 502);
  }
  const bytes = await head.arrayBuffer();
  const arr = new Uint8Array(bytes.slice(0, 4));
  return json({
    ok: head.ok || head.status === 206,
    status: head.status,
    contentType: head.headers.get('Content-Type'),
    contentRange: head.headers.get('Content-Range'),
    first4BytesHex: Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join(' '),
    bytesRead: bytes.byteLength,
    elapsedMs: Date.now() - started,
  });
}

/* ───────────────────────────── роутер ───────────────────────────── */

const MEDIA_GET = /^\/api\/(search|track|stream|artist|album|img|diag)/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });

  if (!SAFE_METHODS.has(method) && MEDIA_GET.test(path)) {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Для этого маршрута доступны только GET и HEAD.');
  }

  let m;

  /* --- служебное --- */
  if (path === '/' || path === '/api') {
    return json({
      ok: true,
      service: 'rh-music-api',
      version: '2.1.3',
      features: ['catalog', 'accounts', 'oauth', 'library', 'playlists', 'history', 'recommendations', 'home'],
    });
  }

    if (path === '/api/health') {
    let upstream = null;
    if (url.searchParams.get('probe') === '1') {
      const started = Date.now();
      try {
        const data = await gql(env, Q.searchTracks, 'searchTracks', { query: 'music', limit: 1, cursor: null });
        const items = (data.search && data.search.tracks && data.search.tracks.items) || [];
        upstream = { ok: items.length > 0, elapsedMs: Date.now() - started };
      } catch (err) {
        upstream = { ok: false, error: err.message, code: err.code || null };
      }
    }
    let database = null;
    try {
      const row = await env.DB.prepare('SELECT COUNT(*) AS users FROM users').first();
      database = { ok: true, users: (row && row.users) || 0 };
    } catch (err) {
      database = { ok: false, error: String(err && err.message) };
    }
    return json({
      ok: true,
      service: 'rh-music-api',
      version: '2.1.3',
      tokenConfigured: !!env.ZVUK_TOKEN,
      database,
      upstream,
      time: new Date().toISOString(),
    });
  }

  /* --- аккаунты --- */
  if (path === '/api/auth/register' && method === 'POST') return handleRegister(request, env);
  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, env);
  if (path === '/api/auth/me' && method === 'GET') return handleMe(request, env);
  if (path === '/api/auth/profile' && method === 'PATCH') return handleUpdateProfile(request, env);
  if (path === '/api/auth/password' && method === 'POST') return handleChangePassword(request, env);
  if (path === '/api/auth/reauth' && method === 'POST') return handleReauth(request, env);

  /* --- внешние способы входа --- */
  if (path === '/api/auth/providers' && method === 'GET') return handleProviders(request, env);
  if (path === '/api/auth/identities' && method === 'GET') return handleIdentities(request, env);
  if (path === '/api/auth/identities/unlink' && method === 'POST') return handleUnlink(request, env);
  if (path === '/api/auth/oauth/google/nonce' && method === 'POST') return handleGoogleNonce(request, env);
  if (path === '/api/auth/oauth/google' && method === 'POST') return handleGoogleLogin(request, env);
  if (path === '/api/auth/oauth/vk/start' && method === 'POST') return handleVkStart(request, env);
  if (path === '/api/auth/oauth/vk/callback' && (method === 'GET' || method === 'POST')) return handleVkCallback(request, env, url);
  if (path === '/api/auth/oauth/apple/start' && method === 'POST') return handleAppleStart(request, env);
  if (path === '/api/auth/oauth/apple/callback' && (method === 'POST' || method === 'GET')) return handleAppleCallback(request, env);
  if (path === '/api/auth/account' && method === 'DELETE') return handleDeleteAccount(request, env);
  if (path === '/api/me/preferences' && method === 'PATCH') return handlePreferences(request, env);

  /* --- библиотека --- */
  if (path === '/api/library' && method === 'GET') return handleLibraryList(request, env, url);
  if (path === '/api/library' && method === 'POST') return handleLibraryAdd(request, env);
  if (path === '/api/library/ids' && method === 'GET') return handleLibraryIds(request, env);
  if ((m = path.match(/^\/api\/library\/([^/]+)$/)) && method === 'DELETE') {
    return handleLibraryRemove(request, env, m[1]);
  }

  /* --- плейлисты --- */
  if (path === '/api/playlists' && method === 'GET') return handlePlaylistsList(request, env);
  if (path === '/api/playlists' && method === 'POST') return handlePlaylistCreate(request, env);
  if ((m = path.match(/^\/api\/playlists\/(\d+)\/tracks$/)) && method === 'POST') {
    return handlePlaylistAddTrack(request, env, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/playlists\/(\d+)\/tracks\/([^/]+)$/)) && method === 'DELETE') {
    return handlePlaylistRemoveTrack(request, env, Number(m[1]), m[2]);
  }
  if ((m = path.match(/^\/api\/playlists\/(\d+)\/order$/)) && method === 'PATCH') {
    return handlePlaylistReorder(request, env, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/playlists\/(\d+)$/))) {
    if (method === 'GET') return handlePlaylistGet(request, env, Number(m[1]));
    if (method === 'PATCH') return handlePlaylistUpdate(request, env, Number(m[1]));
    if (method === 'DELETE') return handlePlaylistDelete(request, env, Number(m[1]));
  }

  /* --- история и рекомендации --- */
  if (path === '/api/history' && method === 'POST') return handleHistoryStart(request, env);
  if (path === '/api/history' && method === 'GET') return handleHistoryRecent(request, env, url);
  if ((m = path.match(/^\/api\/history\/(\d+)$/)) && (method === 'PATCH' || method === 'POST')) {
    return handleHistoryUpdate(request, env, m[1], method);
  }
  if (path === '/api/recommendations' && method === 'GET') return handleRecommendations(request, env);

  /* --- витрина главной (общий контент) --- */
  if (path === '/api/home' && method === 'GET') return handleHome(request, env);
  if ((m = path.match(/^\/api\/playlist\/(\d+)$/)) && method === 'GET') return handleCatalogPlaylist(env, m[1]);

  /* --- каталог (как и раньше) --- */
  if (path === '/api/search' && method === 'GET') {
    const type = (url.searchParams.get('type') || 'all').toLowerCase();
    const supported = ['all', 'tracks', 'artists', 'albums'];
    return handleSearch(env, url, supported.includes(type) ? type : 'all');
  }
  if (path === '/api/search/tracks' && method === 'GET') return handleSearch(env, url, 'tracks');
  if (path === '/api/search/artists' && method === 'GET') return handleSearch(env, url, 'artists');
  if (path === '/api/search/albums' && method === 'GET') return handleSearch(env, url, 'albums');

  if ((m = path.match(/^\/api\/track\/([^/]+)\/stream$/)) && method === 'GET') return handleStreamInfo(env, validId(m[1]), url);
  if ((m = path.match(/^\/api\/track\/([^/]+)$/)) && method === 'GET') return handleTrack(env, validId(m[1]));
  if ((m = path.match(/^\/api\/stream\/([^/]+)$/)) && (method === 'GET' || method === 'HEAD')) {
    return handleStreamProxy(request, env, validId(m[1]), url);
  }
  if ((m = path.match(/^\/api\/artist\/([^/]+)$/)) && method === 'GET') return handleArtist(env, validId(m[1]));
  if ((m = path.match(/^\/api\/album\/([^/]+)$/)) && method === 'GET') return handleAlbum(env, validId(m[1]));
  if (path === '/api/img' && method === 'GET') return handleImage(request, url);
  if ((m = path.match(/^\/api\/diag\/stream\/([^/]+)$/)) && method === 'GET') return handleDiagStream(env, validId(m[1]), url);

  throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    try {
      const response = await route(request, env);
      for (const [key, value] of Object.entries(cors)) {
        if (!response.headers.has(key) && key !== 'Access-Control-Allow-Origin') response.headers.set(key, value);
        else if (key === 'Access-Control-Allow-Origin' && !response.headers.has(key)) response.headers.set(key, value);
      }
      return response;
    } catch (err) {
      const apiErr = err instanceof ApiError
        ? err
        : new ApiError(500, 'INTERNAL', 'Внутренняя ошибка сервера.', String((err && err.message) || err));
      const response = fail(apiErr.status, apiErr.code, apiErr.message, apiErr.detail);
      for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
      return response;
    }
  },
};

export { jsonResponse };