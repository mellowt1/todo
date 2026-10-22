// Waiting on: items, chase timing, the cron's chase tasks and closing both ways. No network; D1 is
// node:sqlite running every migration, the list is the real Durable Object in memory. Every name
// here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { cleanNew, chaseText, fromApply, waitingCron, chaseTaskId, waitingWeek, handleWaiting, CHASE_DAYS, APPLY_DAYS } from '../src/waiting.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const DAY_SECRET = 'day-secret-for-tests';
const DAY = 864e5;
// Wednesday 21 October 2026, 11:00 in Amsterdam.
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
const env = () => ({ HUB_DB: memD1(), HUB_QUEUE: { async sendBatch() {} }, HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_SECRET_DAY: DAY_SECRET });
const call = (e, path, body, headers = {}) => worker.fetch(new Request('https://hub.example/api/' + path, {
  method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
}), e);
const stub = (e) => e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
const doc = async (e) => (await (await stub(e).fetch('https://list/export')).json());
async function seed(e, items) {
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: items.map((item) => ({ op: 'upsert', item })) }) });
}
const events = (e) => e.HUB_DB.db.prepare("SELECT type, source, summary, payload FROM events WHERE type LIKE 'waiting.%' ORDER BY at").all();
// The waiting routes on a fixed clock.
const json = (d, _r, status = 200) => Response.json(d, { status });
const api = (e, rest, body, now = NOW) => handleWaiting(new Request('https://hub.example/api/waiting', {
  method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }), e, [CODE, ...rest], json, now);
const add = async (e, body, now = NOW) => {
  const r = await api(e, [], { source: 'todo', channel: 'email', ...body }, now);
  return { status: r.status, ...(await r.json()) };
};

test('cleanNew: who, what and a channel; 7 days by default; bounded', () => {
  assert.equal(CHASE_DAYS, 7);
  assert.equal(APPLY_DAYS, 14);
  const f = cleanNew({ who: ' Gemeente ', what: 'the parking permit', channel: 'letter' }, '2026-10-21');
  assert.deepEqual(f, { who: 'Gemeente', what: 'the parking permit', channel: 'letter', chase_days: 7, for_whom: null, source_item: null, since: '2026-10-21', next_chase: '2026-10-28' });
  assert.equal(cleanNew({ who: 'A', what: 'B', channel: 'email', chaseDays: 3 }, '2026-10-21').next_chase, '2026-10-24');
  assert.match(cleanNew({ what: 'B', channel: 'email' }, '2026-10-21').error, /who/);
  assert.match(cleanNew({ who: 'A', what: 'B', channel: 'fax' }, '2026-10-21').error, /channel/);
  assert.match(cleanNew({ who: 'A', what: 'B', channel: 'email', chaseDays: 0 }, '2026-10-21').error, /chaseDays/);
  assert.equal(cleanNew({ who: 'A', what: 'B', channel: 'email', forWhom: 'Sam' }, '2026-10-21').for_whom, 'Sam');
});

test('chaseText and fromApply', () => {
  assert.equal(chaseText({ who: 'Gemeente', what: 'the permit', for_whom: null }), 'Chase Gemeente about the permit');
  assert.equal(chaseText({ who: 'the accountant', what: 'the tax overview', for_whom: 'Sam' }), 'Sam: Chase the accountant about the tax overview');
  assert.deepEqual(fromApply('Apply: Policy officer (Ministry of Defence) · 2026-10-30'), { who: 'Ministry of Defence', what: 'the Policy officer application' });
  assert.deepEqual(fromApply('Sollicitatie: Beleidsadviseur'), { who: 'the employer', what: 'the Beleidsadviseur application' });
  assert.deepEqual(fromApply('Apply for nato position'), { who: 'the employer', what: 'the nato position application' }, 'how Paul really writes them');
  assert.deepEqual(fromApply('Sollicitreren bij Defensie'), { who: 'the employer', what: 'the Defensie application' });
  assert.equal(fromApply('Applying sunscreen'), null);
  assert.equal(fromApply('Buy stamps'), null);
});

test('chase timing: no task before the day, one task on the day in Today, energy drained, once', async () => {
  const e = env();
  const { item } = await add(e, { who: 'Gemeente', what: 'the parking permit', channel: 'letter' });
  assert.equal(item.nextChase, '2026-10-28');
  assert.equal((await waitingCron(e, NOW + 6 * DAY)).chased, 0, 'the day before');
  assert.equal((await waitingCron(e, NOW + 7 * DAY)).chased, 1, 'on the day');
  assert.equal((await waitingCron(e, NOW + 7 * DAY + 900e3)).chased, 0, 'the next run makes no second one');
  const id = await chaseTaskId(item.id, 1);
  const t = (await doc(e)).items[id];
  assert.equal(t.text, 'Chase Gemeente about the parking permit');
  assert.equal(t.section, 'today');
  assert.equal(t.energy, 'drained');
  assert.equal(t.waiting, item.id);
  const list = await (await api(e, [], undefined, NOW + 7 * DAY)).json();
  assert.equal(list.due, 1, 'due from its chase day until it is answered, snoozed or still waiting');
});

test('someone else: "Name: Chase ..." in Soon', async () => {
  const e = env();
  const { item } = await add(e, { who: 'the accountant', what: 'the tax overview', channel: 'phone', forWhom: 'Sam', chaseDays: 3 });
  await waitingCron(e, NOW + 3 * DAY);
  const t = (await doc(e)).items[await chaseTaskId(item.id, 1)];
  assert.equal(t.text, 'Sam: Chase the accountant about the tax overview');
  assert.equal(t.section, 'others');
});

test('resolving ticks the open chase task off everywhere; an event says so with ids only', async () => {
  const e = env();
  const { item } = await add(e, { who: 'Gemeente', what: 'the parking permit' });
  await waitingCron(e, NOW + 7 * DAY);
  const r = await (await api(e, [item.id], { action: 'resolve' }, NOW + 7 * DAY)).json();
  assert.equal(r.item.state, 'resolved');
  const t = (await doc(e)).items[await chaseTaskId(item.id, 1)];
  assert.equal(t.done, true, 'marked done, as Paul chose');
  assert.equal((await (await api(e, [])).json()).open, 0);
  const ev = events(e);
  assert.deepEqual(ev.map((x) => x.type), ['waiting.created', 'waiting.chase_due', 'waiting.resolved']);
  assert.ok(ev.every((x) => !/Gemeente|parking/.test(x.summary + x.payload)), 'no who or what in the events');
});

test('ticking a chase task, then "still waiting": the next chase comes the same gap later', async () => {
  const e = env();
  const { item } = await add(e, { who: 'Gemeente', what: 'the permit', chaseDays: 3 });
  await waitingCron(e, NOW + 3 * DAY);
  const r = await (await api(e, [item.id], { action: 'still' }, NOW + 3 * DAY + 3600e3)).json();
  assert.equal(r.item.chaseTask, null);
  assert.equal(r.item.nextChase, '2026-10-27', 'ticked on the 24th, the same 3 days again');
  assert.equal(r.item.chases, 1);
  assert.equal((await waitingCron(e, NOW + 5 * DAY)).chased, 0);
  assert.equal((await waitingCron(e, NOW + 6 * DAY)).chased, 1, 'the second chase on the 27th');
  assert.ok((await doc(e)).items[await chaseTaskId(item.id, 2)]);
});

test('snooze moves the chase day and takes a chase task out again; only 3, 7 or 14', async () => {
  const e = env();
  const { item } = await add(e, { who: 'Gemeente', what: 'the permit', chaseDays: 3 });
  await waitingCron(e, NOW + 3 * DAY);
  assert.equal((await api(e, [item.id], { action: 'snooze', days: 5 }, NOW + 3 * DAY)).status, 400);
  const r = await (await api(e, [item.id], { action: 'snooze', days: 7 }, NOW + 3 * DAY)).json();
  assert.equal(r.item.chaseTask, null);
  assert.equal(r.item.nextChase, '2026-10-31');
  const d = await doc(e);
  assert.equal(d.items[await chaseTaskId(item.id, 1)], undefined, 'the chase task is gone');
  assert.ok(events(e).some((x) => x.type === 'waiting.snoozed'));
});

test('a chase task deleted from the list counts as still waiting', async () => {
  const e = env();
  const { item } = await add(e, { who: 'Gemeente', what: 'the permit', chaseDays: 3 });
  await waitingCron(e, NOW + 3 * DAY);
  const id = await chaseTaskId(item.id, 1);
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'delete', item: { id, updatedAt: NOW + 3 * DAY + 1000 } }] }) });
  await waitingCron(e, NOW + 4 * DAY);
  const row = e.HUB_DB.db.prepare('SELECT next_chase, chase_task FROM waiting').get();
  assert.deepEqual({ ...row }, { next_chase: '2026-10-28', chase_task: null });
  await waitingCron(e, NOW + 7 * DAY);
  assert.ok((await doc(e)).items[await chaseTaskId(item.id, 2)], 'the second chase came a gap later');
});

test('Apply tasks ticked since 1 October make one item each (the old ones too), first chase 14 days after the tick; September never', async () => {
  const e = env();
  await waitingCron(e, NOW); // the start
  await seed(e, [
    { id: 'apply000001', text: 'Apply: Policy officer (Ministry of Defence) · 2026-10-30', section: 'soon', done: true, doneAt: NOW + DAY, updatedAt: NOW + DAY, pos: NOW - DAY },
    { id: 'apply000002', text: 'Apply for nato position', section: 'soon', done: true, doneAt: Date.parse('2026-10-08T10:00:00Z'), updatedAt: NOW - DAY, pos: NOW - 19 * DAY },
    { id: 'apply000003', text: 'Apply: September one (Old org)', section: 'soon', done: true, doneAt: Date.parse('2026-09-20T10:00:00Z'), updatedAt: NOW - 30 * DAY, pos: NOW - 40 * DAY },
    { id: 'plain000001', text: 'Buy stamps', section: 'today', done: true, doneAt: NOW + DAY, updatedAt: NOW + DAY, pos: NOW },
  ]);
  assert.equal((await waitingCron(e, NOW + DAY + 60e3)).made, 2);
  assert.equal((await waitingCron(e, NOW + DAY + 120e3)).made, 0, 'once per task');
  const rows = e.HUB_DB.db.prepare('SELECT who, what, channel, since, next_chase, source, source_item FROM waiting ORDER BY source_item').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { who: 'Ministry of Defence', what: 'the Policy officer application', channel: 'email', since: '2026-10-22', next_chase: '2026-11-05', source: 'apply', source_item: 'apply000001' },
    { who: 'the employer', what: 'the nato position application', channel: 'email', since: '2026-10-08', next_chase: '2026-10-22', source: 'apply', source_item: 'apply000002' },
  ]);
});

test('"Sent, now waiting" from a task: the task id is kept, a second one for the same task is refused', async () => {
  const e = env();
  assert.equal((await add(e, { who: 'A', what: 'B', sourceItem: 'task0000001' })).status, 200);
  assert.equal((await add(e, { who: 'A', what: 'B', sourceItem: 'task0000001' })).status, 409);
});

test('Day: the count and quick add with its own secret, never without it', async () => {
  const e = env();
  const h = { Authorization: 'Bearer ' + DAY_SECRET };
  assert.equal((await call(e, 'hub/waiting/day', { who: 'A', what: 'B', channel: 'email' })).status, 401);
  const r = await call(e, 'hub/waiting/day', { who: 'Gemeente', what: 'the permit', channel: 'email' }, h);
  assert.equal(r.status, 200);
  assert.deepEqual(await (await call(e, 'hub/waiting/day', undefined, h)).json(), { open: 1, due: 0, dueWho: [] });
  assert.equal(e.HUB_DB.db.prepare('SELECT source FROM waiting').get().source, 'day');
});

test('the Sunday block: everything open, oldest first, with the week counts', async () => {
  const e = env();
  e.HUB_DB.db.exec(`INSERT INTO waiting (id, who, what, since, chase_days, next_chase, channel, source, created_at, updated_at) VALUES
    ('aaaaaaaaaaaaaaaa', 'Newer', 'x', '2026-10-20', 7, '2026-10-27', 'email', 'todo', '2026-10-20T08:00:00Z', '2026-10-20T08:00:00Z'),
    ('bbbbbbbbbbbbbbbb', 'Older', 'y', '2026-10-07', 7, '2026-10-14', 'email', 'todo', '2026-10-07T08:00:00Z', '2026-10-07T08:00:00Z')`);
  const w = await waitingWeek(e, '2026-10-19', NOW);
  assert.deepEqual(w.items.map((i) => i.who), ['Older', 'Newer']);
  assert.equal(w.items[0].chaseDue, true);
  assert.deepEqual([w.resolved, w.chased], [0, 0]);
});
