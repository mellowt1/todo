// "This week", against a mocked Worker (no wrangler needed): the group on top of Soon with its
// labels, the move menu's This week item, the edit sheet's switch, the flag on rows outside Soon,
// and a tick that takes the flag off (Undo puts it back). Every value is made up.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run week-check
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
  const t = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: now - 1000 * ++k, pos: now - 1000 * k, ...extra });
  const items = Object.fromEntries([
    t('flagsoon0001', 'Flagged undated', 'soon', { week: true }),
    t('flagsoon0002', `Flagged dated · ${day(6)}`, 'soon', { week: true }),
    t('datedsoon001', `Dated task · ${day(3)}`, 'soon'),
    t('plainsoon001', 'Undated task', 'soon'),
    t('flagtoday001', 'Flagged in Today', 'today', { week: true }),
    t('plaintoday01', 'Plain in Today', 'today'),
  ].map((i) => [i.id, i]));
  let rev = 1;
  return {
    items,
    route(req) {
      const p = new URL(req.url()).pathname;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) {
        for (const o of req.postDataJSON().ops) {
          if (o.op !== 'upsert') { delete items[o.item.id]; continue; }
          const cur = items[o.item.id] || {};
          const next = { ...o.item };
          for (const f of ['week', 'repeat', 'series', 'link']) { if (next[f] === undefined && cur[f]) next[f] = cur[f]; if (next[f] === null) delete next[f]; }
          items[o.item.id] = next;
        }
        rev++;
        return { items: Object.values(items), rev, updated: new Date().toISOString(), rejected: [] };
      }
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      if (p.startsWith('/api/tidy/')) return { text: req.postDataJSON().text, changed: false, kind: 'task' };
      return null;
    },
  };
}

const order = (page) => page.$$eval('#list > li', (els) => els.map((e) => e.dataset.id || 'label:' + e.firstChild.textContent.trim()));
const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['week-phone', { width: 390, height: 844 }, 'light'], ['week-desk', { width: 1280, height: 900 }, 'dark']]) {
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
  await page.waitForSelector('.row[data-id="plaintoday01"]');
  await page.waitForTimeout(600);
  const sync = () => page.waitForTimeout(1600);

  check(await page.$('.row[data-id="flagtoday001"] .tweek') !== null, name + ': a flagged task in Today shows the flag');
  check(await page.$('.row[data-id="plaintoday01"] .tweek') === null, name + ': a plain one does not');

  await page.locator('[data-section="soon"]:visible').first().click();
  await page.waitForSelector('.row[data-id="plainsoon001"]');
  await page.waitForTimeout(500);
  const soon = await order(page);
  check(JSON.stringify(soon) === JSON.stringify(['label:This week', 'flagsoon0002', 'flagsoon0001', 'label:Dated', 'datedsoon001', 'label:No date', 'plainsoon001']), name + ': Soon has This week, Dated, No date ' + JSON.stringify(soon));
  check((await page.textContent('.sublabel-week span')) === '2 left', name + ': the group says how many are left');
  check(await page.$('#list .tweek') === null, name + ': no flag on rows inside the group');
  await page.screenshot({ path: file(name + '-soon') });

  // The move menu flags a task; it joins the group.
  await page.click('.row[data-id="plainsoon001"] .text', { button: 'right' });
  await page.waitForSelector('.menu:not([hidden]) .sec-week');
  check((await page.textContent('.menu .sec-week')).trim() === 'This week', name + ': the menu offers This week');
  await page.screenshot({ path: file(name + '-menu') });
  await page.click('.menu .sec-week');
  await page.waitForTimeout(500);
  check((await order(page)).indexOf('plainsoon001') < (await order(page)).indexOf('label:Dated'), name + ': the flagged task joins the group');
  await sync();
  check(w.items.plainsoon001.week === true, name + ': the server has the flag');
  await page.click('#toastUndo');
  await sync();
  check(w.items.plainsoon001.week === undefined, name + ': Undo takes the flag off again');

  // The edit sheet's switch takes a flag off.
  await page.click('.row[data-id="flagsoon0001"] .text');
  await page.waitForSelector('#edit:not([hidden]) #editWeek');
  await page.waitForTimeout(400);
  check(await page.isChecked('#editWeek'), name + ': the switch shows the flag');
  await page.screenshot({ path: file(name + '-sheet') });
  if (viewport.width < 700) await page.tap('#editWeek'); else await page.click('.week-row');
  await page.waitForTimeout(200);
  check(!(await page.isChecked('#editWeek')), name + ': the switch turns off');
  await page.click('#editClose');
  await sync();
  check(w.items.flagsoon0001.week === undefined, name + ': the server has it off');

  // A tick takes the flag off; Undo brings it back.
  await page.waitForTimeout(5500);
  await page.click('.row[data-id="flagsoon0002"] .circle');
  await sync();
  check(w.items.flagsoon0002.done === true && w.items.flagsoon0002.week === undefined, name + ': done takes the flag off');
  await page.click('#toastUndo');
  await sync();
  check(w.items.flagsoon0002.done === false && w.items.flagsoon0002.week === true, name + ': Undo brings the flag back');

  check(errors.length === 0, name + ': no page errors ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
