/**
 * Word-level синхронизация: получение и проверка временных меток слов.
 *
 * Источник — LiriQo (https://api.liriqo-alfarrizi.my.id/v1) — публичный
 * агрегатор без ключей и регистрации. Он отдаёт нативные word/syllable
 * метки (NetEase YRC, Apple Music TTML, KuGou KRC и др.).
 *
 * Главный принцип: слово подсвечивается только тогда, когда его метки
 * действительно совпадают с текущим текстом трека. Кандидат проверяется
 * по тексту (перевод, другая версия, другой трек отбрасываются), по
 * времени (метки должны лежать внутри строки и в пределах длительности)
 * и по покрытию. Если проверка не проходит — остаётся построчный режим.
 */

import { ApiError, json } from './http.js';
import { resolveLyrics, loadTrackMeta } from './lyrics.js';

const LIRIQO_URL = 'https://api.liriqo-alfarrizi.my.id/v1/lyrics';
const USER_AGENT = 'RH-MUSIC/2.6.0 (https://rh-music.pages.dev; word-sync)';
const TIMEOUT_MS = 12000;

const TTL_WORD_SECONDS = 30 * 24 * 60 * 60;
const TTL_MISS_SECONDS = 3 * 24 * 60 * 60;
const CLIENT_MAX_AGE = 300;
const MEMO_LIMIT = 200;

const PROVIDER_LABELS = {
  apple_music_liriqo: 'Apple Music',
  netease: 'NetEase',
  kugou_legato: 'KuGou',
  qq_portato: 'QQ Music',
  kuwo: 'Kuwo',
  migu: 'Migu',
  petitlyrics: 'PetitLyrics',
  musixmatch: 'Musixmatch',
  lrclib: 'LRCLIB',
};

/* ───────────────────────────── текст и время ───────────────────────────── */

/** Только буквы и цифры: пунктуация, регистр и пробелы не влияют на сверку. */
export function letters(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function wordsOf(text) {
  return String(text == null ? '' : text).trim().split(/\s+/).filter(Boolean);
}

/** Быстрая похожесть двух текстов (Dice по биграммам букв). */
export function textSimilarity(a, b) {
  const left = letters(a);
  const right = letters(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (value) => {
    const map = new Map();
    for (let i = 0; i < value.length - 1; i += 1) {
      const gram = value.slice(i, i + 2);
      map.set(gram, (map.get(gram) || 0) + 1);
    }
    return map;
  };
  const one = grams(left);
  const two = grams(right);
  let overlap = 0;
  for (const [gram, count] of one) {
    const other = two.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (left.length - 1 + right.length - 1);
}

function validWordTime(word, from, to, audioDurationMs) {
  if (!word || !Number.isFinite(word.t) || !Number.isFinite(word.end)) return false;
  if (word.t < 0 || word.end < word.t) return false;
  if (word.t < from) return false;
  if (to && word.end > to) return false;
  if (audioDurationMs && word.t > audioDurationMs + 5000) return false;
  return true;
}

/** Проверяет последовательность слов и границы строки. */
export function validateWords(words, lineStart, lineEnd, audioDurationMs) {
  if (!Array.isArray(words) || !words.length) return false;
  const from = Math.max(0, lineStart - 2500);
  const to = lineEnd ? lineEnd + 2500 : (audioDurationMs ? audioDurationMs + 5000 : 0);
  let previous = -1;
  for (const word of words) {
    if (!validWordTime(word, from, to, audioDurationMs)) return false;
    if (word.t < previous - 5) return false;
    previous = word.t;
  }
  return true;
}

/**
 * Собирает слова строки из токенов провайдера.
 *
 * Токены могут быть слогами (`<e><nough>`), словами с пунктуацией или
 * повторяющимися словами. Каждое слово канонического текста собирается
 * из подряд идущих токенов; если собрать нельзя (лишние/недостающие
 * токены, другой текст) — строка отбрасывается целиком.
 */
export function groupWords(text, tokens) {
  const targets = wordsOf(text);
  if (!targets.length) return null;
  const list = (Array.isArray(tokens) ? tokens : [])
    .filter((token) => token && Number.isFinite(Number(token.start)) && Number.isFinite(Number(token.end)))
    .map((token) => ({
      text: String(token.text == null ? '' : token.text),
      start: Number(token.start),
      end: Number(token.end),
    }))
    .filter((token) => token.end >= token.start && letters(token.text));

  let cursor = 0;
  const words = [];
  for (const target of targets) {
    const need = letters(target);
    if (!need) continue;
    let collected = '';
    let first = null;
    let last = null;
    const syllables = [];
    while (cursor < list.length && collected.length < need.length) {
      const token = list[cursor];
      const add = letters(token.text);
      if (!add) { cursor += 1; continue; }
      if (!need.startsWith(collected + add)) return null;
      collected += add;
      if (!first) first = token;
      last = token;
      syllables.push({
        t: Math.round(token.start),
        end: Math.round(Math.max(token.end, token.start + 1)),
        text: String(token.text).trim(),
      });
      cursor += 1;
    }
    if (!first || collected !== need) return null;
    const word = {
      t: Math.round(first.start),
      end: Math.round(Math.max(last.end, first.start + 1)),
      text: target,
    };
    if (syllables.length > 1) word.syllables = syllables;
    words.push(word);
  }
  if (cursor !== list.length) return null;
  return words.length ? words : null;
}

/* ───────────────────────────── сверка строк ───────────────────────────── */

/**
 * Выравнивает строки канонического текста и кандидата (LCS по тексту).
 * Совпадение засчитывается, только если текст совпадает без пунктуации
 * и время строки отличается не более чем на 2.5 с — это отсекает
 * повторяющиеся припевы, приписанные не к тому месту трека.
 */
export function alignLines(canonical, candidate, tolerance = 2500) {
  const n = canonical.length;
  const m = candidate.length;
  if (!n || !m) return [];
  const count = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  const same = (i, j) => {
    const left = letters(canonical[i].text);
    const right = letters(candidate[j].text);
    if (!left || left !== right) return false;
    return Math.abs(canonical[i].t - candidate[j].start) <= tolerance;
  };
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const match = same(i - 1, j - 1) ? count[i - 1][j - 1] + 1 : 0;
      count[i][j] = Math.max(count[i - 1][j], count[i][j - 1], match);
    }
  }
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (same(i - 1, j - 1) && count[i][j] === count[i - 1][j - 1] + 1) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (count[i - 1][j] >= count[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return pairs.reverse();
}

function finalizeLines(lines) {
  // Порядок строк сохраняем исходный (текст песни), а не сортируем по времени:
  // иначе частично размеченный текст мог бы переставить куплеты местами.
  // Для бинарного поиска достаточно, чтобы время не убывало.
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0 && lines[i].t < lines[i - 1].t) lines[i].t = lines[i - 1].t;
    if (!lines[i].end && i + 1 < lines.length && lines[i + 1].t > lines[i].t) {
      lines[i].end = lines[i + 1].t;
    }
  }
  return lines;
}

/**
 * Строит word-версию для строкового текста.
 * Возвращает null, если покрытие/качество недостаточны.
 */
export function buildFromLines(base, candidate, audioDurationMs) {
  const shift = -(Number(base.offsetMs) || 0);
  const canonical = (base.lines || []).map((line) => ({
    t: Math.max(0, Number(line.t) + shift),
    end: line.end ? Math.max(0, Number(line.end) + shift) : 0,
    text: String(line.text || ''),
  }));
  if (!canonical.length) return null;

  const pairs = alignLines(canonical, candidate.timed || []);
  if (!pairs.length) return null;

  const result = canonical.map((line) => ({ ...line }));
  const used = new Set();
  let wordCount = 0;
  for (const [canonicalIndex, candidateIndex] of pairs) {
    const line = canonical[canonicalIndex];
    const words = groupWords(line.text, candidate.timed[candidateIndex].words);
    if (!words) continue;
    if (!validateWords(words, line.t, line.end, audioDurationMs)) continue;
    result[canonicalIndex] = {
      t: words[0].t,
      end: words[words.length - 1].end,
      text: line.text,
      words,
    };
    used.add(canonicalIndex);
    wordCount += words.length;
  }

  const totalWords = canonical.reduce((sum, line) => sum + wordsOf(line.text).length, 0);
  const lineCoverage = used.size / canonical.length;
  const wordCoverage = wordCount / Math.max(1, totalWords);
  if (used.size < 5 || lineCoverage < 0.4 || wordCoverage < 0.45 || wordCount < 12) return null;

  return {
    lines: finalizeLines(result),
    lineCoverage,
    wordCoverage,
    wordCount,
  };
}

/** Строит word-версию для обычного текста: кандидат сам даёт и строки, и время. */
export function buildFromPlain(base, candidate, audioDurationMs) {
  const plain = String(base.plain || '');
  const timed = Array.isArray(candidate.timed) ? candidate.timed : [];
  if (!plain || timed.length < 5) return null;
  if (textSimilarity(plain, timed.map((line) => line.text).join(' ')) < 0.93) return null;

  const lines = [];
  let wordCount = 0;
  for (const source of timed) {
    const lineText = String(source.text || '').trim();
    if (!lineText) continue;
    const words = groupWords(lineText, source.words);
    if (!words) continue;
    if (!validateWords(words, Number(source.start) || 0, Number(source.end) || 0, audioDurationMs)) continue;
    lines.push({
      t: words[0].t,
      end: words[words.length - 1].end,
      text: lineText,
      words,
    });
    wordCount += words.length;
  }

  const lineCoverage = lines.length / timed.length;
  const totalWords = timed.reduce((sum, line) => sum + wordsOf(line.text).length, 0);
  const wordCoverage = wordCount / Math.max(1, totalWords);
  if (lines.length < 5 || lineCoverage < 0.6 || wordCoverage < 0.6 || wordCount < 12) return null;

  return {
    lines: finalizeLines(lines),
    lineCoverage,
    wordCoverage,
    wordCount,
  };
}

function providerRank(provider) {
  if (provider === 'netease') return 3;
  if (provider === 'apple_music_liriqo') return 2;
  if (provider === 'kugou_legato' || provider === 'qq_portato') return 2;
  return 1;
}

/**
 * Проверяет всех кандидатов LiriQo и выбирает лучший.
 * Возвращает null, если ни один не подтвердил соответствие тексту.
 */
export function buildWordPayload(base, meta, liri) {
  if (!base || !['line', 'plain'].includes(base.syncLevel)) return null;
  const candidates = (liri && Array.isArray(liri.tracks) ? liri.tracks : [])
    .filter((track) => track
      && (track.syncLevel === 'word' || track.syncLevel === 'syllable')
      && Array.isArray(track.timed)
      && track.timed.length >= 5
      && track.timed.some((line) => Array.isArray(line.words) && line.words.length));
  if (!candidates.length) return null;

  const statedDuration = Number(liri && liri.metadata && liri.metadata.duration);
  if (statedDuration && meta.duration && Math.abs(statedDuration - meta.duration) > 12) return null;

  const audioDurationMs = meta.duration > 0 ? meta.duration * 1000 : 0;
  let best = null;
  for (const candidate of candidates) {
    const built = base.syncLevel === 'plain'
      ? buildFromPlain(base, candidate, audioDurationMs)
      : buildFromLines(base, candidate, audioDurationMs);
    if (!built) continue;
    const score = built.wordCoverage * 2 + built.lineCoverage + providerRank(candidate.provider) * 0.01;
    if (!best || score > best.score) {
      best = {
        score,
        ...built,
        provider: candidate.provider,
        providerLabel: PROVIDER_LABELS[candidate.provider] || candidate.provider,
      };
    }
  }
  return best;
}

/* ───────────────────────────── LiriQo ───────────────────────────── */

function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }
}

async function fetchLiriQo(meta) {
  if (!meta || !meta.title || !meta.artist) return null;
  const params = new URLSearchParams({
    title: meta.title,
    artist: meta.artist,
  });
  if (meta.duration > 0) params.set('duration', String(Math.round(meta.duration)));
  if (meta.album) params.set('album', meta.album);

  const response = await fetch(`${LIRIQO_URL}?${params.toString()}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    signal: timeoutSignal(TIMEOUT_MS),
  });
  if (response.status === 429) {
    const error = new Error('rate limited');
    error.reason = 'rate_limited';
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`liriqo http ${response.status}`);
    error.reason = `http_${response.status}`;
    throw error;
  }
  return response.json();
}

/* ───────────────────────────── кеш ───────────────────────────── */

const memo = new Map();
const inflight = new Map();

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
  } catch { /* ignore */ }
}

/* ───────────────────────────── маршрут ───────────────────────────── */

/**
 * GET /api/lyrics/:trackId/words
 *
 * Возвращает word-level строки только после проверки соответствия тексту.
 * Ошибка LiriQo — 502 (клиент остаётся на построчном режиме и не ретраит
 * бесконечно); отсутствие подходящих меток — 200 { syncLevel: 'none' }.
 */
export async function handleLyricsWords(request, env, trackId) {
  const url = new URL(request.url);
  const key = `${url.origin}/__lyrics-words-cache/v2/${trackId}`;

  const cached = await cacheRead(key);
  if (cached) {
    return json({ ...cached, cached: true }, 200, {
      'Cache-Control': `public, max-age=${CLIENT_MAX_AGE}, stale-while-revalidate=86400`,
      'X-Lyrics-Words': 'hit',
    });
  }

  const work = async () => {
    const { payload, meta } = await resolveLyrics(env, trackId, url.origin);
    if (!payload || (payload.syncLevel !== 'line' && payload.syncLevel !== 'plain')) {
      const none = {
        ok: true,
        trackId,
        syncLevel: 'none',
        reason: payload ? `base_${payload.syncLevel}` : 'no_lyrics',
      };
      await cacheWrite(key, none, TTL_MISS_SECONDS);
      return none;
    }

    const trackMeta = meta || await loadTrackMeta(env, trackId);
    if (!trackMeta) throw new ApiError(404, 'TRACK_NOT_FOUND', 'Композиция не найдена.');

    let liriqo;
    try {
      liriqo = await fetchLiriQo(trackMeta);
    } catch (error) {
      throw new ApiError(502, 'WORDS_UNAVAILABLE', 'Источник слов временно недоступен.', error.reason || null);
    }

    const built = buildWordPayload(payload, trackMeta, liriqo);
    if (!built) {
      const none = { ok: true, trackId, syncLevel: 'none', reason: 'no_word_data' };
      await cacheWrite(key, none, TTL_MISS_SECONDS);
      return none;
    }

    const result = {
      ok: true,
      trackId,
      syncLevel: 'word',
      source: payload.source,
      sourceLabel: payload.sourceLabel,
      wordSource: built.provider,
      wordSourceLabel: built.providerLabel,
      attribution: `Слова: LiriQo · ${built.providerLabel}`,
      lines: built.lines,
      coverage: {
        lines: Math.round(built.lineCoverage * 100) / 100,
        words: Math.round(built.wordCoverage * 100) / 100,
      },
      fetchedAt: new Date().toISOString(),
    };
    await cacheWrite(key, result, TTL_WORD_SECONDS);
    return result;
  };

  let pending = inflight.get(trackId);
  if (!pending) {
    pending = work().finally(() => inflight.delete(trackId));
    inflight.set(trackId, pending);
  }
  const result = await pending;
  return json({ ...result, cached: false }, 200, {
    'Cache-Control': `public, max-age=${CLIENT_MAX_AGE}, stale-while-revalidate=86400`,
    'X-Lyrics-Words': 'miss',
  });
}