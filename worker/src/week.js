/* Sunday reset: Morning's Week view and the Sunday push.
 *
 * Read only from what the hub already holds: the to-do list (its Durable Object), the hub's
 * event log (D1 events, for the defence digest's vacancies) and Day's calendar push (HUB_KV
 * morning:calendar). Four sections, each may be empty:
 *
 *   done       tasks ticked off since Monday 00:00 (Amsterdam), grouped by section
 *   quiet      open tasks untouched for 14 days or more, oldest first, minus those given a new date
 *   vacancies  tasks the digest-vacancy-todo rule made this week, with their link and state
 *   next       Day's events from next Monday to next Sunday, titles and times only
 *   paragraph  three sentences Claude writes once each Sunday from the sections above and Desk's
 *              log (src/desk.js): what got done, what slipped, one suggestion. Read only; null
 *              until the first cron run after 06:00 on Sunday has written it (KV week:paragraph:<monday>).
 *   mirror     the Mirror's card (src/mirror.js): one finding from Paul's days, this week's
 *              experiment and how last week's went; null until written on Sunday.
 *
 *   GET  /api/morning/:code             -> { ..., week }   on Sundays, or with ?week=1; else week is null
 *   POST /api/morning/:code/week        <- { id, action }  -> { ok, week, until? }
 *        action: "soon"     Do this week: to the top of Soon (writes the task, so its clock restarts)
 *                "later1" | "later2" | "later4"   New date: back in Today 1, 2 or 4 weeks after the
 *                           coming Monday (on Sunday 18 Oct: 26 Oct, 2 Nov, 16 Nov); the task is not written
 *                "delete"   deletes the task (the page has asked once)
 *                "undo"     takes back the last soon or later on this task
 *
 * The cron (every 15 minutes, weekCron) moves tasks whose date has come into Today, tidies
 * week_marks, and on Sunday sends one ntfy push at sunday_reset_time, never inside quiet_hours
 * (config table, src/dinner.js). A push held by quiet hours goes when they end, if it is still
 * Sunday; otherwise that week has none. The push carries no link: an ntfy.sh topic is readable
 * by anyone who knows its name, and Morning's link holds the list code. */

import { local, zoned, addDays, eventSpan, CAL_KEY } from './morning.js';
import { ID, SECTIONS, cleanOp, cleanLink } from './todo.js';
import { todoTaskId, vacancyTask } from './hub.js';
import { readConfig } from './dinner.js';
import { maskSecrets } from './mask.js';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { anthropic, MODEL } from './intake.js';
import { noDashes } from './mask.js';
import { mirrorFor } from './mirror.js';
import { grantWeek } from './hiscores.js';

const DAY = 24 * 3600 * 1000;
export const QUIET_DAYS = 14;
const MAX_DONE = 200;
const MAX_QUIET = 100;
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const PUSHED_KEY = 'week:pushed';
const LATER = { later1: 1, later2: 2, later4: 4 };

/* ---------- Dates ---------- */

/* Monday of the week holding `date` (weeks run Monday to Sunday). */
export function mondayOf(date) {
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  return addDays(date, -((wd + 6) % 7));
}

/* ISO 8601 week number of a 'YYYY-MM-DD'. */
export function isoWeek(date) {
  const t = Date.parse(date + 'T00:00:00Z');
  const wd = (new Date(t).getUTCDay() + 6) % 7;
  const thu = t + (3 - wd) * DAY;
  const jan1 = Date.UTC(new Date(thu).getUTCFullYear(), 0, 1);
  return Math.floor((thu - jan1) / DAY / 7) + 1;
}

/* The Monday n weeks ahead of `today`'s week: n = 1 is the coming Monday. */
export const mondayAhead = (today, n) => addDays(mondayOf(today), 7 * n);

const toMin = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

/* Pure: is `minutes` (since local midnight) inside "HH:MM-HH:MM"? A window may cross midnight. */
export function inQuiet(minutes, window) {
  if (!window) return false;
  const [a, b] = window.split('-').map(toMin);
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

/* ---------- The sections (pure) ---------- */

/* The time a task last moved. A task put back by Undo keeps its old quiet clock. */
export function touchedAt(item, mark) {
  if (mark && mark.kind === 'restored' && item.updatedAt === mark.at) {
    try {
      const prev = JSON.parse(mark.prev);
      if (prev && Number.isFinite(prev.updatedAt)) return prev.updatedAt;
    } catch (e) { /* a broken mark counts for nothing */ }
  }
  return item.updatedAt;
}

export function doneSection(items, from) {
  const done = items.filter((i) => i.done && Number.isFinite(i.doneAt) && i.doneAt >= from).sort((a, b) => b.doneAt - a.doneAt);
  const groups = SECTIONS.map((section) => ({
    section,
    items: done.filter((i) => i.section === section).slice(0, MAX_DONE).map((i) => ({ text: i.text, day: SHORT[local(i.doneAt).weekday] })),
  })).filter((g) => g.items.length);
  return { count: done.length, groups };
}

export function quietSection(items, marks, now) {
  const out = [];
  for (const i of items) {
    if (i.done) continue;
    const m = marks.get(i.id);
    if (m && m.kind === 'snooze') continue;
    const days = Math.floor((now - touchedAt(i, m)) / DAY);
    if (days >= QUIET_DAYS) out.push({ id: i.id, text: i.text, section: i.section, days, ...(i.link ? { link: i.link } : {}) });
  }
  return out.sort((a, b) => b.days - a.days).slice(0, MAX_QUIET);
}

/* rows: D1 events (id, payload, at); ids: event id -> task id. */
export function vacancySection(rows, ids, doc, now) {
  const out = [];
  for (const r of rows) {
    const id = ids.get(r.id);
    const item = doc.items[id];
    const gone = !item && doc.tombs[id] !== undefined;
    if (!item && !gone) continue; // the rule made no task (no title, or it was there already)
    let p = {};
    try { p = JSON.parse(r.payload) || {}; } catch (e) { /* no payload, no fallback text */ }
    const made = vacancyTask(p, id, now);
    const text = item ? item.text : made.op ? made.op.item.text : '';
    if (!text) continue;
    out.push({ id, text, link: (item && item.link) || cleanLink(p.link) || null, state: item ? (item.done ? 'done' : 'open') : 'deleted' });
  }
  return out;
}

/* Day's events between Monday 00:00 and the next Monday 00:00 (ms), first day each one shows. */
export function nextSection(events, from, to) {
  const out = [];
  for (const e of events) {
    const [s, en] = eventSpan(e);
    const hit = en > s ? s < to && en > from : s >= from && s < to;
    if (!hit) continue;
    const at = Math.max(s, from);
    const l = local(at);
    out.push({ date: l.date, day: SHORT[l.weekday], time: e.allDay ? 'all day' : l.time, title: e.title, sort: l.date + (e.allDay ? ' ' : l.time) });
  }
  return out.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0)).map(({ sort, ...e }) => e);
}

/* ---------- Reading ---------- */

const stub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
async function exportList(env) {
  const r = await stub(env).fetch('https://list/export');
  if (!r.ok) throw new Error('todo export ' + r.status);
  const d = await r.json();
  return { items: d.items || {}, tombs: d.tombs || {} };
}
async function applyOp(env, op) {
  const r = await stub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [op] }), headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error('todo apply ' + r.status);
}
async function readMarks(env) {
  const { results } = await env.HUB_DB.prepare('SELECT task_id, kind, until, prev, at FROM week_marks').all();
  return new Map((results || []).map((m) => [m.task_id, m]));
}

export async function weekBlock(env, now = Date.now()) {
  if (!env.TODO_CODE) throw new Error('TODO_CODE missing');
  const today = local(now).date;
  const monday = mondayOf(today);
  const nextMon = addDays(monday, 7);
  const [doc, marks, vac, cal, para, mirror] = await Promise.all([
    exportList(env),
    env.HUB_DB ? readMarks(env) : new Map(),
    env.HUB_DB
      ? env.HUB_DB.prepare("SELECT id, payload, at FROM events WHERE source = 'defence-digest' AND type = 'vacancy.found' AND at >= ? ORDER BY at")
        .bind(new Date(zoned(monday)).toISOString()).all().then((r) => r.results || [])
      : [],
    env.HUB_KV.get(CAL_KEY, 'json'),
    env.HUB_KV.get(PARA_PREFIX + monday, 'json'),
    mirrorFor(env, monday),
  ]);
  const items = Object.values(doc.items);
  const ids = new Map(await Promise.all(vac.map(async (r) => [r.id, await todoTaskId(r.id)])));
  const received = cal ? Date.parse(cal.received) : NaN;
  return {
    week: isoWeek(today),
    from: monday,
    to: addDays(monday, 6),
    done: doneSection(items, zoned(monday)),
    quiet: quietSection(items, marks, now),
    vacancies: vacancySection(vac, ids, doc, now),
    next: {
      from: nextMon,
      to: addDays(nextMon, 6),
      events: cal ? nextSection(cal.events || [], zoned(nextMon), zoned(addDays(nextMon, 7))) : [],
      sent: cal ? cal.sent : null,
      stale: !Number.isFinite(received) || now - received > 3600000,
    },
    paragraph: para && typeof para.text === 'string' ? para.text : null,
    mirror,
  };
}

/* Morning's block: Sundays only, unless the page asks (?week=1, for checks). */
export async function weekForMorning(env, now, request) {
  const ask = request && new URL(request.url).searchParams.get('week') === '1';
  if (local(now).weekday !== 0 && !ask) return null;
  return weekBlock(env, now);
}

/* ---------- The buttons ---------- */

export async function actOnWeek(env, body, now = Date.now()) {
  if (!body || typeof body !== 'object' || typeof body.id !== 'string' || !ID.test(body.id)) return { status: 400, error: 'id required' };
  const action = body.action;
  if (!['soon', 'delete', 'undo', ...Object.keys(LATER)].includes(action)) return { status: 400, error: 'action must be soon, later1, later2, later4, delete or undo' };
  if (!env.TODO_CODE || !env.HUB_DB) return { status: 503, error: 'not configured' };
  const id = body.id;
  const db = env.HUB_DB;
  const doc = await exportList(env);
  const item = doc.items[id];
  const mark = await db.prepare('SELECT task_id, kind, until, prev, at FROM week_marks WHERE task_id = ?').bind(id).first();
  const out = {};

  if (action === 'undo') {
    if (!mark || mark.kind === 'restored') return { status: 404, error: 'nothing to undo' };
    if (mark.kind === 'snooze') {
      await db.prepare('DELETE FROM week_marks WHERE task_id = ?').bind(id).run();
    } else {
      const prev = JSON.parse(mark.prev);
      // Put it back only if nothing else moved it since; otherwise the newer change stands.
      if (item && item.updatedAt === mark.at) {
        const op = cleanOp({ op: 'upsert', item: { ...prev, updatedAt: now } }, now);
        if (!op) return { status: 500, error: 'cannot put it back' };
        await applyOp(env, op);
        await db.prepare("UPDATE week_marks SET kind = 'restored', at = ? WHERE task_id = ?").bind(now, id).run();
      } else {
        await db.prepare('DELETE FROM week_marks WHERE task_id = ?').bind(id).run();
      }
    }
  } else if (action === 'delete') {
    if (item) await applyOp(env, { op: 'delete', item: { id, updatedAt: Math.max(now, item.updatedAt + 1) } });
    await db.prepare('DELETE FROM week_marks WHERE task_id = ?').bind(id).run();
  } else {
    if (!item || item.done) return { status: 404, error: 'that task is gone or done' };
    if (action === 'soon') {
      const at = Math.max(now, item.updatedAt + 1);
      const op = cleanOp({ op: 'upsert', item: { ...item, section: 'soon', pos: at, updatedAt: at } }, now);
      if (!op) return { status: 500, error: 'cannot move it' };
      await applyOp(env, op);
      await db.prepare("INSERT INTO week_marks (task_id, kind, until, prev, at) VALUES (?, 'moved', NULL, ?, ?) ON CONFLICT(task_id) DO UPDATE SET kind = 'moved', until = NULL, prev = excluded.prev, at = excluded.at")
        .bind(id, JSON.stringify(item), at).run();
    } else {
      out.until = addDays(mondayAhead(local(now).date, 1), 7 * LATER[action]);
      await db.prepare("INSERT INTO week_marks (task_id, kind, until, prev, at) VALUES (?, 'snooze', ?, NULL, ?) ON CONFLICT(task_id) DO UPDATE SET kind = 'snooze', until = excluded.until, prev = NULL, at = excluded.at")
        .bind(id, out.until, now).run();
    }
  }
  if (action !== 'undo') {
    try { await grantWeek(env, id, action, item && item.text, now); } catch (e) { /* XP never blocks the button */ }
  }
  return { ...out, week: await weekBlock(env, now) };
}

export async function handleWeek(request, env, json, now = Date.now()) {
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const text = await request.text();
  if (text.length > 1000) return json({ error: 'too large' }, request, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, request, 400); }
  const out = await actOnWeek(env, body, now);
  if (out.error) return json({ error: out.error }, request, out.status);
  return json({ ok: true, ...out }, request);
}

/* ---------- The cron ---------- */

/* Tasks whose new date has come go into Today; old marks are tidied. */
export async function wakeSnoozes(env, now = Date.now()) {
  if (!env.TODO_CODE || !env.HUB_DB) return { woke: 0 };
  const marks = [...(await readMarks(env)).values()];
  if (!marks.length) return { woke: 0 };
  const today = local(now).date;
  const doc = await exportList(env);
  const drop = [];
  let woke = 0;
  for (const m of marks) {
    const item = doc.items[m.task_id];
    if (m.kind === 'snooze') {
      if (!item || item.done) { drop.push(m.task_id); continue; }
      if (m.until > today) continue;
      const at = Math.max(now, item.updatedAt + 1);
      const op = cleanOp({ op: 'upsert', item: { ...item, section: 'today', pos: at, updatedAt: at } }, now);
      if (op) { await applyOp(env, op); woke++; }
      drop.push(m.task_id);
    } else if (m.kind === 'moved') {
      if (now - m.at > 2 * DAY) drop.push(m.task_id); // Undo lasts seconds; two days is plenty
    } else if (!item || item.updatedAt !== m.at) {
      drop.push(m.task_id); // restored, and touched since: the real clock counts again
    }
  }
  for (const id of drop) await env.HUB_DB.prepare('DELETE FROM week_marks WHERE task_id = ?').bind(id).run();
  return { woke, dropped: drop.length };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* Pure: the push's words. */
export function pushText(w) {
  const parts = [];
  if (w.done.count) parts.push(`${w.done.count} done`);
  if (w.quiet.length) parts.push(`${w.quiet.length} gone quiet`);
  if (w.vacancies.length) parts.push(plural(w.vacancies.length, 'new vacancy', 'new vacancies'));
  return { title: 'Your week is ready', message: (parts.length ? parts.join(', ') + '.' : 'A quiet week.') + ' Open Morning.' };
}

/* Pure: should the Sunday push go now? */
export function pushDue(l, cfg, pushedOn) {
  if (l.weekday !== 0) return 'not Sunday';
  if (!cfg.sunday_reset_time) return 'no time set';
  if (l.minutes < toMin(cfg.sunday_reset_time)) return 'too early';
  if (inQuiet(l.minutes, cfg.quiet_hours)) return 'quiet hours';
  if (pushedOn === l.date) return 'sent';
  return '';
}

export async function sundayPush(env, now = Date.now(), fetcher = fetch) {
  if (!env.HUB_DB) return { skip: 'no db' };
  const l = local(now);
  if (l.weekday !== 0) return { skip: 'not Sunday' };
  const [cfg, pushedOn] = await Promise.all([readConfig(env, ['sunday_reset_time', 'quiet_hours']), env.HUB_KV.get(PUSHED_KEY)]);
  const why = pushDue(l, cfg, pushedOn);
  if (why) return { skip: why };
  if (!env.NTFY_TOPIC) return { skip: 'no topic' };
  const m = pushText(await weekBlock(env, now));
  const r = await fetcher('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: env.NTFY_TOPIC, ...m, priority: 3, tags: ['calendar'] }) });
  if (!r.ok) return { skip: 'ntfy ' + r.status }; // tried again at the next run
  await env.HUB_KV.put(PUSHED_KEY, l.date);
  return { sent: m };
}

/* ---------- The paragraph: Claude, once each Sunday, from the week's facts ---------- */

export const PARA_PREFIX = 'week:paragraph:';
export const PARA_HOUR = 6;
export const MAX_PARA = 480;

const PARA_SYSTEM = [
  "You write the short paragraph at the top of Paul's Sunday review, from a JSON of his own week: tasks done, tasks gone quiet, vacancies, things he did for other people, next week's calendar, and what he typed into Desk (a box where he asks for tasks and drafts; skipped lines show what he did not want).",
  'Exactly three sentences, under 450 characters, plain English, warm and direct, written to Paul as "you". No greeting, no markdown, no lists, no praise inflation.',
  '1. What got done, naming one or two real tasks. 2. What slipped or has gone quiet, naming one; if nothing slipped, say what took most of the week. 3. One concrete suggestion for next week, tied to a task or a day on next week\'s calendar.',
  'Use only names, tasks and numbers in the facts; never invent. Never use dashes as punctuation; use commas or full stops.',
].join('\n');
const Paragraph = z.object({ paragraph: z.string().max(MAX_PARA) });

/* Pure: what Claude sees. Short texts only, masked already by the sections. */
export function paragraphFacts(block, desk) {
  const done = [];
  for (const g of block.done.groups || []) for (const x of g.items) done.push(x.text);
  return {
    week: block.week,
    done: { count: block.done.count, tasks: done.slice(0, 30) },
    goneQuiet: block.quiet.slice(0, 12).map((q) => ({ task: q.text, days: q.days })),
    vacancies: block.vacancies.map((v) => ({ task: v.text, state: v.state })),
    nextWeek: block.next.events.slice(0, 25).map((e) => ({ day: e.day, title: e.title, time: e.time || null })),
    desk,
  };
}

async function deskWeek(env, from) {
  if (!env.HUB_DB) return null;
  try {
    const { results } = await env.HUB_DB.prepare('SELECT text, kinds, outcome FROM desk_log WHERE at >= ? ORDER BY at').bind(new Date(from).toISOString()).all();
    const rows = results || [];
    const count = {};
    for (const r of rows) for (const o of JSON.parse(r.outcome || '[]')) count[o] = (count[o] || 0) + 1;
    return { lines: rows.length, outcomes: count, typed: rows.slice(-15).map((r) => maskSecrets(r.text).slice(0, 160)) };
  } catch (e) {
    return null;
  }
}

export async function writeParagraph(env, facts) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const res = await anthropic(env).beta.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    system: PARA_SYSTEM,
    messages: [{ role: 'user', content: 'Paul\'s week (JSON):\n' + JSON.stringify(facts) }],
    output_config: { effort: 'medium', format: zodOutputFormat(Paragraph) },
    fallbacks: 'default',
    betas: ['server-side-fallback-2026-07-01'],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return null;
  return String(res.parsed_output.paragraph || '') || null;
}

let paraWriter = writeParagraph;
export function _setParagrapher(fn) { paraWriter = fn || writeParagraph; }

/* Sundays from 06:00, once: the week is reserved before the call, so a failure waits a week. */
export async function weekParagraph(env, now = Date.now()) {
  const l = local(now);
  if (l.weekday !== 0) return { skip: 'not Sunday' };
  if (l.minutes < PARA_HOUR * 60) return { skip: 'too early' };
  if (!env.TODO_CODE) return { skip: 'not configured' };
  const monday = mondayOf(l.date);
  const key = PARA_PREFIX + monday;
  if (await env.HUB_KV.get(key)) return { skip: 'written' };
  const ttl = { expirationTtl: 60 * 24 * 3600 };
  await env.HUB_KV.put(key, JSON.stringify({ at: new Date(now).toISOString(), text: null }), ttl);
  const block = await weekBlock(env, now);
  const facts = paragraphFacts(block, await deskWeek(env, zoned(monday)));
  let text = null;
  try { text = await paraWriter(env, facts); } catch (e) { text = null; }
  text = text ? noDashes(text).slice(0, MAX_PARA) || null : null;
  await env.HUB_KV.put(key, JSON.stringify({ at: new Date(now).toISOString(), text }), ttl);
  return text ? { written: text.length } : { skip: 'no paragraph' };
}

export async function weekCron(env, now = Date.now(), fetcher = fetch) {
  const [wake, push, para] = await Promise.allSettled([wakeSnoozes(env, now), sundayPush(env, now, fetcher), weekParagraph(env, now)]);
  return { wake: wake.value || String(wake.reason), push: push.value || String(push.reason), para: para.value || String(para.reason) };
}
