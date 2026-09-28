// Release 1 checks: per-row locks (M1) and the swipe, toast, sheet and keyboard fixes (B1 B2 B3 B8 B9).
// Release 2a checks: motion tokens and awaited exits (M2), FLIP (M3), overlay exits (A2), the check (A3),
// the toast (A4), Undo (A6), the sidebar drop (C1), focus (X1) and modals (X2).
// Every check runs twice, with reduced motion off and on, in Chromium or WebKit.
//   npm run feel           Chromium
//   npm run feel:webkit    WebKit
// APP_URL and API_URL point it at other servers, ONLY=<regex> runs the matching checks. Resets the dev list first and empties it at the end.
// Uses the dev values in worker/.dev.vars. Never the real code.
import { chromium, webkit } from 'playwright';
import { readFileSync } from 'node:fs';
import strict from 'node:assert/strict';
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
// SOFT=1 lists every failed assertion of a check instead of stopping at the first.
const SOFT = process.env.SOFT === '1';
let softFails = [];
const assert = SOFT
  ? Object.fromEntries(['ok', 'equal', 'notEqual', 'deepEqual'].map((k) => [k, (...a) => { try { strict[k](...a); } catch (e) { softFails.push(e.message.split('\n')[0]); } }]))
  : strict;
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

  /* Release 2a helpers */
  // Calls fn on every frame until stopped and keeps what it returns, with the time.
  window.__frames = (fn) => {
    const t0 = performance.now();
    const out = [];
    let on = true;
    const tick = () => {
      if (!on) return;
      out.push(Object.assign({ t: Math.round(performance.now() - t0) }, fn()));
      requestAnimationFrame(tick);
    };
    tick();
    return () => { on = false; return out; };
  };
  // Where transforms and the translate and scale properties put an element, as computed now.
  window.__tr = (el) => {
    const cs = getComputedStyle(el);
    let x = 0, y = 0, s = 1;
    if (cs.transform && cs.transform !== 'none') {
      const m = new DOMMatrixReadOnly(cs.transform);
      x += m.m41; y += m.m42; s = Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
    }
    if (cs.translate && cs.translate !== 'none') { const p = cs.translate.split(' '); x += parseFloat(p[0]) || 0; y += parseFloat(p[1] || '0') || 0; }
    if (cs.scale && cs.scale !== 'none') s *= Math.max(...cs.scale.split(' ').map(parseFloat));
    return { x, y, s };
  };
  // What the eye sees of a row: its opacity times its inner's, and its shift.
  const rowLook = (row) => {
    const inner = row.querySelector('.row-inner');
    const a = __tr(row), b = inner ? __tr(inner) : { x: 0, y: 0 };
    const op = parseFloat(getComputedStyle(row).opacity) * (inner ? parseFloat(getComputedStyle(inner).opacity) : 1);
    return { op, x: a.x + b.x, y: a.y + b.y, anims: row.getAnimations().length + (inner ? inner.getAnimations().length : 0) };
  };
  window.__rowLook = rowLook;
  // When does a row start to collapse, and was its slide still running then? before() is
  // sampled on every frame (and every write to the row) until the collapse starts.
  window.__leaveWatch = (row, before) => {
    const t0 = performance.now();
    const inner = row.querySelector('.row-inner');
    const h0 = row.getBoundingClientRect().height;
    const slides = new Set();
    const w = { start: -1, slideRunning: false, seen: [] };
    const started = () => !row.isConnected || row.classList.contains('collapsing') || row.style.height !== '' || row.style.opacity !== ''
      || row.getAnimations().some((a) => a.playState === 'running') || row.getBoundingClientRect().height < h0 - 0.5;
    let on = true;
    const check = () => {
      if (!on || w.start >= 0) return;
      if (started()) {
        w.start = Math.round(performance.now() - t0);
        w.slideRunning = [...slides].some((a) => a.playState === 'running');
        return;
      }
      for (const a of inner.getAnimations()) slides.add(a);
      if (before) w.seen.push(Object.assign({ t: Math.round(performance.now() - t0) }, before()));
    };
    const mo = new MutationObserver(check);
    mo.observe(row, { attributes: true, attributeFilter: ['style', 'class'] });
    const tick = () => { if (!on) return; check(); requestAnimationFrame(tick); };
    tick();
    return () => { check(); on = false; mo.disconnect(); return w; };
  };
  // Follows one row's top frame by frame, the order of the rows, and the first 120ms of
  // any row that was not there at the start.
  window.__follow = (watchId) => {
    const list = document.getElementById('list');
    const t0 = performance.now();
    const before = new Set([...list.querySelectorAll('.row')].map((r) => r.dataset.id));
    const tops = [];
    const added = {};
    const look = (row) => {
      const id = row.dataset && row.dataset.id;
      if (!id || before.has(id) || !row.isConnected) return;
      const t = performance.now() - t0;
      const a = added[id] || (added[id] = { at: t, minOp: 1, minY: 0, maxShift: 0, anims: 0 });
      if (t - a.at > 120) return;
      const l = rowLook(row);
      a.minOp = Math.min(a.minOp, l.op);
      a.minY = Math.min(a.minY, l.y);
      a.maxShift = Math.max(a.maxShift, Math.abs(l.y), Math.abs(l.x));
      a.anims = Math.max(a.anims, l.anims);
    };
    const mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.matches('.row')) look(n); });
    mo.observe(list, { childList: true });
    let on = true;
    const tick = () => {
      if (!on) return;
      const r = __row(watchId);
      tops.push(r ? Math.round(r.getBoundingClientRect().top * 10) / 10 : null);
      for (const row of list.querySelectorAll('.row')) look(row);
      requestAnimationFrame(tick);
    };
    tick();
    return () => { on = false; mo.disconnect(); return { tops, added, order: [...list.querySelectorAll('.row')].map((r) => r.dataset.id) }; };
  };
  // An overlay on every frame: shown or not, its opacity, its box, and its scrim's opacity.
  window.__overlay = (wrapSel, boxSel) => __frames(() => {
    const wrap = document.querySelector(wrapSel);
    const el = document.querySelector(boxSel);
    const scrim = wrap.querySelector('.scrim');
    const b = el.getBoundingClientRect();
    const open = !wrap.hidden && getComputedStyle(wrap).display !== 'none' && b.width > 0;
    return {
      open, op: parseFloat(getComputedStyle(el).opacity) * (wrap === el ? 1 : parseFloat(getComputedStyle(wrap).opacity)),
      scrim: scrim ? parseFloat(getComputedStyle(scrim).opacity) : 1,
      l: b.left, r: b.right, top: b.top, bot: b.bottom, w: b.width,
      dx: b.left + b.width / 2 - innerWidth / 2, dy: b.top + b.height / 2 - innerHeight / 2,
    };
  });
  // Rows that are half gone: squashed, faded, or still carrying exit styles.
  window.__ghosts = () => [...document.querySelectorAll('#list .row:not(.skeleton)')]
    .filter((r) => r.offsetHeight < 30 || r.style.height || r.style.opacity || r.classList.contains('collapsing') || r.classList.contains('sliding')
      || rowLook(r).op < 0.99 || Math.abs(rowLook(r).x) > 0.5)
    .map((r) => '"' + r.querySelector('.text').textContent + '" ' + r.offsetHeight + 'px ' + r.className + ' ' + (r.getAttribute('style') || ''));
}

/* ---------- Runner ---------- */
const browser = await (ENGINE === 'webkit' ? webkit : chromium).launch();
const results = [];
// A check this engine can not make throws Skip; a part it can not make is noted with part().
class Skip extends Error {}
const skipped = [];
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
    const part = (reason) => { skipped.push([label, 'part: ' + reason]); console.log('      part skipped:', reason); };
    softFails = [];
    await fn(open, motion, part);
    assert.deepEqual(errors, [], 'page error');
    if (softFails.length) throw new Error(softFails.join(' | '));
    results.push(['ok', label]);
    console.log('ok  ', label);
  } catch (e) {
    if (e instanceof Skip) {
      skipped.push([label, e.message]);
      console.log('skip', label, '\n     ', e.message);
      return;
    }
    const why = [...(SOFT && !softFails.includes(e.message.split(' | ')[0]) ? softFails : []), e.message.split('\n')[0]].join(' | ');
    results.push(['FAIL', label, why]);
    console.log('FAIL', label, '\n     ', why);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
}
const inList = (page, id) => page.evaluate((id) => !!__row(id), id);
const gone = (page, ids, ms = 3000) => until(async () => !(await page.evaluate((ids) => ids.some((id) => __row(id)), ids)), ms, 'rows to leave');
const box = (page, sel) => page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cx: r.left + r.width / 2, h: r.height }; }, sel);
// The y part of the computed 'translate' ('none', '0px -300px', ...).
const translateY = (page, sel) => page.evaluate((sel) => { const t = getComputedStyle(document.querySelector(sel)).translate; return t === 'none' ? 0 : parseFloat(t.split(' ')[1] || '0'); }, sel);

/* ---------- Release 2a helpers ---------- */
// Runs act and follows row watchId frame by frame. mid counts the frames where its top was
// between where it started and where it ended: 0 is a snap, several is a glide.
async function follow(page, watchId, act, ms = 1000) {
  await page.evaluate((id) => { window.__stopFollow = __follow(id); }, watchId);
  await act();
  await page.waitForTimeout(ms);
  const f = await page.evaluate(() => __stopFollow());
  const ys = f.tops.filter((y) => y !== null);
  const from = ys[0], to = ys[ys.length - 1];
  const lo = Math.min(from, to) + 1, hi = Math.max(from, to) - 1;
  f.mid = ys.filter((y) => y > lo && y < hi).length;
  f.moved = Math.round(Math.abs(to - from));
  return f;
}
// Samples an overlay while act runs and for ms after.
async function overlay(page, wrapSel, boxSel, act, ms = 600) {
  await page.evaluate(([w, b]) => { window.__stopOverlay = __overlay(w, b); }, [wrapSel, boxSel]);
  await act();
  await page.waitForTimeout(ms);
  return page.evaluate(() => __stopOverlay());
}
// Frames where the overlay was still on screen but part way faded.
const fading = (fr) => fr.filter((f) => f.open && f.op > 0.02 && f.op < 0.95);
const ms = (v) => (/ms$/.test(v) ? parseFloat(v) : /s$/.test(v) ? parseFloat(v) * 1000 : NaN);

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

  /* ================= Release 2a: M2 tokens and awaited animations ================= */
  await test('M2 tokens: --dur-press, --dur-move, --dur-exit and --dist on :root, no --t: 1ms', motion, async (open, motion) => {
    await seed([['Anything']]);
    const page = await open();
    const v = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return Object.fromEntries(['--dur-press', '--dur-move', '--dur-exit', '--dist', '--t'].map((k) => [k, cs.getPropertyValue(k).trim()]));
    });
    assert.equal(v['--dist'], motion === 'reduce' ? '0' : '1', '--dist is ' + JSON.stringify(v['--dist']));
    const move = ms(v['--dur-move']);
    assert.ok(move >= 180 && move <= 240, '--dur-move is ' + JSON.stringify(v['--dur-move']));
    for (const k of ['--dur-press', '--dur-exit']) assert.ok(ms(v[k]) > 0 && ms(v[k]) <= 240, k + ' is ' + JSON.stringify(v[k]));
    assert.notEqual(v['--t'], '1ms', '--t is still 1ms');
  });

  await test('M2 a row slides all the way before it collapses (swipe commit, menu pick)', motion, async (open) => {
    const ids = await seed([['Swipe me done'], ['Pick me a section'], ['Stays one'], ['Stays two']]);
    const page = await open();
    const t = await touch(page, ENGINE);
    const w = await page.evaluate(() => innerWidth);
    await t.drag(page.locator(`.row[data-id="${ids[0]}"]`), Math.round(w * 0.45), { end: false });
    await page.evaluate((id) => { window.__lw = __leaveWatch(__row(id)); }, ids[0]);
    await t.release();
    await gone(page, [ids[0]]);
    let a = await page.evaluate(() => __lw());
    assert.ok(a.start >= 0, 'the swiped row never collapsed');
    assert.ok(!a.slideRunning, `swipe: the row started collapsing at ${a.start}ms with its slide still running`);
    await serverHas((i) => i.id === ids[0] && i.done, 'done on server');

    await t.longPress(page.locator(`.row[data-id="${ids[1]}"]`));
    await page.waitForSelector('#menu:not([hidden])');
    await page.waitForTimeout(300);
    await page.evaluate((id) => { window.__lw = __leaveWatch(__row(id)); __tapSel('#menu button[data-move="soon"]'); }, ids[1]);
    await gone(page, [ids[1]]);
    a = await page.evaluate(() => __lw());
    assert.ok(a.start >= 0, 'the picked row never collapsed');
    assert.ok(!a.slideRunning, `menu pick: the row started collapsing at ${a.start}ms with its slide still running`);
    await serverHas((i) => i.id === ids[1] && i.section === 'soon', 'move on server');
  });

  await test('M2 motion follows a reduced-motion change at runtime', motion, async (open, motion) => {
    const ids = await seed([['Top row'], ['Second row']]);
    const page = await open();
    const now = motion === 'reduce' ? 'no-preference' : 'reduce';
    await page.emulateMedia({ reducedMotion: now });
    await page.waitForTimeout(150);
    let newId;
    const f = await follow(page, ids[0], async () => { [newId] = await seed([['Arrived after the switch']]); await page.evaluate(() => __poll()); }, 1200);
    assert.ok(f.added[newId], 'the new task showed');
    assert.ok(f.moved > 20, 'the top row moved down ' + f.moved + 'px');
    if (now === 'reduce') {
      assert.equal(f.mid, 0, 'rows still glide after reduced motion came on: ' + f.tops.join(' '));
      assert.ok(f.added[newId].maxShift <= 0.5, 'the new row still slides after reduced motion came on');
    } else {
      assert.ok(f.mid >= 2, 'rows still snap after reduced motion went off: ' + f.tops.join(' '));
    }
  });

  /* ================= M3: FLIP around renderList ================= */
  await test('M3 a task from the other device: the rows below glide down, the new row fades in', motion, async (open, motion) => {
    const ids = await seed([['Was first'], ['Was second'], ['Was third']]);
    const page = await open();
    let newId;
    const f = await follow(page, ids[0], async () => { [newId] = await seed([['Arrived from the other device']]); await page.evaluate(() => __poll()); }, 1200);
    const n = f.added[newId];
    assert.ok(n, 'the new task showed');
    assert.equal(f.order[0], newId, 'the new task is on top');
    assert.ok(f.moved > 20, 'the old first row moved down ' + f.moved + 'px');
    assert.ok(n.minOp < 0.95, 'the new row appeared at full opacity, no fade');
    if (motion === 'reduce') {
      assert.equal(f.mid, 0, 'rows glide with reduced motion: ' + f.tops.join(' '));
      assert.ok(n.maxShift <= 0.5, 'the new row slides with reduced motion (' + n.maxShift + 'px)');
    } else {
      assert.ok(f.mid >= 2, 'the rows below jumped in one frame: ' + f.tops.join(' '));
      assert.ok(n.minY <= -1, 'the new row did not come down from above (' + n.minY + 'px)');
    }
  });

  await test('M3 a poll that changes nothing on screen leaves the list alone (list and Done)', motion, async (open) => {
    await seed([['Open one'], ['Open two'], ['Done one', 'today', { done: true, doneAt: Date.now() - 60000 }]]);
    const page = await open();
    for (const where of ['Today', 'Done']) {
      if (where === 'Done') { await page.click('#historyBtn'); await page.waitForSelector('.drow'); await page.waitForTimeout(300); }
      await page.evaluate(() => {
        window.__muts = [];
        window.__mo = new MutationObserver((ms) => { __muts.push(...ms.map((m) => m.type)); });
        __mo.observe(document.getElementById('list'), { childList: true, subtree: true });
      });
      const rev0 = await page.evaluate(() => __rev());
      await otherDevice('Someday, on the other device ' + where);
      await page.evaluate(() => __poll());
      await until(async () => (await page.evaluate(() => __rev())) > rev0, 4000, 'the poll to land');
      await page.waitForTimeout(400);
      const muts = await page.evaluate(() => { __mo.disconnect(); return __muts.length; });
      assert.equal(muts, 0, where + ': the list was rewritten for a change in another section');
    }
  });

  await test('M3 a section switch draws at once; an added task enters once while the rows below glide', motion, async (open, motion) => {
    const ids = await seed([['Today one'], ['Today two'], ['Soon one', 'soon'], ['Soon two', 'soon']]);
    const desk = await open({ desktop: true });
    await desk.evaluate(() => {
      window.__stopSw = __frames(() => ({ rows: [...document.querySelectorAll('#list .row')].map((r) => { const l = __rowLook(r); return l.anims + '/' + l.op.toFixed(2) + '/' + l.y.toFixed(1); }) }));
    });
    await desk.click('.nav-item[data-section="soon"]');
    await desk.waitForTimeout(400);
    const fr = await desk.evaluate(() => __stopSw());
    const moving = fr.flatMap((f) => f.rows.filter((r) => r !== '0/1.00/0.0').map((r) => f.t + 'ms ' + r));
    assert.deepEqual(moving.slice(0, 4), [], 'rows animated on a section switch (animations/opacity/y)');

    await desk.keyboard.press('n');
    await desk.waitForSelector('#inlineAdd:not([hidden])');
    await desk.keyboard.type('Freshly added');
    const f = await follow(desk, ids[2], () => desk.keyboard.press('Enter'), 1000);
    const [nid] = Object.keys(f.added);
    assert.ok(nid, 'the new row showed');
    assert.ok(f.added[nid].anims <= 1, 'the new row ran ' + f.added[nid].anims + ' animations at once');
    assert.ok(f.moved > 20, 'the row below moved ' + f.moved + 'px');
    if (motion === 'reduce') assert.equal(f.mid, 0, 'rows glide with reduced motion: ' + f.tops.join(' '));
    else assert.ok(f.mid >= 2, 'the rows below jumped in one frame: ' + f.tops.join(' '));
  });

  await test('M3 no ghost row: Undo during the collapse, a pick on a task deleted elsewhere', motion, async (open) => {
    const ids = await seed([['Row A'], ['Undo me mid-collapse'], ['Row C'], ['Deleted elsewhere'], ['Row E']]);
    const page = await open();
    await page.evaluate((id) => __tap(id), ids[1]);
    await page.waitForTimeout(250);
    await page.click('#toastUndo');
    await page.waitForTimeout(1500);
    assert.ok(await inList(page, ids[1]), 'the row came back');
    assert.deepEqual(await page.evaluate(() => __ghosts()), [], 'ghost rows after Undo');
    assert.ok(!(await page.evaluate((id) => !!__row(id).querySelector('.circle.checked'), ids[1])), 'the returned row is still checked');

    // Deleted on the other device while the menu is open; the pick then finds no task.
    const t = await touch(page, ENGINE);
    await t.longPress(page.locator(`.row[data-id="${ids[3]}"]`));
    await page.waitForSelector('#menu:not([hidden])');
    await postOps([{ op: 'delete', item: { id: ids[3], updatedAt: Date.now() + 1000 } }]);
    const rev0 = await page.evaluate(() => __rev());
    await page.evaluate(() => __poll());
    await until(async () => (await page.evaluate(() => __rev())) > rev0, 4000, 'the poll to land');
    await page.evaluate(() => __tapSel('#menu button[data-move="soon"]'));
    await page.waitForTimeout(1200);
    assert.ok(!(await inList(page, ids[3])), 'the deleted task left');
    assert.deepEqual(await page.evaluate(() => __ghosts()), [], 'ghost rows after the pick');

    // A render with nothing new for this list keeps it that way.
    await otherDevice();
    await page.evaluate(() => __poll());
    await page.waitForTimeout(800);
    assert.deepEqual(await page.evaluate(() => __ghosts()), [], 'ghost rows after the next poll');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#list .row').length), 4, 'rows listed');
  });

  await test('M3 the sync answer does not bring back a row that left', motion, async (open) => {
    const ids = await seed([['Tick and sync'], ['Stays put']]);
    const page = await open();
    await page.evaluate((id) => {
      window.__back = 0;
      new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.dataset.id === id) window.__back++; })
        .observe(document.getElementById('list'), { childList: true });
      __tap(id);
    }, ids[0]);
    await gone(page, [ids[0]]);
    await serverHas((i) => i.id === ids[0] && i.done, 'done on server');
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => __back), 0, 'the row came back when the sync answered');
  });

  /* ================= A2: overlays leave the way they came ================= */
  const scrimFades = (fr, name) => {
    const on = fr.filter((f) => f.open);
    assert.ok(on.some((f) => f.scrim > 0.02 && f.scrim < 0.95), `${name}: the scrim never faded out (${on.map((f) => f.scrim.toFixed(2)).join(' ')})`);
    const up = on.findIndex((f, i) => i > 0 && f.scrim > on[i - 1].scrim + 0.02);
    assert.equal(up, -1, name + ': the scrim came back up while closing');
    assert.ok(!fr[fr.length - 1].open, name + ' closed');
  };

  await test('A2 phone sheets: the scrim fades out with the sheet (capture, edit)', motion, async (open) => {
    const [id] = await seed([['Open my edit sheet']]);
    const page = await open();
    await page.click('#fab');
    await page.waitForSelector('#capture:not([hidden])');
    await page.waitForTimeout(400);
    scrimFades(await overlay(page, '#capture', '#capture .sheet', () => page.keyboard.press('Escape')), 'capture');
    await page.evaluate((id) => __tap(id, '.text'), id);
    await page.waitForSelector('#edit:not([hidden])');
    await page.waitForTimeout(400);
    scrimFades(await overlay(page, '#edit', '#edit .sheet', () => page.click('#editClose')), 'edit');
  });

  await test('A2 desktop edit sheet: fades and scales from .98, centred on every frame', motion, async (open, motion) => {
    const [id] = await seed([['Open me on the desk']]);
    const desk = await open({ desktop: true });
    const inF = await overlay(desk, '#edit', '#edit .sheet', () => desk.click(`.row[data-id="${id}"] .text`), 500);
    const outF = await overlay(desk, '#edit', '#edit .sheet', () => desk.keyboard.press('Escape'), 500);
    const rest = inF[inF.length - 1];
    assert.ok(rest.open, 'the sheet opened');
    const off = [...inF, ...outF].filter((f) => f.open && (Math.abs(f.dx) > 2 || Math.abs(f.dy) > 2));
    assert.deepEqual(off.slice(0, 3).map((f) => `${f.t}ms ${f.dx.toFixed(1)},${f.dy.toFixed(1)}`), [], 'the sheet left the centre');
    assert.ok([...inF, ...outF].every((f) => !f.open || f.w <= rest.w + 0.5), 'the sheet grew past its size');
    assert.ok(inF.some((f) => f.open && f.op < 0.95), 'the sheet did not fade in');
    assert.ok(fading(outF).length, 'the sheet did not fade out');
    if (motion === 'no-preference') {
      assert.ok(inF.some((f) => f.open && f.w < rest.w - 1), 'no scale from .98 on open: ' + inF.filter((f) => f.open).map((f) => f.w.toFixed(1)).join(' '));
      assert.ok(fading(outF).some((f) => f.w < rest.w - 1), 'no scale to .98 on close');
    }
    scrimFades(outF, 'desktop edit');
  });

  await test('A2 the confirm dialog fades in and out, centred on every frame', motion, async (open) => {
    const [id] = await seed([['Maybe delete me']]);
    const desk = await open({ desktop: true });
    await desk.click(`.row[data-id="${id}"] .text`);
    await desk.waitForSelector('#edit:not([hidden])');
    await desk.waitForTimeout(300);
    for (const [how, act] of [['Escape', () => desk.keyboard.press('Escape')], ['Cancel', () => desk.click('#confirmCancel')]]) {
      const inF = await overlay(desk, '#confirm', '#confirm .dialog', () => desk.click('#editDelete'), 400);
      assert.ok(inF.some((f) => f.open && f.op < 0.95), 'the confirm did not fade in');
      const outF = await overlay(desk, '#confirm', '#confirm .dialog', act, 400);
      assert.ok(fading(outF).length, how + ': the confirm did not fade out');
      assert.ok(!outF[outF.length - 1].open, how + ': the confirm closed');
      const off = [...inF, ...outF].filter((f) => f.open && (Math.abs(f.dx) > 2 || Math.abs(f.dy) > 2));
      assert.deepEqual(off.slice(0, 3).map((f) => `${f.t}ms ${f.dx.toFixed(1)},${f.dy.toFixed(1)}`), [], how + ': the confirm left the centre');
      assert.ok(!(await desk.isHidden('#edit')), how + ': the edit sheet stays open');
    }
  });

  await test('A2 the menu grows from its anchor corner and fades out, below and above the row', motion, async (open, motion) => {
    const ids = await seed(Array.from({ length: 14 }, (_, i) => ['Row ' + (i + 1)]));
    const desk = await open({ desktop: true });
    const low = await desk.evaluate(() => {
      const rs = [...document.querySelectorAll('#list .row')].filter((r) => r.getBoundingClientRect().bottom < innerHeight - 20);
      return rs[rs.length - 1].dataset.id;
    });
    for (const [id, where] of [[ids[0], 'below'], [low, 'above']]) {
      await desk.hover(`.row[data-id="${id}"] .text`);
      const inF = await overlay(desk, '#menu', '#menu', () => desk.click(`.row[data-id="${id}"] .move-btn`), 400);
      const rest = inF[inF.length - 1];
      const row = await box(desk, `.row[data-id="${id}"] .move-btn`); // the anchor
      assert.ok(rest.open, 'the menu opened');
      assert.ok(where === 'below' ? rest.top >= row.bottom - 1 : rest.bot <= row.top + 1, 'the menu did not open ' + where + ' its button');
      assert.ok(inF.every((f) => !f.open || f.w <= rest.w + 0.5), 'the menu grew past its size');
      if (motion === 'no-preference') {
        const grow = inF.filter((f) => f.open && f.w < rest.w - 0.5);
        assert.ok(grow.some((f) => f.w < rest.w - 1), `${where}: no scale from .96 (${inF.filter((f) => f.open).map((f) => f.w.toFixed(1)).join(' ')})`);
        const drift = grow.filter((f) => Math.abs(f.r - rest.r) > 1 || Math.abs(where === 'below' ? f.top - rest.top : f.bot - rest.bot) > 1);
        assert.deepEqual(drift.slice(0, 3).map((f) => `${f.t}ms right ${f.r.toFixed(1)} top ${f.top.toFixed(1)} bottom ${f.bot.toFixed(1)}`), [], where + ': the corner at the anchor moved while the menu grew');
      }
      const outF = await overlay(desk, '#menu', '#menu', () => desk.keyboard.press('Escape'), 400);
      assert.ok(fading(outF).length, where + ': the menu did not fade out');
      assert.ok(!outF[outF.length - 1].open, where + ': the menu closed');
    }
  });

  /* ================= A3: the check moment ================= */
  await test('A3 the check: strike and grey first, the collapse starts within 400ms, no pulse', motion, async (open, motion) => {
    const ids = await seed([['Check me off'], ['Neighbour'], ['Third']]);
    const page = await open();
    const r = await page.evaluate((id) => new Promise((done) => {
      const row = __row(id);
      const text = row.querySelector('.text');
      const circle = row.querySelector('.circle');
      const ic = circle.querySelector('.ic');
      const probe = document.createElement('span');
      probe.style.color = 'var(--secondary)';
      document.body.append(probe);
      const secondary = getComputedStyle(probe).color;
      probe.remove();
      let maxScale = 0, dash = '';
      const offs = [];
      const stop = __leaveWatch(row, () => {
        const cs = getComputedStyle(text);
        maxScale = Math.max(maxScale, __tr(circle).s, __tr(ic).s);
        const is = getComputedStyle(ic);
        if (is.strokeDasharray && is.strokeDasharray !== 'none') dash = is.strokeDasharray;
        offs.push(parseFloat(is.strokeDashoffset) || 0);
        return { strike: /line-through/.test(cs.textDecorationLine || cs.textDecoration), grey: cs.color === secondary };
      });
      __tap(id);
      setTimeout(() => done(Object.assign(stop(), { maxScale, dash, offs })), 900);
    }), ids[0]);
    assert.ok(r.start >= 0, 'the row never collapsed');
    assert.ok(r.start <= 420, `the collapse started ${r.start}ms after the tap`);
    assert.ok(r.seen.some((s) => s.strike && s.grey), 'the text never showed a line-through in --secondary before the collapse');
    assert.ok(r.maxScale <= 1.001, 'the circle scaled to ' + r.maxScale.toFixed(3));
    if (motion === 'no-preference') {
      const d = parseFloat(r.dash);
      assert.ok(d >= 18 && d <= 22, 'check stroke-dasharray is ' + JSON.stringify(r.dash));
      assert.ok(r.offs.some((o) => o > 0.5 && o < 19.5), 'the check stroke never drew (dashoffset ' + [...new Set(r.offs)].slice(0, 6).join(' ') + ')');
    }
    await serverHas((i) => i.id === ids[0] && i.done, 'done on server');
  });

  /* ================= A6: Undo ================= */
  await test('A6 Undo: the row fades back into its old slot while the rows below part', motion, async (open, motion) => {
    const ids = await seed([['Row A'], ['Undo brings me back'], ['Row C'], ['Row D']]);
    const page = await open();
    await page.evaluate((id) => __tap(id), ids[1]);
    await gone(page, [ids[1]]);
    await page.waitForTimeout(200);
    const f = await follow(page, ids[2], () => page.click('#toastUndo'), 1000);
    assert.deepEqual(f.order, ids, 'the row came back in its old slot');
    const b = f.added[ids[1]];
    assert.ok(b, 'the row came back');
    assert.ok(b.minOp < 0.95, 'the row popped back at full opacity');
    assert.ok(f.moved > 20, 'the row below moved ' + f.moved + 'px');
    if (motion === 'reduce') {
      assert.equal(f.mid, 0, 'rows glide with reduced motion: ' + f.tops.join(' '));
      assert.ok(b.maxShift <= 0.5, 'the returning row slides with reduced motion');
    } else {
      assert.ok(f.mid >= 2, 'the rows below jumped in one frame: ' + f.tops.join(' '));
    }
    await serverHas((i) => i.id === ids[1] && !i.done, 'open again on server');
  });

  /* ================= C1: sidebar drop ================= */
  await test('C1 sidebar drop: .dragging while dragged, the row slides out, its own section leaves no ghost', motion, async (open, motion, part) => {
    const ids = await seed([['Row A'], ['Drop me on Soon'], ['Drop me on Today'], ['Row D']]);
    const desk = await open({ desktop: true });
    await desk.evaluate(() => { window.__starts = 0; document.addEventListener('dragstart', () => { __starts++; }, true); });
    const drag = async (id, section, beforeDrop) => {
      await desk.hover(`.row[data-id="${id}"] .text`);
      await desk.mouse.down();
      const n = await box(desk, `.nav-item[data-section="${section}"]`);
      await desk.mouse.move(n.cx, n.top + n.h / 2, { steps: 8 });
      const d = await desk.evaluate((id) => ({ starts: __starts, dragging: !!__row(id) && __row(id).classList.contains('dragging') }), id);
      if (beforeDrop) await beforeDrop();
      await desk.mouse.up();
      return d;
    };
    const d = await drag(ids[1], 'soon', () => desk.evaluate((id) => {
      window.__stopSlide = __frames(() => {
        const r = __row(id);
        const t = document.getElementById('toast');
        const toast = !t.hidden && document.getElementById('toastText').textContent;
        if (!r) return { con: false, toast };
        const l = __rowLook(r);
        return { con: true, toast, slid: Math.abs(l.x) > 2 || l.op < 0.99 || r.classList.contains('sliding') || r.classList.contains('collapsing') };
      });
    }, ids[1]));
    if (!d.starts) {
      await desk.evaluate(() => __stopSlide());
      throw new Skip(`Playwright ${ENGINE} on Windows starts no native drag from the mouse, so there is nothing to drop`);
    }
    assert.ok(d.dragging, 'no .dragging on the row while it was dragged');
    await desk.waitForTimeout(900);
    const fr = await desk.evaluate(() => __stopSlide());
    assert.equal(await desk.evaluate(() => document.querySelectorAll('.row.dragging').length), 0, '.dragging left after the drop');
    if (ENGINE !== 'chromium') {
      part('Playwright WebKit on Windows fires no drop, so the move and the same-section drop are checked in Chromium only');
      return;
    }
    assert.ok(fr.some((f) => f.con && f.slid), 'the dropped row vanished without sliding out');
    const toastAt = fr.find((f) => f.toast === 'Moved to Soon.');
    assert.ok(toastAt && toastAt.t <= 300, 'no "Moved to Soon." toast at the drop');
    await gone(desk, [ids[1]]);
    await serverHas((i) => i.id === ids[1] && i.section === 'soon', 'move on server');

    await drag(ids[2], 'today');
    await desk.waitForTimeout(800);
    assert.ok(await inList(desk, ids[2]), 'a drop on its own section removed the row');
    assert.deepEqual(await desk.evaluate(() => __ghosts()), [], 'ghost rows after a drop on its own section');
    await otherDevice();
    await desk.evaluate(() => __poll());
    await desk.waitForTimeout(800);
    assert.deepEqual(await desk.evaluate(() => __ghosts()), [], 'ghost rows after the next poll');
  });

  /* ================= A4: the toast ================= */
  await test('A4 two ticks and a move: one toast stays up with no bounce, the text follows, centred (desktop)', motion, async (open) => {
    const ids = await seed([['Tick A'], ['Tick B'], ['Move C'], ['Stays']]);
    const desk = await open({ desktop: true });
    const cx = (await box(desk, '.col')).cx;
    await desk.evaluate((cx) => {
      const t = document.getElementById('toast');
      const t0 = performance.now();
      window.__hid = [];
      new MutationObserver((ms) => { for (const m of ms) __hid.push(Math.round(performance.now() - t0)); }).observe(t, { attributes: true, attributeFilter: ['hidden'] });
      window.__stopToast = __frames(() => {
        const cs = getComputedStyle(t);
        const b = t.getBoundingClientRect();
        return { open: !t.hidden && cs.display !== 'none', op: parseFloat(cs.opacity), dx: b.left + b.width / 2 - cx, text: document.getElementById('toastText').textContent };
      });
    }, cx);
    await desk.click(`.row[data-id="${ids[0]}"] .circle`);
    await gone(desk, [ids[0]]);
    await desk.click(`.row[data-id="${ids[1]}"] .circle`);
    await gone(desk, [ids[1]]);
    await desk.hover(`.row[data-id="${ids[2]}"] .text`);
    await desk.click(`.row[data-id="${ids[2]}"] .move-btn`);
    await desk.waitForSelector('#menu:not([hidden])');
    await desk.click('#menu button[data-move="soon"]');
    await desk.waitForTimeout(400);
    const fr = await desk.evaluate(() => __stopToast());
    const hid = await desk.evaluate(() => __hid);
    const first = fr.find((f) => f.open);
    assert.ok(first, 'no toast');
    const from = first.t + 300;
    const bad = fr.filter((f) => f.t >= from && (!f.open || f.op < 0.99 || Math.abs(f.dx) > 2));
    assert.deepEqual(bad.slice(0, 4).map((f) => `${f.t}ms open ${f.open} opacity ${f.op.toFixed(2)} dx ${f.dx.toFixed(1)}`), [], 'the toast hid, dipped or moved while it was replaced');
    assert.deepEqual(hid.filter((t) => t >= from), [], 'hidden was toggled on the toast after it first showed (ms)');
    assert.equal(fr[fr.length - 1].text, 'Moved to Soon.', 'toast text');
  });

  await test('A4 the toast waits while the pointer or focus is on it, then leaves with 2s left', motion, async (open) => {
    const ids = await seed([['Tick and hover'], ['Tick and focus'], ['Stays']]);
    const desk = await open({ desktop: true });
    const cx = (await box(desk, '.col')).cx;
    await desk.click(`.row[data-id="${ids[0]}"] .circle`);
    const t0 = Date.now();
    await desk.waitForSelector('#toast:not([hidden])');
    await desk.waitForTimeout(800);
    await desk.hover('#toast');
    await desk.waitForTimeout(5000 - (Date.now() - t0));
    assert.ok(await desk.isVisible('#toast'), 'the toast left at 4s with the pointer on it');
    await desk.evaluate((cx) => {
      const t = document.getElementById('toast');
      window.__stopToast = __frames(() => {
        const b = t.getBoundingClientRect();
        const cs = getComputedStyle(t);
        return { open: !t.hidden && cs.display !== 'none', op: parseFloat(cs.opacity), dx: b.left + b.width / 2 - cx };
      });
    }, cx);
    await desk.mouse.move(700, 80);
    await desk.waitForTimeout(3200);
    const fr = await desk.evaluate(() => __stopToast());
    const shut = fr.find((f) => !f.open);
    assert.ok(shut, 'the toast never left after the pointer did');
    assert.ok(shut.t >= 1500, `the toast left ${shut.t}ms after the pointer, not about 2s`);
    assert.ok(fading(fr).length, 'the toast left without fading');
    const off = fr.filter((f) => f.open && Math.abs(f.dx) > 2);
    assert.deepEqual(off.slice(0, 3).map((f) => f.t + 'ms ' + f.dx.toFixed(1)), [], 'the toast left the column centre as it went');

    await desk.click(`.row[data-id="${ids[1]}"] .circle`);
    await desk.waitForSelector('#toast:not([hidden])');
    // After the row has left, so moving focus off a leaving row can not take it from the toast.
    await gone(desk, [ids[1]]);
    await desk.waitForTimeout(100);
    await desk.evaluate(() => document.getElementById('toastUndo').focus());
    await desk.waitForTimeout(5000);
    assert.ok(await desk.isVisible('#toast'), 'the toast left at 4s with focus on Undo');
    await desk.evaluate(() => document.activeElement.blur());
    await desk.waitForSelector('#toast', { state: 'hidden', timeout: 3500 });
  });

  await test('A4 the toast leaves with a fade, 8px down (still with reduced motion)', motion, async (open, motion) => {
    const [id] = await seed([['Tick me'], ['Stays']]);
    const page = await open();
    await page.evaluate((id) => __tap(id), id);
    await page.waitForTimeout(3300);
    await page.evaluate(() => {
      const t = document.getElementById('toast');
      window.__stopToast = __frames(() => ({ open: !t.hidden && getComputedStyle(t).display !== 'none', op: parseFloat(getComputedStyle(t).opacity), top: t.getBoundingClientRect().top }));
    });
    await page.waitForTimeout(1700);
    const fr = await page.evaluate(() => __stopToast());
    assert.ok(fr[0].open, 'the toast was up at 3.3s');
    assert.ok(!fr[fr.length - 1].open, 'the toast left');
    assert.ok(fading(fr).length, 'the toast left without fading');
    const drop = Math.max(...fr.filter((f) => f.open).map((f) => f.top - fr[0].top));
    if (motion === 'reduce') assert.ok(drop <= 1, `the toast moved ${drop.toFixed(1)}px with reduced motion`);
    else assert.ok(drop >= 3 && drop <= 9, `the toast moved ${drop.toFixed(1)}px down as it left`);
  });

  /* ================= X1: focus survives a row leaving ================= */
  await test('X1 circle by keyboard: focus lands on the next row; a finger leaves no focus', motion, async (open) => {
    const ids = await seed([['Row A'], ['Row B'], ['Row C'], ['Row D']]);
    const desk = await open({ desktop: true });
    await desk.evaluate((id) => __row(id).querySelector('.circle').focus(), ids[1]);
    await desk.keyboard.press('Enter');
    await gone(desk, [ids[1]]);
    await desk.waitForTimeout(300);
    assert.equal(await desk.evaluate(() => __focusText()), 'Row C', 'focus after the ticked row left');

    const phone = await open();
    await phone.evaluate((id) => __tap(id), ids[2]);
    await gone(phone, [ids[2]]);
    await phone.waitForTimeout(300);
    const f = await phone.evaluate(() => { const a = document.activeElement; return a && a.closest && a.closest('#list') ? a.outerHTML.slice(0, 60) : ''; });
    assert.equal(f, '', 'a tap left focus in the list');
  });

  await test('X1 menu by keyboard: Escape gives focus back to the opener, a pick moves it to the next row', motion, async (open) => {
    const ids = await seed([['Row A'], ['Row B'], ['Row C'], ['Row D']]);
    const desk = await open({ desktop: true });
    const openMenu = async (id) => {
      await desk.hover(`.row[data-id="${id}"] .text`);
      await desk.evaluate((id) => __row(id).querySelector('.move-btn').focus(), id);
      await desk.keyboard.press('Enter');
      await desk.waitForSelector('#menu:not([hidden])');
      await desk.waitForTimeout(250);
    };
    const where = () => desk.evaluate(() => {
      const a = document.activeElement;
      const r = a && a.closest && a.closest('.row');
      return r ? r.querySelector('.text').textContent + (a.classList.contains('move-btn') ? ' move-btn' : '') : a.tagName;
    });
    await openMenu(ids[1]);
    await desk.keyboard.press('Escape');
    await desk.waitForSelector('#menu', { state: 'hidden' });
    await desk.waitForTimeout(100);
    assert.equal(await where(), 'Row B move-btn', 'focus after Escape closed the menu');

    await openMenu(ids[1]);
    assert.equal(await desk.evaluate(() => document.activeElement.dataset.move), 'soon', 'the menu focuses Soon');
    await desk.keyboard.press('Enter');
    await gone(desk, [ids[1]]);
    await desk.waitForTimeout(300);
    assert.equal(await where(), 'Row C', 'focus after the moved row left');
    await serverHas((i) => i.id === ids[1] && i.section === 'soon', 'move on server');
  });

  await test('X1 reopen in Done by keyboard: focus lands on the next done row', motion, async (open) => {
    const t = Date.now() - 600000;
    const ids = await seed([['Done one', 'today', { done: true, doneAt: t }], ['Done two', 'today', { done: true, doneAt: t - 1000 }],
      ['Done three', 'today', { done: true, doneAt: t - 2000 }], ['Open task']]);
    const desk = await open({ desktop: true });
    await desk.click('.nav-item[data-section="done"]');
    await desk.waitForSelector(`.drow[data-id="${ids[1]}"]`);
    await desk.evaluate((id) => document.querySelector(`.drow[data-id="${id}"]`).focus(), ids[1]);
    await desk.keyboard.press('Enter');
    await until(async () => !(await desk.$(`.drow[data-id="${ids[1]}"]`)), 3000, 'the reopened row to leave Done');
    await desk.waitForTimeout(300);
    const f = await desk.evaluate(() => { const d = document.activeElement.closest && document.activeElement.closest('.drow'); return d ? d.querySelector('.dtext').textContent : document.activeElement.tagName; });
    assert.equal(f, 'Done three', 'focus after reopening');
  });

  await test('X1 delete through the confirm by keyboard: focus lands on the next row', motion, async (open) => {
    const ids = await seed([['Row A'], ['Delete me'], ['Row C']]);
    const desk = await open({ desktop: true });
    await desk.evaluate((id) => __row(id).focus(), ids[1]);
    await desk.keyboard.press('Enter');
    await desk.waitForSelector('#edit:not([hidden])');
    await desk.waitForTimeout(300);
    await desk.focus('#editDelete');
    await desk.keyboard.press('Enter');
    await desk.waitForSelector('#confirm:not([hidden])');
    await desk.waitForTimeout(250);
    await desk.focus('#confirmDelete');
    await desk.keyboard.press('Enter');
    await gone(desk, [ids[1]]);
    await desk.waitForTimeout(500);
    assert.equal(await desk.evaluate(() => __focusText()), 'Row C', 'focus after the task was deleted');
    await until(async () => !(await getList()).find((i) => i.id === ids[1]), 8000, 'delete on server');
  });

  await test('X1 a section change in the edit sheet (desktop): focus lands on the next row when it closes', motion, async (open) => {
    const ids = await seed([['Row A'], ['Move me'], ['Row C']]);
    const desk = await open({ desktop: true });
    await desk.evaluate((id) => __row(id).focus(), ids[1]);
    await desk.keyboard.press('Enter');
    await desk.waitForSelector('#edit:not([hidden])');
    await desk.waitForTimeout(300);
    await desk.click('#editSeg button[data-section="soon"]');
    await gone(desk, [ids[1]]); // the row has left the list behind the sheet
    await desk.waitForTimeout(100);
    await desk.keyboard.press('Escape');
    await desk.waitForSelector('#edit', { state: 'hidden' });
    await desk.waitForTimeout(200);
    assert.equal(await desk.evaluate(() => __focusText()), 'Row C', 'focus after the moved task left');
  });

  await test('M1 write at tap: capture Done and confirm Delete write their op before the sheet leaves', motion, async (open) => {
    const [a, b] = await seed([['Delete on the phone'], ['Delete on the desk']]);
    const page = await open();
    await page.click('#fab');
    await page.waitForSelector('#capture:not([hidden])');
    await page.waitForTimeout(300);
    const added = await page.evaluate(() => {
      document.getElementById('capInput').value = 'Typed then Done';
      document.getElementById('capDone').click();
      return __queue().some((o) => o.op === 'upsert' && o.item.text === 'Typed then Done');
    });
    assert.ok(added, 'the new task was not queued at the Done tap');
    await serverHas((i) => i.text === 'Typed then Done', 'added on server');

    const confirmDelete = async (p) => {
      await p.click('#editDelete');
      await p.waitForSelector('#confirm:not([hidden])');
      await p.waitForTimeout(250);
    };
    const queuedAtTap = (p, id) => p.evaluate((id) => {
      document.getElementById('confirmDelete').click();
      return __queue().some((o) => o.op === 'delete' && o.item.id === id);
    }, id);
    await page.evaluate((id) => __tap(id, '.text'), a);
    await page.waitForSelector('#edit:not([hidden])');
    await page.waitForTimeout(300);
    await confirmDelete(page);
    assert.ok(await queuedAtTap(page, a), 'phone: the delete was not queued at the tap');

    const desk = await open({ desktop: true });
    await desk.evaluate((id) => __row(id).focus(), b);
    await desk.keyboard.press('Enter');
    await desk.waitForSelector('#edit:not([hidden])');
    await desk.waitForTimeout(300);
    await confirmDelete(desk);
    assert.ok(await queuedAtTap(desk, b), 'desktop: the delete was not queued at the tap');
    await until(async () => !(await getList()).some((i) => i.id === a || i.id === b), 8000, 'deletes on server');
  });

  /* ================= X2: real modals ================= */
  const modalState = (page) => page.evaluate(() => ({
    edit: document.querySelector('#edit .sheet').getAttribute('aria-modal'),
    capture: document.querySelector('#capture .sheet').getAttribute('aria-modal'),
    confirm: document.querySelector('#confirm .dialog').getAttribute('aria-modal'),
    inert: Object.fromEntries(['.sidebar', 'main', '#fab', '#switcher', '#toast', '#edit'].map((s) => { const el = document.querySelector(s); return [s, !!el.inert || el.hasAttribute('inert')]; })),
  }));
  const behind = { '.sidebar': true, main: true, '#fab': true, '#switcher': true, '#toast': true, '#edit': false };
  const none = { '.sidebar': false, main: false, '#fab': false, '#switcher': false, '#toast': false, '#edit': false };

  await test('X2 desktop: the edit sheet and the confirm are modal, Tab stays in, focus goes back', motion, async (open) => {
    const ids = await seed([['Row A'], ['Edit me'], ['Row C']]);
    const desk = await open({ desktop: true });
    // Where 8 Tabs land that is outside sel (the page itself counts as inside: focus left for the browser).
    const tabOut = async (sel) => {
      const out = [];
      for (let i = 0; i < 8; i++) {
        await desk.keyboard.press('Tab');
        const w = await desk.evaluate((sel) => {
          const a = document.activeElement;
          if (!a || a === document.body || a === document.documentElement || a.closest(sel)) return '';
          return a.id || a.className || a.tagName;
        }, sel);
        if (w) out.push(w);
      }
      return out;
    };
    await desk.evaluate((id) => __row(id).focus(), ids[1]);
    await desk.keyboard.press('Enter');
    await desk.waitForSelector('#edit:not([hidden])');
    await desk.waitForTimeout(300);
    let s = await modalState(desk);
    assert.equal(s.edit, 'true', 'edit sheet aria-modal');
    assert.deepEqual(s.inert, behind, 'inert behind the edit sheet');
    assert.deepEqual(await tabOut('#edit'), [], 'Tab left the edit sheet for');

    await desk.focus('#editDelete');
    await desk.keyboard.press('Enter');
    await desk.waitForSelector('#confirm:not([hidden])');
    await desk.waitForTimeout(250);
    s = await modalState(desk);
    assert.equal(s.confirm, 'true', 'confirm aria-modal');
    assert.ok(s.inert['#edit'], 'the edit sheet is not inert under the confirm');
    assert.deepEqual(await tabOut('#confirm'), [], 'Tab left the confirm for');
    await desk.keyboard.press('Escape');
    await desk.waitForSelector('#confirm', { state: 'hidden' });
    await desk.waitForTimeout(100);
    assert.equal(await desk.evaluate(() => document.activeElement.id), 'editDelete', 'focus after the confirm closed');
    assert.ok(!(await modalState(desk)).inert['#edit'], 'the edit sheet stayed inert after the confirm closed');

    await desk.keyboard.press('Escape');
    await desk.waitForSelector('#edit', { state: 'hidden' });
    await desk.waitForTimeout(200);
    assert.equal(await desk.evaluate(() => __focusText()), 'Edit me', 'focus after the edit sheet closed');
    assert.deepEqual((await modalState(desk)).inert, none, 'inert left behind after closing');
  });

  await test('X2 phone: the edit sheet focuses Close, both sheets are modal, inert clears on close', motion, async (open) => {
    const [id] = await seed([['Tap my text']]);
    const page = await open();
    await page.evaluate((id) => __tap(id, '.text'), id);
    await page.waitForSelector('#edit:not([hidden])');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'editClose', 'focus in the phone edit sheet');
    let s = await modalState(page);
    assert.equal(s.edit, 'true', 'edit sheet aria-modal');
    assert.deepEqual(s.inert, behind, 'inert behind the edit sheet');
    await page.click('#editClose');
    await page.waitForSelector('#edit', { state: 'hidden' });
    await page.waitForTimeout(150);
    assert.deepEqual((await modalState(page)).inert, none, 'inert left behind after the edit sheet');

    await page.click('#fab');
    await page.waitForSelector('#capture:not([hidden])');
    await page.waitForTimeout(150);
    s = await modalState(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'capInput', 'focus in the capture sheet');
    assert.equal(s.capture, 'true', 'capture sheet aria-modal');
    assert.deepEqual(s.inert, behind, 'inert behind the capture sheet');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#capture', { state: 'hidden' });
    await page.waitForTimeout(150);
    assert.deepEqual((await modalState(page)).inert, none, 'inert left behind after the capture sheet');
  });
}

await resetServer();
await browser.close();
const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${ENGINE}: ${results.length - fails.length} passed, ${fails.length} failed, ${skipped.length} skipped`);
for (const f of fails) console.log(' ', f[1], ':', f[2]);
for (const s of skipped) console.log('  skipped', s[0], ':', s[1]);
process.exit(fails.length ? 1 : 0);
