// The Mirror: the daily rows from every source, the splits, the Sunday card. No network: every
// source is faked and Claude is swapped. All moods, tasks and dinners here are made up.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  isoWeekDate, doneByDay, dinnersByDay, moodsOf, resultsByDay, weatherByDay, calendarDay, buildRows,
  splits, strong, welch, score, scoreExperiment, weekCard, factsFor, numbersLine,
  collect, mirrorCron, weekFinding, mirrorFor, _setAsker, COLLECTED_KEY, WEEK_PREFIX,
} from '../src/mirror.js';
import { weekBlock } from '../src/week.js';
import { CONFIG } from '../src/dinner.js';
import { memNamespace } from './mem.js';
import { addDays, zoned } from '../src/morning.js';

const CODE = 'abcdefgh23456789';
const DAY = 864e5;
const SAT = Date.parse('2026-10-17T04:00:00Z'); // Saturday 06:00 in Amsterdam
const SUN = Date.parse('2026-10-18T05:00:00Z'); // Sunday 07:00
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
  return { db, prepare, async batch(list) { for (const s of list) await s.run(); return []; } };
}
const memKV = () => { const m = new Map(); return { m, async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } }; };
const fakeStore = (data) => ({ idFromName: (n) => n, get: () => ({ fetch: async () => Response.json(data) }) });

function env({ moods = {}, kitchenData = { items: {}, away: [] }, feelingDown = false } = {}) {
  const e = {
    TODO_LIST: memNamespace(), TODO_CODE: CODE, KITCHEN_CODE: 'kkkkkkkk23456789', KITCHEN_STORE: fakeStore(kitchenData),
    HUB_KV: memKV(), HUB_DB: memD1(), ANTHROPIC_API_KEY: 'k',
    FEELING: { fetch: async (url) => {
      if (feelingDown) return new Response('down', { status: 503 });
      assert.match(String(url), /\/api\/circle\/circle1$/);
      return Response.json({ members: [{ id: 'paulphone', name: 'P', days: moods }, { id: 'other', name: 'O', days: { '2026-10-16': 1 } }] });
    } },
  };
  e.HUB_DB.db.exec(`INSERT INTO config (key, value, updated_at) VALUES ('mirror_feeling', '{"code":"circle1","id":"paulphone"}', 'x')`);
  return e;
}
const noWeb = async (url) => {
  if (String(url).includes('open-meteo')) return Response.json({ daily: { time: ['2026-10-16', '2026-10-17'], temperature_2m_max: [14.2, 12], precipitation_sum: [0, 6.5], sunshine_duration: [18000, 3600] } });
  if (String(url).includes('espn')) return Response.json({ events: [] });
  throw new Error('no network: ' + url);
};

afterEach(() => _setAsker(null));

/* ---------- Sources ---------- */

test('ISO week and weekday to a date', () => {
  assert.equal(isoWeekDate('2026-W39', 'fri'), '2026-09-25');
  assert.equal(isoWeekDate('2026-W42', 'mon'), '2026-10-12');
  assert.equal(isoWeekDate('2026-W01', 'mon'), '2025-12-29'); // 4 Jan 2026 is a Sunday
  assert.equal(isoWeekDate('2026-W42', 'xyz'), null);
});

test('ticks per Amsterdam date, and the first date the list was used', () => {
  const late = Date.parse('2026-10-12T22:30:00Z'); // 00:30 on the 13th in Amsterdam
  const d = doneByDay({ a: { done: true, doneAt: late }, b: { done: true, doneAt: late + 1000 }, c: { done: false, doneAt: null }, x: { done: true, doneAt: Date.parse('2026-09-23T10:00:00Z') } });
  assert.deepEqual(d.days, { '2026-10-13': 2, '2026-09-23': 1 });
  assert.equal(d.first, '2026-09-23');
});

test("Paul's dinners only; Day's away dates are out", () => {
  const got = dinnersByDay({ items: [
    { type: 'day', id: '2026-W42:mon:paul:dinner', kind: 'recipe' },
    { type: 'day', id: '2026-W42:mon:olivia:dinner', kind: 'pizza' },
    { type: 'day', id: '2026-W42:tue:paul:lunch', kind: 'text' },
    { type: 'day', id: '2026-W42:wed:paul:dinner', kind: 'text' },
    { type: 'recipe', id: 'r1' },
  ], away: ['2026-10-14', '2026-10-16'] });
  assert.deepEqual(got.days, { '2026-10-12': 'recipe', '2026-10-14': 'out', '2026-10-16': 'out' });
  // the export's shape: one entry per calendar event; back again still counts as known
  const ex = dinnersByDay({ items: [{ type: 'day', id: '2026-W42:wed:paul:dinner', kind: 'text' }], away: { 'dinner:aa:2026-10-13': { date: '2026-10-13', away: false, seq: 2 }, 'dinner:bb:2026-10-12': { date: '2026-10-12', away: true, seq: 1 } } });
  assert.deepEqual(ex, { days: { '2026-10-14': 'text', '2026-10-12': 'out' }, known: ['2026-10-12', '2026-10-13'] });
});

test('moods for one member, results with shootouts, weather in hours', () => {
  assert.deepEqual(moodsOf([{ id: 'a', days: { '2026-10-01': 4, '2026-10-02': 9 } }, { id: 'b', days: { '2026-10-01': 1 } }], 'a'), { '2026-10-01': 4 });
  const ev = (date, us, them, usPens) => ({ date, competitions: [{ status: { type: { completed: true, state: 'post' } }, competitors: [
    { team: { id: '359' }, homeAway: 'home', score: { value: us, ...(usPens !== undefined ? { shootoutScore: usPens } : {}) } },
    { team: { id: '1', shortDisplayName: 'Them' }, homeAway: 'away', score: { value: them, ...(usPens !== undefined ? { shootoutScore: 3 } : {}) } }] }] });
  assert.deepEqual(resultsByDay({ events: [ev('2026-10-04T14:00Z', 2, 0), ev('2026-10-08T19:00Z', 1, 1, 4), ev('2026-10-11T19:00Z', 0, 1)] }), { '2026-10-04': 'W', '2026-10-08': 'W', '2026-10-11': 'L' });
  assert.deepEqual(weatherByDay({ daily: { time: ['2026-10-01'], temperature_2m_max: [13.4], precipitation_sum: [2.1], sunshine_duration: [15120] } }), { '2026-10-01': { temp: 13.4, rain: 2.1, sun: 4.2 } });
});

test('a calendar day: Arsenal fixtures left out, hours clipped to the day, first start', () => {
  const c = calendarDay([
    { title: 'Nottingham Forest vs Arsenal (A)', start: '2026-10-18T17:30:00+02:00', end: '2026-10-18T19:30:00+02:00', allDay: false },
    { title: 'Archery', start: '2026-10-18T08:30:00+02:00', end: '2026-10-18T10:00:00+02:00', allDay: false },
    { title: 'Late', start: '2026-10-18T23:00:00+02:00', end: '2026-10-19T01:00:00+02:00', allDay: false },
    { title: 'Birthday', start: '2026-10-18', end: '2026-10-19', allDay: true },
    { title: 'Other day', start: '2026-10-19T09:00:00+02:00', end: '2026-10-19T10:00:00+02:00', allDay: false },
  ], '2026-10-18');
  assert.deepEqual(c, { cal_n: 3, cal_h: 2.5, cal_first: 8.5 });
  assert.deepEqual(calendarDay([], '2026-10-18'), { cal_n: 0, cal_h: 0, cal_first: null });
});

test('rows: a failed source is NULL, days before the list are unknown, the calendar is today only', () => {
  const rows = buildRows({ done: { days: { '2026-10-16': 3 }, first: '2026-10-15' }, weather: { '2026-10-16': { temp: 14, rain: 0, sun: 5 } }, cal: [], arsenal: {} }, ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'], '2026-10-17');
  assert.deepEqual(rows.map((r) => r.done), [null, 0, 3, null]);
  assert.deepEqual(rows.map((r) => r.mood), [null, null, null, null]); // Feeling failed
  assert.deepEqual(rows.map((r) => r.cal_n), [null, null, null, 0]);
  assert.equal(rows[2].temp, 14);
  assert.equal(rows[3].temp, null); // today's weather is not over yet
});

test('the config key takes a circle code and an id, nothing else', () => {
  assert.equal(CONFIG.mirror_feeling('{"code":"abc123","id":"dev1","x":1}'), '{"code":"abc123","id":"dev1"}');
  assert.equal(CONFIG.mirror_feeling({ code: 'AB', id: 'x' }), null);
  assert.equal(CONFIG.mirror_feeling('not json'), null);
});

/* ---------- Splits ---------- */

/* 42 days: mood 4 or 5 on cooked days, 2 or 3 otherwise; everything else noise-free and flat. */
function planted() {
  const rows = [];
  for (let i = 0; i < 42; i++) {
    const date = addDays('2026-09-06', i);
    const cooked = i % 3 === 0;
    rows.push({ date, mood: cooked ? 4 + (i % 2) : 2 + (i % 2), done: 2 + (i % 4), dinner: cooked ? 'recipe' : 'text', arsenal: null, temp: 14, rain: 0, sun: 3, cal_n: null, cal_h: null, cal_first: null });
  }
  return rows;
}

test('Welch: a clear difference has a small p, the same numbers p 1', () => {
  const w = welch([4, 5, 4, 5, 4, 5], [2, 3, 2, 3, 2, 3]);
  assert.ok(w.p < 0.001 && w.d > 2);
  assert.equal(welch([3, 3, 3, 3], [3, 3, 3, 3]).p, 1);
});

test('angry counts as bad', () => {
  assert.equal(score(6), 2);
  assert.equal(score(5), 5);
  assert.equal(score(null), null);
});

test('the planted link comes out on top, with its numbers', () => {
  const all = splits(planted());
  const top = strong(all)[0];
  assert.equal(top.id, 'mood.cooked');
  assert.equal(top.yes.n, 14);
  assert.equal(top.no.n, 28);
  assert.ok(top.yes.mean > 4 && top.no.mean < 3);
  assert.ok(top.ctl);
  assert.match(numbersLine(top), /^Mood 4\.\d of 5 on days you cooked a recipe for dinner \(14 days\), 2\.\d of 5 on other days \(28 days\)$/);
  // a side with fewer than 4 days never shows up
  assert.ok(!all.some((s) => s.factor === 'match'));
  // tasks done is never split by itself
  assert.ok(!all.some((s) => s.id === 'done.productive'));
});

test('an experiment is scored on its own week against the four weeks before', () => {
  const rows = planted();
  const exp = { factor: 'cooked', want: 'more', target: 3, outcome: 'mood', from: '2026-10-11', to: '2026-10-17' };
  const s = scoreExperiment(exp, rows);
  assert.equal(s.hits, 2); // i = 36 and 39 fall in that week
  assert.equal(s.met, false);
  assert.equal(s.week.n, 7);
  assert.equal(s.before.n, 28);
  assert.equal(scoreExperiment({ ...exp, want: 'fewer' }, rows).met, true);
});

test('the card: Claude picks, the code keeps the numbers; without Claude a plain sentence', () => {
  const rows = planted();
  const answer = { pick: 'mood.cooked', finding: 'You tend to feel better on days you cook — about 4.5 against 2.5.', experiment: { factor: 'cooked', want: 'more', target: 4, text: 'Cook a recipe on 4 nights this week.' }, last: '' };
  const c = weekCard(rows, null, '2026-10-18', answer);
  assert.equal(c.finding.text, 'You tend to feel better on days you cook, about 4.5 against 2.5.'); // no dashes
  assert.equal(c.finding.id, 'mood.cooked');
  assert.deepEqual(c.experiment, { text: 'Cook a recipe on 4 nights this week.', factor: 'cooked', want: 'more', target: 4, outcome: 'mood', from: '2026-10-18', to: '2026-10-24' });
  const plain = weekCard(rows, null, '2026-10-18', null);
  assert.equal(plain.finding.text, 'Your mood tends to be higher on days you cooked a recipe for dinner.');
  assert.equal(plain.experiment, null);
  // a pick Claude made up falls back to the strongest
  assert.equal(weekCard(rows, null, '2026-10-18', { ...answer, pick: 'mood.nope' }).finding.id, 'mood.cooked');
});

test('too few days: no finding, and Claude is not asked', async () => {
  const flat = planted().slice(0, 5);
  assert.equal(factsFor(flat, null).candidates.length, 0);
  assert.equal(weekCard(flat, null, '2026-10-18', null).finding, null);
});

/* ---------- The cron ---------- */

async function tick(e, ops) {
  const stub = e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
  await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
}
const done = (id, at) => ({ op: 'upsert', item: { id, text: 'Task ' + id, section: 'today', done: true, doneAt: at, updatedAt: at, pos: at } });

test('first run writes 60 days back, later runs 7; a source that fails keeps what was there', async () => {
  const e = env({ moods: { '2026-10-16': 4, '2026-10-15': 6 }, kitchenData: { items: [{ type: 'day', id: '2026-W42:thu:paul:dinner', kind: 'recipe' }], away: ['2026-10-16'] } });
  await tick(e, [done('task00000001', Date.parse('2026-10-16T10:00:00Z')), done('task00000002', Date.parse('2026-10-16T11:00:00Z'))]);
  await e.HUB_KV.put('morning:calendar', JSON.stringify({ events: [{ title: 'Archery', start: '2026-10-17T10:00:00+02:00', end: '2026-10-17T12:00:00+02:00', allDay: false }] }));
  const r = await collect(e, SAT, noWeb);
  assert.equal(r.days, 61);
  assert.deepEqual(r.failed, []);
  const row = (d) => e.HUB_DB.db.prepare('SELECT * FROM mirror_days WHERE date = ?').get(d);
  assert.equal(row('2026-10-16').mood, 4);
  assert.equal(row('2026-10-16').done, 2);
  assert.equal(row('2026-10-16').dinner, 'out');
  assert.equal(row('2026-10-15').dinner, 'recipe');
  assert.equal(row('2026-10-15').mood, 6);
  assert.equal(row('2026-10-16').temp, 14.2);
  assert.equal(row('2026-10-17').cal_h, 2);
  assert.equal(row('2026-10-17').done, null);

  const e2 = { ...e, FEELING: { fetch: async () => new Response('down', { status: 503 }) } };
  const r2 = await collect(e2, SAT + DAY, noWeb);
  assert.equal(r2.days, 8);
  assert.deepEqual(r2.failed, ['mood']);
  assert.equal(row('2026-10-16').mood, 4); // kept
  assert.equal(row('2026-10-17').cal_h, 2); // yesterday's calendar kept

  // A week on, Kitchen has dropped the away entry for the 16th and shows the planned meal: still out.
  const e3 = { ...e, KITCHEN_STORE: fakeStore({ items: [{ type: 'day', id: '2026-W42:fri:paul:dinner', kind: 'recipe' }], away: {} }) };
  await collect(e3, SAT + 2 * DAY, noWeb);
  assert.equal(row('2026-10-16').dinner, 'out');
  // but a date whose entry says back again takes the meal
  e.HUB_DB.db.prepare("UPDATE mirror_days SET dinner = 'out' WHERE date = '2026-10-15'").run();
  const e4 = { ...e, KITCHEN_STORE: fakeStore({ items: [{ type: 'day', id: '2026-W42:thu:paul:dinner', kind: 'recipe' }], away: { 'dinner:cc:2026-10-15': { date: '2026-10-15', away: false, seq: 2 } } }) };
  await collect(e4, SAT + 2 * DAY, noWeb);
  assert.equal(row('2026-10-15').dinner, 'recipe');
});

test('the cron collects once a day from 05:00, then Sunday writes the card once', async () => {
  const e = env({ moods: {} });
  assert.deepEqual((await mirrorCron(e, Date.parse('2026-10-17T02:30:00Z'), noWeb)).collected, { skip: 'done today' }); // 04:30, too early
  assert.equal((await mirrorCron(e, SAT, noWeb)).collected.days, 61);
  assert.deepEqual((await mirrorCron(e, SAT + 3600e3, noWeb)).collected, { skip: 'done today' });
  assert.equal(await e.HUB_KV.get(COLLECTED_KEY), '2026-10-17');

  // Plant six weeks of rows, then let Sunday run.
  for (const r of planted()) {
    e.HUB_DB.db.prepare('INSERT OR REPLACE INTO mirror_days (date, mood, done, dinner, arsenal, temp, rain, sun, cal_n, cal_h, cal_first, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.date, r.mood, r.done, r.dinner, r.arsenal, r.temp, r.rain, r.sun, r.cal_n, r.cal_h, r.cal_first, 'x');
  }
  let asked = null;
  _setAsker(async (env2, facts) => { asked = facts; return { pick: facts.candidates[0].id, finding: 'You feel better on days you cook.', experiment: { factor: 'cooked', want: 'more', target: 4, text: 'Cook a recipe on 4 nights this week.' }, last: '' }; });
  const sun = await mirrorCron(e, SUN, async (url) => (String(url).includes('open-meteo') ? Response.json({ daily: { time: [] } }) : noWeb(url)));
  assert.deepEqual(sun.found, { written: true, claude: true });
  assert.ok(asked.candidates.length && asked.candidates.every((c) => typeof c.p === 'number'));
  assert.equal(asked.lastExperiment, null);
  const card = await mirrorFor(e, '2026-10-12');
  assert.equal(card.finding.text, 'You feel better on days you cook.');
  assert.equal(card.experiment.from, '2026-10-18');
  assert.deepEqual(await weekFinding(e, SUN + 900e3), { skip: 'written' });

  // Morning's week block carries it
  const w = await weekBlock(e, SUN);
  assert.equal(w.mirror.finding.id, card.finding.id);
});

test('next Sunday: last week\'s experiment comes back scored', async () => {
  const e = env();
  await e.HUB_KV.put(WEEK_PREFIX + '2026-10-12', JSON.stringify({ experiment: { text: 'Cook on 4 nights.', factor: 'cooked', want: 'more', target: 4, outcome: 'mood', from: '2026-10-18', to: '2026-10-24' } }));
  for (let i = 0; i < 7; i++) {
    const d = addDays('2026-10-18', i);
    e.HUB_DB.db.prepare('INSERT INTO mirror_days (date, mood, dinner, updated_at) VALUES (?, ?, ?, ?)').run(d, i < 4 ? 5 : 3, i < 4 ? 'recipe' : 'text', 'x');
  }
  await e.HUB_KV.put(COLLECTED_KEY, '2026-10-25');
  let asked = null;
  _setAsker(async (env2, facts) => { asked = facts; return null; }); // Claude down: the code's sentence
  const r = await weekFinding(e, SUN + 7 * DAY);
  assert.equal(r.claude, false);
  assert.equal(asked.lastExperiment.hits, 4);
  assert.equal(asked.lastExperiment.met, true);
  const card = await mirrorFor(e, '2026-10-19');
  assert.equal(card.last.text, 'You hit it: 4 of 7 days against a target of 4.');
  assert.equal(card.last.experiment, 'Cook on 4 nights.');
});

test('not Sunday, too early, or rows not in: nothing written', async () => {
  const e = env();
  assert.deepEqual(await weekFinding(e, SAT), { skip: 'not Sunday' });
  assert.deepEqual(await weekFinding(e, Date.parse('2026-10-18T03:00:00Z')), { skip: 'too early' });
  assert.deepEqual(await weekFinding(e, SUN), { skip: 'rows not in yet' });
  assert.equal(await mirrorFor(e, '2026-10-12'), null);
});
