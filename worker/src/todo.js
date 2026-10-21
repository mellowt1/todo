/* The to-do module: validation and the per task merge.
 *
 * Pure functions only, so they can be tested in Node without a Worker runtime.
 *
 * Stored document, one KV key per list (todo:<code>):
 *   { items: { [id]: Item }, tombs: { [id]: deletedAt }, rev, updated }
 *
 * Item: { id, text, section, done, doneAt, updatedAt, pos, link?, energy?, energyGuess? }
 *   section  "today" | "soon" | "someday" (a done task keeps the section it came from)
 *   doneAt   ms since epoch, or null while open
 *   pos      ms since epoch, sort key inside a section (newest on top)
 *   link     optional http(s) URL (a vacancy's page, set by the hub). An upsert without
 *            `link` keeps the stored one, so an app that does not know links never drops it;
 *            `link: null` removes it.
 *   energy   optional "wired" | "normal" | "drained": the energy the task takes, confirmed by
 *            Paul (Energy dial, src/energy.js, 2026-10-21). Only a confirmed level is ever picked.
 *   energyGuess  optional, the same three: a suggestion (Tidy, or the one-off pass over old tasks)
 *            that Paul has not confirmed yet. The app shows it outlined.
 *            Both behave like `link`: an upsert without the field keeps the stored one, `null`
 *            removes it, so an app or hub job that does not know them never drops them.
 *   repeat   optional { every: "week" | "2weeks" | "month" | "bins", until: "YYYY-MM-DD" | null }
 *            (2026-10-21, src/repeat.js): ticking the task off makes the next one on the schedule,
 *            from the date in its text. "bins" is the hub's bin-calendar task; the hub makes the next.
 *   series   optional, the id of the first task of a repeat, so every next one gets a fixed id.
 *   week     optional true: "this week" (2026-10-21), on top of Soon until the Sunday reset asks
 *            to keep it or take it off (src/week.js). Behaves like `link`.
 *            Both behave like `link` too.
 *
 * Every op carries its own updatedAt. For each task the newest updatedAt wins, so an
 * offline phone and a desktop never overwrite each other's work on other tasks.
 * A delete leaves a tombstone so an older device cannot bring the task back.
 */

export const SECTIONS = ['today', 'soon', 'someday'];
export const ENERGY = ['wired', 'normal', 'drained'];
export const REPEATS = ['week', '2weeks', 'month', 'bins'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEEP = ['link', 'energy', 'energyGuess', 'repeat', 'series', 'week']; // left out of an upsert: the stored value stays
export const ID = /^[a-z0-9]{8,32}$/;
export const CODE = /^[a-z0-9]{16}$/;
export const MAX_TEXT = 500;
export const MAX_LINK = 800;
export const MAX_OPS = 200;
export const MAX_ITEMS = 10000;
export const TOMB_DAYS = 90;
const DAY = 24 * 3600 * 1000;
const MIN_TIME = Date.UTC(2020, 0, 1);
const SKEW = 5 * 60 * 1000; // a clock more than five minutes ahead is clamped to now

export function emptyDoc() {
  return { items: {}, tombs: {}, rev: 0, updated: null };
}

function cleanTime(v, now, allowNull) {
  if (v === null && allowNull) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < MIN_TIME) return undefined;
  return Math.round(Math.min(n, now + SKEW));
}

// Collapse whitespace the way the app shows it. Control characters are dropped.
// app/app.js has the same function; keep the two identical.
export function cleanText(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_TEXT) return null;
  return t;
}

/* An http(s) URL, at most MAX_LINK long, or null. */
export function cleanLink(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > MAX_LINK || !/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch (e) {
    return null;
  }
}

/* One op in, one clean op out, or null. Anything not on the whitelist is dropped. */
export function cleanOp(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const it = raw.item;
  if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !ID.test(it.id)) return null;
  const updatedAt = cleanTime(it.updatedAt, now, false);
  if (updatedAt === undefined) return null;

  if (raw.op === 'delete') return { op: 'delete', item: { id: it.id, updatedAt } };
  if (raw.op !== 'upsert') return null;

  const text = cleanText(it.text);
  if (text === null) return null;
  if (!SECTIONS.includes(it.section)) return null;
  const done = it.done === true;
  const doneAt = done ? cleanTime(it.doneAt, now, false) : null;
  if (doneAt === undefined) return null;
  const pos = cleanTime(it.pos, now, false);
  if (pos === undefined) return null;
  const item = { id: it.id, text, section: it.section, done, doneAt, updatedAt, pos };
  if (it.link === null) item.link = null;
  else if (it.link !== undefined) {
    item.link = cleanLink(it.link);
    if (item.link === null) return null;
  }
  for (const f of ['energy', 'energyGuess']) {
    if (it[f] === null) item[f] = null;
    else if (it[f] !== undefined) {
      if (!ENERGY.includes(it[f])) return null;
      item[f] = it[f];
    }
  }
  if (it.repeat === null) item.repeat = null;
  else if (it.repeat !== undefined) {
    const r = cleanRepeat(it.repeat);
    if (!r) return null;
    item.repeat = r;
  }
  if (it.week === null || it.week === false) item.week = null;
  else if (it.week !== undefined) {
    if (it.week !== true) return null;
    item.week = true;
  }
  if (it.series === null) item.series = null;
  else if (it.series !== undefined) {
    if (typeof it.series !== 'string' || !ID.test(it.series)) return null;
    item.series = it.series;
  }
  return { op: 'upsert', item };
}

/* { every, until } with a known every and a real date or null, or null. */
export function cleanRepeat(v) {
  if (!v || typeof v !== 'object' || !REPEATS.includes(v.every)) return null;
  const until = v.until === undefined || v.until === null ? null : v.until;
  if (until !== null && (typeof until !== 'string' || !DATE.test(until) || Number.isNaN(Date.parse(until)))) return null;
  return { every: v.every, until };
}

/* Validate a batch. Returns { ops, rejected } or { error }.
 * A bad op is skipped on its own and reported back by index, so one broken task
 * never holds up the others. Only a malformed batch as a whole is an error. */
export function cleanBatch(body, now = Date.now()) {
  const list = body && Array.isArray(body.ops) ? body.ops : Array.isArray(body) ? body : null;
  if (!list) return { error: 'ops required' };
  if (list.length === 0) return { error: 'ops empty' };
  if (list.length > MAX_OPS) return { error: 'too many ops' };
  const ops = [];
  const rejected = [];
  list.forEach((raw, index) => {
    const op = cleanOp(raw, now);
    if (op) ops.push(op);
    else rejected.push(index);
  });
  return { ops, rejected };
}

/* Apply clean ops to a document. Mutates and returns { doc, changed }.
 * Ties go to what is already stored, which makes a resent batch a no-op. */
export function applyOps(doc, ops) {
  let changed = false;
  for (const { op, item } of ops) {
    const cur = doc.items[item.id];
    const tomb = doc.tombs[item.id];
    if (op === 'upsert') {
      if (tomb !== undefined && tomb >= item.updatedAt) continue;
      if (cur && cur.updatedAt >= item.updatedAt) continue;
      const next = { ...item };
      for (const f of KEEP) {
        if (next[f] === undefined && cur && cur[f]) next[f] = cur[f];
        if (next[f] === null) delete next[f];
      }
      doc.items[item.id] = next;
      if (tomb !== undefined) delete doc.tombs[item.id];
      changed = true;
    } else {
      if (cur && cur.updatedAt > item.updatedAt) continue;
      if (tomb !== undefined && tomb >= item.updatedAt) continue;
      delete doc.items[item.id];
      doc.tombs[item.id] = item.updatedAt;
      changed = true;
    }
  }
  return { doc, changed };
}

export function pruneTombs(doc, now = Date.now()) {
  const cutoff = now - TOMB_DAYS * DAY;
  let n = 0;
  for (const [id, at] of Object.entries(doc.tombs)) {
    if (at < cutoff) {
      delete doc.tombs[id];
      n++;
    }
  }
  return n;
}

/* Open tasks with their section and nothing else. What Odysseus gets. */
export function openView(doc) {
  return Object.values(doc.items)
    .filter((i) => !i.done)
    .sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || b.pos - a.pos)
    .map((i) => ({ text: i.text, section: i.section }));
}

export function itemList(doc) {
  return Object.values(doc.items);
}

/* Compare two secrets without leaking how many leading characters match. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : '';
}
