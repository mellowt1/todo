-- The Energy dial (src/energy.js): its taps are hub events (energy.set, energy.cleared,
-- energy.skipped). The level now and the Sunday grid read them by type and time.
-- Apply with: npx wrangler d1 migrations apply hub --remote

CREATE INDEX events_type_at ON events(type, at);
