-- Out for dinner (src/hub.js, src/dinner.js). Day on the Mac reads Paul's calendar and posts
-- day / dinner.away when an event overlaps his dinner window, and dinner.back when it no longer
-- does. Kitchen marks the date "Paul out"; Morning shows the event's title to Paul.
-- Apply with: npx wrangler d1 migrations apply hub --remote

-- Settings a sender may read (GET /api/hub/config/:source) and Paul sets
-- (POST /api/admin/config/:key, ADMIN_TOKEN). dinner_window is "HH:MM-HH:MM", Amsterdam time.
CREATE TABLE config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Kitchen sees only the date: its handler stores no title (Olivia reads Kitchen).
INSERT INTO rules (id, source, type, target, fields, enabled) VALUES
  ('day-dinner-away-kitchen', 'day', 'dinner.away', 'kitchen', '["date","title"]', 1),
  ('day-dinner-back-kitchen', 'day', 'dinner.back', 'kitchen', '["date","title"]', 1);
