// Make a new one: his listening read and numbered, Claude's picks (swapped for a fake) settled by
// number or name, new ones found by search, the private playlist made and put first, the guards.
// Spotify is mocked: no network. Every id, token, song and artist here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { seal, SCOPES, PLAY_SCOPES } from '../src/spotify.js';
import { listening, matchTrack, settle, titleFor, cleanWords, _setPicker, SYSTEM } from '../src/mixtape.js';
import { putFirst } from '../src/soundtrack.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const NOW = Date.parse('2026-11-04T19:00:00Z');
const id = (s) => (s + 'x'.repeat(22)).slice(0, 22).replace(/[^A-Za-z0-9]/g, 'y');
const track = (n, artist, song) => ({ type: 'track', id: id('t' + n), name: song, artists: [{ name: artist }] });

function memKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');
const env = () => ({
  HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE, ANTHROPIC_API_KEY: 'made-up',
  SPOTIFY_CLIENT_ID: 'client-id-made-up', SPOTIFY_CLIENT_SECRET: 'client-secret-made-up', SPOTIFY_KEY: KEY,
});
async function login(e, scope = SCOPES) {
  await e.HUB_KV.put('spotify:login', await seal(e, { refresh: 'r', access: 'access-1', expiresAt: NOW + 3600000, scope }));
}

// His listening: 30 songs over the four reads, some twice.
const TOP = Array.from({ length: 20 }, (_, i) => track(i + 1, 'Artist ' + (i % 7), 'Song ' + (i + 1)));
const sp = { calls: [], made: [], items: [], createStatus: 201 };
const SEARCH = {
  'Real Band|Real Song': [{ id: id('new1'), name: 'Real Song - 2021 Remaster', artists: [{ name: 'Réal Band' }] }],
  'Other Act|Deep Cut': [{ id: id('wrong'), name: 'Deep Cut', artists: [{ name: 'Someone Else' }] }],
};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  sp.calls.push(init.method || 'GET', u.pathname);
  if (u.pathname === '/v1/me/top/tracks') return Response.json({ items: u.searchParams.get('time_range') === 'short_term' ? TOP.slice(0, 15) : TOP.slice(10) });
  if (u.pathname === '/v1/me/player/recently-played') return Response.json({ items: TOP.slice(5, 12).map((t) => ({ track: t })) });
  if (u.pathname === '/v1/me/tracks') return Response.json({ items: [{ item: track(90, 'Liked One', 'Fav') }, { track: { ...track(91, 'Pod', 'Ep'), type: 'episode' } }] });
  if (u.pathname === '/v1/search') {
    const q = u.searchParams.get('q');
    const m = q.match(/^track:(.*) artist:(.*)$/);
    return Response.json({ tracks: { items: m ? SEARCH[m[2] + '|' + m[1]] || [] : [] } });
  }
  if (u.pathname === '/v1/me/playlists' && init.method === 'POST') {
    sp.made.push(JSON.parse(init.body));
    return sp.createStatus === 201 ? Response.json({ id: id('newlist') }, { status: 201 }) : new Response(null, { status: sp.createStatus });
  }
  if (u.pathname === '/v1/playlists/' + id('newlist') + '/items' && init.method === 'POST') { sp.items.push(JSON.parse(init.body).uris); return Response.json({ snapshot_id: 's' }, { status: 201 }); }
  return new Response(null, { status: 404 });
};

async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
}
const ctx = { waitUntil() {} };
const call = (e, body) => at(NOW, async () => {
  const r = await worker.fetch(new Request('https://paul-hub.paul-o-a04.workers.dev/api/spotify/' + CODE + '/make', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), e, ctx);
  return { status: r.status, body: await r.json() };
});

test('listening: played most first, each song once, local files and podcasts left out', () => {
  const heard = listening([{ items: TOP.slice(0, 3) }, { items: [{ track: TOP[1] }, { item: track(50, 'A', 'B') }, { track: { ...TOP[2], id: 'bad' } }, { track: { ...TOP[0], id: id('loc'), is_local: true } }] }, null]);
  assert.deepEqual(heard.map((h) => h.song), ['Song 1', 'Song 2', 'Song 3', 'B']);
  assert.equal(heard[0].uri, 'spotify:track:' + id('t1'));
});

test('matchTrack and settle: by number, by name, the rest searched; a wrong artist is no match', () => {
  assert.equal(matchTrack(SEARCH['Real Band|Real Song'], 'Real Band', 'Real Song'), 'spotify:track:' + id('new1'));
  assert.equal(matchTrack(SEARCH['Other Act|Deep Cut'], 'Other Act', 'Deep Cut'), null);
  assert.equal(matchTrack([{ id: id('f'), name: 'Song (feat. X)', artists: [{ name: 'Main' }] }], 'Main feat. X', 'Song'), 'spotify:track:' + id('f'));
  const heard = listening([{ items: TOP.slice(0, 5) }]);
  const out = settle([
    { n: 2, artist: 'Artist 1', song: 'Song 2' },
    { n: 2, artist: 'Artist 1', song: 'Song 2' },        // twice: once
    { n: 0, artist: 'Artist 3', song: 'Song 4' },        // "new" but he plays it: by name
    { n: 99, artist: 'Real Band', song: 'Real Song' },   // no such number: searched
    { n: 0, artist: '', song: 'Nameless' },              // nothing to search
  ], heard);
  assert.deepEqual(out, [{ uri: heard[1].uri }, { uri: heard[3].uri }, { artist: 'Real Band', song: 'Real Song' }]);
});

test('titleFor and cleanWords: level, words cut at a word, the Dutch date', () => {
  assert.equal(titleFor('drained', 'rainy Sunday', NOW), 'Drained · rainy Sunday · 4 Nov');
  assert.equal(titleFor('wired', '', Date.parse('2026-12-31T23:30:00Z')), 'Wired · 1 Jan');
  const t = titleFor('normal', 'slow coffee and a long walk by the sea', NOW);
  assert.equal(t, 'Normal · slow coffee and a long walk… · 4 Nov');
  assert.ok(t.length <= 60);
  assert.equal(cleanWords('  a\n\tb  '), 'a b');
  assert.equal(cleanWords(5), '');
  assert.equal(cleanWords('x'.repeat(200)).length, 80);
});

test('putFirst: the new one plays first; a full level lets the last made one go, else the last', () => {
  const L = (...t) => t.map((x) => ({ id: x, title: x, pid: x, ...(x.startsWith('m') ? { made: true } : {}) }));
  const base = { wired: L('a', 'm1', 'b'), normal: [], drained: L('a') };
  let r = putFirst(base, 'wired', { id: 'n', title: 'n', made: true });
  assert.deepEqual(r.lists.wired.map((e) => e.id), ['n', 'a', 'b']);
  assert.equal(r.dropped.id, 'm1');
  r = putFirst({ ...base, wired: L('a', 'b', 'c') }, 'wired', { id: 'n', made: true });
  assert.deepEqual(r.lists.wired.map((e) => e.id), ['n', 'a', 'b']);
  r = putFirst(base, 'drained', { id: 'n', made: true });
  assert.deepEqual(r.lists.drained.map((e) => e.id), ['n', 'a']);
  assert.equal(r.dropped, null);
});

test('the prompt: the counts and the rules Paul saw', () => {
  assert.match(SYSTEM, /25 songs/);
  assert.match(SYSTEM, /About 17 from his listening/);
  assert.match(SYSTEM, /About 8 new to him/);
  assert.match(SYSTEM, /really exist/);
});

test('make: Claude picks, the new ones are found, a private playlist is made and plays first', async () => {
  const e = env();
  await login(e);
  let asked = null;
  _setPicker(async (_env, a) => {
    asked = a;
    const mine = a.heard.slice(0, 12).map((h, i) => ({ n: i + 1, artist: h.artist, song: h.song }));
    return { songs: [{ n: 0, artist: 'Real Band', song: 'Real Song' }, ...mine, { n: 0, artist: 'Other Act', song: 'Deep Cut' }], usage: { input: 2000, output: 900, cacheRead: 0, cacheWrite: 400 } };
  });
  const r = await call(e, { level: 'drained', words: ' rainy  Sunday ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(asked.level, 'drained');
  assert.equal(asked.words, 'rainy Sunday');
  assert.equal(asked.heard.length, 21); // 20 top + the liked one; the podcast left out
  assert.equal(r.body.title, 'Drained · rainy Sunday · 4 Nov');
  assert.equal(r.body.songs, 13);  // 12 of his + the one search found; Deep Cut was by someone else
  assert.equal(r.body.fresh, 1);
  assert.deepEqual(sp.made.at(-1), { name: 'Drained · rainy Sunday · 4 Nov', public: false, description: 'Made by paul-hub for Drained: rainy Sunday.' });
  assert.equal(sp.items.at(-1)[0], 'spotify:track:' + id('new1'));
  assert.equal(sp.items.at(-1).length, 13);
  assert.equal(r.body.lists.drained[0].title, 'Drained · rainy Sunday · 4 Nov');
  assert.equal(r.body.lists.drained[0].made, true);
  assert.equal(r.body.uri, 'spotify:playlist:' + id('newlist'));
  assert.equal(e.HUB_KV.m.get('spotify:making'), undefined); // the lock is let go
  assert.deepEqual(JSON.parse(e.HUB_KV.m.get('mixtape:usage:2026-11')), { calls: 1, input: 2000, output: 900, cacheRead: 0, cacheWrite: 400 });
  // the energy answers see it: Play opens the new one
  const lists = JSON.parse(e.HUB_KV.m.get('soundtrack:lists'));
  assert.equal(lists.drained[0].pid, id('newlist'));
});

test('make: guards — level, an old login, one at a time, too few found, Claude down, Spotify says no', async () => {
  const e = env();
  _setPicker(async (_env, a) => ({ songs: a.heard.slice(0, 15).map((h, i) => ({ n: i + 1, artist: h.artist, song: h.song })), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
  assert.equal((await call(e, { level: 'sleepy' })).status, 400);
  let r = await call(e, { level: 'wired' });
  assert.equal(r.status, 409);
  assert.equal(r.body.reconnect, true);
  await login(e, PLAY_SCOPES); // connected before 2026-11-04
  r = await call(e, { level: 'wired' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Connect Spotify again/);
  await login(e);
  await e.HUB_KV.put('spotify:making', '1');
  assert.equal((await call(e, { level: 'wired' })).status, 429);
  await e.HUB_KV.delete('spotify:making');
  _setPicker(async () => ({ songs: [{ n: 1, artist: 'Artist 0', song: 'Song 1' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
  r = await call(e, { level: 'wired' });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /Only 1 songs/);
  _setPicker(async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); });
  assert.equal((await call(e, { level: 'wired' })).status, 502);
  _setPicker(async (_env, a) => ({ songs: a.heard.slice(0, 15).map((h, i) => ({ n: i + 1, artist: h.artist, song: h.song })), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
  sp.createStatus = 403;
  r = await call(e, { level: 'wired' });
  assert.equal(r.status, 502);
  assert.equal(r.body.reconnect, true);
  sp.createStatus = 201;
  assert.equal(e.HUB_KV.m.get('soundtrack:lists'), undefined); // nothing half-made in the lists
  assert.equal(e.HUB_KV.m.get('spotify:making'), undefined);
  _setPicker(null);
});
