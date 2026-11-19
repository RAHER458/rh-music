/**
 * Персональные рекомендации RH—MUSIC.
 *
 * Источники сигналов (все — реальные данные конкретного аккаунта):
 *   • user_track_affinity  — прослушивания, длительность, завершения, давность;
 *   • listening_history    — что слушали последним;
 *   • library_tracks       — что сохранили в библиотеку;
 *   • playlist_tracks      — что добавили в свои плейлисты.
 *
 * Никаких заранее заданных списков исполнителей или запросов: для нового
 * пользователя возвращается честное пустое состояние, а недемонстрационные
 * подборки строятся только из его собственной активности.
 *
 * Каталог используется как источник похожих исполнителей (relatedArtists) и
 * релизов — данные подтягиваются пакетно, одним-двумя GraphQL-запросами.
 */

import { json } from './http.js';
import { currentUser } from './auth.js';
import * as store from './store.js';
import { fetchArtistsBundle, normalizeTrack, normalizeRelease } from './zvuk.js';

const CACHE_TTL_MS = 180000;
const cache = new Map();

function daysAgo(iso) {
  if (!iso) return 3650;
  const diff = Date.now() - Date.parse(iso);
  return Number.isFinite(diff) ? Math.max(diff / 86400000, 0) : 3650;
}

function recencyWeight(iso, halfLifeDays = 21) {
  return Math.pow(0.5, daysAgo(iso) / halfLifeDays);
}

function dedupePush(target, seen, track) {
  if (!track || !track.id || seen.has(String(track.id))) return false;
  seen.add(String(track.id));
  target.push(track);
  return true;
}

function interleave(groups, perGroup, limit) {
  const out = [];
  for (let round = 0; round < perGroup; round++) {
    for (const group of groups) {
      if (out.length >= limit) return out;
      if (group[round]) out.push(group[round]);
    }
  }
  return out;
}

/** Считает вес исполнителей по всем сигналам пользователя. */
function scoreArtists(affinity, collections) {
  const scores = new Map();
  for (const row of affinity) {
    const id = String(row.artistId);
    const base = (row.plays || 0) + (row.completions || 0) * 0.6 + (row.seconds || 0) / 900;
    const score = base * recencyWeight(row.lastPlayedAt);
    scores.set(id, (scores.get(id) || 0) + score);
  }
  for (const [id, signal] of collections.entries()) {
    const boost = signal.libraryCount * 1.6 + signal.playlistCount * 1.1;
    scores.set(id, (scores.get(id) || 0) + boost * 0.75);
  }
  return [...scores.entries()]
    .filter(([, score]) => score > 0.35)
    .sort((a, b) => b[1] - a[1]);
}

export async function buildRecommendations(env, user, options = {}) {
  const wantCache = options.cache !== false;
  const [affinity, recent, recentIds, stats, collections, popular] = await Promise.all([
    store.topArtistsByAffinity(env, user.id, 12),
    store.recentHistory(env, user.id, 25),
    store.recentlyPlayedTrackIds(env, user.id, 10, 80),
    store.userHistoryStats(env, user.id),
    store.artistSignalsFromCollections(env, user.id),
    store.globalPopularTracks(env, 20, 5, 30).catch(() => []),
  ]);

  const cacheKey = `${user.id}:${stats.plays}:${recent.length}`;
  if (wantCache) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.data;
  }

  const sections = [];
  const seen = new Set();

  const continueItems = [];
  for (const row of recent) {
    dedupePush(continueItems, seen, {
      id: row.trackId,
      title: row.title || 'Без названия',
      artist: row.artist || '',
      artistId: row.artistId,
      album: row.album || '',
      albumId: row.albumId,
      cover: row.cover,
      duration: row.duration || 0,
      playedAt: row.playedAt,
    });
    if (continueItems.length >= 12) break;
  }
  if (continueItems.length >= 3) {
    sections.push({
      key: 'continue',
      title: 'Продолжить прослушивание',
      subtitle: 'Треки, которые вы слушали недавно',
      type: 'tracks',
      items: continueItems,
    });
  }

  const ranked = scoreArtists(affinity, collections);
  const recentSet = new Set(recentIds.map(String));

  if (ranked.length) {
    const topIds = ranked.slice(0, 5).map(([id]) => id);
    const bundle = await fetchArtistsBundle(env, topIds, { tracksLimit: 14, relatedLimit: 12, withReleases: true })
      .catch(() => []);

    const groupsForYou = [];
    for (const artist of bundle) {
      const tracks = (artist.popularTracks || [])
        .map((t) => normalizeTrack(t, 300))
        .filter((t) => t && !recentSet.has(String(t.id)));
      groupsForYou.push(tracks);
    }
    const forYou = interleave(groupsForYou, 4, 20);
    forYou.forEach((t) => seen.add(String(t.id)));
    if (forYou.length) {
      sections.push({
        key: 'for-you',
        title: 'Для вас',
        subtitle: 'На основе ваших прослушиваний, библиотеки и плейлистов',
        type: 'tracks',
        items: forYou,
      });
    }

    // Похожие: связанные исполнители первого «любимого» артиста.
    const topSet = new Set(topIds);
    const relatedIds = [];
    for (const artist of bundle) {
      for (const related of artist.relatedArtists || []) {
        const id = String(related.id);
        if (!topSet.has(id) && !relatedIds.includes(id)) relatedIds.push(id);
      }
      if (relatedIds.length >= 8) break;
    }

    if (relatedIds.length) {
      const relatedBundle = await fetchArtistsBundle(env, relatedIds.slice(0, 8),
        { tracksLimit: 6, withRelated: false, withReleases: false }).catch(() => []);
      const groups = relatedBundle.map((artist) =>
        (artist.popularTracks || []).map((t) => normalizeTrack(t, 300)).filter(Boolean));
      const similar = [];
      for (const track of interleave(groups, 3, 18)) dedupePush(similar, seen, track);
      if (similar.length >= 4) {
        const seedArtist = bundle[0] ? bundle[0].title : '';
        sections.push({
          key: 'similar',
          title: seedArtist ? `Похоже на ${seedArtist}` : 'Похожие композиции',
          subtitle: 'Исполнители, близкие к тем, кого вы слушаете',
          type: 'tracks',
          items: similar,
        });
      }
    }

    // Новые релизы любимых исполнителей, отсортированные по дате.
    const releases = [];
    for (const artist of bundle) {
      for (const release of artist.releases || []) {
        const normalized = normalizeRelease(release, 400);
        if (normalized) releases.push(normalized);
      }
    }
    releases.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const fresh = [];
    const releaseSeen = new Set();
    for (const release of releases) {
      if (releaseSeen.has(release.id)) continue;
      releaseSeen.add(release.id);
      fresh.push(release);
      if (fresh.length >= 12) break;
    }
    if (fresh.length >= 3) {
      sections.push({
        key: 'releases',
        title: 'Новые релизы',
        subtitle: 'Свежие работы исполнителей из вашей истории',
        type: 'albums',
        items: fresh,
      });
    }
  }

  // Популярное: реальная агрегированная статистика прослушиваний сервиса.
  if (popular.length >= 5) {
    const items = [];
    for (const row of popular) {
      if (seen.has(String(row.id))) continue;
      items.push({
        id: String(row.id),
        title: row.title || 'Без названия',
        artist: row.artist || '',
        artistId: row.artistId,
        album: '',
        albumId: row.albumId,
        cover: row.cover || null,
        duration: 0,
        listeners: row.listeners,
        plays: row.plays,
      });
      if (items.length >= 20) break;
    }
    if (items.length >= 5) {
      sections.push({
        key: 'popular',
        title: 'Популярно на RH—MUSIC',
        subtitle: 'Что чаще всего слушают пользователи сервиса',
        type: 'tracks',
        items,
      });
    }
  }

  const data = {
    personalized: ranked.length > 0,
    stage: (stats.plays || 0) < 3 ? 'new' : 'active',
    plays: stats.plays || 0,
    tracks: stats.tracks || 0,
    sections,
  };

  if (wantCache) {
    cache.set(cacheKey, { time: Date.now(), data });
    if (cache.size > 500) cache.clear();
  }
  return data;
}

export async function handleRecommendations(request, env) {
  const user = await currentUser(request, env);
  if (!user) {
    return json({
      ok: true,
      personalized: false,
      stage: 'guest',
      plays: 0,
      tracks: 0,
      sections: [],
    });
  }
  const data = await buildRecommendations(env, user);
  return json({ ok: true, ...data });
}