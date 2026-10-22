// The Skills gap tracker (wave 2 Phase 2): Paul's side read from CV Studio blocks, a vacancy read and
// checked with Claude mocked, a Have that names no line of his side turned into Missing, gaps ranked,
// steps into To-do, closing and reopening, past roles, and no vacancy or side text in any hub event.
// D1 is node:sqlite running every migration, the list is the real Durable Object in memory, the queue
// runs through the hub's own consumer. Every vacancy and every line here is made up.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { handleMessage } from '../src/hub.js';
import { keyOf, sideLines, fromApplyTask, settleMatches, gapsFrom, skillsCron, _setClaude, PAGE, READ_PROMPT, MATCH_PROMPT, OPTIONS_PROMPT } from '../src/skills.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const NOW = Date.parse('2026-10-22T10:00:00Z');
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
    async batch(stmts) { for (const s of stmts) await s.run(); },
  };
}
function memKV() {
  const m = new Map();
  return { m, async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); }, async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }; } };
}
function env() {
  const q = [];
  return { q, HUB_DB: memD1(), HUB_KV: memKV(), HUB_QUEUE: { async send(b) { q.push(b); }, async sendBatch(ms) { for (const m of ms) q.push(m.body); } }, TODO_LIST: memNamespace(), TODO_CODE: CODE, ANTHROPIC_API_KEY: 'test' };
}
async function drain(e, ms = NOW) {
  const out = [];
  while (e.q.length) { const m = e.q.shift(); if (m.target === 'skills') out.push(await handleMessage(e, m, ms)); }
  return out;
}
async function at(ms, fn) { const real = Date.now; Date.now = () => ms; try { return await fn(); } finally { Date.now = real; } }
async function call(e, method, path, body, ms = NOW) {
  return at(ms, async () => {
    const r = await worker.fetch(new Request('https://hub.test/api/skills/' + CODE + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }), e);
    return { status: r.status, body: await r.json() };
  });
}
const get = (e, path = '', ms) => call(e, 'GET', path, undefined, ms);
const post = (e, path, body, ms) => call(e, 'POST', path, body, ms);
const stub = (e) => e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
const list = async (e) => (await (await stub(e).fetch('https://list/export')).json());
const events = (e) => e.HUB_DB.db.prepare('SELECT source, type, summary, payload FROM events ORDER BY rowid').all();

const JOB = 'Wat ga je doen? Als beleidsmedewerker internationale samenwerking werk je aan verdragen met partnerlanden. ' +
  'Wat vragen wij? Een masteropleiding, minimaal drie jaar ervaring met beleid in een internationale omgeving, Engels op C1 niveau, ' +
  'Frans is een pré. Je bent bereid een screening op niveau A te ondergaan. FAKEVACANCYWORD staat in deze tekst. ' +
  'Wat bieden wij? Een plek in een klein team in Den Haag, ruimte om te leren en een salaris volgens schaal 11. Solliciteren kan tot en met de sluitingsdatum.';
let calls;
const READS = {
  'Beleidsmedewerker internationale samenwerking': [
    { kind: 'qualification', label: "Master's degree", must: true },
    { kind: 'experience', label: '3+ years international policy work', must: true },
    { kind: 'language', label: 'English C1', must: true },
    { kind: 'language', label: 'French B2', must: false },
    { kind: 'clearance', label: 'Screening level A', must: true },
    { kind: 'language', label: 'english c1', must: true },          // the same label twice
    { kind: 'hobby', label: 'Sailing', must: true },                 // not a kind
  ],
  'Policy Officer, Defence Industry': [
    { kind: 'language', label: 'French B2', must: true },
    { kind: 'clearance', label: 'Screening level A', must: true },
    { kind: 'skill', label: 'Programme management', must: false },
  ],
};
beforeEach(() => {
  calls = { read: [], match: [], options: [] };
  _setClaude({
    read: async (e, text, labels) => { calls.read.push({ text, labels }); const title = Object.keys(READS).find((t) => text.includes(t.split(' ')[0])) || 'Beleidsmedewerker internationale samenwerking'; return { requirements: READS[title] }; },
    match: async (e, reqs, lines) => {
      calls.match.push({ reqs, lines });
      return { matches: reqs.map((r) => (/master/i.test(r.label) ? { label: r.label, status: 'have', line: 'l2', why: 'The degree line' }
        : /english/i.test(r.label) ? { label: r.label, status: 'have', line: 'l99', why: 'made up' }                  // a line that is not his
        : /policy/i.test(r.label) ? { label: r.label, status: 'partly', line: 'l1', why: 'Two years, not three' }
        : { label: r.label, status: 'missing', line: null, why: null })) };
    },
    options: async (e, label, roles) => { calls.options.push({ label, roles }); return { options: [{ title: 'A course', text: 'One evening a week, check the dates.' }, { title: 'An exam date', text: 'Pick one to aim at.' }] }; },
  });
});
afterEach(() => _setClaude(null));

test('labels made comparable, prompts as shown to Paul', () => {
  assert.equal(keyOf('French (B2)'), 'french-b2');
  assert.equal(keyOf('Één Master’s degree!'), 'een-master-s-degree');
  assert.equal(keyOf('  3+ years international policy work '), '3-years-international-policy-work');
  assert.match(READ_PROMPT, /Only what the vacancy states: no guesses, no advice\.$/);
  assert.match(MATCH_PROMPT, /Never assume anything not written in the lines\./);
  assert.match(OPTIONS_PROMPT, /write 'check' where a detail must be looked up\.$/);
});

test("his side: CV Studio's blocks as JSON, or text; never contact details, the header or references", () => {
  const json = JSON.stringify({ blocks: {
    h: { kind: 'header', data: { name: 'P. Example', contact: 'p@example.org · +31 6 12345678' } },
    p: { kind: 'profile', data: { text: 'Made-up profile line about trade policy.' } },
    j: { kind: 'job', data: { role: 'Advisor', org: 'Example Agency', dates: '2021 to now', detail: 'Trade missions', bullets: ['Led example missions', 'Wrote example notes'] } },
    e: { kind: 'education', data: { degree: 'MA Example Studies', school: 'Example University', dates: '2015' } },
    l: { kind: 'languages', data: { items: ['Dutch, native', 'English, C1'] } },
    r: { kind: 'references', data: { items: ['On request'] } },
  } });
  assert.deepEqual(sideLines(json).lines, [
    'Made-up profile line about trade policy.',
    'Advisor, Example Agency (2021 to now): Trade missions',
    'Advisor, Example Agency: Led example missions',
    'Advisor, Example Agency: Wrote example notes',
    'MA Example Studies, Example University (2015)',
    'Language: Dutch, native',
    'Language: English, C1',
  ]);
  const text = 'PROFILE\n- Made-up line one\n• Made-up line two\n\nmail@example.org\n+31 6 1234 5678\nMade-up line one\nok';
  assert.deepEqual(sideLines(text).lines, ['PROFILE', 'Made-up line one', 'Made-up line two']);
  assert.match(sideLines('').error, /paste/);
  assert.match(sideLines('a'.repeat(60001)).error, /at most/);
});

test('an Apply task names the role', () => {
  assert.deepEqual(fromApplyTask('Apply: Policy officer (Ministry of Defence) · 2026-11-04'), { title: 'Policy officer', org: 'Ministry of Defence', deadline: '2026-11-04' });
  assert.deepEqual(fromApplyTask('Apply for nato position'), { title: 'nato position', org: null, deadline: null });
  assert.deepEqual(fromApplyTask('Solliciteren: Adviseur (RVO) [intake]'), { title: 'Adviseur', org: 'RVO', deadline: null });
  assert.equal(fromApplyTask('Buy milk'), null);
});

test('a Have or Partly must name a line of his side; closed gaps are Have', () => {
  const reqs = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }, { key: 'd', label: 'D' }];
  const out = settleMatches(reqs, [
    { label: 'A', status: 'have', line: 'l1', why: 'x' },
    { label: 'B', status: 'partly', line: 'l9', why: 'not his' },
    { label: 'C', status: 'missing', line: 'l1', why: 'no line' },
  ], new Set(['l1']), { d: 'cX' });
  assert.deepEqual(out.map((q) => [q.key, q.status, q.line_id]), [['a', 'have', 'l1'], ['b', 'missing', null], ['c', 'missing', null], ['d', 'have', 'cX']]);
});

test('the route: the code, an empty start', async () => {
  const e = env();
  assert.equal((await at(NOW, () => worker.fetch(new Request('https://hub.test/api/skills/short'), e))).status, 400);
  assert.equal((await at(NOW, () => worker.fetch(new Request('https://hub.test/api/skills/zzzzzzzzzzzzzzzz'), e))).status, 404);
  const { body } = await get(e);
  assert.deepEqual(body, { today: '2026-10-22', side: { lines: 0, closed: 0, updatedAt: null }, roles: [], gaps: [] });
  assert.equal((await post(e, '/nope', {})).status, 404);
});

test('a pasted job is read on the queue; with no side yet everything is unknown and Claude is not asked to match', async () => {
  const e = env();
  assert.equal((await post(e, '/role', { title: 'x', text: 'too short' })).status, 400);
  assert.equal((await post(e, '/role', { text: JOB })).status, 400);
  const r = await post(e, '/role', { title: 'Beleidsmedewerker internationale samenwerking', org: 'Ministerie van Defensie', text: JOB });
  assert.equal(r.status, 200);
  assert.equal(r.body.role.state, 'reading');
  assert.equal(e.q.length, 1);
  assert.equal(e.q[0].type, 'skills.read');
  await drain(e);
  assert.equal(calls.read.length, 1);
  assert.match(calls.read[0].text, /FAKEVACANCYWORD/);
  assert.equal(calls.match.length, 0);
  const { body } = await get(e);
  const role = body.roles[0];
  assert.equal(role.state, 'ready');
  assert.deepEqual(role.reqs.map((q) => [q.key, q.kind, q.must, q.status]), [
    ['master-s-degree', 'qualification', true, 'unknown'], ['3-years-international-policy-work', 'experience', true, 'unknown'],
    ['english-c1', 'language', true, 'unknown'], ['french-b2', 'language', false, 'unknown'], ['screening-level-a', 'clearance', true, 'unknown'],
  ]);
  assert.deepEqual(role.counts, { have: 0, partly: 0, missing: 0, unknown: 5 });
  assert.deepEqual(body.gaps, [], 'nothing is a gap until his side is in');
});

test('his side in: every role is checked again; a made-up line becomes Missing; gaps rank must-haves first', async () => {
  const e = env();
  await post(e, '/role', { title: 'Beleidsmedewerker internationale samenwerking', org: 'Ministerie van Defensie', text: JOB });
  await post(e, '/role', { title: 'Policy Officer, Defence Industry', org: 'European Defence Agency', text: 'Policy Officer vacancy. ' + JOB });
  await drain(e);
  const side = await post(e, '/side', { text: 'Made-up line about two years of policy work\nMade-up MA degree line\nMade-up language line' });
  assert.deepEqual(side.body, { lines: 3, rechecks: 2 });
  await drain(e);
  assert.equal(calls.match.length, 2);
  assert.deepEqual(calls.match[0].lines.map((l) => l.id), ['l1', 'l2', 'l3']);
  const { body } = await get(e);
  const beleid = body.roles.find((r) => r.title.startsWith('Beleid'));
  const by = Object.fromEntries(beleid.reqs.map((q) => [q.key, q]));
  assert.equal(by['master-s-degree'].status, 'have');
  assert.deepEqual(by['master-s-degree'].line, { id: 'l2', text: 'Made-up MA degree line', source: 'cv' });
  assert.equal(by['english-c1'].status, 'missing', 'Claude named a line that is not his');
  assert.equal(by['english-c1'].line, null);
  assert.equal(by['3-years-international-policy-work'].status, 'partly');
  assert.deepEqual(beleid.counts, { have: 1, partly: 1, missing: 3, unknown: 0 });
  assert.equal(body.side.lines, 3);
  assert.deepEqual(body.gaps.map((g) => [g.key, g.must, g.total, g.worst, g.state]), [
    ['screening-level-a', 2, 2, 'missing', 'open'],
    ['french-b2', 1, 2, 'missing', 'open'],
    ['english-c1', 1, 1, 'missing', 'open'],
    ['3-years-international-policy-work', 1, 1, 'partly', 'open'],
    ['programme-management', 0, 1, 'missing', 'open'],
  ]);
  assert.equal(body.gaps[0].active, 2);
  // The second read was told the labels the first one used.
  assert.ok(calls.read[1].labels.includes('French B2'));
});

test('Track this role: from an Apply task, the page read once, then the same role every time', async () => {
  const e = env();
  const now = Date.now();
  const item = { id: 'applytask0001', text: 'Apply: Beleidsmedewerker internationale samenwerking (Ministerie van Defensie) · 2026-11-04', section: 'soon', done: false, doneAt: null, updatedAt: now, pos: now, link: 'https://www.werkenvoornederland.nl/vacatures/example' };
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'upsert', item }] }) });
  const realFetch = globalThis.fetch;
  let fetched = [];
  globalThis.fetch = async (url) => { fetched.push(String(url)); return new Response('<html><script type="application/ld+json">' + JSON.stringify({ '@type': 'JobPosting', title: 'Beleidsmedewerker', description: '<p>' + JOB + '</p>' }) + '</script></html>', { status: 200 }); };
  try {
    assert.equal((await get(e, '/track/applytask0001')).body.role, null);
    const r = await post(e, '/track', { taskId: 'applytask0001' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.role.title, r.body.role.org, r.body.role.deadline, r.body.role.source, r.body.role.taskId], ['Beleidsmedewerker internationale samenwerking', 'Ministerie van Defensie', '2026-11-04', 'digest', 'applytask0001']);
    await drain(e);
    assert.deepEqual(fetched, ['https://www.werkenvoornederland.nl/vacatures/example']);
    assert.match(calls.read[0].text, /FAKEVACANCYWORD/);
    const again = await post(e, '/track', { taskId: 'applytask0001' });
    assert.equal(again.body.role.id, r.body.role.id);
    assert.equal(e.q.length, 0, 'tracking twice reads once');
    assert.equal((await get(e, '/track/applytask0001')).body.role.state, 'ready');
    assert.equal((await post(e, '/track', { taskId: 'notatask0001' })).status, 404);
  } finally { globalThis.fetch = realFetch; }
});

test('a page that cannot be read asks for the text; a failure from Claude is kept, and Check again tries once more', async () => {
  const e = env();
  const now = Date.now();
  const item = { id: 'applytask0002', text: 'Apply: Procurement Officer (NSPA)', section: 'soon', done: false, doneAt: null, updatedAt: now, pos: now, link: 'https://example.org/jobs/1' };
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'upsert', item }] }) });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html><body><div id="app"></div></body></html>', { status: 200 });
  try {
    const r = await post(e, '/track', { taskId: 'applytask0002' });
    await drain(e);
    let role = (await get(e)).body.roles[0];
    assert.equal(role.state, 'needs_text');
    assert.equal(calls.read.length, 0, 'no Claude call without a vacancy');
    assert.equal((await post(e, '/role/' + r.body.role.id + '/text', { text: 'short' })).status, 400);
    _setClaude({ read: async () => { throw new Error('overloaded'); } });
    await post(e, '/role/' + r.body.role.id + '/text', { text: JOB });
    await drain(e);
    role = (await get(e)).body.roles[0];
    assert.equal(role.state, 'failed');
    assert.match(role.error, /overloaded/);
    _setClaude({ read: async () => ({ requirements: READS['Policy Officer, Defence Industry'] }) });
    await post(e, '/role/' + r.body.role.id + '/recheck', {});
    await drain(e);
    role = (await get(e)).body.roles[0];
    assert.equal(role.state, 'ready');
    assert.equal(role.reqs.length, 3);
  } finally { globalThis.fetch = realFetch; }
});

test('a gap: steps, a step into To-do, options from Claude, closed in his words, reopened', async () => {
  const e = env();
  await post(e, '/role', { title: 'Beleidsmedewerker internationale samenwerking', text: JOB });
  await post(e, '/role', { title: 'Policy Officer, Defence Industry', org: 'European Defence Agency', text: 'Policy Officer vacancy. ' + JOB });
  await drain(e);
  await post(e, '/side', { text: 'Made-up line one\nMade-up MA degree line' });
  await drain(e);
  assert.equal((await post(e, '/gap/no-such-gap/step', { text: 'x' })).status, 404);
  let g = (await post(e, '/gap/french-b2/step', { text: 'Find an evening course' })).body.gap;
  assert.equal(g.state, 'working');
  const sid = g.steps[0].id;
  const t = await post(e, '/gap/french-b2/step/' + sid + '/task', {});
  assert.equal(t.status, 200);
  const it = (await list(e)).items[t.body.task.id];
  assert.deepEqual([it.text, it.section, it.energy, it.link], ['Find an evening course', 'soon', 'normal', PAGE + '?g=french-b2']);
  assert.equal(t.body.gap.steps[0].taskId, t.body.task.id);
  assert.equal((await post(e, '/gap/french-b2/step/' + sid + '/task', {})).status, 409);
  g = (await post(e, '/gap/french-b2/options', {})).body.gap;
  assert.deepEqual(g.options.map((o) => o.title), ['A course', 'An exam date']);
  assert.equal(calls.options[0].label, 'French B2');
  assert.equal(calls.options[0].roles.length, 2);
  assert.equal((await post(e, '/gap/french-b2/close', {})).status, 400);
  g = (await post(e, '/gap/french-b2/close', { note: 'Passed a made-up exam' })).body.gap;
  assert.equal(g.state, 'closed');
  assert.equal(g.closedNote, 'Passed a made-up exam');
  let all = (await get(e)).body;
  for (const r of all.roles) assert.equal(r.reqs.find((q) => q.key === 'french-b2').status, 'have');
  assert.equal(all.roles[0].reqs.find((q) => q.key === 'french-b2').line.source, 'closed');
  assert.equal(all.side.closed, 1);
  assert.equal(all.gaps.at(-1).key, 'french-b2', 'closed gaps come last');
  const sideList = (await get(e, '/side')).body.lines;
  assert.deepEqual(sideList.at(-1), { id: sideList.at(-1).id, text: 'French B2: Passed a made-up exam', source: 'closed', gap: 'french-b2' });
  // A later check keeps it Have, whatever Claude says.
  await post(e, '/role/' + all.roles[0].id + '/recheck', {});
  await drain(e);
  assert.equal((await get(e)).body.roles[0].reqs.find((q) => q.key === 'french-b2').status, 'have');
  g = (await post(e, '/gap/french-b2/reopen', {})).body.gap;
  assert.equal(e.q.length, 2, 'both roles are checked again');
  await drain(e);
  all = (await get(e)).body;
  assert.equal(all.side.closed, 0);
  assert.equal(all.roles[0].reqs.find((q) => q.key === 'french-b2').status, 'missing');
  assert.equal(all.gaps.find((x) => x.key === 'french-b2').state, 'working', 'its steps are still there');
  await post(e, '/gap/french-b2/step/' + sid + '/delete', {});
  assert.equal((await get(e)).body.gaps.find((x) => x.key === 'french-b2').state, 'open');
});

test('the day after its closing date a role is past and leaves the gaps; it can come back', async () => {
  const e = env();
  const now = Date.now();
  const item = { id: 'applytask0003', text: 'Apply: Beleidsmedewerker internationale samenwerking (Defensie) · 2026-10-21', section: 'soon', done: false, doneAt: null, updatedAt: now, pos: now };
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'upsert', item }] }) });
  const r = await post(e, '/track', { taskId: 'applytask0003' });
  await drain(e);
  assert.equal((await get(e)).body.roles[0].state, 'needs_text', 'no link: the text is asked for');
  await post(e, '/role/' + r.body.role.id + '/text', { text: JOB });
  await post(e, '/side', { text: 'Made-up line one\nMade-up MA degree line' });
  await drain(e);
  assert.ok((await get(e)).body.gaps.length > 0);
  assert.deepEqual(await skillsCron(e, NOW), { past: 1 });
  let all = (await get(e)).body;
  assert.equal(all.roles[0].state, 'past');
  assert.deepEqual(all.gaps, []);
  all = (await post(e, '/role/' + r.body.role.id + '/past', { past: false })).body;
  assert.equal(all.role.state, 'ready');
  assert.equal((await post(e, '/role/' + r.body.role.id + '/delete', {})).status, 200);
  assert.deepEqual((await get(e)).body.roles, []);
});

test('hub events carry ids and counts only, never the vacancy, his side or a note', async () => {
  const e = env();
  await post(e, '/role', { title: 'Beleidsmedewerker internationale samenwerking', org: 'Ministerie van Defensie', text: JOB });
  await drain(e);
  await post(e, '/side', { text: 'SIDELINE made-up\nSIDELINE MA degree' });
  await drain(e);
  const g = (await post(e, '/gap/french-b2/step', { text: 'STEPWORD course' })).body.gap;
  await post(e, '/gap/french-b2/step/' + g.steps[0].id + '/task', {});
  await post(e, '/gap/french-b2/options', {});
  await post(e, '/gap/french-b2/close', { note: 'NOTEWORD exam' });
  await post(e, '/gap/french-b2/reopen', {});
  const text = JSON.stringify(events(e));
  for (const s of ['FAKEVACANCYWORD', 'Beleidsmedewerker', 'Defensie', 'SIDELINE', 'STEPWORD', 'NOTEWORD', 'French', 'french-b2']) assert.ok(!text.includes(s), s + ' leaked into an event');
  assert.deepEqual([...new Set(events(e).map((x) => x.type))].sort(), ['gap.closed', 'gap.options', 'gap.reopened', 'gap.step', 'gap.task', 'skills.matched', 'skills.read', 'skills.side', 'skills.tracked']);
});

test('gapsFrom: past and unread roles do not count', () => {
  const roles = [
    { id: 'a', state: 'ready', reqs: [{ key: 'x', label: 'X', must: true, status: 'missing' }] },
    { id: 'b', state: 'past', reqs: [{ key: 'x', label: 'X', must: true, status: 'missing' }] },
    { id: 'c', state: 'reading', reqs: [{ key: 'y', label: 'Y', must: true, status: 'missing' }] },
  ];
  const g = gapsFrom(roles, [], []);
  assert.deepEqual(g.map((x) => [x.key, x.roles, x.active]), [['x', ['a'], 1]]);
});
