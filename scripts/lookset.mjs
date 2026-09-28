// Before and after screenshots of the look set (Release 3) for Paul's sign-off, in Chromium.
//   API_URL=http://127.0.0.1:8798 node scripts/lookset.mjs
// BEFORE is HEAD, checked out as a git worktree at ../todo-head3 and served on BEFORE_PORT (8092).
// AFTER is this working tree, served on AFTER_PORT (8093). Both read the same seeded list from
// API_URL (the dev Worker, never the real one), reseeded before every shot. Writes
// screenshots/lookset/*.png and screenshots/lookset/index.html, then removes the worktree
// (KEEP_WORKTREE=1 keeps it).
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { touch } from './touch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WT = resolve(ROOT, '..', 'todo-head3');
const OUT = join(ROOT, 'screenshots', 'lookset');
const vars = Object.fromEntries(readFileSync(join(ROOT, 'worker', '.dev.vars'), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = (process.env.API_URL || 'http://localhost:8787').replace(/\/+$/, '');
const CODE = vars.TODO_CODE;
const PORTS = { before: Number(process.env.BEFORE_PORT || 8092), after: Number(process.env.AFTER_PORT || 8093) };
mkdirSync(OUT, { recursive: true });

/* ---------- Servers ---------- */
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
if (!existsSync(WT)) git('worktree', 'add', '--detach', WT, 'HEAD');
const servers = [];
function serve(dir, port) {
  const p = spawn(process.execPath, [join(dir, 'scripts', 'serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  servers.push(p);
}
serve(WT, PORTS.before);
serve(ROOT, PORTS.after);
for (const port of Object.values(PORTS)) {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://localhost:${port}/`)).ok) break; } catch (e) { /* not up yet */ }
    if (i > 50) throw new Error('server on ' + port + ' did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* ---------- The list every shot starts from ---------- */
const getList = async () => (await (await fetch(`${API}/api/todo/${CODE}`)).json()).items;
async function postOps(ops) {
  const r = await fetch(`${API}/api/todo/${CODE}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops }) });
  return r.json();
}
let n = 0;
const nid = () => 'look' + String(++n).padStart(4, '0') + Math.random().toString(36).slice(2, 10);
const DAY = 86400000;
function at(daysAgo, h, m) { const d = new Date(Date.now() - daysAgo * DAY); d.setHours(h, m, 0, 0); return Math.min(d.getTime(), Date.now() - 600000); }
const OPEN = [
  ['Buy coffee beans', 'today'],
  ['Send the invoice copy to the accountant and ask about the VAT return for the third quarter', 'today'],
  ['Renew the museum card', 'today'],
  ['Pick up the parcel at the post office', 'today'],
  ['Reply to the landlord about the boiler', 'today'],
  ['Book the bike in for a service', 'someday'],
  ['Learn the names of the stars', 'someday'],
];
const DONE = [
  ['Water the plants', 'today', 0, 9, 10], ['Pay the phone bill', 'today', 1, 12, 3], ['Return the library books', 'soon', 1, 18, 45],
  ['Clean the bike chain', 'someday', 1, 8, 20], ['Book a haircut', 'today', 2, 17, 55], ['Order new printer ink', 'soon', 2, 11, 40],
];
async function seed() {
  const items = await getList();
  if (items.length) await postOps(items.map((i) => ({ op: 'delete', item: { id: i.id, updatedAt: Date.now() + 1000 } })));
  await new Promise((r) => setTimeout(r, 20));
  const base = Date.now() - 60000;
  await postOps([
    ...OPEN.map(([text, section], i) => ({ op: 'upsert', item: { id: nid(), text, section, done: false, doneAt: null, pos: base - i * 1000, updatedAt: Date.now() } })),
    ...DONE.map(([text, section, d, h, m]) => ({ op: 'upsert', item: { id: nid(), text, section, done: true, doneAt: at(d, h, m), pos: base - 60000, updatedAt: Date.now() } })),
  ]);
}

/* ---------- Shots ---------- */
const browser = await chromium.launch();
const url = (side, look) => `http://localhost:${PORTS[side]}/?c=${CODE}&api=${encodeURIComponent(API)}${look ? '&look=' + look : ''}`;
async function open(side, scheme, { desktop = false, look = '' } = {}) {
  await seed();
  const ctx = await browser.newContext(desktop
    ? { viewport: { width: 1440, height: 900 }, colorScheme: scheme }
    : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
  // No first-use nudge, so the first row sits still.
  await ctx.addInitScript(() => { try { localStorage.setItem('todo.ui', JSON.stringify({ section: 'today', nudged: true, installOff: true })); } catch (e) { /* ignore */ } });
  const page = await ctx.newPage();
  await page.goto(url(side, look));
  await page.waitForSelector('#list .row:not(.skeleton)');
  await page.waitForTimeout(500);
  return { ctx, page };
}
const row = (page, text) => page.locator('#list .row', { hasText: text });
const file = (name, side) => join(OUT, `${name}-${side}.png`);

// Each shot: name, what it does, desktop or not.
const PHONE = {
  today: async () => {},
  reveal: async (page) => {
    const t = await touch(page);
    await t.drag(row(page, 'Pick up the parcel'), -220, { end: false }); // the finger stays down
    await page.waitForTimeout(250);
  },
  capture: async (page) => {
    await page.click('#fab');
    await page.waitForSelector('#capture:not([hidden])');
    for (const t of ['Water the plants', 'Call the dentist']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); }
    await page.keyboard.type('Book a table for Friday');
    await page.waitForTimeout(450);
  },
  edit: async (page) => {
    await row(page, 'Send the invoice copy').locator('.text').click();
    await page.waitForSelector('#edit:not([hidden])');
    await page.waitForTimeout(450);
  },
  done: async (page) => {
    await page.click('#historyBtn');
    await page.waitForSelector('.drow');
    await page.waitForTimeout(500);
  },
  toast: async (page) => {
    const t = await touch(page);
    await t.drag(row(page, 'Pick up the parcel'), -220);
    await page.waitForTimeout(300);
    await row(page, 'Pick up the parcel').locator('.swipe-move button[data-move="someday"]').click();
    await page.waitForSelector('#toast:not([hidden])');
    await page.waitForTimeout(900);
  },
  offline: async (page, ctx) => {
    await page.click('#switcher button[data-section="someday"]');
    await page.waitForTimeout(300);
    await ctx.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.click('#fab');
    await page.waitForSelector('#capture:not([hidden])');
    for (const t of ['Offline task one', 'Offline task two']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); }
    await page.click('#capture .scrim', { position: { x: 200, y: 100 } });
    await page.waitForSelector('#capture', { state: 'hidden' });
    await row(page, 'Learn the names of the stars').locator('.circle').click();
    await page.waitForFunction(() => document.querySelector('#pill span').textContent === 'Offline. 3 changes waiting', null, { timeout: 5000 });
    await page.waitForSelector('#toast', { state: 'hidden', timeout: 8000 }); // the toast has gone
    await page.waitForTimeout(400);
  },
  empty: async (page) => {
    await page.click('#switcher button[data-section="soon"]');
    await page.waitForTimeout(500);
  },
};
const DESK = {
  'desk-today': async (page) => {
    await page.locator('#list .row').nth(1).hover();
    await page.waitForTimeout(300);
  },
  'desk-edit': async (page) => {
    await row(page, 'Send the invoice copy').locator('.text').click();
    await page.waitForSelector('#edit:not([hidden])');
    await page.waitForTimeout(450);
  },
};

const done = [];
async function take(name, act, side, scheme, desktop, look = '') {
  const tag = `${name}-${scheme}${look ? '-' + look : ''}`;
  const { ctx, page } = await open(side, scheme, { desktop, look });
  try {
    await act(page, ctx);
    await page.screenshot({ path: file(tag, side) });
    done.push(tag + '-' + side);
    console.log('ok  ', tag, side);
  } catch (e) {
    console.log('FAIL', tag, side, e.message.split('\n')[0]);
    process.exitCode = 1;
  } finally {
    await ctx.setOffline(false).catch(() => {});
    await ctx.close();
  }
}
for (const scheme of ['light', 'dark']) {
  for (const [name, act] of Object.entries(PHONE)) for (const side of ['before', 'after']) await take(name, act, side, scheme, false);
  for (const [name, act] of Object.entries(DESK)) for (const side of ['before', 'after']) await take(name, act, side, scheme, true);
  for (const look of ['c10a', 'c10b']) for (const name of ['today', 'done']) await take(name, PHONE[name], 'after', scheme, false, look);
}
await browser.close();
for (const p of servers) p.kill();
{ const items = await getList(); if (items.length) await postOps(items.map((i) => ({ op: 'delete', item: { id: i.id, updatedAt: Date.now() + 1000 } }))); }
if (process.env.KEEP_WORKTREE !== '1') git('worktree', 'remove', '--force', WT);

/* ---------- The page Paul looks at ---------- */
const ROWS = [
  ['today', 'Phone, Today', 'A1 one thumb slides under the switcher labels. C3 hairlines start at the text (54px). C4 the switcher labels go from 15 to 17px.'],
  ['reveal', 'Phone, swipe left (finger held)', 'C2 the move targets are neutral grey chips, the current section dimmed. C3 the hairlines stay at the text during the swipe instead of going full width. C4 the chips go from 14px to 13px semibold (the meta size), leaving about 150px of task text.'],
  ['capture', 'Phone, capture sheet with two lines added', 'C5 one sheet header: the label left and a 17px Close (was a 15px Done). C4 the added lines go from 15 to 17px.'],
  ['edit', 'Phone, edit sheet', 'C5 the Task label moves into the header next to Close. A1 the section control has the sliding thumb. C4 its labels go to 17px.'],
  ['done', 'Phone, Done history', 'C3 no line under a day header, and the lines between rows start at the text.'],
  ['toast', 'Phone, toast after a move', 'C4 the toast text and Undo go from 15 to 17px. C2 the chips it came from are neutral.'],
  ['offline', 'Phone, offline pill in Someday', 'B4 the pill opens in a slot under the title that glides open, so the list never jumps (it does not fit beside Someday and the clock at 390px). C4 the switcher at 17px.'],
  ['empty', 'Phone, empty section', 'A1 the thumb. C4 the switcher at 17px.'],
  ['desk-today', 'Desktop, Today with a hovered row', 'C4 the sidebar sections go from 15 to 17px and the To-do label to 13px. C3 the 8px between cards is now inside each row, so a finished row leaves no 8px hop (same look).'],
  ['desk-edit', 'Desktop, edit sheet', 'C5 one sheet header with the Task label. A1 the thumb in the section control. C4 17px labels.'],
];
const img = (f, cls) => existsSync(join(OUT, f)) ? `<img class="${cls}" src="${f}" alt="" loading="lazy">` : '<div class="missing">not taken</div>';
const pair = (name, scheme, desk) => `
    <div class="pair${desk ? ' desk' : ''}">
      <figure><figcaption>Before</figcaption>${img(`${name}-${scheme}-before.png`, desk ? 'd' : 'p')}</figure>
      <figure><figcaption>After</figcaption>${img(`${name}-${scheme}-after.png`, desk ? 'd' : 'p')}</figure>
    </div>`;
let body = '';
for (const [name, title, note] of ROWS) {
  const desk = name.startsWith('desk');
  body += `
  <section>
    <h2>${title}</h2>
    <p>${note}</p>
    <div class="schemes">
      <div><h3>Light</h3>${pair(name, 'light', desk)}</div>
      <div><h3>Dark</h3>${pair(name, 'dark', desk)}</div>
    </div>
  </section>`;
}
let c10 = '';
for (const name of ['today', 'done']) {
  for (const scheme of ['light', 'dark']) {
    c10 += `
    <div class="trio">
      <h3>${name === 'today' ? 'Today' : 'Done'}, ${scheme}</h3>
      <div class="row3">
        <figure><figcaption>Default (after)</figcaption>${img(`${name}-${scheme}-after.png`, 'p')}</figure>
        <figure><figcaption>C10a: dark fills #7DBF98</figcaption>${img(`${name}-${scheme}-c10a-after.png`, 'p')}</figure>
        <figure><figcaption>C10b: light ring #A1A1A6</figcaption>${img(`${name}-${scheme}-c10b-after.png`, 'p')}</figure>
      </div>
    </div>`;
  }
}
writeFileSync(join(OUT, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>To-do look set</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #111113; color: #E5E5EA; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 1680px; margin: 0 auto; padding: 32px 16px 80px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  .lead { color: #A1A1A6; margin: 0 0 32px; max-width: 70ch; }
  section, .c10 { border-top: 1px solid #2C2C2E; padding: 28px 0; }
  h2 { font-size: 19px; margin: 0 0 4px; }
  h3 { font-size: 13px; font-weight: 600; color: #8E8E93; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .04em; }
  section > p, .c10 > p { color: #A1A1A6; margin: 0 0 16px; max-width: 90ch; }
  .schemes { display: flex; flex-wrap: wrap; gap: 32px; }
  .pair, .row3 { display: flex; flex-wrap: wrap; gap: 12px; }
  figure { margin: 0; }
  figcaption { font-size: 12px; color: #8E8E93; margin-bottom: 6px; }
  img.p { width: 300px; max-width: calc(50vw - 30px); height: auto; border-radius: 12px; border: 1px solid #2C2C2E; display: block; }
  img.d { width: 640px; max-width: calc(100vw - 32px); height: auto; border-radius: 8px; border: 1px solid #2C2C2E; display: block; }
  .pair.desk { flex-direction: column; }
  .trio { margin-bottom: 24px; }
  .missing { width: 300px; height: 120px; display: grid; place-items: center; color: #FF6B60; border: 1px dashed #48484A; border-radius: 12px; }
</style>
</head>
<body>
<main>
  <h1>To-do look set, before and after</h1>
  <p class="lead">Release 3 of the motion and polish review: C2, C3, C4, C5, the B4 pill and the A1 thumb, for one sign-off. Same seeded list on both sides. Phone 390 by 844, desktop 1440 by 900. Taken ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.</p>
${body}
  <div class="c10">
    <h2>C10, two token tweaks to pick from (not applied by default)</h2>
    <p>(a) In dark mode the fills (add button, active segment, done check) use #7DBF98 like the text, with a black check and plus on them, instead of #3F7D5C. (b) In light mode the empty circle ring is #A1A1A6 instead of #C7C7CC, so it stays visible in sunlight.</p>
${c10}
  </div>
</main>
</body>
</html>
`);
console.log(`\n${done.length} shots, index at ${join(OUT, 'index.html')}`);
