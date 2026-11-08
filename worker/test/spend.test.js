// Spend: the usage counters priced per model, old counts at the feature's old model, the route
// behind the to-do's code, and bumpUsage keeping a bucket per model. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceOf, costOf, spendBlock, handleSpend } from '../src/spend.js';
import { bumpUsage, trackRes } from '../src/intake.js';

const CODE = 'abcdefgh12345678';
const NOV8 = Date.parse('2026-11-08T12:00:00Z');

function kv() {
  const m = new Map();
  return { m, async get(k, t) { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); } };
}
const json = (body, _r, status = 200) => ({ status, body });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('a million of each kind costs the list price', () => {
  near(priceOf({ input: 1e6 }, 'claude-haiku-5-5'), 0.10);
  near(priceOf({ output: 1e6 }, 'claude-sonnet-5-5'), 10);
  near(priceOf({ cacheRead: 1e6, cacheWrite: 1e6 }, 'claude-opus-5-5'), 0.20 + 5);
  near(priceOf({ input: 1e6 }, 'claude-unknown'), 4); // priced as Opus
});

test('per-model buckets first, the rest at the old model', () => {
  const cur = { calls: 3, input: 3e6, output: 0, cacheRead: 0, cacheWrite: 0, m: { 'claude-sonnet-5-5': { calls: 1, input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 } } };
  const c = costOf(cur, 'claude-haiku-5-5');
  assert.equal(c.calls, 3);
  near(c.usd, 2 + 2 * 0.10);
  assert.deepEqual(costOf(null, 'claude-haiku-5-5'), { calls: 0, usd: 0 });
});

test('bumpUsage keeps a bucket per model; trackRes reads a raw answer', async () => {
  const env = { HUB_KV: kv() };
  await bumpUsage(env, '2026-11', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 'tidy'); // an old-style count
  await bumpUsage(env, '2026-11', { input: 100, output: 50, cacheRead: 7, cacheWrite: 3, model: 'claude-sonnet-5-5' }, 'tidy');
  await trackRes(env, 'mirror', { model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, NOV8);
  await trackRes(env, 'mirror', null, NOV8); // a failed call counts nothing
  const t = JSON.parse(env.HUB_KV.m.get('tidy:usage:2026-11'));
  assert.equal(t.calls, 2);
  assert.equal(t.input, 110);
  assert.deepEqual(t.m, { 'claude-sonnet-5-5': { calls: 1, input: 100, output: 50, cacheRead: 7, cacheWrite: 3 } });
  const mi = JSON.parse(env.HUB_KV.m.get('mirror:usage:2026-11'));
  assert.equal(mi.calls, 1);
  assert.equal(mi.m['claude-opus-5-5'].output, 200);
});

test('the block: this month by feature, dearest first, pace and last month', async () => {
  const env = { HUB_KV: kv() };
  env.HUB_KV.m.set('intake:usage:2026-11', JSON.stringify({ calls: 4, input: 200000, output: 20000, cacheRead: 0, cacheWrite: 0 })); // Opus: 0.8 + 0.4
  env.HUB_KV.m.set('tidy:usage:2026-11', JSON.stringify({ calls: 50, input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 })); // Haiku: 0.10
  env.HUB_KV.m.set('desk:usage:2026-10', JSON.stringify({ calls: 9, input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 })); // Opus: 4
  const b = await spendBlock(env, NOV8);
  assert.equal(b.month, '2026-11');
  assert.equal(b.usd, 1.3);
  assert.equal(b.calls, 54);
  assert.deepEqual(b.features.map((f) => f.key), ['intake', 'tidy']);
  assert.equal(b.features[0].label, 'Letters read');
  assert.equal(b.pace, Math.round((1.3 / 8) * 30 * 100) / 100);
  assert.deepEqual(b.last, { month: '2026-10', usd: 4 });
  const jan2 = await spendBlock(env, Date.parse('2027-01-02T12:00:00Z'));
  assert.equal(jan2.pace, null);
  assert.equal(jan2.last.month, '2026-12');
});

test('the route needs the to-do code', async () => {
  const env = { HUB_KV: kv(), TODO_CODE: CODE };
  const req = { method: 'GET' };
  assert.equal((await handleSpend(req, env, ['abcdefgh00000000'], json)).status, 404);
  assert.equal((await handleSpend(req, env, ['bad'], json)).status, 400);
  const ok = await handleSpend(req, env, [CODE], json);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.usd, 0);
  assert.deepEqual(ok.body.features, []);
});
