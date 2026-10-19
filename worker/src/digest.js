/* Digest: what happened in the hub lately, in one compact answer, for the PC.
 *
 *   GET /api/hub/digest   Authorization: Bearer <BEAT_TOKEN>  -> the digest below
 *
 * The PC's daily run (morning-projects\chores.mjs --digest) turns it into a Claude Code memory
 * file, so a new session knows the last week without Paul telling it, and the Sunday weekly fix
 * reads the raw JSON to pick one small improvement. Read only: this file writes nothing.
 *
 *   { at, days: 7,
 *     events:  { total, read, sources: { <source>: { count, lastAt, latest: [text, max 5] } } },
 *     status:  { line, summary, summaryAt, at } | null,
 *     jobs:    { quiet: [{ job, name, hoursAgo, limit }], unknown: [job], ok },
 *     mirror:  { week, at, finding, numbers, experiment: { text, from, to } | null, last } | null,
 *     lessons: { kept: { <app>: [rule] }, proposed: [{ app, text, why }],
 *                feedback: { <app>: { <kind>: n } }, corrections: [{ app, kind, before, after }] },
 *     desk:    { days: 14, lines, kinds: { todo, draft, answer }, outcomes: { <state>: n } },
 *     lift:    { at, last: [{ name, date }], next, nextDay } | null,
 *     intake:  { week },
 *     todos:   { open, today, soon, someday },
 *     parked:  [{ text, from, since, days }] }
 *
 * Every part is loaded on its own: one that fails answers { error } in its slot and the rest
 * still arrive. Every string is masked (src/mask.js) on the way out. Dates are Amsterdam. */

import { safeEqual, bearer, SECTIONS } from './todo.js';
import { local, addDays, daysBetween, zoned, PROJECTS_KEY } from './morning.js';
import { listEvents } from './events.js';
import { JOBS, lastBeats } from './health.js';
import { WEEK_PREFIX as MIRROR_PREFIX } from './mirror.js';
import { CORRECTIONS, KEPT_KEY } from './lessons.js';
import { planDay } from './lift.js';
import { maskSecrets } from './mask.js';

export const DAYS = 7;
export const DESK_DAYS = 14;
export const PER_SOURCE = 5;
export const MAX_EVENTS = 300;   // KV reads for the feed; the total still counts every key
const HOUR = 3600000;
const DAY = 24 * HOUR;
const EVENT_PREFIX = 'event:';
const INTAKE_PREFIX = 'intake:r:';
const msOfKey = (k, prefix) => Number(k.slice(prefix.length, prefix.length + 14)) || 0;
const clip = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : null);

/* Pure: every string in a JSON value masked, the shape kept. */
export function maskDeep(v) {
  if (typeof v === 'string') return maskSecrets(v);
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
  return v;
}

/* Pure: feed events (newest first) grouped by source. */
export function groupEvents(events, total = events.length) {
  const sources = {};
  for (const e of events) {
    const s = sources[e.source] || (sources[e.source] = { count: 0, lastAt: e.at, latest: [] });
    s.count++;
    if (s.latest.length < PER_SOURCE) s.latest.push(clip(e.text, 140));
  }
  return { total, read: events.length, sources };
}

/* Pure: which jobs went quiet, from health's beats. */
export function jobState(beats, now) {
  const quiet = [], unknown = [];
  let ok = 0;
  for (const [job, def] of Object.entries(JOBS)) {
    const at = beats[job];
    if (!at) { unknown.push(job); continue; }
    if (now - at > def.hours * HOUR) quiet.push({ job, name: def.name, hoursAgo: Math.round((now - at) / HOUR), limit: def.hours });
    else ok++;
  }
  return { quiet, unknown, ok };
}

/* Pure: the newest written Mirror card from its keys and values. */
export function newestMirror(cards) {
  const done = cards.filter(([, c]) => c && !c.pending).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  if (!done.length) return null;
  const [key, c] = done[0];
  return {
    week: key.slice(MIRROR_PREFIX.length),
    at: c.at || null,
    finding: c.finding ? clip(c.finding.text, 300) : null,
    numbers: c.finding ? clip(c.finding.numbers, 200) : null,
    experiment: c.experiment ? { text: clip(c.experiment.text, 200), from: c.experiment.from || null, to: c.experiment.to || null } : null,
    last: c.last ? clip(c.last.text, 240) : null,
  };
}

/* Pure: desk_log rows -> counts. kinds is "todo,draft,answer"; outcome a JSON list of states. */
export function deskCounts(rows) {
  const kinds = {}, outcomes = {};
  for (const r of rows) {
    for (const k of String(r.kinds || '').split(',').map((x) => x.trim()).filter(Boolean)) kinds[k] = (kinds[k] || 0) + 1;
    let out = [];
    try { out = JSON.parse(r.outcome || '[]'); } catch (e) { out = []; }
    for (const o of Array.isArray(out) ? out : []) outcomes[o] = (outcomes[o] || 0) + 1;
  }
  return { days: DESK_DAYS, lines: rows.length, kinds, outcomes };
}

/* Pure: Lift's stored summary -> the last three workouts and what is next. */
export function liftPart(st, now) {
  if (!st || !st.summary) return null;
  const s = st.summary;
  const workouts = Array.isArray(s.workouts) ? s.workouts : [];
  return {
    at: st.at || null,
    last: workouts.slice(0, 3).map((w) => ({ name: clip(w.name, 60), date: local(w.start).date })),
    next: s.next && s.next.name ? clip(s.next.name, 60) : null,
    nextDay: planDay(s, now),
  };
}

/* Pure: open to-dos per section. */
export function todoCounts(items) {
  const open = items.filter((i) => i && !i.done);
  const out = { open: open.length };
  for (const s of SECTIONS) out[s] = open.filter((i) => i.section === s).length;
  return out;
}

/* Pure: everything parked (items and parked projects) with its age in days, oldest first. */
export function parkedPart(doc, now) {
  if (!doc) return [];
  const today = local(now).date;
  const all = [
    ...(Array.isArray(doc.parked) ? doc.parked : []).filter(Boolean).map((p) => ({ text: p.text, from: p.from || '', since: p.since })),
    ...(Array.isArray(doc.projects) ? doc.projects : []).filter((p) => p && p.status === 'parked').map((p) => ({ text: p.next ? `${p.name}: ${p.next}` : p.name, from: 'project', since: p.since })),
  ];
  return all.map((p) => {
    const since = typeof p.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.since) ? p.since : null;
    return { text: clip(p.text, 200), from: clip(p.from, 80), since, days: since ? Math.max(0, daysBetween(since, today)) : null };
  }).sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
}

/* Pure: lessons:kept -> only the apps that keep a rule (the app list grows over time). */
export function keptPart(kept) {
  const out = {};
  if (!kept || typeof kept !== 'object') return out;
  for (const [app, rules] of Object.entries(kept)) {
    const list = Array.isArray(rules) ? rules.map((t) => clip(t, 200)).filter(Boolean) : [];
    if (list.length) out[app] = list;
  }
  return out;
}

/* ---------- The parts that read ---------- */

async function eventsPart(env, now) {
  const listed = await env.HUB_KV.list({ prefix: EVENT_PREFIX, limit: 1000 });
  const floor = now - DAYS * DAY;
  const total = listed.keys.filter((k) => msOfKey(k.name, EVENT_PREFIX) >= floor).length;
  return groupEvents(await listEvents(env, now, DAYS, MAX_EVENTS), total);
}

async function statusPart(env) {
  const s = await env.HUB_KV.get('hub:status', 'json');
  if (!s) return null;
  return { line: clip(s.line, 300), summary: clip(s.summary, 300), summaryAt: s.summaryAt || null, at: s.at || null };
}

async function mirrorPart(env) {
  const listed = await env.HUB_KV.list({ prefix: MIRROR_PREFIX, limit: 1000 });
  const names = listed.keys.map((k) => k.name).sort().reverse().slice(0, 3);
  return newestMirror(await Promise.all(names.map(async (k) => [k, await env.HUB_KV.get(k, 'json')])));
}

async function lessonsPart(env, now) {
  if (!env.HUB_DB) throw new Error('not configured');
  const from = new Date(zoned(addDays(local(now).date, -(DAYS - 1)))).toISOString();
  const [kept, proposed, counts, recent] = await Promise.all([
    env.HUB_KV.get(KEPT_KEY, 'json'),
    env.HUB_DB.prepare("SELECT app, text, why FROM lessons WHERE state = 'proposed' ORDER BY at DESC LIMIT 10").all(),
    env.HUB_DB.prepare('SELECT app, kind, COUNT(*) AS n FROM feedback WHERE at >= ? GROUP BY app, kind').bind(from).all(),
    env.HUB_DB.prepare(`SELECT app, kind, before, after FROM feedback WHERE at >= ? AND kind IN (${CORRECTIONS.map(() => '?').join(', ')}) ORDER BY at DESC LIMIT 5`).bind(from, ...CORRECTIONS).all(),
  ]);
  const feedback = {};
  for (const r of counts.results || []) (feedback[r.app] || (feedback[r.app] = {}))[r.kind] = Number(r.n) || 0;
  return {
    kept: keptPart(kept),
    proposed: (proposed.results || []).map((r) => ({ app: r.app, text: clip(r.text, 200), why: clip(r.why, 160) })),
    feedback,
    corrections: (recent.results || []).map((r) => ({ app: r.app, kind: r.kind, before: clip(r.before, 160), after: clip(r.after, 160) })),
  };
}

async function deskPart(env, now) {
  if (!env.HUB_DB) throw new Error('not configured');
  const from = new Date(now - DESK_DAYS * DAY).toISOString();
  const { results } = await env.HUB_DB.prepare('SELECT kinds, outcome FROM desk_log WHERE at >= ?').bind(from).all();
  return deskCounts(results || []);
}

async function intakePart(env, now) {
  const listed = await env.HUB_KV.list({ prefix: INTAKE_PREFIX, limit: 1000 });
  return { week: listed.keys.filter((k) => msOfKey(k.name, INTAKE_PREFIX) >= now - DAYS * DAY).length };
}

async function todosPart(env) {
  if (!env.TODO_LIST || !env.TODO_CODE) throw new Error('not configured');
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
  const d = await (await stub.fetch('https://list/read')).json();
  if (!Array.isArray(d.items)) throw new Error('no items');
  return todoCounts(d.items);
}

/* The whole digest. Never throws: a part that fails is { error }. */
export async function buildDigest(env, now = Date.now()) {
  const part = (p) => Promise.resolve().then(p).catch((e) => ({ error: clip(e && e.message ? e.message : String(e), 120) || 'failed' }));
  const [events, status, jobs, mirror, lessons, desk, lift, intake, todos, parked] = await Promise.all([
    part(() => eventsPart(env, now)),
    part(() => statusPart(env)),
    part(async () => jobState(await lastBeats(env), now)),
    part(() => mirrorPart(env)),
    part(() => lessonsPart(env, now)),
    part(() => deskPart(env, now)),
    part(async () => liftPart(await env.HUB_KV.get('lift:state', 'json'), now)),
    part(() => intakePart(env, now)),
    part(() => todosPart(env)),
    part(async () => parkedPart(await env.HUB_KV.get(PROJECTS_KEY, 'json'), now)),
  ]);
  return maskDeep({ at: new Date(now).toISOString(), date: local(now).date, days: DAYS, events, status, jobs, mirror, lessons, desk, lift, intake, todos, parked });
}

export async function handleDigest(request, env, json, now = Date.now()) {
  if (!env.BEAT_TOKEN || !safeEqual(bearer(request), env.BEAT_TOKEN)) return json({ error: 'unauthorized' }, request, 401);
  if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
  return json(await buildDigest(env, now), request);
}
