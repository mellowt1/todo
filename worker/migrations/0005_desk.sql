-- Desk (src/desk.js): every line Paul types on Morning's Desk and what became of each action
-- Claude prepared for it. Kept for the friction readout after two weeks; Morning never shows it.
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE desk_log (
  id         TEXT PRIMARY KEY,                        -- the Desk item's id
  at         TEXT NOT NULL,                           -- when Paul typed it (ISO, UTC)
  text       TEXT NOT NULL,                           -- the line, masked (src/mask.js)
  kinds      TEXT NOT NULL,                           -- what was prepared: "todo,draft,answer"
  outcome    TEXT NOT NULL CHECK (json_valid(outcome)), -- each action's state: ["approved","skipped"]
  updated_at TEXT NOT NULL
);
CREATE INDEX desk_log_at ON desk_log(at);
