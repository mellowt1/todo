// Others: the fourth section, the person field, slots, Morning's block, Sunday reset's section
// and the hand-back draft. No network: the drafter is swapped. Every name is made up.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { cleanOp, applyOps, openView, emptyDoc } from '../src/todo.js';
import { parseSlots, slotState, formatSlots } from '../src/slots.js';
import { groupOthers, noDashes, _setDrafter, othersBlock, othersAssign, ASSIGN_KEY } from '../src/others.js';
import { othersSection, doneSection, quietSection } from '../src/week.js';
import { CONFIG } from '../src/dinner.js';
import { local } from '../src/morning.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const DAY = 864e5;
const NOW = Date.parse('2026-10-17T08:30:00Z'); // Saturday 10:30 in Amsterdam
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
const memKV = () => { const m = new Map(); return { m, async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); }, async list() { return { keys: [] }; } }; };
const env = (over = {}) => ({ TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: memKV(), HUB_DB: memD1(), ANTHROPIC_API_KEY: 'k', ...over });
const call = (e, path, init = {}) => worker.fetch(new Request('https://hub.example/api/' + path, init), e);
const put = (e, ...items) => call(e, `todo/${CODE}/ops`, { method: 'POST', body: JSON.stringify({ ops: items.map((item) => ({ op: 'upsert', item })) }) });
const t = (id, text, section, over = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: NOW - DAY, pos: NOW - DAY, ...over });

afterEach(() => _setDrafter(null));

test('the item: others is a section, person is cleaned and kept like a link, handedBack only when done', () => {
  const op = cleanOp({ op: 'upsert', item: t('task0000001', 'Set up the printer', 'others', { person: '  Dad ' }) }, NOW);
  assert.equal(op.item.section, 'others');
  assert.equal(op.item.person, 'Dad');
  assert.equal(cleanOp({ op: 'upsert', item: t('task0000001', 'x', 'others', { person: 'x'.repeat(41) }) }, NOW), null);
  assert.equal(cleanOp({ op: 'upsert', item: t('task0000001', 'x', 'others', { handedBack: true }) }, NOW).item.handedBack, undefined);
  assert.equal(cleanOp({ op: 'upsert', item: t('task0000001', 'x', 'others', { done: true, doneAt: NOW, handedBack: true }) }, NOW).item.handedBack, true);
  const doc = emptyDoc();
  applyOps(doc, [op]);
  // An old app that knows nothing of people keeps the person; null clears it.
  applyOps(doc, [cleanOp({ op: 'upsert', item: t('task0000001', 'Set up the printer', 'others', { updatedAt: NOW }) }, NOW)]);
  assert.equal(doc.items.task0000001.person, 'Dad');
  applyOps(doc, [cleanOp({ op: 'upsert', item: t('task0000001', 'Set up the printer', 'soon', { updatedAt: NOW + 1, person: null }) }, NOW + 1)]);
  assert.equal(doc.items.task0000001.person, undefined);
});

test('Odysseus sees Others last, with the person in brackets', () => {
  const doc = emptyDoc();
  applyOps(doc, [t('a0000001', 'Mine', 'someday'), t('b0000001', 'Set up the printer', 'others', { person: 'Dad' })].map((item) => cleanOp({ op: 'upsert', item }, NOW)));
  assert.deepEqual(openView(doc), [{ text: 'Mine', section: 'someday' }, { text: 'Set up the printer (Dad)', section: 'others' }]);
});

test('slots: parse, tidy, refuse; where now stands and the next one', () => {
  assert.equal(formatSlots(parseSlots('saturday 10:00 - 12:00; Wed 19:00-20:00')), 'Sat 10:00-12:00; Wed 19:00-20:00');
  assert.equal(parseSlots('Sat 12:00-10:00'), null);
  assert.equal(parseSlots('Someday 10:00-12:00'), null);
  assert.equal(parseSlots(''), null);
  assert.equal(CONFIG.others_slots('sat 10:00-12:00'), 'Sat 10:00-12:00');
  assert.equal(CONFIG.others_slots('whenever'), null);
  const s = parseSlots('Sat 10:00-12:00; Wed 19:00-20:00');
  assert.deepEqual(slotState(s, { weekday: 6, minutes: 10 * 60 + 30 }), { inSlot: { day: 'Sat', start: '10:00', end: '12:00' }, next: { day: 'Wed', start: '19:00', label: 'Wed 19:00' } });
  assert.deepEqual(slotState(s, { weekday: 6, minutes: 9 * 60 }).next.label, 'today 10:00');
  assert.deepEqual(slotState(s, { weekday: 2, minutes: 20 * 60 }).next.label, 'tomorrow 19:00');
  assert.deepEqual(slotState(s, { weekday: 3, minutes: 20 * 60 }).next.label, 'Sat 10:00');
  assert.deepEqual(slotState(null, { weekday: 3, minutes: 0 }), { inSlot: null, next: null });
});

test('groupOthers: open Others only, by person, newest first, numbers masked', () => {
  const g = groupOthers([
    t('a1', 'Set up the printer', 'others', { person: 'Dad', pos: NOW - 12 * DAY }),
    t('a2', 'Check pension ref 1234 5678 9012', 'others', { person: 'Dad', pos: NOW - 3 * DAY }),
    t('a3', 'Phone plan', 'others', { person: 'Mom', pos: NOW - 6 * DAY }),
    t('a4', 'Old', 'others', { person: 'Mom', done: true, doneAt: NOW }),
    t('a5', 'Mine', 'today'),
  ], NOW);
  assert.deepEqual(g.map((x) => [x.person, x.tasks.map((y) => [y.text, y.days])]), [
    ['Dad', [['Check pension ref ··9012', 3], ['Set up the printer', 12]]],
    ['Mom', [['Phone plan', 6]]],
  ]);
});

test('Morning: Others never in Today; one line outside a slot, the list during one', async () => {
  const e = env();
  await put(e, t('mine000001', 'Mine today', 'today'), t('dad0000001', 'Set up the printer', 'others', { person: 'Dad' }), t('mom0000001', 'Phone plan', 'others', { person: 'Mom' }));
  let b = await othersBlock(e, NOW, local(NOW));
  assert.deepEqual([b.waiting, b.slots, b.inSlot, b.next, b.groups], [2, false, null, null, null]);
  await e.HUB_DB.prepare("INSERT INTO config (key, value, updated_at) VALUES ('others_slots', 'Sat 10:00-12:00; Wed 19:00-20:00', 'x')").run();
  b = await othersBlock(e, NOW, local(NOW));
  assert.equal(b.inSlot.end, '12:00');
  assert.deepEqual(b.groups.map((g) => g.person), ['Dad', 'Mom']);
  const later = NOW + 3 * 3600e3; // Saturday 13:30
  b = await othersBlock(e, later, local(later));
  assert.deepEqual([b.inSlot, b.next.label, b.groups], [null, 'Wed 19:00', null]);
  const m = await (await call(e, `morning/${CODE}`)).json();
  assert.deepEqual(m.todos.items.map((i) => i.text), ['Mine today']);
  assert.equal(m.others.waiting, 2);
});

test('Sunday reset: Others leave done and quiet, and get their own section', () => {
  const from = NOW - 5 * DAY;
  const items = [
    t('d1', 'Renew his permit', 'others', { person: 'Dad', done: true, doneAt: NOW - 2 * DAY }),
    t('n1', 'Proofread the letter', 'others', { person: 'Nick', done: true, doneAt: NOW - DAY, handedBack: true }),
    t('w1', 'Set up the printer', 'others', { person: 'Dad', updatedAt: NOW - 30 * DAY, pos: NOW - 30 * DAY }),
    t('w2', 'Phone plan', 'others', { person: 'Mom', pos: NOW - 6 * DAY }),
    t('m1', 'Mine', 'today', { done: true, doneAt: NOW - DAY }),
  ];
  assert.deepEqual(doneSection(items, from).count, 1);
  assert.deepEqual(quietSection(items, new Map(), NOW), []);
  const o = othersSection(items, from, NOW);
  assert.deepEqual(o.done.map((d) => [d.person, d.text, d.handedBack]), [['Dad', 'Renew his permit', false], ['Nick', 'Proofread the letter', true]]);
  assert.deepEqual(o.waiting, [{ person: 'Dad', count: 1, oldestDays: 30 }, { person: 'Mom', count: 1, oldestDays: 6 }]);
});

test('noDashes: dashes as punctuation go, hyphens in words stay', () => {
  assert.equal(noDashes('Hoi pap — ik kan het niet. Wil je het zelf doen - of samen?'), 'Hoi pap, ik kan het niet. Wil je het zelf doen, of samen?');
  assert.equal(noDashes('Een e-mail sturen – morgen.'), 'Een e-mail sturen, morgen.');
  assert.equal(noDashes('Klaar —.'), 'Klaar.');
});

test('the draft route: only open Others tasks, the language asked, never sends', async () => {
  const e = env();
  await put(e, t('dad0000001', 'Set up the printer', 'others', { person: 'Dad' }), t('mine000001', 'Mine', 'today'));
  const seen = [];
  _setDrafter(async (env2, args) => { seen.push(args); return noDashes('Hoi pap — ik lukt het deze week niet.'); });
  const post = (body) => call(e, `others/${CODE}/draft`, { method: 'POST', body: JSON.stringify(body) });
  const r = await (await post({ id: 'dad0000001', lang: 'nl' })).json();
  assert.equal(r.text, 'Hoi pap, ik lukt het deze week niet.');
  assert.deepEqual(seen[0], { text: 'Set up the printer', person: 'Dad', lang: 'nl' });
  assert.equal((await post({ id: 'mine000001', lang: 'nl' })).status, 404);
  assert.equal((await post({ id: 'dad0000001', lang: 'fr' })).status, 400);
  assert.equal((await call(e, 'others/zzzzzzzzzzzzzzzz/draft', { method: 'POST', body: '{}' })).status, 404);
  // Nothing in the list changed: a draft writes nothing.
  const items = (await (await call(e, `todo/${CODE}`)).json()).items;
  assert.equal(items.find((i) => i.id === 'dad0000001').done, false);
});

test('othersAssign: moves exactly the confirmed open tasks, once', async () => {
  const e = env();
  e.HUB_KV.delete = async (k) => { e.HUB_KV.m.delete(k); };
  await put(e, t('nicktax001', 'Nick taxes overview', 'soon'), t('dadcap0001', 'Dad Cap one', 'soon'), t('mine000001', 'Start investing', 'someday'), t('donetask01', 'Old', 'soon', { done: true, doneAt: NOW }));
  assert.deepEqual(await othersAssign(e, NOW), { skip: 'nothing to move' });
  e.HUB_KV.m.set(ASSIGN_KEY, JSON.stringify([{ id: 'nicktax001', person: 'Nick' }, { id: 'dadcap0001', person: ' Dad ' }, { id: 'donetask01', person: 'Mom' }, { id: 'nosuchtask', person: 'X' }]));
  assert.deepEqual(await othersAssign(e, NOW), { moved: 2 });
  const by = Object.fromEntries((await (await call(e, 'todo/' + CODE)).json()).items.map((i) => [i.id, i]));
  assert.deepEqual([by.nicktax001.section, by.nicktax001.person, by.dadcap0001.person, by.mine000001.section, by.donetask01.section], ['others', 'Nick', 'Dad', 'someday', 'soon']);
  assert.equal(e.HUB_KV.m.has(ASSIGN_KEY), false);
  assert.equal(JSON.parse(e.HUB_KV.m.get(ASSIGN_KEY + ':done')).moved.length, 2);
});
