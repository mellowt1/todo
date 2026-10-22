-- Archive (src/archive.js, Phase 5, 2026-10-22): tasks Paul decided not to do after passing on them
-- five times. The task leaves the list; its row stays here for the Archived ledger and Restore.
-- Each change is also a hub event (task.fate_due, task.buried, task.resurrected, task.fate_later).
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE archive (
  task_id     TEXT PRIMARY KEY,              -- the To-do id; Restore brings it back under the same id
  item        TEXT NOT NULL CHECK (json_valid(item)), -- the task as it was, for Restore
  added_at    INTEGER,                       -- ms: when the task was made, if known (`created`)
  archived_at TEXT NOT NULL,                 -- ISO 8601, UTC
  skips       INTEGER NOT NULL,              -- passed on this many times when archived
  note        TEXT,                          -- Paul's own note, at most 80 characters
  state       TEXT NOT NULL DEFAULT 'archived' CHECK (state IN ('archived', 'restored')),
  restored_at TEXT
);
CREATE INDEX archive_state ON archive(state, archived_at);
