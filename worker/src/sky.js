/* The hub constellation (Paul, 2026-10-22; Phase 7): every app on the hub is a star, a line joins two
 * apps that told each other something, a pulse is one event travelling from the app that sent it to
 * the apps that react. Morning draws it (morning/app/constellation/).
 *
 *   GET /api/sky/:code   (the to-do's code)  -> { now, from, poll, replay, stars, lines, pulses }
 *
 * Nothing new is stored for it (Paul: "reuse"). It reads the log the hub already keeps, and only four
 * things per event: when, which app sent it, its type, and who reacted:
 *   - D1 `events`: id, source, type, at. Never summary or payload, with one exception: the routing
 *     word `kind` of an email.received ("triage" waits in Day; the others go to the hub's mail target).
 *   - D1 `handled`: which rule target reacted to an event (todo, kitchen; mail is the hub itself).
 *   - Morning's Lately lines in KV (src/events.js) from the apps that only ever post a line there
 *     (PC, Arsenal watch, Lift): source and kind, kept in a small index (sky:feed) so a poll reads
 *     each line once. The line's text is never read into the index or the answer.
 * Who reacts to an event is the hub's rules (handled rows) plus REACTS: the apps that show it.
 * A Lately line counts as its app's sign of life for as long as KV keeps it (30 days).
 *
 * A star's sign of life is its own newest event, a heartbeat the hub already gets (src/health.js:
 * the jobs, Day's calendar push), the to-do list's last change, Morning's last visit (life:morning,
 * written at most once an hour) and the hourly cron for the hub. A star is quiet when its last sign
 * of life is older than its limit. Paul's answers (2026-10-22): 7 days of counts and lines, a live
 * check every 30 s, a day or a week replayed in 60 s, the last 4 events on a star, Hub in the middle.
 * The limits were left to me: the jobs keep their health-check hours, To-do and Morning 2 days, Day
 * 3 hours (its calendar push is a heartbeat), Kitchen, Email in and Lift 7 days, the hub 3 hours.
 * Feeling, Runway and Plan de regreso are not on the hub and never become stars. */

import { CODE, safeEqual } from './todo.js';
import { JOBS, lastBeats } from './health.js';
import { STATUS_KEY } from './status.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
export const WINDOW_DAYS = 7;
export const POLL_SECONDS = 30;
export const REPLAY_SECONDS = { day: 60, week: 60 };
const MAX_PULSES = 3000;
const FEED_IDX = 'sky:feed';
const LIFE = 'life:';
const LIFE_EVERY = HOUR;

export const STARS = [
  { id: 'todo', name: 'To-do', kind: 'app', limitHours: 48 },
  { id: 'morning', name: 'Morning', kind: 'app', limitHours: 48 },
  { id: 'day', name: 'Day', kind: 'app', limitHours: 3 },
  { id: 'kitchen', name: 'Kitchen', kind: 'app', limitHours: 7 * 24 },
  { id: 'mail', name: 'Email in', kind: 'app', limitHours: 7 * 24 },
  { id: 'defence-digest', name: 'Defence digest', kind: 'job', limitHours: JOBS['defence-digest'].hours, how: JOBS['defence-digest'].how },
  { id: 'lift', name: 'Lift', kind: 'app', limitHours: 7 * 24 },
  { id: 'pc', name: 'PC', kind: 'job', limitHours: JOBS['morning-projects'].hours, how: JOBS['morning-projects'].how },
  { id: 'arsenal-watch', name: 'Arsenal watch', kind: 'job', limitHours: JOBS['arsenal-watch'].hours, how: JOBS['arsenal-watch'].how },
  { id: 'hub', name: 'Hub', kind: 'hub', limitHours: 3 },
];
const IDS = new Set(STARS.map((s) => s.id));
const ORDER = new Map(STARS.map((s, i) => [s.id, i]));
// Apps that only ever post a Lately line; a line from any other source repeats a typed event.
export const FEED_ONLY = ['pc', 'arsenal-watch', 'lift'];
// Which heartbeat (src/health.js) counts as whose sign of life.
const BEATS = { 'defence-digest': ['defence-digest'], pc: ['morning-projects', 'backup'], 'arsenal-watch': ['arsenal-watch'], day: ['calendar'] };

const TRIO = ['todo', 'morning', 'day'];
const TWO = ['todo', 'morning'];
/* The apps that act on or show each type. The source itself is taken out; nobody left means the
 * event stayed in the hub (an answer to the weekly question lives only there). */
export const REACTS = {
  'energy.set': TRIO, 'energy.cleared': TRIO, 'energy.skipped': TRIO,
  'waiting.created': TRIO, 'waiting.snoozed': TRIO, 'waiting.resolved': TRIO, 'waiting.chase_due': TRIO,
  'dread.started': TRIO, 'dread.rated': TRIO, 'dread.done': TRIO, 'dread.stopped': TRIO, 'dread.undone': TRIO, 'dread.skipped': TRIO,
  'task.fate_due': TWO, 'task.fate_later': TWO, 'task.buried': TWO, 'task.resurrected': TWO, 'task.handed_off': TRIO,
  'task.created': ['todo'], 'readlater.created': ['morning'], 'readlater.closed': ['morning'],
  'oracle.asked': ['morning'], 'oracle.answered': ['morning'],
  'dinner.away': ['kitchen', 'morning'], 'dinner.back': ['kitchen', 'morning'],
  'vacancy.found': ['todo'],
  'email.received': ['hub'], 'email.sorted': ['hub'],
  // The Network map is a Morning page: its changes stay in the hub, a Reach out lands in To-do, a
  // contact logged from To-do or the hub shows on Morning's map.
  'person.added': ['hub'], 'person.updated': ['hub'], 'person.deleted': ['hub'], 'person.imported': ['hub'],
  'person.reach': ['todo'], 'person.contacted': ['morning'], 'tie.added': ['hub'], 'tie.removed': ['hub'],
};
// The rule targets that are stars. The mail target is the hub's own work; REACTS says where mail goes.
const TARGET_STAR = { todo: 'todo', kitchen: 'kitchen' };

export const LABELS = {
  'energy.set': 'Energy set', 'energy.cleared': 'Energy cleared', 'energy.skipped': 'Not this one',
  'waiting.created': 'Waiting on added', 'waiting.snoozed': 'Snoozed', 'waiting.resolved': 'Answered', 'waiting.chase_due': 'Chase due',
  'dread.started': 'Timer started', 'dread.rated': 'Dread rated', 'dread.done': 'Done after a timer', 'dread.stopped': 'Timer stopped',
  'dread.undone': 'Done undone', 'dread.skipped': 'Passed on',
  'task.fate_due': 'Time to decide', 'task.fate_later': 'Decide later', 'task.buried': 'Archived', 'task.resurrected': 'Restored',
  'task.handed_off': 'Handed off', 'task.created': 'Task made',
  'readlater.created': 'Read later added', 'readlater.closed': 'Read later closed',
  'oracle.asked': 'Weekly question', 'oracle.answered': 'Question answered',
  'dinner.away': 'Out for dinner', 'dinner.back': 'Back for dinner',
  'vacancy.found': 'Vacancy found', 'email.received': 'Mail in', 'email.sorted': 'Mail sorted',
  'person.added': 'Person added', 'person.updated': 'Person changed', 'person.deleted': 'Person removed',
  'person.imported': 'LinkedIn import', 'person.reach': 'Reach out task', 'person.contacted': 'Contact logged',
  'tie.added': 'Link added', 'tie.removed': 'Link removed',
  'feed.drop': 'Ticket drop', 'feed.job': 'Job ran', 'feed.workout': 'Workout', 'feed.note': 'Note',
};
export function label(type) {
  if (LABELS[type]) return LABELS[type];
  if (type.startsWith('feed.')) return 'Lately line';
  const s = type.replace(/[._]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* Pure: the stars that react to one event. */
export function reactorsOf({ source, type, kind, targets = [] }) {
  let base = REACTS[type] || [];
  if (type === 'email.received' && kind === 'triage') base = ['day'];
  if (type.startsWith('feed.')) base = ['morning'];
  const set = new Set(base);
  for (const t of targets) if (TARGET_STAR[t]) set.add(TARGET_STAR[t]);
  set.delete(source);
  const out = [...set].filter((x) => IDS.has(x)).sort((a, b) => ORDER.get(a) - ORDER.get(b));
  return out.length ? out : source === 'hub' ? [] : ['hub'];
}

async function shortId(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('sky:' + s));
  return Array.from(new Uint8Array(b).slice(0, 6), (x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- Reading the log ---------- */

/* Typed events in the window, oldest first: { key, at, source, type, kind, targets }. */
export async function typedEvents(env, fromIso) {
  const { results } = await env.HUB_DB.prepare(
    "SELECT e.id, e.source, e.type, e.at, CASE WHEN e.type = 'email.received' THEN json_extract(e.payload, '$.kind') END AS kind, " +
    '(SELECT group_concat(h.target) FROM handled h WHERE h.event_id = e.id) AS targets ' +
    'FROM events e WHERE e.at >= ? ORDER BY e.at, e.rowid LIMIT ?'
  ).bind(fromIso, MAX_PULSES).all();
  return (results || []).map((r) => ({
    key: 'e:' + r.id, at: r.at, source: r.source, type: r.type, kind: typeof r.kind === 'string' ? r.kind : null,
    targets: r.targets ? String(r.targets).split(',') : [],
  }));
}

/* Lately lines from the feed-only apps: { key, at, source, type }, oldest first, all 30 days KV keeps.
 * The index keeps source and kind per KV key, so each line's value is read once, ever. */
export async function feedEvents(env) {
  const listed = await env.HUB_KV.list({ prefix: 'event:', limit: 1000 });
  const names = (listed.keys || []).map((k) => k.name);
  const idx = (await env.HUB_KV.get(FEED_IDX, 'json')) || {};
  const missing = names.filter((n) => !Object.prototype.hasOwnProperty.call(idx, n));
  if (missing.length) {
    const recs = await Promise.all(missing.map((n) => env.HUB_KV.get(n, 'json')));
    missing.forEach((n, i) => {
      const r = recs[i];
      idx[n] = r && typeof r.source === 'string' ? [r.source, typeof r.kind === 'string' ? r.kind : 'note'] : null;
    });
  }
  const keep = {};
  for (const n of names) if (idx[n] !== undefined) keep[n] = idx[n];
  if (missing.length || Object.keys(idx).length !== Object.keys(keep).length) {
    try { await env.HUB_KV.put(FEED_IDX, JSON.stringify(keep)); } catch (e) { /* the index is a cache */ }
  }
  const out = [];
  for (const n of names.sort()) {
    const v = keep[n];
    const ms = Number(n.slice(6, 20));
    if (!v || !FEED_ONLY.includes(v[0]) || !Number.isFinite(ms)) continue;
    out.push({ key: 'f:' + n, at: new Date(ms).toISOString(), source: v[0], type: 'feed.' + v[1], kind: null, targets: [] });
  }
  return out;
}

/* Signs of life: { star: ms | null }. `feed` is feedEvents' lines. */
export async function signsOfLife(env, now, feed = []) {
  const life = Object.fromEntries(STARS.map((s) => [s.id, null]));
  const bump = (id, ms) => { if (id in life && Number.isFinite(ms) && ms <= now + 60000 && (life[id] === null || ms > life[id])) life[id] = ms; };
  const [sent, handled, beats, morning, status, list] = await Promise.all([
    env.HUB_DB.prepare('SELECT source, max(at) AS at FROM events GROUP BY source').all().then((r) => r.results || []),
    env.HUB_DB.prepare('SELECT target, max(at) AS at FROM handled GROUP BY target').all().then((r) => r.results || []),
    lastBeats(env).catch(() => ({})),
    env.HUB_KV.get(LIFE + 'morning', 'json').catch(() => null),
    env.HUB_KV.get(STATUS_KEY, 'json').catch(() => null),
    listMeta(env).catch(() => null),
  ]);
  for (const r of sent) bump(r.source, Date.parse(r.at));
  for (const f of feed) bump(f.source, Date.parse(f.at));
  for (const r of handled) if (TARGET_STAR[r.target]) bump(TARGET_STAR[r.target], Date.parse(r.at));
  for (const [star, jobs] of Object.entries(BEATS)) for (const j of jobs) if (beats[j]) bump(star, beats[j]);
  if (morning && morning.at) bump('morning', Date.parse(morning.at));
  if (status && status.at) bump('hub', Date.parse(status.at));
  if (list && list.updated) bump('todo', Date.parse(list.updated));
  return life;
}

async function listMeta(env) {
  if (!env.TODO_CODE || !env.TODO_LIST) return null;
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
  const r = await stub.fetch('https://list/meta');
  return r.ok ? r.json() : null;
}

/* Morning was opened: remember it, at most once an hour (a KV read per visit, a write per hour). */
export async function markLife(env, star, now = Date.now()) {
  const prev = await env.HUB_KV.get(LIFE + star, 'json');
  if (prev && Number.isFinite(Date.parse(prev.at)) && now - Date.parse(prev.at) < LIFE_EVERY) return false;
  await env.HUB_KV.put(LIFE + star, JSON.stringify({ at: new Date(now).toISOString() }));
  return true;
}

/* ---------- The sky ---------- */

const byCount = (a, b) => b.n - a.n || a.label.localeCompare(b.label);

/* Pure: events (typed + Lately, any order) and signs of life in, the answer out. */
export function buildSky(events, life, now, pulseIds) {
  const pulses = events
    .filter((e) => IDS.has(e.source))
    .map((e) => ({ ...e, to: reactorsOf(e) }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-MAX_PULSES)
    .map((e) => ({ id: pulseIds.get(e.key), at: e.at, from: e.source, type: e.type, label: label(e.type), to: e.to }));

  const stars = STARS.map((s) => ({ s, sent: new Map(), received: new Map(), events: 0 }));
  const star = new Map(stars.map((x) => [x.s.id, x]));
  const lines = new Map();
  const add = (map, type, who) => {
    const row = map.get(type) || { type, label: label(type), n: 0, who: new Set() };
    row.n++;
    for (const w of [].concat(who)) row.who.add(w);
    map.set(type, row);
  };
  for (const p of pulses) {
    const from = star.get(p.from);
    if (from) from.events++;
    // Sent counts the event once, with everyone it reached; received counts it once per star.
    if (from) add(from.sent, p.type, p.to);
    for (const t of p.to) {
      const to = star.get(t);
      if (to) { add(to.received, p.type, p.from); to.events++; }
      const [a, b] = ORDER.get(p.from) <= ORDER.get(t) ? [p.from, t] : [t, p.from];
      const k = a + '|' + b;
      const line = lines.get(k) || { a, b, n: 0, ab: new Map(), ba: new Map() };
      line.n++;
      const dir = p.from === a ? line.ab : line.ba;
      const row = dir.get(p.type) || { type: p.type, label: p.label, n: 0 };
      row.n++; dir.set(p.type, row);
      lines.set(k, line);
    }
  }
  const order = (ids) => [...ids].sort((a, b) => ORDER.get(a) - ORDER.get(b));
  return {
    now: new Date(now).toISOString(),
    from: new Date(now - WINDOW_DAYS * DAY).toISOString(),
    poll: POLL_SECONDS,
    replay: REPLAY_SECONDS,
    stars: stars.map(({ s, sent, received, events: n }) => {
      const at = life[s.id];
      const quiet = at === null || now - at > s.limitHours * HOUR;
      return {
        id: s.id, name: s.name, kind: s.kind, events: n,
        sent: [...sent.values()].map((r) => ({ type: r.type, label: r.label, n: r.n, to: order(r.who) })).sort(byCount),
        received: [...received.values()].map((r) => ({ type: r.type, label: r.label, n: r.n, from: order(r.who) })).sort(byCount),
        life: at === null ? null : new Date(at).toISOString(),
        limitHours: s.limitHours,
        quiet,
        quietHours: quiet && at !== null ? Math.floor((now - at) / HOUR) : null,
        how: quiet && s.how ? s.how : null,
      };
    }),
    lines: [...lines.values()]
      .map((l) => ({ a: l.a, b: l.b, n: l.n, ab: [...l.ab.values()].sort(byCount), ba: [...l.ba.values()].sort(byCount) }))
      .sort((x, y) => ORDER.get(x.a) - ORDER.get(y.a) || ORDER.get(x.b) - ORDER.get(y.b)),
    pulses,
  };
}

export async function skyFor(env, now = Date.now()) {
  const from = now - WINDOW_DAYS * DAY;
  const [typed, feed] = await Promise.all([
    typedEvents(env, new Date(from).toISOString()),
    feedEvents(env).catch(() => []),
  ]);
  const life = await signsOfLife(env, now, feed);
  const events = [...typed, ...feed.filter((f) => Date.parse(f.at) >= from)];
  const ids = new Map(await Promise.all(events.map(async (e) => [e.key, await shortId(e.key)])));
  return buildSky(events, life, now, ids);
}

export async function handleSky(request, env, rest, json, now = Date.now()) {
  const code = rest[0] || '';
  if (rest.length !== 1) return json({ error: 'not found' }, request, 404);
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (!env.HUB_DB || !env.HUB_KV) return json({ error: 'not configured' }, request, 503);
  if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
  // The constellation is a Morning page: looking at it is Morning being used.
  await markLife(env, 'morning', now).catch(() => {});
  return json(await skyFor(env, now), request);
}
