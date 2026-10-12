-- The hub's event log and its rules (src/hub.js). HUB_KV keeps everything it held before;
-- only typed events live here. Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE events (
  id        TEXT PRIMARY KEY,              -- the sender's stable id (a vacancy: sha256 of its URL)
  source    TEXT NOT NULL,
  type      TEXT NOT NULL,
  summary   TEXT NOT NULL,
  payload   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  caused_by TEXT,
  hops      INTEGER NOT NULL DEFAULT 0,
  at        TEXT NOT NULL                  -- ISO 8601, UTC
);
CREATE INDEX events_at ON events(at);

CREATE TABLE rules (
  id      TEXT PRIMARY KEY,
  source  TEXT NOT NULL,
  type    TEXT NOT NULL,
  target  TEXT NOT NULL,
  fields  TEXT NOT NULL CHECK (json_valid(fields)),   -- the payload fields the target may see
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);
CREATE INDEX rules_match ON rules(source, type, enabled);

CREATE TABLE handled (
  target   TEXT NOT NULL,
  event_id TEXT NOT NULL,
  at       TEXT NOT NULL,
  PRIMARY KEY (target, event_id)
);

INSERT INTO rules (id, source, type, target, fields, enabled) VALUES
  ('digest-vacancy-todo', 'defence-digest', 'vacancy.found', 'todo', '["title","organisation","link","deadline"]', 1);
