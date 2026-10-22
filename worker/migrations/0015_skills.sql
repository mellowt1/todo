-- The Skills gap tracker (src/skills.js, wave 2 Phase 2, 2026-10-22): the roles Paul tracks, what each
-- asks for, how his own side matches it, and the gaps he works on. Private behind the to-do's code.
-- Events carry ids only (skills.*, gap.*); never a requirement, a line of his side or a note.
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE skill_roles (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  org        TEXT,
  link       TEXT,
  deadline   TEXT,                              -- YYYY-MM-DD; the day after, the role is past
  source     TEXT NOT NULL CHECK (source IN ('digest', 'paste')),
  task_id    TEXT,                              -- the Apply task in To-do it was tracked from
  text       TEXT,                              -- the vacancy text, at most 20000 characters
  state      TEXT NOT NULL DEFAULT 'reading' CHECK (state IN ('reading', 'ready', 'needs_text', 'failed', 'past')),
  error      TEXT,
  runs       INTEGER NOT NULL DEFAULT 0,        -- each read or check is a queue message of its own
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  read_at    TEXT,
  matched_at TEXT
);
CREATE UNIQUE INDEX skill_roles_task ON skill_roles(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE skill_reqs (
  role_id TEXT NOT NULL,
  key     TEXT NOT NULL,                        -- the label made comparable: french-b2
  label   TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('skill', 'experience', 'language', 'clearance', 'qualification')),
  must    INTEGER NOT NULL DEFAULT 1 CHECK (must IN (0, 1)),
  status  TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('have', 'partly', 'missing', 'unknown')),
  line_id TEXT,
  why     TEXT,
  pos     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role_id, key)
);

-- Paul's side: his CV Studio blocks as he pasted them (cv), and gaps he closed in his own words (closed).
CREATE TABLE skill_lines (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('cv', 'closed')),
  gap        TEXT,                              -- the gap key a closed line belongs to
  pos        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE skill_gaps (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  closed      INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  closed_note TEXT,
  closed_at   TEXT,
  options     TEXT CHECK (options IS NULL OR json_valid(options)),
  options_at  TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE skill_steps (
  id         TEXT PRIMARY KEY,
  gap        TEXT NOT NULL,
  text       TEXT NOT NULL,
  task_id    TEXT,
  source     TEXT NOT NULL DEFAULT 'paul' CHECK (source IN ('paul', 'claude')),
  created_at TEXT NOT NULL
);
CREATE INDEX skill_steps_gap ON skill_steps(gap, created_at);
