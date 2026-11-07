// Cleaning chores on Paul's cleaning weekend: seven Today tasks once per turn of his, nothing on
// Robin's or the shared weekend, a deleted one stays gone. Every name is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleaningOps, cleaningCron, cleanId, CHORES } from '../src/cleaning.js';
import { dayTasks } from '../src/dayplan.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const ROTAS = JSON.stringify([{ what: 'Cleaning', from: '2026-10-03', every: 7, days: 2, turns: ['You', 'Robin', 'Both of you'] }]);
const at = (iso) => Date.parse(iso);
const SAT = at('2026-11-14T08:00:00Z'); // Paul's turn, Saturday 14 Nov
const SUN = at('2026-11-15T18:00:00Z');
const empty = () => ({ items: {}, tombs: {} });

test("Paul's weekend puts the seven chores in Today, in order", () => {
  const ops = cleaningOps(empty(), ROTAS, SAT);
  assert.deepEqual(ops.map((o) => o.item.text), CHORES.map((c) => c[1]));
  assert.ok(ops.every((o) => o.op === 'upsert' && o.item.section === 'today' && !o.item.done));
  assert.equal(ops[0].item.id, 'clean20261114kitchen');
  assert.ok(ops[0].item.pos > ops[6].item.pos); // Kitchen first
  assert.equal(cleaningOps(empty(), ROTAS, SUN).length, 7); // Sunday too, same ids
  assert.equal(cleaningOps(empty(), ROTAS, SUN)[0].item.id, 'clean20261114kitchen');
});

test("nothing on Robin's weekend, the shared one, or a weekday", () => {
  assert.deepEqual(cleaningOps(empty(), ROTAS, at('2026-11-21T08:00:00Z')), []); // Robin
  assert.deepEqual(cleaningOps(empty(), ROTAS, at('2026-11-07T08:00:00Z')), []); // both of you
  assert.deepEqual(cleaningOps(empty(), ROTAS, at('2026-11-12T08:00:00Z')), []); // Thursday before
  assert.deepEqual(cleaningOps(empty(), null, SAT), []);
  assert.deepEqual(cleaningOps(empty(), 'not json', SAT), []);
});

test('made once: present, ticked or deleted chores are not made again', () => {
  const first = cleaningOps(empty(), ROTAS, SAT);
  const doc = { items: Object.fromEntries(first.map((o) => [o.item.id, o.item])), tombs: {} };
  assert.deepEqual(cleaningOps(doc, ROTAS, SAT + 900000), []);
  const id = cleanId('2026-11-14', 'stairs');
  delete doc.items[id];
  doc.tombs[id] = SAT;
  assert.deepEqual(cleaningOps(doc, ROTAS, SUN), []);
});

test("open chores from an earlier turn go when Paul's next one starts; done ones stay", () => {
  const old = { id: cleanId('2026-10-24', 'office'), text: 'Clean office', section: 'today', done: false, updatedAt: 1, pos: 1 };
  const ticked = { ...old, id: cleanId('2026-10-24', 'toilet'), done: true, doneAt: 2 };
  const doc = { items: { [old.id]: old, [ticked.id]: ticked }, tombs: {} };
  assert.deepEqual(cleaningOps(doc, ROTAS, at('2026-11-07T08:00:00Z')), []); // not his turn: left alone
  const ops = cleaningOps(doc, ROTAS, SAT);
  assert.deepEqual(ops.filter((o) => o.op === 'delete').map((o) => o.item.id), [old.id]);
  assert.equal(ops.filter((o) => o.op === 'upsert').length, 7);
});

test('Day leaves the chores out (no date in the text)', () => {
  const items = cleaningOps(empty(), ROTAS, SAT).map((o) => o.item);
  assert.deepEqual(dayTasks(items, '2026-11-14'), []);
});

test('cleaningCron writes the list once', async () => {
  const e = { TODO_LIST: memNamespace(), TODO_CODE: CODE, ROTAS };
  assert.deepEqual(await cleaningCron({ ...e, ROTAS: undefined }, SAT), { skip: 'not configured' });
  const r = await cleaningCron(e, SAT);
  assert.equal(r.cleaning.length, 7);
  assert.equal(r.cleaning[0], '+clean20261114kitchen');
  assert.deepEqual(await cleaningCron(e, SAT + 900000), { cleaning: [] });
  const d = await (await e.TODO_LIST.get('todo:' + CODE).fetch('https://list/export')).json();
  assert.equal(d.items.clean20261114bedroom.text, 'Clean bedroom');
  assert.equal(d.items.clean20261114bedroom.section, 'today');
});
