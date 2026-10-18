/* Lift: the gym app (its own repo, on GitHub Pages). Workouts live on the phone; after each
 * workout, and after each change to the plan, Lift sends its state here. paul-hub keeps it for
 * Morning, pays Strength XP for every gym day it shows (the same id as the gym button, so a day
 * never pays twice), posts a line to the feed for a workout from the last two days, and holds
 * the phone's latest backup.
 *
 *   POST /api/lift/:code         <- { summary, backup? }  -> { ok, xp, feed }
 *   GET  /api/lift/:code         -> { summary, at, backupAt, backupSize }
 *   GET  /api/lift/:code/backup  -> the backup as the phone sent it
 *   Morning's block (liftForMorning) -> { next, nextDay, today, week, last, at }
 *
 * summary = {
 *   next: { name, items: [{ name, sets, range, kg, up }] } | null,   today's weights for the routine due next
 *   nextDay: 'YYYY-MM-DD' | null,                                    the next gym day the phone worked out
 *   rotation: [name], days: [7 booleans, Monday first],
 *   workouts: [{ id, name, start, end, volume, sets, prs }]         newest first, at most 500
 * }
 * KV: lift:state { summary, at }, lift:backup (the phone's export, at most 4 MB), lift:fed:<id> (30 days).
 * The code is the to-do's (TODO_CODE), as for Morning and Hiscores. */

import { safeEqual, CODE } from './todo.js';
import { local } from './morning.js';
import { grant, XP } from './hiscores.js';
import { cleanEvent, putEvent } from './events.js';

const STATE = 'lift:state';
const BACKUP = 'lift:backup';
const MAX_BODY = 4 * 1024 * 1024;
const DAY = 86400000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/* Pure: whatever the phone sent → a summary with known shapes, or { error }. */
export function cleanSummary(s) {
  if (!s || typeof s !== 'object') return { error: 'summary required' };
  const items = (s.next && Array.isArray(s.next.items) ? s.next.items : []).slice(0, 20).map((it) => ({
    name: str(it && it.name, 80),
    sets: Math.min(20, Math.round(num(it && it.sets))),
    range: str(it && it.range, 12),
    kg: it && typeof it.kg === 'number' && Number.isFinite(it.kg) && it.kg > 0 ? Math.round(it.kg * 100) / 100 : null,
    up: !!(it && it.up),
  })).filter((it) => it.name);
  const next = s.next && str(s.next.name, 60) ? { name: str(s.next.name, 60), items } : null;
  const workouts = (Array.isArray(s.workouts) ? s.workouts : []).slice(0, 500).map((w) => ({
    id: str(w && w.id, 40),
    name: str(w && w.name, 60) || 'Workout',
    start: num(w && w.start),
    end: num(w && w.end),
    volume: Math.round(num(w && w.volume)),
    sets: Math.round(num(w && w.sets)),
    prs: Math.round(num(w && w.prs)),
  })).filter((w) => w.id && w.start > Date.parse('2000-01-01')).sort((a, b) => b.start - a.start);
  return {
    next,
    nextDay: DATE.test(s.nextDay || '') ? s.nextDay : null,
    rotation: (Array.isArray(s.rotation) ? s.rotation : []).slice(0, 12).map((n) => str(n, 60)).filter(Boolean),
    days: Array.from({ length: 7 }, (_, i) => !!(Array.isArray(s.days) && s.days[i])),
    workouts,
  };
}

/* Pure: one Strength row per day with a workout. The id is the gym button's, so a day pays once. */
export function strengthRows(workouts) {
  const seen = new Set();
  const out = [];
  for (const w of workouts) {
    const date = local(w.start).date;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ id: 'st:' + date, skill: 'strength', xp: XP.gym, at: new Date(w.start).toISOString(), what: `Gym: ${w.name}` });
  }
  return out;
}

const kg = (n) => Math.round(n).toLocaleString('en-GB');
export function feedLine(w) {
  const bits = [`${w.name} done`];
  if (w.volume) bits.push(`${kg(w.volume)} kg`);
  if (w.prs) bits.push(`${w.prs} PR${w.prs === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

export async function saveLift(env, body, now = Date.now()) {
  const summary = cleanSummary(body && body.summary);
  if (summary.error) return summary;
  await env.HUB_KV.put(STATE, JSON.stringify({ summary, at: new Date(now).toISOString() }));
  if (body.backup && typeof body.backup === 'object') {
    await env.HUB_KV.put(BACKUP, JSON.stringify({ at: new Date(now).toISOString(), data: body.backup }));
  }
  const xp = await grant(env, strengthRows(summary.workouts));
  // The feed hears about a workout once, and only a recent one: an import of old history stays quiet.
  let feed = 0;
  for (const w of summary.workouts.filter((x) => x.end > now - 2 * DAY && x.end <= now + 60000)) {
    const key = 'lift:fed:' + w.id;
    if (await env.HUB_KV.get(key)) continue;
    const rec = cleanEvent({ source: 'lift', kind: 'workout', text: feedLine(w), at: new Date(w.end).toISOString() }, now);
    if (rec.error) continue;
    await putEvent(env, rec, now);
    await env.HUB_KV.put(key, '1', { expirationTtl: 30 * 86400 });
    feed++;
  }
  return { xp, feed };
}

/* Morning: what's next and when, today's weights, this week, and the last workout. */
export async function liftForMorning(env, now = Date.now()) {
  const st = await env.HUB_KV.get(STATE, 'json');
  if (!st || !st.summary) return null;
  const s = st.summary;
  const today = local(now).date;
  const monday = mondayOf(today);
  const weekDone = new Set(s.workouts.filter((w) => local(w.start).date >= monday).map((w) => local(w.start).date)).size;
  const doneToday = s.workouts.find((w) => local(w.start).date === today) || null;
  const last = s.workouts[0] || null;
  return {
    next: s.next,
    nextDay: s.nextDay,
    today: s.nextDay === today && !doneToday,
    doneToday: doneToday ? { name: doneToday.name, volume: doneToday.volume, prs: doneToday.prs } : null,
    week: { done: weekDone, planned: s.days.filter(Boolean).length },
    rotation: s.rotation,
    last: last ? { name: last.name, date: local(last.start).date, minutes: Math.round((last.end - last.start) / 60000), volume: last.volume, prs: last.prs } : null,
    at: st.at,
  };
}

function mondayOf(date) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export async function handleLift(request, env, rest, json, now = Date.now()) {
  if (!rest.length || rest.length > 2 || !CODE.test(rest[0])) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(rest[0], env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (rest[1] === 'backup') {
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    const b = await env.HUB_KV.get(BACKUP, 'json');
    return b ? json(b, request) : json({ error: 'no backup yet' }, request, 404);
  }
  if (rest.length === 2) return json({ error: 'not found' }, request, 404);
  if (request.method === 'GET') {
    const st = await env.HUB_KV.get(STATE, 'json');
    const raw = await env.HUB_KV.get(BACKUP);
    let backupAt = null;
    try { backupAt = raw ? JSON.parse(raw).at : null; } catch (e) { /* an unreadable backup reads as none */ }
    return json({ summary: st ? st.summary : null, at: st ? st.at : null, backupAt, backupSize: raw ? raw.length : 0 }, request);
  }
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, request, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, request, 400); }
  const out = await saveLift(env, body, now);
  if (out.error) return json({ error: out.error }, request, 400);
  return json({ ok: true, ...out }, request);
}
