-- Sunday reset (src/week.js): Morning's Week view and the Sunday push.
-- Apply with: npx wrangler d1 migrations apply hub --remote

-- What the Week view's buttons left behind, one row per task:
--   snooze    "New date": the task stays out of Gone quiet and goes into Today on `until`
--   moved     "Do this week" moved it to Soon; `prev` is the task before, for Undo
--   restored  Undo put it back; while the task still carries updatedAt = `at`, its quiet
--             clock runs from prev's updatedAt, so Undo does not make it look touched
CREATE TABLE week_marks (
  task_id TEXT PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN ('snooze', 'moved', 'restored')),
  until   TEXT,                                          -- snooze: YYYY-MM-DD, Amsterdam
  prev    TEXT CHECK (prev IS NULL OR json_valid(prev)),
  at      INTEGER NOT NULL                               -- ms since epoch
);

-- Quiet hours for the hub's own pushes. sunday_reset_time is set by Paul (no default: no push).
INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('quiet_hours', '22:00-08:00', '2026-10-12T00:00:00Z');
