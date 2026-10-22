// Lanes: a lane is a section the list accepts, and Paul's picks move there once.
// No network; the list is the real Durable Object code in memory. Every name is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanOp, SECTIONS, LANES } from '../src/todo.js';
import { laneOps, laneMoves } from '../src/lanes.js';
import { dueMoves } from '../src/due.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const NOW = Date.parse('2026-10-21T14:00:00Z');
const DAY = 864e5;
const task = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: NOW - DAY, pos: NOW - 20 * DAY, ...extra });
const memKV = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; };

test('a lane is a section: the list takes it, the old three stay first', () => {
  assert.deepEqual(LANES, ['build', 'fun']);
  assert.deepEqual(SECTIONS.slice(0, 3), ['today', 'soon', 'someday']);
  assert.equal(cleanOp({ op: 'upsert', item: { ...task('abcdefgh0001', 'An app idea', 'build'), updatedAt: NOW } }, NOW).item.section, 'build');
  assert.equal(cleanOp({ op: 'upsert', item: { ...task('abcdefgh0002', 'Nope', 'nowhere'), updatedAt: NOW } }, NOW), null);
});

test('a dated task in a lane moves into Today on its day', () => {
  const { move } = dueMoves({ a: task('abcdefgh0003', 'Idea with a date · 2026-10-21', 'build') }, {}, '2026-10-21');
  assert.deepEqual(move.map((i) => i.id), ['abcdefgh0003']);
});

test('laneOps: picks move, built ones are ticked; gone, done or moved since are left alone', () => {
  const items = {
    a: task('aaaaaaaa0001', 'Readout', 'soon'),
    b: task('bbbbbbbb0001', 'Moved to Today since', 'today'),
    c: task('cccccccc0001', 'Request one', 'today'),
    d: task('dddddddd0001', 'Request two, done already', 'today', { done: true, doneAt: NOW - DAY }),
  };
  const byId = Object.fromEntries(Object.values(items).map((i) => [i.id, i]));
  const ops = laneOps('build', { from: ['soon'], move: ['aaaaaaaa0001', 'bbbbbbbb0001', 'missing00001'], tick: ['cccccccc0001', 'dddddddd0001'] }, byId, NOW);
  assert.deepEqual(ops.map((o) => [o.item.id, o.item.section, o.item.done]), [['aaaaaaaa0001', 'build', false], ['cccccccc0001', 'today', true]]);
  assert.equal(ops[0].item.text, 'Readout');
  assert.equal(ops[0].item.pos, NOW - 20 * DAY); // the Attack clock stays
});

test('laneMoves runs once', async () => {
  const e = { HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE };
  const stub = e.TODO_LIST.get('todo:' + CODE);
  await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [
    { op: 'upsert', item: task('ng3x9nsfkl36exdk', 'Ask Claude for the Desk friction readout · 2026-10-31', 'soon') },
    { op: 'upsert', item: task('h9b87rzey00logw2', 'To do needs to recognize jobs for skills high score', 'today') },
  ] }) });
  assert.deepEqual(await laneMoves(e, NOW), { build: 2, fun: 0 });
  const items = (await (await stub.fetch('https://list/export')).json()).items;
  assert.equal(items.ng3x9nsfkl36exdk.section, 'build');
  assert.equal(items.h9b87rzey00logw2.done, true);
  assert.deepEqual(await laneMoves(e, NOW + 60000), { build: 'done', fun: 'done' });
});
