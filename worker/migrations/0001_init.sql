-- RH—MUSIC · начальная схема D1 (миграция 0001)
-- Все пользовательские данные привязаны к users(id) внешними ключами.
-- Аудиофайлы в базе не хранятся: только метаданные каталога.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  display_name  TEXT,
  password_hash TEXT    NOT NULL,
  password_salt TEXT    NOT NULL,
  iterations    INTEGER NOT NULL DEFAULT 150000,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users (username COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email    ON users (email COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_token  ON sessions (token_hash);
CREATE INDEX        IF NOT EXISTS ix_sessions_user   ON sessions (user_id);
CREATE INDEX        IF NOT EXISTS ix_sessions_expire ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS library_tracks (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id  TEXT    NOT NULL,
  title     TEXT    NOT NULL,
  artist    TEXT,
  artist_id TEXT,
  album     TEXT,
  album_id  TEXT,
  cover     TEXT,
  duration  INTEGER,
  added_at  TEXT    NOT NULL,
  PRIMARY KEY (user_id, track_id)
);

CREATE INDEX IF NOT EXISTS ix_library_user_added ON library_tracks (user_id, added_at DESC);

CREATE TABLE IF NOT EXISTS playlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  description TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_playlists_user ON playlists (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    TEXT    NOT NULL,
  position    INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  artist      TEXT,
  artist_id   TEXT,
  album       TEXT,
  album_id    TEXT,
  cover       TEXT,
  duration    INTEGER,
  added_at    TEXT    NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);

CREATE INDEX IF NOT EXISTS ix_playlist_tracks_pos ON playlist_tracks (playlist_id, position);

CREATE TABLE IF NOT EXISTS listening_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id         TEXT    NOT NULL,
  title            TEXT,
  artist           TEXT,
  artist_id        TEXT,
  album            TEXT,
  album_id         TEXT,
  cover            TEXT,
  duration         INTEGER,
  started_at       TEXT    NOT NULL,
  listened_seconds INTEGER NOT NULL DEFAULT 0,
  completed        INTEGER NOT NULL DEFAULT 0,
  source           TEXT
);

CREATE INDEX IF NOT EXISTS ix_history_user_started ON listening_history (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_history_track        ON listening_history (track_id, started_at DESC);

-- Агрегат по треку для рекомендаций (обновляется при прослушивании, чтобы не считать каждый раз).
CREATE TABLE IF NOT EXISTS user_track_affinity (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id         TEXT    NOT NULL,
  title            TEXT,
  artist_id        TEXT,
  album_id         TEXT,
  plays            INTEGER NOT NULL DEFAULT 0,
  listened_seconds INTEGER NOT NULL DEFAULT 0,
  completions      INTEGER NOT NULL DEFAULT 0,
  first_played_at  TEXT    NOT NULL,
  last_played_at   TEXT    NOT NULL,
  PRIMARY KEY (user_id, track_id)
);

CREATE INDEX IF NOT EXISTS ix_affinity_user_recent ON user_track_affinity (user_id, last_played_at DESC);
CREATE INDEX IF NOT EXISTS ix_affinity_user_plays  ON user_track_affinity (user_id, plays DESC);
CREATE INDEX IF NOT EXISTS ix_affinity_artist      ON user_track_affinity (user_id, artist_id);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  repeat_mode TEXT    NOT NULL DEFAULT 'off',
  shuffle     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL
);

-- Ограничение частоты попыток входа/регистрации.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT    NOT NULL,
  action     TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_attempts_ip_action ON auth_attempts (ip, action, created_at);