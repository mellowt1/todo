/* Lanes: the tasks Paul picked for each lane move there once (2026-10-21).
 *
 * A once-only cron job per lane, like retire.js: KV lanes:<lane>:v1 keeps what it did, and a
 * second run skips. Only the section changes (text and pos stay, so a task that waited two weeks
 * still pays its Attack XP). A task that is gone, done or moved somewhere else since Paul picked
 * it is left alone. `tick` is for the picks that are already built: they are ticked off instead.
 *
 * Build (Paul's picks): the Desk friction readout and birthdays in Day move in; the two To-do
 * requests (weekly repeats, Slayer for job applications) are built and live, so they are ticked. */

import { cleanOp } from './todo.js';

export const MOVES = {
  build: {
    key: 'lanes:build:v1',
    from: ['soon'],
    move: ['ng3x9nsfkl36exdk', 'xp0tizx9ovelgfdk'],
    tick: ['h9b87rzey00logw2', 'qllqzv1i0jkq3yct'],
  },
};

/* Pure: one lane's picks against the list -> the ops. */
export function laneOps(lane, plan, items, now) {
  const ops = [];
  const at = (it) => Math.max(now, it.updatedAt + 1);
  for (const id of plan.move || []) {
    const it = items[id];
    if (!it || it.done || !plan.from.includes(it.section)) continue;
    ops.push(cleanOp({ op: 'upsert', item: { ...it, section: lane, updatedAt: at(it) } }, at(it)));
  }
  for (const id of plan.tick || []) {
    const it = items[id];
    if (!it || it.done) continue;
    ops.push(cleanOp({ op: 'upsert', item: { ...it, done: true, doneAt: at(it), updatedAt: at(it) } }, at(it)));
  }
  return ops.filter(Boolean);
}

export async function laneMoves(env, now = Date.now()) {
  if (!env.TODO_CODE || !env.HUB_KV) return { skip: 'not configured' };
  const out = {};
  for (const [lane, plan] of Object.entries(MOVES)) {
    if (await env.HUB_KV.get(plan.key)) { out[lane] = 'done'; continue; }
    const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
    const doc = await (await stub.fetch('https://list/export')).json();
    const ops = laneOps(lane, plan, doc.items || {}, now);
    if (ops.length) {
      const r = await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
      if (!r.ok) throw new Error('todo apply ' + r.status);
    }
    await env.HUB_KV.put(plan.key, JSON.stringify({ at: new Date(now).toISOString(), ops: ops.map((o) => [o.item.id, o.item.done ? 'ticked' : o.item.section]) }));
    out[lane] = ops.length;
  }
  return out;
}
