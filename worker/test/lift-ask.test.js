// Lift's Ask: a gym question comes back as a short answer and a few exercises. No network: the asker is swapped.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { _setAsker, cleanAsk, cleanAnswer } from '../src/lift-ask.js';

const CODE = 'abcdefgh23456789';
const memKV = () => { const m = new Map(); return { m, async get(k, t) { return m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null; }, async put(k, v) { m.set(k, v); } }; };
const env = (over = {}) => ({ TODO_CODE: CODE, HUB_KV: memKV(), ANTHROPIC_API_KEY: 'k', ...over });
const post = (e, path, body) => worker.fetch(new Request('https://hub.example/api/' + path, { method: 'POST', body: JSON.stringify(body) }), e);

afterEach(() => _setAsker(null));

test('cleanAsk: question required, lists trimmed and capped', () => {
  assert.deepEqual(cleanAsk({ question: '  ' }), { error: 'question required' });
  const out = cleanAsk({
    question: ' good  hamstring\n moves? ',
    library: ['Lying Leg Curl (Machine)', 'Lying Leg Curl (Machine)', '', 5],
    recent: [{ name: 'Bench Press (Barbell)', muscle: 'Chest', sets: 12.4 }, { name: '' }],
    routines: [{ name: 'Back', items: ['Pull-up', ''] }, { items: [] }],
  });
  assert.deepEqual(out, {
    question: 'good hamstring moves?',
    library: ['Lying Leg Curl (Machine)'],
    recent: [{ name: 'Bench Press (Barbell)', muscle: 'Chest', sets: 12 }],
    routines: [{ name: 'Back', items: ['Pull-up'] }],
  });
});

test('cleanAnswer: empty and repeated picks go', () => {
  const out = cleanAnswer({ answer: ' Hit them twice a week. ', picks: [{ name: 'Romanian Deadlift (Barbell)', why: '3 x 8' }, { name: 'romanian deadlift (barbell)', why: 'again' }, { name: ' ', why: 'x' }] });
  assert.deepEqual(out, { answer: 'Hit them twice a week.', picks: [{ name: 'Romanian Deadlift (Barbell)', why: '3 x 8' }] });
});

test('POST /api/lift/:code/ask answers, counts tokens, refuses bad input', async () => {
  const e = env();
  let seen;
  _setAsker(async (_e, input) => { seen = input; return { out: { answer: 'Add curls.', picks: [{ name: 'Lying Leg Curl (Machine)', why: '3 x 10-15' }] }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }; });
  const res = await post(e, `lift/${CODE}/ask`, { question: 'hamstrings?', library: ['Lying Leg Curl (Machine)'] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { answer: 'Add curls.', picks: [{ name: 'Lying Leg Curl (Machine)', why: '3 x 10-15' }] });
  assert.equal(seen.question, 'hamstrings?');
  assert.ok([...e.HUB_KV.m.keys()].some((k) => k.startsWith('lift-ask:usage:')));

  assert.equal((await post(e, `lift/${CODE}/ask`, { question: '' })).status, 400);
  assert.equal((await post(e, 'lift/zzzzzzzzzzzzzzzz/ask', { question: 'x' })).status, 404);
  assert.equal((await post(env({ ANTHROPIC_API_KEY: '' }), `lift/${CODE}/ask`, { question: 'x' })).status, 503);
  _setAsker(async () => ({ usage: null }));
  assert.equal((await post(e, `lift/${CODE}/ask`, { question: 'x' })).status, 502);
  _setAsker(async () => { throw new Error('down'); });
  assert.equal((await post(e, `lift/${CODE}/ask`, { question: 'x' })).status, 502);
});
