/* Archive (Paul, 2026-10-22; Phase 5, the master prompt's "task graveyard", drawn plain: no
 * headstones). A task passed on LIMIT times gets a decision line in To-do and Morning: Do it now (the
 * Dread meter's start), Hand off (a Waiting on item, src/waiting.js, `handoff: true`), Archive (with
 * an optional note) or Later (the line comes back after the next skip).
 *
 *   GET  /api/archive/:code              -> { due: [{ task, name, section, skips }], archived }
 *   GET  /api/archive/:code/list         -> { items: [{ task, name, added, archived, skips, note }] }  newest first
 *   POST /api/archive/:code/later        <- { task, source }
 *   POST /api/archive/:code/archive      <- { task, note?, source }  the task leaves the list
 *   POST /api/archive/:code/restore      <- { task, source }         back in Soon, its count from 0
 *
 * Skips (Paul's answers): "Not this one" (energy.skipped) and a move out of Today (dread.skipped),
 * counted from the day this went live (KV archive:since), never Waiting on snoozes. Each task's count
 * starts again after it is archived or restored. Never a decision line: repeating tasks, chase tasks
 * (Waiting on has them), tasks read from letters ([intake]) and the Others lane.
 *
 * Everything is a hub event through acceptEvent, ids only, out of Morning's feed: task.fate_due
 * (once per count), task.fate_later, task.buried, task.resurrected; task.handed_off comes from
 * src/waiting.js. The archived task itself (its text) lives in D1 `archive` (migrations/0012). */

import { CODE, ID, safeEqual, cleanOp } from './todo.js';
import { acceptEvent } from './hub.js';
import { readItems, listStub, nameAndDue } from './energy.js';
import { maskSecrets } from './mask.js';
import { zoned, addDays } from './morning.js';

export const LIMIT = 5; // passed on this many times: the decision line (Paul, 2026-10-22)
export const MAX_NOTE = 80;
const SINCE_KEY = 'archive:since'; // ms: skips before this never count ("from launch", Paul)
const SOURCES = ['todo', 'morning'];
const SKIPS = ['energy.skipped', 'dread.skipped'];
const TYPES = "('energy.skipped', 'dread.skipped', 'task.fate_later', 'task.fate_due', 'task.buried', 'task.resurrected')";
const INTAKE_MARK = /\s*\[intake\]$/;

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
const parse = (s) => { try { return JSON.parse(s) || {}; } catch (e) { return {}; } };
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const nameOf = (it) => maskSecrets(nameAndDue(it.text).name);

/* Pure: a task that may get the decision line at all. */
export function eligible(it) {
  return !!it && !it.done && !it.repeat && !it.series && !it.waiting && it.section !== 'others'
    && !INTAKE_MARK.test(String(it.text || ''));
}

/* Pure: the events since launch (oldest first) -> per task { skips, later, skipAfter, due }. */
export function tally(rows) {
  const by = new Map();
  const fresh = () => ({ skips: 0, later: false, skipAfter: false, due: false });
  for (const r of rows) {
    const task = parse(r.payload).task;
    if (typeof task !== 'string') continue;
    if (!by.has(task)) by.set(task, fresh());
    const t = by.get(task);
    if (SKIPS.includes(r.type)) { t.skips++; if (t.later) t.skipAfter = true; }
    else if (r.type === 'task.fate_later') { t.later = true; t.skipAfter = false; }
    else if (r.type === 'task.fate_due') t.due = true;
    else if (r.type === 'task.buried' || r.type === 'task.resurrected') by.set(task, fresh());
  }
  return by;
}

/* Pure: the tally + the list -> the tasks that get the line, most passed-on first. `fresh` lists the
 * ones that just reached LIMIT (their task.fate_due is not written yet). */
export function dueFrom(by, items) {
  const due = [];
  const fresh = [];
  for (const [task, t] of by) {
    const it = items[task];
    if (t.skips < LIMIT || !eligible(it)) continue;
    if (!t.due) fresh.push(task);
    if (t.later && !t.skipAfter) continue;
    due.push({ task, name: nameOf(it), section: it.section, skips: t.skips });
  }
  due.sort((a, b) => b.skips - a.skips || (items[a.task].pos || 0) - (items[b.task].pos || 0));
  return { due, fresh };
}

async function since(env, now) {
  const v = Number(await env.HUB_KV.get(SINCE_KEY));
  if (v) return v;
  await env.HUB_KV.put(SINCE_KEY, String(now));
  return now;
}

async function emit(env, type, source, payload, now, summary) {
  await acceptEvent(env, {
    id: type.replace('.', '-') + '-' + now + '-' + rand(), source, type, summary,
    payload, caused_by: null, hops: 0, at: new Date(now).toISOString(),
  }, { feed: false });
}

async function tallyNow(env, now) {
  const from = new Date(await since(env, now)).toISOString();
  const { results } = await env.HUB_DB.prepare('SELECT type, payload, at FROM events WHERE type IN ' + TYPES + ' AND at >= ? ORDER BY at, rowid').bind(from).all();
  return tally(results || []);
}

/* The lines due now; writes task.fate_due once for a task that just reached LIMIT. */
export async function fateNow(env, now = Date.now(), items = null) {
  const by = await tallyNow(env, now);
  const list = items || await readItems(env);
  const { due, fresh } = dueFrom(by, list);
  for (const task of fresh) await emit(env, 'task.fate_due', 'hub', { task, skips: by.get(task).skips }, now, 'Passed on ' + LIMIT + ' times');
  return due;
}

async function archivedCount(env) {
  const r = await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM archive WHERE state = 'archived'").first();
  return r ? r.n : 0;
}

export async function archiveTask(env, task, note, source, now = Date.now()) {
  const items = await readItems(env);
  const it = items[task];
  if (!it || it.done) return { status: 404, error: 'no such open task' };
  const skips = (await tallyNow(env, now)).get(task)?.skips || 0;
  const at = new Date(now).toISOString();
  await env.HUB_DB.prepare(
    `INSERT INTO archive (task_id, item, added_at, archived_at, skips, note, state, restored_at) VALUES (?, ?, ?, ?, ?, ?, 'archived', NULL)
     ON CONFLICT(task_id) DO UPDATE SET item = excluded.item, added_at = COALESCE(excluded.added_at, archive.added_at), archived_at = excluded.archived_at,
       skips = excluded.skips, note = excluded.note, state = 'archived', restored_at = NULL`
  ).bind(task, JSON.stringify(it), Number.isFinite(it.created) ? it.created : null, at, skips, note || null).run();
  const r = await listStub(env).fetch('https://list/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops: [{ op: 'delete', item: { id: task, updatedAt: Math.max(now, (it.updatedAt || 0) + 1) } }] }) });
  if (!r.ok) throw new Error('todo apply ' + r.status);
  await emit(env, 'task.buried', source, { task, skips }, now, 'Archived a task');
  return { ok: true, task, skips };
}

export async function restoreTask(env, task, source, now = Date.now()) {
  const row = await env.HUB_DB.prepare('SELECT * FROM archive WHERE task_id = ?').bind(task).first();
  if (!row || row.state !== 'archived') return { status: 404, error: 'not archived' };
  const doc = await (await listStub(env).fetch('https://list/export')).json();
  const tomb = (doc.tombs || {})[task] || 0;
  const at = Math.max(now, tomb + 1);
  const old = parse(row.item);
  const op = cleanOp({ op: 'upsert', item: { ...old, id: task, section: 'soon', done: false, doneAt: null, updatedAt: at, pos: at } }, at);
  if (!op) return { status: 422, error: 'could not restore' };
  if (Number.isFinite(row.added_at)) op.item.created = row.added_at;
  const r = await listStub(env).fetch('https://list/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: [op] }) });
  if (!r.ok) throw new Error('todo apply ' + r.status);
  await env.HUB_DB.prepare("UPDATE archive SET state = 'restored', restored_at = ? WHERE task_id = ?").bind(new Date(now).toISOString(), task).run();
  await emit(env, 'task.resurrected', source, { task }, now, 'Restored a task');
  return { ok: true, task, section: 'soon' };
}

/* Pure: a ledger row. */
export function ledgerRow(r) {
  const it = parse(r.item);
  return { task: r.task_id, name: it.text ? nameOf(it) : '', added: r.added_at ?? null, archived: r.archived_at, skips: r.skips, note: r.note || '' };
}

export async function archivedList(env) {
  const { results } = await env.HUB_DB.prepare("SELECT * FROM archive WHERE state = 'archived' ORDER BY archived_at DESC").all();
  return (results || []).map(ledgerRow);
}

/* The cron: writes task.fate_due for tasks that reached LIMIT with no app open. */
export async function archiveCron(env, now = Date.now()) {
  if (!env.HUB_DB || !env.TODO_CODE) return { skipped: true };
  return { due: (await fateNow(env, now)).length };
}

/* The Sunday card: what was archived and handed off this week, and how many came back. */
export async function archiveWeek(env, monday) {
  if (!env.HUB_DB) return null;
  const from = new Date(zoned(monday)).toISOString();
  const to = new Date(zoned(addDays(monday, 7))).toISOString();
  const [arch, handed, back] = await Promise.all([
    env.HUB_DB.prepare('SELECT * FROM archive WHERE archived_at >= ? AND archived_at < ? ORDER BY archived_at').bind(from, to).all().then((r) => r.results || []),
    env.HUB_DB.prepare("SELECT e.payload, w.who, w.what, w.next_chase, w.state FROM events e LEFT JOIN waiting w ON w.id = json_extract(e.payload, '$.waiting') WHERE e.type = 'task.handed_off' AND e.at >= ? AND e.at < ? ORDER BY e.at").bind(from, to).all().then((r) => r.results || []),
    env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'task.resurrected' AND at >= ? AND at < ?").bind(from, to).first(),
  ]);
  return {
    archived: arch.map((r) => { const l = ledgerRow(r); return { name: l.name, skips: l.skips, note: l.note }; }),
    handedOff: handed.filter((h) => h.who).map((h) => ({ name: h.what, who: h.who, nextChase: h.state === 'open' ? h.next_chase : null })),
    restored: back ? back.n : 0,
  };
}

/* ---------- Routes ---------- */

async function readJson(request, max = 2000) {
  const raw = await request.text();
  if (raw.length > max) return { status: 413, error: 'too large' };
  try { return { body: raw ? JSON.parse(raw) : {} }; } catch (e) { return { status: 400, error: 'bad json' }; }
}

export async function handleArchive(request, env, rest, json, now = Date.now()) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  const sub = rest.slice(1);
  if (request.method === 'GET') {
    if (sub.length === 0) {
      const [due, archived] = await Promise.all([fateNow(env, now), archivedCount(env)]);
      return json({ due, archived, limit: LIMIT }, request);
    }
    if (sub.length === 1 && sub[0] === 'list') return json({ items: await archivedList(env) }, request);
    return json({ error: 'not found' }, request, 404);
  }
  if (request.method !== 'POST' || sub.length !== 1) return json({ error: 'not found' }, request, 404);
  const got = await readJson(request);
  if (got.error) return json({ error: got.error }, request, got.status);
  const b = got.body && typeof got.body === 'object' ? got.body : {};
  const src = SOURCES.includes(b.source) ? b.source : null;
  if (!src) return json({ error: 'source: todo or morning' }, request, 400);
  const task = typeof b.task === 'string' && ID.test(b.task) ? b.task : null;
  if (!task) return json({ error: 'task: an id' }, request, 400);
  const send = (out) => json(out.error ? { error: out.error } : out, request, out.status || 200);
  switch (sub[0]) {
    case 'later':
      await emit(env, 'task.fate_later', src, { task }, now, 'Decide later');
      return json({ ok: true }, request);
    case 'archive': {
      if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') return json({ error: 'note: text' }, request, 400);
      return send(await archiveTask(env, task, clean(b.note, MAX_NOTE), src, now));
    }
    case 'restore':
      return send(await restoreTask(env, task, src, now));
    default:
      return json({ error: 'not found' }, request, 404);
  }
}
