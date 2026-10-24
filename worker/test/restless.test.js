// The Restless list: reading "restless: ..." lines, the sun, picking (what fits, by weight), the
// drift, the routes, Day, and the Sunday card. No network; D1 is node:sqlite running every
// migration. Every item here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { readLine, guessKind, bucket, sunTimes, isDark, fits, pickOne, drift, restlessWeek, DRIFT, WEIGHT_MIN, WEIGHT_MAX } from '../src/restless.js';
import { weekBlock } from '../src/week.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const DAY_SECRET = 'day-secret-for-tests';
const MIN = 60000;
const HOUR = 60 * MIN;
const NOON = Date.parse('2026-10-24T12:00:00Z'); // Saturday, 14:00 in The Hague
const NIGHT = Date.parse('2026-10-24T20:00:00Z'); // 22:00, dark
const DIR = new URL('../migrations/', import.meta.url);

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
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }; },
  };
}
const env = () => ({ HUB_DB: memD1(), HUB_QUEUE: { async sendBatch() {} }, HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_SECRET_DAY: DAY_SECRET });
const events = (e) => e.HUB_DB.db.prepare("SELECT type, source, payload FROM events WHERE type LIKE 'restless.%' ORDER BY at, rowid").all();

async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
}
const call = (e, path, body, ms = NOON, headers = {}) => at(ms, async () => {
  const r = await worker.fetch(new Request('https://hub.example/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e, { waitUntil() {} });
  return { status: r.status, body: await r.json() };
});
const rl = (e, sub, body, ms) => call(e, 'restless/' + CODE + (sub ? '/' + sub : ''), body, ms);
const day = (e, sub, body, ms) => call(e, 'hub/restless/day' + (sub ? '/' + sub : ''), body, ms, { Authorization: 'Bearer ' + DAY_SECRET });

test('readLine: time, place and money come out of the words; a kind is only guessed', () => {
  assert.deepEqual(readLine('restless: kayak on the Vliet 2h outside €'), { text: 'Kayak on the Vliet', kind: 'outside', mins: 120, place: 'outside', costs: 1 });
  assert.deepEqual(readLine('Run the park loop 45 min free'), { text: 'Run the park loop', kind: 'move', mins: 60, place: null, costs: 0 });
  assert.deepEqual(readLine('fix the bike light 30m inside'), { text: 'Fix the bike light', kind: 'build', mins: 30, place: 'inside', costs: null });
  assert.deepEqual(readLine('Climb at the hall 1,5 uur binnen €12'), { text: 'Climb at the hall', kind: 'move', mins: 120, place: 'inside', costs: 1 });
  assert.equal(readLine('Read a chapter of Dune').kind, 'learn');
  assert.equal(readLine('Call Lucho').kind, 'social');
  assert.equal(readLine('Something odd').kind, null); // waits in To sort
  assert.equal(readLine('Free climbing video').costs, null); // "free" in the middle is a word, not a price
  assert.equal(readLine('restless:   ').text, '');
  // Paul's starter list (2026-10-24): what the fixed words make of it; the rest waits in To sort
  const kinds = ['Pushups', 'Dance', 'Cook', 'Shower', 'go to gym', 'watch TV', 'Play Games'].map((t) => [readLine(t).text, readLine(t).kind]);
  assert.deepEqual(kinds, [['Pushups', 'move'], ['Dance', 'move'], ['Cook', 'home'], ['Shower', null], ['Go to gym', 'move'], ['Watch TV', null], ['Play Games', null]]);
  assert.equal(guessKind('Walk to the harbour'), 'outside');
});

test('bucket: any minutes into 15, 30, 60 or 2 h+', () => {
  assert.deepEqual([5, 15, 16, 30, 45, 60, 61, 300].map(bucket), [15, 15, 30, 30, 60, 60, 120, 120]);
  assert.equal(bucket(0), null);
  assert.equal(bucket(NaN), null);
});

test('the sun in The Hague: up around 08:30, down around 18:20 on 24 October; dark at 22:00', () => {
  const { rise, set } = sunTimes('2026-10-24');
  assert.ok(rise > Date.parse('2026-10-24T06:15:00Z') && rise < Date.parse('2026-10-24T06:50:00Z'), new Date(rise).toISOString());
  assert.ok(set > Date.parse('2026-10-24T16:00:00Z') && set < Date.parse('2026-10-24T16:35:00Z'), new Date(set).toISOString());
  const june = sunTimes('2026-06-21');
  assert.ok(june.set - june.rise > 16 * HOUR); // long summer days
  assert.equal(isDark(NOON), false);
  assert.equal(isDark(NIGHT), true);
  assert.equal(isDark(Date.parse('2026-10-24T05:00:00Z')), true);
});

test('fits: time, hidden today, outside in the dark, skipped this round', () => {
  const it = (id, mins, place, extra = {}) => ({ id, mins, place, weight: 1, hidden_until: null, deleted_at: null, ...extra });
  const items = [it('a', 30, 'inside'), it('b', 120, 'outside'), it('c', null, null), it('d', 15, 'outside', { hidden_until: '2026-10-25' }), it('e', 15, null, { deleted_at: 'x' })];
  const ids = (o) => fits(items, { today: '2026-10-24', ...o }).map((x) => x.id);
  assert.deepEqual(ids({ mins: 60 }), ['a', 'c']); // 2 h+ does not fit an hour; no time fits anything
  assert.deepEqual(ids({ mins: null }), ['a', 'b', 'c']);
  assert.deepEqual(ids({ mins: null, dark: true }), ['a', 'c']);
  assert.deepEqual(ids({ mins: null, skip: ['a'] }), ['b', 'c']);
  assert.deepEqual(fits(items, { today: '2026-10-25' }).map((x) => x.id), ['a', 'b', 'c', 'd']); // hidden for one day only
});

test('pickOne: by weight; drift: done up, another and not for me down, kept within bounds', () => {
  const items = [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }];
  assert.equal(pickOne(items, () => 0.2).id, 'a'); // 0.8 of 4
  assert.equal(pickOne(items, () => 0.3).id, 'b'); // 1.2 of 4
  assert.equal(pickOne([], () => 0.5), null);
  assert.equal(drift(1, 'done'), DRIFT.done);
  assert.equal(drift(1, 'another'), 0.8);
  assert.equal(drift(1, 'notforme'), 0.5);
  assert.equal(drift(WEIGHT_MAX, 'done'), WEIGHT_MAX);
  assert.equal(drift(WEIGHT_MIN, 'notforme'), WEIGHT_MIN);
  // a thousand picks follow the weights
  let b = 0;
  for (let i = 0; i < 1000; i++) if (pickOne(items).id === 'b') b++;
  assert.ok(b > 680 && b < 820, String(b));
});

test('the routes: add, list, pick what fits, Another, Not for me, Done, edit, delete; events carry ids only', async () => {
  const e = env();
  let r = await rl(e, 'add', { text: 'restless: kayak on the Vliet 2h outside €', source: 'todo' });
  assert.equal(r.status, 200);
  const kayak = r.body.item;
  assert.deepEqual({ ...kayak, id: 'x', createdAt: 'x' }, { id: 'x', text: 'Kayak on the Vliet', kind: 'outside', mins: 120, place: 'outside', costs: true, weight: 1, done: 0, skipped: 0, hiddenUntil: null, source: 'todo', createdAt: 'x' });
  const bike = (await rl(e, 'add', { text: 'Fix the bike light', kind: 'build', mins: 30, place: 'inside', costs: false, source: 'morning' })).body.item;
  const read = (await rl(e, 'add', { text: 'Something odd', source: 'day' })).body.item;
  assert.equal(read.kind, null);
  assert.equal((await rl(e, 'add', { text: '   ', source: 'todo' })).body.error, 'What is it? Give it a few words.');
  assert.equal((await rl(e, 'add', { text: 'x', source: 'mail' })).status, 400); // only mail itself is "mail"

  r = await rl(e);
  assert.equal(r.body.items.length, 3);
  assert.deepEqual(r.body.counts, { total: 3, done: 0, skipped: 0 });

  // An hour free: the kayak (2 h+) does not fit
  for (let i = 0; i < 20; i++) assert.notEqual((await rl(e, 'pick', { mins: 60, source: 'morning' })).body.item.id, kayak.id);
  // Another: skipped, weight down, not offered again this round
  r = await rl(e, 'pick', { mins: 60, skip: [], another: bike.id, source: 'morning' });
  assert.equal(r.body.item.id, read.id);
  assert.equal(r.body.fit, 1);
  r = await rl(e, 'pick', { mins: 60, skip: [bike.id, read.id], source: 'morning' });
  assert.deepEqual([r.body.item, r.body.fit], [null, 0]); // nothing left this round
  // In the dark the kayak never comes up, with all the time in the world
  for (let i = 0; i < 20; i++) assert.notEqual((await rl(e, 'pick', { mins: null, source: 'day' }, NIGHT)).body.item.id, kayak.id);
  assert.equal((await rl(e, 'pick', { mins: null, source: 'day' }, NIGHT)).body.dark, true);

  // Not for me: hidden until tomorrow, weight halved
  r = await rl(e, 'notforme', { id: read.id, source: 'morning' });
  assert.equal(r.body.item.hiddenUntil, '2026-10-25');
  assert.equal(r.body.item.weight, 0.5);
  for (let i = 0; i < 10; i++) assert.equal((await rl(e, 'pick', { mins: 60, source: 'morning' })).body.item.id, bike.id);
  // Done: up
  r = await rl(e, 'done', { id: bike.id, source: 'morning' });
  assert.deepEqual([r.body.item.done, r.body.item.weight], [1, 1]); // 0.8 after Another, then x1.25
  // Edit and delete
  r = await rl(e, 'item/' + read.id, { text: 'Read a chapter', kind: 'learn', mins: 30 });
  assert.deepEqual([r.body.item.text, r.body.item.kind, r.body.item.mins], ['Read a chapter', 'learn', 30]);
  assert.deepEqual((await rl(e, 'item/' + kayak.id + '/delete', {})).body, { ok: true });
  assert.equal((await rl(e)).body.items.length, 2);
  assert.equal((await rl(e, 'item/' + kayak.id + '/delete', {})).status, 404);

  const ev = events(e);
  assert.ok(ev.some((x) => x.type === 'restless.picked') && ev.some((x) => x.type === 'restless.done') && ev.some((x) => x.type === 'restless.skipped') && ev.some((x) => x.type === 'restless.added'));
  for (const x of ev) assert.doesNotMatch(x.payload, /Kayak|bike|Something|chapter/i);
  assert.deepEqual(JSON.parse(ev.find((x) => x.type === 'restless.skipped').payload), { item: bike.id, why: 'another' });
  assert.equal((await call(e, 'restless/zzzzzzzz12345678')).status, 404);
  assert.equal((await rl(e, 'pick', { mins: 'lots', source: 'morning' })).status, 400);
});

test('Day: pick, done, not for me and add through its own secret; no editing from Day', async () => {
  const e = env();
  const it = (await day(e, 'add', { text: 'Run the park loop 45 min outside' })).body.item;
  assert.equal(it.source, 'day');
  assert.equal((await day(e, 'pick', { mins: 60 })).body.item.id, it.id);
  assert.equal((await day(e, 'done', { id: it.id })).body.item.done, 1);
  assert.equal((await day(e, 'notforme', { id: it.id })).body.item.hiddenUntil, '2026-10-25');
  assert.equal((await day(e, 'item/' + it.id, { text: 'x' })).status, 404);
  assert.equal((await call(e, 'hub/restless/day/pick', { mins: 60 }, NOON, { Authorization: 'Bearer nope' })).status, 401);
  assert.equal(events(e).every((x) => x.source === 'day'), true);
});

test('Sunday: how often wired, what was done (by kind), how many skipped', async () => {
  const p = (o) => JSON.stringify(o);
  const rows = [
    { type: 'energy.set', payload: p({ level: 'wired' }), at: '2026-10-20T17:00:00Z' },
    { type: 'energy.set', payload: p({ level: 'drained' }), at: '2026-10-21T17:00:00Z' },
    { type: 'restless.done', payload: p({ item: 'i1', kind: 'move' }), at: '2026-10-20T17:30:00Z' },
    { type: 'restless.skipped', payload: p({ item: 'i2', why: 'another' }), at: '2026-10-20T17:31:00Z' },
    { type: 'restless.done', payload: p({ item: 'gone', kind: 'build' }), at: '2026-10-22T17:30:00Z' },
  ];
  const w = restlessWeek(rows, [{ id: 'i1', text: 'Run the park loop', kind: 'move' }]);
  assert.equal(w.wired, 1);
  assert.equal(w.skipped, 1);
  assert.deepEqual(w.done.map((d) => [d.text, d.kind]), [['Run the park loop', 'move'], ['Something since removed', 'build']]);
  assert.deepEqual(w.byKind, { move: 1, build: 1, outside: 0, social: 0, learn: 0, home: 0 });
  // and it reaches the Sunday block
  const e = env();
  const it = (await rl(e, 'add', { text: 'Run the park loop 45 min', source: 'todo' }, Date.parse('2026-10-20T10:00:00Z'))).body.item;
  await rl(e, 'done', { id: it.id, source: 'morning' }, Date.parse('2026-10-20T17:00:00Z'));
  const block = await weekBlock(e, Date.parse('2026-10-25T08:00:00Z'));
  assert.deepEqual(block.restless.done.map((d) => d.text), ['Run the park loop']);
  assert.equal(block.restless.byKind.move, 1);
});
