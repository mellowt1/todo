/* German tutor calls (src/german.js).
 *
 * The tutor app on Paul's Windows PC "calls" him on four random evenings a week. The PC
 * pushes the week's plan and each call's outcome here; Odysseus pulls them for calendar
 * events. Times are Europe/Amsterdam.
 *
 *   POST /api/german/week     Authorization: Bearer <GERMAN_PUSH_TOKEN>
 *                             <- { calls: [{ id, date, windowStart, windowEnd, at, persona, topic }] }
 *                             -> { ok: true, count }
 *   POST /api/german/outcome  Authorization: Bearer <GERMAN_PUSH_TOKEN>
 *                             <- { id, status, minutes?, outcomeAt, fixes? }
 *                             -> { ok: true }
 *   GET  /api/german/calls    Authorization: Bearer <GERMAN_READ_TOKEN>
 *                             ?from=YYYY-MM-DD (default 28 days ago)
 *                             -> { calls: [...], updated }
 *
 * HUB_KV key german:calls holds a JSON array of calls. The PC is the only writer, so a
 * plain read-modify-write on one key is enough. Calls older than 90 days are pruned on write.
 */

import { safeEqual, bearer } from './todo.js';
import { local, addDays, validDay } from './morning.js';

export const GERMAN_KEY = 'german:calls';
export const MAX_CALLS = 20;
export const MAX_TEXT = 80;
export const KEEP_DAYS = 90;
export const DEFAULT_FROM_DAYS = 28;
export const PERSONAS = ['Ingrid', 'Hartmut'];
export const STATUSES = ['planned', 'answered', 'missed', 'declined'];
const OUTCOMES = ['answered', 'missed', 'declined'];
const MAX_BODY = 64 * 1024;

const ID_RE = /^[a-z0-9-]{1,64}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function validIso(s) {
  return typeof s === 'string' && s.length <= MAX_TEXT && ISO_RE.test(s) && Number.isFinite(Date.parse(s)) && validDay(s.slice(0, 10));
}

const text = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_TEXT;

/* Validate a week push. All or nothing: { calls } or { error } naming the item. */
export function cleanWeek(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.calls)) return { error: 'calls must be a list' };
  if (body.calls.length > MAX_CALLS) return { error: `at most ${MAX_CALLS} calls` };
  const seen = new Set();
  const calls = [];
  for (let i = 0; i < body.calls.length; i++) {
    const c = body.calls[i];
    const bad = (why) => ({ error: `call ${i}: ${why}` });
    if (!c || typeof c !== 'object' || Array.isArray(c)) return bad('not an object');
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) return bad('id must be 1 to 64 of a-z, 0-9 and -');
    if (seen.has(c.id)) return bad('duplicate id');
    seen.add(c.id);
    if (!validDay(c.date)) return bad('date must be YYYY-MM-DD');
    if (typeof c.windowStart !== 'string' || !TIME_RE.test(c.windowStart)) return bad('windowStart must be HH:MM');
    if (typeof c.windowEnd !== 'string' || !TIME_RE.test(c.windowEnd)) return bad('windowEnd must be HH:MM');
    if (c.windowEnd <= c.windowStart) return bad('windowEnd must be after windowStart');
    if (!validIso(c.at)) return bad('at must be an ISO time with offset');
    if (!PERSONAS.includes(c.persona)) return bad('persona must be Ingrid or Hartmut');
    if (!text(c.topic)) return bad(`topic must be 1 to ${MAX_TEXT} characters`);
    calls.push({ id: c.id, date: c.date, windowStart: c.windowStart, windowEnd: c.windowEnd, at: c.at, persona: c.persona, topic: c.topic.trim() });
  }
  return { calls };
}

/* Validate an outcome push: { outcome } or { error }. */
export function cleanOutcome(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'send an object' };
  if (typeof b.id !== 'string' || !ID_RE.test(b.id)) return { error: 'id must be 1 to 64 of a-z, 0-9 and -' };
  if (!OUTCOMES.includes(b.status)) return { error: 'status must be answered, missed or declined' };
  if (b.minutes !== undefined && b.minutes !== null
    && (typeof b.minutes !== 'number' || !Number.isFinite(b.minutes) || b.minutes < 0 || b.minutes > 180)) {
    return { error: 'minutes must be a number from 0 to 180' };
  }
  if (b.fixes !== undefined && b.fixes !== null && (!Number.isInteger(b.fixes) || b.fixes < 0 || b.fixes > 99)) {
    return { error: 'fixes must be a whole number from 0 to 99' };
  }
  if (!validIso(b.outcomeAt)) return { error: 'outcomeAt must be an ISO time with offset' };
  return { outcome: { id: b.id, status: b.status, minutes: b.minutes ?? null, fixes: b.fixes ?? null, outcomeAt: b.outcomeAt } };
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : Date.parse(a.at) - Date.parse(b.at));

export async function readCalls(env) {
  const v = await env.HUB_KV.get(GERMAN_KEY, 'json');
  return Array.isArray(v) ? v : [];
}

async function writeCalls(env, calls, now) {
  const cutoff = addDays(local(now).date, -KEEP_DAYS);
  const kept = calls.filter((c) => c.date >= cutoff).sort(byDate);
  await env.HUB_KV.put(GERMAN_KEY, JSON.stringify(kept));
  return kept;
}

const PLAN = ['date', 'windowStart', 'windowEnd', 'at', 'persona', 'topic'];

/* Upsert the plan. Status, minutes, fixes and outcomeAt are never touched here. A call still
 * planned for today or later that the push leaves out is dropped (the PC replanned). */
export function mergeWeek(stored, incoming, now) {
  const today = local(now).date;
  const stamp = new Date(now).toISOString();
  const byId = new Map(stored.map((c) => [c.id, c]));
  const sent = new Set(incoming.map((c) => c.id));
  const out = stored.filter((c) => sent.has(c.id) || c.status !== 'planned' || c.date < today);
  const index = new Map(out.map((c, i) => [c.id, i]));
  for (const c of incoming) {
    const old = byId.get(c.id);
    if (old) {
      const changed = PLAN.some((k) => old[k] !== c[k]);
      out[index.get(c.id)] = changed ? { ...old, ...c, updated: stamp } : old;
    } else {
      out.push({ ...c, status: 'planned', minutes: null, fixes: null, outcomeAt: null, updated: stamp });
    }
  }
  return out;
}

/* { thisWeek: { planned, answered, missed, declined }, streak } or null with no data.
 * The week is Monday to Sunday in Amsterdam. The streak counts answered calls back from
 * the most recent call that is no longer planned. */
export function germanView(calls, now = Date.now()) {
  if (!calls.length) return null;
  const l = local(now);
  const monday = addDays(l.date, -((l.weekday + 6) % 7));
  const sunday = addDays(monday, 6);
  const thisWeek = { planned: 0, answered: 0, missed: 0, declined: 0 };
  for (const c of calls) {
    if (c.date >= monday && c.date <= sunday && thisWeek[c.status] !== undefined) thisWeek[c.status]++;
  }
  let streak = 0;
  const done = calls.filter((c) => c.status !== 'planned').sort(byDate);
  for (let i = done.length - 1; i >= 0 && done[i].status === 'answered'; i--) streak++;
  return { thisWeek, streak };
}

export async function germanBlock(env, now = Date.now()) {
  if (!env.HUB_KV) return null;
  return germanView(await readCalls(env), now);
}

async function readBody(request) {
  const t = await request.text();
  if (t.length > MAX_BODY) return { status: 413, error: 'too large' };
  try {
    return { body: JSON.parse(t) };
  } catch (e) {
    return { status: 400, error: 'bad json' };
  }
}

/* 503 when the secret is not set, 401 when the token is missing or wrong, else null. */
function denied(request, secret, json) {
  if (!secret) return json({ error: 'not configured' }, request, 503);
  if (!safeEqual(bearer(request), secret)) return json({ error: 'token required' }, request, 401);
  return null;
}

export async function handleGerman(request, env, rest, url, json, now = Date.now()) {
  const route = rest.join('/');
  if (route === 'week' || route === 'outcome') {
    if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
    const no = denied(request, env.GERMAN_PUSH_TOKEN, json);
    if (no) return no;
    const got = await readBody(request);
    if (got.error) return json({ error: got.error }, request, got.status);

    if (route === 'week') {
      const w = cleanWeek(got.body);
      if (w.error) return json({ error: w.error }, request, 400);
      await writeCalls(env, mergeWeek(await readCalls(env), w.calls, now), now);
      return json({ ok: true, count: w.calls.length }, request);
    }

    const o = cleanOutcome(got.body);
    if (o.error) return json({ error: o.error }, request, 400);
    const calls = await readCalls(env);
    const i = calls.findIndex((c) => c.id === o.outcome.id);
    if (i < 0) return json({ error: 'unknown id' }, request, 404);
    calls[i] = { ...calls[i], ...o.outcome, updated: new Date(now).toISOString() };
    await writeCalls(env, calls, now);
    return json({ ok: true }, request);
  }

  if (route === 'calls') {
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    const no = denied(request, env.GERMAN_READ_TOKEN, json);
    if (no) return no;
    const q = url.searchParams.get('from');
    if (q !== null && !validDay(q)) return json({ error: 'from must be YYYY-MM-DD' }, request, 400);
    const from = q ?? addDays(local(now).date, -DEFAULT_FROM_DAYS);
    const all = await readCalls(env);
    const calls = all.filter((c) => c.date >= from).sort(byDate).map((c) => ({
      id: c.id, date: c.date, windowStart: c.windowStart, windowEnd: c.windowEnd, at: c.at,
      persona: c.persona, topic: c.topic, status: c.status, minutes: c.minutes ?? null,
      fixes: c.fixes ?? null, outcomeAt: c.outcomeAt ?? null, updated: c.updated ?? null,
    }));
    const updated = all.reduce((m, c) => (c.updated && (!m || c.updated > m) ? c.updated : m), null);
    return json({ calls, updated }, request);
  }

  return json({ error: 'not found' }, request, 404);
}
