/* Day plans dated to-dos (Paul, 2026-10-19: "it will plan stuff in Day if I put times or dates
 * on the to-do").
 *
 *   GET /api/hub/todo/day   Bearer HUB_SECRET_DAY -> { tasks: [{ id, title, date, time, appt? }], undated, at }
 *
 * Every open task whose text ends in the list's date ending (" · YYYY-MM-DD", or with " HH:MM",
 * which Tidy writes, src/tidy.js) and whose date is no more than 14 days gone. Day (Odysseus on
 * the Mac) pulls this and keeps one calendar row per task: a block at the time, or an all-day row
 * on the date. It also reaches the iPhone (Paul's choice). One direction: a task ticked or
 * deleted here, or its date taken off, is gone from the next answer and Day removes its row.
 * The title is the name, masked like Morning (src/mask.js), with no date and no [intake] mark.
 *
 * Appointments (2026-11-04, after a psychologist visit typed with no date never reached Day): a
 * task Tidy read as one carries appt: true, and every open appointment with no date yet comes in
 * `undated` [{ id, title }], newest first, so Day can show it until a date is added.
 *
 * On the calendar (Paul, 2026-11-04: once an appointment is surely in the calendar it can leave the
 * list until its day). After Day has written its rows it tells the hub which ones it holds:
 *
 *   POST /api/hub/todo/day/ack   Bearer HUB_SECRET_DAY, { rows: [{ id, date }] } -> { marked }
 *
 * Each open appointment whose text date is that date gets cal: date (src/todo.js). The app then
 * folds it out of Soon until the day, when src/due.js brings it into Today as before. It is never
 * ticked: a ticked task leaves this route's answer and Day would delete its row. A date changed
 * in To-do no longer matches, so the task shows again until Day confirms the new one. */

import { safeEqual, bearer, cleanOp, ID } from './todo.js';
import { dueDate } from './due.js';
import { DUE_END } from './tidy.js';
import { maskSecrets } from './mask.js';
import { local, addDays } from './morning.js';

export const PAST_DAYS = 14;
export const TITLE_MAX = 120;
const INTAKE_MARK = /\s*\[intake\]$/;

/* Pure: the list's items -> the tasks Day plans, by date and time. */
export function dayTasks(items, today) {
  const from = addDays(today, -PAST_DAYS);
  const out = [];
  for (const it of items) {
    if (!it || it.done || typeof it.text !== 'string') continue;
    const text = it.text.replace(INTAKE_MARK, '');
    const m = text.match(DUE_END);
    if (!m || m[1] < from || Number.isNaN(Date.parse(m[1]))) continue;
    const title = maskSecrets(text.slice(0, m.index)).trim().slice(0, TITLE_MAX);
    if (!title) continue;
    out.push({ id: it.id, title, date: m[1], time: m[2] ? m[2] + ':' + m[3] : null, ...(it.appt === true ? { appt: true } : {}) });
  }
  return out.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

/* Pure: open appointments with no date yet, newest first. */
export const UNDATED_MAX = 10;
export function undatedAppointments(items) {
  return items
    .filter((it) => it && !it.done && it.appt === true && typeof it.text === 'string' && !it.text.replace(INTAKE_MARK, '').match(DUE_END))
    .sort((a, b) => (b.pos || 0) - (a.pos || 0))
    .map((it) => ({ id: it.id, title: maskSecrets(it.text.replace(INTAKE_MARK, '')).trim().slice(0, TITLE_MAX) }))
    .filter((t) => t.title)
    .slice(0, UNDATED_MAX);
}

export async function todoForDay(env, now = Date.now()) {
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
  const d = await (await stub.fetch('https://list/read')).json();
  if (!Array.isArray(d.items)) throw new Error('no items');
  return { tasks: dayTasks(d.items, local(now).date), undated: undatedAppointments(d.items), at: now };
}

/* Pure: the appointments Day confirmed that are not marked yet, as upserts. */
export const ACK_MAX = 300;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function ackOps(items, rows, now) {
  const ops = [];
  for (const r of rows.slice(0, ACK_MAX)) {
    if (!r || typeof r.id !== 'string' || !ID.test(r.id) || typeof r.date !== 'string' || !DATE.test(r.date)) continue;
    const it = items[r.id];
    if (!it || it.done || it.appt !== true || it.cal === r.date || dueDate(it.text) !== r.date) continue;
    const at = Math.max(now, it.updatedAt + 1);
    const op = cleanOp({ op: 'upsert', item: { ...it, cal: r.date, updatedAt: at } }, at);
    if (op) ops.push(op);
  }
  return ops;
}

export async function handleTodoDayAck(request, env, json, now = Date.now()) {
  if (!env.HUB_SECRET_DAY || !safeEqual(bearer(request), env.HUB_SECRET_DAY)) return json({ error: 'unauthorized' }, request, 401);
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  if (!env.TODO_LIST || !env.TODO_CODE) return json({ error: 'not configured' }, request, 503);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.rows)) return json({ error: 'rows required' }, request, 400);
  try {
    const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
    const doc = await (await stub.fetch('https://list/export')).json();
    const ops = ackOps(doc.items || {}, body.rows, now);
    if (ops.length) {
      const w = await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
      if (!w.ok) throw new Error('apply ' + w.status);
    }
    return json({ marked: ops.length }, request);
  } catch (e) {
    return json({ error: 'list unavailable' }, request, 502);
  }
}

export async function handleTodoDay(request, env, json, now = Date.now()) {
  if (!env.HUB_SECRET_DAY || !safeEqual(bearer(request), env.HUB_SECRET_DAY)) return json({ error: 'unauthorized' }, request, 401);
  if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
  if (!env.TODO_LIST || !env.TODO_CODE) return json({ error: 'not configured' }, request, 503);
  try {
    return json(await todoForDay(env, now), request);
  } catch (e) {
    return json({ error: 'list unavailable' }, request, 502);
  }
}
