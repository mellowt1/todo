import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// A Map is enough of KV for these tests.
function makeEnv() {
  const store = new Map();
  let puts = 0;
  return {
    env: {
      HUB_KV: {
        get: async (k) => (store.has(k) ? store.get(k) : null),
        put: async (k, v) => { puts++; store.set(k, v); },
      },
      TODO_CODE: 'abcdefgh23456789',
      TODO_READ_TOKEN: 'read-token-for-tests',
      ADMIN_TOKEN: 'admin-token-for-tests',
    },
    puts: () => puts,
  };
}

const BASE = 'https://paul-hub.example.workers.dev';
const CODE = 'abcdefgh23456789';
const call = (env, path, init = {}) => worker.fetch(new Request(BASE + path, init), env);
const post = (env, ops, origin = 'https://mellowt1.github.io') =>
  call(env, `/api/todo/${CODE}/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ ops }),
  });
const now = Date.now();
const task = (id, over = {}) => ({ id, text: 'Renew the museum card', section: 'today', done: false, doneAt: null, updatedAt: now, pos: now, ...over });

test('round trip: ops, then read, then since=rev is cheap', async () => {
  const { env, puts } = makeEnv();
  let r = await post(env, [{ op: 'upsert', item: task('aaaaaaaa') }, { op: 'upsert', item: task('bbbbbbbb', { done: true, doneAt: now }) }]);
  assert.equal(r.status, 200);
  const { rev } = await r.json();
  assert.equal(rev, 1);
  r = await call(env, `/api/todo/${CODE}`);
  const body = await r.json();
  assert.equal(body.items.length, 2);
  r = await call(env, `/api/todo/${CODE}?since=${rev}`);
  assert.deepEqual(await r.json(), { unchanged: true, rev: 1 });
  // Same batch again: no KV write, same rev.
  r = await post(env, [{ op: 'upsert', item: task('aaaaaaaa') }]);
  assert.equal((await r.json()).rev, 1);
  assert.equal(puts(), 1);
});

test('code must be exactly 16 lowercase letters or digits, and the known one', async () => {
  const { env } = makeEnv();
  assert.equal((await call(env, '/api/todo/short')).status, 400);
  assert.equal((await call(env, '/api/todo/ABCDEFGH23456789')).status, 400);
  assert.equal((await call(env, '/api/todo/abcdefgh2345678x')).status, 404);
  assert.equal((await call(env, `/api/todo/${CODE}`)).status, 200);
});

test('bad input is refused', async () => {
  const { env } = makeEnv();
  assert.equal((await post(env, [{ op: 'upsert', item: task('aaaaaaaa', { section: 'later' }) }])).status, 400);
  const r = await call(env, `/api/todo/${CODE}/ops`, { method: 'POST', body: 'not json' });
  assert.equal(r.status, 400);
  assert.equal((await call(env, `/api/todo/${CODE}/ops`, { method: 'GET' })).status, 405);
});

test('read token opens /api/todo/open and nothing else', async () => {
  const { env } = makeEnv();
  await post(env, [{ op: 'upsert', item: task('aaaaaaaa', { section: 'soon' }) }, { op: 'upsert', item: task('bbbbbbbb', { done: true, doneAt: now }) }]);
  const auth = { headers: { Authorization: 'Bearer read-token-for-tests' } };

  assert.equal((await call(env, '/api/todo/open')).status, 401);
  assert.equal((await call(env, '/api/todo/open', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const r = await call(env, '/api/todo/open', auth);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.items, [{ text: 'Renew the museum card', section: 'soon' }]);

  // No write through the read route, and the token does not open admin.
  assert.equal((await call(env, '/api/todo/open', { method: 'POST', ...auth })).status, 405);
  assert.equal((await call(env, '/api/admin/todo/export', auth)).status, 401);
});

test('admin token exports the whole document', async () => {
  const { env } = makeEnv();
  await post(env, [{ op: 'delete', item: { id: 'cccccccc', updatedAt: now } }]);
  const r = await call(env, '/api/admin/todo/export', { headers: { Authorization: 'Bearer admin-token-for-tests' } });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).tombs.cccccccc);
  assert.equal((await call(env, '/api/todo/open', { headers: { Authorization: 'Bearer admin-token-for-tests' } })).status, 401);
});

test('CORS allows Pages and localhost only', async () => {
  const { env } = makeEnv();
  const origin = async (o) => (await call(env, `/api/todo/${CODE}`, { headers: { Origin: o } })).headers.get('Access-Control-Allow-Origin');
  assert.equal(await origin('https://mellowt1.github.io'), 'https://mellowt1.github.io');
  assert.equal(await origin('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(await origin('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  assert.equal(await origin('https://evil.example'), null);
  assert.equal(await origin('http://localhost.evil.example'), null);
});

test('unknown module is a 404, leaving room for /api/morning later', async () => {
  const { env } = makeEnv();
  assert.equal((await call(env, '/api/morning')).status, 404);
});
