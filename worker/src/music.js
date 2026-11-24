/**
 * Личная библиотека, плейлисты и история прослушивания.
 * Все операции проверяют принадлежность данных текущему пользователю.
 */

import { ApiError, json, readJson, requireCsrf, sanitizeTrack } from './http.js';
import { requireUser } from './auth.js';
import * as store from './store.js';

const ID_RE = /^[0-9]{1,20}$/;

/* ───────────────────────────── библиотека ───────────────────────────── */

export async function handleLibraryList(request, env, url) {
  const user = await requireUser(request, env);
  const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
  const sort = url.searchParams.get('sort') || 'recent';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const data = await store.listLibrary(env, user.id, { query, sort, limit, offset });
  return json({ ok: true, ...data, sort, query });
}

export async function handleLibraryIds(request, env) {
  const user = await requireUser(request, env);
  const ids = await store.libraryIds(env, user.id);
  return json({ ok: true, ids });
}

export async function handleLibraryAdd(request, env) {
  requireCsrf(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const track = sanitizeTrack(body.track);
  const { added } = await store.addLibraryTrack(env, user.id, track);
  const total = await store.libraryCount(env, user.id);
  return json({ ok: true, added, saved: true, total });
}

export async function handleLibraryRemove(request, env, trackId) {
  requireCsrf(request, env);
  const user = await requireUser(request, env);
  if (!ID_RE.test(trackId)) throw new ApiError(400, 'BAD_TRACK_ID', 'Некорректный идентификатор.');
  const { removed } = await store.removeLibraryTrack(env, user.id, trackId);
  const total = await store.libraryCount(env, user.id);
  return json({ ok: true, removed, saved: false, total });
}

/* ───────────────────────────── плейлисты ───────────────────────────── */

function sanitizeTitle(value) {
  const title = String(value || '').trim().replace(/\s+/g, ' ');
  if (title.length < 1) throw new ApiError(400, 'VALIDATION', 'Укажите название плейлиста.');
  if (title.length > 120) throw new ApiError(400, 'VALIDATION', 'Название слишком длинное.');
  return title;
}

export async function handlePlaylistsList(request, env) {
  const user = await requireUser(request, env);
  const items = await store.listPlaylists(env, user.id);
  return json({ ok: true, items });
}

export async function handlePlaylistGet(request, env, id) {
  const user = await requireUser(request, env);
  const playlist = await store.getPlaylist(env, user.id, id);
  if (!playlist) throw new ApiError(404, 'PLAYLIST_NOT_FOUND', 'Плейлист не найден.');
  return json({
    ok: true,
    playlist: {
      id: playlist.id,
      title: playlist.title,
      description: playlist.description || '',
      createdAt: playlist.created_at,
      updatedAt: playlist.updated_at,
      tracks: playlist.tracks,
    },
  });
}

export async function handlePlaylistCreate(request, env) {
  requireCsrf(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const id = await store.createPlaylist(env, user.id, {
    title: sanitizeTitle(body.title),
    description: String(body.description || '').trim().slice(0, 400),
  });
  return json({ ok: true, id, playlist: { id, title: sanitizeTitle(body.title) } }, 201);
}

export async function handlePlaylistUpdate(request, env, id) {
  requireCsrf(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const updated = await store.updatePlaylist(env, user.id, id, {
    title: body.title == null ? null : sanitizeTitle(body.title),
    description: body.description == null ? null : String(body.description).slice(0, 400),
  });
  if (!updated) throw new ApiError(404, 'PLAYLIST_NOT_FOUND', 'Плейлист не найден.');
  return json({ ok: true });
}

export async function handlePlaylistDelete(request, env, id) {
  requireCsrf(request, env);
  const user = await requireUser(request, env);
  const removed = await store.deletePlaylist(env, user.id, id);
  if (!removed) throw new ApiError(404, 'PLAYLIST_NOT_FOUND', 'Плейлист не найден.');
  return json({ ok: true, deleted: true });
}

export async function handlePlaylistAddTrack(request, env, id) {
  requireCsrf(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const track = sanitizeTrack(body.track);
  const { added, position } = await store.addPlaylistTrack(env, user.id, id, track);
  return json({ ok: true, added, position, duplicate: !added });
}

export async function handlePlaylistRemoveTrack(request, env, id, trackId) {
  requireCsrf(request, env);
  const user = await requireUser(request, env);
  if (!ID_RE.test(trackId)) throw new ApiError(400, 'BAD_TRACK_ID', 'Некорректный идентификатор.');
  const { removed } = await store.removePlaylistTrack(env, user.id, id, trackId);
  return json({ ok: true, removed });
}

export async function handlePlaylistReorder(request, env, id) {
  requireCsrf(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const ids = Array.isArray(body.trackIds) ? body.trackIds.map(String).filter((x) => ID_RE.test(x)) : null;
  if (!ids) throw new ApiError(400, 'VALIDATION', 'Ожидается список идентификаторов.');
  const result = await store.reorderPlaylist(env, user.id, id, ids);
  return json({ ok: true, order: result.order });
}

/* ───────────────────────────── история ───────────────────────────── */

export async function handleHistoryStart(request, env) {
  requireCsrf(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const track = sanitizeTrack(body.track);
  const id = await store.startHistory(env, user.id, track, body.source);
  return json({ ok: true, id });
}

export async function handleHistoryUpdate(request, env, id, method) {
  requireCsrf(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const listened = Math.min(Math.max(Number(body.listenedSeconds) || 0, 0), 24 * 3600);
  const completed = !!body.completed;
  const result = await store.updateHistory(env, user.id, Number(id), { listenedSeconds: listened, completed });
  return json({ ok: true, ...result });
}

export async function handleHistoryRecent(request, env, url) {
  const user = await requireUser(request, env);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 100);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const rows = await store.recentHistory(env, user.id, limit, offset);
  const items = rows.map((row) => ({
    id: row.trackId,
    title: row.title || 'Без названия',
    artist: row.artist || '',
    artistId: row.artistId,
    album: row.album || '',
    albumId: row.albumId,
    cover: row.cover,
    duration: row.duration || 0,
    playedAt: row.playedAt,
    listenedSeconds: row.listenedSeconds || 0,
    completed: !!row.completed,
    historyId: row.id,
  }));
  return json({ ok: true, items, hasMore: rows.length === limit });
}