/* Dates drive placement (2026-10-21): an open task whose date has come moves into Today.
 *
 * The date lives in the task's text, as Tidy writes it (" · 2026-10-25", maybe a time after it,
 * maybe "[intake]" last). Every cron run (every 15 minutes) moves each open task in Soon or
 * Someday whose date is today or earlier into Today. Overdue tasks move too.
 *
 * Only the section and updatedAt change: the text and pos stay, so nothing is rewritten and a task
 * that waited two weeks still pays its Attack XP. Today shows dated tasks first (app/app.js).
 *
 * A task moves once per date. KV due:moved holds { taskId: date } for the moves made; when Paul
 * moves a task back out of Today on its day it stays where he put it. A new date moves it again. */

import { local } from './morning.js';
import { cleanOp } from './todo.js';
import { DUE_END } from './tidy.js';

export const MOVED_KEY = 'due:moved';
const INTAKE_MARK = /\s*\[intake\]$/;

/* Pure: the date at the end of a task's text, or null. */
export function dueDate(text) {
  if (typeof text !== 'string') return null;
  const m = text.replace(INTAKE_MARK, '').match(DUE_END);
  return m && !Number.isNaN(Date.parse(m[1])) ? m[1] : null;
}

/* Pure: which tasks move today, and the marks to keep. */
export function dueMoves(items, moved, today) {
  const move = [];
  const keep = {};
  for (const it of Object.values(items)) {
    if (!it || it.done) continue;
    const d = dueDate(it.text);
    if (!d) continue;
    if (moved[it.id] === d) { keep[it.id] = d; continue; } // moved once for this date already
    if (d > today) continue;
    keep[it.id] = d; // in Today on its day, moved or put there: taken out again, it stays out
    if (it.section !== 'today') move.push(it);
  }
  return { move, keep };
}

const stub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));

export async function dueCron(env, now = Date.now()) {
  if (!env.TODO_CODE || !env.HUB_KV) return { moved: 0 };
  const r = await stub(env).fetch('https://list/export');
  if (!r.ok) throw new Error('todo export ' + r.status);
  const doc = await r.json();
  const moved = (await env.HUB_KV.get(MOVED_KEY, 'json')) || {};
  const { move, keep } = dueMoves(doc.items || {}, moved, local(now).date);
  const ops = [];
  for (const it of move) {
    const at = Math.max(now, it.updatedAt + 1);
    const op = cleanOp({ op: 'upsert', item: { ...it, section: 'today', updatedAt: at } }, at);
    if (op) ops.push(op);
  }
  if (ops.length) {
    const w = await stub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
    if (!w.ok) throw new Error('todo apply ' + w.status);
  }
  if (JSON.stringify(keep) !== JSON.stringify(moved)) await env.HUB_KV.put(MOVED_KEY, JSON.stringify(keep));
  return { moved: ops.length };
}
