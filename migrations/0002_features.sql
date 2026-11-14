-- schedules, reminders, pin & order
ALTER TABLE trackers ADD COLUMN period TEXT NOT NULL DEFAULT 'day';   -- day | week
ALTER TABLE trackers ADD COLUMN days TEXT;                            -- "1,3,5" (0=Sun..6=Sat); NULL = every day
ALTER TABLE trackers ADD COLUMN reminders TEXT;                       -- JSON array of "HH:MM"
ALTER TABLE trackers ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trackers ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
UPDATE trackers SET sort = rowid;

-- books
ALTER TABLE entries ADD COLUMN book_id TEXT;
CREATE INDEX idx_entries_book ON entries(book_id);
CREATE TABLE books (
  id TEXT PRIMARY KEY,
  tracker_id TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  total_pages INTEGER,
  start_page INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reading',   -- reading | finished
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- push notifications
CREATE TABLE push_subs (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
