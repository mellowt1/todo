-- Waiting on (src/waiting.js): things Paul sent and is waiting to hear back about. Each change
-- is also a hub event (waiting.created, waiting.chase_due, waiting.snoozed, waiting.resolved).
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE waiting (
  id          TEXT PRIMARY KEY,                -- 16 of a-z0-9
  who         TEXT NOT NULL,
  what        TEXT NOT NULL,
  since       TEXT NOT NULL,                   -- YYYY-MM-DD, Amsterdam: when it was sent
  chase_days  INTEGER NOT NULL,                -- the gap between chases
  next_chase  TEXT NOT NULL,                   -- YYYY-MM-DD: the day the next chase task comes
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'phone', 'letter', 'in-person')),
  for_whom    TEXT,                            -- NULL: for Paul; else the name it is for
  source      TEXT NOT NULL,                   -- todo | morning | day | apply
  source_item TEXT,                            -- the To-do task it came from, if any
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  chase_task  TEXT,                            -- the To-do id of the chase task out now, if any
  chases      INTEGER NOT NULL DEFAULT 0,      -- chase tasks made so far
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX waiting_open ON waiting(state, next_chase);
CREATE UNIQUE INDEX waiting_source ON waiting(source_item) WHERE source_item IS NOT NULL;
