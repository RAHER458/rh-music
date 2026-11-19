/**
 * Тексты песен: источники, нормализация и кеш.
 *
 * Приоритет источников:
 *   1. Zvuk  — тот же каталог, что и стриминг. Текст отдаёт tiny-API
 *      `GET https://zvuk.com/api/tiny/lyrics?track_id=…` в виде
 *      `{ result: { lyrics, type, translation } }`, где `type = "subtitle"` —
 *      LRC с таймкодами, `type = "lyrics"` — обычный текст.
 *      GraphQL-поле `lyrics` — это Boolean-признак наличия, а не текст.
 *      Tiny-API перед ответом делает redirect и ставит cookie (антибот),
 *      поэтому запрос идёт вручную с переносом cookie между хопами.
 *   2. LRCLIB — `GET https://lrclib.net/api/get` (точное совпадение по
 *      названию/исполнителю/альбому/длительности) и `/api/search` с
 *      последующей строгой проверкой версии и длительности.
 *
 * Наружу отдаётся единый формат, не зависящий от источника. Обычный текст
 * никогда не смешивается с синхронизированными строками и не выдаётся за них.
 * Токен Zvuk берётся только из секрета окружения и никогда не покидает Worker.
 */

import { ApiError, json } from './http.js';
import { gql } from './zvuk.js';

const ZVUK_TINY_URL = 'https://zvuk.com/api/tiny/lyrics';
const LRCLIB_BASE = 'https://lrclib.net/api';
const USER_AGENT = 'RH-MUSIC/2.5.0 (https://rh-music.pages.dev; lyrics)';
const ZVUK_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const ZVUK_TIMEOUT_MS = 7000;
const LRCLIB_TIMEOUT_MS = 6000;

const TTL_FOUND_SECONDS = 7 * 24 * 60 * 60;
const TTL_MISS_SECONDS = 24 * 60 * 60;
const CLIENT_MAX_AGE = 300;
const MEMO_LIMIT = 300;

const TIME_TAG = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>/g;
const META_TAG = /^\[([A-Za-z][A-Za-z0-9_-]*):(.*)\]$/;

/* ───────────────────────────── парсер LRC ───────────────────────────── */

function secondsOf(minutes, seconds, fraction) {
  const frac = fraction ? Number(`0.${fraction}`) : 0;
  return Number(minutes) * 60 + Number(seconds) + frac;
}

function parseWordTags(raw, lineTimeSeconds) {
  const text = raw.trim();
  WORD_TAG.lastIndex = 0;
  if (!WORD_TAG.test(text)) return { text, words: null };
  WORD_TAG.lastIndex = 0;

  const words = [];
  let plain = '';
  let lastIndex = 0;
  let lastTime = lineTimeSeconds;
  let match;
  while ((match = WORD_TAG.exec(text))) {
    const chunk = text.slice(lastIndex, match.index);
    if (chunk.trim()) {
      words.push({ t: Math.round(lastTime * 1000), text: chunk.trim() });
      plain += chunk;
    }
    lastTime = secondsOf(match[1], match[2], match[3]);
    lastIndex = WORD_TAG.lastIndex;
  }
  const tail = text.slice(lastIndex);
  if (tail.trim()) {
    words.push({ t: Math.round(lastTime * 1000), text: tail.trim() });
    plain += tail;
  }
  return { text: plain.trim(), words: words.length > 1 ? words : null };
}

/**
 * Разбирает LRC в отсортированный список строк.
 *
 * Поддерживает: `[mm:ss.xx]`, `[mm:ss.xxx]`, `[mm:ss]`, `[mm:ss:xx]`,
 * несколько меток на строке, метаданные `[ti:…]`, `[offset:…]`,
 * расширенный LRC с `<mm:ss.xx>` (word-level), мусорные строки.
 *
 * `offset` применяется как сдвиг: положительный означает, что текст
 * показывается позже (клиент ищет строку по `currentTime - offset`).
 */
export function parseLrc(input) {
  const result = { offsetMs: 0, lines: [], meta: {} };
  if (typeof input !== 'string' || !input.trim()) return result;

  const entries = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Чистая метастрока: [ti:Название], [offset:500] и т. п.
    if (!TIME_TAG.test(trimmed)) {
      TIME_TAG.lastIndex = 0;
      const meta = trimmed.match(META_TAG);
      if (meta) {
        const key = meta[1].toLowerCase();
        const value = meta[2].trim();
        if (key === 'offset') {
          const offset = Number(value);
          if (Number.isFinite(offset)) result.offsetMs = Math.round(offset);
        } else {
          result.meta[key] = value;
        }
        continue;
      }
      continue;
    }
    TIME_TAG.lastIndex = 0;

    const times = [];
    let rest = trimmed;
    let leading;
    while ((leading = rest.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/))) {
      times.push(secondsOf(leading[1], leading[2], leading[3]));
      rest = rest.slice(leading[0].length);
    }
    if (!times.length) continue;

    const { text, words } = parseWordTags(rest, times[0]);
    if (!text) continue;

    for (const time of times) {
      entries.push({ t: Math.round(time * 1000), text, words: words ? words.slice() : null });
    }
  }

  entries.sort((a, b) => a.t - b.t);

  // Дубликаты (одинаковое время и текст) схлопываем: они не несут смысла.
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.t}\u0000${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.lines.push(entry);
  }
  return result;
}

/** Убирает технический мусор и проставляет конец строки. */
export function normalizeLines(lines) {
  const cleaned = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || !Number.isFinite(line.t)) continue;
    const text = String(line.text || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Строки из точек/многоточия — типичная заглушка вместо текста.
    if (!text || /^[.\s·•…\-–—]+$/.test(text)) continue;
    const entry = { t: Math.max(0, Math.round(line.t)), text };
    if (Array.isArray(line.words) && line.words.length) {
      entry.words = line.words
        .filter((word) => word && Number.isFinite(word.t) && String(word.text || '').trim())
        .map((word) => ({ t: Math.max(0, Math.round(word.t)), text: String(word.text).trim() }));
      if (entry.words.length < 2) delete entry.words;
    }
    cleaned.push(entry);
  }
  cleaned.sort((a, b) => a.t - b.t);
  // Повторяющиеся строки (одно время и тот же текст) не несут смысла.
  for (let i = cleaned.length - 1; i > 0; i -= 1) {
    if (cleaned[i].t === cleaned[i - 1].t && cleaned[i].text === cleaned[i - 1].text) cleaned.splice(i, 1);
  }
  for (let i = 0; i < cleaned.length; i += 1) {
    if (i + 1 < cleaned.length && cleaned[i + 1].t > cleaned[i].t) {
      cleaned[i].end = cleaned[i + 1].t;
    }
  }
  return cleaned;
}

/* ───────────────────────────── источники ───────────────────────────── */

function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }
}

function readSetCookie(response) {
  let list = [];
  try {
    if (typeof response.headers.getSetCookie === 'function') list = response.headers.getSetCookie();
  } catch { /* ignore */ }
  if (!list.length) {
    const raw = response.headers.get('set-cookie');
    // Expires содержит запятую, поэтому режем только перед «name=».
    if (raw) list = raw.split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
  }
  return list
    .map((cookie) => String(cookie).split(';')[0].trim())
    .filter((cookie) => cookie.includes('='))
    .join('; ');
}

let zvukCookie = '';

/**
 * Запрос к tiny-API Zvuk с ручной обработкой антибот-редиректа.
 * Возвращает `{ status, data }`, где status: ok | none | error.
 */
async function fetchZvukLyrics(env, trackId) {
  const token = env && env.ZVUK_TOKEN;
  if (!token) return { status: 'error', reason: 'no_token' };

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Origin': 'https://zvuk.com',
    'Referer': 'https://zvuk.com/',
    'User-Agent': ZVUK_BROWSER_UA,
    'X-Auth-Token': token,
  };

  let url = `${ZVUK_TINY_URL}?track_id=${encodeURIComponent(trackId)}`;
  let cookie = zvukCookie;

  for (let hop = 0; hop < 3; hop += 1) {
    let response;
    try {
      response = await fetch(url, {
        headers: cookie ? { ...headers, Cookie: cookie } : headers,
        redirect: 'manual',
        signal: timeoutSignal(ZVUK_TIMEOUT_MS),
      });
    } catch (error) {
      return { status: 'error', reason: 'network', detail: String((error && error.message) || error) };
    }

    if (response.status >= 300 && response.status < 400) {
      const nextCookie = readSetCookie(response);
      if (nextCookie) {
        cookie = nextCookie;
        zvukCookie = nextCookie;
      }
      const location = response.headers.get('location');
      if (!location) return { status: 'error', reason: 'redirect' };
      url = new URL(location, url).toString();
      continue;
    }

    if (response.status === 200) {
      let body;
      try {
        body = await response.json();
      } catch {
        return { status: 'error', reason: 'bad_json' };
      }
      const result = (body && body.result) || body || {};
      const lyrics = typeof result.lyrics === 'string' ? result.lyrics : '';
      const type = typeof result.type === 'string' ? result.type : '';
      if (!lyrics.trim()) return { status: 'none' };
      if (type === 'subtitle') {
        const parsed = parseLrc(lyrics);
        const lines = normalizeLines(parsed.lines);
        if (lines.length) return { status: 'ok', syncLevel: 'line', lines, offsetMs: parsed.offsetMs };
        // Таймкодов нет или они битые — показываем как обычный текст, но
        // только если это действительно текст, а не пустая заглушка.
        const plain = normalizePlain(lyrics);
        return plain ? { status: 'ok', syncLevel: 'plain', plain } : { status: 'none' };
      }
      const plain = normalizePlain(lyrics);
      return plain ? { status: 'ok', syncLevel: 'plain', plain } : { status: 'none' };
    }

    if (response.status === 404 || response.status === 422) return { status: 'none' };
    if (response.status === 429) {
      return { status: 'error', reason: 'rate_limited', retryAfter: response.headers.get('retry-after') };
    }
    return { status: 'error', reason: `http_${response.status}` };
  }

  return { status: 'error', reason: 'redirect_loop' };
}

function normalizePlain(value) {
  const text = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text || /^[.\s·•…\-–—]+$/.test(text)) return '';
  return text.slice(0, 20000);
}

/* ───────────────────────────── LRCLIB ───────────────────────────── */

export function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .replace(/\s*-\s*(remaster(ed)?|live|radio edit|single version).*$/i, ' ')
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VERSION_RE = /\b(remix|mix|live|acoustic|instrumental|karaoke|cover|sped up|slowed|reverb|nightcore|edit|demo|version|remaster(?:ed)?)\b/gi;

function versionTags(value) {
  return new Set((String(value || '').match(VERSION_RE) || []).map((tag) => tag.toLowerCase()));
}

function comparableVersions(a, b) {
  const left = versionTags(a);
  const right = versionTags(b);
  for (const tag of left) if (!right.has(tag)) return false;
  for (const tag of right) if (!left.has(tag)) return false;
  return true;
}

function durationClose(candidate, meta) {
  const duration = Number(candidate);
  if (!Number.isFinite(duration) || duration <= 0) return false;
  return Math.abs(duration - meta.duration) <= Math.max(4, meta.duration * 0.03);
}

/**
 * Выбирает лучшее совпадение среди результатов поиска LRCLIB.
 * Случайный текст по похожему названию недопустим, поэтому проверяются
 * исполнитель, длительность и совпадение версии (remix/live/acoustic…).
 */
export function pickLrclibMatch(items, meta) {
  if (!Array.isArray(items) || !items.length) return null;
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    if (!item || (!item.syncedLyrics && !item.plainLyrics && !item.instrumental)) continue;
    const title = normalizeTitle(item.trackName);
    const wanted = normalizeTitle(meta.title);
    if (!title || !wanted) continue;
    if (!comparableVersions(item.trackName, meta.title)) continue;
    if (title !== wanted && !title.includes(wanted) && !wanted.includes(title)) continue;

    const artist = normalizeTitle(item.artistName);
    const wantedArtist = normalizeTitle(meta.artist);
    const artistOk = !!artist && !!wantedArtist
      && (artist === wantedArtist || artist.includes(wantedArtist) || wantedArtist.includes(artist));
    if (!artistOk) continue;
    if (!durationClose(item.duration, meta)) continue;

    let score = 0;
    if (title === wanted) score += 4;
    if (artist === wantedArtist) score += 3;
    if (item.syncedLyrics) score += 2;
    if (item.instrumental) score += 1;
    score -= Math.abs(Number(item.duration) - meta.duration) / 10;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return best;
}

async function lrclibRequest(path) {
  const response = await fetch(`${LRCLIB_BASE}${path}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT, 'Lrclib-Client': USER_AGENT },
    signal: timeoutSignal(LRCLIB_TIMEOUT_MS),
  });
  return response;
}

async function fetchLrclib(meta) {
  if (!meta || !meta.title || !meta.artist || !Number.isFinite(meta.duration) || meta.duration <= 0) {
    return { status: 'none' };
  }
  const exact = new URLSearchParams({
    track_name: meta.title,
    artist_name: meta.artist,
    duration: String(Math.round(meta.duration)),
  });
  if (meta.album) exact.set('album_name', meta.album);

  let match = null;
  try {
    const response = await lrclibRequest(`/get?${exact.toString()}`);
    if (response.status === 200) {
      const item = await response.json();
      if (item && (item.syncedLyrics || item.plainLyrics || item.instrumental)) match = item;
    } else if (response.status === 429) {
      return { status: 'error', reason: 'rate_limited' };
    } else if (response.status >= 500) {
      return { status: 'error', reason: `http_${response.status}` };
    }
  } catch {
    return { status: 'error', reason: 'network' };
  }

  if (!match) {
    try {
      const params = new URLSearchParams({ track_name: meta.title, artist_name: meta.artist });
      const response = await lrclibRequest(`/search?${params.toString()}`);
      if (response.status === 429) return { status: 'error', reason: 'rate_limited' };
      if (response.status >= 500) return { status: 'error', reason: `http_${response.status}` };
      if (response.status === 200) {
        const items = await response.json();
        match = pickLrclibMatch(items, meta);
      }
    } catch {
      return { status: 'error', reason: 'network' };
    }
  }

  if (!match) return { status: 'none' };
  if (match.instrumental) return { status: 'ok', syncLevel: 'instrumental' };

  if (match.syncedLyrics) {
    const parsed = parseLrc(match.syncedLyrics);
    const lines = normalizeLines(parsed.lines);
    if (lines.length) return { status: 'ok', syncLevel: 'line', lines, offsetMs: parsed.offsetMs };
  }
  const plain = normalizePlain(match.plainLyrics);
  return plain ? { status: 'ok', syncLevel: 'plain', plain } : { status: 'none' };
}

/* ───────────────────────────── кеш ───────────────────────────── */

const memo = new Map();

function defaultCache() {
  try {
    if (typeof caches !== 'undefined' && caches.default) return caches.default;
  } catch { /* ignore */ }
  return null;
}

function memoSet(key, value) {
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value);
  memo.set(key, value);
}

async function cacheRead(key) {
  if (memo.has(key)) return memo.get(key);
  const cache = defaultCache();
  if (!cache) return null;
  try {
    const response = await cache.match(new Request(key));
    if (!response) return null;
    const data = await response.json();
    memoSet(key, data);
    return data;
  } catch {
    return null;
  }
}

async function cacheWrite(key, value, ttlSeconds) {
  memoSet(key, value);
  const cache = defaultCache();
  if (!cache) return;
  try {
    await cache.put(new Request(key), new Response(JSON.stringify(value), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${ttlSeconds}`,
      },
    }));
  } catch { /* кеш недоступен — не критично */ }
}

/* ───────────────────────────── сборка ───────────────────────────── */

function sourceLabel(source) {
  if (source === 'zvuk') return 'Zvuk';
  if (source === 'lrclib') return 'LRCLIB';
  return '';
}

function attributionFor(source, syncLevel) {
  const instrumental = syncLevel === 'instrumental';
  if (source === 'lrclib') return instrumental ? 'Инструментал: LRCLIB (lrclib.net)' : 'Текст: LRCLIB (lrclib.net)';
  if (source === 'zvuk') return instrumental ? 'Инструментал: Zvuk' : 'Текст: Zvuk';
  return null;
}

function payloadFor(trackId, source, data, cached) {
  const syncLevel = data.syncLevel || 'none';
  return {
    ok: true,
    trackId,
    source,
    sourceLabel: sourceLabel(source),
    syncLevel,
    offsetMs: syncLevel === 'line' ? Math.round(Number(data.offsetMs) || 0) : 0,
    lines: syncLevel === 'line' || syncLevel === 'word' ? (data.lines || []) : [],
    plain: syncLevel === 'plain' ? (data.plain || '') : null,
    instrumental: syncLevel === 'instrumental',
    attribution: attributionFor(source, syncLevel),
    fetchedAt: new Date().toISOString(),
    cached: !!cached,
  };
}

const TRACK_META_QUERY = `
query lyricsTrack($ids: [ID!]!) {
  getTracks(ids: $ids) {
    id
    title
    duration
    lyrics
    artists { title }
    release { title }
  }
}`;

async function loadTrackMeta(env, trackId) {
  const data = await gql(env, TRACK_META_QUERY, 'lyricsTrack', { ids: [trackId] });
  const found = (data.getTracks || []).find((item) => item && item.id);
  if (!found) return null;
  const artists = Array.isArray(found.artists) ? found.artists : [];
  return {
    id: String(found.id),
    title: String(found.title || '').trim(),
    artist: artists.map((artist) => artist && artist.title).filter(Boolean).join(', '),
    album: (found.release && found.release.title) || '',
    duration: Number(found.duration) || 0,
    hasLyrics: found.lyrics === true,
  };
}

/**
 * GET /api/lyrics/:trackId
 *
 * Всегда отвечает единым форматом. Если источники недоступны (сеть, 429,
 * 5xx), возвращается 502 — клиент показывает состояние ошибки и может
 * повторить запрос; такие ответы не кешируются.
 */
export async function handleLyrics(request, env, trackId) {
  const url = new URL(request.url);
  const cacheKey = `${url.origin}/__lyrics-cache/v1/${trackId}`;

  const cached = await cacheRead(cacheKey);
  if (cached) {
    return json({ ...cached, cached: true }, 200, {
      'Cache-Control': `public, max-age=${CLIENT_MAX_AGE}, stale-while-revalidate=86400`,
      'X-Lyrics-Cache': 'hit',
    });
  }

  let meta;
  try {
    meta = await loadTrackMeta(env, trackId);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502;
    if (status === 401 || status === 403) {
      // Каталог недоступен — синхронизированный текст получить не из чего.
      return json({ ok: false, error: { code: 'CATALOG_UNAVAILABLE', message: 'Каталог временно недоступен.' } }, 502);
    }
    throw error;
  }
  if (!meta) throw new ApiError(404, 'TRACK_NOT_FOUND', 'Композиция не найдена.');

  let source = 'zvuk';
  let data = { status: 'none' };
  if (meta.hasLyrics) {
    data = await fetchZvukLyrics(env, trackId);
  }

  if (data.status !== 'ok') {
    const primary = data;
    const fallback = await fetchLrclib(meta);
    if (fallback.status === 'ok') {
      source = 'lrclib';
      data = fallback;
    } else if (primary.status === 'error' && fallback.status === 'none') {
      // Основной источник не ответил, поэтому «текста нет» не подтверждено —
      // это ошибка с возможностью повторить, а не пустой результат.
      data = primary;
    } else if (fallback.status === 'error' && primary.status !== 'error') {
      // Zvuk уверенно ответил «текста нет», а LRCLIB недоступен: показываем
      // отсутствие текста, но не выдаём это за сбой всех источников.
      data = { status: 'none' };
    } else if (fallback.status === 'none') {
      data = { status: 'none' };
    }
  }

  if (data.status === 'error') {
    return json({
      ok: false,
      error: {
        code: 'LYRICS_UNAVAILABLE',
        message: 'Источники текста временно недоступны.',
        reason: data.reason || null,
      },
    }, 502, { 'Cache-Control': 'no-store' });
  }

  const payload = payloadFor(trackId, data.status === 'ok' ? source : null, data.status === 'ok' ? data : { syncLevel: 'none' }, false);
  const ttl = payload.syncLevel === 'none' ? TTL_MISS_SECONDS : TTL_FOUND_SECONDS;
  await cacheWrite(cacheKey, payload, ttl);

  return json(payload, 200, {
    'Cache-Control': `public, max-age=${CLIENT_MAX_AGE}, stale-while-revalidate=86400`,
    'X-Lyrics-Cache': 'miss',
  });
}