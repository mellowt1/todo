// Gym days in the to-do: Lift's planned day makes a Today task, a workout ticks it, a missed day
// drops it, a deleted one stays gone, and Day leaves it out. Every name is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gymOps, gymCron, gymId, gymText } from '../src/gym.js';
import { dayTasks } from '../src/dayplan.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const H = 3600000;
// Thursday 5 November 2026, 09:00 in Amsterdam.
const NOW = Date.parse('2026-11-05T08:00:00Z');
const TODAY = '2026-11-05';
const THU = [false, false, false, true, false, false, false];
const lift = (extra = {}) => ({ next: { name: 'Back', items: [] }, nextDay: null, rotation: ['Back', 'Chest'], days: THU, workouts: [], ...extra });
const empty = () => ({ items: {}, tombs: {} });
const memKV = () => {
  const m = new Map();
  return { m, async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); } };
};

test('a planned gym day makes one Today task with the routine due next', () => {
  const ops = gymOps(empty(), lift(), NOW);
  assert.equal(ops.length, 1);
  assert.deepEqual(
    { id: ops[0].item.id, text: ops[0].item.text, section: ops[0].item.section, done: ops[0].item.done },
    { id: 'gym20261105', text: 'Gym: Back · 2026-11-05', section: 'today', done: false },
  );
});

test('no task on a day that is not a gym day, or with no gym days set', () => {
  assert.deepEqual(gymOps(empty(), lift({ days: [true, false, false, false, false, false, false] }), NOW), []);
  assert.deepEqual(gymOps(empty(), lift({ days: Array(7).fill(false) }), NOW), []);
  assert.deepEqual(gymOps(empty(), lift({ nextDay: '2026-11-07' }), NOW), []); // the phone moved it to Saturday
  assert.deepEqual(gymOps(empty(), null, NOW), []);
});

test('the phone saying today counts even if the weekday is not ticked', () => {
  const ops = gymOps(empty(), lift({ days: [true, false, false, false, false, false, false], nextDay: TODAY }), NOW);
  assert.equal(ops[0].item.id, 'gym20261105');
});

test('already there, or deleted by Paul: nothing made', () => {
  const there = { items: { gym20261105: { id: 'gym20261105', text: gymText('Back', TODAY), section: 'today', done: false, updatedAt: NOW - H, pos: NOW - H } }, tombs: {} };
  assert.deepEqual(gymOps(there, lift(), NOW), []);
  assert.deepEqual(gymOps({ items: {}, tombs: { gym20261105: NOW - H } }, lift(), NOW), []);
});

test("today's workout ticks the task at the workout's end; none is made after it", () => {
  const start = NOW - 2 * H;
  const w = { id: 'w1', name: 'Back', start, end: start + H };
  const doc = { items: { gym20261105: { id: 'gym20261105', text: gymText('Back', TODAY), section: 'today', done: false, doneAt: null, updatedAt: NOW - 3 * H, pos: NOW - 3 * H } }, tombs: {} };
  const ops = gymOps(doc, lift({ workouts: [w] }), NOW);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].item.done, true);
  assert.equal(ops[0].item.doneAt, start + H);
  assert.deepEqual(gymOps(empty(), lift({ workouts: [w] }), NOW), []);
});

test('an extra (home abs) on a gym day ticks nothing and still lets the task be made', () => {
  const start = NOW - 2 * H;
  const w = { id: 'w2', name: 'Home abs', start, end: start + H / 4, extra: true };
  const doc = { items: { gym20261105: { id: 'gym20261105', text: gymText('Back', TODAY), section: 'today', done: false, doneAt: null, updatedAt: NOW - 3 * H, pos: NOW - 3 * H } }, tombs: {} };
  assert.deepEqual(gymOps(doc, lift({ workouts: [w] }), NOW), []);
  assert.equal(gymOps(empty(), lift({ workouts: [w] }), NOW)[0].item.id, 'gym20261105');
});

test('a missed gym day: its open task goes; a done one stays', () => {
  const old = (done) => ({ id: 'gym20261102', text: gymText('Chest', '2026-11-02'), section: 'today', done, doneAt: done ? NOW - 72 * H : null, updatedAt: NOW - 72 * H, pos: NOW - 72 * H });
  const ops = gymOps({ items: { gym20261102: old(false) }, tombs: {} }, lift({ days: Array(7).fill(false) }), NOW);
  assert.deepEqual(ops.map((o) => [o.op, o.item.id]), [['delete', 'gym20261102']]);
  assert.deepEqual(gymOps({ items: { gym20261102: old(true) }, tombs: {} }, lift({ days: Array(7).fill(false) }), NOW), []);
  // Logged late (Lift synced the next day): ticked, not dropped.
  const w = { id: 'w0', name: 'Chest', start: Date.parse('2026-11-02T17:00:00Z'), end: Date.parse('2026-11-02T18:00:00Z') };
  const late = gymOps({ items: { gym20261102: old(false) }, tombs: {} }, lift({ days: Array(7).fill(false), workouts: [w] }), NOW);
  assert.deepEqual(late.map((o) => [o.op, o.item.done]), [['upsert', true]]);
});

test('other tasks are never touched, and Day leaves gym tasks out', () => {
  const doc = { items: { abcdefgh0001: { id: 'abcdefgh0001', text: 'Gym bag · 2026-11-01', section: 'today', done: false, updatedAt: NOW - 99 * H, pos: NOW - 99 * H } }, tombs: {} };
  assert.deepEqual(gymOps(doc, lift({ days: Array(7).fill(false) }), NOW), []);
  const items = [
    { id: gymId(TODAY), text: gymText('Back', TODAY), done: false },
    { id: 'abcdefgh0002', text: 'Dentist · 2026-11-05', done: false },
  ];
  assert.deepEqual(dayTasks(items, TODAY).map((t) => t.id), ['abcdefgh0002']);
});

test('gymCron reads Lift from KV and writes the list; a second run changes nothing', async () => {
  const kv = memKV();
  const e = { HUB_KV: kv, TODO_LIST: memNamespace(), TODO_CODE: CODE };
  assert.deepEqual(await gymCron(e, NOW), { skip: 'no lift state' });
  await kv.put('lift:state', JSON.stringify({ summary: lift(), at: new Date(NOW).toISOString() }));
  assert.deepEqual(await gymCron(e, NOW), { gym: ['+gym20261105'] });
  assert.deepEqual(await gymCron(e, NOW + 15 * 60000), { gym: [] });
  const d = await (await e.TODO_LIST.get('todo:' + CODE).fetch('https://list/export')).json();
  assert.equal(d.items.gym20261105.text, 'Gym: Back · 2026-11-05');
  assert.equal(d.items.gym20261105.section, 'today');
});
