// The Dread meter: one timer, a 1 to 5 rating, settling, the drained ranking and the Sunday card.
// No network; D1 is node:sqlite running every migration, the list is the real Durable Object in
// memory. Every name here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { minutes, runningFrom, settleAction, dreadWeek, dreadCron, MAX_HOURS } from '../src/dread.js';
import { pickPool } from '../src/energy.js';
import { cleanOp, applyOps, emptyDoc } from '../src/todo.js';
import { weekBlock } from '../src/week.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const DAY_SECRET = 'day-secret-for-tests';
const MIN = 60000;
const HOUR = 60 * MIN;
// Thursday 22 October 2026, 11:00 in Amsterdam (CEST).
const NOW = Date.parse('2026-10-22T09:00:00Z');
const DIR = new URL('../migrations/', import.meta.url);

function memD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, DIR), 'utf8'));
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
function memKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }; },
  };
}
const env = (over = {}) => ({
  HUB_DB: memD1(), HUB_QUEUE: { async sendBatch() {} }, HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE,
  HUB_SECRET_DAY: DAY_SECRET, ...over,
});
const stub = (e) => e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
const task = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: NOW - 3 * HOUR, pos: NOW - 10 * HOUR, ...extra });
async function seed(e, items) {
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: items.map((item) => ({ op: 'upsert', item })) }) });
}
const list = async (e) => (await (await stub(e).fetch('https://list/export')).json()).items;
const events = (e, type) => e.HUB_DB.db.prepare('SELECT type, source, payload, at FROM events WHERE type LIKE ? ORDER BY at, rowid').all(type || 'dread.%');

// The routes run on a fixed clock: Date.now is moved for each call.
async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
}
const call = (e, path, body, ms = NOW, headers = {}) => at(ms, async () => {
  const r = await worker.fetch(new Request('https://hub.example/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
  return { status: r.status, body: await r.json() };
});
const dread = (e, sub, body, ms) => call(e, 'dread/' + CODE + (sub ? '/' + sub : ''), body, ms);
const day = (e, sub, body, ms) => call(e, 'hub/dread/day' + (sub ? '/' + sub : ''), body, ms, { Authorization: 'Bearer ' + DAY_SECRET });

const T1 = 'task0000lucho01';
const T2 = 'task0000lamp002';

test('minutes: whole, at least 1, capped at four hours', () => {
  const s = new Date(NOW).toISOString();
  assert.equal(minutes(s, NOW + 20000), 1);
  assert.equal(minutes(s, NOW + 6 * MIN + 10000), 6);
  assert.equal(minutes(s, NOW + 9 * HOUR), MAX_HOURS * 60);
});

test('runningFrom: only a start or an undo runs; the newest rating since wins', () => {
  const p = (o) => JSON.stringify(o);
  const s = new Date(NOW).toISOString();
  assert.equal(runningFrom(null), null);
  assert.equal(runningFrom({ type: 'dread.done', payload: p({ task: T1, startedAt: s }) }), null);
  const run = runningFrom({ type: 'dread.started', source: 'todo', payload: p({ task: T1, startedAt: s, dread: null, level: 'drained' }) },
    { payload: p({ task: T1, startedAt: s, dread: 4 }) });
  assert.deepEqual(run, { task: T1, startedAt: s, dread: 4, level: 'drained', source: 'todo' });
});

test('settleAction: ticked is done at doneAt, deleted is stopped, four hours stops counting', () => {
  const run = { task: T1, startedAt: new Date(NOW).toISOString() };
  assert.deepEqual(settleAction(run, task(T1, 'x', 'today', { done: true, doneAt: NOW + 5 * MIN }), NOW + 9 * MIN), { type: 'dread.done', end: NOW + 5 * MIN });
  assert.deepEqual(settleAction(run, undefined, NOW + MIN), { type: 'dread.stopped', why: 'gone', end: NOW + MIN });
  assert.equal(settleAction(run, task(T1, 'x', 'today'), NOW + 3 * HOUR), null);
  assert.equal(settleAction(run, task(T1, 'x', 'today'), NOW + 4 * HOUR).why, 'timeout');
  // ticked before the timer started (an old done): not this run's done
  assert.equal(settleAction(run, task(T1, 'x', 'today', { done: true, doneAt: NOW - HOUR }), NOW + MIN), null);
});

test('the task field: dread 1 to 5 is kept like link, anything else drops the op', () => {
  const base = task(T1, 'Ticket for Lucho', 'today');
  assert.equal(cleanOp({ op: 'upsert', item: { ...base, dread: 4 } }, NOW).item.dread, 4);
  assert.equal(cleanOp({ op: 'upsert', item: { ...base, dread: 6 } }, NOW), null);
  assert.equal(cleanOp({ op: 'upsert', item: { ...base, dread: '4' } }, NOW), null);
  const doc = emptyDoc();
  applyOps(doc, [cleanOp({ op: 'upsert', item: { ...base, dread: 5 } }, NOW)]);
  applyOps(doc, [cleanOp({ op: 'upsert', item: { ...base, text: 'Ticket for Lucho November', updatedAt: NOW - HOUR } }, NOW)]);
  assert.equal(doc.items[T1].dread, 5);
  applyOps(doc, [cleanOp({ op: 'upsert', item: { ...base, dread: null, updatedAt: NOW - MIN } }, NOW)]);
  assert.equal(doc.items[T1].dread, undefined);
});

test('drained: tasks last rated 4 or 5 go last, still in the pool; other levels ignore dread', () => {
  const items = {
    a: task('aaaaaaaa', 'Return the lamp', 'today', { energy: 'drained', dread: 5 }),
    b: task('bbbbbbbb', 'Text Sam back', 'soon', { energy: 'drained', dread: 2 }),
    c: task('cccccccc', 'Nick: send the photos', 'today', { energy: 'drained' }),
  };
  assert.deepEqual(pickPool(items, 'drained').map((r) => r.it.id), ['bbbbbbbb', 'cccccccc', 'aaaaaaaa']);
  for (const it of Object.values(items)) it.energy = 'wired';
  assert.deepEqual(pickPool(items, 'wired').map((r) => r.it.id), ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
});

test('start, rate, tick: done with the minutes; the rating lands on the task', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today'), task(T2, 'Return the lamp', 'soon')]);
  let r = await dread(e, 'start', { task: T1, source: 'todo' });
  assert.equal(r.status, 200);
  assert.equal(r.body.running.task, T1);
  assert.equal(r.body.running.name, 'Ticket for Lucho November');
  assert.equal(r.body.running.dread, null);

  r = await dread(e, 'rate', { task: T1, dread: 4, source: 'morning' }, NOW + MIN);
  assert.equal(r.body.running.dread, 4);
  assert.equal((await list(e))[T1].dread, 4);

  r = await dread(e, '', undefined, NOW + 3 * MIN);
  assert.equal(r.body.running.mins, 3);
  assert.equal(r.body.running.dread, 4);

  r = await dread(e, 'stop', { done: true, source: 'todo' }, NOW + 6 * MIN);
  assert.deepEqual(r.body.stopped, { task: T1, mins: 6, dread: 4, done: true, name: 'Ticket for Lucho November' });
  assert.equal(r.body.running, null);
  assert.equal((await dread(e, '')).body.running, null);
  // ids only in the events, never the task's name
  for (const ev of events(e)) assert.ok(!ev.payload.includes('Lucho'));
});

test('starting another stops the first (a switch, not a skip); a rating with start is kept', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today'), task(T2, 'Return the lamp', 'soon')]);
  await dread(e, 'start', { task: T1, dread: 3, source: 'todo' });
  const r = await dread(e, 'start', { task: T2, dread: 5, source: 'todo' }, NOW + 10 * MIN);
  assert.equal(r.body.running.task, T2);
  assert.equal(r.body.stopped.task, T1);
  assert.equal(r.body.stopped.mins, 10);
  assert.equal(r.body.stopped.done, false);
  const types = events(e).map((x) => x.type);
  assert.deepEqual(types, ['dread.started', 'dread.stopped', 'dread.started']);
  assert.equal(JSON.parse(events(e)[1].payload).why, 'switch');
  assert.equal((await list(e))[T2].dread, 5);
  // the same task again only changes the rating
  const again = await dread(e, 'start', { task: T2, dread: 2, source: 'todo' }, NOW + 11 * MIN);
  assert.equal(again.body.running.dread, 2);
  assert.equal(events(e, 'dread.started').length, 2);
});

test('settling: a task ticked elsewhere is done at doneAt; a forgotten timer stops at four hours', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today'), task(T2, 'Return the lamp', 'today')]);
  await dread(e, 'start', { task: T1, dread: 5, source: 'todo' });
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today', { done: true, doneAt: NOW + 4 * MIN, updatedAt: NOW + 4 * MIN })]);
  const r = await dread(e, '', undefined, NOW + 30 * MIN);
  assert.equal(r.body.running, null);
  assert.equal(r.body.stopped.mins, 4);
  assert.equal(r.body.stopped.done, true);

  await dread(e, 'start', { task: T2, source: 'todo' }, NOW + HOUR);
  assert.deepEqual(await dreadCron(e, NOW + 6 * HOUR), { settled: 1 });
  const last = events(e).at(-1);
  assert.equal(last.type, 'dread.stopped');
  assert.equal(JSON.parse(last.payload).why, 'timeout');
  assert.equal(JSON.parse(last.payload).mins, 240);
});

test('undo after Done: the timer runs on from the same start', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today')]);
  await dread(e, 'start', { task: T1, dread: 4, source: 'todo' });
  await dread(e, 'stop', { done: true, source: 'todo' }, NOW + 2 * MIN);
  const r = await dread(e, 'undo', { task: T1, source: 'todo' }, NOW + 2 * MIN + 5000);
  assert.equal(r.body.running.task, T1);
  assert.equal(r.body.running.startedAt, new Date(NOW).toISOString());
  assert.equal(r.body.running.dread, 4);
  assert.equal((await dread(e, 'undo', { task: T1, source: 'todo' })).status, 409);
});

test('Day: the same routes with its secret, source day; no secret, no entry', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today')]);
  assert.equal((await call(e, 'hub/dread/day', undefined)).status, 401);
  const r = await day(e, 'start', { task: T1, dread: 2 });
  assert.equal(r.body.running.source, 'day');
  assert.equal((await day(e, '')).body.running.task, T1);
  assert.equal((await day(e, 'skip', { task: T1, why: 'moved' })).status, 404);
  assert.equal((await day(e, 'stop', {})).body.stopped.done, false);
});

test('bad input: unknown code, no source, a dread of 7, a task that is not open', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today', { done: true, doneAt: NOW - HOUR })]);
  assert.equal((await call(e, 'dread/zzzzzzzz12345678', undefined)).status, 404);
  assert.equal((await dread(e, 'start', { task: T1 })).status, 400);
  assert.equal((await dread(e, 'start', { task: T1, dread: 7, source: 'todo' })).status, 400);
  assert.equal((await dread(e, 'start', { task: T1, source: 'todo' })).status, 404);
  assert.equal((await dread(e, 'rate', { task: T1, dread: 3, source: 'todo' })).status, 409);
});

test('dreadWeek: lies are 4-5 done in 15 minutes or less, an undone done does not count, skips add up', () => {
  const s = (m) => new Date(NOW + m * MIN).toISOString();
  const ev = (type, payload) => ({ type, payload: JSON.stringify(payload) });
  const rows = [
    ev('dread.started', { task: 'a', startedAt: s(0) }),
    ev('dread.done', { task: 'a', startedAt: s(0), dread: 5, mins: 4, level: 'drained' }),
    ev('dread.started', { task: 'b', startedAt: s(10) }),
    ev('dread.done', { task: 'b', startedAt: s(10), dread: 4, mins: 30, level: 'normal' }),
    ev('dread.started', { task: 'c', startedAt: s(50) }),
    ev('dread.done', { task: 'c', startedAt: s(50), dread: 4, mins: 2, level: 'drained' }),
    ev('dread.undone', { task: 'c', startedAt: s(50) }),
    ev('dread.stopped', { task: 'c', startedAt: s(50), dread: 4, mins: 20, level: 'drained', why: 'stop' }),
    ev('dread.started', { task: 'd', startedAt: s(90) }),
    ev('dread.done', { task: 'd', startedAt: s(90), dread: 3, mins: 5, level: 'wired' }),
    ev('energy.skipped', { task: 'a' }), ev('waiting.snoozed', {}), ev('dread.skipped', { task: 'b', why: 'moved' }),
  ];
  const items = { a: task('a', 'Call the gemeente · 2026-10-20', 'today', { done: true }) };
  const w = dreadWeek(rows, items);
  assert.deepEqual(w.lies, [{ task: 'a', name: 'Call the gemeente', dread: 5, mins: 4 }]);
  assert.deepEqual(w.byLevel, { wired: 3, normal: 4, drained: 4.5 });
  assert.equal(w.started, 4);
  assert.equal(w.skipped, 3);
  assert.equal(w.rated, 4);
});

test('Sunday block carries the dread card; "moved" skips from To-do count', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today'), task(T2, 'Return the lamp', 'today')]);
  await dread(e, 'start', { task: T1, dread: 4, source: 'todo' });
  await dread(e, 'stop', { done: true, source: 'todo' }, NOW + 6 * MIN);
  assert.equal((await dread(e, 'skip', { task: T2, why: 'moved', source: 'todo' })).status, 200);
  assert.equal((await dread(e, 'skip', { task: T2, why: 'bored', source: 'todo' })).status, 400);
  const w = await weekBlock(e, NOW + HOUR);
  assert.deepEqual(w.dread.lies, [{ task: T1, name: 'Ticket for Lucho November', dread: 4, mins: 6 }]);
  assert.equal(w.dread.started, 1);
  assert.equal(w.dread.skipped, 1);
});
