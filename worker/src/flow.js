/**
 * RH—MUSIC Flow — непрерывный музыкальный поток главной страницы.
 *
 * Источник треков — только реальный каталог Zvuk (GraphQL searchTracks).
 * Для авторизованного пользователя сначала добавляются треки из его
 * собственных рекомендаций (история, библиотека, плейлисты), затем — подборки
 * по выбранным настроениям, жанрам и сценариям.
 */

import { ApiError, json } from './http.js';
import { currentUser } from './auth.js';
import { searchTracksFor } from './zvuk.js';
import { buildRecommendations } from './recommend.js';

const CACHE_TTL_MS = 60 * 1000;
const MAX_QUERIES = 8;
const MAX_TRACKS = 40;
const cache = new Map();

export const MOOD_QUERIES = {
  happy: 'весёлая позитивная музыка',
  sad: 'грустная музыка',
  energetic: 'энергичная быстрая музыка',
  calm: 'спокойная расслабляющая музыка',
  romantic: 'романтические песни',
  drive: 'мощная драйвовая музыка',
  focus: 'музыка для концентрации',
  melancholy: 'меланхоличная атмосферная музыка',
  party: 'танцевальная музыка вечеринка',
  road: 'музыка для дороги',
  workout: 'музыка для тренировки',
  nostalgia: 'любимые хиты прошлых лет',
  new: 'новые релизы новые исполнители',
  instrumental: 'инструментальная музыка без слов',
};

export const GENRE_QUERIES = {
  pop: 'поп музыка',
  rock: 'рок',
  rap: 'рэп',
  hiphop: 'хип-хоп',
  electronic: 'электронная музыка',
  edm: 'edm танцевальная музыка',
  rnb: 'rnb соул',
  jazz: 'джаз',
  classical: 'классическая музыка',
  metal: 'метал',
  indie: 'инди',
  alternative: 'альтернативная музыка',
  russian: 'русская музыка',
  foreign: 'зарубежная музыка',
};

export const PREF_QUERIES = {
  familiar: 'знакомые хиты',
  fresh: 'новые исполнители',
  popular: 'популярные треки',
  rare: 'редкие композиции',
  lovedArtists: '',
  lessRepetition: '',
  instrumental: 'инструментальная музыка',
};

export const SCENARIO_QUERIES = {
  work: 'музыка для работы',
  study: 'музыка для учёбы',
  rest: 'музыка для отдыха',
  sleep: 'музыка для сна',
  walk: 'музыка для прогулки',
  trip: 'музыка для поездки',
  workout: 'музыка для тренировки',
  party: 'музыка для вечеринки',
};

export function listParam(value) {
  return String(value == null ? '' : value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

/** Собирает текстовые запросы потока из настроений, жанров, настроек и сценариев. */
export function buildFlowQueries(selection = {}) {
  const queries = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !queries.includes(text)) queries.push(text);
  };
  for (const key of selection.moods || []) push(MOOD_QUERIES[key]);
  for (const key of selection.genres || []) push(GENRE_QUERIES[key]);
  for (const key of selection.prefs || []) push(PREF_QUERIES[key]);
  for (const key of selection.scenarios || []) push(SCENARIO_QUERIES[key]);
  if (selection.prefs && selection.prefs.includes('fresh')) {
    for (let i = 0; i < queries.length; i += 1) queries[i] = `${queries[i]} новинки`;
  }
  return queries.slice(0, MAX_QUERIES);
}

function interleave(groups, limit) {
  const out = [];
  const max = Math.max(0, ...groups.map((group) => group.length));
  for (let round = 0; round < max; round += 1) {
    for (const group of groups) {
      if (out.length >= limit) return out;
      if (group[round]) out.push(group[round]);
    }
  }
  return out;
}

function dedupe(tracks, limit) {
  const seen = new Set();
  const out = [];
  for (const track of tracks) {
    if (!track || !track.id) continue;
    const id = String(track.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(track);
    if (out.length >= limit) break;
  }
  return out;
}

function cacheKey(selection, userId) {
  return [userId || 'guest', selection.moods.join(','), selection.genres.join(','),
    selection.prefs.join(','), selection.scenarios.join(',')].join('|');
}

export async function buildFlow(request, env, selection) {
  const user = await currentUser(request, env).catch(() => null);
  const key = cacheKey(selection, user && user.id);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.data;

  const queries = buildFlowQueries(selection);
  const personal = [];
  if (user) {
    try {
      const recommendations = await buildRecommendations(env, user, { cache: false });
      for (const section of recommendations.sections || []) {
        for (const track of section.items || []) {
          if (track && track.id) personal.push(track);
          if (personal.length >= 16) break;
        }
        if (personal.length >= 16) break;
      }
    } catch { /* персональный сигнал не критичен */ }
  }

  const results = await Promise.all(queries.map(async (query) => {
    try {
      return await searchTracksFor(env, query, 20);
    } catch {
      return [];
    }
  }));

  const catalog = interleave(results, 28).map((track) => track);
  const tracks = dedupe([...personal, ...catalog], MAX_TRACKS);
  if (!tracks.length) {
    throw new ApiError(502, 'FLOW_UNAVAILABLE', 'Не удалось собрать поток. Попробуйте ещё раз.');
  }

  const data = {
    ok: true,
    personalized: !!user,
    stage: user ? 'personal' : 'guest',
    moods: selection.moods,
    genres: selection.genres,
    prefs: selection.prefs,
    scenarios: selection.scenarios,
    tracks,
    total: tracks.length,
    generatedAt: new Date().toISOString(),
  };
  cache.set(key, { time: Date.now(), data });
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return data;
}

export async function handleFlow(request, env, url) {
  const selection = {
    moods: listParam(url.searchParams.get('moods')),
    genres: listParam(url.searchParams.get('genres')),
    prefs: listParam(url.searchParams.get('prefs')),
    scenarios: listParam(url.searchParams.get('scenarios')),
  };
  if (!selection.moods.length && !selection.genres.length && !selection.scenarios.length) {
    selection.moods = ['happy'];
  }
  const data = await buildFlow(request, env, selection);
  return json(data, 200, { 'Cache-Control': 'private, max-age=30' });
}
