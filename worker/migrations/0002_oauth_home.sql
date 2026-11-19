-- RH—MUSIC · миграция 0002
-- Внешние способы входа, одноразовые OAuth-состояния, подтверждение личности
-- для чувствительных операций и снимок витрины главной страницы.
-- Все выражения идемпотентны: мигратор применяет файл целиком при каждом запуске.

-- Привязки внешних аккаунтов к внутреннему users.id.
-- provider_subject — устойчивый идентификатор у провайдера (sub/subject/user_id),
-- provider_email — email, который вернул провайдер (может быть скрытым у Apple).
-- Один внешний идентификатор не может принадлежать двум аккаунтам RH—MUSIC.
CREATE TABLE IF NOT EXISTS oauth_identities (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT    NOT NULL,
  provider_subject TEXT    NOT NULL,
  provider_email   TEXT,
  provider_name    TEXT,
  created_at       TEXT    NOT NULL,
  last_login_at    TEXT,
  updated_at       TEXT    NOT NULL,
  UNIQUE (provider, provider_subject)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_oauth_identity ON oauth_identities (provider, provider_subject);
CREATE INDEX IF NOT EXISTS ix_oauth_identity_user ON oauth_identities (user_id, provider);

-- Одноразовые состояния OAuth: защита от CSRF/replay, хранение nonce и PKCE.
CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  provider      TEXT    NOT NULL,
  mode          TEXT    NOT NULL DEFAULT 'login',
  nonce         TEXT    NOT NULL,
  code_verifier TEXT,
  redirect_uri  TEXT,
  link_user_id  INTEGER,
  created_at    TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,
  consumed_at   TEXT
);

CREATE INDEX IF NOT EXISTS ix_oauth_states_expire ON oauth_states (expires_at);
CREATE INDEX IF NOT EXISTS ix_oauth_states_user   ON oauth_states (link_user_id);

-- Свежее подтверждение личности для опасных действий (отвязка провайдера,
-- удаление аккаунта). Живёт 5 минут, одноразовое.
CREATE TABLE IF NOT EXISTS reauth_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method     TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  used_at    TEXT
);

CREATE INDEX IF NOT EXISTS ix_reauth_user ON reauth_events (user_id, created_at DESC);

-- Снимок витрины главной страницы: общий контент для всех посетителей.
-- Хранится в D1, чтобы не зависеть от памяти изолята и не тратить внешние запросы.
CREATE TABLE IF NOT EXISTS home_snapshot (
  key        TEXT PRIMARY KEY,
  payload    TEXT    NOT NULL,
  fetched_at TEXT    NOT NULL
);