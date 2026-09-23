import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListStore } from '../src/list.js';
import { MemStorage } from './mem.js';
import { cleanOp, MAX_ITEMS } from '../src/todo.js';

const NOW = Date.UTC(2026, 8, 23, 12);
const DAY = 86400000;
const up = (id, over = {}) => cleanOp({ op: 'upsert', item: { id, text: 'x', section: 'today', done: false, doneAt: null, updatedAt: NOW - 1000, pos: NOW, ...over } }, NOW);
const del = (id, updatedAt) => cleanOp({ op: 'delete', item: { id, updatedAt } }, NOW);

test('one row per task, rev bumps only on change, since is cheap', async () => {
  const s = new ListStore(new MemStorage());
  let r = await s.apply([up('aaaaaaaa'), up('bbbbbbbb')], NOW);
  assert.equal(r.rev, 1);
  assert.equal(r.items.length, 2);
  r = await s.apply([up('aaaaaaaa')], NOW);
  assert.equal(r.rev, 1);
  assert.deepEqual(await s.read(1), { unchanged: true, rev: 1 });
  assert.equal((await s.read(0)).items.length, 2);
});

test('delete writes a tombstone and removes the row; count follows', async () => {
  const st = new MemStorage();
  const s = new ListStore(st);
  await s.apply([up('aaaaaaaa'), up('bbbbbbbb')], NOW);
  await s.apply([del('aaaaaaaa', NOW - 500)], NOW);
  const all = await s.exportAll();
  assert.deepEqual(Object.keys(all.items), ['bbbbbbbb']);
  assert.equal(all.tombs.aaaaaaaa, NOW - 500);
  assert.equal((await st.get('meta')).count, 1);
  // a stale upsert from an old device does not resurrect it
  await s.apply([up('aaaaaaaa', { updatedAt: NOW - 900 })], NOW);
  assert.equal((await s.read(null)).items.length, 1);
});

test('tombstones older than 90 days are pruned on a later write', async () => {
  const st = new MemStorage();
  const s = new ListStore(st);
  await s.apply([del('oldoldol', NOW - 91 * DAY), del('newnewne', NOW - 10 * DAY)], NOW - 2 * DAY);
  await s.apply([up('cccccccc')], NOW);
  const all = await s.exportAll();
  assert.deepEqual(Object.keys(all.tombs), ['newnewne']);
});

test('batches larger than 128 keys are chunked', async () => {
  const s = new ListStore(new MemStorage());
  const ops = Array.from({ length: 200 }, (_, i) => up('t' + String(i).padStart(8, '0')));
  const r = await s.apply(ops, NOW);
  assert.equal(r.items.length, 200);
});

test('a full list refuses new tasks without writing', async () => {
  const st = new MemStorage();
  await st.put('meta', { rev: 3, updated: null, count: MAX_ITEMS, pruned: NOW });
  const s = new ListStore(st);
  const r = await s.apply([up('aaaaaaaa')], NOW);
  assert.equal(r.error, 'list full');
  assert.equal((await st.get('meta')).rev, 3);
});
