// Apply: an Apply task is queued from To-do and prepared on the PC. No network: the writer is
// swapped. Every name and CV line here is made up.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { _setApplier, postingFromHtml, toDraft, decode, CVS_KEY, QUEUE_KEY } from '../src/apply.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const PC = 'pc-token-for-tests';
const NOW = Date.parse('2026-10-17T08:30:00Z');
const memKV = () => { const m = new Map(); return { m, async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); }, async list() { return { keys: [] }; } }; };
const CVS = { versions: [
  { key: 'defensie', label: 'Defensie', lang: 'nl', text: 'Test Person. Controller bij een ministerie.' },
  { key: 'en', label: 'English master', lang: 'en', text: 'Test Person. Controller.' },
] };
const env = (over = {}) => {
  const kv = memKV();
  kv.m.set(CVS_KEY, JSON.stringify(CVS));
  return { TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: kv, ANTHROPIC_API_KEY: 'k', APPLY_PC_TOKEN: PC, ...over };
};
const call = (e, path, init = {}) => worker.fetch(new Request('https://hub.example/api/' + path, init), e);
const post = (e, path, body, token) => call(e, path, { method: 'POST', body: body === undefined ? '' : JSON.stringify(body), headers: token ? { Authorization: 'Bearer ' + token } : {} });
const pcGet = (e, path, token = PC) => call(e, path, { headers: { Authorization: 'Bearer ' + token } });
const task = (id, text, link, over = {}) => ({ op: 'upsert', item: { id, text, section: 'soon', done: false, doneAt: null, updatedAt: NOW, pos: NOW, ...(link ? { link } : {}), ...over } });
const seed = (e, ...ops) => post(e, `todo/${CODE}/ops`, { ops });

const LONG = 'Wat ga je doen? Je plant opleidingen en bewaakt de voortgang. '.repeat(12);
const PAGE = `<html><head><title>Planner | Werken</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Planner opleidingen","hiringOrganization":{"@type":"Organization","name":"Werken bij Defensie"},"description":"<p>${LONG}</p><ul><li>HAVO</li></ul>"}
,"extra":1</script></head><body>menu</body></html>`;
const OUT = { cv: 'defensie', fit: 7.4, fit_line: 'Strong on planning — light on training.', gaps: ['No HAVO listed — mention it', 'b', 'c', 'd'], asks: ['CV', 'Motivation letter'], deadline: '2026-11-01', lang: 'nl', letter: 'Geachte heer/mevrouw,\n\nIk solliciteer — graag.\n\nMet vriendelijke groet,\nPaul' };

afterEach(() => _setApplier(null));

test('postingFromHtml: JobPosting data first, junk after the JSON tolerated; plain text otherwise', () => {
  const p = postingFromHtml(PAGE);
  assert.deepEqual([p.title, p.organisation], ['Planner opleidingen', 'Defensie']);
  assert.ok(p.text.startsWith('Wat ga je doen?') && p.text.includes('- HAVO'));
  const q = postingFromHtml('<title>A &amp; B</title><script>x()</script><p>Hello <b>there</b></p>');
  assert.deepEqual([q.title, q.text], ['A & B', 'A & B Hello there']);
  assert.equal(decode('&#13;&euro;&#x41;&nbsp;'), '\r&euro;A ');
});

test('toDraft: fit clamped, three gaps, no dashes, asks and deadline kept, bad date dropped', () => {
  const d = toDraft(OUT, CVS.versions, { title: 'Planner', organisation: 'Defensie' }, { url: 'https://x.nl/v', now: NOW, examples: 2 });
  assert.deepEqual([d.fit, d.cvLabel, d.gaps.length, d.gaps[0], d.deadline, d.examples], [7, 'Defensie', 3, 'No HAVO listed, mention it', '2026-11-01', 2]);
  assert.deepEqual(d.asks, ['CV', 'Motivation letter']);
  assert.equal(d.letter, 'Geachte heer/mevrouw,\n\nIk solliciteer, graag.\n\nMet vriendelijke groet,\nPaul');
  assert.equal(toDraft({ ...OUT, cv: 'nope', fit: 40, deadline: 'soon' }, CVS.versions, {}, { now: NOW }).deadline, null);
});

test('the whole round: queue from To-do, the PC takes it, drafts with past letters, reports the folder', async () => {
  const e = env();
  await seed(e, task('apply0000001', 'Apply: Planner (Defensie) · 2026-11-01', 'https://werk.example/vacature/1'), task('apply0000002', 'Apply: Other (X)', 'https://werk.example/2'));
  assert.deepEqual(await (await call(e, `apply/${CODE}/apply0000001`)).json(), { state: 'none' });

  let r = await post(e, `apply/${CODE}/apply0000001`, {}, null, NOW);
  assert.equal((await r.json()).state, 'queued');
  await post(e, `apply/${CODE}/apply0000001`); // twice: still one in the queue
  assert.deepEqual(JSON.parse(e.HUB_KV.m.get(QUEUE_KEY)), ['apply0000001']);

  const q = await (await pcGet(e, 'apply/pc/queue')).json();
  assert.deepEqual(q.jobs.map((j) => [j.taskId, j.link]), [['apply0000001', 'https://werk.example/vacature/1']]);

  let seen;
  _setApplier(async (_env, x) => { seen = x; return { out: OUT, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }; });
  r = await post(e, 'apply/pc/apply0000001/draft', { text: LONG, title: 'Planner', organisation: 'Defensie', examples: ['Geachte heer, oud.', '', 'Tweede brief.', 'Derde.'] }, PC);
  assert.equal(r.status, 200);
  assert.deepEqual(seen.examples, ['Geachte heer, oud.', 'Tweede brief.']);
  assert.equal(seen.posting.organisation, 'Defensie');
  assert.equal((await r.json()).draft.fit, 7);
  assert.equal((await (await call(e, `apply/${CODE}/apply0000001`)).json()).state, 'queued');

  r = await post(e, 'apply/pc/apply0000001/ready', { folder: 'C:\\Apps\\2026-10-17 Defensie - Planner' }, PC);
  assert.deepEqual(await r.json(), { state: 'ready' });
  const s = await (await call(e, `apply/${CODE}/apply0000001`)).json();
  assert.deepEqual([s.state, s.folder, s.draft.cvLabel], ['ready', 'C:\\Apps\\2026-10-17 Defensie - Planner', 'Defensie']);
  assert.deepEqual(JSON.parse(e.HUB_KV.m.get(QUEUE_KEY)), []);
  assert.deepEqual((await (await pcGet(e, 'apply/pc/queue')).json()).jobs, []);
  assert.ok([...e.HUB_KV.m.keys()].some((k) => k.startsWith('event:')), 'a line on the feed');
  assert.ok([...e.HUB_KV.m.keys()].some((k) => k.startsWith('apply:usage:')));

  // Queued again from a ready one: back in the queue for a new folder.
  assert.equal((await (await post(e, `apply/${CODE}/apply0000001`)).json()).state, 'queued');
});

test('refused: PC token, order of steps, short text, ordinary and done tasks, no CVs, unknown code', async () => {
  const e = env();
  await seed(e, task('apply0000003', 'Apply: Y', 'https://werk.example/3'), task('plain0000001', 'Buy milk'), task('apply0000004', 'Apply: Done', 'https://w/4', { done: true, doneAt: NOW }));
  assert.equal((await pcGet(e, 'apply/pc/queue', 'wrong')).status, 401);
  assert.equal((await pcGet(env({ APPLY_PC_TOKEN: undefined }), 'apply/pc/queue', 'x')).status, 401);
  assert.equal((await post(e, 'apply/pc/apply0000003/draft', { text: LONG }, PC)).status, 409, 'not queued yet');
  await post(e, `apply/${CODE}/apply0000003`);
  assert.equal((await post(e, 'apply/pc/apply0000003/ready', { folder: 'x' }, PC)).status, 409, 'no draft yet');
  assert.equal((await post(e, 'apply/pc/apply0000003/draft', { text: 'short' }, PC)).status, 400);
  _setApplier(async () => ({ error: 'could not write a draft' }));
  assert.equal((await post(e, 'apply/pc/apply0000003/draft', { text: LONG }, PC)).status, 502);
  assert.equal((await post(e, `apply/${CODE}/plain0000001`)).status, 404);
  assert.equal((await post(e, `apply/${CODE}/apply0000004`)).status, 404);
  assert.equal((await post(e, `apply/${CODE}/BAD`)).status, 400);
  assert.equal((await post(e, 'apply/zzzzzzzzzzzzzzzz/apply0000003')).status, 404);
  const bare = env();
  bare.HUB_KV.m.delete(CVS_KEY);
  await seed(bare, task('apply0000005', 'Apply: Z', 'https://w/5'));
  await post(bare, `apply/${CODE}/apply0000005`);
  assert.equal((await post(bare, 'apply/pc/apply0000005/draft', { text: LONG }, PC)).status, 503);
});
