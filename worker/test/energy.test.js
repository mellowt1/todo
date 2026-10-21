// The Energy dial: the level held by the hub, Give me one, the one-off guess and the Sunday grid.
// No network; D1 is node:sqlite running every migration, the list is the real Durable Object in
// memory. Every name here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { stateFrom, pickPool, pickTask, forSomeoneElse, nameAndDue, needsGuess, energyWeek, HOURS, _setGuesser } from '../src/energy.js';
import { cleanOp, applyOps, emptyDoc } from '../src/todo.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const DAY_SECRET = 'day-secret-for-tests';
const HOUR = 3600000;
// Wednesday 21 October 2026, 11:00 in Amsterdam (CEST).
const NOW = Date.parse('2026-10-21T09:00:00Z');
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
  HUB_SECRET_DAY: DAY_SECRET, ANTHROPIC_API_KEY: 'test-key', ...over,
});
const call = (e, path, body, headers = {}) => worker.fetch(new Request('https://hub.example/api/' + path, {
  method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
}), e);
const day = (e, path, body) => call(e, 'hub/energy/day' + path, body, { Authorization: 'Bearer ' + DAY_SECRET });
const stub = (e) => e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
const task = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: NOW - 3 * HOUR, pos: NOW - 10 * HOUR, ...extra });
async function seed(e, items) {
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: items.map((item) => ({ op: 'upsert', item })) }) });
}
const items = async (e) => (await (await stub(e).fetch('https://list/export')).json()).items;
const byId = (list) => Object.fromEntries(list.map((t) => [t.id, t]));

/* ---------- The task fields ---------- */

test('task fields: energy and energyGuess are one of three levels; an upsert without them keeps them; null clears', () => {
  const base = task('aaaaaaaa', 'Buy coffee', 'today', { updatedAt: NOW });
  assert.equal(cleanOp({ op: 'upsert', item: { ...base, energy: 'tired' } }, NOW), null, 'an unknown level is refused');
  assert.equal(cleanOp({ op: 'upsert', item: { ...base, energy: 'drained', energyGuess: 'normal' } }, NOW).item.energy, 'drained');
  const doc = emptyDoc();
  applyOps(doc, [cleanOp({ op: 'upsert', item: { ...base, energy: 'drained', energyGuess: 'normal' } }, NOW)]);
  applyOps(doc, [cleanOp({ op: 'upsert', item: { ...base, text: 'Buy coffee beans', updatedAt: NOW + 1 } }, NOW + 1)]);
  assert.equal(doc.items.aaaaaaaa.energy, 'drained', 'an app that does not know the field never drops it');
  assert.equal(doc.items.aaaaaaaa.energyGuess, 'normal');
  applyOps(doc, [cleanOp({ op: 'upsert', item: { ...base, energyGuess: null, updatedAt: NOW + 2 } }, NOW + 2)]);
  assert.equal(doc.items.aaaaaaaa.energyGuess, undefined);
  assert.equal(doc.items.aaaaaaaa.energy, 'drained');
});

/* ---------- The level ---------- */

test('stateFrom: a set level lasts HOURS, a clear or an old one is no level', () => {
  const at = new Date(NOW - HOUR).toISOString();
  const row = { type: 'energy.set', source: 'morning', payload: '{"level":"drained"}', at };
  assert.equal(HOURS, 4);
  assert.deepEqual(stateFrom(row, NOW), { level: 'drained', setAt: at, until: new Date(NOW + 3 * HOUR).toISOString(), source: 'morning' });
  assert.equal(stateFrom(row, NOW + 3 * HOUR).level, null, 'four hours after it was set');
  assert.equal(stateFrom({ ...row, type: 'energy.cleared', payload: '{}' }, NOW).level, null);
  assert.equal(stateFrom({ ...row, payload: '{"level":"tired"}' }, NOW).level, null);
  assert.equal(stateFrom(null, NOW).level, null);
});

test('sync: a level set in To-do is what Morning and Day read; Day can clear it', async () => {
  const e = env();
  assert.equal((await (await call(e, 'energy/' + CODE)).json()).level, null);
  let r = await call(e, 'energy/' + CODE, { level: 'wired', source: 'todo' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).level, 'wired');
  assert.equal((await (await call(e, 'energy/' + CODE)).json()).source, 'todo');
  const seen = await (await day(e, '')).json();
  assert.equal(seen.level, 'wired');
  r = await day(e, '', { level: null });
  assert.equal((await r.json()).level, null);
  assert.equal((await (await call(e, 'energy/' + CODE)).json()).level, null);
  const rows = e.HUB_DB.db.prepare('SELECT source, type FROM events ORDER BY at').all();
  assert.deepEqual(rows.map((x) => x.source + ' ' + x.type), ['todo energy.set', 'day energy.cleared'], 'each tap is one hub event');
  assert.equal([...e.HUB_KV.m.keys()].filter((k) => k.startsWith('event:')).length, 0, 'kept out of Morning\'s Lately feed');
});

test('routes refuse: bad level, missing source, wrong code, no Day secret', async () => {
  const e = env();
  assert.equal((await call(e, 'energy/' + CODE, { level: 'tired', source: 'todo' })).status, 400);
  assert.equal((await call(e, 'energy/' + CODE, { level: 'wired' })).status, 400);
  assert.equal((await call(e, 'energy/zzzzzzzzzzzzzzzz', { level: 'wired', source: 'todo' })).status, 404);
  assert.equal((await call(e, 'hub/energy/day', { level: 'wired' })).status, 401);
  assert.equal((await day(e, '/suggest', {})).status, 404, 'Day cannot run the paid guess');
});

/* ---------- Give me one ---------- */

const POOL = [
  task('t0000001', 'Text Sam back', 'today', { energy: 'drained', pos: NOW - 1 * HOUR }),
  task('t0000002', 'Return the lamp · 2026-10-25', 'soon', { energy: 'drained' }),
  task('t0000003', 'Pay the fine · 2026-10-19', 'soon', { energy: 'drained' }),
  task('t0000004', 'Buy stamps · 2026-10-21 16:00 [intake]', 'today', { energy: 'drained' }),
  task('t0000005', 'Sam: look at his bike', 'today', { energy: 'drained' }),
  task('t0000006', 'Order bulbs', 'soon', { energy: 'drained', pos: NOW - 2 * HOUR }),
  task('t0000007', 'Order cables', 'soon', { energy: 'drained', pos: NOW - 5 * HOUR }),
  task('t0000008', 'Write the plan', 'today', { energy: 'wired' }),
  task('t0000009', 'Clean the shed', 'someday', { energy: 'drained' }),
  task('t0000010', 'Guessed only', 'today', { energyGuess: 'drained' }),
  task('t0000011', 'Done already', 'today', { energy: 'drained', done: true, doneAt: NOW }),
];

test('pickPool: confirmed level only, Today then Soon, dated by date, undated newest first, someone else last', () => {
  const ids = pickPool(byId(POOL), 'drained').map((r) => r.it.id);
  assert.deepEqual(ids, ['t0000004', 't0000001', 't0000003', 't0000002', 't0000006', 't0000007', 't0000005']);
  assert.ok(!ids.includes('t0000009'), 'never Someday');
  assert.ok(!ids.includes('t0000010'), 'a guess is never picked');
});

test('forSomeoneElse and nameAndDue', () => {
  assert.equal(forSomeoneElse({ text: 'Nick: taxes overview' }), true);
  assert.equal(forSomeoneElse({ text: 'Apply: Policy officer' }), false);
  assert.equal(forSomeoneElse({ text: 'Choose: pay at once' }), false);
  assert.equal(forSomeoneElse({ text: 'Plain', section: 'others' }), true);
  assert.deepEqual(nameAndDue('Buy stamps · 2026-10-21 16:00 [intake]'), { name: 'Buy stamps', due: '2026-10-21', time: '16:00' });
});

test('pickTask: next walks the order, skips are left out, surprise never repeats the one on screen', () => {
  const all = byId(POOL);
  let p = pickTask(all, 'drained');
  assert.equal(p.task.id, 't0000004');
  assert.equal(p.task.name, 'Buy stamps');
  assert.deepEqual([p.count, p.left, p.position], [7, 7, 1]);
  p = pickTask(all, 'drained', { skip: ['t0000004', 't0000001'] });
  assert.equal(p.task.id, 't0000003');
  assert.equal(p.position, 3);
  p = pickTask(all, 'drained', { skip: POOL.map((t) => t.id) });
  assert.equal(p.task, null, 'every task that fits was turned down');
  for (let i = 0; i < 20; i++) {
    const s = pickTask(all, 'drained', { mode: 'surprise', current: 't0000004', random: () => i / 20 });
    assert.notEqual(s.task.id, 't0000004');
  }
  assert.equal(pickTask(all, 'wired').task.id, 't0000008');
  assert.equal(pickTask(all, null).task, null);
});

test('the pick route: Not this one is stored as a skip on that task; Surprise me is not', async () => {
  const e = env();
  await seed(e, POOL);
  await call(e, 'energy/' + CODE, { level: 'drained', source: 'morning' });
  let r = await (await call(e, 'energy/' + CODE + '?pick=1')).json();
  assert.equal(r.pick.task.id, 't0000004');
  r = await (await call(e, 'energy/' + CODE + '/pick', { mode: 'next', skip: ['t0000004'], skipped: 't0000004', current: 't0000004', source: 'morning' })).json();
  assert.equal(r.pick.task.id, 't0000001');
  r = await (await day(e, '/pick', { mode: 'surprise', skip: ['t0000004'], current: 't0000001' })).json();
  assert.notEqual(r.pick.task.id, 't0000001');
  const skips = e.HUB_DB.db.prepare("SELECT source, payload FROM events WHERE type = 'energy.skipped'").all();
  assert.deepEqual(skips.map((s) => [s.source, JSON.parse(s.payload)]), [['morning', { task: 't0000004', level: 'drained' }]]);
});

/* ---------- The one-off guess ---------- */

test('suggest: guesses only open tasks with no level and no guess, writes energyGuess never energy, once a day', async () => {
  const e = env();
  await seed(e, [
    task('g0000001', 'Book flights', 'soon'),
    task('g0000002', 'Has a level', 'soon', { energy: 'wired' }),
    task('g0000003', 'Has a guess', 'soon', { energyGuess: 'normal' }),
    task('g0000004', 'Done', 'today', { done: true, doneAt: NOW }),
    task('g0000005', 'Text Sam IBAN NL91ABNA0417164300', 'today'),
  ]);
  assert.deepEqual(needsGuess(await items(e)).map((t) => t.id).sort(), ['g0000001', 'g0000005']);
  let sent;
  _setGuesser(async (_e, list) => {
    sent = list.map((t) => t.id).sort();
    return { out: { tasks: [{ id: 'g0000001', energy: 'normal' }, { id: 'g0000005', energy: 'drained' }, { id: 'g0000002', energy: 'drained' }] }, usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } };
  });
  const r = await (await call(e, 'energy/' + CODE + '/suggest', {})).json();
  assert.deepEqual(sent, ['g0000001', 'g0000005']);
  assert.equal(r.guessed, 2);
  const after = await items(e);
  assert.equal(after.g0000001.energyGuess, 'normal');
  assert.equal(after.g0000001.energy, undefined, 'Paul confirms every level himself');
  assert.equal(after.g0000002.energy, 'wired', 'a confirmed level is never touched');
  assert.equal(after.g0000002.energyGuess, undefined);
  assert.equal((await (await call(e, 'energy/' + CODE + '/suggest', {})).json()).already, true, 'at most once a day');
  _setGuesser(null);
});

/* ---------- The Sunday grid ---------- */

test('energyWeek: the level held for most of each part of each day, the count of taps, the part each level was most', () => {
  const at = (s) => new Date(Date.parse(s)).toISOString();
  const rows = [
    { type: 'energy.set', payload: '{"level":"wired"}', at: at('2026-10-18T20:00:00Z') }, // Sunday before, runs past midnight
    { type: 'energy.set', payload: '{"level":"normal"}', at: at('2026-10-19T07:00:00Z') }, // Mon 09:00 local, 4 h
    { type: 'energy.set', payload: '{"level":"drained"}', at: at('2026-10-19T17:00:00Z') }, // Mon 19:00 local
    { type: 'energy.cleared', payload: '{}', at: at('2026-10-19T18:00:00Z') }, // cleared after an hour
    { type: 'energy.set', payload: '{"level":"drained"}', at: at('2026-10-20T19:00:00Z') }, // Tue 21:00 local
  ];
  const w = energyWeek(rows, '2026-10-19', Date.parse('2026-10-25T12:00:00Z'));
  assert.deepEqual(w.parts, ['morning', 'afternoon', 'evening']);
  assert.deepEqual(w.days[0], { date: '2026-10-19', parts: ['normal', 'normal', 'drained'] });
  assert.deepEqual(w.days[1], { date: '2026-10-20', parts: [null, null, 'drained'] });
  assert.deepEqual(w.days[2].parts, ['drained', null, null], 'Tuesday 21:00 runs to Wednesday 01:00');
  assert.equal(w.sets, 3, 'taps before Monday are not this week');
  assert.deepEqual(w.most, { wired: 'morning', normal: 'morning', drained: 'evening' }, 'the wired from Sunday night runs into Monday morning');
});
