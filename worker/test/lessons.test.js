// Lessons: Paul's corrections in, Sunday proposals, Keep and Drop, kept rules in the prompts.
// No network: Claude is swapped, and the one prompt check stops the SDK at fetch. Made-up texts.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { _setDesker, prepare } from '../src/desk.js';
import { tidyLine } from '../src/tidy.js';
import { deskSignal, cleanProposals, cleanReport, lessonsText, weekLessons, keptFor, _setLessonAsker, KEPT_KEY, WEEK_PREFIX } from '../src/lessons.js';
import { readItem } from '../src/intake.js';
import { askLift } from '../src/lift-ask.js';
import { weekBlock } from '../src/week.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const SUN = Date.parse('2026-10-18T05:00:00Z'); // Sunday 07:00 in Amsterdam
const SAT = Date.parse('2026-10-17T10:00:00Z');
const DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));
function memD1() {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) db.exec(m);
  return {
    db,
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const o = {
        bind(...a) { args = a; return o; },
        async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; },
        async all() { return { results: st.all(...args) }; },
        async first() { return st.get(...args) ?? null; },
      };
      return o;
    },
  };
}
const memKV = () => { const m = new Map(); return { m, async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } }; };
const env = (over = {}) => ({ TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: memKV(), HUB_DB: memD1(), ANTHROPIC_API_KEY: 'k', ...over });
const call = (e, path, init = {}) => worker.fetch(new Request('https://hub.example/api/' + path, init), e);
const post = (e, path, body) => call(e, path, { method: 'POST', body: JSON.stringify(body) });
const rows = (e, sql = 'SELECT app, kind, before, after, note FROM feedback ORDER BY rowid') => e.HUB_DB.db.prepare(sql).all().map((r) => ({ ...r }));
const addFeedback = (e, at, app, kind, before, after = null) => e.HUB_DB.db.prepare('INSERT INTO feedback (id, at, app, kind, before, after, note) VALUES (?, ?, ?, ?, ?, ?, NULL)')
  .run('f' + Math.random().toString(36).slice(2, 12), at, app, kind, before, after);

afterEach(() => { _setDesker(null); _setLessonAsker(null); });

test('deskSignal: edits, skips and undos are corrections; a second press says nothing', () => {
  const was = { kind: 'todo', text: 'Call the bank', section: 'soon', state: 'ready' };
  assert.deepEqual(deskSignal(was, { ...was, state: 'approved' }, 'approve'), { kind: 'approved', before: 'Call the bank [soon]' });
  assert.deepEqual(deskSignal(was, { ...was, section: 'today', state: 'approved' }, 'approve'), { kind: 'edited', before: 'Call the bank [soon]', after: 'Call the bank [today]' });
  assert.deepEqual(deskSignal(was, { ...was, state: 'skipped' }, 'skip'), { kind: 'skipped', before: 'Call the bank [soon]' });
  const done = { ...was, state: 'approved', taskId: 'x' };
  assert.deepEqual(deskSignal(done, { ...was }, 'undo'), { kind: 'undone', before: 'Call the bank [soon]' });
  assert.equal(deskSignal(done, done, 'approve'), null);
  const draft = { kind: 'draft', to: 'Sam', text: 'See you at eight.', state: 'ready' };
  assert.deepEqual(deskSignal(draft, { ...draft, text: 'See you at 8.', state: 'copied' }, 'copied'), { kind: 'edited', before: 'to Sam: See you at eight.', after: 'to Sam: See you at 8.' });
});

test('Desk logs what each button did, with the line Paul typed', async () => {
  const e = env();
  _setDesker(async () => ({ plan: { answer: null, actions: [
    { kind: 'todo', text: 'Call the gemeente', section: 'soon', to: null, lang: null },
    { kind: 'draft', text: 'Running late, see you at eight.', section: null, to: 'Sam', lang: 'en' },
  ] } }));
  const { item } = await (await post(e, `desk/${CODE}`, { text: 'call gemeente and tell sam im late' })).json();
  await post(e, `desk/${CODE}/act`, { id: item.id, idx: 0, action: 'approve', edit: { text: 'Bel de gemeente' } });
  await post(e, `desk/${CODE}/act`, { id: item.id, idx: 0, action: 'approve' }); // a second press
  await post(e, `desk/${CODE}/act`, { id: item.id, idx: 1, action: 'skip' });
  assert.deepEqual(rows(e), [
    { app: 'desk', kind: 'edited', before: 'Call the gemeente [soon]', after: 'Bel de gemeente [soon]', note: 'call gemeente and tell sam im late' },
    { app: 'desk', kind: 'skipped', before: 'to Sam: Running late, see you at eight.', after: null, note: 'call gemeente and tell sam im late' },
  ]);
});

test('the To-do app reports Tidy undos and edits; nothing else gets in', async () => {
  const e = env();
  let r = await post(e, `lessons/${CODE}/feedback`, { app: 'tidy', kind: 'undone', before: 'Buy cat food · 2026-10-18', after: 'buy cat food tmrw' });
  assert.deepEqual(await r.json(), { ok: true });
  r = await post(e, `lessons/${CODE}/feedback`, { app: 'tidy', kind: 'edited', before: 'Bel de huisarts', after: 'Bel huisarts Dr. Bos' });
  assert.equal(r.status, 200);
  assert.equal((await post(e, `lessons/${CODE}/feedback`, { app: 'desk', kind: 'undone', before: 'a', after: 'b' })).status, 400);
  assert.equal((await post(e, `lessons/${CODE}/feedback`, { app: 'tidy', kind: 'approved', before: 'a', after: 'b' })).status, 400);
  assert.equal((await post(e, `lessons/${CODE}/feedback`, { app: 'tidy', kind: 'edited', before: 'same', after: 'same' })).status, 400);
  assert.equal((await post(e, `lessons/zzzzzzzz23456789/feedback`, { app: 'tidy', kind: 'undone', before: 'a', after: 'b' })).status, 404);
  assert.deepEqual(rows(e).map((x) => x.kind), ['undone', 'edited']);
});

test('cleanProposals: at most five, no repeats of known rules, no dashes', () => {
  const out = { lessons: [
    { app: 'tidy', text: 'Never turn "tmrw" into a date — keep it as typed.', why: 'You undid 2 tidies.' },
    { app: 'desk', text: 'Keep Dutch tasks in Dutch', why: '' },
    { app: 'desk', text: 'keep dutch tasks in dutch', why: 'dup' },
    { app: 'other', text: 'x', why: 'y' },
  ] };
  assert.deepEqual(cleanProposals(out, ['Already kept']), [
    { app: 'tidy', text: 'Never turn "tmrw" into a date, keep it as typed.', why: 'You undid 2 tidies.' },
    { app: 'desk', text: 'Keep Dutch tasks in Dutch', why: 'From this week\'s corrections.' },
  ]);
  assert.deepEqual(cleanProposals(out, ['KEEP DUTCH TASKS IN DUTCH']).map((x) => x.app), ['tidy']);
  assert.deepEqual(cleanProposals(null, []), []);
});

test('Sunday: proposals from the week, once; too few corrections means no call', async () => {
  const e = env();
  let calls = 0;
  let seen;
  _setLessonAsker(async (_e, facts) => { calls++; seen = facts; return { lessons: [{ app: 'tidy', text: 'Leave "tmrw" as typed.', why: 'You undid 2 tidies that turned tmrw into a date.' }] }; });

  addFeedback(e, '2026-10-16T10:00:00Z', 'tidy', 'undone', 'Buy cat food · 2026-10-17', 'buy cat food tmrw');
  assert.deepEqual(await weekLessons(e, SUN), { rows: 1, corrections: 1, added: 0 });
  assert.equal(calls, 0);

  e.HUB_KV.m.delete(WEEK_PREFIX + '2026-10-12');
  addFeedback(e, '2026-10-17T10:00:00Z', 'tidy', 'undone', 'Bake bread · 2026-10-18', 'bake bread tmrw');
  addFeedback(e, '2026-10-01T10:00:00Z', 'desk', 'skipped', 'An old one [soon]'); // before the week
  assert.deepEqual(await weekLessons(e, SAT), { skip: 'not Sunday' });
  assert.deepEqual(await weekLessons(e, SUN), { rows: 2, corrections: 2, added: 1 });
  assert.equal(seen.rows.length, 2);
  assert.deepEqual(await weekLessons(e, SUN), { skip: 'done' });
  assert.equal(calls, 1);
  assert.deepEqual(rows(e, 'SELECT app, text, state, week FROM lessons'), [{ app: 'tidy', text: 'Leave "tmrw" as typed.', state: 'proposed', week: '2026-10-12' }]);
});

test('Keep puts a rule into the prompts, Drop takes it out, Undo puts it back to waiting', async () => {
  const e = env();
  e.HUB_DB.db.exec("INSERT INTO lessons (id, app, text, why, state, week, at) VALUES ('lesson00001', 'desk', 'Write tasks for Dad in Spanish.', 'You edited 3.', 'proposed', '2026-10-12', '2026-10-18T05:00:00Z')");
  let block = await weekBlock(e, SUN);
  assert.deepEqual(block.lessons, { proposed: [{ id: 'lesson00001', app: 'desk', text: 'Write tasks for Dad in Spanish.', why: 'You edited 3.' }], kept: [] });

  let r = await post(e, `morning/${CODE}/lesson`, { id: 'lesson00001', action: 'keep' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).lessons.kept.map((l) => l.id), ['lesson00001']);
  assert.deepEqual(await keptFor(e, 'desk'), ['Write tasks for Dad in Spanish.']);
  assert.deepEqual(await keptFor(e, 'tidy'), []);

  r = await post(e, `morning/${CODE}/lesson`, { id: 'lesson00001', action: 'drop' });
  assert.deepEqual((await r.json()).lessons, { proposed: [], kept: [] });
  assert.deepEqual(JSON.parse(e.HUB_KV.m.get(KEPT_KEY)), { desk: [], tidy: [], intake: [], lift: [] });
  r = await post(e, `morning/${CODE}/lesson`, { id: 'lesson00001', action: 'undo' });
  assert.equal((await r.json()).lessons.proposed.length, 1);

  assert.equal((await post(e, `morning/${CODE}/lesson`, { id: 'nosuchlesson', action: 'keep' })).status, 404);
  assert.equal((await post(e, `morning/${CODE}/lesson`, { id: 'lesson00001', action: 'maybe' })).status, 400);
});

test('lessonsText and the real calls: kept rules reach the system prompt of Desk and Tidy', async () => {
  assert.equal(lessonsText([]), '');
  assert.match(lessonsText(['A', 'B']), /^Paul's own rules.*\n- A\n- B$/s);

  const e = env({ ANTHROPIC_API_KEY: 'k-lessons-prompt' });
  e.HUB_KV.m.set(KEPT_KEY, JSON.stringify({ desk: ['Write tasks for Dad in Spanish.'], tidy: ['Leave "tmrw" as typed.'] }));
  const bodies = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"stop"}}', { status: 400, headers: { 'content-type': 'application/json' } }); };
  try {
    await assert.rejects(prepare(e, { text: 'x', context: {} }));
    await assert.rejects(tidyLine(e, 'x', SUN));
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].system.length, 2);
  assert.match(bodies[0].system[1].text, /- Write tasks for Dad in Spanish\./);
  assert.match(bodies[1].system, /- Leave "tmrw" as typed\.$/);
});

test('feedback from more apps: intake edits and deletes, lift picks; each app only its own kinds', async () => {
  const e = env();
  const ok = async (body) => assert.deepEqual(await (await post(e, `lessons/${CODE}/feedback`, body)).json(), { ok: true });
  await ok({ app: 'intake', kind: 'edited', before: 'Pay the CJIB fine · 2026-10-21 [intake]', after: 'Pay CJIB fine via iDEAL · 2026-10-21 [intake]' });
  await ok({ app: 'intake', kind: 'skipped', before: 'Read the UWV letter [intake]' });
  await ok({ app: 'lift', kind: 'approved', before: 'Face Pull', note: 'what for my rear delts' });
  await ok({ app: 'lift', kind: 'skipped', before: 'Upright Row, Shrug', note: 'what for my rear delts' });
  await ok({ app: 'tidy', kind: 'undone', before: 'ask: What do I have on Thursday', after: 'task' });
  assert.deepEqual(rows(e).map((r) => r.app + ' ' + r.kind), ['intake edited', 'intake skipped', 'lift approved', 'lift skipped', 'tidy undone']);
  assert.equal(rows(e)[2].note, 'what for my rear delts');
  assert.equal((await post(e, `lessons/${CODE}/feedback`, { app: 'intake', kind: 'approved', before: 'a' })).status, 400);
  assert.equal((await post(e, `lessons/${CODE}/feedback`, { app: 'intake', kind: 'edited', before: 'a' })).status, 400, 'an edit says what Paul wanted');
  assert.equal((await post(e, `lessons/${CODE}/feedback`, { app: 'lift', kind: 'skipped' })).status, 400);
  assert.equal(cleanReport({ app: 'talk', kind: 'skipped', before: 'x' }).error.startsWith('app and kind'), true);
});

test('kept rules reach Intake and Lift Ask too, in a second system block', async () => {
  const e = env({ ANTHROPIC_API_KEY: 'k-lessons-more' });
  e.HUB_KV.m.set(KEPT_KEY, JSON.stringify({ intake: ['Never make a task for a newsletter.'], lift: ['Prefer cable exercises.'] }));
  const bodies = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"stop"}}', { status: 400, headers: { 'content-type': 'application/json' } }); };
  try {
    await assert.rejects(readItem(e, { files: [], text: 'a letter', today: '2026-10-19' }));
    await assert.rejects(askLift(e, { question: 'rear delts?', library: ['Face Pull'], recent: [], routines: [] }));
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].system[1].text, /- Never make a task for a newsletter\./);
  assert.match(bodies[1].system[1].text, /- Prefer cable exercises\./);
});
