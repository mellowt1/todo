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
