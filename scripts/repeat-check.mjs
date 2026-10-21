// Repeating tasks, against a mocked Worker (no wrangler needed): the Repeat row in the edit sheet,
// a first date for an undated task, Ends, the repeat icon, a tick that brings the next one in,
// Undo that takes both back, the last one of a series, and the bins task's sheet. Every value is made up.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run repeat-check
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
  const items = Object.fromEntries([
    t('plants000001', 'Water the plants', 'today'),
    t('meetup000001', `Club night · ${day(0)}`, 'today', { repeat: { every: '2weeks', until: day(28) } }),
    t('lastone00001', `Last one · ${day(0)}`, 'today', { repeat: { every: 'week', until: day(0) } }),
    t('bins' + compact(day(1)), `Put the bins out (GFT and Restafval) · ${day(0)}`, 'today', { repeat: { every: 'bins', until: null } }),
  ].map((i) => [i.id, i]));
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
      if (p.startsWith('/api/tidy/')) return { text: req.postDataJSON().text, changed: false, kind: 'task' };
      return null;
    },
  };
}

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['repeat-phone', { width: 390, height: 844 }, 'light'], ['repeat-desk', { width: 1280, height: 900 }, 'dark']]) {
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
  await page.waitForSelector('.row[data-id="plants000001"]');
  await page.waitForTimeout(600);
  const sync = () => page.waitForTimeout(1600); // the app's write debounce, then the mocked round trip

  check(await page.$('.row[data-id="meetup000001"] .trep') !== null, name + ': a repeating task shows the repeat icon');
  check(await page.$('.row[data-id="plants000001"] .trep') === null, name + ': a plain task does not');

  // 1. An undated task: Weekly gives it today's date, shown as First date.
  await page.click('.row[data-id="plants000001"] .text');
  await page.waitForSelector('#edit:not([hidden]) #editRepeat');
  await page.waitForTimeout(400);
  check(await page.getAttribute('#editRepeat [data-every=""]', 'aria-checked') === 'true', name + ': Never is chosen for a plain task');
  check(await page.isHidden('#editRepeatMore'), name + ': no date rows while it does not repeat');
  await page.click('#editRepeat [data-every="week"]');
  await page.waitForTimeout(300);
  check(await page.inputValue('#editText') === `Water the plants · ${day(0)}`, name + ': Weekly adds today to the text ' + await page.inputValue('#editText'));
  check(await page.textContent('#repDateLabel') === 'First date', name + ': the date row says First date');
  check(await page.inputValue('#repDate') === day(0), name + ': the date field shows today');
  check((await page.textContent('#repNote')).startsWith('Then '), name + ': the note lists the next dates ' + await page.textContent('#repNote'));
  await page.screenshot({ path: file(name + '-sheet') });
  // A different first date rewrites the text's date.
  await page.fill('#repDate', day(3));
  await page.dispatchEvent('#repDate', 'change');
  await page.waitForTimeout(200);
  check(await page.inputValue('#editText') === `Water the plants · ${day(3)}`, name + ': a new first date rewrites the text');
  // Ends: a date, then Clear.
  await page.fill('#repUntil', day(17));
  await page.dispatchEvent('#repUntil', 'change');
  await page.waitForTimeout(200);
  check(/and it stops\.$/.test(await page.textContent('#repNote')), name + ': an end date says it stops ' + await page.textContent('#repNote'));
  check(await page.textContent('#repUntilClear') === 'Clear', name + ': the end can be cleared');
  await page.screenshot({ path: file(name + '-sheet-ends') });
  await page.click('#editClose');
  await sync();
  check(JSON.stringify(w.items.plants000001.repeat) === JSON.stringify({ every: 'week', until: day(17) }), name + ': the server has the repeat ' + JSON.stringify(w.items.plants000001.repeat));
  check(w.items.plants000001.text === `Water the plants · ${day(3)}`, name + ': and the date in the text');

  // 2. Tick a repeating task: the next one comes in, in Soon, with a fixed id.
  const nextId = 'meetup000001' + compact(day(14));
  await page.click('.row[data-id="meetup000001"] .circle');
  await page.waitForTimeout(500);
  check((await page.textContent('#toastText')).startsWith('Done. Next: '), name + ': the toast names the next one ' + await page.textContent('#toastText'));
  await sync();
  check(w.items[nextId] && w.items[nextId].text === `Club night · ${day(14)}` && w.items[nextId].section === 'soon', name + ': the next one is on the server in Soon');
  check(w.items[nextId] && w.items[nextId].series === 'meetup000001', name + ': with the series id');
  await page.screenshot({ path: file(name + '-ticked') });
  // Undo takes both back.
  await page.click('#toastUndo');
  await sync();
  check(!w.items[nextId] && w.items.meetup000001.done === false, name + ': Undo reopens it and takes the next one away');

  // 3. The last one of a series brings nothing.
  const before = Object.keys(w.items).length;
  await page.waitForTimeout(5500); // the earlier toast has gone
  await page.click('.row[data-id="lastone00001"] .circle');
  await page.waitForTimeout(500);
  check(await page.textContent('#toastText') === 'Done.', name + ': the last one just says Done.');
  await sync();
  check(Object.keys(w.items).length === before, name + ': and makes no next one');

  // 4. Bins: the sheet says where they come from, no Repeat row.
  await page.click(`.row[data-id="bins${compact(day(1))}"] .text`);
  await page.waitForSelector('#edit:not([hidden])');
  await page.waitForTimeout(400);
  check(await page.isHidden('#editRepeat'), name + ': bins have no Repeat row');
  check((await page.textContent('#repNote')).startsWith('From the bin calendar'), name + ': bins say they come from the calendar');
  await page.screenshot({ path: file(name + '-bins') });
  await page.click('#editClose');
  await page.waitForTimeout(400);

  check(errors.length === 0, name + ': no page errors ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
