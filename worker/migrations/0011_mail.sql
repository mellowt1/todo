-- Email in (src/mail.js): mail Paul forwards to hub@<his domain>. Only subject, original sender,
-- date and a short excerpt are kept; never the full body or attachments.
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE mail (
  id         TEXT PRIMARY KEY,                -- 16 of a-z0-9
  kind       TEXT NOT NULL CHECK (kind IN ('todo', 'later', 'wait', 'triage')),
  subject    TEXT NOT NULL,                   -- without the prefix and tags
  sender     TEXT,                            -- the original sender, as "Name <address>" or a name
  sent_at    TEXT,                            -- the original date when the forward says it, else received
  excerpt    TEXT NOT NULL DEFAULT '',
  energy     TEXT CHECK (energy IS NULL OR energy IN ('wired', 'normal', 'drained')),  -- a #tag
  others     INTEGER NOT NULL DEFAULT 0,      -- #others
  state      TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'task', 'waiting', 'later', 'done', 'dropped')),
  target     TEXT,                            -- the task or waiting item it became
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX mail_open ON mail(state, kind, created_at);

-- The reactions run on the hub's queue like every other event (src/hub.js TARGETS.mail).
INSERT INTO rules (id, source, type, target, fields, enabled) VALUES
  ('mail-received', 'mail', 'email.received', 'mail', '["id"]', 1),
  ('mail-sorted-day', 'day', 'email.sorted', 'mail', '["id","as"]', 1);
