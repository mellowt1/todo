// Out for dinner: Day's dinner.away / dinner.back, the Kitchen flag, the config route and
// Morning's block. No network; D1 is node:sqlite running the real migrations. Every name is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { consume } from '../src/hub.js';
import { parseDinnerId, CONFIG, awayNow, dinnerBlock } from '../src/dinner.js';
import { KitchenStore } from '../src/kitchen-store.js';
import { memNamespace } from './mem.js';

const NOW = Date.parse('2026-10-12T07:00:00Z');
const DAY_SECRET = 'day-secret-for-tests';
const ADMIN = 'admin-token-for-tests';
const KCODE = 'kitchen1234567890'.slice(0, 16);
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
const memKV = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async list() { return { keys: [] }; } }; };
const memQueue = () => ({ sent: [], async sendBatch(ms) { this.sent.push(...ms); } });
const env = (over = {}) => ({
  HUB_DB: memD1(), HUB_QUEUE: memQueue(), HUB_KV: memKV(), KITCHEN_STORE: memNamespace(KitchenStore), KITCHEN_CODE: KCODE,
  HUB_SECRET_DAY: DAY_SECRET, ADMIN_TOKEN: ADMIN, ...over,
});
const BASE = 'dinner:0123456789abcdef:2026-10-14';
const away = (seq, over = {}) => ({
  id: BASE + ':' + seq, source: 'day', type: 'dinner.away', summary: 'Out for dinner Wed 14 Oct',
  payload: { date: '2026-10-14', title: 'Dinner with Sam', start: '19:30' }, ...over,
});
const back = (seq) => ({ id: BASE + ':' + seq, source: 'day', type: 'dinner.back', summary: 'Back for dinner Wed 14 Oct', payload: { date: '2026-10-14' } });
const post = (e, body, token = DAY_SECRET) => worker.fetch(new Request('https://hub.example/api/event', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), e);
const get = (e, path, token) => worker.fetch(new Request('https://hub.example/api/' + path, { headers: { Authorization: 'Bearer ' + token } }), e);
const setConfig = (e, key, value, token = ADMIN) => worker.fetch(new Request('https://hub.example/api/admin/config/' + key, {
  method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify({ value }),
}), e);
// Hand the queued messages to the consumer, as Cloudflare would.
async function drain(e) {
  const msgs = e.HUB_QUEUE.sent.splice(0).map((m) => ({ body: m.body, attempts: 1, acked: false, ack() { this.acked = true; }, retry() { this.retried = true; } }));
  await consume({ messages: msgs }, e);
  return msgs;
}
const kitchenRead = async (e) => (await worker.fetch(new Request('https://hub.example/api/kitchen/' + KCODE), e)).json();

test('the two rules are seeded: day dinner.away and dinner.back go to kitchen with date and title', async () => {
  const e = env();
  const r = await (await get(e, 'admin/rules', ADMIN)).json();
  const mine = r.rules.filter((x) => x.source === 'day');
  assert.deepEqual(mine.map((x) => [x.id, x.type, x.target, x.fields, x.enabled]), [
    ['day-dinner-away-kitchen', 'dinner.away', 'kitchen', ['date', 'title'], true],
    ['day-dinner-back-kitchen', 'dinner.back', 'kitchen', ['date', 'title'], true],
  ]);
});

test('parseDinnerId: base, date and seq, or null', () => {
  assert.deepEqual(parseDinnerId(BASE + ':3'), { base: BASE, date: '2026-10-14', seq: 3 });
  assert.equal(parseDinnerId('dinner:0123456789abcdef:2026-02-30:1'), null);
  assert.equal(parseDinnerId('dinner:XYZ:2026-10-14:1'), null);
  assert.equal(parseDinnerId(BASE), null);
});

test('away marks the date in Kitchen; the title never reaches it; back clears it', async () => {
  const e = env();
  assert.equal((await post(e, away(1))).status, 200);
  const [m] = e.HUB_QUEUE.sent;
  assert.deepEqual(m.body.payload, { date: '2026-10-14', title: 'Dinner with Sam' }); // start is not in the rule
  const msgs = await drain(e);
  assert.ok(msgs[0].acked);
  const k = await kitchenRead(e);
  assert.deepEqual(k.away, ['2026-10-14']);
  assert.ok(!JSON.stringify(k).includes('Sam'), 'no title in what Kitchen serves');
  const dump = [...e.KITCHEN_STORE.storages.values()].map((s) => JSON.stringify([...s.m])).join('');
  assert.ok(!dump.includes('Sam'), 'no title in what Kitchen stores');

  assert.equal((await post(e, back(2))).status, 200);
  await drain(e);
  assert.deepEqual((await kitchenRead(e)).away, []);
});

test('a planned meal is never touched', async () => {
  const e = env();
  const day = { op: 'upsert', type: 'day', item: { id: '2026-W42:wed:paul:dinner', kind: 'text', text: 'Soup', updatedAt: NOW } };
  await worker.fetch(new Request('https://hub.example/api/kitchen/' + KCODE + '/ops', { method: 'POST', body: JSON.stringify({ ops: [day] }) }), e);
  const before = (await kitchenRead(e)).items;
  await post(e, away(1));
  await drain(e);
  await post(e, back(2));
  await drain(e);
  assert.deepEqual((await kitchenRead(e)).items, before);
});

test('a late retry of an older message never wins', async () => {
  const e = env();
  await post(e, away(1));
  const first = e.HUB_QUEUE.sent.splice(0);
  await post(e, back(2));
  await drain(e); // back lands first
  e.HUB_QUEUE.sent.push(...first);
  await drain(e); // then the old away
  assert.deepEqual((await kitchenRead(e)).away, []);
});

test('two events on one date: Paul is out until both are back', async () => {
  const e = env();
  const other = 'dinner:fedcba9876543210:2026-10-14';
  await post(e, away(1));
  await post(e, { ...away(1), id: other + ':1' });
  await drain(e);
  await post(e, back(2));
  await drain(e);
  assert.deepEqual((await kitchenRead(e)).away, ['2026-10-14']);
});

test('a resent event is a duplicate, not a second reaction', async () => {
  const e = env();
  await post(e, away(1));
  const again = await (await post(e, away(1))).json();
  assert.equal(again.duplicate, true);
  assert.equal(e.HUB_QUEUE.sent.length, 1);
});

test('a message whose date is not the one in its id is skipped', async () => {
  const e = env();
  await post(e, away(1, { payload: { date: '2026-10-15', title: 'x', start: '19:00' } }));
  await drain(e);
  assert.deepEqual((await kitchenRead(e)).away, []);
});

test('only day may post as day', async () => {
  const e = env();
  assert.equal((await post(e, away(1), 'wrong')).status, 401);
});

test('config: Paul sets dinner_window, Day reads it with its own secret', async () => {
  const e = env();
  assert.deepEqual(await (await get(e, 'hub/config/day', DAY_SECRET)).json(), { dinner_window: null });
  assert.equal((await setConfig(e, 'dinner_window', '18:00-21:00')).status, 200);
  assert.deepEqual(await (await get(e, 'hub/config/day', DAY_SECRET)).json(), { dinner_window: '18:00-21:00' });
  assert.equal((await get(e, 'hub/config/day', 'wrong')).status, 401);
  assert.equal((await get(e, 'hub/config/defence-digest', DAY_SECRET)).status, 401);
  assert.equal((await setConfig(e, 'dinner_window', '18:00-21:00', 'wrong')).status, 401);
  assert.equal((await setConfig(e, 'dinner_window', '21:00-18:00')).status, 400);
  assert.equal((await setConfig(e, 'dinner_window', '7pm')).status, 400);
  assert.equal((await setConfig(e, 'other', 'x')).status, 404);
  assert.equal((await setConfig(e, 'dinner_window', null)).status, 200);
  assert.deepEqual(await (await get(e, 'hub/config/day', DAY_SECRET)).json(), { dinner_window: null });
});

test('CONFIG.dinner_window: same evening, end after start', () => {
  assert.equal(CONFIG.dinner_window(' 17:30-20:45 '), '17:30-20:45');
  assert.equal(CONFIG.dinner_window('20:00-20:00'), null);
  assert.equal(CONFIG.dinner_window('22:00-01:00'), null);
  assert.equal(CONFIG.dinner_window('24:00-25:00'), null);
});

test('awayNow: the newest seq per base decides; back and past dates drop out', () => {
  const p = (o) => JSON.stringify(o);
  const rows = [
    { id: BASE + ':1', type: 'dinner.away', payload: p({ date: '2026-10-14', title: 'Old title', start: '19:00' }) },
    { id: BASE + ':2', type: 'dinner.away', payload: p({ date: '2026-10-14', title: 'Dinner with Sam', start: '19:30' }) },
    { id: 'dinner:1111111111111111:2026-10-13:1', type: 'dinner.away', payload: p({ date: '2026-10-13', title: 'Gone', start: '19:00' }) },
    { id: 'dinner:1111111111111111:2026-10-13:2', type: 'dinner.back', payload: p({ date: '2026-10-13' }) },
    { id: 'dinner:2222222222222222:2026-10-11:1', type: 'dinner.away', payload: p({ date: '2026-10-11', title: 'Yesterday', start: '19:00' }) },
    { id: 'dinner:3333333333333333:2026-10-12:1', type: 'dinner.away', payload: p({ date: '2026-10-12', title: 'Tonight', start: '18:30' }) },
  ];
  assert.deepEqual(awayNow(rows, '2026-10-12', '2026-10-19'), [
    { date: '2026-10-12', title: 'Tonight', start: '18:30' },
    { date: '2026-10-14', title: 'Dinner with Sam', start: '19:30' },
  ]);
});

test("Morning's block carries the title; Kitchen's does not", async () => {
  const e = env();
  await post(e, away(1));
  await drain(e);
  assert.deepEqual(await dinnerBlock(e, NOW), { away: [{ date: '2026-10-14', title: 'Dinner with Sam', start: '19:30' }] });
  await post(e, back(2));
  assert.equal(await dinnerBlock(e, NOW), null);
});
