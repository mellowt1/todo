// A busy Today, against a mocked Worker, for looking at how much text it carries: a level set in
// Morning, tasks without a level, a running timer with "Music for this?", a task passed on 5 times,
// and the sheets that open from Today (Edit, Energy sort, Give me one) plus Soon's Waiting on.
// Screenshots only (no checks but page errors). Every task and name is made up.
//   PORT=8121 npm run serve, then: APP_URL=http://localhost:8121/ SHOTS=today node scripts/today-shots.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8121/';
const TAG = process.env.SHOTS || 'today';
const CODE = 'abcdefgh23456789';
const OUT = new URL('../screenshots/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const file = (n) => fileURLToPath(new URL(n + '.png', OUT));

function world() {
  const now = Date.now();
  let k = 0;
  const t = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: now - 1000 * ++k, pos: now - 1000 * k, ...extra });
  const items = Object.fromEntries([
    t('todaylucho01', 'Ticket for Lucho November', 'today', { energy: 'drained' }),
    t('todaylamp001', 'Return the lamp', 'today', { energy: 'normal' }),
    t('todaybike001', 'Pump the bike tyres', 'today'),
    t('todaymail001', 'Answer the landlord email', 'today'),
    t('todayboil001', 'Book the boiler service', 'today', { energy: 'normal' }),
    t('soonstamp001', 'Buy stamps', 'soon', { energy: 'drained' }),
    t('soondesk0001', 'Clear the desk drawer', 'soon', { energy: 'normal' }),
  ].map((i) => [i.id, i]));
  const startedAt = new Date(now - 7 * 60e3).toISOString();
  return {
    items,
    route(req) {
      const p = new URL(req.url()).pathname;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev: 1, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) return { items: Object.values(items), rev: 2, updated: new Date().toISOString(), rejected: [] };
      if (p === `/api/energy/${CODE}`) return { level: 'drained', setAt: new Date(now - 3600e3).toISOString(), until: new Date(now + 3 * 3600e3).toISOString(), source: 'morning', pick: null, play: { level: 'drained', title: 'Low tide', url: 'https://open.spotify.com/playlist/37i9dQZF1DX4sWSpwq3LiO', uri: 'spotify:playlist:37i9dQZF1DX4sWSpwq3LiO' } };
      if (p === `/api/energy/${CODE}/pick`) return { level: 'drained', pick: null };
      if (p === `/api/dread/${CODE}`) return { running: { task: 'todaylamp001', name: 'Return the lamp', startedAt, dread: 3, source: 'todo', mins: 7, level: 'normal' }, stopped: null, offer: { level: 'drained', title: 'Low tide', url: 'https://open.spotify.com/playlist/37i9dQZF1DX4sWSpwq3LiO', uri: 'spotify:playlist:37i9dQZF1DX4sWSpwq3LiO', startedAt } };
      if (p === `/api/archive/${CODE}`) return { due: [{ task: 'todayboil001', name: 'Book the boiler service', section: 'today', skips: 5 }], archived: 2, limit: 5 };
      if (p === `/api/waiting/${CODE}`) {
        const w = (id, who, what, since, due) => ({ id, who, what, since, channel: 'email', chaseDays: 7, nextChase: '2026-11-08', forWhom: null, source: 'todo', state: 'open', chases: 0, chaseDue: due, chaseTask: null });
        const list = [w('waitgemeente01', 'Gemeente', 'Parking permit', '2026-10-21', true), w('waitaccount001', 'the accountant', 'Tax papers', '2026-10-30', false)];
        return { items: list, open: list.length, due: 1, names: ['Gemeente', 'the accountant'] };
      }
      if (p === `/api/soundtrack/${CODE}`) return { lists: { wired: [], normal: [], drained: [{ id: 'lowtide001', title: 'Low tide', url: 'https://open.spotify.com/playlist/37i9dQZF1DX4sWSpwq3LiO', uri: 'spotify:playlist:37i9dQZF1DX4sWSpwq3LiO' }] }, max: 3 };
      if (p === `/api/spotify/${CODE}`) return { configured: true, connected: true, canMake: true };
      if (p === `/api/tidy/${CODE}`) return { text: 'x', changed: false, kind: 'task' };
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      if (p.startsWith('/api/hiscores/')) return { skills: [] };
      return null;
    },
  };
}

const browser = await chromium.launch();
let errs = 0;
for (const [name, viewport, scheme] of [[TAG + '-phone', { width: 390, height: 844 }, 'light'], [TAG + '-desk', { width: 1280, height: 900 }, 'dark']]) {
  const w = world();
  const phone = viewport.width < 700;
  const ua = phone ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' : undefined;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: scheme, userAgent: ua });
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
  await page.waitForTimeout(2500);
  const shut = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(400); };
  await page.screenshot({ path: file(name + '-today') });
  if (!phone) { await ctx.close(); if (errors.length) { errs++; console.error(name, errors); } continue; }
  await page.click('.row[data-id="todaybike001"] .text');
  await page.waitForSelector('#edit:not([hidden])');
  await page.waitForTimeout(400);
  await page.screenshot({ path: file(name + '-edit') });
  if (await page.locator('#chipRow').count()) {
    // Edit in one line: a sideways swipe steps the energy chip; a tap on place opens its choices.
    const b = await page.locator('#chipRow [data-k="energy"]').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 - 70, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    console.log('energy chip after a swipe left:', (await page.textContent('#chipRow [data-k="energy"]')).trim(), '· task energy:', w.items.todaybike001.energy || '(none yet: the write is queued)');
    await page.click('#chipRow [data-k="place"]');
    await page.waitForTimeout(450);
    await page.screenshot({ path: file(name + '-edit-open') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await shut();
  if (await page.isVisible('#energySort')) {
    await page.click('#energySort');
    await page.waitForSelector('#sort:not([hidden])');
    await page.waitForTimeout(400);
    await page.screenshot({ path: file(name + '-sort') });
    await shut();
  }
  await page.click('#giveOne');
  await page.waitForSelector('#pick:not([hidden])');
  await page.waitForTimeout(400);
  await page.screenshot({ path: file(name + '-pick') });
  await shut();
  await page.click('#switcher [data-section="soon"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: file(name + '-soon') });
  if (await page.isVisible('#waitLine')) {
    await page.click('#waitLine');
    await page.waitForSelector('#waitList:not([hidden])');
    await page.waitForTimeout(400);
    await page.screenshot({ path: file(name + '-waitlist') });
  }
  if (errors.length) { errs++; console.error(name, errors); }
  await ctx.close();
}
await browser.close();
console.log(errs ? 'today-shots: page errors' : 'today-shots: done');
