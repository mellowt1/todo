// The finishing-touches set (2026-11-04): the main screens in both themes, against a mocked Worker,
// for a before/after look. Screenshots only (no checks but page errors). Every task is made up.
//   PORT=8131 npm run serve, then: APP_URL=http://localhost:8131/ SHOTS=after node scripts/polish-shots.mjs
// Writes screenshots/polish/<SHOTS>-*.png.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8131/';
const TAG = process.env.SHOTS || 'after';
const CODE = 'abcdefgh23456789';
const OUT = new URL('../screenshots/polish/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const file = (n) => fileURLToPath(new URL(`${TAG}-${n}.png`, OUT));

function world(allDone) {
  const now = Date.now();
  let k = 0;
  const t = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: now - 1000 * ++k, pos: now - 1000 * k, ...extra });
  const done = (id, text, hoursAgo, extra = {}) => t(id, text, 'today', { done: true, doneAt: now - hoursAgo * 3600e3, ...extra });
  const list = allDone
    ? [done('d1', 'Ticket for Lucho November', 1, { skill: 'crafting' }), done('d2', 'Return the lamp', 2), done('d3', 'Answer the landlord email', 3, { skill: 'magic' })]
    : [
      t('todaylucho01', 'Ticket for Lucho November', 'today', { energy: 'drained', skill: 'crafting' }),
      t('todaylamp001', 'Return the lamp', 'today', { energy: 'normal' }),
      t('todaybike001', 'Pump the bike tyres', 'today', { skill: 'construction' }),
      t('todaymail001', 'Answer the landlord email · 2026-11-05', 'today', { skill: 'magic' }),
      t('todayboil001', 'Book the boiler service', 'today', { energy: 'normal' }),
      done('d1', 'Water the plants', 1, { skill: 'farming' }),
      done('d2', 'Pay the phone bill', 4),
      done('d3', 'Call the dentist', 26),
      done('d4', 'Clean the bathroom', 30, { skill: 'construction' }),
      done('d5', 'Apply: policy officer', 50),
    ];
  list.push(
    t('soonstamp001', 'Buy stamps', 'soon', { energy: 'drained' }),
    t('soondesk0001', 'Clear the desk drawer', 'soon', { energy: 'normal', week: true }),
    t('soonpass0001', 'Renew the passport · 2026-11-12', 'soon'),
    t('somedaypia01', 'Learn the piano intro', 'someday'),
  );
  const items = Object.fromEntries(list.map((i) => [i.id, i]));
  const startedAt = new Date(now - 7 * 60e3).toISOString();
  return (req) => {
    const p = new URL(req.url()).pathname;
    if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev: 1, updated: new Date().toISOString() };
    if (p === `/api/todo/${CODE}/ops`) return { items: Object.values(items), rev: 2, updated: new Date().toISOString(), rejected: [] };
    if (p === `/api/energy/${CODE}`) return { level: 'drained', setAt: new Date(now - 3600e3).toISOString(), until: new Date(now + 3 * 3600e3).toISOString(), source: 'morning', pick: null, play: null };
    if (p === `/api/energy/${CODE}/pick`) return { level: 'drained', pick: null };
    if (p === `/api/dread/${CODE}`) return allDone ? { running: null, stopped: null, offer: null } : { running: { task: 'todaylamp001', name: 'Return the lamp', startedAt, dread: 3, source: 'todo', mins: 7, level: 'normal' }, stopped: null, offer: { level: 'drained', title: 'Low tide', url: 'https://open.spotify.com/playlist/37i9dQZF1DX4sWSpwq3LiO', uri: 'spotify:playlist:37i9dQZF1DX4sWSpwq3LiO', startedAt } };
    if (p === `/api/archive/${CODE}`) return allDone ? { due: [], archived: 2, limit: 5 } : { due: [{ task: 'todayboil001', name: 'Book the boiler service', section: 'today', skips: 5 }], archived: 2, limit: 5 };
    if (p === `/api/waiting/${CODE}`) {
      const w = (id, who, what, since, due) => ({ id, who, what, since, channel: 'email', chaseDays: 7, nextChase: '2026-11-08', forWhom: null, source: 'todo', state: 'open', chases: 0, chaseDue: due, chaseTask: null });
      const l = [w('waitgemeente01', 'Gemeente', 'Parking permit', '2026-10-21', false), w('waitaccount001', 'the accountant', 'Tax papers', '2026-10-30', false)];
      return { items: l, open: l.length, due: 0, names: ['Gemeente', 'the accountant'] };
    }
    if (p === `/api/soundtrack/${CODE}`) return { lists: { wired: [], normal: [], drained: [{ id: 'lowtide001', title: 'Low tide', url: 'https://open.spotify.com/playlist/37i9dQZF1DX4sWSpwq3LiO', uri: 'spotify:playlist:37i9dQZF1DX4sWSpwq3LiO' }] }, max: 3 };
    if (p === `/api/spotify/${CODE}`) return { configured: true, connected: true, canMake: true };
    if (p === `/api/tidy/${CODE}`) return { text: 'x', changed: false, kind: 'task' };
    if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
    if (p === `/api/intake/${CODE}`) return { items: [] };
    if (p.startsWith('/api/hiscores/')) return { skills: [] };
    return null;
  };
}

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 860 };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

const browser = await chromium.launch();
let errs = 0;
async function open(viewport, scheme, allDone = false, hash = '') {
  const phone = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: scheme, userAgent: phone ? UA : undefined });
  const page = await ctx.newPage();
  const route = world(allDone);
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.route('**/api/**', async (r) => {
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
    const out = route(r.request());
    return out ? r.fulfill({ json: out, headers: h }) : r.fulfill({ status: 404, json: { error: 'not found' }, headers: h });
  });
  await page.goto(APP + '?noforce&c=' + CODE + '&api=' + encodeURIComponent('http://localhost:8799') + hash);
  await page.waitForTimeout(2200);
  page.done = async () => { if (page.errors.length) { errs++; console.error(page.errors); } await ctx.close(); };
  return page;
}
const shut = async (page) => { await page.keyboard.press('Escape'); await page.waitForTimeout(450); };

for (const scheme of ['light', 'dark']) {
  const s = scheme[0];
  const page = await open(PHONE, scheme);
  await page.screenshot({ path: file(`phone-${s}-today`) });
  if (s === 'l') {
    await page.click('.row[data-id="todaybike001"] .text');
    await page.waitForSelector('#edit:not([hidden])');
    await page.waitForTimeout(450);
    await page.screenshot({ path: file('phone-l-edit') });
    await shut(page);
    await page.click('#giveOne');
    await page.waitForSelector('#pick:not([hidden])');
    await page.waitForTimeout(450);
    await page.screenshot({ path: file('phone-l-pick') });
    await shut(page);
    await page.click('#fab');
    await page.waitForSelector('#capture:not([hidden])');
    await page.waitForTimeout(450);
    await page.screenshot({ path: file('phone-l-capture') });
    await shut(page);
  }
  await page.click('#switcher [data-section="soon"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: file(`phone-${s}-soon`) });
  await page.click('#historyBtn');
  await page.waitForTimeout(900);
  await page.screenshot({ path: file(`phone-${s}-done`) });
  await page.done();

  const empty = await open(PHONE, scheme, true);
  await empty.screenshot({ path: file(`phone-${s}-alldone`) });
  await empty.done();

  const desk = await open(DESK, scheme);
  await desk.screenshot({ path: file(`desk-${s}-today`) });
  await desk.done();
}
await browser.close();
console.log(errs ? 'polish-shots: page errors' : 'polish-shots: done');
