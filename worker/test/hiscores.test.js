// Hiscores: the OSRS XP table, each source's rows, the ledger never counting twice, the board,
// the route and the Sunday reset's Construction XP. No network. Every task and title is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  LEVEL_XP, levelOf, taskRows, cookingRows, prayerRows, rangedRows, magicRows, craftingRows, fishingRows, hunterRows, miningRows, smithingRows,
  board, scan, grantWeek, readBoard, handleHiscores, hiscoresForMorning, XP, SCAN_KEY,
} from '../src/hiscores.js';
import { actOnWeek } from '../src/week.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const SAT = Date.parse('2026-10-17T18:00:00Z'); // Saturday 20:00 in Amsterdam
const DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));

function memD1() {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) db.exec(m);
  const prepare = (sql) => {
    const st = db.prepare(sql);
    let args = [];
    const o = {
      bind(...a) { args = a; return o; },
      async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; },
      async all() { return { results: st.all(...args) }; },
      async first() { return st.get(...args) ?? null; },
    };
    return o;
  };
  return { db, prepare, async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}
const memKV = () => { const m = new Map(); return { m, async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } }; };
const fakeStore = (data) => ({ idFromName: (n) => n, get: () => ({ fetch: async () => Response.json(data) }) });
const json = (data, request, status = 200) => Response.json(data, { status });

function env() {
  const e = {
    TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: memKV(), HUB_DB: memD1(),
    KITCHEN_CODE: 'kkkkkkkk23456789',
    KITCHEN_STORE: fakeStore({ items: [
      { type: 'recipe', id: 'rec1', title: 'Seco De Pollo' },
      { type: 'day', id: '2026-W42:mon:paul:dinner', kind: 'recipe', recipeId: 'rec1' },
      { type: 'day', id: '2026-W42:tue:paul:dinner', kind: 'pizza', text: 'Pizza night' },
      { type: 'day', id: '2026-W42:wed:paul:dinner', kind: 'recipe', recipeId: 'rec1' },
      { type: 'day', id: '2026-W42:sat:paul:dinner', kind: 'recipe', recipeId: 'rec1' },
    ], away: { 'dinner:aa:2026-10-14': { date: '2026-10-14', away: true, seq: 1 } } }),
    FEELING: { fetch: async () => Response.json({ members: [{ id: 'me', days: { '2026-10-16': 4, '2026-10-17': 2 } }] }) },
  };
  e.HUB_DB.db.exec(`INSERT INTO config (key, value, updated_at) VALUES ('mirror_feeling', '{"code":"circle1","id":"me"}', 'x')`);
  return e;
}
async function seedTasks(e) {
  const stub = e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
  const t = (id, text, done, at) => ({ op: 'upsert', item: { id, text, section: 'today', done, doneAt: done ? at : null, updatedAt: at, pos: at } });
  await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [
    t('task00000001', 'Pay the rent', true, SAT - 3600e3),
    t('task00000002', 'Apply: Policy officer (A ministry) · 2026-10-30', true, SAT - 7200e3),
    t('task00000003', 'Fix the hallway light', false, SAT - 86400e3 * 20),
  ] }), headers: { 'Content-Type': 'application/json' } });
}

test('the OSRS XP table: the real milestones', () => {
  assert.equal(LEVEL_XP[2], 83);
  assert.equal(LEVEL_XP[10], 1154);
  assert.equal(LEVEL_XP[30], 13363);
  assert.equal(LEVEL_XP[50], 101333);
  assert.equal(LEVEL_XP[92], 6517253);
  assert.equal(LEVEL_XP[99], 13034431);
  assert.equal(levelOf(0), 1);
  assert.equal(levelOf(82), 1);
  assert.equal(levelOf(83), 2);
  assert.equal(levelOf(13363), 30);
  assert.equal(levelOf(200e6), 99);
});

test('to-dos: ticks are Woodcutting, Apply tasks are Slayer, the date label is dropped', () => {
  const rows = taskRows({
    a: { id: 'a1', text: 'Pay the rent · 2026-10-16', done: true, doneAt: SAT },
    b: { id: 'b1', text: 'Apply: Analyst (A ministry) · 2026-10-30', done: true, doneAt: SAT },
    c: { id: 'c1', text: 'Open', done: false, doneAt: null },
    d: { id: 'd1', text: 'Pay to NL86 INGB 0002 4455 88', done: true, doneAt: SAT },
    e: { id: 'e1', text: 'Apply for the policy adviser job', done: true, doneAt: SAT },
    f: { id: 'f1', text: 'Sollicitatiebrief sturen', done: true, doneAt: SAT },
    g: { id: 'g1', text: 'Applying sunscreen', done: true, doneAt: SAT },
  });
  assert.deepEqual(rows.map((r) => [r.id, r.skill, r.xp, r.what]), [
    ['wc:a1', 'woodcutting', 100, 'Pay the rent'],
    ['sl:b1', 'slayer', 4000, 'Analyst (A ministry)'],
    ['wc:d1', 'woodcutting', 100, 'Pay to IBAN ··5588'],
    ['sl:e1', 'slayer', 4000, 'Apply for the policy adviser job'],
    ['sl:f1', 'slayer', 4000, 'Sollicitatiebrief sturen'],
    ['wc:g1', 'woodcutting', 100, 'Applying sunscreen'],
  ]);
});

test('cooking: only days that are over, none on a night out, pizza pays less', () => {
  const e = env();
  return e.KITCHEN_STORE.get().fetch().then((r) => r.json()).then((data) => {
    const rows = cookingRows(data, '2026-10-17');
    assert.deepEqual(rows.filter((r) => r.skill === 'cooking').map((r) => [r.id, r.xp, r.what]), [
      ['ck:2026-10-12', 800, 'Seco De Pollo'],
      ['ck:2026-10-13', 500, 'Pizza night'],
    ]); // Wed was out, Saturday is today
  });
});

test('prayer, ranged, magic and crafting rows', () => {
  assert.deepEqual(prayerRows({ '2026-10-16': 4, '2026-10-18': 3 }, '2026-10-17', SAT).map((r) => r.id), ['pr:2026-10-16']);
  const ranged = rangedRows(
    [{ title: 'Sint Sebastiaen - Groep A', start: '2026-10-12T19:00:00+02:00', end: '2026-10-12T21:00:00+02:00', allDay: false },
      { title: 'Archery', start: '2026-10-19T19:00:00+02:00', end: '2026-10-19T21:00:00+02:00', allDay: false },
      { title: 'Dentist', start: '2026-10-13T09:00:00+02:00', end: '2026-10-13T10:00:00+02:00', allDay: false }],
    [{ payload: JSON.stringify({ date: '2026-10-05', title: 'Archery club' }) }, { payload: JSON.stringify({ date: '2026-10-12', title: 'Archery' }) }, { payload: 'nope' }],
    SAT,
  );
  assert.deepEqual(ranged.map((r) => r.id).sort(), ['rg:2026-10-05', 'rg:2026-10-12']);
  const magic = magicRows([{ id: 'c1', status: 'answered', minutes: 12, persona: 'Ingrid', outcomeAt: '2026-10-15T18:20:00Z' }, { id: 'c2', status: 'missed' }, { id: 'c3', status: 'answered', minutes: 90 }]);
  assert.deepEqual(magic.map((r) => [r.id, r.xp, r.what]), [['mg:c1', 1200, 'German with Ingrid, 12 min'], ['mg:c3', 2100, 'German with the tutor, 30 min']]);
  const craft = craftingRows([{ id: 'd1', text: 'Email the landlord', outcome: '["approved","skipped","copied"]', updated_at: '2026-10-17T10:00:00Z' }]);
  assert.deepEqual(craft.map((r) => r.id), ['cr:d1:0', 'cr:d1:2']);
});

test('the board: levels, next level, today, total', () => {
  const b = board({ woodcutting: 13363, cooking: 82 }, { woodcutting: 200 });
  const wc = b.skills.find((s) => s.id === 'woodcutting');
  assert.deepEqual([wc.level, wc.at, wc.next, wc.today], [30, 13363, 14833, 200]);
  assert.equal(b.skills.find((s) => s.id === 'cooking').level, 1);
  assert.equal(b.skills.length, 17);
  assert.equal(b.total, 30 + 10 + 15); // Hitpoints starts at 10
  assert.deepEqual(b.skills.map((s) => s.id), ['attack', 'hitpoints', 'mining', 'strength', 'smithing', 'defence', 'herblore', 'fishing', 'ranged', 'cooking', 'prayer', 'crafting', 'magic', 'woodcutting', 'slayer', 'construction', 'hunter']);
  // Hitpoints: 1154 plus a third of the combat XP, today too
  const c = board({ strength: 3000, ranged: 3000, magic: 0, woodcutting: 9000 }, { strength: 300 });
  const hp = c.skills.find((s) => s.id === 'hitpoints');
  assert.deepEqual([hp.xp, hp.level, hp.today], [1154 + 2000, levelOf(3154), 100]);
});

test('a scan back-fills every source once; scanning again adds nothing', async () => {
  const e = env();
  await seedTasks(e);
  await e.HUB_KV.put('german:calls', JSON.stringify([{ id: 'call1', status: 'answered', minutes: 10, persona: 'Hartmut', outcomeAt: '2026-10-16T18:00:00Z' }]));
  e.HUB_DB.db.exec(`INSERT INTO desk_log (id, at, text, kinds, outcome, updated_at) VALUES ('desk1', '2026-10-17T09:00:00Z', 'Draft a reply', 'draft', '["approved"]', '2026-10-17T09:05:00Z')`);
  e.HUB_DB.db.exec(`INSERT INTO events (id, source, type, summary, payload, at) VALUES ('dinner:x:2026-10-12:1', 'day', 'dinner.away', 's', '{"date":"2026-10-12","title":"Archery"}', '2026-10-11T10:00:00Z')`);
  e.HUB_DB.db.exec(`INSERT INTO mirror_days (date, mood, updated_at) VALUES ('2026-10-10', 3, 'x')`);
  const r = await scan(e, SAT);
  assert.deepEqual(r.failed, []);
  const ids = e.HUB_DB.db.prepare('SELECT id FROM xp_log ORDER BY id').all().map((x) => x.id);
  assert.deepEqual(ids, ['ck:2026-10-12', 'ck:2026-10-13', 'cr:desk1:0', 'hb:rec1', 'mg:call1', 'pr:2026-10-10', 'pr:2026-10-16', 'pr:2026-10-17', 'rg:2026-10-12', 'sl:task00000002', 'wc:task00000001']);
  assert.equal(r.added, 11);
  assert.equal((await scan(e, SAT + 60e3)).added, 0);

  const b = await readBoard(e, SAT);
  const get = (id) => b.skills.find((s) => s.id === id);
  assert.equal(get('slayer').xp, 4000);
  assert.equal(get('cooking').xp, 1300);
  assert.equal(get('prayer').xp, 3 * XP.face);
  assert.equal(get('prayer').today, XP.face); // today's face
  assert.equal(get('woodcutting').today, 100);
  assert.equal(b.log[0].skill, 'prayer'); // newest first
});

test('a failing source is reported; the rest still pay', async () => {
  const e = env();
  e.KITCHEN_STORE = { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({ error: 'x' }, { status: 500 }) }) };
  await seedTasks(e);
  const r = await scan(e, SAT);
  assert.deepEqual(r.failed, ['cooking']);
  assert.ok(r.added >= 2);
});

test('the route: code checked, scans first, then the board; a read within a minute does not scan', async () => {
  const e = env();
  await seedTasks(e);
  const req = new Request('https://x/api/hiscores/' + CODE);
  assert.equal((await handleHiscores(req, e, ['wrongcode1234567'], json, SAT)).status, 404);
  assert.equal((await handleHiscores(req, e, ['bad'], json, SAT)).status, 400);
  const res = await handleHiscores(req, e, [CODE], json, SAT);
  const body = await res.json();
  assert.equal(body.skills.length, 17);
  assert.ok(body.total >= 8);
  assert.equal(await e.HUB_KV.get(SCAN_KEY), new Date(SAT).toISOString());
  await hiscoresForMorning(e, SAT + 30e3);
  assert.equal(await e.HUB_KV.get(SCAN_KEY), new Date(SAT).toISOString()); // no second scan
  const m = await hiscoresForMorning(e, SAT + 120e3);
  assert.equal(m.log.length <= 5, true);
});

test('Strength: a gym visit pays once a day, by POST only', async () => {
  const e = env();
  const post = (path, method = 'POST') => handleHiscores(new Request('https://x/api/hiscores/' + path, { method }), e, path.split('/'), json, SAT);
  const first = await (await post(CODE + '/gym')).json();
  assert.deepEqual(first, { ok: true, added: true, level: 9, xp: 1000, say: 'Strength +1,000 XP. Level 9.' });
  const again = await (await post(CODE + '/gym')).json();
  assert.equal(again.added, false);
  assert.equal(again.say, 'Already logged today. Strength level 9.');
  assert.equal((await post(CODE + '/gym', 'GET')).status, 405);
  assert.equal((await post(CODE + '/nope')).status, 404);
  assert.equal((await post('wrongcode1234567/gym')).status, 404);
  const b = await readBoard(e, SAT);
  assert.equal(b.skills.find((x) => x.id === 'strength').today, 1000);
  assert.equal(b.log[0].what, 'Gym visit');
});

test('Construction: the Sunday reset buttons pay once per task per kind per week', async () => {
  const e = env();
  await seedTasks(e);
  const SUN = Date.parse('2026-10-18T16:00:00Z');
  await actOnWeek(e, { id: 'task00000003', action: 'later2' }, SUN);
  await actOnWeek(e, { id: 'task00000003', action: 'undo' }, SUN + 1000);
  await actOnWeek(e, { id: 'task00000003', action: 'later1' }, SUN + 2000);
  const rows = e.HUB_DB.db.prepare("SELECT id, xp, what FROM xp_log WHERE skill = 'construction'").all();
  assert.deepEqual(rows.map((r) => [r.id, r.xp, r.what]), [['cn:task00000003:later:2026-10-12', 600, 'New date: Fix the hallway light']]);
  assert.equal(await grantWeek(e, 'task00000009', 'undo', 'x', SUN), 0);
});

test('Attack and Defence from to-dos; Herblore once per recipe', () => {
  const DAY = 864e5;
  const rows = taskRows({
    a: { id: 'old1', text: 'Sort the tax papers', done: true, doneAt: SAT, pos: SAT - 20 * DAY },
    b: { id: 'new1', text: 'Buy milk', done: true, doneAt: SAT, pos: SAT - DAY },
    c: { id: 'let1', text: 'Pay the water bill · 2026-10-20 [intake]', done: true, doneAt: SAT, pos: SAT - DAY },
  });
  assert.deepEqual(rows.map((r) => [r.id, r.what]), [
    ['wc:old1', 'Sort the tax papers'], ['at:old1', 'Sort the tax papers, after 20 days'],
    ['wc:new1', 'Buy milk'],
    ['wc:let1', 'Pay the water bill'], ['df:let1', 'Pay the water bill'],
  ]);
  const cook = cookingRows({ items: [
    { type: 'recipe', id: 'r1', title: 'Stew' },
    { type: 'day', id: '2026-W41:mon:paul:dinner', kind: 'recipe', recipeId: 'r1' },
    { type: 'day', id: '2026-W42:mon:paul:dinner', kind: 'recipe', recipeId: 'r1' },
  ], away: [] }, '2026-10-17');
  assert.deepEqual(cook.filter((r) => r.skill === 'herblore').map((r) => [r.id, r.at.slice(0, 10)]), [['hb:r1', '2026-10-05']]);
  assert.ok(cook.every((r) => !('recipeId' in r)));
});

test('Fishing, Hunter, Mining and Smithing rows', () => {
  assert.deepEqual(fishingRows([{ id: 'v1', summary: 's', payload: '{"title":"Analyst","organisation":"A ministry"}', at: '2026-10-15T08:00:00Z' }]).map((r) => [r.id, r.what, r.xp]), [['fi:v1', 'Analyst (A ministry)', 1000]]);
  assert.deepEqual(hunterRows([
    { id: 'e1', source: 'arsenal-watch', text: 'Arsenal drop: Spurs tickets on sale', at: '2026-10-10T09:00:00Z' },
    { id: 'e2', source: 'feeling', text: 'Nick checked in', at: '2026-10-10T09:00:00Z' },
    { id: 'e3', source: 'arsenal-watch', text: 'Watcher restarted', at: '2026-10-10T09:00:00Z' },
  ]).map((r) => [r.id, r.what]), [['hu:e1', 'Spurs tickets on sale']]);
  assert.deepEqual(miningRows([{ id: 'i1', at: '2026-10-12T10:00:00Z', record: { sender: 'Gemeente Den Haag' } }, { id: 'i2', at: '2026-10-13T10:00:00Z', names: ['scan.pdf'] }, { at: 'x' }]).map((r) => [r.id, r.what]), [['mi:i1', 'Gemeente Den Haag'], ['mi:i2', 'scan.pdf']]);
  assert.deepEqual(smithingRows([{ hash: 'abcdef1234567890ff', repo: 'todo', at: '2026-10-17T20:00:00+02:00', subject: 'Hiscores' }, { hash: 'nothex', at: '2026-10-17' }]).map((r) => [r.id, r.what, r.at]), [['sm:abcdef1234567890', 'todo: Hiscores', '2026-10-17T18:00:00.000Z']]);
});

test('the hourly scan adds Hunter and Mining from KV; the quick one does not list KV', async () => {
  const e = env();
  await e.HUB_KV.put('event:00000000000001:e1', JSON.stringify({ id: 'e1', source: 'arsenal-watch', text: 'Arsenal drop: Cup tickets', at: '2026-10-10T09:00:00Z' }));
  await e.HUB_KV.put('intake:r:00000000000001:i1', JSON.stringify({ id: 'i1', at: '2026-10-12T10:00:00Z', record: { sender: 'DUO' } }));
  let listed = 0;
  const list = e.HUB_KV.list;
  e.HUB_KV.list = async ({ prefix }) => { listed++; return { keys: [...e.HUB_KV.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; };
  await scan(e, SAT);
  assert.equal(listed, 0);
  await scan(e, SAT, { slow: true });
  assert.equal(listed, 2);
  const ids = e.HUB_DB.db.prepare("SELECT id FROM xp_log WHERE skill IN ('hunter', 'mining') ORDER BY id").all().map((x) => x.id);
  assert.deepEqual(ids, ['hu:e1', 'mi:i1']);
  e.HUB_KV.list = list;
});

test('commits: the beat token, then each commit once', async () => {
  const e = { ...env(), BEAT_TOKEN: 'beat-secret' };
  const send = (token, body) => handleHiscores(new Request('https://x/api/hiscores/commits', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }), e, ['commits'], json, SAT);
  const commits = [{ hash: 'a'.repeat(40), repo: 'todo', at: '2026-10-17T10:00:00Z', subject: 'One' }, { hash: 'b'.repeat(40), repo: 'morning', at: '2026-10-17T11:00:00Z', subject: 'Two' }];
  assert.equal((await send('wrong', { commits })).status, 401);
  assert.deepEqual(await (await send('beat-secret', { commits })).json(), { ok: true, added: 2, seen: 2 });
  assert.deepEqual(await (await send('beat-secret', { commits })).json(), { ok: true, added: 0, seen: 2 });
  const b = await readBoard(e, SAT);
  assert.equal(b.skills.find((s) => s.id === 'smithing').xp, 50);
});
