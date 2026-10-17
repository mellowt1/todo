// The Sunday paragraph: once each Sunday from 06:00, from the week's facts and Desk's log; Morning
// gets it in the week block. No network: the writer is swapped. Every task here is made up.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { weekParagraph, weekBlock, paragraphFacts, _setParagrapher, PARA_PREFIX, weekCron } from '../src/week.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const DAY = 864e5;
const SUN = Date.parse('2026-10-18T05:00:00Z'); // Sunday 07:00 in Amsterdam
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
const env = () => ({ TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: memKV(), HUB_DB: memD1(), ANTHROPIC_API_KEY: 'k' });
async function seed(e) {
  const stub = e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
  const t = (id, text, over) => ({ op: 'upsert', item: { id, text, section: 'soon', done: false, doneAt: null, updatedAt: SUN - DAY, pos: SUN - DAY, ...over } });
  await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [
    t('done00000001', 'Renew the passport', { done: true, doneAt: SUN - 2 * DAY, updatedAt: SUN - 2 * DAY }),
    t('quiet0000001', 'Sort the tax papers', { updatedAt: SUN - 20 * DAY, pos: SUN - 20 * DAY }),
  ] }), headers: { 'Content-Type': 'application/json' } });
  e.HUB_DB.db.prepare("INSERT INTO desk_log (id, at, text, kinds, outcome, updated_at) VALUES ('d1', ?, 'remind me to call the bank', 'todo', '[\"approved\"]', ?), ('d2', ?, 'write to the landlord', 'draft', '[\"skipped\"]', ?), ('old', '2026-10-01T10:00:00Z', 'last month', 'todo', '[\"approved\"]', '2026-10-01T10:00:00Z')")
    .run(new Date(SUN - DAY).toISOString(), new Date(SUN - DAY).toISOString(), new Date(SUN - DAY).toISOString(), new Date(SUN - DAY).toISOString());
}

afterEach(() => _setParagrapher(null));

test('Sunday from 06:00, once: the facts carry the week and Desk; Morning gets the text', async () => {
  const e = env();
  await seed(e);
  let seen = null;
  let calls = 0;
  _setParagrapher(async (_env, facts) => { calls++; seen = facts; return 'You renewed the passport — good. The tax papers sat for 20 days. Do them Monday.'; });
  assert.deepEqual(await weekParagraph(e, SUN - 2 * 3600000), { skip: 'too early' }); // 05:00
  assert.deepEqual(await weekParagraph(e, SUN - DAY), { skip: 'not Sunday' });
  assert.equal((await weekBlock(e, SUN)).paragraph, null);
  assert.deepEqual(await weekParagraph(e, SUN), { written: 79 });
  assert.deepEqual(seen.done.tasks, ['Renew the passport']);
  assert.deepEqual(seen.goneQuiet, [{ task: 'Sort the tax papers', days: 20 }]);
  assert.deepEqual(seen.desk, { lines: 2, outcomes: { approved: 1, skipped: 1 }, typed: ['remind me to call the bank', 'write to the landlord'] });
  assert.deepEqual(await weekParagraph(e, SUN + 3600000), { skip: 'written' });
  assert.equal(calls, 1);
  assert.equal((await weekBlock(e, SUN)).paragraph, 'You renewed the passport, good. The tax papers sat for 20 days. Do them Monday.');
  assert.ok(e.HUB_KV.m.has(PARA_PREFIX + '2026-10-12'));
});

test('a failed call waits for next week; the cron runs it with the rest', async () => {
  const e = env();
  await seed(e);
  let calls = 0;
  _setParagrapher(async () => { calls++; throw new Error('api down'); });
  const out = await weekCron(e, SUN, async () => new Response('', { status: 200 }));
  assert.deepEqual(out.para, { skip: 'no paragraph' });
  assert.deepEqual(await weekParagraph(e, SUN + 3600000), { skip: 'written' });
  assert.equal(calls, 1);
  assert.equal((await weekBlock(e, SUN)).paragraph, null);
});

test('paragraphFacts keeps it short', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ text: 't' + i, day: 'Mon' }));
  const f = paragraphFacts({ week: 42, done: { count: 50, groups: [{ section: 'soon', items: many }] }, quiet: [], vacancies: [], others: null, next: { events: [] } }, null);
  assert.equal(f.done.tasks.length, 30);
  assert.equal(f.done.count, 50);
});
