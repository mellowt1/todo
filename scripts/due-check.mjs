// Dates drive placement, against a mocked Worker (no wrangler needed): Soon shows dated tasks first
// by date and time with a "No date" label before the rest, Today shows what is due first, Someday
// keeps newest first. Every value is made up.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run due-check
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

function world() {
  const now = Date.now();
  let k = 0;
  const t = (id, text, section) => ({ id, text, section, done: false, doneAt: null, updatedAt: now - 1000 * ++k, pos: now - 1000 * k });
  const list = [
    t('soonplain001', 'Newest undated task', 'soon'),
    t('soonlate0001', `Third by date · ${day(9)}`, 'soon'),
    t('soonplain002', 'Older undated task', 'soon'),
    t('soonnear0001', `First by date · ${day(1)} 16:00`, 'soon'),
    t('soonmid00001', `Second by date · ${day(4)} [intake]`, 'soon'),
    t('todayplain01', 'Plain today task', 'today'),
    t('todaydue0001', `Due today · ${day(0)} 09:30`, 'today'),
    t('todayfuture1', `Later date in Today · ${day(5)}`, 'today'),
    t('somedaynew01', `Someday dated · ${day(2)}`, 'someday'),
    t('somedayold01', 'Someday older', 'someday'),
  ];
  const items = Object.fromEntries(list.map((i) => [i.id, i]));
  let rev = 1;
  return {
    route(req) {
      const p = new URL(req.url()).pathname;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) {
        for (const o of req.postDataJSON().ops) { if (o.op === 'upsert') items[o.item.id] = o.item; else delete items[o.item.id]; }
        rev++;
        return { items: Object.values(items), rev, updated: new Date().toISOString(), rejected: [] };
      }
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      return null;
    },
  };
}

const order = (page) => page.$$eval('#list > li', (els) => els.map((e) => e.dataset.id || 'label:' + e.textContent.trim()));
const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['due-phone', { width: 390, height: 844 }, 'light'], ['due-desk', { width: 1280, height: 900 }, 'dark']]) {
  const w = world();
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: viewport.width < 700, hasTouch: viewport.width < 700, colorScheme: scheme });
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
  await page.waitForSelector('.row[data-id="todayplain01"]');
  await page.waitForTimeout(600);

  check(JSON.stringify(await order(page)) === JSON.stringify(['todaydue0001', 'todayplain01', 'todayfuture1']), name + ': Today puts what is due first ' + JSON.stringify(await order(page)));
  await page.screenshot({ path: file(name + '-today') });

  await page.locator('[data-section="soon"]:visible').first().click();
  await page.waitForSelector('.row[data-id="soonnear0001"]');
  await page.waitForTimeout(500);
  const soon = await order(page);
  check(JSON.stringify(soon) === JSON.stringify(['soonnear0001', 'soonmid00001', 'soonlate0001', 'label:No date', 'soonplain001', 'soonplain002']), name + ': Soon dated by date, label, then newest first ' + JSON.stringify(soon));
  await page.screenshot({ path: file(name + '-soon') });

  // Tick the undated ones off: the label goes with them.
  for (const id of ['soonplain001', 'soonplain002']) {
    await page.click(`.row[data-id="${id}"] .circle`);
    await page.waitForTimeout(900);
  }
  const after = await order(page);
  check(!after.some((x) => x.startsWith('label:')), name + ': no label once Soon has only dated tasks ' + JSON.stringify(after));

  await page.locator('[data-section="someday"]:visible').first().click();
  await page.waitForSelector('.row[data-id="somedayold01"]');
  await page.waitForTimeout(400);
  check(JSON.stringify(await order(page)) === JSON.stringify(['somedaynew01', 'somedayold01']), name + ': Someday stays newest first');
  check(errors.length === 0, name + ': no page errors ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
