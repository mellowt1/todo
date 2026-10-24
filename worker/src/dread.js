/* The Dread meter (Paul, 2026-10-22): start a task, say how much you dread it (1 to 5), and the hub
 * times it. On Sunday: the biggest lies (dreaded 4 or 5, done in 15 minutes or less), the average
 * dread per energy level, how many were started and how many were skipped.
 *
 *   GET  /api/dread/:code                  -> { running }
 *   POST /api/dread/:code/start            <- { task, dread?: 1-5 | null, source }  -> { running, stopped? }
 *   POST /api/dread/:code/rate             <- { task, dread, source }               -> { running }
 *   POST /api/dread/:code/stop             <- { done?: true, source }               -> { running: null, stopped }
 *   POST /api/dread/:code/undo             <- { task, source }   a Done undone: the timer runs on -> { running }
 *   POST /api/dread/:code/skip             <- { task, why: "moved", source }        -> { ok }
 *   GET/POST /api/hub/dread/day[/start|/rate|/stop]   the same for Day, Bearer HUB_SECRET_DAY, source "day"
 *
 *   running = { task, name, section, startedAt, dread, mins, level, source } or null
 *   offer   = "Music for this?": the Spotify playlist for the level now, or null (src/soundtrack.js)
 *   stopped = { task, name, mins, dread, done }
 *
 * One timer at a time; starting another stops the one that runs. Everything is a hub event in D1
 * `events` through acceptEvent, kept out of Morning's feed, with task ids only, never names:
 *   dread.started  { task, level, dread, startedAt }       dread.rated   { task, dread, startedAt }
 *   dread.stopped  { task, level, dread, startedAt, mins, why }   why: stop | switch | timeout | gone
 *   dread.done     { task, level, dread, startedAt, mins }
 *   dread.undone   { task, level, dread, startedAt }       dread.skipped { task, why }
 * The timer that runs is the newest of started / stopped / done / undone, when that is a start or
 * an undo. Its dread is the newest rating since it started. A rating is also kept on the task
 * (`dread`, src/todo.js), which Give me one reads on a drained day (src/energy.js pickPool).
 *
 * Settling, on every read and every cron run: a running task that was ticked off (anywhere) is done
 * at its doneAt; one that was deleted is stopped; one older than MAX_HOURS stops counting there.
 *
 * Skips (Paul's answer): "Not this one" (energy.skipped), a Waiting on snooze (waiting.snoozed) and
 * a task moved out of Today in To-do (dread.skipped). Stopping a timer is not a skip. */

import { CODE, ID, safeEqual, bearer, cleanOp } from './todo.js';
import { acceptEvent } from './hub.js';
import { energyNow, readItems, listStub, nameAndDue } from './energy.js';
import { maskSecrets } from './mask.js';
import { zoned, addDays } from './morning.js';
import { offerFor } from './soundtrack.js';

export const MAX_HOURS = 4; // a forgotten timer stops counting after this (Paul, 2026-10-22)
export const LIE_DREAD = 4; // dreaded at least this ...
export const LIE_MINS = 15; // ... and done in this many minutes or less: a lie
export const LIES_SHOWN = 5;
export const SCALE = [1, 2, 3, 4, 5];
const MIN = 60000;
const RUN_TYPES = "('dread.started', 'dread.stopped', 'dread.done', 'dread.undone')";
const CODE_SOURCES = ['todo', 'morning'];
const LEVELS = ['wired', 'normal', 'drained'];

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
const parse = (s) => { try { return JSON.parse(s) || {}; } catch (e) { return {}; } };
export const cleanDread = (v) => (SCALE.includes(v) ? v : null);

/* Pure: whole minutes from start to end, at least 1, never more than MAX_HOURS. */
export function minutes(startedAt, end) {
  const ms = Math.min(end - Date.parse(startedAt), MAX_HOURS * 60 * MIN);
  return Math.max(1, Math.round(ms / MIN));
}

/* Pure: the newest timer event (+ the newest rating since) -> the timer that runs, or null. */
export function runningFrom(row, rated) {
  if (!row || (row.type !== 'dread.started' && row.type !== 'dread.undone')) return null;
  const p = parse(row.payload);
  if (typeof p.task !== 'string' || !Number.isFinite(Date.parse(p.startedAt))) return null;
  let dread = cleanDread(p.dread);
  const r = rated ? parse(rated.payload) : null;
  if (r && r.task === p.task && r.startedAt === p.startedAt && cleanDread(r.dread)) dread = r.dread;
  return { task: p.task, startedAt: p.startedAt, dread, level: LEVELS.includes(p.level) ? p.level : null, source: row.source };
}

async function readRunning(env) {
  const row = await env.HUB_DB.prepare('SELECT type, source, payload, at FROM events WHERE type IN ' + RUN_TYPES + ' ORDER BY at DESC, rowid DESC LIMIT 1').first();
  if (!row || (row.type !== 'dread.started' && row.type !== 'dread.undone')) return null;
  const rated = await env.HUB_DB.prepare("SELECT payload FROM events WHERE type = 'dread.rated' AND at >= ? ORDER BY at DESC, rowid DESC LIMIT 1")
    .bind(parse(row.payload).startedAt || row.at).first();
  return runningFrom(row, rated);
}

async function emit(env, type, source, payload, now, summary) {
  await acceptEvent(env, {
    id: type.replace('.', '-') + '-' + now + '-' + rand(), source, type, summary,
    payload, caused_by: null, hops: 0, at: new Date(now).toISOString(),
  }, { feed: false });
}

/* Pure: what to do with the timer that runs, given its task now. */
export function settleAction(run, it, now) {
  if (!run) return null;
  if (!it) return { type: 'dread.stopped', why: 'gone', end: now };
  if (it.done && Number.isFinite(it.doneAt) && it.doneAt >= Date.parse(run.startedAt)) return { type: 'dread.done', end: Math.min(it.doneAt, now) };
  if (now - Date.parse(run.startedAt) >= MAX_HOURS * 60 * MIN) return { type: 'dread.stopped', why: 'timeout', end: Date.parse(run.startedAt) + MAX_HOURS * 60 * MIN };
  return null;
}

async function finish(env, run, type, why, end, source, now) {
  const mins = minutes(run.startedAt, end);
  const payload = { task: run.task, level: run.level, dread: run.dread, startedAt: run.startedAt, mins };
  if (type === 'dread.stopped') payload.why = why;
  await emit(env, type, source, payload, now, type === 'dread.done' ? 'Done after a timer' : 'Timer stopped');
  return { task: run.task, mins, dread: run.dread, done: type === 'dread.done' };
}

/* The timer that runs, settled against the list. Returns { run, items, stopped }. */
async function current(env, now) {
  const run = await readRunning(env);
  if (!run) return { run: null, items: null, stopped: null };
  const items = env.TODO_CODE ? await readItems(env) : {};
  const act = settleAction(run, items[run.task], now);
  if (!act) return { run, items, stopped: null };
  const stopped = await finish(env, run, act.type, act.why, act.end, run.source || 'hub', now);
  return { run: null, items, stopped: { ...stopped, name: nameOf(items[run.task]) } };
}

const nameOf = (it) => (it ? maskSecrets(nameAndDue(it.text).name) : null);

/* Pure: the timer as the apps see it. */
export function runningView(run, items, now) {
  if (!run) return null;
  const it = items && items[run.task];
  return {
    task: run.task, name: nameOf(it), section: it ? it.section : null, startedAt: run.startedAt,
    dread: run.dread, level: run.level, source: run.source, mins: Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / MIN)),
  };
}

/* Keep the rating on the task too: Give me one reads it on a drained day. */
async function rateTask(env, items, id, dread, now) {
  const it = items && items[id];
  if (!it || it.dread === dread) return;
  const at = Math.max(now, (it.updatedAt || 0) + 1);
  const op = cleanOp({ op: 'upsert', item: { ...it, dread, updatedAt: at } }, at);
  if (!op) return;
  const r = await listStub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [op] }), headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error('todo apply ' + r.status);
}

export async function startTimer(env, task, dread, source, now = Date.now()) {
  const cur = await current(env, now);
  const items = cur.items || await readItems(env);
  const it = items[task];
  if (!it || it.done) return { error: 'no such open task', status: 404 };
  let stopped = cur.stopped;
  if (cur.run && cur.run.task === task) { // already running: only the rating can change
    if (dread) await rateTimer(env, task, dread, source, now);
    return { running: runningView(await readRunning(env), await readItems(env), now) };
  }
  if (cur.run) stopped = { ...(await finish(env, cur.run, 'dread.stopped', 'switch', now, source, now)), name: nameOf(items[cur.run.task]) };
  const level = (await energyNow(env, now)).level;
  const startedAt = new Date(now).toISOString();
  await emit(env, 'dread.started', source, { task, level, dread, startedAt }, now, 'Timer started');
  if (dread) await rateTask(env, items, task, dread, now);
  return { running: runningView({ task, startedAt, dread, level, source }, items, now), stopped };
}

export async function rateTimer(env, task, dread, source, now = Date.now()) {
  const run = await readRunning(env);
  if (!run || run.task !== task) return { error: 'not running', status: 409 };
  await emit(env, 'dread.rated', source, { task, dread, startedAt: run.startedAt }, now, 'Dread rated');
  const items = await readItems(env);
  await rateTask(env, items, task, dread, now);
  return { running: runningView({ ...run, dread }, items, now) };
}

export async function stopTimer(env, done, source, now = Date.now()) {
  const cur = await current(env, now);
  if (!cur.run) return { running: null, stopped: cur.stopped };
  const stopped = await finish(env, cur.run, done ? 'dread.done' : 'dread.stopped', 'stop', now, source, now);
  return { running: null, stopped: { ...stopped, name: nameOf(cur.items[cur.run.task]) } };
}

/* Undo after a Done: only when the newest timer event is that task's done; the timer runs on. */
export async function undoDone(env, task, source, now = Date.now()) {
  const row = await env.HUB_DB.prepare('SELECT type, payload FROM events WHERE type IN ' + RUN_TYPES + ' ORDER BY at DESC, rowid DESC LIMIT 1').first();
  const p = row ? parse(row.payload) : {};
  if (!row || row.type !== 'dread.done' || p.task !== task) return { error: 'nothing to undo', status: 409 };
  const payload = { task, level: p.level || null, dread: cleanDread(p.dread), startedAt: p.startedAt };
  await emit(env, 'dread.undone', source, payload, now, 'Done undone');
  return { running: runningView({ ...payload, source }, await readItems(env), now) };
}

export async function recordSkip(env, task, why, source, now = Date.now()) {
  await emit(env, 'dread.skipped', source, { task, why }, now, 'Skipped');
  return { ok: true };
}

/* The cron: settles a ticked, deleted or forgotten timer even when no app is open. */
export async function dreadCron(env, now = Date.now()) {
  if (!env.HUB_DB || !env.TODO_CODE) return { skipped: true };
  const cur = await current(env, now);
  return { settled: cur.stopped ? 1 : 0 };
}

/* ---------- The Sunday card ---------- */

/* Pure: the week's dread and skip events (oldest first) + the list -> the card. Two timer events
 * with the same task and start are one run; an undone done does not count. */
export function dreadWeek(rows, items) {
  const runs = new Map();
  let started = 0;
  let skipped = 0;
  for (const r of rows) {
    const p = parse(r.payload);
    if (r.type === 'energy.skipped' || r.type === 'waiting.snoozed' || r.type === 'dread.skipped') { skipped++; continue; }
    if (r.type === 'dread.started') { started++; continue; }
    const key = p.task + '|' + p.startedAt;
    if (r.type === 'dread.done' || r.type === 'dread.stopped') runs.set(key, { ...p, done: r.type === 'dread.done' });
    else if (r.type === 'dread.undone') runs.delete(key);
  }
  const lies = [];
  const sums = { wired: [0, 0], normal: [0, 0], drained: [0, 0] };
  for (const run of runs.values()) {
    const d = cleanDread(run.dread);
    if (d && sums[run.level]) { sums[run.level][0] += d; sums[run.level][1]++; }
    if (run.done && d >= LIE_DREAD && run.mins <= LIE_MINS) {
      const it = items && items[run.task];
      lies.push({ task: run.task, name: it ? nameOf(it) : 'A task since deleted', dread: d, mins: run.mins });
    }
  }
  lies.sort((a, b) => b.dread - a.dread || a.mins - b.mins);
  const byLevel = {};
  for (const l of LEVELS) byLevel[l] = sums[l][1] ? Math.round((sums[l][0] / sums[l][1]) * 10) / 10 : null;
  return { lies: lies.slice(0, LIES_SHOWN), byLevel, rated: Object.values(sums).reduce((n, s) => n + s[1], 0), started, skipped };
}

export async function dreadFor(env, monday, items) {
  if (!env.HUB_DB) return null;
  const from = new Date(zoned(monday)).toISOString();
  const to = new Date(zoned(addDays(monday, 7))).toISOString();
  const { results } = await env.HUB_DB.prepare(
    "SELECT type, payload, at FROM events WHERE type IN ('dread.started', 'dread.stopped', 'dread.done', 'dread.undone', 'dread.skipped', 'energy.skipped', 'waiting.snoozed') AND at >= ? AND at < ? ORDER BY at, rowid"
  ).bind(from, to).all();
  return dreadWeek(results || [], items);
}

/* ---------- Routes ---------- */

async function readJson(request, max = 2000) {
  const raw = await request.text();
  if (raw.length > max) return { status: 413, error: 'too large' };
  try { return { body: raw ? JSON.parse(raw) : {} }; } catch (e) { return { status: 400, error: 'bad json' }; }
}

async function dreadRoute(request, env, sub, source, json, now) {
  if (!env.HUB_DB || !env.TODO_CODE) return json({ error: 'not configured' }, request, 503);
  if (sub.length === 0 && request.method === 'GET') {
    const cur = await current(env, now);
    const running = runningView(cur.run, cur.items, now);
    return json({ running, stopped: cur.stopped, offer: await offerFor(env, running, await energyNow(env, now)) }, request);
  }
  if (request.method !== 'POST' || sub.length !== 1) return json({ error: 'not found' }, request, 404);
  const got = await readJson(request);
  if (got.error) return json({ error: got.error }, request, got.status);
  const b = got.body && typeof got.body === 'object' ? got.body : {};
  const src = source || (CODE_SOURCES.includes(b.source) ? b.source : null);
  if (!src) return json({ error: 'source: todo or morning' }, request, 400);
  const task = typeof b.task === 'string' && ID.test(b.task) ? b.task : null;
  const send = async (out) => {
    if (out.error) return json({ error: out.error }, request, out.status || 400);
    if ('running' in out) out.offer = await offerFor(env, out.running, await energyNow(env, now));
    return json(out, request);
  };

  switch (sub[0]) {
    case 'start': {
      if (!task) return json({ error: 'task: an id' }, request, 400);
      if (b.dread !== undefined && b.dread !== null && !cleanDread(b.dread)) return json({ error: 'dread: 1 to 5 or null' }, request, 400);
      return send(await startTimer(env, task, cleanDread(b.dread), src, now));
    }
    case 'rate':
      if (!task) return json({ error: 'task: an id' }, request, 400);
      if (!cleanDread(b.dread)) return json({ error: 'dread: 1 to 5' }, request, 400);
      return send(await rateTimer(env, task, b.dread, src, now));
    case 'stop':
      return send(await stopTimer(env, b.done === true, src, now));
    case 'undo':
      if (!task) return json({ error: 'task: an id' }, request, 400);
      return send(await undoDone(env, task, src, now));
    case 'skip':
      if (!task || b.why !== 'moved' || source) return json({ error: 'task and why: moved' }, request, 400);
      return send(await recordSkip(env, task, 'moved', src, now));
    default:
      return json({ error: 'not found' }, request, 404);
  }
}

export async function handleDread(request, env, rest, json, now = Date.now()) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  return dreadRoute(request, env, rest.slice(1), null, json, now);
}

/* /api/hub/dread/day[/start|/rate|/stop]: Day on the Mac, through the Odysseus backend. */
export async function handleDreadDay(request, env, sub, json, now = Date.now()) {
  if (!env.HUB_SECRET_DAY || !safeEqual(bearer(request), env.HUB_SECRET_DAY)) return json({ error: 'unauthorized' }, request, 401);
  if (sub[0] === 'undo' || sub[0] === 'skip') return json({ error: 'not found' }, request, 404);
  return dreadRoute(request, env, sub, 'day', json, now);
}
