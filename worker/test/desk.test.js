// Desk: one line in, prepared tasks and drafts out, nothing in the list until approve.
// No network: the preparer is swapped. Every name is made up.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { _setDesker, toActions, gatherContext, RECENT_KEY } from '../src/desk.js';
import { CAL_KEY } from '../src/morning.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
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
const memKV = () => { const m = new Map(); return { m, async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); }, async list() { return { keys: [] }; } }; };
const env = (over = {}) => ({ TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: memKV(), HUB_DB: memD1(), ANTHROPIC_API_KEY: 'k', ...over });
const call = (e, path, init = {}) => worker.fetch(new Request('https://hub.example/api/' + path, init), e);
const post = (e, path, body) => call(e, path, { method: 'POST', body: JSON.stringify(body) });
const open = async (e) => (await (await call(e, `todo/${CODE}`)).json()).items.filter((i) => !i.done && !i.deleted);

const PLAN = {
  answer: null,
  actions: [
    { kind: 'todo', text: 'Call the gemeente about the parking permit', section: 'soon', person: null, to: null, lang: null },
    { kind: 'draft', text: 'Hey Sam — running late Saturday, see you at eight.', section: null, person: null, to: 'Sam', lang: 'en' },
  ],
};

afterEach(() => _setDesker(null));

test('toActions: at most three, an unknown section is soon, drafts lose their dashes', () => {
  const acts = toActions({ actions: [
    { kind: 'todo', text: ' Fix  the bike ', section: 'others' },
    { kind: 'todo', text: 'Dad: print the form', section: 'someday' },
    { kind: 'draft', text: 'Hi — see you soon', to: 'Kim', lang: 'xx' },
    { kind: 'todo', text: 'A fourth one', section: 'today' },
  ] });
  assert.equal(acts.length, 3);
  assert.deepEqual(acts[0], { kind: 'todo', text: 'Fix the bike', section: 'soon', state: 'ready' });
  assert.deepEqual([acts[1].text, acts[1].section], ['Dad: print the form', 'someday']);
  assert.equal(acts[2].text, 'Hi, see you soon');
  assert.equal(acts[2].lang, 'en');
  assert.deepEqual(toActions({ actions: [{ kind: 'todo', text: '   ' }] }), []);
  assert.deepEqual(toActions(null), []);
});

test('a line is prepared, kept and logged; nothing reaches the list', async () => {
  const e = env();
  let seen;
  _setDesker(async (_env, x) => { seen = x; return { plan: PLAN, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }; });
  const r = await post(e, `desk/${CODE}`, { text: 'remind me to call the gemeente about parking and tell Sam I am late Saturday' });
  assert.equal(r.status, 200);
  const { item } = await r.json();
  assert.equal(item.actions.length, 2);
  assert.equal(item.actions[1].text, 'Hey Sam, running late Saturday, see you at eight.');
  assert.ok(seen.context.today && Array.isArray(seen.context.todos));
  assert.deepEqual(await open(e), []);
  const row = e.HUB_DB.db.prepare('SELECT kinds, outcome FROM desk_log WHERE id = ?').get(item.id);
  assert.deepEqual({ ...row }, { kinds: 'todo,draft', outcome: '["ready","ready"]' });
  assert.deepEqual(JSON.parse(e.HUB_KV.m.get(RECENT_KEY)), [item.id]);
  assert.ok([...e.HUB_KV.m.keys()].some((k) => k.startsWith('desk:usage:')));
  const list = await (await call(e, `desk/${CODE}`)).json();
  assert.equal(list.items[0].id, item.id);
});

test('approve writes the task, undo takes it out, skip and copied only log', async () => {
  const e = env();
  _setDesker(async () => ({ plan: PLAN }));
  const { item } = await (await post(e, `desk/${CODE}`, { text: 'two things' })).json();

  let r = await post(e, `desk/${CODE}/act`, { id: item.id, idx: 0, action: 'approve', edit: { text: 'Call the gemeente about parking', section: 'today' } });
  assert.equal(r.status, 200);
  const approved = (await r.json()).item.actions[0];
  assert.equal(approved.state, 'approved');
  assert.match(approved.taskId, /^[a-z0-9]{14}dk$/);
  let tasks = await open(e);
  assert.equal(tasks.length, 1);
  assert.deepEqual([tasks[0].id, tasks[0].text, tasks[0].section], [approved.taskId, 'Call the gemeente about parking', 'today']);

  r = await post(e, `desk/${CODE}/act`, { id: item.id, idx: 0, action: 'skip' });
  assert.equal(r.status, 409);

  r = await post(e, `desk/${CODE}/act`, { id: item.id, idx: 0, action: 'undo' });
  assert.equal((await r.json()).item.actions[0].state, 'ready');
  assert.deepEqual(await open(e), []);

  r = await post(e, `desk/${CODE}/act`, { id: item.id, idx: 1, action: 'approve' });
  assert.equal(r.status, 400);
  r = await post(e, `desk/${CODE}/act`, { id: item.id, idx: 1, action: 'copied' });
  assert.equal((await r.json()).item.actions[1].state, 'copied');
  r = await post(e, `desk/${CODE}/act`, { id: item.id, idx: 0, action: 'skip' });
  assert.equal((await r.json()).item.actions[0].state, 'skipped');
  assert.deepEqual(await open(e), []);
  assert.equal(e.HUB_DB.db.prepare('SELECT outcome FROM desk_log WHERE id = ?').get(item.id).outcome, '["skipped","copied"]');
});

test('an answer only: masked, no actions', async () => {
  const e = env();
  _setDesker(async () => ({ plan: { answer: 'Pay NL86INGB0002445588 by Friday — two tasks are open.', actions: [] } }));
  const { item } = await (await post(e, `desk/${CODE}`, { text: 'what is due this week?' })).json();
  assert.equal(item.answer, 'Pay IBAN ··5588 by Friday, two tasks are open.');
  assert.deepEqual(item.actions, []);
});

test('refused: code, empty line, long line, no key, failed call, unknown item', async () => {
  const e = env();
  assert.equal((await post(e, 'desk/zzzzzzzzzzzzzzzz', { text: 'x' })).status, 404);
  assert.equal((await post(e, 'desk/bad', { text: 'x' })).status, 400);
  assert.equal((await post(e, `desk/${CODE}`, { text: '  ' })).status, 400);
  assert.equal((await post(e, `desk/${CODE}`, { text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await post(env({ ANTHROPIC_API_KEY: undefined }), `desk/${CODE}`, { text: 'x' })).status, 503);
  _setDesker(async () => ({ error: 'refused' }));
  assert.equal((await post(e, `desk/${CODE}`, { text: 'x' })).status, 502);
  assert.equal((await post(e, `desk/${CODE}/act`, { id: 'nothere12345', idx: 0, action: 'approve' })).status, 404);
  assert.equal((await post(e, `desk/${CODE}/other`, {})).status, 404);
});

test('context: open to-dos masked, done ones left out, calendar in the window', async () => {
  const e = env();
  const now = Date.parse('2026-10-17T08:30:00Z');
  await post(e, `todo/${CODE}/ops`, { ops: [
    { op: 'upsert', item: { id: 'aaaa00000001', text: 'Pay NL86INGB0002445588', section: 'soon', done: false, doneAt: null, updatedAt: now, pos: now } },
    { op: 'upsert', item: { id: 'aaaa00000002', text: 'Old thing', section: 'today', done: true, doneAt: now, updatedAt: now, pos: now } },
  ] });
  await e.HUB_KV.put(CAL_KEY, JSON.stringify({ events: [
    { title: 'Archery', start: '2026-10-19T19:00:00+02:00', end: '2026-10-19T21:00:00+02:00', allDay: false },
    { title: 'Far away', start: '2026-12-01', end: '2026-12-02', allDay: true },
  ] }));
  const c = await gatherContext(e, now);
  assert.equal(c.today, '2026-10-17');
  assert.equal(c.weekday, 'Saturday');
  assert.deepEqual(c.todos, [{ text: 'Pay IBAN ··5588', section: 'soon' }]);
  assert.deepEqual(c.calendar.map((x) => x.title), ['Archery']);
});
