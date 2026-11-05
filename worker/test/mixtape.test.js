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
const sp = { calls: [], made: [], items: [], createStatus: 201, searches: 0 };
const SEARCH = {
  'Real Band|Real Song': [{ id: id('new1'), name: 'Real Song - 2021 Remaster', artists: [{ name: 'Réal Band' }] }],
  'Other Act|Deep Cut': [{ id: id('wrong'), name: 'Deep Cut', artists: [{ name: 'Someone Else' }] }],
  'Artist 3|Other Name': [TOP[3]], // search lands on a song he plays: left out
};
// n new songs by n/2 made-up artists (two each), all found by search
const news = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ artist: 'New Artist ' + Math.floor((from + i) / 2), song: 'Tune ' + (from + i) }));
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  sp.calls.push(init.method || 'GET', u.pathname);
  if (u.pathname === '/v1/me/top/tracks') return Response.json({ items: u.searchParams.get('time_range') === 'short_term' ? TOP.slice(0, 15) : TOP.slice(10) });
  if (u.pathname === '/v1/me/player/recently-played') return Response.json({ items: TOP.slice(5, 12).map((t) => ({ track: t })) });
  if (u.pathname === '/v1/me/tracks') return Response.json({ items: [{ item: track(90, 'Liked One', 'Fav') }, { track: { ...track(91, 'Pod', 'Ep'), type: 'episode' } }] });
  if (u.pathname === '/v1/search') {
    const q = u.searchParams.get('q');
    sp.searches++;
    const m = q.match(/^track:(.*) artist:(.*)$/);
    if (!m) return Response.json({ tracks: { items: q === 'Loose Act Loose Song' ? [{ id: id('loose'), name: 'Loose Song', artists: [{ name: 'Loose Act' }] }] : [] } });
    if (/^New Artist/.test(m[2])) return Response.json({ tracks: { items: [{ id: id('n' + m[1]), name: m[1], artists: [{ name: m[2] }] }] } });
    return Response.json({ tracks: { items: SEARCH[m[2] + '|' + m[1]] || [] } });
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

test('matchTrack and settle: only new songs, each once, two per artist; a wrong artist is no match', () => {
  assert.equal(matchTrack(SEARCH['Real Band|Real Song'], 'Real Band', 'Real Song'), 'spotify:track:' + id('new1'));
  assert.equal(matchTrack(SEARCH['Other Act|Deep Cut'], 'Other Act', 'Deep Cut'), null);
  assert.equal(matchTrack([{ id: id('f'), name: 'Song (feat. X)', artists: [{ name: 'Main' }] }], 'Main feat. X', 'Song'), 'spotify:track:' + id('f'));
  const heard = listening([{ items: TOP.slice(0, 5) }]);
  const out = settle([
    { artist: 'Artist 1', song: 'Song 2' },              // he plays it: out
    { artist: 'artist 3', song: 'Song 4 (Live)' },       // he plays it, written a bit differently: out
    { artist: 'Artist 1', song: 'A New One' },           // a new song by an artist he plays: in
    { artist: 'Real Band', song: 'Real Song' },
    { artist: 'Real Band', song: 'Real Song' },          // twice: once
    { artist: 'Real Band', song: 'Second' },
    { artist: 'Real Band feat. Guest', song: 'Third' },  // a third by the same artist: out
    { artist: '', song: 'Nameless' },                    // nothing to search
  ], heard);
  assert.deepEqual(out, [
    { artist: 'Artist 1', song: 'A New One' }, { artist: 'Real Band', song: 'Real Song' }, { artist: 'Real Band', song: 'Second' },
  ]);
  assert.equal(settle(news(40), heard).length, 20); // a few more than 15 are searched, no more
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

test('the prompt: all new, his recent listening read for taste', () => {
  assert.match(SYSTEM, /Pick 20 songs that are NEW to him/);
  assert.match(SYSTEM, /most recent first/);
  assert.match(SYSTEM, /None of the songs in his listening/);
  assert.match(SYSTEM, /really exist/);
  assert.doesNotMatch(SYSTEM, /number \(n\)/);
});

test('make: Claude picks 15 new ones, none he plays, a private playlist is made and plays first', async () => {
  const e = env();
  await login(e);
  let asked = null;
  _setPicker(async (_env, a) => {
    asked = a;
    const songs = [
      { artist: 'Real Band', song: 'Real Song' },
      { artist: a.heard[0].artist, song: a.heard[0].song },  // one he plays: out before search
      { artist: 'Other Act', song: 'Deep Cut' },              // search finds someone else: out
      { artist: 'Artist 3', song: 'Other Name' },            // search lands on one he plays: out
      { artist: 'Loose Act', song: 'Loose Song' },           // the 15th, found by the looser second search
      ...news(13),
    ];
    return { songs, usage: { input: 2000, output: 900, cacheRead: 0, cacheWrite: 400 } };
  });
  sp.searches = 0;
  const r = await call(e, { level: 'drained', words: ' rainy  Sunday ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(asked.level, 'drained');
  assert.equal(asked.words, 'rainy Sunday');
  assert.equal(asked.heard.length, 21); // 20 top + the liked one; the podcast left out
  assert.equal(asked.heard[0].song, 'Song 6'); // recent plays come first
  assert.equal(r.body.title, 'Drained · rainy Sunday · 4 Nov');
  assert.equal(r.body.songs, 15);
  assert.equal(r.body.fresh, 15);
  assert.ok(sp.searches <= 30, 'searches stay inside the Worker limit: ' + sp.searches);
  assert.deepEqual(sp.made.at(-1), { name: 'Drained · rainy Sunday · 4 Nov', public: false, description: 'Made by paul-hub for Drained: rainy Sunday.' });
  const uris = sp.items.at(-1);
  assert.equal(uris.length, 15);
  assert.equal(uris[0], 'spotify:track:' + id('new1'));
  assert.ok(uris.includes('spotify:track:' + id('loose')));
  const his = new Set(asked.heard.map((h) => h.uri));
  assert.ok(uris.every((u) => !his.has(u)), 'nothing he already plays');
  assert.equal(new Set(uris).size, 15);
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
  const fine = async () => ({ songs: news(20), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
  _setPicker(fine);
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
  // only songs he already plays, plus a few new: too few
  _setPicker(async (_env, a) => ({ songs: [...a.heard.slice(0, 15).map((h) => ({ artist: h.artist, song: h.song })), ...news(3)], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
  r = await call(e, { level: 'wired' });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /Only 3 songs/);
  _setPicker(async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); });
  assert.equal((await call(e, { level: 'wired' })).status, 502);
  _setPicker(fine);
  sp.createStatus = 403;
  r = await call(e, { level: 'wired' });
  assert.equal(r.status, 502);
  assert.equal(r.body.reconnect, true);
  sp.createStatus = 201;
  assert.equal(e.HUB_KV.m.get('soundtrack:lists'), undefined); // nothing half-made in the lists
  assert.equal(e.HUB_KV.m.get('spotify:making'), undefined);
  _setPicker(null);
});
