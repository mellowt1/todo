-- Lessons (src/lessons.js): what Paul did with what Claude gave him, and the short rules Claude
-- learns from it. Paul keeps or drops each rule on Morning's Week view; kept rules go into the
-- prompts of Desk and Tidy.
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE feedback (
  id     TEXT PRIMARY KEY,
  at     TEXT NOT NULL,      -- ISO, UTC
  app    TEXT NOT NULL,      -- desk | tidy
  kind   TEXT NOT NULL,      -- approved | copied | edited | skipped | undone
  before TEXT,               -- what Claude gave, masked
  after  TEXT,               -- what Paul kept instead (edited, undone), masked
  note   TEXT                -- desk: the line Paul typed; tidy: null
);
CREATE INDEX feedback_at ON feedback(at);

CREATE TABLE lessons (
  id         TEXT PRIMARY KEY,
  app        TEXT NOT NULL,                         -- desk | tidy
  text       TEXT NOT NULL,                         -- one rule, said to Claude
  why        TEXT NOT NULL,                         -- one line for Paul: the corrections behind it
  state      TEXT NOT NULL DEFAULT 'proposed',      -- proposed | kept | dropped
  week       TEXT NOT NULL,                         -- the Monday of the Sunday that proposed it
  at         TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX lessons_state ON lessons(state);
