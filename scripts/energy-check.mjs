// The Energy dial, against a mocked Worker (no wrangler needed): the dial sets and clears the level,
// Give me one walks the hub's order, Not this one tells the hub, Surprise me never repeats, Start this
// one moves a Soon task to Today, the edit sheet and Sort confirm guesses, a level set in Morning
// shows here, and Tidy's guess lands outlined. Every value is made up.
//   PORT=8097 npm run serve, then: APP_URL=http://localhost:8097/ npm run energy-check
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8097/';
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
    t('todayplain01', 'Text Sam back', 'today', { energy: 'drained' }),
    t('todaydue0001', `Buy stamps · ${day(0)}`, 'today', { energy: 'drained' }),
    t('todaywired01', 'Write the plan', 'today', { energy: 'wired' }),
    t('soonplain001', 'Order bulbs', 'soon', { energy: 'drained' }),
    t('soondated001', `Return the lamp · ${day(4)}`, 'soon', { energy: 'drained' }),
    t('soonnick0001', 'Nick: look at his bike', 'soon', { energy: 'drained' }),
    t('soonguess001', 'Book flights', 'soon', { energyGuess: 'normal' }),
    t('soonblank001', 'Call the gemeente', 'soon'),
    t('somedayd0001', 'Clean the shed', 'someday', { energy: 'drained' }),
  ];
  const items = Object.fromEntries(list.map((i) => [i.id, i]));
  let rev = 1;
  const w = {
    items, posts: [], skips: [], suggested: 0, ops: [],
    state: { level: null, setAt: null, until: null, source: null },
    route(req) {
      const p = new URL(req.url()).pathname;
      const body = req.method() === 'POST' ? req.postDataJSON() : null;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) {
        for (const o of body.ops) {
          w.ops.push(o);
          if (o.op === 'upsert') {
            const cur = items[o.item.id] || {};
            const next = { ...o.item };
            for (const f of ['energy', 'energyGuess']) { if (next[f] === undefined && cur[f]) next[f] = cur[f]; if (next[f] === null) delete next[f]; }
            items[o.item.id] = next;
          } else delete items[o.item.id];
        }
        rev++;
        return { items: Object.values(items), rev, updated: new Date().toISOString(), rejected: [] };
      }
      if (p === `/api/energy/${CODE}`) {
        if (body) {
          w.posts.push(body);
          w.state = body.level ? { level: body.level, setAt: new Date().toISOString(), until: new Date(Date.now() + 4 * 3600e3).toISOString(), source: body.source } : { level: null, setAt: null, until: null, source: null };
        }
        return { ...w.state, pick: null };
      }
      if (p === `/api/energy/${CODE}/pick`) { if (body.skipped) w.skips.push(body.skipped); return { ...w.state, pick: null }; }
      if (p === `/api/energy/${CODE}/suggest`) {
        w.suggested++;
        items.soonblank001 = { ...items.soonblank001, energyGuess: 'normal', updatedAt: Date.now() };
        rev++;
        return { guessed: 1 };
      }
      if (p === `/api/tidy/${CODE}`) return { text: 'Buy coffee beans', changed: true, kind: 'task', energy: 'drained' };
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      if (p.startsWith('/api/hiscores/')) return { skills: [] };
      if (p === `/api/dread/${CODE}`) return { running: null, stopped: null };
      if (p === `/api/dread/${CODE}/start`) return { running: { task: body.task, name: '', startedAt: new Date().toISOString(), dread: body.dread, source: 'todo', mins: 0 } };
      if (p === `/api/dread/${CODE}/skip`) return { ok: true };
      return null;
    },
  };
  return w;
}

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['energy-phone', { width: 390, height: 844 }, 'light'], ['energy-desk', { width: 1280, height: 900 }, 'dark']]) {
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
  await page.waitForTimeout(500);
  const tap = (sel) => page.locator(sel).first().click();
  const pickName = () => page.locator('#pickBody .pick-name').textContent();

  // The dial, unset.
  check(await page.isVisible('#energy'), name + ': the dial shows on Today');
  check((await page.textContent('#energyText')).includes('How much energy'), name + ': no level yet');
  check(await page.isHidden('#giveOne'), name + ': no Give me one without a level');
  check((await page.textContent('#energySort')).startsWith('2 tasks have no level'), name + ': Sort counts the tasks with no level');
  check((await page.locator('.row[data-id="todayplain01"] .tbatt').count()) === 1, name + ': a confirmed level shows as a battery on the row');
  if (phone) await page.screenshot({ path: file(name + '-unset') });

  // Set it.
  await tap('#energySeg [data-level="drained"]');
  await page.waitForTimeout(400);
  check(JSON.stringify(w.posts.at(-1)) === JSON.stringify({ level: 'drained', source: 'todo' }), name + ': tapping Drained tells the hub ' + JSON.stringify(w.posts.at(-1)));
  check((await page.getAttribute('#energySeg [data-level="drained"]', 'aria-checked')) === 'true', name + ': Drained is on');
  check((await page.textContent('#energyText')).startsWith('Drained until'), name + ': says until when');
  check(await page.isVisible('#giveOne'), name + ': Give me one shows');
  await page.screenshot({ path: file(name + '-today') });

  // Give me one: Today dated first, Today undated, Soon dated, Soon undated, someone else last.
  await tap('#giveOne');
  await page.waitForSelector('#pick:not([hidden]) .pick-name');
  await page.waitForTimeout(400);
  check((await pickName()) === 'Buy stamps', name + ': the first pick is due today ' + await pickName());
  check((await page.textContent('#pickHead')).includes('1 of 5 that fit'), name + ': 5 fit, Someday never ' + await page.textContent('#pickHead'));
  await page.screenshot({ path: file(name + '-pick') });
  const seen = [await pickName()];
  for (let i = 0; i < 4; i++) { await tap('#pickBody [data-act="skip"]'); await page.waitForTimeout(150); seen.push(await pickName()); }
  check(JSON.stringify(seen) === JSON.stringify(['Buy stamps', 'Text Sam back', 'Return the lamp', 'Order bulbs', 'Nick: look at his bike']), name + ': Not this one walks the order ' + JSON.stringify(seen));
  await page.waitForTimeout(300);
  check(w.skips.length === 4 && w.skips[0] === 'todaydue0001', name + ': each Not this one is told to the hub ' + JSON.stringify(w.skips));
  await tap('#pickBody [data-act="skip"]');
  await page.waitForTimeout(150);
  check((await pickName()).startsWith('That was every task'), name + ': all turned down');
  await tap('#pickBody [data-act="again"]');
  await page.waitForTimeout(150);
  let same = 0;
  for (let i = 0; i < 8; i++) { const before = await pickName(); await tap('#pickBody [data-act="surprise"]'); await page.waitForTimeout(80); if ((await pickName()) === before) same++; }
  check(same === 0, name + ': Surprise me never shows the same task twice in a row');
  check(w.skips.length === 5, name + ': Surprise me is not a skip');
  // Walk to Order bulbs (Soon) and do it: it moves to Today. Opening again starts a new round.
  await tap('#pickClose');
  await page.waitForTimeout(400);
  await tap('#giveOne');
  await page.waitForSelector('#pick:not([hidden]) .pick-name');
  for (let i = 0; i < 3; i++) { await tap('#pickBody [data-act="skip"]'); await page.waitForTimeout(100); }
  check((await pickName()) === 'Order bulbs', name + ': at Order bulbs');
  check((await page.textContent('#pickBody .pick-do')).includes('moves it to Today'), name + ': a Soon pick says it moves');
  await tap('#pickBody [data-act="start"]');
  await page.waitForSelector('#pickBody .dread-chips');
  await tap('#pickBody [data-act="nodread"]');
  await page.waitForTimeout(2000); // the op goes out after the 1.2 s debounce
  check(w.items.soonplain001.section === 'today', name + ': Start this one moved it to Today');
  check(w.items.soonplain001.energy === 'drained', name + ': the move kept its level');
  await tap('#pickBody [data-act="close"]');
  await page.waitForTimeout(500);

  // The edit sheet: a guess is outlined, a tap confirms it.
  await tap('[data-section="soon"]:visible');
  await page.waitForSelector('.row[data-id="soonguess001"]');
  await page.locator('.row[data-id="soonguess001"] .text').click();
  await page.waitForSelector('#edit:not([hidden])');
  await page.waitForTimeout(400);
  check(await page.locator('#editEnergy [data-level="normal"].guess').count() === 1, name + ': the guess is outlined');
  check(await page.isVisible('#editEnergyNote'), name + ': says it is a guess');
  if (phone) await page.screenshot({ path: file(name + '-edit') });
  await tap('#editEnergy [data-level="normal"]');
  await page.waitForTimeout(1600);
  check(w.items.soonguess001.energy === 'normal' && !w.items.soonguess001.energyGuess, name + ': confirmed, the guess gone ' + JSON.stringify(w.items.soonguess001));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Sort: asks for guesses once, shows them, a tap confirms.
  await tap('[data-section="today"]:visible');
  await page.waitForTimeout(300);
  await tap('#energySort');
  await page.waitForSelector('#sort:not([hidden]) .sort-row');
  await page.waitForTimeout(900);
  check(w.suggested === 1, name + ': Sort asked the hub for guesses once');
  check(await page.locator('.sort-row[data-id="soonblank001"] [data-level="normal"].guess').count() === 1, name + ': the new guess shows outlined');
  if (phone) await page.screenshot({ path: file(name + '-sort') });
  await page.locator('.sort-row[data-id="soonblank001"] [data-level="drained"]').click();
  await page.waitForTimeout(1600);
  check(w.items.soonblank001.energy === 'drained' && !w.items.soonblank001.energyGuess, name + ': Sort confirmed another level than the guess');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check(await page.isHidden('#energySort'), name + ': nothing left to sort');

  // A level set in Morning shows here on the next poll.
  w.state = { level: 'wired', setAt: new Date().toISOString(), until: new Date(Date.now() + 2 * 3600e3).toISOString(), source: 'morning' };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(800);
  check((await page.textContent('#energyText')).includes('set in Morning') && (await page.getAttribute('#energySeg [data-level="wired"]', 'aria-checked')) === 'true', name + ': a level from Morning shows');
  // Tapping the level that is on clears it.
  await tap('#energySeg [data-level="wired"]');
  await page.waitForTimeout(400);
  check(w.posts.at(-1).level === null && (await page.isHidden('#giveOne')), name + ': tapping it again clears it');

  // Tidy's guess lands outlined on a new task.
  if (phone) {
    await tap('#fab');
    await page.fill('#capInput', 'buy cofee beans');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2200);
    const added = Object.values(w.items).find((i) => i.text === 'Buy coffee beans');
    check(added && added.energyGuess === 'drained' && !added.energy, name + ': Tidy guessed, nothing confirmed ' + JSON.stringify(added));
  }
  check(errors.length === 0, name + ': no page errors ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
