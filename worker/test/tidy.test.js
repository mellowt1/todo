// Tidy: a typed task comes back clean, with its day as the date ending. No network: the tidier is swapped.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { _setTidier, toText, toPlace, repeatOf, withRepeat } from '../src/tidy.js';

const CODE = 'abcdefgh23456789';
const memKV = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async put(k, v) { m.set(k, v); } }; };
const env = (over = {}) => ({ TODO_CODE: CODE, HUB_KV: memKV(), ANTHROPIC_API_KEY: 'k', ...over });
const post = (e, path, body) => worker.fetch(new Request('https://hub.example/api/' + path, { method: 'POST', body: JSON.stringify(body) }), e);

afterEach(() => _setTidier(null));

test('toText: capital, no full stop, no dashes, the date as the ending, a kept ending wins when none found', () => {
  assert.equal(toText({ name: 'call the gemeente about the parking permit.', due: '2026-10-23' }, 'call gemeente abt parking frday', '2026-10-17'), 'Call the gemeente about the parking permit · 2026-10-23');
  assert.equal(toText({ name: 'Dad: printer — new ink', due: null }, 'dad: printer - new ink', '2026-10-17'), 'Dad: printer, new ink');
  assert.equal(toText({ name: 'Pay the fine', due: null }, 'pay fine · 2026-11-01', '2026-10-17'), 'Pay the fine · 2026-11-01');
  assert.equal(toText({ name: 'Old thing', due: '2025-01-01' }, 'old thing', '2026-10-17'), 'Old thing', 'a date long gone is dropped');
  assert.equal(toText({ name: 'X', due: 'friday' }, 'x friday', '2026-10-17'), 'X');
  assert.equal(toText({ name: '', due: null }, 'as typed', '2026-10-17'), 'as typed');
});

test('the route: tidies, says whether it changed, counts usage; intake tasks pass through', async () => {
  const e = env();
  let seen;
  const soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10); // a date still to come, whatever day the test runs
  _setTidier(async (_e, text) => { seen = text; return { out: { name: 'Book the bike service', due: soon, energy: 'normal' }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }; });
  let r = await post(e, `tidy/${CODE}`, { text: '  book bike servise monday ' });
  assert.deepEqual(await r.json(), { text: 'Book the bike service · ' + soon, changed: true, kind: 'task', energy: 'normal', place: 'soon', appt: false, skill: null }, 'the energy is a guess for the app to show');
  assert.equal(seen, 'book bike servise monday');
  assert.ok([...e.HUB_KV.m.keys()].some((k) => k.startsWith('tidy:usage:')));
  r = await post(e, `tidy/${CODE}`, { text: 'Pay the CJIB fine · 2026-10-21 [intake]' });
  assert.deepEqual(await r.json(), { text: 'Pay the CJIB fine · 2026-10-21 [intake]', changed: false });
  _setTidier(async () => ({ usage: null }));
  assert.deepEqual(await (await post(e, `tidy/${CODE}`, { text: 'Hello' })).json(), { text: 'Hello', changed: false });
  _setTidier(async () => { throw new Error('down'); });
  assert.equal((await post(e, `tidy/${CODE}`, { text: 'Hello' })).status, 502);
});

test('refused: unknown code, empty text, no key', async () => {
  assert.equal((await post(env(), 'tidy/zzzzzzzzzzzzzzzz', { text: 'x' })).status, 404);
  assert.equal((await post(env(), `tidy/${CODE}`, { text: '  ' })).status, 400);
  assert.equal((await post(env({ ANTHROPIC_API_KEY: undefined }), `tidy/${CODE}`, { text: 'x' })).status, 503);
});

test('toText: a clock time rides after the date, never alone, and a kept time stays when none found', () => {
  assert.equal(toText({ name: 'Dentist', due: '2026-10-23', time: '14:00' }, 'dentist friday 2pm', '2026-10-17'), 'Dentist · 2026-10-23 14:00');
  assert.equal(toText({ name: 'Dentist', due: null, time: '14:00' }, 'dentist 2pm', '2026-10-17'), 'Dentist', 'a time without a date is dropped');
  assert.equal(toText({ name: 'Dentist', due: '2026-10-23', time: '25:00' }, 'dentist', '2026-10-17'), 'Dentist · 2026-10-23');
  assert.equal(toText({ name: 'Call Bas', due: null, time: null }, 'call bas · 2026-10-20 09:30', '2026-10-17'), 'Call Bas · 2026-10-20 09:30');
});

test('a question or a message comes back as typed with its kind, for the app to hand to Desk', async () => {
  const e = env();
  _setTidier(async () => ({ out: { name: 'What do I have on Thursday', due: null, time: null, kind: 'ask' }, usage: null }));
  assert.deepEqual(await (await post(e, `tidy/${CODE}`, { text: 'what do i have on thursday' })).json(), { text: 'what do i have on thursday', changed: false, kind: 'ask' });
  _setTidier(async () => ({ out: { name: 'Write to the landlord', due: null, time: null, kind: 'write' }, usage: null }));
  assert.equal((await (await post(e, `tidy/${CODE}`, { text: 'write to the landlord' })).json()).kind, 'write');
  _setTidier(async () => ({ out: { name: 'Odd', due: null, time: null, kind: 'poem' }, usage: null }));
  assert.equal((await (await post(e, `tidy/${CODE}`, { text: 'odd' })).json()).kind, 'task', 'anything unknown is a task');
});

test('toPlace: a lane wins, a date picks Today or Soon, an undated appointment stays in Today, unsure stays put', () => {
  const T = '2026-11-04';
  assert.equal(toPlace({ place: 'build' }, '2026-11-20', T), 'build');
  assert.equal(toPlace({ place: 'others' }, null, T), 'others');
  assert.equal(toPlace({ place: 'keep' }, '2026-11-09', T), 'soon', 'a later date goes to Soon');
  assert.equal(toPlace({ place: 'someday' }, '2026-11-09', T), 'soon');
  assert.equal(toPlace({ place: 'soon' }, '2026-11-04', T), 'today', 'due today is Today');
  assert.equal(toPlace({ place: 'keep', appointment: true }, null, T), 'today', 'an appointment with no date stays in sight');
  assert.equal(toPlace({ place: 'someday', appointment: true }, null, T), 'today');
  assert.equal(toPlace({ place: 'keep' }, null, T), null);
  assert.equal(toPlace({ place: 'someday' }, null, T), 'someday');
  assert.equal(toPlace({ place: 'kitchen' }, null, T), null, 'anything unknown stays put');
  assert.equal(toPlace(null, null, T), null);
  assert.equal(toPlace({ place: 'fun', appointment: true }, T, T), 'today', 'archery at 20:00 today is Today, not Fun');
  assert.equal(toPlace({ place: 'fun', appointment: true }, '2026-11-20', T), 'soon', 'an appointment never goes to Build or Fun');
  assert.equal(toPlace({ place: 'others', appointment: true }, '2026-11-20', T), 'others', 'but may go to Others');
  assert.equal(toPlace({ place: 'fun' }, T, T), 'today', 'due today is Today, lane or not');
});

test('the route: place and appointment come back; a time without a date never makes one up', async () => {
  const e = env();
  _setTidier(async () => ({ out: { name: 'Psychologist visit', due: null, time: null, kind: 'task', energy: 'normal', place: 'keep', appointment: true, skill: 'herblore' }, usage: null }));
  assert.deepEqual(await (await post(e, `tidy/${CODE}`, { text: 'psychologist visit' })).json(), { text: 'Psychologist visit', changed: true, kind: 'task', energy: 'normal', place: 'today', appt: true, skill: 'herblore' });
  _setTidier(async () => ({ out: { name: 'Grandpa: Order bed frame', due: null, time: null, kind: 'task', energy: 'normal', place: 'others', appointment: false }, usage: null }));
  const r = await (await post(e, `tidy/${CODE}`, { text: 'order bed frame for grandpa' })).json();
  assert.equal(r.text, 'Grandpa: Order bed frame');
  assert.equal(r.place, 'others');
  assert.equal(r.appt, false);
  _setTidier(async () => ({ out: { name: 'Peronik', due: null, time: '12:45', kind: 'task', energy: 'normal', place: 'keep', appointment: true }, usage: null }));
  const p = await (await post(e, `tidy/${CODE}`, { text: 'peronik 12:45' })).json();
  assert.equal(p.text, 'Peronik', 'no date in, no date out');
  _setTidier(async () => ({ out: { name: 'Old style', due: null, time: null, kind: 'task', energy: 'normal' }, usage: null }));
  const o = await (await post(e, `tidy/${CODE}`, { text: 'old style' })).json();
  assert.equal(o.place, null);
  assert.equal(o.appt, false);
});

test('the route hands Tidy the recent corrections (none without D1)', async () => {
  let seen;
  _setTidier(async (_e, _t, _n, examples) => { seen = examples; return { out: { name: 'X', due: null, time: null, kind: 'task' }, usage: null }; });
  await post(env(), `tidy/${CODE}`, { text: 'x' });
  assert.deepEqual(seen, []);
});

test('the route: the skill a task trains comes back; none or anything unknown is null', async () => {
  const e = env();
  const ask = (skill) => _setTidier(async () => ({ out: { name: 'Call Capital One', due: null, time: null, kind: 'task', energy: 'normal', place: 'keep', appointment: false, skill }, usage: null }));
  ask('thieving');
  assert.equal((await (await post(e, `tidy/${CODE}`, { text: 'call capital one' })).json()).skill, 'thieving');
  ask('none');
  assert.equal((await (await post(e, `tidy/${CODE}`, { text: 'call capital one' })).json()).skill, null);
  ask('woodcutting');
  assert.equal((await (await post(e, `tidy/${CODE}`, { text: 'call capital one' })).json()).skill, null, 'Woodcutting is every task, not a pick');
});

test('repeatOf: "every …" words in English, Dutch and Spanish; a bare "weekly" is a name', () => {
  assert.equal(repeatOf('Uren sturen werk every week'), 'week');
  assert.equal(repeatOf('bel oma elke week'), 'week');
  assert.equal(repeatOf('regar las plantas cada semana'), 'week');
  assert.equal(repeatOf('Clean the fridge every 2 weeks'), '2weeks');
  assert.equal(repeatOf('stofzuigen om de week'), '2weeks');
  assert.equal(repeatOf('Pay rent every month'), 'month');
  assert.equal(repeatOf('huur betalen iedere maand'), 'month');
  assert.equal(repeatOf('Send weekly report'), null);
  assert.equal(repeatOf('Plan next week'), null);
});

test('withRepeat: the words leave the text, a kept date and time stay, no date gets today', () => {
  assert.equal(withRepeat('Uren sturen werk every week', '2026-11-08'), 'Uren sturen werk · 2026-11-08');
  assert.equal(withRepeat('Every month pay rent · 2026-12-01 09:00', '2026-11-08'), 'Pay rent · 2026-12-01 09:00');
  assert.equal(withRepeat('Call mum, elke week', '2026-11-08'), 'Call mum · 2026-11-08');
  assert.equal(withRepeat('every week', '2026-11-08'), 'every week', 'nothing left: as it was');
});

test('the route: "every week" comes back as a repeat with a date; no words, no repeat field', async () => {
  const e = env();
  _setTidier(async () => ({ out: { name: 'Uren sturen werk every week', due: null, time: null, kind: 'task', energy: 'drained', place: 'keep', appointment: false, skill: 'none' }, usage: null }));
  const r = await (await post(e, `tidy/${CODE}`, { text: 'Uren sturen werk every week' })).json();
  assert.equal(r.repeat, 'week');
  assert.match(r.text, /^Uren sturen werk · \d{4}-\d{2}-\d{2}$/);
  assert.equal(r.changed, true);
  _setTidier(async () => ({ out: { name: 'Send weekly report', due: null, time: null, kind: 'task', energy: 'normal', place: 'keep', appointment: false }, usage: null }));
  assert.equal('repeat' in (await (await post(e, `tidy/${CODE}`, { text: 'send weekly report' })).json()), false);
});
