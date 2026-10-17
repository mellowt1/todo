-- Hiscores (src/hiscores.js): Paul's real life as OSRS skills. One row per thing that earned XP,
-- with a stable id from its source, so scanning again never counts it twice. XP is never taken back.
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE xp_log (
  id    TEXT PRIMARY KEY,   -- source:key, e.g. "wc:<task id>", "ck:2026-10-12", "mg:<call id>"
  skill TEXT NOT NULL,      -- woodcutting | cooking | ranged | magic | slayer | prayer | crafting | construction
  xp    INTEGER NOT NULL,
  at    TEXT NOT NULL,      -- when it was earned (ISO, UTC)
  what  TEXT NOT NULL       -- one short line for the log
);
CREATE INDEX xp_log_at ON xp_log(at);
CREATE INDEX xp_log_skill ON xp_log(skill);
