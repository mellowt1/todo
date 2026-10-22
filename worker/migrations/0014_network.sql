-- The Network map (src/network.js, wave 2 Phase 1, 2026-10-22): the people Paul knows, by sector, and
-- how they are tied together. Private behind the to-do's code. Each change is also a hub event with
-- ids only (person.added, person.updated, person.deleted, person.contacted, person.reach,
-- person.imported, tie.added, tie.removed); never a name or a note.
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE TABLE people (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  org          TEXT,
  role         TEXT,
  sector       TEXT NOT NULL DEFAULT 'sort' CHECK (sector IN ('emb', 'min', 'ind', 'nato', 'other', 'sort')),
  met_where    TEXT,
  met_when     TEXT,                            -- YYYY-MM
  topics       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(topics)),
  notes        TEXT,
  email        TEXT,
  phone        TEXT,
  linkedin     TEXT,                            -- https://www.linkedin.com/in/...
  last_contact TEXT,                            -- YYYY-MM-DD
  source       TEXT NOT NULL DEFAULT 'hand' CHECK (source IN ('hand', 'linkedin')),
  connected_on TEXT,                            -- YYYY-MM-DD from LinkedIn; never counts as contact
  reach_task   TEXT,                            -- the open "Reach out to ..." task in To-do
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX people_linkedin ON people(linkedin) WHERE linkedin IS NOT NULL;

CREATE TABLE ties (
  a          TEXT NOT NULL,                     -- introduced: a introduced b; works_with: a < b
  b          TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('introduced', 'works_with')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (a, b, kind)
);

-- A Waiting on item made from a person's card ("Sent a message"); its answer moves Last contact.
ALTER TABLE waiting ADD COLUMN person TEXT;
