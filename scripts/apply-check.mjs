// Applications, against a mocked Worker (no wrangler needed): an Apply task's edit sheet offers
// Prepare on the PC; the sheet queues it and says so; once the PC has built the folder the sheet
// shows the fit, the folder, the gaps and the letter (folded, with Copy). Ordinary tasks show no
// row. Every name is made up.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run apply-check
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

const LETTER = 'Geachte heer/mevrouw,\n\nMet veel interesse las ik uw vacature voor planner militaire opleidingen.\n\nMet vriendelijke groet,\nTest Person';
const DRAFT = { at: new Date().toISOString(), url: 'https://werk.example/vacature/1', title: 'Planner', organisation: 'Defensie', cv: 'defensie', cvLabel: 'Defensie', fit: 7, fitLine: 'Strong planning record, no training background yet.', gaps: ['No HAVO line on the CV, add it', 'Little classroom work, mention the workshops'], asks: ['CV', 'Motivation letter'], deadline: '2026-11-01', lang: 'nl', letter: LETTER, examples: 2 };

function world() {
  const now = Date.now();
  const t = (id, text, section, link) => ({ id, text, section, done: false, doneAt: null, updatedAt: now, pos: now, ...(link ? { link } : {}) });
  const items = {};
  for (const it of [
    t('applyplan001', 'Apply: Planner militaire opleidingen (Defensie) · 2026-11-01', 'soon', 'https://werk.example/vacature/1'),
    t('mine0000001', 'Book the boiler service', 'soon'),
  ]) items[it.id] = it;
  return {
    items, posts: 0, rec: { state: 'none' },
    route(req) {
      const p = new URL(req.url()).pathname;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev: 1, updated: new Date().toISOString() };
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      if (p === `/api/skills/${CODE}/track/applyplan001`) return { role: null };
      if (p === `/api/apply/${CODE}/applyplan001`) {
        if (req.method() === 'POST') { this.posts++; this.rec = { state: 'queued', queuedAt: '2026-10-17T09:15:00Z' }; }
        return this.rec;
      }
      return null;
    },
  };
}

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['apply-phone', { width: 390, height: 844 }, 'light'], ['apply-desk', { width: 1280, height: 900 }, 'dark']]) {
  const w = world();
  const phone = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: scheme, permissions: ['clipboard-read', 'clipboard-write'] });
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
  if (phone) await page.click('#switcher [data-section="soon"]'); else await page.click('.nav-item[data-section="soon"]');
  await page.waitForSelector('.row[data-id="applyplan001"]');
  await page.waitForTimeout(600);

  // Clean names: the date leaves the name and sits small at the right; "Apply:" stays in the name
  // and the row's skill is Slayer, the Hiscores skill an application pays into (2026-10-19).
  check((await page.textContent('.row[data-id="applyplan001"] .tname')) === 'Apply: Planner militaire opleidingen (Defensie)', name + ': name keeps Apply:');
  check((await page.getAttribute('.row[data-id="applyplan001"] .tskill img', 'src')) === 'icons/skills/slayer.png', name + ': Slayer skill');
  check((await page.getAttribute('.row[data-id="mine0000001"] .tskill img', 'src')) === 'icons/skills/woodcutting.png', name + ': an ordinary task pays Woodcutting');
  check((await page.textContent('.row[data-id="applyplan001"] .tdue')) === '1 Nov', name + ': date label 1 Nov');
  check(await page.evaluate(() => { const r = document.querySelector('.row[data-id="applyplan001"]'); return r.querySelector('.tmeta').getBoundingClientRect().right > r.querySelector('.tname').getBoundingClientRect().right; }), name + ': label to the right of the name');
  await page.locator('#list').screenshot({ path: file(name + '-list') });

  await page.click('.row[data-id="mine0000001"] .text');
  await page.waitForSelector('#edit:not([hidden])');
  check(await page.$eval('#editApply', (e) => e.hidden), name + ': no Prepare row on an ordinary task');
  await page.click('#editClose');
  await page.waitForTimeout(500);

  const open = async () => {
    await page.click('.row[data-id="applyplan001"] .text');
    await page.waitForSelector('#editApply:not([hidden])');
    await page.waitForTimeout(300);
    await page.click('#editApply');
    await page.waitForSelector('#apply:not([hidden])');
    await page.waitForFunction(() => !document.querySelector('#apBody .ap-wait'));
  };
  await open();
  check((await page.textContent('#apBody [data-act="queue"]')) === 'Prepare on the PC', name + ': not started: Prepare on the PC');
  await page.locator('#apply .sheet').screenshot({ path: file(name + '-none') });
  await page.click('#apBody [data-act="queue"]');
  await page.waitForSelector('#apBody .fit-queued');
  check(w.posts === 1, name + ': one POST queues it');
  check((await page.textContent('#apBody .fit-queued b')) === 'Queued for your PC', name + ': says it is queued');
  await page.locator('#apply .sheet').screenshot({ path: file(name + '-queued') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // The PC built the folder.
  w.rec = { state: 'ready', queuedAt: '2026-10-17T09:15:00Z', folder: 'C:\\Users\\Test\\Applications\\2026-10-17 Defensie - Planner', draft: DRAFT };
  await open();
  check((await page.textContent('#apBody .ap-fit b')) === 'Fit 7/10', name + ': ready: fit 7/10');
  check((await page.textContent('#apBody .ap-folder b')) === '2026-10-17 Defensie - Planner', name + ': ready: the folder name');
  check((await page.$$('#apBody .ap-gaps li')).length === 2, name + ': two gaps');
  check(!(await page.isVisible('#apBody .ap-letter')), name + ': the letter is folded');
  await page.locator('#apply .sheet').screenshot({ path: file(name + '-ready') });
  await page.click('#apBody .ap-more summary');
  await page.click('#apBody [data-act="copy"]');
  await page.waitForTimeout(250);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(clip.replace(/\r\n/g, '\n') === LETTER, name + ': Copy puts the letter on the clipboard'); // Windows keeps \r\n
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': no sideways scroll');
  check(errors.length === 0, name + ': no page errors ' + errors.join('; '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
console.log('all apply checks pass');
