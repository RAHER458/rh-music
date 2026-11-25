/**
 * SoundCloud API v2 — изолированный адаптер для RH—MUSIC.
 *
 * Задача: найти трек, получить метаданные и отдать браузеру играбельный
 * источник. Client ID живёт только в секрете Worker и никогда не попадает
 * в ответы. Из нескольких транскодингов выбирается полный (не snipped)
 * и не зашифрованный; HLS отдаётся через тот же Worker как m3u8, чтобы
 * <audio> получил обычный URL и не зависел от CORS JSON-API.
 */

import { ApiError } from './http.js';

const SC_API = 'https://api-v2.soundcloud.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function clientId(env) {
  const id = env && env.SC_CLIENT_ID ? String(env.SC_CLIENT_ID).trim() : '';
  if (!id) throw new ApiError(503, 'SC_NOT_CONFIGURED', 'Источник временно недоступен.');
  return id;
}

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://soundcloud.com/' },
      signal: controller.signal,
    });
    if (!response.ok) throw new ApiError(502, 'SC_HTTP', 'Источник временно недоступен.');
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error && error.name === 'AbortError') throw new ApiError(504, 'SC_TIMEOUT', 'Источник не ответил вовремя.');
    throw new ApiError(502, 'SC_FETCH', 'Не удалось получить данные.');
  } finally {
    clearTimeout(timer);
  }
}

async function scApi(env, pathname, params = {}) {
  const url = new URL(SC_API + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  url.searchParams.set('client_id', clientId(env));
  return fetchJson(url);
}

async function scUrl(env, href) {
  const url = new URL(href);
  if (!url.searchParams.has('client_id')) url.searchParams.set('client_id', clientId(env));
  return fetchJson(url);
}

export function soundCloudId(raw) {
  const id = String(raw || '').replace(/^sc:/i, '');
  return /^\d+$/.test(id) ? id : null;
}

function artistOf(track) {
  const published = track && track.publisher_metadata && track.publisher_metadata.artist;
  return published || (track && track.user && track.user.username) || '';
}

function hiResArtwork(url) {
  if (!url) return null;
  return String(url).replace('-large', '-t500x500').replace('-t300x300', '-t500x500');
}

export function normalizeSoundCloudTrack(track) {
  if (!track || !track.id) return null;
  const transcodings = Array.isArray(track.media && track.media.transcodings)
    ? track.media.transcodings.filter((item) => item && item.url && !item.snipped)
    : [];
  const playable = transcodings.filter((item) => {
    const protocol = (item.format && item.format.protocol) || '';
    return !/encrypted/i.test(protocol) && !/encrypted/i.test(item.url || '');
  });
  if (!playable.length) return null;
  if (track.streamable === false) return null;
  if (String(track.policy || '').toUpperCase() === 'BLOCK') return null;

  const hasProgressive = playable.some((item) => (item.format && item.format.protocol) === 'progressive');
  return {
    id: 'sc:' + String(track.id),
    source: 'soundcloud',
    streamKind: hasProgressive ? 'progressive' : 'hls',
    title: track.title || 'Без названия',
    artist: artistOf(track),
    artistId: null,
    album: (track.publisher_metadata && track.publisher_metadata.album_title) || '',
    albumId: null,
    duration: Number(track.full_duration || track.duration || 0) / 1000,
    cover: hiResArtwork(track.artwork_url || (track.user && track.user.avatar_url) || null),
    explicit: !!(track.publisher_metadata && track.publisher_metadata.explicit),
    permalink: track.permalink_url || null,
    playbackCount: Number(track.playback_count) || 0,
  };
}

function rankTranscoding(item) {
  if (!item) return 99;
  const protocol = (item.format && item.format.protocol) || '';
  const mime = (item.format && item.format.mime_type) || '';
  if (/encrypted/i.test(protocol) || /encrypted/i.test(item.url || '')) return 99;
  if (item.snipped) return 99;
  if (protocol === 'progressive' && /audio\/mpeg/.test(mime)) return 0;
  if (protocol === 'progressive') return 1;
  if (protocol === 'hls' && /mp4a/.test(mime)) return 2;
  if (protocol === 'hls') return 3;
  return 9;
}

function sortedTranscodings(track) {
  const items = Array.isArray(track.media && track.media.transcodings) ? track.media.transcodings.slice() : [];
  return items.sort((a, b) => rankTranscoding(a) - rankTranscoding(b)).filter((item) => rankTranscoding(item) < 9);
}

async function resolveTranscoding(env, item) {
  const url = new URL(item.url);
  url.searchParams.set('client_id', clientId(env));
  const data = await fetchJson(url);
  return data && data.url ? data.url : null;
}

export async function searchSoundCloud(env, query, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  const data = options.next
    ? await scUrl(env, options.next)
    : await scApi(env, '/search/tracks', { q: query, limit });
  const items = (data.collection || []).map(normalizeSoundCloudTrack).filter(Boolean);
  return {
    items,
    total: Number(data.total_results) || items.length,
    next: data.next_href || null,
  };
}

export async function getSoundCloudTrack(env, rawId) {
  const id = soundCloudId(rawId);
  if (!id) throw new ApiError(400, 'BAD_ID', 'Некорректный идентификатор.');
  const track = await scApi(env, '/tracks/' + id);
  const normalized = normalizeSoundCloudTrack(track);
  if (!normalized) throw new ApiError(404, 'TRACK_NOT_AVAILABLE', 'Композиция недоступна.');
  return normalized;
}

export async function soundCloudStreamUrl(env, rawId) {
  const id = soundCloudId(rawId);
  if (!id) throw new ApiError(400, 'BAD_ID', 'Некорректный идентификатор.');
  const track = await scApi(env, '/tracks/' + id);
  for (const item of sortedTranscodings(track)) {
    try {
      const url = await resolveTranscoding(env, item);
      if (url) return { url, protocol: (item.format && item.format.protocol) || '', mime: (item.format && item.format.mime_type) || '', preset: item.preset || '' };
    } catch { /* пробуем следующий вариант */ }
  }
  throw new ApiError(404, 'STREAM_NOT_FOUND', 'Поток недоступен для этой композиции.');
}

/**
 * Отдаёт браузеру URL обычного аудио:
 *  • progressive → 302 на подписанный CDN;
 *  • HLS → m3u8 того же origin, чтобы <audio>/hls.js не упирались в CORS JSON-API.
 */
export async function soundCloudPlayResponse(env, rawId) {
  const resolved = await soundCloudStreamUrl(env, rawId);
  if (resolved.protocol === 'progressive') {
    return Response.redirect(resolved.url, 302);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let upstream;
  try {
    upstream = await fetch(resolved.url, {
      headers: { 'User-Agent': UA, Referer: 'https://soundcloud.com/' },
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(504, 'SC_TIMEOUT', 'Источник не ответил вовремя.');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) throw new ApiError(502, 'SC_HTTP', 'Источник временно недоступен.');
  const body = await upstream.text();
  const headers = new Headers();
  headers.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(body, { status: 200, headers });
}


/**
 * Экспериментальный fallback: собирает HLS init + сегменты в один MP4
 * и отдаёт его same-origin. Нужен для iPhone/Safari, когда нативный HLS
 * не открывает fMP4-поток, а браузерный fetch к CDN блокируется CORS.
 */
export async function soundCloudAudioResponse(env, rawId) {
  const resolved = await soundCloudStreamUrl(env, rawId);
  const headers = { 'User-Agent': UA, Referer: 'https://soundcloud.com/' };
  const get = async (url) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new ApiError(502, 'SC_HTTP', 'Источник временно недоступен.');
    return res;
  };
  if (resolved.protocol === 'progressive') {
    const upstream = await get(resolved.url);
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': resolved.mime || 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  const playlistResponse = await get(resolved.url);
  const playlist = await playlistResponse.text();
  if (!/^#EXTM3U/m.test(playlist.trim())) {
    return new Response(playlist, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const lines = playlist.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variant = lines.find((line) => line && !line.startsWith('#'));
  if (lines.some((line) => line.startsWith('#EXT-X-STREAM-INF')) && variant) {
    const nested = await get(new URL(variant, resolved.url).href);
    return soundCloudAudioFromPlaylist(env, await nested.text(), new URL(variant, resolved.url).href);
  }
  return soundCloudAudioFromPlaylist(env, playlist, resolved.url);
}

async function soundCloudAudioFromPlaylist(env, playlist, baseUrl) {
  const headers = { 'User-Agent': UA, Referer: 'https://soundcloud.com/' };
  const lines = playlist.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const mapLine = lines.find((line) => line.startsWith('#EXT-X-MAP:'));
  const mapMatch = mapLine && mapLine.match(/URI="([^"]+)"/);
  const initUrl = mapMatch ? new URL(mapMatch[1], baseUrl).href : null;
  const segmentUrls = lines.filter((line) => line && !line.startsWith('#')).map((line) => new URL(line, baseUrl).href);
  if (!segmentUrls.length || segmentUrls.length > 240) throw new ApiError(502, 'SC_HLS', 'Поток недоступен.');
  const parts = [];
  const read = async (url) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new ApiError(502, 'SC_HTTP', 'Сегмент потока недоступен.');
    return new Uint8Array(await res.arrayBuffer());
  };
  if (initUrl) parts.push(await read(initUrl));
  for (const url of segmentUrls) parts.push(await read(url));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  if (total > 24 * 1024 * 1024) throw new ApiError(413, 'SC_TOO_LARGE', 'Поток слишком большой.');
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { merged.set(part, offset); offset += part.length; }
  return new Response(merged, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mp4',
      'Content-Length': String(total),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/* ── Курсор поиска: объединяет страницы Zvuk и SoundCloud ───────────── */

export function encodeSearchCursor(zvuk, sc) {
  const payload = JSON.stringify({ v: 1, z: zvuk || null, s: sc === false ? false : (sc || null) });
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return 'sc1.' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeSearchCursor(cursor) {
  if (!cursor) return { zvuk: null, sc: null, combined: false };
  if (!String(cursor).startsWith('sc1.')) return { zvuk: String(cursor), sc: null, combined: false };
  try {
    const raw = String(cursor).slice(4).replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    return { zvuk: data.z || null, sc: data.s === false ? false : (data.s || null), combined: true };
  } catch {
    return { zvuk: String(cursor), sc: null, combined: false };
  }
}

/** Чередует Zvuk и SoundCloud, убирая дубли по названию и исполнителю. */
export function mergeTrackLists(zvukItems, soundCloudItems) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (!item) return;
    const key = (item.title || '').toLowerCase() + '|' + (item.artist || '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  const left = Array.isArray(zvukItems) ? zvukItems : [];
  const right = Array.isArray(soundCloudItems) ? soundCloudItems : [];
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    push(left[index]);
    push(right[index]);
  }
  return out;
}
