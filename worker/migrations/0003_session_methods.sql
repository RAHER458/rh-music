-- RH—MUSIC · миграция 0003
-- Каким способом была создана конкретная серверная сессия.
-- Нужно, чтобы интерфейс мог показать «текущий вход» без доверия к клиенту.
-- Выражение идемпотентно: мигратор применяет файл целиком при каждом запуске.

CREATE TABLE IF NOT EXISTS session_methods (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method     TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_session_methods_user ON session_methods (user_id);