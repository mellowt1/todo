// Status: the hub's one line about everything. No network. Every name here is made up.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { gatherFacts, rulesLine, shouldSummarise, refreshStatus, STATUS_KEY, SUMMARY_AT_KEY, _setWriter } from '../src/status.js';
import { zoned, CAL_KEY, PROJECTS_KEY, REPOS_KEY } from '../src/morning.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = zoned('2026-10-12', '06:23'); // the cron's first run after six, Amsterdam

function memKV() {
  const m = new Map();
  const puts = [];
  return {
    m, puts,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); puts.push(k); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }; },
  };
}
const iso = (ms) => new Date(ms).toISOString();
const env = (over = {}) => ({ HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE, ...over });

async function seed(e, now = NOW) {
  const kv = e.HUB_KV;
  const ev = (ms, source, text) => kv.m.set(`event:${String(ms).padStart(14, '0')}:${source.slice(0, 2)}${String(ms).slice(-4)}`, JSON.stringify({ id: 'x', source, kind: 'note', who: '', text, at: iso(ms) }));
  ev(now - 2 * HOUR, 'feeling', 'Nick checked in');
  ev(now - 5 * HOUR, 'feeling', 'Elias sent a cheer');
  ev(now - 6 * HOUR, 'feeling', 'Nick checked in');
  ev(now - 7 * HOUR, 'feeling', 'Nick checked in');
  ev(now - 20 * HOUR, 'pc', 'Projects list refreshed');
  ev(now - 30 * HOUR, 'arsenal-watch', 'Arsenal drop: old one'); // outside 24 h
  kv.m.set('beat:arsenal-watch', JSON.stringify({ at: iso(now - 5 * HOUR) })); // limit 3 h: quiet
  kv.m.set('beat:morning-projects', JSON.stringify({ at: iso(now - 20 * HOUR) }));
  kv.m.set('beat:backup', JSON.stringify({ at: iso(now - 10 * DAY) })); // old
  kv.m.set(CAL_KEY, JSON.stringify({ received: iso(now - HOUR), events: [] }));
  kv.m.set(REPOS_KEY, JSON.stringify({ updated: iso(now - HOUR), repos: [{ name: 'lift', why: 'no remote' }, { name: 'eduardo-site', why: '2 ahead' }] }));
  kv.m.set(PROJECTS_KEY, JSON.stringify({ projects: [{ name: 'Lift', status: 'parked', next: 'Host it', id: 'aaaaaa', since: '2026-10-01' }], parked: [{ text: 'VanMoof key', from: 'Bike', id: 'bbbbbb', since: '2026-10-05' }] }));
  kv.puts.length = 0;
  const n = Date.now();
  const t = (id, section, done) => ({ op: 'upsert', item: { id, text: 'Task ' + id, section, done, doneAt: done ? n : null, updatedAt: n, pos: n } });
  const r = await worker.fetch(new Request(`https://hub.example/api/todo/${CODE}/ops`, { method: 'POST', body: JSON.stringify({ ops: [t('aaaaaaaa', 'today', false), t('bbbbbbbb', 'today', false), t('cccccccc', 'soon', false), t('dddddddd', 'today', true)] }) }), e);
  assert.equal(r.status, 200);
}

afterEach(() => _setWriter(null));

test('gatherFacts: events of the last 24 h by source, quiet jobs, backup age, to-dos, repos, parked', async () => {
  const e = env();
  await seed(e);
  const f = await gatherFacts(e, NOW);
  assert.equal(f.events.total, 5);
  assert.deepEqual(Object.keys(f.events.sources), ['feeling', 'pc']);
  assert.equal(f.events.sources.feeling.count, 4);
  assert.deepEqual(f.events.sources.feeling.latest, ['Nick checked in', 'Elias sent a cheer', 'Nick checked in']);
  assert.deepEqual(f.jobs.quiet.map((q) => q.job), ['arsenal-watch', 'backup']);
  assert.equal(f.jobs.quiet[0].hoursAgo, 5);
  assert.equal(f.jobs.ok, 2, 'calendar + morning-projects');
  assert.deepEqual(f.jobs.unknown, ['defence-digest', 'icc-briefing']);
  assert.equal(f.backup.ageDays, 10);
  assert.deepEqual(f.todos, { open: 3, today: 2 });
  assert.deepEqual(f.repos, { notPushed: 2, names: ['lift', 'eduardo-site'] });
  assert.deepEqual(f.parked, { count: 2, oldestDays: 11 });
});

test('gatherFacts: an empty hub gives nulls and zeros, never throws', async () => {
  const e = env({ TODO_LIST: undefined });
  const f = await gatherFacts(e, NOW);
  assert.deepEqual(f.events, { total: 0, sources: {} });
  assert.deepEqual(f.jobs.quiet, []);
  assert.equal(f.backup.ageDays, null);
  assert.equal(f.todos, null);
  assert.equal(f.repos, null);
  assert.deepEqual(f.parked, { count: 0, oldestDays: null });
});

test('rulesLine: late things first, then what happened, then the counts', async () => {
  const e = env();
  await seed(e);
  const f = await gatherFacts(e, NOW);
  assert.equal(rulesLine(f), 'Arsenal ticket watch quiet 5 hours, Weekly backup quiet 10 days, backup 10 days old, 5 things happened in 2 apps, 3 open to-dos, 2 repos not pushed, 2 things parked.');
  const quiet = await gatherFacts(env({ TODO_LIST: undefined }), NOW);
  assert.equal(rulesLine(quiet), 'A quiet night.');
  assert.equal(rulesLine({ ...quiet, todos: { open: 1, today: 1 } }), 'A quiet night, 1 open to-do.');
  assert.equal(rulesLine({ ...quiet, jobs: { quiet: [{ job: 'backup', name: 'Weekly backup', hoursAgo: 240, limit: 198 }], ok: 0, unknown: [] } }), 'Weekly backup quiet 10 days.');
});

test('shouldSummarise: once a day, first run at or after six Amsterdam', () => {
  assert.equal(shouldSummarise(zoned('2026-10-12', '05:59'), null), false);
  assert.equal(shouldSummarise(zoned('2026-10-12', '06:23'), null), true);
  assert.equal(shouldSummarise(zoned('2026-10-12', '06:23'), iso(zoned('2026-10-11', '06:23'))), true);
  assert.equal(shouldSummarise(zoned('2026-10-12', '07:23'), iso(zoned('2026-10-12', '06:23'))), false);
  assert.equal(shouldSummarise(zoned('2026-10-12', '23:23'), iso(zoned('2026-10-12', '06:23'))), false);
  assert.equal(shouldSummarise(zoned('2026-10-12', '12:23'), 'garbage'), true);
});

test('refreshStatus: line every hour, one summary a day, carried between runs', async () => {
  const e = env();
  await seed(e);
  const calls = [];
  const write = async (_env, facts) => { calls.push(facts); return 'Arsenal watch is quiet. Nick checked in three times.'; };

  const r1 = await refreshStatus(e, NOW, write);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].events.total, 5, 'the writer sees the facts');
  assert.equal(r1.summary, 'Arsenal watch is quiet. Nick checked in three times.');
  assert.match(r1.line, /^Arsenal ticket watch quiet/);
  assert.equal(r1.summaryAt, iso(NOW));
  assert.equal(e.HUB_KV.m.get(SUMMARY_AT_KEY), iso(NOW));

  const r2 = await refreshStatus(e, NOW + HOUR, write);
  assert.equal(calls.length, 1, 'not again this day');
  assert.equal(r2.summary, r1.summary, 'carried');
  assert.equal(r2.summaryAt, iso(NOW));
  assert.equal(r2.at, iso(NOW + HOUR));
  assert.equal(JSON.parse(e.HUB_KV.m.get(STATUS_KEY)).at, iso(NOW + HOUR));

  await refreshStatus(e, NOW + DAY, write);
  assert.equal(calls.length, 2, 'next morning');
});

test('refreshStatus: a failing writer keeps the line, drops the summary, and still spends the day', async () => {
  const e = env();
  await seed(e);
  const r = await refreshStatus(e, NOW, async () => { throw new Error('api down'); });
  assert.equal(r.summary, null);
  assert.match(r.line, /\.$/);
  assert.equal(e.HUB_KV.m.get(SUMMARY_AT_KEY), iso(NOW), 'reserved before the call');
  let called = 0;
  await refreshStatus(e, NOW + HOUR, async () => { called++; return 'x'; });
  assert.equal(called, 0, 'one attempt per day');
  const nul = await refreshStatus(e, NOW + DAY, async () => null);
  assert.equal(nul.summary, null);
});

test('refreshStatus: the default writer is a no-op without a key', async () => {
  const e = env();
  await seed(e);
  const r = await refreshStatus(e, NOW);
  assert.equal(r.summary, null);
  assert.ok(r.line);
});

test('refreshStatus: writes only hub:* keys and never touches the to-do list', async () => {
  const e = env();
  await seed(e);
  const writesBefore = e.HUB_KV.m.size;
  const doWrites = [...e.TODO_LIST.storages.values()].map((s) => s.writes);
  await refreshStatus(e, NOW, async () => 'fine');
  await refreshStatus(e, NOW + HOUR, async () => 'fine');
  assert.deepEqual([...new Set(e.HUB_KV.puts)].sort(), [STATUS_KEY, SUMMARY_AT_KEY]);
  assert.equal(e.HUB_KV.m.size, writesBefore + 2);
  assert.deepEqual([...e.TODO_LIST.storages.values()].map((s) => s.writes), doWrites);
});

test('the cron runs the status alongside health and the snapshot', async () => {
  const e = env({ NTFY_TOPIC: undefined });
  await seed(e);
  let settled;
  await worker.scheduled({}, e, { waitUntil: (p) => { settled = p; } });
  await settled;
  const s = JSON.parse(e.HUB_KV.m.get(STATUS_KEY));
  assert.ok(s.line);
  assert.ok(s.facts.events.total >= 0);
});
