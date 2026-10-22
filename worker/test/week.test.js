// Sunday reset: the Week block, its buttons, the snooze wake-up and the Sunday push.
// No network; D1 is node:sqlite running the real migrations. Every name is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { todoTaskId } from '../src/hub.js';
import { CONFIG } from '../src/dinner.js';
import { isoWeek, mondayOf, mondayAhead, inQuiet, pushDue, pushText, weekBlock, actOnWeek, wakeSnoozes, sundayPush, PUSHED_KEY } from '../src/week.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const ADMIN = 'admin-token-for-tests';
const DAY = 864e5;
// Sunday 18 October 2026, 18:05 in Amsterdam (CEST).
const SUN = Date.parse('2026-10-18T16:05:00Z');
const DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));

function memD1() {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) db.exec(m);
  return {
    db,
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const o = {
        bind(...a) { args = a; return o; },
        async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; },
        async all() { return { results: st.all(...args) }; },
        async first() { return st.get(...args) ?? null; },
      };
      return o;
    },
  };
}
const memKV = () => {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async list() { return { keys: [] }; },
  };
};
const env = (over = {}) => ({ HUB_DB: memD1(), HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE, ADMIN_TOKEN: ADMIN, ...over });

const task = (id, text, section, updatedAt, done = null, extra = {}) =>
  ({ id, text, section, done: done !== null, doneAt: done, updatedAt: done ?? updatedAt, pos: updatedAt, ...extra });
async function seed(e, items, tombs = []) {
  const ops = items.map((item) => ({ op: 'upsert', item })).concat(tombs.map((id) => ({ op: 'delete', item: { id, updatedAt: SUN - DAY } })));
  const stub = e.TODO_LIST.get('todo:' + CODE);
  await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }) });
}
const read = async (e) => (await (await e.TODO_LIST.get('todo:' + CODE).fetch('https://list/export')).json());

const BASIC = [
  task('done000monday', 'Pay the rent', 'today', 0, Date.parse('2026-10-12T08:00:00Z')),
  task('done000friday', 'Renew the ID card', 'soon', 0, Date.parse('2026-10-16T10:00:00Z')),
  task('done000sunday', 'Frame the print', 'someday', 0, Date.parse('2026-10-18T09:00:00Z')),
  task('done0lastweek', 'Old win', 'today', 0, Date.parse('2026-10-11T20:00:00Z')),  // Sunday before: not this week
  task('quiet00031day', 'Cancel the old contract', 'soon', SUN - 31 * DAY),
  task('quiet00014day', 'Fix the hallway light', 'today', SUN - 14 * DAY),
  task('fresh00013day', 'Not quiet yet', 'someday', SUN - 13 * DAY - 3600000),
];

test('dates: week numbers, Mondays, quiet hours across midnight', () => {
  assert.equal(isoWeek('2026-10-12'), 42);
  assert.equal(isoWeek('2026-10-18'), 42);
  assert.equal(isoWeek('2027-01-01'), 53);
  assert.equal(isoWeek('2026-01-01'), 1);
  assert.equal(mondayOf('2026-10-18'), '2026-10-12');
  assert.equal(mondayOf('2026-10-12'), '2026-10-12');
  assert.equal(mondayAhead('2026-10-18', 1), '2026-10-19');
  assert.equal(inQuiet(23 * 60, '22:00-08:00'), true);
  assert.equal(inQuiet(7 * 60 + 59, '22:00-08:00'), true);
  assert.equal(inQuiet(8 * 60, '22:00-08:00'), false);
  assert.equal(inQuiet(13 * 60, '12:00-14:00'), true);
  assert.equal(inQuiet(13 * 60, null), false);
});

test('config: sunday_reset_time and quiet_hours are checked; quiet hours ship as 22:00-08:00', async () => {
  assert.equal(CONFIG.sunday_reset_time(' 18:00 '), '18:00');
  assert.equal(CONFIG.sunday_reset_time('24:00'), null);
  assert.equal(CONFIG.quiet_hours('22:00-08:00'), '22:00-08:00');
  assert.equal(CONFIG.quiet_hours('08:00-08:00'), null);
  const e = env();
  const set = (key, value) => worker.fetch(new Request('https://hub.example/api/admin/config/' + key, { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN }, body: JSON.stringify({ value }) }), e);
  assert.equal((await set('sunday_reset_time', '6pm')).status, 400);
  assert.match((await (await set('sunday_reset_time', '6pm')).json()).error, /like "18:00"/);
  assert.equal((await set('sunday_reset_time', '18:00')).status, 200);
  const all = await (await worker.fetch(new Request('https://hub.example/api/admin/config', { headers: { Authorization: 'Bearer ' + ADMIN } }), e)).json();
  assert.deepEqual(Object.keys(all.config), ['dinner_window', 'sunday_reset_time', 'quiet_hours', 'mirror_feeling', 'letter_portals']);
  assert.deepEqual([all.config.dinner_window, all.config.sunday_reset_time, all.config.quiet_hours], [null, '18:00', '22:00-08:00']);
});

test('done this week: Monday 00:00 to now, grouped Today, Soon, Someday, newest first', async () => {
  const e = env();
  await seed(e, BASIC);
  const w = await weekBlock(e, SUN);
  assert.equal(w.week, 42);
  assert.equal(w.from, '2026-10-12');
  assert.equal(w.to, '2026-10-18');
  assert.equal(w.done.count, 3);
  assert.deepEqual(w.done.groups, [
    { section: 'today', items: [{ text: 'Pay the rent', day: 'Mon' }] },
    { section: 'soon', items: [{ text: 'Renew the ID card', day: 'Fri' }] },
    { section: 'someday', items: [{ text: 'Frame the print', day: 'Sun' }] },
  ]);
});

test('gone quiet: open tasks untouched 14 days or more, oldest first', async () => {
  const e = env();
  await seed(e, BASIC);
  const w = await weekBlock(e, SUN);
  assert.deepEqual(w.quiet.map((q) => [q.id, q.days, q.section]), [['quiet00031day', 31, 'soon'], ['quiet00014day', 14, 'today']]);
});

test('every section can be empty', async () => {
  const w = await weekBlock(env(), SUN);
  assert.deepEqual([w.done.count, w.done.groups, w.quiet, w.vacancies, w.next.events], [0, [], [], [], []]);
  assert.equal(w.next.stale, true);
});

test('new vacancies: tasks the digest rule made this week, open, done or deleted, with links', async () => {
  const e = env();
  const ev = (id, at, title) => e.HUB_DB.db.prepare("INSERT INTO events (id, source, type, summary, payload, at) VALUES (?, 'defence-digest', 'vacancy.found', ?, ?, ?)")
    .run(id, title, JSON.stringify({ title, organisation: 'Ministry', link: 'https://jobs.example/' + id, deadline: '2026-10-30' }), at);
  ev('vac-open-0001', '2026-10-13T05:00:00.000Z', 'Policy officer');
  ev('vac-done-0002', '2026-10-14T05:00:00.000Z', 'Analyst');
  ev('vac-gone-0003', '2026-10-15T05:00:00.000Z', 'Researcher');
  ev('vac-old-00004', '2026-10-09T05:00:00.000Z', 'Last week');
  ev('vac-none-0005', '2026-10-16T05:00:00.000Z', 'Never became a task');
  const [a, b, c, d] = await Promise.all(['vac-open-0001', 'vac-done-0002', 'vac-gone-0003', 'vac-old-00004'].map(todoTaskId));
  await seed(e, [
    task(a, 'Apply: Policy officer (Ministry) · 2026-10-30', 'soon', Date.parse('2026-10-13T05:00:00Z'), null, { link: 'https://jobs.example/vac-open-0001' }),
    task(b, 'Apply: Analyst (Ministry) · 2026-10-30', 'soon', 0, Date.parse('2026-10-16T05:00:00Z')),
    task(d, 'Apply: Last week (Ministry)', 'soon', Date.parse('2026-10-09T05:00:00Z')),
  ], [c]);
  const w = await weekBlock(e, SUN);
  assert.deepEqual(w.vacancies, [
    { id: a, text: 'Apply: Policy officer (Ministry) · 2026-10-30', link: 'https://jobs.example/vac-open-0001', state: 'open' },
    { id: b, text: 'Apply: Analyst (Ministry) · 2026-10-30', link: 'https://jobs.example/vac-done-0002', state: 'done' },
    { id: c, text: 'Apply: Researcher (Ministry) · 2026-10-30', link: 'https://jobs.example/vac-gone-0003', state: 'deleted' },
  ]);
});

test('next week: Day events Monday to Sunday ahead, titles and times only, first day each shows', async () => {
  const e = env();
  await e.HUB_KV.put('morning:calendar', JSON.stringify({ sent: '2026-10-18T18:00:00+02:00', received: new Date(SUN - 60000).toISOString(), events: [
    { title: 'Archery', start: '2026-10-19T19:00:00+02:00', end: '2026-10-19T21:00:00+02:00', allDay: false, location: 'Club' },
    { title: 'Tonight, not next week', start: '2026-10-18T20:00:00+02:00', end: '2026-10-18T22:00:00+02:00', allDay: false, location: '' },
    { title: 'Away in Rotterdam', start: '2026-10-21', end: '2026-10-23', allDay: true, location: '' },
    { title: 'Call home', start: '2026-10-25T11:00:00+01:00', end: '2026-10-25T11:30:00+01:00', allDay: false, location: '' },
    { title: 'Week after', start: '2026-10-26T09:00:00+01:00', end: '2026-10-26T10:00:00+01:00', allDay: false, location: '' },
  ] }));
  const w = await weekBlock(e, SUN);
  assert.equal(w.next.from, '2026-10-19');
  assert.equal(w.next.to, '2026-10-25');
  assert.equal(w.next.stale, false);
  assert.deepEqual(w.next.events, [
    { date: '2026-10-19', day: 'Mon', time: '19:00', title: 'Archery' },
    { date: '2026-10-21', day: 'Wed', time: 'all day', title: 'Away in Rotterdam' },
    { date: '2026-10-25', day: 'Sun', time: '11:00', title: 'Call home' },  // after the clocks go back
  ]);
});

test('Do this week: to the top of Soon, off Gone quiet; Undo puts it back with its old age', async () => {
  const e = env();
  await seed(e, BASIC);
  const out = await actOnWeek(e, { id: 'quiet00014day', action: 'soon' }, SUN);
  let t = (await read(e)).items.quiet00014day;
  assert.equal(t.section, 'soon');
  assert.equal(t.pos, SUN);
  assert.ok(!out.week.quiet.some((q) => q.id === 'quiet00014day'));
  const back = await actOnWeek(e, { id: 'quiet00014day', action: 'undo' }, SUN + 3000);
  t = (await read(e)).items.quiet00014day;
  assert.equal(t.section, 'today');
  assert.equal(t.pos, SUN - 14 * DAY);
  assert.deepEqual(back.week.quiet.find((q) => q.id === 'quiet00014day').days, 14);
  // A second undo has nothing to take back.
  assert.equal((await actOnWeek(e, { id: 'quiet00014day', action: 'undo' }, SUN + 4000)).status, 404);
  // Once Paul really touches it, the restored mark is tidied and its clock is the real one.
  await seed(e, [{ ...t, text: 'Fix the hallway light today', updatedAt: SUN + 5000 }]);
  await wakeSnoozes(e, SUN + 6000);
  assert.equal(e.HUB_DB.db.prepare('SELECT COUNT(*) AS n FROM week_marks').get().n, 0);
});

test('this week: flagged open tasks; Keep holds the flag and leaves the list, Unflag takes it off with Undo', async () => {
  const e = env();
  await seed(e, [
    task('flagged00001', 'Book the flights', 'soon', SUN - DAY, null, { week: true }),
    task('flagged00002', 'Call the plumber', 'today', SUN - 2 * DAY, null, { week: true }),
    task('flagdone0001', 'Done and flagged', 'soon', SUN - DAY, SUN - 3600000, { week: true }),
    task('plain0000001', 'Not flagged', 'soon', SUN - DAY),
  ]);
  let w = await weekBlock(e, SUN);
  assert.deepEqual(w.thisWeek.map((x) => x.id), ['flagged00001', 'flagged00002']);
  assert.deepEqual(w.thisWeek[0], { id: 'flagged00001', text: 'Book the flights', section: 'soon' });

  const kept = await actOnWeek(e, { id: 'flagged00001', action: 'keep' }, SUN);
  assert.deepEqual(kept.week.thisWeek.map((x) => x.id), ['flagged00002']);
  assert.equal((await read(e)).items.flagged00001.week, true);

  const off = await actOnWeek(e, { id: 'flagged00002', action: 'unflag' }, SUN + 1000);
  assert.deepEqual(off.week.thisWeek, []);
  assert.equal((await read(e)).items.flagged00002.week, undefined);
  await actOnWeek(e, { id: 'flagged00002', action: 'undo' }, SUN + 2000);
  assert.equal((await read(e)).items.flagged00002.week, true);

  // Next Sunday the kept one shows again.
  w = await weekBlock(e, SUN + 7 * DAY);
  assert.ok(w.thisWeek.some((x) => x.id === 'flagged00001'));
  assert.equal((await actOnWeek(e, { id: 'flagdone0001', action: 'unflag' }, SUN)).status, 404);
});

test('Undo after another change leaves the newer change alone', async () => {
  const e = env();
  await seed(e, BASIC);
  await actOnWeek(e, { id: 'quiet00031day', action: 'soon' }, SUN);
  const t = (await read(e)).items.quiet00031day;
  await seed(e, [{ ...t, section: 'today', updatedAt: SUN + 1000 }]);
  await actOnWeek(e, { id: 'quiet00031day', action: 'undo' }, SUN + 2000);
  assert.equal((await read(e)).items.quiet00031day.section, 'today');
});

test('New date: off Gone quiet until its Monday, then into Today; Undo takes the date back', async () => {
  const e = env();
  await seed(e, BASIC);
  const a = await actOnWeek(e, { id: 'quiet00031day', action: 'later1' }, SUN);
  assert.equal(a.until, '2026-10-26');
  assert.equal((await actOnWeek(e, { id: 'quiet00014day', action: 'later2' }, SUN)).until, '2026-11-02');
  assert.ok(!a.week.quiet.some((q) => q.id === 'quiet00031day'));
  assert.equal((await read(e)).items.quiet00031day.updatedAt, SUN - 31 * DAY); // the task itself is untouched
  // The day before: nothing moves.
  assert.equal((await wakeSnoozes(e, Date.parse('2026-10-25T20:00:00Z'))).woke, 0);
  // Monday 26 Oct, just after midnight in Amsterdam.
  const mon = Date.parse('2026-10-25T23:08:00Z');
  assert.equal((await wakeSnoozes(e, mon)).woke, 1);
  const t = (await read(e)).items.quiet00031day;
  assert.equal(t.section, 'today');
  assert.equal(t.updatedAt, mon);
  // Undo of a date simply drops it.
  await actOnWeek(e, { id: 'quiet00014day', action: 'undo' }, SUN + 1000);
  assert.ok((await weekBlock(e, SUN + 2000)).quiet.some((q) => q.id === 'quiet00014day'));
});

test('Delete removes the task for good, and its marks', async () => {
  const e = env();
  await seed(e, BASIC);
  await actOnWeek(e, { id: 'quiet00031day', action: 'later4' }, SUN);
  const out = await actOnWeek(e, { id: 'quiet00031day', action: 'delete' }, SUN + 1000);
  const doc = await read(e);
  assert.equal(doc.items.quiet00031day, undefined);
  assert.ok(doc.tombs.quiet00031day >= SUN);
  assert.ok(!out.week.quiet.some((q) => q.id === 'quiet00031day'));
  assert.equal(e.HUB_DB.db.prepare('SELECT COUNT(*) AS n FROM week_marks').get().n, 0);
});

test('bad requests are refused', async () => {
  const e = env();
  await seed(e, BASIC);
  assert.equal((await actOnWeek(e, { id: 'BAD', action: 'soon' }, SUN)).status, 400);
  assert.equal((await actOnWeek(e, { id: 'quiet00031day', action: 'later3' }, SUN)).status, 400);
  assert.equal((await actOnWeek(e, { id: 'done000monday', action: 'soon' }, SUN)).status, 404);
  assert.equal((await actOnWeek(e, { id: 'nosuchtask01', action: 'later1' }, SUN)).status, 404);
});

test('the routes: week on Sundays only (or ?week=1), and the buttons behind the list code', async () => {
  const e = env();
  await seed(e, BASIC);
  const get = (q = '') => worker.fetch(new Request('https://hub.example/api/morning/' + CODE + q), e);
  // The route uses the real clock, so only the shape can be checked here; the block has its own tests.
  const today = await (await get()).json();
  assert.ok('week' in today);
  const asked = await (await get('?week=1')).json();
  assert.equal(asked.week.quiet.length >= 1, true);
  const post = (code, body) => worker.fetch(new Request('https://hub.example/api/morning/' + code + '/week', { method: 'POST', body: JSON.stringify(body) }), e);
  assert.equal((await post('zzzzzzzzzzzzzzzz', { id: 'quiet00031day', action: 'soon' })).status, 404);
  const r = await post(CODE, { id: 'quiet00031day', action: 'soon' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.week.quiet));
});

test('the push: Sunday, after its time, outside quiet hours, once', () => {
  const l = (date, hhmm, weekday = 0) => ({ date, weekday, minutes: +hhmm.slice(0, 2) * 60 + +hhmm.slice(3) });
  const cfg = { sunday_reset_time: '18:00', quiet_hours: '22:00-08:00' };
  assert.equal(pushDue(l('2026-10-17', '18:10', 6), cfg, null), 'not Sunday');
  assert.equal(pushDue(l('2026-10-18', '18:10'), { quiet_hours: '22:00-08:00' }, null), 'no time set');
  assert.equal(pushDue(l('2026-10-18', '17:53'), cfg, null), 'too early');
  assert.equal(pushDue(l('2026-10-18', '18:08'), cfg, null), '');
  assert.equal(pushDue(l('2026-10-18', '18:23'), cfg, '2026-10-18'), 'sent');
  // Set inside quiet hours: held until they end, which is Monday, so that week has none.
  assert.equal(pushDue(l('2026-10-18', '23:08'), { ...cfg, sunday_reset_time: '23:00' }, null), 'quiet hours');
  // Set early: held until 08:00, then it goes.
  assert.equal(pushDue(l('2026-10-18', '07:53'), { ...cfg, sunday_reset_time: '07:00' }, null), 'quiet hours');
  assert.equal(pushDue(l('2026-10-18', '08:08'), { ...cfg, sunday_reset_time: '07:00' }, null), '');
});

test('the push words', () => {
  const w = (d, q, v) => ({ done: { count: d }, quiet: Array(q).fill({}), vacancies: Array(v).fill({}) });
  assert.deepEqual(pushText(w(12, 4, 2)), { title: 'Your week is ready', message: '12 done, 4 gone quiet, 2 new vacancies. Open Morning.' });
  assert.equal(pushText(w(1, 0, 1)).message, '1 done, 1 new vacancy. Open Morning.');
  assert.equal(pushText(w(0, 0, 0)).message, 'A quiet week. Open Morning.');
});

test('sundayPush sends one ntfy message with no link, retries after a failure, then stops', async () => {
  const e = env({ NTFY_TOPIC: 'topic-for-tests' });
  await seed(e, BASIC);
  await e.HUB_DB.prepare("INSERT INTO config (key, value, updated_at) VALUES ('sunday_reset_time', '18:00', 'x')").run();
  const sent = [];
  let okNext = false;
  const fetcher = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: okNext, status: okNext ? 200 : 503 }; };
  assert.deepEqual(await sundayPush(e, SUN, fetcher), { skip: 'ntfy 503' });
  assert.equal(e.HUB_KV.m.get(PUSHED_KEY), undefined);
  okNext = true;
  const out = await sundayPush(e, SUN + 15 * 60000, fetcher);
  assert.equal(out.sent.message, '3 done, 2 gone quiet. Open Morning.');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].topic, 'topic-for-tests');
  assert.equal(sent[1].click, undefined);
  assert.ok(!JSON.stringify(sent[1]).includes(CODE));
  assert.equal(e.HUB_KV.m.get(PUSHED_KEY), '2026-10-18');
  assert.deepEqual(await sundayPush(e, SUN + 30 * 60000, fetcher), { skip: 'sent' });
  assert.equal(sent.length, 2);
});

test('the cron: the Sunday reset every run, the hourly jobs only at :23', async () => {
  const e = env();
  let settled;
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-18T16:08:00Z') }, e, { waitUntil: (p) => { settled = p; } });
  const r = await settled;
  assert.equal(r.length, 11); // the Sunday reset, Waiting on chases, the Dread meter's timer, dates into Today, Door's reminders, the Mirror, the once-only intake catch-up and Others retirement, the lessons, the Network map's Reach out tasks, Skills roles past their closing date
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-18T16:23:00Z') }, e, { waitUntil: (p) => { settled = p; } });
  assert.equal((await settled).length, 14);
});
