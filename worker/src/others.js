/* Others: tasks Paul does for other people (To-do's fourth section, each task with a person).
 *
 *   POST /api/others/:code/draft   <- { id, lang: "nl" | "en" | "es" }  -> { text }
 *        A short, friendly message handing the task back to its person, in that language.
 *        It is only a draft: nothing here sends anything. The app offers Copy, and "Mark handed
 *        back" closes the task with that status (the app writes done + handedBack itself).
 *
 * Morning's block (othersBlock): how many are waiting, whether a slot is on now and when the next
 * one starts (hub config others_slots, src/slots.js), and during a slot the list by person.
 * Others tasks never reach Morning's Today, Start with, Gone quiet or a push. */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { CODE, safeEqual, cleanOp } from './todo.js';
import { anthropic, MODEL } from './intake.js';
import { readConfig } from './dinner.js';
import { parseSlots, slotState } from './slots.js';
import { maskSecrets } from './mask.js';

const DAY = 864e5;
const LANGS = { nl: 'Dutch', en: 'English', es: 'Spanish' };
const ID = /^[a-z0-9]{8,32}$/;

const stub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
async function readItems(env) {
  const d = await (await stub(env).fetch('https://list/read')).json();
  if (!Array.isArray(d.items)) throw new Error('no items');
  return d.items;
}

/* Pure: open Others tasks grouped by person, groups by name, newest task first in each. */
export function groupOthers(items, now) {
  const by = new Map();
  for (const i of items) {
    if (i.done || i.section !== 'others') continue;
    const p = i.person || 'Someone';
    if (!by.has(p)) by.set(p, []);
    by.get(p).push({ id: i.id, text: maskSecrets(i.text), days: Math.max(0, Math.floor((now - i.pos) / DAY)) });
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'en', { sensitivity: 'base' }))
    .map(([person, list]) => ({ person, tasks: list.sort((a, b) => a.days - b.days) }));
}

/* Morning: { waiting, inSlot, next, groups (during a slot only), slots } */
export async function othersBlock(env, now, l) {
  const [items, cfg] = await Promise.all([readItems(env), env.HUB_DB ? readConfig(env, ['others_slots']) : { others_slots: null }]);
  const groups = groupOthers(items, now);
  const waiting = groups.reduce((n, g) => n + g.tasks.length, 0);
  const slots = parseSlots(cfg.others_slots);
  const state = slotState(slots, l);
  return { waiting, slots: !!slots, inSlot: state.inSlot, next: state.next, groups: state.inSlot ? groups : null };
}

/* ---------- Moving tasks Paul confirmed into Others ----------
 * Claude Code suggests which open tasks are for someone else; Paul confirms each one; the
 * confirmed list is written to KV others:assign through wrangler ([{ id, person }]). The cron
 * moves exactly those (open ones only) into Others with their person, then deletes the key and
 * keeps what it did in others:assign:done. Nothing moves without that list. */
export const ASSIGN_KEY = 'others:assign';
export async function othersAssign(env, now = Date.now()) {
  if (!env.TODO_CODE || !env.HUB_KV) return { skip: 'not configured' };
  const raw = await env.HUB_KV.get(ASSIGN_KEY);
  if (!raw) return { skip: 'nothing to move' };
  let list;
  try { list = JSON.parse(raw); } catch (e) { list = null; }
  if (!Array.isArray(list)) { await env.HUB_KV.delete(ASSIGN_KEY); return { skip: 'bad list' }; }
  const doc = await (await stub(env).fetch('https://list/export')).json();
  const ops = [];
  const done = [];
  for (const a of list.slice(0, 100)) {
    const it = a && typeof a.id === 'string' ? doc.items[a.id] : null;
    const op = it && !it.done ? cleanOp({ op: 'upsert', item: { ...it, section: 'others', person: a.person, pos: now, updatedAt: Math.max(now, it.updatedAt + 1) } }, now) : null;
    if (op && op.item.person) { ops.push(op); done.push({ id: a.id, person: op.item.person }); }
  }
  if (ops.length) {
    const r = await stub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error('todo apply ' + r.status);
  }
  await env.HUB_KV.put(ASSIGN_KEY + ':done', JSON.stringify({ at: new Date(now).toISOString(), moved: done, asked: list.length }));
  await env.HUB_KV.delete(ASSIGN_KEY);
  return { moved: done.length };
}

/* ---------- The draft ---------- */

const SYSTEM = 'You draft a short, friendly message from Paul handing a small task back to the person it belongs to. ' +
  'Paul helps family and friends with errands; this time he cannot do it, or it is better done by them. ' +
  'Write in the language asked for, as Paul himself, to that person by name (Mom, Dad, Grandpa become the natural word in that language: mam, pap, opa; mamá, papá, abuelo). ' +
  'Two or three sentences, warm and plain, no excuses piled up, no apology spiral, offer help another time. ' +
  'Never use dashes as punctuation (no hyphen, en dash or em dash between words or clauses); use commas or full stops. ' +
  'No greeting line on its own, no sign-off name, no emoji, no quotes around the message.';
const Draft = z.object({ message: z.string().max(600) });

/* Pure: dashes used as punctuation become commas; hyphens inside words stay. */
export function noDashes(s) {
  return String(s)
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/\s+-\s+/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function writeDraft(env, { text, person, lang }) {
  const res = await anthropic(env).beta.messages.parse({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    messages: [{ role: 'user', content: `Language: ${LANGS[lang]}\nTo: ${person}\nThe task Paul is handing back: ${text}` }],
    output_config: { effort: 'low', format: zodOutputFormat(Draft) },
    fallbacks: 'default',
    betas: ['server-side-fallback-2026-07-01'],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return null;
  return noDashes(res.parsed_output.message) || null;
}

let writer = writeDraft;
export function _setDrafter(fn) { writer = fn || writeDraft; }

export async function handleOthers(request, env, rest, json) {
  if (rest.length !== 2 || rest[1] !== 'draft') return json({ error: 'not found' }, request, 404);
  if (!CODE.test(rest[0])) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(rest[0], env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'not configured' }, request, 503);
  const raw = await request.text();
  if (raw.length > 1000) return json({ error: 'too large' }, request, 413);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad json' }, request, 400); }
  if (!body || typeof body.id !== 'string' || !ID.test(body.id)) return json({ error: 'id required' }, request, 400);
  if (!LANGS[body.lang]) return json({ error: 'lang: nl, en or es' }, request, 400);
  const it = (await readItems(env)).find((i) => i.id === body.id);
  if (!it || it.done || it.section !== 'others' || !it.person) return json({ error: 'not an open Others task' }, request, 404);
  let text;
  try {
    text = await writer(env, { text: maskSecrets(it.text.replace(/\s*\[intake\]$/, '')), person: it.person, lang: body.lang });
  } catch (e) {
    return json({ error: 'could not write a draft' }, request, 502);
  }
  if (!text) return json({ error: 'could not write a draft' }, request, 502);
  return json({ text }, request);
}
