// Retiring Others: open and done Others tasks move to Soon once, with the person's name in front.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retireOthers, retiredOp, RETIRED_KEY } from '../src/retire.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const NOW = Date.parse('2026-10-17T15:00:00Z');
const memKV = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; };

test('retiredOp: name in front once, done kept, other sections left alone', () => {
  const base = { id: 'task00000001', text: 'Set up the printer', section: 'others', person: 'Dad', done: false, doneAt: null, updatedAt: NOW - 5, pos: NOW - 9 };
  assert.deepEqual(retiredOp(base, NOW).item, { id: 'task00000001', text: 'Dad: Set up the printer', section: 'soon', done: false, doneAt: null, updatedAt: NOW, pos: NOW - 9 });
  assert.equal(retiredOp({ ...base, text: 'Dad: printer' }, NOW).item.text, 'Dad: printer');
  assert.equal(retiredOp({ ...base, person: undefined }, NOW).item.text, 'Set up the printer');
  const done = retiredOp({ ...base, done: true, doneAt: NOW - 3, handedBack: true }, NOW).item;
  assert.deepEqual([done.done, done.doneAt, done.handedBack], [true, NOW - 3, undefined]);
  assert.equal(retiredOp({ ...base, section: 'soon' }, NOW), null);
});

test('retireOthers moves them once through the list itself', async () => {
  const e = { TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: memKV() };
  const stub = e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
  // Stored by the old Worker, which knew the Others section: written straight into the storage.
  const st = e.TODO_LIST.storages.get('todo:' + CODE);
  await stub.fetch('https://list/read');
  const doc = { items: {
    a0000000001: { id: 'a0000000001', text: 'Printer', section: 'others', person: 'Dad', done: false, doneAt: null, updatedAt: NOW - 9, pos: NOW - 9 },
    b0000000001: { id: 'b0000000001', text: 'Mine', section: 'today', done: false, doneAt: null, updatedAt: NOW - 9, pos: NOW - 9 },
  }, tombs: {} };
  for (const [k, v] of await st.list()) if (k.startsWith('i:')) await st.delete(k);
  await st.put(Object.fromEntries(Object.values(doc.items).map((it) => ['i:' + it.id, it])));
  assert.deepEqual(await retireOthers(e, NOW), { moved: 1 });
  const items = (await (await stub.fetch('https://list/export')).json()).items;
  assert.deepEqual([items.a0000000001.text, items.a0000000001.section, items.a0000000001.person], ['Dad: Printer', 'soon', undefined]);
  assert.equal(items.b0000000001.section, 'today');
  assert.ok(e.HUB_KV.m.has(RETIRED_KEY));
  assert.deepEqual(await retireOthers(e, NOW + 1), { skip: 'done' });
});
