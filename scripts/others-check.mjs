// The Others lane, against a mocked Worker (no wrangler needed): the fourth section grouped by
// person, adding a task for someone from the add sheet, the For field in the edit sheet, Hand back
// (language, copy, mark handed back) and Done history. Every name is made up.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run others-check
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8091/';
const CODE = 'abcdefgh23456789';
const OUT = new URL('../screenshots/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const file = (n) => fileURLToPath(new URL(n + '.png', OUT));
let failed = false;
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 150)); } };
const check = (ok, what) => { if (!ok) { failed = true; console.error('FAIL:', what); } else console.log('ok:', what); };

function world() {
  const now = Date.now();
  const t = (id, text, section, ago, person) => ({ id, text, section, done: false, doneAt: null, updatedAt: now - ago, pos: now - ago, ...(person ? { person } : {}) });
  const items = {};
  for (const it of [
    t('dadprinter1', 'Set up the new printer', 'others', 9e5, 'Dad'),
    t('dadpension1', 'Check the pension letter', 'others', 3e5, 'Dad'),
    t('momphone001', 'Find a cheaper phone plan', 'others', 6e5, 'Mom'),
    t('nickcv00001', 'Read his CV and send notes', 'others', 2e5, 'Nick'),
    t('mine0000001', 'Book the boiler service', 'today', 1e5),
  ]) items[it.id] = it;
  let rev = 1;
  return {
    items, drafts: [],
    route(req) {
      const p = new URL(req.url()).pathname;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) {
        for (const o of req.postDataJSON().ops) {
          if (o.op === 'delete') { delete items[o.item.id]; continue; }
          const next = { ...o.item };
          if (next.person === null) delete next.person;
          items[o.item.id] = next;
        }
        rev++;
        return { items: Object.values(items), rev, updated: new Date().toISOString(), rejected: [] };
      }
      if (p === `/api/others/${CODE}/draft`) {
        const b = req.postDataJSON();
        this.drafts.push(b.lang);
        return { text: { nl: 'Hoi pap, het lukt me deze week niet om de printer in te stellen. Wil jij het voorlopig weer oppakken?', en: 'Hi Dad, I can’t set up the printer this week. Could you take it back for now?', es: 'Hola papá, esta semana no puedo configurar la impresora. ¿Puedes retomarlo tú?' }[b.lang] };
      }
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      return null;
    },
  };
}

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['others-phone', { width: 390, height: 844 }, 'light'], ['others-desk', { width: 1280, height: 900 }, 'dark']]) {
  const w = world();
  const phone = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: scheme, permissions: ['clipboard-read', 'clipboard-write'] });
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
  await page.waitForSelector('.row[data-id="mine0000001"]');
  check(!(await page.$('.row[data-id="dadprinter1"]')), name + ': Others tasks are not in Today');

  if (phone) await page.click('#switcher [data-section="others"]'); else await page.click('.nav-item[data-section="others"]');
  await page.waitForSelector('.row[data-id="dadprinter1"]');
  const heads = await page.$$eval('#list .whohead', (els) => els.map((e) => e.textContent.trim()));
  check(heads.join('|') === 'Dad 2|Mom 1|Nick 1', name + ': grouped by person ' + heads.join('|'));
  check((await page.$$('#list .hb-btn')).length === 4, name + ': a Hand back button on each');
  if (!phone) check((await page.textContent('.nav-item[data-section="others"] .count')) === '4', name + ': sidebar count 4');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': no sideways scroll');
  await page.waitForTimeout(900); // the tab thumb and the rows finish gliding
  await page.screenshot({ path: file(name) });

  // Hand back: English by default, switch to Dutch, copy, mark handed back.
  await page.click('.row[data-id="dadprinter1"] .hb-btn');
  await page.waitForFunction(() => !document.getElementById('hbDraft').classList.contains('wait') && document.getElementById('hbDraft').textContent.length > 20);
  check((await page.textContent('#hbHead')) === 'Hand back to Dad', name + ': sheet names the person');
  await page.click('#hbLang [data-lang="nl"]');
  await page.waitForFunction(() => document.getElementById('hbDraft').textContent.startsWith('Hoi pap'));
  check(w.drafts.join() === 'en,nl', name + ': drafts asked for en then nl ' + w.drafts);
  await page.click('#hbCopy');
  check((await page.evaluate(() => navigator.clipboard.readText())).startsWith('Hoi pap'), name + ': draft copied');
  await page.locator('#handback .sheet').screenshot({ path: file(name + '-handback') });
  await page.click('#hbMark');
  await page.waitForTimeout(800);
  check(await until(() => w.items.dadprinter1.done === true && w.items.dadprinter1.handedBack === true), name + ': closed as handed back');
  check(!(await page.$('#list .row[data-id="dadprinter1"]')), name + ': off the list');

  // Add a task for Mom from the add screen.
  if (phone) await page.click('#fab'); else await page.click('#addDesk');
  const box = phone ? '#capFor' : '#inlineFor';
  await page.waitForSelector(box + ' .for-chip');
  await page.click(`${box} .for-chip[data-for="Mom"]`);
  if (phone) check((await page.textContent('#capLabel')) === 'Adds to Others · Mom', name + ': label says Others · Mom');
  const input = phone ? '#capInput' : '#inlineInput';
  await page.fill(input, 'Call the energy company');
  await page.press(input, 'Enter');
  await page.waitForTimeout(600);
  const added = await until(() => Object.values(w.items).find((i) => i.text === 'Call the energy company'));
  check(added && added.section === 'others' && added.person === 'Mom', name + ': added to Others for Mom');
  // "Me" from the Others view puts it in Today.
  await page.click(`${box} .for-chip[data-for=""]`);
  await page.fill(input, 'My own thing');
  await page.press(input, 'Enter');
  await page.waitForTimeout(600);
  const mine = await until(() => Object.values(w.items).find((i) => i.text === 'My own thing'));
  check(mine && mine.section === 'today' && !mine.person, name + ': Me puts it in Today');
  if (phone) await page.click('#capDone'); else await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Edit sheet: clearing For makes it Paul's own, in Soon.
  await page.click('.row[data-id="nickcv00001"] .text');
  await page.waitForSelector('#edit:not([hidden])');
  check((await page.inputValue('#editFor')) === 'Nick', name + ': edit sheet shows For: Nick');
  await page.fill('#editFor', '');
  await page.press('#editFor', 'Enter');
  await page.waitForTimeout(400);
  check(await until(() => w.items.nickcv00001.section === 'soon' && !w.items.nickcv00001.person), name + ': cleared For moves it to Soon');
  await page.click('#editClose');
  await page.waitForTimeout(500);

  // Done history says who it was for.
  if (phone) { /* the phone reaches Done from the title; checked on desktop */ } else {
    await page.click('.nav-item[data-section="done"]');
    await page.waitForSelector('.drow');
    const metas = await page.$$eval('.drow .meta:not(.dtime)', (els) => els.map((e) => e.textContent));
    check(metas.includes('Handed back to Dad'), name + ': Done history says Handed back to Dad');
  }
  check(errors.length === 0, name + ': no page errors ' + errors.join('; '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
console.log('all others checks pass');
