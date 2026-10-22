// Lanes, against a mocked Worker (no wrangler needed): the phone's Lanes tab with a head per
// lane, the PC sidebar's lane line, the move menu and the edit sheet sending a task to a lane,
// and a new task on the Lanes tab landing in the first lane. Every value is made up.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run lanes-check
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

function world() {
  const now = Date.now();
  let k = 0;
  const t = (id, text, section) => ({ id, text, section, done: false, doneAt: null, updatedAt: now - 1000 * ++k, pos: now - 1000 * k });
  const items = Object.fromEntries([
    t('build0000001', 'Add birthdays to Day', 'build'),
    t('build0000002', 'A sketch for the kitchen app', 'build'),
    t('fun000000001', 'Play a flight game', 'fun'),
    t('soon00000001', 'Renew the passport', 'soon'),
    t('today0000001', 'Water the plants', 'today'),
  ].map((i) => [i.id, i]));
  let rev = 1;
  return {
    items,
    route(req) {
      const p = new URL(req.url()).pathname;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) {
        for (const o of req.postDataJSON().ops) { if (o.op === 'upsert') items[o.item.id] = { ...(items[o.item.id] || {}), ...o.item }; else delete items[o.item.id]; }
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
for (const [name, viewport, scheme] of [['lanes-phone', { width: 390, height: 844 }, 'light'], ['lanes-desk', { width: 1280, height: 900 }, 'dark']]) {
  const w = world();
  const phone = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: scheme });
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
  await page.waitForSelector('.row[data-id="today0000001"]');
  await page.waitForTimeout(600);
  const sync = () => page.waitForTimeout(1600);

  // The move menu sends a task to Build.
  await page.click('.row[data-id="today0000001"] .text', { button: 'right' });
  await page.waitForSelector('.menu:not([hidden]) [data-move="build"]');
  check((await page.$$eval('.menu [data-move]', (b) => b.map((x) => x.textContent))).join() === 'Today,Soon,Someday,Build,Fun', name + ': the menu moves to Today, Soon, Someday, Build or Fun');
  await page.click('.menu [data-move="build"]');
  await sync();
  check(w.items.today0000001.section === 'build', name + ': moved to Build');

  // The Lanes tab (phone) or the Build line (PC).
  const tab = phone ? 'lanes' : 'build';
  await page.locator(`[data-section="${tab}"]:visible`).first().click();
  await page.waitForSelector('.row[data-id="build0000001"]');
  await page.waitForTimeout(400);
  check(await page.textContent('#title') === (phone ? 'Lanes' : 'Build'), name + ': the title says ' + await page.textContent('#title'));
  const rows = await order(page);
  check(JSON.stringify(rows) === JSON.stringify(phone ? ['label:Build', 'today0000001', 'build0000001', 'build0000002', 'label:Fun', 'fun000000001'] : ['today0000001', 'build0000001', 'build0000002']), name + ': the lane lists its tasks ' + JSON.stringify(rows));
  if (phone) check((await page.textContent('.sublabel-lane span')) === '3', name + ': the Build head counts 3');
  if (phone) check((await page.textContent('#switcher [data-section="lanes"] .scount')) === '4', name + ': the switcher counts the lanes');
  else check((await page.textContent('.nav-item[data-section="build"] .count')) === '3', name + ': the sidebar counts Build');
  await page.screenshot({ path: file(name) });

  // The edit sheet: the lane group shows the lane; Soon takes it back out.
  await page.click('.row[data-id="build0000002"] .text');
  await page.waitForSelector('#edit:not([hidden]) #editLane');
  await page.waitForTimeout(400);
  check(await page.getAttribute('#editLane [data-section="build"]', 'aria-checked') === 'true' && await page.$$eval('#editSeg [aria-checked="true"]', (b) => b.length) === 0, name + ': the sheet shows Build, no section');
  await page.screenshot({ path: file(name + '-sheet') });
  await page.click('#editSeg [data-section="soon"]');
  await page.click('#editClose');
  await sync();
  check(w.items.build0000002.section === 'soon', name + ': Soon takes it out of the lane');

  // A new task on this tab lands in Build.
  await page.waitForTimeout(5500);
  if (phone) await page.click('#fab'); else await page.keyboard.press('n');
  await page.waitForTimeout(400);
  const box = phone ? '#capInput' : '#inlineInput';
  await page.fill(box, 'Dark mode for the lift app');
  await page.keyboard.press('Enter');
  await sync();
  const added = Object.values(w.items).find((i) => i.text === 'Dark mode for the lift app');
  check(added && added.section === 'build', name + ': a new task lands in Build ' + (added && added.section));

  await page.keyboard.press(phone ? 'Enter' : 'Escape'); // finished adding
  await page.waitForTimeout(500);
  // Return: a new task starting with Return and no date asks for one once the add is done.
  await page.locator('[data-section="today"]:visible').first().click();
  await page.waitForTimeout(5500);
  if (phone) await page.click('#fab'); else await page.keyboard.press('n');
  await page.waitForTimeout(400);
  await page.fill(box, 'Return the drill to Sam');
  await page.keyboard.press('Enter');
  if (phone) { await page.waitForTimeout(300); await page.keyboard.press('Enter'); } // an empty Return closes the add sheet
  await page.waitForSelector('#ret:not([hidden])', { timeout: 8000 }).catch(() => {});
  check(await page.isVisible('#ret') && (await page.textContent('#retName')) === 'Return the drill to Sam', name + ': Return asks for a date');
  await page.waitForTimeout(600); // the sheet has arrived
  await page.screenshot({ path: file(name + '-return') });
  const by = new Date(Date.now() + 9 * 864e5).toLocaleDateString('en-CA');
  await page.fill('#retDate', by);
  await page.click('#retSave');
  await sync();
  const ret = Object.values(w.items).find((i) => i.text.startsWith('Return the drill'));
  check(ret && ret.text === 'Return the drill to Sam · ' + by, name + ': the date goes on the task ' + (ret && ret.text));
  // A Return task that already has a date does not ask.
  if (phone) await page.click('#fab'); else await page.keyboard.press('n');
  await page.waitForTimeout(400);
  await page.fill(box, 'Return the lamp · ' + by);
  await page.keyboard.press('Enter');
  if (phone) { await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
  await page.waitForTimeout(2500);
  check(!(await page.isVisible('#ret')), name + ': a dated Return task does not ask');

  check(errors.length === 0, name + ': no page errors ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
