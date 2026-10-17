/* Retiring the Others section (Paul, 2026-10-17: "not happy" with it, chose to remove it).
 *
 * The list is back to Today, Soon and Someday. Tasks still filed under Others, open or done,
 * move to Soon once, with the person's name in front ("Dad: set up the printer"), so nothing is
 * lost and the Done history stays readable. Runs from the cron until it has run once
 * (KV others:retired:v1 keeps what it moved). */

import { cleanOp, MAX_TEXT } from './todo.js';

export const RETIRED_KEY = 'others:retired:v1';

/* Pure: one stored Others task -> its upsert into Soon, or null. */
export function retiredOp(it, now) {
  if (!it || it.section !== 'others') return null;
  const person = typeof it.person === 'string' ? it.person.trim() : '';
  const named = person && !it.text.toLowerCase().startsWith(person.toLowerCase() + ':') ? `${person}: ${it.text}` : it.text;
  return cleanOp({ op: 'upsert', item: {
    id: it.id, text: named.slice(0, MAX_TEXT), section: 'soon', done: it.done === true, doneAt: it.done ? it.doneAt : null,
    updatedAt: Math.max(now, (it.updatedAt || 0) + 1), pos: it.pos, ...(it.link ? { link: it.link } : {}),
  } }, now);
}

export async function retireOthers(env, now = Date.now()) {
  if (!env.TODO_CODE || !env.HUB_KV) return { skip: 'not configured' };
  if (await env.HUB_KV.get(RETIRED_KEY)) return { skip: 'done' };
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
  const doc = await (await stub.fetch('https://list/export')).json();
  const ops = Object.values(doc.items || {}).map((it) => retiredOp(it, now)).filter(Boolean);
  if (ops.length) {
    const r = await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error('todo apply ' + r.status);
  }
  await env.HUB_KV.put(RETIRED_KEY, JSON.stringify({ at: new Date(now).toISOString(), moved: ops.map((o) => o.item.id) }));
  return { moved: ops.length };
}
