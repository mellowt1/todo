/* Gym days in the to-do (Paul, 2026-11-05: "Gym should automatically show up in my todo when
 * lift has the days set for the workouts").
 *
 * On a gym day Lift plans (its ticked weekdays, src/lift.js planDay), the hub puts one task in
 * Today: "Gym: <the routine due next> · <date>". Its id is "gym" + the date, so the cron and the
 * Lift sync never make two, and a task Paul deleted is never made again.
 *   - A workout logged in Lift that day ticks it (the tick time is the workout's end).
 *   - A gym day that passed with no workout: its task goes away; Lift rolls the plan forward.
 *   - Ticked here, it pays Woodcutting like any task; Strength comes from Lift itself.
 * Day already draws gym days from Lift, so src/dayplan.js leaves these tasks out.
 * Runs on every cron run and right after Lift sends its state. */

import { local } from './morning.js';
import { cleanOp, MAX_TEXT } from './todo.js';
import { planDay } from './lift.js';

export const GYM_ID = /^gym(\d{4})(\d{2})(\d{2})$/;
export const gymId = (date) => 'gym' + date.replace(/-/g, '');
const dateOf = (id) => { const m = id.match(GYM_ID); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
export const gymText = (name, date) => `Gym: ${name || 'workout'} · ${date}`.slice(0, MAX_TEXT);

/* Pure: Lift's summary + the list -> the ops that keep gym days right. */
export function gymOps(doc, s, now) {
  if (!s || !Array.isArray(s.days) || !Array.isArray(s.workouts)) return [];
  const today = local(now).date;
  const ops = [];
  const at = (it) => Math.max(now, (it.updatedAt || 0) + 1);
  const worked = new Map(); // date -> the end of that day's last workout
  for (const w of s.workouts) {
    const d = local(w.start).date;
    worked.set(d, Math.max(worked.get(d) || 0, w.end || w.start));
  }

  for (const it of Object.values(doc.items)) {
    const date = dateOf(it.id);
    if (!date || it.done) continue;
    if (worked.has(date)) ops.push({ op: 'upsert', item: { ...it, done: true, doneAt: Math.min(worked.get(date), now), updatedAt: at(it) } });
    else if (date < today) ops.push({ op: 'delete', item: { id: it.id, updatedAt: at(it) } });
  }

  // Today's task, when today is a planned gym day with no workout yet.
  if (s.days.some(Boolean) && planDay(s, now) === today && !worked.has(today)) {
    const id = gymId(today);
    if (!doc.items[id] && doc.tombs[id] === undefined) {
      ops.push({ op: 'upsert', item: { id, text: gymText(s.next && s.next.name, today), section: 'today', done: false, doneAt: null, updatedAt: now, pos: now } });
    }
  }
  return ops.map((o) => cleanOp(o, now)).filter(Boolean);
}

const stub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));

export async function gymCron(env, now = Date.now()) {
  if (!env.TODO_CODE || !env.HUB_KV || !env.TODO_LIST) return { skip: 'not configured' };
  const st = await env.HUB_KV.get('lift:state', 'json');
  if (!st || !st.summary) return { skip: 'no lift state' };
  const r = await stub(env).fetch('https://list/export');
  if (!r.ok) throw new Error('todo export ' + r.status);
  const d = await r.json();
  const ops = gymOps({ items: d.items || {}, tombs: d.tombs || {} }, st.summary, now);
  if (ops.length) {
    const a = await stub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
    if (!a.ok) throw new Error('todo apply ' + a.status);
  }
  return { gym: ops.map((o) => (o.op === 'delete' ? '-' : o.item.done ? '✓' : '+') + o.item.id) };
}
