// Day plans dated to-dos: which open tasks go, as what, and who may read them. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { dayTasks, PAST_DAYS, undatedAppointments } from '../src/dayplan.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const SECRET = 'day-secret-for-tests';
const item = (id, text, done = false) => ({ id, text, section: 'soon', done, doneAt: done ? 1 : null, updatedAt: 1, pos: 1 });

test('dayTasks: dated open tasks only, time optional, no [intake] mark, masked, by date then time', () => {
  const out = dayTasks([
    item('aaaaaaaa', 'Dentist · 2026-10-23 14:00'),
    item('bbbbbbbb', 'Buy cat food · 2026-10-21'),
    item('cccccccc', 'No date here'),
    item('dddddddd', 'Done one · 2026-10-21', true),
    item('eeeeeeee', 'Pay CJIB 1234567890 · 2026-10-22 [intake]'),
    item('ffffffff', 'Too old · 2026-09-01'),
    item('gggggggg', 'Call Bas · 2026-10-21 09:30'),
  ], '2026-10-19');
  assert.deepEqual(out, [
    { id: 'bbbbbbbb', title: 'Buy cat food', date: '2026-10-21', time: null },
    { id: 'gggggggg', title: 'Call Bas', date: '2026-10-21', time: '09:30' },
    { id: 'eeeeeeee', title: 'Pay CJIB ··7890', date: '2026-10-22', time: null },
    { id: 'aaaaaaaa', title: 'Dentist', date: '2026-10-23', time: '14:00' },
  ]);
  assert.equal(PAST_DAYS, 14);
  assert.equal(dayTasks([item('hhhhhhhh', 'Late · 2026-10-05')], '2026-10-19').length, 1, '14 days back still shows');
});

test('GET /api/hub/todo/day: needs HUB_SECRET_DAY, reads the list', async () => {
  const env = { TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_SECRET_DAY: SECRET };
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + CODE));
  await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'upsert', item: item('aaaaaaaa', 'Dentist · 2099-10-23 14:00') }] }) });
  const get = (auth) => worker.fetch(new Request('https://hub.example/api/hub/todo/day', { headers: auth ? { authorization: 'Bearer ' + auth } : {} }), env);
  assert.equal((await get(null)).status, 401);
  assert.equal((await get('wrong')).status, 401);
  const r = await get(SECRET);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.tasks, [{ id: 'aaaaaaaa', title: 'Dentist', date: '2099-10-23', time: '14:00' }]);
});

test('appointments: dated ones say so, undated ones are listed for Day, newest first', () => {
  const appt = (id, text, pos, over = {}) => ({ ...item(id, text), appt: true, pos, ...over });
  const items = [
    appt('aaaaaaaa', 'Psychologist visit', 5),
    appt('bbbbbbbb', 'Peronik · 2026-11-09 12:45', 4),
    appt('cccccccc', 'Haircut Ollie', 9),
    appt('dddddddd', 'Dentist', 7, { done: true, doneAt: 1 }),
    item('eeeeeeee', 'Not an appointment'),
  ];
  assert.deepEqual(undatedAppointments(items), [{ id: 'cccccccc', title: 'Haircut Ollie' }, { id: 'aaaaaaaa', title: 'Psychologist visit' }]);
  assert.deepEqual(dayTasks(items, '2026-11-04'), [{ id: 'bbbbbbbb', title: 'Peronik', date: '2026-11-09', time: '12:45', appt: true }]);
});
