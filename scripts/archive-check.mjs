// Archive, against a mocked Worker (no wrangler needed): a task passed on 5 times gets the line on
// Today; Later hides it; Archive asks for a note in place and tells the hub; Hand off opens the
// Waiting sheet as "Hand it off" and sends handoff; Do it now asks the dread; the ledger opens from
// Done and Restore tells the hub. Every value is made up.
//   PORT=8121 npm run serve, then: APP_URL=http://localhost:8121/ npm run archive-check
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

function world() {
  const now = Date.now();
  let k = 0;
  const t = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: now - 1000 * ++k, pos: now - 1000 * k, ...extra });
  const list = [
    t('luchotask001', 'Ticket for Lucho November', 'today'),
    t('boilertask01', 'Book the boiler service', 'today'),
    t('lamptask0001', 'Return the lamp', 'today'),
  ];
  const items = Object.fromEntries(list.map((i) => [i.id, i]));
  let rev = 1;
  const w = {
    items, posts: [], waits: [], dread: [],
    due: [{ task: 'luchotask001', name: 'Ticket for Lucho November', section: 'today', skips: 5 }, { task: 'boilertask01', name: 'Book the boiler service', section: 'today', skips: 6 }],
    ledger: [{ task: 'drawer000001', name: 'Sort the cable drawer', added: null, archived: new Date(now - 2 * 864e5).toISOString(), skips: 5, note: 'Not this year.' }],
    route(req) {
      const p = new URL(req.url()).pathname;
      const body = req.method() === 'POST' ? req.postDataJSON() : null;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) {
        for (const o of body.ops) { if (o.op === 'upsert') items[o.item.id] = { ...(items[o.item.id] || {}), ...o.item }; else delete items[o.item.id]; }
        rev++;
        return { items: Object.values(items), rev, updated: new Date().toISOString(), rejected: [] };
      }
      if (p === `/api/archive/${CODE}`) return { due: w.due, archived: w.ledger.length, limit: 5 };
      if (p === `/api/archive/${CODE}/list`) return { items: w.ledger };
      if (p.startsWith(`/api/archive/${CODE}/`)) {
        const sub = p.split('/').pop();
        w.posts.push({ sub, ...body });
        if (sub === 'later' || sub === 'archive') w.due = w.due.filter((d) => d.task !== body.task);
        if (sub === 'archive') { const it = items[body.task]; delete items[body.task]; rev++; w.ledger.unshift({ task: body.task, name: it.text, added: null, archived: new Date().toISOString(), skips: 5, note: body.note }); }
        if (sub === 'restore') { const l = w.ledger.find((x) => x.task === body.task); w.ledger = w.ledger.filter((x) => x.task !== body.task); items[body.task] = { id: body.task, text: l.name, section: 'soon', done: false, doneAt: null, updatedAt: Date.now(), pos: Date.now() }; rev++; }
        return { ok: true };
      }
      if (p === `/api/waiting/${CODE}`) {
        if (body) { w.waits.push(body); w.due = w.due.filter((d) => d.task !== body.sourceItem); return { item: { id: 'waititem00000001' } }; }
        return { items: [], open: 0, due: 0, names: ['Olivia', 'Nick'] };
      }
      if (p === `/api/dread/${CODE}`) return { running: null, stopped: null };
      if (p === `/api/dread/${CODE}/start`) { w.dread.push(body); return { running: { task: body.task, name: '', startedAt: new Date().toISOString(), dread: body.dread, source: 'todo', mins: 0 } }; }
      if (p === `/api/energy/${CODE}`) return { level: null, setAt: null, until: null, source: null, pick: null };
      if (p === `/api/tidy/${CODE}`) return { text: 'x', changed: false, kind: 'task' };
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      if (p.startsWith('/api/hiscores/')) return { skills: [] };
      return null;
    },
  };
  return w;
}

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['archive-phone', { width: 390, height: 844 }, 'light'], ['archive-desk', { width: 1280, height: 900 }, 'dark']]) {
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
  await page.waitForSelector('.row[data-id="luchotask001"]');
  await page.waitForSelector('#fate:not([hidden])', { timeout: 5000 }).catch(() => {});
  const tap = (sel) => page.locator(sel).first().click();
  const last = (sub) => w.posts.filter((d) => d.sub === sub).at(-1);

  check(await page.isVisible('#fate'), name + ': the line shows on Today');
  check((await page.textContent('#fateName')) === 'Ticket for Lucho November' && (await page.textContent('#fateWhy')) === 'Passed on 5 times', name + ': names the task and the count');
  await page.screenshot({ path: file(name + '-line') });

  // Later: gone, the next one shows.
  await tap('#fateLater');
  await page.waitForTimeout(400);
  check(last('later') && last('later').task === 'luchotask001' && last('later').source === 'todo', name + ': Later told the hub');
  check((await page.textContent('#fateName')) === 'Book the boiler service', name + ': the next one shows');

  // Archive in place, with a note.
  await tap('#fateArch');
  check(await page.isVisible('#fateNoteIn') && await page.evaluate(() => document.activeElement.id === 'fateNoteIn'), name + ': Archive asks for a note, focus in it');
  check((await page.getAttribute('#fateNoteIn', 'maxlength')) === '80', name + ': the note is 80 at most');
  await page.fill('#fateNoteIn', 'Olivia booked it');
  if (phone) await page.screenshot({ path: file(name + '-note') });
  await tap('#fateArchGo');
  await page.waitForTimeout(1200);
  check(last('archive') && last('archive').task === 'boilertask01' && last('archive').note === 'Olivia booked it', name + ': archived with the note ' + JSON.stringify(last('archive')));
  check((await page.locator('.row[data-id="boilertask01"]').count()) === 0, name + ': the row is gone');
  check(await page.isHidden('#fate'), name + ': nothing left to decide');
  check((await page.textContent('#toastText')).startsWith('Archived.'), name + ': the toast says where it went');

  // Hand off: the Waiting sheet as "Hand it off".
  w.due = [{ task: 'lamptask0001', name: 'Return the lamp', section: 'today', skips: 5 }];
  for (let i = 0; i < 6; i++) { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(250); }
  await page.waitForSelector('#fate:not([hidden])');
  await tap('#fateHand');
  await page.waitForSelector('#wait:not([hidden])');
  check((await page.textContent('#waitHead')) === 'Hand it off' && (await page.textContent('#waitSave')) === 'Hand it off', name + ': the sheet says Hand it off');
  check((await page.inputValue('#waitWhat')) === 'Return the lamp', name + ': what is the task');
  if (phone) await page.screenshot({ path: file(name + '-handoff') });
  await page.fill('#waitWho', 'Olivia');
  await tap('#waitSave');
  await page.waitForTimeout(1800);
  const h = w.waits.at(-1);
  check(h && h.handoff === true && h.sourceItem === 'lamptask0001' && h.who === 'Olivia' && h.chaseDays === 7, name + ': handoff sent ' + JSON.stringify(h));
  check(w.items.lamptask0001 && w.items.lamptask0001.done === true, name + ': the task is ticked off');

  // Do it now: the dread question.
  w.due = [{ task: 'luchotask001', name: 'Ticket for Lucho November', section: 'today', skips: 6 }];
  for (let i = 0; i < 6; i++) { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(250); }
  await page.waitForSelector('#fate:not([hidden])');
  await tap('#fateDo');
  await page.waitForSelector('#pick:not([hidden]) .dread-chips');
  check((await page.textContent('#pickBody .pick-name')) === 'Ticket for Lucho November', name + ': Do it now asks the dread for it');
  await tap('#pickBody [data-dread="3"]');
  await page.waitForTimeout(500);
  check(w.dread.at(-1) && w.dread.at(-1).task === 'luchotask001' && w.dread.at(-1).dread === 3, name + ': the timer started');
  await tap('#pickBody [data-act="close"]');
  await page.waitForTimeout(500);
  check(await page.isHidden('#fate'), name + ': the line steps aside while it runs');

  // The ledger from Done, and Restore.
  if (phone) await tap('#historyBtn'); else await tap('.nav-item[data-section="done"]');
  await page.waitForSelector('#archivedBtn:not([hidden])');
  check((await page.textContent('#archivedBtn')) === 'Archived (2)', name + ': Done shows Archived (2)');
  await tap('#archivedBtn');
  await page.waitForSelector('#archivedRows li[data-task]');
  check((await page.locator('#archivedRows li[data-task]').count()) === 2, name + ': two rows in the ledger');
  check((await page.textContent('#archivedRows li[data-task="drawer000001"] .ledger-top span:nth-child(2)')) === '–', name + ': an unknown added date is a dash');
  await page.screenshot({ path: file(name + '-ledger') });
  await tap('#archivedRows li[data-task="drawer000001"] [data-act="restore"]');
  await page.waitForTimeout(900);
  check(last('restore') && last('restore').task === 'drawer000001', name + ': Restore told the hub');
  check(w.items.drawer000001 && w.items.drawer000001.section === 'soon', name + ': back in Soon');
  check((await page.locator('#archivedRows li[data-task]').count()) === 1, name + ': the ledger has one left');
  check(errors.length === 0, name + ': no page errors ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
