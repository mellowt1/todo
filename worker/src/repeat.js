/* Repeating tasks (Paul, 2026-10-21).
 *
 * A task with `repeat` { every: "week" | "2weeks" | "month", until } and a date in its text
 * (" · 2026-11-09") comes back when it is ticked off: the next one on the schedule, with the date
 * in its text swapped. A late tick skips what was missed, so the schedule never drifts. The series
 * stops after `until`. The app makes the next one at the tick (app/app.js nextOf, the same rules);
 * the cron makes any the app did not (a tick from somewhere else). The next one's id is fixed by the
 * series and its date, so two devices and the cron never make two.
 *
 * Bins: "every: bins" is the hub's own task, from Den Haag's bin calendar (Morning's bins block).
 * The cron keeps one open bins task, "Put the bins out (GFT and Restafval) · <the day before>",
 * for the next collection. Ticked or deleted, the next collection's comes after it.
 *
 * Once: the three "Thema avond Groep A & B samen" tasks became one, every 2 weeks, ending with the
 * last of them (KV repeat:thema:v1 keeps what it did). */

import { local, addDays, bins } from './morning.js';
import { cleanOp, MAX_TEXT } from './todo.js';
import { DUE_END } from './tidy.js';

export const THEMA_KEY = 'repeat:thema:v1';
const DAY = 24 * 3600 * 1000;
const RECENT = 21 * DAY; // the cron looks back this far for ticks without their next one
const INTAKE_MARK = /\s*\[intake\]$/;
const STEP = { week: 7, '2weeks': 14 };

/* Pure: the date at the end of the text, and where it sits. */
export function dueOf(text) {
  const mark = text.match(INTAKE_MARK);
  const body = mark ? text.slice(0, mark.index) : text;
  const m = body.match(DUE_END);
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  return { date: m[1], at: m.index, time: m[2] ? m[2] + ':' + m[3] : null, rest: mark ? mark[0] : '' };
}

/* Pure: `date` plus n months, on the same day or the month's last. */
export function addMonths(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

/* Pure: the next date on the schedule after `due` that is today or later, or null past `until`. */
export function nextDate(due, every, today, until = null) {
  let k = 1;
  let next;
  do {
    next = every === 'month' ? addMonths(due, k) : addDays(due, STEP[every] * k);
    k++;
  } while (next < today && k < 1000);
  return until && next > until ? null : next;
}

export const nextId = (it, date) => (it.series || it.id).slice(0, 20) + date.replace(/-/g, '');

/* Pure: the task that follows a ticked repeating one, or null (no date, bins, or the series ended). */
export function successor(it, today, now) {
  if (!it || !it.repeat || !(STEP[it.repeat.every] || it.repeat.every === 'month')) return null;
  const due = dueOf(it.text);
  if (!due) return null;
  const date = nextDate(due.date, it.repeat.every, today, it.repeat.until);
  if (!date) return null;
  const text = (it.text.slice(0, due.at) + ' · ' + date + (due.time ? ' ' + due.time : '') + due.rest).slice(0, MAX_TEXT);
  return {
    id: nextId(it, date), text, section: date <= today ? 'today' : 'soon', done: false, doneAt: null,
    updatedAt: now, pos: now, repeat: it.repeat, series: it.series || it.id,
  };
}

const stub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
async function exportList(env) {
  const r = await stub(env).fetch('https://list/export');
  if (!r.ok) throw new Error('todo export ' + r.status);
  const d = await r.json();
  return { items: d.items || {}, tombs: d.tombs || {} };
}
async function apply(env, ops) {
  if (!ops.length) return;
  const r = await stub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error('todo apply ' + r.status);
}

/* Pure: the next ones the app did not make. A deleted next one (a tombstone) is never remade. */
export function missingNext(doc, today, now) {
  const out = [];
  for (const it of Object.values(doc.items)) {
    if (!it.done || !it.repeat || now - it.doneAt > RECENT) continue;
    const next = successor(it, today, now);
    if (!next || doc.items[next.id] || doc.tombs[next.id] !== undefined) continue;
    out.push(next);
  }
  return out;
}

/* ---------- Bins ---------- */

const BIN_ID = /^bins\d{8}$/;
const list = (types) => (types.length < 2 ? types.join('') : types.slice(0, -1).join(', ') + ' and ' + types[types.length - 1]);
export const binsText = (c) => `Put the bins out (${list(c.types)}) · ${addDays(c.date, -1)}`;

/* Pure: the bins task to add, or null while one is open. */
export function binsTask(doc, collections, today, now) {
  const items = Object.values(doc.items);
  if (items.some((it) => BIN_ID.test(it.id) && !it.done)) return null;
  for (const c of collections || []) {
    const day = addDays(c.date, -1);
    const id = 'bins' + c.date.replace(/-/g, '');
    if (day < today || !c.types || !c.types.length) continue;
    if (doc.items[id] || doc.tombs[id] !== undefined) continue; // done or deleted: the next one
    return {
      id, text: binsText(c), section: day <= today ? 'today' : 'soon', done: false, doneAt: null,
      updatedAt: now, pos: now, repeat: { every: 'bins', until: null },
    };
  }
  return null;
}

/* ---------- Thema avond, once ---------- */

/* Pure: the ops that make the Thema avond tasks one repeating task, or []. */
export function themaOps(doc, now) {
  const open = Object.values(doc.items)
    .filter((it) => !it.done && it.text.startsWith('Thema avond Groep A & B samen') && dueOf(it.text))
    .sort((a, b) => (dueOf(a.text).date < dueOf(b.text).date ? -1 : 1));
  if (open.length < 2) return [];
  const [first, ...rest] = open;
  const until = dueOf(rest[rest.length - 1].text).date;
  const at = (it) => Math.max(now, it.updatedAt + 1);
  return [
    { op: 'upsert', item: { ...first, repeat: { every: '2weeks', until }, updatedAt: at(first) } },
    ...rest.map((it) => ({ op: 'delete', item: { id: it.id, updatedAt: at(it) } })),
  ];
}

/* ---------- The cron ---------- */

export async function repeatCron(env, now = Date.now()) {
  if (!env.TODO_CODE || !env.HUB_KV) return { skip: 'not configured' };
  const today = local(now).date;
  const doc = await exportList(env);
  const out = {};

  if (!(await env.HUB_KV.get(THEMA_KEY))) {
    const ops = themaOps(doc, now).map((o) => cleanOp(o, now)).filter(Boolean);
    await apply(env, ops);
    for (const o of ops) if (o.op === 'delete') { delete doc.items[o.item.id]; doc.tombs[o.item.id] = o.item.updatedAt; }
    await env.HUB_KV.put(THEMA_KEY, JSON.stringify({ at: new Date(now).toISOString(), ops: ops.map((o) => [o.op, o.item.id]) }));
    out.thema = ops.length;
  }

  const next = missingNext(doc, today, now).map((item) => cleanOp({ op: 'upsert', item }, now)).filter(Boolean);
  await apply(env, next);
  out.next = next.length;

  if (env.BIN_ADDRESS) {
    const b = await bins(env, now).catch(() => null);
    const task = b ? binsTask(doc, b.collections, today, now) : null;
    const op = task && cleanOp({ op: 'upsert', item: task }, now);
    if (op) await apply(env, [op]);
    out.bins = op ? op.item.id : null;
  }
  return out;
}
