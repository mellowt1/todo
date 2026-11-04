// Waiting on, against a mocked Worker (no wrangler needed): the line on Soon, the list with They
// answered and Snooze, "Sent, now waiting" from a task (ticks it off), the form's checks, someone
// else, and "did they answer?" when a chase task is ticked. Every value is made up.
//   PORT=8113 npm run serve, then: APP_URL=http://localhost:8113/ npm run waiting-check
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8113/';
const CODE = 'abcdefgh23456789';
const OUT = new URL('../screenshots/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const file = (n) => fileURLToPath(new URL(n + '.png', OUT));
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.error('FAIL:', what); } else console.log('ok:', what); };

function world() {
  const now = Date.now();
  let k = 0;
  const t = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: now - 1000 * ++k, pos: now - 1000 * k, ...extra });
  const list = [
    t('chasetask001', 'Chase Gemeente about the parking permit', 'today', { energy: 'drained', waiting: 'wgemeente0000001' }),
    t('todayplain01', 'Text Sam back', 'today'),
    t('soonsend0001', 'Send the payment choice to the tax office', 'soon'),
    t('soonplain001', 'Order bulbs', 'soon'),
  ];
  const items = Object.fromEntries(list.map((i) => [i.id, i]));
  let rev = 1;
  const w = {
    items, posts: [], acts: [],
    waits: [
      { id: 'wgemeente0000001', who: 'Gemeente', what: 'the parking permit', since: '2026-10-10', channel: 'letter', chaseDays: 7, nextChase: '2026-10-17', forWhom: null, source: 'todo', state: 'open', chases: 1, chaseDue: true, chaseTask: 'chasetask001' },
      { id: 'waccountant00001', who: 'the accountant', what: 'the tax overview', since: '2026-10-18', channel: 'phone', chaseDays: 7, nextChase: '2026-10-25', forWhom: 'Sam', source: 'todo', state: 'open', chases: 0, chaseDue: false, chaseTask: null },
    ],
    route(req) {
      const p = new URL(req.url()).pathname;
      const body = req.method() === 'POST' ? req.postDataJSON() : null;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) {
        for (const o of body.ops) { if (o.op === 'upsert') items[o.item.id] = { ...items[o.item.id], ...o.item }; else delete items[o.item.id]; }
        rev++;
        return { items: Object.values(items), rev, updated: new Date().toISOString(), rejected: [] };
      }
      if (p === `/api/waiting/${CODE}`) {
        if (body) {
          w.posts.push(body);
          const item = { id: 'wnew' + String(w.posts.length).padStart(12, '0'), who: body.who, what: body.what, since: '2026-10-21', channel: body.channel, chaseDays: body.chaseDays, nextChase: '2026-10-28', forWhom: body.forWhom || null, source: 'todo', state: 'open', chases: 0, chaseDue: false, chaseTask: null };
          w.waits.push(item);
          return { item };
        }
        const open = w.waits.filter((x) => x.state === 'open');
        return { items: open, open: open.length, due: open.filter((x) => x.chaseDue).length, names: ['Gemeente', 'the accountant'] };
      }
      const m = p.match(new RegExp(`^/api/waiting/${CODE}/([a-z0-9]{16})$`));
      if (m) {
        w.acts.push({ id: m[1], ...body });
        const it = w.waits.find((x) => x.id === m[1]);
        if (body.action === 'resolve') it.state = 'resolved';
        if (body.action === 'snooze') { it.chaseDue = false; it.nextChase = '2026-10-28'; }
        return { item: it };
      }
      if (p === `/api/energy/${CODE}`) return { level: null, setAt: null, until: null, source: null, pick: null };
      if (p === `/api/tidy/${CODE}`) return { text: '', changed: false, kind: 'task' };
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      if (p.startsWith('/api/hiscores/')) return { skills: [] };
      return null;
    },
  };
  return w;
}

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['waiting-phone', { width: 390, height: 844 }, 'light'], ['waiting-desk', { width: 1280, height: 900 }, 'dark']]) {
  const w = world();
  const phone = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: scheme });
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
  await page.waitForSelector('.row[data-id="todayplain01"]');
  await page.waitForTimeout(2200); // the first Waiting on read comes after the list
  const tap = (sel) => page.locator(sel).first().click();

  // The line, Soon only.
  check(await page.isHidden('#waitLine'), name + ': no line on Today');
  await tap('[data-section="soon"]:visible');
  await page.waitForTimeout(400);
  check((await page.textContent('#waitLine')) === 'Waiting on 2 · 1 chase due', name + ': the line on Soon ' + await page.textContent('#waitLine'));

  // The stack: chases due first; swipe right they answered, left snooze 3 days.
  // Drags the top card of a stack: dx/dy in px, quick or slow.
  const drag = async (stage, dx, dy = 0) => {
    const b = await page.locator(stage + ' .scard[aria-hidden="false"]').boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(450);
  };
  const topName = (stage) => page.locator(stage + ' .scard[aria-hidden="false"] .sc-name').textContent();
  const metaTop = () => page.textContent('#waitStage .scard[aria-hidden="false"] .sc-meta');
  await tap('#waitLine');
  await page.waitForSelector('#waitList:not([hidden]) .scard');
  await page.waitForTimeout(400);
  check((await topName('#waitStage')) === 'Gemeente about the parking permit', name + ': the due one first ' + await topName('#waitStage'));
  check((await metaTop()).includes('Chase due'), name + ': a due one says so');
  if (phone) await page.screenshot({ path: file(name + '-list') });
  const acts0 = w.acts.length;
  await drag('#waitStage', 150);
  check((await topName('#waitStage')) === 'the accountant about the tax overview' && (await metaTop()).startsWith('For Sam'), name + ': next card, someone else says for whom');
  check(w.acts.length === acts0, name + ': the hub is told a moment later, not yet');
  await tap('#waitBtns [data-dir="left"]');
  await page.waitForTimeout(600);
  check(w.acts.at(-1) && w.acts.at(-1).action === 'resolve' && w.acts.at(-1).id === 'wgemeente0000001', name + ': the next swipe sent They answered ' + JSON.stringify(w.acts.at(-1)));
  await tap('#waitUndo');
  await page.waitForTimeout(500);
  check((await topName('#waitStage')) === 'the accountant about the tax overview' && w.acts.length === acts0 + 1, name + ': Undo took the snooze back before it was sent');
  await tap('#waitBtns [data-dir="left"]');
  await page.waitForTimeout(450);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  check(JSON.stringify(w.acts.at(-1)) === JSON.stringify({ id: 'waccountant00001', source: 'todo', action: 'snooze', days: 3 }), name + ': closing sent Snooze 3 days ' + JSON.stringify(w.acts.at(-1)));

  // Sent, now waiting from a task.
  await page.locator('.row[data-id="soonsend0001"] .text').click();
  await page.waitForSelector('#edit:not([hidden])');
  await page.waitForTimeout(400);
  await tap('#editWait');
  await page.waitForSelector('#wait:not([hidden])');
  await page.waitForTimeout(500);
  check((await page.inputValue('#waitWhat')) === 'Send the payment choice to the tax office', name + ': About is the task');
  await tap('#waitSave');
  await page.waitForTimeout(200);
  check(await page.isVisible('#waitErr') && w.posts.length === 0, name + ': Who is required, nothing sent');
  await tap('#waitNames [data-name="Gemeente"]');
  await page.fill('#waitWhat', 'the payment plan');
  await tap('#waitHow [data-v="letter"]');
  if (phone) await page.screenshot({ path: file(name + '-form') });
  await tap('#waitSave');
  await page.waitForTimeout(2000);
  check(JSON.stringify(w.posts.at(-1)) === JSON.stringify({ source: 'todo', who: 'Gemeente', what: 'the payment plan', channel: 'letter', chaseDays: 7, sourceItem: 'soonsend0001' }), name + ': the right body ' + JSON.stringify(w.posts.at(-1)));
  check(w.items.soonsend0001.done === true, name + ': the task is ticked off');

  // Someone else needs a name.
  await tap('#waitLine');
  await page.waitForSelector('#waitList:not([hidden])');
  await page.waitForTimeout(300);
  await tap('#waitAdd');
  await page.waitForSelector('#wait:not([hidden])');
  await page.waitForTimeout(500);
  await page.fill('#waitWho', 'the landlord');
  await page.fill('#waitWhat', 'the heater');
  await tap('#waitFor [data-v="else"]');
  await tap('#waitAfter [data-v="3"]');
  await tap('#waitSave');
  await page.waitForTimeout(200);
  check((await page.textContent('#waitErr')).includes('Who is it for'), name + ': someone else needs a name');
  await page.fill('#waitForName', 'Mum');
  await tap('#waitSave');
  await page.waitForTimeout(900);
  check(w.posts.at(-1).forWhom === 'Mum' && w.posts.at(-1).chaseDays === 3 && !w.posts.at(-1).sourceItem, name + ': for Mum, 3 days, no task ' + JSON.stringify(w.posts.at(-1)));

  // A chase task ticked: did they answer?
  await tap('[data-section="today"]:visible');
  await page.waitForSelector('.row[data-id="chasetask001"]');
  w.waits.find((x) => x.id === 'wgemeente0000001').state = 'open'; // still open for this part
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(600);
  await page.locator('.row[data-id="chasetask001"] .circle').click();
  await page.waitForSelector('#answered:not([hidden])', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);
  check(await page.isVisible('#answered'), name + ': ticking a chase task asks');
  check((await page.textContent('#ansQ')).startsWith('Did Gemeente answer'), name + ': names who ' + await page.textContent('#ansQ'));
  if (phone) await page.screenshot({ path: file(name + '-answered') });
  await tap('#ansStill');
  await page.waitForTimeout(600);
  check(w.acts.at(-1).action === 'still' && w.acts.at(-1).id === 'wgemeente0000001', name + ': Still waiting tells the hub');

  // Three chases due: the stack opens by itself with those and lets go when each is swiped.
  for (const [id, who] of [['wforceaaaaaaaaa1', 'the landlord'], ['wforceaaaaaaaaa2', 'the bank'], ['wforceaaaaaaaaa3', 'the school']]) {
    w.waits.push({ id, who, what: 'a reply', since: '2026-10-12', channel: 'email', chaseDays: 7, nextChase: '2026-10-19', forWhom: null, source: 'todo', state: 'open', chases: 0, chaseDue: true, chaseTask: null });
  }
  await page.reload();
  await page.waitForSelector('#waitList:not([hidden]) .scard', { timeout: 8000 });
  await page.waitForTimeout(500);
  check((await page.textContent('#waitListHead')) === 'Chase these first' && await page.isHidden('#waitListClose') && await page.isHidden('#waitAdd'), name + ': forced: no Close, no Add');
  for (let i = 0; i < 6 && await page.locator('#waitStage .scard').count(); i++) { await page.locator('#waitStage').focus(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(450); } // Gemeente is still due too
  await page.waitForTimeout(1500);
  check(await page.isHidden('#waitList') && ['wforceaaaaaaaaa1', 'wforceaaaaaaaaa2', 'wforceaaaaaaaaa3'].every((id) => w.acts.some((a) => a.id === id && a.action === 'resolve')), name + ': each due one answered and sent, then it let go ' + JSON.stringify(w.acts.slice(-4)));
  check(errors.length === 0, name + ': no page errors ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
