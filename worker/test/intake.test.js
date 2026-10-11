import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { memNamespace } from './mem.js';
import { toOps, cleanInput, Record, _setReader, dayOf } from '../src/intake.js';

const CODE = 'abcdefgh23456789';
const BASE = 'https://paul-hub.example.workers.dev';

function memKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
  };
}

function makeEnv(over = {}) {
  return { TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: memKV(), ANTHROPIC_API_KEY: 'test-key', ...over };
}

const call = (env, path, init = {}) => worker.fetch(new Request(BASE + path, init), env);
const post = (env, body) => call(env, `/api/intake/${CODE}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://mellowt1.github.io' },
  body: JSON.stringify(body),
});
const PDF = 'JVBERi0xLjQK'; // "%PDF-1.4\n" in base64, enough for the shape

const today = dayOf(Date.now());
const plus = (days) => {
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const record = (over = {}) => ({
  readable: true, who: 'me', kind: 'letter', summary: 'A letter that wants a reply.',
  deadline: plus(10), amount: { value: 120.5, currency: 'EUR' },
  actions: [{ text: 'Reply to the letter', due: plus(10) }, { text: 'Pay the amount', due: plus(1) }, { text: 'File it', due: null }],
  needs_paul: true, quotes: ['uiterlijk ' + plus(10)], note: null, ...over,
});

afterEach(() => _setReader(null));

test('the record schema accepts a good record and refuses a bad one', () => {
  assert.ok(Record.safeParse(record()).success);
  assert.equal(Record.safeParse(record({ who: 'auntie' })).success, false);
  assert.equal(Record.safeParse(record({ summary: 'x'.repeat(161) })).success, false);
});

test('toOps: section follows the due date, text carries the date and the [intake] mark', () => {
  const now = Date.now();
  let n = 0;
  const ops = toOps(record(), now, () => 'id' + String(n++).padStart(6, '0'));
  assert.equal(ops.length, 3);
  assert.equal(ops[0].item.section, 'soon');
  assert.equal(ops[0].item.text, `Reply to the letter · ${plus(10)} [intake]`);
  assert.equal(ops[1].item.section, 'today');
  assert.equal(ops[2].item.section, 'soon'); // no date, but Paul has to act
  assert.equal(ops[2].item.text, 'File it [intake]');
  for (const o of ops) {
    assert.equal(o.op, 'upsert');
    assert.equal(o.item.done, false);
    assert.equal(o.item.updatedAt, now);
  }
});

test('toOps: nothing from an unreadable record, someday when nothing is urgent', () => {
  assert.deepEqual(toOps(record({ readable: false })), []);
  const ops = toOps(record({ needs_paul: false, actions: [{ text: 'Check the refund arrives', due: null }, { text: 'Far away', due: plus(40) }] }));
  assert.equal(ops[0].item.section, 'someday');
  assert.equal(ops[1].item.section, 'someday');
});

test('cleanInput: media types, base64 and limits', () => {
  assert.equal(cleanInput({}).status, 400);
  assert.equal(cleanInput({ files: [{ media_type: 'text/plain', data: PDF }] }).status, 400);
  assert.equal(cleanInput({ files: [{ media_type: 'application/pdf', data: 'not base64!' }] }).status, 400);
  assert.equal(cleanInput({ files: Array(11).fill({ media_type: 'application/pdf', data: PDF }) }).status, 400);
  const ok = cleanInput({ files: [{ name: 'a.pdf', media_type: 'application/pdf', data: PDF }], text: '  hi ' });
  assert.equal(ok.files.length, 1);
  assert.equal(ok.text, 'hi');
});

test('POST: reads, writes the tasks into the list, keeps the record, counts usage', async () => {
  const env = makeEnv();
  const seen = [];
  _setReader(async (e, input) => {
    seen.push(input);
    return { record: record(), usage: { model: 'claude-opus-5-5', input: 1000, output: 200, cacheRead: 0, cacheWrite: 900 } };
  });
  const r = await post(env, { files: [{ name: 'brief.pdf', media_type: 'application/pdf', data: PDF }] });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.tasks.length, 3);
  assert.equal(out.record.who, 'me');
  assert.equal(seen[0].files[0].media_type, 'application/pdf');
  assert.equal(seen[0].today, today);

  const list = await (await call(env, `/api/todo/${CODE}`)).json();
  assert.equal(list.items.length, 3);
  assert.ok(list.items.every((i) => i.text.endsWith('[intake]')));

  const keys = [...env.HUB_KV.m.keys()];
  assert.equal(keys.filter((k) => k.startsWith('intake:r:')).length, 1);
  assert.equal(keys.filter((k) => k.startsWith('intake:hash:')).length, 1);
  const usage = JSON.parse(env.HUB_KV.m.get('intake:usage:' + today.slice(0, 7)));
  assert.equal(usage.calls, 1);
  assert.equal(usage.input, 1000);
  // The file itself is nowhere in KV.
  assert.ok(keys.every((k) => !env.HUB_KV.m.get(k).includes(PDF)));

  const got = await (await call(env, `/api/intake/${CODE}?limit=5`)).json();
  assert.equal(got.items.length, 1);
  assert.equal(got.items[0].tasks.length, 3);
});

test('POST: the same file twice is a duplicate and writes nothing new', async () => {
  const env = makeEnv();
  let calls = 0;
  _setReader(async () => { calls++; return { record: record(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }; });
  const body = { files: [{ name: 'brief.pdf', media_type: 'application/pdf', data: PDF }] };
  await post(env, body);
  const r = await post(env, body);
  const out = await r.json();
  assert.equal(out.duplicate, true);
  assert.equal(out.tasks.length, 3);
  assert.equal(calls, 1);
  assert.equal((await (await call(env, `/api/todo/${CODE}`)).json()).items.length, 3);
});

test('POST: a refusal or an unreadable page makes no task', async () => {
  const env = makeEnv();
  _setReader(async () => ({ error: 'refused', detail: 'general_harms', usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  let r = await post(env, { text: 'something' });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, 'refused');

  _setReader(async () => ({ record: record({ readable: false, actions: [], note: 'Page is dark.' }), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
  r = await post(env, { files: [{ media_type: 'image/jpeg', data: PDF }] });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.tasks.length, 0);
  assert.equal(out.record.readable, false);
  assert.equal((await (await call(env, `/api/todo/${CODE}`)).json()).items.length, 0);
});

test('guards: wrong code, no key, bad input', async () => {
  _setReader(async () => { throw new Error('must not be called'); });
  const env = makeEnv();
  assert.equal((await call(env, '/api/intake/abcdefgh2345678x', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await call(env, '/api/intake/short', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await post(env, {})).status, 400);
  assert.equal((await post(env, { files: [{ media_type: 'text/plain', data: PDF }] })).status, 400);
  assert.equal((await post(makeEnv({ ANTHROPIC_API_KEY: undefined }), { text: 'x' })).status, 503);
});
