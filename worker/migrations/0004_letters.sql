-- Letter action cards (src/letters.js). An official letter read by Intake gets one card; each
-- task Intake made from it points at the card. The card holds what the letter says (amount,
-- IBAN, payment reference, case number, the choices it offers) and only the card shows them.
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE letters (
  id         TEXT PRIMARY KEY,                       -- the intake record's id
  card       TEXT NOT NULL CHECK (json_valid(card)),
  pick       INTEGER,                                -- which of card.options Paul chose, or NULL
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE letter_tasks (
  task_id   TEXT PRIMARY KEY,
  letter_id TEXT NOT NULL REFERENCES letters(id),
  done_date TEXT,                                    -- YYYY-MM-DD, the day Paul says it was done
  done_how  TEXT CHECK (done_how IS NULL OR done_how IN ('paid', 'form sent', 'called')),
  done_at   TEXT                                     -- when he pressed Done (ISO, UTC)
);
CREATE INDEX letter_tasks_letter ON letter_tasks(letter_id);

-- Where each sender's portal is. Matched against the sender's name, longest name first.
-- Paul adds senders with POST /api/admin/config/letter_portals (src/dinner.js checks it).
INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('letter_portals',
  '{"Belastingdienst":"https://mijn.belastingdienst.nl","Toeslagen":"https://mijn.toeslagen.nl","DUO":"https://mijn.duo.nl","Gemeente Den Haag":"https://www.denhaag.nl"}',
  '2026-10-12T00:00:00Z');
