-- Calendars connected by signing in with Google or Microsoft (OAuth), alongside link-based (.ics) imports.
ALTER TABLE calendar_sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'ics';  -- ics | google | microsoft
ALTER TABLE calendar_sources ADD COLUMN account_email TEXT;
ALTER TABLE calendar_sources ADD COLUMN token_enc TEXT;                    -- AES-GCM encrypted refresh token
ALTER TABLE calendar_sources ADD COLUMN calendars TEXT NOT NULL DEFAULT '[]'; -- JSON [{id, name}] selected for import

CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY,               -- sha256 of the random state value
  user_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  member_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'shared',
  verifier TEXT NOT NULL,            -- PKCE code verifier
  created_at INTEGER NOT NULL
);
