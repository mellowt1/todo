// Repeating tasks: the next date, the next task, the cron's back-up, bins and the Thema avond merge.
// No network; the list is the real Durable Object code in memory. Every name is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanOp } from '../src/todo.js';
import { addMonths, nextDate, successor, missingNext, binsTask, binsText, themaOps, repeatCron, THEMA_KEY } from '../src/repeat.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const DAY = 864e5;
// Wednesday 21 October 2026, 16:00 in Amsterdam.
const NOW = Date.parse('2026-10-21T14:00:00Z');
const TODAY = '2026-10-21';
const task = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: NOW - 3 * DAY, pos: NOW - 3 * DAY, ...extra });
const doneTask = (id, text, extra = {}) => task(id, text, 'today', { done: true, doneAt: NOW - 60000, updatedAt: NOW - 60000, ...extra });
const memKV = () => {
  const m = new Map();
  return { m, async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); } };
};
const list = (e) => e.TODO_LIST.get('todo:' + CODE);
async function seed(e, items) {
  await list(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: items.map((item) => ({ op: 'upsert', item })) }) });
}
const read = async (e) => (await (await list(e).fetch('https://list/export')).json());

test('cleanOp keeps a valid repeat and series and refuses bad ones', () => {
  const base = { id: 'abcdefgh0001', text: 'Bins · 2026-10-27', section: 'soon', updatedAt: NOW, pos: NOW };
  assert.deepEqual(cleanOp({ op: 'upsert', item: { ...base, repeat: { every: '2weeks', until: '2026-12-07' }, series: 'abcdefgh0000' } }, NOW).item.repeat, { every: '2weeks', until: '2026-12-07' });
  assert.deepEqual(cleanOp({ op: 'upsert', item: { ...base, repeat: { every: 'week' } } }, NOW).item.repeat, { every: 'week', until: null });
  assert.equal(cleanOp({ op: 'upsert', item: { ...base, repeat: null } }, NOW).item.repeat, null);
  assert.equal(cleanOp({ op: 'upsert', item: { ...base, repeat: { every: 'daily' } } }, NOW), null);
  assert.equal(cleanOp({ op: 'upsert', item: { ...base, repeat: { every: 'week', until: '7 Dec' } } }, NOW), null);
  assert.equal(cleanOp({ op: 'upsert', item: { ...base, series: 'Not an id!' } }, NOW), null);
});

test('nextDate: on the schedule, missed ones skipped, months clamp, until stops it', () => {
  assert.equal(nextDate('2026-11-09', '2weeks', '2026-11-09'), '2026-11-23');
  assert.equal(nextDate('2026-11-09', '2weeks', '2026-11-01'), '2026-11-23'); // ticked early
  assert.equal(nextDate('2026-10-19', 'week', '2026-10-22'), '2026-10-26'); // Monday's, ticked Thursday
  assert.equal(nextDate('2026-10-05', 'week', '2026-10-26'), '2026-10-26'); // three missed: the one due today
  assert.equal(nextDate('2026-01-31', 'month', '2026-01-31'), '2026-02-28');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(nextDate('2026-11-23', '2weeks', '2026-11-23', '2026-12-07'), '2026-12-07');
  assert.equal(nextDate('2026-12-07', '2weeks', '2026-12-07', '2026-12-07'), null);
});

test('successor: date swapped, time and [intake] kept, fixed id from the series', () => {
  const it = doneTask('thema0000001', 'Thema avond · 2026-11-09 19:30', { repeat: { every: '2weeks', until: null } });
  const n = successor(it, TODAY, NOW);
  assert.equal(n.text, 'Thema avond · 2026-11-23 19:30');
  assert.equal(n.id, 'thema000000120261123');
  assert.equal(n.series, 'thema0000001');
  assert.equal(n.section, 'soon');
  assert.equal(successor({ ...n, done: true }, TODAY, NOW).id, 'thema000000120261207'); // the series id, not the chain
  assert.equal(successor(doneTask('letter000001', 'Pay · 2026-10-20 [intake]', { repeat: { every: 'month', until: null } }), TODAY, NOW).text, 'Pay · 2026-11-20 [intake]');
  assert.equal(successor(doneTask('nodate000001', 'No date', { repeat: { every: 'week', until: null } }), TODAY, NOW), null);
  assert.equal(successor(doneTask('bins20261028', 'Bins · 2026-10-27', { repeat: { every: 'bins', until: null } }), TODAY, NOW), null);
  assert.ok(cleanOp({ op: 'upsert', item: n }, NOW));
});

test('missingNext: makes what the app did not, never a deleted one or an old tick', () => {
  const r = { repeat: { every: 'week', until: null } };
  const doc = {
    items: {
      a: doneTask('aaaaaaaa0001', 'Water the plants · 2026-10-21', r),
      b: doneTask('bbbbbbbb0001', 'Call home · 2026-10-21', r),
      bbbbbbbb000120261028: task('bbbbbbbb000120261028', 'Call home · 2026-10-28', 'soon'),
      c: doneTask('cccccccc0001', 'Old one · 2026-09-01', { ...r, doneAt: NOW - 40 * DAY }),
      d: doneTask('dddddddd0001', 'Undone next · 2026-10-21', r),
    },
    tombs: { dddddddd000120261028: NOW - 1000 },
  };
  assert.deepEqual(missingNext(doc, TODAY, NOW).map((x) => x.id), ['aaaaaaaa000120261028']);
});

test('binsTask: one open bins task, the day before the next collection', () => {
  const cols = [{ date: '2026-10-21', types: ['GFT', 'Restafval'] }, { date: '2026-10-28', types: ['GFT', 'Restafval'] }, { date: '2026-11-03', types: ['Papier'] }];
  const empty = { items: {}, tombs: {} };
  const t = binsTask(empty, cols, TODAY, NOW);
  assert.equal(t.id, 'bins20261028');
  assert.equal(t.text, 'Put the bins out (GFT and Restafval) · 2026-10-27');
  assert.equal(t.section, 'soon');
  assert.deepEqual(t.repeat, { every: 'bins', until: null });
  assert.equal(binsTask({ items: { [t.id]: t }, tombs: {} }, cols, TODAY, NOW), null); // one is open
  assert.equal(binsTask({ items: { [t.id]: { ...t, done: true } }, tombs: {} }, cols, TODAY, NOW).id, 'bins20261103');
  assert.equal(binsTask({ items: {}, tombs: { bins20261028: NOW } }, cols, TODAY, NOW).id, 'bins20261103');
  assert.equal(binsText({ date: '2026-11-04', types: ['GFT', 'Restafval', 'Papier'] }), 'Put the bins out (GFT, Restafval and Papier) · 2026-11-03');
  assert.equal(binsTask(empty, cols, '2026-10-27', NOW).section, 'today');
});

test('themaOps: the earliest keeps the date and repeats every 2 weeks to the last; the rest go', () => {
  const doc = { items: {
    x: task('thema0000003', 'Thema avond Groep A & B samen · 2026-12-07', 'soon'),
    y: task('thema0000001', 'Thema avond Groep A & B samen · 2026-11-09', 'soon', { energy: 'normal' }),
    z: task('thema0000002', 'Thema avond Groep A & B samen · 2026-11-23', 'soon'),
    w: task('other0000001', 'Something else · 2026-11-09', 'soon'),
  }, tombs: {} };
  const ops = themaOps(doc, NOW);
  assert.equal(ops.length, 3);
  assert.equal(ops[0].op, 'upsert');
  assert.equal(ops[0].item.id, 'thema0000001');
  assert.equal(ops[0].item.text, 'Thema avond Groep A & B samen · 2026-11-09');
  assert.equal(ops[0].item.energy, 'normal');
  assert.deepEqual(ops[0].item.repeat, { every: '2weeks', until: '2026-12-07' });
  assert.deepEqual(ops.slice(1).map((o) => [o.op, o.item.id]), [['delete', 'thema0000002'], ['delete', 'thema0000003']]);
  assert.deepEqual(themaOps({ items: { y: doc.items.y }, tombs: {} }, NOW), []);
});

test('repeatCron: merges Thema once, makes a missing next one, adds the bins task', async () => {
  const kv = memKV();
  // The bins block reads Morning's cache, so seed the cache it reads.
  const e = { HUB_KV: kv, TODO_LIST: memNamespace(), TODO_CODE: CODE };
  await seed(e, [
    task('thema0000001', 'Thema avond Groep A & B samen · 2026-11-09', 'soon'),
    task('thema0000002', 'Thema avond Groep A & B samen · 2026-11-23', 'soon'),
    task('thema0000003', 'Thema avond Groep A & B samen · 2026-12-07', 'soon'),
    doneTask('plants000001', 'Water the plants · 2026-10-21', { repeat: { every: 'week', until: null } }),
  ]);
  const out = await repeatCron(e, NOW);
  assert.deepEqual(out, { thema: 3, next: 1 });
  const d = await read(e);
  assert.deepEqual(d.items.thema0000001.repeat, { every: '2weeks', until: '2026-12-07' });
  assert.equal(d.items.thema0000002, undefined);
  assert.ok(d.tombs.thema0000003);
  assert.equal(d.items.plants00000120261028.text, 'Water the plants · 2026-10-28');
  assert.ok(kv.m.get(THEMA_KEY));

  // A second run changes nothing.
  assert.deepEqual(await repeatCron(e, NOW + 15 * 60000), { next: 0 });
});
