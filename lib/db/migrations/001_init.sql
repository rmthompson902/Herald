CREATE TABLE schedules (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  qlab_cue_number    TEXT NOT NULL,
  interval_seconds   INTEGER,
  start_time         TEXT,
  end_time           TEXT,
  weekdays           TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
  date_range_start   TEXT,
  date_range_end     TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_schedules_enabled ON schedules(enabled);

CREATE TABLE vog_messages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  qlab_cue_number    TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE cue_cache (
  qlab_cue_number    TEXT PRIMARY KEY,
  qlab_internal_id   TEXT,
  cue_display_name   TEXT,
  duration_seconds   REAL,
  zones              TEXT,
  refreshed_at       TEXT NOT NULL
);
