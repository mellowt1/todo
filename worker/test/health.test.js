// Heartbeats, the hourly check, and Morning's repos + links blocks. No network: fetch is passed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { JOBS, healthChanges, checkHealth, ago } from '../src/health.js';
import { cleanRepos, linksBlock, CAL_KEY } from '../src/morning.js';

const HOUR = 3600000;
const NOW = Date.parse('2026-10-05T12:00:00Z');
const TOKEN = 'beat-token-for-tests';

function memKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}
const env = (over = {}) => ({ HUB_KV: memKV(), BEAT_TOKEN: TOKEN, NTFY_TOPIC: 'test-topic', ...over });
const beat = (e, body, token = TOKEN) => worker.fetch(new Request('https://hub.example/api/health/beat', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), e);

test('beat: needs the token and a known job', async () => {
  const e = env();
  assert.equal((await beat(e, { job: 'arsenal-watch' }, 'wrong')).status, 401);
  assert.equal((await beat(e, { job: 'nope' })).status, 400);
  assert.equal((await beat(e, { job: 'calendar' })).status, 400, 'the calendar beats through its own push');
  const r = await beat(e, { job: 'arsenal-watch', note: 'x'.repeat(500) });
  assert.equal(r.status, 200);
  const stored = JSON.parse(e.HUB_KV.m.get('beat:arsenal-watch'));
  assert.ok(Date.parse(stored.at));
  assert.equal(stored.note.length, 200);
});

test('beat: no BEAT_TOKEN set means nobody gets in', async () => {
  assert.equal((await beat(env({ BEAT_TOKEN: undefined }), { job: 'backup' }, '')).status, 401);
});

test('health: never-seen jobs are not checked; late ones alert once, then once when back', () => {
  const beats = { 'arsenal-watch': NOW - 4 * HOUR, 'morning-projects': NOW - HOUR, backup: null };
  const a = healthChanges(beats, {}, NOW);
  assert.deepEqual(a.send.map((m) => m.title), ['Arsenal ticket watch stopped']);
  assert.match(a.send[0].message, /4 hours ago/);
  assert.ok(a.alerted['arsenal-watch']);

  const b = healthChanges(beats, a.alerted, NOW + HOUR);
  assert.equal(b.send.length, 0, 'no second alert while still late');

  const c = healthChanges({ ...beats, 'arsenal-watch': NOW + HOUR }, b.alerted, NOW + 2 * HOUR);
  assert.deepEqual(c.send.map((m) => m.title), ['Arsenal ticket watch is running again']);
  assert.equal(c.alerted['arsenal-watch'], undefined);
});

test('health: every job has a name, a limit and a hint', () => {
  for (const [job, d] of Object.entries(JOBS)) {
    assert.match(job, /^[a-z0-9-]+$/);
    assert.ok(d.name && d.how && d.hours > 1, job);
  }
});

test('checkHealth: reads the calendar push, sends to ntfy, remembers only what was sent', async () => {
  const e = env();
  await e.HUB_KV.put(CAL_KEY, JSON.stringify({ received: new Date(NOW - 5 * HOUR).toISOString(), events: [] }));
  await e.HUB_KV.put('beat:backup', JSON.stringify({ at: new Date(NOW - HOUR).toISOString() }));
  const calls = [];
  let okay = false;
  const fetcher = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: okay }; };

  await checkHealth(e, NOW, fetcher);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].topic, 'test-topic');
  assert.equal(calls[0].title, 'Calendar push from Odysseus stopped');
  assert.equal(e.HUB_KV.m.get('health:alerted'), undefined, 'ntfy failed: try again next hour');

  okay = true;
  await checkHealth(e, NOW, fetcher);
  assert.equal(calls.length, 2);
  assert.ok(JSON.parse(e.HUB_KV.m.get('health:alerted')).calendar);

  await checkHealth(e, NOW + HOUR, fetcher);
  assert.equal(calls.length, 2, 'once only');
});

test('checkHealth: no topic, no sends', async () => {
  const e = env({ NTFY_TOPIC: undefined });
  await e.HUB_KV.put('beat:backup', JSON.stringify({ at: new Date(NOW - 30 * 24 * HOUR).toISOString() }));
  let called = false;
  await checkHealth(e, NOW, async () => { called = true; return { ok: true }; });
  assert.equal(called, false);
});

test('ago: plain words', () => {
  assert.equal(ago(10 * 60000), 'under an hour ago');
  assert.equal(ago(HOUR), '1 hour ago');
  assert.equal(ago(5 * HOUR), '5 hours ago');
  assert.equal(ago(72 * HOUR), '3 days ago');
});

test('repos: cleaned, capped, null without a scan', () => {
  assert.equal(cleanRepos(null), null);
  assert.equal(cleanRepos({}), null);
  const r = cleanRepos({ updated: '2026-10-05T07:31:00.000Z', repos: [{ name: 'lift', why: 'no remote' }, { name: '', why: 'x' }, { name: 'a\u0000b', why: 'y'.repeat(300) }] });
  assert.deepEqual(r.repos.map((x) => x.name), ['lift', 'a b']);
  assert.equal(r.repos[1].why.length, 120);
  assert.equal(r.updated, '2026-10-05T07:31:00.000Z');
});

test('links: https only, broken secret is empty', () => {
  for (const raw of [undefined, '', 'not json', '{}']) assert.deepEqual(linksBlock(raw), { links: [] });
  const l = linksBlock(JSON.stringify([
    { name: 'Kitchen', url: 'https://example.github.io/kitchen/?c=abc' },
    { name: 'Bad', url: 'javascript:alert(1)' },
    { name: 'Plain', url: 'http://example.com/' },
    { name: 'Day', url: 'https://day.example/' },
  ]));
  assert.deepEqual(l.links.map((x) => x.name), ['Kitchen', 'Day']);
});
