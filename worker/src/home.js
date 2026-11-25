/**
 * Витрина главной страницы RH—MUSIC.
 *
 * Что это: общий для всех посетителей музыкальный контент каталога — плейлисты,
 * свежие релизы, исполнители и треки, сгруппированные по жанрам.
 *
 * Почему так: публичный GraphQL каталога не предоставляет отдельного метода
 * «редакционная выдача главной» (проверены доступные корневые поля: есть только
 * search / getTracks / getArtists / getReleases / playlists(ids) / genres(ids)).
 * Поэтому витрина собирается из РЕАЛЬНЫХ объектов каталога: поиск по названию
 * жанра возвращает настоящие плейлисты каталога (включая его собственные
 * редакционные подборки), их обложки берутся из реальных релизов, а даты
 * релизов — из каталога. Ничего не придумывается и не подменяется.
 *
 * Данные общие (не персональные) и кэшируются в D1 на 15 минут.
 */

import { json } from './http.js';
import * as store from './store.js';
import { gql, normalizeTrack, normalizeRelease, normalizeArtist, img } from './zvuk.js';

const SNAPSHOT_KEY = 'home:v1';
const TTL_MS = 15 * 60 * 1000;

/** Жанровые направления витрины. Это музыкальные жанры, а не списки артистов. */
const GENRES = [
  { key: 'rock', title: 'Рок', query: 'рок' },
  { key: 'pop', title: 'Поп', query: 'поп музыка' },
  { key: 'hiphop', title: 'Хип-хоп', query: 'хип-хоп' },
  { key: 'electronic', title: 'Электроника', query: 'электронная музыка' },
  { key: 'indie', title: 'Инди', query: 'инди' },
  { key: 'jazz', title: 'Джаз', query: 'джаз' },
  { key: 'classical', title: 'Классика', query: 'классическая музыка' },
  { key: 'rnb', title: 'R&B и соул', query: 'rnb соул' },
];

const PLAYLIST_FIELDS = `
  id
  title
  description
  duration
  isPublic
  tracks(limit: 1) {
    id
    release { image { src } }
  }
`;

function homeQuery(count) {
  const vars = Array.from({ length: count }, (_, i) => `$q${i}: String!`).join(', ');
  const blocks = Array.from({ length: count }, (_, i) => `
    g${i}: search(query: $q${i}) {
      playlists(limit: 5) { items { id title description duration } }
      releases(limit: 5) { items { id title date type image { src } artists { id title } } }
      artists(limit: 3) { items { id title image { src } } }
      tracks(limit: 6) { items { id title duration explicit artists { id title } release { id title date type image { src } artists { id title } } } }
    }`).join('');
  return `query homeFeed(${vars}) {${blocks} }`;
}

const COVERS_QUERY = `
query playlistCovers($ids: [ID!]!) {
  playlists(ids: $ids) {
    id
    title
    description
    duration
    tracks(limit: 1) {
      id
      release { image { src } }
    }
  }
}`;

export const PLAYLIST_QUERY = `
query catalogPlaylist($id: [ID!]!, $limit: Int) {
  playlists(ids: $id) {
    id
    title
    description
    duration
    isPublic
    tracks(limit: $limit) {
      id
      title
      duration
      explicit
      artists { id title }
      release { id title date type image { src } artists { id title } }
    }
  }
}`;

function dedupeById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || !item.id) continue;
    const id = String(item.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function interleave(groups, limit) {
  const out = [];
  const max = Math.max(0, ...groups.map((g) => g.length));
  for (let round = 0; round < max; round++) {
    for (const group of groups) {
      if (out.length >= limit) return out;
      if (group[round]) out.push(group[round]);
    }
  }
  return out;
}

function playlistCard(p, cover) {
  return {
    id: String(p.id),
    title: p.title || 'Подборка',
    description: p.description || '',
    duration: Number(p.duration) || 0,
    cover: cover || null,
  };
}

/** Собирает витрину из каталога. Два пакетных GraphQL-запроса на всю страницу. */
export async function buildHome(env) {
  const data = await gql(env, homeQuery(GENRES.length), 'homeFeed',
    Object.fromEntries(GENRES.map((genre, index) => ['q' + index, genre.query])));

  const perGenre = [];
  for (let index = 0; index < GENRES.length; index++) {
    const block = data['g' + index] || {};
    perGenre.push({
      genre: GENRES[index],
      playlists: (block.playlists && block.playlists.items) || [],
      releases: (block.releases && block.releases.items) || [],
      artists: (block.artists && block.artists.items) || [],
      tracks: (block.tracks && block.tracks.items) || [],
    });
  }

  const coverIds = [];
  for (const bucket of perGenre) {
    for (const playlist of bucket.playlists.slice(0, 4)) {
      if (playlist && playlist.id) coverIds.push(String(playlist.id));
    }
  }
  let covers = new Map();
  if (coverIds.length) {
    try {
      const coverData = await gql(env, COVERS_QUERY, 'playlistCovers', { ids: [...new Set(coverIds)].slice(0, 24) });
      for (const playlist of coverData.playlists || []) {
        const first = playlist && playlist.tracks && playlist.tracks[0];
        covers.set(String(playlist.id), first ? img(first.release, 400) : null);
      }
    } catch {
      covers = new Map();
    }
  }

  const sections = [];

  // Плейлисты по жанрам — реальные подборки каталога с обложками из их релизов.
  const playlistSections = [];
  for (const bucket of perGenre) {
    const items = bucket.playlists
      .filter((p) => p && p.id && p.title)
      .slice(0, 4)
      .map((p) => playlistCard(p, covers.get(String(p.id)) || null))
      .filter((p) => p.title);
    if (items.length >= 2) {
      playlistSections.push({
        key: 'playlists-' + bucket.genre.key,
        title: 'Плейлисты: ' + bucket.genre.title,
        subtitle: 'Подборки каталога в этом жанре',
        type: 'playlists',
        items,
      });
    }
  }
  sections.push(...playlistSections.slice(0, 4));

  // Новые альбомы — реальные релизы с настоящими датами.
  const releases = dedupeById(perGenre.flatMap((bucket) => bucket.releases.map((r) => normalizeRelease(r, 400))));
  releases.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  if (releases.length >= 4) {
    sections.push({
      key: 'releases',
      title: 'Новые альбомы',
      subtitle: 'Свежие релизы каталога',
      type: 'albums',
      items: releases.slice(0, 14),
    });
  }

  // Исполнители жанров.
  const artists = dedupeById(perGenre.flatMap((bucket) => bucket.artists.map((a) => normalizeArtist(a, 400))));
  if (artists.length >= 4) {
    sections.push({
      key: 'artists',
      title: 'Исполнители',
      subtitle: 'Артисты, которых слушают прямо сейчас',
      type: 'artists',
      items: artists.slice(0, 14),
    });
  }

  // Треки: чередуем жанры, чтобы подборка не была одножанровой.
  const trackGroups = perGenre.map((bucket) => bucket.tracks.map((t) => normalizeTrack(t, 300)).filter(Boolean));
  const tracks = dedupeById(interleave(trackGroups, 16));
  if (tracks.length >= 6) {
    sections.push({
      key: 'tracks',
      title: 'Треки дня',
      subtitle: 'Популярное в жанрах каталога',
      type: 'tracks',
      items: tracks.slice(0, 16),
    });
  }

  const heroPlaylist = sections.find((s) => s.type === 'playlists' && s.items.length)?.items[0] || null;

  return {
    generatedAt: new Date().toISOString(),
    genres: GENRES.map((g) => ({ key: g.key, title: g.title })),
    hero: heroPlaylist,
    sections,
  };
}

/** Общий кэш витрины: память изолята + снимок в D1 (переживает холодный старт). */
let memory = { at: 0, data: null };
let inflight = null;

export async function getHome(env) {
  const now = Date.now();
  if (memory.data && now - memory.at < TTL_MS) return memory.data;

  if (!inflight) {
    inflight = (async () => {
      const snapshot = await store.readHomeSnapshot(env, SNAPSHOT_KEY).catch(() => null);
      if (snapshot && snapshot.payload && now - Date.parse(snapshot.fetchedAt) < TTL_MS) {
        memory = { at: Date.parse(snapshot.fetchedAt), data: snapshot.payload };
        return snapshot.payload;
      }
      const data = await buildHome(env);
      memory = { at: Date.now(), data };
      await store.writeHomeSnapshot(env, SNAPSHOT_KEY, data).catch(() => {});
      return data;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

export async function syncHome(env) {
  const data = await buildHome(env);
  await store.writeHomeSnapshot(env, 'home:v1', data).catch(() => {});
  return data;
}

export async function handleHome(request, env) {
  try {
    const data = await getHome(env);
    return json({ ok: true, ...data }, 200, { 'Cache-Control': 'public, max-age=300' });
  } catch (error) {
    const snapshot = await store.readHomeSnapshot(env, SNAPSHOT_KEY).catch(() => null);
    if (snapshot && snapshot.payload) {
      return json({ ok: true, stale: true, ...snapshot.payload });
    }
    throw error;
  }
}

/** Страница конкретного плейлиста каталога. */
export async function handleCatalogPlaylist(env, id) {
  const data = await gql(env, PLAYLIST_QUERY, 'catalogPlaylist', { id: [String(id)], limit: 100 });
  const playlist = (data.playlists || []).find((item) => item && String(item.id) === String(id));
  if (!playlist) return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Плейлист не найден.' } }, 404);
  const tracks = (playlist.tracks || []).map((t) => normalizeTrack(t, 300)).filter(Boolean);
  return json({
    ok: true,
    playlist: {
      id: String(playlist.id),
      title: playlist.title || 'Плейлист',
      description: playlist.description || '',
      duration: Number(playlist.duration) || 0,
      cover: tracks[0] ? tracks[0].cover : null,
      source: 'catalog',
    },
    tracks,
    total: tracks.length,
  });
}