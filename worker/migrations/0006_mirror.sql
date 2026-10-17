-- The Mirror (src/mirror.js): one row per Amsterdam date with what the hub can read about Paul's
-- day from his own apps. Sundays the Mirror reads these rows for one finding and one experiment.
-- A NULL is "not known": the source was down, or it does not reach back that far.
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE mirror_days (
  date       TEXT PRIMARY KEY,   -- YYYY-MM-DD, Amsterdam
  mood       INTEGER,            -- Feeling face: 1 very bad, 2 bad, 3 okay, 4 good, 5 very good, 6 angry
  done       INTEGER,            -- to-dos ticked off that day
  dinner     TEXT,               -- Paul's Kitchen dinner: recipe | pizza | text | out
  arsenal    TEXT,               -- W | D | L on a match day
  temp       REAL,               -- Den Haag, max in °C
  rain       REAL,               -- mm
  sun        REAL,               -- hours of sunshine
  cal_n      INTEGER,            -- Day's events that day (subscribed Arsenal fixtures left out)
  cal_h      REAL,               -- hours of timed events
  cal_first  REAL,               -- first timed start, hours after midnight (8.5 = 08:30)
  updated_at TEXT NOT NULL
);
