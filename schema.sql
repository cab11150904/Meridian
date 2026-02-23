-- Meridian D1 Schema — Multi-tenant
-- Run one statement at a time in the Cloudflare D1 console, or:
--   npx wrangler d1 execute meridian-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS settings (
  user_id    TEXT PRIMARY KEY,
  name       TEXT    DEFAULT '',
  role       TEXT    DEFAULT '',
  work_start TEXT    DEFAULT '9:00 AM',
  work_end   TEXT    DEFAULT '6:00 PM',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS goals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  type       TEXT    NOT NULL CHECK(type IN ('work', 'personal')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  start_time TEXT    NOT NULL,
  end_time   TEXT    DEFAULT '',
  type       TEXT    DEFAULT 'work',
  notes      TEXT    DEFAULT '',
  source     TEXT    DEFAULT 'manual',
  event_date TEXT    DEFAULT (date('now')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_user_date ON events(user_id, event_date);
