/**
 * Клиент каталога (GraphQL) и нормализация данных.
 * Токен берётся только из секрета окружения ZVUK_TOKEN.
 */

import { ApiError } from './http.js';

const GQL_ENDPOINT = 'https://zvuk.com/api/v1/graphql';
const CDN_IMAGE_HOST = 'cdn-image.zvuk.com';
const TIMEOUT_MS = 9000;

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

export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 20;

const TRACK_FIELDS = `
  id
  title
  duration
  explicit
  artists { id title image { src } }
  release { id title date type image { src } artists { id title } }
`;

export const Q = {
  searchAll: `
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
}`,
  searchTracks: `
query searchTracks($query: String, $limit: Int = 20, $cursor: Cursor) {
  search(query: $query) {
    tracks(limit: $limit, cursor: $cursor) {
      page { total next cursor }
      items { ${TRACK_FIELDS} }
    }
  }
}`,
  searchArtists: `
query searchArtists($query: String, $limit: Int = 20, $cursor: Cursor) {
  search(query: $query) {
    artists(limit: $limit, cursor: $cursor) {
      page { total next cursor }
      items { id title image { src } }
    }
  }
}`,
  searchReleases: `
query searchReleases($query: String, $limit: Int = 20, $cursor: Cursor) {
  search(query: $query) {
    releases(limit: $limit, cursor: $cursor) {
      page { total next cursor }
      items { id title date type image { src } artists { id title } }
    }
  }
}`,
  track: `
query getTracks($ids: [ID!]!) {
  getTracks(ids: $ids) {
    ${TRACK_FIELDS}
  }
}`,
  stream: `
query getStream($ids: [ID!]!) {
  mediaContents(ids: $ids) {
    __typename
    ... on Track {
      id
      stream { expire expireDelta mid high flac }
    }
  }
}`,
  artist: `
query getArtist($ids: [ID!]!, $withReleases: Boolean = true, $withPopTracks: Boolean = true,
                $withDescription: Boolean = true, $withRelated: Boolean = false,
                $releasesLimit: Int = 30, $tracksLimit: Int = 30, $relatedLimit: Int = 20) {
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
    relatedArtists(limit: $relatedLimit) @include(if: $withRelated) {
      id title image { src }
    }
  }
}`,
  release: `
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
}`,
};

export function img(node, size = 300) {
  if (!node || !node.image || !node.image.src) return null;
  return String(node.image.src).replace('{size}', String(size));
}

export function normalizeTrack(t, size = 300) {
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

export function normalizeArtist(a, size = 400) {
  if (!a) return null;
  return {
    id: String(a.id),
    title: a.title || 'Без названия',
    cover: img(a, size),
    description: a.description || '',
  };
}

export function normalizeRelease(r, size = 400) {
  if (!r) return null;
  const artists = Array.isArray(r.artists) ? r.artists.filter((a) => a && a.title) : [];
  return {
    id: String(r.id),
    title: r.title || 'Без названия',
    year: r.date ? String(r.date).slice(0, 4) : '',
    date: r.date || '',
    type: r.type || 'album',
    cover: img(r, size),
    artist: artists.map((a) => a.title).join(', '),
    artistId: artists[0] ? String(artists[0].id) : null,
  };
}

export function pageOf(block, mapper, size) {
  if (!block) return { total: 0, next: null, cursor: null, items: [] };
  return {
    total: (block.page && block.page.total) || 0,
    next: block.page ? block.page.next : null,
    cursor: block.page ? block.page.cursor : null,
    items: (block.items || []).map((x) => mapper(x, size)).filter(Boolean),
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Один GraphQL-запрос к каталогу с ретраем на антибот/5xx. */
export async function gql(env, query, operationName, variables) {
  const token = env.ZVUK_TOKEN;
  if (!token) throw new ApiError(500, 'NO_TOKEN', 'Сервер не настроен.');

  let lastError = null;

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
        lastError = new ApiError(502, 'UPSTREAM_BLOCKED', 'Каталог временно недоступен.', String(response.status));
        if (attempt === 0) { await sleep(450); continue; }
        throw lastError;
      }
      if (!response.ok) {
        throw new ApiError(502, 'UPSTREAM_HTTP', 'Каталог вернул HTTP ' + response.status + '.', text.slice(0, 200));
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError(502, 'UPSTREAM_NOT_JSON', 'Каталог вернул некорректный ответ.', text.slice(0, 160));
      }

      if (Array.isArray(payload.errors) && payload.errors.length) {
        const msg = payload.errors.map((e) => e.message).join('; ');
        const code = payload.errors[0] && payload.errors[0].extensions && payload.errors[0].extensions.code;
        if (code === 'GRAPHQL_VALIDATION_FAILED') {
          throw new ApiError(400, 'BAD_QUERY', 'Некорректный запрос к каталогу.', msg);
        }
        if (/internal error/i.test(msg)) {
          throw new ApiError(404, 'NOT_FOUND', 'В каталоге ничего не найдено.', msg);
        }
        throw new ApiError(502, 'GRAPHQL_ERROR', 'Ошибка каталога: ' + msg, null);
      }

      return payload.data || {};
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'UPSTREAM_BLOCKED' && attempt === 0) { await sleep(450); continue; }
        throw err;
      }
      if (err && err.name === 'AbortError') {
        lastError = new ApiError(504, 'UPSTREAM_TIMEOUT', 'Каталог не ответил вовремя.');
        if (attempt === 0) continue;
        throw lastError;
      }
      lastError = new ApiError(502, 'UPSTREAM_FETCH', 'Не удалось связаться с каталогом.',
        err && err.message ? String(err.message) : null);
      if (attempt === 0) { await sleep(250); continue; }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new ApiError(502, 'UPSTREAM', 'Неизвестная ошибка каталога.');
}

/** Пакетно подтягивает популярные треки и связанных исполнителей для набора артистов. */
export async function fetchArtistsBundle(env, ids, { tracksLimit = 12, relatedLimit = 12, withReleases = true, withRelated = true } = {}) {
  if (!ids.length) return [];
  const data = await gql(env, Q.artist, 'getArtist', {
    ids: ids.slice(0, 10).map(String),
    withReleases,
    withPopTracks: true,
    withDescription: false,
    withRelated,
    releasesLimit: 20,
    tracksLimit,
    relatedLimit,
  });
  return data.getArtists || [];
}

export async function searchTracksFor(env, query, limit = 20) {
  const data = await gql(env, Q.searchTracks, 'searchTracks', { query, limit, cursor: null });
  const block = data.search && data.search.tracks;
  return pageOf(block, normalizeTrack, 300).items;
}

export { CDN_IMAGE_HOST };