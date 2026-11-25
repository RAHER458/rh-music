/**
 * «Моя волна» — персональный поток RH—MUSIC.
 *
 * Публичный GraphQL Zvuk не предоставляет отдельного метода «Мой поток»,
 * поэтому поток собирается из реальных поисковых выдач каталога по жанрам,
 * языку и настроению, с ранжированием и защитой от повторов. Если каталог
 * временно недоступен, используется уже сохранённый снимок главной D1.
 */

import { json } from './http.js';
import { searchTracksFor, gql, normalizeTrack } from './zvuk.js';
import { PLAYLIST_QUERY } from './home.js';
import { readHomeSnapshot } from './store.js';
import { searchSoundCloud } from './soundcloud.js';

const GENRE_QUERIES = {
  classic: { label: 'Классика', query: 'классическая музыка' },
  ambient: { label: 'Эмбиент', query: 'эмбиент' },
  electronic: { label: 'Электроника', query: 'электронная музыка' },
  folk: { label: 'Фолк', query: 'фолк музыка' },
  hip_hop: { label: 'Хип-хоп', query: 'хип-хоп' },
  indie: { label: 'Инди', query: 'инди музыка' },
  instrumental: { label: 'Инструментал', query: 'инструментальная музыка' },
  metal: { label: 'Метал', query: 'метал музыка' },
  pop: { label: 'Поп', query: 'поп музыка' },
  rock: { label: 'Рок', query: 'рок музыка' },
  soundtrack: { label: 'Саундтреки', query: 'саундтреки' },
};

function langWord(language) {
  if (language === 'russian') return 'русский';
  if (language === 'foreign') return 'зарубежный';
  if (language === 'voiceless') return 'инструментал';
  return '';
}

function moodWords(mood) {
  const energy = Number(mood && mood.energy);
  const fun = Number(mood && mood.fun);
  const words = [];
  if (Number.isFinite(energy) && energy >= 0.66) words.push('энергичная');
  else if (Number.isFinite(energy) && energy <= 0.34) words.push('спокойная');
  if (Number.isFinite(fun) && fun >= 0.66) words.push('веселая');
  else if (Number.isFinite(fun) && fun <= 0.34) words.push('грустная');
  return words;
}

function isRussian(text) {
  return /[А-Яа-яЁё]/.test(text);
}

function matchesLanguage(track, language) {
  if (!language || language === 'all') return true;
  const text = `${track.title || ''} ${track.artist || ''}`;
  if (language === 'russian') return isRussian(text);
  if (language === 'foreign') return !isRussian(text);
  if (language === 'voiceless') return /instrumental|инструментал/i.test(text);
  return true;
}

function scoreTrack(track, { genres, language, popularity, mood }) {
  let score = 100;
  const text = `${track.title || ''} ${track.artist || ''}`.toLowerCase();
  for (const genre of genres) {
    const item = GENRE_QUERIES[genre];
    if (item && (text.includes(item.label.toLowerCase()) || text.includes(item.query.split(' ')[0]))) score += 8;
  }
  if (language === 'russian' && isRussian(text)) score += 10;
  if (language === 'foreign' && !isRussian(text)) score += 10;
  if (language === 'voiceless' && /instrumental|инструментал/i.test(text)) score += 12;
  const energy = Number(mood && mood.energy);
  const fun = Number(mood && mood.fun);
  if (Number.isFinite(energy) && energy >= 0.66 && /энерг|dance|club|rock|metal|techno|house/i.test(text)) score += 8;
  if (Number.isFinite(energy) && energy <= 0.34 && /acoustic|ambient|calm|piano|lo-?fi|спокой/i.test(text)) score += 8;
  if (Number.isFinite(fun) && fun <= 0.34 && /sad|груст|melanch|slow/i.test(text)) score += 6;
  if (Number.isFinite(fun) && fun >= 0.66 && /happy|весел|dance|pop/i.test(text)) score += 6;
  const rank = Number(track._popularityRank) || 0;
  if (popularity === 2) score += Math.max(0, 12 - rank * 0.25);
  else if (popularity === 0) score += Math.min(12, rank * 0.25);
  else score += 4;
  return score;
}

function cachedTracks(snapshot) {
  const out = [];
  const seen = new Set();
  for (const section of (snapshot && snapshot.sections) || []) {
    for (const item of section.items || []) {
      if (!item || !item.id || !item.title || !item.artist) continue;
      const id = String(item.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        ...item,
        id,
        source: item.source || 'zvuk',
        streamKind: item.streamKind || 'progressive',
        sectionKey: section.key,
        sectionTitle: section.title,
      });
    }
  }
  return out;
}

function dedupe(items, exclude) {
  const blocked = new Set((exclude || []).map(String));
  const seen = new Set();
  const out = [];
  for (const track of items || []) {
    if (!track || !track.id || !track.title || !track.artist) continue;
    const id = String(track.id);
    if (blocked.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(track);
  }
  return out;
}

const WAVE_PLAYLISTS = `
query wavePlaylists($query: String, $limit: Int = 5) {
  search(query: $query) {
    playlists(limit: $limit) { items { id title } }
  }
}`;

const GENERIC_TITLE = /^(хип[- ]?хоп|рок|поп|метал|фолк|инди|эмбиент|классика|саундтреки|инструментал|electronic|rock|pop|hip[- ]?hop)(\s+музыка)?$/i;

async function genrePlaylistTracks(env, genre) {
  const label = GENRE_QUERIES[genre].label.toLowerCase();
  const snapshot = await readHomeSnapshot(env, 'popular:v1').catch(() => null);
  const editorial = [];
  for (const section of (snapshot && snapshot.payload && snapshot.payload.sections) || []) {
    if (section.type !== 'playlists') continue;
    for (const item of section.items || []) {
      const title = String(item.title || '').toLowerCase();
      if (title.includes(label) && !editorial.includes(String(item.id))) editorial.push(String(item.id));
    }
  }
  let ids = editorial.slice(0, 5);
  if (!ids.length) {
    const found = await gql(env, WAVE_PLAYLISTS, 'wavePlaylists', { query: GENRE_QUERIES[genre].query, limit: 6 });
    ids = ((found.search && found.search.playlists && found.search.playlists.items) || [])
      .map((item) => String(item.id)).filter(Boolean).slice(0, 4);
  }
  if (!ids.length) return [];
  const data = await gql(env, PLAYLIST_QUERY, 'catalogPlaylist', { id: ids, limit: 100 });
  const out = [];
  let rank = 0;
  for (const playlist of data.playlists || []) {
    for (const raw of playlist.tracks || []) {
      const track = normalizeTrack(raw, 300);
      if (!track) continue;
      track._genre = genre;
      track._playlist = playlist.title;
      track._popularityRank = rank++;
      out.push(track);
    }
  }
  return out;
}

async function moodPlaylistTracks(env, words) {
  if (!words.length) return [];
  const found = await gql(env, WAVE_PLAYLISTS, 'wavePlaylists', { query: words[0] + ' музыка', limit: 4 });
  const ids = ((found.search && found.search.playlists && found.search.playlists.items) || [])
    .map((item) => String(item.id)).filter(Boolean).slice(0, 3);
  if (!ids.length) return [];
  const data = await gql(env, PLAYLIST_QUERY, 'catalogPlaylist', { id: ids, limit: 80 });
  const out = [];
  let rank = 0;
  for (const playlist of data.playlists || []) {
    for (const raw of playlist.tracks || []) {
      const track = normalizeTrack(raw, 300);
      if (!track) continue;
      track._popularityRank = rank++;
      out.push(track);
    }
  }
  return out;
}

export async function handleWave(request, env) {
  const body = await request.json().catch(() => ({}));
  const genres = Array.isArray(body.genres) ? body.genres.filter((g) => GENRE_QUERIES[g]).slice(0, 4) : [];
  const language = ['all', 'russian', 'foreign', 'voiceless'].includes(body.language) ? body.language : 'all';
  const popularity = [0, 1, 2].includes(Number(body.popularity)) ? Number(body.popularity) : 1;
  const mood = body.mood && typeof body.mood === 'object' ? body.mood : {};
  const exclude = Array.isArray(body.exclude) ? body.exclude.slice(0, 200) : [];
  const excludeArtists = Array.isArray(body.excludeArtists) ? body.excludeArtists.map((x) => String(x).toLowerCase()).slice(0, 40) : [];
  const page = Math.max(0, Math.min(20, Number(body.page) || 0));
  const limit = Math.max(5, Math.min(30, Number(body.limit) || 20));

  const selected = genres.length ? genres : ['pop', 'hip_hop', 'electronic', 'rock'].slice(0, 4);
  const words = [...moodWords(mood), langWord(language)].filter(Boolean);
  const queries = selected.map((genre) => [GENRE_QUERIES[genre].query, ...words].join(' ').trim());
  const collected = [];

  try {
    // Основной источник — реальные треки жанровых плейлистов Zvuk, а не
    // буквальные поисковые совпадения вроде песни с названием «ХИП-ХОП».
    const playlistPages = await Promise.all(selected.map((genre) => genrePlaylistTracks(env, genre).catch((error) => { debug.push({ genre, error: String(error && error.message || error) }); return []; })));
    for (const items of playlistPages) collected.push(...items);
    // Дополнительный источник — поиск по жанру; нужен, если плейлисты пусты.
    if (collected.length < limit) {
      const pages = await Promise.all(queries.map(async (query) => {
        const items = await searchTracksFor(env, query, Math.min(30, limit + 20));
        return items.map((item) => ({ ...item, _query: query }));
      }));
      for (const items of pages) collected.push(...items);
    }
  } catch (error) {
    // Каталог Zvuk может быть временно недоступен (401/таймаут). Волна не
    // должна падать: сначала пробуем живой SoundCloud по тем же запросам,
    // затем последний снимок главной. Так поток остаётся играбельным.
    for (const query of selected.map((genre) => GENRE_QUERIES[genre].query)) {
      try {
        const page = await searchSoundCloud(env, query, { limit: Math.min(15, limit) });
        if (page.items.length) collected.push(...page.items);
      } catch { /* пробуем следующий запрос */ }
    }
    if (!collected.length) {
      const snapshot = await readHomeSnapshot(env, 'home:v1').catch(() => null);
      const fallback = cachedTracks(snapshot && snapshot.payload).filter((track) => matchesLanguage(track, language));
      collected.push(...fallback);
    }
  }

  const ranked = dedupe(collected, exclude)
    .filter((track) => !GENERIC_TITLE.test(String(track.title || '').trim()))
    .filter((track) => matchesLanguage(track, language))
    .filter((track) => !excludeArtists.some((artist) => String(track.artist || '').toLowerCase().includes(artist)))
    .map((track) => ({ track, score: scoreTrack(track, { genres, language, popularity, mood }) }))
    .sort((a, b) => b.score - a.score)
    .filter(({ track }, index, all) => {
      // Не более двух треков одного исполнителя и одного названия в батче.
      const artist = String(track.artist || '').toLowerCase();
      const title = String(track.title || '').trim().toLowerCase();
      const before = all.slice(0, index);
      const sameArtist = before.filter((row) => String(row.track.artist || '').toLowerCase() === artist).length;
      const sameTitle = before.filter((row) => String(row.track.title || '').trim().toLowerCase() === title).length;
      return sameArtist < 2 && sameTitle === 0;
    })
    .map(({ track }) => {
      const clean = { ...track };
      delete clean._query;
      delete clean._genre;
      delete clean._playlist;
      delete clean._popularityRank;
      delete clean.sectionKey;
      delete clean.sectionTitle;
      return clean;
    });

  // popularity: высокие — начало выдачи, низкие — более глубокие позиции.
  let pool = ranked;
  if (popularity === 0) pool = ranked.slice().reverse();
  else if (popularity === 1) pool = ranked.slice(Math.min(2, ranked.length));
  const offset = (page * limit) % Math.max(1, pool.length);
  const batch = pool.slice(offset, offset + limit);
  if (batch.length < limit && pool.length > batch.length) {
    batch.push(...pool.slice(0, Math.max(0, limit - batch.length)));
  }

  return json({
    ok: true,
    items: batch,
    settings: { genres, language, popularity, mood, page },
    total: ranked.length,
  });
}
