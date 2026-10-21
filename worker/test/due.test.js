// Dates drive placement: a task whose date has come moves into Today, once per date.
// No network; the list is the real Durable Object code in memory. Every name is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueDate, dueMoves, dueCron, MOVED_KEY } from '../src/due.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const DAY = 864e5;
// Thursday 22 October 2026, 00:15 in Amsterdam (CEST): just past midnight.
const THU = Date.parse('2026-10-21T22:15:00Z');
const memKV = () => {
  const m = new Map();
  return { m, async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); } };
};
const env = () => ({ HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE });
const task = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: THU - 3 * DAY, pos: THU - 20 * DAY, ...extra });
const list = (e) => e.TODO_LIST.get('todo:' + CODE);
async function seed(e, items) {
  await list(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: items.map((item) => ({ op: 'upsert', item })) }) });
}
const read = async (e) => (await (await list(e).fetch('https://list/export')).json()).items;
async function upsert(e, item) {
  await list(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'upsert', item }] }) });
}

test('dueDate reads the date at the end, with a time or [intake] after it', () => {
  assert.equal(dueDate('Return the lamp · 2026-10-25'), '2026-10-25');
  assert.equal(dueDate('Meeting with Sam · 2026-10-22 16:00'), '2026-10-22');
  assert.equal(dueDate('Choose: pay at once or monthly · 2026-11-06 [intake]'), '2026-11-06');
  assert.equal(dueDate('No date here'), null);
  assert.equal(dueDate('A date 2026-10-25 in the middle'), null);
  assert.equal(dueDate(null), null);
});

test('dueMoves: today and overdue move from Soon and Someday; future, undated, done and Today stay', () => {
  const items = {
    a: task('a', 'Meeting · 2026-10-22 16:00', 'soon'),
    b: task('b', 'Overdue · 2026-10-19', 'someday'),
    c: task('c', 'Later · 2026-10-25', 'soon'),
    d: task('d', 'Undated', 'soon'),
    e: task('e', 'Already in Today · 2026-10-22', 'today'),
    f: { ...task('f', 'Done · 2026-10-22', 'soon'), done: true, doneAt: THU },
  };
  const { move, keep } = dueMoves(items, {}, '2026-10-22');
  assert.deepEqual(move.map((i) => i.id).sort(), ['a', 'b']);
  assert.deepEqual(keep, { a: '2026-10-22', b: '2026-10-19', e: '2026-10-22' });
});

test('dueMoves: a task moved once for its date stays where Paul put it; a new date moves it again', () => {
  const items = { a: task('a', 'Meeting · 2026-10-22', 'soon'), b: task('b', 'Call · 2026-10-23', 'soon') };
  const moved = { a: '2026-10-22', b: '2026-10-20', gone: '2026-10-01' };
  const { move, keep } = dueMoves(items, moved, '2026-10-23');
  assert.deepEqual(move.map((i) => i.id), ['b']);
  assert.deepEqual(keep, { a: '2026-10-22', b: '2026-10-23' }); // the gone task's mark is dropped
});

test('dueCron moves the task into Today with text and pos unchanged, once', async () => {
  const e = env();
  const lamp = task('lamp00000001', 'Return the lamp · 2026-10-22', 'soon');
  const later = task('later0000001', 'Book flights · 2026-11-02', 'soon');
  const intake = task('intake000001', 'Choose: pay at once or monthly · 2026-10-21 [intake]', 'someday', { link: 'https://example.com/x' });
  await seed(e, [lamp, later, intake]);

  assert.deepEqual(await dueCron(e, THU), { moved: 2 });
  let items = await read(e);
  assert.equal(items.lamp00000001.section, 'today');
  assert.equal(items.lamp00000001.text, lamp.text);
  assert.equal(items.lamp00000001.pos, lamp.pos);
  assert.ok(items.lamp00000001.updatedAt > lamp.updatedAt);
  assert.equal(items.intake000001.section, 'today');
  assert.equal(items.intake000001.link, 'https://example.com/x');
  assert.equal(items.later0000001.section, 'soon');
  assert.deepEqual(JSON.parse(e.HUB_KV.m.get(MOVED_KEY)), { lamp00000001: '2026-10-22', intake000001: '2026-10-21' });

  // Paul moves the lamp back to Soon the same day: the next runs leave it there.
  await upsert(e, { ...items.lamp00000001, section: 'soon', updatedAt: THU + 60000 });
  assert.deepEqual(await dueCron(e, THU + 15 * 60000), { moved: 0 });
  items = await read(e);
  assert.equal(items.lamp00000001.section, 'soon');
});

test('dueCron with nothing due writes nothing', async () => {
  const e = env();
  await seed(e, [task('later0000001', 'Book flights · 2026-11-02', 'soon'), task('plain0000001', 'Undated', 'soon')]);
  assert.deepEqual(await dueCron(e, THU), { moved: 0 });
  assert.equal(e.HUB_KV.m.has(MOVED_KEY), false);
});
