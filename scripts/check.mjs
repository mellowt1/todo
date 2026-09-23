// End to end check against the local Worker (wrangler dev on :8787) and the local app (npm run serve on :8080).
// Drives the real app in Chromium, asserts each flow, and saves screenshots to screenshots/.
//   npm run check
// Uses the dev values in worker/.dev.vars. Never the real code.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const vars = Object.fromEntries(readFileSync(new URL('../worker/.dev.vars', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = 'http://localhost:8787';
const APP = 'http://localhost:8080/';
const CODE = vars.TODO_CODE;
const SHOTS = new URL('../screenshots/', import.meta.url);
mkdirSync(SHOTS, { recursive: true });

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log('ok  ', name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('FAIL', name, '\n     ', e.message.split('\n')[0]); }
}

/* ---------- API helpers ---------- */
const getList = async () => (await (await fetch(`${API}/api/todo/${CODE}`)).json()).items;
async function postOps(ops) {
  const r = await fetch(`${API}/api/todo/${CODE}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops }) });
  return r.json();
}
async function resetServer() {
  const items = await getList();
  if (items.length) await postOps(items.map((i) => ({ op: 'delete', item: { id: i.id, updatedAt: Date.now() + 1000 } })));
}
let n = 0;
const nid = () => 'seed' + String(++n).padStart(4, '0') + Math.random().toString(36).slice(2, 10);
function task(text, section = 'today', over = {}) {
  const t = Date.now() - 60000 - n * 1000;
  return { op: 'upsert', item: { id: nid(), text, section, done: false, doneAt: null, updatedAt: t, pos: t, ...over } };
}
const DAY = 86400000;
function at(daysAgo, h, m) { const d = new Date(Date.now() - daysAgo * DAY); d.setHours(h, m, 0, 0); return d.getTime(); }
async function until(fn, ms = 6000, msg = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + msg);
    await new Promise((r) => setTimeout(r, 150));
  }
}
const serverHas = (pred, msg) => until(async () => (await getList()).find(pred), 8000, msg);

/* ---------- Browser helpers ---------- */
const browser = await chromium.launch();
const phone = (scheme) => browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name + '.png', SHOTS)) });
async function touch(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  let x0 = 0, y0 = 0, cur = 0;
  return {
    async drag(el, dx, { end = true, steps = 12 } = {}) {
      const b = await el.boundingBox();
      x0 = b.x + b.width / 2; y0 = b.y + b.height / 2; cur = 0;
      await send('touchStart', x0, y0);
      await this.to(dx, steps);
      if (end) await send('touchEnd');
    },
    async to(dx, steps = 6) {
      const from = cur;
      for (let i = 1; i <= steps; i++) { cur = from + ((dx - from) * i) / steps; await send('touchMove', x0 + cur, y0); await page.waitForTimeout(12); }
    },
    async release() { await send('touchEnd'); },
    async longPress(el) {
      const b = await el.boundingBox();
      await send('touchStart', b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(650);
      await send('touchEnd');
    },
  };
}
const row = (page, text) => page.locator('.row', { hasText: text });
const openTexts = (page) => page.locator('#list .row .text').allTextContents();

/* ================= Phone, light ================= */
await resetServer();

const ctx = await phone('light');
const page = await ctx.newPage();
page.on('pageerror', (e) => results.push(['FAIL', 'page error', e.message]));

await step('missing code shows the full screen message', async () => {
  await page.goto(APP);
  await page.waitForSelector('#nocode:not([hidden])');
  assert.match(await page.textContent('#nocode'), /This link is missing its code\. Open the private link again\./);
  await shot(page, 'phone-missing-code-light');
});

await step('first open: empty Today with first open copy', async () => {
  await page.goto(APP + '?c=' + CODE);
  await page.waitForSelector('#empty:not([hidden])');
  assert.equal((await page.textContent('#empty p')).trim(), 'Nothing here yet. Tap plus to add a task.');
  await shot(page, 'phone-empty-light');
});

const seedToday = ['Buy coffee beans', 'Send the invoice copy to the accountant', 'Renew the museum card', 'Pick up the parcel at the post office', 'Reply to the landlord about the boiler'];
await step('capture: plus opens the sheet, Return saves and keeps it open', async () => {
  await page.click('#fab');
  await page.waitForSelector('#capture:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'capInput');
  assert.equal(await page.textContent('#capLabel'), 'Adds to Today');
  for (const t of seedToday) { await page.keyboard.type(t); await page.keyboard.press('Enter'); }
  assert.equal(await page.inputValue('#capInput'), '');
  assert.ok(await page.isVisible('#capture'));
  await page.keyboard.type('Book the bike in for a service');
  await shot(page, 'phone-capture-light');
  await page.keyboard.press('Enter');
  await page.click('#capture .scrim', { position: { x: 200, y: 100 } });
  await page.waitForSelector('#capture', { state: 'hidden' });
  const texts = await openTexts(page);
  assert.equal(texts[0], 'Book the bike in for a service');
  assert.equal(texts.length, 6);
});

await step('new tasks reach the Worker', async () => {
  await until(async () => (await getList()).length === 6, 8000, 'six tasks on the server');
});

await step('Today with tasks', async () => {
  await page.waitForTimeout(1200);
  await shot(page, 'phone-today-light');
});

await step('circle tap marks done, toast Undo brings it back', async () => {
  await row(page, 'Buy coffee beans').locator('.circle').click();
  await page.waitForSelector('#toast:not([hidden])');
  assert.equal(await page.textContent('#toastText'), 'Done.');
  await until(async () => !(await openTexts(page)).includes('Buy coffee beans'), 3000, 'row to leave');
  await page.click('#toastUndo');
  await until(async () => (await openTexts(page)).includes('Buy coffee beans'), 3000, 'row back');
  await serverHas((i) => i.text === 'Buy coffee beans' && !i.done && i.updatedAt > Date.now() - 20000, 'undo on server');
});

await step('swipe right: mid swipe, then commit with toast', async () => {
  const t = await touch(page);
  const r = row(page, 'Reply to the landlord about the boiler');
  await t.drag(r, 140, { end: false });
  await page.waitForTimeout(100);
  await shot(page, 'phone-swipe-right-mid-light');
  await t.to(260);
  await t.release();
  await page.waitForSelector('#toast:not([hidden])');
  await until(async () => !(await openTexts(page)).includes('Reply to the landlord about the boiler'), 3000, 'row to leave');
  await shot(page, 'phone-swipe-done-toast-light');
  await serverHas((i) => i.text === 'Reply to the landlord about the boiler' && i.done, 'done on server');
});

await step('swipe left reveals Today, Soon, Someday; tap moves with toast', async () => {
  const t = await touch(page);
  const r = row(page, 'Pick up the parcel at the post office');
  await t.drag(r, -220);
  await page.waitForTimeout(300);
  assert.ok(await r.evaluate((el) => el.classList.contains('swipe-l')));
  await shot(page, 'phone-move-reveal-light');
  await r.locator('.swipe-move button[data-move="soon"]').click();
  await until(async () => (await page.textContent('#toastText')) === 'Moved to Soon.', 3000, 'move toast');
  await until(async () => !(await openTexts(page)).includes('Pick up the parcel at the post office'), 3000, 'row to leave');
  await shot(page, 'phone-moved-toast-light');
  await serverHas((i) => i.text === 'Pick up the parcel at the post office' && i.section === 'soon', 'move on server');
});

await step('long press opens the move menu', async () => {
  const t = await touch(page);
  await t.longPress(row(page, 'Renew the museum card'));
  await page.waitForSelector('#menu:not([hidden])');
  await shot(page, 'phone-long-press-menu-light');
  await page.click('#menu button[data-move="someday"]');
  await until(async () => !(await openTexts(page)).includes('Renew the museum card'), 3000, 'row to leave');
  await serverHas((i) => i.text === 'Renew the museum card' && i.section === 'someday', 'move on server');
});

await step('switcher shows Soon, Someday', async () => {
  await page.click('#switcher button[data-section="soon"]');
  assert.deepEqual(await openTexts(page), ['Pick up the parcel at the post office']);
  await page.click('#switcher button[data-section="someday"]');
  assert.deepEqual(await openTexts(page), ['Renew the museum card']);
  await page.click('#switcher button[data-section="today"]');
});

await step('tap text opens edit sheet; edits autosave', async () => {
  await row(page, 'Send the invoice copy').locator('.text').click();
  await page.waitForSelector('#edit:not([hidden])');
  await page.fill('#editText', 'Send the invoice copy to the accountant and ask about the VAT return');
  await page.waitForTimeout(700);
  await shot(page, 'phone-edit-light');
  await page.click('#editClose');
  await page.waitForSelector('#edit', { state: 'hidden' });
  assert.ok((await openTexts(page)).includes('Send the invoice copy to the accountant and ask about the VAT return'));
  await serverHas((i) => i.text.includes('VAT return'), 'edit on server');
});

await step('edit sheet section control moves the task', async () => {
  await row(page, 'Buy coffee beans').locator('.text').click();
  await page.click('#editSeg button[data-section="soon"]');
  await page.click('#editClose');
  await page.waitForSelector('#edit', { state: 'hidden' });
  assert.ok(!(await openTexts(page)).includes('Buy coffee beans'));
  await serverHas((i) => i.text === 'Buy coffee beans' && i.section === 'soon', 'section change on server');
});

await step('delete asks once, then removes (tombstone on server)', async () => {
  await page.click('#fab');
  await page.keyboard.type('Temporary task to delete');
  await page.keyboard.press('Enter');
  await page.click('#capture .scrim', { position: { x: 200, y: 100 } });
  await page.waitForSelector('#capture', { state: 'hidden' });
  await row(page, 'Temporary task to delete').locator('.text').click();
  await page.click('#editDelete');
  await page.waitForSelector('#confirm:not([hidden])');
  assert.equal(await page.textContent('#confirmText'), 'Delete this task? It will not go to Done.');
  await shot(page, 'phone-delete-confirm-light');
  await page.click('#confirmDelete');
  await until(async () => !(await openTexts(page)).includes('Temporary task to delete'), 3000, 'row gone');
  await page.waitForTimeout(1800);
  const exp = await (await fetch(`${API}/api/admin/todo/export`, { headers: { Authorization: 'Bearer ' + vars.ADMIN_TOKEN } })).json();
  assert.ok(!Object.values(exp.items).some((i) => i.text === 'Temporary task to delete'));
  assert.ok(Object.keys(exp.tombs).length >= 1);
});

await step('done history grouped by day, reopen with toast', async () => {
  const hist = [
    ['Water the plants', 0, 9, 10, 'today'], ['Pay the phone bill', 1, 12, 3, 'today'], ['Return the library books', 1, 18, 45, 'soon'],
    ['Clean the bike chain', 1, 8, 20, 'someday'], ['Book a haircut', 2, 17, 55, 'today'], ['Order new printer ink', 2, 11, 40, 'soon'],
    ['Back up the laptop', 2, 10, 2, 'today'], ['Fix the kitchen tap', 3, 16, 30, 'soon'], ['Call the dentist', 4, 9, 45, 'today'],
  ];
  await postOps(hist.map(([text, d, h, m, s]) => task(text, s, { done: true, doneAt: at(d, h, m), updatedAt: Date.now() - 5000 })));
  await page.click('#historyBtn');
  await page.waitForSelector('body.view-done');
  await until(async () => (await page.locator('.drow').count()) >= 10, 12000, 'history rows after poll');
  const heads = await page.locator('.dhead').allTextContents();
  assert.equal(heads[0], 'Today');
  assert.equal(heads[1], 'Yesterday');
  assert.match(heads[2], /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} (Jan|Feb|Mar|Apr|May|June|July|Aug|Sept|Oct|Nov|Dec)$/);
  const firstText = await page.locator('.drow .dtext').first().textContent();
  assert.equal(firstText, 'Reply to the landlord about the boiler'); // newest first
  assert.match(await page.locator('.drow .dtime').first().textContent(), /^\d\d:\d\d$/);
  await shot(page, 'phone-done-history-light');
  await page.locator('.drow', { hasText: 'Water the plants' }).click();
  await page.waitForSelector('#toast:not([hidden])');
  assert.equal(await page.textContent('#toastText'), 'Reopened in Today.');
  await shot(page, 'phone-reopen-toast-light');
  await page.click('#closeDone');
  assert.ok((await openTexts(page)).includes('Water the plants'));
  await serverHas((i) => i.text === 'Water the plants' && !i.done, 'reopen on server');
});

await step('offline: changes queue with the pill, then sync on reconnect', async () => {
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.click('#fab');
  await page.keyboard.type('Offline task one'); await page.keyboard.press('Enter');
  await page.keyboard.type('Offline task two'); await page.keyboard.press('Enter');
  await page.click('#capture .scrim', { position: { x: 200, y: 100 } });
  await page.waitForSelector('#capture', { state: 'hidden' });
  await row(page, 'Water the plants').locator('.circle').click();
  await page.waitForTimeout(1600);
  assert.equal(await page.textContent('#pill span'), 'Offline. 3 changes waiting');
  await page.evaluate(() => document.getElementById('toast').hidden = true);
  await shot(page, 'phone-offline-light');
  await page.reload().catch(() => {}); // no network: the page cannot reload, the queue must survive in storage anyway
  await ctx.setOffline(false);
  await page.goto(APP + '?c=' + CODE);
  await serverHas((i) => i.text === 'Offline task two', 'offline task on server');
  await serverHas((i) => i.text === 'Water the plants' && i.done, 'offline done on server');
});

await step('sync pill: Syncing then Synced after coming back', async () => {
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.click('#fab');
  await page.keyboard.type('Task made on the train'); await page.keyboard.press('Enter');
  await page.click('#capture .scrim', { position: { x: 200, y: 100 } });
  await page.waitForTimeout(1500);
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(async () => (await page.textContent('#pill span')) === 'Synced', 5000, 'Synced pill');
  await until(async () => page.locator('#pill').isHidden(), 5000, 'pill to fade');
  await serverHas((i) => i.text === 'Task made on the train', 'train task on server');
});

await step('sync error banner with Retry', async () => {
  await page.route('**/api/todo/**', (r) => r.abort());
  await page.click('#switcher button[data-section="someday"]');
  await row(page, 'Renew the museum card').locator('.circle').click();
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('toast').hidden = true);
  await until(async () => page.locator('#banner').isVisible(), 6000, 'banner');
  assert.equal((await page.textContent('#banner span')).trim(), 'Could not sync. Your changes are saved on this device.');
  await shot(page, 'phone-sync-error-empty-light');
  await page.unroute('**/api/todo/**');
  await page.click('#retry');
  await until(async () => page.locator('#banner').isHidden(), 5000, 'banner to go');
  await serverHas((i) => i.text === 'Renew the museum card' && i.done, 'retried op on server');
  assert.equal((await page.textContent('#empty p')).trim(), 'Nothing for someday.');
});

await step('two devices editing different tasks both keep their change', async () => {
  const other = await (await phone('light')).newPage();
  await other.goto(APP + '?c=' + CODE);
  await other.waitForSelector('#list .row');
  await row(other, 'Book the bike in for a service').locator('.text').click();
  await other.fill('#editText', 'Book the bike in for a service on Friday');
  await other.click('#editClose');
  await page.click('#switcher button[data-section="today"]');
  await row(page, 'Offline task one').locator('.circle').click();
  await serverHas((i) => i.text === 'Book the bike in for a service on Friday', 'device B edit');
  await serverHas((i) => i.text === 'Offline task one' && i.done, 'device A done');
  await until(async () => (await openTexts(page)).includes('Book the bike in for a service on Friday'), 15000, 'poll to bring B edit to A');
  await other.context().close();
});

await ctx.close();

/* ================= Phone, dark ================= */
{
  // A clean Today for the dark screenshots.
  const dctx = await phone('dark');
  const p = await dctx.newPage();
  await step('dark: Today, Done history, empty section', async () => {
    await p.goto(APP + '?c=' + CODE);
    await p.waitForSelector('#list .row:not(.skeleton)');
    await p.waitForTimeout(500);
    await shot(p, 'phone-today-dark');
    await p.click('#fab');
    await p.keyboard.type('Call the bike shop about the brakes');
    await shot(p, 'phone-capture-dark');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    await p.click('#historyBtn');
    await p.waitForSelector('.drow');
    await shot(p, 'phone-done-history-dark');
    await p.click('#closeDone');
    await p.click('#switcher button[data-section="someday"]');
    await shot(p, 'phone-empty-someday-dark');
  });
  await dctx.close();
}

/* ================= Desktop ================= */
for (const scheme of ['light', 'dark']) {
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const p = await dctx.newPage();
  p.on('pageerror', (e) => results.push(['FAIL', 'page error desktop', e.message]));
  await step(`desktop ${scheme}: sidebar, keyboard, inline add`, async () => {
    await p.goto(APP + '?c=' + CODE);
    await p.waitForSelector('#list .row:not(.skeleton)');
    assert.ok(await p.isVisible('.sidebar'));
    assert.ok(await p.isHidden('#fab'));
    if (scheme === 'light') {
      await p.keyboard.press('n');
      assert.ok(await p.isVisible('#inlineAdd'));
      await p.keyboard.type('Plan the weekend ride');
      await p.keyboard.press('Enter');
      assert.equal((await openTexts(p))[0], 'Plan the weekend ride');
      await p.keyboard.press('Escape');
      await p.keyboard.press('2');
      assert.equal(await p.textContent('#title'), 'Soon');
      await p.keyboard.press('1');
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('ArrowDown');
      const focused = await p.evaluate(() => document.activeElement.querySelector('.text').textContent);
      await p.keyboard.press(' ');
      await until(async () => !(await openTexts(p)).includes(focused), 3000, 'space to mark done');
      await p.waitForTimeout(4200); // let the toast go
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('Enter');
      assert.ok(await p.isVisible('#edit'));
      await shot(p, 'desktop-edit-light');
      await p.keyboard.press('Escape');
      await p.keyboard.press('n');
      await p.keyboard.type('New task being typed');
    }
    await p.locator('#list .row').nth(1).hover();
    await p.waitForTimeout(200);
    await shot(p, `desktop-today-${scheme}`);
    if (scheme === 'light') {
      await p.click('.nav-done');
      await p.waitForSelector('.drow');
      await shot(p, 'desktop-done-history-light');
    }
  });
  await dctx.close();
}

/* ================= Service worker: opens with no signal ================= */
await step('service worker caches the shell; app opens offline with the local list', async () => {
  const sctx = await phone('light');
  const p = await sctx.newPage();
  await p.goto(APP + '?sw=1&c=' + CODE);
  await p.waitForSelector('#list .row:not(.skeleton)');
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload();
  await until(() => p.evaluate(() => !!navigator.serviceWorker.controller), 5000, 'controller');
  await sctx.setOffline(true);
  await p.reload();
  await p.waitForSelector('#list .row:not(.skeleton)');
  assert.ok((await openTexts(p)).length > 0);
  assert.equal(await p.textContent('#pill span'), 'Offline');
  await sctx.close();
});

/* ================= Odysseus read route ================= */
await step('read route: 401 without token, open tasks only with token', async () => {
  assert.equal((await fetch(`${API}/api/todo/open`)).status, 401);
  assert.equal((await fetch(`${API}/api/todo/open`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const r = await fetch(`${API}/api/todo/open`, { headers: { Authorization: 'Bearer ' + vars.TODO_READ_TOKEN } });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.ok(d.items.length > 0);
  for (const i of d.items) assert.deepEqual(Object.keys(i).sort(), ['section', 'text']);
  const done = (await getList()).filter((i) => i.done).map((i) => i.text);
  assert.ok(!d.items.some((i) => done.includes(i.text)));
});

await browser.close();
const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - fails.length} passed, ${fails.length} failed`);
for (const f of fails) console.log(' ', f[1], ':', f[2]);
process.exit(fails.length ? 1 : 0);
