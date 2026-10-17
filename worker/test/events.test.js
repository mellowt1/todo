// Events: the hub's inbox. No network. Every name here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { cleanEvent, listEvents, eventsBlock, KEEP_DAYS } from '../src/events.js';

const NOW = Date.parse('2026-10-11T10:00:00Z');
const DAY = 86400000;
const TOKEN = 'event-token-for-tests';

function memKV() {
  const m = new Map();
  const kv = {
    m, ttl: new Map(),
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v, opts) { m.set(k, v); if (opts && opts.expirationTtl) kv.ttl.set(k, opts.expirationTtl); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }; },
  };
  return kv;
}
const env = (over = {}) => ({ HUB_KV: memKV(), EVENT_TOKEN: TOKEN, ...over });
const post = (e, body, token = TOKEN) => worker.fetch(new Request('https://hub.example/api/event', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}), e);
const get = (e, q = '', token = TOKEN) => worker.fetch(new Request('https://hub.example/api/event' + q, { headers: { Authorization: 'Bearer ' + token } }), e);

test('cleanEvent: source and text are required, the rest is optional and bounded', () => {
  assert.equal(cleanEvent(null).error, 'send { source, text }');
  assert.match(cleanEvent({ source: 'Feeling App', text: 'x' }, NOW).error, /source/);
  assert.equal(cleanEvent({ source: 'feeling', text: '  ' }, NOW).error, 'text required');
  const r = cleanEvent({ source: 'Feeling', text: '  Nick\tchecked\n in  ', kind: 'CheckIn', who: 'Nick', at: '2026-10-11T09:12:00Z' }, NOW);
  assert.deepEqual(r, { source: 'feeling', kind: 'checkin', who: 'Nick', text: 'Nick checked in', at: '2026-10-11T09:12:00.000Z' });
  assert.equal(cleanEvent({ source: 'pc', text: 'x', kind: 'not a word' }, NOW).kind, 'note');
  assert.equal(cleanEvent({ source: 'pc', text: 'x'.repeat(500) }, NOW).text.length, 140);
});

test('cleanEvent: a missing, future or ancient `at` becomes now', () => {
  const now = new Date(NOW).toISOString();
  assert.equal(cleanEvent({ source: 'pc', text: 'x' }, NOW).at, now);
  assert.equal(cleanEvent({ source: 'pc', text: 'x', at: '2027-01-01T00:00:00Z' }, NOW).at, now);
  assert.equal(cleanEvent({ source: 'pc', text: 'x', at: new Date(NOW - 40 * DAY).toISOString() }, NOW).at, now);
  assert.equal(cleanEvent({ source: 'pc', text: 'x', at: 'yesterday' }, NOW).at, now);
});

test('POST /api/event: token, limits, stored under a sortable key with a 30 day life', async () => {
  const e = env();
  assert.equal((await post(e, { source: 'feeling', text: 'x' }, 'wrong')).status, 401);
  assert.equal((await post(env({ EVENT_TOKEN: undefined }), { source: 'feeling', text: 'x' }, '')).status, 401);
  assert.equal((await post(e, '{not json')).status, 400);
  assert.equal((await post(e, { source: 'feeling' })).status, 400);
  assert.equal((await post(e, { source: 'feeling', text: 'x'.repeat(3000) })).status, 413);
  const r = await post(e, { source: 'feeling', text: 'Nick checked in', kind: 'checkin', who: 'Nick' });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.ok(out.ok && /^[a-z0-9]{6}$/.test(out.id));
  const keys = [...e.HUB_KV.m.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^event:\d{14}:[a-z0-9]{6}$/);
  const ttl = e.HUB_KV.ttl.get(keys[0]);
  assert.ok(ttl > (KEEP_DAYS - 1) * 86400 && ttl <= KEEP_DAYS * 86400);
  assert.deepEqual(JSON.parse(e.HUB_KV.m.get(keys[0])), { id: out.id, source: 'feeling', kind: 'checkin', who: 'Nick', text: 'Nick checked in', at: out.at });
});

test('GET /api/event and the Morning block: newest first, only the last days, per-source last heard', async () => {
  const e = env();
  const put = (ms, source, text) => e.HUB_KV.m.set('event:' + String(ms).padStart(14, '0') + ':' + source.slice(0, 6).padEnd(6, 'x'), JSON.stringify({ id: 'id' + ms, source, kind: 'note', who: '', text, at: new Date(ms).toISOString() }));
  put(NOW - 5 * DAY, 'runway', 'old');
  put(NOW - 2 * DAY, 'runway', 'bank synced');
  put(NOW - 3600000, 'feeling', 'Nick checked in');
  put(NOW - 60000, 'plan-regreso', 'Dad ticked Pasaporte');
  assert.equal((await get(e, '', 'wrong')).status, 401);
  const three = await listEvents(e, NOW, 3);
  assert.deepEqual(three.map((x) => x.text), ['Dad ticked Pasaporte', 'Nick checked in', 'bank synced']);
  assert.equal((await listEvents(e, NOW, 10)).length, 4);
  const b = await eventsBlock(e, NOW);
  assert.equal(b.events.length, 3);
  assert.deepEqual(b.sources, { 'plan-regreso': new Date(NOW - 60000).toISOString(), feeling: new Date(NOW - 3600000).toISOString(), runway: new Date(NOW - 2 * DAY).toISOString() });
  assert.equal(await eventsBlock(env(), NOW), null, 'hidden until the first event');
  // The route reads the real clock, so its events are placed relative to it.
  const live = env();
  const at = (ms, text) => live.HUB_KV.m.set('event:' + String(ms).padStart(14, '0') + ':pcxxxx', JSON.stringify({ id: 'id' + ms, source: 'pc', kind: 'note', who: '', text, at: new Date(ms).toISOString() }));
  at(Date.now() - 12 * DAY, 'too old');
  at(Date.now() - 5 * DAY, 'in the window');
  at(Date.now() - 60000, 'just now');
  const r = await get(live, '?days=10');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).events.map((x) => x.text), ['just now', 'in the window']);
  assert.equal((await worker.fetch(new Request('https://hub.example/api/event/x', { headers: { Authorization: 'Bearer ' + TOKEN } }), e)).status, 404);
});
