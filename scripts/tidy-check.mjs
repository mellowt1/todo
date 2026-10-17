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
      const typed = q.postDataJSON().text;
      asked.push(typed);
      await new Promise((res) => setTimeout(res, 300));
      const text = /jan/i.test(typed) ? 'Email Jan about the meeting · 2026-10-22' : 'Call the gemeente about the parking permit · 2026-10-23';
      return r.fulfill({ json: { text, changed: true }, headers: h });
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

  // Editing: opening and closing without a change asks nothing; a changed text is tidied on close.
  const messy = page.locator('.row', { hasText: 'call gemeente abt parking permit frday' });
  await messy.locator('.text').click();
  await page.waitForSelector('#edit:not([hidden])');
  await page.click('#editClose');
  await page.waitForTimeout(800);
  check(asked.length === 1, name + ': an unchanged edit asks nothing');
  await messy.locator('.text').click();
  await page.waitForSelector('#edit:not([hidden])');
  await page.fill('#editText', 'emial jan abt teh meeting thursday');
  await page.click('#editClose');
  await page.waitForFunction(() => [...document.querySelectorAll('.row .tname')].some((e) => e.textContent === 'Email Jan about the meeting'), null, { timeout: 5000 });
  check(asked[1] === 'emial jan abt teh meeting thursday', name + ': the edited text is tidied on close');
  check(errors.length === 0, name + ': no page errors ' + errors.join('; '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
console.log('all tidy checks pass');
