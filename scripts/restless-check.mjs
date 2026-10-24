// "restless: ..." in New task, against a mocked Worker: the sheet's label says where it goes, the
// line goes to the hub's Restless list (never onto To-do) and the toast says what the hub made of it;
// on the desktop the same through the inline add field. Every value is made up.
//   PORT=8121 npm run serve, then: APP_URL=http://localhost:8121/ npm run restless-check
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8121/';
const CODE = 'abcdefgh23456789';
const OUT = new URL('../screenshots/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const file = (n) => fileURLToPath(new URL(n + '.png', OUT));
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.error('FAIL:', what); } else console.log('ok:', what); };

function world() {
  const now = Date.now();
  const items = { todaylucho01: { id: 'todaylucho01', text: 'Ticket for Lucho November', section: 'today', done: false, doneAt: null, updatedAt: now - 1000, pos: now - 1000 } };
  const w = {
    items, adds: [], ops: [],
    route(req) {
      const p = new URL(req.url()).pathname;
      const body = req.method() === 'POST' ? req.postDataJSON() : null;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev: 1, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) { w.ops.push(...body.ops); return { items: Object.values(items), rev: 2, updated: new Date().toISOString(), rejected: [] }; }
      if (p === `/api/restless/${CODE}/add`) {
        w.adds.push(body);
        return { item: { id: 'restless0001', text: 'Kayak on the Vliet', kind: 'outside', mins: 120, place: 'outside', costs: true, weight: 1, done: 0, skipped: 0, hiddenUntil: null, source: 'todo' } };
      }
      if (p === `/api/energy/${CODE}`) return { level: null, setAt: null, until: null, source: null, pick: null, play: null };
      if (p === `/api/dread/${CODE}`) return { running: null, stopped: null, offer: null };
      if (p === `/api/tidy/${CODE}`) return { text: 'x', changed: false, kind: 'task' };
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      if (p.startsWith('/api/hiscores/')) return { skills: [] };
      if (p === `/api/waiting/${CODE}`) return { items: [], open: 0, due: 0, names: [] };
      if (p === `/api/soundtrack/${CODE}`) return { lists: { wired: [], normal: [], drained: [] }, max: 3 };
      if (p === `/api/spotify/${CODE}`) return { configured: true, connected: false };
      return null;
    },
  };
  return w;
}

const LINE = 'restless: kayak on the Vliet 2h outside €';
const browser = await chromium.launch();
for (const [name, viewport] of [['restless-phone', { width: 390, height: 844 }], ['restless-desk', { width: 1280, height: 900 }]]) {
  const w = world();
  const phone = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone });
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
  await page.waitForSelector('.row[data-id="todaylucho01"]');
  await page.waitForTimeout(500);

  if (phone) {
    await page.locator('#fab').click();
    await page.waitForSelector('#capture:not([hidden]) #capInput');
    check((await page.textContent('#capLabel')) === 'Adds to Today', name + ': the sheet adds to Today');
    await page.type('#capInput', LINE);
    check((await page.textContent('#capLabel')) === 'Adds to the Restless list', name + ': typing restless: says where it goes');
    await page.screenshot({ path: file(name + '-typing') });
    await page.keyboard.press('Enter');
  } else {
    await page.locator('#addDesk').click();
    await page.waitForSelector('#inlineInput');
    await page.type('#inlineInput', LINE);
    await page.keyboard.press('Enter');
  }
  await page.waitForSelector('.toast', { timeout: 4000 });
  await page.waitForTimeout(300);
  const toastText = (await page.textContent('.toast')).trim();
  check(toastText.startsWith('On the Restless list: Kayak on the Vliet · 2 h+ · outside · costs money.'), name + ': the toast says what the hub made of it ' + JSON.stringify(toastText));
  check(w.adds.length === 1 && w.adds[0].text === LINE && w.adds[0].source === 'todo', name + ': the hub got the line ' + JSON.stringify(w.adds));
  await page.waitForTimeout(800);
  check(!w.ops.some((o) => o.item && /kayak/i.test(o.item.text || '')), name + ': no task was made of it');
  check(!(await page.locator('.row', { hasText: 'kayak' }).count()), name + ': nothing new on Today');
  if (phone) check((await page.locator('#capAdded li').count()) === 0, name + ': no ticked task line in the sheet');
  await page.screenshot({ path: file(name + '-sent') });
  check(!errors.length, name + ': no page errors ' + JSON.stringify(errors));
  await ctx.close();
}
await browser.close();
if (failed) { console.error('restless-check: FAILED'); process.exit(1); }
console.log('restless-check: all good');
