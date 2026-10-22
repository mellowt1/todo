// Skills gap on the Apply card, against a mocked Worker: an untracked Apply task offers Track this role;
// tapping it posts the task once, shows Claude reading, looks again every 5 seconds and then shows the
// counts with a link to the role in Morning's Skills page (with the code). A page that could not be read
// says so; a hub that is away says so with Try again. Every value is made up.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run skills-track-check
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

const ROLE = (state, extra = {}) => ({ id: 'r8k2m4x9q1a0', title: 'Planner militaire opleidingen', org: 'Defensie', state, error: null, counts: { have: 7, partly: 2, missing: 3, unknown: 0 }, reqs: [], ...extra });
function world() {
  const now = Date.now();
  const items = { applyplan001: { id: 'applyplan001', text: 'Apply: Planner militaire opleidingen (Defensie) · 2026-11-01', section: 'soon', done: false, doneAt: null, updatedAt: now, pos: now, link: 'https://werk.example/vacature/1' } };
  return {
    items, posts: [], gets: 0, role: null, away: false,
    route(req) {
      const p = new URL(req.url()).pathname;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev: 1, updated: new Date().toISOString() };
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      if (p === `/api/apply/${CODE}/applyplan001`) return { state: 'none' };
      if (p === `/api/skills/${CODE}/track/applyplan001`) { this.gets++; return this.away ? 'away' : { role: this.role }; }
      if (p === `/api/skills/${CODE}/track` && req.method() === 'POST') { this.posts.push(req.postDataJSON()); this.role = ROLE('reading', { counts: { have: 0, partly: 0, missing: 0, unknown: 0 } }); return { role: this.role }; }
      return null;
    },
  };
}

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['skills-phone', { width: 390, height: 844 }, 'light'], ['skills-desk', { width: 1280, height: 900 }, 'dark']]) {
  const w = world();
  const phone = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install();
  await page.route('**/api/**', async (r) => {
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
    const out = w.route(r.request());
    if (out === 'away') return r.abort();
    return out ? r.fulfill({ json: out, headers: h }) : r.fulfill({ status: 404, json: { error: 'not found' }, headers: h });
  });
  await page.goto(APP + '?c=' + CODE + '&api=' + encodeURIComponent('http://localhost:8799'));
  if (phone) await page.click('#switcher [data-section="soon"]'); else await page.click('.nav-item[data-section="soon"]');
  await page.waitForSelector('.row[data-id="applyplan001"]');
  const open = async () => {
    await page.click('.row[data-id="applyplan001"] .text');
    await page.waitForSelector('#editApply:not([hidden])');
    await page.click('#editApply');
    await page.waitForSelector('#apply:not([hidden])');
    await page.waitForFunction(() => !document.querySelector('#apBody .ap-wait'));
  };
  await open();
  check((await page.textContent('#apBody [data-act="track"]')) === 'Track this role', name + ': not tracked: Track this role');
  check((await page.textContent('#apBody .ap-skills .card-note')).includes('About 3 cents'), name + ': says what it costs');
  await page.locator('#apply .sheet').screenshot({ path: file(name + '-none') });

  await page.click('#apBody [data-act="track"]');
  await page.waitForFunction(() => (document.querySelector('#apBody .sk-wait') || {}).textContent === 'Claude is reading the vacancy…');
  check(w.posts.length === 1 && w.posts[0].taskId === 'applyplan001', name + ': one POST with the task: ' + JSON.stringify(w.posts));
  check((await page.textContent('#apBody .sk-wait')) === 'Claude is reading the vacancy…', name + ': says Claude is reading');
  await page.locator('#apply .sheet').screenshot({ path: file(name + '-reading') });
  const before = w.gets;
  await page.clock.runFor(5100);
  await page.waitForTimeout(200);
  check(w.gets === before + 1, name + ': looks again after 5 seconds');
  w.role = ROLE('ready');
  await page.clock.runFor(5100);
  await page.waitForSelector('#apBody .sk-sum');
  check((await page.textContent('#apBody .sk-sum b')) === 'Tracked · 12 requirements' && (await page.textContent('#apBody .sk-sum small')) === '7 have · 2 partly · 3 missing', name + ': the counts');
  const href = await page.getAttribute('#apBody .sk-open', 'href');
  check(href === 'https://mellowt1.github.io/morning/skills/?r=r8k2m4x9q1a0&c=' + CODE, name + ': Open in Skills with the code: ' + href);
  const after = w.gets;
  await page.clock.runFor(15000);
  check(w.gets === after, name + ': stops looking once read');
  await page.locator('#apply .sheet').screenshot({ path: file(name + '-ready') });
  const box = await page.$eval('#apBody .sk-open', (e) => e.getBoundingClientRect().height);
  check(box >= 44, name + ': the link is 44 px or more: ' + box);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  w.role = ROLE('needs_text');
  await open();
  check((await page.textContent('#apBody .ap-skills .ap-say')).includes('could not be read'), name + ': a page that could not be read says so');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  w.away = true;
  await page.click('.row[data-id="applyplan001"] .text');
  await page.waitForSelector('#editApply:not([hidden])');
  await page.click('#editApply');
  await page.waitForSelector('#apBody [data-act="skreload"]');
  check((await page.textContent('#apBody .ap-skills .ap-say')).includes('reach the hub'), name + ': hub away');
  w.away = false;
  w.role = null;
  await page.click('#apBody [data-act="skreload"]');
  await page.waitForSelector('#apBody [data-act="track"]');
  check(true, name + ': Try again brings Track back');
  check(errors.length === 0, name + ': nothing in the console ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
