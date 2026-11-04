// Task skills for the old tasks: once, only the skill added, Applies and letters left alone.
// No network: Claude is swapped; the list is the real Durable Object code in memory. Made-up tasks.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { needSkill, skillOps, taskSkillsOnce, _setSkillAsker, KEY, TRIES } from '../src/taskskills.js';
import { taskRows } from '../src/hiscores.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const NOW = Date.parse('2026-11-04T15:00:00Z');
const DAY = 864e5;
const task = (id, text, extra = {}) => ({ id, text, section: 'today', done: false, doneAt: null, updatedAt: NOW - DAY, pos: NOW - 20 * DAY, ...extra });
const memKV = () => { const m = new Map(); return { m, async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); } }; };

afterEach(() => _setSkillAsker(null));

test('needSkill: not an Apply, not a letter, not one that has a skill', () => {
  const items = {
    a: task('aaaaaaaa0001', 'Call Capital One'),
    b: task('bbbbbbbb0001', 'Apply: Analyst'),
    c: task('cccccccc0001', 'Pay the water bill · 2026-10-20 [intake]'),
    d: task('dddddddd0001', 'Book London', { skill: 'sailing' }),
  };
  assert.deepEqual(needSkill(items).map((t) => t.id), ['aaaaaaaa0001']);
});

test('skillOps: only the skill changes; unknown skills, none and missing tasks are dropped', () => {
  const items = { aaaaaaaa0001: task('aaaaaaaa0001', 'Call Capital One', { done: true, doneAt: NOW - DAY, energy: 'normal' }), bbbbbbbb0001: task('bbbbbbbb0001', 'Buy milk') };
  const ops = skillOps(items, [{ id: 'aaaaaaaa0001', skill: 'thieving' }, { id: 'bbbbbbbb0001', skill: 'none' }, { id: 'zzzzzzzz0001', skill: 'cooking' }, { id: 'bbbbbbbb0001', skill: 'baking' }], NOW);
  assert.equal(ops.length, 1);
  const it = ops[0].item;
  assert.deepEqual([it.id, it.skill, it.text, it.section, it.done, it.doneAt, it.pos], ['aaaaaaaa0001', 'thieving', 'Call Capital One', 'today', true, NOW - DAY, NOW - 20 * DAY]);
});

test('the job: runs once, in batches, adds only the skill, and the next scan pays it at the time it was done', async () => {
  const env = { TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: memKV(), ANTHROPIC_API_KEY: 'k' };
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + CODE));
  const tasks = Array.from({ length: 45 }, (_, i) => task('task' + String(i).padStart(8, '0'), 'Task ' + i, i === 0 ? { done: true, doneAt: NOW - 3 * DAY } : {}));
  await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: tasks.map((item) => ({ op: 'upsert', item })) }) });
  const batches = [];
  _setSkillAsker(async (_e, ts) => { batches.push(ts.length); return { tasks: ts.map((t, i) => ({ id: t.id, skill: i % 2 ? 'none' : 'herblore' })), usage: null }; });
  const out = await taskSkillsOnce(env, NOW);
  assert.deepEqual(batches, [40, 5]);
  assert.deepEqual(out, { read: 45, set: 23 });
  const items = (await (await stub.fetch('https://list/export')).json()).items;
  assert.equal(items.task00000000.skill, 'herblore');
  assert.equal(items.task00000000.text, 'Task 0');
  assert.equal('skill' in items.task00000001, false);
  assert.equal(JSON.parse(env.HUB_KV.m.get(KEY)).done, true);
  assert.deepEqual(await taskSkillsOnce(env, NOW + DAY), { skip: 'done' });
  assert.equal(batches.length, 2, 'never again');
  const paid = taskRows(items).filter((r) => r.id === 'ts:task00000000');
  assert.deepEqual(paid.map((r) => [r.skill, r.xp, r.at]), [['herblore', 300, new Date(NOW - 3 * DAY).toISOString()]]);
});

test('a failure is written down and tried again later, at most TRIES times', async () => {
  const env = { TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: memKV(), ANTHROPIC_API_KEY: 'k' };
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + CODE));
  await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'upsert', item: task('aaaaaaaa0001', 'Call Capital One') }] }) });
  let calls = 0;
  _setSkillAsker(async () => { calls++; throw new Error('down'); });
  for (let i = 0; i < TRIES + 2; i++) await taskSkillsOnce(env, NOW + i * DAY);
  assert.equal(calls, TRIES);
  assert.equal(JSON.parse(env.HUB_KV.m.get(KEY)).error, 'down');
  assert.deepEqual(await taskSkillsOnce({ ...env, ANTHROPIC_API_KEY: undefined }, NOW), { skip: 'no key' });
});
