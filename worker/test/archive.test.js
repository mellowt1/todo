// Archive (Phase 5): counting skips from launch, the decision line at 5, Later, Archive, Restore,
// Hand off and the Sunday card. No network; D1 is node:sqlite running every migration, the list is
// the real Durable Object in memory. Every name here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { tally, dueFrom, eligible, LIMIT, archiveCron } from '../src/archive.js';
import { applyOps, cleanOp, emptyDoc } from '../src/todo.js';
import { weekBlock } from '../src/week.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
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
const env = (over = {}) => {
  const e = { HUB_DB: memD1(), HUB_QUEUE: { async sendBatch() {} }, HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE, ...over };
  e.HUB_KV.m.set('archive:since', String(NOW - 24 * HOUR)); // launched yesterday
  return e;
};
const stub = (e) => e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
const task = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: NOW - 30 * HOUR, pos: NOW - 30 * HOUR, ...extra });
async function seed(e, items) {
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: items.map((item) => ({ op: 'upsert', item })) }) });
}
const doc = async (e) => (await stub(e).fetch('https://list/export')).json();
const events = (e, type) => e.HUB_DB.db.prepare('SELECT type, source, payload, at FROM events WHERE type LIKE ? ORDER BY at, rowid').all(type);
function skip(e, taskId, at, type = 'energy.skipped') {
  e.HUB_DB.db.prepare("INSERT INTO events (id, source, type, summary, payload, hops, at) VALUES (?, 'todo', ?, 'x', ?, 0, ?)")
    .run(type + '-' + at + '-' + Math.random(), type, JSON.stringify({ task: taskId }), new Date(at).toISOString());
}

async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
}
const call = (e, path, body, ms = NOW) => at(ms, async () => {
  const r = await worker.fetch(new Request('https://hub.example/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
  return { status: r.status, body: await r.json() };
});
const arch = (e, sub, body, ms) => call(e, 'archive/' + CODE + (sub ? '/' + sub : ''), body, ms);

const T1 = 'task0000lucho01';
const T2 = 'task0000lamp002';

test('eligible: no repeats, chase tasks, letters or the Others lane', () => {
  assert.equal(eligible(task(T1, 'Ticket for Lucho', 'today')), true);
  assert.equal(eligible(task(T1, 'Bins out', 'today', { repeat: { every: 'week', until: null } })), false);
  assert.equal(eligible(task(T1, 'Chase Sam about the bike', 'today', { waiting: 'abcdefghij123456' })), false);
  assert.equal(eligible(task(T1, 'Pay the tax letter [intake]', 'soon')), false);
  assert.equal(eligible(task(T1, 'Nick: photos', 'others')), false);
  assert.equal(eligible(task(T1, 'Done one', 'today', { done: true, doneAt: NOW })), false);
});

test('tally: skips count, Later hides until the next skip, archive and restore start again', () => {
  const r = (type, t) => ({ type, payload: JSON.stringify({ task: t }) });
  let by = tally([1, 2, 3, 4, 5].map(() => r('energy.skipped', 'a')));
  assert.equal(by.get('a').skips, 5);
  by = tally([...[1, 2, 3, 4, 5].map(() => r('dread.skipped', 'a')), r('task.fate_later', 'a')]);
  const items = { a: task('a', 'Ticket', 'today') };
  assert.deepEqual(dueFrom(by, items).due, []);
  by = tally([...[1, 2, 3, 4, 5].map(() => r('dread.skipped', 'a')), r('task.fate_later', 'a'), r('energy.skipped', 'a')]);
  assert.equal(dueFrom(by, items).due[0].skips, 6);
  by = tally([...[1, 2, 3, 4, 5].map(() => r('energy.skipped', 'a')), r('task.resurrected', 'a'), r('energy.skipped', 'a')]);
  assert.equal(by.get('a').skips, 1);
  // Waiting on snoozes are not counted (they are not even read)
  by = tally([1, 2, 3, 4, 5].map(() => r('waiting.snoozed', 'a')));
  assert.equal(by.get('a').skips, 0);
});

test('only skips since launch count; the line shows at 5 and task.fate_due is written once', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November · 2026-10-30', 'today'), task(T2, 'Return the lamp', 'soon')]);
  skip(e, T1, NOW - 48 * HOUR); // before launch: never counts
  for (let i = 1; i <= 4; i++) skip(e, T1, NOW - i * HOUR, i % 2 ? 'energy.skipped' : 'dread.skipped');
  let r = await arch(e, '');
  assert.deepEqual(r.body.due, []);
  skip(e, T1, NOW - MIN);
  r = await arch(e, '');
  assert.deepEqual(r.body.due, [{ task: T1, name: 'Ticket for Lucho November', section: 'today', skips: LIMIT }]);
  await arch(e, '');
  assert.equal(events(e, 'task.fate_due').length, 1);
  assert.equal(r.body.archived, 0);
  for (const ev of events(e, 'task.%')) assert.ok(!ev.payload.includes('Lucho'));
});

test('Later: gone until the next skip', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today')]);
  for (let i = 1; i <= 5; i++) skip(e, T1, NOW - i * HOUR);
  assert.equal((await arch(e, 'later', { task: T1, source: 'morning' })).status, 200);
  assert.deepEqual((await arch(e, '', undefined, NOW + MIN)).body.due, []);
  skip(e, T1, NOW + 2 * MIN);
  assert.equal((await arch(e, '', undefined, NOW + 3 * MIN)).body.due[0].skips, 6);
});

test('Archive: off the list everywhere, in the ledger with the note; Restore puts it in Soon from 0', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today', { energy: 'drained', dread: 4 })]);
  for (let i = 1; i <= 5; i++) skip(e, T1, NOW - i * HOUR);
  let r = await arch(e, 'archive', { task: T1, note: '  He sorted it   himself.  ' + 'x'.repeat(100), source: 'todo' });
  assert.equal(r.status, 200);
  assert.equal(r.body.skips, 5);
  let d = await doc(e);
  assert.equal(d.items[T1], undefined);
  assert.ok(d.tombs[T1]);
  r = await arch(e, 'list');
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].name, 'Ticket for Lucho November');
  assert.equal(r.body.items[0].note.length, 80);
  assert.ok(r.body.items[0].note.startsWith('He sorted it himself.'));
  assert.equal((await arch(e, '')).body.archived, 1);
  assert.equal(events(e, 'task.buried').length, 1);

  r = await arch(e, 'restore', { task: T1, source: 'morning' }, NOW + HOUR);
  assert.equal(r.status, 200);
  d = await doc(e);
  assert.equal(d.items[T1].section, 'soon');
  assert.equal(d.items[T1].energy, 'drained');
  assert.equal(d.tombs[T1], undefined);
  assert.deepEqual((await arch(e, 'list')).body.items, []);
  assert.deepEqual((await arch(e, '', undefined, NOW + HOUR)).body.due, []); // its count starts again
  assert.equal((await arch(e, 'restore', { task: T1, source: 'todo' })).status, 404);
});

test('Hand off: the Waiting on item, task.handed_off, and the Sunday card lists it', async () => {
  const e = env();
  await seed(e, [task(T1, 'Book the boiler service', 'today'), task(T2, 'Return the lamp', 'today')]);
  const r = await call(e, 'waiting/' + CODE, { who: 'Olivia', what: 'Book the boiler service', channel: 'in-person', chaseDays: 7, sourceItem: T1, handoff: true, source: 'todo' });
  assert.equal(r.status, 200);
  const ev = events(e, 'task.handed_off');
  assert.equal(ev.length, 1);
  assert.deepEqual(JSON.parse(ev[0].payload), { task: T1, waiting: r.body.item.id });
  assert.equal((await doc(e)).items[T1].done, true); // the hub ticked it (Morning cannot)
  for (let i = 1; i <= 5; i++) skip(e, T2, NOW - i * HOUR);
  await arch(e, 'archive', { task: T2, note: 'Not mine', source: 'todo' });
  const w = await weekBlock(e, NOW + HOUR);
  assert.deepEqual(w.archive.archived, [{ name: 'Return the lamp', skips: 5, note: 'Not mine' }]);
  assert.deepEqual(w.archive.handedOff, [{ name: 'Book the boiler service', who: 'Olivia', nextChase: '2026-10-29' }]);
  assert.equal(w.archive.restored, 0);
});

test('a plain Waiting on item is not a hand off', async () => {
  const e = env();
  await seed(e, [task(T1, 'Book the boiler service', 'today')]);
  await call(e, 'waiting/' + CODE, { who: 'Olivia', what: 'the boiler', channel: 'email', sourceItem: T1, source: 'todo' });
  assert.equal(events(e, 'task.handed_off').length, 0);
});

test('created: stamped once when a task first arrives, never from an app', () => {
  const d = emptyDoc();
  applyOps(d, [cleanOp({ op: 'upsert', item: { ...task(T1, 'A', 'today'), created: 5 } }, NOW)]);
  assert.equal(d.items[T1].created, NOW - 30 * HOUR);
  applyOps(d, [cleanOp({ op: 'upsert', item: { ...task(T1, 'A edited', 'today'), updatedAt: NOW } }, NOW)]);
  assert.equal(d.items[T1].created, NOW - 30 * HOUR);
});

test('the cron writes fate_due with no app open; bad input is refused', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today')]);
  for (let i = 1; i <= 5; i++) skip(e, T1, NOW - i * HOUR);
  assert.deepEqual(await archiveCron(e, NOW), { due: 1 });
  assert.equal(events(e, 'task.fate_due').length, 1);
  assert.equal((await arch(e, 'archive', { task: T1 })).status, 400);
  assert.equal((await arch(e, 'archive', { task: 'NOPE', source: 'todo' })).status, 400);
  assert.equal((await arch(e, 'archive', { task: 'zzzzzzzzzz', source: 'todo' })).status, 404);
  assert.equal((await call(e, 'archive/zzzzzzzzzzzzzzzz', undefined)).status, 404);
});
