/**
 * Вкладка «Популярное» Zvuk.com.
 *
 * Источник — публичный грид Zvuk: /api/tiny/grid?name=popular_music_web.
 * Структура и порядок блоков сохраняются как у Zvuk; метаданные карточек
 * резолвятся через уже используемый GraphQL-клиент каталога.
 *
 * Снапшот складывается в D1 (home_snapshot) и обновляется Cron Trigger.
 */

import { json } from './http.js';
import * as store from './store.js';
import { gql, normalizeTrack, normalizeRelease, normalizeArtist, img, Q } from './zvuk.js';
import { PLAYLIST_QUERY } from './home.js';

const GRID_NAME = 'popular_music_web';
const SNAPSHOT_KEY = 'popular:v1';
const TTL_MS = 6 * 60 * 60 * 1000;

const GRID_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Origin': 'https://zvuk.com',
  'Referer': 'https://zvuk.com/popular',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

function slug(value) {
  return String(value || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'section';
}

function uniqueIds(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const id = String(item && item.id);
    if (!id || id === 'undefined' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function fetchGrid() {
  const url = 'https://zvuk.com/api/tiny/grid?name=' + encodeURIComponent(GRID_NAME);
  // Zvuk выдаёт 307 на тот же URL с cookie spid/spsc: без cookie каждый
  // следующий запрос снова редиректится и Worker получает too many redirects.
  const first = await fetch(url, { headers: GRID_HEADERS, redirect: 'manual' });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const cookies = (first.headers.get('set-cookie') || '')
      .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
      .map((cookie) => cookie.trim().split(';')[0])
      .filter(Boolean)
      .join('; ');
    if (!cookies) throw new Error('Zvuk grid: нет cookie для повторного запроса');
    res = await fetch(url, { headers: { ...GRID_HEADERS, Cookie: cookies }, redirect: 'follow' });
  }
  if (!res.ok) throw new Error('Zvuk grid HTTP ' + res.status);
  const body = await res.json();
  const sections = body && body.result && body.result.page && body.result.page.sections;
  if (!Array.isArray(sections)) throw new Error('Zvuk grid: нет sections');
  return sections.filter((s) => s && s.enabled !== false);
}

async function resolvePlaylists(env, ids) {
  if (!ids.length) return new Map();
  try {
    const data = await gql(env, PLAYLIST_QUERY, 'catalogPlaylist', { id: ids, limit: 1 });
    const map = new Map();
    for (const p of data.playlists || []) {
      if (!p) continue;
      const first = (p.tracks || [])[0];
      map.set(String(p.id), {
        id: String(p.id),
        title: p.title || 'Подборка',
        description: p.description || '',
        duration: Number(p.duration) || 0,
        cover: first ? img(first.release, 400) : null,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

async function resolveReleases(env, ids) {
  if (!ids.length) return new Map();
  try {
    const data = await gql(env, Q.release, 'getRelease', { ids });
    const map = new Map();
    for (const r of data.getReleases || []) {
      const item = normalizeRelease(r, 400);
      if (item) map.set(String(item.id), item);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function resolveArtists(env, ids) {
  if (!ids.length) return new Map();
  try {
    const data = await gql(env, Q.artist, 'getArtist', {
      ids,
      withReleases: false,
      withPopTracks: false,
      withDescription: false,
      withRelated: false,
      releasesLimit: 1,
      tracksLimit: 1,
      relatedLimit: 1,
    });
    const map = new Map();
    for (const a of data.getArtists || []) {
      const item = normalizeArtist(a, 400);
      if (item) map.set(String(item.id), item);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function resolvePlaylistTracks(env, id) {
  try {
    const data = await gql(env, PLAYLIST_QUERY, 'catalogPlaylist', { id: [String(id)], limit: 60 });
    const p = (data.playlists || []).find((x) => x && String(x.id) === String(id));
    if (!p) return null;
    const items = (p.tracks || []).map((t) => normalizeTrack(t, 300)).filter(Boolean);
    return {
      id: String(p.id),
      title: p.title || 'Подборка',
      description: p.description || '',
      duration: Number(p.duration) || 0,
      items,
    };
  } catch {
    return null;
  }
}

/** Собирает структуру вкладки «Популярное» в форме sections RH—MUSIC. */
export async function buildPopular(env) {
  const grid = await fetchGrid();
  const playlistIds = [];
  const releaseIds = [];
  const artistIds = [];

  for (const section of grid) {
    if (section.type === 'listing') {
      const type = (section.data || [])[0] && section.data[0].type;
      const ids = uniqueIds(section.data || []);
      if (type === 'playlist') playlistIds.push(...ids);
      else if (type === 'release') releaseIds.push(...ids);
      else if (type === 'artist') artistIds.push(...ids);
    } else if (section.type === 'content') {
      const first = (section.data || [])[0];
      if (first && first.type === 'playlist') playlistIds.push(String(first.id));
    }
  }

  const [playlists, releases, artists] = await Promise.all([
    resolvePlaylists(env, uniqueIds(playlistIds.map((id) => ({ id })))),
    resolveReleases(env, uniqueIds(releaseIds.map((id) => ({ id })))),
    resolveArtists(env, uniqueIds(artistIds.map((id) => ({ id })))),
  ]);

  const sections = [];
  let hero = null;

  for (const [index, section] of grid.entries()) {
    if (section.type === 'banner') {
      const message = (section.messages || [])[0] || {};
      const actions = (section.actions || []).map((a) => ({ title: a.title, url: a.action && a.action.url }));
      if (message.title || actions.length) {
        sections.push({
          key: 'banner-' + index,
          type: 'banner',
          title: message.title || 'Подборки',
          subtitle: message.detail || '',
          cover: message.image || null,
          actions,
        });
      }
      continue;
    }

    if (section.type === 'content') {
      const first = (section.data || [])[0];
      if (!first || first.type !== 'playlist') continue;
      const playlist = await resolvePlaylistTracks(env, first.id);
      if (!playlist || !playlist.items.length) continue;
      if (!hero) hero = { id: playlist.id, title: playlist.title, description: playlist.description, cover: playlist.items[0].cover };
      sections.push({
        key: slug('content-' + first.id),
        type: 'tracks',
        title: playlist.title,
        subtitle: playlist.description || 'Популярное на Zvuk',
        items: playlist.items,
      });
      continue;
    }

    if (section.type !== 'listing') continue;
    const header = section.header || {};
    const title = header.title || 'Популярное';
    const ids = uniqueIds(section.data || []);
    const first = (section.data || [])[0] || {};
    let items = [];
    let type = null;

    if (first.type === 'playlist') {
      items = ids.map((id) => playlists.get(id)).filter(Boolean);
      type = 'playlists';
    } else if (first.type === 'release') {
      items = ids.map((id) => releases.get(id)).filter(Boolean);
      type = 'albums';
    } else if (first.type === 'artist') {
      items = ids.map((id) => artists.get(id)).filter(Boolean);
      type = 'artists';
    }
    if (!items.length) continue;
    sections.push({
      key: slug(section.content && section.content.list || section.UUID || title + index),
      type,
      title,
      subtitle: section.content && section.content.list ? '' : 'Популярное на Zvuk',
      items,
    });
  }

  return { sections, hero, source: 'zvuk-popular', fetchedAt: new Date().toISOString() };
}

/** Читает снимок из D1; при отсутствии/устаревании собирает заново. */
export async function getPopular(env, { force = false } = {}) {
  const snapshot = await store.readHomeSnapshot(env, SNAPSHOT_KEY).catch(() => null);
  const age = snapshot ? Date.now() - Date.parse(snapshot.fetchedAt) : Infinity;
  if (!force && snapshot && snapshot.payload && age < TTL_MS) return snapshot.payload;
  try {
    const built = await buildPopular(env);
    await store.writeHomeSnapshot(env, SNAPSHOT_KEY, built).catch(() => {});
    return built;
  } catch (error) {
    if (snapshot && snapshot.payload) return { ...snapshot.payload, stale: true };
    throw error;
  }
}

export async function handlePopular(env) {
  try {
    const data = await getPopular(env);
    return json({ ok: true, ...data }, 200, { 'Cache-Control': 'public, max-age=300' });
  } catch (error) {
    const snapshot = await store.readHomeSnapshot(env, SNAPSHOT_KEY).catch(() => null);
    if (snapshot && snapshot.payload) return json({ ok: true, stale: true, ...snapshot.payload });
    throw error;
  }
}

export async function syncPopular(env) {
  const built = await buildPopular(env);
  await store.writeHomeSnapshot(env, SNAPSHOT_KEY, built);
  return built;
}
