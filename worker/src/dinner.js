/* Out for dinner: Day's calendar marks Paul out in Kitchen, and Morning names the event.
 *
 * Day (the Mac) reads Paul's calendar, keeps the events that overlap his dinner window, and
 * posts one typed event per change (src/hub.js):
 *
 *   { id: "dinner:<16 hex>:<YYYY-MM-DD>:<seq>", source: "day", type: "dinner.away" | "dinner.back",
 *     summary, payload: { date, title?, start? } }
 *
 * The first three parts of the id are the base: one calendar event on one date. seq goes up by
 * one with each change Day sends for that base, so a late retry of an older message never wins.
 *
 * Kitchen (the rule's target) keeps base -> { date, away, seq } in its Durable Object and shows
 * the date as "Paul out". It never stores the title: Olivia reads Kitchen.
 * Morning reads the hub's own event log (D1 events) for the title; only Paul reads Morning.
 *
 * Day reads the window it filters by from the hub:
 *   GET  /api/hub/config/day          Bearer HUB_SECRET_DAY  -> { dinner_window: "18:00-21:00" | null }
 *   GET  /api/admin/config            ADMIN_TOKEN            -> { config: { key: value } }
 *   POST /api/admin/config/:key       ADMIN_TOKEN            <- { value: "18:00-21:00" | null }
 *
 * The same table holds the Sunday reset's settings (src/week.js): sunday_reset_time ("18:00", when
 * the Sunday push goes) and quiet_hours ("22:00-08:00", may cross midnight; no push inside it).
 * letter_portals holds the letter cards' portal links (src/letters.js); send the whole map.
 */

import { safeEqual, bearer } from './todo.js';
import { secretName, cleanDate } from './hub.js';
import { kitchen } from './kitchen-store.js';

export const DINNER_ID = /^(dinner:[0-9a-f]{16}:(\d{4}-\d{2}-\d{2})):(\d{1,9})$/;
export const AHEAD_DAYS = 7;
const DAY_MS = 86400000;
const TZ = 'Europe/Amsterdam';

/* Pure: "dinner:<hex>:<date>:<seq>" -> { base, date, seq }, or null. */
export function parseDinnerId(id) {
  const m = typeof id === 'string' ? DINNER_ID.exec(id) : null;
  if (!m || !cleanDate(m[2])) return null;
  return { base: m[1], date: m[2], seq: Number(m[3]) };
}

/* ---------- Config ---------- */

const HHMM = '([01]\\d|2[0-3]):([0-5]\\d)';
const WINDOW = new RegExp('^' + HHMM + '-' + HHMM + '$');
const TIME = new RegExp('^' + HHMM + '$');

/* Pure: what each key may hold. A value that fails is refused, never stored. */
export const CONFIG = {
  dinner_window(v) {
    const m = typeof v === 'string' ? WINDOW.exec(v.trim()) : null;
    if (!m) return null;
    const from = +m[1] * 60 + +m[2];
    const to = +m[3] * 60 + +m[4];
    return to > from ? v.trim() : null; // same evening only; never across midnight
  },
  sunday_reset_time(v) {
    return typeof v === 'string' && TIME.test(v.trim()) ? v.trim() : null;
  },
  quiet_hours(v) {
    const m = typeof v === 'string' ? WINDOW.exec(v.trim()) : null;
    if (!m) return null;
    return m[1] + m[2] !== m[3] + m[4] ? v.trim() : null; // may cross midnight; never empty
  },
  /* The Mirror (src/mirror.js): Paul in one Feeling circle, { "code": "<circle code>", "id": "<his device id>" }. */
  mirror_feeling(v) {
    let o = v;
    if (typeof v === 'string') { try { o = JSON.parse(v); } catch (e) { return null; } }
    if (!o || typeof o !== 'object' || !/^[a-z0-9]{6,12}$/.test(o.code) || !/^[a-z0-9]{1,32}$/i.test(o.id)) return null;
    return JSON.stringify({ code: o.code, id: o.id });
  },
  /* { "Sender name": "https://portal" }, as JSON text or an object. https only, at most 40. */
  letter_portals(v) {
    let o = v;
    if (typeof v === 'string') { try { o = JSON.parse(v); } catch (e) { return null; } }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const out = {};
    const entries = Object.entries(o);
    if (!entries.length || entries.length > 40) return null;
    for (const [name, url] of entries) {
      const n = String(name).trim();
      if (!n || n.length > 60 || typeof url !== 'string') return null;
      try { if (new URL(url).protocol !== 'https:') return null; } catch (e) { return null; }
      out[n] = url;
    }
    return JSON.stringify(out);
  },
};
const HINTS = {
  dinner_window: 'like "18:00-21:00", the end after the start',
  sunday_reset_time: 'like "18:00"',
  quiet_hours: 'like "22:00-08:00", start and end not the same',
  letter_portals: 'an object like { "DUO": "https://mijn.duo.nl" }, https links, at most 40',
};
// Which keys a sender may read with its own secret.
export const READERS = { day: ['dinner_window'] };

export async function readConfig(env, keys) {
  const out = Object.fromEntries(keys.map((k) => [k, null]));
  if (!keys.length) return out;
  const { results } = await env.HUB_DB.prepare(`SELECT key, value FROM config WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all();
  for (const r of results || []) out[r.key] = r.value;
  return out;
}

/* GET /api/hub/config/:source */
export async function handleHub(request, env, rest, url, json) {
  if (rest.length !== 2 || rest[0] !== 'config') return json({ error: 'not found' }, request, 404);
  const source = rest[1];
  const keys = READERS[source];
  const secret = keys ? env[secretName(source)] : '';
  if (!secret || !safeEqual(bearer(request), secret)) return json({ error: 'unauthorized' }, request, 401);
  if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  return json(await readConfig(env, keys), request);
}

/* /api/admin/config[/:key] (the admin token is checked by the caller) */
export async function adminConfig(request, env, rest, json, readBody, now = Date.now()) {
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  if (rest.length === 0) {
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    return json({ config: await readConfig(env, Object.keys(CONFIG)) }, request);
  }
  const key = rest[0];
  if (rest.length !== 1 || !CONFIG[key]) return json({ error: 'no such setting' }, request, 404);
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const got = await readBody(request, 1000);
  if (got.error) return json({ error: got.error }, request, got.status);
  const v = got.body && got.body.value;
  if (v === null) {
    await env.HUB_DB.prepare('DELETE FROM config WHERE key = ?').bind(key).run();
    return json({ ok: true, key, value: null }, request);
  }
  const value = CONFIG[key](v);
  if (value === null) return json({ error: key + ': ' + HINTS[key] }, request, 400);
  await env.HUB_DB.prepare('INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, value, new Date(now).toISOString()).run();
  return json({ ok: true, key, value }, request);
}

/* ---------- Kitchen's reaction ---------- */

/* The hub's kitchen target: set or clear Paul's flag on the date. Never touches a meal. */
export async function kitchenTarget(env, msg) {
  if (msg.type !== 'dinner.away' && msg.type !== 'dinner.back') return { skip: 'no kitchen reaction for ' + msg.type };
  const id = parseDinnerId(msg.event_id);
  if (!id) return { skip: 'not a dinner id' };
  if (cleanDate(msg.payload && msg.payload.date) !== id.date) return { skip: 'date does not match the id' };
  if (!env.KITCHEN_CODE || !env.KITCHEN_STORE) throw new Error('KITCHEN_CODE missing');
  const r = await kitchen(env, env.KITCHEN_CODE, '/away', { base: id.base, date: id.date, away: msg.type === 'dinner.away', seq: id.seq });
  if (r.status !== 200) throw new Error('kitchen away ' + r.status);
  return r.data.changed ? { done: id.base } : { skip: 'older or the same' };
}

/* ---------- Morning ---------- */

const localDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/* Pure: the hub's dinner events in, what stands now out: [{ date, title, start }], by date.
 * The newest seq of each base decides; a base whose last word is dinner.back is gone. */
export function awayNow(rows, today, until) {
  const last = new Map();
  for (const r of rows) {
    const id = parseDinnerId(r.id);
    if (!id) continue;
    const cur = last.get(id.base);
    if (!cur || id.seq > cur.seq) last.set(id.base, { ...id, type: r.type, payload: r.payload });
  }
  const out = [];
  for (const e of last.values()) {
    if (e.type !== 'dinner.away' || e.date < today || e.date > until) continue;
    let p = {};
    try { p = JSON.parse(e.payload) || {}; } catch (err) { /* a broken row shows no title */ }
    const title = typeof p.title === 'string' ? p.title.slice(0, 200) : '';
    const start = typeof p.start === 'string' && /^\d{2}:\d{2}$/.test(p.start) ? p.start : '';
    out.push({ date: e.date, title, start });
  }
  return out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

/* Morning's block: { away: [...] }, or null when nothing stands. */
export async function dinnerBlock(env, now = Date.now()) {
  if (!env.HUB_DB) return null;
  const today = localDate(now);
  const until = localDate(now + AHEAD_DAYS * DAY_MS);
  const { results } = await env.HUB_DB.prepare(
    "SELECT id, type, payload FROM events WHERE source = 'day' AND type IN ('dinner.away', 'dinner.back') AND at >= ?"
  ).bind(new Date(now - 30 * DAY_MS).toISOString()).all();
  const away = awayNow(results || [], today, until);
  return away.length ? { away } : null;
}
