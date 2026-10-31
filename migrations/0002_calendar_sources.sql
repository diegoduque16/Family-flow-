-- Imported calendars (Google / Outlook / Apple via their private iCal links)
CREATE TABLE IF NOT EXISTS calendar_sources (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'ics',      -- google | outlook | apple | ics (detected from the link)
  url TEXT NOT NULL,
  member_id TEXT,                            -- family profile the events belong to (optional)
  visibility TEXT NOT NULL DEFAULT 'shared', -- shared | private (only the person who added it)
  etag TEXT,
  last_modified TEXT,
  last_sync_at INTEGER,
  last_ok_at INTEGER,
  last_status TEXT,                          -- ok | error | not_modified
  last_error TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sources_hh ON calendar_sources(household_id);
CREATE INDEX IF NOT EXISTS idx_sources_due ON calendar_sources(deleted_at, last_sync_at);

ALTER TABLE events ADD COLUMN source_id TEXT;
ALTER TABLE events ADD COLUMN ext_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_id);
