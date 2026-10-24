// Spotify, for real: the sealed login, connecting, refreshing, picking the device Paul tapped on,
// playing (now, or once Spotify comes up), his playlists, and Day. Spotify itself is mocked: no
// network. Every id, token and name here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { pickDevice, play, seal, unseal, accessToken, SCOPES, REDIRECT, WAIT, MOVE } from '../src/spotify.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const DAY_SECRET = 'day-secret-for-tests';
const NOW = Date.parse('2026-10-24T09:00:00Z');
const URI = 'spotify:playlist:37i9dQZF1DX4sWSpwq3LiO';
WAIT.every = 5; // the background tries, quickly
MOVE.ms = 5;

function memKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }; },
  };
}
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');
const env = (over = {}) => ({
  HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_SECRET_DAY: DAY_SECRET,
  SPOTIFY_CLIENT_ID: 'client-id-made-up', SPOTIFY_CLIENT_SECRET: 'client-secret-made-up', SPOTIFY_KEY: KEY, ...over,
});

// Spotify, mocked. `sp.devices` is what the device list shows; `sp.calls` records every call.
const sp = { devices: [], calls: [], playStatus: 204, needsMove: false, moved: [], refresh: 'refresh-1', rotate: null, refuse: false, playlists: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
  sp.calls.push({ u, method: init.method || 'GET', auth, body: init.body ? String(init.body) : '' });
  if (u === 'https://accounts.spotify.com/api/token') {
    const p = new URLSearchParams(String(init.body));
    if (auth !== 'Basic ' + btoa('client-id-made-up:client-secret-made-up')) return Response.json({ error: 'invalid_client' }, { status: 401 });
    if (p.get('grant_type') === 'authorization_code') {
      if (p.get('code') !== 'good-code' || p.get('redirect_uri') !== REDIRECT) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: 'access-1', refresh_token: sp.refresh, expires_in: 3600, scope: SCOPES });
    }
    if (p.get('grant_type') === 'refresh_token') {
      if (sp.refuse || p.get('refresh_token') !== sp.refresh) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const out = { access_token: 'access-' + (sp.calls.length + 1), expires_in: 3600 };
      if (sp.rotate) { out.refresh_token = sp.rotate; sp.refresh = sp.rotate; sp.rotate = null; }
      return Response.json(out);
    }
  }
  if (u === 'https://api.spotify.com/v1/me/player/devices') return Response.json({ devices: sp.devices });
  if (u.startsWith('https://api.spotify.com/v1/me/player/play?device_id=')) {
    const id = decodeURIComponent(u.split('device_id=')[1]);
    if (sp.needsMove && !sp.moved.includes(id)) return Response.json({ error: { status: 404, message: 'Device not found' } }, { status: 404 });
    return new Response(null, { status: sp.playStatus });
  }
  if (u === 'https://api.spotify.com/v1/me/player' && init.method === 'PUT') { sp.moved.push(JSON.parse(init.body).device_ids[0]); return new Response(null, { status: 204 }); }
  if (u.startsWith('https://api.spotify.com/v1/me/playlists')) {
    const second = u.includes('offset=50');
    return Response.json({ items: second ? sp.playlists.slice(50) : sp.playlists.slice(0, 50), next: !second && sp.playlists.length > 50 ? 'https://api.spotify.com/v1/me/playlists?offset=50&limit=50' : null });
  }
  return realFetch(url, init);
};

async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
}
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const raw = (e, path, init = {}, ms = NOW) => at(ms, () => worker.fetch(new Request('https://paul-hub.paul-o-a04.workers.dev/api/' + path, init), e, ctx));
const call = async (e, path, body, ms = NOW, headers = {}) => {
  const r = await raw(e, path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }, ms);
  return { status: r.status, body: await r.json() };
};
async function connect(e) {
  const r = await raw(e, 'spotify/' + CODE + '/login');
  const state = new URL(r.headers.get('Location')).searchParams.get('state');
  return raw(e, 'spotify/callback?code=good-code&state=' + state);
}
const phone = { id: 'dev-iphone', name: 'iPhone', type: 'Smartphone', is_active: false, is_restricted: false };
const pc = { id: 'dev-pc', name: 'PAUL-PC', type: 'Computer', is_active: true, is_restricted: false };

test('seal: AES-GCM round trip, nothing readable at rest, a wrong key opens nothing', async () => {
  const e = env();
  const s = await seal(e, { refresh: 'refresh-secret' });
  assert.doesNotMatch(s, /refresh-secret/);
  assert.deepEqual(await unseal(e, s), { refresh: 'refresh-secret' });
  assert.equal(await unseal(env({ SPOTIFY_KEY: Buffer.alloc(32, 7).toString('base64') }), s), null);
});

test('pickDevice: the kind he tapped on, an active one first, never a restricted one', () => {
  const phone2 = { ...phone, id: 'dev-iphone-2', is_active: true };
  assert.equal(pickDevice([pc, phone], 'phone').id, 'dev-iphone');
  assert.equal(pickDevice([pc, phone, phone2], 'phone').id, 'dev-iphone-2');
  assert.equal(pickDevice([phone, pc], 'computer').id, 'dev-pc');
  assert.equal(pickDevice([{ ...phone, is_restricted: true }], 'phone'), null);
  assert.equal(pickDevice([pc], 'phone'), null);
  assert.equal(pickDevice([{ ...phone, type: 'Tablet' }], 'phone').type, 'Tablet');
  assert.equal(pickDevice([pc], 'tv'), null);
});

test('connecting: the consent page asks for the three scopes only; the login is kept sealed', async () => {
  const e = env();
  assert.deepEqual((await call(e, 'spotify/' + CODE)).body, { configured: true, connected: false });
  const r = await raw(e, 'spotify/' + CODE + '/login');
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get('Location'));
  assert.equal(to.origin + to.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(to.searchParams.get('scope'), 'playlist-read-private user-read-playback-state user-modify-playback-state');
  assert.equal(to.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(to.searchParams.get('client_id'), 'client-id-made-up');
  // a made-up or used state is refused
  assert.equal((await raw(e, 'spotify/callback?code=good-code&state=' + 'f'.repeat(32))).status, 400);
  const state = to.searchParams.get('state');
  const ok = await raw(e, 'spotify/callback?code=good-code&state=' + state);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Spotify is connected/);
  assert.equal((await raw(e, 'spotify/callback?code=good-code&state=' + state)).status, 400);
  const kept = e.HUB_KV.m.get('spotify:login');
  assert.ok(kept && !/refresh-1|access-1/.test(kept));
  assert.deepEqual((await call(e, 'spotify/' + CODE)).body, { configured: true, connected: true });
  // a refused consent keeps nothing
  const e2 = env();
  const r2 = await raw(e2, 'spotify/' + CODE + '/login');
  const st2 = new URL(r2.headers.get('Location')).searchParams.get('state');
  assert.equal((await raw(e2, 'spotify/callback?error=access_denied&state=' + st2)).status, 400);
  assert.equal(e2.HUB_KV.m.get('spotify:login'), undefined);
});

test('refresh: a token near its end is renewed, a new refresh token is kept, a revoked one forgets', async () => {
  const e = env();
  await at(NOW, () => connect(e));
  assert.equal(await accessToken(e, NOW + 10 * 60000), 'access-1'); // still fresh
  sp.rotate = 'refresh-2';
  const t2 = await accessToken(e, NOW + 59 * 60000 + 30000);
  assert.match(t2, /^access-\d+$/);
  assert.notEqual(t2, 'access-1');
  assert.equal((await unseal(e, e.HUB_KV.m.get('spotify:login'))).refresh, 'refresh-2');
  sp.refuse = true;
  assert.equal(await accessToken(e, NOW + 3 * 3600000), null);
  assert.equal(e.HUB_KV.m.get('spotify:login'), undefined);
  sp.refuse = false;
  sp.refresh = 'refresh-1';
});

test('play: on the Spotify he tapped on, now when it is there', async () => {
  const e = env();
  await at(NOW, () => connect(e));
  sp.devices = [pc, phone];
  sp.calls.length = 0;
  let r = await call(e, 'spotify/' + CODE + '/play', { uri: URI, kind: 'phone' }, NOW + 60000);
  assert.deepEqual(r.body, { ok: true, device: 'iPhone' });
  const put = sp.calls.find((c) => c.method === 'PUT');
  assert.equal(put.u, 'https://api.spotify.com/v1/me/player/play?device_id=dev-iphone');
  assert.deepEqual(JSON.parse(put.body), { context_uri: URI });
  r = await call(e, 'spotify/' + CODE + '/play', { uri: URI, kind: 'computer' }, NOW + 60000);
  assert.deepEqual(r.body, { ok: true, device: 'PAUL-PC' });
  // only playlists, only the two kinds
  assert.equal((await call(e, 'spotify/' + CODE + '/play', { uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', kind: 'phone' })).status, 400);
  assert.equal((await call(e, 'spotify/' + CODE + '/play', { uri: URI, kind: 'tv' })).status, 400);
  // Spotify says Premium is needed: said plainly
  sp.playStatus = 403;
  assert.deepEqual((await call(e, 'spotify/' + CODE + '/play', { uri: URI, kind: 'phone' }, NOW + 60000)).body, { ok: false, why: 'premium' });
  sp.playStatus = 204;
});

test('play: Spotify was closed; the tap opened it, the hub plays once it shows up', async () => {
  const e = env();
  await at(NOW, () => connect(e));
  sp.devices = [pc];
  waits.length = 0;
  sp.calls.length = 0;
  const r = await call(e, 'spotify/' + CODE + '/play', { uri: URI, kind: 'phone' }, NOW + 60000);
  assert.deepEqual(r.body, { ok: false, why: 'no device', waiting: true });
  assert.equal(waits.length, 1);
  setTimeout(() => { sp.devices = [pc, phone]; }, 12); // the app comes up a moment later
  assert.deepEqual(await waits[0], { ok: true, device: 'iPhone' });
  assert.equal(sp.calls.filter((c) => c.method === 'PUT').length, 1);
  // never there: it gives up quietly
  sp.devices = [];
  const gone = await play(e, URI, 'phone', null, NOW + 60000);
  assert.deepEqual(await gone.later, { ok: false, why: 'no device' });
});

test('not set up or not connected: Play still opens Spotify, the hub just says so', async () => {
  const bare = env({ SPOTIFY_CLIENT_ID: undefined, SPOTIFY_CLIENT_SECRET: undefined, SPOTIFY_KEY: undefined });
  assert.deepEqual((await call(bare, 'spotify/' + CODE)).body, { configured: false, connected: false });
  assert.equal((await call(bare, 'spotify/' + CODE + '/play', { uri: URI, kind: 'phone' })).status, 503);
  assert.deepEqual((await call(env(), 'spotify/' + CODE + '/play', { uri: URI, kind: 'phone' })).body, { ok: false, why: 'not connected' });
  assert.equal((await call(env(), 'spotify/zzzzzzzz12345678')).status, 404);
});

test('playlists: his own, up to 100, with the count under either name; disconnect forgets', async () => {
  const e = env();
  await at(NOW, () => connect(e));
  sp.playlists = Array.from({ length: 120 }, (_, i) => ({
    id: ('p' + String(i).padStart(3, '0')).padEnd(22, 'x'), name: 'List ' + i,
    ...(i % 2 ? { items: { total: i } } : { tracks: { total: i } }),
  }));
  sp.playlists.push({ id: 'short', name: 'bad id' });
  const r = await call(e, 'spotify/' + CODE + '/playlists', undefined, NOW + 60000);
  assert.equal(r.body.playlists.length, 100);
  assert.deepEqual(r.body.playlists[3], { pid: 'p003'.padEnd(22, 'x'), title: 'List 3', count: 3, url: 'https://open.spotify.com/playlist/' + 'p003'.padEnd(22, 'x'), uri: 'spotify:playlist:' + 'p003'.padEnd(22, 'x') });
  assert.equal(r.body.playlists[4].count, 4);
  assert.deepEqual((await call(e, 'spotify/' + CODE + '/disconnect', {})).body, { connected: false });
  assert.equal((await call(e, 'spotify/' + CODE + '/playlists')).status, 409);
});

test('Day: plays on the phone through its own secret', async () => {
  const e = env();
  await at(NOW, () => connect(e));
  sp.devices = [pc, phone];
  const day = { Authorization: 'Bearer ' + DAY_SECRET };
  const r = await call(e, 'hub/spotify/day/play', { uri: URI, kind: 'computer' }, NOW + 60000, day);
  assert.deepEqual(r.body, { ok: true, device: 'iPhone' }); // Day is always the phone
  assert.equal((await call(e, 'hub/spotify/day/play', { uri: URI }, NOW, { Authorization: 'Bearer nope' })).status, 401);
  assert.equal((await call(e, 'hub/spotify/day/login', undefined, NOW, day)).status, 404);
});

test('play: Spotify is open on the PC but the phone played last; Play moves it there, then plays', async () => {
  const e = env();
  await at(NOW, () => connect(e));
  sp.devices = [{ ...pc, is_active: false }, { ...phone, is_active: true }];
  sp.needsMove = true;
  sp.moved = [];
  sp.calls.length = 0;
  const r = await call(e, 'spotify/' + CODE + '/play', { uri: URI, kind: 'computer' }, NOW + 60000);
  assert.deepEqual(r.body, { ok: true, device: 'PAUL-PC' });
  const puts = sp.calls.filter((c) => c.method === 'PUT').map((c) => c.u.replace('https://api.spotify.com/v1', ''));
  assert.deepEqual(puts, ['/me/player/play?device_id=dev-pc', '/me/player', '/me/player/play?device_id=dev-pc']);
  assert.deepEqual(JSON.parse(sp.calls.find((c) => c.u.endsWith('/me/player')).body), { device_ids: ['dev-pc'], play: false });
  sp.needsMove = false;
});
