// The Energy soundtrack: Spotify links, the lists, `play` on the energy answers and the offer on
// the Dread meter's (energy.set and dread.started handled). Spotify is mocked: no network. D1 is
// node:sqlite running every migration, the list is the real Durable Object in memory. Every
// playlist and task here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { readLink, cleanLists, playFrom, offerStands, MAX_PER_LEVEL } from '../src/soundtrack.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const DAY_SECRET = 'day-secret-for-tests';
const MIN = 60000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-24T09:00:00Z');
const DIR = new URL('../migrations/', import.meta.url);

const P1 = '37i9dQZF1DX4sWSpwq3LiO'; // 22 characters, like Spotify's
const P2 = '3cEYpjA9oz9GiPac4AsH4n';
const P3 = '1h0CEZCm6IbFTbxThn6Xcs';
const P4 = '5ABHKGoOzxkaa28ttQV9sE';
const TITLES = { [P1]: 'Low tide', [P2]: 'Rain on the window', [P3]: 'Desk hours', [P4]: 'Full send' };

function memD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, DIR), 'utf8'));
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
function memKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }; },
  };
}
const env = (over = {}) => ({
  HUB_DB: memD1(), HUB_QUEUE: { async sendBatch() {} }, HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE,
  HUB_SECRET_DAY: DAY_SECRET, ...over,
});
const stub = (e) => e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
const task = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: NOW - 3 * HOUR, pos: NOW - 10 * HOUR, ...extra });
async function seed(e, items) {
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: items.map((item) => ({ op: 'upsert', item })) }) });
}
const events = (e) => e.HUB_DB.db.prepare("SELECT type, source, payload FROM events WHERE type LIKE 'soundtrack.%' ORDER BY at, rowid").all();

// Spotify, mocked: oEmbed answers with the made-up title, spotify.link redirects. `calls` counts.
let spotifyUp = true;
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.startsWith('https://open.spotify.com/oembed?url=')) {
    const pid = decodeURIComponent(u.split('url=')[1]).split('/').pop();
    if (!spotifyUp || !TITLES[pid]) return new Response('no', { status: 404 });
    return new Response(JSON.stringify({ title: TITLES[pid], type: 'rich' }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (u === 'https://spotify.link/abcDEF123') {
    const r = new Response('<html><a href="https://open.spotify.com/playlist/' + P2 + '?si=x">open</a></html>');
    Object.defineProperty(r, 'url', { value: 'https://spotify.link/abcDEF123' });
    return r;
  }
  if (u === 'https://spotify.link/song9999') {
    const r = new Response('');
    Object.defineProperty(r, 'url', { value: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=y' });
    return r;
  }
  return realFetch(url);
};

async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
}
const call = (e, path, body, ms = NOW, headers = {}) => at(ms, async () => {
  const r = await worker.fetch(new Request('https://hub.example/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
  return { status: r.status, body: await r.json() };
});
const sound = (e, sub, body, ms) => call(e, 'soundtrack/' + CODE + (sub ? '/' + sub : ''), body, ms);
const energy = (e, sub, body, ms) => call(e, 'energy/' + CODE + (sub ? '/' + sub : ''), body, ms);
const dread = (e, sub, body, ms) => call(e, 'dread/' + CODE + (sub ? '/' + sub : ''), body, ms);
const day = (e, path, body, ms) => call(e, 'hub/' + path, body, ms, { Authorization: 'Bearer ' + DAY_SECRET });
const link = (pid, q = '?si=a1b2c3') => 'https://open.spotify.com/playlist/' + pid + q;

const T1 = 'task0000lucho01';
const T2 = 'task0000lamp002';

test('readLink: playlists by link or app link; songs, albums and other sites say what they are', () => {
  assert.deepEqual(readLink(link(P1)), { pid: P1 });
  assert.deepEqual(readLink('  https://open.spotify.com/intl-nl/playlist/' + P1 + '  '), { pid: P1 });
  assert.deepEqual(readLink('https://open.spotify.com/user/someone/playlist/' + P1), { pid: P1 });
  assert.deepEqual(readLink('spotify:playlist:' + P1), { pid: P1 });
  assert.equal(readLink('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC').error, 'That is a song, not a playlist.');
  assert.equal(readLink('https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC').error, 'That is an album, not a playlist.');
  assert.equal(readLink('spotify:album:4uLU6hMCjMI75M1A2tKUQC').error, 'That is an album, not a playlist.');
  assert.equal(readLink('https://music.apple.com/nl/playlist/x/pl.123').error, 'Only a Spotify playlist link counts.');
  assert.match(readLink('low tide').error, /Paste a Spotify playlist link/);
  assert.match(readLink('javascript:alert(1)').error, /Paste a Spotify playlist link/);
  assert.equal(readLink('https://open.spotify.com/playlist/short').error, 'That is not a playlist link.');
  assert.deepEqual(readLink('https://spotify.link/abcDEF123?x=1'), { short: 'https://spotify.link/abcDEF123' });
});

test('cleanLists: at most 3 a level, anything malformed dropped; playFrom is the first', () => {
  const ok = (id, pid, title) => ({ id, pid, title });
  const lists = cleanLists({
    drained: [ok('aaaaaaaaaa', P1, 'Low tide'), ok('bbbbbbbbbb', P2, 'Rain'), ok('cccccccccc', P3, 'Desk'), ok('dddddddddd', P4, 'Full')],
    normal: [ok('BAD', P1, 'x'), ok('eeeeeeeeee', 'nope', 'x'), ok('ffffffffff', P3, '   ')],
    wired: 'not a list',
  });
  assert.equal(lists.drained.length, MAX_PER_LEVEL);
  assert.deepEqual(lists.normal, []);
  assert.deepEqual(lists.wired, []);
  assert.deepEqual(playFrom(lists, 'drained'), { level: 'drained', title: 'Low tide', url: 'https://open.spotify.com/playlist/' + P1, uri: 'spotify:playlist:' + P1 });
  assert.equal(playFrom(lists, 'normal'), null);
  assert.equal(playFrom(lists, null), null);
});

test('offerStands: Play since the level was set ends it; Not now ends it for that timer only', () => {
  const s1 = '2026-10-24T09:00:00.000Z';
  assert.equal(offerStands([], s1), true);
  assert.equal(offerStands([{ type: 'soundtrack.declined', payload: JSON.stringify({ startedAt: '2026-10-24T08:00:00.000Z' }) }], s1), true);
  assert.equal(offerStands([{ type: 'soundtrack.declined', payload: JSON.stringify({ startedAt: s1 }) }], s1), false);
  assert.equal(offerStands([{ type: 'soundtrack.played', payload: JSON.stringify({ level: 'drained', startedAt: null }) }], s1), false);
});

test('add, peek and remove: the name is read from Spotify, 3 a level, no doubles, in plain words', async () => {
  const e = env();
  calls.length = 0;
  let r = await sound(e, 'peek', { url: link(P1) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { pid: P1, title: 'Low tide', url: 'https://open.spotify.com/playlist/' + P1, uri: 'spotify:playlist:' + P1 });
  r = await sound(e);
  assert.deepEqual(r.body, { lists: { wired: [], normal: [], drained: [] }, max: 3 }); // peek added nothing

  r = await sound(e, 'add', { level: 'drained', url: link(P1) });
  assert.equal(r.status, 200);
  assert.equal(r.body.added.title, 'Low tide');
  assert.match(r.body.added.id, /^[a-z0-9]{10}$/);
  r = await sound(e, 'add', { level: 'drained', url: 'https://spotify.link/abcDEF123', title: '  My   rain ' });
  assert.equal(r.body.added.title, 'My rain'); // his own name wins over Spotify's
  assert.equal(r.body.added.uri, 'spotify:playlist:' + P2);
  r = await sound(e, 'add', { level: 'drained', url: link(P1, '') });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'That one is in Drained already.');
  await sound(e, 'add', { level: 'drained', url: link(P3) });
  r = await sound(e, 'add', { level: 'drained', url: link(P4) });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'Drained has 3 already. Remove one first.');
  r = await sound(e, 'add', { level: 'normal', url: 'https://spotify.link/song9999' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'That is a song, not a playlist.');

  spotifyUp = false;
  r = await sound(e, 'add', { level: 'wired', url: link(P4) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Give it a name.');
  r = await sound(e, 'add', { level: 'wired', url: link(P4), title: 'Full send' });
  assert.equal(r.status, 200);
  spotifyUp = true;

  r = await sound(e);
  assert.deepEqual(r.body.lists.drained.map((x) => x.title), ['Low tide', 'My rain', 'Desk hours']);
  assert.deepEqual(r.body.lists.wired.map((x) => x.title), ['Full send']);
  const first = r.body.lists.drained[0].id;
  r = await sound(e, 'remove', { level: 'drained', id: first });
  assert.deepEqual(r.body.lists.drained.map((x) => x.title), ['My rain', 'Desk hours']);
  r = await sound(e, 'remove', { level: 'drained', id: first });
  assert.equal(r.status, 404);
  // only Spotify was asked, and only for names and the short link
  assert.ok(calls.every((u) => u.startsWith('https://open.spotify.com/oembed?url=') || u.startsWith('https://spotify.link/')), calls.join('\n'));
  // the code guards it
  assert.equal((await call(e, 'soundtrack/zzzzzzzz12345678')).status, 404);
  assert.equal((await sound(e, 'add', { level: 'sleepy', url: link(P1) })).status, 400);
});

test('energy.set: every energy answer carries play for the level, none without one', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today', { energy: 'drained' })]);
  let r = await energy(e);
  assert.equal(r.body.level, null);
  assert.equal(r.body.play, null);
  await sound(e, 'add', { level: 'drained', url: link(P1) });
  r = await energy(e, '', { level: 'drained', source: 'todo' });
  assert.deepEqual(r.body.play, { level: 'drained', title: 'Low tide', url: 'https://open.spotify.com/playlist/' + P1, uri: 'spotify:playlist:' + P1 });
  assert.equal(r.body.pick.task.id, T1);
  assert.equal((await energy(e, undefined, undefined, NOW + MIN)).body.play.title, 'Low tide');
  r = await call(e, 'energy/' + CODE + '?pick=1', undefined, NOW + MIN);
  assert.equal(r.body.play.title, 'Low tide');
  r = await energy(e, 'pick', { mode: 'next', source: 'morning' }, NOW + 2 * MIN);
  assert.equal(r.body.play.title, 'Low tide');
  r = await day(e, 'energy/day', undefined, NOW + 2 * MIN);
  assert.equal(r.body.play.title, 'Low tide');
  // a level with no playlist, a cleared level, a lapsed level: no Play
  r = await energy(e, '', { level: 'wired', source: 'todo' }, NOW + 3 * MIN);
  assert.equal(r.body.play, null);
  await energy(e, '', { level: 'drained', source: 'todo' }, NOW + 4 * MIN);
  r = await energy(e, '', { level: null, source: 'todo' }, NOW + 5 * MIN);
  assert.equal(r.body.play, null);
  await energy(e, '', { level: 'drained', source: 'todo' }, NOW + 6 * MIN);
  assert.equal((await energy(e, undefined, undefined, NOW + 6 * MIN + 4 * HOUR)).body.play, null);
});

test('dread.started: Music for this? on Start, gone after Not now or Play, back for the next timer', async () => {
  const e = env();
  await seed(e, [task(T1, 'Ticket for Lucho November', 'today', { energy: 'drained' }), task(T2, 'Return seasonal lamp', 'today', { energy: 'drained' })]);
  await sound(e, 'add', { level: 'drained', url: link(P1) });

  // no level: nothing to offer
  let r = await dread(e, 'start', { task: T1, source: 'todo' });
  assert.equal(r.body.offer, null);
  await dread(e, 'stop', { source: 'todo' }, NOW + MIN);

  await energy(e, '', { level: 'drained', source: 'morning' }, NOW + 2 * MIN);
  r = await dread(e, 'start', { task: T1, source: 'todo' }, NOW + 3 * MIN);
  const s1 = r.body.running.startedAt;
  assert.deepEqual(r.body.offer, { level: 'drained', title: 'Low tide', url: 'https://open.spotify.com/playlist/' + P1, uri: 'spotify:playlist:' + P1, startedAt: s1 });
  assert.equal((await dread(e, undefined, undefined, NOW + 4 * MIN)).body.offer.startedAt, s1);
  assert.equal((await day(e, 'dread/day', undefined, NOW + 4 * MIN)).body.offer.title, 'Low tide');
  r = await dread(e, 'rate', { task: T1, dread: 4, source: 'todo' }, NOW + 4 * MIN);
  assert.equal(r.body.offer.title, 'Low tide');

  // Not now, from Day: gone everywhere for this timer
  r = await day(e, 'soundtrack/day/notnow', { startedAt: s1 }, NOW + 5 * MIN);
  assert.deepEqual(r.body, { ok: true });
  assert.equal((await dread(e, undefined, undefined, NOW + 6 * MIN)).body.offer, null);

  // the next timer asks again
  r = await dread(e, 'start', { task: T2, source: 'morning' }, NOW + 7 * MIN);
  const s2 = r.body.running.startedAt;
  assert.equal(r.body.offer.startedAt, s2);
  assert.equal(r.body.stopped.task, T1);

  // Play from the offer: gone
  r = await sound(e, 'played', { level: 'drained', startedAt: s2, from: 'offer', source: 'todo' }, NOW + 8 * MIN);
  assert.deepEqual(r.body, { ok: true });
  assert.equal((await dread(e, undefined, undefined, NOW + 9 * MIN)).body.offer, null);
  await dread(e, 'stop', { done: true, source: 'todo' }, NOW + 10 * MIN);

  // the music is on already (Play since the level was set): no offer on the next start either
  r = await dread(e, 'start', { task: T1, source: 'todo' }, NOW + 11 * MIN);
  assert.equal(r.body.offer, null);
  await dread(e, 'stop', { source: 'todo' }, NOW + 12 * MIN);

  // a new level: the offer comes back
  await energy(e, '', { level: 'drained', source: 'todo' }, NOW + 13 * MIN);
  r = await dread(e, 'start', { task: T1, source: 'todo' }, NOW + 14 * MIN);
  assert.equal(r.body.offer.title, 'Low tide');

  // the events carry levels and times only, never a title or a link
  const ev = events(e);
  assert.deepEqual(ev.map((x) => [x.type, x.source]), [['soundtrack.declined', 'day'], ['soundtrack.played', 'todo']]);
  for (const x of ev) assert.doesNotMatch(x.payload, /Low tide|spotify|http/i);
  assert.deepEqual(JSON.parse(ev[1].payload), { level: 'drained', startedAt: s2, from: 'offer' });
});

test('Play from the dial is logged; bad input is refused; Day plays but never edits', async () => {
  const e = env();
  let r = await sound(e, 'played', { level: 'normal', source: 'morning' });
  assert.deepEqual(r.body, { ok: true });
  assert.deepEqual(JSON.parse(events(e)[0].payload), { level: 'normal', startedAt: null, from: 'dial' });
  assert.equal((await sound(e, 'played', { level: 'loud', source: 'todo' })).status, 400);
  assert.equal((await sound(e, 'played', { level: 'normal' })).status, 400); // no source
  assert.equal((await sound(e, 'notnow', { startedAt: 'yesterday', source: 'todo' })).status, 400);
  assert.equal((await day(e, 'soundtrack/day/played', { level: 'wired' })).status, 200);
  assert.equal(events(e)[1].source, 'day');
  assert.equal((await day(e, 'soundtrack/day/add', { level: 'wired', url: link(P1) })).status, 404);
  assert.equal((await day(e, 'soundtrack/day')).status, 404);
  assert.equal((await call(e, 'hub/soundtrack/day/played', { level: 'wired' }, NOW, { Authorization: 'Bearer nope' })).status, 401);
});
