// The hub: typed events, rules and the to-do reaction. No network; D1 is node:sqlite running
// the real migration. Every name here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { cleanHubEvent, pick, cleanDate, vacancyTask, handleMessage, consume, secretName } from '../src/hub.js';
import { cleanOp, applyOps, emptyDoc, cleanLink } from '../src/todo.js';
import { memNamespace } from './mem.js';

const NOW = Date.parse('2026-10-12T07:00:00Z');
const SECRET = 'digest-secret-for-tests';
const ADMIN = 'admin-token-for-tests';
const CODE = 'abcdefgh12345678';
const MIGRATION = readFileSync(new URL('../migrations/0001_hub.sql', import.meta.url), 'utf8');

function memD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION);
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
const memQueue = () => ({ sent: [], fail: false, async sendBatch(ms) { if (this.fail) throw new Error('down'); this.sent.push(...ms); } });
const env = (over = {}) => ({
  HUB_DB: memD1(), HUB_QUEUE: memQueue(), HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE,
  HUB_SECRET_DEFENCE_DIGEST: SECRET, EVENT_TOKEN: 'event-token', ADMIN_TOKEN: ADMIN, ...over,
});
const vacancy = (over = {}) => ({
  id: 'a'.repeat(64), source: 'defence-digest', type: 'vacancy.found', summary: 'Policy officer, Ministry of Defence',
  payload: { title: 'Policy officer', organisation: 'Ministry of Defence', link: 'https://example.org/jobs/1', deadline: '2026-10-30', salary: 'scale 11' },
  ...over,
});
const post = (e, body, token = SECRET) => worker.fetch(new Request('https://hub.example/api/event', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), e);
const admin = (e, path, body, token = ADMIN) => worker.fetch(new Request('https://hub.example/api/admin/' + path, {
  method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined,
}), e);
const tasks = async (e) => {
  const stub = e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
  return (await (await stub.fetch('https://list/export')).json());
};

test('secretName: the source in capitals, dashes as underscores', () => {
  assert.equal(secretName('defence-digest'), 'HUB_SECRET_DEFENCE_DIGEST');
});

test('cleanHubEvent: id, source, type and summary are required and bounded', () => {
  assert.match(cleanHubEvent(null).error, /send/);
  assert.match(cleanHubEvent(vacancy({ id: 'short' })).error, /id/);
  assert.match(cleanHubEvent(vacancy({ type: 'vacancy' })).error, /type/);
  assert.match(cleanHubEvent(vacancy({ summary: ' ' })).error, /summary/);
  assert.match(cleanHubEvent(vacancy({ payload: [1] })).error, /payload/);
  assert.match(cleanHubEvent(vacancy({ hops: 1.5 })).error, /hops/);
  assert.match(cleanHubEvent(vacancy({ payload: { x: 'y'.repeat(5000) } })).error, /too large/);
  const ev = cleanHubEvent(vacancy(), NOW);
  assert.equal(ev.hops, 0);
  assert.equal(ev.caused_by, null);
  assert.equal(ev.at, '2026-10-12T07:00:00.000Z');
});

test('pick keeps only the allowed fields', () => {
  assert.deepEqual(pick({ a: 1, b: 2, c: 3 }, ['a', 'c', 'z']), { a: 1, c: 3 });
});

test('a typed event needs its own source secret, not EVENT_TOKEN', async () => {
  const e = env();
  assert.equal((await post(e, vacancy(), 'event-token')).status, 401);
  assert.equal((await post(e, vacancy({ source: 'other-app' }))).status, 401);
  assert.equal((await post(env({ HUB_SECRET_DEFENCE_DIGEST: undefined }), vacancy())).status, 401);
  assert.equal(e.HUB_QUEUE.sent.length, 0);
});

test('stored once, matched to the rule, payload cut to the allowlist, one feed line', async () => {
  const e = env();
  const r = await post(e, vacancy());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, id: 'a'.repeat(64), queued: 1 });
  const row = e.HUB_DB.db.prepare('SELECT * FROM events').get();
  assert.equal(row.type, 'vacancy.found');
  assert.equal(JSON.parse(row.payload).salary, 'scale 11'); // the log keeps everything
  const msg = e.HUB_QUEUE.sent[0].body;
  assert.equal(msg.target, 'todo');
  assert.equal(msg.rule, 'digest-vacancy-todo');
  assert.deepEqual(msg.payload, { title: 'Policy officer', organisation: 'Ministry of Defence', link: 'https://example.org/jobs/1', deadline: '2026-10-30' });
  const feed = [...e.HUB_KV.m.entries()].filter(([k]) => k.startsWith('event:'));
  assert.equal(feed.length, 1);
  assert.equal(JSON.parse(feed[0][1]).kind, 'vacancy');
});

test('the same id again is a 200 that does nothing', async () => {
  const e = env();
  await post(e, vacancy());
  const r = await post(e, vacancy({ summary: 'changed' }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).duplicate, true);
  assert.equal(e.HUB_QUEUE.sent.length, 1);
  assert.equal(e.HUB_DB.db.prepare('SELECT summary FROM events').get().summary, 'Policy officer, Ministry of Defence');
});

test('hops >= 1 is stored but never queued', async () => {
  const e = env();
  const r = await post(e, vacancy({ hops: 1, caused_by: 'b'.repeat(64) }));
  assert.equal((await r.json()).queued, 0);
  assert.equal(e.HUB_QUEUE.sent.length, 0);
  assert.equal(e.HUB_DB.db.prepare('SELECT hops FROM events').get().hops, 1);
});

test('a queue failure forgets the event, so the resend goes through', async () => {
  const e = env();
  e.HUB_QUEUE.fail = true;
  assert.equal((await post(e, vacancy())).status, 503);
  assert.equal(e.HUB_DB.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  e.HUB_QUEUE.fail = false;
  assert.equal((await (await post(e, vacancy())).json()).queued, 1);
});

test('admin: list the rules and flip one; a disabled rule queues nothing', async () => {
  const e = env();
  assert.equal((await admin(e, 'rules', null, 'wrong')).status, 401);
  const list = await (await admin(e, 'rules')).json();
  assert.deepEqual(list.rules, [{ id: 'digest-vacancy-todo', source: 'defence-digest', type: 'vacancy.found', target: 'todo', fields: ['title', 'organisation', 'link', 'deadline'], enabled: true }]);
  assert.equal((await admin(e, 'rules/digest-vacancy-todo', { enabled: 'no' })).status, 400);
  assert.equal((await admin(e, 'rules/nope', { enabled: false })).status, 404);
  const off = await (await admin(e, 'rules/digest-vacancy-todo', { enabled: false })).json();
  assert.equal(off.rule.enabled, false);
  assert.equal((await (await post(e, vacancy())).json()).queued, 0);
  await admin(e, 'rules/digest-vacancy-todo', { enabled: true });
  assert.equal((await (await post(e, vacancy({ id: 'c'.repeat(64) }))).json()).queued, 1);
});

test('cleanDate: only a real YYYY-MM-DD', () => {
  assert.equal(cleanDate('2026-10-30'), '2026-10-30');
  assert.equal(cleanDate('2026-02-30'), null);
  assert.equal(cleanDate('end of October'), null);
  assert.equal(cleanDate(undefined), null);
});

test('vacancyTask: Apply line in Soon, the deadline only when given, the link kept', () => {
  const t = vacancyTask({ title: 'Policy officer', organisation: 'Ministry of Defence', link: 'https://example.org/jobs/1', deadline: '2026-10-30' }, 'abcdef0123456789abcdef01', NOW);
  assert.equal(t.op.item.text, 'Apply: Policy officer (Ministry of Defence) · 2026-10-30');
  assert.equal(t.op.item.section, 'soon');
  assert.equal(t.op.item.link, 'https://example.org/jobs/1');
  assert.equal(vacancyTask({ title: 'Analyst', organisation: 'A think tank' }, 'abcdef0123456789abcdef01', NOW).op.item.text, 'Apply: Analyst (A think tank)');
  assert.equal(vacancyTask({ title: 'Analyst', deadline: 'soon' }, 'abcdef0123456789abcdef01', NOW).op.item.text, 'Apply: Analyst');
  assert.equal(vacancyTask({ title: 'Analyst', link: 'javascript:alert(1)' }, 'abcdef0123456789abcdef01', NOW).op.item.link, undefined);
  assert.equal(vacancyTask({ organisation: 'X' }, 'abcdef0123456789abcdef01', NOW).skip, 'no title');
});

test('the consumer makes one task, marks it handled, and a redelivery changes nothing', async () => {
  const e = env();
  await post(e, vacancy());
  const body = e.HUB_QUEUE.sent[0].body;
  const out = await handleMessage(e, body, NOW);
  assert.ok(out.done);
  const doc = await tasks(e);
  const items = Object.values(doc.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Apply: Policy officer (Ministry of Defence) · 2026-10-30');
  assert.equal(items[0].link, 'https://example.org/jobs/1');
  assert.equal(e.HUB_DB.db.prepare('SELECT COUNT(*) AS n FROM handled').get().n, 1);
  assert.deepEqual(await handleMessage(e, body, NOW), { skip: 'handled' });
  assert.equal(Object.keys((await tasks(e)).items).length, 1);
});

test('a task already in the list (handled row lost) is not made twice', async () => {
  const e = env();
  await post(e, vacancy());
  const body = e.HUB_QUEUE.sent[0].body;
  await handleMessage(e, body, NOW);
  e.HUB_DB.db.exec('DELETE FROM handled');
  assert.deepEqual(await handleMessage(e, body, NOW), { skip: 'already there' });
  assert.equal(Object.keys((await tasks(e)).items).length, 1);
});

test('consume: a failure retries the message and writes no handled row', async () => {
  const e = env({ TODO_CODE: undefined });
  await post(e, vacancy());
  const calls = [];
  const msg = { body: e.HUB_QUEUE.sent[0].body, attempts: 2, ack: () => calls.push('ack'), retry: (o) => calls.push('retry ' + o.delaySeconds) };
  await consume({ messages: [msg] }, e);
  assert.deepEqual(calls, ['retry 60']);
  assert.equal(e.HUB_DB.db.prepare('SELECT COUNT(*) AS n FROM handled').get().n, 0);
  e.TODO_CODE = CODE;
  await consume({ messages: [msg] }, e);
  assert.deepEqual(calls, ['retry 60', 'ack']);
});

test('an old one-line event still works with EVENT_TOKEN', async () => {
  const e = env();
  const r = await post(e, { source: 'pc', text: 'Weekly backup done' }, 'event-token');
  assert.equal(r.status, 200);
  assert.equal(e.HUB_DB.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('to-do link: http(s) only; an upsert without link keeps it, null removes it', () => {
  assert.equal(cleanLink('https://example.org/a b'), 'https://example.org/a%20b');
  assert.equal(cleanLink('ftp://example.org'), null);
  assert.equal(cleanLink('javascript:alert(1)'), null);
  const base = { id: 'aaaaaaaa', text: 'Apply: x', section: 'soon', done: false, doneAt: null, pos: NOW - 5000 };
  assert.equal(cleanOp({ op: 'upsert', item: { ...base, link: 'nope', updatedAt: NOW - 4000 } }, NOW), null);
  const doc = emptyDoc();
  applyOps(doc, [cleanOp({ op: 'upsert', item: { ...base, link: 'https://example.org/1', updatedAt: NOW - 4000 } }, NOW)]);
  applyOps(doc, [cleanOp({ op: 'upsert', item: { ...base, done: true, doneAt: NOW - 3000, updatedAt: NOW - 3000 } }, NOW)]);
  assert.equal(doc.items.aaaaaaaa.done, true);
  assert.equal(doc.items.aaaaaaaa.link, 'https://example.org/1');
  applyOps(doc, [cleanOp({ op: 'upsert', item: { ...base, link: null, updatedAt: NOW - 2000 } }, NOW)]);
  assert.equal('link' in doc.items.aaaaaaaa, false);
});
