// The Oracle question (Phase 6): the six-field summary, the Sunday call with Claude mocked, once a
// week, a failure that shows nothing, answering and putting aside. No network; D1 is node:sqlite
// running every migration, the list is the real Durable Object in memory. Every name is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { summaryFrom, oracleCron, _setAsker, SYSTEM, MAX_ANSWER } from '../src/oracle.js';
import { weekBlock } from '../src/week.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const HOUR = 3600000;
// Sunday 25 October 2026, 07:00 in Amsterdam (CET, the clocks went back that night).
const SUNDAY = Date.parse('2026-10-25T06:00:00Z');
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
const env = () => ({ HUB_DB: memD1(), HUB_QUEUE: { async sendBatch() {} }, HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE, ANTHROPIC_API_KEY: 'test-key' });
const stub = (e) => e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
const task = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: SUNDAY - 50 * HOUR, pos: SUNDAY - 50 * HOUR, ...extra });
async function seed(e, items) {
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: items.map((item) => ({ op: 'upsert', item })) }) });
}
function ev(e, type, payload, at) {
  e.HUB_DB.db.prepare("INSERT INTO events (id, source, type, summary, payload, hops, at) VALUES (?, 'todo', ?, 'x', ?, 0, ?)")
    .run(type + Math.random(), type, JSON.stringify(payload), new Date(at).toISOString());
}
async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
}
const call = (e, path, body, ms = SUNDAY + HOUR) => at(ms, async () => {
  const r = await worker.fetch(new Request('https://hub.example/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
  return { status: r.status, body: await r.json() };
});

async function world() {
  const e = env();
  await seed(e, [
    task('donetask0001', 'Call the gemeente · 2026-10-21', 'today', { done: true, doneAt: SUNDAY - 72 * HOUR }),
    task('landlord0001', 'Reply to the landlord', 'today'),
    task('lamptask0001', 'Return the lamp [intake]', 'soon'),
  ]);
  for (let i = 0; i < 6; i++) ev(e, i % 2 ? 'energy.skipped' : 'dread.skipped', { task: 'landlord0001' }, SUNDAY - (40 + i) * HOUR);
  ev(e, 'energy.skipped', { task: 'lamptask0001' }, SUNDAY - 30 * HOUR);
  ev(e, 'energy.skipped', { task: 'landlord0001' }, SUNDAY - 10 * 24 * HOUR); // last week: not counted
  return e;
}

test('summaryFrom: the six fields, names cleaned, passed-on counts this week only', async () => {
  const e = await world();
  const block = await weekBlock(e, SUNDAY + HOUR);
  const skips = e.HUB_DB.db.prepare("SELECT payload FROM events WHERE type IN ('energy.skipped','dread.skipped') AND at >= ?").all(new Date(Date.parse('2026-10-18T22:00:00Z')).toISOString());
  const items = (await (await stub(e).fetch('https://list/export')).json()).items;
  const s = summaryFrom(block, skips, items);
  assert.deepEqual(Object.keys(s), ['week', 'finished', 'passedOn', 'archivedOrHandedOff', 'dreadVersusTime', 'energy', 'waitingOn']);
  assert.deepEqual(s.finished.tasks, ['Call the gemeente']);
  assert.deepEqual(s.passedOn, [{ task: 'Reply to the landlord', times: 6 }, { task: 'Return the lamp', times: 1 }]);
  assert.ok(!JSON.stringify(s).includes('[intake]'));
});

test('Sunday from 06:00: one call, the question stored and announced, once a week', async () => {
  const e = await world();
  let seen = null;
  _setAsker(async (env, summary) => { seen = summary; return { question: 'You passed on "Reply to the landlord" six times. What is in the way?', usage: { input: 2000, output: 300 } }; });
  try {
    assert.deepEqual(await oracleCron(e, SUNDAY - 2 * HOUR), { skip: 'too early' }); // 05:00
    assert.deepEqual(await oracleCron(e, SUNDAY - 24 * HOUR), { skip: 'not Sunday' });
    assert.deepEqual(await at(SUNDAY, () => oracleCron(e, SUNDAY)), { asked: '2026-10-19' });
    assert.equal(seen.passedOn[0].times, 6);
    assert.deepEqual(await oracleCron(e, SUNDAY + HOUR), { skip: 'asked' });
  } finally { _setAsker(null); }
  const r = await call(e, 'oracle/' + CODE);
  assert.equal(r.body.current.question, 'You passed on "Reply to the landlord" six times. What is in the way?');
  assert.equal(r.body.current.label, 'Week 43');
  const asked = e.HUB_DB.db.prepare("SELECT payload FROM events WHERE type = 'oracle.asked'").all();
  assert.equal(asked.length, 1);
  assert.ok(!asked[0].payload.includes('landlord'));
  assert.equal((await weekBlock(e, SUNDAY + HOUR)).oracle.state, 'open');
});

test('a failed call shows nothing, logs no content, and does not try again that week', async () => {
  const e = await world();
  const logs = [];
  const real = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  _setAsker(async () => { const err = new Error('landlord secret'); err.name = 'APIError'; throw err; });
  try {
    assert.deepEqual(await oracleCron(e, SUNDAY), { failed: true });
    assert.deepEqual(await oracleCron(e, SUNDAY + HOUR), { skip: 'asked' });
  } finally { _setAsker(null); console.log = real; }
  assert.deepEqual(logs, ['oracle failed APIError']);
  assert.equal((await call(e, 'oracle/' + CODE)).body.current, null);
  assert.deepEqual((await call(e, 'oracle/' + CODE + '/list')).body.weeks, []);
});

test('answer and Not this week; the list keeps both, newest first', async () => {
  const e = await world();
  e.HUB_DB.db.exec("INSERT INTO oracle (week, label, question, asked_at, state) VALUES ('2026-10-12', 'Week 42', 'Old one?', '2026-10-18T05:00:00Z', 'open'), ('2026-10-19', 'Week 43', 'New one?', '2026-10-25T05:00:00Z', 'open')");
  assert.equal((await call(e, 'oracle/' + CODE)).body.current.week, '2026-10-19');
  let r = await call(e, 'oracle/' + CODE + '/answer', { week: '2026-10-19', answer: '  The lease talk scares me.\r\nSo I wait.  ', source: 'morning' });
  assert.equal(r.status, 200);
  assert.equal(r.body.week.answer, 'The lease talk scares me.\nSo I wait.');
  assert.equal((await call(e, 'oracle/' + CODE)).body.current, null); // answered: no line in Morning
  r = await call(e, 'oracle/' + CODE + '/aside', { week: '2026-10-12', source: 'morning' });
  assert.equal(r.body.week.state, 'aside');
  assert.equal((await call(e, 'oracle/' + CODE + '/aside', { week: '2026-10-19', source: 'morning' })).status, 409);
  const weeks = (await call(e, 'oracle/' + CODE + '/list')).body.weeks;
  assert.deepEqual(weeks.map((w) => [w.label, w.state]), [['Week 43', 'answered'], ['Week 42', 'aside']]);
  const ans = e.HUB_DB.db.prepare("SELECT payload FROM events WHERE type = 'oracle.answered'").all();
  assert.equal(ans.length, 2);
  assert.ok(!ans.some((a) => a.payload.includes('lease')));
  // bad input
  assert.equal((await call(e, 'oracle/' + CODE + '/answer', { week: '2026-10-19', answer: '  ', source: 'morning' })).status, 400);
  assert.equal((await call(e, 'oracle/' + CODE + '/answer', { week: '2026-10-05', answer: 'x', source: 'morning' })).status, 404);
  assert.equal((await call(e, 'oracle/' + CODE + '/answer', { week: '2026-10-19', answer: 'x' })).status, 400);
  r = await call(e, 'oracle/' + CODE + '/answer', { week: '2026-10-19', answer: 'y'.repeat(5000), source: 'morning' });
  assert.equal(r.status, 413);
  r = await call(e, 'oracle/' + CODE + '/answer', { week: '2026-10-19', answer: 'y'.repeat(1500), source: 'morning' });
  assert.equal(r.body.week.answer.length, MAX_ANSWER);
});

test('the system prompt is the one Paul approved', () => {
  assert.ok(SYSTEM.startsWith("You read a JSON summary of one week of Paul's own to-do data"));
  assert.ok(SYSTEM.endsWith('If there is too little data to ask something specific, return no question.'));
});
