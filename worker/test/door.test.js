// Door: locks are cleaned strictly (never a photo), kept newest first and once per id; the cron
// reminds before a timed appointment once, stays quiet at night, in quiet hours, after a lock and
// for calls/online/home events; the route checks the code. No network: fetch is passed in.
// Every title is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLock, addLock, skipEvent, isSubscribedFixture, upcoming, remindAt, dueNow, eventHash, pushText, doorCron, nextReminder, handleDoor, LOCKS_KEY, SENT_PREFIX, DOOR_URL, MAX_LOCKS } from '../src/door.js';
import { CAL_KEY, local } from '../src/morning.js';

const CODE = 'abcdefgh23456789';
const MIN = 60e3, H = 60 * MIN;
const NOW = Date.parse('2026-10-19T16:00:00Z'); // Monday 18:00 in Amsterdam (CEST, +02:00)

const memKV = () => {
  const m = new Map();
  const ttl = new Map();
  return {
    m, ttl,
    async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; },
    async put(k, v, o) { m.set(k, v); if (o && o.expirationTtl) ttl.set(k, o.expirationTtl); },
    async delete(k) { m.delete(k); },
  };
};
const json = (data, request, status = 200) => Response.json(data, { status });
const ev = (title, start, more = {}) => ({ title, start, end: start.replace(/T(\d\d)/, (_, h) => 'T' + String(+h + 1).padStart(2, '0')), allDay: false, location: '', ...more });
const env = (events = [], over = {}) => {
  const e = { TODO_CODE: CODE, NTFY_TOPIC: 'test-topic', HUB_KV: memKV(), ...over };
  e.HUB_KV.m.set(CAL_KEY, JSON.stringify({ sent: '2026-10-19T17:00:00+02:00', received: '2026-10-19T15:00:00Z', events }));
  return e;
};
const pushes = () => {
  const sent = [];
  const f = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  f.sent = sent;
  return f;
};
const call = (e, path, method = 'GET', body, now = NOW) => handleDoor(new Request('https://x/api/door/' + path, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), e, path.split('/'), json, now);

/* ---------- cleanLock / addLock ---------- */

test('a lock is cleaned to four facts', () => {
  assert.deepEqual(cleanLock({ id: 'k3x9', at: NOW - MIN, word: 'Otter', photo: true }, NOW), { lock: { id: 'k3x9', at: NOW - MIN, word: 'Otter', photo: true } });
  assert.deepEqual(cleanLock({ id: 'k3x9', at: NOW }, NOW), { lock: { id: 'k3x9', at: NOW, word: '', photo: false } });
  assert.deepEqual(cleanLock({ id: 'k3x9', at: NOW, word: null }, NOW).lock.word, '');
});

test('a lock is refused when anything is off, and a photo can only be true or false', () => {
  const bad = [
    null, [], 'x',
    { at: NOW },
    { id: 'UPPER', at: NOW },
    { id: 'a'.repeat(41), at: NOW },
    { id: 'a', at: '2026-10-19T16:00:00Z' },
    { id: 'a', at: NOW + 0.5 },
    { id: 'a', at: NOW + 10 * MIN },
    { id: 'a', at: NOW - 31 * 24 * H },
    { id: 'a', at: NOW, word: 'two words' },
    { id: 'a', at: NOW, word: 7 },
    { id: 'a', at: NOW, photo: 'data:image/jpeg;base64,AAAA' },
    { id: 'a', at: NOW, photo: 1 },
    { id: 'a', at: NOW, image: 'data:image/jpeg;base64,AAAA' },
  ];
  for (const b of bad) assert.ok(cleanLock(b, NOW).error, JSON.stringify(b));
});

test('locks stay newest first, once per id, at most 30', () => {
  let list = [];
  for (let i = 0; i < 35; i++) list = addLock(list, { id: 'l' + i, at: NOW - (35 - i) * H, word: '', photo: false }).list;
  assert.equal(list.length, MAX_LOCKS);
  assert.equal(list[0].id, 'l34');
  const again = addLock(list, { id: 'l34', at: NOW, word: 'Otter', photo: true });
  assert.equal(again.dup, true);
  assert.equal(again.list, list);
  const late = addLock(list, { id: 'old', at: NOW - 30 * H, word: '', photo: false }).list; // a queued lock from earlier
  assert.equal(late[0].id, 'l34');
  assert.ok(late.findIndex((l) => l.id === 'old') > 0);
});

/* ---------- which events ---------- */

test('calls, online, home and subscribed fixtures are skipped; real outings are not', () => {
  const skip = ['Call with Mum', 'Bellen met de huisarts', 'Zoom: team sync', 'Teams interview', 'Google Meet with recruiter',
    'Webinar: NATO careers', 'Online intake', 'Deutsch: Ingrid ruft an', 'German call', 'Anruf von Hartmut', 'To-do: pay rent',
    'Gym day', 'Arsenal vs Chelsea', 'Spurs v Arsenal'];
  for (const t of skip) assert.ok(skipEvent({ title: t }), t);
  assert.ok(skipEvent({ title: 'Intake', location: 'https://zoom.us/j/1' }));
  assert.ok(skipEvent({ title: 'Lunch', location: 'Home' }));
  assert.ok(skipEvent({ title: 'Interview', location: 'Microsoft Teams Meeting' }));
  const keep = ['Archery', 'Dentist', 'Meet Tom for coffee', 'Arsenal shop visit', 'Callisto tour', 'Dinner at Olivia\'s parents'];
  for (const t of keep) assert.ok(!skipEvent({ title: t, location: 'Den Haag' }), t);
  assert.ok(isSubscribedFixture('Arsenal vs. Spurs') && !isSubscribedFixture('Arsenal Museum'));
});

test('upcoming: timed, not started, not skipped, soonest first', () => {
  const list = upcoming([
    ev('Dentist', '2026-10-19T20:00:00+02:00'),
    ev('Archery', '2026-10-19T18:30:00+02:00'),
    ev('Earlier', '2026-10-19T17:00:00+02:00'),
    { title: 'Birthday', start: '2026-10-19', end: '2026-10-20', allDay: true },
    ev('Zoom call', '2026-10-19T18:20:00+02:00'),
    ev('', '2026-10-19T18:40:00+02:00'),
  ], NOW);
  assert.deepEqual(list.map((x) => x.e.title), ['Archery', 'Dentist']);
});

test('remindAt: 45 minutes before, never before 06:30, none when no allowed time is left', () => {
  const at = (iso) => { const r = remindAt(Date.parse(iso)); return r === null ? null : local(r).date + ' ' + local(r).time; };
  assert.equal(at('2026-10-19T19:00:00+02:00'), '2026-10-19 18:15');
  assert.equal(at('2026-10-20T07:00:00+02:00'), '2026-10-20 06:30');
  assert.equal(at('2026-10-20T06:20:00+02:00'), null);
  assert.equal(at('2026-10-20T00:10:00+02:00'), '2026-10-19 23:25');
  assert.equal(at('2026-10-20T00:20:00+02:00'), null);
  assert.equal(at('2026-10-19T23:59:00+02:00'), '2026-10-19 23:14');
  assert.equal(at('2026-10-26T09:00:00+01:00'), '2026-10-26 08:15', 'after the clocks go back');
});

test('dueNow: within 45 minutes only', () => {
  const events = [ev('Archery', '2026-10-19T18:45:00+02:00'), ev('Dentist', '2026-10-19T18:46:00+02:00')];
  assert.deepEqual(dueNow(events, NOW).map((x) => x.e.title), ['Archery']);
});

test('the push names the event and its time, links to Door and carries no code', () => {
  const m = pushText(dueNow([ev('Archery', '2026-10-19T19:00:00+02:00')], NOW + 20 * MIN));
  assert.deepEqual(m, { title: 'Lock the door', message: 'Archery at 19:00. Open Door when you lock up.', click: DOOR_URL, tags: ['key'], priority: 3 });
  const three = pushText(upcoming([ev('A', '2026-10-19T18:10:00+02:00'), ev('B', '2026-10-19T18:20:00+02:00'), ev('C', '2026-10-19T18:30:00+02:00')], NOW));
  assert.equal(three.message, 'A at 18:10, B at 18:20 and 1 more. Open Door when you lock up.');
  assert.equal(eventHash({ title: 'A', start: 'x' }), eventHash({ title: 'A', start: 'x' }));
  assert.notEqual(eventHash({ title: 'A', start: 'x' }), eventHash({ title: 'A', start: 'y' }));
});

/* ---------- the cron ---------- */

test('cron: one push for a due appointment, then not again', async () => {
  const e = env([ev('Archery', '2026-10-19T18:40:00+02:00'), ev('Dentist', '2026-10-19T21:00:00+02:00')]);
  const f = pushes();
  const out = await doorCron(e, NOW, f);
  assert.ok(out.sent);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].url, 'https://ntfy.sh/');
  assert.deepEqual(f.sent[0].body, { topic: 'test-topic', title: 'Lock the door', message: 'Archery at 18:40. Open Door when you lock up.', click: DOOR_URL, tags: ['key'], priority: 3 });
  assert.ok(!JSON.stringify(f.sent[0].body).includes(CODE));
  const key = [...e.HUB_KV.m.keys()].find((k) => k.startsWith(SENT_PREFIX));
  assert.equal(e.HUB_KV.m.get(key), 'sent');
  assert.equal(e.HUB_KV.ttl.get(key), 2 * 86400);
  assert.deepEqual(await doorCron(e, NOW + 15 * MIN, f), { skip: 'nothing due' });
  assert.equal(f.sent.length, 1);
});

test('cron: nothing due, an all day event, a call, or a started event send nothing', async () => {
  const f = pushes();
  const e = env([
    ev('Dentist', '2026-10-19T19:00:00+02:00'),
    { title: 'Trip', start: '2026-10-19', end: '2026-10-20', allDay: true, location: '' },
    ev('Call with Mum', '2026-10-19T18:15:00+02:00'),
    ev('Started', '2026-10-19T17:55:00+02:00'),
  ]);
  assert.deepEqual(await doorCron(e, NOW, f), { skip: 'nothing due' });
  assert.equal(f.sent.length, 0);
});

test('cron: a lock in the last hour marks it done, so it does not come later', async () => {
  const e = env([ev('Archery', '2026-10-19T18:40:00+02:00')]);
  e.HUB_KV.m.set(LOCKS_KEY, JSON.stringify([{ id: 'a', at: NOW - 50 * MIN, word: '', photo: false }]));
  const f = pushes();
  assert.deepEqual(await doorCron(e, NOW, f), { skip: 'locked', events: 1 });
  assert.deepEqual(await doorCron(e, NOW + 15 * MIN, f), { skip: 'nothing due' }, 'the lock is now over an hour old, but the event was handled');
  assert.equal(f.sent.length, 0);
  // An older lock does not count.
  const e2 = env([ev('Archery', '2026-10-19T18:40:00+02:00')]);
  e2.HUB_KV.m.set(LOCKS_KEY, JSON.stringify([{ id: 'a', at: NOW - 61 * MIN, word: '', photo: false }]));
  assert.ok((await doorCron(e2, NOW, f)).sent);
});

test('cron: quiet at night, without a topic, and in quiet hours; a failed send is tried again', async () => {
  const f = pushes();
  const late = Date.parse('2026-10-19T21:40:00Z'); // 23:40
  assert.deepEqual(await doorCron(env([ev('Late film', '2026-10-20T00:15:00+02:00')]), late, f), { skip: 'night' });
  const early = Date.parse('2026-10-20T04:15:00Z'); // 06:15
  assert.deepEqual(await doorCron(env([ev('Train', '2026-10-20T06:50:00+02:00')]), early, f), { skip: 'night' });
  assert.ok((await doorCron(env([ev('Train', '2026-10-20T06:50:00+02:00')]), early + 15 * MIN, f)).sent, '06:30 is allowed');
  assert.deepEqual(await doorCron(env([ev('Archery', '2026-10-19T18:40:00+02:00')], { NTFY_TOPIC: '' }), NOW, f), { skip: 'no topic' });

  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ key: 'quiet_hours', value: '17:30-18:30' }] }) }) }) };
  const q = env([ev('Archery', '2026-10-19T18:40:00+02:00')], { HUB_DB: db });
  assert.deepEqual(await doorCron(q, NOW, f), { skip: 'quiet hours' });
  assert.ok((await doorCron(q, NOW + 30 * MIN, f)).sent, 'goes once quiet hours end, the event not started yet');

  const broken = { prepare: () => { throw new Error('no such table'); } };
  assert.ok((await doorCron(env([ev('Archery', '2026-10-19T18:40:00+02:00')], { HUB_DB: broken }), NOW, f)).sent, 'no config table: no quiet hours');

  const e = env([ev('Archery', '2026-10-19T18:40:00+02:00')]);
  const down = async () => ({ ok: false, status: 503 });
  assert.deepEqual(await doorCron(e, NOW, down), { skip: 'ntfy 503' });
  assert.ok((await doorCron(e, NOW + 15 * MIN, f)).sent);
});

test('cron: two appointments due together share one push', async () => {
  const e = env([ev('Archery', '2026-10-19T18:30:00+02:00'), ev('Drinks', '2026-10-19T18:40:00+02:00')]);
  const f = pushes();
  await doorCron(e, NOW, f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body.message, 'Archery at 18:30, Drinks at 18:40. Open Door when you lock up.');
  assert.equal([...e.HUB_KV.m.keys()].filter((k) => k.startsWith(SENT_PREFIX)).length, 2);
});

/* ---------- next ---------- */

test('next: the first reminder still to come', async () => {
  const e = env([ev('Call with Mum', '2026-10-19T18:30:00+02:00'), ev('Archery', '2026-10-19T19:30:00+02:00'), ev('Dentist', '2026-10-20T10:00:00+02:00')]);
  assert.deepEqual(await nextReminder(e, NOW), { title: 'Archery', start: '2026-10-19T19:30:00+02:00', remindAt: '2026-10-19T16:45:00.000Z' });
  await doorCron(e, NOW + 45 * MIN, pushes());
  assert.equal((await nextReminder(e, NOW + 50 * MIN)).title, 'Dentist', 'sent ones are done');
  assert.equal(await nextReminder(env([]), NOW), null);
  assert.equal(await nextReminder({ HUB_KV: memKV() }, NOW), null, 'no calendar yet');
});

test('next: due now but locked up means no reminder; due now otherwise means now', async () => {
  const e = env([ev('Archery', '2026-10-19T18:30:00+02:00')]);
  assert.equal((await nextReminder(e, NOW)).remindAt, new Date(NOW).toISOString());
  e.HUB_KV.m.set(LOCKS_KEY, JSON.stringify([{ id: 'a', at: NOW - 5 * MIN, word: '', photo: false }]));
  assert.equal(await nextReminder(e, NOW), null);
});

/* ---------- routes ---------- */

test('route: the code must be the to-do code', async () => {
  const e = env();
  assert.equal((await call(e, 'short')).status, 400);
  assert.equal((await call(e, 'zzzzzzzzzzzzzzzz')).status, 404);
  assert.equal((await call({ ...e, TODO_CODE: undefined }, CODE)).status, 404);
  assert.equal((await call(e, CODE + '/lock/x', 'POST', {})).status, 400);
  assert.equal((await call(e, CODE + '/other', 'POST', {})).status, 404);
  assert.equal((await call(e, CODE + '/lock')).status, 405);
  assert.equal((await call(e, CODE, 'POST', {})).status, 405);
});

test('route: lock, dedupe, read back, remove', async () => {
  const e = env([ev('Archery', '2026-10-19T19:30:00+02:00')]);
  const r = await call(e, CODE + '/lock', 'POST', { id: 'm1', at: NOW - MIN, word: 'Otter', photo: true });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(await (await call(e, CODE + '/lock', 'POST', { id: 'm1', at: NOW - MIN, word: 'Otter', photo: true })).json(), { ok: true, dup: true });
  assert.equal((await call(e, CODE + '/lock', 'POST', { id: 'm2', at: NOW, photo: 'data:image/jpeg;base64,AAAA' })).status, 400);
  assert.equal((await call(e, CODE + '/lock', 'POST', '{nope')).status, 400);
  assert.equal((await call(e, CODE + '/lock', 'POST', { id: 'm3', at: NOW, pad: 'x'.repeat(3000) })).status, 413);
  for (let i = 0; i < 12; i++) await call(e, CODE + '/lock', 'POST', { id: 'n' + i, at: NOW - (20 + i) * H });
  const got = await (await call(e, CODE)).json();
  assert.equal(got.locks.length, 10);
  assert.deepEqual(got.locks[0], { id: 'm1', at: NOW - MIN, word: 'Otter', photo: true });
  assert.deepEqual(got.next, { title: 'Archery', start: '2026-10-19T19:30:00+02:00', remindAt: '2026-10-19T16:45:00.000Z' });
  assert.ok(!e.HUB_KV.m.get(LOCKS_KEY).includes('data:'));
  assert.deepEqual(await (await call(e, CODE + '/remove', 'POST', { id: 'm1' })).json(), { ok: true, removed: 1 });
  assert.deepEqual(await (await call(e, CODE + '/remove', 'POST', { id: 'm1' })).json(), { ok: true, removed: 0 });
  assert.equal((await call(e, CODE + '/remove', 'POST', { id: 'BAD ID' })).status, 400);
  assert.equal((await (await call(e, CODE)).json()).locks[0].id, 'n0');
});
