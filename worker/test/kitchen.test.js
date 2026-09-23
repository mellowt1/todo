// Kitchen module: calendar maths, validation, merge, the Durable Object, the routes,
// the admin route and the Morning Screen's kitchen block. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, * as entry from '../src/worker.js';
import {
  isoWeek, weekStart, validWeek, dayDate, cleanRecipe, cleanOp, cleanBatch, applyOps, tonightView, validId, LIMITS,
} from '../src/kitchen.js';
import { KitchenData, KitchenStore } from '../src/kitchen-store.js';
import { handleMorning, kitchenBlock } from '../src/morning.js';
import { MemStorage, memNamespace } from './mem.js';
import { TodoList } from '../src/list.js';

const BASE = 'https://paul-hub.example.workers.dev';
const TODO = 'abcdefgh23456789';
const KIT = 'kitchen234567890';
const ADMIN = 'admin-token-for-tests';
const NOW = Date.now();
const T = Date.UTC(2026, 8, 23, 12); // Wednesday 23 September 2026, week 39

function makeEnv(over = {}) {
  return {
    TODO_LIST: memNamespace(TodoList),
    KITCHEN_STORE: memNamespace(KitchenStore),
    TODO_CODE: TODO,
    KITCHEN_CODE: KIT,
    TODO_READ_TOKEN: 'read-token-for-tests',
    ADMIN_TOKEN: ADMIN,
    ...over,
  };
}
const call = (env, path, init = {}) => worker.fetch(new Request(BASE + path, init), env);
const post = (env, ops, code = KIT) => call(env, `/api/kitchen/${code}/ops`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://mellowt1.github.io' }, body: JSON.stringify({ ops }),
});
const admin = (env, body, token = ADMIN) => call(env, '/api/admin/kitchen/recipes', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

const recipe = (over = {}) => ({
  title: 'Chickpea and spinach curry', servings: 4, time: '35 min', veg: true,
  ingredients: [
    { qty: 2, unit: 'tins', item: 'chickpeas, drained', aisle: 'tins' },
    { qty: 200, unit: 'g', item: 'spinach', aisle: 'produce' },
    { qty: null, unit: '', item: 'salt', aisle: 'spices' },
  ],
  steps: ['Soften the onion in a little oil, 5 minutes.', 'Serve with rice.'],
  notes: 'Good the next day.',
  ...over,
});
const up = (type, item, updatedAt = NOW) => ({ op: 'upsert', type, item: { ...item, updatedAt } });
const del = (type, id, updatedAt = NOW) => ({ op: 'delete', type, item: { id, updatedAt } });

test('the Worker entry exports only handlers and classes (workerd refuses anything else)', () => {
  for (const [name, v] of Object.entries(entry)) {
    if (name === 'default') assert.equal(typeof v.fetch, 'function');
    else assert.equal(typeof v, 'function', name);
  }
  assert.ok(entry.KitchenStore && entry.TodoList);
});

/* ---------- Calendar ---------- */

test('ISO weeks: Monday first, week 53, and years that start in the old year', () => {
  assert.deepEqual(isoWeek('2026-09-23'), { week: '2026-W39', day: 'wed' });
  assert.deepEqual(isoWeek('2026-09-21'), { week: '2026-W39', day: 'mon' });
  assert.deepEqual(isoWeek('2026-09-27'), { week: '2026-W39', day: 'sun' });
  assert.deepEqual(isoWeek('2026-12-31'), { week: '2026-W53', day: 'thu' });
  assert.deepEqual(isoWeek('2021-01-03'), { week: '2020-W53', day: 'sun' });
  assert.deepEqual(isoWeek('2024-12-30'), { week: '2025-W01', day: 'mon' });
  assert.equal(weekStart('2026-W39'), '2026-09-21');
  assert.equal(weekStart('2025-W01'), '2024-12-30');
  assert.equal(dayDate('2026-W39:sat'), '2026-09-26');
  assert.ok(validWeek('2026-W53'));
  assert.ok(!validWeek('2025-W53'));
  assert.ok(!validWeek('2026-W00'));
  assert.ok(!validWeek('2026-W5'));
  assert.ok(!validWeek('1999-W10'));
});

/* ---------- Validation ---------- */

test('cleanRecipe keeps the contract, rounds amounts and says what is wrong', () => {
  const ok = cleanRecipe({ ...recipe(), extra: 'dropped', title: '  Chickpea   curry ' });
  assert.equal(ok.value.title, 'Chickpea curry');
  assert.equal(ok.value.extra, undefined);
  assert.equal(cleanRecipe(recipe({ ingredients: [{ qty: 1 / 3, unit: 'cup', item: 'rice', aisle: 'pasta' }] })).value.ingredients[0].qty, 0.333);
  assert.equal(cleanRecipe(recipe({ time: undefined, notes: undefined })).value.time, '');
  const why = (over) => cleanRecipe(recipe(over)).error;
  assert.match(why({ title: '' }), /title/);
  assert.match(why({ servings: 0 }), /servings/);
  assert.match(why({ servings: 2.5 }), /servings/);
  assert.match(why({ veg: 'yes' }), /veg/);
  assert.match(why({ ingredients: [{ qty: 1, unit: 'g', item: 'rice', aisle: 'grains' }] }), /ingredient 1: aisle/);
  assert.match(why({ ingredients: [{ qty: -1, unit: 'g', item: 'rice', aisle: 'pasta' }] }), /ingredient 1: qty/);
  assert.match(why({ ingredients: [{ qty: '2', unit: 'g', item: 'rice', aisle: 'pasta' }] }), /qty/);
  assert.match(why({ ingredients: [{ qty: 1, unit: 'g', item: '', aisle: 'pasta' }] }), /item/);
  assert.match(why({ steps: ['ok', ''] }), /step 2/);
  assert.match(why({ steps: 'Mix it' }), /steps/);
  assert.match(why({ notes: 'x'.repeat(LIMITS.notes + 1) }), /notes/);
  assert.match(why({ ingredients: Array.from({ length: LIMITS.ingredients + 1 }, () => ({ qty: 1, unit: 'g', item: 'x', aisle: 'other' })) }), /ingredients/);
  assert.match(cleanRecipe(null).error, /object/);
});

test('cleanOp: every type, ids per type, and anything off contract is dropped', () => {
  const day = (item) => cleanOp(up('day', item), NOW);
  assert.deepEqual(day({ id: '2026-W39:sat', kind: 'pizza', servings: 4 }).item,
    { type: 'day', id: '2026-W39:sat', kind: 'pizza', recipeId: null, text: '', servings: 4, updatedAt: NOW });
  assert.equal(day({ id: '2026-W39:wed', kind: 'recipe', recipeId: 'aaaaaaaa', servings: null }).item.recipeId, 'aaaaaaaa');
  assert.equal(day({ id: '2026-W39:wed', kind: 'text', text: ' Dinner at friends ' }).item.text, 'Dinner at friends');
  assert.equal(day({ id: '2026-W39:wed', kind: 'recipe' }), null);
  assert.equal(day({ id: '2026-W39:wed', kind: 'text', text: '' }), null);
  assert.equal(day({ id: '2026-W39:xyz', kind: 'pizza' }), null);
  assert.equal(day({ id: '2025-W53:mon', kind: 'pizza' }), null);
  assert.equal(day({ id: '2026-W39:wed', kind: 'pizza', servings: 99 }), null);

  const ex = cleanOp(up('extra', { id: 'xxxxxxxx', week: '2026-W39', text: 'Bread flour', qty: '870 g', aisle: 'baking', junk: 1 }), NOW);
  assert.deepEqual(ex.item, { type: 'extra', id: 'xxxxxxxx', week: '2026-W39', text: 'Bread flour', qty: '870 g', aisle: 'baking', updatedAt: NOW });
  assert.equal(cleanOp(up('extra', { id: 'xxxxxxxx', week: '2026-W39', text: 'Milk', aisle: 'shelf' }), NOW), null);

  assert.equal(cleanOp(up('tick', { id: '2026-W39|i:chickpeas', on: true }), NOW).item.on, true);
  assert.equal(cleanOp(up('tick', { id: '2026-W39|i:chick|peas', on: true }), NOW), null);
  assert.equal(cleanOp(up('tick', { id: '2026-W39|i:crème fraîche', on: false }), NOW).item.on, false);
  assert.equal(cleanOp(up('tick', { id: '2026-W39|x', on: 'yes' }), NOW), null);
  assert.ok(!validId('tick', '2026-W39|'));
  assert.ok(!validId('tick', '2026-W39|' + 'k'.repeat(LIMITS.key + 1)));

  const dough = (over) => cleanOp(up('dough', { id: 'dough', size: 14, count: 2, thickness: 'regular', gf: false, night: '2026-09-26', tweaks: { water: 64 }, ...over }), NOW);
  assert.deepEqual(dough({}).item.tweaks, { water: 64 });
  assert.equal(dough({ id: 'other' }), null);
  assert.equal(dough({ thickness: 'deep' }), null);
  assert.equal(dough({ night: '2026-02-30' }), null);
  assert.equal(dough({ tweaks: { water: 150 } }), null);
  assert.equal(dough({ tweaks: { butter: 5 } }), null);
  assert.equal(dough({ tweaks: { toString: 5 } }), null);
  assert.equal(dough({ night: null, tweaks: null }).item.night, null);

  assert.ok(cleanOp(up('recipe', { id: 'rrrrrrrr', ...recipe() }), NOW));
  assert.equal(cleanOp(up('recipe', { id: 'RRRRRRRR', ...recipe() }), NOW), null);
  assert.equal(cleanOp(up('pantry', { id: 'aaaaaaaa' }), NOW), null);
  assert.equal(cleanOp({ op: 'upsert', type: 'tick', item: { id: '2026-W39|x', on: true } }, NOW), null); // no updatedAt
  assert.equal(cleanOp(up('tick', { id: '2026-W39|x', on: true }, Date.UTC(2019, 0, 1)), NOW), null);
  assert.equal(cleanOp(up('tick', { id: '2026-W39|x', on: true }, NOW + 3600000), NOW).item.updatedAt, NOW + 5 * 60000);
  assert.deepEqual(cleanOp(del('day', '2026-W39:wed'), NOW), { op: 'delete', type: 'day', item: { type: 'day', id: '2026-W39:wed', updatedAt: NOW } });
  assert.equal(cleanOp(del('day', 'nope'), NOW), null);

  assert.deepEqual(cleanBatch({ ops: [] }), { error: 'ops empty' });
  assert.deepEqual(cleanBatch({}), { error: 'ops required' });
  assert.deepEqual(cleanBatch({ ops: Array(LIMITS.ops + 1).fill(del('day', '2026-W39:wed')) }), { error: 'too many ops' });
});

/* ---------- Merge ---------- */

test('merge: per record, newest wins, deletes leave tombstones, ties keep what is stored', () => {
  const doc = { items: {}, tombs: {} };
  const clean = (o) => cleanOp(o, NOW + 10000);
  applyOps(doc, [clean(up('day', { id: '2026-W39:mon', kind: 'text', text: 'A' }, NOW)), clean(up('day', { id: '2026-W39:tue', kind: 'text', text: 'B' }, NOW))]);
  // an older edit loses, a newer one wins, a tie changes nothing
  assert.equal(applyOps(doc, [clean(up('day', { id: '2026-W39:mon', kind: 'text', text: 'old' }, NOW - 1))]).changed, false);
  assert.equal(applyOps(doc, [clean(up('day', { id: '2026-W39:mon', kind: 'text', text: 'tie' }, NOW))]).changed, false);
  applyOps(doc, [clean(up('day', { id: '2026-W39:mon', kind: 'text', text: 'new' }, NOW + 1))]);
  assert.equal(doc.items['day:2026-W39:mon'].text, 'new');
  assert.equal(doc.items['day:2026-W39:tue'].text, 'B');
  // delete, then an older upsert cannot bring it back, a newer one can
  applyOps(doc, [clean(del('day', '2026-W39:tue', NOW + 5))]);
  assert.equal(doc.tombs['day:2026-W39:tue'], NOW + 5);
  assert.equal(applyOps(doc, [clean(up('day', { id: '2026-W39:tue', kind: 'text', text: 'stale' }, NOW + 4))]).changed, false);
  applyOps(doc, [clean(up('day', { id: '2026-W39:tue', kind: 'text', text: 'again' }, NOW + 6))]);
  assert.equal(doc.items['day:2026-W39:tue'].text, 'again');
  assert.equal(doc.tombs['day:2026-W39:tue'], undefined);
  // a delete older than the stored record is ignored
  assert.equal(applyOps(doc, [clean(del('day', '2026-W39:mon', NOW))]).changed, false);
  // the same id under two types is two records
  applyOps(doc, [clean(up('recipe', { id: 'samesame', ...recipe() }, NOW)), clean(up('extra', { id: 'samesame', week: '2026-W39', text: 'Milk', aisle: 'dairy' }, NOW))]);
  assert.ok(doc.items['recipe:samesame'] && doc.items['extra:samesame']);
});

/* ---------- The Durable Object ---------- */

test('store: one row per record, rev bumps only on change, since is cheap, export has tombstones', async () => {
  const st = new MemStorage();
  const s = new KitchenData(st);
  const ops = cleanBatch({ ops: [up('recipe', { id: 'rrrrrrrr', ...recipe() }), up('tick', { id: '2026-W39|i:spinach', on: true })] }, NOW).ops;
  let r = await s.apply(ops, NOW);
  assert.equal(r.rev, 1);
  assert.equal(r.items.length, 2);
  assert.ok(await st.get('r:recipe:rrrrrrrr'));
  assert.ok(await st.get('r:tick:2026-W39|i:spinach'));
  r = await s.apply(ops, NOW);
  assert.equal(r.rev, 1);
  assert.deepEqual(await s.read(1), { unchanged: true, rev: 1 });
  await s.apply(cleanBatch({ ops: [del('tick', '2026-W39|i:spinach', NOW + 1)] }, NOW + 10).ops, NOW + 10);
  const all = await s.exportAll();
  assert.deepEqual(all.items.map((i) => i.id), ['rrrrrrrr']);
  assert.equal(all.tombs['tick:2026-W39|i:spinach'], NOW + 1);
  assert.equal((await st.get('meta')).count, 1);
});

test('store: old tombstones are pruned, big batches are chunked, a full kitchen refuses', async () => {
  const DAY = 86400000;
  const st = new MemStorage();
  const s = new KitchenData(st);
  await s.apply(cleanBatch({ ops: [del('day', '2026-W01:mon', T - 91 * DAY), del('day', '2026-W02:mon', T - 10 * DAY)] }, T).ops, T - 2 * DAY);
  await s.apply(cleanBatch({ ops: [up('tick', { id: '2026-W39|a', on: true }, T)] }, T).ops, T);
  assert.deepEqual(Object.keys((await s.exportAll()).tombs), ['day:2026-W02:mon']);

  const many = Array.from({ length: 200 }, (_, i) => up('tick', { id: '2026-W39|item ' + i, on: true }, T));
  assert.equal((await s.apply(cleanBatch({ ops: many }, T).ops, T)).items.length, 201);

  const full = new MemStorage();
  await full.put('meta', { rev: 3, updated: null, count: LIMITS.rows, pruned: T });
  const r = await new KitchenData(full).apply(cleanBatch({ ops: [up('tick', { id: '2026-W39|a', on: true }, T)] }, T).ops, T);
  assert.equal(r.error, 'kitchen full');
  assert.equal((await full.get('meta')).rev, 3);
});

/* ---------- Routes ---------- */

test('GET and POST /api/kitchen/:code: round trip, since, rejected ops by index', async () => {
  const env = makeEnv();
  let r = await post(env, [
    up('day', { id: '2026-W39:sat', kind: 'pizza', servings: 2 }),
    up('day', { id: '2026-W39:sun', kind: 'soup' }),
    up('extra', { id: 'eeeeeeee', week: '2026-W39', text: 'Mozzarella', qty: '2 balls', aisle: 'dairy' }),
  ]);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://mellowt1.github.io');
  let b = await r.json();
  assert.deepEqual(b.rejected, [1]);
  assert.equal(b.rev, 1);
  assert.deepEqual(b.items.map((i) => i.type + ':' + i.id).sort(), ['day:2026-W39:sat', 'extra:eeeeeeee']);
  r = await call(env, `/api/kitchen/${KIT}`);
  b = await r.json();
  assert.equal(b.items.length, 2);
  assert.deepEqual(await (await call(env, `/api/kitchen/${KIT}?since=1`)).json(), { unchanged: true, rev: 1 });
  assert.equal((await (await call(env, `/api/kitchen/${KIT}?since=0`)).json()).items.length, 2);
  // a batch where every op is refused still answers with the current state
  b = await (await post(env, [up('day', { id: 'bad', kind: 'pizza' })])).json();
  assert.deepEqual(b.rejected, [0]);
  assert.equal(b.items.length, 2);
});

test('two devices editing different records never lose each other\'s changes', async () => {
  const env = makeEnv();
  const base = NOW - 60000;
  // phone A goes offline after its last sync; phone B keeps editing
  await post(env, [up('day', { id: '2026-W39:mon', kind: 'text', text: 'Pasta' }, base)]);
  await post(env, [up('day', { id: '2026-W39:tue', kind: 'text', text: 'Curry' }, base + 2000), up('tick', { id: '2026-W39|i:spinach', on: true }, base + 2000)]);
  // A comes back with an older edit on another day and a tick on another line
  const b = await (await post(env, [up('day', { id: '2026-W39:wed', kind: 'text', text: 'Soup' }, base + 1000), up('tick', { id: '2026-W39|i:onion', on: true }, base + 1000)])).json();
  const ids = b.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['2026-W39:mon', '2026-W39:tue', '2026-W39:wed', '2026-W39|i:onion', '2026-W39|i:spinach']);
  // and on the same record, the newer edit wins whatever order they arrive in
  await post(env, [up('day', { id: '2026-W39:mon', kind: 'text', text: 'Newer' }, base + 5000)]);
  const after = await (await post(env, [up('day', { id: '2026-W39:mon', kind: 'text', text: 'Older' }, base + 4000)])).json();
  assert.equal(after.items.find((i) => i.id === '2026-W39:mon').text, 'Newer');
});

test('the kitchen code and the to-do code never open each other', async () => {
  const env = makeEnv();
  assert.equal((await call(env, `/api/kitchen/${TODO}`)).status, 404);
  assert.equal((await post(env, [up('tick', { id: '2026-W39|a', on: true })], TODO)).status, 404);
  assert.equal((await call(env, `/api/todo/${KIT}`)).status, 404);
  assert.equal((await call(env, `/api/morning/${KIT}`)).status, 404);
  assert.equal((await call(env, `/api/kitchen/${KIT}`)).status, 200);
  assert.equal((await call(env, `/api/kitchen/short`)).status, 400);
  assert.equal((await call(env, `/api/kitchen/KITCHEN234567890`)).status, 400);
  // no KITCHEN_CODE set: nothing is served
  const off = makeEnv({ KITCHEN_CODE: undefined });
  assert.equal((await call(off, `/api/kitchen/${KIT}`)).status, 404);
});

test('kitchen routes refuse bad bodies, wrong methods and unknown paths', async () => {
  const env = makeEnv();
  const raw = (body) => call(env, `/api/kitchen/${KIT}/ops`, { method: 'POST', body });
  assert.equal((await raw('not json')).status, 400);
  assert.equal((await raw(JSON.stringify({ ops: [] }))).status, 400);
  assert.equal((await raw(JSON.stringify([up('tick', { id: '2026-W39|a', on: true })]))).status, 400);
  assert.equal((await raw('x'.repeat(200001))).status, 413);
  assert.equal((await call(env, `/api/kitchen/${KIT}/ops`)).status, 405);
  assert.equal((await call(env, `/api/kitchen/${KIT}`, { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await call(env, `/api/kitchen/${KIT}/other`)).status, 404);
  assert.equal((await call(env, `/api/kitchen/${KIT}`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080' } })).status, 204);
});

/* ---------- Admin ---------- */

test('admin recipes: token, upsert of one or many, ids kept, all or nothing with reasons', async () => {
  const env = makeEnv();
  assert.equal((await admin(env, { recipes: [recipe()] }, 'wrong')).status, 401);
  assert.equal((await admin(env, { recipes: [recipe()] }, 'read-token-for-tests')).status, 401);
  assert.equal((await call(env, '/api/admin/kitchen/recipes', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await call(env, '/api/admin/kitchen/recipes', { headers: { Authorization: 'Bearer ' + ADMIN } })).status, 405);

  let r = await admin(env, { recipes: [recipe(), recipe({ id: 'pastanorma', title: 'Pasta alla Norma', servings: 2 })] });
  assert.equal(r.status, 200);
  let b = await r.json();
  assert.equal(b.ok, true);
  assert.equal(b.ids.length, 2);
  assert.match(b.ids[0], /^[a-z0-9]{16}$/);
  assert.equal(b.ids[1], 'pastanorma');

  // a single recipe object works too, and the same id replaces it
  b = await (await admin(env, recipe({ id: 'pastanorma', title: 'Pasta alla Norma, better', servings: 2 }))).json();
  assert.deepEqual(b.ids, ['pastanorma']);
  const list = (await (await call(env, `/api/kitchen/${KIT}`)).json()).items;
  assert.equal(list.length, 2);
  assert.equal(list.find((i) => i.id === 'pastanorma').title, 'Pasta alla Norma, better');

  // one bad recipe refuses the whole call and says which and why
  r = await admin(env, { recipes: [recipe({ title: 'Fine' }), recipe({ title: 'Broken', ingredients: [{ qty: 1, unit: 'g', item: 'rice', aisle: 'grains' }] }), recipe({ id: 'BAD' })] });
  assert.equal(r.status, 400);
  b = await r.json();
  assert.deepEqual(b.errors.map((e) => e.index), [1, 2]);
  assert.equal(b.errors[0].title, 'Broken');
  assert.match(b.errors[0].error, /ingredient 1: aisle/);
  assert.equal((await (await call(env, `/api/kitchen/${KIT}`)).json()).items.length, 2);

  assert.equal((await admin(env, { recipes: Array(26).fill(recipe()) })).status, 400);
  assert.equal((await admin(env, { recipes: [] })).status, 400);
  assert.equal((await admin(env, 'nope')).status, 400);
  assert.equal((await admin(makeEnv({ KITCHEN_CODE: undefined }), { recipes: [recipe()] })).status, 503);
});

test('admin recipes always win: same millisecond twice, a phone clock ahead, a newer tombstone', async () => {
  const env = makeEnv();
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    let b = await (await admin(env, recipe({ id: 'samemilli', title: 'First' }))).json();
    assert.equal(b.ok, true);
    b = await (await admin(env, recipe({ id: 'samemilli', title: 'Second' }))).json();
    assert.equal(b.ok, true);
    let items = (await (await call(env, `/api/kitchen/${KIT}`)).json()).items;
    assert.equal(items.find((i) => i.id === 'samemilli').title, 'Second');

    // a phone 4 minutes ahead edits the recipe; the admin replace a moment later still wins
    await post(env, [up('recipe', { id: 'samemilli', ...recipe({ title: 'From a fast phone' }) }, frozen + 4 * 60000)]);
    items = (await (await call(env, `/api/kitchen/${KIT}`)).json()).items;
    assert.equal(items.find((i) => i.id === 'samemilli').title, 'From a fast phone');
    b = await (await admin(env, recipe({ id: 'samemilli', title: 'Admin again' }))).json();
    assert.equal(b.ok, true);
    items = (await (await call(env, `/api/kitchen/${KIT}`)).json()).items;
    const r = items.find((i) => i.id === 'samemilli');
    assert.equal(r.title, 'Admin again');
    assert.ok(r.updatedAt > frozen + 4 * 60000);

    // deleted on a fast phone, then re-added by the admin: it comes back
    await post(env, [del('recipe', 'samemilli', frozen + 4 * 60000 + 5000)]);
    b = await (await admin(env, recipe({ id: 'samemilli', title: 'Back' }))).json();
    assert.equal(b.ok, true);
    items = (await (await call(env, `/api/kitchen/${KIT}`)).json()).items;
    assert.equal(items.find((i) => i.id === 'samemilli').title, 'Back');
  } finally {
    Date.now = realNow;
  }
});

test('store: skipped lists the ops that did not land; win restamps past what is stored', async () => {
  const s = new KitchenData(new MemStorage());
  const op = (text, at) => cleanOp(up('day', { id: '2026-W39:mon', kind: 'text', text }, at), at + 1);
  let r = await s.apply([op('New', T)], T);
  assert.deepEqual(r.skipped, []);
  r = await s.apply([op('Old', T - 5)], T);
  assert.deepEqual(r.skipped, ['2026-W39:mon']);
  r = await s.apply([op('Won', T - 5)], T, true);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.items[0].text, 'Won');
  assert.equal(r.items[0].updatedAt, T + 1);
});

test('admin export: every kitchen record and tombstone, admin token only', async () => {
  const env = makeEnv();
  await post(env, [up('extra', { id: 'eeeeeeee', week: '2026-W39', text: 'Milk', aisle: 'dairy' }), del('day', '2026-W39:mon')]);
  assert.equal((await call(env, '/api/admin/kitchen/export')).status, 401);
  const r = await call(env, '/api/admin/kitchen/export', { headers: { Authorization: 'Bearer ' + ADMIN } });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.items[0].text, 'Milk');
  assert.ok(b.tombs['day:2026-W39:mon']);
  assert.equal(b.rev, 1);
  assert.equal((await call(makeEnv({ KITCHEN_CODE: undefined }), '/api/admin/kitchen/export', { headers: { Authorization: 'Bearer ' + ADMIN } })).status, 503);
});

/* ---------- Morning Screen ---------- */

const rec = (type, item) => ({ type, ...item, updatedAt: NOW });

test('tonightView: recipe, text, pizza, mix day 3 days ahead or 1 when gluten free', () => {
  const today = '2026-09-23'; // Wednesday
  const pasta = rec('recipe', { id: 'pastanorma', ...recipe({ title: 'Pasta alla Norma', veg: true }) });
  assert.equal(tonightView([], today), null);
  assert.deepEqual(tonightView([pasta, rec('day', { id: '2026-W39:wed', kind: 'recipe', recipeId: 'pastanorma' })], today),
    { tonight: { kind: 'recipe', title: 'Pasta alla Norma', veg: true }, mixToday: false, pizzaOn: null });
  assert.equal(tonightView([rec('day', { id: '2026-W39:wed', kind: 'recipe', recipeId: 'gonegone' })], today), null);
  assert.equal(tonightView([rec('day', { id: '2026-W39:wed', kind: 'text', text: 'Dinner at friends' })], today).tonight.title, 'Dinner at friends');
  assert.equal(tonightView([rec('day', { id: '2026-W39:wed', kind: 'pizza' })], today).tonight.title, 'Pizza night');
  // a pizza day on Saturday: mix on Wednesday
  assert.deepEqual(tonightView([rec('day', { id: '2026-W39:sat', kind: 'pizza' })], today), { tonight: null, mixToday: true, pizzaOn: '2026-09-26' });
  assert.equal(tonightView([rec('day', { id: '2026-W39:sat', kind: 'pizza' })], '2026-09-22'), null);
  // the dough's pizza night date counts too
  const dough = (over) => rec('dough', { id: 'dough', size: 14, count: 2, thickness: 'regular', gf: false, night: '2026-09-26', tweaks: {}, ...over });
  assert.equal(tonightView([dough()], today).mixToday, true);
  // gluten free: the day before
  assert.equal(tonightView([dough({ gf: true })], today), null);
  assert.equal(tonightView([dough({ gf: true })], '2026-09-25').mixToday, true);
  assert.equal(tonightView([dough({ gf: true, night: null }), rec('day', { id: '2026-W39:thu', kind: 'pizza' })], today).pizzaOn, '2026-09-24');
});

test('morning kitchen block: null without KITCHEN_CODE, read from the kitchen store, errors stay in the block', async () => {
  const env = makeEnv();
  assert.equal(await kitchenBlock(makeEnv({ KITCHEN_CODE: undefined }), T), null);
  assert.equal(await kitchenBlock(env, T), null); // empty kitchen
  await post(env, [up('day', { id: '2026-W39:wed', kind: 'text', text: 'Leftover curry' }), up('day', { id: '2026-W39:sat', kind: 'pizza', servings: 4 })]);
  assert.deepEqual(await kitchenBlock(env, T), { tonight: { kind: 'text', title: 'Leftover curry', veg: false }, mixToday: true, pizzaOn: '2026-09-26' });

  // Through the morning route with the to-do code; every other source is offline.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const path = `/api/morning/${TODO}`;
    const run = (e) => handleMorning(new Request(BASE + path), e, path.split('/').filter(Boolean).slice(2), (d, _r, status = 200) => Response.json(d, { status }), T);
    let b = await (await run(env)).json();
    assert.deepEqual(b.kitchen, { tonight: { kind: 'text', title: 'Leftover curry', veg: false }, mixToday: true, pizzaOn: '2026-09-26' });
    assert.ok(!JSON.stringify(b).includes(KIT), 'the kitchen code never leaves the Worker');
    b = await (await run(makeEnv({ KITCHEN_CODE: undefined }))).json();
    assert.equal(b.kitchen, null);
    const broken = makeEnv({ KITCHEN_STORE: { idFromName: () => 'x', get: () => ({ fetch: async () => { throw new Error('down'); } }) } });
    b = await (await run(broken)).json();
    assert.deepEqual(b.kitchen, { error: "Kitchen can't load right now" });
  } finally {
    globalThis.fetch = realFetch;
  }
});
