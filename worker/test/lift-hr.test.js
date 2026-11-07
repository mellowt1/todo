import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSamples, mergeSamples } from '../src/lift-hr.js';
import { handleLift } from '../src/lift.js';

const CODE = 'abcdefgh23456789';
const NOW = Date.parse('2026-11-07T12:00:00Z');
const memKV = () => {
  const m = new Map();
  return { m, async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); } };
};
const json = (data, request, status = 200) => Response.json(data, { status });
const call = (e, path, method = 'GET', body) => handleLift(new Request('https://x/api/lift/' + path, { method, body }), e, path.split('?')[0].split('/'), json, NOW);

test('Shortcut lines read: ISO with offset, semicolon/comma/tab, units, junk skipped', () => {
  const s = parseSamples('2026-11-07T12:30:00+01:00;92\n2026-11-07 11:31:00Z,101.4\n2026-11-07T11:32:00Z\t130 count/min\nnot a line\n2026-11-07T11:33:00Z;300\n2026-11-07T11:34:00Z;12', NOW);
  assert.deepEqual(s, [[Date.parse('2026-11-07T11:30:00Z'), 92], [Date.parse('2026-11-07T11:31:00Z'), 101], [Date.parse('2026-11-07T11:32:00Z'), 130]]);
  assert.deepEqual(parseSamples({ lines: '2026-11-07T11:30:00Z;80' }, NOW), [[Date.parse('2026-11-07T11:30:00Z'), 80]]);
  assert.deepEqual(parseSamples({ samples: [[NOW - 1000, 77], [NOW + 2 * 3600e3, 77]] }, NOW), [[NOW - 1000, 77]], 'nothing from the future');
});

test('merge keeps one sample per second, newest wins, sorted', () => {
  assert.deepEqual(mergeSamples([[2000, 90], [1000, 80]], [[2000, 95], [500, 70]]), [[500, 70], [1000, 80], [2000, 95]]);
});

test('POST then GET a window; posting twice does not double; samples split by UTC day', async () => {
  const e = { TODO_CODE: CODE, HUB_KV: memKV() };
  const text = ['2026-11-06T23:59:30Z;88', '2026-11-07T00:00:30Z;99', '2026-11-07T11:00:00Z;120'].join('\n');
  let r = await call(e, CODE + '/hr', 'POST', text);
  assert.deepEqual(await r.json(), { ok: true, added: 3, days: 2 });
  await call(e, CODE + '/hr', 'POST', text);
  assert.equal(JSON.parse(e.HUB_KV.m.get('lift:hr:2026-11-07')).length, 2);
  r = await call(e, `${CODE}/hr?from=${Date.parse('2026-11-06T23:00:00Z')}&to=${Date.parse('2026-11-07T01:00:00Z')}`);
  const out = await r.json();
  assert.deepEqual(out.samples.map((s) => s[1]), [88, 99]);
  assert.ok(out.at);
});

test('bad input: empty post 400, wide window 400, wrong code 404', async () => {
  const e = { TODO_CODE: CODE, HUB_KV: memKV() };
  assert.equal((await call(e, CODE + '/hr', 'POST', 'hello')).status, 400);
  assert.equal((await call(e, `${CODE}/hr?from=0&to=${2 * 86400000}`)).status, 400);
  assert.equal((await call(e, 'zzzzzzzzzzzzzzzz/hr', 'POST', '2026-11-07T11:00:00Z;120')).status, 404);
});
