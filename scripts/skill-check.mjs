// The skill a task trains (2026-11-04), against a mocked Worker: Tidy's skill shows as the row's
// icon and is stored; the edit sheet's icon opens a grid, a pick changes the skill and tells the
// hub's lessons; ticking pays Woodcutting plus the skill. Every value is made up.
//   PORT=8097 npm run serve, then: APP_URL=http://localhost:8097/ npm run skill-check
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8091/';
const CODE = 'abcdefgh23456789';
const SHOTS = new URL('../screenshots/', import.meta.url);
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.error('FAIL:', what); } else console.log('ok:', what); };

const TIDY = {
  'call capital one': { text: 'Call Capital One', changed: true, kind: 'task', place: null, appt: false, skill: 'thieving' },
  'buy milk': { text: 'Buy milk', changed: true, kind: 'task', place: null, appt: false, skill: null },
};

const browser = await chromium.launch();
for (const [name, viewport] of [['skill-phone', { width: 390, height: 844 }], ['skill-desk', { width: 1280, height: 900 }]]) {
  const phone = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const items = {};
  const taught = [];
  await page.route('**/api/**', async (r) => {
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    const q = r.request();
    if (q.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
    const p = new URL(q.url()).pathname;
    if (p === `/api/tidy/${CODE}`) {
      await new Promise((res) => setTimeout(res, 200));
      const typed = q.postDataJSON().text;
      return r.fulfill({ json: TIDY[typed] || { text: typed, changed: false, kind: 'task', place: null, appt: false, skill: null }, headers: h });
    }
    if (p === `/api/lessons/${CODE}/feedback`) { taught.push(q.postDataJSON()); return r.fulfill({ json: { ok: true }, headers: h }); }
    if (p === `/api/todo/${CODE}/ops`) for (const o of q.postDataJSON().ops) items[o.item.id] = Object.assign({}, items[o.item.id], o.item);
    if (p.startsWith(`/api/todo/${CODE}`)) return r.fulfill({ json: { items: Object.values(items), rev: Date.now(), updated: new Date().toISOString(), rejected: [] }, headers: h });
    return r.fulfill({ status: 404, json: {}, headers: h });
  });
  await page.goto(APP + '?c=' + CODE + '&api=' + encodeURIComponent('http://localhost:8799'));
  await page.waitForTimeout(800);
  if (phone) await page.click('#fab'); else await page.keyboard.press('n');
  await page.waitForTimeout(400);
  const box = phone ? '#capInput' : '#inlineInput';
  for (const l of ['call capital one', 'buy milk']) { await page.fill(box, l); await page.keyboard.press('Enter'); await page.waitForTimeout(150); }
  await page.waitForTimeout(900);
  if (phone) await page.click('#capDone'); else await page.keyboard.press('Escape');
  await page.waitForTimeout(1600);
  const cap = Object.values(items).find((i) => i.text === 'Call Capital One');
  check(cap && cap.skill === 'thieving', name + ': Tidy\'s skill is stored');
  const icon = await page.locator('.row', { hasText: 'Call Capital One' }).locator('.tskill img').getAttribute('src');
  check(icon === 'icons/skills/thieving.png', name + ': the row shows Thieving ' + icon);
  const title = await page.locator('.row', { hasText: 'Call Capital One' }).locator('.tskill').getAttribute('title');
  check(title === 'Thieving 300 XP, Woodcutting 100 XP', name + ': it pays Thieving and Woodcutting ' + title);
  const milk = await page.locator('.row', { hasText: 'Buy milk' }).locator('.tskill img').getAttribute('src');
  check(milk === 'icons/skills/woodcutting.png', name + ': an ordinary task stays Woodcutting');

  // The edit sheet: the icon beside Task, the grid, a pick.
  await page.locator('.row', { hasText: 'Call Capital One' }).locator('.text').click();
  await page.waitForSelector('#edit:not([hidden])');
  check((await page.getAttribute('#editSkill img', 'src')) === 'icons/skills/thieving.png', name + ': the sheet shows the skill');
  check(await page.isHidden('#skillGrid'), name + ': the grid starts folded');
  await page.click('#editSkill');
  await page.waitForTimeout(400);
  check(await page.isVisible('#skillGrid'), name + ': a tap opens the grid');
  check((await page.$$eval('#skillGrid button', (b) => b.length)) === 14, name + ': Woodcutting and the 13 skills');
  check((await page.getAttribute('#skillGrid [data-skill="thieving"]', 'aria-checked')) === 'true', name + ': the current one is picked');
  await page.screenshot({ path: fileURLToPath(new URL(name + '-grid.png', SHOTS)) });
  await page.click('#skillGrid [data-skill="defence"]');
  await page.waitForTimeout(300);
  check(await page.isHidden('#skillGrid'), name + ': a pick folds it away');
  await page.click('#editClose');
  await page.waitForTimeout(1600);
  check(items[cap.id].skill === 'defence', name + ': the pick is stored');
  const mv = taught.find((t) => t.kind === 'moved');
  check(mv && mv.before === 'Call Capital One [today, skill thieving]' && mv.after === 'Call Capital One [today, skill defence]' && mv.note === 'call capital one', name + ': and the hub learns from it ' + JSON.stringify(mv));
  // Woodcutting in the grid takes the skill off.
  await page.locator('.row', { hasText: 'Call Capital One' }).locator('.text').click();
  await page.waitForSelector('#edit:not([hidden])');
  await page.click('#editSkill');
  await page.waitForTimeout(300);
  await page.click('#skillGrid [data-skill="woodcutting"]');
  await page.click('#editClose');
  await page.waitForTimeout(1600);
  check(items[cap.id].skill === null, name + ': Woodcutting takes the skill off');
  check(errors.length === 0, name + ': no page errors ' + errors.join('; '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
console.log('all skill checks pass');
