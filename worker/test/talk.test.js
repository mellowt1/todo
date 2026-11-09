// Talk points: Feeling's entries come back as short sections. No network: the writer is swapped.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { _setTalker, cleanEntries, cleanSections } from '../src/talk.js';

const CODE = 'abcdefgh23456789';
const memKV = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async put(k, v) { m.set(k, v); } }; };
const env = (over = {}) => ({ TODO_CODE: CODE, HUB_KV: memKV(), ANTHROPIC_API_KEY: 'k', ...over });
const post = (e, path, body) => worker.fetch(new Request('https://hub.example/api/' + path, { method: 'POST', body: JSON.stringify(body) }), e);

afterEach(() => _setTalker(null));

test('cleanEntries: oldest first, bad rows dropped, unknown mood blank, bring only when true', () => {
  const out = cleanEntries([
    { day: '2026-10-08', time: '21:10', mood: 'very bad', text: '  froze \n at the email ', bring: true },
    { day: '2026-10-06', time: '22:00', mood: 'angry', text: 'argument', bring: 'yes' },
    { day: 'yesterday', time: '10:00', mood: 'bad', text: 'x' },
    { day: '2026-10-07', time: '09:00', mood: 'meh', text: '' },
    { day: '2026-10-07', time: '10:00', mood: 'nope', text: 'tired' },
  ]);
  assert.deepEqual(out, [
    { day: '2026-10-06', time: '22:00', mood: 'angry', text: 'argument' },
    { day: '2026-10-07', time: '10:00', mood: '', text: 'tired' },
    { day: '2026-10-08', time: '21:10', mood: 'very bad', text: 'froze at the email', bring: true },
  ]);
  assert.deepEqual(cleanEntries('nope'), []);
});

test('cleanSections: empty titles and items go', () => {
  assert.deepEqual(cleanSections({ sections: [{ title: 'You flagged', items: [' The move ', ''] }, { title: '', items: ['x'] }, { title: 'Patterns', items: [] }] }),
    [{ title: 'You flagged', items: ['The move'] }]);
  assert.deepEqual(cleanSections(null), []);
});

test('the route: passes clean entries, returns sections, counts usage, stores no text', async () => {
  const e = env();
  let seen;
  _setTalker(async (_e, input) => { seen = input; return { out: { sections: [{ title: 'What weighed most', items: ['Work email at 21:00 (Thu 8 Oct)'] }] }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }; });
  const r = await post(e, `talk/${CODE}`, { range: 'Since session', entries: [{ day: '2026-10-08', time: '21:10', mood: 'very bad', text: 'froze' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { sections: [{ title: 'What weighed most', items: ['Work email at 21:00 (Thu 8 Oct)'] }] });
  assert.equal(seen.range, 'Since session');
  assert.equal(seen.entries.length, 1);
  assert.deepEqual([...e.HUB_KV.m.keys()].map((k) => k.replace(/\d{4}-\d{2}$/, 'M')), ['talk:usage:M']);
  _setTalker(async () => ({ usage: null }));
  assert.equal((await post(e, `talk/${CODE}`, { entries: [{ day: '2026-10-08', time: '21:10', mood: 'bad', text: 'x' }] })).status, 502);
  _setTalker(async () => { throw new Error('down'); });
  assert.equal((await post(e, `talk/${CODE}`, { entries: [{ day: '2026-10-08', time: '21:10', mood: 'bad', text: 'x' }] })).status, 502);
});

test('refused: unknown code, no entries, no key', async () => {
  const one = { entries: [{ day: '2026-10-08', time: '21:10', mood: 'bad', text: 'x' }] };
  assert.equal((await post(env(), 'talk/zzzzzzzzzzzzzzzz', one)).status, 404);
  assert.equal((await post(env(), `talk/${CODE}`, { entries: [] })).status, 400);
  assert.equal((await post(env({ ANTHROPIC_API_KEY: undefined }), `talk/${CODE}`, one)).status, 503);
});

// Next session: the first psychologist/psychiatrist visit in the list, for Feeling's Today card.
import { sessionNames, sessionKind, sessionsFrom, SESSION_OPEN_MIN } from '../src/talk.js';
import { memNamespace } from './mem.js';

const it = (id, text, done = false) => ({ id, text, section: 'soon', done, doneAt: done ? 1 : null, updatedAt: 1, pos: 1 });
const NAMES = sessionNames('Anna=psychologist, Bram = psychiatrist, bad name 1=x, Cora=dentistry');

test('sessionNames + sessionKind: names from the secret, then the words; unknown kind is session', () => {
  assert.equal(NAMES.length, 3);
  assert.equal(sessionKind('Anna', NAMES), 'psychologist');
  assert.equal(sessionKind('anna praktijk', NAMES), 'psychologist');
  assert.equal(sessionKind('Bram call', NAMES), 'psychiatrist');
  assert.equal(sessionKind('Cora', NAMES), 'session');
  assert.equal(sessionKind('Annabel lunch', NAMES), null, 'whole names only');
  assert.equal(sessionKind('Psycholoog', []), 'psychologist');
  assert.equal(sessionKind('Afspraak psychiater', []), 'psychiatrist');
  assert.equal(sessionKind('Dentist', NAMES), null);
  assert.deepEqual(sessionNames(''), []);
});

test('sessionsFrom: next is the first open one not yet over, past are the days of the ones over', () => {
  const items = [
    it('a1', 'Anna · 2026-11-09 12:45'),
    it('a2', 'Anna · 2026-11-23 12:45'),
    it('b1', 'Bram · 2026-11-16'),
    it('a0', 'Anna · 2026-10-26 12:45', true),
    it('x1', 'Dentist · 2026-11-10 09:00'),
    it('a3', 'Anna'),
    it('a4', 'Anna · 2026-12-01 10:00', true),
    it('ol', 'Anna · 2026-01-02 10:00', true),
  ];
  const before = sessionsFrom(items, NAMES, { date: '2026-11-09', minutes: 11 * 60 });
  assert.deepEqual(before.next, { title: 'Anna', kind: 'psychologist', date: '2026-11-09', time: '12:45' });
  assert.deepEqual(before.past, ['2026-10-26']);
  const during = sessionsFrom(items, NAMES, { date: '2026-11-09', minutes: 12 * 60 + 45 + SESSION_OPEN_MIN - 1 });
  assert.equal(during.next.date, '2026-11-09', 'stays on through the visit');
  const after = sessionsFrom(items, NAMES, { date: '2026-11-09', minutes: 12 * 60 + 45 + SESSION_OPEN_MIN });
  assert.deepEqual(after.next, { title: 'Bram', kind: 'psychiatrist', date: '2026-11-16', time: null });
  assert.deepEqual(after.past, ['2026-10-26', '2026-11-09']);
  assert.equal(sessionsFrom(items, NAMES, { date: '2026-11-16', minutes: 23 * 60 }).next.title, 'Bram', 'whole day stays on all day');
  assert.deepEqual(sessionsFrom([], NAMES, { date: '2026-11-09', minutes: 0 }), { next: null, past: [] });
});

test('GET talk/:code/next: reads the list, wrong code 404, POST still writes', async () => {
  const e = env({ TODO_LIST: memNamespace(), SESSION_NAMES: 'Anna=psychologist' });
  const stub = e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
  await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'upsert', item: it('aaaaaaaa', 'Anna · 2099-01-05 10:00') }] }) });
  const r = await worker.fetch(new Request(`https://hub.example/api/talk/${CODE}/next`), e);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.next, { title: 'Anna', kind: 'psychologist', date: '2099-01-05', time: '10:00' });
  assert.deepEqual(d.past, []);
  assert.equal((await worker.fetch(new Request('https://hub.example/api/talk/zzzzzzzz23456789/next'), e)).status, 404);
  assert.equal((await worker.fetch(new Request(`https://hub.example/api/talk/${CODE}/other`), e)).status, 404);
  assert.equal((await worker.fetch(new Request(`https://hub.example/api/talk/${CODE}/next`, { method: 'POST', body: '{}' }), e)).status, 405);
});
