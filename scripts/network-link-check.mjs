// The Network map's "Reach out to ..." task links back to the person's card in Morning; To-do adds the
// code to that link when it draws it (the iPhone's home-screen app and Safari do not share storage), and
// never to any other link or to the stored task. Against a mocked Worker; every value is made up.
//   PORT=8121 npm run serve, then: APP_URL=http://localhost:8121/ npm run network-link-check
import { chromium } from 'playwright';

const APP = process.env.APP_URL || 'http://localhost:8121/';
const CODE = 'abcdefgh23456789';
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.error('FAIL:', what); } else console.log('ok:', what); };

const now = Date.now();
const MORNING = 'https://mellowt1.github.io/morning/network/?p=k3j9x0a1b2c3';
const items = {
  reachtask0001: { id: 'reachtask0001', text: 'Reach out to Anna de Vries', section: 'soon', done: false, doneAt: null, updatedAt: now - 1000, pos: now - 1000, link: MORNING, energy: 'normal' },
  vacancy00001: { id: 'vacancy00001', text: 'Apply: Policy officer (Ministry)', section: 'soon', done: false, doneAt: null, updatedAt: now - 2000, pos: now - 2000, link: 'https://www.werkenvoornederland.nl/vacatures/x' },
};
const ops = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/api/**', async (r) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
  const p = new URL(r.request().url()).pathname;
  if (p === `/api/todo/${CODE}`) return r.fulfill({ json: { items: Object.values(items), rev: 1, updated: new Date().toISOString() }, headers: h });
  if (p === `/api/todo/${CODE}/ops`) { ops.push(...r.request().postDataJSON().ops); return r.fulfill({ json: { items: Object.values(items), rev: 2, updated: new Date().toISOString(), rejected: [] }, headers: h }); }
  if (p === `/api/energy/${CODE}`) return r.fulfill({ json: { level: null, setAt: null, until: null, source: null, pick: null }, headers: h });
  if (p === `/api/dread/${CODE}`) return r.fulfill({ json: { running: null, stopped: null }, headers: h });
  if (p === `/api/archive/${CODE}`) return r.fulfill({ json: { due: [], archived: 0, limit: 5 }, headers: h });
  if (p === `/api/waiting/${CODE}`) return r.fulfill({ json: { items: [], open: 0, due: 0, names: [] }, headers: h });
  return r.fulfill({ status: 404, json: { error: 'not found' }, headers: h });
});
await page.goto(APP + '?c=' + CODE + '&api=' + encodeURIComponent('http://localhost:8799'));
await page.locator('button[data-section="soon"]:visible').first().click();
await page.waitForSelector('.row[data-id="reachtask0001"]');

const reach = await page.getAttribute('.row[data-id="reachtask0001"] a.link', 'href');
const vac = await page.getAttribute('.row[data-id="vacancy00001"] a.link', 'href');
check(reach === MORNING + '&c=' + CODE, 'the Reach out link opens the card with the code: ' + reach);
check(vac === 'https://www.werkenvoornederland.nl/vacatures/x', 'any other link stays as it is: ' + vac);
check(!JSON.stringify(ops).includes(CODE), 'the code never goes into a stored task');
check(errors.length === 0, 'nothing in the console ' + errors.join(' | '));
await browser.close();
if (failed) process.exit(1);
