-- The Restless list (src/restless.js, wave 2 Phase 4, 2026-10-24): things Paul would do with spare
-- energy. When the dial says wired, Morning and Day offer one that fits the time he has. Done makes an
-- item come up more often, Another and Not for me less (weight). Events carry ids only.
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE restless_items (
  id           TEXT PRIMARY KEY,
  text         TEXT NOT NULL,
  kind         TEXT CHECK (kind IS NULL OR kind IN ('move', 'build', 'outside', 'social', 'learn', 'home')),  -- NULL: To sort
  mins         INTEGER CHECK (mins IS NULL OR mins IN (15, 30, 60, 120)),                                   -- 120: 2 h or more
  place        TEXT CHECK (place IS NULL OR place IN ('inside', 'outside')),
  costs        INTEGER CHECK (costs IS NULL OR costs IN (0, 1)),
  weight       REAL NOT NULL DEFAULT 1,      -- the chance of being picked, against the others
  done_n       INTEGER NOT NULL DEFAULT 0,
  skip_n       INTEGER NOT NULL DEFAULT 0,
  hidden_until TEXT,                         -- YYYY-MM-DD: Not for me hides it for the rest of the day
  source       TEXT NOT NULL,                -- todo | morning | day | mail
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX restless_live ON restless_items(deleted_at, kind);
