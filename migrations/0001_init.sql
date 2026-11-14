CREATE TABLE trackers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '•',
  color TEXT NOT NULL DEFAULT '#6366f1',
  kind TEXT NOT NULL DEFAULT 'check',       -- check | count | duration
  polarity TEXT NOT NULL DEFAULT 'build',   -- build (good habit) | quit (bad habit)
  goal REAL,                                -- daily target (build) or daily limit (quit)
  unit TEXT,
  category TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  tracker_id TEXT NOT NULL,
  date TEXT NOT NULL,                       -- local YYYY-MM-DD
  value REAL NOT NULL DEFAULT 1,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_entries_date ON entries(date);
CREATE INDEX idx_entries_tracker_date ON entries(tracker_id, date);
