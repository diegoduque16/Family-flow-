-- Family Flow schema v1
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_iter INTEGER NOT NULL,
  current_household_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,              -- sha-256 of the token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  ics_token TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,   -- change counter for sync
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'adult',   -- adult | child
  sort INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_members_hh ON members(household_id, seq);

CREATE TABLE IF NOT EXISTS memberships (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                 -- owner | adult | child
  member_id TEXT,                     -- which family profile this login is
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,                -- sha-256 of the token
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  member_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  location_name TEXT NOT NULL DEFAULT '',
  location_address TEXT NOT NULL DEFAULT '',
  lat REAL, lon REAL,
  all_day INTEGER NOT NULL DEFAULT 0,
  start_local TEXT NOT NULL,          -- YYYY-MM-DDTHH:MM (or YYYY-MM-DD when all-day)
  end_local TEXT NOT NULL,            -- exclusive end date for all-day events
  tz TEXT NOT NULL,
  start_utc INTEGER NOT NULL,
  end_utc INTEGER NOT NULL,
  rrule TEXT,                         -- FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;UNTIL=...;COUNT=...
  series_end_utc INTEGER,             -- last possible occurrence end (null = open-ended)
  exdates TEXT NOT NULL DEFAULT '[]', -- JSON array of start_local strings skipped
  assignees TEXT NOT NULL DEFAULT '[]', -- JSON array of member ids
  visibility TEXT NOT NULL DEFAULT 'shared', -- shared | private
  reminders TEXT NOT NULL DEFAULT '[]', -- JSON array of minutes before start
  owner_user_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_hh_seq ON events(household_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_hh_time ON events(household_id, start_utc);

CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'todo',  -- todo | shopping
  sort INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lists_hh ON lists(household_id, seq);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_local TEXT,                     -- YYYY-MM-DD or YYYY-MM-DDTHH:MM
  due_utc INTEGER,
  assignee TEXT,                      -- member id
  repeat TEXT,                        -- daily | weekly | monthly | null
  remind INTEGER NOT NULL DEFAULT 0,  -- 1 = remind at due time
  event_id TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_hh ON tasks(household_id, seq);

CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL, lon REAL,
  favorite INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (household_id, address)
);

CREATE TABLE IF NOT EXISTS scheduled_notifications (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  ref_type TEXT NOT NULL,             -- event | task
  ref_id TEXT NOT NULL,
  only_user_id TEXT,                  -- private items: only this user
  fire_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  error TEXT,
  UNIQUE (ref_type, ref_id, fire_at)
);
CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_notifications(status, fire_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT,                       -- null = everyone in household
  kind TEXT NOT NULL,                 -- reminder | info
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  ref_type TEXT, ref_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_hh ON notifications(household_id, created_at);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                 -- user | assistant
  content TEXT NOT NULL,              -- JSON (Anthropic content blocks)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  conversation_id TEXT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- event | task
  payload TEXT NOT NULL,              -- JSON, validated
  notes TEXT NOT NULL DEFAULT '[]',   -- JSON: what the AI assumed
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | dismissed
  result_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proposals_hh ON proposals(household_id, status);

CREATE TABLE IF NOT EXISTS usage (
  household_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (household_id, day, kind)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  household_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  ref_type TEXT, ref_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_hh ON audit(household_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
