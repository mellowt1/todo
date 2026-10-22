-- The Oracle question (src/oracle.js, Phase 6, 2026-10-22): one question a week from Claude about
-- Paul's week, and his answer. Each change is also a hub event (oracle.asked, oracle.answered).
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE oracle (
  week        TEXT PRIMARY KEY,                -- YYYY-MM-DD: the Monday of the week asked about
  label       TEXT NOT NULL,                   -- "Week 43"
  question    TEXT,                            -- NULL: the call failed or there was too little to ask
  asked_at    TEXT NOT NULL,                   -- ISO 8601, UTC: when the week was reserved
  state       TEXT NOT NULL DEFAULT 'none' CHECK (state IN ('none', 'open', 'answered', 'aside')),
  answer      TEXT,                            -- Paul's own words, at most 1000 characters
  answered_at TEXT
);
