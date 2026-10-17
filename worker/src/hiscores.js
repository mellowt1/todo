/* Hiscores: Paul's real life as Old School RuneScape skills.
 *
 * Every app the hub can read pays XP into one ledger (D1 xp_log, migrations/0007_hiscores.sql).
 * Each row has a stable id from its source, so a scan can run any number of times; XP is never
 * taken back, as in the game. Levels follow the real OSRS XP table; the XP per action is set so
 * an ordinary month gets a skill to about 30, and 99 stays years away.
 *
 *   strength      a gym visit, once a day (POST .../gym)  1000  st:<date>
 *   woodcutting   a to-do ticked off                      100   wc:<task id>
 *   slayer        an "Apply:" to-do ticked off           4000   sl:<task id>
 *   cooking       Paul's Kitchen dinner, once the day is over: a recipe 800, a pizza night 500;
 *                 none on a night Day said he was out     ck:<date>
 *   prayer        a Feeling face that day                  450   pr:<date>
 *   ranged        an archery evening in Day, once it ended 3300  rg:<date>
 *   magic         a German call answered: 600 + 50 a minute (30 at most)  mg:<call id>
 *   crafting      a Desk action approved or copied         450   cr:<desk id>:<n>
 *   construction  a Sunday reset button (Do this week, New date, Delete), once per task per kind
 *                 a week: 600 (src/week.js calls grant)   cn:<task id>:<kind>:<monday>
 *
 * The first scan back-fills everything the sources still hold. After that the cron scans every
 * run, and a read scans first when the last scan is a minute old, so a tick shows right away.
 *
 *   GET  /api/hiscores/:code      -> { skills: [{ id, name, xp, level, at, next, today }], total, totalXp, log, at }
 *   POST /api/hiscores/:code/gym  -> { ok, added, level, xp, say }   a gym visit today (Strength)
 *   Morning's block (hiscoresForMorning) is the same without the long log.
 */

import { local, zoned, addDays, eventSpan, CAL_KEY } from './morning.js';
import { kitchen } from './kitchen-store.js';
import { readConfig } from './dinner.js';
import { safeEqual, CODE } from './todo.js';
import { GERMAN_KEY } from './german.js';
import { maskSecrets } from './mask.js';
import { moodsOf, dinnersByDay, isoWeekDate } from './mirror.js';

export const SKILLS = [ // the order of the OSRS skills tab, read across
  { id: 'strength', name: 'Strength', from: 'Gym visits' },
  { id: 'ranged', name: 'Ranged', from: 'Archery evenings' },
  { id: 'cooking', name: 'Cooking', from: 'Kitchen dinners' },
  { id: 'prayer', name: 'Prayer', from: 'Feeling faces' },
  { id: 'crafting', name: 'Crafting', from: 'Desk actions' },
  { id: 'magic', name: 'Magic', from: 'German calls' },
  { id: 'woodcutting', name: 'Woodcutting', from: 'To-dos ticked' },
  { id: 'slayer', name: 'Slayer', from: 'Applications' },
  { id: 'construction', name: 'Construction', from: 'Sunday resets' },
];
export const XP = { gym: 1000, task: 100, apply: 4000, recipe: 800, pizza: 500, face: 450, archery: 3300, call: 600, callMinute: 50, desk: 450, week: 600 };
export const ARCHERY = /archery|handboog|boogschiet|sebasti/i;
export const SCAN_KEY = 'hiscores:scanAt';
const SCAN_EVERY = 60 * 1000;
const LOG_SHOWN = 30;

/* ---------- The OSRS XP table ---------- */

export const LEVEL_XP = (() => {
  const t = [0, 0]; // t[level] = XP needed for that level; level 1 is 0
  let points = 0;
  for (let l = 1; l < 99; l++) {
    points += Math.floor(l + 300 * 2 ** (l / 7));
    t.push(Math.floor(points / 4));
  }
  return t;
})();

export function levelOf(xp) {
  let l = 1;
  while (l < 99 && xp >= LEVEL_XP[l + 1]) l++;
  return l;
}

/* ---------- From the sources to ledger rows (pure) ---------- */

const iso = (ms) => new Date(ms).toISOString();
const line = (s, n = 80) => maskSecrets(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, n);

export function taskRows(items) {
  const out = [];
  for (const i of Object.values(items || {})) {
    if (!i || !i.done || !Number.isFinite(i.doneAt) || typeof i.text !== 'string') continue;
    const apply = /^apply:/i.test(i.text);
    out.push(apply
      ? { id: 'sl:' + i.id, skill: 'slayer', xp: XP.apply, at: iso(i.doneAt), what: line(i.text.replace(/^apply:\s*/i, '').replace(/\s·\s\d{4}-\d{2}-\d{2}$/, '')) }
      : { id: 'wc:' + i.id, skill: 'woodcutting', xp: XP.task, at: iso(i.doneAt), what: line(i.text.replace(/\s·\s\d{4}-\d{2}-\d{2}$/, '')) });
  }
  return out;
}

/* Dinners of days that are over; a night out earns nothing. */
export function cookingRows(data, today) {
  const titles = new Map();
  for (const r of Object.values((data && data.items) || {})) if (r && r.type === 'recipe' && r.id) titles.set(r.id, r.title);
  const { days } = dinnersByDay(data);
  const out = [];
  for (const r of Object.values((data && data.items) || {})) {
    if (!r || r.type !== 'day') continue;
    const m = /^(\d{4}-W\d{2}):([a-z]{3}):paul:dinner$/.exec(r.id || '');
    const date = m && isoWeekDate(m[1], m[2]);
    if (!date || date >= today || days[date] !== r.kind) continue; // "out" replaced it
    if (r.kind === 'recipe') out.push({ id: 'ck:' + date, skill: 'cooking', xp: XP.recipe, at: iso(zoned(date, '20:00')), what: line(titles.get(r.recipeId) || 'A recipe') });
    else if (r.kind === 'pizza') out.push({ id: 'ck:' + date, skill: 'cooking', xp: XP.pizza, at: iso(zoned(date, '20:00')), what: line(r.text || 'Pizza night') });
  }
  return out;
}

export function prayerRows(moods, today, now) {
  return Object.keys(moods || {}).filter((d) => d <= today).map((d) => ({
    id: 'pr:' + d, skill: 'prayer', xp: XP.face, at: d === today ? iso(now) : iso(zoned(d, '21:00')), what: 'A face in Feeling',
  }));
}

/* Archery from Day's calendar push (events that have ended) and from the hub's dinner.away log,
 * which keeps the titles of evenings already gone. One per date. */
export function rangedRows(events, awayRows, now) {
  const out = new Map();
  for (const e of events || []) {
    if (!ARCHERY.test(e.title || '')) continue;
    let s, en;
    try { [s, en] = eventSpan(e); } catch (err) { continue; }
    if (!(en <= now)) continue;
    const d = local(s).date;
    out.set(d, { id: 'rg:' + d, skill: 'ranged', xp: XP.archery, at: iso(en), what: line(e.title) });
  }
  for (const r of awayRows || []) {
    let p = {};
    try { p = JSON.parse(r.payload) || {}; } catch (err) { continue; }
    if (!ARCHERY.test(p.title || '') || !/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) continue;
    const end = zoned(p.date, '22:00');
    if (end > now || out.has(p.date)) continue;
    out.set(p.date, { id: 'rg:' + p.date, skill: 'ranged', xp: XP.archery, at: iso(end), what: line(p.title) });
  }
  return [...out.values()];
}

export function magicRows(calls) {
  return (calls || []).filter((c) => c && c.status === 'answered' && c.id).map((c) => {
    const min = Math.max(0, Math.min(30, Math.round(Number(c.minutes) || 0)));
    const at = Date.parse(c.outcomeAt || c.at || '');
    return { id: 'mg:' + c.id, skill: 'magic', xp: XP.call + XP.callMinute * min, at: Number.isFinite(at) ? iso(at) : iso(zoned(c.date || '2026-01-01', '20:00')), what: line(`German with ${c.persona || 'the tutor'}${min ? `, ${min} min` : ''}`) };
  });
}

export function craftingRows(deskRows) {
  const out = [];
  for (const r of deskRows || []) {
    let o = [];
    try { o = JSON.parse(r.outcome || '[]'); } catch (e) { continue; }
    o.forEach((x, n) => {
      if (x === 'approved' || x === 'copied') out.push({ id: `cr:${r.id}:${n}`, skill: 'crafting', xp: XP.desk, at: r.updated_at || r.at, what: line(r.text, 60) });
    });
  }
  return out;
}

/* ---------- The ledger ---------- */

const INSERT = 'INSERT OR IGNORE INTO xp_log (id, skill, xp, at, what) VALUES (?, ?, ?, ?, ?)';

export async function grant(env, rows) {
  if (!env.HUB_DB || !rows.length) return 0;
  const res = await env.HUB_DB.batch(rows.map((r) => env.HUB_DB.prepare(INSERT).bind(r.id, r.skill, r.xp, r.at, r.what || '')));
  return res.reduce((n, r) => n + ((r && r.meta && r.meta.changes) || 0), 0);
}

/* Construction, from the Sunday reset's buttons (src/week.js). */
export async function grantWeek(env, taskId, action, text, now = Date.now()) {
  const kind = action.startsWith('later') ? 'later' : action;
  if (!['soon', 'later', 'delete'].includes(kind)) return 0;
  const today = local(now).date;
  const monday = addDays(today, -((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const what = { soon: 'Moved up: ', later: 'New date: ', delete: 'Cleared: ' }[kind] + line(text || 'a task', 60);
  return grant(env, [{ id: `cn:${taskId}:${kind}:${monday}`, skill: 'construction', xp: XP.week, at: iso(now), what }]);
}

/* Read every source; one failing source never stops the others. */
export async function scan(env, now = Date.now()) {
  const today = local(now).date;
  const jobs = {
    tasks: async () => {
      const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
      const r = await stub.fetch('https://list/export');
      if (!r.ok) throw new Error('todo ' + r.status);
      return taskRows((await r.json()).items);
    },
    cooking: async () => {
      if (!env.KITCHEN_CODE || !env.KITCHEN_STORE) return [];
      const r = await kitchen(env, env.KITCHEN_CODE, '/export');
      if (r.status !== 200) throw new Error('kitchen ' + r.status);
      return cookingRows(r.data, today);
    },
    prayer: async () => {
      const moods = {};
      const { results } = await env.HUB_DB.prepare('SELECT date, mood FROM mirror_days WHERE mood IS NOT NULL').all();
      for (const r of results || []) moods[r.date] = r.mood;
      const cfg = JSON.parse((await readConfig(env, ['mirror_feeling'])).mirror_feeling || 'null');
      if (cfg && env.FEELING) {
        const r = await env.FEELING.fetch('https://feeling-circle/api/circle/' + cfg.code);
        if (r.ok) Object.assign(moods, moodsOf((await r.json()).members, cfg.id));
      }
      return prayerRows(moods, today, now);
    },
    ranged: async () => {
      const cal = await env.HUB_KV.get(CAL_KEY, 'json');
      const { results } = await env.HUB_DB.prepare("SELECT payload FROM events WHERE type = 'dinner.away'").all();
      return rangedRows((cal && cal.events) || [], results || [], now);
    },
    magic: async () => magicRows((await env.HUB_KV.get(GERMAN_KEY, 'json')) || []),
    crafting: async () => {
      const { results } = await env.HUB_DB.prepare('SELECT id, at, text, outcome, updated_at FROM desk_log').all();
      return craftingRows(results || []);
    },
  };
  const names = Object.keys(jobs);
  const got = await Promise.allSettled(names.map((n) => jobs[n]()));
  const rows = [], failed = [];
  got.forEach((g, i) => (g.status === 'fulfilled' ? rows.push(...g.value) : failed.push(names[i])));
  const { results } = await env.HUB_DB.prepare('SELECT id FROM xp_log').all();
  const have = new Set((results || []).map((r) => r.id));
  const added = await grant(env, rows.filter((r) => !have.has(r.id)));
  await env.HUB_KV.put(SCAN_KEY, iso(now));
  return { added, failed };
}

/* ---------- Reading ---------- */

/* Pure: the skills tab from per-skill totals and today's gains. */
export function board(totals, todays) {
  const skills = SKILLS.map((s) => {
    const xp = totals[s.id] || 0;
    const level = levelOf(xp);
    return { id: s.id, name: s.name, from: s.from, xp, level, at: LEVEL_XP[level], next: level < 99 ? LEVEL_XP[level + 1] : null, today: todays[s.id] || 0 };
  });
  return { skills, total: skills.reduce((n, s) => n + s.level, 0), totalXp: skills.reduce((n, s) => n + s.xp, 0) };
}

export async function readBoard(env, now = Date.now(), logRows = LOG_SHOWN) {
  const start = iso(zoned(local(now).date));
  const [tot, tod, log] = await Promise.all([
    env.HUB_DB.prepare('SELECT skill, SUM(xp) AS xp FROM xp_log GROUP BY skill').all(),
    env.HUB_DB.prepare('SELECT skill, SUM(xp) AS xp FROM xp_log WHERE at >= ? GROUP BY skill').bind(start).all(),
    env.HUB_DB.prepare('SELECT skill, xp, at, what FROM xp_log ORDER BY at DESC, id DESC LIMIT ?').bind(logRows).all(),
  ]);
  const map = (r) => Object.fromEntries((r.results || []).map((x) => [x.skill, Number(x.xp) || 0]));
  return { ...board(map(tot), map(tod)), log: log.results || [], at: iso(now) };
}

async function fresh(env, now) {
  const last = Date.parse((await env.HUB_KV.get(SCAN_KEY)) || '');
  if (!(now - last < SCAN_EVERY)) await scan(env, now);
}

export async function hiscoresForMorning(env, now = Date.now()) {
  if (!env.HUB_DB) return null;
  await fresh(env, now);
  return readBoard(env, now, 5);
}

/* Strength: a gym visit, once a day. The Hiscores page's button and an iPhone Shortcuts
 * automation (arrive at the gym) both POST here. `say` is one line a Shortcut can show. */
export async function logGym(env, now = Date.now()) {
  const date = local(now).date;
  const added = await grant(env, [{ id: 'st:' + date, skill: 'strength', xp: XP.gym, at: iso(now), what: 'Gym visit' }]);
  const b = await readBoard(env, now, 0);
  const s = b.skills.find((x) => x.id === 'strength');
  return { added: added > 0, level: s.level, xp: s.xp, say: added ? `Strength +${XP.gym.toLocaleString('en-GB')} XP. Level ${s.level}.` : `Already logged today. Strength level ${s.level}.` };
}

export async function handleHiscores(request, env, rest, json, now = Date.now()) {
  if (!rest.length || rest.length > 2 || !CODE.test(rest[0])) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(rest[0], env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  if (rest.length === 2) {
    if (rest[1] !== 'gym') return json({ error: 'not found' }, request, 404);
    if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
    return json({ ok: true, ...(await logGym(env, now)) }, request);
  }
  if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
  await fresh(env, now);
  return json(await readBoard(env, now), request);
}

export async function hiscoresCron(env, now = Date.now()) {
  if (!env.HUB_DB || !env.TODO_CODE) return { skip: 'not configured' };
  return scan(env, now);
}
