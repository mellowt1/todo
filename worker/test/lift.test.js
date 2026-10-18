// Lift: the summary is cleaned, gym days pay Strength once (shared with the gym button), the
// feed hears only about recent workouts and only once, Morning's block, the route and the backup.
// No network. Every routine name and number is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { cleanSummary, strengthRows, feedLine, handleLift, liftForMorning } from '../src/lift.js';
import { readBoard, logGym } from '../src/hiscores.js';

const CODE = 'abcdefgh23456789';
const SUN = Date.parse('2026-10-18T10:00:00Z'); // Sunday 12:00 in Amsterdam
const H = 3600e3, DAY = 24 * H;
const DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));

function memD1() {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) db.exec(m);
  const prepare = (sql) => {
    const st = db.prepare(sql);
    let args = [];
    const o = {
      bind(...a) { args = a; return o; },
      async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; },
      async all() { return { results: st.all(...args) }; },
      async first() { return st.get(...args) ?? null; },
    };
    return o;
  };
  return { db, prepare, async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}
const memKV = () => {
  const m = new Map();
  return {
    m,
    async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
  };
};
const json = (data, request, status = 200) => Response.json(data, { status });
const env = () => ({ TODO_CODE: CODE, HUB_KV: memKV(), HUB_DB: memD1() });

const w = (id, name, start, mins = 60, volume = 9000, prs = 0) => ({ id, name, start, end: start + mins * 60e3, volume, sets: 18, prs });
const summary = (workouts) => ({
  next: { name: 'Back', items: [{ name: 'Lat Pulldown (Cable)', sets: 4, range: '8–10', kg: 40, up: false }, { name: 'Dumbbell Row', sets: 3, range: '15–20', kg: 34, up: true }] },
  nextDay: '2026-10-18',
  rotation: ['Back', 'Chest', 'Shoulders'],
  days: [true, false, true, false, false, false, true],
  workouts,
});
const call = (e, path, method = 'GET', body) => handleLift(new Request('https://x/api/lift/' + path, { method, body: body && JSON.stringify(body) }), e, path.split('/'), json, SUN);

test('summary is cleaned to known shapes', () => {
  const s = cleanSummary({ next: { name: ' Back ', items: [{ name: 'Row', sets: 3.4, kg: 'heavy', up: 1 }, { name: '' }] }, nextDay: 'soon', days: [1, 0], workouts: [{ id: 'a', start: 'x' }, w('b', 'Chest', SUN - DAY)] });
  assert.deepEqual(s.next, { name: 'Back', items: [{ name: 'Row', sets: 3, range: '', kg: null, up: true }] });
  assert.equal(s.nextDay, null);
  assert.deepEqual(s.days, [true, false, false, false, false, false, false]);
  assert.deepEqual(s.workouts.map((x) => x.id), ['b'], 'a workout without a real start is dropped');
  assert.equal(cleanSummary(null).error, 'summary required');
});

test('one Strength row per gym day, in Amsterdam time', () => {
  const late = Date.parse('2026-10-17T22:30:00Z'); // Sunday 00:30 in Amsterdam
  const rows = strengthRows([w('a', 'Back', late), w('b', 'Back again', late + H), w('c', 'Chest', late - DAY)]);
  assert.deepEqual(rows.map((r) => r.id), ['st:2026-10-18', 'st:2026-10-17']);
  assert.equal(rows[0].what, 'Gym: Back');
  assert.equal(feedLine(w('x', 'Back', SUN, 60, 9840, 2)), 'Back done · 9,840 kg · 2 PRs');
  assert.equal(feedLine(w('x', 'Back', SUN, 60, 0, 1)), 'Back done · 1 PR');
});

test('POST pays Strength once a day, shared with the gym button', async () => {
  const e = env();
  await logGym(e, SUN - 2 * H); // the Shortcut already logged today
  const list = [w('t', 'Back', SUN - 2 * H), w('y', 'Shoulders', SUN - DAY), w('o', 'Chest', SUN - 30 * DAY)];
  const first = await (await call(e, CODE, 'POST', { summary: summary(list), backup: { app: 'lift', workouts: [] } })).json();
  assert.equal(first.ok, true);
  assert.equal(first.xp, 2, 'yesterday and a month ago pay; today was paid by the button');
  const again = await (await call(e, CODE, 'POST', { summary: summary(list) })).json();
  assert.equal(again.xp, 0);
  const b = await readBoard(e, SUN);
  assert.equal(b.skills.find((x) => x.id === 'strength').xp, 3000);
});

test('the feed hears about recent workouts once, never about old history', async () => {
  const e = env();
  const list = [w('t', 'Back', SUN - 2 * H, 60, 9840, 2), w('o', 'Chest', SUN - 10 * DAY)];
  assert.equal((await (await call(e, CODE, 'POST', { summary: summary(list) })).json()).feed, 1);
  assert.equal((await (await call(e, CODE, 'POST', { summary: summary(list) })).json()).feed, 0);
  const lines = [...e.HUB_KV.m.entries()].filter(([k]) => k.startsWith('event:')).map(([, v]) => JSON.parse(v));
  assert.deepEqual(lines.map((l) => [l.source, l.kind, l.text]), [['lift', 'workout', 'Back done · 9,840 kg · 2 PRs']]);
});

test('Morning: next routine, today, the week and the last workout', async () => {
  const e = env();
  assert.equal(await liftForMorning(e, SUN), null, 'nothing until Lift has sent once');
  const sat = Date.parse('2026-10-17T17:12:00Z');
  await call(e, CODE, 'POST', { summary: summary([w('s', 'Shoulders', sat, 76, 8200, 1), w('m', 'Chest', Date.parse('2026-10-12T17:00:00Z')), w('old', 'Back', Date.parse('2026-10-08T17:00:00Z'))]) });
  const m = await liftForMorning(e, SUN);
  assert.equal(m.next.name, 'Back');
  assert.equal(m.today, true, 'Sunday is the next gym day and nothing is logged yet');
  assert.deepEqual(m.week, { done: 2, planned: 3 });
  assert.deepEqual(m.last, { name: 'Shoulders', date: '2026-10-17', minutes: 76, volume: 8200, prs: 1 });
  assert.equal(m.doneToday, null);
});

test('route: code, methods, backup', async () => {
  const e = env();
  assert.equal((await call(e, 'wrongcode1234567')).status, 404);
  assert.equal((await call(e, 'short')).status, 400);
  assert.equal((await call(e, CODE + '/backup')).status, 404, 'no backup yet');
  assert.equal((await call(e, CODE, 'POST', { nope: 1 })).status, 400);
  assert.equal((await call(e, CODE, 'PUT')).status, 405);
  await call(e, CODE, 'POST', { summary: summary([]), backup: { app: 'lift', workouts: [{ id: 'z' }] } });
  const got = await (await call(e, CODE)).json();
  assert.equal(got.summary.next.name, 'Back');
  assert.ok(got.backupSize > 0);
  const back = await (await call(e, CODE + '/backup')).json();
  assert.deepEqual(back.data, { app: 'lift', workouts: [{ id: 'z' }] });
});
