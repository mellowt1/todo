// Ask (Desk folded into To-do), against a mocked Worker: a message or question typed in the add box
// leaves the list and opens Claude's answer in a sheet; a draft copies; a suggested task adds; "Keep
// it as a task" puts the line back and tells the lessons loop. A plain task is only tidied.
//   PORT=8091 npm run serve, then: APP_URL=http://localhost:8091/ npm run ask-check  (--webkit too)
import { chromium, webkit } from 'playwright';

const APP = process.env.APP_URL || 'http://localhost:8091/';
const SHOTS = process.env.SHOTS || '';
const CODE = 'abcdefgh23456789';
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.error('FAIL:', what); } else console.log('ok:', what); };
const engine = process.argv.includes('--webkit') ? webkit : chromium;

const browser = await engine.launch();
for (const [name, viewport] of [['ask-phone', { width: 390, height: 844 }], ['ask-desk', { width: 1280, height: 900 }]]) {
  const phone = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
  if (engine === chromium) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(APP).origin });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const items = {};
  const desk = [];
  const acts = [];
  const taught = [];
  const item = {
    id: 'deskitem000001', at: new Date().toISOString(), text: 'write to the landlord that the heater is broken again',
    answer: 'Here is a short message for your landlord.',
    actions: [
      { kind: 'draft', to: 'landlord', lang: 'nl', text: 'Hoi, de verwarming is weer kapot. Kunt u deze week iemand sturen?', state: 'ready' },
      { kind: 'todo', text: 'Check the heater warranty', section: 'soon', state: 'ready' },
    ],
  };
  await page.route('**/api/**', async (r) => {
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    const q = r.request();
    if (q.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
    const p = new URL(q.url()).pathname;
    if (p === `/api/tidy/${CODE}`) {
      const typed = q.postDataJSON().text;
      await new Promise((res) => setTimeout(res, 200));
      if (/landlord|what do/i.test(typed)) return r.fulfill({ json: { text: typed, changed: false, kind: /landlord/.test(typed) ? 'write' : 'ask' }, headers: h });
      return r.fulfill({ json: { text: 'Buy cat food', changed: typed !== 'Buy cat food', kind: 'task' }, headers: h });
    }
    if (p === `/api/desk/${CODE}`) {
      const text = q.postDataJSON().text;
      desk.push(text);
      await new Promise((res) => setTimeout(res, 400));
      if (/what do/i.test(text)) return r.fulfill({ json: { item: { id: 'deskitem000002', at: item.at, text, answer: 'Archery at 19:00.', actions: [] } }, headers: h });
      return r.fulfill({ json: { item }, headers: h });
    }
    if (p === `/api/desk/${CODE}/act`) {
      const b = q.postDataJSON();
      acts.push(b.action);
      const a = item.actions[b.idx];
      if (b.action === 'approve') {
        a.state = 'approved';
        a.taskId = 'tk1dk';
        items.tk1dk = { id: 'tk1dk', text: a.text, section: 'soon', done: false, doneAt: null, pos: Date.now(), updatedAt: Date.now() };
      }
      if (b.action === 'copied') a.state = 'copied';
      return r.fulfill({ json: { item: JSON.parse(JSON.stringify(item)) }, headers: h });
    }
    if (p === `/api/lessons/${CODE}/feedback`) { taught.push(q.postDataJSON()); return r.fulfill({ json: { ok: true }, headers: h }); }
    if (p === `/api/todo/${CODE}/ops`) for (const o of q.postDataJSON().ops) { if (o.op === 'delete') delete items[o.item.id]; else items[o.item.id] = o.item; }
    if (p.startsWith(`/api/todo/${CODE}`)) return r.fulfill({ json: { items: Object.values(items), rev: 1, updated: new Date().toISOString(), rejected: [] }, headers: h });
    if (p === `/api/intake/${CODE}/cards`) return r.fulfill({ json: { tasks: [] }, headers: h });
    if (p === `/api/intake/${CODE}`) return r.fulfill({ json: { items: [] }, headers: h });
    return r.fulfill({ status: 404, json: {}, headers: h });
  });
  await page.goto(APP + '?c=' + CODE + '&api=' + encodeURIComponent('http://localhost:8799'));
  await page.waitForTimeout(800);
  const open = async () => { if (phone) await page.click('#fab'); else await page.click('#addDesk'); };
  const input = phone ? '#capInput' : '#inlineInput';
  const close = async () => { if (phone) await page.click('#capDone'); else await page.keyboard.press('Escape'); };
  const rowNamed = (t) => page.waitForFunction((t) => [...document.querySelectorAll('.row .tname')].some((e) => e.textContent === t), t, { timeout: 4000 });

  // 1. A message request: the answer waits while the add box is open, then opens.
  await open();
  await page.fill(input, 'write to the landlord that the heater is broken again');
  await page.press(input, 'Enter');
  await page.waitForTimeout(1200);
  check(desk.length === 1, name + ': the line went to Desk once');
  if (phone) {
    check(await page.locator('#ask').isHidden(), name + ': the answer waits while the add sheet is open');
    await close();
  }
  await page.waitForSelector('#ask:not([hidden])', { timeout: 3000 });
  check(true, name + (phone ? ': the Claude sheet opens after the add sheet closes' : ': the Claude sheet opens (the inline add is no sheet)'));
  await page.waitForTimeout(400);
  check(!(await page.locator('.row .tname', { hasText: 'landlord' }).count()), name + ': the line is not in the list');
  check((await page.textContent('#askBody .ask-draft p')).startsWith('Hoi, de verwarming'), name + ': the draft shows');
  check((await page.textContent('#askBody .ask-draft .meta')) === 'To landlord · Dutch', name + ': who and which language');
  if (SHOTS) await page.screenshot({ path: SHOTS + '/' + name + '-sheet.png' });
  await page.click('#askBody [data-act="copy"]');
  await page.waitForTimeout(400);
  if (engine === chromium) {
    check(acts.includes('copied'), name + ': Copy tells Desk it was copied');
    check((await page.evaluate(() => navigator.clipboard.readText())).startsWith('Hoi, de verwarming'), name + ': the draft is on the clipboard');
  }
  await page.click('#askBody [data-act="add"]');
  await page.waitForFunction(() => [...document.querySelectorAll('#askBody .card-copy')].some((b) => b.textContent === 'Added'), null, { timeout: 3000 });
  check(acts.includes('approve'), name + ': Add approves the suggested task');
  await page.click('#askClose');
  await page.waitForSelector('#ask', { state: 'hidden', timeout: 3000 });

  // 2. A question, then Keep it as a task.
  await open();
  await page.fill(input, 'what do i have on thursday');
  await page.press(input, 'Enter');
  await close();
  await page.waitForSelector('#ask:not([hidden])', { timeout: 4000 });
  check((await page.textContent('#askBody .ask-answer')) === 'Archery at 19:00.', name + ': the answer shows');
  await page.click('#askBody [data-act="keep"]');
  await rowNamed('what do i have on thursday');
  check(true, name + ': Keep it as a task puts the line back as typed');
  await page.waitForTimeout(400);
  check(taught.some((t) => t.app === 'tidy' && t.kind === 'undone' && t.before === 'ask: what do i have on thursday' && t.after === 'task'), name + ': Keep tells the lessons loop');
  check(desk.length === 2, name + ': the kept task is not sent to Claude again');

  // 3. A plain task stays a task.
  await open();
  await page.fill(input, 'buy cat fod');
  await page.press(input, 'Enter');
  await close();
  await rowNamed('Buy cat food');
  check(desk.length === 2 && await page.locator('#ask').isHidden(), name + ': a task is tidied, never sent to Claude');
  if (SHOTS) await page.screenshot({ path: SHOTS + '/' + name + '-list.png' });
  check(!errors.length, name + ': no page errors ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
