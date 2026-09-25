/* To-do. One list, three sections, done history. Vanilla, no build step.
 *
 * Data flow
 *   The list lives in localStorage and is shown at once. Every change is an op on one
 *   task, kept in a queue (one op per task, the latest wins) and sent in a debounced
 *   batch. The screen always shows the last server copy with the queue laid on top,
 *   so offline changes show immediately and survive a reload. While the page is
 *   visible it polls with ?since=<rev>, which costs nothing when nothing moved.
 */
(() => {
  'use strict';

  const SECTIONS = ['today', 'soon', 'someday'];
  const LABEL = { today: 'Today', soon: 'Soon', someday: 'Someday', done: 'Done' };
  const EMPTY = { today: 'Nothing for today.', soon: 'Nothing coming up.', someday: 'Nothing for someday.' };
  const MAX_TEXT = 500;
  const MAX_BATCH = 200;
  const MAX_BODY = 150000;
  const DEBOUNCE = 1200;
  const POLL = 10000;
  const TOAST_MS = 4000;

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const apiParam = params.get('api') || '';
  const API = (/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)/.test(apiParam)
    ? apiParam
    : isLocal ? 'http://localhost:8787' : 'https://paul-hub.paul-o-a04.workers.dev').replace(/\/+$/, '');
  const desk = matchMedia('(min-width: 900px)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- Storage (every access guarded; private mode can throw) ---------- */
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or blocked */ } },
  };

  /* ---------- The code in the link ---------- */
  let code = (params.get('c') || '').trim().toLowerCase();
  if (/^[a-z0-9]{16}$/.test(code)) {
    store.set('todo.code', code);
  } else {
    code = store.get('todo.code') || '';
    if (/^[a-z0-9]{16}$/.test(code)) {
      // Put it back in the address, so Add to Home Screen keeps it.
      params.set('c', code);
      history.replaceState(null, '', location.pathname + '?' + params.toString());
    }
  }
  if (!/^[a-z0-9]{16}$/.test(code)) {
    $('nocode').hidden = false;
    return;
  }

  const KEY = 'todo.v1.' + code;
  const ui = Object.assign({ section: 'today', nudged: false, installOff: false }, store.get('todo.ui') || {});
  const saveUi = () => store.set('todo.ui', ui);
  const saved = store.get(KEY);
  const st = saved && typeof saved === 'object'
    ? { server: saved.server || {}, rev: saved.rev || 0, queue: Array.isArray(saved.queue) ? saved.queue : [] }
    : { server: {}, rev: 0, queue: [] };
  let loaded = !!saved; // false only on a cold start with no local copy
  const save = () => store.set(KEY, st);

  let view = 'list'; // 'list' | 'done'
  let items = {};
  const justAdded = new Set();

  /* ---------- Model ---------- */
  function computeView() {
    const m = Object.assign({}, st.server);
    for (const o of st.queue) {
      if (o.op === 'delete') delete m[o.item.id];
      else m[o.item.id] = o.item;
    }
    items = m;
  }

  let lastStamp = 0;
  // The Worker refuses times before 2020, so a phone with a wrong clock still gets a usable stamp.
  const MIN_TIME = Date.UTC(2020, 0, 1) + 1;
  const now = () => Math.max(Date.now(), MIN_TIME);
  function stamp() {
    lastStamp = Math.max(now(), lastStamp + 1);
    return lastStamp;
  }

  function newId() {
    const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const b = crypto.getRandomValues(new Uint8Array(16));
    let s = '';
    for (const x of b) s += a[x % 36];
    return s;
  }

  // Same as cleanText in worker/src/todo.js, so the Worker never refuses what the app sends.
  function cleanText(v) {
    const t = String(v || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT).trim() : t;
  }

  function enqueue(op) {
    st.queue = st.queue.filter((o) => o.item.id !== op.item.id);
    st.queue.push(op);
    save();
    computeView();
    render();
    scheduleFlush();
  }

  function upsert(it) {
    enqueue({ op: 'upsert', item: {
      id: it.id, text: it.text, section: it.section, done: !!it.done,
      doneAt: it.done ? it.doneAt : null, pos: it.pos, updatedAt: stamp(),
    } });
  }

  function remove(id) {
    enqueue({ op: 'delete', item: { id, updatedAt: stamp() } });
  }

  function openIn(section) {
    return Object.values(items).filter((i) => !i.done && i.section === section).sort((a, b) => b.pos - a.pos);
  }

  /* ---------- Actions ---------- */
  function addTask(text) {
    text = cleanText(text);
    if (!text) return;
    const id = newId();
    justAdded.add(id);
    upsert({ id, text, section: ui.section, done: false, doneAt: null, pos: now() });
  }

  function markDone(id) {
    const it = items[id];
    if (!it || it.done) return;
    const prev = Object.assign({}, it);
    upsert(Object.assign({}, it, { done: true, doneAt: now() }));
    toast('Done.', () => upsert(prev));
  }

  function moveTo(id, section, withToast = true) {
    const it = items[id];
    if (!it || it.section === section) return;
    const prev = Object.assign({}, it);
    upsert(Object.assign({}, it, { section, pos: now() }));
    if (withToast) toast('Moved to ' + LABEL[section] + '.', () => upsert(prev));
  }

  function reopen(id) {
    const it = items[id];
    if (!it || !it.done) return;
    const prev = Object.assign({}, it);
    upsert(Object.assign({}, it, { done: false, doneAt: null, pos: now() }));
    toast('Reopened in ' + LABEL[it.section] + '.', () => upsert(prev));
  }

  /* ---------- Sync ---------- */
  let flushTimer = 0;
  let inflight = false;
  let polling = false;
  let net = 'idle'; // idle | offline | syncing | synced | error
  let trouble = false; // true after offline or an error, so the recovery gets a "Synced"
  let slowTimer = 0;
  let rejectNote = false; // the Worker refused an op: the banner stays until Retry or a clean batch

  function scheduleFlush(ms = DEBOUNCE) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, ms);
    if (!navigator.onLine) setNet('offline');
  }

  function refused(status, body) {
    return status === 404 || (status === 400 && body && body.error === 'bad code');
  }

  async function flush(keepalive = false) {
    clearTimeout(flushTimer);
    if (inflight || !st.queue.length) return;
    if (!navigator.onLine) { setNet('offline'); return; }
    inflight = true;
    // A keepalive request (sent as the app goes to the background) may carry at most 64 kB.
    const sent = nextBatch(keepalive ? 60000 : MAX_BODY);
    if (trouble) setNet('syncing');
    else slowTimer = setTimeout(() => setNet('syncing'), 800);
    let again = false;
    try {
      const r = await fetch(API + '/api/todo/' + code + '/ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops: sent }),
        keepalive,
      });
      const d = await r.json().catch(() => null);
      if (refused(r.status, d)) return showNoCode();
      if (!r.ok || !d) throw new Error('status ' + r.status); // kept in the queue, tried again later
      // Ops the Worker refused one by one (named by index) will never be taken. They go with
      // the rest of the batch, and the banner says something did not sync.
      const rejected = Array.isArray(d.rejected) ? d.rejected.filter((i) => sent[i]) : [];
      dropSent(sent);
      applyServer(d);
      rejectNote = rejected.length > 0;
      if (rejectNote) setNet('error');
      else if (st.queue.length) again = true;
      else settle();
    } catch (e) {
      setNet(navigator.onLine ? 'error' : 'offline');
    } finally {
      inflight = false;
      clearTimeout(slowTimer);
    }
    if (again) flush();
  }

  function dropSent(sent) {
    st.queue = st.queue.filter((o) => !sent.some((s) => s.item.id === o.item.id && s.item.updatedAt === o.item.updatedAt));
    save();
    computeView();
    render();
  }

  // Up to MAX_BATCH ops, and well under the Worker's 200 kB body limit.
  function nextBatch(limit) {
    const out = [];
    let size = 20;
    for (const o of st.queue) {
      const n = JSON.stringify(o).length + 1;
      if (out.length && (out.length >= MAX_BATCH || size + n > limit)) break;
      out.push(o);
      size += n;
    }
    return out;
  }

  function applyServer(d) {
    if (!d || !Array.isArray(d.items)) return;
    if (typeof d.rev === 'number' && d.rev < st.rev) return; // an older answer arriving late
    const m = {};
    for (const i of d.items) m[i.id] = i;
    st.server = m;
    st.rev = d.rev || 0;
    save();
    computeView();
    render();
  }

  async function poll() {
    if (document.hidden || polling) return;
    if (st.queue.length && !inflight) flush();
    polling = true;
    try {
      const r = await fetch(API + '/api/todo/' + code + '?since=' + st.rev, { cache: 'no-store' });
      const d = await r.json().catch(() => null);
      if (refused(r.status, d)) return showNoCode();
      if (!r.ok || !d) throw new Error('status ' + r.status);
      if (!d.unchanged) applyServer(d);
      if (!loaded) { loaded = true; render(); }
      if (!st.queue.length) settle();
    } catch (e) {
      if (!loaded) { loaded = true; render(); }
      setNet(navigator.onLine ? 'error' : 'offline');
    } finally {
      polling = false;
    }
  }

  function settle() {
    if (rejectNote) return;
    if (trouble || net === 'syncing') setNet('synced');
    else if (net !== 'synced') setNet('idle');
  }

  let pillTimer = 0;
  function setNet(s) {
    net = s;
    const pill = $('pill');
    const span = pill.querySelector('span');
    const use = pill.querySelector('use');
    clearTimeout(pillTimer);
    pill.classList.remove('fade');
    $('banner').hidden = s !== 'error';
    if (s === 'offline' || s === 'error') trouble = true;
    if (s === 'offline') {
      const n = st.queue.length;
      span.textContent = n ? 'Offline. ' + n + (n === 1 ? ' change' : ' changes') + ' waiting' : 'Offline';
      use.setAttribute('href', '#i-offline');
      pill.hidden = false;
    } else if (s === 'syncing') {
      span.textContent = 'Syncing';
      use.setAttribute('href', '#i-sync');
      pill.hidden = false;
    } else if (s === 'synced') {
      trouble = false;
      span.textContent = 'Synced';
      use.setAttribute('href', '#i-check');
      pill.hidden = false;
      pillTimer = setTimeout(() => {
        pill.classList.add('fade');
        pillTimer = setTimeout(() => { pill.hidden = true; pill.classList.remove('fade'); net = 'idle'; }, 450);
      }, 1600);
    } else {
      pill.hidden = true;
    }
  }

  function showNoCode() {
    $('nocode').hidden = false;
  }

  /* ---------- Rendering ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');

  function dayLabel(t) {
    const d = new Date(t);
    const today = new Date();
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(today) - start(d)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    let s = DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
    if (d.getFullYear() !== today.getFullYear()) s += ' ' + d.getFullYear();
    return s;
  }

  function rowHtml(it, enter) {
    const moves = SECTIONS.map((s) =>
      '<button data-move="' + s + '"' + (s === it.section ? ' aria-current="true" tabindex="-1"' : '') + '>' + LABEL[s] + '</button>').join('');
    return '<li class="row' + (enter ? ' enter' : '') + '" data-id="' + it.id + '" tabindex="-1"' + (desk.matches ? ' draggable="true"' : '') + '>' +
      '<div class="swipe-done" aria-hidden="true"><svg class="ic ic-2" width="24" height="24"><use href="#i-check"/></svg></div>' +
      '<div class="swipe-move"><span class="move-group">' + moves + '</span></div>' +
      '<div class="row-inner">' +
      '<button class="circle" aria-label="Mark done"><svg class="ic ic-2" width="16" height="16"><use href="#i-check"/></svg></button>' +
      '<div class="text">' + esc(it.text) + '</div>' +
      '<button class="move-btn" aria-label="Move task"><svg class="ic" width="20" height="20"><use href="#i-move"/></svg></button>' +
      '</div></li>';
  }

  const DONE_PAGE = 300;
  let doneShown = DONE_PAGE;

  let renderQueued = false;
  function render() {
    if (busy || revealed) { renderQueued = true; return; }
    renderQueued = false;
    const list = $('list');
    const focusedId = document.activeElement && document.activeElement.closest && document.activeElement.closest('.row, .drow')
      ? document.activeElement.closest('.row, .drow').dataset.id : null;

    document.body.classList.toggle('view-done', view === 'done');
    document.body.classList.toggle('view-list', view === 'list');
    $('title').textContent = view === 'done' ? 'Done' : LABEL[ui.section];
    document.title = view === 'done' ? 'Done' : 'To-do';

    for (const b of document.querySelectorAll('#switcher button')) b.setAttribute('aria-selected', String(b.dataset.section === ui.section));
    for (const b of document.querySelectorAll('.nav-item')) {
      const on = view === 'done' ? b.dataset.section === 'done' : b.dataset.section === ui.section;
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      const c = b.querySelector('.count');
      if (c) { const n = openIn(b.dataset.section).length; c.textContent = n ? String(n) : ''; }
    }
    if ($('capture').hidden) $('capLabel').textContent = 'Adds to ' + LABEL[ui.section];

    const all = Object.values(items);
    const empty = $('empty');
    let html = '';
    let emptyText = '';

    if (!loaded && !all.length) {
      html = [1, 2, 3].map(() => '<li class="row skeleton" aria-hidden="true"><div class="row-inner"><span class="circle-static"></span><div class="bar"></div></div></li>').join('');
    } else if (view === 'list') {
      const rows = openIn(ui.section);
      html = rows.map((it) => rowHtml(it, justAdded.has(it.id))).join('');
      if (!rows.length) {
        emptyText = all.length ? EMPTY[ui.section]
          : desk.matches ? 'Nothing here yet. Press N or click plus to add a task.' : 'Nothing here yet. Tap plus to add a task.';
      }
    } else {
      const done = all.filter((i) => i.done).sort((a, b) => b.doneAt - a.doneAt);
      let last = '';
      for (const it of done.slice(0, doneShown)) {
        const label = dayLabel(it.doneAt);
        if (label !== last) { html += '<li class="dhead" aria-hidden="true">' + label + '</li>'; last = label; }
        const t = new Date(it.doneAt);
        html += '<li class="drow" data-id="' + it.id + '" tabindex="-1" role="button" aria-label="Reopen ' + esc(it.text) + '">' +
          '<span class="dcheck"><svg class="ic ic-2" width="16" height="16"><use href="#i-check"/></svg></span>' +
          '<div class="dbody"><div class="dtext">' + esc(it.text) + '</div><div class="meta">' + LABEL[it.section] + '</div></div>' +
          '<div class="meta dtime">' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + '</div></li>';
      }
      if (done.length > doneShown) html += '<li class="dmore" aria-hidden="true" style="height:1px"></li>';
      if (!done.length) emptyText = 'Done tasks will show up here.';
    }
    list.innerHTML = html;
    justAdded.clear();
    empty.hidden = !emptyText;
    empty.querySelector('p').textContent = emptyText;

    $('install').hidden = !(view === 'list' && showInstall());

    if (focusedId) {
      const el = list.querySelector('[data-id="' + focusedId + '"]');
      if (el) el.focus({ preventScroll: true });
    }
    const more = list.querySelector('.dmore');
    if (more) moreObserver.observe(more);
    maybeNudge();
  }

  const moreObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { doneShown += DONE_PAGE; render(); }
  });

  function maybeNudge() {
    if (ui.nudged || view !== 'list' || desk.matches || matchMedia('(hover: hover)').matches) return;
    const first = $('list').querySelector('.row:not(.skeleton)');
    if (!first) return;
    ui.nudged = true;
    saveUi();
    first.classList.add('nudge');
  }

  /* ---------- Install card (Safari on iPhone only, before install) ---------- */
  function isStandalone() {
    return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  }
  function showInstall() {
    if (ui.installOff) return false;
    if (isStandalone()) { ui.installOff = true; saveUi(); return false; }
    const ua = navigator.userAgent;
    return navigator.standalone === false && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  }
  $('installClose').addEventListener('click', () => { ui.installOff = true; saveUi(); render(); });

  /* ---------- Navigation ---------- */
  function setSection(s) {
    closeMenu();
    closeReveal();
    if (s === 'done') { view = 'done'; doneShown = DONE_PAGE; }
    else { view = 'list'; ui.section = s; saveUi(); }
    hideInline();
    render();
    window.scrollTo(0, 0);
  }
  for (const b of document.querySelectorAll('#switcher button, .nav-item')) {
    b.addEventListener('click', () => setSection(b.dataset.section));
  }
  $('historyBtn').addEventListener('click', () => setSection('done'));
  $('closeDone').addEventListener('click', () => setSection(ui.section));

  /* ---------- Toast ---------- */
  let toastTimer = 0;
  let undoFn = null;
  function toast(text, undo) {
    $('toastText').textContent = text;
    undoFn = undo;
    const t = $('toast');
    t.hidden = true;
    void t.offsetWidth; // restart the entrance
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, TOAST_MS);
  }
  function hideToast() { $('toast').hidden = true; undoFn = null; }
  $('toastUndo').addEventListener('click', () => { const f = undoFn; hideToast(); if (f) f(); });

  /* ---------- Row animations ---------- */
  let busy = false; // true while a row animates or a finger is on a row; renders wait
  function unbusy() {
    busy = false;
    if (renderQueued) render();
  }

  function collapse(row, then) {
    busy = true;
    const done = () => { unbusy(); then(); };
    if (reduced.matches) {
      row.style.transition = 'opacity 160ms ease';
      row.style.opacity = '0';
      return setTimeout(done, 170);
    }
    row.style.height = row.offsetHeight + 'px';
    row.classList.add('collapsing');
    void row.offsetHeight;
    row.style.height = '0px';
    row.style.opacity = '0';
    setTimeout(done, 210);
  }

  function completeRow(row) {
    const id = row.dataset.id;
    const circle = row.querySelector('.circle');
    circle.classList.add('checked');
    busy = true;
    setTimeout(() => collapse(row, () => markDone(id)), reduced.matches ? 120 : 200);
  }

  function slideOut(row, dir, then) {
    const inner = row.querySelector('.row-inner');
    busy = true;
    row.classList.add('sliding');
    if (reduced.matches) inner.style.opacity = '0';
    else inner.style.transform = 'translateX(' + (dir > 0 ? '100%' : '-100%') + ')';
    setTimeout(() => collapse(row, then), reduced.matches ? 120 : 200);
  }

  /* ---------- Swipe, long press, taps ---------- */
  const list = $('list');
  let g = null;             // the gesture in progress
  let revealed = null;      // the row showing its move buttons
  let swallowUntil = 0;     // taps right after a swipe, long press or menu close are not taps
  const swallow = (ms = 450) => { swallowUntil = Date.now() + ms; };

  function revealWidth(row) {
    return row.querySelector('.move-group').offsetWidth + 12;
  }
  function setX(row, x, animate) {
    const inner = row.querySelector('.row-inner');
    row.classList.toggle('sliding', !!animate);
    row.classList.toggle('swipe-r', x > 0);
    row.classList.toggle('swipe-l', x < 0);
    inner.style.transform = x ? 'translateX(' + x + 'px)' : '';
  }
  function closeReveal() {
    if (!revealed) return;
    const r = revealed;
    revealed = null;
    setX(r, 0, true);
    setTimeout(() => {
      if (revealed !== r) r.classList.remove('swipe-l', 'sliding');
      if (renderQueued && !busy && !revealed) render();
    }, 240);
  }

  list.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('skeleton') || e.button !== 0) return;
    if (revealed && revealed !== row) { closeReveal(); swallow(); return; }
    if (e.target.closest('.swipe-move button')) return;
    const touch = e.pointerType !== 'mouse';
    g = { row, id: row.dataset.id, x0: e.clientX, y0: e.clientY, x: 0, mode: null, pid: e.pointerId, touch,
      base: revealed === row ? -revealWidth(row) : 0, long: 0 };
    if (touch) {
      g.long = setTimeout(() => {
        if (g && !g.mode) { g.mode = 'long'; swallow(1500); openMenu(row); }
      }, 500);
    }
  });

  list.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.pid) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.mode) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      clearTimeout(g.long);
      if (g.touch && Math.abs(dx) > Math.abs(dy)) {
        g.mode = 'h';
        busy = true;
        try { g.row.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      } else {
        g = null;
        return;
      }
    }
    if (g.mode !== 'h') return;
    e.preventDefault();
    let x = g.base + dx;
    const w = g.row.offsetWidth;
    const rw = revealWidth(g.row);
    if (x < -rw) x = -rw - (-rw - x) * 0.25; // resist past the buttons
    if (x > w) x = w;
    g.x = x;
    setX(g.row, x, false);
    const armed = x > w * 0.4;
    if (armed !== g.row.classList.contains('armed')) {
      g.row.classList.toggle('armed', armed);
      g.row.querySelector('.circle').classList.toggle('checked', armed);
    }
  });

  function endGesture(e, cancelled) {
    if (!g || (e && e.pointerId !== g.pid)) return;
    const cur = g;
    g = null;
    clearTimeout(cur.long);
    if (cur.mode === 'long') { swallow(400); return; }
    if (cur.mode !== 'h') return;
    swallow(300);
    const row = cur.row;
    const w = row.offsetWidth;
    const rw = revealWidth(row);
    if (!cancelled && cur.x > w * 0.4) {
      revealed = null;
      setX(row, w, true);
      setTimeout(() => collapse(row, () => markDone(cur.id)), 180);
      return;
    }
    row.classList.remove('armed');
    row.querySelector('.circle').classList.remove('checked');
    if (!cancelled && cur.x < -rw / 2) {
      setX(row, -rw, true);
      revealed = row;
    } else {
      setX(row, 0, true);
      if (revealed === row) revealed = null;
      setTimeout(() => row.classList.remove('swipe-r', 'swipe-l', 'sliding'), 240);
    }
    unbusy();
  }
  list.addEventListener('pointerup', (e) => endGesture(e, false));
  list.addEventListener('pointercancel', (e) => endGesture(e, true));

  list.addEventListener('click', (e) => {
    if (Date.now() < swallowUntil) return;
    if (view === 'done') {
      const d = e.target.closest('.drow');
      if (d) reopen(d.dataset.id);
      return;
    }
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('skeleton')) return;
    const mv = e.target.closest('.swipe-move button');
    if (mv) {
      if (mv.hasAttribute('aria-current')) { closeReveal(); return; }
      revealed = null;
      slideOut(row, -1, () => moveTo(row.dataset.id, mv.dataset.move));
      return;
    }
    if (revealed === row) { closeReveal(); return; }
    if (e.target.closest('.circle')) { completeRow(row); return; }
    if (e.target.closest('.move-btn')) { openMenu(row, e.target.closest('.move-btn')); return; }
    openEdit(row.dataset.id);
  });

  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('skeleton') || view !== 'list') return;
    e.preventDefault();
    if (g && g.touch) return; // long press already handled it
    openMenu(row, null, e.clientX, e.clientY);
  });

  /* ---------- Drag a row onto a sidebar section (desktop) ---------- */
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.dataTransfer.setData('application/x-todo-id', row.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  for (const nav of document.querySelectorAll('.nav-item')) {
    const s = nav.dataset.section;
    if (!SECTIONS.includes(s)) continue;
    nav.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-todo-id')) { e.preventDefault(); nav.classList.add('drop'); }
    });
    nav.addEventListener('dragleave', () => nav.classList.remove('drop'));
    nav.addEventListener('drop', (e) => {
      nav.classList.remove('drop');
      const id = e.dataTransfer.getData('application/x-todo-id');
      if (id) { e.preventDefault(); moveTo(id, s); }
    });
  }

  /* ---------- Move menu (long press, right click, move icon) ---------- */
  const menu = $('menu');
  let menuRow = null;
  function openMenu(row, anchor, x, y) {
    closeReveal();
    const it = items[row.dataset.id];
    if (!it) return;
    menuRow = row;
    row.classList.add('menu-open');
    menu.innerHTML = '<div class="meta menu-title">Move to</div>' + SECTIONS.map((s) =>
      '<button class="sec" role="menuitem" data-move="' + s + '"' + (s === it.section ? ' aria-current="true"' : '') + '>' + LABEL[s] + '</button>').join('');
    menu.hidden = false;
    const r = (anchor || row).getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = x !== undefined ? x : anchor ? r.right - mw : Math.min(r.left + 56, innerWidth - mw - 16);
    let top = y !== undefined ? y : r.bottom + 4;
    if (top + mh > innerHeight - 16) top = (y !== undefined ? y : r.top) - mh - 4;
    menu.style.left = Math.max(12, Math.min(left, innerWidth - mw - 12)) + 'px';
    menu.style.top = Math.max(12, top) + 'px';
    const first = menu.querySelector('button.sec:not([aria-current])');
    if (first && !(g && g.touch)) first.focus({ preventScroll: true });
    busy = true;
  }
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    if (menuRow) menuRow.classList.remove('menu-open');
    menuRow = null;
    unbusy();
  }
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button.sec');
    if (!b) return;
    const row = menuRow;
    closeMenu();
    if (!row || b.hasAttribute('aria-current')) return;
    slideOut(row, -1, () => moveTo(row.dataset.id, b.dataset.move));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) {
      closeMenu();
      swallow(400);
    }
  }, true);

  /* ---------- Sheets ---------- */
  function openSheet(wrap) {
    wrap.hidden = false;
    const sheet = wrap.querySelector('.sheet');
    sheet.style.transform = '';
    sheet.classList.remove('closing');
    placeSheet();
  }
  function closeSheet(wrap, after) {
    if (wrap.hidden) return;
    const sheet = wrap.querySelector('.sheet');
    if (desk.matches || reduced.matches) { wrap.hidden = true; if (after) after(); return; }
    sheet.classList.add('closing');
    sheet.style.transform = 'translateY(100%)';
    setTimeout(() => { wrap.hidden = true; sheet.classList.remove('closing'); sheet.style.transform = ''; if (after) after(); }, 180);
  }

  // Keep the open sheet above the iPhone keyboard.
  function placeSheet() {
    const vv = window.visualViewport;
    const off = vv && !desk.matches ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0;
    for (const s of document.querySelectorAll('.sheet')) s.style.bottom = desk.matches ? '' : off + 'px';
  }
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', placeSheet);
    visualViewport.addEventListener('scroll', placeSheet);
  }

  // Swipe a sheet down to close it.
  for (const wrap of [$('capture'), $('edit')]) {
    const sheet = wrap.querySelector('.sheet');
    let s = null;
    sheet.addEventListener('pointerdown', (e) => {
      if (desk.matches || e.target.closest('textarea, input, button')) return;
      s = { y0: e.clientY, dy: 0, pid: e.pointerId };
      sheet.setPointerCapture(e.pointerId);
      sheet.classList.add('dragging');
    });
    sheet.addEventListener('pointermove', (e) => {
      if (!s || e.pointerId !== s.pid) return;
      s.dy = Math.max(0, e.clientY - s.y0);
      sheet.style.transform = 'translateY(' + s.dy + 'px)';
    });
    const end = () => {
      if (!s) return;
      sheet.classList.remove('dragging');
      const far = s.dy > 70;
      s = null;
      if (far) (wrap.id === 'edit' ? closeEdit : closeCapture)();
      else { sheet.classList.add('closing'); sheet.style.transform = ''; }
    };
    sheet.addEventListener('pointerup', end);
    sheet.addEventListener('pointercancel', end);
    wrap.querySelector('.scrim').addEventListener('click', () => (wrap.id === 'edit' ? closeEdit : closeCapture)());
  }

  /* ---------- Capture ---------- */
  const capInput = $('capInput');
  function openAdd() {
    if (view !== 'list') setSection(ui.section);
    if (desk.matches) return showInline();
    capInput.value = '';
    capAdded = [];
    showCapAdded();
    openSheet($('capture'));
    capInput.focus(); // inside the tap, so iOS brings the keyboard up
  }
  // What Return just saved stays in the sheet, ticked, so a cleared field reads as saved.
  let capAdded = [];
  function showCapAdded() {
    $('capAdded').innerHTML = capAdded.slice(-3).map((t) =>
      '<li><span class="ok"><svg class="ic ic-2" width="16" height="16"><use href="#i-check"/></svg></span><span class="t">' + esc(t) + '</span></li>').join('');
    $('capLabel').textContent = capAdded.length
      ? 'Added to ' + LABEL[ui.section]
      : 'Adds to ' + LABEL[ui.section];
  }
  let capClosing = false;
  function closeCapture() {
    if (capClosing || $('capture').hidden) return; // Escape, a tap outside and a swipe can all arrive
    capClosing = true;
    const v = cleanText(capInput.value);
    capInput.value = '';
    capInput.blur();
    closeSheet($('capture'), () => { capClosing = false; if (v) addTask(v); });
  }
  capInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const v = cleanText(capInput.value);
      if (!v) return closeCapture(); // Return on an empty field means finished
      addTask(v);
      capAdded.push(v);
      showCapAdded();
      capInput.value = '';
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeCapture();
    }
  });
  $('fab').addEventListener('click', openAdd);
  $('capDone').addEventListener('click', closeCapture);
  $('addDesk').addEventListener('click', () => ($('inlineAdd').hidden ? showInline() : hideInline()));

  const inlineInput = $('inlineInput');
  function showInline() {
    $('inlineAdd').hidden = false;
    inlineInput.focus();
  }
  function hideInline() {
    if (document.activeElement === inlineInput) inlineInput.blur();
    $('inlineAdd').hidden = true;
    inlineInput.value = '';
  }
  inlineInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      addTask(inlineInput.value);
      inlineInput.value = '';
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      hideInline();
    }
  });
  inlineInput.addEventListener('blur', () => { if (!inlineInput.value.trim()) setTimeout(() => { if (document.activeElement !== inlineInput) hideInline(); }, 150); });

  /* ---------- Edit ---------- */
  const editText = $('editText');
  let editId = null;
  let editTimer = 0;
  function openEdit(id) {
    const it = items[id];
    if (!it) return;
    editId = id;
    editText.value = it.text;
    paintEditSeg(it.section);
    openSheet($('edit'));
    if (desk.matches) { editText.focus(); editText.setSelectionRange(editText.value.length, editText.value.length); }
  }
  function paintEditSeg(section) {
    for (const b of document.querySelectorAll('#editSeg button')) b.setAttribute('aria-checked', String(b.dataset.section === section));
  }
  function saveEditText() {
    clearTimeout(editTimer);
    const it = items[editId];
    const t = cleanText(editText.value);
    if (it && t && t !== it.text) upsert(Object.assign({}, it, { text: t }));
  }
  function closeEdit() {
    if (editId === null) return; // already closing
    saveEditText();
    editText.blur();
    const id = editId;
    editId = null;
    closeSheet($('edit'), () => {
      const row = list.querySelector('.row[data-id="' + id + '"]');
      if (row && desk.matches) row.focus({ preventScroll: true });
    });
  }
  editText.addEventListener('input', () => {
    clearTimeout(editTimer);
    editTimer = setTimeout(saveEditText, 400);
  });
  editText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); closeEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEdit(); }
  });
  $('editClose').addEventListener('click', closeEdit);
  for (const b of document.querySelectorAll('#editSeg button')) {
    b.addEventListener('click', () => {
      const it = items[editId];
      if (!it || it.section === b.dataset.section) return;
      saveEditText();
      moveTo(editId, b.dataset.section, false);
      paintEditSeg(b.dataset.section);
    });
  }
  $('editDelete').addEventListener('click', () => {
    $('confirm').hidden = false;
    $('confirmCancel').focus();
  });
  $('confirmCancel').addEventListener('click', () => { $('confirm').hidden = true; });
  $('confirmDelete').addEventListener('click', () => {
    $('confirm').hidden = true;
    const id = editId;
    clearTimeout(editTimer);
    editId = null;
    closeSheet($('edit'), () => remove(id));
  });

  /* ---------- Keyboard (desktop) ---------- */
  function rows() { return Array.from(list.querySelectorAll(view === 'done' ? '.drow' : '.row:not(.skeleton)')); }
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (!$('confirm').hidden) { $('confirm').hidden = true; return; }
      if (!menu.hidden) { closeMenu(); return; }
      if (!$('edit').hidden) { closeEdit(); return; }
      if (!$('capture').hidden) { closeCapture(); return; }
      closeReveal();
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || !$('edit').hidden || !$('capture').hidden || !$('confirm').hidden) return;
    if (!menu.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const bs = Array.from(menu.querySelectorAll('button.sec'));
        const i = bs.indexOf(document.activeElement);
        bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus();
        e.preventDefault();
      }
      return;
    }
    const k = e.key;
    if (k === 'n' || k === 'N') { e.preventDefault(); openAdd(); return; }
    if (k === '1' || k === '2' || k === '3') { setSection(SECTIONS[Number(k) - 1]); return; }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      const rs = rows();
      if (!rs.length) return;
      e.preventDefault();
      const cur = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.row, .drow') : null;
      let i = rs.indexOf(cur);
      i = i < 0 ? (k === 'ArrowDown' ? 0 : rs.length - 1) : Math.max(0, Math.min(rs.length - 1, i + (k === 'ArrowDown' ? 1 : -1)));
      rs[i].focus();
      rs[i].scrollIntoView({ block: 'nearest' });
      return;
    }
    const focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.row, .drow') : null;
    if (!focused) return;
    if (view === 'done' && (k === 'Enter' || k === ' ')) { e.preventDefault(); reopen(focused.dataset.id); return; }
    if (k === 'Enter' && e.target === focused) { e.preventDefault(); openEdit(focused.dataset.id); return; }
    if (k === ' ' && e.target === focused) {
      e.preventDefault();
      const next = focused.nextElementSibling || focused.previousElementSibling;
      completeRow(focused);
      if (next) setTimeout(() => { const n = list.querySelector('[data-id="' + next.dataset.id + '"]'); if (n) n.focus({ preventScroll: true }); }, 450);
    }
  });

  /* ---------- Life cycle ---------- */
  let pollTimer = 0;
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(pollTimer);
      if (st.queue.length) flush(true); // send before iOS freezes the page
    } else {
      poll();
      startPolling();
    }
  });
  window.addEventListener('online', () => { flush(); poll(); });
  window.addEventListener('offline', () => setNet('offline'));
  $('retry').addEventListener('click', () => { rejectNote = false; flush(); poll(); });
  desk.addEventListener('change', () => { hideInline(); render(); });

  computeView();
  render();
  if (!navigator.onLine) setNet('offline');
  poll();
  if (st.queue.length) scheduleFlush(300);
  startPolling();

  if ('serviceWorker' in navigator && (!isLocal || params.has('sw'))) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
