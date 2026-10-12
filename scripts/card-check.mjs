// The letter action card, against a mocked Worker (no wrangler needed). Opens a letter task as a
// card, checks the facts and "not on file", copy, the options, the portal link, Done with date and
// how, Edit task, and that a normal task still opens the edit sheet. Every value is made up.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run card-check
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8091/';
const CODE = 'abcdefgh23456789';
const OUT = new URL('../screenshots/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const file = (n) => fileURLToPath(new URL(n + '.png', OUT));
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.error('FAIL:', what); } else console.log('ok:', what); };

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
const IBAN = 'NL91 ABNA 0417 1643 00';

function world() {
  const now = Date.now();
  const items = {
    letter000001: { id: 'letter000001', text: `Pay the 2025 income tax assessment · ${day(27)} [intake]`, section: 'today', done: false, doneAt: null, updatedAt: now - 5000, pos: now - 5000 },
    plain0000001: { id: 'plain0000001', text: 'Water the plants', section: 'today', done: false, doneAt: null, updatedAt: now - 9000, pos: now - 9000 },
  };
  const card = {
    taskId: 'letter000001', letterId: 'rec1', sender: 'Belastingdienst', who: 'me', letterDate: day(-2),
    want: 'Pay the 2025 income tax assessment', due: day(27), amount: { value: 1247, currency: 'EUR' },
    iban: IBAN, reference: '5123 4567 8901 2340', referenceLabel: 'Betalingskenmerk', caseNumber: null, caseLabel: null,
    options: [{ title: 'Pay at once', detail: 'EUR 1,247.00 before the deadline' }, { title: 'Pay in instalments', detail: 'Ask for a payment plan before the deadline' }],
    fresh: true, pick: null, portal: { name: 'Belastingdienst', url: 'https://mijn.belastingdienst.nl', host: 'mijn.belastingdienst.nl' }, done: null,
  };
  let rev = 1;
  return {
    posts: [],
    route(req) {
      const u = new URL(req.url());
      const p = u.pathname;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) {
        for (const o of req.postDataJSON().ops) { if (o.op === 'upsert') items[o.item.id] = o.item; else delete items[o.item.id]; }
        rev++;
        return { items: Object.values(items), rev, updated: new Date().toISOString(), rejected: [] };
      }
      if (p === `/api/intake/${CODE}/cards`) return { tasks: ['letter000001'] };
      if (p === `/api/intake/${CODE}/card/letter000001`) {
        if (req.method() === 'GET') return { card };
        const body = req.postDataJSON();
        this.posts.push(body);
        if ('pick' in body) card.pick = body.pick;
        if (body.done) { card.done = body.done; items.letter000001 = { ...items.letter000001, done: true, doneAt: Date.now(), updatedAt: Date.now() }; rev++; }
        return { ok: true, card };
      }
      if (p === `/api/intake/${CODE}`) return { items: [] };
      return null;
    },
  };
}

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['card-phone', { width: 390, height: 844 }, 'light'], ['card-desk', { width: 1280, height: 900 }, 'dark']]) {
  const w = world();
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: viewport.width < 700, hasTouch: viewport.width < 700, colorScheme: scheme, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', async (r) => {
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
    const out = w.route(r.request());
    return out ? r.fulfill({ json: out, headers: h }) : r.fulfill({ status: 404, json: { error: 'not found' }, headers: h });
  });
  await page.goto(APP + '?c=' + CODE + '&api=' + encodeURIComponent('http://localhost:8799'));
  await page.waitForSelector('.row[data-id="letter000001"]');
  await page.waitForTimeout(2000); // the card list loads after the list

  await page.click('.row[data-id="letter000001"] .text');
  await page.waitForSelector('#card:not([hidden]) .card-want');
  check(await page.textContent('#cardFrom') === `Belastingdienst · letter of ${+day(-2).slice(8)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+day(-2).slice(5, 7) - 1]}`, name + ': sender and letter date ' + await page.textContent('#cardFrom'));
  check(await page.textContent('.card-want') === 'Pay the 2025 income tax assessment', name + ': what they want');
  check(await page.textContent('.card-left') === '27 days left', name + ': days left');
  const facts = await page.$$eval('.card-fact', (els) => els.map((e) => e.querySelector('.card-v').textContent));
  check(facts.join('|') === `€1,247.00|${IBAN}|5123 4567 8901 2340|not on file`, name + ': facts ' + facts.join('|'));
  check((await page.$$('.card-copy')).length === 3, name + ': three copy buttons, none for what is not on file');
  check(await page.getAttribute('.card-portal', 'href') === 'https://mijn.belastingdienst.nl' && await page.getAttribute('.card-portal', 'target') === '_blank', name + ': portal link');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': no sideways scroll');
  await page.locator('#card .sheet').screenshot({ path: file(name) });

  await page.click('.card-copy[data-copy="iban"]');
  check(await page.evaluate(() => navigator.clipboard.readText()) === 'NL91ABNA0417164300', name + ': IBAN copies without spaces');
  await page.click('.card-copy[data-copy="amount"]');
  check(await page.evaluate(() => navigator.clipboard.readText()) === '1247,00', name + ': amount copies as 1247,00');

  await page.click('.card-opt[data-pick="1"]');
  await page.waitForTimeout(200);
  check(await page.getAttribute('.card-opt[data-pick="1"]', 'aria-checked') === 'true' && w.posts.at(-1).pick === 1, name + ': option picked and saved');

  await page.click('.card-done');
  check(await page.isDisabled('.card-save'), name + ': Save waits for how');
  await page.click('.card-hows [data-how="paid"]');
  await page.locator('#card .sheet').screenshot({ path: file(name + '-done') });
  await page.click('.card-save');
  await page.waitForSelector('.card-stamp');
  const stamp = await page.textContent('.card-stamp');
  check(/^✓ Done \d+ \w{3} · paid · pay in instalments$/.test(stamp), name + ': stamp ' + stamp);
  check(w.posts.at(-1).done && w.posts.at(-1).done.how === 'paid' && w.posts.at(-1).done.date === day(0), name + ': done sent with today and paid');
  await page.click('#cardClose');
  await page.waitForTimeout(1500);
  check(!(await page.$('#list .row[data-id="letter000001"]')), name + ': the task is ticked off the list');

  await page.click('.row[data-id="plain0000001"] .text');
  await page.waitForSelector('#edit:not([hidden])');
  check(await page.$eval('#card', (e) => e.hidden), name + ': a normal task opens the edit sheet');
  check(errors.length === 0, name + ': no page errors ' + errors.join('; '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
console.log('all card checks pass');
