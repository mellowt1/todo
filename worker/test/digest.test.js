// Digest: the PC's daily read of the hub. No network; made-up texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildDigest, handleDigest, groupEvents, jobState, newestMirror, deskCounts, liftPart, todoCounts, parkedPart, maskDeep } from '../src/digest.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const TOKEN = 'beat-token-for-tests';
const NOW = Date.parse('2026-10-19T10:00:00Z'); // Monday 12:00 in Amsterdam
const HOUR = 3600000;
const DAY = 24 * HOUR;
const DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));

function memD1() {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) db.exec(m);
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
    async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '', limit = 1000 } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) }; },
  };
}
const env = (over = {}) => ({ HUB_KV: memKV(), HUB_DB: memD1(), TODO_LIST: memNamespace(), TODO_CODE: CODE, BEAT_TOKEN: TOKEN, ...over });
const json = (data, request, status = 200) => Response.json(data, { status });
const evKey = (ms, id) => 'event:' + String(ms).padStart(14, '0') + ':' + id;
const putEv = (e, ms, source, text) => e.HUB_KV.put(evKey(ms, Math.random().toString(36).slice(2, 8)), JSON.stringify({ id: 'x', source, kind: 'job', who: '', text, at: new Date(ms).toISOString() }));

test('groupEvents: counts per source, at most five newest texts', () => {
  const events = Array.from({ length: 7 }, (_, i) => ({ source: 'pc', text: 'run ' + (7 - i), at: new Date(NOW - i * HOUR).toISOString() }));
  events.push({ source: 'feeling', text: 'Nick checked in', at: new Date(NOW - 9 * HOUR).toISOString() });
  const g = groupEvents(events, 10);
  assert.equal(g.total, 10);
  assert.equal(g.read, 8);
  assert.equal(g.sources.pc.count, 7);
  assert.deepEqual(g.sources.pc.latest, ['run 7', 'run 6', 'run 5', 'run 4', 'run 3']);
  assert.equal(g.sources.pc.lastAt, events[0].at);
  assert.equal(g.sources.feeling.count, 1);
});

test('jobState: quiet past the limit, unknown when never seen', () => {
  const s = jobState({ 'arsenal-watch': NOW - 5 * HOUR, 'morning-projects': NOW - HOUR }, NOW);
  assert.deepEqual(s.quiet, [{ job: 'arsenal-watch', name: 'Arsenal ticket watch', hoursAgo: 5, limit: 3 }]);
  assert.equal(s.ok, 1);
  assert.ok(s.unknown.includes('backup'));
});

test('newestMirror: the newest written card, pending ones skipped', () => {
  const m = newestMirror([
    ['mirror:week:2026-10-05', { at: 'a', finding: { text: 'old', numbers: '1 vs 2' }, experiment: null }],
    ['mirror:week:2026-10-19', { at: 'b', pending: true }],
    ['mirror:week:2026-10-12', { at: 'c', finding: { text: 'You tick more on cook days.', numbers: '5.1 vs 3.2' }, experiment: { text: 'Cook on 4 nights.', from: '2026-10-18', to: '2026-10-24' }, last: { text: 'You hit it.' } }],
  ]);
  assert.deepEqual(m, { week: '2026-10-12', at: 'c', finding: 'You tick more on cook days.', numbers: '5.1 vs 3.2', experiment: { text: 'Cook on 4 nights.', from: '2026-10-18', to: '2026-10-24' }, last: 'You hit it.' });
  assert.equal(newestMirror([['mirror:week:2026-10-19', { pending: true }]]), null);
});

test('deskCounts, todoCounts, liftPart, parkedPart', () => {
  assert.deepEqual(deskCounts([{ kinds: 'todo,draft', outcome: '["approved","skipped"]' }, { kinds: 'answer', outcome: 'not json' }]),
    { days: 14, lines: 2, kinds: { todo: 1, draft: 1, answer: 1 }, outcomes: { approved: 1, skipped: 1 } });
  assert.deepEqual(todoCounts([{ section: 'today' }, { section: 'soon' }, { section: 'soon', done: true }, { section: 'someday' }]), { open: 3, today: 1, soon: 1, someday: 1, build: 0, fun: 0 });
  const lift = liftPart({ at: 'x', summary: { next: { name: 'Legs' }, nextDay: null, days: [false, false, false, false, false, false, false], workouts: [
    { name: 'Push', start: NOW - DAY }, { name: 'Pull', start: NOW - 3 * DAY }, { name: 'Legs', start: NOW - 5 * DAY }, { name: 'Old', start: NOW - 9 * DAY },
  ] } }, NOW);
  assert.deepEqual(lift.last, [{ name: 'Push', date: '2026-10-18' }, { name: 'Pull', date: '2026-10-16' }, { name: 'Legs', date: '2026-10-14' }]);
  assert.equal(lift.next, 'Legs');
  assert.equal(liftPart(null, NOW), null);
  const parked = parkedPart({ projects: [{ name: 'CV Studio', status: 'parked', next: '', since: '2026-09-01' }, { name: 'Lift', status: 'live' }], parked: [{ text: 'VanMoof unlock', from: 'memory', since: '2026-10-05' }, { text: 'no date' }] }, NOW);
  assert.deepEqual(parked.map((p) => [p.text, p.days]), [['CV Studio', 48], ['VanMoof unlock', 14], ['no date', null]]);
});

test('maskDeep: account numbers cut down anywhere in the tree', () => {
  assert.deepEqual(maskDeep({ a: ['Pay NL86 INGB 0002 4455 88'], n: 3, b: { c: 'ref 5123 4567 8901 2340' } }), { a: ['Pay IBAN ··5588'], n: 3, b: { c: 'ref ··2340' } });
});

test('handleDigest: needs BEAT_TOKEN, GET only', async () => {
  const e = env();
  const req = (token, method = 'GET') => new Request('https://hub.example/api/hub/digest', { method, headers: token ? { Authorization: 'Bearer ' + token } : {} });
  assert.equal((await handleDigest(req('wrong'), e, json, NOW)).status, 401);
  assert.equal((await handleDigest(req(''), e, json, NOW)).status, 401);
  assert.equal((await handleDigest(req(TOKEN), { ...e, BEAT_TOKEN: undefined }, json, NOW)).status, 401);
  assert.equal((await handleDigest(req(TOKEN, 'POST'), e, json, NOW)).status, 405);
  const r = await handleDigest(req(TOKEN), e, json, NOW);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.date, '2026-10-19');
  assert.equal(d.days, 7);
});

test('buildDigest: every part from a filled hub, masked', async () => {
  const e = env();
  await putEv(e, NOW - HOUR, 'pc', 'Projects list refreshed');
  await putEv(e, NOW - 2 * DAY, 'pc', 'Weekly backup done');
  await putEv(e, NOW - 3 * DAY, 'feeling', 'Paid NL86 INGB 0002 4455 88');
  await putEv(e, NOW - 9 * DAY, 'pc', 'too old');
  await e.HUB_KV.put('hub:status', JSON.stringify({ at: 'now', line: 'A quiet night.', summary: 'All fine.', summaryAt: 's' }));
  await e.HUB_KV.put('beat:arsenal-watch', JSON.stringify({ at: new Date(NOW - 6 * HOUR).toISOString() }));
  await e.HUB_KV.put('mirror:week:2026-10-12', JSON.stringify({ at: 'c', finding: { text: 'Finding.', numbers: 'n' }, experiment: null }));
  await e.HUB_KV.put('lessons:kept', JSON.stringify({ desk: ['Keep Dutch tasks in Dutch.'], tidy: [] }));
  await e.HUB_KV.put('lift:state', JSON.stringify({ at: 'l', summary: { next: { name: 'Arms' }, days: [], workouts: [{ name: 'Legs', start: NOW - DAY }] } }));
  await e.HUB_KV.put('intake:r:' + String(NOW - DAY).padStart(14, '0') + ':a', '{}');
  await e.HUB_KV.put('intake:r:' + String(NOW - 10 * DAY).padStart(14, '0') + ':b', '{}');
  await e.HUB_KV.put('morning:projects', JSON.stringify({ projects: [], parked: [{ text: 'Bluetooth unlock page', from: 'memory', since: '2026-10-05', id: 'abcdef' }] }));
  const at = (ms) => new Date(ms).toISOString();
  const db = e.HUB_DB.db;
  db.prepare("INSERT INTO lessons (id, app, text, why, state, week, at) VALUES ('l1', 'tidy', 'Keep tmrw as typed.', 'You undid 2.', 'proposed', '2026-10-12', ?)").run(at(NOW - DAY));
  const fb = db.prepare('INSERT INTO feedback (id, at, app, kind, before, after, note) VALUES (?, ?, ?, ?, ?, ?, NULL)');
  fb.run('f1', at(NOW - DAY), 'tidy', 'undone', 'Buy milk · 2026-10-20', 'buy milk tmrw');
  fb.run('f2', at(NOW - 2 * DAY), 'desk', 'approved', 'Call the bank [soon]', null);
  fb.run('f3', at(NOW - 20 * DAY), 'desk', 'edited', 'old', 'older');
  const dl = db.prepare('INSERT INTO desk_log (id, at, text, kinds, outcome, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  dl.run('d1', at(NOW - DAY), 'call bank', 'todo', '["approved"]', at(NOW));
  dl.run('d2', at(NOW - 3 * DAY), 'note for sam', 'draft', '["skipped"]', at(NOW));
  dl.run('d3', at(NOW - 30 * DAY), 'old', 'todo', '["ready"]', at(NOW));
  const stub = e.TODO_LIST.get('todo:' + CODE);
  await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [
    { op: 'upsert', item: { id: 'aaaaaaaaaaaa', text: 'One', section: 'today', done: false, doneAt: null, updatedAt: NOW, pos: 1 } },
    { op: 'upsert', item: { id: 'bbbbbbbbbbbb', text: 'Two', section: 'soon', done: false, doneAt: null, updatedAt: NOW, pos: 2 } },
  ] }) });

  const d = await buildDigest(e, NOW);
  assert.equal(d.events.total, 3, 'the 9-day-old event is out');
  assert.equal(d.events.sources.pc.count, 2);
  assert.deepEqual(d.events.sources.feeling.latest, ['Paid IBAN ··5588']);
  assert.equal(d.status.summary, 'All fine.');
  assert.equal(d.jobs.quiet[0].job, 'arsenal-watch');
  assert.equal(d.mirror.week, '2026-10-12');
  assert.deepEqual(d.lessons.kept, { desk: ['Keep Dutch tasks in Dutch.'] }, 'apps without a rule left out');
  assert.deepEqual(d.lessons.proposed, [{ app: 'tidy', text: 'Keep tmrw as typed.', why: 'You undid 2.' }]);
  assert.deepEqual(d.lessons.feedback, { tidy: { undone: 1 }, desk: { approved: 1 } });
  assert.deepEqual(d.lessons.corrections, [{ app: 'tidy', kind: 'undone', before: 'Buy milk · 2026-10-20', after: 'buy milk tmrw' }]);
  assert.deepEqual(d.desk, { days: 14, lines: 2, kinds: { todo: 1, draft: 1 }, outcomes: { approved: 1, skipped: 1 } });
  assert.deepEqual(d.lift.last, [{ name: 'Legs', date: '2026-10-18' }]);
  assert.equal(d.lift.next, 'Arms');
  assert.deepEqual(d.intake, { week: 1 });
  assert.deepEqual(d.todos, { open: 2, today: 1, soon: 1, someday: 0, build: 0, fun: 0 });
  assert.deepEqual(d.parked, [{ text: 'Bluetooth unlock page', from: 'memory', since: '2026-10-05', days: 14 }]);
});

test('buildDigest: one failing part is { error }, the rest still arrive', async () => {
  const e = env({ HUB_DB: undefined, TODO_LIST: undefined });
  e.HUB_KV.get = async (k, t) => { if (k === 'hub:status') throw new Error('kv down'); return null; };
  const d = await buildDigest(e, NOW);
  assert.deepEqual(d.status, { error: 'kv down' });
  assert.deepEqual(d.lessons, { error: 'not configured' });
  assert.deepEqual(d.desk, { error: 'not configured' });
  assert.deepEqual(d.todos, { error: 'not configured' });
  assert.equal(d.events.total, 0);
  assert.equal(d.lift, null);
  assert.deepEqual(d.parked, []);
  assert.equal(d.mirror, null);
});
