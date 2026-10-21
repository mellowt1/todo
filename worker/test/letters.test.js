// Letter action cards: verified values, the mask, portals, the card routes, the refill of an
// old letter and the once-only catch-up. No network: the reader is swapped, D1 is node:sqlite
// running the real migrations. Every name and number here is made up or a public example.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { _setReader, dayOf, intakeCatchUp, CATCHUP_KEY } from '../src/intake.js';
import { validIban, inQuotes, cardFromRecord, portalFor, _setNexter, nextText } from '../src/letters.js';
import { maskSecrets } from '../src/mask.js';
import { CONFIG } from '../src/dinner.js';
import { memNamespace } from './mem.js';

const CODE = 'abcdefgh23456789';
const BASE = 'https://paul-hub.example.workers.dev';
const IBAN = 'NL91 ABNA 0417 1643 00'; // the textbook example IBAN
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
function memKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
  };
}
const env = (over = {}) => ({ TODO_LIST: memNamespace(), TODO_CODE: CODE, HUB_KV: memKV(), HUB_DB: memD1(), ANTHROPIC_API_KEY: 'test-key', ...over });
const call = (e, path, init = {}) => worker.fetch(new Request(BASE + path, init), e);
const drop = (e, data = 'JVBERi0xLjQK') => call(e, `/api/intake/${CODE}`, { method: 'POST', body: JSON.stringify({ files: [{ name: 'brief.pdf', media_type: 'application/pdf', data }] }) });
const items = async (e) => (await (await call(e, `/api/todo/${CODE}`)).json()).items;

const today = dayOf(Date.now());
const plus = (days) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

const letter = (over = {}) => ({
  readable: true, who: 'me', kind: 'letter', summary: `Tax assessment: pay EUR 1,247.00 to ${IBAN}.`,
  deadline: plus(27), amount: { value: 1247, currency: 'EUR' },
  actions: [{ text: 'Pay the 2025 income tax assessment', due: plus(27) }],
  needs_paul: true, note: null,
  quotes: [`Betaal € 1.247,00 vóór ${plus(27)}`, `op rekening ${IBAN} ten name van Belastingdienst`, 'Betalingskenmerk 5123 4567 8901 2340', 'Aanslagnummer 1234.56.789.H.56.01'],
  official: true, sender: 'Belastingdienst', letter_date: plus(-2), want: 'Pay the 2025 income tax assessment',
  iban: IBAN, reference: '5123 4567 8901 2340', reference_label: 'Betalingskenmerk',
  case_number: '1234.56.789.H.56.01', case_label: 'Aanslagnummer',
  options: [{ title: 'Pay at once', detail: 'EUR 1,247.00 before the deadline' }, { title: 'Pay in instalments', detail: 'Ask for a payment plan before the deadline' }],
  ...over,
});
const read = (rec) => async () => ({ record: rec, usage: { model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });

afterEach(() => _setReader(null));

test('validIban and inQuotes', () => {
  assert.equal(validIban(IBAN), true);
  assert.equal(validIban('NL91 ABNA 0417 1643 01'), false);
  assert.equal(validIban('hello'), false);
  assert.equal(inQuotes('5123456789012340', ['Betalingskenmerk 5123 4567 8901 2340']), true);
  assert.equal(inQuotes('5123 4567 8901 2341', ['Betalingskenmerk 5123 4567 8901 2340']), false);
  assert.equal(inQuotes('12', ['12']), false); // too short to mean anything
});

test('maskSecrets: IBANs and long numbers to their last four; dates, amounts and short numbers stay', () => {
  assert.equal(maskSecrets(`Pay ${IBAN} ref 5123 4567 8901 2340 by 2026-11-14, EUR 1.247,00, room 12`),
    'Pay IBAN ··4300 ref ··2340 by 2026-11-14, EUR 1.247,00, room 12');
  assert.equal(maskSecrets('NL91ABNA0417164300'), 'IBAN ··4300');
  assert.equal(maskSecrets('Aanslag 1234.56.789.H.56.01'), 'Aanslag ··6789.H.56.01');
  assert.equal(maskSecrets(null), null);
});

test('cardFromRecord: keeps what the quotes hold, drops what they do not; not official is no card', () => {
  const c = cardFromRecord(letter());
  assert.equal(c.iban, IBAN);
  assert.equal(c.reference, '5123 4567 8901 2340');
  assert.equal(c.caseNumber, '1234.56.789.H.56.01');
  assert.equal(c.due, plus(27));
  assert.deepEqual(c.amount, { value: 1247, currency: 'EUR' });
  assert.equal(c.options.length, 2);
  // Invented values: not in any quote, or a bad IBAN.
  const made = cardFromRecord(letter({ reference: '9999 8888 7777 6666', case_number: 'X-42', iban: 'NL91 ABNA 0417 1643 01', quotes: [...letter().quotes, 'NL91 ABNA 0417 1643 01'] }));
  assert.deepEqual([made.reference, made.caseNumber, made.iban], [null, null, null]);
  assert.equal(cardFromRecord(letter({ official: false })), null);
  // A record read before cards: a letter gets a card with what was on file.
  const old = letter();
  for (const k of ['official', 'sender', 'want', 'iban', 'reference', 'case_number', 'options', 'letter_date']) delete old[k];
  const oc = cardFromRecord(old);
  assert.deepEqual([oc.iban, oc.reference, oc.caseNumber, oc.sender, oc.fresh], [null, null, null, null, false]);
  assert.equal(oc.want, 'Pay the 2025 income tax assessment');
  assert.equal(cardFromRecord({ ...old, kind: 'note' }), null);
});

test('portalFor: the match furthest right wins; unknown senders get none', () => {
  const map = JSON.parse(CONFIG.letter_portals({ Belastingdienst: 'https://mijn.belastingdienst.nl', Toeslagen: 'https://mijn.toeslagen.nl', 'Gemeente Den Haag': 'https://www.denhaag.nl' }));
  assert.equal(portalFor('Belastingdienst', map).url, 'https://mijn.belastingdienst.nl');
  assert.equal(portalFor('Belastingdienst/Toeslagen', map).name, 'Toeslagen');
  assert.equal(portalFor('Gemeente Den Haag', map).host, 'denhaag.nl');
  assert.equal(portalFor('Gemeente Rotterdam', map), null);
  assert.equal(portalFor(null, map), null);
  assert.equal(CONFIG.letter_portals('{"DUO":"http://mijn.duo.nl"}'), null);
  assert.equal(CONFIG.letter_portals('not json'), null);
});

test('a letter: the task is masked, the card is full, every other answer is masked', async () => {
  const e = env();
  _setReader(read(letter()));
  const r = await (await drop(e)).json();
  assert.equal(r.card, true);
  assert.ok(!JSON.stringify(r).includes('0417 1643 00') && !JSON.stringify(r).includes('5123 4567'));
  const [task] = await items(e);
  assert.equal(task.text, `Pay the 2025 income tax assessment · ${plus(27)} [intake]`);
  assert.equal(task.section, 'soon');
  const cards = await (await call(e, `/api/intake/${CODE}/cards`)).json();
  assert.deepEqual(cards.tasks, [task.id]);
  const { card } = await (await call(e, `/api/intake/${CODE}/card/${task.id}`)).json();
  assert.equal(card.iban, IBAN);
  assert.equal(card.reference, '5123 4567 8901 2340');
  assert.equal(card.caseLabel, 'Aanslagnummer');
  assert.deepEqual(card.portal, { name: 'Belastingdienst', url: 'https://mijn.belastingdienst.nl', host: 'mijn.belastingdienst.nl' });
  assert.equal(card.pick, null);
  assert.equal(card.done, null);
  // The KV record and the list the To-do app reads hold no full IBAN or reference.
  const kv = [...e.HUB_KV.m.entries()].filter(([k]) => k.startsWith('intake:r:')).map(([, v]) => v).join();
  assert.ok(!kv.includes('0417 1643 00') && !kv.includes('5123 4567 8901') && kv.includes('··4300'));
  const listed = JSON.stringify(await (await call(e, `/api/intake/${CODE}`)).json());
  assert.ok(!listed.includes('0417 1643 00'));
  // Morning: Read for you is masked too.
  const m = JSON.stringify((await (await call(e, `/api/morning/${CODE}`)).json()).intake);
  assert.ok(!m.includes('0417 1643 00') && m.includes('··4300'));
});

test('a non-official item gets no card and opens as a normal task', async () => {
  const e = env();
  _setReader(read(letter({ official: false, kind: 'note' })));
  const r = await (await drop(e)).json();
  assert.equal(r.card, false);
  assert.deepEqual((await (await call(e, `/api/intake/${CODE}/cards`)).json()).tasks, []);
});

test('the card: pick an option, then Done with date and how ticks the task', async () => {
  const e = env();
  _setReader(read(letter()));
  await drop(e);
  const [task] = await items(e);
  const post = (body) => call(e, `/api/intake/${CODE}/card/${task.id}`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post({ pick: 5 })).status, 400);
  let out = await (await post({ pick: 1 })).json();
  assert.equal(out.card.pick, 1);
  out = await (await post({ pick: null })).json();
  assert.equal(out.card.pick, null);
  await post({ pick: 0 });
  assert.equal((await post({ done: { date: today, how: 'wired' } })).status, 400);
  assert.equal((await post({ done: { date: plus(3), how: 'paid' } })).status, 400); // not in the future
  out = await (await post({ done: { date: today, how: 'paid' } })).json();
  assert.deepEqual(out.card.done, { date: today, how: 'paid' });
  assert.equal(out.card.pick, 0);
  const [after] = await items(e);
  assert.equal(after.done, true);
  assert.equal((await call(e, `/api/intake/${CODE}/card/nosuchtask1`)).status, 404);
});

test('a choice closes the letter: the next step comes in on the deadline, the same card, change and Undo', async () => {
  const e = env();
  _setReader(read(letter()));
  const asked = [];
  _setNexter(async (env, card, option) => { asked.push(option.title); return { task: option.title === 'Pay in instalments' ? 'Set up the EUR 21 a month payment plan (Belastingdienst).' : null, usage: null }; });
  try {
    await drop(e);
    const [task] = await items(e);
    const post = (id, body) => call(e, `/api/intake/${CODE}/card/${id}`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await post(task.id, { choose: 7 })).status, 400);

    let out = await (await post(task.id, { choose: 1 })).json();
    const nextId = task.id.slice(0, 24) + 'next';
    assert.deepEqual(out.next, { id: nextId, text: `Set up the EUR 21 a month payment plan (Belastingdienst) · ${plus(27)}`, from: task.id });
    assert.equal(out.card.pick, 1);
    assert.equal(out.card.chosen.title, 'Pay in instalments');
    assert.equal(out.card.chosen.isNext, false);
    let list = await items(e);
    assert.equal(list.find((i) => i.id === task.id).done, true);
    const next = list.find((i) => i.id === nextId);
    assert.equal(next.section, 'soon');
    assert.equal(next.done, false);
    assert.ok(!/NL91|5123/.test(next.text)); // no IBAN or reference in a task's text
    // The next step opens the same card, the choice stamped.
    assert.ok((await (await call(e, `/api/intake/${CODE}/cards`)).json()).tasks.includes(nextId));
    let card = (await (await call(e, `/api/intake/${CODE}/card/${nextId}`)).json()).card;
    assert.equal(card.iban, IBAN);
    assert.equal(card.chosen.isNext, true);

    // Change, from the next step's card: the same task, new words (the template when Claude has none).
    out = await (await post(nextId, { choose: 0 })).json();
    assert.equal(out.next.id, nextId);
    assert.equal(out.next.text, `Pay at once (Belastingdienst) · ${plus(27)}`);
    list = await items(e);
    assert.equal(list.filter((i) => !i.done).length, 1);
    assert.equal(list.find((i) => i.id === nextId).text, `Pay at once (Belastingdienst) · ${plus(27)}`);

    // Undo: no pick, the letter's task open again, the next step gone.
    out = await (await post(nextId, { unchoose: true })).json();
    assert.equal(out.card.taskId, task.id);
    assert.equal(out.card.pick, null);
    assert.equal(out.card.chosen, null);
    list = await items(e);
    assert.equal(list.find((i) => i.id === task.id).done, false);
    assert.equal(list.find((i) => i.id === nextId), undefined);
    assert.ok(!(await (await call(e, `/api/intake/${CODE}/cards`)).json()).tasks.includes(nextId));
    assert.equal((await post(task.id, { unchoose: true })).status, 404);

    // Chosen again after the Undo: the next step comes back under the same id.
    out = await (await post(task.id, { choose: 1 })).json();
    assert.equal((await items(e)).find((i) => i.id === nextId).done, false);
    assert.deepEqual(asked, ['Pay in instalments', 'Pay at once', 'Pay in instalments']);
  } finally {
    _setNexter(null);
  }
});

test('nextText: Claude\'s words cleaned and masked, the template when there are none', () => {
  const card = { sender: 'Belastingdienst', due: '2026-11-06' };
  assert.equal(nextText('pay NL91 ABNA 0417 1643 00 - today.', card, { title: 'Pay at once' }), 'Pay IBAN ··4300, today · 2026-11-06');
  assert.equal(nextText(null, card, { title: 'Pay at once' }), 'Pay at once (Belastingdienst) · 2026-11-06');
  assert.equal(nextText('', { sender: null, due: null }, { title: 'Call them' }), 'Call them');
});

test('dropping a letter read before cards fills in its card, with no new tasks', async () => {
  const e = env();
  const old = letter();
  for (const k of ['official', 'sender', 'want', 'iban', 'reference', 'reference_label', 'case_number', 'case_label', 'options', 'letter_date']) delete old[k];
  _setReader(read(old));
  await drop(e);
  const before = await items(e);
  assert.equal(before.length, 1);
  // A letter read the old way has a card with nothing on file yet.
  const first = (await (await call(e, `/api/intake/${CODE}/card/${before[0].id}`)).json()).card;
  assert.deepEqual([first.iban, first.reference, first.fresh], [null, null, false]);
  _setReader(read(letter()));
  const r = await (await drop(e)).json();
  assert.equal(r.refilled, true);
  assert.equal((await items(e)).length, 1);
  const { card } = await (await call(e, `/api/intake/${CODE}/card/${before[0].id}`)).json();
  assert.equal(card.iban, IBAN);
  // A third drop is a plain duplicate: no call to the reader.
  _setReader(async () => { throw new Error('should not read'); });
  assert.equal((await (await drop(e)).json()).duplicate, true);
});

test('catch-up, once: dated intake tasks leave Someday, long numbers are masked, old letters get a card', async () => {
  const e = env();
  const old = letter();
  for (const k of ['official', 'sender', 'want', 'iban', 'reference', 'reference_label', 'case_number', 'case_label', 'options', 'letter_date']) delete old[k];
  _setReader(read(old));
  await drop(e);
  const [t] = await items(e);
  const now = Date.now();
  const put = (item) => call(e, `/api/todo/${CODE}/ops`, { method: 'POST', body: JSON.stringify({ ops: [{ op: 'upsert', item }] }) });
  await put({ ...t, section: 'someday', updatedAt: now + 1 });
  await put({ id: 'oldintake001', text: `Pay ref 5123 4567 8901 2340 · ${plus(40)} [intake]`, section: 'someday', done: false, doneAt: null, updatedAt: now, pos: now });
  await put({ id: 'soontoday001', text: `Call them · ${plus(1)} [intake]`, section: 'someday', done: false, doneAt: null, updatedAt: now, pos: now });
  await put({ id: 'undated00001', text: 'Read it some time [intake]', section: 'someday', done: false, doneAt: null, updatedAt: now, pos: now });
  await put({ id: 'notintake001', text: `Mine · ${plus(40)}`, section: 'someday', done: false, doneAt: null, updatedAt: now, pos: now });
  const out = await intakeCatchUp(e, now + 10);
  assert.equal(out.cards, 1);
  const by = Object.fromEntries((await items(e)).map((i) => [i.id, i]));
  assert.equal(by[t.id].section, 'soon');
  assert.equal(by.oldintake001.section, 'soon');
  assert.equal(by.oldintake001.text, `Pay ref ··2340 · ${plus(40)} [intake]`);
  assert.equal(by.soontoday001.section, 'today');
  assert.equal(by.undated00001.section, 'someday');
  assert.equal(by.notintake001.section, 'someday');
  const { card } = await (await call(e, `/api/intake/${CODE}/card/${t.id}`)).json();
  assert.deepEqual([card.iban, card.reference, card.want], [null, null, 'Pay the 2025 income tax assessment']);
  assert.ok(e.HUB_KV.m.get(CATCHUP_KEY));
  assert.deepEqual(await intakeCatchUp(e, now + 20), { skip: 'done before' });
});
