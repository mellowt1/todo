/* Day plans dated to-dos (Paul, 2026-10-19: "it will plan stuff in Day if I put times or dates
 * on the to-do").
 *
 *   GET /api/hub/todo/day   Bearer HUB_SECRET_DAY -> { tasks: [{ id, title, date, time }], at }
 *
 * Every open task whose text ends in the list's date ending (" · YYYY-MM-DD", or with " HH:MM",
 * which Tidy writes, src/tidy.js) and whose date is no more than 14 days gone. Day (Odysseus on
 * the Mac) pulls this and keeps one calendar row per task: a block at the time, or an all-day row
 * on the date. It also reaches the iPhone (Paul's choice). One direction: a task ticked or
 * deleted here, or its date taken off, is gone from the next answer and Day removes its row.
 * The title is the name, masked like Morning (src/mask.js), with no date and no [intake] mark.
 * Read only. */

import { safeEqual, bearer } from './todo.js';
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
    out.push({ id: it.id, title, date: m[1], time: m[2] ? m[2] + ':' + m[3] : null });
  }
  return out.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

export async function todoForDay(env, now = Date.now()) {
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
  const d = await (await stub.fetch('https://list/read')).json();
  if (!Array.isArray(d.items)) throw new Error('no items');
  return { tasks: dayTasks(d.items, local(now).date), at: now };
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
