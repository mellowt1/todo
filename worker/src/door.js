/* Door: "Did I Lock It?" (its own repo, on GitHub Pages). The log and the photos stay on the
 * phone; after each lock Door tells paul-hub when it happened, so the hub can remind Paul to
 * lock up before an appointment and stay quiet when he already has.
 *
 *   POST /api/door/:code/lock    <- { id, at, word?, photo? }  -> { ok, dup? }
 *        id    1 to 40 of a-z, 0-9 and -; the same id twice is stored once (an offline retry)
 *        at    ms since epoch, from 30 days ago to 5 minutes ahead
 *        word  the word Door gave to say out loud, letters only, at most 20
 *        photo true when the lock has a photo. Only that fact: no photo data ever comes here.
 *   POST /api/door/:code/remove  <- { id }  -> { ok, removed }   Door's "Remove" (a lock logged by mistake)
 *   GET  /api/door/:code         -> { locks (newest 10), next: { title, start, remindAt } | null }
 *
 * The cron (doorCron, on every run, so every 15 minutes) reads Day's calendar push (HUB_KV
 * morning:calendar). A timed event that starts within LEAD_MIN minutes, and has not started,
 * gets one ntfy push "Lock the door", unless:
 *   - it is clearly at home or online (skipEvent: calls, Zoom, Teams, Google Meet, webinars,
 *     the German tutor's calls, To-do rows, Lift's gym days, Arsenal fixtures from the
 *     subscribed calendar, a location of home or a link);
 *   - a lock was logged in the last LOCKED_MIN minutes when it comes due (he is out already;
 *     the event is marked done so the push does not follow later);
 *   - it is outside 06:30 to 23:30, or inside quiet_hours (config table, src/dinner.js). Held
 *     pushes go at the next run that is allowed, if the event has still not started.
 * Events due in the same run share one push. A failed send is tried again at the next run.
 * The push links to Door only: an ntfy.sh topic is readable by anyone who knows its name, so
 * the To-do code never goes in it.
 *
 * KV: door:locks [{ id, at, word, photo }] newest first, at most 30;
 *     door:sent:<hash of title + start> 'sent' | 'locked', 2 days.
 * The code is the to-do's (TODO_CODE), as for Lift, Morning and Hiscores. */

import { safeEqual, CODE } from './todo.js';
import { local, zoned, addDays, CAL_KEY } from './morning.js';
import { readConfig } from './dinner.js';
import { inQuiet } from './week.js';

export const LOCKS_KEY = 'door:locks';
export const SENT_PREFIX = 'door:sent:';
export const DOOR_URL = 'https://mellowt1.github.io/door/';
export const LEAD_MIN = 45;
export const LOCKED_MIN = 60;
export const MAX_LOCKS = 30;
export const SHOWN_LOCKS = 10;
export const DAY_START = '06:30';
export const DAY_END = '23:30';
const MIN = 60000;
const DAY = 1440 * MIN;
const MAX_BODY = 2000;
const SENT_TTL = 2 * 86400;
const ID = /^[a-z0-9-]{1,40}$/;
const WORD = /^[A-Za-z]{1,20}$/;
const FIELDS = new Set(['id', 'at', 'word', 'photo']);
const toMin = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

/* ---------- Locks (pure) ---------- */

/* Whatever the phone sent -> { lock } or { error }. Strict: unknown fields, a photo that is
 * not true/false, or an odd time are refused, so nothing but these four facts is ever kept. */
export function cleanLock(b, now = Date.now()) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'send an object' };
  for (const k of Object.keys(b)) if (!FIELDS.has(k)) return { error: `unknown field ${k}` };
  if (typeof b.id !== 'string' || !ID.test(b.id)) return { error: 'id must be 1 to 40 of a-z, 0-9 and -' };
  if (typeof b.at !== 'number' || !Number.isInteger(b.at)) return { error: 'at must be ms since epoch' };
  if (b.at < now - 30 * DAY || b.at > now + 5 * MIN) return { error: 'at must be within the last 30 days' };
  if (b.word !== undefined && b.word !== null && (typeof b.word !== 'string' || !WORD.test(b.word))) return { error: 'word must be 1 to 20 letters' };
  if (b.photo !== undefined && typeof b.photo !== 'boolean') return { error: 'photo must be true or false' };
  return { lock: { id: b.id, at: b.at, word: b.word || '', photo: b.photo === true } };
}

/* Pure: the list with this lock in, newest first, at most MAX_LOCKS. Same id: unchanged. */
export function addLock(list, lock) {
  if (list.some((l) => l.id === lock.id)) return { list, dup: true };
  return { list: [lock, ...list].sort((a, b) => b.at - a.at).slice(0, MAX_LOCKS), dup: false };
}

export const lastLockAt = (list) => list.reduce((m, l) => Math.max(m, l.at), 0);

/* ---------- Events (pure) ---------- */

/* At home or online: no door to lock. Matched on the title and the location. */
export const SKIP = /\b(call|calls|bellen|zoom|teams|google meet|meet\.google|webinar|online|deutsch|german|anruf)\b|^\s*to-do:|\bgym day\b/i;
export const HOME_PLACE = /^\s*(home|thuis|at home)\s*$|https?:\/\//i;

/* Arsenal fixtures from the subscribed (ECAL) calendar: "Arsenal vs Chelsea", "Spurs v Arsenal". */
export const isSubscribedFixture = (title) => /arsenal/i.test(title || '') && /\s(vs?\.?)\s/i.test(title || '');

export function skipEvent(e) {
  const title = e.title || '', place = e.location || '';
  return SKIP.test(title) || SKIP.test(place) || HOME_PLACE.test(place) || isSubscribedFixture(title);
}

/* Timed events not yet started, worth a reminder, soonest first: [{ e, start }]. */
export function upcoming(events, now) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && !e.allDay && typeof e.start === 'string' && typeof e.title === 'string' && e.title.trim())
    .map((e) => ({ e, start: Date.parse(e.start) }))
    .filter((x) => Number.isFinite(x.start) && x.start > now && !skipEvent(x.e))
    .sort((a, b) => a.start - b.start);
}

/* Inside the hours a push may go (06:30 to 23:30 Amsterdam)? */
export const awake = (ms) => { const m = local(ms).minutes; return m >= toMin(DAY_START) && m < toMin(DAY_END); };

/* When the cron will first send for an event starting at `start`: LEAD_MIN before, moved to
 * 06:30 if that is earlier in the morning, or null when no allowed time is left before it. */
export function remindAt(start) {
  let r = start - LEAD_MIN * MIN;
  const l = local(r);
  if (l.minutes < toMin(DAY_START)) r = zoned(l.date, DAY_START);
  else if (l.minutes >= toMin(DAY_END)) r = zoned(addDays(l.date, 1), DAY_START);
  return r < start ? r : null;
}

/* Pure: due in this run (starts within LEAD_MIN, not started). */
export const dueNow = (events, now) => upcoming(events, now).filter((x) => x.start - now <= LEAD_MIN * MIN);

/* 32-bit FNV-1a of title + start, as hex: the dedupe key, with no title in KV keys. */
export function eventHash(e) {
  let h = 0x811c9dc5;
  const s = `${e.title}\u0000${e.start}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
export const sentKey = (e) => SENT_PREFIX + eventHash(e);

/* Pure: the push's words for one or more events due together. */
export function pushText(due) {
  const names = due.slice(0, 2).map((x) => `${x.e.title.trim().slice(0, 60)} at ${local(x.start).time}`);
  const more = due.length > 2 ? ` and ${due.length - 2} more` : '';
  return { title: 'Lock the door', message: `${names.join(', ')}${more}. Open Door when you lock up.`, click: DOOR_URL, tags: ['key'], priority: 3 };
}

/* ---------- KV ---------- */

const readLocks = async (env) => {
  const v = await env.HUB_KV.get(LOCKS_KEY, 'json');
  return Array.isArray(v) ? v : [];
};

/* The next reminder the cron will send, for Door's quiet line: { title, start, remindAt } | null. */
export async function nextReminder(env, now = Date.now()) {
  const cal = await env.HUB_KV.get(CAL_KEY, 'json');
  const list = upcoming(cal && cal.events, now).slice(0, 20);
  const locked = lastLockAt(await readLocks(env)) > now - LOCKED_MIN * MIN;
  for (const x of list) {
    const r = remindAt(x.start);
    if (r === null) continue;
    if (r <= now && locked) continue; // due now, and he has locked up: it will be marked, not sent
    if (await env.HUB_KV.get(sentKey(x.e))) continue;
    return { title: x.e.title.trim().slice(0, 80), start: x.e.start, remindAt: new Date(Math.max(r, now)).toISOString() };
  }
  return null;
}

async function quietNow(env, now) {
  if (!env.HUB_DB) return false;
  try {
    const cfg = await readConfig(env, ['quiet_hours']);
    return inQuiet(local(now).minutes, cfg.quiet_hours);
  } catch (e) { return false; } // no config table: no quiet hours
}

/* Every cron run. Returns what it did, for tests and wrangler tail. */
export async function doorCron(env, now = Date.now(), fetcher = fetch) {
  if (!awake(now)) return { skip: 'night' };
  if (!env.NTFY_TOPIC) return { skip: 'no topic' };
  const cal = await env.HUB_KV.get(CAL_KEY, 'json');
  const due = [];
  for (const x of dueNow(cal && cal.events, now)) if (!(await env.HUB_KV.get(sentKey(x.e)))) due.push(x);
  if (!due.length) return { skip: 'nothing due' };
  if (lastLockAt(await readLocks(env)) > now - LOCKED_MIN * MIN) {
    for (const x of due) await env.HUB_KV.put(sentKey(x.e), 'locked', { expirationTtl: SENT_TTL });
    return { skip: 'locked', events: due.length };
  }
  if (await quietNow(env, now)) return { skip: 'quiet hours' };
  const m = pushText(due);
  const r = await fetcher('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: env.NTFY_TOPIC, ...m }) });
  if (!r.ok) return { skip: 'ntfy ' + r.status }; // tried again at the next run
  for (const x of due) await env.HUB_KV.put(sentKey(x.e), 'sent', { expirationTtl: SENT_TTL });
  return { sent: m };
}

/* ---------- Routes ---------- */

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { status: 413, error: 'too large' };
  try { return { body: JSON.parse(text) }; } catch (e) { return { status: 400, error: 'bad json' }; }
}

export async function handleDoor(request, env, rest, json, now = Date.now()) {
  if (!rest.length || rest.length > 2 || !CODE.test(rest[0])) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(rest[0], env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (rest.length === 1) {
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    const locks = await readLocks(env);
    return json({ locks: locks.slice(0, SHOWN_LOCKS), next: await nextReminder(env, now) }, request);
  }
  if (rest[1] !== 'lock' && rest[1] !== 'remove') return json({ error: 'not found' }, request, 404);
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const got = await readJson(request);
  if (got.error) return json({ error: got.error }, request, got.status);
  const list = await readLocks(env);
  if (rest[1] === 'remove') {
    const id = got.body && got.body.id;
    if (typeof id !== 'string' || !ID.test(id)) return json({ error: 'id must be 1 to 40 of a-z, 0-9 and -' }, request, 400);
    const left = list.filter((l) => l.id !== id);
    if (left.length !== list.length) await env.HUB_KV.put(LOCKS_KEY, JSON.stringify(left));
    return json({ ok: true, removed: list.length - left.length }, request);
  }
  const c = cleanLock(got.body, now);
  if (c.error) return json({ error: c.error }, request, 400);
  const out = addLock(list, c.lock);
  if (!out.dup) await env.HUB_KV.put(LOCKS_KEY, JSON.stringify(out.list));
  return json(out.dup ? { ok: true, dup: true } : { ok: true }, request);
}
