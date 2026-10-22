// The Network map (wave 2 Phase 1): fields and their limits, fading, sector suggestions, LinkedIn's
// Connections.csv read and matched, Reach out into To-do and back, Sent a message into Waiting on and
// back, ties, and no name or note in any hub event. D1 is node:sqlite running every migration, the
// list is the real Durable Object in memory. Every person here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { normalizeLinkedIn, monthsBefore, isFading, suggestSector, cleanPerson, parseCsv, parseConnections, connectedOn, PAGE, FADE_MONTHS } from '../src/network.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-22T10:00:00Z'); // Thursday 22 October, 12:00 in Amsterdam
const TODAY = '2026-10-22';
const DIR = new URL('../migrations/', import.meta.url);

function memD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, DIR), 'utf8'));
  const d1 = {
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
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
  return d1;
}
function memKV() {
  const m = new Map();
  return { m, async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); }, async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }; } };
}
const env = () => ({ HUB_DB: memD1(), HUB_QUEUE: { async sendBatch() {} }, HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE });
const stub = (e) => e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
async function at(ms, fn) { const real = Date.now; Date.now = () => ms; try { return await fn(); } finally { Date.now = real; } }
async function call(e, method, path, body, ms = NOW) {
  return at(ms, async () => {
    const r = await worker.fetch(new Request('https://hub.test/api/network/' + CODE + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }), e);
    return { status: r.status, body: await r.json() };
  });
}
const get = (e, ms) => call(e, 'GET', '', undefined, ms);
const post = (e, path, body, ms) => call(e, 'POST', path, body, ms);
const add = async (e, body, ms) => (await post(e, '/person', body, ms)).body.person;
const events = (e) => e.HUB_DB.db.prepare('SELECT source, type, summary, payload FROM events ORDER BY rowid').all();
const list = async (e) => (await (await stub(e).fetch('https://list/export')).json());

const CSV = [
  'Notes:',
  '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email. You can learn more here https://www.linkedin.com/help/linkedin/answer/261"',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Olga,Petrova,https://www.linkedin.com/in/olga-petrova-x1,olga@example.org,NCIA,Recruiter,03 Feb 2025',
  'Tom,Visser,https://www.linkedin.com/in/TomVisser/,,Thales Nederland,"Business development, naval",12 Sep 2024',
  'Frank,Hoekstra,https://nl.linkedin.com/in/frank-hoekstra?trk=x,,Ministerie van Defensie,Senior advisor,28 Jun 2023',
  'Ingrid,Solberg,https://www.linkedin.com/in/ingrid-solberg,,Royal Norwegian Embassy in The Hague,Counsellor,9 May 2023',
  'Daan,Willems,https://www.linkedin.com/in/daan-willems,daan@example.org,Rabobank,"Analyst ""data""",14 Jan 2022',
  'Eva,Bakker,,,Economische Zaken,Senior advisor,1 Mar 2021',
  'Olga,Petrova,https://www.linkedin.com/in/olga-petrova-x1,,NCIA,Recruiter,03 Feb 2025',
  ',,,,,,',
].join('\r\n');

test('LinkedIn links, months back, fading', () => {
  assert.equal(normalizeLinkedIn('https://nl.linkedin.com/in/Frank-Hoekstra/?trk=abc#x'), 'https://www.linkedin.com/in/frank-hoekstra');
  assert.equal(normalizeLinkedIn('http://linkedin.com/in/a-b'), 'https://www.linkedin.com/in/a-b');
  assert.equal(normalizeLinkedIn('https://www.linkedin.com/company/thales'), null);
  assert.equal(normalizeLinkedIn('https://evil.example/in/x'), null);
  assert.equal(normalizeLinkedIn('javascript:alert(1)'), null);
  assert.equal(monthsBefore('2026-10-22', 6), '2026-04-22');
  assert.equal(monthsBefore('2026-08-31', 6), '2026-02-28');
  assert.equal(monthsBefore('2026-03-15', 6), '2025-09-15');
  assert.equal(FADE_MONTHS, 6);
  assert.equal(isFading(null, TODAY), true, 'never contacted fades too');
  assert.equal(isFading('2026-04-22', TODAY), false);
  assert.equal(isFading('2026-04-21', TODAY), true);
});

test('sector suggestions by fixed words, To sort when nothing fits', () => {
  assert.equal(suggestSector('NCIA'), 'nato');
  assert.equal(suggestSector('Permanent Representation of the Netherlands to NATO'), 'nato');
  assert.equal(suggestSector('European Defence Agency'), 'nato');
  assert.equal(suggestSector('Royal Norwegian Embassy in The Hague'), 'emb');
  assert.equal(suggestSector('Ambassade van Frankrijk'), 'emb');
  assert.equal(suggestSector('Ministerie van Defensie'), 'min');
  assert.equal(suggestSector('Ministry of Foreign Affairs'), 'min');
  assert.equal(suggestSector('Thales Nederland'), 'ind');
  assert.equal(suggestSector('Damen Naval'), 'ind');
  assert.equal(suggestSector('Rabobank'), 'sort');
  assert.equal(suggestSector(''), 'sort');
  assert.equal(suggestSector(null), 'sort');
});

test('a person is cleaned: limits, dates, topics, links; null clears, the name never', () => {
  const ok = cleanPerson({ name: '  Anna   de Vries ', org: 'Ministerie van Defensie', sector: 'min', metWhen: '2026-03', topics: ['Procurement', 'procurement', ' LatAm '], notes: 'Line one\r\n\r\n\r\nLine two', email: 'anna@example.org', phone: '+31 6 1234 5678', linkedin: 'https://linkedin.com/in/Anna-dV/', lastContact: '2026-10-02' }, TODAY);
  assert.deepEqual(ok.fields, { name: 'Anna de Vries', org: 'Ministerie van Defensie', sector: 'min', met_when: '2026-03', topics: '["Procurement","LatAm"]', notes: 'Line one\n\nLine two', email: 'anna@example.org', phone: '+31 6 1234 5678', linkedin: 'https://www.linkedin.com/in/anna-dv', last_contact: '2026-10-02' });
  assert.match(cleanPerson({}, TODAY).error, /name/);
  assert.match(cleanPerson({ name: 'x', sector: 'army' }, TODAY).error, /sector/);
  assert.match(cleanPerson({ name: 'x', metWhen: '2026-13' }, TODAY).error, /metWhen/);
  assert.match(cleanPerson({ name: 'x', lastContact: '2026-10-23' }, TODAY).error, /future/);
  assert.match(cleanPerson({ name: 'x', lastContact: '2026-02-30' }, TODAY).error, /lastContact/);
  assert.match(cleanPerson({ name: 'x', email: 'nope' }, TODAY).error, /email/);
  assert.match(cleanPerson({ name: 'x', phone: 'call me' }, TODAY).error, /phone/);
  assert.match(cleanPerson({ name: 'x', linkedin: 'https://example.org/in/x' }, TODAY).error, /linkedin/);
  assert.match(cleanPerson({ name: 'x', topics: Array.from({ length: 13 }, (_, i) => 't' + i) }, TODAY).error, /topics/);
  assert.match(cleanPerson({ name: 'x', notes: 'a'.repeat(1001) }, TODAY).error, /notes/);
  assert.equal(cleanPerson({ name: 'x'.repeat(300) }, TODAY).fields.name.length, 120);
  assert.deepEqual(cleanPerson({ org: null, notes: '' }, TODAY, { partial: true }).fields, { org: null, notes: null });
  assert.match(cleanPerson({ name: '' }, TODAY, { partial: true }).error, /name/);
});

test("Connections.csv: LinkedIn's notes skipped, quotes kept, emails never read, doubles once", () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\r\n"x\ny",z'), [['a', 'b,c', 'd "e"'], ['x\ny', 'z']]);
  assert.equal(connectedOn('03 Feb 2025'), '2025-02-03');
  assert.equal(connectedOn('9 May 2023'), '2023-05-09');
  assert.equal(connectedOn('31 Feb 2023'), null);
  assert.equal(connectedOn('2024-01-05'), '2024-01-05');
  const { rows } = parseConnections('﻿' + CSV);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], { key: 'https://www.linkedin.com/in/olga-petrova-x1', name: 'Olga Petrova', org: 'NCIA', role: 'Recruiter', linkedin: 'https://www.linkedin.com/in/olga-petrova-x1', connectedOn: '2025-02-03' });
  assert.equal(rows[1].role, 'Business development, naval');
  assert.equal(rows[1].linkedin, 'https://www.linkedin.com/in/tomvisser');
  assert.equal(rows[4].role, 'Analyst "data"');
  assert.equal(rows[5].key, 'n:eva bakker|economische zaken');
  assert.ok(!JSON.stringify(rows).includes('example.org'), 'no email address anywhere');
  assert.match(parseConnections('Name,Company\nx,y').error, /First Name/);
  assert.match(parseConnections('').error, /empty/);
});

test('the route: the code, an empty network, what Paul chose', async () => {
  const e = env();
  const bad = await at(NOW, () => worker.fetch(new Request('https://hub.test/api/network/short'), e));
  assert.equal(bad.status, 400);
  const unknown = await at(NOW, () => worker.fetch(new Request('https://hub.test/api/network/zzzzzzzzzzzzzzzz'), e));
  assert.equal(unknown.status, 404);
  const { status, body } = await get(e);
  assert.equal(status, 200);
  assert.deepEqual(body, {
    today: TODAY, fadeMonths: 6, people: [], ties: [],
    sectors: [{ id: 'emb', name: 'Embassies' }, { id: 'min', name: 'Ministries' }, { id: 'ind', name: 'Industry' }, { id: 'nato', name: 'NATO and EU' }, { id: 'other', name: 'Other' }],
  });
  assert.equal((await post(e, '/nope', {})).status, 404);
  assert.equal((await post(e, '/person/abcdefabcdef', { org: 'x' })).status, 404);
});

test('add, change, fade: someone never contacted or not for 6 months fades', async () => {
  const e = env();
  const anna = await add(e, { name: 'Anna de Vries', org: 'Ministerie van Defensie', role: 'Policy advisor', sector: 'min', lastContact: '2026-10-02', topics: ['Procurement'] });
  const lars = await add(e, { name: 'Lars Eriksen', org: 'Embassy of Norway', sector: 'emb', lastContact: '2026-02-10' });
  const new1 = await add(e, { name: 'Nadia Haddad' });
  assert.match(anna.id, /^[a-z0-9]{12}$/);
  assert.equal(new1.sector, 'other', 'added by hand without a sector: Other, on the map');
  const { body } = await get(e);
  assert.deepEqual(body.people.map((p) => [p.name, p.fading]), [['Anna de Vries', false], ['Lars Eriksen', true], ['Nadia Haddad', true]]);
  assert.deepEqual(body.people[0].topics, ['Procurement']);
  assert.equal(body.people[0].source, 'hand');
  const ch = await post(e, '/person/' + anna.id, { org: null, role: 'Head of unit', metWhere: 'Career event', metWhen: '2026-03' });
  assert.equal(ch.status, 200);
  assert.equal(ch.body.person.org, null);
  assert.equal(ch.body.person.role, 'Head of unit');
  assert.equal(ch.body.person.name, 'Anna de Vries');
  assert.equal((await post(e, '/person/' + anna.id, { name: null })).status, 400);
  await post(e, '/person/' + anna.id, { linkedin: 'https://www.linkedin.com/in/anna' });
  const dup = await post(e, '/person', { name: 'Someone', linkedin: 'https://nl.linkedin.com/in/ANNA/' });
  assert.equal(dup.status, 409);
  assert.equal((await post(e, '/person/' + lars.id, { linkedin: 'https://www.linkedin.com/in/anna' })).status, 409);
});

test('Talked today moves Last contact forward only', async () => {
  const e = env();
  const p = await add(e, { name: 'Tom Visser', sector: 'ind', lastContact: '2026-05-01' });
  let r = await post(e, '/person/' + p.id + '/talked', {});
  assert.equal(r.body.person.lastContact, TODAY);
  assert.equal(r.body.person.fading, false);
  r = await post(e, '/person/' + p.id + '/talked', { date: '2026-09-01' });
  assert.equal(r.body.person.lastContact, TODAY, 'an older day never moves it back');
  assert.equal((await post(e, '/person/' + p.id + '/talked', { date: '2026-10-23' })).status, 400);
  const contacted = events(e).filter((x) => x.type === 'person.contacted');
  assert.equal(contacted.length, 1);
  assert.deepEqual(JSON.parse(contacted[0].payload), { id: p.id, how: 'talked' });
});

test('Reach out: a task in To-do linking back; ticking it moves Last contact; deleting it lets go', async () => {
  const e = env();
  const p = await add(e, { name: 'Anna de Vries', sector: 'min' });
  const r = await post(e, '/person/' + p.id + '/reach', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.task.text, 'Reach out to Anna de Vries');
  const doc = await list(e);
  const it = doc.items[r.body.task.id];
  assert.equal(it.section, 'soon');
  assert.equal(it.energy, 'normal');
  assert.equal(it.link, PAGE + p.id);
  assert.equal(r.body.person.reachTask, r.body.task.id);
  assert.equal((await post(e, '/person/' + p.id + '/reach', { section: 'today' })).status, 409, 'one open task at a time');
  assert.equal((await post(e, '/person/' + p.id + '/reach', { section: 'someday' })).status, 400);
  assert.equal((await post(e, '/person/' + p.id + '/reach', { energy: 'hyper' })).status, 400);
  // Ticked in To-do on Saturday evening.
  const done = Date.parse('2026-10-24T19:30:00Z');
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'upsert', item: { ...it, done: true, doneAt: done, updatedAt: done } }] }) });
  const g = await get(e, done + HOUR);
  const after = g.body.people[0];
  assert.equal(after.lastContact, '2026-10-24');
  assert.equal(after.reachTask, null);
  assert.deepEqual(JSON.parse(events(e).find((x) => x.type === 'person.contacted').payload), { id: p.id, how: 'task' });
  // A second task, deleted in To-do: no contact, the task is let go.
  const r2 = await post(e, '/person/' + p.id + '/reach', { section: 'today', energy: 'drained' }, done + 2 * HOUR);
  assert.equal((await list(e)).items[r2.body.task.id].section, 'today');
  await stub(e).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'delete', item: { id: r2.body.task.id, updatedAt: done + 3 * HOUR } }] }) });
  await at(done + 4 * HOUR, () => worker.scheduled({ cron: '*/15 * * * *', scheduledTime: done + 4 * HOUR }, e, { waitUntil: (p) => p }));
  await new Promise((r) => setTimeout(r, 50));
  const row = e.HUB_DB.db.prepare('SELECT reach_task, last_contact FROM people WHERE id = ?').get(p.id);
  assert.deepEqual({ ...row }, { reach_task: null, last_contact: '2026-10-24' });
});

test('Sent a message: a Waiting on item; its answer moves Last contact', async () => {
  const e = env();
  const p = await add(e, { name: 'Henrik Larsen', sector: 'nato', lastContact: '2026-03-01' });
  assert.equal((await post(e, '/person/' + p.id + '/sent', { what: 'x', channel: 'pigeon' })).status, 400);
  assert.equal((await post(e, '/person/' + p.id + '/sent', { what: 'x', channel: 'email', chaseDays: 5 })).status, 400);
  assert.equal((await post(e, '/person/' + p.id + '/sent', { channel: 'email' })).status, 400);
  const r = await post(e, '/person/' + p.id + '/sent', { what: 'The NSPA vacancy', channel: 'email' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.person.waiting, { id: r.body.waiting.id, what: 'The NSPA vacancy', nextChase: '2026-10-29' });
  const w = e.HUB_DB.db.prepare('SELECT who, what, channel, chase_days, person, source FROM waiting WHERE id = ?').get(r.body.waiting.id);
  assert.deepEqual({ ...w }, { who: 'Henrik Larsen', what: 'The NSPA vacancy', channel: 'email', chase_days: 7, person: p.id, source: 'morning' });
  // He answers on Monday; Paul resolves it in To-do.
  const mon = Date.parse('2026-10-26T09:00:00Z');
  const res = await at(mon, () => worker.fetch(new Request('https://hub.test/api/waiting/' + CODE + '/' + r.body.waiting.id, { method: 'POST', body: JSON.stringify({ action: 'resolve', source: 'todo' }) }), e));
  assert.equal(res.status, 200);
  const g = await get(e, mon);
  assert.equal(g.body.people[0].lastContact, '2026-10-26');
  assert.equal(g.body.people[0].waiting, null);
  assert.equal(g.body.people[0].fading, false);
});

test('ties: introduced has a direction, works with does not; removing someone takes their ties', async () => {
  const e = env();
  const a = await add(e, { name: 'Mark Jansen', sector: 'min' });
  const b = await add(e, { name: 'Anna de Vries', sector: 'min' });
  const c = await add(e, { name: 'Ruben Smit', sector: 'min' });
  let r = await post(e, '/tie', { a: a.id, b: b.id, kind: 'introduced' });
  assert.deepEqual(r.body.ties, [{ a: a.id, b: b.id, kind: 'introduced' }]);
  r = await post(e, '/tie', { a: c.id, b: b.id, kind: 'works_with' });
  const [x, y] = [b.id, c.id].sort();
  assert.deepEqual(r.body.ties.find((t) => t.kind === 'works_with'), { a: x, b: y, kind: 'works_with' });
  r = await post(e, '/tie', { a: b.id, b: c.id, kind: 'works_with' });
  assert.equal(r.body.ties.length, 2, 'the same pair once');
  assert.equal((await post(e, '/tie', { a: a.id, b: a.id, kind: 'works_with' })).status, 400);
  assert.equal((await post(e, '/tie', { a: a.id, b: 'zzzzzzzzzzzz', kind: 'works_with' })).status, 404);
  assert.equal((await post(e, '/tie', { a: a.id, b: b.id, kind: 'married' })).status, 400);
  r = await post(e, '/tie', { a: b.id, b: c.id, kind: 'works_with', remove: true });
  assert.deepEqual(r.body.ties, [{ a: a.id, b: b.id, kind: 'introduced' }]);
  const s = await post(e, '/person/' + b.id + '/sent', { what: 'Coffee', channel: 'phone' });
  assert.equal((await post(e, '/person/' + b.id + '/delete', {})).status, 200);
  const g = await get(e);
  assert.deepEqual(g.body.people.map((p) => p.name), ['Mark Jansen', 'Ruben Smit']);
  assert.deepEqual(g.body.ties, []);
  assert.equal(e.HUB_DB.db.prepare('SELECT person FROM waiting WHERE id = ?').get(s.body.waiting.id).person, null, 'the wait stays, without her');
});

test('LinkedIn import: a dry run to check, then in; matches only fill gaps; no email kept', async () => {
  const e = env();
  const tom = await add(e, { name: 'Tom Visser', org: 'Thales Nederland', role: 'Account manager', sector: 'ind', linkedin: 'https://www.linkedin.com/in/tomvisser' });
  const eva = await add(e, { name: 'Eva Bakker', org: 'Economische Zaken', sector: 'min' });
  const dry = await post(e, '/import', { csv: CSV, dry: true });
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body.counts, { total: 6, new: 4, match: 2 });
  assert.deepEqual(dry.body.rows.map((r) => [r.name, r.status, r.sector]), [
    ['Olga Petrova', 'new', 'nato'], ['Tom Visser', 'match', 'ind'], ['Frank Hoekstra', 'new', 'min'],
    ['Ingrid Solberg', 'new', 'emb'], ['Daan Willems', 'new', 'sort'], ['Eva Bakker', 'match', 'min'],
  ]);
  assert.equal(e.HUB_DB.db.prepare('SELECT COUNT(*) AS n FROM people').get().n, 2, 'a dry run stores nothing');
  const daan = dry.body.rows.find((r) => r.name === 'Daan Willems').key;
  const done = await post(e, '/import', { csv: CSV, sectors: { [daan]: 'other' } });
  assert.deepEqual(done.body, { added: 4, matched: 2 });
  const { body } = await get(e);
  const by = Object.fromEntries(body.people.map((p) => [p.name, p]));
  assert.equal(by['Daan Willems'].sector, 'other');
  assert.equal(by['Olga Petrova'].source, 'linkedin');
  assert.equal(by['Olga Petrova'].connectedOn, '2025-02-03');
  assert.equal(by['Olga Petrova'].lastContact, null, 'Connected on never counts as contact');
  assert.equal(by['Olga Petrova'].fading, true);
  assert.equal(by['Tom Visser'].role, 'Account manager', 'his own words stay');
  assert.equal(by['Tom Visser'].connectedOn, '2024-09-12', 'a gap is filled');
  assert.equal(by['Eva Bakker'].connectedOn, '2021-03-01');
  assert.ok(body.people.every((p) => p.email === null), 'LinkedIn emails are never kept');
  assert.equal(tom.id, by['Tom Visser'].id);
  assert.equal(eva.id, by['Eva Bakker'].id);
  // Again: everyone is already here.
  const again = await post(e, '/import', { csv: CSV, dry: true });
  assert.deepEqual(again.body.counts, { total: 6, new: 0, match: 6 });
  assert.equal((await post(e, '/import', { csv: 'nope' })).status, 400);
  assert.equal((await post(e, '/import', {})).status, 400);
});

test('hub events carry ids only: no name, organisation, note or topic', async () => {
  const e = env();
  const p = await add(e, { name: 'Claire Dubois', org: 'Embassy of France', sector: 'emb', notes: 'Likes jazz', topics: ['Sahel'] });
  const q = await add(e, { name: 'Jean Moreau', org: 'DG DEFIS', sector: 'nato' });
  await post(e, '/person/' + p.id, { notes: 'Still likes jazz' });
  await post(e, '/tie', { a: p.id, b: q.id, kind: 'introduced' });
  await post(e, '/person/' + p.id + '/talked', {});
  await post(e, '/person/' + p.id + '/reach', {});
  await post(e, '/person/' + q.id + '/sent', { what: 'Sahel paper', channel: 'email' });
  await post(e, '/import', { csv: CSV });
  await post(e, '/person/' + q.id + '/delete', {});
  const all = events(e);
  const text = JSON.stringify(all);
  for (const s of ['Claire', 'Dubois', 'Embassy', 'jazz', 'Sahel', 'Jean', 'Moreau', 'DEFIS', 'Olga', 'NCIA']) assert.ok(!text.includes(s), s + ' leaked into an event');
  assert.deepEqual([...new Set(all.map((x) => x.type))].sort(), ['person.added', 'person.contacted', 'person.deleted', 'person.imported', 'person.reach', 'person.updated', 'tie.added', 'waiting.created']);
  assert.ok(all.every((x) => x.source === 'morning'));
});
