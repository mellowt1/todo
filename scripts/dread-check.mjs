// The Dread meter, against a mocked Worker (no wrangler needed): Start this one asks the dread and
// tells the hub, the pill runs on Today with the minutes on the row, ticking it off says how long it
// took (Undo lets it run on), a timer started in Morning shows and can be rated and stopped, the
// move menu and the edit sheet start one, a move out of Today is a skip, and on a drained day a
// task last rated 4 or 5 is picked last. Every value is made up.
//   PORT=8121 npm run serve, then: APP_URL=http://localhost:8121/ npm run dread-check
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8121/';
const CODE = 'abcdefgh23456789';
const OUT = new URL('../screenshots/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const file = (n) => fileURLToPath(new URL(n + '.png', OUT));
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.error('FAIL:', what); } else console.log('ok:', what); };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

function world() {
  const now = Date.now();
  let k = 0;
  const t = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: now - 1000 * ++k, pos: now - 1000 * k, ...extra });
  const list = [
    t('heavydue0001', `Ticket for Lucho November · ${day(0)}`, 'today', { energy: 'drained', dread: 5 }),
    t('todayplain01', 'Text Sam back', 'today', { energy: 'drained', dread: 2 }),
    t('todaylamp001', 'Return the lamp', 'today', { energy: 'drained' }),
    t('soonplain001', 'Order bulbs', 'soon', { energy: 'drained' }),
  ];
  const items = Object.fromEntries(list.map((i) => [i.id, i]));
  let rev = 1;
  const w = {
    items, dread: [], running: null,
    state: { level: 'drained', setAt: new Date().toISOString(), until: new Date(Date.now() + 3 * 3600e3).toISOString(), source: 'todo' },
    route(req) {
      const p = new URL(req.url()).pathname;
      const body = req.method() === 'POST' ? req.postDataJSON() : null;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) {
        for (const o of body.ops) {
          if (o.op === 'upsert') {
            const cur = items[o.item.id] || {};
            const next = { ...o.item };
            for (const f of ['energy', 'energyGuess', 'dread']) { if (next[f] === undefined && cur[f]) next[f] = cur[f]; if (next[f] === null) delete next[f]; }
            items[o.item.id] = next;
          } else delete items[o.item.id];
        }
        rev++;
        return { items: Object.values(items), rev, updated: new Date().toISOString(), rejected: [] };
      }
      if (p === `/api/energy/${CODE}`) return { ...w.state, pick: null };
      if (p === `/api/energy/${CODE}/pick`) return { ...w.state, pick: null };
      if (p.startsWith(`/api/dread/${CODE}`)) {
        const sub = p.slice(`/api/dread/${CODE}`.length).replace('/', '');
        if (!sub) return { running: w.running, stopped: null };
        w.dread.push({ sub, ...body });
        const name = (id) => (items[id] ? items[id].text.replace(/ · .*$/, '') : '');
        if (sub === 'start') { w.running = { task: body.task, name: name(body.task), startedAt: new Date(Date.now() - 60e3).toISOString(), dread: body.dread, source: 'todo', mins: 1 }; return { running: w.running }; }
        if (sub === 'rate') { w.running = { ...w.running, dread: body.dread }; items[body.task] = { ...items[body.task], dread: body.dread }; return { running: w.running }; }
        if (sub === 'stop') { const r = w.running; w.running = null; return { running: null, stopped: r ? { task: r.task, name: r.name, mins: 7, dread: r.dread, done: !!body.done } : null }; }
        if (sub === 'undo') { w.running = { task: body.task, name: name(body.task), startedAt: new Date(Date.now() - 60e3).toISOString(), dread: 4, source: 'todo', mins: 1 }; return { running: w.running }; }
        if (sub === 'skip') return { ok: true };
      }
      if (p === `/api/tidy/${CODE}`) return { text: 'x', changed: false, kind: 'task' };
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      if (p.startsWith('/api/hiscores/')) return { skills: [] };
      if (p === `/api/waiting/${CODE}`) return { items: [], open: 0, due: 0, names: [] };
      return null;
    },
  };
  return w;
}

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['dread-phone', { width: 390, height: 844 }, 'light'], ['dread-desk', { width: 1280, height: 900 }, 'dark']]) {
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
  await page.waitForTimeout(600);
  const tap = (sel) => page.locator(sel).first().click();
  const last = (sub) => w.dread.filter((d) => d.sub === sub).at(-1);
  const poll = async (n = 3) => { for (let i = 0; i < n; i++) { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(300); } };

  // Drained: the dreaded task due today goes last; the dated rule would have put it first.
  await tap('#giveOne');
  await page.waitForSelector('#pick:not([hidden]) .pick-name');
  await page.waitForTimeout(400);
  const order = [await page.textContent('#pickBody .pick-name')];
  for (let i = 0; i < 2; i++) { await tap('#pickBody [data-act="skip"]'); await page.waitForTimeout(150); order.push(await page.textContent('#pickBody .pick-name')); }
  check(order[0] !== 'Ticket for Lucho November' && order.includes('Ticket for Lucho November') === false, name + ': a task last rated 5 is not picked first ' + JSON.stringify(order));
  await tap('#pickClose');
  await page.waitForTimeout(400);

  // Start this one -> the question -> 4 -> started.
  await tap('#giveOne');
  await page.waitForSelector('#pick:not([hidden]) .pick-name');
  const first = await page.textContent('#pickBody .pick-name');
  check((await page.textContent('#pickBody .pick-do')).startsWith('Start this one'), name + ': the pick says Start this one');
  await tap('#pickBody [data-act="start"]');
  await page.waitForSelector('#pickBody .dread-chips');
  check((await page.locator('#pickBody .dread-chips button').count()) === 5, name + ': five dread buttons');
  check(await page.evaluate(() => document.activeElement && document.activeElement.dataset.dread === '1'), name + ': focus goes to the first number');
  await page.screenshot({ path: file(name + '-ask') });
  await tap('#pickBody [data-dread="4"]');
  await page.waitForSelector('#pickBody .dread-said');
  const startPost = last('start');
  check(startPost && startPost.dread === 4 && startPost.source === 'todo' && w.items[startPost.task] && first.startsWith(w.items[startPost.task].text.replace(/ · .*$/, '')), name + ': the hub heard start with dread 4 ' + JSON.stringify(startPost));
  check((await page.textContent('#pickBody .dread-said')).includes(', dread 4. The timer runs on Today.'), name + ': says started, dread 4');
  await tap('#pickBody [data-act="close"]');
  await page.waitForTimeout(500);
  const runId = startPost.task;
  check(await page.isVisible('#running'), name + ': the pill runs on Today');
  check((await page.textContent('#runMeta')).includes('Running 1 min · dread 4'), name + ': pill says minutes and dread ' + await page.textContent('#runMeta'));
  check(await page.isHidden('#runRate'), name + ': rated already, no Rate');
  check((await page.locator(`.row[data-id="${runId}"] .trun`).count()) === 1, name + ': the row shows its minutes');
  await page.screenshot({ path: file(name + '-running') });

  // Tick it off: the toast says how long it took; Undo lets the timer run on.
  await page.click(`.row[data-id="${runId}"] .circle`);
  await page.waitForTimeout(1800);
  check((await page.textContent('#toastText')).startsWith('Done. Dreaded 4, took 1 minute.'), name + ': the toast ' + await page.textContent('#toastText'));
  check(last('stop') && last('stop').done === true, name + ': the hub heard it was done');
  check(await page.isHidden('#running'), name + ': no pill after Done');
  if (phone) await page.screenshot({ path: file(name + '-done') });
  await tap('#toastUndo');
  await page.waitForTimeout(1800);
  check(last('undo') && last('undo').task === runId, name + ': Undo told the hub');
  check(await page.isVisible('#running') && !w.items[runId].done, name + ': the task is open and the timer runs again');

  // Stop.
  await tap('#runStop');
  await page.waitForTimeout(500);
  check(last('stop') && last('stop').done === undefined && await page.isHidden('#running'), name + ': Stop stops it');
  check((await page.textContent('#toastText')).startsWith('Stopped after 7 minutes'), name + ': says how long ' + await page.textContent('#toastText'));

  // A timer started in Morning shows on the next read; Rate asks; a number rates it.
  w.running = { task: 'todaylamp001', name: 'Return the lamp', startedAt: new Date(Date.now() - 5 * 60e3).toISOString(), dread: null, source: 'morning', mins: 5 };
  await poll();
  check((await page.textContent('#runMeta')).includes('started in Morning'), name + ': a Morning timer shows ' + await page.textContent('#runMeta'));
  check(await page.isVisible('#runRate'), name + ': not rated: Rate shows');
  await tap('#runRate');
  await page.waitForSelector('#pick:not([hidden]) .dread-chips');
  check((await page.textContent('#pickHead')) === 'Rate the dread', name + ': the sheet asks to rate');
  await tap('#pickBody [data-dread="2"]');
  await page.waitForTimeout(600);
  check(last('rate') && last('rate').dread === 2 && last('rate').task === 'todaylamp001', name + ': rated 2');
  check((await page.textContent('#runMeta')).includes('dread 2') && await page.isHidden('#pick'), name + ': the pill says dread 2, the sheet closed');

  // The edit sheet of the running task stops it.
  await page.locator('.row[data-id="todaylamp001"] .text').click();
  await page.waitForSelector('#edit:not([hidden])');
  await page.waitForTimeout(400);
  check((await page.textContent('#editStart')) === 'Stop timer', name + ': the edit sheet offers Stop');
  if (phone) await page.screenshot({ path: file(name + '-edit') });
  await tap('#editStart');
  await page.waitForTimeout(900);
  check(await page.isHidden('#running'), name + ': stopped from the edit sheet');

  if (!phone) {
    // The move menu starts one; Skip just starts.
    await page.locator('.row[data-id="todayplain01"]').click({ button: 'right' });
    await page.waitForSelector('#menu:not([hidden])');
    check((await page.textContent('#menu [data-start]')) === 'Start this one', name + ': the menu offers Start this one');
    await tap('#menu [data-start]');
    await page.waitForSelector('#pick:not([hidden]) .dread-chips');
    await tap('#pickBody [data-act="nodread"]');
    await page.waitForSelector('#pickBody .dread-said');
    check(last('start').task === 'todayplain01' && last('start').dread === null, name + ': started from the menu, no dread');
    await tap('#pickBody [data-act="close"]');
    await page.waitForTimeout(400);
    check(await page.isVisible('#runRate'), name + ': no dread yet: Rate shows');

    // Moving a task out of Today is a skip.
    await page.locator('.row[data-id="todaylamp001"]').click({ button: 'right' });
    await page.waitForSelector('#menu:not([hidden])');
    await page.click('#menu button[data-move="soon"]');
    await page.waitForTimeout(600);
    check(last('skip') && last('skip').task === 'todaylamp001' && last('skip').why === 'moved', name + ': the move was told as a skip');
  }
  check(errors.length === 0, name + ': no page errors ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
