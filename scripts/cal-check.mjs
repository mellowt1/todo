// On the calendar (2026-11-04), against a mocked Worker (no wrangler needed): an appointment Day has
// confirmed (cal = the date in its text, still to come) waits in Soon behind one shut
// "N on the calendar" line and is not counted; a tap unfolds it; one whose date changed after Day
// confirmed it, one Day has not confirmed and one that is not an appointment stay in the list; the
// repeats line still comes last. Every value is made up.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run cal-check
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
  const list = [
    t('todayplain01', 'Plain today task', 'today'),
    t('caldent00001', `Dentist · ${day(3)} 14:00`, 'soon', { appt: true, cal: day(3) }),
    t('calhair00001', `Haircut · ${day(8)}`, 'soon', { appt: true, cal: day(8) }),
    t('calmoved0001', `Psychologist · ${day(5)} 10:00`, 'soon', { appt: true, cal: day(4) }), // date changed since Day confirmed
    t('calnew000001', `Physio · ${day(6)} 09:00`, 'soon', { appt: true }), // Day has not confirmed it yet
    t('soonplain001', `Return the lamp · ${day(2)}`, 'soon'),
    t('soonplain002', 'Call the bank', 'soon'),
    t('repclaim0001', `Club claim · ${day(14)}`, 'soon', { repeat: { every: '2weeks', until: null } }),
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
            for (const f of ['repeat', 'series', 'link', 'appt', 'cal']) { if (next[f] === undefined && cur[f]) next[f] = cur[f]; if (next[f] === null) delete next[f]; }
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
for (const [name, viewport, scheme] of [['cal-phone', { width: 390, height: 844 }, 'light'], ['cal-desk', { width: 1280, height: 900 }, 'dark']]) {
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

  // 4 in the list (moved, new, lamp, bank); the 2 on the calendar and the repeat are not counted.
  check((await counts(page)).every((c) => c === '4'), name + ': the Soon count leaves the calendar ones out ' + JSON.stringify(await counts(page)));

  await page.locator('[data-section="soon"]:visible').first().click();
  await page.waitForSelector('.row[data-id="soonplain001"]');
  await page.waitForTimeout(500);
  const shut = await order(page);
  check(JSON.stringify(shut) === JSON.stringify(['soonplain001', 'calmoved0001', 'calnew000001', 'label:No date', 'soonplain002', 'label:2 on the calendar', 'label:1 repeat']),
    name + ': confirmed appointments wait under one shut line before the repeats ' + JSON.stringify(shut));
  check(await page.getAttribute('.cal-fold', 'aria-expanded') === 'false', name + ': the line says it is shut');
  await page.screenshot({ path: file(name + '-shut') });

  await page.click('.cal-fold');
  await page.waitForTimeout(500);
  const open = await order(page);
  check(JSON.stringify(open) === JSON.stringify(['soonplain001', 'calmoved0001', 'calnew000001', 'label:No date', 'soonplain002', 'label:2 on the calendar', 'caldent00001', 'calhair00001', 'label:1 repeat']),
    name + ': a tap shows them, by date ' + JSON.stringify(open));
  check(await page.getAttribute('.cal-fold', 'aria-expanded') === 'true', name + ': the line says it is open');
  await page.screenshot({ path: file(name + '-open') });

  check(!errors.length, name + ': no page errors ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
console.log(failed ? 'cal-check: FAILED' : 'cal-check: all good');
process.exit(failed ? 1 : 0);
