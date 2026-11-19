/**
 * Слой доступа к D1. Все запросы параметризованы, данные всегда фильтруются по user_id.
 */

import { ApiError } from './http.js';

const nowIso = () => new Date().toISOString();

function only(sql) {
  return { sql, params: [] };
}

async function run(env, sql, params = []) {
  try {
    return await env.DB.prepare(sql).bind(...params).run();
  } catch (error) {
    throw new ApiError(500, 'DB_ERROR', 'Ошибка базы данных.', String(error && error.message));
  }
}

async function first(env, sql, params = []) {
  try {
    return await env.DB.prepare(sql).bind(...params).first();
  } catch (error) {
    throw new ApiError(500, 'DB_ERROR', 'Ошибка базы данных.', String(error && error.message));
  }
}

async function all(env, sql, params = []) {
  try {
    const result = await env.DB.prepare(sql).bind(...params).all();
    return result.results || [];
  } catch (error) {
    throw new ApiError(500, 'DB_ERROR', 'Ошибка базы данных.', String(error && error.message));
  }
}

export const db = { run, first, all, nowIso };

/* ───────────────────────────── пользователи ───────────────────────────── */

export async function findUserByEmailOrName(env, email, username) {
  return first(env, 'SELECT * FROM users WHERE email = ?1 OR username = ?2 COLLATE NOCASE LIMIT 1', [email, username]);
}

export async function findUserByLogin(env, login) {
  return first(env, 'SELECT * FROM users WHERE email = ?1 OR username = ?1 COLLATE NOCASE LIMIT 1', [login]);
}

export async function findUserById(env, id) {
  return first(env, 'SELECT id, username, email, display_name, created_at FROM users WHERE id = ?1', [id]);
}

export async function insertUser(env, { username, email, hash, salt, iterations }) {
  const ts = nowIso();
  const result = await run(
    env,
    `INSERT INTO users (username, email, display_name, password_hash, password_salt, iterations, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    [username, email, username, hash, salt, iterations, ts],
  );
  const id = result.meta && result.meta.last_row_id;
  await run(env, 'INSERT OR IGNORE INTO user_preferences (user_id, repeat_mode, shuffle, updated_at) VALUES (?1, \'off\', 0, ?2)', [id, ts]);
  return id;
}

export async function updateUser(env, id, { displayName, email }) {
  await run(env, 'UPDATE users SET display_name = COALESCE(?1, display_name), email = COALESCE(?2, email), updated_at = ?3 WHERE id = ?4',
    [displayName ?? null, email ?? null, nowIso(), id]);
}

export async function updatePassword(env, id, { hash, salt, iterations }) {
  await run(env, 'UPDATE users SET password_hash = ?1, password_salt = ?2, iterations = ?3, updated_at = ?4 WHERE id = ?5',
    [hash, salt, iterations, nowIso(), id]);
}

export async function getPreferences(env, userId) {
  const row = await first(env, 'SELECT repeat_mode, shuffle FROM user_preferences WHERE user_id = ?1', [userId]);
  return row || { repeat_mode: 'off', shuffle: 0 };
}

export async function savePreferences(env, userId, { repeat, shuffle }) {
  await run(
    env,
    `INSERT INTO user_preferences (user_id, repeat_mode, shuffle, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id) DO UPDATE SET repeat_mode = ?2, shuffle = ?3, updated_at = ?4`,
    [userId, repeat || 'off', shuffle ? 1 : 0, nowIso()],
  );
}

/* ───────────────────────────── сессии ───────────────────────────── */

/** Запоминает, каким способом создана сессия (только на сервере, в D1). */
export async function recordSessionMethod(env, { tokenHash, userId, method }) {
  await run(
    env,
    'INSERT OR REPLACE INTO session_methods (token_hash, user_id, method, created_at) VALUES (?1, ?2, ?3, ?4)',
    [tokenHash, userId, String(method || 'password'), nowIso()],
  );
}

export async function sessionMethod(env, tokenHash) {
  const row = await first(env, 'SELECT method FROM session_methods WHERE token_hash = ?1', [tokenHash]);
  return row ? row.method : null;
}


export async function insertSession(env, { id, userId, tokenHash, expiresAt, userAgent, ip }) {
  const ts = nowIso();
  await run(
    env,
    `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7)`,
    [id, userId, tokenHash, ts, expiresAt, (userAgent || '').slice(0, 200), ip || ''],
  );
}

export async function findSession(env, tokenHash) {
  return first(
    env,
    `SELECT s.id AS session_id, s.user_id, s.expires_at, u.username, u.email, u.display_name, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
    [tokenHash, nowIso()],
  );
}

export async function touchSession(env, sessionId) {
  await run(env, 'UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2', [nowIso(), sessionId]);
}

export async function deleteSession(env, tokenHash) {
  await run(env, 'DELETE FROM session_methods WHERE token_hash = ?1', [tokenHash]);
  await run(env, 'DELETE FROM sessions WHERE token_hash = ?1', [tokenHash]);
}

export async function deleteExpiredSessions(env) {
  await run(env, 'DELETE FROM sessions WHERE expires_at <= ?1', [nowIso()]);
}

/* ───────────────────────────── лимиты попыток ───────────────────────────── */

export async function logAttempt(env, ip, action) {
  await run(env, 'INSERT INTO auth_attempts (ip, action, created_at) VALUES (?1, ?2, ?3)', [ip, action, nowIso()]);
}

export async function countAttempts(env, ip, action, windowMinutes) {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const row = await first(
    env,
    'SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ?1 AND action = ?2 AND created_at > ?3',
    [ip, action, since],
  );
  return (row && row.n) || 0;
}

export async function pruneAttempts(env) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await run(env, 'DELETE FROM auth_attempts WHERE created_at <= ?1', [since]);
}

/* ───────────────────────────── библиотека ───────────────────────────── */

export async function listLibrary(env, userId, { query = '', sort = 'recent', limit = 100, offset = 0 }) {
  const order = {
    recent: 'added_at DESC',
    added: 'added_at ASC',
    title: 'title COLLATE NOCASE ASC',
    artist: 'artist COLLATE NOCASE ASC',
  }[sort] || 'added_at DESC';

  const like = '%' + query.toLowerCase() + '%';
  const rows = await all(
    env,
    `SELECT track_id AS id, title, artist, artist_id AS artistId, album, album_id AS albumId, cover, duration, added_at AS addedAt
     FROM library_tracks
     WHERE user_id = ?1 AND (?2 = '' OR LOWER(title) LIKE ?3 OR LOWER(artist) LIKE ?3 OR LOWER(album) LIKE ?3)
     ORDER BY ${order}
     LIMIT ?4 OFFSET ?5`,
    [userId, query, like, limit, offset],
  );
  const total = await first(
    env,
    `SELECT COUNT(*) AS n FROM library_tracks
     WHERE user_id = ?1 AND (?2 = '' OR LOWER(title) LIKE ?3 OR LOWER(artist) LIKE ?3 OR LOWER(album) LIKE ?3)`,
    [userId, query, like],
  );
  return { items: rows, total: (total && total.n) || 0 };
}

export async function libraryIds(env, userId) {
  const rows = await all(env, 'SELECT track_id FROM library_tracks WHERE user_id = ?1', [userId]);
  return rows.map((r) => r.track_id);
}

export async function addLibraryTrack(env, userId, track) {
  const result = await run(
    env,
    `INSERT OR IGNORE INTO library_tracks
       (user_id, track_id, title, artist, artist_id, album, album_id, cover, duration, added_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    [userId, track.id, track.title, track.artist, track.artistId, track.album, track.albumId, track.cover, track.duration, nowIso()],
  );
  return { added: (result.meta && result.meta.changes) > 0 };
}

export async function removeLibraryTrack(env, userId, trackId) {
  const result = await run(env, 'DELETE FROM library_tracks WHERE user_id = ?1 AND track_id = ?2', [userId, trackId]);
  return { removed: (result.meta && result.meta.changes) > 0 };
}

export async function libraryCount(env, userId) {
  const row = await first(env, 'SELECT COUNT(*) AS n FROM library_tracks WHERE user_id = ?1', [userId]);
  return (row && row.n) || 0;
}

/* ───────────────────────────── плейлисты ───────────────────────────── */

export async function listPlaylists(env, userId) {
  return all(
    env,
    `SELECT p.id, p.title, p.description, p.created_at AS createdAt, p.updated_at AS updatedAt,
            (SELECT COUNT(*) FROM playlist_tracks t WHERE t.playlist_id = p.id) AS trackCount,
            (SELECT t.cover FROM playlist_tracks t WHERE t.playlist_id = p.id ORDER BY t.position LIMIT 1) AS cover,
            (SELECT t.artist FROM playlist_tracks t WHERE t.playlist_id = p.id ORDER BY t.position LIMIT 1) AS leadArtist
     FROM playlists p WHERE p.user_id = ?1 ORDER BY p.updated_at DESC`,
    [userId],
  );
}

export async function getPlaylist(env, userId, id) {
  const row = await first(env, 'SELECT * FROM playlists WHERE id = ?1 AND user_id = ?2', [id, userId]);
  if (!row) return null;
  const tracks = await all(
    env,
    `SELECT track_id AS id, title, artist, artist_id AS artistId, album, album_id AS albumId, cover, duration, position
     FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position ASC, added_at ASC`,
    [id],
  );
  return { ...row, tracks };
}

export async function createPlaylist(env, userId, { title, description }) {
  const ts = nowIso();
  const result = await run(
    env,
    'INSERT INTO playlists (user_id, title, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
    [userId, title.slice(0, 120), (description || '').slice(0, 400), ts],
  );
  return result.meta && result.meta.last_row_id;
}

export async function updatePlaylist(env, userId, id, { title, description }) {
  const result = await run(
    env,
    `UPDATE playlists SET title = COALESCE(?1, title), description = COALESCE(?2, description), updated_at = ?3
     WHERE id = ?4 AND user_id = ?5`,
    [title ?? null, description ?? null, nowIso(), id, userId],
  );
  return (result.meta && result.meta.changes) > 0;
}

export async function deletePlaylist(env, userId, id) {
  const result = await run(env, 'DELETE FROM playlists WHERE id = ?1 AND user_id = ?2', [id, userId]);
  return (result.meta && result.meta.changes) > 0;
}

export async function addPlaylistTrack(env, userId, playlistId, track) {
  const owner = await first(env, 'SELECT id FROM playlists WHERE id = ?1 AND user_id = ?2', [playlistId, userId]);
  if (!owner) throw new ApiError(404, 'PLAYLIST_NOT_FOUND', 'Плейлист не найден.');
  const next = await first(env, 'SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM playlist_tracks WHERE playlist_id = ?1', [playlistId]);
  const position = (next && next.pos) || 1;
  const result = await run(
    env,
    `INSERT OR IGNORE INTO playlist_tracks
       (playlist_id, track_id, position, title, artist, artist_id, album, album_id, cover, duration, added_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    [playlistId, track.id, position, track.title, track.artist, track.artistId, track.album, track.albumId, track.cover, track.duration, nowIso()],
  );
  const added = (result.meta && result.meta.changes) > 0;
  if (added) await run(env, 'UPDATE playlists SET updated_at = ?1 WHERE id = ?2', [nowIso(), playlistId]);
  return { added, position };
}

export async function removePlaylistTrack(env, userId, playlistId, trackId) {
  const owner = await first(env, 'SELECT id FROM playlists WHERE id = ?1 AND user_id = ?2', [playlistId, userId]);
  if (!owner) throw new ApiError(404, 'PLAYLIST_NOT_FOUND', 'Плейлист не найден.');
  const result = await run(env, 'DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2', [playlistId, trackId]);
  if ((result.meta && result.meta.changes) > 0) {
    await run(env, 'UPDATE playlists SET updated_at = ?1 WHERE id = ?2', [nowIso(), playlistId]);
  }
  return { removed: (result.meta && result.meta.changes) > 0 };
}

export async function reorderPlaylist(env, userId, playlistId, orderedIds) {
  const owner = await first(env, 'SELECT id FROM playlists WHERE id = ?1 AND user_id = ?2', [playlistId, userId]);
  if (!owner) throw new ApiError(404, 'PLAYLIST_NOT_FOUND', 'Плейлист не найден.');
  const rows = await all(env, 'SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1', [playlistId]);
  const existing = new Set(rows.map((r) => r.track_id));
  const ordered = orderedIds.filter((id) => existing.has(String(id)));
  for (const id of existing) if (!ordered.includes(id)) ordered.push(id);

  const statements = ordered.map((trackId, index) =>
    env.DB.prepare('UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3')
      .bind(index + 1, playlistId, trackId));
  if (statements.length) await env.DB.batch(statements);
  await run(env, 'UPDATE playlists SET updated_at = ?1 WHERE id = ?2', [nowIso(), playlistId]);
  return { order: ordered };
}

/* ───────────────────────────── история и аффинити ───────────────────────────── */

export async function startHistory(env, userId, track, source) {
  const ts = nowIso();
  const result = await run(
    env,
    `INSERT INTO listening_history
       (user_id, track_id, title, artist, artist_id, album, album_id, cover, duration, started_at, listened_seconds, completed, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 0, ?11)`,
    [userId, track.id, track.title, track.artist, track.artistId, track.album, track.albumId, track.cover, track.duration, ts, (source || 'player').slice(0, 40)],
  );
  await run(
    env,
    `INSERT INTO user_track_affinity
       (user_id, track_id, title, artist_id, album_id, plays, listened_seconds, completions, first_played_at, last_played_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, 0, ?6, ?6)
     ON CONFLICT(user_id, track_id) DO UPDATE SET
       plays = plays + 1,
       last_played_at = ?6,
       title = ?3,
       artist_id = COALESCE(?4, artist_id),
       album_id = COALESCE(?5, album_id)`,
    [userId, track.id, track.title, track.artistId, track.albumId, ts],
  );
  return result.meta && result.meta.last_row_id;
}

export async function updateHistory(env, userId, historyId, { listenedSeconds, completed }) {
  const row = await first(env, 'SELECT track_id FROM listening_history WHERE id = ?1 AND user_id = ?2', [historyId, userId]);
  if (!row) return { updated: false };
  await run(
    env,
    'UPDATE listening_history SET listened_seconds = MAX(listened_seconds, ?1), completed = MAX(completed, ?2) WHERE id = ?3 AND user_id = ?4',
    [listenedSeconds, completed ? 1 : 0, historyId, userId],
  );
  await run(
    env,
    `UPDATE user_track_affinity
     SET listened_seconds = listened_seconds + ?1, completions = completions + ?2
     WHERE user_id = ?3 AND track_id = ?4`,
    [listenedSeconds, completed ? 1 : 0, userId, row.track_id],
  );
  return { updated: true };
}

export async function recentHistory(env, userId, limit = 30, offset = 0) {
  return all(
    env,
    `SELECT h.id, h.track_id AS id2, h.track_id AS trackId, h.title, h.artist, h.artist_id AS artistId,
            h.album, h.album_id AS albumId, h.cover, h.duration, h.started_at AS playedAt,
            h.listened_seconds AS listenedSeconds, h.completed
     FROM listening_history h
     WHERE h.user_id = ?1
       AND h.id = (SELECT MAX(h2.id) FROM listening_history h2 WHERE h2.user_id = h.user_id AND h2.track_id = h.track_id)
     ORDER BY h.started_at DESC
     LIMIT ?2 OFFSET ?3`,
    [userId, limit, offset],
  );
}

export async function topArtistsByAffinity(env, userId, limit = 6) {
  return all(
    env,
    `SELECT artist_id AS artistId, SUM(plays) AS plays,
            SUM(listened_seconds) AS seconds,
            SUM(completions) AS completions,
            MAX(last_played_at) AS lastPlayedAt
     FROM user_track_affinity
     WHERE user_id = ?1 AND artist_id IS NOT NULL
     GROUP BY artist_id
     ORDER BY (SUM(plays) + SUM(completions) * 0.6) * (1.0 / (1 + (julianday('now') - julianday(MAX(last_played_at))))) DESC
     LIMIT ?2`,
    [userId, limit],
  );
}

export async function recentlyPlayedTrackIds(env, userId, days = 7, limit = 60) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await all(
    env,
    `SELECT track_id FROM user_track_affinity
     WHERE user_id = ?1 AND last_played_at > ?2 ORDER BY plays DESC LIMIT ?3`,
    [userId, since, limit],
  );
  return rows.map((r) => r.track_id);
}

export async function userHistoryStats(env, userId) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS plays, COUNT(DISTINCT track_id) AS tracks, MAX(started_at) AS lastAt
     FROM listening_history WHERE user_id = ?1`,
    [userId],
  );
  return row || { plays: 0, tracks: 0, lastAt: null };
}

export async function globalPopularTracks(env, limit = 20, minPlays = 5, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return all(
    env,
    `SELECT track_id AS id, title, artist, artist_id AS artistId, album_id AS albumId, cover,
            COUNT(*) AS plays, COUNT(DISTINCT user_id) AS listeners
     FROM listening_history
     WHERE started_at > ?1
     GROUP BY track_id
     HAVING COUNT(*) >= ?2
     ORDER BY COUNT(DISTINCT user_id) DESC, COUNT(*) DESC
     LIMIT ?3`,
    [since, minPlays, limit],
  );
}

/**
 * Сигналы предпочтений из личной библиотеки и плейлистов:
 * сохранение трека и добавление в плейлист — тоже интерес к исполнителю.
 */
export async function artistSignalsFromCollections(env, userId) {
  const rows = await all(
    env,
    `SELECT artist_id AS artistId, SUM(lib) AS libraryCount, SUM(pl) AS playlistCount FROM (
       SELECT artist_id, COUNT(*) AS lib, 0 AS pl FROM library_tracks
        WHERE user_id = ?1 AND artist_id IS NOT NULL GROUP BY artist_id
       UNION ALL
       SELECT t.artist_id, 0 AS lib, COUNT(*) AS pl FROM playlist_tracks t
         JOIN playlists p ON p.id = t.playlist_id
        WHERE p.user_id = ?1 AND t.artist_id IS NOT NULL GROUP BY t.artist_id
     ) GROUP BY artist_id`,
    [userId],
  );
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.artistId), { libraryCount: row.libraryCount || 0, playlistCount: row.playlistCount || 0 });
  }
  return map;
}

export async function completedTrackIds(env, userId, limit = 100) {
  const rows = await all(
    env,
    `SELECT track_id FROM user_track_affinity WHERE user_id = ?1 AND completions > 0
     ORDER BY completions DESC, last_played_at DESC LIMIT ?2`,
    [userId, limit],
  );
  return rows.map((r) => r.track_id);
}

/**
 * Полное удаление аккаунта и всех персональных данных.
 * Порядок важен: сначала зависимые таблицы, затем пользователь.
 * Внешние привязки удаляются в той же транзакции — после удаления аккаунта
 * повторный вход через того же провайдера должен создать НОВЫЙ чистый аккаунт.
 */
export async function deleteAllUserData(env, userId) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ?1)').bind(userId),
    env.DB.prepare('DELETE FROM playlists WHERE user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM library_tracks WHERE user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM listening_history WHERE user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM user_track_affinity WHERE user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM session_methods WHERE user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM user_preferences WHERE user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM oauth_states WHERE link_user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM reauth_events WHERE user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM oauth_identities WHERE user_id = ?1').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(userId),
  ]);
}

/* ───────────────────────────── внешние аккаунты (OAuth) ───────────────────────────── */

export async function findIdentity(env, provider, subject) {
  return first(
    env,
    `SELECT i.*, u.username, u.email, u.display_name, u.created_at AS user_created_at
     FROM oauth_identities i JOIN users u ON u.id = i.user_id
     WHERE i.provider = ?1 AND i.provider_subject = ?2 LIMIT 1`,
    [provider, subject],
  );
}

export async function listIdentities(env, userId) {
  return all(
    env,
    `SELECT provider, provider_subject AS subject, provider_email AS email, provider_name AS name,
            created_at AS createdAt, last_login_at AS lastLoginAt
     FROM oauth_identities WHERE user_id = ?1 ORDER BY created_at ASC`,
    [userId],
  );
}

export async function insertIdentity(env, { userId, provider, subject, email, name }) {
  const ts = nowIso();
  await run(
    env,
    `INSERT INTO oauth_identities
       (user_id, provider, provider_subject, provider_email, provider_name, created_at, last_login_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)`,
    [userId, provider, subject, email || null, name || null, ts],
  );
}

export async function touchIdentity(env, provider, subject, { email, name } = {}) {
  await run(
    env,
    `UPDATE oauth_identities
     SET last_login_at = ?1, updated_at = ?1,
         provider_email = COALESCE(?2, provider_email),
         provider_name  = COALESCE(?3, provider_name)
     WHERE provider = ?4 AND provider_subject = ?5`,
    [nowIso(), email || null, name || null, provider, subject],
  );
}

export async function deleteIdentity(env, userId, provider) {
  const result = await run(env, 'DELETE FROM oauth_identities WHERE user_id = ?1 AND provider = ?2', [userId, provider]);
  return (result.meta && result.meta.changes) > 0;
}

export async function identityCount(env, userId) {
  const row = await first(env, 'SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?1', [userId]);
  return (row && row.n) || 0;
}

/** OAuth-аккаунт без пароля: password_hash остаётся пустым, вход по паролю невозможен. */
export async function insertOAuthUser(env, { username, email, displayName }) {
  const ts = nowIso();
  const result = await run(
    env,
    `INSERT INTO users (username, email, display_name, password_hash, password_salt, iterations, created_at, updated_at)
     VALUES (?1, ?2, ?3, '', '', 0, ?4, ?4)`,
    [username, email, displayName || username, ts],
  );
  const id = result.meta && result.meta.last_row_id;
  await run(env, 'INSERT OR IGNORE INTO user_preferences (user_id, repeat_mode, shuffle, updated_at) VALUES (?1, \'off\', 0, ?2)', [id, ts]);
  return id;
}

export async function usernameTaken(env, username) {
  const row = await first(env, 'SELECT id FROM users WHERE username = ?1 COLLATE NOCASE LIMIT 1', [username]);
  return !!row;
}

export async function emailTaken(env, email, exceptUserId = 0) {
  const row = await first(env, 'SELECT id FROM users WHERE email = ?1 COLLATE NOCASE LIMIT 1', [email]);
  return !!row && Number(row.id) !== Number(exceptUserId);
}

export async function hasPassword(env, userId) {
  const row = await first(env, 'SELECT password_hash FROM users WHERE id = ?1', [userId]);
  return !!(row && row.password_hash);
}

/* ───────────────────────────── состояния OAuth ───────────────────────────── */

export async function insertOAuthState(env, { state, provider, mode, nonce, codeVerifier, redirectUri, linkUserId, ttlSeconds }) {
  const ts = new Date();
  const expires = new Date(ts.getTime() + ttlSeconds * 1000).toISOString();
  await run(
    env,
    `INSERT INTO oauth_states (state, provider, mode, nonce, code_verifier, redirect_uri, link_user_id, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    [state, provider, mode, nonce, codeVerifier || null, redirectUri || null, linkUserId || null, ts.toISOString(), expires],
  );
}

/** Забирает состояние одноразово: возвращает строку либо null, если оно уже использовано/просрочено. */
export async function consumeOAuthState(env, state) {
  const ts = nowIso();
  const row = await first(
    env,
    'SELECT * FROM oauth_states WHERE state = ?1 AND consumed_at IS NULL AND expires_at > ?2 LIMIT 1',
    [state, ts],
  );
  if (!row) return null;
  const result = await run(
    env,
    'UPDATE oauth_states SET consumed_at = ?1 WHERE state = ?2 AND consumed_at IS NULL',
    [ts, state],
  );
  if (!result.meta || result.meta.changes < 1) return null;
  return row;
}

export async function pruneOAuthStates(env) {
  const cutoff = new Date(Date.now() - 86400000).toISOString();
  await run(env, 'DELETE FROM oauth_states WHERE expires_at <= ?1', [cutoff]);
}

/* ───────────────────────────── подтверждение личности ───────────────────────────── */

export async function addReauth(env, userId, method) {
  const ts = nowIso();
  await run(env, 'INSERT INTO reauth_events (user_id, method, created_at) VALUES (?1, ?2, ?3)', [userId, method, ts]);
  await run(env, 'DELETE FROM reauth_events WHERE created_at <= ?1', [new Date(Date.now() - 7 * 86400000).toISOString()]);
}

/**
 * Атомарно забирает свежее подтверждение личности: только один запрос может
 * использовать событие, и только в пределах своего user_id.
 */
export async function consumeReauth(env, userId, seconds = 300) {
  const since = new Date(Date.now() - seconds * 1000).toISOString();
  const row = await first(
    env,
    'SELECT id FROM reauth_events WHERE user_id = ?1 AND created_at > ?2 AND used_at IS NULL ORDER BY id DESC LIMIT 1',
    [userId, since],
  );
  if (!row) return null;
  const result = await run(
    env,
    'UPDATE reauth_events SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL',
    [nowIso(), row.id],
  );
  if (!result.meta || result.meta.changes < 1) return null;
  return row.id;
}

export async function hasFreshReauth(env, userId, seconds = 300) {
  const since = new Date(Date.now() - seconds * 1000).toISOString();
  const row = await first(
    env,
    'SELECT id FROM reauth_events WHERE user_id = ?1 AND created_at > ?2 AND used_at IS NULL ORDER BY id DESC LIMIT 1',
    [userId, since],
  );
  return row ? row.id : null;
}

export async function useReauth(env, id) {
  await run(env, 'UPDATE reauth_events SET used_at = ?1 WHERE id = ?2', [nowIso(), id]);
}

/**
 * Удаляет привязку провайдера ОДНИМ запросом с проверкой «не последний способ».
 * Условие проверяется в той же транзакции, поэтому два параллельных запроса на
 * отвязку разных провайдеров не могут оставить пользователя без входа:
 * второй увидит уже уменьшившееся количество и удалит 0 строк.
 */
export async function unlinkIfNotLast(env, userId, provider) {
  const result = await run(
    env,
    `DELETE FROM oauth_identities
     WHERE user_id = ?1 AND provider = ?2
       AND (
         EXISTS (SELECT 1 FROM oauth_identities o WHERE o.user_id = ?1 AND o.provider <> ?2)
         OR EXISTS (SELECT 1 FROM users WHERE id = ?1 AND password_hash <> '')
       )`,
    [userId, provider],
  );
  return (result.meta && result.meta.changes) > 0;
}

/* ───────────────────────────── витрина главной ───────────────────────────── */

export async function readHomeSnapshot(env, key) {
  const row = await first(env, 'SELECT payload, fetched_at FROM home_snapshot WHERE key = ?1', [key]);
  if (!row) return null;
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch { payload = null; }
  return payload ? { payload, fetchedAt: row.fetched_at } : null;
}

export async function writeHomeSnapshot(env, key, payload) {
  await run(
    env,
    `INSERT INTO home_snapshot (key, payload, fetched_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET payload = ?2, fetched_at = ?3`,
    [key, JSON.stringify(payload), nowIso()],
  );
}