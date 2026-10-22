// The constellation (Phase 7): who reacts, the window, lines both ways, the Lately index read once,
// signs of life and quiet stars, replay order, and nothing but types, sources and times in the answer.
// D1 is node:sqlite running every migration, the list is the real Durable Object in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { reactorsOf, buildSky, skyFor, markLife, label, STARS, REACTS, LABELS, FEED_ONLY } from '../src/sky.js';
import { CAL_KEY } from '../src/morning.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-22T13:00:00Z');
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
  const kv = {
    m, gets: [], puts: [],
    async get(k, type) { kv.gets.push(k); const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { kv.puts.push(k); m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }; },
  };
  return kv;
}
const env = () => ({ HUB_DB: memD1(), HUB_QUEUE: { async sendBatch() {} }, HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE });
const iso = (ms) => new Date(ms).toISOString();
let n = 0;
function ev(e, source, type, at, { payload = {}, summary = 'x', id } = {}) {
  const eid = id || type + '-' + (++n) + '-0000';
  e.HUB_DB.db.prepare('INSERT INTO events (id, source, type, summary, payload, hops, at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run(eid, source, type, summary, JSON.stringify(payload), iso(at));
  return eid;
}
const handled = (e, target, eventId, at) => e.HUB_DB.db.prepare('INSERT INTO handled (target, event_id, at) VALUES (?, ?, ?)').run(target, eventId, iso(at));
function line(e, source, kind, at, text = 'a line') {
  e.HUB_KV.m.set('event:' + String(at).padStart(14, '0') + ':' + (++n).toString(36).padStart(6, '0'), JSON.stringify({ id: 'x', source, kind, who: '', text, at: iso(at) }));
}
async function get(e, path = '/api/sky/' + CODE, at = NOW) {
  const real = Date.now;
  Date.now = () => at;
  try {
    const r = await worker.fetch(new Request('https://hub.test' + path), e);
    return { status: r.status, body: await r.json() };
  } finally { Date.now = real; }
}
const star = (sky, id) => sky.stars.find((s) => s.id === id);

test('who reacts: the apps that show it, the rule targets, never the sender', () => {
  assert.deepEqual(reactorsOf({ source: 'todo', type: 'energy.set' }), ['morning', 'day']);
  assert.deepEqual(reactorsOf({ source: 'day', type: 'energy.skipped' }), ['todo', 'morning']);
  assert.deepEqual(reactorsOf({ source: 'hub', type: 'waiting.chase_due' }), ['todo', 'morning', 'day']);
  assert.deepEqual(reactorsOf({ source: 'day', type: 'dinner.away', targets: ['kitchen'] }), ['morning', 'kitchen']);
  assert.deepEqual(reactorsOf({ source: 'defence-digest', type: 'vacancy.found', targets: ['todo'] }), ['todo']);
  assert.deepEqual(reactorsOf({ source: 'mail', type: 'email.received', kind: 'triage', targets: ['mail'] }), ['day']);
  assert.deepEqual(reactorsOf({ source: 'mail', type: 'email.received', kind: 'todo', targets: ['mail'] }), ['hub']);
  assert.deepEqual(reactorsOf({ source: 'day', type: 'email.sorted', targets: ['mail'] }), ['hub']);
  assert.deepEqual(reactorsOf({ source: 'hub', type: 'task.created' }), ['todo']);
  assert.deepEqual(reactorsOf({ source: 'hub', type: 'task.fate_due' }), ['todo', 'morning']);
  assert.deepEqual(reactorsOf({ source: 'arsenal-watch', type: 'feed.drop' }), ['morning']);
  // Stored only in the hub: the pulse goes to the hub. The hub's own: nowhere.
  assert.deepEqual(reactorsOf({ source: 'morning', type: 'oracle.answered' }), ['hub']);
  assert.deepEqual(reactorsOf({ source: 'todo', type: 'something.new' }), ['hub']);
  assert.deepEqual(reactorsOf({ source: 'hub', type: 'something.new' }), []);
});

test('every type the hub emits has a plain label', () => {
  for (const t of Object.keys(REACTS)) assert.ok(LABELS[t], t);
  assert.equal(label('feed.drop'), 'Ticket drop');
  assert.equal(label('feed.other'), 'Lately line');
  assert.equal(label('energy.set'), 'Energy set');
  assert.equal(label('thing.went_off'), 'Thing went off');
});

test('the route: the code, GET only, ten stars in a fixed order, the numbers Paul chose', async () => {
  const e = env();
  assert.equal((await get(e, '/api/sky/short')).status, 400);
  assert.equal((await get(e, '/api/sky/zzzzzzzzzzzzzzzz')).status, 404);
  assert.equal((await get(e, '/api/sky/' + CODE + '/more')).status, 404);
  const post = await worker.fetch(new Request('https://hub.test/api/sky/' + CODE, { method: 'POST', body: '{}' }), e);
  assert.equal(post.status, 405);
  const { status, body } = await get(e);
  assert.equal(status, 200);
  assert.deepEqual(body.stars.map((s) => s.id), ['todo', 'morning', 'day', 'kitchen', 'mail', 'defence-digest', 'lift', 'pc', 'arsenal-watch', 'hub']);
  assert.deepEqual(body.stars.map((s) => s.name), ['To-do', 'Morning', 'Day', 'Kitchen', 'Email in', 'Defence digest', 'Lift', 'PC', 'Arsenal watch', 'Hub']);
  assert.equal(body.poll, 30);
  assert.deepEqual(body.replay, { day: 60, week: 60 });
  assert.equal(body.now, iso(NOW));
  assert.equal(body.from, iso(NOW - 7 * DAY));
  assert.deepEqual(body.pulses, []);
  assert.deepEqual(body.lines, []);
});

test('nothing but types, sources, times and counts leaves the hub', async () => {
  const e = env();
  ev(e, 'defence-digest', 'vacancy.found', NOW - 2 * HOUR, { summary: 'SECRET vacancy title', payload: { title: 'SECRET title', organisation: 'SECRET org', link: 'https://secret.example' } });
  ev(e, 'day', 'dinner.away', NOW - 3 * HOUR, { summary: 'SECRET dinner', payload: { date: '2026-10-23', title: 'SECRET with Lucho' } });
  ev(e, 'mail', 'email.received', NOW - 4 * HOUR, { summary: 'Mail received', payload: { id: 'SECRETID', kind: 'triage' } });
  ev(e, 'todo', 'waiting.created', NOW - 5 * HOUR, { id: 'waiting.created-SECRETITEM-1-abcd' });
  line(e, 'pc', 'job', NOW - HOUR, 'SECRET projects line');
  line(e, 'lift', 'workout', NOW - 2 * HOUR, 'SECRET bench 80 kg');
  const { body } = await get(e);
  const text = JSON.stringify(body);
  assert.ok(!/SECRET|secret|Lucho|bench/.test(text), text);
  assert.equal(body.pulses.length, 6);
  for (const p of body.pulses) {
    assert.deepEqual(Object.keys(p).sort(), ['at', 'from', 'id', 'label', 'to', 'type']);
    assert.match(p.id, /^[0-9a-f]{12}$/);
  }
  // The Lately index keeps source and kind only.
  const idx = JSON.parse(e.HUB_KV.m.get('sky:feed'));
  assert.ok(!/SECRET/.test(JSON.stringify(idx)));
  assert.deepEqual(Object.values(idx).sort(), [['lift', 'workout'], ['pc', 'job']]);
});

test('the window is 7 days, pulses run oldest first across both logs, ids stay the same', async () => {
  const e = env();
  ev(e, 'todo', 'energy.set', NOW - 8 * DAY);            // too old
  ev(e, 'todo', 'energy.set', NOW - 1 * HOUR);
  ev(e, 'hub', 'waiting.chase_due', NOW - 3 * DAY);      // inserted later, happened earlier
  line(e, 'arsenal-watch', 'drop', NOW - 2 * DAY);
  line(e, 'arsenal-watch', 'drop', NOW - 9 * DAY);       // too old
  const a = (await get(e)).body;
  assert.deepEqual(a.pulses.map((p) => [p.from, p.type, p.to]), [
    ['hub', 'waiting.chase_due', ['todo', 'morning', 'day']],
    ['arsenal-watch', 'feed.drop', ['morning']],
    ['todo', 'energy.set', ['morning', 'day']],
  ]);
  assert.deepEqual(a.pulses.map((p) => p.at), [iso(NOW - 3 * DAY), iso(NOW - 2 * DAY), iso(NOW - HOUR)]);
  const b = (await get(e, undefined, NOW + 60000)).body;
  assert.deepEqual(b.pulses.map((p) => p.id), a.pulses.map((p) => p.id));
  assert.equal(new Set(a.pulses.map((p) => p.id)).size, 3);
});

test('Lately lines that repeat a typed event, and apps not on the hub, never become pulses', async () => {
  const e = env();
  ev(e, 'day', 'dinner.away', NOW - HOUR);
  line(e, 'day', 'dinner', NOW - HOUR);                 // the same event's Lately line
  line(e, 'defence-digest', 'vacancy', NOW - HOUR);
  line(e, 'feeling', 'checkin', NOW - HOUR);            // Feeling is not on the hub
  ev(e, 'runway', 'spend.logged', NOW - HOUR);          // nor is Runway
  const { body } = await get(e);
  assert.deepEqual(body.pulses.map((p) => p.type), ['dinner.away']);
  assert.ok(FEED_ONLY.every((s) => STARS.some((x) => x.id === s)));
});

test('the Lately index reads each line once and forgets lines that expired', async () => {
  const e = env();
  line(e, 'pc', 'job', NOW - HOUR);
  line(e, 'arsenal-watch', 'drop', NOW - 2 * HOUR);
  await get(e);
  const lineReads = () => e.HUB_KV.gets.filter((k) => k.startsWith('event:')).length;
  assert.equal(lineReads(), 2);
  e.HUB_KV.puts.length = 0;
  await get(e);
  assert.equal(lineReads(), 2, 'no line read twice');
  assert.ok(!e.HUB_KV.puts.includes('sky:feed'), 'nothing new, the index is not rewritten');
  line(e, 'lift', 'workout', NOW - 30 * 60000);
  const first = [...e.HUB_KV.m.keys()].find((k) => k.startsWith('event:'));
  e.HUB_KV.m.delete(first);                              // KV expired it after 30 days
  const { body } = await get(e);
  assert.equal(lineReads(), 3);
  assert.equal(Object.keys(JSON.parse(e.HUB_KV.m.get('sky:feed'))).length, 2);
  assert.equal(body.pulses.length, 2);
});

test('lines join both ways, stars count sent and received with who', async () => {
  const e = env();
  for (let i = 0; i < 3; i++) ev(e, 'todo', 'energy.set', NOW - (i + 1) * HOUR);
  ev(e, 'morning', 'energy.set', NOW - 5 * HOUR);
  const d = ev(e, 'day', 'dinner.away', NOW - 6 * HOUR);
  handled(e, 'kitchen', d, NOW - 6 * HOUR + 5000);
  ev(e, 'hub', 'waiting.chase_due', NOW - 7 * HOUR);
  const { body } = await get(e);
  const tm = body.lines.find((l) => l.a === 'todo' && l.b === 'morning');
  assert.equal(tm.n, 4);
  assert.deepEqual(tm.ab, [{ type: 'energy.set', label: 'Energy set', n: 3 }]);
  assert.deepEqual(tm.ba, [{ type: 'energy.set', label: 'Energy set', n: 1 }]);
  const dk = body.lines.find((l) => l.a === 'day' && l.b === 'kitchen');
  assert.deepEqual(dk.ab, [{ type: 'dinner.away', label: 'Out for dinner', n: 1 }]);
  assert.deepEqual(dk.ba, []);
  assert.ok(body.lines.find((l) => l.a === 'todo' && l.b === 'hub'), 'the hub is a star like the others');
  const todo = star(body, 'todo');
  assert.deepEqual(todo.sent, [{ type: 'energy.set', label: 'Energy set', n: 6, to: ['morning', 'day'] }]);
  assert.deepEqual(todo.received.map((r) => [r.type, r.n, r.from]), [['waiting.chase_due', 1, ['hub']], ['energy.set', 1, ['morning']]]);
  assert.equal(todo.events, 3 + 2);                      // 3 sent, 1 from Morning, 1 chase from the hub
  assert.equal(star(body, 'kitchen').events, 1);
  assert.deepEqual(star(body, 'kitchen').received, [{ type: 'dinner.away', label: 'Out for dinner', n: 1, from: ['day'] }]);
});

test('signs of life: own events, heartbeats, the calendar, the list, Morning, the cron; quiet past the limit', async () => {
  const e = env();
  e.HUB_KV.m.set('beat:arsenal-watch', JSON.stringify({ at: iso(NOW - 5 * HOUR - 60000) }));
  e.HUB_KV.m.set('beat:morning-projects', JSON.stringify({ at: iso(NOW - 70 * HOUR) }));
  e.HUB_KV.m.set('beat:backup', JSON.stringify({ at: iso(NOW - 20 * HOUR) }));
  e.HUB_KV.m.set('beat:defence-digest', JSON.stringify({ at: iso(NOW - 10 * HOUR) }));
  e.HUB_KV.m.set(CAL_KEY, JSON.stringify({ received: iso(NOW - 10 * 60000), events: [] }));
  e.HUB_KV.m.set('hub:status', JSON.stringify({ at: iso(NOW - 4 * HOUR), line: 'x' }));
  ev(e, 'mail', 'email.received', NOW - 8 * DAY, { payload: { kind: 'todo' } });   // outside the window, still its last sign
  line(e, 'lift', 'workout', NOW - 2 * DAY);
  const real = Date.now;
  Date.now = () => NOW - 30 * HOUR;
  await e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE)).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'upsert', item: { id: 'a1', text: 'x', section: 'today', done: false, doneAt: null, updatedAt: NOW - 30 * HOUR, pos: 1 } }] }) });
  Date.now = real;
  const { body } = await get(e);
  const s = (id) => { const x = star(body, id); return [x.quiet, x.quietHours]; };
  assert.deepEqual(s('arsenal-watch'), [true, 5]);
  assert.match(star(body, 'arsenal-watch').how, /watch\.log/);
  assert.equal(star(body, 'arsenal-watch').limitHours, 3);
  assert.deepEqual(s('pc'), [false, null], 'the backup beat 20 h ago keeps the PC lit');
  assert.deepEqual(s('defence-digest'), [false, null]);
  assert.deepEqual(s('day'), [false, null], 'the calendar push');
  assert.deepEqual(s('todo'), [false, null], 'the list changed 30 h ago, the limit is 2 days');
  assert.equal(star(body, 'todo').life, iso(NOW - 30 * HOUR));
  assert.deepEqual(s('hub'), [true, 4], 'the hourly cron stopped');
  assert.deepEqual(s('mail'), [true, 192]);
  assert.deepEqual(s('lift'), [false, null]);
  assert.deepEqual(s('kitchen'), [true, null], 'never heard from');
  assert.equal(star(body, 'kitchen').life, null);
  assert.equal(star(body, 'todo').how, null);
  // Looking at the constellation is Morning being used.
  assert.deepEqual(s('morning'), [false, null]);
  assert.equal(star(body, 'morning').life, iso(NOW));
});

test("Morning's visits mark its star at most once an hour, only for a good code", async () => {
  const e = env();
  const morning = async (code, at) => {
    const real = Date.now;
    Date.now = () => at;
    try { return (await worker.fetch(new Request('https://hub.test/api/morning/' + code), e)).status; } finally { Date.now = real; }
  };
  assert.equal(await morning('zzzzzzzzzzzzzzzz', NOW), 404);
  assert.equal(e.HUB_KV.m.get('life:morning'), undefined);
  assert.equal(await morning(CODE, NOW), 200);
  assert.equal(JSON.parse(e.HUB_KV.m.get('life:morning')).at, iso(NOW));
  e.HUB_KV.puts.length = 0;
  await morning(CODE, NOW + 30 * 60000);
  assert.ok(!e.HUB_KV.puts.includes('life:morning'));
  await morning(CODE, NOW + HOUR + 1);
  assert.equal(JSON.parse(e.HUB_KV.m.get('life:morning')).at, iso(NOW + HOUR + 1));
  assert.equal(await markLife(e, 'morning', NOW + HOUR + 2), false);
});

test('buildSky is pure: a hub event that reaches nobody still counts as sent', () => {
  const life = Object.fromEntries(STARS.map((s) => [s.id, NOW]));
  const sky = buildSky([{ key: 'e:1', at: iso(NOW - HOUR), source: 'hub', type: 'something.new', kind: null, targets: [] }], life, NOW, new Map([['e:1', 'aaaaaaaaaaaa']]));
  assert.deepEqual(sky.pulses, [{ id: 'aaaaaaaaaaaa', at: iso(NOW - HOUR), from: 'hub', type: 'something.new', label: 'Something new', to: [] }]);
  assert.deepEqual(star(sky, 'hub').sent, [{ type: 'something.new', label: 'Something new', n: 1, to: [] }]);
  assert.equal(star(sky, 'hub').events, 1);
  assert.deepEqual(sky.lines, []);
  assert.ok(sky.stars.every((s) => !s.quiet));
});

test('skyFor works without a list or heartbeats', async () => {
  const e = env();
  delete e.TODO_LIST;
  ev(e, 'todo', 'energy.set', NOW - HOUR);
  const sky = await skyFor(e, NOW);
  assert.equal(sky.pulses.length, 1);
  assert.equal(star(sky, 'todo').life, iso(NOW - HOUR));
});
