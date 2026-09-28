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

  /* ---------- Motion (the tokens live in app.css) ---------- */
  const M = {};
  function readMotion() {
    const cs = getComputedStyle(document.documentElement);
    const num = (name, d) => { const v = parseFloat(cs.getPropertyValue(name)); return isNaN(v) ? d : v; };
    M.press = num('--dur-press', 140);
    M.move = num('--dur-move', 220);
    M.exit = num('--dur-exit', 180);
    M.dist = num('--dist', 1); // 0 under reduced motion, so slides become fades
    M.ease = cs.getPropertyValue('--ease').trim() || 'ease-out';
    M.reduced = reduced.matches;
  }
  readMotion();
  reduced.addEventListener('change', readMotion);

  // Resolves true when the animation ran to its end and false when it was cut short,
  // so a cancelled animation never throws and never leaves a lock behind.
  function play(el, frames, o) {
    const a = el.animate(frames, Object.assign({ duration: M.move, easing: M.ease }, o));
    const p = a.finished.then(() => true, () => false);
    p.anim = a;
    return p;
  }
  // An exit keeps its last frame until the caller hides the element and calls rest().
  const exits = new WeakMap();
  function leave(el, frames, o) {
    rest(el);
    const p = play(el, frames, Object.assign({ duration: M.exit, fill: 'forwards' }, o));
    exits.set(el, p.anim);
    return p.then((ok) => ok && exits.get(el) === p.anim);
  }
  function rest(el) {
    const a = exits.get(el);
    if (!a) return;
    exits.delete(el);
    a.cancel();
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Speed over the last 100ms of samples ({ t, v }), in px per ms. A finger held still reads 0.
  function speed(pts) {
    const t = performance.now();
    const p = pts.filter((s) => t - s.t <= 100);
    if (p.length < 2) return 0;
    const a = p[0], b = p[p.length - 1];
    return (b.v - a.v) / Math.max(1, b.t - a.t);
  }
  function sample(pts, v) {
    const t = performance.now();
    pts.push({ t, v });
    while (pts.length && t - pts[0].t > 100) pts.shift();
  }

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
    toast('Done.', () => upsert(prev), id);
  }

  function moveTo(id, section, withToast = true) {
    const it = items[id];
    if (!it || it.section === section) return;
    const prev = Object.assign({}, it);
    upsert(Object.assign({}, it, { section, pos: now() }));
    if (withToast) toast('Moved to ' + LABEL[section] + '.', () => upsert(prev), id);
  }

  function reopen(id) {
    const it = items[id];
    if (!it || !it.done) return;
    const prev = Object.assign({}, it);
    upsert(Object.assign({}, it, { done: false, doneAt: null, pos: now() }));
    toast('Reopened in ' + LABEL[it.section] + '.', () => upsert(prev), id);
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
      // One draw for both: drawn between them, the old server copy would bring back rows the
      // batch just changed, and the next draw would collapse them a second time.
      dropSent(sent);
      if (!applyServer(d)) { computeView(); render(); }
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

  // Returns true when it took the answer (and drew it).
  function applyServer(d) {
    if (!d || !Array.isArray(d.items)) return false;
    if (typeof d.rev === 'number' && d.rev < st.rev) return false; // an older answer arriving late
    const m = {};
    for (const i of d.items) m[i.id] = i;
    st.server = m;
    st.rev = d.rev || 0;
    save();
    computeView();
    render();
    return true;
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
    rest(pill); // a fade on its way out stops here
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
        leave(pill, [{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: 'ease' }).then((ok) => {
          if (!ok) return;
          pill.hidden = true;
          rest(pill);
          net = 'idle';
        });
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

  // The chrome (title, counts, controls) always updates at once. The list waits while a
  // row animates out, a finger is on a row, the move menu is open or a row shows its
  // move buttons, so nothing is rebuilt under a gesture.
  let renderQueued = false;
  function render() {
    // A reveal on a task that is gone, done or moved elsewhere lets go, so it can not hold the list.
    if (revealed) {
      const it = items[revealed.dataset.id];
      if (!it || it.done || view !== 'list' || it.section !== ui.section) closeReveal();
    }
    renderChrome();
    if (leaving.size || pressed || menuRow || revealed) { renderQueued = true; return; }
    renderQueued = false;
    renderList();
  }

  function renderChrome() {
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
    $('install').hidden = !(view === 'list' && showInstall());
  }

  let lastHtml = null;     // the list as last written, without the entrance class; null after a row got inline styles
  let shownKey = '';       // what the list shows: 'skeleton', 'done' or a section
  let pendingFocus = null; // a row id that takes focus in the next write (Undo pressed from the keyboard)
  const byId = (id) => $('list').querySelector('[data-id="' + CSS.escape(id) + '"]');
  // The next row that stays, else the one above: where focus goes when a row leaves.
  function neighbour(el) {
    const stays = (n) => n.dataset.id && !gone(n);
    let n = el.nextElementSibling;
    while (n && !stays(n)) n = n.nextElementSibling;
    if (!n) {
      n = el.previousElementSibling;
      while (n && !stays(n)) n = n.previousElementSibling;
    }
    return n ? n.dataset.id : null;
  }

  function renderList() {
    const list = $('list');
    const all = Object.values(items);
    const empty = $('empty');
    let html = '';
    let emptyText = '';
    let key = view === 'done' ? 'done' : ui.section;
    let ids = null; // the open rows about to show (list view only)

    if (!loaded && !all.length) {
      key = 'skeleton';
      html = [1, 2, 3].map(() => '<li class="row skeleton" aria-hidden="true"><div class="row-inner"><span class="circle-static"></span><div class="bar"></div></div></li>').join('');
    } else if (view === 'list') {
      const rows = openIn(ui.section);
      ids = new Set(rows.map((it) => it.id));
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

    const same = key === shownKey; // no section switch, skeleton or first paint: changes animate
    // A row that left without an exit of its own (a poll, an Undo, a delete) collapses first.
    // The list is written once it is gone, like every other row that leaves.
    if (same && ids) {
      const out = Array.from(list.querySelectorAll('.row[data-id]')).filter((r) => !ids.has(r.dataset.id) && !r.classList.contains('collapsing'));
      if (out.length) {
        for (const r of out) {
          const unlock = lock(r.dataset.id);
          collapse(r).finally(unlock);
        }
        renderQueued = true;
        return;
      }
    }

    const emptyWas = !empty.hidden;
    empty.hidden = !emptyText;
    empty.querySelector('p').textContent = emptyText;
    // The empty state arrives a moment after the last row has gone, rising 4px.
    if (same && emptyText && !emptyWas) {
      play(empty, [{ opacity: 0, transform: 'translateY(' + 4 * M.dist + 'px)' }, { opacity: 1, transform: 'none' }], { delay: 60, fill: 'backwards' });
    }
    const cmp = html.replace(/ class="row enter"/g, ' class="row"');
    if (same && cmp === lastHtml) { justAdded.clear(); return; } // nothing changed: a running entrance plays on

    const a = document.activeElement;
    const focused = a && a.closest ? a.closest('#list > [data-id]') : null;
    const free = !a || a === document.body || menu.contains(a) || toastEl.contains(a);
    const order = Array.from(list.children, (el) => el.dataset.id).filter(Boolean);
    // First: where each row stands now. A collapsed row counts as gone, so an Undo fades it back in.
    const tops = new Map();
    if (same && ids) {
      for (const r of list.querySelectorAll('.row[data-id]')) {
        if (!r.classList.contains('collapsing')) tops.set(r.dataset.id, r.getBoundingClientRect().top);
      }
    }

    const from = shownKey;
    list.innerHTML = html;
    lastHtml = cmp;
    shownKey = key;
    justAdded.clear();
    if (from && !same) handOff(from, key);

    // Last, invert, play: rows that stay glide from where they stood, new rows fade in.
    // Rows with .enter already have their entrance.
    if (same && ids) {
      for (const r of list.querySelectorAll('.row[data-id]')) {
        if (r.classList.contains('enter')) continue;
        const top = tops.get(r.dataset.id);
        if (top === undefined) {
          play(r, [{ opacity: 0, transform: 'translateY(' + -8 * M.dist + 'px)' }, { opacity: 1, transform: 'none' }]);
        } else if (!M.reduced) {
          const dy = top - r.getBoundingClientRect().top;
          if (Math.abs(dy) >= 1) play(r, [{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }]);
        }
      }
    }

    // Focus stays on its row, or moves to the row next to the one that left.
    let target = pendingFocus && free ? byId(pendingFocus) : null;
    if (!target && focused) {
      target = byId(focused.dataset.id);
      const i = order.indexOf(focused.dataset.id);
      for (let j = i + 1; !target && j < order.length; j++) target = byId(order[j]);
      for (let j = i - 1; !target && j >= 0; j--) target = byId(order[j]);
    }
    if (target) target.focus({ preventScroll: true });
    pendingFocus = null;

    const more = list.querySelector('.dmore');
    if (more) moreObserver.observe(more);
    maybeNudge();
  }

  // The list's content changed wholesale. A section switch fades it in with no slide and no
  // outgoing phase; the skeleton gives way to all rows at once. The first paint and the Done
  // layer (setSection) do not come through here.
  function handOff(from, key) {
    if (from === 'done' || key === 'done' || key === 'skeleton') return;
    const duration = from === 'skeleton' ? M.exit : M.move;
    for (const el of [$('list'), $('empty')]) {
      if (!el.hidden) play(el, [{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'ease' });
    }
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
    lastHtml = null;
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
    dropGesture();
    // Rows still leaving are cut short: their ops are already written.
    for (const t of leaving.values()) clearTimeout(t);
    leaving.clear();
    const was = view;
    // Leaving Done: a still copy of it stays on top and sinks away over the list.
    const ghost = was === 'done' && s !== 'done' && shownKey === 'done' ? liftCol() : null;
    if (s === 'done') { view = 'done'; doneShown = DONE_PAGE; }
    else { view = 'list'; ui.section = s; saveUi(); }
    hideInline(true);
    render();
    window.scrollTo(0, 0);
    if (was !== view) layer(view === 'done', ghost);
  }

  // Done is a layer above the list. It rises 12px and fades in while the add button and the
  // switcher fade out; closing it plays the reverse. Reduced motion: opacity only (--dist).
  let colGhost = null;
  function liftCol() {
    const col = document.querySelector('.col');
    const r = col.getBoundingClientRect();
    const lc = getComputedStyle($('list'));
    const gh = col.cloneNode(true);
    // What shows in Done stays shown once the body says list, and no id is left twice.
    for (const el of gh.querySelectorAll('.list-only, [hidden]')) el.remove();
    for (const el of gh.querySelectorAll('.done-only')) el.classList.remove('done-only');
    for (const el of gh.querySelectorAll('[id]')) el.removeAttribute('id');
    const gl = gh.querySelector('.list');
    if (gl) { gl.style.display = lc.display; gl.style.padding = lc.padding; }
    gh.classList.add('col-ghost');
    gh.setAttribute('aria-hidden', 'true');
    gh.inert = true;
    Object.assign(gh.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: Math.max(0, innerHeight - r.top) + 'px' });
    return gh;
  }
  function layer(open, ghost) {
    const col = document.querySelector('.col');
    const bar = desk.matches ? [] : [$('fab'), $('switcher')];
    const y = 'translateY(' + 12 * M.dist + 'px)';
    if (colGhost) { colGhost.remove(); colGhost = null; }
    if (open) {
      play(col, [{ opacity: 0, transform: y }, { opacity: 1, transform: 'none' }]);
      for (const el of bar) {
        el.classList.add('layer-out'); // shown while it fades, though the body says Done
        leave(el, [{ opacity: 1 }, { opacity: 0 }], { easing: 'ease' }).then((ok) => {
          if (!ok) return;
          el.classList.remove('layer-out');
          rest(el);
        });
      }
      return;
    }
    for (const el of bar) {
      rest(el);
      el.classList.remove('layer-out');
      play(el, [{ opacity: 0 }, { opacity: 1 }], { easing: 'ease' });
    }
    if (!ghost) return;
    colGhost = ghost;
    document.body.append(ghost);
    play(ghost, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: y }], { duration: M.exit, fill: 'forwards' }).then(() => {
      ghost.remove();
      if (colGhost === ghost) colGhost = null;
    });
  }
  for (const b of document.querySelectorAll('#switcher button, .nav-item')) {
    b.addEventListener('click', () => setSection(b.dataset.section));
  }
  $('historyBtn').addEventListener('click', () => setSection('done'));
  $('closeDone').addEventListener('click', () => setSection(ui.section));

  /* ---------- Toast ---------- */
  const toastEl = $('toast');
  let toastTimer = 0;
  let toastOn = false;
  let undoFn = null;
  let undoId = null;
  const toastHeld = { pointer: false, focus: false }; // the timer waits while either is true
  function toast(text, undo, id) {
    const tx = $('toastText');
    undoFn = undo;
    undoId = id || null;
    if (toastOn && !toastEl.hidden) {
      // Already up: only the words change.
      tx.textContent = text;
      play(tx, [{ opacity: 0 }, { opacity: 1 }], { duration: M.press, easing: 'ease' });
    } else if (!toastEl.hidden) {
      // Caught on its way out: it comes back from where it is.
      const cs = getComputedStyle(toastEl);
      const from = { opacity: cs.opacity, translate: cs.translate };
      rest(toastEl);
      tx.textContent = text;
      play(toastEl, [from, { opacity: 1, translate: '0 0' }], { duration: M.press });
    } else {
      tx.textContent = text;
      toastEl.hidden = false; // the entrance is toast-in in app.css
    }
    toastOn = true;
    toastEl.classList.remove('leaving');
    armToast(TOAST_MS);
  }
  function armToast(ms) {
    clearTimeout(toastTimer);
    if (!toastHeld.pointer && !toastHeld.focus) toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    undoFn = null;
    undoId = null;
    toastHeld.pointer = toastHeld.focus = false;
    if (!toastOn) return;
    toastOn = false;
    if (toastEl.hidden) return;
    toastEl.classList.add('leaving');
    leave(toastEl, [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 ' + 8 * M.dist + 'px' }]).then((ok) => {
      if (!ok) return;
      toastEl.hidden = true;
      toastEl.classList.remove('leaving');
      rest(toastEl);
    });
  }
  // A finger, the pointer or focus on the toast holds it; letting go leaves 2 seconds.
  function holdToast(k, on) {
    const was = toastHeld.pointer || toastHeld.focus;
    toastHeld[k] = on;
    if (!toastOn) return;
    if (on) clearTimeout(toastTimer);
    else if (was && !toastHeld.pointer && !toastHeld.focus) armToast(2000);
  }
  toastEl.addEventListener('pointerenter', () => holdToast('pointer', true));
  toastEl.addEventListener('pointerdown', () => holdToast('pointer', true));
  toastEl.addEventListener('pointerleave', () => holdToast('pointer', false));
  toastEl.addEventListener('focusin', () => holdToast('focus', true));
  toastEl.addEventListener('focusout', (e) => { if (!toastEl.contains(e.relatedTarget)) holdToast('focus', false); });
  $('toastUndo').addEventListener('click', () => {
    const f = undoFn;
    const id = undoId;
    if (!f) return;
    // Focus in the toast goes to the task the Undo brings back, or next to the one it takes away.
    if (id && toastEl.contains(document.activeElement)) {
      const el = byId(id);
      pendingFocus = !el || gone(el) ? id : neighbour(el);
    }
    hideToast();
    f();
  });

  /* ---------- Row animations ---------- */
  // The op is written at the tap. A leaving lock then keeps the old row on screen while
  // it plays its exit, and the list is redrawn once no row is leaving.
  const leaving = new Map(); // id -> failsafe timer
  let pressed = null;        // id of the row under a finger
  function lock(id) {
    clearTimeout(leaving.get(id));
    // Failsafe: a lost animation or a page frozen by iOS never blocks the list for good.
    const t = setTimeout(() => unlock(id, t), 1000);
    leaving.set(id, t);
    return () => unlock(id, t);
  }
  function unlock(id, t) {
    if (leaving.get(id) !== t) return; // already dropped, or taken again since
    clearTimeout(t);
    leaving.delete(id);
    if (renderQueued) render();
  }
  // A row on its way out takes no more taps.
  function gone(row) {
    return !row.isConnected || leaving.has(row.dataset.id) || row.classList.contains('collapsing') || !!row.querySelector('.circle.checked');
  }
  // A finger or the menu let go of the list. Draw what waited a moment later, so the
  // click that follows a pointerup still finds its row.
  let wakeTimer = 0;
  function wake() {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => { if (renderQueued) render(); }, 100);
  }
  function release() {
    if (!pressed) return;
    pressed = null;
    wake();
  }

  // The row closes to nothing (reduced motion: it fades). The end state is written inline
  // and the animation plays from the old one, so a cut animation still leaves it closed.
  function collapse(row) {
    if (!row.isConnected) return Promise.resolve(false);
    lastHtml = null;
    row.classList.add('collapsing');
    if (M.reduced) {
      row.style.opacity = '0';
      return play(row, [{ opacity: 1 }, { opacity: 0 }], { duration: M.exit, easing: 'ease' });
    }
    const cs = getComputedStyle(row);
    const from = { height: row.offsetHeight + 'px', opacity: 1 };
    const to = { height: '0px', opacity: 0 };
    // Done rows and day headers carry padding and a hairline, which a height of 0 can not close.
    for (const k of ['paddingTop', 'paddingBottom', 'borderTopWidth']) {
      if (parseFloat(cs[k])) { from[k] = cs[k]; to[k] = '0px'; }
    }
    Object.assign(row.style, to);
    return play(row, [from, to]);
  }

  // Reopen mirrors the check: the tick drains to an empty ring and the text comes back, then
  // the row closes, with its day header if nothing is left under it. Written at the tap.
  function reopenRow(d) {
    const id = d.dataset.id;
    if (!d.isConnected || leaving.has(id) || d.classList.contains('reopening') || d.classList.contains('collapsing')) return;
    const unlock = lock(id);
    lastHtml = null;
    d.classList.add('reopening');
    reopen(id);
    // The drain (--dur-press), a short rest so the open ring registers, then the collapse.
    sleep(M.press + 80).then(() => {
      const it = items[id];
      if (it && it.done) { d.classList.remove('reopening'); return; } // Undo came during the drain
      const head = orphanHead(d);
      return Promise.all([collapse(d), head ? collapse(head) : null]);
    }).finally(unlock);
  }
  // The day header above a done row, when every other row under it is leaving too.
  function orphanHead(d) {
    const stays = (n) => n.classList.contains('drow') && !gone(n) && !n.classList.contains('reopening');
    let h = d.previousElementSibling;
    while (h && !h.classList.contains('dhead')) { if (stays(h)) return null; h = h.previousElementSibling; }
    let n = d.nextElementSibling;
    while (n && n.classList.contains('drow')) { if (stays(n)) return null; n = n.nextElementSibling; }
    return h && !h.classList.contains('collapsing') ? h : null;
  }

  // The check: the circle fills, the tick draws, the text dims and is struck through, the row
  // rests a moment, then collapses. Tap to collapse is HOLD at most. The op is written at the tap.
  const HOLD = 360;
  const DRAW = 180;
  function completeRow(row) {
    if (gone(row)) return false; // a double tap or Space twice runs once
    const id = row.dataset.id;
    const unlock = lock(id);
    lastHtml = null;
    row.classList.add('ticked');
    row.querySelector('.circle').classList.add('checked');
    markDone(id);
    const ic = row.querySelector('.circle .ic');
    const draw = M.reduced ? M.press : DRAW;
    const drawn = M.reduced
      ? play(ic, [{ opacity: 0 }, { opacity: 1 }], { duration: draw, easing: 'ease' })
      : play(ic, [{ strokeDashoffset: '20' }, { strokeDashoffset: '0' }], { duration: draw });
    play(row.querySelector('.text'), [{ textDecorationColor: 'transparent' }, { textDecorationColor: 'currentcolor' }], { duration: M.press, easing: 'ease' });
    drawn.then(() => sleep(HOLD - draw)).then(() => {
      const it = items[id];
      if (it && !it.done) {
        // Undo came during the hold: the row stays.
        row.classList.remove('ticked');
        row.querySelector('.circle').classList.remove('checked');
        return;
      }
      return collapse(row);
    }).finally(unlock);
    return true;
  }

  // Menu, reveal and sidebar moves: the row slides out to the left, then collapses.
  function slideOut(row, dir) {
    if (gone(row)) return false;
    const unlock = lock(row.dataset.id);
    lastHtml = null;
    const inner = row.querySelector('.row-inner');
    const from = getComputedStyle(inner).transform;
    stopSlide(inner);
    row.classList.add('sliding');
    let slid;
    if (M.reduced) {
      inner.style.opacity = '0';
      slid = play(inner, [{ opacity: 1 }, { opacity: 0 }], { duration: M.exit, easing: 'ease' });
    } else {
      const to = 'translateX(' + (dir > 0 ? '100%' : '-100%') + ')';
      inner.style.transform = to;
      slid = play(inner, [{ transform: from }, { transform: to }]);
    }
    slid.then(() => collapse(row)).finally(unlock);
    return true;
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
  // Puts the row's content at x. Animated, it glides from where it is now and resolves
  // true when it lands (false when a newer move took over).
  const slides = new WeakMap(); // .row-inner -> its running glide
  function stopSlide(inner) {
    const a = slides.get(inner);
    if (!a) return;
    slides.delete(inner);
    a.cancel();
  }
  // A settle takes longer the further the row still has to go: 140 to 240ms.
  const settleMs = (d, w) => Math.round(M.press + (240 - M.press) * Math.min(1, Math.abs(d) / Math.max(1, w)));
  function setX(row, x, animate, duration) {
    lastHtml = null;
    const inner = row.querySelector('.row-inner');
    const from = animate ? getComputedStyle(inner).transform : 'none';
    stopSlide(inner);
    const to = x ? 'translateX(' + x + 'px)' : '';
    inner.style.transform = to;
    // Gliding home, the swipe background stays under the row until it lands.
    const home = animate && !x;
    if (!home) {
      row.classList.toggle('swipe-r', x > 0);
      row.classList.toggle('swipe-l', x < 0);
    }
    if (!animate || M.reduced || from === (to || 'none')) {
      row.classList.remove('sliding');
      if (home) row.classList.remove('swipe-r', 'swipe-l');
      return Promise.resolve(true);
    }
    row.classList.add('sliding');
    const p = play(inner, [{ transform: from }, { transform: to || 'none' }], duration ? { duration } : undefined);
    slides.set(inner, p.anim);
    return p.then((ok) => {
      if (!ok || slides.get(inner) !== p.anim) return false;
      slides.delete(inner);
      row.classList.remove('sliding');
      if (home && !inner.style.transform) row.classList.remove('swipe-r', 'swipe-l');
      return true;
    });
  }
  let revealY = 0; // the scroll position when the row opened its move buttons
  function closeReveal() {
    if (!revealed) return;
    const r = revealed;
    revealed = null;
    setX(r, 0, true).then(() => { if (renderQueued) render(); });
  }
  // A still finger lights the row up like an iOS cell; moving or letting go clears it.
  function unpress(gs) {
    if (!gs) return;
    clearTimeout(gs.lit);
    gs.row.classList.remove('pressing');
  }
  // The gesture ends without a swipe or a tap (a scroll, a view change, a lost row).
  function dropGesture() {
    if (g) { clearTimeout(g.long); unpress(g); }
    g = null;
    release();
  }

  // Paul moves on: a scroll, a touch anywhere else or the app going away closes an open reveal.
  let scrolledAt = -Infinity;
  window.addEventListener('scroll', () => {
    scrolledAt = performance.now();
    if (revealed && Math.abs(scrollY - revealY) > 8) closeReveal();
  }, { passive: true });
  let revealTap = null; // the pointerdown that only closed a reveal
  document.addEventListener('pointerdown', (e) => {
    if (!revealed || revealed.contains(e.target)) return;
    revealTap = e;
    closeReveal();
    swallow();
  }, true);
  // WebKit applies :active on touch only when a touchstart listener is there.
  document.addEventListener('touchstart', () => {}, { passive: true });

  list.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('skeleton') || e.button !== 0 || e === revealTap) return;
    if (e.target.closest('.swipe-move button') || gone(row)) return;
    if (g) { clearTimeout(g.long); unpress(g); }
    const touch = e.pointerType !== 'mouse';
    const rw = revealed === row ? revealWidth(row) : 0;
    g = { row, id: row.dataset.id, x0: e.clientX, y0: e.clientY, x: 0, mode: null, pid: e.pointerId, touch,
      base: -rw, rw, w: 0, pts: [], long: 0, lit: 0 };
    sample(g.pts, g.base); // a flick that arrives as one move still has a speed
    pressed = g.id; // the list waits until this finger lifts
    if (!touch) return;
    const gs = g;
    gs.lit = setTimeout(() => { if (g === gs && !gs.mode) row.classList.add('pressing'); }, 90);
    // A finger that stops a fling is not a long press.
    if (performance.now() - scrolledAt < 150) return;
    gs.long = setTimeout(() => {
      if (g !== gs || gs.mode) return;
      if (!gs.row.isConnected) return dropGesture();
      gs.mode = 'long';
      unpress(gs);
      swallow(1500);
      openMenu(gs.row);
    }, 500);
  });

  list.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.pid) return;
    if (!g.row.isConnected) return dropGesture();
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.mode) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      clearTimeout(g.long);
      unpress(g);
      if (g.touch && Math.abs(dx) > Math.abs(dy)) {
        g.mode = 'h';
        // Measured once here, so the moves that follow never force a layout. The buttons
        // only have a size while they show.
        g.w = g.row.offsetWidth;
        if (!g.rw) {
          g.row.classList.add('swipe-l');
          g.rw = revealWidth(g.row);
          g.row.classList.remove('swipe-l'); // setX puts it back when the row goes left
        }
        try { g.row.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      } else {
        return dropGesture(); // a scroll
      }
    }
    if (g.mode !== 'h') return;
    e.preventDefault();
    const w = g.w;
    const rw = g.rw;
    let x = g.base + dx;
    if (x < -rw) x = -rw - (-rw - x) * 0.25; // resist past the buttons
    if (x > w) x = w;
    g.x = x;
    sample(g.pts, x);
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
    unpress(cur);
    if (cur.mode !== 'h') {
      if (cur.mode === 'long') swallow(400);
      return release();
    }
    swallow(300);
    const row = cur.row;
    const { w, rw, x } = cur;
    // A flick counts as well as distance: past 20% moving right fast, or 24px moving left fast.
    const v = speed(cur.pts);
    if (!cancelled && (x > w * 0.4 || (x > w * 0.2 && v > 0.6))) {
      revealed = null;
      const unlock = lock(cur.id);
      row.classList.add('armed');
      row.querySelector('.circle').classList.add('checked');
      markDone(cur.id); // written at release, before the exit plays
      // The collapse waits for the slide to land (it used to start 40ms before).
      setX(row, w, true, settleMs(w - x, w)).then(() => collapse(row)).finally(unlock);
      return release();
    }
    row.classList.remove('armed');
    row.querySelector('.circle').classList.remove('checked');
    if (!cancelled && (x < -rw / 2 || (x < -24 && v < -0.4))) {
      setX(row, -rw, true, settleMs(rw + x, w));
      revealed = row;
      revealY = scrollY;
    } else {
      if (revealed === row) revealed = null;
      setX(row, 0, true, settleMs(x, w)); // the swipe classes go when it lands
    }
    release();
  }
  // On the document, so a mouse let go just off the list still ends the press.
  document.addEventListener('pointerup', (e) => endGesture(e, false));
  document.addEventListener('pointercancel', (e) => endGesture(e, true));

  list.addEventListener('click', (e) => {
    if (Date.now() < swallowUntil) return;
    if (view === 'done') {
      const d = e.target.closest('.drow');
      if (d) reopenRow(d);
      return;
    }
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('skeleton')) return;
    const mv = e.target.closest('.swipe-move button');
    if (mv) {
      if (mv.hasAttribute('aria-current')) { closeReveal(); return; }
      if (gone(row)) return;
      revealed = null;
      if (slideOut(row, -1)) moveTo(row.dataset.id, mv.dataset.move);
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
    dropGesture(); // Safari sends no pointerup after a drag, so the press ends here
    row.classList.add('dragging');
    e.dataTransfer.setData('application/x-todo-id', row.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  // On the document: a render during the drag can take the row out of the list.
  document.addEventListener('dragend', () => {
    for (const r of list.querySelectorAll('.row.dragging')) r.classList.remove('dragging');
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
      if (!id) return;
      e.preventDefault();
      const it = items[id];
      if (!it || it.done || it.section === s) return; // its own section: nothing moves, nothing slides
      // Leaves like a menu move: the lock goes on, then the op is written at the drop.
      const row = byId(id);
      if (!row || slideOut(row, -1)) moveTo(id, s);
    });
  }

  /* ---------- Move menu (long press, right click, move icon) ---------- */
  const menu = $('menu');
  let menuRow = null;
  let menuOn = false;     // false as soon as it starts to leave
  let menuOpener = null;  // takes focus back when the menu closes
  const menuScale = () => 'scale(' + (1 - 0.04 * M.dist) + ')';
  function openMenu(row, anchor, x, y) {
    if (gone(row)) return; // a detached row would put the menu in the corner
    closeReveal();
    const it = items[row.dataset.id];
    if (!it) return;
    if (menuRow && menuRow !== row) menuRow.classList.remove('menu-open');
    menuRow = row;
    menuOn = true;
    menuOpener = anchor || row;
    row.classList.add('menu-open');
    menu.innerHTML = '<div class="meta menu-title">Move to</div>' + SECTIONS.map((s) =>
      '<button class="sec" role="menuitem" data-move="' + s + '"' + (s === it.section ? ' aria-current="true"' : '') + '>' + LABEL[s] + '</button>').join('');
    rest(menu); // a menu still leaving comes back
    menu.classList.remove('leaving');
    menu.hidden = false;
    const r = (anchor || row).getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = x !== undefined ? x : anchor ? r.right - mw : Math.min(r.left + 56, innerWidth - mw - 16);
    let top = y !== undefined ? y : r.bottom + 4;
    const above = top + mh > innerHeight - 16;
    if (above) top = (y !== undefined ? y : r.top) - mh - 4;
    menu.style.left = Math.max(12, Math.min(left, innerWidth - mw - 12)) + 'px';
    menu.style.top = Math.max(12, top) + 'px';
    // It grows from the corner next to what opened it.
    menu.style.transformOrigin = (above ? 'bottom ' : 'top ') + (anchor ? 'right' : 'left');
    play(menu, [{ opacity: 0, transform: menuScale() }, { opacity: 1, transform: 'none' }], { duration: M.exit });
    const first = menu.querySelector('button.sec:not([aria-current])');
    if (first && !(g && g.touch)) first.focus({ preventScroll: true });
  }
  function closeMenu() {
    if (!menuOn) return;
    menuOn = false;
    const back = menu.contains(document.activeElement) ? menuOpener : null;
    const row = menuRow;
    menuOpener = null;
    if (menuRow) menuRow.classList.remove('menu-open');
    menuRow = null;
    menu.classList.add('leaving');
    leave(menu, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: menuScale() }]).then((ok) => {
      if (!ok) return;
      menu.hidden = true;
      menu.classList.remove('leaving');
      rest(menu);
    });
    // Focus goes back to what opened the menu. The move button hides with the menu, so then the row.
    // A row that is leaving takes it itself: its move button hides once the row slides from under
    // the pointer, and the write that removes the row passes focus on to the next one.
    if (back && back.isConnected) {
      if (row && row.isConnected && gone(row)) row.focus({ preventScroll: true });
      else back.focus({ preventScroll: true });
      if (document.activeElement !== back && row && row.isConnected) row.focus({ preventScroll: true });
    }
    wake();
  }
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button.sec');
    if (!b || !menuOn) return;
    const row = menuRow;
    // The leaving lock goes on before closeMenu lets go, so the slide plays on the row on screen.
    if (row && !b.hasAttribute('aria-current') && slideOut(row, -1)) moveTo(row.dataset.id, b.dataset.move);
    closeMenu();
  });
  document.addEventListener('pointerdown', (e) => {
    if (menuOn && !menu.contains(e.target)) {
      closeMenu();
      swallow(400);
    }
  }, true);

  /* ---------- Sheets ---------- */
  // The sheets and the confirm are modal: what is behind them goes inert, and focus goes
  // back to the opener when they close (pass opener false on close to skip that).
  const modals = new Map(); // open wrap -> { el, id } of its opener
  function modal(open, wrap, opener) {
    const box = wrap.querySelector('.sheet, .dialog');
    const back = open ? null : modals.get(wrap);
    if (open) {
      box.setAttribute('aria-modal', 'true');
      const el = opener || document.activeElement;
      const row = el && el.closest ? el.closest('#list > [data-id]') : null;
      modals.set(wrap, { el, id: row ? row.dataset.id : null });
    } else {
      box.removeAttribute('aria-modal');
      modals.delete(wrap);
    }
    const on = modals.size > 0;
    for (const el of [document.querySelector('.sidebar'), document.querySelector('main'), $('fab'), $('switcher'), toastEl]) el.inert = on;
    $('edit').inert = modals.has($('confirm'));
    if (!back || opener === false) return;
    const a = document.activeElement;
    if (a && a !== document.body && !a.closest('.sheet-wrap, .dialog-wrap')) return; // focus already went somewhere
    // A row moved away from the edit sheet hands focus to the row that was next to it.
    const el = back.el && back.el !== document.body && back.el.isConnected ? back.el
      : (back.id && byId(back.id)) || (back.next && byId(back.next));
    if (el) el.focus({ preventScroll: true });
  }

  const closingSheets = new Set();
  function openSheet(wrap, kb, opener) {
    const sheet = wrap.querySelector('.sheet');
    rest(sheet); // a sheet caught leaving comes back
    rest(wrap.querySelector('.scrim'));
    sheet.style.transform = '';
    wrap.querySelector('.scrim').style.opacity = '';
    closingSheets.delete(sheet);
    setKb(sheet, kb === undefined ? keyboard() : kb);
    wrap.hidden = false;
    modal(true, wrap, opener);
  }
  // after always runs once, also when the sheet is opened again before it has left.
  function closeSheet(wrap, after, refocus = true) {
    const sheet = wrap.querySelector('.sheet');
    if (wrap.hidden || closingSheets.has(sheet)) return;
    const scrim = wrap.querySelector('.scrim');
    closingSheets.add(sheet); // the keyboard dropping now does not move it
    modal(false, wrap, refocus);
    let frames;
    if (M.reduced) frames = [{ opacity: 1 }, { opacity: 0 }];
    // Desktop sheets are centred with transform, so the scale rides on its own property.
    else if (desk.matches) frames = [{ opacity: 1, scale: 1 }, { opacity: 0, scale: 0.98 }];
    else {
      // From where it is (a drag may have moved it) to its height plus the keyboard offset
      // (--kb is negative), so it ends below the screen.
      const kb = parseFloat(sheet.style.getPropertyValue('--kb')) || 0;
      frames = [{ transform: sheet.style.transform || 'none' }, { transform: 'translateY(' + (sheet.offsetHeight - kb) + 'px)' }];
    }
    // The scrim goes on from where a drag left it.
    leave(scrim, [{ opacity: getComputedStyle(scrim).opacity }, { opacity: 0 }]);
    leave(sheet, frames).then(() => {
      if (closingSheets.delete(sheet)) {
        wrap.hidden = true;
        sheet.style.transform = '';
        scrim.style.opacity = '';
        rest(sheet);
        rest(scrim);
      }
      if (after) after();
    });
  }

  // Keep the open sheet above the iPhone keyboard. The offset rides on the CSS translate
  // property (--kb), so the sheet glides with the keyboard. Desktop never offsets.
  function keyboard() {
    const vv = window.visualViewport;
    return vv && !desk.matches ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
  }
  function setKb(sheet, off) {
    const vv = window.visualViewport;
    sheet.style.setProperty('--kb', -off + 'px');
    sheet.style.setProperty('--vvh', (vv ? vv.height : innerHeight) + 'px');
    sheet.classList.toggle('kb', off > 0);
  }
  // snap: the page panned under the keyboard, so the sheet follows at once, with no glide.
  function placeSheet(snap) {
    const off = keyboard();
    const typing = document.activeElement === capInput || document.activeElement === editText;
    if (off && typing && off !== ui.kb) { ui.kb = off; saveUi(); } // the next capture sheet starts there
    for (const s of document.querySelectorAll('.sheet')) {
      if (s.closest('.sheet-wrap').hidden || closingSheets.has(s)) continue;
      if (!snap) { setKb(s, off); continue; }
      s.classList.add('kb-snap');
      setKb(s, off);
      void s.offsetHeight;
      s.classList.remove('kb-snap');
    }
  }
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', () => placeSheet(false));
    visualViewport.addEventListener('scroll', () => placeSheet(true));
  }

  // Swipe a sheet down to close it. The scrim lightens with the drag, and a flick closes it.
  for (const wrap of [$('capture'), $('edit')]) {
    const sheet = wrap.querySelector('.sheet');
    const scrim = wrap.querySelector('.scrim');
    let s = null;
    let back = [];   // the snap-back glides
    sheet.addEventListener('pointerdown', (e) => {
      if (desk.matches || closingSheets.has(sheet) || e.target.closest('textarea, input, button')) return;
      for (const a of back) a.cancel();
      back = [];
      s = { y0: e.clientY, dy: 0, pid: e.pointerId, h: sheet.offsetHeight, pts: [] };
      sample(s.pts, 0);
      // The entry is over; ended here it can not replay when the drag lets go.
      for (const a of sheet.getAnimations()) if (a.animationName) a.finish();
      try { sheet.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      sheet.classList.add('dragging');
    });
    sheet.addEventListener('pointermove', (e) => {
      if (!s || e.pointerId !== s.pid) return;
      s.dy = Math.max(0, e.clientY - s.y0);
      sample(s.pts, s.dy);
      sheet.style.transform = 'translateY(' + s.dy + 'px)';
      scrim.style.opacity = String(Math.max(0, 1 - s.dy / Math.max(1, s.h)));
    });
    const end = () => {
      if (!s) return;
      sheet.classList.remove('dragging');
      const close = s.dy > 70 || (s.dy > 16 && speed(s.pts) > 0.5);
      s = null;
      // Closing goes on from where the finger left it (closeSheet starts from the current transform).
      if (close) { (wrap.id === 'edit' ? closeEdit : closeCapture)(); return; }
      const from = sheet.style.transform;
      const op = scrim.style.opacity;
      sheet.style.transform = '';
      scrim.style.opacity = '';
      // Glides on their own, so no transition is left behind for the next drag.
      if (from && !M.reduced) back.push(play(sheet, [{ transform: from }, { transform: 'none' }]).anim);
      if (op) back.push(play(scrim, [{ opacity: op }, { opacity: 1 }], { easing: 'ease' }).anim);
    };
    sheet.addEventListener('pointerup', end);
    sheet.addEventListener('pointercancel', end);
    wrap.querySelector('.scrim').addEventListener('click', () => (wrap.id === 'edit' ? closeEdit : closeCapture)());
  }

  /* ---------- Capture ---------- */
  const capInput = $('capInput');
  function openAdd() {
    if (view !== 'list') setSection(ui.section);
    closeReveal();
    if (desk.matches) return showInline();
    capInput.value = '';
    capAdded = [];
    $('capAdded').textContent = '';
    capLabel();
    // Start where the keyboard will be, so the sheet does not land and then jump.
    const kb = Number(ui.kb) || 0;
    openSheet($('capture'), kb > 0 && kb < innerHeight ? kb : 0);
    capInput.focus(); // inside the tap, so iOS brings the keyboard up
    clearTimeout(kbTimer);
    kbTimer = setTimeout(() => { if (!keyboard()) placeSheet(); }, 600); // no keyboard came
  }
  let kbTimer = 0;
  // What Return just saved stays in the sheet, ticked, so a cleared field reads as saved.
  let capAdded = [];
  // Only the new line is added, growing from nothing. Past three lines the first closes at the
  // same pace, so the sheet keeps its height. Reduced motion: the line fades in, the first goes at once.
  function addCapLine(t) {
    const ul = $('capAdded');
    const first = !ul.firstElementChild;
    const li = document.createElement('li');
    li.innerHTML = '<span class="ok"><svg class="ic ic-2" width="16" height="16"><use href="#i-check"/></svg></span><span class="t"></span>';
    li.querySelector('.t').textContent = t;
    ul.append(li);
    const lines = ul.querySelectorAll('li:not(.leaving)');
    const old = lines.length > 3 ? lines[0] : null;
    if (M.reduced) {
      if (old) old.remove();
      play(li, [{ opacity: 0 }, { opacity: 1 }], { easing: 'ease' });
    } else {
      const h = li.offsetHeight + 'px';
      const shut = { height: '0px', minHeight: '0px', opacity: 0 };
      const open = { height: h, minHeight: h, opacity: 1 };
      play(li, [shut, open]);
      if (first) play(ul, [{ marginTop: '-10px' }, { marginTop: '0px' }]); // the sheet's 10px gap comes with the first line
      if (old) {
        old.classList.add('leaving');
        play(old, [open, shut], { fill: 'forwards' }).then(() => old.remove());
      }
    }
    capLabel();
  }
  // The label crossfades only when its words change.
  function capLabel() {
    const l = $('capLabel');
    const t = (capAdded.length ? 'Added to ' : 'Adds to ') + LABEL[ui.section];
    if (l.textContent === t) return;
    l.textContent = t;
    if (!$('capture').hidden) play(l, [{ opacity: 0 }, { opacity: 1 }], { duration: M.press, easing: 'ease' });
  }
  let capClosing = false;
  function closeCapture() {
    if (capClosing || $('capture').hidden) return; // Escape, a tap outside and a swipe can all arrive
    capClosing = true;
    const v = cleanText(capInput.value);
    capInput.value = '';
    capInput.blur();
    if (v) addTask(v); // written at the tap: the page can hide before the sheet has left
    closeSheet($('capture'), () => { capClosing = false; });
  }
  capInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const v = cleanText(capInput.value);
      if (!v) return closeCapture(); // Return on an empty field means finished
      addTask(v);
      capAdded.push(v);
      addCapLine(v);
      capInput.value = '';
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeCapture();
    }
  });
  $('fab').addEventListener('click', openAdd);
  $('capDone').addEventListener('click', closeCapture);
  $('addDesk').addEventListener('click', () => (inlineOn ? hideInline() : showInline()));

  // The desktop add field opens in a grid slot (0fr to 1fr), so the rows below make room
  // smoothly, and closes the same way. Reduced motion: it fades.
  const inlineInput = $('inlineInput');
  const inlineSlot = $('inlineSlot');
  let inlineOn = false;
  function showInline() {
    const shut = $('inlineAdd').hidden;
    rest(inlineSlot); // one on its way out comes back
    $('inlineAdd').hidden = false;
    inlineOn = true;
    if (shut) play(inlineSlot, M.reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ gridTemplateRows: '0fr' }, { gridTemplateRows: '1fr' }]);
    inlineInput.focus({ preventScroll: true }); // no scroll, or the closed slot would scroll its field into view
  }
  // now: gone at once, as on a section switch.
  function hideInline(now) {
    if (document.activeElement === inlineInput) inlineInput.blur();
    inlineInput.value = '';
    if (!inlineOn) return;
    inlineOn = false;
    if (now) { rest(inlineSlot); $('inlineAdd').hidden = true; return; }
    leave(inlineSlot, M.reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ gridTemplateRows: '1fr' }, { gridTemplateRows: '0fr' }]).then((ok) => {
      if (!ok) return;
      $('inlineAdd').hidden = true;
      rest(inlineSlot);
    });
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
  let editFrom = null; // { id, section, pos } when the sheet opened
  let editTimer = 0;
  function openEdit(id) {
    const it = items[id];
    const row = list.querySelector('.row[data-id="' + id + '"]');
    if (!it || leaving.has(id) || (row && gone(row))) return; // a task about to leave does not open
    editId = id;
    editFrom = { id, section: it.section, pos: it.pos };
    editText.value = it.text;
    paintEditSeg(it.section);
    const a = document.activeElement;
    openSheet($('edit'), undefined, list.contains(a) ? a : desk.matches ? row : null);
    if (desk.matches) { editText.focus(); editText.setSelectionRange(editText.value.length, editText.value.length); }
    else $('editClose').focus({ preventScroll: true }); // on the phone the keyboard waits for a tap in the text
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
    editId = null;
    const from = editFrom;
    editFrom = null;
    // Focus goes back to the row it opened from. A task that ended up in another section says
    // where it went, once, however many times the section was changed.
    closeSheet($('edit'), () => {
      const it = from && items[from.id];
      if (!it || it.done || it.section === from.section) return;
      toast('Moved to ' + LABEL[it.section] + '.', () => {
        const cur = items[from.id];
        if (cur) upsert(Object.assign({}, cur, { section: from.section, pos: from.pos }));
      }, from.id);
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
      // Where focus goes on close if the row has left by then (only when it came from the row).
      const back = modals.get($('edit'));
      const row = byId(editId);
      if (back && back.id === editId && row) back.next = neighbour(row);
      moveTo(editId, b.dataset.section, false);
      paintEditSeg(b.dataset.section);
    });
  }
  // The confirm fades in (app.css) and out.
  const confirmWrap = $('confirm');
  let confirmClosing = false;
  function openConfirm() {
    if (editId === null) return; // the edit sheet is already leaving
    rest(confirmWrap.querySelector('.dialog'));
    rest(confirmWrap.querySelector('.scrim'));
    confirmClosing = false;
    confirmWrap.hidden = false;
    modal(true, confirmWrap, $('editDelete'));
    $('confirmCancel').focus();
  }
  function closeConfirm(refocus = true) {
    if (confirmWrap.hidden || confirmClosing) return;
    confirmClosing = true;
    modal(false, confirmWrap, refocus);
    const dialog = confirmWrap.querySelector('.dialog');
    const scrim = confirmWrap.querySelector('.scrim');
    const fade = [{ opacity: 1 }, { opacity: 0 }];
    leave(scrim, fade);
    leave(dialog, fade).then((ok) => {
      if (!ok) return;
      confirmWrap.hidden = true;
      confirmClosing = false;
      rest(dialog);
      rest(scrim);
    });
  }
  $('editDelete').addEventListener('click', openConfirm);
  $('confirmCancel').addEventListener('click', () => closeConfirm());
  $('confirmDelete').addEventListener('click', () => {
    if (confirmClosing || editId === null) return;
    closeConfirm(false); // focus goes with the edit sheet to the row, then next to it once the row leaves
    const id = editId;
    clearTimeout(editTimer);
    editId = null;
    editFrom = null;
    remove(id); // written at the tap; the row collapses behind the leaving sheet
    closeSheet($('edit'));
  });

  /* ---------- Keyboard (desktop) ---------- */
  function rows() { return Array.from(list.querySelectorAll(view === 'done' ? '.drow' : '.row:not(.skeleton)')); }
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (!confirmWrap.hidden) { closeConfirm(); return; }
      if (menuOn) { closeMenu(); return; }
      if (!$('edit').hidden) { closeEdit(); return; }
      if (!$('capture').hidden) { closeCapture(); return; }
      closeReveal();
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || !$('edit').hidden || !$('capture').hidden || !$('confirm').hidden) return;
    if (menuOn) {
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
    if (view === 'done' && (k === 'Enter' || k === ' ')) { e.preventDefault(); reopenRow(focused); return; }
    if (k === 'Enter' && e.target === focused) { e.preventDefault(); openEdit(focused.dataset.id); return; }
    if (k === ' ' && e.target === focused) {
      e.preventDefault();
      completeRow(focused); // the render that removes it focuses the next row that stays
    }
  });

  /* ---------- Life cycle ---------- */
  let pollTimer = 0;
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL);
  }
  document.addEventListener('visibilitychange', () => {
    closeReveal();
    if (document.hidden) {
      // A finger or the menu can not hold the list while the app is away.
      endGesture(null, true);
      closeMenu();
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
  desk.addEventListener('change', () => { hideInline(true); render(); });

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
