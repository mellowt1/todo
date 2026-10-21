/* The Energy dial (Paul, 2026-10-21): three buttons, wired, normal and drained, in To-do, Morning
 * and Day. The hub holds the level; every app reads it from here.
 *
 *   GET  /api/energy/:code              ?pick=1   -> { level, setAt, until, source, pick? }
 *   POST /api/energy/:code              <- { level: "wired" | "normal" | "drained" | null, source }
 *                                       -> the same as GET with a pick
 *   POST /api/energy/:code/pick         <- { mode: "next" | "surprise", skip: [taskId], current?, skipped?, source }
 *                                       -> { level, ..., pick: { task, count, left, position } }
 *   POST /api/energy/:code/suggest      -> { guessed }   the one-off guess for old tasks (Claude Haiku)
 *   GET/POST /api/hub/energy/day[/pick] the same for Day, Bearer HUB_SECRET_DAY, source "day"
 *
 * `source` is "todo" or "morning" on the code routes. Setting the dial is a typed hub event,
 * `energy.set` (payload { level }) or `energy.cleared`, stored once in D1 `events` through
 * acceptEvent like every other event, but kept out of Morning's Lately feed. There is no other
 * copy: the level now is the newest of those events when it is younger than HOURS, and the
 * history (the Sunday grid) is the same rows. "Not this one" stores `energy.skipped`
 * (payload { task, level }), which the Dread meter will count later.
 *
 * Give me one picks only open tasks whose level Paul confirmed (`energy` on the task, src/todo.js;
 * a guess never counts): Today first, then Soon, never Someday. Inside that: overdue and dated
 * tasks by date, then undated ones newest first; tasks for someone else ("Nick: ...") last.
 * Paul's answers, 2026-10-21. */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { CODE, ENERGY, safeEqual, bearer, cleanOp } from './todo.js';
import { acceptEvent } from './hub.js';
import { DUE_END } from './tidy.js';
import { maskSecrets } from './mask.js';
import { local, zoned, addDays } from './morning.js';
import { anthropic, bumpUsage, dayOf } from './intake.js';

export const HOURS = 4; // a level stays on this long (Paul, 2026-10-21)
export const POOL = ['today', 'soon']; // in this order; Someday is never picked
export const PARTS = [['morning', '00:00', '12:00'], ['afternoon', '12:00', '18:00'], ['evening', '18:00', null]]; // the Sunday grid
const CODE_SOURCES = ['todo', 'morning'];
const ID = /^[a-z0-9]{8,32}$/;
const INTAKE_MARK = /\s*\[intake\]$/;
const HOUR = 3600000;

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');

/* ---------- The level ---------- */

/* Pure: the newest dial event -> the level now. */
export function stateFrom(row, now) {
  const none = { level: null, setAt: null, until: null, source: null };
  if (!row || row.type !== 'energy.set') return none;
  let level = null;
  try { level = JSON.parse(row.payload).level; } catch (e) { /* stays null */ }
  const at = Date.parse(row.at);
  if (!ENERGY.includes(level) || !Number.isFinite(at) || now >= at + HOURS * HOUR) return none;
  return { level, setAt: row.at, until: new Date(at + HOURS * HOUR).toISOString(), source: row.source };
}

export async function energyNow(env, now = Date.now()) {
  const row = await env.HUB_DB.prepare("SELECT type, source, payload, at FROM events WHERE type IN ('energy.set', 'energy.cleared') ORDER BY at DESC LIMIT 1").first();
  return stateFrom(row, now);
}

/* The dial was tapped: one event. A null level clears it. */
export async function setEnergy(env, level, source, now = Date.now()) {
  const ev = {
    id: 'energy-' + now + '-' + rand(), source, type: level ? 'energy.set' : 'energy.cleared',
    summary: level ? 'Energy ' + level : 'Energy cleared', payload: level ? { level } : {},
    caused_by: null, hops: 0, at: new Date(now).toISOString(),
  };
  await acceptEvent(env, ev, { feed: false });
  return stateFrom({ type: ev.type, source, payload: JSON.stringify(ev.payload), at: ev.at }, now);
}

async function recordSkip(env, task, level, source, now) {
  await acceptEvent(env, {
    id: 'energy-skip-' + now + '-' + rand(), source, type: 'energy.skipped', summary: 'Not this one',
    payload: { task, level }, caused_by: null, hops: 0, at: new Date(now).toISOString(),
  }, { feed: false });
}

/* ---------- Give me one ---------- */

const PERSON = /^\p{Lu}[\p{L}'-]{1,23}: /u;
const NOT_A_PERSON = new Set(['Apply', 'Choose', 'Pay', 'Note', 'Read', 'Call', 'Sollicitatie']);

/* Pure: a task done for someone else. The Others lane once it exists, else "Nick: ..." text. */
export function forSomeoneElse(it) {
  if (it.section === 'others') return true;
  const m = typeof it.text === 'string' && it.text.match(PERSON);
  return !!m && !NOT_A_PERSON.has(m[0].slice(0, -2));
}

/* Pure: the name without its date ending or [intake] mark, and the date. */
export function nameAndDue(text) {
  const t = String(text || '').replace(INTAKE_MARK, '');
  const m = t.match(DUE_END);
  if (!m) return { name: t, due: null, time: null };
  return { name: t.slice(0, m.index).trim(), due: m[1], time: m[2] ? m[2] + ':' + m[3] : null };
}

/* Pure: every task that fits the level, best first. */
export function pickPool(items, level) {
  const rows = [];
  for (const it of Object.values(items || {})) {
    if (!it || it.done || it.energy !== level || !POOL.includes(it.section)) continue;
    rows.push({ it, others: forSomeoneElse(it) ? 1 : 0, sec: POOL.indexOf(it.section), due: nameAndDue(it.text) });
  }
  rows.sort((a, b) => a.others - b.others || a.sec - b.sec
    || (a.due.due ? 0 : 1) - (b.due.due ? 0 : 1)
    || (a.due.due && b.due.due ? (a.due.due + (a.due.time || '')).localeCompare(b.due.due + (b.due.time || '')) : 0)
    || (b.it.pos || 0) - (a.it.pos || 0));
  return rows;
}

/* Pure: one pick. `skip` holds the tasks already turned down this round; `current` is the one on
 * screen, which Surprise me never shows again straight away. */
export function pickTask(items, level, { skip = [], current = null, mode = 'next', random = Math.random } = {}) {
  if (!ENERGY.includes(level)) return { task: null, count: 0, left: 0, position: 0 };
  const pool = pickPool(items, level);
  const left = pool.filter((r) => !skip.includes(r.it.id));
  let row = left[0] || null;
  if (mode === 'surprise' && left.length > 1) {
    const others = left.filter((r) => r.it.id !== current);
    row = others[Math.floor(random() * others.length)] || left[0];
  }
  const task = row ? {
    id: row.it.id, name: maskSecrets(row.due.name), section: row.it.section, due: row.due.due, time: row.due.time,
  } : null;
  return { task, count: pool.length, left: left.length, position: pool.length - left.length + 1 };
}

const listStub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
async function readItems(env) {
  const d = await (await listStub(env).fetch('https://list/export')).json();
  return d.items || {};
}

/* ---------- The one-off guess for old tasks (Paul chose Haiku, once, 2026-10-21) ---------- */

export const SUGGEST_MODEL = 'claude-haiku-5-5';
export const SUGGEST_MAX = 80;
const SUGGESTED_KEY = 'energy:suggested'; // the day it last ran: at most once a day

export const SUGGEST_SYSTEM = [
  'Paul sorts his open to-do tasks by the energy each one takes. For every task give one level:',
  '"wired": needs real focus or drive (building something, writing, applying for a job, a hard conversation, planning, anything long or new).',
  '"normal": an ordinary task with some thinking (a meeting, booking, sorting out an account, a call that needs preparing).',
  '"drained": small and easy, fine on a tired evening (buy, text, return, look up one thing, a quick reply, tidy one thing).',
  'When unsure between two, pick the lower one. Tasks may be in English, Dutch or Spanish. Answer for every id you are given, with that id exactly.',
].join('\n');

const Guesses = z.object({ tasks: z.array(z.object({ id: z.string(), energy: z.enum(ENERGY) })) });

/* Pure: the tasks to guess for: open, no level, no guess yet. */
export function needsGuess(items) {
  return Object.values(items || {}).filter((it) => it && !it.done && !it.energy && !it.energyGuess).slice(0, SUGGEST_MAX);
}

export async function guessLevels(env, tasks) {
  const lines = tasks.map((t) => t.id + ' | ' + maskSecrets(nameAndDue(t.text).name)).join('\n');
  const res = await anthropic(env).messages.parse({
    model: SUGGEST_MODEL,
    max_tokens: 4000,
    system: SUGGEST_SYSTEM,
    messages: [{ role: 'user', content: 'The tasks, one per line, id | task:\n' + lines }],
    output_config: { effort: 'low', format: zodOutputFormat(Guesses) },
  });
  const usage = {
    input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0,
    cacheRead: res.usage?.cache_read_input_tokens ?? 0, cacheWrite: res.usage?.cache_creation_input_tokens ?? 0,
  };
  return { out: res.stop_reason === 'refusal' ? null : res.parsed_output, usage };
}

let guesser = guessLevels;
export function _setGuesser(fn) { guesser = fn || guessLevels; }

/* Writes energyGuess on each task, never `energy`: Paul confirms every one himself. */
export async function suggestLevels(env, now = Date.now()) {
  const today = dayOf(now);
  if ((await env.HUB_KV.get(SUGGESTED_KEY)) === today) return { guessed: 0, already: true };
  const items = await readItems(env);
  const todo = needsGuess(items);
  if (!todo.length) return { guessed: 0 };
  await env.HUB_KV.put(SUGGESTED_KEY, today); // reserved before the call: a failure waits a day
  const got = await guesser(env, todo);
  if (got.usage) await bumpUsage(env, today.slice(0, 7), got.usage, 'energy').catch(() => {});
  const ops = [];
  for (const g of (got.out && got.out.tasks) || []) {
    const it = items[g.id];
    if (!it || it.done || it.energy || it.energyGuess || !ENERGY.includes(g.energy)) continue;
    const at = Math.max(now, (it.updatedAt || 0) + 1);
    const op = cleanOp({ op: 'upsert', item: { ...it, energyGuess: g.energy, updatedAt: at } }, at);
    if (op) ops.push(op);
  }
  if (ops.length) {
    const r = await listStub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error('todo apply ' + r.status);
  }
  return { guessed: ops.length };
}

/* ---------- The Sunday grid ---------- */

/* Pure: the dial's events (oldest first, the newest one before Monday included) -> for each day
 * of the week and each part of it, the level Paul was at for most of that part, or null. */
export function energyWeek(rows, monday, now) {
  const spans = [];
  rows.forEach((r, i) => {
    if (r.type !== 'energy.set') return;
    let level = null;
    try { level = JSON.parse(r.payload).level; } catch (e) { return; }
    if (!ENERGY.includes(level)) return;
    const from = Date.parse(r.at);
    const next = rows[i + 1] ? Date.parse(rows[i + 1].at) : Infinity;
    spans.push({ level, from, to: Math.min(from + HOURS * HOUR, next, now) });
  });
  const start = zoned(monday);
  const end = zoned(addDays(monday, 7));
  const byPart = PARTS.map(() => ({ wired: 0, normal: 0, drained: 0 }));
  const days = [];
  for (let d = 0; d < 7; d++) {
    const date = addDays(monday, d);
    const parts = PARTS.map(([, a, b], p) => {
      const lo = zoned(date, a);
      const hi = b ? zoned(date, b) : zoned(addDays(date, 1));
      const h = { wired: 0, normal: 0, drained: 0 };
      for (const s of spans) {
        const o = Math.min(hi, s.to) - Math.max(lo, s.from);
        if (o > 0) { h[s.level] += o; byPart[p][s.level] += o; }
      }
      const best = ENERGY.reduce((x, k) => (h[k] > h[x] ? k : x), 'wired');
      return h[best] > 0 ? best : null;
    });
    days.push({ date, parts });
  }
  const most = {};
  for (const k of ENERGY) {
    let p = -1;
    byPart.forEach((h, i) => { if (h[k] > 0 && (p < 0 || h[k] > byPart[p][k])) p = i; });
    most[k] = p < 0 ? null : PARTS[p][0];
  }
  const sets = rows.filter((r) => r.type === 'energy.set' && Date.parse(r.at) >= start && Date.parse(r.at) < end).length;
  return { parts: PARTS.map((p) => p[0]), days, sets, most };
}

export async function energyFor(env, monday, now = Date.now()) {
  if (!env.HUB_DB) return null;
  const from = new Date(zoned(monday)).toISOString();
  const to = new Date(zoned(addDays(monday, 7))).toISOString();
  const [before, during] = await Promise.all([
    env.HUB_DB.prepare("SELECT type, payload, at FROM events WHERE type IN ('energy.set', 'energy.cleared') AND at < ? ORDER BY at DESC LIMIT 1").bind(from).first(),
    env.HUB_DB.prepare("SELECT type, payload, at FROM events WHERE type IN ('energy.set', 'energy.cleared') AND at >= ? AND at < ? ORDER BY at").bind(from, to).all().then((r) => r.results || []),
  ]);
  return energyWeek(before ? [before, ...during] : during, monday, now);
}

/* ---------- Routes ---------- */

async function withPick(env, state, opts) {
  if (!state.level || !env.TODO_CODE) return { ...state, pick: null };
  return { ...state, pick: pickTask(await readItems(env), state.level, opts) };
}

async function readJson(request, max = 4000) {
  const raw = await request.text();
  if (raw.length > max) return { status: 413, error: 'too large' };
  try { return { body: raw ? JSON.parse(raw) : {} }; } catch (e) { return { status: 400, error: 'bad json' }; }
}

/* Shared by the code routes and Day's. `sub` is what follows the code (or "day"). */
async function energyRoute(request, env, sub, source, json, now) {
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  if (sub.length === 0 && request.method === 'GET') {
    const state = await energyNow(env, now);
    const want = new URL(request.url).searchParams.get('pick') === '1';
    return json(want ? await withPick(env, state, {}) : state, request);
  }
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const got = await readJson(request);
  if (got.error) return json({ error: got.error }, request, got.status);
  const b = got.body && typeof got.body === 'object' ? got.body : {};
  const src = source || (CODE_SOURCES.includes(b.source) ? b.source : null);

  if (sub.length === 0) {
    if (!src) return json({ error: 'source: todo or morning' }, request, 400);
    if (b.level !== null && !ENERGY.includes(b.level)) return json({ error: 'level: wired, normal, drained or null' }, request, 400);
    return json(await withPick(env, await setEnergy(env, b.level, src, now), {}), request);
  }
  if (sub.length === 1 && sub[0] === 'pick') {
    if (!src) return json({ error: 'source: todo or morning' }, request, 400);
    const skip = Array.isArray(b.skip) ? b.skip.filter((s) => typeof s === 'string' && ID.test(s)).slice(0, 200) : [];
    const current = typeof b.current === 'string' && ID.test(b.current) ? b.current : null;
    const state = await energyNow(env, now);
    if (state.level && typeof b.skipped === 'string' && ID.test(b.skipped)) await recordSkip(env, b.skipped, state.level, src, now);
    return json(await withPick(env, state, { skip, current, mode: b.mode === 'surprise' ? 'surprise' : 'next' }), request);
  }
  if (sub.length === 1 && sub[0] === 'suggest' && !source) {
    if (!env.ANTHROPIC_API_KEY || !env.TODO_CODE) return json({ error: 'not configured' }, request, 503);
    try {
      return json(await suggestLevels(env, now), request);
    } catch (e) {
      return json({ error: 'could not guess' }, request, 502);
    }
  }
  return json({ error: 'not found' }, request, 404);
}

export async function handleEnergy(request, env, rest, json, now = Date.now()) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  return energyRoute(request, env, rest.slice(1), null, json, now);
}

/* /api/hub/energy/day[/pick]: Day on the Mac, through the Odysseus backend. */
export async function handleEnergyDay(request, env, sub, json, now = Date.now()) {
  if (!env.HUB_SECRET_DAY || !safeEqual(bearer(request), env.HUB_SECRET_DAY)) return json({ error: 'unauthorized' }, request, 401);
  return energyRoute(request, env, sub, 'day', json, now);
}
