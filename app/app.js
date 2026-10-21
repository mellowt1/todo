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
  const LEVELS = ['wired', 'normal', 'drained'];
  const LNAME = { wired: 'Wired', normal: 'Normal', drained: 'Drained' };
  const FILL = { wired: 12, normal: 7, drained: 2.5 };
  // A battery whose fill is the level. label: an image with a name; without, decoration.
  const battSvg = (level, label) => '<svg class="batt" width="20" height="12" viewBox="0 0 20 12"' + (label ? ' role="img" aria-label="' + label + '"' : ' aria-hidden="true"') + '>' +
    '<rect x="0.75" y="0.75" width="16" height="10.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<rect x="17.5" y="3.75" width="1.75" height="4.5" rx="0.8" fill="currentColor"/>' +
    '<rect x="2.75" y="2.75" width="' + FILL[level] + '" height="6.5" rx="1.2" fill="currentColor"/></svg>';
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

  /* ---------- One quiet live region ---------- */
  // #say is the only thing a screen reader hears by itself. Emptied first and filled a frame
  // later, so the same words twice are read twice.
  let sayFrame = 0;
  function say(text) {
    const el = $('say');
    cancelAnimationFrame(sayFrame);
    el.textContent = '';
    sayFrame = requestAnimationFrame(() => { el.textContent = text; });
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
      ...(it.link ? { link: it.link } : {}), // set by the hub (a vacancy's page); the app only keeps it
      // The Energy dial: a confirmed level and a guess. Left out, the hub keeps them; null clears.
      ...(it.energy !== undefined ? { energy: it.energy } : {}),
      ...(it.energyGuess !== undefined ? { energyGuess: it.energyGuess } : {}),
      ...(it.repeat !== undefined ? { repeat: it.repeat } : {}), // null takes a repeat off
      ...(it.week !== undefined ? { week: it.week === true ? true : null } : {}), // "this week"
      ...(it.series ? { series: it.series } : {}),
      ...(it.waiting ? { waiting: it.waiting } : {}), // a chase task's Waiting on item, set by the hub
    } });
  }

  function remove(id) {
    enqueue({ op: 'delete', item: { id, updatedAt: stamp() } });
  }

  // Dates drive placement (2026-10-21). Soon: dated tasks first, by date and time, then the rest,
  // newest first. Today: what is due today or earlier first, then the rest. Someday: newest first.
  // The hub moves a task into Today on its day (worker/src/due.js).
  function dueKey(it) {
    const p = nameParts(it);
    return p.due ? p.due + ' ' + (p.time || '') : null;
  }
  function openIn(section) {
    const rows = Object.values(items).filter((i) => !i.done && i.section === section);
    if (section === 'someday') return rows.sort((a, b) => b.pos - a.pos);
    const d = new Date(now());
    const end = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '~';
    const key = new Map(rows.map((it) => {
      const k = dueKey(it);
      return [it.id, k && (section === 'soon' || k < end) ? k : null];
    }));
    // Soon: "this week" tasks first (2026-10-21), sorted the same way among themselves.
    const wk = (it) => (section === 'soon' && it.week === true ? 0 : 1);
    return rows.sort((a, b) => {
      if (wk(a) !== wk(b)) return wk(a) - wk(b);
      const ka = key.get(a.id), kb = key.get(b.id);
      if (ka && kb) return ka < kb ? -1 : ka > kb ? 1 : b.pos - a.pos;
      if (ka || kb) return ka ? -1 : 1;
      return b.pos - a.pos;
    });
  }

  /* ---------- Actions ---------- */
  function addTask(text) {
    text = cleanText(text);
    if (!text) return;
    const id = newId();
    justAdded.add(id);
    upsert({ id, text, section: ui.section, done: false, doneAt: null, pos: now() });
    tidyLater(id, text);
    return id;
  }

  /* Tidy (Paul, 2026-10-17): the task goes in as typed, then Claude cleans it up a second later
   * (typos, a short task, its day or date as the date label; POST /api/tidy/:code). The tidy
   * text replaces it only when nobody has touched the task since, with Undo in the toast.
   * The toast sits under the capture sheet, so while the sheet is open the Undo goes on the
   * sheet's own line instead (capTidied). Offline, it stays as typed. */
  /* A question for Claude or a message to write (Tidy's kind "ask" or "write", 2026-10-19) leaves
   * the list again and goes to Desk; its answer opens in the Claude sheet (Ask, below). An edited
   * task (edit true) is only tidied, never sent. */
  async function tidyLater(id, typed, edit) {
    if (!navigator.onLine) return;
    try {
      const r = await fetch(API + '/api/tidy/' + code, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: typed }) });
      const d = r.ok ? await r.json() : null;
      const it = items[id];
      if (!edit && d && (d.kind === 'ask' || d.kind === 'write') && it && !it.done && it.text === typed) return toDesk(id, typed, d.kind);
      if (!d || !it || it.done || it.text !== typed) return;
      // Tidy also guesses the energy the task takes; it shows outlined until Paul confirms it.
      const guess = LEVELS.includes(d.energy) && !it.energy && !it.energyGuess ? { energyGuess: d.energy } : null;
      if (!d.changed || !d.text) { if (guess) upsert(Object.assign({}, it, guess)); return; }
      upsert(Object.assign({}, it, { text: d.text }, guess));
      tidied[id] = d.text;
      const undo = () => { const cur = items[id]; if (cur) { upsert(Object.assign({}, cur, { text: typed })); teach('undone', d.text, typed); } delete tidied[id]; };
      if (!$('capture').hidden && !capClosing) return capTidied(id, typed, d.text, undo);
      toast('Tidied.', undo, id);
    } catch (e) { /* stays as typed */ }
  }

  /* Lessons (worker/src/lessons.js): an Undo of a tidy, or an edit of a tidied task, tells the hub
   * what Paul wanted instead. On Sundays Claude turns those into rules he keeps or drops on Morning. */
  const tidied = {};
  function teach(kind, before, after) {
    if (!before || !after || before === after) return;
    report('tidy', kind, before, after);
  }
  // Also Intake (an edit or a delete of a task read from a letter) and "Keep as a task" (2026-10-19).
  function report(app, kind, before, after) {
    if (!navigator.onLine || !before) return;
    fetch(API + '/api/lessons/' + code + '/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app, kind, before, after }) }).catch(() => {});
  }

  function markDone(id) {
    const it = items[id];
    if (!it || it.done) return;
    const prev = Object.assign({}, it);
    const at = now();
    const row = byId(id);
    if (row && view === 'list') xpDrop(row, pays(it, at));
    upsert(Object.assign({}, it, { done: true, doneAt: at }, it.week ? { week: null } : {})); // done takes the flag off; Undo puts it back
    // A repeating task: the next one on the schedule comes in now; Undo takes both back.
    const next = nextOf(it, ymd(new Date(at)), at);
    if (next && !items[next.id]) upsert(next);
    else if (next) { toast('Done.', () => upsert(prev), id); return; }
    toast(next ? 'Done. Next: ' + longDay(nameParts(next).due) + '.' : 'Done.', () => { upsert(prev); if (next) remove(next.id); }, id);
    if (it.waiting) askAnswered(it); // a chase task: did they answer?
  }

  function moveTo(id, section, withToast = true) {
    const it = items[id];
    if (!it || it.section === section) return;
    const prev = Object.assign({}, it);
    upsert(Object.assign({}, it, { section, pos: now() }));
    if (withToast) toast('Moved to ' + LABEL[section] + '.', () => upsert(prev), id);
  }

  // "This week" on or off (2026-10-21). In Soon the task joins or leaves the group on top.
  function setWeek(id, on, withToast = true) {
    const it = items[id];
    if (!it || it.done || (it.week === true) === on) return;
    const prev = Object.assign({}, it);
    upsert(Object.assign({}, it, { week: on ? true : null }));
    if (withToast) toast(on ? 'Flagged for this week.' : 'Off this week.', () => upsert(Object.assign({}, prev, { week: prev.week === true ? true : null })), id);
  }

  function reopen(id) {
    const it = items[id];
    if (!it || !it.done) return;
    const prev = Object.assign({}, it);
    upsert(Object.assign({}, it, { done: false, doneAt: null, pos: now() }));
    // A repeating task's next one goes again while it is still open, so there are never two.
    const next = nextOf(it, ymd(new Date(it.doneAt)), now());
    const made = next && items[next.id] && !items[next.id].done ? Object.assign({}, items[next.id]) : null;
    if (made) remove(made.id);
    toast('Reopened in ' + LABEL[it.section] + '.', () => { upsert(prev); if (made) upsert(made); }, id);
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
      loadEnergy(); // the dial may have been set in Morning or Day
      if (++pollCount % 6 === 1) loadWaiting(); // Waiting on, about once a minute
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
    const was = net;
    net = s;
    const pill = $('pill');
    const span = pill.querySelector('span');
    const use = pill.querySelector('use');
    clearTimeout(pillTimer);
    if (s === 'error') slotIn($('banner')); else slotOut($('banner'));
    if (s === 'error' && was !== 'error') say($('banner').querySelector('span').textContent);
    if (s === 'offline' || s === 'error') trouble = true;
    if (s === 'offline') {
      const n = st.queue.length;
      span.textContent = n ? 'Offline. ' + n + (n === 1 ? ' change' : ' changes') + ' waiting' : 'Offline';
      use.setAttribute('href', '#i-offline');
      slotIn(pill);
      if (was !== 'offline') say(span.textContent); // routine sync is never announced, only trouble
    } else if (s === 'syncing') {
      span.textContent = 'Syncing';
      use.setAttribute('href', '#i-sync');
      slotIn(pill);
    } else if (s === 'synced') {
      trouble = false;
      span.textContent = 'Synced';
      use.setAttribute('href', '#i-check');
      slotIn(pill);
      pillTimer = setTimeout(() => {
        slotOut(pill, 400).then((ok) => { if (ok) net = 'idle'; });
      }, 1600);
    } else {
      slotOut(pill);
    }
  }

  // The pill and the banner open in grid slots under the title (0fr to 1fr), so the list makes
  // room with a glide and never jumps. They leave the other way round: the words fade, then the
  // room closes. Reduced motion, or before the first paint: the room opens and closes at once.
  const slotOf = (el) => el.closest('.slot');
  function slotIn(el) {
    const slot = slotOf(el);
    const shut = el.hidden || exits.has(slot);
    const op = exits.has(el) ? getComputedStyle(el).opacity : null; // caught fading out
    rest(el);
    rest(slot);
    el.hidden = false;
    if (shut) {
      if (!document.body.classList.contains('ready')) return;
      if (!M.reduced) play(slot, [{ gridTemplateRows: '0fr' }, { gridTemplateRows: '1fr' }]);
      play(el, [{ opacity: 0 }, { opacity: 1 }], { easing: 'ease' });
    } else if (op !== null) {
      play(el, [{ opacity: op }, { opacity: 1 }], { duration: M.press, easing: 'ease' });
    }
  }
  // Resolves true once it is gone, false when it was already going or came back.
  function slotOut(el, fade = M.exit) {
    const slot = slotOf(el);
    if (el.hidden || exits.has(el) || exits.has(slot)) return Promise.resolve(false);
    return leave(el, [{ opacity: 1 }, { opacity: 0 }], { duration: fade, easing: 'ease' })
      .then((ok) => ok && (M.reduced || leave(slot, [{ gridTemplateRows: '1fr' }, { gridTemplateRows: '0fr' }])))
      .then((ok) => {
        if (!ok) return false;
        el.hidden = true;
        rest(el);
        rest(slot);
        return true;
      });
  }

  function showNoCode() {
    $('nocode').hidden = false;
  }

  /* ---------- Rendering ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  // A task Intake wrote ends in "[intake]". It shows as a small clip, not as the mark.
  const INTAKE_MARK = /\s*\[intake\]$/;
  const isIntake = (it) => INTAKE_MARK.test(it.text);
  // The name stays clean (Paul, 2026-10-17): a date at the end (" · 2026-11-01") shows as a small
  // label at the right, amber from two days before and red only once it has passed (the letter
  // card's colours, so one date reads the same in both). "Apply:" stays in the name: the Slayer
  // icon says the rest (2026-10-19). The text itself is unchanged, so the edit sheet shows both.
  // A time may follow the date (" · 2026-11-01 14:00", 2026-10-19): Day plans the task at that hour.
  const DUE = /\s*·\s*(\d{4}-\d{2}-\d{2})(?: ([01]\d|2[0-3]):([0-5]\d))?$/;
  function nameParts(it) {
    let name = it.text.replace(INTAKE_MARK, '');
    const m = name.match(DUE);
    if (m) name = name.slice(0, m.index);
    return { name: name || it.text, due: m ? m[1] : null, time: m && m[2] ? m[2] + ':' + m[3] : null };
  }

  /* ---------- Repeats ----------
   * The same rules as worker/src/repeat.js (nextDate, successor): change both together. The next
   * one is on the schedule from the task's date, missed ones skipped, and stops after `until`. Its
   * id is fixed by the series and the date, so the hub's back-up never makes a second one. Bins
   * ("every: bins") come from the hub's bin calendar, never from here. */
  const REPEAT_STEP = { week: 7, '2weeks': 14 };
  const REPEAT_LABEL = { week: 'Weekly', '2weeks': '2 weeks', month: 'Monthly' };
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const plusDays = (date, n) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + n)).toISOString().slice(0, 10);
  function plusMonths(date, n) {
    const [y, m, d] = date.split('-').map(Number);
    const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
  }
  function nextDate(due, every, today, until) {
    let k = 1;
    let next;
    do { next = every === 'month' ? plusMonths(due, k) : plusDays(due, REPEAT_STEP[every] * k); k++; } while (next < today && k < 1000);
    return until && next > until ? null : next;
  }
  function nextOf(it, today, at) {
    if (!it.repeat || !(REPEAT_STEP[it.repeat.every] || it.repeat.every === 'month')) return null;
    const mark = it.text.match(INTAKE_MARK);
    const body = mark ? it.text.slice(0, mark.index) : it.text;
    const m = body.match(DUE);
    if (!m) return null;
    const date = nextDate(m[1], it.repeat.every, today, it.repeat.until);
    if (!date) return null;
    const text = (body.slice(0, m.index) + ' · ' + date + (m[2] ? ' ' + m[2] + ':' + m[3] : '') + (mark ? mark[0] : '')).slice(0, MAX_TEXT);
    const series = it.series || it.id;
    return { id: series.slice(0, 20) + date.replace(/-/g, ''), text, section: date <= today ? 'today' : 'soon', done: false, doneAt: null, pos: at, repeat: it.repeat, series };
  }
  const longDay = (d) => { const t = new Date(d + 'T12:00:00'); return DAYS[t.getDay()] + ' ' + t.getDate() + ' ' + MONTHS[t.getMonth()]; };
  const WEEK_ICON = '<svg class="ic tweek" width="13" height="13" viewBox="0 0 16 16" role="img" aria-label="This week"><path d="M3.5 14V2.5M3.5 2.5h8.2l-1.8 3 1.8 3H3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const REPEAT_ICON = '<svg class="ic trep" width="13" height="13" viewBox="0 0 16 16" role="img" aria-label="Repeats"><path d="M3 7.5A5 5 0 0 1 12.2 4.6M13 8.5A5 5 0 0 1 3.8 11.4M12.6 1.8v3.2H9.4M3.4 14.2V11h3.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ---------- Hiscores ----------
   * The hub pays XP into Paul's real-life Hiscores for every task ticked off; the list shows what
   * a task pays and what the day earned. These rules are worker/src/hiscores.js taskRows(),
   * copied: change both together. The list never writes XP, the hub's scan does. */
  const XP_RULES = { task: 100, apply: 4000, oldTask: 1500, letterTask: 1200 };
  const OLD_MS = 14 * 86400000;
  const SKILL = { woodcutting: 'Woodcutting', slayer: 'Slayer', attack: 'Attack', defence: 'Defence' };
  // What a task pays when ticked at `at` (an open task: now), biggest first.
  function pays(it, at) {
    const out = [/^(apply|sollicit\w*)\b/i.test(it.text) ?{ skill: 'slayer', xp: XP_RULES.apply } : { skill: 'woodcutting', xp: XP_RULES.task }];
    if (Number.isFinite(it.pos) && at - it.pos >= OLD_MS) out.push({ skill: 'attack', xp: XP_RULES.oldTask });
    if (INTAKE_MARK.test(it.text)) out.push({ skill: 'defence', xp: XP_RULES.letterTask });
    return out.sort((a, b) => b.xp - a.xp);
  }
  const paysAt = (it) => pays(it, it.done ? it.doneAt : now());
  const xpSum = (ps) => ps.reduce((n, p) => n + p.xp, 0);
  const fmt = (n) => n.toLocaleString('en-GB');
  const skillImg = (s) => '<img class="skill" src="icons/skills/' + s + '.png" alt="" width="18" height="18">';
  const paysTitle = (ps) => ps.map((p) => SKILL[p.skill] + ' ' + fmt(p.xp) + ' XP').join(', ');
  const midnight = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // XP by skill over a set of done tasks, biggest first.
  function bySkill(done) {
    const m = {};
    for (const it of done) for (const p of paysAt(it)) m[p.skill] = (m[p.skill] || 0) + p.xp;
    return Object.keys(m).map((skill) => ({ skill, xp: m[skill] })).sort((a, b) => b.xp - a.xp);
  }
  // Levels come from the hub's board (GET /api/hiscores/:code), read once a session when a
  // screen shows them. Without it the screens show XP only.
  let levels = null;
  let levelsAsked = false;
  function loadLevels() {
    if (levelsAsked || !navigator.onLine) return;
    levelsAsked = true;
    fetch(API + '/api/hiscores/' + code).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d || !Array.isArray(d.skills)) return;
      levels = {};
      for (const s of d.skills) if (s && s.id) levels[s.id] = s.level;
      render();
    }).catch(() => {});
  }
  // The XP drop (OSRS): what a tick paid rises from the right of the row and fades. Decoration
  // only; the toast already says "Done.". Reduced motion: it fades in place.
  function xpDrop(row, ps) {
    const r = row.getBoundingClientRect();
    ps.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'xpdrop';
      d.setAttribute('aria-hidden', 'true');
      d.innerHTML = skillImg(p.skill) + '<span>+' + fmt(p.xp) + '</span>';
      d.style.top = Math.round(r.top + r.height / 2 - 11) + 'px';
      d.style.right = Math.round(innerWidth - r.right + 16) + 'px';
      document.body.append(d);
      const up = 'translateY(' + -32 * M.dist + 'px)';
      play(d, [{ opacity: 0, transform: 'none' }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.7 }, { opacity: 0, transform: up }],
        { duration: 1300, delay: i * 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'both' }).then(() => d.remove());
    });
  }
  function dueLabel(d) {
    const t = new Date(d + 'T12:00:00');
    const today = new Date();
    const diff = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    const words = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : t.getDate() + ' ' + MONTHS[t.getMonth()];
    return { words, state: diff < 0 ? ' late' : diff <= 2 ? ' near' : '' };
  }
  const skillSlot = (it) => { const ps = paysAt(it); return '<span class="tskill" title="' + paysTitle(ps) + '">' + skillImg(ps[0].skill) + '</span>'; };
  // withSkill false: the caller puts the skill in a column of its own (Done rows).
  function textHtml(it, withSkill = true) {
    const p = nameParts(it);
    let meta = '';
    if (it.week === true && !it.done && it.section !== 'soon') meta += WEEK_ICON; // Soon has its group
    if (it.repeat && !it.done) meta += REPEAT_ICON;
    if (p.due) { const d = dueLabel(p.due); meta += '<span class="tdue' + (it.done ? '' : d.state) + '" title="' + p.due + (p.time ? ' ' + p.time : '') + '">' + d.words + (p.time ? ' ' + p.time : '') + '</span>'; }
    // The confirmed energy level, a small battery (a guess shows only in the edit sheet).
    if (withSkill && !it.done && LEVELS.includes(it.energy)) meta += '<span class="tbatt" title="' + LNAME[it.energy] + ' energy">' + battSvg(it.energy, LNAME[it.energy] + ' energy') + '</span>';
    // One slot at the right: the skill the task pays most into (a letter's Defence, an Apply's Slayer).
    if (withSkill) meta += skillSlot(it);
    return '<span class="tname">' + esc(p.name) + '</span>' + (meta ? '<span class="tmeta">' + meta + '</span>' : '');
  }

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

  // A task the hub made can carry a link (a vacancy's page): a small icon that opens it.
  const SAFE_LINK = /^https?:\/\//i;
  function linkHtml(it) {
    if (typeof it.link !== 'string' || !SAFE_LINK.test(it.link)) return '';
    let host = '';
    try { host = new URL(it.link).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
    return '<a class="link" href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer" aria-label="Open link, ' + esc(host) + '" title="' + esc(host) + '">' +
      '<svg class="ic" width="20" height="20"><use href="#i-link"/></svg></a>';
  }

  function rowHtml(it, enter) {
    const moves = SECTIONS.map((s) =>
      '<button data-move="' + s + '"' + (s === it.section ? ' aria-current="true" tabindex="-1"' : '') + '>' + LABEL[s] + '</button>').join('');
    return '<li class="row' + (enter ? ' enter' : '') + '" data-id="' + it.id + '" tabindex="-1"' + (desk.matches ? ' draggable="true"' : '') + '>' +
      '<div class="swipe-done" aria-hidden="true"><svg class="ic ic-2" width="24" height="24"><use href="#i-check"/></svg></div>' +
      '<div class="swipe-move"><span class="move-group">' + moves + '</span></div>' +
      '<div class="row-inner">' +
      '<button class="circle" aria-label="Mark done" aria-describedby="t-' + it.id + '"><svg class="ic ic-2" width="16" height="16"><use href="#i-check"/></svg></button>' +
      '<div class="text" id="t-' + it.id + '" role="button">' + textHtml(it) + '</div>' +
      linkHtml(it) +
      '<button class="move-btn" aria-label="Move task" aria-describedby="t-' + it.id + '" aria-haspopup="menu" aria-expanded="false"><svg class="ic" width="20" height="20"><use href="#i-move"/></svg></button>' +
      '</div></li>';
  }

  const DONE_PAGE = 300;
  let doneShown = DONE_PAGE;
  const MORE = '<li class="dmore" aria-hidden="true" style="height:1px"></li>';
  const doneList = () => Object.values(items).filter((i) => i.done).sort((a, b) => b.doneAt - a.doneAt);
  // Done rows from..to, with a day header wherever the day changes from last. Each row is a
  // real button, described by its section and time as they show.
  // A day header carries that day's XP in data-xp (drawn by app.css), so its text stays the label.
  let dayXp = new Map();
  function doneRows(done, from, to, last) {
    let html = '';
    for (const it of done.slice(from, to)) {
      const label = dayLabel(it.doneAt);
      if (label !== last) {
        const xp = dayXp.get(midnight(new Date(it.doneAt)));
        html += '<li class="dhead"' + (xp ? ' data-xp="' + fmt(xp) + ' XP"' : '') + '>' + label + '</li>';
        last = label;
      }
      const t = new Date(it.doneAt);
      html += '<li class="drow" data-id="' + it.id + '">' +
        '<button class="dbtn" aria-label="Reopen ' + esc(it.text) + '" aria-describedby="ds-' + it.id + ' dt-' + it.id + '">' +
        '<span class="dcheck" aria-hidden="true"><svg class="ic ic-2" width="16" height="16"><use href="#i-check"/></svg></span>' +
        '<span class="dbody"><span class="dtext">' + textHtml(it, false) + '</span><span class="meta" id="ds-' + it.id + '">' + LABEL[it.section] + '</span></span>' +
        skillSlot(it) +
        '<span class="meta dtime" id="dt-' + it.id + '">' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + '</span></button></li>';
    }
    return html;
  }
  // I7: a task from Today finished since local midnight.
  const ALL_DONE = 'All done for today.';
  function doneToday(all) {
    const m = midnight();
    return all.some((i) => i.done && i.section === 'today' && i.doneAt >= m);
  }
  const doneSince = (t) => Object.values(items).filter((i) => i.done && i.doneAt >= t);

  // Today's progress under the title: done of Today's tasks, and the XP the whole day earned.
  function renderProgress() {
    const el = $('progress');
    const on = view === 'list' && ui.section === 'today' && loaded;
    const m = midnight();
    const ticked = on ? doneSince(m).filter((i) => i.section === 'today').length : 0;
    const total = on ? ticked + openIn('today').length : 0;
    el.hidden = !total;
    if (!total) return;
    const xp = xpSum(doneSince(m).flatMap(paysAt));
    $('progressText').textContent = ticked + ' of ' + total + ' done' + (xp ? ' · ' + fmt(xp) + ' XP today' : '');
    $('progressFill').style.transform = 'scaleX(' + (ticked / total).toFixed(3) + ')';
  }

  // Today cleared: what the day paid, skill by skill, with the level when the board has it.
  function rewardsHtml() {
    const done = doneSince(midnight());
    const rows = bySkill(done);
    if (!rows.length) return '';
    loadLevels();
    return '<p class="rsum">' + done.length + (done.length === 1 ? ' task, ' : ' tasks, ') + fmt(xpSum(rows)) + ' XP earned</p>' +
      '<ul class="rlist">' + rows.map((r) => '<li>' + skillImg(r.skill) + '<span class="rname">' + SKILL[r.skill] + '</span><b>+' + fmt(r.xp) + '</b>' +
        '<span class="rlevel">' + (levels && levels[r.skill] ? 'Level ' + levels[r.skill] : '') + '</span></li>').join('') + '</ul>';
  }

  // Done opens on the week: tasks per day for the last seven days, the week's XP and its skills.
  const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  function renderWeek(done) {
    const el = $('week');
    const today = midnight();
    const start = midnight(new Date(today - 6 * 86400000 + 43200000)); // six days back, safe across a clock change
    const week = done.filter((i) => i.doneAt >= start);
    el.hidden = view !== 'done' || !done.length;
    if (el.hidden) return;
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const t = midnight(new Date(today - i * 86400000 + 43200000));
      days.push({ t, n: week.filter((x) => midnight(new Date(x.doneAt)) === t).length, label: WEEKDAYS[new Date(t).getDay()] });
    }
    const max = Math.max(1, ...days.map((d) => d.n));
    const skills = bySkill(week);
    el.innerHTML = '<div class="wk-head"><span>This week</span><span class="meta">' + week.length + (week.length === 1 ? ' task' : ' tasks') + ' · ' + fmt(xpSum(skills)) + ' XP</span></div>' +
      '<div class="wk-bars" aria-hidden="true">' + days.map((d, i) => '<div class="wk-day' + (i === 6 ? ' now' : '') + '"><span class="wk-n">' + (d.n || '') + '</span><span class="wk-bar" data-h="' + (d.n / max).toFixed(3) + '"></span><span class="wk-l">' + d.label + '</span></div>').join('') + '</div>' +
      (skills.length ? '<div class="wk-skills">' + skills.map((s) => '<span>' + skillImg(s.skill) + SKILL[s.skill] + ' ' + fmt(s.xp) + '</span>').join('') + '</div>' : '');
    el.setAttribute('aria-label', 'This week: ' + week.length + ' tasks done, ' + fmt(xpSum(skills)) + ' XP');
    // Heights through the CSSOM: a bar never shorter than a sliver, so an empty day still reads as a day.
    for (const b of el.querySelectorAll('.wk-bar')) b.style.height = Math.max(3, Math.round(Number(b.dataset.h) * 44)) + 'px';
    loadLevels();
  }

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
    if (sortOpen) renderSort();
    if (leaving.size || pressed || menuRow || revealed) { renderQueued = true; return; }
    renderQueued = false;
    renderList();
  }

  function renderChrome() {
    document.body.classList.toggle('view-done', view === 'done');
    document.body.classList.toggle('view-list', view === 'list');
    $('title').textContent = view === 'done' ? 'Done' : LABEL[ui.section];
    document.title = view === 'done' ? 'Done' : 'To-do';

    for (const b of document.querySelectorAll('#switcher button')) {
      if (b.dataset.section === ui.section) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    for (const b of document.querySelectorAll('.nav-item')) {
      const on = view === 'done' ? b.dataset.section === 'done' : b.dataset.section === ui.section;
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      const c = b.querySelector('.count');
      if (c) { const n = openIn(b.dataset.section).length; c.textContent = n ? String(n) : ''; }
    }
    // The phone switcher shows how much waits in Soon and Someday, as the sidebar does.
    for (const c of document.querySelectorAll('#switcher .scount')) {
      const n = openIn(c.parentElement.dataset.section).length;
      c.textContent = n ? String(n) : '';
    }
    renderProgress();
    renderEnergy();
    renderWaitLine();
    if ($('capture').hidden) $('capLabel').textContent = 'Adds to ' + LABEL[ui.section];
    $('install').hidden = !(view === 'list' && showInstall());
  }

  let lastHtml = null;     // the list as last written, without the entrance class; null after a row got inline styles
  let shownKey = '';       // what the list shows: 'skeleton', 'done' or a section
  let pendingFocus = null; // a row id that takes focus in the next write (Undo pressed from the keyboard)
  const byId = (id) => $('list').querySelector('[data-id="' + CSS.escape(id) + '"]');
  const focusRow = (el) => (el.querySelector('.dbtn') || el).focus({ preventScroll: true });
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
      // Soon: a quiet "No date" label where the undated tasks start, when there are both.
      // Soon's labels: "This week" on top when anything is flagged, then "Dated" (only under This
      // week), then a quiet "No date" where the undated tasks start, when there are both.
      const soon = ui.section === 'soon';
      const flagged = soon ? rows.filter((it) => it.week === true).length : 0;
      const rest = rows.slice(flagged);
      const dated = flagged && rest.length && dueKey(rest[0]) ? flagged : -1;
      const firstUndated = rest.findIndex((it) => !dueKey(it));
      const undated = soon && firstUndated >= 0 ? flagged + firstUndated : -1;
      const label = (i) => (flagged && i === 0 ? '<li class="sublabel sublabel-week">This week<span>' + flagged + ' left</span></li>'
        : i === dated ? '<li class="sublabel">Dated</li>'
        : i === undated && i > 0 ? '<li class="sublabel">No date</li>' : '');
      html = rows.map((it, i) => label(i) + rowHtml(it, justAdded.has(it.id))).join('');
      if (!rows.length) {
        emptyText = !all.length ? (desk.matches ? 'Nothing here yet. Press N or click plus to add a task.' : 'Nothing here yet. Tap plus to add a task.')
          : ui.section === 'today' && doneToday(all) ? ALL_DONE : EMPTY[ui.section];
      }
    } else {
      const done = doneList();
      dayXp = new Map();
      for (const it of done) { const d = midnight(new Date(it.doneAt)); dayXp.set(d, (dayXp.get(d) || 0) + xpSum(paysAt(it))); }
      html = doneRows(done, 0, doneShown, '');
      if (done.length > doneShown) html += MORE;
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
    empty.classList.toggle('all-done', emptyText === ALL_DONE);
    const rewards = emptyText === ALL_DONE ? rewardsHtml() : '';
    const rw = $('rewards');
    if (rw.innerHTML !== rewards) rw.innerHTML = rewards;
    rw.hidden = !rewards;
    renderWeek(view === 'done' && loaded ? doneList() : []);
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
    if (target) focusRow(target);
    pendingFocus = null;

    const more = list.querySelector('.dmore');
    moreObserver.disconnect();
    if (more) moreObserver.observe(more);
    // B6: the first list with rows after load.
    if (!nudgeSeen && ids && ids.size) { nudgeSeen = true; maybeNudge(); }
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
    if (entries.some((e) => e.isIntersecting)) moreDone();
  });
  // The next page of Done goes in at the sentinel, and the rows already there stay as they are.
  // A day split across the pages keeps its one header. When the list is behind the model
  // (a change waits to be drawn), the whole list is drawn instead.
  function moreDone() {
    const list = $('list');
    const more = list.querySelector('.dmore');
    if (!more || view !== 'done' || shownKey !== 'done') return;
    const done = doneList();
    const next = doneShown + DONE_PAGE;
    if (lastHtml !== doneRows(done, 0, doneShown, '') + MORE) { doneShown = next; render(); return; }
    const heads = list.querySelectorAll('.dhead');
    moreObserver.disconnect();
    more.insertAdjacentHTML('beforebegin', doneRows(done, doneShown, next, heads.length ? heads[heads.length - 1].textContent : ''));
    doneShown = next;
    const again = done.length > doneShown;
    if (again) moreObserver.observe(more); else more.remove();
    lastHtml = doneRows(done, 0, doneShown, '') + (again ? MORE : '');
  }

  // First use: the top row slides a little way right over the soft done fill, once. Only with
  // both sheets down, so it is seen; it counts as shown once it has played to the end.
  let nudgeSeen = false;
  function maybeNudge() {
    if (ui.nudged || M.reduced || view !== 'list' || desk.matches || matchMedia('(hover: hover)').matches) return;
    if (!$('capture').hidden || !$('edit').hidden) return;
    const first = $('list').querySelector('.row:not(.skeleton)');
    if (!first || first.classList.contains('nudge')) return;
    first.classList.add('nudge');
    first.addEventListener('animationend', (e) => {
      if (e.animationName !== 'nudge') return;
      first.classList.remove('nudge');
      ui.nudged = true;
      saveUi();
    });
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
    say(text);
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
  // The toast's Undo, from its button or Ctrl/Cmd+Z. Only while the toast is up.
  function undo() {
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
    say('Undone.');
  }
  $('toastUndo').addEventListener('click', undo);

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
    // Done rows and day headers carry padding, and desktop rows their 8px margin, which a height
    // of 0 can not close.
    for (const k of ['paddingTop', 'paddingBottom', 'borderTopWidth', 'marginBottom']) {
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
    if (e.target.closest('.link')) {
      if (revealed === row) { e.preventDefault(); closeReveal(); }
      return; // the browser opens it
    }
    if (revealed === row) { closeReveal(); return; }
    if (e.target.closest('.circle')) { completeRow(row); return; }
    if (e.target.closest('.move-btn')) { openMenu(row, e.target.closest('.move-btn')); return; }
    openTask(row.dataset.id);
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
    if (menuRow && menuRow !== row) expand(menuRow, false);
    menuRow = row;
    menuOn = true;
    menuOpener = anchor || row;
    expand(row, true);
    menu.innerHTML = '<div class="meta menu-title">Move to</div>' + SECTIONS.map((s) =>
      '<button class="sec" role="menuitem" data-move="' + s + '"' + (s === it.section ? ' aria-current="true" aria-disabled="true"' : '') + '>' + LABEL[s] + '</button>').join('') +
      '<div class="menu-sep"></div><button class="sec sec-week" role="menuitemcheckbox" data-week aria-checked="' + (it.week === true) + '">' +
      WEEK_ICON.replace('role="img" aria-label="This week"', 'aria-hidden="true"') + (it.week === true ? 'Not this week' : 'This week') + '</button>';
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
  // The row lights up and its move button says the menu is open.
  function expand(row, on) {
    row.classList.toggle('menu-open', on);
    const b = row.querySelector('.move-btn');
    if (b) b.setAttribute('aria-expanded', String(on));
  }
  // refocus false: focus has already gone somewhere else and stays there.
  function closeMenu(refocus = true) {
    if (!menuOn) return;
    menuOn = false;
    const back = refocus && menu.contains(document.activeElement) ? menuOpener : null;
    const row = menuRow;
    menuOpener = null;
    if (menuRow) expand(menuRow, false);
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
    if (b.hasAttribute('data-week')) { if (row) setWeek(row.dataset.id, !(items[row.dataset.id] && items[row.dataset.id].week === true)); closeMenu(); return; }
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
  // Focus moving out of the menu closes it (Tab is handled with the keys).
  menu.addEventListener('focusout', (e) => {
    if (menuOn && e.relatedTarget && !menu.contains(e.relatedTarget)) closeMenu(false);
  });

  /* ---------- Sheets ---------- */
  // The sheets and the confirm are modal: what is behind them goes inert, and focus goes
  // back to the opener when they close (pass opener false on close to skip that).
  const modals = new Map(); // open wrap -> { el, id, key } of its opener
  // Whether the last thing Paul did was a key press, so a sheet knows how it was opened.
  let keyed = false;
  document.addEventListener('keydown', () => { keyed = true; }, true);
  document.addEventListener('pointerdown', () => { keyed = false; }, true);
  function modal(open, wrap, opener) {
    const box = wrap.querySelector('.sheet, .dialog');
    const back = open ? null : modals.get(wrap);
    if (open) {
      box.setAttribute('aria-modal', 'true');
      const el = opener || document.activeElement;
      const row = el && el.closest ? el.closest('#list > [data-id]') : null;
      modals.set(wrap, { el, id: row ? row.dataset.id : null, key: keyed || desk.matches });
    } else {
      box.removeAttribute('aria-modal');
      modals.delete(wrap);
    }
    const on = modals.size > 0;
    for (const el of [document.querySelector('.sidebar'), document.querySelector('main'), $('fab'), $('switcher'), toastEl]) el.inert = on;
    $('edit').inert = modals.has($('confirm'));
    if (!back || opener === false) return;
    const a = document.activeElement;
    // A sheet a finger opened on the phone gives no focus back, or the add button or the row would
    // light up with a focus ring. Focus only goes back when it came from the keyboard.
    if (!back.key && wrap.classList.contains('sheet-wrap')) { if (a && wrap.contains(a)) a.blur(); return; }
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
      maybeNudge();
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
    capUndo = null;
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
  function addCapLine(t, id) {
    const ul = $('capAdded');
    const first = !ul.firstElementChild;
    const li = document.createElement('li');
    li.dataset.id = id;
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
  // A tidy that lands while the sheet is open: the ticked line crossfades to the tidied words and
  // carries its own Undo, so what the sheet shows matches the list. A line already gone (past three)
  // keeps its Undo for the toast when the sheet closes; so does the newest line still showing one.
  let capUndo = null;
  function swapCapText(el, text) {
    el.textContent = text;
    play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: M.press, easing: 'ease' });
  }
  function capTidied(id, typed, clean, undo) {
    capUndo = { id, undo };
    const li = $('capAdded').querySelector('li[data-id="' + id + '"]:not(.leaving)');
    const p = nameParts({ text: clean });
    const shown = p.name + (p.due ? ' · ' + dueLabel(p.due).words + (p.time ? ' ' + p.time : '') : ''); // as the list row reads it
    if (!li) return say('Tidied: ' + shown + '.');
    swapCapText(li.querySelector('.t'), shown);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cap-undo';
    b.textContent = 'Undo';
    b.setAttribute('aria-label', 'Undo tidy, back to ' + typed);
    b.addEventListener('click', () => {
      undo();
      if (capUndo && capUndo.id === id) capUndo = null;
      swapCapText(li.querySelector('.t'), typed);
      b.remove();
      say('Undone.');
      capInput.focus();
    });
    li.append(b);
    play(b, [{ opacity: 0 }, { opacity: 1 }], { duration: M.press, easing: 'ease' });
    say('Tidied: ' + shown + '.');
  }
  let capClosing = false;
  function closeCapture() {
    if (capClosing || $('capture').hidden) return; // Escape, a tap outside and a swipe can all arrive
    capClosing = true;
    const v = cleanText(capInput.value);
    capInput.value = '';
    capInput.blur();
    if (v) addTask(v); // written at the tap: the page can hide before the sheet has left
    const held = capUndo;
    capUndo = null;
    closeSheet($('capture'), () => {
      capClosing = false;
      if (held && tidied[held.id]) toast('Tidied.', held.undo, held.id);
    });
  }
  capInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const v = cleanText(capInput.value);
      if (!v) return closeCapture(); // Return on an empty field means finished
      const id = addTask(v);
      capAdded.push(v);
      addCapLine(v, id);
      capInput.value = '';
      say('Added to ' + LABEL[ui.section] + '.');
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
      if (cleanText(inlineInput.value)) say('Added to ' + LABEL[ui.section] + '.');
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
    editFrom = { id, section: it.section, pos: it.pos, text: it.text };
    editText.value = it.text.replace(INTAKE_MARK, ''); // the mark stays on the task, not in the box
    showFrom(it);
    $('editApply').hidden = !isApply(it);
    paintEditEnergy(it);
    $('editWait').hidden = !!it.waiting; // a chase task is already part of one
    const seg = $('editSeg');
    seg.classList.add('instant');
    paintEditSeg(it.section);
    repStarted = false;
    $('editRepeat').classList.add('instant');
    paintRepeat(it);
    $('editWeek').checked = it.week === true;
    requestAnimationFrame(() => $('editRepeat').classList.remove('instant'));
    const a = document.activeElement;
    openSheet($('edit'), undefined, list.contains(a) ? a : desk.matches ? row : null);
    // The thumb takes its place in this frame; it glides again from the next one.
    void seg.offsetWidth;
    requestAnimationFrame(() => seg.classList.remove('instant'));
    if (desk.matches) { editText.focus(); editText.setSelectionRange(editText.value.length, editText.value.length); }
    else $('editClose').focus({ preventScroll: true }); // on the phone the keyboard waits for a tap in the text
  }
  function paintEditSeg(section) {
    for (const b of document.querySelectorAll('#editSeg button')) {
      const on = b.dataset.section === section;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1; // one tab stop; the arrows move inside
    }
  }
  $('editSeg').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const bs = Array.from($('editSeg').querySelectorAll('button'));
    const i = Math.max(0, bs.indexOf(document.activeElement));
    const b = bs[(i + step + bs.length) % bs.length];
    b.focus();
    b.click(); // a radio group: the arrow picks as it moves
  });
  /* Repeat in the edit sheet (2026-10-21). The date lives in the text, as Tidy writes it: the date
   * field rewrites that ending, and a repeat on a task with no date starts today (the field shows
   * it, to change). Bins come from the bin calendar, so their sheet only says so. */
  const repDate = $('repDate');
  const repUntil = $('repUntil');
  let repStarted = false; // this sheet gave the task its first date
  function withDate(text, date) {
    const mark = text.match(INTAKE_MARK);
    const body = mark ? text.slice(0, mark.index) : text;
    const m = body.match(DUE);
    const head = m ? body.slice(0, m.index) : body;
    return cleanText(head + ' · ' + date + (m && m[2] ? ' ' + m[2] + ':' + m[3] : '') + (mark ? mark[0] : ''));
  }
  function paintRepeat(it) {
    const r = it.repeat || null;
    const bins = !!r && r.every === 'bins';
    $('editRepeatHead').hidden = bins;
    $('editRepeat').hidden = bins;
    for (const b of document.querySelectorAll('#editRepeat button')) {
      const on = (r && !bins ? r.every : '') === b.dataset.every;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const more = !!r && !bins;
    $('editRepeatMore').hidden = !more;
    const note = $('repNote');
    note.hidden = !bins && !more;
    if (bins) { note.textContent = 'From the bin calendar. Tick it off and the next collection’s comes in.'; return; }
    if (!more) return;
    const due = nameParts(it).due;
    $('repDateLabel').textContent = repStarted ? 'First date' : 'Next';
    repDate.value = due || '';
    repUntil.value = r.until || '';
    repUntil.closest('.rep-end').classList.toggle('set', !!r.until);
    $('repUntilClear').textContent = r.until ? 'Clear' : 'Never';
    // The dates that follow, so the schedule can be checked at a glance.
    const after = [];
    for (let d = due, i = 0; d && i < 3; i++) { d = nextDate(d, r.every, d, r.until); if (d) after.push(shortDay(d)); }
    note.textContent = !due ? '' : !after.length ? 'This is the last one.'
      : 'Then ' + after.join(', ') + (r.until && after.length < 3 ? ', and it stops.' : ' and so on.');
  }
  // Writes a change made in the sheet; text the sheet wrote itself is not "edited" (no Tidy).
  function repWrite(next) {
    if (editFrom && items[editId] && editFrom.text === items[editId].text) editFrom.text = next.text;
    upsert(next);
    editText.value = next.text.replace(INTAKE_MARK, '');
    paintRepeat(items[editId]);
  }
  function setRepeat(every) {
    saveEditText();
    const it = items[editId];
    if (!it || ((it.repeat && it.repeat.every) || '') === every) return;
    const next = Object.assign({}, it, { repeat: every ? { every, until: (it.repeat && it.repeat.until) || null } : null });
    if (every && !nameParts(it).due) { next.text = withDate(it.text, ymd(new Date())); repStarted = true; }
    repWrite(next);
  }
  for (const b of document.querySelectorAll('#editRepeat button')) b.addEventListener('click', () => setRepeat(b.dataset.every));
  $('editWeek').addEventListener('change', () => { saveEditText(); if (editId) setWeek(editId, $('editWeek').checked, false); });
  repDate.addEventListener('change', () => {
    const it = items[editId];
    if (!it) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(repDate.value)) { paintRepeat(it); return; } // cleared: the date stays
    saveEditText();
    repWrite(Object.assign({}, items[editId], { text: withDate(items[editId].text, repDate.value) }));
  });
  repUntil.addEventListener('change', () => {
    const it = items[editId];
    if (!it || !it.repeat) return;
    const until = /^\d{4}-\d{2}-\d{2}$/.test(repUntil.value) ? repUntil.value : null;
    repWrite(Object.assign({}, it, { repeat: { every: it.repeat.every, until } }));
  });
  $('repUntilClear').addEventListener('click', () => {
    const it = items[editId];
    if (!it || !it.repeat) return;
    if (it.repeat.until) { repWrite(Object.assign({}, it, { repeat: { every: it.repeat.every, until: null } })); return; }
    try { repUntil.showPicker(); } catch (e) { repUntil.focus(); }
  });
  $('editRepeat').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const bs = Array.from($('editRepeat').querySelectorAll('button'));
    const i = Math.max(0, bs.indexOf(document.activeElement));
    const b = bs[(i + step + bs.length) % bs.length];
    b.focus();
    b.click();
  });
  function saveEditText() {
    clearTimeout(editTimer);
    const it = items[editId];
    let t = cleanText(editText.value);
    if (it && t && isIntake(it) && !INTAKE_MARK.test(t)) t = cleanText(t + ' [intake]') || t;
    if (it && t && t !== it.text) upsert(Object.assign({}, it, { text: t }));
  }
  function closeEdit(after) {
    if (editId === null) return; // already closing
    saveEditText();
    editText.blur();
    editId = null;
    const from = editFrom;
    editFrom = null;
    // A changed text is tidied like a new task (Paul, 2026-10-17), once the sheet is closed.
    const edited = from && items[from.id];
    if (edited && !edited.done && edited.text !== from.text) {
      if (tidied[edited.id] === from.text) teach('edited', from.text, edited.text);
      if (INTAKE_MARK.test(from.text)) report('intake', 'edited', from.text, edited.text);
      delete tidied[edited.id];
      tidyLater(edited.id, edited.text, true);
    }
    // Focus goes back to the row it opened from. A task that ended up in another section says
    // where it went, once, however many times the section was changed.
    closeSheet($('edit'), () => {
      if (typeof after === 'function') { after(); return; }
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
    const gone = items[id];
    if (gone && !gone.done && isIntake(gone)) report('intake', 'skipped', gone.text); // Claude made a task he didn't want
    remove(id); // written at the tap; the row collapses behind the leaving sheet
    closeSheet($('edit'));
  });

  /* ---------- Letter cards ----------
   * A task Intake made from an official letter opens as a card instead of the edit sheet
   * (worker/src/letters.js): what they want, the deadline and days left, copy buttons for the
   * amount, IBAN, reference and case number ("not on file" when the letter has none), the
   * letter's own choices, a link to the sender's portal, and Done. The card is fetched each time
   * it opens and never kept on the device, since it holds the IBAN and references in full; only
   * which tasks have a card is kept. It prepares and nothing more: nothing here pays, submits or
   * sends. Done asks the date and how, and the Worker ticks the task. */
  const CARDS_KEY = 'todo.cards.' + code;
  let cardIds = new Set(store.get(CARDS_KEY) || []);
  let cardId = null;
  let card = null; // the open card, or { error } / null while it loads
  let cardDone = null; // { date, how } while Done is asking
  let cardChanging = false; // the next step's card shows the options again (Change)
  const HOWS = [['paid', 'Paid'], ['form sent', 'Form sent'], ['called', 'Called']];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const localDay = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD on this device
  const dayText = (d) => { const t = new Date(d + 'T12:00:00Z'); return WD[t.getUTCDay()] + ' ' + t.getUTCDate() + ' ' + MON[t.getUTCMonth()]; };
  const shortDay = (d) => +d.slice(8, 10) + ' ' + MON[+d.slice(5, 7) - 1];

  async function loadCards() {
    try {
      const r = await fetch(API + '/api/intake/' + code + '/cards', { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      if (!d || !Array.isArray(d.tasks)) return;
      cardIds = new Set(d.tasks);
      store.set(CARDS_KEY, d.tasks);
    } catch (e) { /* a letter opens in the edit sheet until the list arrives */ }
  }
  function openTask(id) {
    if (cardIds.has(id)) openCard(id);
    else openEdit(id);
  }
  async function openCard(id) {
    const it = items[id];
    const row = list.querySelector('.row[data-id="' + id + '"]');
    if (!it || leaving.has(id) || (row && gone(row))) return;
    cardId = id;
    card = null;
    cardDone = null;
    cardChanging = false;
    renderCard();
    const a = document.activeElement;
    openSheet($('card'), 0, list.contains(a) ? a : desk.matches ? row : null);
    $('cardClose').focus({ preventScroll: true });
    try {
      const r = await fetch(API + '/api/intake/' + code + '/card/' + id, { cache: 'no-store' });
      const d = await r.json().catch(() => null);
      if (cardId !== id) return;
      if (r.status === 404) { closeCard(() => openEdit(id)); return; } // no card after all
      card = r.ok && d && d.card ? d.card : { error: true };
    } catch (e) {
      if (cardId !== id) return;
      card = { error: true };
    }
    renderCard();
  }
  function closeCard(after) {
    if (cardId === null) return;
    cardId = null;
    closeSheet($('card'), typeof after === 'function' ? after : undefined);
  }

  function money(a) {
    try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: a.currency || 'EUR' }).format(a.value); } catch (e) { return a.value.toFixed(2) + ' ' + a.currency; }
  }
  // What goes on the clipboard: the way Dutch bank apps take it.
  function copyValue(k) {
    if (k === 'amount') return card.amount.value.toFixed(2).replace('.', ',');
    if (k === 'iban') return card.iban.replace(/\s+/g, '');
    if (k === 'reference') return card.reference.replace(/\s+/g, '');
    return card.caseNumber;
  }

  function renderCard() {
    const body = $('cardBody');
    if (!card || card.error) {
      $('cardFrom').textContent = 'Letter';
      body.innerHTML = card && card.error
        ? '<p class="card-note">Can’t load the card right now.</p><button class="card-edit" data-act="edit">Edit task</button>'
        : '<p class="card-note">Loading…</p>';
      return;
    }
    $('cardFrom').textContent = (card.sender || 'Letter') + (card.letterDate ? ' · letter of ' + shortDay(card.letterDate) : '');
    let due = '';
    if (card.due) {
      const n = Math.round((Date.parse(card.due) - Date.parse(localDay())) / 864e5);
      const left = n < 0 ? (n === -1 ? '1 day late' : -n + ' days late') : n === 0 ? 'Due today' : n === 1 ? '1 day left' : n + ' days left';
      due = '<div class="card-due"><span>Due <b>' + esc(dayText(card.due)) + '</b></span><span class="card-left' + (n < 0 ? ' late' : '') + '">' + esc(left) + '</span></div>';
    }
    const facts = [
      ['amount', 'Amount', '', card.amount ? money(card.amount) : null],
      ['iban', 'IBAN', '', card.iban],
      ['reference', 'Reference', card.referenceLabel, card.reference],
      ['case', 'Case number', card.caseLabel, card.caseNumber],
    ].map(([k, label, sub, v]) => '<div class="card-fact"><span class="card-k">' + esc(label) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
      (v ? '<span class="card-v">' + esc(v) + '</span><button class="card-copy" data-copy="' + k + '" aria-label="Copy ' + esc(label.toLowerCase()) + '">Copy</button>'
         : '<span class="card-v none">not on file</span><span></span>') + '</div>').join('');
    // A choice closes the letter (2026-10-21): the options are Choose buttons; the pick ticks this
    // task and brings in the next step on the deadline, which opens this card with the choice
    // stamped and a Change. A done letter keeps the old read-only list.
    const ch = card.chosen;
    const onNext = !!(ch && ch.isNext);
    let opts = '';
    if (card.options.length && card.done) {
      opts = '<div class="meta">The letter offers</div><div class="card-opts" role="radiogroup" aria-label="Options">' +
        card.options.map((o, i) => '<button class="card-opt" role="radio" aria-checked="' + (card.pick === i) + '" disabled>' +
          '<span class="card-dot" aria-hidden="true"></span><span><b>' + esc(o.title) + '</b>' + (o.detail ? '<span>' + esc(o.detail) + '</span>' : '') + '</span></button>').join('') + '</div>';
    } else if (card.options.length && onNext && !cardChanging) {
      opts = '<div class="card-chosen"><span>You chose <b>' + esc(ch.title) + '</b>' + (ch.on ? ' on ' + esc(shortDay(ch.on)) : '') + '</span>' +
        '<button class="card-change" data-act="change">Change</button></div>';
    } else if (card.options.length) {
      opts = '<div class="meta">' + (onNext ? 'Choose again. The next step changes with it.' : 'Choose one. It closes this letter and adds the next step on the deadline.') + '</div>' +
        '<div class="card-opts" role="group" aria-label="The letter offers">' +
        card.options.map((o, i) => '<button class="card-opt card-choose" data-choose="' + i + '" aria-pressed="' + (card.pick === i) + '">' +
          '<span><b>' + esc(o.title) + '</b>' + (o.detail ? '<span>' + esc(o.detail) + '</span>' : '') + '</span><span class="card-choose-go">' + (onNext && card.pick === i ? 'Chosen' : 'Choose') + '</span></button>').join('') + '</div>' +
        (cardChanging ? '<button class="card-edit" data-act="keep">Keep ' + esc(ch.title.toLowerCase()) + '</button>' : '');
    }
    const portal = card.portal ? '<a class="card-portal" href="' + esc(card.portal.url) + '" target="_blank" rel="noopener noreferrer"><span>' + esc(card.portal.name) +
      '<small>' + esc(card.portal.host) + '</small></span><span class="card-open">Open ›</span></a>' : '';
    let foot;
    if (card.done) {
      const pick = card.pick !== null && card.options[card.pick] ? ' · ' + card.options[card.pick].title.toLowerCase() : '';
      foot = '<div class="card-stamp">✓ Done ' + esc(shortDay(card.done.date)) + ' · ' + esc(card.done.how) + esc(pick) + '</div>';
    } else if (cardDone) {
      foot = '<div class="card-ask"><label class="meta" for="cardDate">When</label><input id="cardDate" type="date" max="' + localDay() + '" value="' + esc(cardDone.date) + '">' +
        '<div class="meta">How</div><div class="card-hows" role="group" aria-label="How">' +
        HOWS.map(([v, l]) => '<button data-how="' + v + '" aria-pressed="' + (cardDone.how === v) + '">' + l + '</button>').join('') + '</div>' +
        '<div class="card-ask-row"><button class="card-cancel" data-act="cancel">Cancel</button><button class="card-save" data-act="save"' + (cardDone.how ? '' : ' disabled') + '>Save</button></div></div>';
    } else if (card.options.length && !onNext) {
      foot = '<p class="card-note">This card only prepares. Paying or sending happens elsewhere.</p>'; // choosing closes it
    } else {
      foot = '<button class="card-done" data-act="done">Done</button><p class="card-note">This card only prepares. Paying or sending happens elsewhere.</p>';
    }
    // The next step's card leads with the step itself; the letter's own card with what it wants.
    const want = onNext && items[cardId] ? nameParts(items[cardId]).name : card.want;
    body.innerHTML = '<p class="card-want">' + esc(want) + '</p>' + due + '<div class="card-facts">' + facts + '</div>' + opts + portal + foot +
      '<button class="card-edit" data-act="edit">Edit task</button>';
  }

  async function cardPost(payload) {
    const id = cardId;
    const r = await fetch(API + '/api/intake/' + code + '/card/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.card) throw new Error((d && d.error) || 'status ' + r.status);
    if (cardId === id) { card = d.card; renderCard(); }
    return d;
  }
  // Undo of a choice: the letter's task opens again and the next step goes (any of the two ids works).
  async function unchoose(id) {
    try {
      const r = await fetch(API + '/api/intake/' + code + '/card/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unchoose: true }) });
      if (!r.ok) throw new Error('status ' + r.status);
      poll();
      say('Undone.');
    } catch (e) { toast(navigator.onLine ? 'Couldn’t undo that. Try again.' : 'Needs a connection.'); }
  }
  async function chooseOption(i, b) {
    const onNext = !!(card.chosen && card.chosen.isNext);
    if (onNext && card.pick === i) { cardChanging = false; renderCard(); return; }
    const title = card.options[i].title;
    const due = card.due;
    for (const x of $('cardBody').querySelectorAll('[data-choose]')) x.disabled = true;
    b.querySelector('.card-choose-go').textContent = 'Choosing…';
    try {
      const d = await cardPost({ choose: i });
      cardChanging = false;
      poll(); // the Worker ticked the letter and added the next step; draw them
      loadCards(); // the next step opens as this card too
      if (onNext) { renderCard(); say('Changed to ' + title + '.'); return; }
      const next = d.next && d.next.id;
      closeCard(() => toast('Chose ' + title.toLowerCase() + '. Next step added' + (due ? ' for ' + shortDay(due) : '') + '.', next ? () => unchoose(next) : null, next));
    } catch (err) {
      renderCard();
      toast(navigator.onLine ? 'Couldn’t save that. Try again.' : 'Needs a connection.');
    }
  }

  $('cardBody').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !card) return;
    if (card.error && b.dataset.act !== 'edit') return;
    if (b.dataset.copy) {
      const v = copyValue(b.dataset.copy);
      const done = (ok) => {
        b.textContent = ok ? 'Copied' : 'Select';
        b.classList.toggle('ok', ok);
        say(ok ? 'Copied' : 'Could not copy');
        setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('ok'); }, 1400);
        if (!ok) { const s = getSelection(); const r = document.createRange(); r.selectNodeContents(b.previousElementSibling); s.removeAllRanges(); s.addRange(r); }
      };
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => done(true), () => done(false));
      return;
    }
    if (b.dataset.pick !== undefined) {
      const i = +b.dataset.pick;
      if (card.pick === i) return;
      const was = card.pick;
      card.pick = i;
      renderCard();
      try { await cardPost({ pick: i }); say('Saved'); } catch (err) { card.pick = was; renderCard(); toast('Couldn’t save that. Try again.'); }
      return;
    }
    if (b.dataset.choose !== undefined) { chooseOption(+b.dataset.choose, b); return; }
    if (b.dataset.how) { cardDone.how = b.dataset.how; cardDone.date = $('cardDate').value || cardDone.date; renderCard(); return; }
    const act = b.dataset.act;
    if (act === 'change') { cardChanging = true; renderCard(); return; }
    if (act === 'keep') { cardChanging = false; renderCard(); return; }
    if (act === 'edit') { const id = cardId; closeCard(() => openEdit(id)); return; }
    if (act === 'done') { cardDone = { date: localDay(), how: null }; renderCard(); $('cardDate').focus({ preventScroll: true }); return; }
    if (act === 'cancel') { cardDone = null; renderCard(); return; }
    if (act === 'save') {
      const date = $('cardDate').value;
      if (!date || date > localDay() || !cardDone.how) return;
      b.disabled = true;
      try {
        await cardPost({ done: { date, how: cardDone.how } });
        cardDone = null;
        renderCard();
        poll(); // the Worker ticked the task; draw it
        say('Done. Ticked off.');
      } catch (err) {
        b.disabled = false;
        toast(navigator.onLine ? 'Couldn’t save that. Try again.' : 'Needs a connection.');
      }
    }
  });
  $('cardClose').addEventListener('click', () => closeCard());
  $('card').querySelector('.scrim').addEventListener('click', () => closeCard());

  /* ---------- Applications: an "Apply: ..." task, prepared on Paul's PC ----------
   * The edit sheet of an Apply task (from the defence digest, with its vacancy link) offers
   * Prepare on the PC. That queues it (POST /api/apply/:code/:taskId); the PC builds a folder with
   * the right CV, the letter in Word, the vacancy text and a checklist (PAUL AGENTS/applications,
   * every morning at 07:30 or from the Desktop), then reports it. The sheet shows where it stands,
   * and once ready the fit, the gaps and the letter. Nothing is sent to an employer. */
  let apId = null;
  let ap = null; // { loading } | { state: 'none' | 'queued' | 'ready', ... } | { error }
  const isApply = (it) => !!it && !it.done && /^Apply:/i.test(it.text);
  const FIT = (n) => (n >= 7 ? 'good' : n >= 5 ? 'fair' : 'weak');
  const WHEN = 'every morning at 07:30, or now with Prepare applications on the PC’s Desktop';

  function openApply(id) {
    const it = items[id];
    if (!isApply(it)) return;
    apId = id;
    ap = { loading: true };
    renderApply();
    openSheet($('apply'), 0, null);
    $('apClose').focus({ preventScroll: true });
    loadApply(id);
  }
  async function apFetch(id, post) {
    const r = await fetch(API + '/api/apply/' + code + '/' + id, post ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : { cache: 'no-store' });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.state) throw new Error((d && d.error) || 'status ' + r.status);
    return d;
  }
  async function loadApply(id) {
    try {
      const d = await apFetch(id);
      if (apId === id) ap = d;
    } catch (e) {
      if (apId === id) ap = { error: navigator.onLine ? 'Couldn’t reach the hub. Try again.' : 'Needs a connection.' };
    }
    if (apId === id) renderApply();
  }
  async function queueApply(id) {
    ap = { loading: true };
    renderApply();
    try {
      const d = await apFetch(id, true);
      if (apId === id) { ap = d; say('Queued for your PC'); }
    } catch (e) {
      if (apId === id) ap = { error: navigator.onLine ? 'Couldn’t queue it. Try again.' : 'Needs a connection.' };
    }
    if (apId === id) renderApply();
  }
  const clock = (iso) => { const d = new Date(iso); return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
  function renderApply() {
    const body = $('apBody');
    const it = items[apId];
    const task = it ? it.text.replace(/^Apply:\s*/i, '').replace(INTAKE_MARK, '') : '';
    const head = '<p class="card-want">' + esc(task) + '</p>';
    const link = it && it.link ? '<a class="card-portal" href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer"><span>Vacancy<small>' + esc(hostOf(it.link)) + '</small></span><span class="card-open">Open ›</span></a>' : '';
    if (!ap || ap.loading) { body.innerHTML = head + '<p class="ap-wait">Loading…</p>'; return; }
    if (ap.error) { body.innerHTML = head + '<p class="ap-say">' + esc(ap.error) + '</p><button class="card-done" data-act="reload">Try again</button>'; return; }
    if (ap.state === 'none') {
      body.innerHTML = head + '<p class="ap-say">Your PC builds a folder for this vacancy: the CV version that fits, the letter in Word in your own voice, the vacancy text and a checklist with the fit and the gaps.</p>' +
        '<button class="card-done" data-act="queue">Prepare on the PC</button>' + link +
        '<p class="card-note">It runs ' + WHEN + '. Nothing is sent.</p>';
      return;
    }
    if (ap.state === 'queued') {
      body.innerHTML = head + '<div class="ap-fit fit-queued"><b>Queued for your PC</b><span>Since ' + esc(clock(ap.queuedAt)) + '. The folder appears in Documents › Applications after the next run.</span><small>Runs ' + esc(WHEN) + '.</small></div>' + link;
      return;
    }
    const d = ap.draft;
    const folder = String(ap.folder || '').split(/[\\/]/).pop();
    const gaps = d.gaps.length ? '<div class="meta">Gaps to cover</div><ul class="ap-gaps">' + d.gaps.map((g) => '<li>' + esc(g) + '</li>').join('') + '</ul>' : '';
    body.innerHTML = head +
      '<div class="ap-fit fit-' + FIT(d.fit) + '"><b>Fit ' + d.fit + '/10</b><span>' + esc(d.fitLine) + '</span><small>Uses your ' + esc(d.cvLabel) + ' CV' + (d.deadline ? ' · closes ' + esc(d.deadline) : '') + '</small></div>' +
      '<div class="ap-folder"><span class="meta">Folder ready on your PC</span><b>' + esc(folder) + '</b><small>Documents › Paul - Job Search &amp; Career › Applications</small></div>' +
      gaps +
      '<details class="ap-more"><summary>Letter · ' + (d.lang === 'nl' ? 'Dutch' : 'English') + '</summary><p class="hb-draft ap-letter">' + esc(d.letter) + '</p>' +
      '<div class="hb-btns"><button class="hb-copy" data-act="copy">Copy letter</button></div></details>' +
      link +
      '<p class="hb-note">Nothing is sent. Check the folder, then apply on the site yourself. <button class="hb-again" data-act="queue">Prepare again</button></p>';
  }
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  function closeApply() {
    if (apId === null) return;
    apId = null;
    closeSheet($('apply'));
  }
  $('apBody').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || apId === null) return;
    const act = b.dataset.act;
    if (act === 'queue') queueApply(apId);
    else if (act === 'reload') { ap = { loading: true }; renderApply(); loadApply(apId); }
    else if (act === 'copy' && ap && ap.draft) {
      const done = (ok) => { b.textContent = ok ? 'Copied' : 'Select it and copy'; say(ok ? 'Copied' : 'Could not copy'); setTimeout(() => { b.textContent = 'Copy letter'; }, 1400); };
      (navigator.clipboard ? navigator.clipboard.writeText(ap.draft.letter) : Promise.reject()).then(() => done(true), () => done(false));
    }
  });
  $('apClose').addEventListener('click', closeApply);
  $('apply').querySelector('.scrim').addEventListener('click', closeApply);
  $('editApply').addEventListener('click', () => { const id = editId; closeEdit(() => openApply(id)); });

  /* ---------- Ask: Claude answers in a sheet (Desk folded into To-do, 2026-10-19) ----------
   * Paul types everything into the same box ("I don't really know when to use Desk"). When Tidy
   * says a line is a question ("ask") or a message for Claude to write ("write"), it leaves the
   * list and goes to Desk (worker/src/desk.js, POST /api/desk/:code). The sheet shows the answer,
   * each draft with Copy and Share, and any task Claude suggests with Add. "Keep it as a task"
   * puts the line back as typed and tells the lessons loop Tidy got it wrong. Nothing is sent
   * from here; a draft only leaves through Paul's own Share or paste. */
  let askItem = null;
  let askWait = null; // an answer that came while another sheet was open
  let askTimer = 0;
  const LANG = { nl: 'Dutch', en: 'English', es: 'Spanish' };
  async function toDesk(id, typed, kind) {
    const section = items[id] ? items[id].section : ui.section;
    remove(id);
    delete tidied[id];
    const li = $('capAdded').querySelector('li[data-id="' + id + '"]:not(.leaving)');
    if (li) swapCapText(li.querySelector('.t'), 'For Claude: ' + typed);
    readingN++;
    readPill.querySelector('span').textContent = kind === 'write' ? 'Claude is writing' : 'Asking Claude';
    slotIn(readPill);
    say(kind === 'write' ? 'Claude is writing it.' : 'Asking Claude.');
    let why = 'Claude could not answer. Kept it as a task.';
    try {
      const r = await fetch(API + '/api/desk/' + code, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: typed }) });
      const d = await r.json().catch(() => null);
      if (refused(r.status, d)) return showNoCode();
      if (r.status === 429) why = 'Claude is busy. Kept it as a task.';
      if (!r.ok || !d || !d.item) throw new Error((d && d.error) || 'status ' + r.status);
      showAsk(Object.assign({}, d.item, { typed, kind, section }));
    } catch (e) {
      keepAsTask(typed, section);
      toast(why);
    } finally {
      if (--readingN === 0) slotOut(readPill);
    }
  }
  function keepAsTask(typed, section) {
    const id = newId();
    justAdded.add(id);
    upsert({ id, text: typed, section: SECTIONS.includes(section) ? section : ui.section, done: false, doneAt: null, pos: now() });
    tidyLater(id, typed, true); // tidied like any task, never sent to Claude again
  }
  // The answer waits for the capture sheet (or any other) to close, then opens.
  function showAsk(item) {
    if (!modals.size) return openAsk(item);
    askWait = item;
    say('Claude answered. It opens when you close this.');
    clearInterval(askTimer);
    askTimer = setInterval(() => {
      if (modals.size || !askWait) return;
      clearInterval(askTimer);
      const x = askWait;
      askWait = null;
      openAsk(x);
    }, 300);
  }
  function openAsk(item) {
    askItem = item;
    renderAsk();
    openSheet($('ask'), 0, null);
    $('askClose').focus({ preventScroll: true });
  }
  function renderAsk() {
    const it = askItem;
    if (!it) return;
    let html = '<p class="ask-line">' + esc(it.typed || it.text) + '</p>';
    if (it.answer) html += '<p class="ask-answer">' + esc(it.answer) + '</p>';
    it.actions.forEach((a, i) => {
      if (a.kind === 'draft') {
        const head = [a.to ? 'To ' + a.to : 'Message', LANG[a.lang] || ''].filter(Boolean).join(' · ');
        const copied = a.state === 'copied';
        html += '<div class="ask-draft"><div class="meta">' + esc(head) + '</div><p>' + esc(a.text) + '</p><div class="ask-btns">' +
          '<button class="card-copy' + (copied ? ' ok' : '') + '" data-act="copy" data-i="' + i + '">' + (copied ? 'Copied' : 'Copy') + '</button>' +
          (navigator.share ? '<button class="ask-share" data-act="share" data-i="' + i + '">Share</button>' : '') + '</div></div>';
      } else if (a.kind === 'todo') {
        const on = a.state === 'approved';
        const p = nameParts({ text: a.text });
        const shown = p.name + (p.due ? ' · ' + dueLabel(p.due).words + (p.time ? ' ' + p.time : '') : '');
        html += '<div class="ask-task"><span class="ask-t">' + esc(shown) + '<small>' + (on ? 'In ' : 'For ') + LABEL[a.section] + '</small></span>' +
          '<button class="card-copy' + (on ? ' ok' : '') + '" data-act="' + (on ? 'undo' : 'add') + '" data-i="' + i + '" aria-label="' + (on ? 'Added. Tap to take it out again' : 'Add to ' + LABEL[a.section]) + '">' + (on ? 'Added' : 'Add') + '</button></div>';
      }
    });
    if (!it.answer && !it.actions.length) html += '<p class="ap-say">Claude had nothing to add.</p>';
    html += '<button class="ask-keep" data-act="keep">Keep it as a task instead</button>';
    $('askBody').innerHTML = html;
  }
  async function askAct(i, action) {
    const it = askItem;
    try {
      const r = await fetch(API + '/api/desk/' + code + '/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: it.id, idx: i, action }) });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !d.item) throw new Error((d && d.error) || 'status ' + r.status);
      if (askItem && askItem.id === it.id) { askItem = Object.assign({}, d.item, { typed: it.typed, kind: it.kind, section: it.section }); renderAsk(); }
      if (action === 'approve' || action === 'undo') poll(); // Desk wrote the task; draw it now
      return true;
    } catch (e) {
      toast(navigator.onLine ? 'Could not do that. Try again.' : 'Needs a connection.');
      return false;
    }
  }
  function closeAsk() {
    if (!askItem) return;
    askItem = null;
    closeSheet($('ask'));
  }
  $('askBody').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const it = askItem;
    if (!b || !it) return;
    const i = Number(b.dataset.i);
    const a = it.actions[i];
    const act = b.dataset.act;
    if (act === 'keep') {
      keepAsTask(it.typed, it.section);
      report('tidy', 'undone', it.kind + ': ' + it.typed, 'task'); // Tidy sent a task to Claude
      closeAsk();
      toast('Kept as a task.');
    } else if (act === 'add') askAct(i, 'approve').then((ok) => ok && say('Added to ' + LABEL[a.section]));
    else if (act === 'undo') askAct(i, 'undo').then((ok) => ok && say('Taken out again'));
    else if (act === 'copy' && a) {
      const done = (ok) => { if (ok) { askAct(i, 'copied'); say('Copied'); } else { b.textContent = 'Select it and copy'; say('Could not copy'); } };
      (navigator.clipboard ? navigator.clipboard.writeText(a.text) : Promise.reject()).then(() => done(true), () => done(false));
    } else if (act === 'share' && a) {
      navigator.share({ text: a.text }).then(() => askAct(i, 'copied'), () => {});
    }
  });
  $('askClose').addEventListener('click', closeAsk);
  $('ask').querySelector('.scrim').addEventListener('click', closeAsk);

  /* ---------- Energy ----------
   * The dial (Paul, 2026-10-21): wired, normal or drained. The hub holds the level for every app
   * (worker/src/energy.js) for 4 hours; tapping the level that is on clears it. Here it sits on
   * Today, with Give me one: one open task whose confirmed level matches. The pick is made on the
   * phone, so it works offline, with the hub's order copied from pickPool: Today then Soon, dated
   * by date, then the rest newest first, tasks for someone else last. Change both together.
   * "Not this one" is told to the hub, which counts it as a skip on that task. */
  const HOURS = 4;
  let energy = Object.assign({ level: null, until: null, source: null }, store.get('todo.energy') || {});
  let energyPending = null; // a tap not yet stored by the hub: { level }
  const levelOn = () => (energy.level && Date.parse(energy.until) > now() ? energy.level : null);
  const hm = (iso) => { const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const SOURCE_NAME = { morning: 'Morning', day: 'Day' };
  for (const seg of [$('energySeg'), $('editEnergy')]) {
    for (const b of seg.querySelectorAll('button')) b.innerHTML = battSvg(b.dataset.level) + '<span>' + LNAME[b.dataset.level] + '</span>';
  }
  const unsorted = () => Object.values(items).filter((i) => !i.done && !LEVELS.includes(i.energy));

  function renderEnergy() {
    const on = view === 'list' && ui.section === 'today' && loaded;
    $('energy').hidden = !on;
    if (!on) return;
    const level = levelOn();
    for (const b of $('energySeg').querySelectorAll('button')) {
      const sel = b.dataset.level === level;
      b.setAttribute('aria-checked', String(sel));
      b.tabIndex = sel || (!level && b.dataset.level === 'wired') ? 0 : -1;
    }
    $('energyText').textContent = level
      ? LNAME[level] + ' until ' + hm(energy.until) + (SOURCE_NAME[energy.source] ? ', set in ' + SOURCE_NAME[energy.source] : '')
      : 'How much energy have you got?';
    $('giveOne').hidden = !level;
    const n = unsorted().length;
    $('energySort').hidden = !n;
    $('energySort').textContent = n === 1 ? '1 task has no level yet. Sort it' : n + ' tasks have no level yet. Sort them';
  }

  function takeEnergy(d) {
    if (!d || !('level' in d)) return;
    const was = levelOn();
    energy = { level: d.level, until: d.until, source: d.source };
    store.set('todo.energy', energy);
    if (was !== levelOn()) { pickSkip = []; renderChrome(); if (!$('pick').hidden) closePick(); }
  }
  async function loadEnergy() {
    if (energyPending) return sendEnergy();
    try {
      const r = await fetch(API + '/api/energy/' + code, { cache: 'no-store' });
      if (r.ok) takeEnergy(await r.json());
    } catch (e) { /* the last known level stays */ }
    if (energy.level && !levelOn()) renderChrome(); // four hours ran out
  }
  async function sendEnergy() {
    const p = energyPending;
    if (!p || !navigator.onLine) return;
    try {
      const r = await fetch(API + '/api/energy/' + code, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: p.level, source: 'todo' }) });
      if (!r.ok) return;
      const d = await r.json();
      if (energyPending === p) { energyPending = null; takeEnergy(d); }
    } catch (e) { /* tried again on the next poll */ }
  }
  function setLevel(level) {
    const next = levelOn() === level ? null : level; // the level that is on: off again
    energy = next ? { level: next, until: new Date(now() + HOURS * 3600000).toISOString(), source: 'todo' } : { level: null, until: null, source: null };
    store.set('todo.energy', energy);
    energyPending = { level: next };
    pickSkip = [];
    renderChrome();
    say(next ? 'Energy ' + LNAME[next] : 'Energy cleared');
    sendEnergy();
  }
  for (const b of $('energySeg').querySelectorAll('button')) b.addEventListener('click', () => setLevel(b.dataset.level));
  $('energySeg').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; // Up and Down still walk the list
    if (!step) return;
    e.preventDefault();
    const bs = Array.from($('energySeg').querySelectorAll('button'));
    const i = Math.max(0, bs.indexOf(document.activeElement));
    bs[(i + step + bs.length) % bs.length].focus(); // moving does not set a level; Space or Enter does
  });

  // Copied from worker/src/energy.js (forSomeoneElse, pickPool).
  const PERSON = /^\p{Lu}[\p{L}'-]{1,23}: /u;
  const NOT_A_PERSON = new Set(['Apply', 'Choose', 'Pay', 'Note', 'Read', 'Call', 'Sollicitatie']);
  function forSomeoneElse(it) {
    if (it.section === 'others') return true;
    const m = it.text.match(PERSON);
    return !!m && !NOT_A_PERSON.has(m[0].slice(0, -2));
  }
  function pickPool(level) {
    const rows = Object.values(items).filter((it) => !it.done && it.energy === level && (it.section === 'today' || it.section === 'soon'))
      .map((it) => ({ it, others: forSomeoneElse(it) ? 1 : 0, sec: it.section === 'today' ? 0 : 1, key: dueKey(it) }));
    rows.sort((a, b) => a.others - b.others || a.sec - b.sec || (a.key ? 0 : 1) - (b.key ? 0 : 1)
      || (a.key && b.key ? a.key.localeCompare(b.key) : 0) || b.it.pos - a.it.pos);
    return rows.map((r) => r.it);
  }

  let pickSkip = [];  // turned down this round, for this level
  let pickCur = null; // the task on screen
  function pickNext(mode) {
    const level = levelOn();
    const pool = level ? pickPool(level) : [];
    const left = pool.filter((it) => !pickSkip.includes(it.id));
    let it = left[0] || null;
    if (mode === 'surprise' && left.length > 1) {
      const others = left.filter((x) => x.id !== pickCur);
      it = others[Math.floor(Math.random() * others.length)];
    }
    pickCur = it ? it.id : null;
    return { it, count: pool.length, position: pool.length - left.length + 1, level };
  }
  let pickShown = null;
  function renderPick(p) {
    pickShown = p;
    const L = p.level ? LNAME[p.level] : '';
    $('pickHead').innerHTML = p.level ? battSvg(p.level) + ' ' + esc(L) + (p.it ? ' · ' + p.position + ' of ' + p.count + ' that fit' : '') : '';
    let html;
    if (p.it) {
      const n = nameParts(p.it);
      const due = n.due ? 'due ' + dueLabel(n.due).words.toLowerCase().replace(/^(\d+ )(\w)/, (m, a, b) => a + b.toUpperCase()) + (n.time ? ' ' + n.time : '') : '';
      html = '<p class="pick-name">' + esc(n.name) + '</p>' +
        '<div class="pick-meta">' + skillSlot(p.it) + '<span>' + LABEL[p.it.section] + '</span>' + (due ? '<span>· ' + esc(due) + '</span>' : '') + '</div>' +
        '<button class="pick-do" data-act="do">' + (p.it.section === 'today' ? 'Do this one' : 'Do this one (moves it to Today)') + '</button>' +
        '<div class="pick-two"><button data-act="skip">Not this one</button><button data-act="surprise">Surprise me</button></div>';
    } else if (p.count) {
      html = '<p class="pick-name">That was every task that fits ' + L.toLowerCase() + '.</p>' +
        '<p class="meta">Each one you turned down counts once. Start again to see them in the same order.</p>' +
        '<button class="pick-again" data-act="again">Start again</button>';
    } else {
      html = '<p class="pick-name">No task fits ' + L.toLowerCase() + ' yet.</p>' +
        '<p class="meta">Only tasks with a confirmed level can be picked. Give tasks a level in their edit sheet, or sort them all at once.</p>' +
        '<button class="pick-again" data-act="sort">Sort energy</button>';
    }
    $('pickBody').innerHTML = html;
  }
  function openPick() {
    if (!levelOn()) return;
    pickSkip = [];
    renderPick(pickNext('next'));
    openSheet($('pick'), 0, $('giveOne'));
    $('pickClose').focus({ preventScroll: true });
  }
  function closePick(after) { pickShown = null; closeSheet($('pick'), after); }
  function tellSkip(id) {
    if (!navigator.onLine) return;
    fetch(API + '/api/energy/' + code + '/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'next', skip: [id], current: id, skipped: id, source: 'todo' }) }).catch(() => {});
  }
  $('giveOne').addEventListener('click', openPick);
  $('pickClose').addEventListener('click', () => closePick());
  $('pick').querySelector('.scrim').addEventListener('click', () => closePick());
  $('pickBody').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !pickShown) return;
    const act = b.dataset.act;
    const it = pickShown.it;
    if (act === 'skip' && it) { tellSkip(it.id); pickSkip.push(it.id); renderPick(pickNext('next')); }
    else if (act === 'surprise' && it) renderPick(pickNext('surprise'));
    else if (act === 'again') { pickSkip = []; renderPick(pickNext('next')); }
    else if (act === 'sort') closePick(openSort);
    else if (act === 'do' && it) {
      const id = it.id;
      closePick(() => {
        if (items[id] && items[id].section !== 'today') moveTo(id, 'today');
        const row = byId(id);
        if (row) { row.scrollIntoView({ block: 'nearest', behavior: M.reduced ? 'auto' : 'smooth' }); if (keyed) focusRow(row); }
      });
    }
  });

  // The edit sheet: tap a level to confirm it (a guess goes), tap the one that is on to clear it.
  function paintEditEnergy(it) {
    const guess = !LEVELS.includes(it.energy) && LEVELS.includes(it.energyGuess) ? it.energyGuess : null;
    for (const b of $('editEnergy').querySelectorAll('button')) {
      const on = b.dataset.level === it.energy;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('guess', b.dataset.level === guess);
      b.tabIndex = on || (!it.energy && b.dataset.level === (guess || 'wired')) ? 0 : -1;
    }
    $('editEnergyNote').hidden = !guess;
  }
  for (const b of $('editEnergy').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      const it = items[editId];
      if (!it) return;
      saveEditText();
      const cur = items[editId];
      const level = cur.energy === b.dataset.level ? null : b.dataset.level;
      upsert(Object.assign({}, cur, { energy: level, energyGuess: level ? null : cur.energyGuess }));
      paintEditEnergy(items[editId]);
    });
  }
  $('editEnergy').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const bs = Array.from($('editEnergy').querySelectorAll('button'));
    const i = Math.max(0, bs.indexOf(document.activeElement));
    bs[(i + step + bs.length) % bs.length].focus();
  });

  // Sort: every open task with three buttons. On open, tasks with neither a level nor a guess are
  // sent once for a guess (POST /api/energy/:code/suggest, Claude Haiku, at most once a day).
  let sortOpen = false;
  let sortAsked = false;
  // The ones still without a level first, then the rest; each part in list order. The order is
  // taken when the sheet opens, so a row never jumps away under a tap.
  let sortOrder = [];
  function sortRows() {
    const all = SECTIONS.flatMap((s) => openIn(s));
    const rank = new Map(sortOrder.map((id, i) => [id, i]));
    return all.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
  }
  function renderSort() {
    const rows = sortRows();
    const set = rows.filter((i) => LEVELS.includes(i.energy)).length;
    $('sortCount').textContent = set + ' of ' + rows.length + ' open tasks have a level';
    $('sortList').innerHTML = rows.map((it) => {
      const guess = !LEVELS.includes(it.energy) && LEVELS.includes(it.energyGuess) ? it.energyGuess : null;
      const name = nameParts(it).name;
      return '<li class="sort-row' + (it.energy ? ' set' : '') + '" data-id="' + it.id + '">' +
        '<div class="sort-name"><span>' + esc(name) + '</span><span class="sort-where">' + LABEL[it.section] + '</span></div>' +
        '<div class="sort-btns" role="radiogroup" aria-label="Energy for ' + esc(name) + '">' + LEVELS.map((l) =>
          '<button role="radio" data-level="' + l + '" aria-checked="' + (it.energy === l) + '"' + (l === guess ? ' class="guess"' : '') + '>' + battSvg(l) + LNAME[l] + '</button>').join('') +
        '</div></li>';
    }).join('');
  }
  async function askGuesses() {
    if (sortAsked || !navigator.onLine) return;
    if (!Object.values(items).some((i) => !i.done && !i.energy && !i.energyGuess)) return;
    sortAsked = true;
    try {
      const r = await fetch(API + '/api/energy/' + code + '/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.ok) await poll(); // the guesses are on the tasks now
    } catch (e) { /* they stay blank; Paul can still pick */ }
  }
  function openSort() {
    const all = SECTIONS.flatMap((s) => openIn(s));
    sortOrder = all.filter((i) => !LEVELS.includes(i.energy)).concat(all.filter((i) => LEVELS.includes(i.energy))).map((i) => i.id);
    sortOpen = true;
    renderSort();
    openSheet($('sort'), 0, $('energySort'));
    $('sortClose').focus({ preventScroll: true });
    askGuesses();
  }
  function closeSort() { if (!sortOpen) return; sortOpen = false; closeSheet($('sort')); }
  $('energySort').addEventListener('click', openSort);
  $('sortClose').addEventListener('click', closeSort);
  $('sort').querySelector('.scrim').addEventListener('click', closeSort);
  $('sortList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-level]');
    const li = b && b.closest('[data-id]');
    const it = li && items[li.dataset.id];
    if (!it) return;
    const level = it.energy === b.dataset.level ? null : b.dataset.level;
    upsert(Object.assign({}, it, { energy: level, energyGuess: level ? null : it.energyGuess }));
  });

  /* ---------- Waiting ----------
   * Waiting on (Paul, 2026-10-21): something sent, waiting to hear back. The hub holds the list
   * (worker/src/waiting.js) and puts a "Chase ..." task in Today on its day. Here: "Sent, now waiting"
   * in the edit sheet (ticks the task off), a line on Soon that opens the list (They answered,
   * Snooze), and "did they answer?" when a chase task is ticked. Every write needs a connection. */
  let pollCount = 0;
  let waiting = Object.assign({ items: [], open: 0, due: 0, names: [] }, store.get('todo.waiting') || {});
  const CHANNEL = { email: 'Email', phone: 'Phone', letter: 'Letter', 'in-person': 'In person' };
  async function loadWaiting() {
    if (!navigator.onLine) return;
    try {
      const r = await fetch(API + '/api/waiting/' + code, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (!Array.isArray(d.items)) return;
      waiting = { items: d.items, open: d.open, due: d.due, names: d.names || [] };
      store.set('todo.waiting', waiting);
      renderChrome();
      if (!$('waitList').hidden) renderWaitRows();
    } catch (e) { /* the last copy stays */ }
  }
  async function waitPost(path, body) {
    const r = await fetch(API + '/api/waiting/' + code + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ source: 'todo' }, body)) });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error((d && d.error) || 'status ' + r.status);
    return d;
  }
  function renderWaitLine() {
    const on = view === 'list' && ui.section === 'soon' && loaded && waiting.open > 0;
    $('waitLine').hidden = !on;
    if (on) $('waitLine').textContent = 'Waiting on ' + waiting.open + (waiting.due ? ' · ' + waiting.due + (waiting.due === 1 ? ' chase due' : ' chases due') : '');
  }

  // The form: from a task (edit sheet) or on its own (the list's Add).
  let waitTask = null; // the task it came from, or null
  let waitBusy = false;
  function pickIn(group, v) {
    for (const b of $(group).querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === v));
  }
  const picked = (group) => { const b = $(group).querySelector('[aria-checked="true"]'); return b ? b.dataset.v : null; };
  function openWait(taskId) {
    const it = taskId ? items[taskId] : null;
    waitTask = it ? it.id : null;
    $('waitFrom').hidden = !it;
    if (it) $('waitFrom').textContent = 'From the task: ' + nameParts(it).name;
    $('waitWho').value = '';
    $('waitWhat').value = it ? nameParts(it).name : '';
    pickIn('waitHow', 'email');
    pickIn('waitAfter', '7');
    pickIn('waitFor', 'me');
    $('waitForName').hidden = true;
    $('waitForName').value = '';
    $('waitErr').hidden = true;
    $('waitNames').innerHTML = waiting.names.map((n) => '<button type="button" data-name="' + esc(n) + '">' + esc(n) + '</button>').join('');
    $('waitSave').textContent = it ? 'Done, now waiting' : 'Add';
    openSheet($('wait'), undefined, null);
    if (desk.matches) $('waitWho').focus();
    else $('waitCancel').focus({ preventScroll: true });
  }
  function closeWait(after) { waitTask = null; closeSheet($('wait'), after); }
  for (const g of ['waitHow', 'waitAfter', 'waitFor']) {
    $(g).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      pickIn(g, b.dataset.v);
      if (g === 'waitFor') { $('waitForName').hidden = b.dataset.v !== 'else'; if (b.dataset.v === 'else') $('waitForName').focus(); }
    });
  }
  $('waitNames').addEventListener('click', (e) => { const b = e.target.closest('button[data-name]'); if (b) { $('waitWho').value = b.dataset.name; $('waitErr').hidden = true; $('waitWhat').focus(); } });
  $('wait').addEventListener('input', () => { $('waitErr').hidden = true; }); // a fix clears the note
  $('waitCancel').addEventListener('click', () => closeWait());
  $('wait').querySelector('.scrim').addEventListener('click', () => closeWait());
  $('waitSave').addEventListener('click', async () => {
    if (waitBusy) return;
    const who = cleanText($('waitWho').value).slice(0, 60);
    const what = cleanText($('waitWhat').value).slice(0, 160);
    const err = (t) => { $('waitErr').textContent = t; $('waitErr').hidden = false; };
    if (!who) return err('Who are you waiting on?');
    if (!what) return err('What is it about?');
    const forElse = picked('waitFor') === 'else';
    const forWhom = forElse ? cleanText($('waitForName').value).slice(0, 40) : '';
    if (forElse && !forWhom) return err('Who is it for?');
    if (!navigator.onLine) return err('Needs a connection. Nothing was lost; try again when you are back online.');
    waitBusy = true;
    $('waitSave').disabled = true;
    const task = waitTask;
    try {
      await waitPost('', { who, what, channel: picked('waitHow'), chaseDays: Number(picked('waitAfter')), ...(forWhom ? { forWhom } : {}), ...(task ? { sourceItem: task } : {}) });
      closeWait(() => { if (task && items[task] && !items[task].done) markDone(task); else toast('Waiting on ' + who + '.'); });
      loadWaiting();
    } catch (e) {
      err(String(e.message) === 'that task already has one' ? 'This task is already waiting.' : 'Could not save: ' + e.message);
    } finally {
      waitBusy = false;
      $('waitSave').disabled = false;
    }
  });
  $('editWait').addEventListener('click', () => {
    const id = editId;
    if (id) closeEdit(() => openWait(id));
  });

  // The list: oldest first, They answered and Snooze.
  let snoozeOpen = null;
  function renderWaitRows() {
    if (!waiting.items.length) { $('waitRows').innerHTML = '<li class="wait-empty">Nothing you are waiting on.</li>'; return; }
    $('waitRows').innerHTML = waiting.items.map((w) => {
      const meta = [w.forWhom ? 'For ' + esc(w.forWhom) : '', CHANNEL[w.channel], 'since ' + shortDay(w.since), w.chases ? (w.chases === 1 ? 'chased once' : 'chased ' + w.chases + ' times') : '', w.chaseDue ? '' : 'chase on ' + shortDay(w.nextChase)].filter(Boolean).join(' · ');
      const btns = snoozeOpen === w.id
        ? '<button data-act="snooze" data-days="3">3 days</button><button data-act="snooze" data-days="7">1 week</button><button data-act="snooze" data-days="14">2 weeks</button>'
        : '<button data-act="resolve">They answered</button><button data-act="snoozing">Snooze</button>';
      return '<li class="wait-row" data-id="' + w.id + '"><div class="wr-top"><span><b>' + esc(w.who) + '</b> about ' + esc(w.what) + '</span>' +
        (w.chaseDue ? '<span class="wr-due">Chase due</span>' : '') + '</div><span class="meta">' + meta + '</span><div class="wr-btns">' + btns + '</div></li>';
    }).join('');
  }
  function openWaitList() {
    snoozeOpen = null;
    renderWaitRows();
    openSheet($('waitList'), 0, $('waitLine'));
    $('waitListClose').focus({ preventScroll: true });
    loadWaiting();
  }
  function closeWaitList(after) { closeSheet($('waitList'), after); }
  $('waitLine').addEventListener('click', openWaitList);
  $('waitListClose').addEventListener('click', () => closeWaitList());
  $('waitList').querySelector('.scrim').addEventListener('click', () => closeWaitList());
  $('waitAdd').addEventListener('click', () => closeWaitList(() => openWait(null)));
  $('waitRows').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    const li = b && b.closest('[data-id]');
    if (!li || b.disabled) return;
    const id = li.dataset.id;
    if (b.dataset.act === 'snoozing') { snoozeOpen = id; renderWaitRows(); const f = $('waitRows').querySelector('[data-id="' + id + '"] button'); if (f) f.focus(); return; }
    if (!navigator.onLine) { toast('Needs a connection.'); return; }
    b.disabled = true;
    try {
      if (b.dataset.act === 'resolve') { await waitPost('/' + id, { action: 'resolve' }); say('Done waiting'); poll(); }
      else { await waitPost('/' + id, { action: 'snooze', days: Number(b.dataset.days) }); say('Snoozed'); poll(); }
      snoozeOpen = null;
      await loadWaiting();
    } catch (err) {
      b.disabled = false;
      toast('Could not do that. Try again.');
    }
  });

  // A chase task ticked: did they answer? Yes resolves the item, Still waiting chases again a gap later.
  let ansItem = null;
  async function askAnswered(task) {
    if (!waiting.items.some((x) => x.id === task.waiting)) await loadWaiting(); // made since the last read
    const w = waiting.items.find((x) => x.id === task.waiting);
    const name = w ? w.who : '';
    ansItem = { id: task.waiting, gap: w ? w.chaseDays : null };
    $('ansMeta').textContent = w ? 'Chased. Waiting since ' + shortDay(w.since) + ', ' + (CHANNEL[w.channel] || '').toLowerCase() : 'Chased';
    $('ansQ').textContent = w ? 'Did ' + name + ' answer about ' + w.what + '?' : 'Did they answer?';
    $('ansStill').textContent = 'Still waiting, chase again' + (ansItem.gap ? ' in ' + ansItem.gap + ' days' : '');
    const open = () => { openSheet($('answered'), 0, null); $('ansYes').focus({ preventScroll: true }); };
    if (modals.size) setTimeout(open, 400); else open();
  }
  function closeAnswered() { ansItem = null; closeSheet($('answered')); }
  async function answer(action) {
    const a = ansItem;
    if (!a) return;
    closeAnswered();
    try {
      await waitPost('/' + a.id, { action });
      toast(action === 'resolve' ? 'Done waiting.' : 'Chase again later.');
      loadWaiting();
    } catch (e) {
      toast(navigator.onLine ? 'Could not save that. Use the Waiting on list on Soon.' : 'Needs a connection. Use the Waiting on list on Soon later.');
    }
  }
  $('ansYes').addEventListener('click', () => answer('resolve'));
  $('ansStill').addEventListener('click', () => answer('still'));
  $('ansLater').addEventListener('click', closeAnswered);
  $('answered').querySelector('.scrim').addEventListener('click', closeAnswered);

  /* ---------- Keyboard (desktop) ---------- */
  function rows() { return Array.from(list.querySelectorAll(view === 'done' ? '.drow' : '.row:not(.skeleton)')); }
  const isField = (el) => !!el && (/^(input|textarea|select)$/i.test(el.tagName || '') || el.isContentEditable);
  // A sheet or the confirm on its way out takes no more keys, so N works right after Escape.
  const shown = (wrap) => !wrap.hidden && !closingSheets.has(wrap.querySelector('.sheet'));
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+Z is the toast's Undo, only while the toast shows and never in a field.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key || '').toLowerCase() === 'z') {
      if (!isField(e.target) && toastOn && undoFn && !modals.size) { e.preventDefault(); undo(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (!confirmWrap.hidden) { closeConfirm(); return; }
      if (menuOn) { closeMenu(); return; }
      if (!$('edit').hidden) { closeEdit(); return; }
      if (!$('card').hidden) { closeCard(); return; }
      if (!$('apply').hidden) { closeApply(); return; }
      if (!$('ask').hidden) { closeAsk(); return; }
      if (!$('pick').hidden) { closePick(); return; }
      if (!$('sort').hidden) { closeSort(); return; }
      if (!$('answered').hidden) { closeAnswered(); return; }
      if (!$('wait').hidden) { closeWait(); return; }
      if (!$('waitList').hidden) { closeWaitList(); return; }
      if (!$('capture').hidden) { closeCapture(); return; }
      closeReveal();
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || shown($('edit')) || shown($('card')) || shown($('apply')) || shown($('ask')) || shown($('pick')) || shown($('sort')) || shown($('wait')) || shown($('waitList')) || shown($('answered')) || shown($('capture')) || (!confirmWrap.hidden && !confirmClosing)) return;
    if (menuOn) {
      const bs = Array.from(menu.querySelectorAll('button.sec'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const i = bs.indexOf(document.activeElement);
        bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus();
        e.preventDefault();
      } else if (e.key === 'Home' || e.key === 'End') {
        bs[e.key === 'Home' ? 0 : bs.length - 1].focus();
        e.preventDefault();
      } else if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault();
        const b = bs[Number(e.key) - 1];
        if (b && !b.hasAttribute('aria-current')) b.click();
      } else if (e.key === 'Tab') {
        closeMenu(); // focus goes back to the opener, and Tab moves on from there
      }
      return;
    }
    const k = e.key;
    if (k === 'n' || k === 'N') { e.preventDefault(); openAdd(); return; }
    if (k === '1' || k === '2' || k === '3') { setSection(SECTIONS[Number(k) - 1]); say(LABEL[SECTIONS[Number(k) - 1]]); return; }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      const rs = rows();
      if (!rs.length) return;
      e.preventDefault();
      const cur = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.row, .drow') : null;
      let i = rs.indexOf(cur);
      i = i < 0 ? (k === 'ArrowDown' ? 0 : rs.length - 1) : Math.max(0, Math.min(rs.length - 1, i + (k === 'ArrowDown' ? 1 : -1)));
      focusRow(rs[i]);
      rs[i].scrollIntoView({ block: 'nearest' });
      return;
    }
    const focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.row, .drow') : null;
    if (!focused) return;
    if (view === 'done' && (k === 'Enter' || k === ' ')) { e.preventDefault(); reopenRow(focused); return; }
    if ((k === 'm' || k === 'M') && view === 'list') {
      e.preventDefault();
      openMenu(focused, desk.matches ? focused.querySelector('.move-btn') : null);
      if (menuOn) menuOpener = e.target; // Escape goes back to where M was pressed
      return;
    }
    if (k === 'Enter' && e.target === focused) { e.preventDefault(); openTask(focused.dataset.id); return; }
    if (k === ' ' && e.target === focused) {
      e.preventDefault();
      completeRow(focused); // the render that removes it focuses the next row that stays
    }
  });

  /* ---------- Intake: a letter, a PDF or a photo becomes tasks ---------- */
  // The paper-clip (capture sheet on the phone, add row on the desktop) and a file dropped on the
  // list go to POST /api/intake. The Worker asks Claude for one record and writes the tasks into
  // the list itself; the next poll draws them. The pill under the title shows the wait, a toast
  // says what came of it. The last records stay on this device, so the edit sheet can show what the
  // letter said; on load the Worker's recent records are merged in once, for tasks read elsewhere.
  const INTAKE_KEY = 'todo.intake.' + code;
  const MAX_FILES = 10;
  const MAX_PDF = 15 * 1024 * 1024;
  const MAX_SIDE = 1600; // photos are shrunk on the phone before they go
  const KINDS = { letter: 'a letter', bill: 'a bill', contract: 'a contract', 'credit-report': 'a credit report', job: 'a job posting', note: 'your note', other: 'a document' };
  let recs = Array.isArray(store.get(INTAKE_KEY)) ? store.get(INTAKE_KEY) : [];
  const fileIn = $('fileIn');
  const readPill = $('reading');
  let readingN = 0;

  function pickFiles() { fileIn.value = ''; fileIn.click(); }
  fileIn.addEventListener('change', () => { if (fileIn.files.length) readFiles(Array.from(fileIn.files)); });
  $('capClip').addEventListener('click', pickFiles);
  $('inlineClip').addEventListener('click', pickFiles);

  const asBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  // A photo becomes a JPEG no wider than MAX_SIDE. Browsers draw it the right way up from its EXIF.
  function shrink(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * s));
        c.height = Math.max(1, Math.round(img.naturalHeight * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1] || null);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  async function readFiles(files) {
    if (view !== 'list') setSection(ui.section);
    if (!$('capture').hidden) closeCapture(); // what was typed is added; the pill tells the rest
    hideInline();
    if (!navigator.onLine) return toast('Needs a connection to read it.');
    if (files.length > MAX_FILES) return toast('At most ' + MAX_FILES + ' files at a time.');
    const out = [];
    for (const f of files) {
      const type = f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : '');
      if (type === 'application/pdf') {
        if (f.size > MAX_PDF) return toast(f.name + ' is too big. 15 MB at most.');
        out.push({ name: f.name, media_type: type, data: await asBase64(f) });
      } else if (/^image\//.test(type)) {
        const data = await shrink(f);
        if (!data) return toast('Could not open ' + f.name + '.');
        out.push({ name: f.name, media_type: 'image/jpeg', data });
      } else {
        return toast('Only photos and PDFs can be read.');
      }
    }
    if (out.length) sendIntake(out, files.length === 1 ? files[0].name : files.length + ' files');
  }

  const READ_ERRORS = {
    'api key refused': 'Reading is not set up on the server.',
    refused: 'Claude declined to read this one.',
    'too large': 'Too big. Try fewer pages.',
    'cut off': 'Too long to read in one go. Try fewer pages.',
  };
  async function sendIntake(files, label) {
    readingN++;
    readPill.querySelector('span').textContent = 'Reading ' + label;
    slotIn(readPill);
    say('Reading ' + label);
    try {
      const r = await fetch(API + '/api/intake/' + code, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      const d = await r.json().catch(() => null);
      if (refused(r.status, d)) return showNoCode();
      if (r.status === 429) return toast('Busy. Try again in a minute.');
      if (!r.ok || !d) return toast((d && READ_ERRORS[d.error]) || 'Could not read it. Try again.');
      if (d.record) remember(d);
      if (d.duplicate) return toast('Already read' + (d.at ? ' ' + dayLabel(Date.parse(d.at)).toLowerCase() : '') + '.');
      if (d.refilled !== undefined) { await loadCards(); return toast(d.refilled ? 'Letter card filled in.' : 'Read again. Nothing new for the card.'); }
      if (d.card) loadCards();
      const rec = d.record || {};
      if (rec.readable === false) return toast('Could not read it. Try a sharper photo.');
      const tasks = Array.isArray(d.tasks) ? d.tasks : [];
      if (!tasks.length) return toast('Read. Nothing to do.');
      await poll(); // the Worker already wrote the tasks; draw them now rather than in ten seconds
      if (!tasks.every((t) => items[t.id])) setTimeout(poll, 1200); // a poll was already running
      const by = {};
      for (const t of tasks) by[t.section] = (by[t.section] || 0) + 1;
      const where = SECTIONS.filter((s) => by[s]).map((s) => LABEL[s] + ' ' + by[s]).join(', ');
      toast((tasks.length === 1 ? '1 task' : tasks.length + ' tasks') + ' from ' + (KINDS[rec.kind] || 'the document') + ': ' + where + '.');
    } catch (e) {
      toast(navigator.onLine ? 'Could not read it. Try again.' : 'Needs a connection to read it.');
    } finally {
      if (--readingN === 0) slotOut(readPill);
    }
  }

  // Keep what the edit sheet needs: the summary, a few quotes, which tasks it made.
  function remember(d) {
    const rec = d.record || {};
    const ids = Array.isArray(d.tasks) ? d.tasks.map((t) => t.id) : [];
    const entry = { id: d.id, at: d.at, kind: rec.kind, who: rec.who, summary: rec.summary || '', note: rec.note || null, quotes: (rec.quotes || []).slice(0, 4), tasks: ids };
    recs = [entry].concat(recs.filter((x) => x.id !== d.id)).slice(0, 40);
    store.set(INTAKE_KEY, recs);
  }
  const recOf = (taskId) => recs.find((x) => x.tasks.includes(taskId)) || null;
  function showFrom(it) {
    const box = $('editFrom');
    const rec = isIntake(it) ? recOf(it.id) : null;
    box.hidden = !rec;
    if (!rec) return;
    $('editFromKind').textContent = KINDS[rec.kind] || 'a document';
    $('editFromSummary').textContent = rec.summary + (rec.note ? ' ' + rec.note : '');
    $('editFromQuotes').innerHTML = rec.quotes.slice(0, 3).map((q) => '<li>' + esc(q) + '</li>').join('');
  }
  // Once per load: records made on another device.
  async function loadRecs() {
    try {
      const r = await fetch(API + '/api/intake/' + code + '?limit=30', { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      if (!d || !Array.isArray(d.items)) return;
      const have = new Set(recs.map((x) => x.id));
      for (const x of d.items) if (!have.has(x.id)) remember(x);
    } catch (e) { /* the edit sheet just shows less */ }
  }

  // Desktop: a file dragged over the list can be dropped on it. Rows dragged between sections
  // carry their own type and are not files.
  const mainEl = document.querySelector('main');
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  mainEl.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); mainEl.classList.add('drop-files'); } });
  mainEl.addEventListener('dragleave', (e) => { if (!mainEl.contains(e.relatedTarget)) mainEl.classList.remove('drop-files'); });
  mainEl.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    mainEl.classList.remove('drop-files');
    readFiles(Array.from(e.dataTransfer.files));
  });

  /* ---------- Life cycle ---------- */
  let pollTimer = 0;
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { newDay(); poll(); }, POLL);
  }
  // Past midnight the day labels and the Today empty state are drawn again. No task moves.
  let lastDay = new Date().toDateString();
  function newDay() {
    const d = new Date().toDateString();
    if (d === lastDay) return;
    lastDay = d;
    render();
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
      newDay();
      poll();
      loadWaiting();
      startPolling();
    }
  });
  window.addEventListener('online', () => { flush(); poll(); });
  window.addEventListener('offline', () => setNet('offline'));
  $('retry').addEventListener('click', () => { rejectNote = false; flush(); poll(); });
  desk.addEventListener('change', () => { hideInline(true); render(); });

  computeView();
  render();
  // The seg thumb glides only after the first paint, so it never slides in on open.
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('ready')));
  if (!navigator.onLine) setNet('offline');
  poll();
  if (st.queue.length) scheduleFlush(300);
  startPolling();
  setTimeout(loadRecs, 1500); // after the list, never before it
  setTimeout(loadCards, 1600);
  setTimeout(loadWaiting, 1700);

  if ('serviceWorker' in navigator && (!isLocal || params.has('sw'))) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
