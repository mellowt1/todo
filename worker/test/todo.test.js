import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDoc, cleanOp, cleanBatch, applyOps, pruneTombs, openView, safeEqual, MAX_OPS, MAX_TEXT,
} from '../src/todo.js';

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const item = (id, over = {}) => ({
  id, text: 'Buy coffee beans', section: 'today', done: false, doneAt: null, updatedAt: NOW - 1000, pos: NOW - 1000, ...over,
});
const up = (id, over) => cleanOp({ op: 'upsert', item: item(id, over) }, NOW);
const del = (id, updatedAt) => cleanOp({ op: 'delete', item: { id, updatedAt } }, NOW);

test('newest updatedAt wins per task', () => {
  const doc = emptyDoc();
  applyOps(doc, [up('aaaaaaaa', { text: 'phone', updatedAt: NOW - 500 })]);
  applyOps(doc, [up('aaaaaaaa', { text: 'desktop older', updatedAt: NOW - 900 })]);
  assert.equal(doc.items.aaaaaaaa.text, 'phone');
  applyOps(doc, [up('aaaaaaaa', { text: 'desktop newer', updatedAt: NOW - 100 })]);
  assert.equal(doc.items.aaaaaaaa.text, 'desktop newer');
});

test('edits to different tasks never overwrite each other', () => {
  const doc = emptyDoc();
  applyOps(doc, [up('aaaaaaaa', { updatedAt: NOW - 900 }), up('bbbbbbbb', { updatedAt: NOW - 900 })]);
  applyOps(doc, [up('aaaaaaaa', { section: 'soon', updatedAt: NOW - 100 })]); // phone
  applyOps(doc, [up('bbbbbbbb', { done: true, doneAt: NOW - 200, updatedAt: NOW - 200 })]); // desktop, older clock
  assert.equal(doc.items.aaaaaaaa.section, 'soon');
  assert.equal(doc.items.bbbbbbbb.done, true);
});

test('a resent batch changes nothing', () => {
  const doc = emptyDoc();
  const ops = [up('aaaaaaaa')];
  assert.equal(applyOps(doc, ops).changed, true);
  assert.equal(applyOps(doc, ops).changed, false);
});

test('a delete leaves a tombstone that beats an older upsert', () => {
  const doc = emptyDoc();
  applyOps(doc, [up('aaaaaaaa', { updatedAt: NOW - 900 })]);
  applyOps(doc, [del('aaaaaaaa', NOW - 500)]);
  assert.equal(doc.items.aaaaaaaa, undefined);
  assert.equal(doc.tombs.aaaaaaaa, NOW - 500);
  const r = applyOps(doc, [up('aaaaaaaa', { updatedAt: NOW - 700 })]); // stale device
  assert.equal(r.changed, false);
  assert.equal(doc.items.aaaaaaaa, undefined);
});

test('an edit made after the delete brings the task back', () => {
  const doc = emptyDoc();
  applyOps(doc, [del('aaaaaaaa', NOW - 500)]);
  applyOps(doc, [up('aaaaaaaa', { updatedAt: NOW - 100 })]);
  assert.ok(doc.items.aaaaaaaa);
  assert.equal(doc.tombs.aaaaaaaa, undefined);
});

test('an older delete does not remove a newer task', () => {
  const doc = emptyDoc();
  applyOps(doc, [up('aaaaaaaa', { updatedAt: NOW - 100 })]);
  assert.equal(applyOps(doc, [del('aaaaaaaa', NOW - 500)]).changed, false);
  assert.ok(doc.items.aaaaaaaa);
});

test('tombstones older than 90 days are pruned', () => {
  const doc = emptyDoc();
  doc.tombs.old00000 = NOW - 91 * 86400000;
  doc.tombs.new00000 = NOW - 89 * 86400000;
  assert.equal(pruneTombs(doc, NOW), 1);
  assert.deepEqual(Object.keys(doc.tombs), ['new00000']);
});

test('validation drops anything off the whitelist', () => {
  assert.equal(cleanOp({ op: 'upsert', item: item('SHOUTING') }, NOW), null);
  assert.equal(cleanOp({ op: 'upsert', item: item('short') }, NOW), null);
  assert.equal(cleanOp({ op: 'upsert', item: item('aaaaaaaa', { section: 'later' }) }, NOW), null);
  assert.equal(cleanOp({ op: 'upsert', item: item('aaaaaaaa', { text: '   ' }) }, NOW), null);
  assert.equal(cleanOp({ op: 'upsert', item: item('aaaaaaaa', { text: 'x'.repeat(MAX_TEXT + 1) }) }, NOW), null);
  assert.equal(cleanOp({ op: 'upsert', item: item('aaaaaaaa', { updatedAt: 'soon' }) }, NOW), null);
  assert.equal(cleanOp({ op: 'drop', item: item('aaaaaaaa') }, NOW), null);
  const op = cleanOp({ op: 'upsert', item: { ...item('aaaaaaaa'), evil: '<script>', text: '  two\n lines ' } }, NOW);
  assert.equal(op.item.evil, undefined);
  assert.equal(op.item.text, 'two lines');
});

test('a clock far in the future is clamped to now', () => {
  const op = up('aaaaaaaa', { updatedAt: NOW + 86400000 });
  assert.ok(op.item.updatedAt <= NOW + 5 * 60 * 1000);
});

test('batch caps; a bad op is skipped on its own and reported', () => {
  assert.equal(cleanBatch({ ops: [] }, NOW).error, 'ops empty');
  const many = Array.from({ length: MAX_OPS + 1 }, (_, i) => ({ op: 'upsert', item: item('a' + String(i).padStart(8, '0')) }));
  assert.equal(cleanBatch({ ops: many }, NOW).error, 'too many ops');
  const r = cleanBatch({ ops: [{ op: 'upsert', item: item('aaaaaaaa') }, { op: 'upsert' }, { op: 'upsert', item: item('bbbbbbbb', { text: '' }) }] }, NOW);
  assert.equal(r.ops.length, 1);
  assert.deepEqual(r.rejected, [1, 2]);
  assert.equal(cleanBatch({ ops: [{ op: 'upsert', item: item('aaaaaaaa') }] }, NOW).ops.length, 1);
  assert.equal(cleanBatch({ ops: 'x' }, NOW).error, 'ops required');
});

test('open view shows open tasks with section only', () => {
  const doc = emptyDoc();
  applyOps(doc, [
    up('aaaaaaaa', { text: 'open one', section: 'soon' }),
    up('bbbbbbbb', { text: 'finished', done: true, doneAt: NOW - 10 }),
  ]);
  assert.deepEqual(openView(doc), [{ text: 'open one', section: 'soon' }]);
});

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual(undefined, 'x'), false);
});
