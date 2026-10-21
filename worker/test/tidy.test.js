// Tidy: a typed task comes back clean, with its day as the date ending. No network: the tidier is swapped.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { _setTidier, toText } from '../src/tidy.js';

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
  assert.deepEqual(await r.json(), { text: 'Book the bike service · ' + soon, changed: true, kind: 'task', energy: 'normal' }, 'the energy is a guess for the app to show');
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
