/* Email in (Paul, 2026-10-21): mail he forwards to hub@<his domain> becomes a task, a read-later
 * line, a Waiting on item, or waits in Day's "Mail to sort".
 *
 *   email()  Cloudflare Email Routing hands each message to this Worker (worker.js `email`).
 *            Only addresses in the EMAIL_ALLOW secret (comma separated) get in; anything else is
 *            dropped without a word back: no reply, no bounce, no forward. The log says only "mail
 *            dropped". Paul chose the address alone, no DKIM check (2026-10-21).
 *
 *   Subject:  "todo: ..."  a task in Soon (Today when Tidy finds a date within 2 days)
 *             "later: ..." a line in Morning's Read for you, with Done and Drop
 *             "wait: ..."  a Waiting on item: who = the person the forwarded mail went to (or came
 *                          from), what = the subject, email, chase after 7 days
 *             no prefix    Day's "Mail to sort": Task, Read later, Waiting or Drop
 *            "FW:", "Fwd:", "Doorst:" are ignored before or after the prefix. Tags anywhere in the
 *            subject: #wired #normal #drained set the task's energy, #others puts it in the Others
 *            lane ("Others: ..."). Tags and prefix are taken out of the stored subject.
 *
 *   Kept per mail (D1 `mail`, migrations/0011_mail.sql): subject, the original sender, the original
 *   date, the first EXCERPT characters of the forwarded text, masked (src/mask.js). Never the body,
 *   never attachments.
 *
 *   Events: email.received (source "mail", payload { id, kind }) goes through acceptEvent like every
 *   other event; the rule mail-received queues it for TARGETS.mail (src/hub.js), which makes the task
 *   (task.created), the read-later line (readlater.created) or the Waiting on item (waiting.created,
 *   src/waiting.js). Day's sorting is the event email.sorted (source "day", rule mail-sorted-day).
 *
 *   GET  /api/mail/:code              -> { later: [...], triage: n }
 *   POST /api/mail/:code/:id          <- { action: "done" | "drop" }   a read-later line, from Morning
 *   GET  /api/hub/mail/day            Bearer HUB_SECRET_DAY -> { items }  Mail to sort, newest first
 *   POST /api/hub/mail/day/:id        Bearer HUB_SECRET_DAY <- { as: "task" | "later" | "wait" | "drop" } */

import PostalMime from 'postal-mime';
import { CODE, ENERGY, safeEqual, bearer, cleanOp, cleanText, MAX_TEXT } from './todo.js';
import { acceptEvent } from './hub.js';
import { maskSecrets, noDashes } from './mask.js';
import { local, addDays } from './morning.js';
import { tidyLine, toText, DUE_END } from './tidy.js';
import { createItem, CHASE_DAYS } from './waiting.js';
import { bumpUsage, dayOf } from './intake.js';

export const EXCERPT = 200; // characters kept from the forwarded text (Paul, 2026-10-21)
export const MAX_RAW = 1024 * 1024; // a bigger mail is dropped
const KINDS = { todo: 'todo', later: 'later', wait: 'wait' };
const SORT_AS = ['task', 'later', 'wait', 'drop'];
const ID16 = /^[a-z0-9]{16}$/;
const clean = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const rand = (n = 16) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
async function hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
}
export const mailTaskId = async (id) => (await hex('mailtask:' + id)).slice(0, 24);

/* ---------- Pure ---------- */

export function allowed(from, allowList) {
  const list = String(allowList || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(from || '').trim().toLowerCase());
}

const FWD = /^(fw|fwd|doorst|tr|wg|rv)\s*:\s*/i;
/* The subject -> { kind, subject, energy, others }. */
export function readSubject(raw) {
  let s = clean(raw, 400);
  let kind = null;
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(FWD, '');
    const m = !kind && s.match(/^(todo|later|wait)\s*:\s*/i);
    if (m) { kind = KINDS[m[1].toLowerCase()]; s = s.slice(m[0].length); }
    if (s === before) break;
  }
  let energy = null;
  let others = false;
  s = s.replace(/(^|\s)#(wired|normal|drained|others)\b/gi, (m, sp, tag) => {
    const t = tag.toLowerCase();
    if (t === 'others') others = true; else energy = t;
    return sp;
  });
  return { kind: kind || 'triage', subject: clean(s, 200) || '(no subject)', energy, others };
}

// The header block a forward puts above the original: English, Dutch, Spanish and German labels,
// as Outlook (Hotmail) and Gmail write them.
const H_FROM = /^\s*\*?(from|van|de|von)\*?\s*:\s*(.+)$/im;
const H_TO = /^\s*\*?(to|aan|para|an)\*?\s*:\s*(.+)$/im;
const H_DATE = /^\s*\*?(sent|date|verzonden|datum|enviado|fecha|gesendet)\*?\s*:\s*(.+)$/im;
const MARKER = /(-{5,}\s*(forwarded message|doorgestuurd bericht|mensaje reenviado)\s*-{5,}|_{10,}|-----\s*original message\s*-----)/i;

/* The forwarded mail's sender, recipient, date and opening text, from the plain text. */
export function readForward(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const mark = t.search(MARKER);
  const block = mark >= 0 ? t.slice(mark) : t;
  const from = block.match(H_FROM);
  const to = block.match(H_TO);
  const date = block.match(H_DATE);
  // The original text starts after the header block: the first empty line after the From line
  // (Gmail puts To under Subject, Outlook puts it above, so no single label ends the block).
  let body = mark >= 0 ? block.replace(MARKER, '') : block;
  if (from) {
    const gap = block.slice(from.index).search(/\n[ \t]*\n/);
    if (gap >= 0) body = block.slice(from.index + gap);
  }
  const name = (v) => v ? clean(v[2].replace(/\[mailto:[^\]]*\]/i, ''), 120) : null;
  return { from: name(from), to: name(to), date: date ? clean(date[2], 80) : null, body: body.trim() };
}

/* The first EXCERPT characters, masked, one line. */
export function excerptOf(text) {
  return clean(maskSecrets(noDashes(String(text || '').replace(/^>+\s?/gm, ''))), EXCERPT);
}

/* "Ana Lopez <ana@example.org>" -> "Ana Lopez"; a bare address stays. */
export function personOf(v) {
  if (!v) return null;
  const m = String(v).match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return clean(m ? m[1] : v, 60) || null;
}

const htmlToText = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/* A parsed mail -> the row to keep. */
export function toRow(parsed, receivedAt) {
  const subj = readSubject(parsed.subject);
  const text = parsed.text || htmlToText(parsed.html);
  const fw = readForward(text);
  const directFrom = parsed.from ? (parsed.from.name ? parsed.from.name + ' <' + parsed.from.address + '>' : parsed.from.address) : null;
  return {
    kind: subj.kind, subject: subj.subject, energy: subj.energy, others: subj.others ? 1 : 0,
    sender: fw.from || directFrom, to: fw.to, sent_at: fw.date || receivedAt, excerpt: excerptOf(fw.body),
  };
}

/* ---------- Receiving ---------- */

async function emit(env, type, id, source, now, extra = {}) {
  await acceptEvent(env, {
    id: type + '-' + id + '-' + now, source, type, summary: 'Mail ' + type.split('.')[1],
    payload: { id, ...extra }, caused_by: null, hops: 0, at: new Date(now).toISOString(),
  }, { feed: false });
}

async function readRaw(raw) {
  if (typeof raw === 'string' || raw instanceof ArrayBuffer || raw instanceof Uint8Array) return raw;
  return await new Response(raw).arrayBuffer(); // a ReadableStream from Email Routing
}

/* The Worker's email() handler. Never replies, forwards or rejects. */
export async function receiveMail(message, env, now = Date.now()) {
  if (!allowed(message.from, env.EMAIL_ALLOW) || !env.HUB_DB) { console.log('mail dropped'); return { dropped: true }; }
  if (message.rawSize && message.rawSize > MAX_RAW) { console.log('mail dropped'); return { dropped: true }; }
  const parsed = await PostalMime.parse(await readRaw(message.raw));
  const at = new Date(now).toISOString();
  const row = toRow(parsed, at);
  const id = rand();
  await env.HUB_DB.prepare(
    'INSERT INTO mail (id, kind, subject, sender, sent_at, excerpt, energy, others, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, row.kind, row.subject, row.sender, row.sent_at, row.excerpt, row.energy, row.others, at, at).run();
  if (row.to) await env.HUB_KV.put('mail:to:' + id, row.to, { expirationTtl: 30 * 86400 }); // for "wait:", never shown
  await emit(env, 'email.received', id, 'mail', now, { kind: row.kind });
  return { id, kind: row.kind };
}

/* ---------- The reactions (src/hub.js TARGETS.mail) ---------- */

const listStub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
let tidier = tidyLine;
export function _setMailTidier(fn) { tidier = fn || tidyLine; }

async function makeTask(env, row, now) {
  const id = await mailTaskId(row.id);
  const today = local(now).date;
  let text = row.subject;
  let guess = null;
  if (env.ANTHROPIC_API_KEY) {
    try {
      const got = await tidier(env, row.subject, now);
      if (got.usage) await bumpUsage(env, dayOf(now).slice(0, 7), got.usage, 'tidy').catch(() => {});
      if (got.out) { text = toText(got.out, row.subject, today); guess = ENERGY.includes(got.out.energy) ? got.out.energy : null; }
    } catch (e) { /* the subject as it came */ }
  }
  if (row.others && !/^\p{Lu}[\p{L}'-]{1,23}: /u.test(text)) text = 'Others: ' + text;
  text = cleanText(text.slice(0, MAX_TEXT)) || 'Mail';
  const due = (text.match(DUE_END) || [])[1];
  const section = due && due <= addDays(today, 2) ? 'today' : 'soon';
  const item = { id, text, section, done: false, doneAt: null, updatedAt: now, pos: now };
  if (row.energy) item.energy = row.energy; else if (guess) item.energyGuess = guess;
  const op = cleanOp({ op: 'upsert', item }, now);
  const doc = await (await listStub(env).fetch('https://list/export')).json();
  if (op && !(doc.items && doc.items[id]) && !(doc.tombs && doc.tombs[id] !== undefined)) {
    const r = await listStub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [op] }), headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error('todo apply ' + r.status);
  }
  return id;
}

export async function mailTarget(env, msg, now = Date.now()) {
  const id = msg.payload && msg.payload.id;
  if (typeof id !== 'string' || !ID16.test(id)) return { skip: 'no id' };
  const row = await env.HUB_DB.prepare('SELECT * FROM mail WHERE id = ?').bind(id).first();
  if (!row) return { skip: 'no such mail' };
  if (row.state !== 'open') return { skip: 'already ' + row.state };
  const as = msg.type === 'email.sorted' ? msg.payload.as : row.kind === 'todo' ? 'task' : row.kind;
  const at = new Date(now).toISOString();
  const set = (state, target = null) => env.HUB_DB.prepare('UPDATE mail SET state = ?, target = ?, updated_at = ? WHERE id = ?').bind(state, target, at, id).run();
  if (as === 'triage') return { done: 'waits in Day' };
  if (as === 'task') {
    const task = await makeTask(env, row, now);
    await set('task', task);
    await emit(env, 'task.created', id, 'hub', now, { task });
    return { done: task };
  }
  if (as === 'later') {
    await set('later');
    await emit(env, 'readlater.created', id, 'hub', now);
    return { done: 'later' };
  }
  if (as === 'wait') {
    const to = await env.HUB_KV.get('mail:to:' + id);
    const who = personOf(to) || personOf(row.sender) || 'someone';
    const since = local(now).date;
    const w = await createItem(env, { who, what: row.subject.slice(0, 160), channel: 'email', chase_days: CHASE_DAYS, for_whom: null, source_item: null, since, next_chase: addDays(since, CHASE_DAYS) }, 'mail', now);
    await set('waiting', w ? w.id : null);
    return { done: 'waiting' };
  }
  if (as === 'drop') { await set('dropped'); return { done: 'dropped' }; }
  return { skip: 'unknown ' + as };
}

/* ---------- Reading ---------- */

const laterView = (r) => ({ id: r.id, subject: r.subject, sender: personOf(r.sender), sentAt: r.sent_at, excerpt: r.excerpt, at: r.created_at });
const triageView = (r) => ({ id: r.id, subject: r.subject, sender: personOf(r.sender), sentAt: r.sent_at, excerpt: r.excerpt, at: r.created_at });

export async function mailForMorning(env) {
  if (!env.HUB_DB) return null;
  const [later, triage] = await Promise.all([
    env.HUB_DB.prepare("SELECT * FROM mail WHERE state = 'later' ORDER BY created_at DESC LIMIT 10").all().then((r) => r.results || []),
    env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM mail WHERE state = 'open' AND kind = 'triage'").first(),
  ]);
  return { later: later.map(laterView), triage: triage ? triage.n : 0 };
}

async function readJson(request, max = 2000) {
  const raw = await request.text();
  if (raw.length > max) return { status: 413, error: 'too large' };
  try { return { body: raw ? JSON.parse(raw) : {} }; } catch (e) { return { status: 400, error: 'bad json' }; }
}

/* /api/mail/:code[/:id]: Morning's read-later lines. */
export async function handleMail(request, env, rest, json, now = Date.now()) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  if (rest.length === 1 && request.method === 'GET') return json(await mailForMorning(env), request);
  if (rest.length === 2 && ID16.test(rest[1]) && request.method === 'POST') {
    const got = await readJson(request);
    if (got.error) return json({ error: got.error }, request, got.status);
    const action = got.body && got.body.action;
    if (action !== 'done' && action !== 'drop') return json({ error: 'action: done or drop' }, request, 400);
    const r = await env.HUB_DB.prepare("UPDATE mail SET state = ?, updated_at = ? WHERE id = ? AND state = 'later'")
      .bind(action === 'done' ? 'done' : 'dropped', new Date(now).toISOString(), rest[1]).run();
    if (!r.meta || r.meta.changes === 0) return json({ error: 'not a read-later line' }, request, 404);
    await emit(env, 'readlater.closed', rest[1], 'morning', now, { how: action });
    return json({ ok: true }, request);
  }
  return json({ error: 'not found' }, request, 404);
}

/* /api/hub/mail/day[/:id]: Day's Mail to sort, through the Odysseus backend. */
export async function handleMailDay(request, env, sub, json, now = Date.now()) {
  if (!env.HUB_SECRET_DAY || !safeEqual(bearer(request), env.HUB_SECRET_DAY)) return json({ error: 'unauthorized' }, request, 401);
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  if (sub.length === 0 && request.method === 'GET') {
    const { results } = await env.HUB_DB.prepare("SELECT * FROM mail WHERE state = 'open' AND kind = 'triage' ORDER BY created_at DESC LIMIT 50").all();
    return json({ items: (results || []).map(triageView) }, request);
  }
  if (sub.length === 1 && ID16.test(sub[0]) && request.method === 'POST') {
    const got = await readJson(request);
    if (got.error) return json({ error: got.error }, request, got.status);
    const as = got.body && got.body.as;
    if (!SORT_AS.includes(as)) return json({ error: 'as: task, later, wait or drop' }, request, 400);
    const row = await env.HUB_DB.prepare('SELECT state, kind FROM mail WHERE id = ?').bind(sub[0]).first();
    if (!row || row.kind !== 'triage') return json({ error: 'no such mail' }, request, 404);
    if (row.state !== 'open') return json({ ok: true, already: row.state }, request);
    await acceptEvent(env, {
      id: 'email.sorted-' + sub[0], source: 'day', type: 'email.sorted', summary: 'Mail sorted',
      payload: { id: sub[0], as }, caused_by: null, hops: 0, at: new Date(now).toISOString(),
    }, { feed: false });
    return json({ ok: true }, request);
  }
  return json({ error: 'not found' }, request, 404);
}
