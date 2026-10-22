// Email in: sample forwards from Hotmail and Gmail, a sender not on the allowlist, the four subject
// paths through the hub's queue, Day's sorting, and that nothing is ever sent back. No network; D1
// is node:sqlite running every migration. Every name and address here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { handleMessage } from '../src/hub.js';
import { readSubject, readForward, allowed, receiveMail, excerptOf, personOf, mailTaskId, EXCERPT } from '../src/mail.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh12345678';
const DAY_SECRET = 'day-secret-for-tests';
const ME = 'paul.example@hotmail.example';
const NOW = Date.parse('2026-10-22T09:00:00Z');
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
const memQueue = () => ({ sent: [], async sendBatch(ms) { this.sent.push(...ms); } });
const env = () => ({ HUB_DB: memD1(), HUB_QUEUE: memQueue(), HUB_KV: memKV(), TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_SECRET_DAY: DAY_SECRET, EMAIL_ALLOW: ME + ', other.example@hotmail.example' });
const stub = (e) => e.TODO_LIST.get(e.TODO_LIST.idFromName('todo:' + CODE));
const items = async (e) => (await (await stub(e).fetch('https://list/export')).json()).items;
const rows = (e) => e.HUB_DB.db.prepare('SELECT * FROM mail ORDER BY created_at').all();
// Run what the hub queued, as the queue consumer would.
async function drain(e, now = NOW) {
  const out = [];
  while (e.HUB_QUEUE.sent.length) out.push(await handleMessage(e, e.HUB_QUEUE.sent.shift().body, now));
  return out;
}
// A message as Email Routing hands it over, with spies on everything that would send mail.
function message(from, raw) {
  const sent = [];
  return { from, to: 'hub@example.org', raw, rawSize: raw.length, sent,
    forward: async () => sent.push('forward'), reply: async () => sent.push('reply'), setReject: () => sent.push('reject') };
}

/* ---------- Sample mails ---------- */

// Outlook (Hotmail), Dutch labels, quoted-printable, with a text and an HTML part.
const hotmail = (subject, quoted) => [
  'From: Paul Example <' + ME + '>',
  'To: hub@example.org',
  'Subject: ' + subject,
  'Date: Thu, 22 Oct 2026 09:12:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Please look at this.',
  '',
  '________________________________',
  ...quoted,
  '--b1',
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<p>Please look at this.</p>',
  '--b1--',
  '',
].join('\r\n');
const GEMEENTE = [
  'Van: Gemeente Voorbeeld <noreply@gemeente.example>',
  'Verzonden: woensdag 21 oktober 2026 14:03',
  'Aan: Paul Example <' + ME + '>',
  'Onderwerp: Your parking permit application',
  '',
  'We have received your application for a resident parking permit. Pay =E2=82=AC 50 to IBAN NL91ABNA0417164300 =',
  'within 14 days. We will let you know within 8 weeks whether the permit is granted, and we will write to you =',
  'again when the zone changes next year. Kind regards, the permits team, and some more words to pass two hundred.',
];
const SENT_BY_ME = [
  'Van: Paul Example <' + ME + '>',
  'Verzonden: dinsdag 20 oktober 2026 10:00',
  'Aan: Sam Voorbeeld <sam@landlord.example>',
  'Onderwerp: The heater',
  '',
  'Hi Sam, the heater is broken again. Could you send someone this week?',
];
// Gmail's forward, English labels.
const GMAIL_BODY = [
  'FYI',
  '',
  '---------- Forwarded message ---------',
  'From: Ana Example <ana@example.org>',
  'Date: Tue, 20 Oct 2026 at 10:00',
  'Subject: Lunch plans',
  'To: Paul <someone@gmail.example>',
  '',
  'Shall we meet on Friday at the usual place?',
].join('\n');
const gmail = (subject) => [
  'From: Paul <someone@gmail.example>', 'To: hub@example.org', 'Subject: ' + subject, 'MIME-Version: 1.0',
  'Content-Type: text/plain; charset="UTF-8"', '', GMAIL_BODY, '',
].join('\r\n');

/* ---------- Pure ---------- */

test('readSubject: prefix before or after FW, tags anywhere, taken out', () => {
  assert.deepEqual(readSubject('todo: FW: Parking permit #drained'), { kind: 'todo', subject: 'Parking permit', energy: 'drained', others: false });
  assert.deepEqual(readSubject('FW: later: Defence budget article'), { kind: 'later', subject: 'Defence budget article', energy: null, others: false });
  assert.deepEqual(readSubject('Wait: The heater #others'), { kind: 'wait', subject: 'The heater', energy: null, others: true });
  assert.deepEqual(readSubject('Doorst: Invoice October'), { kind: 'triage', subject: 'Invoice October', energy: null, others: false });
  assert.equal(readSubject('').subject, '(no subject)');
  assert.equal(readSubject('todo is a word: not a prefix').kind, 'triage');
});

test('readForward: Outlook in Dutch and Gmail in English', () => {
  const o = readForward(['Please look.', '', '________________________________', ...SENT_BY_ME].join('\n'));
  assert.equal(o.from, 'Paul Example <' + ME + '>');
  assert.equal(o.to, 'Sam Voorbeeld <sam@landlord.example>');
  assert.equal(o.date, 'dinsdag 20 oktober 2026 10:00');
  assert.match(o.body, /^Hi Sam/);
  const g = readForward(GMAIL_BODY);
  assert.equal(g.from, 'Ana Example <ana@example.org>');
  assert.equal(g.body, 'Shall we meet on Friday at the usual place?');
  assert.equal(personOf('Ana Example <ana@example.org>'), 'Ana Example');
  assert.equal(personOf('ana@example.org'), 'ana@example.org');
});

test('allowed: only the listed addresses, case and spaces ignored', () => {
  assert.equal(allowed('Paul.Example@Hotmail.Example', ' paul.example@hotmail.example ,x@y.z'), true);
  assert.equal(allowed('someone@gmail.example', 'paul.example@hotmail.example'), false);
  assert.equal(allowed('x@y.z', ''), false);
});

test('excerptOf: at most EXCERPT characters, one line, IBAN masked', () => {
  assert.equal(EXCERPT, 200);
  const x = excerptOf('Pay to IBAN NL91ABNA0417164300 now.\n' + 'word '.repeat(80));
  assert.ok(x.length <= 200);
  assert.ok(!x.includes('NL91ABNA0417164300'), x);
});

/* ---------- Receiving ---------- */

test('a sender not on the allowlist is dropped: nothing stored, nothing queued, nothing sent back', async () => {
  const e = env();
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    for (const m of [message('stranger@example.net', hotmail('todo: Buy a car', GEMEENTE)), message('someone@gmail.example', gmail('todo: Lunch'))]) {
      assert.deepEqual(await receiveMail(m, e, NOW), { dropped: true });
      assert.deepEqual(m.sent, []);
    }
  } finally { console.log = log; }
  assert.equal(rows(e).length, 0);
  assert.equal(e.HUB_QUEUE.sent.length, 0);
  assert.deepEqual(logs, ['mail dropped', 'mail dropped'], 'the log says only that it was dropped');
});

test('Hotmail todo: one row with only subject, sender, date and excerpt; the queue makes the task in Soon with the tag\'s energy', async () => {
  const e = env();
  const m = message(ME, hotmail('todo: FW: Your parking permit application #drained', GEMEENTE));
  const got = await receiveMail(m, e, NOW);
  assert.equal(got.kind, 'todo');
  assert.deepEqual(m.sent, [], 'no reply, forward or bounce');
  const [r] = rows(e);
  assert.equal(r.subject, 'Your parking permit application');
  assert.equal(r.sender, 'Gemeente Voorbeeld <noreply@gemeente.example>');
  assert.equal(r.sent_at, 'woensdag 21 oktober 2026 14:03');
  assert.ok(r.excerpt.startsWith('We have received your application'));
  assert.ok(r.excerpt.length <= 200 && !r.excerpt.includes('NL91ABNA0417164300'));
  assert.deepEqual(Object.keys(r).sort(), ['created_at', 'energy', 'excerpt', 'id', 'kind', 'others', 'sender', 'sent_at', 'state', 'subject', 'target', 'updated_at']);
  assert.deepEqual(e.HUB_QUEUE.sent.map((x) => [x.body.target, x.body.type, JSON.stringify(x.body.payload)]), [['mail', 'email.received', JSON.stringify({ id: r.id })]]);
  await drain(e);
  const t = (await items(e))[await mailTaskId(r.id)];
  assert.equal(t.text, 'Your parking permit application');
  assert.equal(t.section, 'soon');
  assert.equal(t.energy, 'drained');
  assert.equal(rows(e)[0].state, 'task');
  const types = e.HUB_DB.db.prepare('SELECT type, payload FROM events ORDER BY at, type').all();
  assert.deepEqual(types.map((x) => x.type), ['email.received', 'task.created']);
  assert.ok(types.every((x) => !/parking|Gemeente/i.test(x.payload)), 'events carry ids only');
});

test('later: a read-later line Morning lists until Done or Drop', async () => {
  const e = env();
  await receiveMail(message(ME, hotmail('later: Defence budget article', GEMEENTE)), e, NOW);
  await drain(e);
  const call = (path, body) => worker.fetch(new Request('https://hub.example/api/mail/' + CODE + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined }), e);
  const list = await (await call('')).json();
  assert.equal(list.later.length, 1);
  assert.equal(list.later[0].subject, 'Defence budget article');
  assert.equal(list.later[0].sender, 'Gemeente Voorbeeld');
  assert.equal((await call('/' + list.later[0].id, { action: 'archive' })).status, 400);
  assert.equal((await call('/' + list.later[0].id, { action: 'done' })).status, 200);
  assert.equal((await (await call('')).json()).later.length, 0);
});

test('wait: a Waiting on item for the person the forwarded mail went to, email, 7 days', async () => {
  const e = env();
  await receiveMail(message(ME, hotmail('wait: The heater', SENT_BY_ME)), e, NOW);
  await drain(e);
  const w = e.HUB_DB.db.prepare('SELECT who, what, channel, chase_days, source FROM waiting').get();
  assert.deepEqual({ ...w }, { who: 'Sam Voorbeeld', what: 'The heater', channel: 'email', chase_days: 7, source: 'mail' });
  assert.equal(rows(e)[0].state, 'waiting');
  assert.ok(e.HUB_DB.db.prepare("SELECT 1 FROM events WHERE type = 'waiting.created'").get());
});

test('no prefix: Mail to sort in Day; sorting it goes through the queue once', async () => {
  const e = env();
  await receiveMail(message(ME, hotmail('FW: Invoice October', GEMEENTE)), e, NOW);
  await drain(e);
  assert.equal(rows(e)[0].state, 'open', 'it waits');
  const day = (path, body, token = DAY_SECRET) => worker.fetch(new Request('https://hub.example/api/hub/mail/day' + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined }), e);
  assert.equal((await day('', undefined, 'wrong')).status, 401);
  const { items: list } = await (await day('')).json();
  assert.deepEqual(list.map((x) => [x.subject, x.sender]), [['Invoice October', 'Gemeente Voorbeeld']]);
  assert.equal((await day('/' + list[0].id, { as: 'archive' })).status, 400);
  assert.equal((await day('/' + list[0].id, { as: 'task' })).status, 200);
  assert.deepEqual(e.HUB_QUEUE.sent.map((x) => x.body.type), ['email.sorted']);
  await drain(e);
  assert.ok((await items(e))[await mailTaskId(list[0].id)], 'the task is there');
  assert.equal((await (await day('')).json()).items.length, 0);
  assert.deepEqual(await (await day('/' + list[0].id, { as: 'drop' })).json(), { ok: true, already: 'task' }, 'sorting twice does nothing');
});

test('wait: with #others the wait is for someone else, so its chase lands in the Others lane', async () => {
  const e = env();
  await receiveMail(message(ME, hotmail('wait: The heater #others', SENT_BY_ME)), e, NOW);
  await drain(e);
  assert.equal(e.HUB_DB.db.prepare('SELECT for_whom FROM waiting').get().for_whom, 'Someone else');
});

test('#others puts the task in the Others lane by name', async () => {
  const e = env();
  await receiveMail(message(ME, hotmail('todo: Tax overview for the accountant #others', GEMEENTE)), e, NOW);
  await drain(e);
  const t = (await items(e))[await mailTaskId(rows(e)[0].id)];
  assert.equal(t.text, 'Tax overview for the accountant');
  assert.equal(t.section, 'others');
});

test('the Worker\'s email() handler never throws and never sends', async () => {
  const e = env();
  const m = message(ME, 'not a mail at all');
  await worker.email(m, e);
  assert.deepEqual(m.sent, []);
});
