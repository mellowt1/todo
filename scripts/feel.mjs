// Release 1 checks: per-row locks (M1) and the swipe, toast, sheet and keyboard fixes (B1 B2 B3 B8 B9).
// Every check runs twice, with reduced motion off and on, in Chromium or WebKit.
//   npm run feel           Chromium
//   npm run feel:webkit    WebKit
// APP_URL and API_URL point it at other servers, ONLY=<regex> runs the matching checks. Resets the dev list first and empties it at the end.
// Uses the dev values in worker/.dev.vars. Never the real code.
import { chromium, webkit } from 'playwright';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { touch } from './touch.mjs';

const vars = Object.fromEntries(readFileSync(new URL('../worker/.dev.vars', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ENGINE = process.env.ENGINE || (process.argv.includes('--webkit') ? 'webkit' : 'chromium');
if (!['chromium', 'webkit'].includes(ENGINE)) throw new Error('ENGINE must be chromium or webkit');
const API = (process.env.API_URL || 'http://localhost:8787').replace(/\/+$/, '');
const APP = process.env.APP_URL || 'http://localhost:8080/';
const CODE = vars.TODO_CODE;
const OPEN = APP + '?c=' + CODE + '&api=' + encodeURIComponent(API);
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- API helpers ---------- */
const getList = async () => (await (await fetch(`${API}/api/todo/${CODE}`)).json()).items;
async function postOps(ops) {
  const r = await fetch(`${API}/api/todo/${CODE}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops }) });
  return r.json();
}
async function resetServer() {
  const items = await getList();
  if (items.length) await postOps(items.map((i) => ({ op: 'delete', item: { id: i.id, updatedAt: Date.now() + 1000 } })));
}
let n = 0;
const nid = () => 'feel' + String(++n).padStart(4, '0') + Math.random().toString(36).slice(2, 10);
// Seeds tasks top to bottom in the order given and returns their ids.
async function seed(tasks) {
  const base = Date.now() - 60000;
  const ops = tasks.map(([text, section = 'today', over = {}], i) =>
    ({ op: 'upsert', item: { id: nid(), text, section, done: false, doneAt: null, updatedAt: base - i * 1000, pos: base - i * 1000, ...over } }));
  await postOps(ops);
  return ops.map((o) => o.item.id);
}
// A change from the other device, so the next poll has something to render.
const otherDevice = (text = 'Changed on the other device') => seed([[text, 'someday']]);
async function until(fn, ms = 6000, msg = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + msg);
    await wait(100);
  }
}
const serverHas = (pred, msg) => until(async () => (await getList()).find(pred), 8000, msg);

/* ---------- In the page ---------- */
// Taps as the app sees them (pointerdown, pointerup, click in one go), a sampler, and a
// fake iPhone keyboard: visualViewport is swapped for one whose height the test sets.
function kit() {
  // No first-use nudge: it would move the first row under the checks.
  try { if (!localStorage.getItem('todo.ui')) localStorage.setItem('todo.ui', JSON.stringify({ section: 'today', nudged: true, installOff: false })); } catch (e) { /* about:blank */ }
  const tapEl = (el, x, y) => {
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', o));
  };
  window.__row = (id) => document.querySelector('#list .row[data-id="' + id + '"]');
  window.__tap = (id, part = '.circle') => {
    const r = __row(id);
    if (!r) return false;
    const el = r.querySelector(part);
    const b = el.getBoundingClientRect();
    tapEl(el, b.x + b.width / 2, b.y + b.height / 2);
    return true;
  };
  // The task text of the focused row, or the tag of whatever has focus instead.
  window.__focusText = () => { const r = document.activeElement.closest && document.activeElement.closest('.row'); return r ? r.querySelector('.text').textContent : document.activeElement.tagName; };
  window.__tapAt = (x, y) => { const el = document.elementFromPoint(x, y); if (el) tapEl(el, x, y); };
  window.__tapSel = (sel) => { const el = document.querySelector(sel); const b = el.getBoundingClientRect(); tapEl(el, b.x + b.width / 2, b.y + b.height / 2); };
  window.__poll = () => window.dispatchEvent(new Event('online')); // the app flushes and polls at once
  window.__queue = () => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('todo.v1.')))).queue;
  window.__rev = () => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('todo.v1.')))).rev;
  // Calls fn every 25ms until stopped; fn returns a problem string or nothing.
  window.__sample = (fn) => {
    const t0 = performance.now();
    const bad = [];
    const iv = setInterval(() => { const p = fn(); if (p) bad.push(Math.round(performance.now() - t0) + 'ms ' + p); }, 25);
    return () => { clearInterval(iv); return bad; };
  };
  const vv = new EventTarget();
  let kb = 0;
  const props = { width: () => innerWidth, height: () => innerHeight - kb, offsetLeft: () => 0, offsetTop: () => 0, pageLeft: () => scrollX, pageTop: () => scrollY, scale: () => 1 };
  for (const [k, get] of Object.entries(props)) Object.defineProperty(vv, k, { get });
  Object.defineProperty(window, 'visualViewport', { get: () => vv, configurable: true });
  window.__kb = (px) => { kb = px; vv.dispatchEvent(new Event('resize')); };
  // The page pans under the keyboard: iOS sends scroll, not resize.
  window.__kbScroll = (px) => { kb = px; vv.dispatchEvent(new Event('scroll')); };
  // Watches a row's style and its circle's class. Stop returns the row height after each
  // style write, in order, and how many times the circle's class was written.
  window.__watch = (row) => {
    const circle = row.querySelector('.circle');
    const log = [];
    const mo = new MutationObserver((ms) => { log.push(...ms); });
    mo.observe(row, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    mo.observe(circle, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    return () => {
      log.push(...mo.takeRecords());
      mo.disconnect();
      // A record holds the value before its write, so the value after is the next one's old value.
      const styles = log.filter((m) => m.target === row);
      const after = styles.map((m, i) => (i + 1 < styles.length ? styles[i + 1].oldValue : row.getAttribute('style')) || '');
      const heights = after.map((s) => (s.match(/(?:^|;)s*height:s*([^;]+)/) || [])[1] || '').map((h) => h.trim());
      return { heights, checks: log.filter((m) => m.target === circle).length };
    };
  };
}

/* ---------- Runner ---------- */
const browser = await (ENGINE === 'webkit' ? webkit : chromium).launch();
const results = [];
async function test(name, motion, fn) {
  if (ONLY && !ONLY.test(name)) return;
  const label = name + ' [' + motion + ']';
  const contexts = [];
  const errors = [];
  const open = async ({ desktop = false, size = { width: 390, height: 844 } } = {}) => {
    const ctx = await browser.newContext(desktop
      ? { viewport: { width: 1440, height: 900 }, reducedMotion: motion }
      : { viewport: size, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: motion });
    contexts.push(ctx);
    await ctx.addInitScript(kit);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(OPEN);
    await page.waitForSelector('#list .row:not(.skeleton)');
    await page.waitForTimeout(300);
    return page;
  };
  try {
    await resetServer();
    await fn(open, motion);
    assert.deepEqual(errors, [], 'page error');
    results.push(['ok', label]);
    console.log('ok  ', label);
  } catch (e) {
    results.push(['FAIL', label, e.message.split('\n')[0]]);
    console.log('FAIL', label, '\n     ', e.message.split('\n')[0]);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
}
const inList = (page, id) => page.evaluate((id) => !!__row(id), id);
const gone = (page, ids, ms = 3000) => until(async () => !(await page.evaluate((ids) => ids.some((id) => __row(id)), ids)), ms, 'rows to leave');
const box = (page, sel) => page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cx: r.left + r.width / 2, h: r.height }; }, sel);
// The y part of the computed 'translate' ('none', '0px -300px', ...).
const translateY = (page, sel) => page.evaluate((sel) => { const t = getComputedStyle(document.querySelector(sel)).translate; return t === 'none' ? 0 : parseFloat(t.split(' ')[1] || '0'); }, sel);

for (const motion of ['no-preference', 'reduce']) {
  console.log(`\n${ENGINE}, reduced motion: ${motion}`);

  /* ================= M1: per-row locks ================= */
  await test('M1 three ticks: no row loses its check, a poll in the middle', motion, async (open) => {
    const ids = await seed([['Tick one'], ['Tick two'], ['Tick three'], ['Stays open one'], ['Stays open two']]);
    const page = await open();
    await otherDevice();
    const bad = await page.evaluate(async ([a, b, c]) => {
      const tapped = new Set();
      const stop = __sample(() => {
        for (const id of tapped) { const r = __row(id); if (r && !r.querySelector('.circle.checked')) return id + ' lost .checked'; }
      });
      const at = (ms, f) => new Promise((r) => setTimeout(() => { f(); r(); }, ms));
      await Promise.all([
        at(0, () => { __tap(a); tapped.add(a); }),
        at(150, () => { __tap(b); tapped.add(b); }),
        at(200, __poll),
        at(300, () => { __tap(c); tapped.add(c); }),
        at(450, __poll),
      ]);
      await new Promise((r) => setTimeout(r, 1200));
      return stop();
    }, ids.slice(0, 3));
    assert.deepEqual(bad, [], 'a ticked row showed unchecked');
    await gone(page, ids.slice(0, 3));
    assert.ok(await inList(page, ids[3]) && await inList(page, ids[4]), 'untouched rows still listed');
    for (const id of ids.slice(0, 3)) await serverHas((i) => i.id === id && i.done, 'done on server');
  });

  await test('M1 write at tap: the done op and the toast come at the tap', motion, async (open) => {
    const [id] = await seed([['Write me at once'], ['Neighbour']]);
    const page = await open();
    const r = await page.evaluate(async (id) => {
      const t0 = performance.now();
      __tap(id);
      for (;;) {
        const queued = __queue().some((o) => o.op === 'upsert' && o.item.id === id && o.item.done);
        const toast = !document.getElementById('toast').hidden && document.getElementById('toastText').textContent;
        if (queued && toast) return { ms: performance.now() - t0, toast };
        if (performance.now() - t0 > 60) return { ms: -1, queued, toast };
        await new Promise((r) => setTimeout(r, 5));
      }
    }, id);
    assert.ok(r.ms >= 0, 'nothing written within 60ms (queued ' + r.queued + ', toast ' + JSON.stringify(r.toast) + ')');
    assert.equal(r.toast, 'Done.');
    await serverHas((i) => i.id === id && i.done, 'done on server');
  });

  await test('M1 double tap: one op, one toast, one check, one collapse, the neighbour untouched', motion, async (open, motion) => {
    const ids = await seed([['Tap me twice'], ['The neighbour below'], ['Third row']]);
    const page = await open();
    await page.evaluate(() => {
      window.__sent = [];
      const f = window.fetch;
      window.fetch = (u, o) => { if (o && o.method === 'POST') { try { __sent.push(...JSON.parse(o.body).ops); } catch (e) { /* not ops */ } } return f(u, o); };
      window.__toasts = 0;
      new MutationObserver((ms) => { __toasts += ms.length; }).observe(document.getElementById('toastText'), { childList: true });
    });
    const c = await page.evaluate((id) => { window.__stopWatch = __watch(__row(id)); const b = __row(id).querySelector('.circle').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }, ids[0]);
    // The second tap lands in the hold and the third in the collapse; the row takes neither.
    await page.evaluate(async ([x, y]) => {
      __tapAt(x, y);
      await new Promise((r) => setTimeout(r, 80));
      __tapAt(x, y);
      await new Promise((r) => setTimeout(r, 150));
      __tapAt(x, y);
      await new Promise((r) => setTimeout(r, 300));
    }, c);
    const w = await page.evaluate(() => __stopWatch());
    assert.equal(w.checks, 1, 'the circle got .checked written ' + w.checks + ' times');
    if (motion === 'no-preference') {
      const up = w.heights.findIndex((h, i) => i > 0 && w.heights[i - 1] === '0px' && h && h !== '0px');
      assert.equal(up, -1, 'the row height went from 0px back up (a second collapse): ' + w.heights.join(' > '));
      assert.ok(w.heights.includes('0px'), 'the row collapsed: ' + w.heights.join(' > '));
    }
    await gone(page, [ids[0]]);
    await serverHas((i) => i.id === ids[0] && i.done, 'done on server');
    await page.waitForTimeout(300);
    const s = await page.evaluate((id) => ({
      ops: __sent.concat(__queue()).filter((o) => o.item.id === id && o.item.done).length,
      toasts: __toasts,
    }), ids[0]);
    assert.equal(s.ops, 1, 'done ops sent');
    assert.equal(s.toasts, 1, 'toasts');
    const nb = await page.evaluate((id) => { const r = __row(id); return r && { checked: !!r.querySelector('.circle.checked'), style: r.getAttribute('style') || '', cls: r.className }; }, ids[1]);
    assert.ok(nb, 'neighbour still listed');
    assert.deepEqual(nb, { checked: false, style: '', cls: 'row' });
    assert.ok(!(await getList()).find((i) => i.id === ids[1]).done, 'neighbour open on server');
  });

  await test('M1 Space twice (desktop): one op, one check, focus on the next row', motion, async (open, motion) => {
    const ids = await seed([['Row A'], ['Space me twice'], ['Row C']]);
    const page = await open({ desktop: true });
    await page.evaluate((id) => {
      window.__toasts = 0;
      new MutationObserver((ms) => { __toasts += ms.length; }).observe(document.getElementById('toastText'), { childList: true });
      window.__stopWatch = __watch(__row(id));
      __row(id).focus();
    }, ids[1]);
    await page.keyboard.press(' ');
    await page.waitForTimeout(80);
    await page.keyboard.press(' ');
    await page.waitForTimeout(150);
    await page.keyboard.press(' ');
    await page.waitForTimeout(300);
    const w = await page.evaluate(() => __stopWatch());
    assert.equal(w.checks, 1, 'the circle got .checked written ' + w.checks + ' times');
    if (motion === 'no-preference') {
      const up = w.heights.findIndex((h, i) => i > 0 && w.heights[i - 1] === '0px' && h && h !== '0px');
      assert.equal(up, -1, 'the row height went from 0px back up (a second collapse): ' + w.heights.join(' > '));
    }
    await gone(page, [ids[1]]);
    await serverHas((i) => i.id === ids[1] && i.done, 'done on server');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => __toasts), 1, 'toasts');
    assert.equal(await page.evaluate(() => __focusText()), 'Row C', 'focus after the row left');
  });

  await test('M1 Space, ArrowUp, Space (desktop): focus skips the row still leaving', motion, async (open) => {
    const ids = await seed([['Row A'], ['Row B'], ['Row C'], ['Row D']]);
    const page = await open({ desktop: true });
    await page.evaluate((id) => __row(id).focus(), ids[1]);
    await page.keyboard.press(' ');
    await page.waitForTimeout(60);
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => __focusText()), 'Row A', 'ArrowUp reaches A');
    await page.keyboard.press(' ');
    await gone(page, ids.slice(0, 2));
    await page.waitForTimeout(200);
    const f = await page.evaluate(() => __focusText());
    assert.equal(f, 'Row C', 'focus after both rows left');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => __focusText()), 'Row D', 'the next arrow goes on from C');
  });

  await test('M1 long press during a poll: the menu opens next to the row', motion, async (open) => {
    const ids = await seed([['Row one'], ['Row two'], ['Row three'], ['Row four'], ['Hold this row'], ['Row six']]);
    const page = await open();
    await otherDevice();
    const rev0 = await page.evaluate(() => __rev());
    const t = await touch(page, ENGINE);
    const b = await page.locator(`.row[data-id="${ids[4]}"] .text`).boundingBox();
    await t.down(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(250);
    await page.evaluate(() => __poll());
    await page.waitForTimeout(400);
    await page.waitForSelector('#menu:not([hidden])', { timeout: 1500 });
    const m = await box(page, '#menu');
    const r = await page.evaluate((id) => { const b = __row(id).getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; }, ids[4]);
    await t.up();
    assert.ok(await page.evaluate(() => __rev()) > rev0, 'the poll landed during the hold');
    const below = m.top - r.bottom, above = r.top - m.bottom;
    assert.ok((below >= 0 && below <= 8) || (above >= 0 && above <= 8),
      `menu at top ${Math.round(m.top)}, row ${Math.round(r.top)} to ${Math.round(r.bottom)}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#menu', { state: 'hidden' });
  });

  await test('M1 tap text during the hold: the edit sheet stays shut', motion, async (open) => {
    const [id] = await seed([['Tick then tap my text'], ['Another']]);
    const page = await open();
    await page.evaluate(async (id) => { __tap(id); await new Promise((r) => setTimeout(r, 100)); __tap(id, '.text'); }, id);
    await page.waitForTimeout(700);
    assert.ok(await page.locator('#edit').isHidden(), 'edit sheet opened on a leaving task');
    await serverHas((i) => i.id === id && i.done, 'done on server');
  });

  await test('M1 empty state waits for the last row to leave', motion, async (open) => {
    const [, id] = await seed([['Keeps Today busy'], ['The only soon task', 'soon']]);
    const page = await open();
    await page.click('#switcher button[data-section="soon"]');
    await page.waitForSelector(`.row[data-id="${id}"]`);
    const bad = await page.evaluate(async (id) => {
      const stop = __sample(() => (!document.getElementById('empty').hidden && __row(id) ? 'empty state shown with the row still there' : ''));
      __tap(id);
      await new Promise((r) => setTimeout(r, 1200));
      return stop();
    }, id);
    assert.deepEqual(bad, []);
    assert.ok(!(await inList(page, id)), 'row left');
    assert.equal((await page.textContent('#empty p')).trim(), 'Nothing coming up.');
    assert.ok(await page.locator('#empty').isVisible(), 'empty state shows after the row left');
  });

  await test('M1 menu move: the row slides out, toast at the tap, server has it', motion, async (open) => {
    const ids = await seed([['First'], ['Second'], ['Move me to soon'], ['Fourth']]);
    const page = await open();
    const t = await touch(page, ENGINE);
    await t.longPress(page.locator(`.row[data-id="${ids[2]}"]`));
    await page.waitForSelector('#menu:not([hidden])');
    // A poll lands while the menu is open, so a render is waiting when the pick comes.
    await otherDevice();
    await page.evaluate(() => __poll());
    await page.waitForTimeout(400);
    const r = await page.evaluate(async (id) => {
      const t0 = performance.now();
      __tapSel('#menu button[data-move="soon"]');
      let sliding = false, toastMs = -1;
      while (performance.now() - t0 < 150) {
        const row = __row(id);
        if (row && row.classList.contains('sliding')) sliding = true;
        if (toastMs < 0 && !document.getElementById('toast').hidden) toastMs = performance.now() - t0;
        await new Promise((r) => setTimeout(r, 10));
      }
      return { sliding, toastMs, text: document.getElementById('toastText').textContent };
    }, ids[2]);
    assert.ok(r.sliding, 'the row in the list never slid');
    assert.ok(r.toastMs >= 0, 'no toast within 150ms of the pick');
    assert.equal(r.text, 'Moved to Soon.');
    await gone(page, [ids[2]]);
    await serverHas((i) => i.id === ids[2] && i.section === 'soon', 'move on server');
  });

  await test('M1 renders resume: a server change shows within the next poll', motion, async (open) => {
    const [id] = await seed([['Tick me first'], ['Another open task']]);
    const page = await open();
    await page.evaluate((id) => __tap(id), id);
    await gone(page, [id]);
    await page.waitForTimeout(1500);
    const [newId] = await seed([['Arrived from the other device']]);
    await until(() => inList(page, newId), 12000, 'the poll to show the new task');
  });

  // WebKit sends no pointerup or pointercancel once a native drag starts, so the press must end at dragstart.
  await test('M1 desktop drag onto the sidebar: the list keeps drawing', motion, async (open) => {
    const [id] = await seed([['Drag me to Soon'], ['Stays in Today']]);
    const page = await open({ desktop: true });
    await page.dragAndDrop(`.row[data-id="${id}"] .text`, '.nav-item[data-section="soon"]');
    // Playwright's WebKit on Windows fires no drop, so only Chromium can check the move itself.
    if (ENGINE === 'chromium') await until(async () => !(await inList(page, id)), 3000, 'the dropped row to leave Today');
    const [newId] = await seed([['Arrived after the drag']]);
    await page.evaluate(() => __poll());
    await until(() => inList(page, newId), 3000, 'the list to draw a server change after the drag');
  });

  /* ================= B1 to B9 ================= */
  await test('B1 a two-line task keeps its height through a swipe', motion, async (open) => {
    const [id] = await seed([['Call the insurance company about the dented bumper and ask whether the excess applies here'], ['Short one']]);
    const page = await open();
    const h = () => page.evaluate((id) => __row(id).offsetHeight, id);
    const before = await h();
    assert.ok(before > 60, 'the task wraps to two lines (' + before + 'px)');
    const t = await touch(page, ENGINE);
    await t.drag(page.locator(`.row[data-id="${id}"]`), 100, { end: false });
    await page.waitForTimeout(50);
    const during = await h();
    await t.release();
    await page.waitForTimeout(400);
    const after = await h();
    assert.deepEqual([during, after], [before, before], `offsetHeight ${before}px before, ${during}px during, ${after}px after`);
  });

  await test('B2 toast centred on the column (desktop), clear of the edge in Done, level with the FAB', motion, async (open) => {
    const ids = await seed([['Desk tick'], ['Phone tick'], ['Reopen me', 'today', { done: true, doneAt: Date.now() - 3600000 }], ['Stays']]);
    const desk = await open({ desktop: true });
    await desk.click(`.row[data-id="${ids[0]}"] .circle`);
    await desk.waitForSelector('#toast:not([hidden])');
    await desk.waitForTimeout(350);
    const tb = await box(desk, '#toast'), cb = await box(desk, '.col');
    assert.ok(Math.abs(tb.cx - cb.cx) <= 2, `desktop toast centre ${Math.round(tb.cx)}, column centre ${Math.round(cb.cx)}`);

    const phone = await open();
    await phone.evaluate((id) => __tap(id), ids[1]);
    await phone.waitForSelector('#toast:not([hidden])');
    await phone.waitForTimeout(350);
    const pt = await box(phone, '#toast'), fab = await box(phone, '#fab');
    assert.ok(Math.abs(pt.top - fab.top) <= 1, `toast top ${pt.top}, FAB top ${fab.top}`);
    await phone.click('#historyBtn');
    await phone.click(`.drow[data-id="${ids[2]}"]`);
    await phone.waitForSelector('#toast:not([hidden])');
    await phone.waitForTimeout(350);
    const dt = await box(phone, '#toast');
    const w = await phone.evaluate(() => innerWidth);
    assert.ok(Math.abs(w - dt.right - 16) <= 1, `Done toast right edge ${Math.round(w - dt.right)}px from the edge`);
  });

  await test('B3 after a snap-back the next sheet drag follows the finger', motion, async (open) => {
    await seed([['Anything']]);
    const page = await open();
    await page.click('#fab');
    await page.waitForSelector('#capture:not([hidden])');
    await page.waitForTimeout(400);
    const g = await box(page, '#capture .grabber');
    const x = g.cx, y = g.top + g.h / 2;
    const t = await touch(page, ENGINE);
    await t.down(x, y);
    for (const d of [10, 20, 30]) { await t.move(x, y + d); await page.waitForTimeout(16); }
    await t.up();
    await page.waitForTimeout(400);
    assert.ok(await page.isVisible('#capture'), 'a 30px drag snaps back');
    const top0 = (await box(page, '#capture .sheet')).top;
    await t.down(x, y);
    await t.move(x, y + 20);
    await page.waitForTimeout(50);
    await t.move(x, y + 40);
    // Pointer moves land on the next frame; two frames on, a 180ms transition would still lag.
    const s = await page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const sh = document.querySelector('#capture .sheet');
      const cs = getComputedStyle(sh);
      const props = cs.transitionProperty.split(',').map((p) => p.trim());
      const durs = cs.transitionDuration.split(',').map((d) => parseFloat(d));
      const slow = props.map((p, i) => [p, durs[i % durs.length]]).filter(([p, d]) => (p === 'transform' || p === 'all') && d > 0);
      return { dragging: sh.classList.contains('dragging'), slow, top: sh.getBoundingClientRect().top };
    });
    await t.up();
    assert.ok(s.dragging, 'sheet is .dragging');
    assert.deepEqual(s.slow, [], 'transform transition while dragging');
    assert.ok(Math.abs(s.top - top0 - 40) <= 2, `sheet moved ${Math.round(s.top - top0)}px for a 40px drag`);
  });

  await test('B8 the edit sheet Close stays on screen with the keyboard up (375x667)', motion, async (open) => {
    const [id] = await seed([['Edit me with the keyboard up']]);
    const page = await open({ size: { width: 375, height: 667 } });
    await page.click(`.row[data-id="${id}"] .text`);
    await page.waitForSelector('#edit:not([hidden])');
    await page.waitForTimeout(400);
    await page.evaluate(() => __kb(300));
    await page.waitForTimeout(500);
    const c = await box(page, '#editClose');
    const vh = await page.evaluate(() => visualViewport.offsetTop + visualViewport.height);
    assert.ok(c.top >= 0 && c.bottom <= vh, `Close from ${Math.round(c.top)} to ${Math.round(c.bottom)}, visible area 0 to ${vh}`);
  });

  await test('B9 the capture sheet rides the keyboard on translate, and a second open starts there', motion, async (open, motion) => {
    await seed([['Anything']]);
    const page = await open();
    await page.click('#fab');
    await page.waitForSelector('#capture:not([hidden])');
    await page.waitForTimeout(300);
    await page.evaluate(() => __kb(300));
    await page.waitForTimeout(500);
    const s = await page.evaluate(() => {
      const sh = document.querySelector('#capture .sheet');
      return { bottom: sh.style.bottom, rect: sh.getBoundingClientRect().bottom, ih: innerHeight };
    });
    assert.equal(s.bottom, '', 'style.bottom is not used');
    assert.ok(Math.abs(await translateY(page, '#capture .sheet') + 300) <= 1, 'computed translate lifts the sheet 300px');
    assert.ok(Math.abs(s.ih - 300 - s.rect) <= 2, `sheet bottom ${Math.round(s.rect)}, keyboard top ${s.ih - 300}`);

    // The page pans under the keyboard (scroll, not resize): the sheet follows at once, no glide.
    if (motion === 'no-preference') {
      const y = await page.evaluate(() => {
        __kbScroll(260);
        const t = getComputedStyle(document.querySelector('#capture .sheet')).translate;
        return t === 'none' ? 0 : parseFloat(t.split(' ')[1] || '0');
      });
      assert.ok(Math.abs(y + 260) <= 1, `right after a pan the sheet is at ${y}px, not -260px`);
      await page.evaluate(() => __kb(300));
      await page.waitForTimeout(400);
    }

    // Close; the keyboard drops while the sheet leaves.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    const c = await page.evaluate(() => {
      __kb(0);
      const sh = document.querySelector('#capture .sheet');
      const open = !document.getElementById('capture').hidden;
      const kb = sh.style.getPropertyValue('--kb');
      // Play the exit to its end to see where the sheet stops.
      for (const a of sh.getAnimations()) a.finish();
      return { open, kb, top: sh.getBoundingClientRect().top, ih: innerHeight };
    });
    if (motion === 'no-preference') {
      assert.ok(c.open, 'the sheet is still leaving');
      assert.equal(c.kb, '-300px', 'the closing sheet kept its offset when the keyboard dropped');
      assert.ok(c.top >= c.ih - 1, `the closing sheet stops at ${Math.round(c.top)}, the screen ends at ${c.ih}`);
    }
    await page.waitForSelector('#capture', { state: 'hidden' });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('todo.ui')).kb), 300, 'ui.kb remembers the offset');

    // Second open: the last offset is there before any resize event.
    const first = await page.evaluate(() => {
      document.getElementById('fab').click();
      const sh = document.querySelector('#capture .sheet');
      const t = getComputedStyle(sh).translate;
      // Where the entry's first frame puts the sheet.
      const a = sh.getAnimations().find((x) => x.animationName === 'sheet-in');
      let top = null;
      if (a) { a.pause(); a.currentTime = 0; top = sh.getBoundingClientRect().top; a.play(); }
      return { y: t === 'none' ? 0 : parseFloat(t.split(' ')[1] || '0'), top, ih: innerHeight };
    });
    assert.ok(Math.abs(first.y + 300) <= 1, `second open starts at ${first.y}px, not -300px`);
    if (motion === 'no-preference') assert.ok(first.top !== null && first.top >= first.ih - 1, `the entry starts at ${first.top}, not below the screen (${first.ih})`);
    await page.waitForTimeout(200);
    await page.evaluate(() => __kb(300));
    await page.waitForTimeout(800);
    assert.ok(Math.abs(await translateY(page, '#capture .sheet') + 300) <= 1, 'stays up when the keyboard comes');
    await page.keyboard.press('Escape');
    await page.evaluate(() => __kb(0));
    await page.waitForSelector('#capture', { state: 'hidden' });
    await page.waitForTimeout(400);

    // Third open with no keyboard: the sheet comes back down.
    await page.evaluate(() => document.getElementById('fab').click());
    await page.waitForTimeout(1200);
    assert.ok(Math.abs(await translateY(page, '#capture .sheet')) <= 1, 'no keyboard came, the sheet is back down');
    await page.keyboard.press('Escape');

    // Desktop never offsets.
    const [id] = await seed([['Desk edit']]);
    const desk = await open({ desktop: true });
    await desk.click(`.row[data-id="${id}"] .text`);
    await desk.waitForSelector('#edit:not([hidden])');
    await desk.evaluate(() => __kb(300));
    await desk.waitForTimeout(400);
    assert.equal(await translateY(desk, '#edit .sheet'), 0, 'desktop sheet offset');
    assert.equal(await desk.evaluate(() => document.querySelector('#edit .sheet').style.bottom), '', 'desktop style.bottom');
  });
}

await resetServer();
await browser.close();
const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${ENGINE}: ${results.length - fails.length} passed, ${fails.length} failed`);
for (const f of fails) console.log(' ', f[1], ':', f[2]);
process.exit(fails.length ? 1 : 0);
