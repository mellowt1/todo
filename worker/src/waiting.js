/* Waiting on (Paul, 2026-10-21): things he sent and is waiting to hear back about.
 *
 *   GET  /api/waiting/:code              -> { items, due, open, names }   open items, oldest first
 *   POST /api/waiting/:code              <- { who, what, channel, chaseDays?, forWhom?, source, sourceItem? }
 *                                        -> { item }
 *   POST /api/waiting/:code/:id          <- { action: "resolve" | "snooze" | "still", days? }  -> { item }
 *   GET  /api/hub/waiting/day            Bearer HUB_SECRET_DAY  -> { open, due, dueWho }
 *   POST /api/hub/waiting/day            Bearer HUB_SECRET_DAY  <- { who, what, channel, chaseDays? }  (source "day")
 *
 * Everything lives in D1 `waiting` (migrations/0010_waiting.sql); every change is also a hub event
 * through acceptEvent (waiting.created, waiting.chase_due, waiting.snoozed, waiting.resolved),
 * whose summary and payload carry ids only, never who or what.
 *
 * Every cron run:
 *   - an open item whose chase day has come, with no chase task out, gets one in To-do: "Chase
 *     <who> about <what>", energy drained, in Today; for someone else "<Name>: Chase ..." in the Others lane
 *     (the light Others lane groups it). The task carries `waiting` = the item's id.
 *   - an "Apply ..." or "Sollicit..." task ticked off since 1 October makes an item for that employer,
 *     email, first chase after APPLY_DAYS.
 *   - a chase task deleted from the list counts as "still waiting": the next chase comes a gap later.
 *
 * Closing goes both ways: resolving an item ticks its open chase task off (Paul chose done, not
 * removed); ticking a chase task in To-do asks whether they answered (the app then posts resolve
 * or still). Snooze moves the chase day; a chase task already out is taken away again.
 *
 * Paul's numbers (2026-10-21): chase after 7 days unless he picks another (3 / 7 / 14); 14 for an
 * application; "still waiting" uses the same gap again; snooze 3, 7 or 14 days. */

import { CODE, ID, safeEqual, bearer, cleanOp } from './todo.js';
import { acceptEvent } from './hub.js';
import { local, addDays, zoned } from './morning.js';
import { DUE_END } from './tidy.js';

export const CHASE_DAYS = 7;
export const APPLY_DAYS = 14;
export const CHASE_CHOICES = [3, 7, 14];
export const SNOOZE_CHOICES = [3, 7, 14];
export const CHANNELS = ['email', 'phone', 'letter', 'in-person'];
const SOURCES = ['todo', 'morning'];
const MAX_WHO = 60;
const MAX_WHAT = 160;
const APPLY_SINCE_KEY = 'waiting:apply-since'; // ms: Apply ticks before this never make an item
// The first run starts from here, so the applications Paul already sent in October get a wait too
// (Paul, 2026-10-21: "add the old one"). Each counts from the day it was ticked off.
export const APPLY_BACKFILL_FROM = Date.parse('2026-09-30T22:00:00Z'); // 1 October, Amsterdam
// Paul writes "Apply: ...", "Apply for nato position" or "Sollicit..." (the same start as Slayer XP).
const APPLY = /^(apply|sollicit\w*)\b\s*:?\s*(?:(?:for|to|at|bij|voor|naar)\s+)?/i;
const INTAKE_MARK = /\s*\[intake\]$/;
const clean = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const rand = (n = 16) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

async function hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
}
/* The chase task's id: derived, so a retried cron run never makes a second one. */
export const chaseTaskId = async (id, round) => (await hex('chase:' + id + ':' + round)).slice(0, 24);

/* ---------- Pure ---------- */

/* Body in, a clean new item or { error }. */
export function cleanNew(body, today) {
  if (!body || typeof body !== 'object') return { error: 'send { who, what, channel }' };
  const who = clean(body.who, MAX_WHO);
  const what = clean(body.what, MAX_WHAT);
  if (!who) return { error: 'who required' };
  if (!what) return { error: 'what required' };
  if (!CHANNELS.includes(body.channel)) return { error: 'channel: email, phone, letter or in-person' };
  const days = body.chaseDays === undefined ? CHASE_DAYS : body.chaseDays;
  if (!Number.isInteger(days) || days < 1 || days > 90) return { error: 'chaseDays: 1 to 90' };
  const forWhom = body.forWhom == null || body.forWhom === '' ? null : clean(body.forWhom, 40) || null;
  const sourceItem = typeof body.sourceItem === 'string' && ID.test(body.sourceItem) ? body.sourceItem : null;
  return { who, what, channel: body.channel, chase_days: days, for_whom: forWhom, source_item: sourceItem, since: today, next_chase: addDays(today, days) };
}

/* The chase task for an item. */
export function chaseText(it) {
  const t = 'Chase ' + it.who + ' about ' + it.what;
  return it.for_whom ? it.for_whom + ': ' + t : t;
}

/* An "Apply: Policy officer (Ministry of Defence) · 2026-10-30" task -> who and what. */
export function fromApply(text) {
  const t = String(text || '').replace(INTAKE_MARK, '').replace(DUE_END, '').trim();
  if (!APPLY.test(t)) return null;
  const rest = t.replace(APPLY, '').trim();
  const m = rest.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  const title = clean(m ? m[1] : rest, 120);
  const org = clean(m ? m[2] : '', MAX_WHO);
  if (!title) return null;
  return { who: org || 'the employer', what: 'the ' + title + ' application' };
}

/* An item as the apps see it. */
export function view(r, today) {
  return {
    id: r.id, who: r.who, what: r.what, since: r.since, channel: r.channel, chaseDays: r.chase_days,
    nextChase: r.next_chase, forWhom: r.for_whom, source: r.source, state: r.state, chases: r.chases,
    chaseDue: r.state === 'open' && r.next_chase <= today, chaseTask: r.chase_task, resolvedAt: r.resolved_at,
  };
}

/* ---------- Storage and events ---------- */

async function emit(env, type, id, source, now, extra = {}) {
  await acceptEvent(env, {
    id: type + '-' + id + '-' + now + '-' + rand(4), source, type, summary: 'Waiting on item ' + type.split('.')[1].replace('_', ' '),
    payload: { id, ...extra }, caused_by: null, hops: 0, at: new Date(now).toISOString(),
  }, { feed: false });
}

const listStub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
async function listItems(env) {
  const r = await listStub(env).fetch('https://list/export');
  if (!r.ok) throw new Error('todo export ' + r.status);
  return (await r.json());
}
async function applyOps(env, ops) {
  if (!ops.length) return;
  const r = await listStub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error('todo apply ' + r.status);
}

const getRow = (env, id) => env.HUB_DB.prepare('SELECT * FROM waiting WHERE id = ?').bind(id).first();

export async function createItem(env, fields, source, now = Date.now()) {
  const at = new Date(now).toISOString();
  const id = rand();
  const ins = await env.HUB_DB.prepare(
    `INSERT INTO waiting (id, who, what, since, chase_days, next_chase, channel, for_whom, source, source_item, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
  ).bind(id, fields.who, fields.what, fields.since, fields.chase_days, fields.next_chase, fields.channel, fields.for_whom, source, fields.source_item, at, at).run();
  if (!ins.meta || ins.meta.changes === 0) return null; // that task already made an item
  await emit(env, 'waiting.created', id, source === 'apply' ? 'todo' : source, now, source === 'apply' ? { auto: 'apply' } : {});
  return getRow(env, id);
}

/* Tick the chase task off, if it is out and still open. */
async function tickChase(env, row, now) {
  if (!row.chase_task || !env.TODO_CODE) return;
  const doc = await listItems(env);
  const it = doc.items && doc.items[row.chase_task];
  if (!it || it.done) return;
  const at = Math.max(now, (it.updatedAt || 0) + 1);
  const op = cleanOp({ op: 'upsert', item: { ...it, done: true, doneAt: at, updatedAt: at } }, at);
  if (op) await applyOps(env, [op]);
}
async function dropChase(env, row, now) {
  if (!row.chase_task || !env.TODO_CODE) return;
  const doc = await listItems(env);
  const it = doc.items && doc.items[row.chase_task];
  if (!it || it.done) return;
  await applyOps(env, [{ op: 'delete', item: { id: it.id, updatedAt: Math.max(now, (it.updatedAt || 0) + 1) } }]);
}

/* resolve | snooze | still. Returns the row or { status, error }. */
export async function actOn(env, id, body, source, now = Date.now()) {
  const row = await getRow(env, id);
  if (!row) return { status: 404, error: 'no such item' };
  const action = body && body.action;
  const today = local(now).date;
  const at = new Date(now).toISOString();
  if (action === 'resolve') {
    if (row.state === 'resolved') return row;
    await tickChase(env, row, now);
    await env.HUB_DB.prepare("UPDATE waiting SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?").bind(at, at, id).run();
    await emit(env, 'waiting.resolved', id, source, now);
    return getRow(env, id);
  }
  if (row.state !== 'open') return { status: 409, error: 'already resolved' };
  if (action === 'snooze') {
    if (!SNOOZE_CHOICES.includes(body.days)) return { status: 400, error: 'days: 3, 7 or 14' };
    await dropChase(env, row, now);
    await env.HUB_DB.prepare('UPDATE waiting SET next_chase = ?, chase_task = NULL, updated_at = ? WHERE id = ?').bind(addDays(today, body.days), at, id).run();
    await emit(env, 'waiting.snoozed', id, source, now, { days: body.days });
    return getRow(env, id);
  }
  if (action === 'still') {
    await env.HUB_DB.prepare('UPDATE waiting SET next_chase = ?, chase_task = NULL, updated_at = ? WHERE id = ?').bind(addDays(today, row.chase_days), at, id).run();
    await emit(env, 'waiting.snoozed', id, source, now, { days: row.chase_days, still: true });
    return getRow(env, id);
  }
  return { status: 400, error: 'action: resolve, snooze or still' };
}

export async function openItems(env, now = Date.now()) {
  const today = local(now).date;
  const { results } = await env.HUB_DB.prepare("SELECT * FROM waiting WHERE state = 'open' ORDER BY since, created_at").all();
  return (results || []).map((r) => view(r, today));
}

/* The last names used, for chips. */
async function recentNames(env) {
  const { results } = await env.HUB_DB.prepare('SELECT who FROM waiting ORDER BY created_at DESC LIMIT 40').all();
  return [...new Set((results || []).map((r) => r.who))].slice(0, 6);
}

/* ---------- The cron ---------- */

export async function waitingCron(env, now = Date.now()) {
  if (!env.HUB_DB || !env.TODO_CODE) return { chased: 0, made: 0 };
  const today = local(now).date;
  const doc = await listItems(env);
  const items = doc.items || {};
  const tombs = doc.tombs || {};

  // Apply: ... ticked off after the start: one item each (the unique source_item keeps it once).
  let made = 0;
  let since = Number(await env.HUB_KV.get(APPLY_SINCE_KEY));
  if (!since) { since = Math.min(APPLY_BACKFILL_FROM, now); await env.HUB_KV.put(APPLY_SINCE_KEY, String(since)); }
  for (const it of Object.values(items)) {
    if (!it.done || !it.doneAt || it.doneAt < since || it.waiting) continue;
    const a = fromApply(it.text);
    if (!a) continue;
    const day = local(it.doneAt).date;
    const row = await createItem(env, { ...a, channel: 'email', chase_days: APPLY_DAYS, for_whom: null, source_item: it.id, since: day, next_chase: addDays(day, APPLY_DAYS) }, 'apply', now);
    if (row) made++;
  }

  // Chase tasks.
  const { results } = await env.HUB_DB.prepare("SELECT * FROM waiting WHERE state = 'open' AND (next_chase <= ? OR chase_task IS NOT NULL)").bind(today).all();
  const ops = [];
  const at = new Date(now).toISOString();
  let chased = 0;
  for (const row of results || []) {
    if (row.chase_task) {
      // Deleted from the list: still waiting, a gap from now.
      if (tombs[row.chase_task] !== undefined && !items[row.chase_task]) {
        await env.HUB_DB.prepare('UPDATE waiting SET chase_task = NULL, next_chase = ?, updated_at = ? WHERE id = ?').bind(addDays(today, row.chase_days), at, row.id).run();
      }
      continue;
    }
    if (row.next_chase > today) continue;
    const taskId = await chaseTaskId(row.id, row.chases + 1);
    const t = now + chased; // distinct pos per task
    const op = cleanOp({ op: 'upsert', item: {
      id: taskId, text: chaseText(row).slice(0, 500), section: row.for_whom ? 'others' : 'today', done: false, doneAt: null,
      updatedAt: t, pos: t, energy: 'drained', waiting: row.id,
    } }, t);
    if (!op) continue;
    if (!items[taskId] && tombs[taskId] === undefined) ops.push(op);
    await env.HUB_DB.prepare('UPDATE waiting SET chase_task = ?, chases = chases + 1, updated_at = ? WHERE id = ?').bind(taskId, at, row.id).run();
    await emit(env, 'waiting.chase_due', row.id, 'hub', now, { task: taskId });
    chased++;
  }
  await applyOps(env, ops);
  return { chased, made };
}

/* ---------- Blocks for Morning and the Sunday reset ---------- */

export async function waitingForMorning(env, now = Date.now()) {
  if (!env.HUB_DB) return null;
  const items = await openItems(env, now);
  const due = items.filter((i) => i.chaseDue);
  return { open: items.length, due: due.length, dueWho: due.slice(0, 3).map((i) => i.who), items: items.slice(0, 8) };
}

export async function waitingWeek(env, monday, now = Date.now()) {
  if (!env.HUB_DB) return null;
  const from = new Date(zoned(monday)).toISOString();
  const [items, resolved, chased] = await Promise.all([
    openItems(env, now),
    env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM waiting WHERE state = 'resolved' AND resolved_at >= ?").bind(from).first(),
    env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'waiting.chase_due' AND at >= ?").bind(from).first(),
  ]);
  return { items, resolved: resolved ? resolved.n : 0, chased: chased ? chased.n : 0 };
}

/* ---------- Routes ---------- */

async function readJson(request, max = 4000) {
  const raw = await request.text();
  if (raw.length > max) return { status: 413, error: 'too large' };
  try { return { body: raw ? JSON.parse(raw) : {} }; } catch (e) { return { status: 400, error: 'bad json' }; }
}

async function create(request, env, source, json, now) {
  const got = await readJson(request);
  if (got.error) return json({ error: got.error }, request, got.status);
  const src = source || (SOURCES.includes(got.body && got.body.source) ? got.body.source : null);
  if (!src) return json({ error: 'source: todo or morning' }, request, 400);
  const today = local(now).date;
  const f = cleanNew(got.body, today);
  if (f.error) return json({ error: f.error }, request, 400);
  const row = await createItem(env, f, src, now);
  if (!row) return json({ error: 'that task already has one' }, request, 409);
  return json({ item: view(row, today) }, request);
}

export async function handleWaiting(request, env, rest, json, now = Date.now()) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  if (rest.length === 1) {
    if (request.method === 'GET') {
      const [items, names] = await Promise.all([openItems(env, now), recentNames(env)]);
      return json({ items, open: items.length, due: items.filter((i) => i.chaseDue).length, names }, request);
    }
    if (request.method === 'POST') return create(request, env, null, json, now);
    return json({ error: 'method' }, request, 405);
  }
  if (rest.length === 2 && /^[a-z0-9]{16}$/.test(rest[1])) {
    if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
    const got = await readJson(request, 1000);
    if (got.error) return json({ error: got.error }, request, got.status);
    const src = SOURCES.includes(got.body && got.body.source) ? got.body.source : 'todo';
    const out = await actOn(env, rest[1], got.body, src, now);
    if (out.error) return json({ error: out.error }, request, out.status);
    return json({ item: view(out, local(now).date) }, request);
  }
  return json({ error: 'not found' }, request, 404);
}

/* /api/hub/waiting/day: Day's chases-due chip and quick add, through the Odysseus backend. */
export async function handleWaitingDay(request, env, json, now = Date.now()) {
  if (!env.HUB_SECRET_DAY || !safeEqual(bearer(request), env.HUB_SECRET_DAY)) return json({ error: 'unauthorized' }, request, 401);
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  if (request.method === 'GET') {
    const items = await openItems(env, now);
    const due = items.filter((i) => i.chaseDue);
    return json({ open: items.length, due: due.length, dueWho: due.slice(0, 3).map((i) => i.who) }, request);
  }
  if (request.method === 'POST') return create(request, env, 'day', json, now);
  return json({ error: 'method' }, request, 405);
}
