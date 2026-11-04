// Where Tidy puts a new task (2026-11-04), against a mocked Worker: typed on Today it goes where
// Tidy says (Soon for a later date, a lane, Today with "No date yet" for an undated appointment, on
// top); typed on another tab it stays; Undo puts back text, place and flag; a move of a placed task
// tells the hub (lessons "moved", with the typed line), also after a reload. Every value is made up.
//   PORT=8097 npm run serve, then: APP_URL=http://localhost:8097/ npm run place-check
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8091/';
const CODE = 'abcdefgh23456789';
const SHOTS = new URL('../screenshots/', import.meta.url);
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.error('FAIL:', what); } else console.log('ok:', what); };
const later = new Date(Date.now() + 5 * 864e5);
const LATER = later.getFullYear() + '-' + String(later.getMonth() + 1).padStart(2, '0') + '-' + String(later.getDate()).padStart(2, '0');

// What the mocked Tidy answers, by the line as typed.
const TIDY = {
  'peronik 12:45': { text: 'Peronik · ' + LATER + ' 12:45', changed: true, kind: 'task', place: 'soon', appt: true },
  'psychologist visit': { text: 'Psychologist visit', changed: true, kind: 'task', place: 'today', appt: true },
  'order bed frame for grandpa': { text: 'Grandpa: Order bed frame', changed: true, kind: 'task', place: 'others', appt: false },
  'Day misses the airpods mic': { text: 'Day misses the AirPods mic', changed: true, kind: 'task', place: 'build', appt: false },
  'Tell Nick to split payments': { text: 'Tell Nick to split payments', changed: false, kind: 'task', place: null, appt: false },
  'buy stamps someday': { text: 'Buy stamps', changed: true, kind: 'task', place: 'someday', appt: false },
};

const browser = await chromium.launch();
for (const [name, viewport] of [['place-phone', { width: 390, height: 844 }], ['place-desk', { width: 1280, height: 900 }]]) {
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
      await new Promise((res) => setTimeout(res, 250));
      const typed = q.postDataJSON().text;
      return r.fulfill({ json: TIDY[typed] || { text: typed, changed: false, kind: 'task', place: null, appt: false }, headers: h });
    }
    if (p === `/api/lessons/${CODE}/feedback`) { taught.push(q.postDataJSON()); return r.fulfill({ json: { ok: true }, headers: h }); }
    if (p === `/api/todo/${CODE}/ops`) for (const o of q.postDataJSON().ops) items[o.item.id] = Object.assign({}, items[o.item.id], o.item);
    if (p.startsWith(`/api/todo/${CODE}`)) return r.fulfill({ json: { items: Object.values(items), rev: Date.now(), updated: new Date().toISOString(), rejected: [] }, headers: h });
    return r.fulfill({ status: 404, json: {}, headers: h });
  });
  const open = async () => {
    await page.goto(APP + '?c=' + CODE + '&noforce&api=' + encodeURIComponent('http://localhost:8799')); // many tasks without a level
    await page.waitForTimeout(800);
  };
  const add = async (lines) => {
    if (phone) await page.click('#fab'); else await page.keyboard.press('n');
    await page.waitForTimeout(400);
    const box = phone ? '#capInput' : '#inlineInput';
    for (const l of lines) { await page.fill(box, l); await page.keyboard.press('Enter'); await page.waitForTimeout(150); }
    await page.waitForTimeout(900); // Tidy answers while the sheet is open
    if (phone) await page.click('#capDone'); else await page.keyboard.press('Escape');
    await page.waitForTimeout(1600);
  };
  const byText = (t) => Object.values(items).find((i) => i.text === t);
  const tab = async (s) => { await page.locator(`[data-section="${s}"]:visible`).first().click(); await page.waitForTimeout(500); };
  const sync = () => page.waitForTimeout(1600);
  await open();

  // 1. Typed on Today: each goes where Tidy says.
  await add(['Tell Nick to split payments', 'psychologist visit', 'peronik 12:45', 'order bed frame for grandpa', 'Day misses the airpods mic']);
  const peronik = byText('Peronik · ' + LATER + ' 12:45');
  check(peronik && peronik.section === 'soon' && peronik.appt === true, name + ': a later timed appointment goes to Soon ' + JSON.stringify(peronik));
  const psych = byText('Psychologist visit');
  check(psych && psych.section === 'today' && psych.appt === true, name + ': an undated appointment stays in Today, flagged');
  check(byText('Grandpa: Order bed frame')?.section === 'others', name + ': for Grandpa goes to Others');
  check(byText('Day misses the AirPods mic')?.section === 'build', name + ': an app bug goes to Build');
  const nick = byText('Tell Nick to split payments');
  check(nick && nick.section === 'today' && !nick.appt, name + ': his own task that names Nick stays in Today');
  await tab('today');
  const first = await page.$$eval('[data-section-list="today"] .row .tname, .list .row .tname', (e) => e.map((x) => x.textContent));
  check(first[0] === 'Psychologist visit', name + ': the undated appointment is on top of Today ' + first.join(' | '));
  const label = await page.locator('.row', { hasText: 'Psychologist visit' }).locator('.tdue.nodate').textContent().catch(() => null);
  check(label === 'No date yet', name + ': it says No date yet where the date would be');
  await page.screenshot({ path: fileURLToPath(new URL(name + '-today.png', SHOTS)) });

  // 2. Undo puts back the text, the place and the flag, and tells the hub.
  await add(['buy stamps someday']);
  check(byText('Buy stamps')?.section === 'someday', name + ': "someday" goes to Someday');
  check((await page.textContent('#toastText')) === 'Tidied · in Someday.', name + ': the toast says where it went');
  await page.click('#toast button');
  await sync();
  const back = byText('buy stamps someday');
  check(back && back.section === 'today', name + ': Undo brings it back to Today as typed');
  const u = taught.find((t) => t.kind === 'undone');
  check(u && u.before === 'Buy stamps [someday]' && u.after === 'buy stamps someday [today]' && u.note === 'buy stamps someday', name + ': Undo tells the hub with places ' + JSON.stringify(u));

  // 3. Typed on Soon: it stays in Soon.
  await tab('soon');
  TIDY['order frame for grandpa'] = { text: 'Grandpa: Order frame', changed: true, kind: 'task', place: 'others', appt: false };
  await add(['order frame for grandpa']);
  check(byText('Grandpa: Order frame')?.section === 'soon', name + ': typed on Soon it stays in Soon');

  // 4. After a reload, moving a placed task back still teaches; an undated appointment moved out of Today loses its flag.
  await open();
  await tab('today');
  const g = byText('Grandpa: Order bed frame');
  await tab(phone ? 'lanes' : 'others');
  await page.click(`.row[data-id="${g.id}"] .text`, { button: 'right' });
  await page.waitForSelector('.menu:not([hidden]) [data-move="soon"]');
  await page.click('.menu [data-move="soon"]');
  await sync();
  const mv = taught.find((t) => t.kind === 'moved');
  check(mv && mv.before === 'Grandpa: Order bed frame [others]' && mv.after === 'Grandpa: Order bed frame [soon]' && mv.note === 'order bed frame for grandpa', name + ': a move after a reload tells the hub ' + JSON.stringify(mv));
  await tab('today');
  await page.click(`.row[data-id="${psych.id}"] .text`);
  await page.waitForSelector('#edit:not([hidden])');
  await page.click('#editSeg [data-section="someday"]');
  await page.click('#editClose');
  await sync();
  check(items[psych.id].section === 'someday' && items[psych.id].appt === null, name + ': moved to Someday it is no appointment any more');
  const off = taught.filter((t) => t.kind === 'moved').at(-1);
  check(off && off.before === 'Psychologist visit [today, appointment]' && off.after === 'Psychologist visit [someday]', name + ': and the hub hears it ' + JSON.stringify(off));
  check(errors.length === 0, name + ': no page errors ' + errors.join('; '));
  await ctx.close();
}
await browser.close();
if (failed) process.exit(1);
console.log('all place checks pass');
