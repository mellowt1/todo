/* Desk: Paul types one line, Claude prepares, Paul approves.
 *
 * Since 2026-10-19 the line comes from the To-do app's add box (Paul: "if I want to write something
 * in Day, I just pop open To Do and type it in"). Tidy (src/tidy.js) decides a line is a question
 * ("ask") or a message to write ("write"); the app then sends it here and shows the answer and the
 * drafts in a sheet. Morning's own Desk card is gone.
 *
 *   GET  /api/desk/:code           -> { items }   the last 10 lines, newest first
 *   POST /api/desk/:code           <- { text }    -> { item }
 *   POST /api/desk/:code/act       <- { id, idx, action, edit? }  -> { item }
 *        action: "approve" (a task goes into the list), "undo" (it comes out again),
 *        "copied" (a draft was copied), "skip"
 *
 * An item is { id, at, text, answer, actions: [...] }. An action is
 *   { kind: "todo", text, section, state, taskId? }  or
 *   { kind: "draft", to, lang, text, state }
 * and its state is "ready", "approved", "copied" or "skipped".
 *
 * Prepare, then approve (Paul, 2026-10-17): the POST only asks Claude and keeps the answer.
 * Nothing reaches the list until Paul presses Approve, and a draft is never sent; the page
 * copies it. Desk writes to-do tasks and nothing else: never Kitchen, Runway, Feeling or Plan.
 *
 * Claude sees the open to-dos, Parked, the calendar for the next seven days and the hub's
 * events of the last day, all masked (src/mask.js), so it can answer "what is due this week".
 *
 * KV: desk:p:<id> (an item, 14 days), desk:recent (the last 20 ids), desk:usage:YYYY-MM.
 * D1 desk_log: every line and what became of each action. That log is for later: after two
 * weeks it shows where the friction is. Morning does not show it. */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { CODE, ID, SECTIONS, safeEqual, cleanOp, MAX_TEXT } from './todo.js';
import { anthropic, MODEL, randomId, bumpUsage, dayOf } from './intake.js';
import { maskSecrets } from './mask.js';
import { local, CAL_KEY, inWindow, PROJECTS_KEY } from './morning.js';
import { listEvents } from './events.js';
import { noDashes } from './mask.js';
import { keptFor, lessonsText, deskSignal, logFeedback } from './lessons.js';

export const MAX_LINE = 1000;
export const MAX_ACTIONS = 3;
export const KEEP_DAYS = 14;
export const RECENT_KEY = 'desk:recent';
const RECENT_MAX = 20;
const SHOWN = 10;
const DAY = 864e5;
const LANGS = { nl: 'Dutch', en: 'English', es: 'Spanish' };
const STATES = { approve: 'approved', copied: 'copied', skip: 'skipped' };

export const Plan = z.object({
  answer: z.string().max(600).nullable().describe('a short answer when Paul asks a question, from the context only; null when he asks for nothing'),
  actions: z.array(z.object({
    kind: z.enum(['todo', 'draft']),
    text: z.string().max(600).describe('todo: the task, imperative, short, in the language Paul typed it in. draft: the whole message'),
    section: z.enum(['today', 'soon', 'someday']).nullable().describe('todo only'),
    to: z.string().max(40).nullable().describe('draft only: who the message is for'),
    lang: z.enum(['nl', 'en', 'es']).nullable().describe('draft only'),
  })).max(MAX_ACTIONS),
});

/* Frozen per deploy, so it caches. The day's context goes in the user message. */
export const SYSTEM = [
  'You are Desk, a helper inside Paul\'s own apps. Paul typed one line into his to-do app, on his phone or PC, and it was a question for you or a message he wants written. You prepare things for him to approve; you never act yourself.',
  'You can prepare two kinds of action, three at most, and give one short answer:',
  '1. todo: a task for his to-do list. Sections: today (must happen today or tomorrow), soon (this week or two, or has a date), someday (no pressure). A task Paul does for someone else starts with their name, e.g. "Dad: set up the printer".',
  '   Write the task short and imperative, the way Paul would write it himself, in the language he typed. When he gives a date, end the text with " · YYYY-MM-DD".',
  '   Do not add a task that is already open in his list; mention it in the answer instead.',
  '2. draft: a message for Paul to copy and send himself (text, WhatsApp or email). Write as Paul, warm and plain, two to four sentences, in the language he asks for or the language that person is usually written to (Dutch for Dutch services and Dutch friends, Spanish for family when he says so, English otherwise).',
  '   No greeting line on its own, no sign-off name, no emoji, no quotes around it. Never use dashes as punctuation; use commas or full stops.',
  'answer: when Paul asks a question, answer it in one to three short sentences from the context below only. If the context does not hold it, say so plainly. When he only asks for tasks or drafts, answer is null, or one short line when something needs saying (a task that already exists, a clash on the calendar).',
  'Never invent dates, amounts, names or facts that are not in his line or the context. Masked numbers (··1234) stay masked.',
  'Prepare only what he asked for. One line can hold a task and a draft at once. If the line is unclear, give an answer that asks one short question and no actions.',
].join('\n');

/* ---------- The context: read only, masked ---------- */

const stub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function gatherContext(env, now = Date.now()) {
  const part = (p) => p.catch(() => null);
  const [todos, parked, calendar, events] = await Promise.all([
    part((async () => {
      const d = await (await stub(env).fetch('https://list/read')).json();
      return (d.items || []).filter((i) => !i.done).slice(0, 200).map((i) => ({ text: maskSecrets(i.text), section: i.section }));
    })()),
    part((async () => {
      const p = await env.HUB_KV.get(PROJECTS_KEY, 'json');
      if (!p) return [];
      const rows = [...(p.projects || []).filter((x) => x && x.status === 'parked'), ...(p.parked || [])];
      return rows.slice(0, 40).map((x) => ({ name: maskSecrets(String(x.name || x.title || x.text || '')), since: x.since || null }));
    })()),
    part((async () => {
      const doc = await env.HUB_KV.get(CAL_KEY, 'json');
      return doc ? inWindow(doc.events || [], now).slice(0, 60).map((e) => ({ title: e.title, start: e.start, allDay: e.allDay })) : [];
    })()),
    part((async () => (await listEvents(env, now, 1, 50)).map((e) => ({ source: e.source, text: maskSecrets(e.text), at: e.at })))()),
  ]);
  const l = local(now);
  return { today: l.date, weekday: WEEKDAY[l.weekday], time: l.time, todos, parked, calendar, events };
}

/* ---------- The call ---------- */

export async function prepare(env, { text, context }) {
  // Paul's kept rules (src/lessons.js) go in a second block: the first stays cached across weeks.
  const rules = lessonsText(await keptFor(env, 'desk'));
  const system = [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }];
  if (rules) system.push({ type: 'text', text: rules, cache_control: { type: 'ephemeral' } });
  const res = await anthropic(env).beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: `Context (JSON):\n${JSON.stringify(context)}\n\nPaul's line:\n${text}` }],
    output_config: { effort: 'medium', format: zodOutputFormat(Plan) },
    fallbacks: 'default',
    betas: ['server-side-fallback-2026-07-01'],
  });
  const usage = {
    input: res.usage?.input_tokens ?? 0,
    output: res.usage?.output_tokens ?? 0,
    cacheRead: res.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: res.usage?.cache_creation_input_tokens ?? 0,
  };
  if (res.stop_reason === 'refusal') return { error: 'refused', usage };
  if (!res.parsed_output) return { error: 'no answer', usage };
  return { plan: res.parsed_output, usage };
}

let preparer = prepare;
export function _setDesker(fn) { preparer = fn || prepare; }

/* Pure: Claude's plan becomes the item's actions. Anything that would not make a valid
 * task or draft is dropped; an unknown section is soon. */
export function toActions(plan) {
  const out = [];
  for (const a of Array.isArray(plan && plan.actions) ? plan.actions : []) {
    if (out.length >= MAX_ACTIONS) break;
    const text = String((a && a.text) || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (a.kind === 'todo') {
      const section = SECTIONS.includes(a.section) ? a.section : 'soon';
      out.push({ kind: 'todo', text: maskSecrets(text).slice(0, MAX_TEXT), section, state: 'ready' });
    } else if (a.kind === 'draft') {
      out.push({ kind: 'draft', to: String(a.to || '').trim().slice(0, 40) || null, lang: LANGS[a.lang] ? a.lang : 'en', text: noDashes(text).slice(0, 1200), state: 'ready' });
    }
  }
  return out;
}

/* ---------- Storage ---------- */

const itemKey = (id) => 'desk:p:' + id;
const ttl = { expirationTtl: KEEP_DAYS * 24 * 3600 };

async function saveItem(env, item) {
  await env.HUB_KV.put(itemKey(item.id), JSON.stringify(item), ttl);
}

async function remember(env, id) {
  const cur = (await env.HUB_KV.get(RECENT_KEY, 'json')) || [];
  await env.HUB_KV.put(RECENT_KEY, JSON.stringify([id, ...cur.filter((x) => x !== id)].slice(0, RECENT_MAX)));
}

async function recent(env) {
  const ids = ((await env.HUB_KV.get(RECENT_KEY, 'json')) || []).slice(0, SHOWN);
  return (await Promise.all(ids.map((id) => env.HUB_KV.get(itemKey(id), 'json')))).filter(Boolean);
}

/* The friction log. Best effort: a failing log never fails Paul's line. */
async function logItem(env, item) {
  if (!env.HUB_DB) return;
  const kinds = item.actions.map((a) => a.kind).concat(item.answer ? ['answer'] : []).join(',');
  const outcome = JSON.stringify(item.actions.map((a) => a.state));
  await env.HUB_DB.prepare(
    'INSERT INTO desk_log (id, at, text, kinds, outcome, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET outcome = excluded.outcome, updated_at = excluded.updated_at'
  ).bind(item.id, item.at, maskSecrets(item.text), kinds, outcome, new Date().toISOString()).run().catch(() => {});
}

/* ---------- Approving ---------- */

async function apply(env, ops) {
  const r = await stub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error('todo apply ' + r.status);
}

/* Pure: what an edit may change. */
function edited(a, edit) {
  if (!edit || typeof edit !== 'object') return a;
  const out = { ...a };
  if (typeof edit.text === 'string' && edit.text.trim()) out.text = edit.text.replace(/\s+/g, ' ').trim().slice(0, a.kind === 'todo' ? MAX_TEXT : 1200);
  if (a.kind === 'todo') {
    if (SECTIONS.includes(edit.section)) out.section = edit.section;
  }
  return out;
}

export async function act(env, item, idx, action, edit, now = Date.now()) {
  const a = item.actions[idx];
  if (!a) return { error: 'no such action', status: 404 };
  if (action === 'undo') {
    if (a.kind !== 'todo' || a.state !== 'approved' || !a.taskId) return { error: 'nothing to undo', status: 409 };
    await apply(env, [cleanOp({ op: 'delete', item: { id: a.taskId, updatedAt: now } }, now)]);
    item.actions[idx] = { ...a, state: 'ready', taskId: undefined };
    return { item };
  }
  if (!STATES[action]) return { error: 'action: approve, undo, copied or skip', status: 400 };
  if (a.state === 'approved' && action !== 'skip') return { item };
  const next = edited(a, edit);
  if (action === 'approve') {
    if (next.kind !== 'todo') return { error: 'only a task can be approved; a draft is copied', status: 400 };
    const taskId = randomId().slice(0, 14) + 'dk';
    const op = cleanOp({ op: 'upsert', item: { id: taskId, text: next.text, section: next.section, done: false, doneAt: null, updatedAt: now, pos: now } }, now);
    if (!op) return { error: 'that task does not fit the list', status: 400 };
    await apply(env, [op]);
    item.actions[idx] = { ...next, state: 'approved', taskId };
    return { item };
  }
  if (action === 'skip' && a.state === 'approved') return { error: 'undo it first', status: 409 };
  item.actions[idx] = { ...next, state: STATES[action] };
  return { item };
}

/* ---------- The route ---------- */

export async function handleDesk(request, env, rest, json, now = Date.now()) {
  if (!rest.length || !CODE.test(rest[0])) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(rest[0], env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (rest.length > 2 || (rest.length === 2 && rest[1] !== 'act')) return json({ error: 'not found' }, request, 404);

  if (request.method === 'GET' && rest.length === 1) return json({ items: await recent(env) }, request);
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);

  const raw = await request.text();
  if (raw.length > MAX_LINE * 4 + 200) return json({ error: 'too large' }, request, 413);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad json' }, request, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad body' }, request, 400);

  if (rest.length === 2) {
    if (typeof body.id !== 'string' || !ID.test(body.id) || !Number.isInteger(body.idx)) return json({ error: 'id and idx required' }, request, 400);
    const item = await env.HUB_KV.get(itemKey(body.id), 'json');
    if (!item) return json({ error: 'gone' }, request, 404);
    const was = item.actions[body.idx] ? { ...item.actions[body.idx] } : null;
    const out = await act(env, item, body.idx, body.action, body.edit, now);
    if (out.error) return json({ error: out.error }, request, out.status);
    const signal = deskSignal(was, out.item.actions[body.idx], body.action);
    if (signal) await logFeedback(env, { app: 'desk', ...signal, note: item.text }, now);
    await saveItem(env, out.item);
    await logItem(env, out.item);
    return json({ item: out.item }, request);
  }

  const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) return json({ error: 'type something' }, request, 400);
  if (text.length > MAX_LINE) return json({ error: `at most ${MAX_LINE} characters` }, request, 400);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'not configured' }, request, 503);

  const context = await gatherContext(env, now);
  let got;
  try {
    got = await preparer(env, { text, context });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'api key refused' }, request, 502);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'api rate limit, try again in a minute' }, request, 429);
    if (e instanceof Anthropic.APIStatusError) return json({ error: 'api error ' + e.status }, request, 502);
    if (e instanceof Anthropic.APIConnectionError) return json({ error: 'api unreachable' }, request, 502);
    throw e;
  }
  if (got.usage) await bumpUsage(env, dayOf(now).slice(0, 7), got.usage, 'desk').catch(() => {});
  if (got.error) return json({ error: got.error }, request, 502);

  const answer = got.plan.answer ? maskSecrets(noDashes(String(got.plan.answer))).slice(0, 600) : null;
  const item = { id: randomId(), at: new Date(now).toISOString(), text: maskSecrets(text), answer, actions: toActions(got.plan) };
  await saveItem(env, item);
  await remember(env, item.id);
  await logItem(env, item);
  return json({ item }, request);
}
