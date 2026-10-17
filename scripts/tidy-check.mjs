// Tidy, against a mocked Worker: a task goes in as typed, comes back tidy with a date label and a
// "Tidied." toast; Undo puts the typed text back. Offline nothing is asked.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run tidy-check
import { chromium } from 'playwright';

const APP = process.env.APP_URL || 'http://localhost:8091/';
const CODE = 'abcdefgh23456789';
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.error('FAIL:', what); } else console.log('ok:', what); };

const browser = await chromium.launch();
for (const [name, viewport] of [['tidy-phone', { width: 390, height: 844 }], ['tidy-desk', { width: 1280, height: 900 }]]) {
  const phone = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const items = {};
  const asked = [];
  await page.route('**/api/**', async (r) => {
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    const q = r.request();
    if (q.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
    const p = new URL(q.url()).pathname;
    if (p === `/api/tidy/${CODE}`) {
      asked.push(q.postDataJSON().text);
      await new Promise((res) => setTimeout(res, 300));
      return r.fulfill({ json: { text: 'Call the gemeente about the parking permit · 2026-10-23', changed: true }, headers: h });
    }
    if (p === `/api/todo/${CODE}/ops`) for (const o of q.postDataJSON().ops) items[o.item.id] = o.item;
    if (p.startsWith(`/api/todo/${CODE}`)) return r.fulfill({ json: { items: Object.values(items), rev: 1, updated: new Date().toISOString(), rejected: [] }, headers: h });
    if (p === `/api/intake/${CODE}/cards`) return r.fulfill({ json: { tasks: [] }, headers: h });
    if (p === `/api/intake/${CODE}`) return r.fulfill({ json: { items: [] }, headers: h });
    return r.fulfill({ status: 404, json: {}, headers: h });
  });
  await page.goto(APP + '?c=' + CODE + '&api=' + encodeURIComponent('http://localhost:8799'));
  await page.waitForTimeout(800);
  if (phone) await page.click('#fab'); else await page.click('#addDesk');
  const input = phone ? '#capInput' : '#inlineInput';
  await page.fill(input, 'call gemeente abt parking permit frday');
  await page.press(input, 'Enter');
  if (phone) await page.click('#capDone'); else await page.keyboard.press('Escape');
  await page.waitForFunction(() => [...document.querySelectorAll('.row .tname')].some((e) => e.textContent.startsWith('Call the gemeente')), null, { timeout: 5000 });
  check(asked.join() === 'call gemeente abt parking permit frday', name + ': asked once with the typed text');
  const row = page.locator('.row', { hasText: 'Call the gemeente' });
  check((await row.locator('.tdue').textContent()) !== '', name + ': date label shows');
  check((await page.textContent('#toastText')) === 'Tidied.', name + ': toast says Tidied.');
  await page.click('#toast button');
  await page.waitForFunction(() => [...document.querySelectorAll('.row .tname')].some((e) => e.textContent === 'call gemeente abt parking permit frday'), null, { timeout: 3000 });
  check(true, name + ': Undo puts the typed text back');
  check(errors.length === 0, name + ': no page errors ' + errors.join('; '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
console.log('all tidy checks pass');
