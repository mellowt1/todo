// German tutor calls: routes, validation, merge rules, pruning and the morning field.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { handleGerman, cleanWeek, cleanOutcome, germanView, GERMAN_KEY, MAX_CALLS } from '../src/german.js';
import { handleMorning, zoned, addDays, local } from '../src/morning.js';
import { memNamespace } from './mem.js';

const BASE = 'https://paul-hub.example.workers.dev';
const CODE = 'abcdefgh23456789';
const PUSH = 'german-push-token-for-tests';
const READ = 'german-read-token-for-tests';
// Wednesday 7 October 2026, noon in Amsterdam. The week runs Monday 5 to Sunday 11.
const NOW = zoned('2026-10-07', '12:00');

function memKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
  };
}
const makeEnv = (over = {}) => ({ TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: memKV(), GERMAN_PUSH_TOKEN: PUSH, GERMAN_READ_TOKEN: READ, ...over });
const json = (data, request, status = 200) => Response.json(data, { status });

// Through the Worker (real clock) or straight into the module with a fixed clock.
const viaWorker = (env, path, { method = 'GET', token, body } = {}) => worker.fetch(new Request(BASE + path, {
  method, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: body === undefined ? undefined : JSON.stringify(body),
}), env);
const at = (env, path, { method = 'GET', token, body } = {}, now = NOW) => {
  const url = new URL(BASE + path);
  const req = new Request(url, { method, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  return handleGerman(req, env, url.pathname.split('/').filter(Boolean).slice(2), url, json, now);
};
const week = (env, calls, now) => at(env, '/api/german/week', { method: 'POST', token: PUSH, body: { calls } }, now);
const outcome = (env, body, now) => at(env, '/api/german/outcome', { method: 'POST', token: PUSH, body }, now);
const list = async (env, q = '', now) => (await at(env, '/api/german/calls' + q, { token: READ }, now)).json();
const stored = (env) => JSON.parse(env.HUB_KV.m.get(GERMAN_KEY) || '[]');

const call = (id, date, over = {}) => ({
  id, date, windowStart: '18:00', windowEnd: '21:00', at: `${date}T19:12:00+02:00`, persona: 'Ingrid', topic: 'Beim Bäcker', ...over,
});

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('no network in tests'); }; });
afterEach(() => { globalThis.fetch = realFetch; });

/* ---------- Auth ---------- */

test('auth: missing or wrong token is 401, an unset secret is 503, tokens do not cross', async () => {
  const env = makeEnv();
  const today = local(Date.now()).date;
  const body = { calls: [call('a1', today)] };
  assert.equal((await viaWorker(env, '/api/german/week', { method: 'POST', body })).status, 401);
  assert.equal((await viaWorker(env, '/api/german/week', { method: 'POST', token: 'wrong', body })).status, 401);
  assert.equal((await viaWorker(env, '/api/german/week', { method: 'POST', token: READ, body })).status, 401);
  assert.equal((await viaWorker(env, '/api/german/outcome', { method: 'POST', token: READ, body: {} })).status, 401);
  assert.equal((await viaWorker(env, '/api/german/calls')).status, 401);
  assert.equal((await viaWorker(env, '/api/german/calls', { token: PUSH })).status, 401);
  assert.equal(env.HUB_KV.m.has(GERMAN_KEY), false);

  const r = await viaWorker(env, '/api/german/week', { method: 'POST', token: PUSH, body });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, count: 1 });
  assert.equal((await viaWorker(env, '/api/german/calls', { token: READ })).status, 200);

  const off = makeEnv({ GERMAN_PUSH_TOKEN: undefined, GERMAN_READ_TOKEN: '' });
  const w = await viaWorker(off, '/api/german/week', { method: 'POST', token: PUSH, body });
  assert.equal(w.status, 503);
  assert.deepEqual(await w.json(), { error: 'not configured' });
  assert.equal((await viaWorker(off, '/api/german/outcome', { method: 'POST', token: PUSH, body: {} })).status, 503);
  assert.equal((await viaWorker(off, '/api/german/calls', { token: READ })).status, 503);
});

test('routes: wrong method is 405, unknown path is 404, CORS headers come along', async () => {
  const env = makeEnv();
  assert.equal((await viaWorker(env, '/api/german/week', { token: PUSH })).status, 405);
  assert.equal((await viaWorker(env, '/api/german/calls', { method: 'POST', token: READ, body: {} })).status, 405);
  assert.equal((await viaWorker(env, '/api/german/nope', { token: PUSH })).status, 404);
  const r = await worker.fetch(new Request(BASE + '/api/german/calls', { headers: { Authorization: 'Bearer ' + READ, Origin: 'http://localhost:8080' } }), env);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
});

/* ---------- Validation ---------- */

test('validation: the whole week is refused on any bad item, with a reason', async () => {
  const ok = call('a1', '2026-10-08');
  assert.equal(cleanWeek({ calls: [ok] }).calls.length, 1);
  assert.deepEqual(cleanWeek({ calls: [] }).calls, []);
  const bad = (over) => cleanWeek({ calls: [ok, { ...call('b2', '2026-10-09'), ...over }] }).error;
  assert.match(cleanWeek({}).error, /calls must be a list/);
  assert.match(cleanWeek(null).error, /calls must be a list/);
  assert.match(cleanWeek({ calls: Array.from({ length: MAX_CALLS + 1 }, (_, i) => call('c' + i, '2026-10-08')) }).error, /at most 20/);
  assert.match(bad({ id: 'Upper' }), /call 1: id/);
  assert.match(bad({ id: 'x'.repeat(65) }), /id/);
  assert.match(bad({ id: 'a1' }), /duplicate/);
  assert.match(bad({ date: '2026-02-30' }), /date/);
  assert.match(bad({ date: '8-10-2026' }), /date/);
  assert.match(bad({ windowStart: '6pm' }), /windowStart/);
  assert.match(bad({ windowEnd: '24:00' }), /windowEnd/);
  assert.match(bad({ windowEnd: '17:00' }), /after/);
  assert.match(bad({ at: '2026-10-09T19:12:00' }), /at must/);
  assert.match(bad({ at: 'tomorrow' }), /at must/);
  assert.match(bad({ persona: 'Klaus' }), /persona/);
  assert.match(bad({ topic: '' }), /topic/);
  assert.match(bad({ topic: 'x'.repeat(81) }), /topic/);
  assert.match(bad({ topic: 5 }), /topic/);
  assert.equal(cleanWeek({ calls: [call('z', '2026-10-08', { topic: 'x'.repeat(80) })] }).error, undefined);

  const env = makeEnv();
  const r = await week(env, [ok, call('b2', '2026-10-09', { persona: 'Nobody' })]);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /call 1: persona/);
  assert.equal(env.HUB_KV.m.has(GERMAN_KEY), false);
  const raw = await handleGerman(new Request(BASE + '/api/german/week', { method: 'POST', headers: { Authorization: 'Bearer ' + PUSH }, body: 'not json' }), env, ['week'], new URL(BASE), json, NOW);
  assert.equal(raw.status, 400);
});

test('validation: outcomes', () => {
  const o = { id: 'a1', status: 'answered', minutes: 12.5, outcomeAt: '2026-10-07T19:30:00+02:00', fixes: 3 };
  assert.deepEqual(cleanOutcome(o).outcome, o);
  assert.deepEqual(cleanOutcome({ id: 'a1', status: 'missed', outcomeAt: '2026-10-07T21:00:00Z' }).outcome,
    { id: 'a1', status: 'missed', minutes: null, fixes: null, outcomeAt: '2026-10-07T21:00:00Z' });
  assert.match(cleanOutcome({ ...o, id: 'A!' }).error, /id/);
  assert.match(cleanOutcome({ ...o, status: 'planned' }).error, /status/);
  assert.match(cleanOutcome({ ...o, minutes: 181 }).error, /minutes/);
  assert.match(cleanOutcome({ ...o, minutes: -1 }).error, /minutes/);
  assert.match(cleanOutcome({ ...o, minutes: '10' }).error, /minutes/);
  assert.match(cleanOutcome({ ...o, fixes: 1.5 }).error, /fixes/);
  assert.match(cleanOutcome({ ...o, fixes: 100 }).error, /fixes/);
  assert.match(cleanOutcome({ ...o, outcomeAt: 'now' }).error, /outcomeAt/);
  assert.match(cleanOutcome([]).error, /object/);
});

/* ---------- Merge rules ---------- */

test('upsert: a new plan never overwrites an outcome', async () => {
  const env = makeEnv();
  await week(env, [call('a1', '2026-10-06'), call('a2', '2026-10-08')]);
  assert.equal((await outcome(env, { id: 'a1', status: 'answered', minutes: 14, fixes: 4, outcomeAt: '2026-10-06T19:30:00+02:00' })).status, 200);
  // Replan: a1 gets a new topic, a2 moves.
  const r = await week(env, [call('a1', '2026-10-06', { topic: 'Neu' }), call('a2', '2026-10-09', { persona: 'Hartmut' })]);
  assert.deepEqual(await r.json(), { ok: true, count: 2 });
  const [a1, a2] = (await list(env)).calls;
  assert.equal(a1.topic, 'Neu');
  assert.equal(a1.status, 'answered');
  assert.equal(a1.minutes, 14);
  assert.equal(a1.fixes, 4);
  assert.equal(a1.outcomeAt, '2026-10-06T19:30:00+02:00');
  assert.deepEqual(a2, { ...call('a2', '2026-10-09', { persona: 'Hartmut' }), status: 'planned', minutes: null, fixes: null, outcomeAt: null, updated: new Date(NOW).toISOString() });
  // Status in the body is ignored.
  await week(env, [{ ...call('a2', '2026-10-09'), status: 'answered', minutes: 99 }]);
  const again = stored(env).find((c) => c.id === 'a2');
  assert.equal(again.status, 'planned');
  assert.equal(again.minutes, null);
});

test('replan: only planned calls from today on that the push leaves out are removed', async () => {
  const env = makeEnv();
  const yesterday = '2026-10-06';
  await week(env, [
    call('past-planned', yesterday), call('today-planned', '2026-10-07'), call('future-planned', '2026-10-09'),
    call('future-answered', '2026-10-08'), call('keep', '2026-10-10'),
  ], NOW - 3 * 86400000);
  await outcome(env, { id: 'future-answered', status: 'declined', outcomeAt: '2026-10-06T18:00:00+02:00' });
  await week(env, [call('keep', '2026-10-10'), call('new', '2026-10-11')]);
  assert.deepEqual(stored(env).map((c) => c.id).sort(), ['future-answered', 'keep', 'new', 'past-planned']);
  // An empty push clears every planned call from today on, and nothing else.
  await week(env, []);
  assert.deepEqual(stored(env).map((c) => c.id).sort(), ['future-answered', 'past-planned']);
});

/* ---------- Outcomes ---------- */

test('outcome: unknown id is 404, a later outcome replaces an earlier one', async () => {
  const env = makeEnv();
  await week(env, [call('a1', '2026-10-07')]);
  const miss = await outcome(env, { id: 'nope', status: 'missed', outcomeAt: '2026-10-07T21:00:00+02:00' });
  assert.equal(miss.status, 404);
  assert.equal((await outcome(env, { id: 'a1', status: 'maybe', outcomeAt: '2026-10-07T21:00:00+02:00' })).status, 400);

  const r = await outcome(env, { id: 'a1', status: 'missed', outcomeAt: '2026-10-07T21:00:00+02:00' });
  assert.deepEqual(await r.json(), { ok: true });
  let c = (await list(env)).calls[0];
  assert.equal(c.status, 'missed');
  assert.equal(c.minutes, null);

  const later = NOW + 3600000;
  await outcome(env, { id: 'a1', status: 'answered', minutes: 9, fixes: 2, outcomeAt: '2026-10-07T21:40:00+02:00' }, later);
  c = (await list(env)).calls[0];
  assert.equal(c.status, 'answered');
  assert.equal(c.minutes, 9);
  assert.equal(c.fixes, 2);
  assert.equal(c.outcomeAt, '2026-10-07T21:40:00+02:00');
  assert.equal(c.updated, new Date(later).toISOString());
  // A missed after that drops the minutes again: the latest outcome wins whole.
  await outcome(env, { id: 'a1', status: 'missed', outcomeAt: '2026-10-07T22:00:00+02:00' });
  assert.equal((await list(env)).calls[0].minutes, null);
});

/* ---------- Reading ---------- */

test('calls: default is the last 28 days, ?from filters, sorted by date and time', async () => {
  const env = makeEnv();
  const old = NOW - 40 * 86400000;
  await week(env, [call('old', '2026-08-28')], old);
  await week(env, [call('edge', '2026-09-09'), call('before', '2026-09-08')], NOW - 30 * 86400000);
  await week(env, [
    call('late', '2026-10-09', { at: '2026-10-09T20:30:00+02:00' }),
    call('early', '2026-10-09', { at: '2026-10-09T18:05:00+02:00' }),
    call('mid', '2026-10-08'),
  ]);
  const b = await list(env);
  assert.deepEqual(b.calls.map((c) => c.id), ['edge', 'mid', 'early', 'late']);
  assert.equal(b.updated, new Date(NOW).toISOString());
  assert.deepEqual(Object.keys(b.calls[0]).sort(),
    ['at', 'date', 'fixes', 'id', 'minutes', 'outcomeAt', 'persona', 'status', 'topic', 'updated', 'windowEnd', 'windowStart']);
  assert.deepEqual((await list(env, '?from=2026-08-01')).calls.map((c) => c.id), ['old', 'before', 'edge', 'mid', 'early', 'late']);
  assert.deepEqual((await list(env, '?from=2026-10-09')).calls.map((c) => c.id), ['early', 'late']);
  assert.equal((await at(env, '/api/german/calls?from=yesterday', { token: READ })).status, 400);
  assert.deepEqual(await list(makeEnv()), { calls: [], updated: null });
});

test('pruning: calls older than 90 days go on the next write', async () => {
  const env = makeEnv();
  const today = local(NOW).date;
  await week(env, [call('ancient', addDays(today, -91)), call('kept', addDays(today, -90))], NOW - 100 * 86400000);
  assert.equal(stored(env).length, 2);
  await week(env, [call('now', today)]);
  assert.deepEqual(stored(env).map((c) => c.id), ['kept', 'now']);
});

/* ---------- Morning ---------- */

test('morning: german field counts this week and the answered streak, null without data', async () => {
  const env = makeEnv();
  const morning = async () => (await handleMorning(new Request(`${BASE}/api/morning/${CODE}`), env, [CODE], json, NOW)).json();
  const before = await morning();
  assert.equal(before.german, null);
  // The other blocks are unchanged by the new field.
  assert.deepEqual(Object.keys(before), ['now', 'todos', 'calendar', 'fixed', 'weather', 'arsenal', 'bins', 'birthdays', 'news', 'kitchen', 'projects', 'german']);

  await week(env, [
    call('w-prev', '2026-10-01'), call('w-prev2', '2026-10-02'), call('w-prev3', '2026-10-03'),
    call('mon', '2026-10-05'), call('tue', '2026-10-06'), call('thu', '2026-10-08'), call('sun', '2026-10-11'), call('next', '2026-10-12'),
  ], NOW - 7 * 86400000);
  const o = (id, status, day) => outcome(env, { id, status, outcomeAt: `${day}T20:00:00+02:00` });
  await o('w-prev', 'answered', '2026-10-01');
  await o('w-prev2', 'missed', '2026-10-02');
  await o('w-prev3', 'answered', '2026-10-03');
  await o('mon', 'answered', '2026-10-05');
  await o('tue', 'answered', '2026-10-06');
  let g = (await morning()).german;
  assert.deepEqual(g.thisWeek, { planned: 2, answered: 2, missed: 0, declined: 0 });
  assert.equal(g.streak, 3);

  await o('tue', 'declined', '2026-10-06');
  g = (await morning()).german;
  assert.deepEqual(g.thisWeek, { planned: 2, answered: 1, missed: 0, declined: 1 });
  assert.equal(g.streak, 0);

  // A broken store only blanks this block.
  env.HUB_KV.get = async () => { throw new Error('kv down'); };
  const b = await morning();
  assert.deepEqual(b.german, { error: "German calls can't load right now" });
});

test('germanView: streak counts back from the latest non-planned call', () => {
  const c = (id, date, status) => ({ ...call(id, date), status });
  assert.equal(germanView([], NOW), null);
  assert.equal(germanView([c('a', '2026-10-01', 'planned')], NOW).streak, 0);
  assert.equal(germanView([c('a', '2026-10-01', 'answered'), c('b', '2026-10-02', 'answered'), c('p', '2026-10-09', 'planned')], NOW).streak, 2);
  assert.equal(germanView([c('a', '2026-10-01', 'answered'), c('b', '2026-10-02', 'missed')], NOW).streak, 0);
});
