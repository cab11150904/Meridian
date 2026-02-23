-- Meridian D1 Schema
-- Run with: npx wrangler d1 execute meridian-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('work', 'personal')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT DEFAULT '',
  type       TEXT DEFAULT 'work',
  notes      TEXT DEFAULT '',
  source     TEXT DEFAULT 'manual',
  event_date TEXT DEFAULT (date('now')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
