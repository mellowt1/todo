// Soon's repeats fold away (2026-11-04), against a mocked Worker (no wrangler needed): repeating
// tasks sit under one "N repeats" line at the bottom of Soon, shut by default and not counted; a tap
// unfolds them, a tick inside brings the next one in under the fold, a This week flag keeps a repeat
// in the list, and a Soon of only repeats shows just the line. Every value is made up.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run fold-check
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
const compact = (d) => d.replace(/-/g, '');

function world() {
  const now = Date.now();
  let k = 0;
  const t = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: now - 1000 * ++k, pos: now - 1000 * k, ...extra });
  const list = [
    t('todayplain01', 'Plain today task', 'today'),
    t('soonnear0001', `Return the lamp · ${day(1)}`, 'soon'),
    t('soonhair0001', `Haircut · ${day(2)} 11:00`, 'soon'),
    t('soonplain001', 'Call the bank', 'soon'),
    t('soonplain002', 'Book the dentist', 'soon'),
    t('repclaim0001', `Club claim · ${day(14)}`, 'soon', { repeat: { every: '2weeks', until: null } }),
    t('repmeet00001', `Group evening · ${day(5)}`, 'soon', { repeat: { every: '2weeks', until: day(40) } }),
    t('bins' + compact(day(7)), `Put the bins out (GFT and Restafval) · ${day(6)}`, 'soon', { repeat: { every: 'bins', until: null } }),
    t('repweek00001', `Weekly call · ${day(3)}`, 'soon', { repeat: { every: 'week', until: null }, week: true }),
    t('repsomeday01', `Someday repeat · ${day(9)}`, 'someday', { repeat: { every: 'month', until: null } }),
  ];
  const items = Object.fromEntries(list.map((i) => [i.id, i]));
  let rev = 1;
  return {
    items,
    route(req) {
      const p = new URL(req.url()).pathname;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) {
        for (const o of req.postDataJSON().ops) {
          if (o.op === 'upsert') {
            const cur = items[o.item.id] || {};
            const next = { ...o.item };
            for (const f of ['repeat', 'series', 'link']) { if (next[f] === undefined && cur[f]) next[f] = cur[f]; if (next[f] === null) delete next[f]; }
            items[o.item.id] = next;
          } else delete items[o.item.id];
        }
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
const counts = (page) => page.$$eval('#switcher [data-section="soon"] .scount, .nav-item[data-section="soon"] .count', (els) => els.map((e) => e.textContent));
const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['fold-phone', { width: 390, height: 844 }, 'light'], ['fold-desk', { width: 1280, height: 900 }, 'dark']]) {
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
  await page.goto(APP + '?c=' + CODE + '&noforce&api=' + encodeURIComponent('http://localhost:8799'));
  await page.waitForSelector('.row[data-id="todayplain01"]');
  await page.waitForTimeout(600);

  // 4 plain + 1 flagged repeat count; the 3 folded repeats do not.
  check((await counts(page)).every((c) => c === '5'), name + ': the Soon count leaves the folded repeats out ' + JSON.stringify(await counts(page)));

  await page.locator('[data-section="soon"]:visible').first().click();
  await page.waitForSelector('.row[data-id="soonnear0001"]');
  await page.waitForTimeout(500);
  const shut = await order(page);
  check(JSON.stringify(shut) === JSON.stringify(['label:This week1 left', 'repweek00001', 'label:Dated', 'soonnear0001', 'soonhair0001', 'label:No date', 'soonplain001', 'soonplain002', 'label:3 repeats']),
    name + ': Soon ends with one shut "3 repeats" line, a flagged repeat stays in This week ' + JSON.stringify(shut));
  check(await page.getAttribute('.rep-fold', 'aria-expanded') === 'false', name + ': the fold says it is shut');
  await page.screenshot({ path: file(name + '-shut') });

  await page.click('.rep-fold');
  await page.waitForTimeout(500);
  const open = await order(page);
  check(JSON.stringify(open.slice(-4)) === JSON.stringify(['label:3 repeats', 'repmeet00001', 'bins' + compact(day(7)), 'repclaim0001']), name + ': the fold opens onto the repeats by date ' + JSON.stringify(open));
  check(await page.getAttribute('.rep-fold', 'aria-expanded') === 'true', name + ': the fold says it is open');
  await page.screenshot({ path: file(name + '-open') });

  // A tick inside the fold: the next one comes in under the fold, the count stays out of it.
  await page.click('.row[data-id="repmeet00001"] .circle');
  await page.waitForTimeout(1800);
  const after = await order(page);
  const nextId = 'repmeet00001'.slice(0, 20) + compact(day(19));
  check(w.items.repmeet00001.done === true && after.indexOf(nextId) > after.indexOf('label:3 repeats'), name + ': the next one sits under the fold ' + JSON.stringify(after));
  check((await counts(page)).every((c) => c === '5'), name + ': the count still leaves repeats out');

  await page.click('.rep-fold');
  await page.waitForTimeout(600);
  check((await order(page)).at(-1) === 'label:3 repeats', name + ': a second tap shuts it again');

  // Someday's repeats are not folded.
  await page.locator('[data-section="someday"]:visible').first().click();
  await page.waitForSelector('.row[data-id="repsomeday01"]');
  check(await page.$('.rep-fold') === null, name + ': Someday has no fold');

  // A Soon of only repeats: just the line, no empty message.
  for (const id of ['soonnear0001', 'soonhair0001', 'soonplain001', 'soonplain002', 'repweek00001']) w.items[id] = { ...w.items[id], done: true, doneAt: Date.now(), updatedAt: Date.now() };
  await page.reload();
  await page.waitForSelector('.row[data-id="repsomeday01"]'); // the app opens where it was left
  await page.locator('[data-section="soon"]:visible').first().click();
  await page.waitForSelector('.rep-fold');
  await page.waitForTimeout(400);
  check(JSON.stringify(await order(page)) === JSON.stringify(['label:3 repeats']) && await page.isHidden('#empty'), name + ': only repeats: the line alone');
  check((await counts(page)).every((c) => c === ''), name + ': and no count');
  await page.screenshot({ path: file(name + '-only') });

  check(errors.length === 0, name + ': no page errors ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
