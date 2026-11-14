-- accounts
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  tz TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- sha256 of the cookie token
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
);

-- every row belongs to a user (existing rows are claimed by the first account)
ALTER TABLE trackers ADD COLUMN user_id TEXT;
ALTER TABLE entries ADD COLUMN user_id TEXT;
ALTER TABLE books ADD COLUMN user_id TEXT;
ALTER TABLE push_subs ADD COLUMN user_id TEXT;
CREATE INDEX idx_trackers_user ON trackers(user_id, sort);
CREATE INDEX idx_entries_user_date ON entries(user_id, date);
CREATE INDEX idx_books_user ON books(user_id);
CREATE INDEX idx_push_user ON push_subs(user_id);

-- daily diary with mood
CREATE TABLE diary (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  mood INTEGER,                      -- 1..5
  text TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);
