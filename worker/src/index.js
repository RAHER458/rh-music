/**
 * RH-MUSIC API — Cloudflare Worker
 *
 * Прокси между фронтендом RH—MUSIC и GraphQL API Zvuk.com.
 * Токен Zvuk хранится только в secret-переменной окружения ZVUK_TOKEN
 * и никогда не попадает в ответы, логи или клиентский код.
 *
 * Маршруты:
 *   GET /api/health
 *   GET /api/search?q=&type=all|tracks|artists|albums&limit=&cursor=
 *   GET /api/search/tracks?q=&limit=&cursor=
 *   GET /api/search/artists?q=&limit=
 *   GET /api/search/albums?q=&limit=
 *   GET /api/track/:id
 *   GET /api/track/:id/stream?quality=mid|high
 *   GET /api/stream/:id?quality=mid|high      (поток через Worker, Range passthrough)
 *   GET /api/artist/:id
 *   GET /api/album/:id
 *   GET /api/img?u=<encoded url>&size=<px>    (прокси обложек с кэшем)
 *   GET /api/diag/stream/:id                  (диагностика доступности CDN)
 */

const GQL_ENDPOINT = 'https://zvuk.com/api/v1/graphql';
const CDN_IMAGE_HOST = 'cdn-image.zvuk.com';

const UPSTREAM_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Content-Type': 'application/json',
  'Origin': 'https://zvuk.com',
  'Referer': 'https://zvuk.com/',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

const TIMEOUT_MS = 9000;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/* ------------------------------------------------------------------ */
/* GraphQL документы                                                   */
/* ------------------------------------------------------------------ */

const TRACK_FIELDS = `
  id
  title
  duration
  explicit
  artists { id title image { src } }
  release { id title date type image { src } artists { id title } }
`;

const Q_SEARCH_ALL = `
query searchAll($query: String, $limit: Int = 20, $tracks: Boolean = true,
                $artists: Boolean = true, $releases: Boolean = true,
                $trackCursor: Cursor, $artistsCursor: Cursor, $releasesCursor: Cursor) {
  search(query: $query) {
    searchId
    tracks(limit: $limit, cursor: $trackCursor) @include(if: $tracks) {
      page { total next cursor }
      items { ${TRACK_FIELDS} }
    }
    artists(limit: $limit, cursor: $artistsCursor) @include(if: $artists) {
      page { total next cursor }
      items { id title image { src } }
    }
    releases(limit: $limit, cursor: $releasesCursor) @include(if: $releases) {
      page { total next cursor }
      items { id title date type image { src } artists { id title } }
    }
  }
}`;

const Q_SEARCH_TRACKS = `
query searchTracks($query: String, $limit: Int = 20, $cursor: Cursor) {
  search(query: $query) {
    tracks(limit: $limit, cursor: $cursor) {
      page { total next cursor }
      items { ${TRACK_FIELDS} }
    }
  }
}`;

const Q_SEARCH_ARTISTS = `
query searchArtists($query: String, $limit: Int = 20, $cursor: Cursor) {
  search(query: $query) {
    artists(limit: $limit, cursor: $cursor) {
      page { total next cursor }
      items { id title image { src } }
    }
  }
}`;

const Q_SEARCH_RELEASES = `
query searchReleases($query: String, $limit: Int = 20, $cursor: Cursor) {
  search(query: $query) {
    releases(limit: $limit, cursor: $cursor) {
      page { total next cursor }
      items { id title date type image { src } artists { id title } }
    }
  }
}`;

const Q_TRACK = `
query getTracks($ids: [ID!]!) {
  getTracks(ids: $ids) {
    ${TRACK_FIELDS}
  }
}`;

const Q_STREAM = `
query getStream($ids: [ID!]!) {
  mediaContents(ids: $ids) {
    __typename
    ... on Track {
      id
      stream { expire expireDelta mid high flac }
    }
  }
}`;

const Q_ARTIST = `
query getArtist($ids: [ID!]!, $withReleases: Boolean = true, $withPopTracks: Boolean = true,
                $withDescription: Boolean = true, $releasesLimit: Int = 30, $tracksLimit: Int = 30) {
  getArtists(ids: $ids) {
    id
    title
    image { src }
    secondImage { src }
    description @include(if: $withDescription)
    releases(limit: $releasesLimit) @include(if: $withReleases) {
      id title date type image { src } artists { id title }
    }
    popularTracks(limit: $tracksLimit) @include(if: $withPopTracks) {
      ${TRACK_FIELDS}
    }
  }
}`;

const Q_RELEASE = `
query getRelease($ids: [ID!]!) {
  getReleases(ids: $ids) {
    id
    title
    date
    type
    image { src }
    artists { id title image { src } }
    tracks { ${TRACK_FIELDS} }
  }
}`;

/* ------------------------------------------------------------------ */
/* Нормализация                                                        */
/* ------------------------------------------------------------------ */

function img(node, size = 300) {
  if (!node || !node.image || !node.image.src) return null;
  return String(node.image.src).replace('{size}', String(size));
}

function normalizeTrack(t, size = 300) {
  if (!t) return null;
  const cover = (t.release && t.release.image && t.release.image.src) ||
    (Array.isArray(t.artists) && t.artists[0] && t.artists[0].image && t.artists[0].image.src) || null;
  const artists = Array.isArray(t.artists) ? t.artists.filter((a) => a && a.title) : [];
  return {
    id: String(t.id),
    title: t.title || 'Без названия',
    duration: Number(t.duration) || 0,
    artist: artists.map((a) => a.title).join(', '),
    artistId: artists[0] ? String(artists[0].id) : null,
    album: (t.release && t.release.title) || '',
    albumId: t.release && t.release.id ? String(t.release.id) : null,
    cover: cover ? String(cover).replace('{size}', String(size)) : null,
    explicit: !!t.explicit,
  };
}

function normalizeArtist(a, size = 400) {
  if (!a) return null;
  return {
    id: String(a.id),
    title: a.title || 'Без названия',
    cover: img(a, size),
    description: a.description || '',
  };
}

function normalizeRelease(r, size = 400) {
  if (!r) return null;
  const artists = Array.isArray(r.artists) ? r.artists.filter((a) => a && a.title) : [];
  return {
    id: String(r.id),
    title: r.title || 'Без названия',
    year: r.date ? String(r.date).slice(0, 4) : '',
    type: r.type || 'album',
    cover: img(r, size),
    artist: artists.map((a) => a.title).join(', '),
    artistId: artists[0] ? String(artists[0].id) : null,
  };
}

function pageOf(block, mapper, size) {
  if (!block) return { total: 0, next: null, cursor: null, items: [] };
  return {
    total: (block.page && block.page.total) || 0,
    next: block.page ? block.page.next : null,
    cursor: block.page ? block.page.cursor : null,
    items: (block.items || []).map((x) => mapper(x, size)).filter(Boolean),
  };
}

/* ------------------------------------------------------------------ */
/* Ошибки и ответы                                                     */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function fail(status, code, message, detail) {
  return json({ ok: false, error: { code, message, detail: detail || null } }, status);
}

/* ------------------------------------------------------------------ */
/* CORS                                                                */
/* ------------------------------------------------------------------ */

const ORIGIN_PATTERNS = [
  /^https:\/\/rh-music\.pages\.dev$/i,
  /^https:\/\/[a-z0-9-]+\.rh-music\.pages\.dev$/i,
  /^https:\/\/rh-music-api\.[a-z0-9-]+\.workers\.dev$/i,
  /^http:\/\/localhost(:\d{2,5})?$/i,
  /^http:\/\/127\.0\.0\.1(:\d{2,5})?$/i,
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = origin && ORIGIN_PATTERNS.some((re) => re.test(origin));
  const h = {
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allowed) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

/* ------------------------------------------------------------------ */
/* GraphQL клиент                                                      */
/* ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gql(env, query, operationName, variables) {
  const token = env.ZVUK_TOKEN;
  if (!token) {
    throw new ApiError(500, 'NO_TOKEN', 'Сервер не настроен: отсутствует ZVUK_TOKEN.');
  }

  let lastError = null;

  // Один повтор на случай временной антибот-блокировки или 5xx.
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(GQL_ENDPOINT, {
        method: 'POST',
        headers: { ...UPSTREAM_HEADERS, 'X-Auth-Token': token },
        body: JSON.stringify({ query, operationName, variables }),
        signal: controller.signal,
      });

      const text = await response.text();

      if (response.status === 418 || response.status === 429 || response.status >= 500) {
        lastError = new ApiError(502, 'UPSTREAM_BLOCKED',
          'Zvuk временно ограничил доступ (' + response.status + ').', text.slice(0, 300));
        if (attempt === 0) { await sleep(450); continue; }
        throw lastError;
      }

      if (!response.ok) {
        throw new ApiError(502, 'UPSTREAM_HTTP',
          'Zvuk вернул HTTP ' + response.status + '.', text.slice(0, 300));
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError(502, 'UPSTREAM_NOT_JSON',
          'Zvuk вернул не JSON (возможно, страница антибот-защиты).', text.slice(0, 200));
      }

      if (Array.isArray(payload.errors) && payload.errors.length) {
        const msg = payload.errors.map((e) => e.message).join('; ');
        const code = payload.errors[0] && payload.errors[0].extensions &&
          payload.errors[0].extensions.code;
        if (code === 'GRAPHQL_VALIDATION_FAILED') {
          throw new ApiError(400, 'BAD_QUERY', 'Некорректный запрос к каталогу.', msg);
        }
        if (/internal error/i.test(msg)) {
          throw new ApiError(404, 'NOT_FOUND', 'В каталоге Zvuk ничего не найдено по этому идентификатору.', msg);
        }
        throw new ApiError(502, 'GRAPHQL_ERROR', 'Ошибка каталога Zvuk: ' + msg, null);
      }

      return payload.data || {};
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'UPSTREAM_BLOCKED' && attempt === 0) { await sleep(450); continue; }
        throw err;
      }
      if (err && err.name === 'AbortError') {
        lastError = new ApiError(504, 'UPSTREAM_TIMEOUT', 'Zvuk не ответил вовремя.');
        if (attempt === 0) continue;
        throw lastError;
      }
      lastError = new ApiError(502, 'UPSTREAM_FETCH', 'Не удалось связаться с Zvuk.',
        err && err.message ? String(err.message) : null);
      if (attempt === 0) { await sleep(250); continue; }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new ApiError(502, 'UPSTREAM', 'Неизвестная ошибка каталога.');
}

/* ------------------------------------------------------------------ */
/* Валидация                                                           */
/* ------------------------------------------------------------------ */

const ID_RE = /^[0-9]{1,20}$/;

function validId(raw) {
  if (!raw || !ID_RE.test(raw)) {
    throw new ApiError(400, 'BAD_ID', 'Некорректный идентификатор.');
  }
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
  const q = (url.searchParams.get('quality') || 'mid').toLowerCase();
  return q === 'high' ? 'high' : 'mid';
}

/* ------------------------------------------------------------------ */
/* Обработчики                                                         */
/* ------------------------------------------------------------------ */

async function handleSearch(env, url, type) {
  const query = parseQuery(url);
  const limit = parseLimit(url);
  const cursor = parseCursor(url);

  if (type === 'tracks') {
    const data = await gql(env, Q_SEARCH_TRACKS, 'searchTracks', { query, limit, cursor });
    const block = data.search && data.search.tracks;
    return json({ ok: true, type, query, tracks: pageOf(block, normalizeTrack, 300) });
  }

  if (type === 'artists') {
    const data = await gql(env, Q_SEARCH_ARTISTS, 'searchArtists', { query, limit, cursor });
    const block = data.search && data.search.artists;
    return json({ ok: true, type, query, artists: pageOf(block, normalizeArtist, 400) });
  }

  if (type === 'albums') {
    const data = await gql(env, Q_SEARCH_RELEASES, 'searchReleases', { query, limit, cursor });
    const block = data.search && data.search.releases;
    return json({ ok: true, type, query, albums: pageOf(block, normalizeRelease, 400) });
  }

  const data = await gql(env, Q_SEARCH_ALL, 'searchAll', {
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
  const data = await gql(env, Q_TRACK, 'getTracks', { ids: [id] });
  const found = (data.getTracks || []).find((item) => item && item.id);
  if (!found) throw new ApiError(404, 'TRACK_NOT_FOUND', 'Композиция не найдена.');
  return json({ ok: true, track: normalizeTrack(found, 400) });
}

async function streamFor(env, id, quality) {
  const data = await gql(env, Q_STREAM, 'getStream', { ids: [id] });
  const items = data.mediaContents || [];
  const item = items.find((x) => x && x.__typename === 'Track' && x.stream)
    || items.find((x) => x && x.stream);
  if (!item || !item.stream) {
    throw new ApiError(404, 'STREAM_NOT_FOUND', 'Поток недоступен для этой композиции.');
  }
  const stream = item.stream;
  const url = quality === 'high' ? (stream.high || stream.mid) : (stream.mid || stream.high);
  if (!url) {
    throw new ApiError(404, 'STREAM_NOT_FOUND', 'Каталог не выдал адрес потока.');
  }
  return {
    url,
    quality: url === stream.high && stream.high ? 'high' : 'mid',
    expiresAt: stream.expire || null,
    expireDelta: stream.expireDelta || null,
  };
}

async function handleStreamInfo(env, id, url) {
  const quality = parseQuality(url);
  const info = await streamFor(env, id, quality);
  return json({
    ok: true,
    id,
    quality: info.quality,
    expiresAt: info.expiresAt,
    expireDelta: info.expireDelta,
    url: info.url,
  });
}

async function handleStreamProxy(request, env, id, url) {
  const quality = parseQuality(url);
  const info = await streamFor(env, id, quality);

  const headers = new Headers();
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let upstream;
  try {
    upstream = await fetch(info.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new ApiError(504, 'CDN_TIMEOUT', 'Аудио-сервер не ответил вовремя.');
    }
    throw new ApiError(502, 'CDN_FETCH', 'Не удалось получить аудиопоток.',
      err && err.message ? String(err.message) : null);
  }
  clearTimeout(timer);

  if (!upstream.ok && upstream.status !== 206) {
    throw new ApiError(502, 'CDN_HTTP',
      'Аудио-сервер вернул HTTP ' + upstream.status + '.');
  }

  const out = new Headers();
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set('Cache-Control', 'no-store');
  out.set('X-Content-Type-Options', 'nosniff');

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

async function handleArtist(env, id) {
  const data = await gql(env, Q_ARTIST, 'getArtist', {
    ids: [id],
    withReleases: true,
    withPopTracks: true,
    withDescription: true,
    releasesLimit: 30,
    tracksLimit: 30,
  });
  const a = (data.getArtists || []).find((item) => item && item.id);
  if (!a) throw new ApiError(404, 'ARTIST_NOT_FOUND', 'Исполнитель не найден.');
  return json({
    ok: true,
    artist: {
      ...normalizeArtist(a, 600),
      banner: a.secondImage && a.secondImage.src
        ? String(a.secondImage.src).replace('{size}', '800') : null,
    },
    tracks: (a.popularTracks || []).map((t) => normalizeTrack(t, 300)),
    albums: (a.releases || []).map((r) => normalizeRelease(r, 400)),
  });
}

async function handleAlbum(env, id) {
  const data = await gql(env, Q_RELEASE, 'getRelease', { ids: [id] });
  const r = (data.getReleases || []).find((item) => item && item.id);
  if (!r) throw new ApiError(404, 'ALBUM_NOT_FOUND', 'Альбом не найден.');
  return json({
    ok: true,
    album: normalizeRelease(r, 600),
    tracks: (r.tracks || []).map((t) => normalizeTrack(t, 300)),
  });
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
  if (targetUrl.searchParams.has('size')) {
    targetUrl.searchParams.set('size', String(size));
  }

  const cache = caches.default;
  const cacheKey = new Request(targetUrl.toString(), { method: 'GET' });
  let cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set('X-Cache', 'HIT');
    return hit;
  }

  const upstream = await fetch(targetUrl.toString(), {
    headers: {
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Referer': 'https://zvuk.com/',
      'User-Agent': UPSTREAM_HEADERS['User-Agent'],
    },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });

  if (!upstream.ok) {
    throw new ApiError(502, 'IMAGE_HTTP', 'Обложка недоступна (' + upstream.status + ').');
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=604800, immutable');
  const length = upstream.headers.get('Content-Length');
  if (length) headers.set('Content-Length', length);

  const response = new Response(upstream.body, { status: 200, headers });
  try {
    await cache.put(cacheKey, response.clone());
  } catch {
    /* кэш недоступен — не критично */
  }
  return response;
}

async function handleDiagStream(env, id, url) {
  const quality = parseQuality(url);
  const info = await streamFor(env, id, quality);
  const started = Date.now();

  let head;
  try {
    head = await fetch(info.url, {
      method: 'GET',
      headers: { 'Range': 'bytes=0-2047' },
      redirect: 'follow',
    });
  } catch (err) {
    return json({
      ok: false,
      cdnHost: (() => { try { return new URL(info.url).host; } catch { return null; } })(),
      error: String((err && err.message) || err),
      elapsedMs: Date.now() - started,
    }, 502);
  }

  const bytes = await head.arrayBuffer();
  const arr = new Uint8Array(bytes.slice(0, 4));
  return json({
    ok: head.ok || head.status === 206,
    cdnHost: (() => { try { return new URL(info.url).host; } catch { return null; } })(),
    status: head.status,
    contentType: head.headers.get('Content-Type'),
    contentLength: head.headers.get('Content-Length'),
    contentRange: head.headers.get('Content-Range'),
    acceptRanges: head.headers.get('Accept-Ranges'),
    first4BytesHex: Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join(' '),
    bytesRead: bytes.byteLength,
    elapsedMs: Date.now() - started,
  }, 200);
}

/* ------------------------------------------------------------------ */
/* Роутер                                                              */
/* ------------------------------------------------------------------ */

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Разрешены только GET и HEAD.');
  }

  let m;

  if (path === '/' || path === '/api') {
    return json({
      ok: true,
      service: 'rh-music-api',
      routes: [
        '/api/health', '/api/search', '/api/search/tracks', '/api/search/artists',
        '/api/search/albums', '/api/track/:id', '/api/track/:id/stream',
        '/api/stream/:id', '/api/artist/:id', '/api/album/:id', '/api/img',
      ],
    });
  }

  if (path === '/api/health') {
    let upstream = null;
    if (url.searchParams.get('probe') === '1') {
      const started = Date.now();
      try {
        const data = await gql(env, Q_SEARCH_TRACKS, 'searchTracks',
          { query: 'Кино', limit: 1, cursor: null });
        const items = (data.search && data.search.tracks && data.search.tracks.items) || [];
        upstream = { ok: items.length > 0, elapsedMs: Date.now() - started };
      } catch (err) {
        upstream = { ok: false, error: err.message, code: err.code || null };
      }
    }
    return json({
      ok: true,
      service: 'rh-music-api',
      version: '1.0.0',
      tokenConfigured: !!env.ZVUK_TOKEN,
      qualityDefault: 'mid',
      upstream,
      time: new Date().toISOString(),
    });
  }

  if (path === '/api/search') {
    const type = (url.searchParams.get('type') || 'all').toLowerCase();
    const supported = ['all', 'tracks', 'artists', 'albums'];
    return handleSearch(env, url, supported.includes(type) ? type : 'all');
  }
  if (path === '/api/search/tracks') return handleSearch(env, url, 'tracks');
  if (path === '/api/search/artists') return handleSearch(env, url, 'artists');
  if (path === '/api/search/albums') return handleSearch(env, url, 'albums');

  if ((m = path.match(/^\/api\/track\/([^/]+)\/stream$/))) {
    return handleStreamInfo(env, validId(m[1]), url);
  }
  if ((m = path.match(/^\/api\/track\/([^/]+)$/))) {
    return handleTrack(env, validId(m[1]));
  }
  if ((m = path.match(/^\/api\/stream\/([^/]+)$/))) {
    return handleStreamProxy(request, env, validId(m[1]), url);
  }
  if ((m = path.match(/^\/api\/artist\/([^/]+)$/))) {
    return handleArtist(env, validId(m[1]));
  }
  if ((m = path.match(/^\/api\/album\/([^/]+)$/))) {
    return handleAlbum(env, validId(m[1]));
  }
  if (path === '/api/img') {
    return handleImage(request, url);
  }
  if ((m = path.match(/^\/api\/diag\/stream\/([^/]+)$/))) {
    return handleDiagStream(env, validId(m[1]), url);
  }

  throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request);
    try {
      const response = await route(request, env, ctx);
      for (const [key, value] of Object.entries(cors)) {
        if (!response.headers.has(key)) response.headers.set(key, value);
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