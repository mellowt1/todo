/* Cleaning tasks on Paul's cleaning weekend (Paul, 2026-11-07: "whenever it is my week to clean
 * add the following tasks: Clean Kitchen, Clean Living room, Office, Bathroom, toilet, stairs
 * bedroom only when it is my week").
 *
 * The Cleaning rota lives in the ROTAS secret (src/morning.js rotasBlock). When the turn that is
 * on now is Paul's own ("You"), the hub puts the seven chores in Today, once per turn. A turn
 * that is someone else's or a shared one adds nothing.
 *   - Ids are "clean" + the turn's first day + the chore, so the cron never makes two and a
 *     chore Paul deleted is never made again.
 *   - No date in the text: Day and the iPhone calendar leave them out (seven rows is too many).
 *   - Chores still open from an earlier turn go when the next one of Paul's starts.
 * Runs on every cron run. */

import { rotasBlock } from './morning.js';
import { cleanOp } from './todo.js';

export const CHORES = [
  ['kitchen', 'Clean kitchen'],
  ['living', 'Clean living room'],
  ['office', 'Clean office'],
  ['bathroom', 'Clean bathroom'],
  ['toilet', 'Clean toilet'],
  ['stairs', 'Clean stairs'],
  ['bedroom', 'Clean bedroom'],
];
export const CLEAN_ID = /^clean(\d{8})[a-z]+$/;
export const cleanId = (date, key) => 'clean' + date.replace(/-/g, '') + key;
const PAUL = /^(you|paul)$/i;

/* Pure: the ROTAS secret + the list -> the ops for Paul's cleaning turn. */
export function cleaningOps(doc, rotasRaw, now) {
  const turn = rotasBlock(rotasRaw, now).rotas.find((r) => /clean/i.test(r.what));
  if (!turn || turn.days > 0 || !PAUL.test(turn.who)) return [];
  const stamp = turn.date.replace(/-/g, '');
  const ops = [];
  for (const it of Object.values(doc.items)) {
    const m = it.id.match(CLEAN_ID);
    if (m && m[1] < stamp && !it.done) ops.push({ op: 'delete', item: { id: it.id, updatedAt: Math.max(now, (it.updatedAt || 0) + 1) } });
  }
  CHORES.forEach(([key, text], i) => {
    const id = cleanId(turn.date, key);
    if (doc.items[id] || doc.tombs[id] !== undefined) return;
    ops.push({ op: 'upsert', item: { id, text, section: 'today', done: false, doneAt: null, updatedAt: now, pos: now - i } });
  });
  return ops.map((o) => cleanOp(o, now)).filter(Boolean);
}

const stub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));

export async function cleaningCron(env, now = Date.now()) {
  if (!env.TODO_CODE || !env.TODO_LIST || !env.ROTAS) return { skip: 'not configured' };
  const r = await stub(env).fetch('https://list/export');
  if (!r.ok) throw new Error('todo export ' + r.status);
  const d = await r.json();
  const ops = cleaningOps({ items: d.items || {}, tombs: d.tombs || {} }, env.ROTAS, now);
  if (ops.length) {
    const a = await stub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
    if (!a.ok) throw new Error('todo apply ' + a.status);
  }
  return { cleaning: ops.map((o) => (o.op === 'delete' ? '-' : '+') + o.item.id) };
}
