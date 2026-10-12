/* Letter action cards: an official letter read by Intake opens in To-do as a card.
 *
 * The card says what the letter wants, by when, and holds the values Paul needs to act on it
 * (amount, IBAN, payment reference, case or letter number), each with a copy button in the app,
 * the choices the letter offers, and a link to the sender's portal. The card only prepares:
 * nothing here pays, submits or sends anything.
 *
 *   GET  /api/intake/:code/cards          -> { tasks: [taskId, ...] }  which tasks open as a card
 *   GET  /api/intake/:code/card/:taskId   -> { card }
 *   POST /api/intake/:code/card/:taskId   <- { pick: 0 | 1 | ... | null }       the option chosen
 *                                         <- { done: { date: "YYYY-MM-DD", how: "paid" | "form sent" | "called" } }
 *                                            ticks the task in the list and keeps date and how
 *
 * Never invent a value: an IBAN, reference or case number is kept only when its characters
 * appear in one of the record's quoted lines (the lines Claude copied from the letter), and an
 * IBAN only when its check digits add up. Anything else is null, which the card shows as
 * "not on file". The full values exist only here (D1 letters) and in the card's answer; every
 * other text goes through maskSecrets (src/mask.js).
 *
 * Portals come from hub config letter_portals, { "Sender name": "https://..." }. The name is
 * matched inside the letter's sender; the match furthest right wins, so
 * "Belastingdienst/Toeslagen" goes to Toeslagen. */

import { cleanOp } from './todo.js';
import { readConfig } from './dinner.js';

export const HOW = ['paid', 'form sent', 'called'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TASK = /^[a-z0-9]{8,32}$/;
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ISO 13616 check: move the first four to the end, letters to numbers, mod 97 must be 1. */
export function validIban(s) {
  const v = norm(s);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  const digits = (v.slice(4) + v.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let r = 0;
  for (const d of digits) r = (r * 10 + +d) % 97;
  return r === 1;
}

/* A value counts only when the letter's quoted lines contain it. */
export function inQuotes(value, quotes) {
  const v = norm(value);
  if (v.length < 4) return false;
  return (quotes || []).some((q) => norm(q).includes(v));
}

const isDate = (s) => typeof s === 'string' && DATE.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

/* Pure: an intake record in, the card out, or null when it is not an official letter.
 * Old records (read before cards existed) have no `official`: a letter or bill counts, with
 * only what was on file then. */
export function cardFromRecord(rec) {
  if (!rec || rec.readable === false) return null;
  const official = rec.official === undefined ? rec.kind === 'letter' || rec.kind === 'bill' : rec.official === true;
  if (!official) return null;
  const quotes = Array.isArray(rec.quotes) ? rec.quotes : [];
  const keep = (v, max) => { const s = clean(v, max); return s && inQuotes(s, quotes) ? s : null; };
  const iban = keep(rec.iban, 50);
  const firstAction = Array.isArray(rec.actions) && rec.actions[0] ? clean(rec.actions[0].text, 120) : '';
  const amount = rec.amount && Number.isFinite(rec.amount.value) && rec.amount.value > 0
    ? { value: Math.round(rec.amount.value * 100) / 100, currency: clean(rec.amount.currency, 3).toUpperCase() || 'EUR' } : null;
  return {
    sender: clean(rec.sender, 80) || null,
    who: clean(rec.who, 12) || 'me',
    letterDate: isDate(rec.letter_date) ? rec.letter_date : null,
    want: clean(rec.want, 120) || firstAction || clean(rec.summary, 120),
    due: isDate(rec.deadline) ? rec.deadline : null,
    amount,
    iban: iban && validIban(iban) ? iban : null,
    reference: keep(rec.reference, 60),
    referenceLabel: clean(rec.reference_label, 40) || null,
    caseNumber: keep(rec.case_number, 60),
    caseLabel: clean(rec.case_label, 40) || null,
    options: (Array.isArray(rec.options) ? rec.options : []).slice(0, 4)
      .map((o) => ({ title: clean(o && o.title, 60), detail: clean(o && o.detail, 160) })).filter((o) => o.title),
    fresh: rec.official !== undefined, // read with the card fields; false for an old record
  };
}

/* Pure: the portal for a sender, from the config map. */
export function portalFor(sender, map) {
  if (!sender || !map || typeof map !== 'object') return null;
  const s = sender.toLowerCase();
  let best = null;
  for (const [name, url] of Object.entries(map)) {
    const at = s.lastIndexOf(name.toLowerCase());
    if (at < 0) continue;
    if (!best || at > best.at || (at === best.at && name.length > best.name.length)) best = { at, name, url };
  }
  if (!best) return null;
  let host = '';
  try { host = new URL(best.url).hostname.replace(/^www\./, ''); } catch (e) { return null; }
  return { name: best.name, url: best.url, host };
}

/* Write (or fill in) a letter's card and point its tasks at it. */
export async function saveLetter(env, letterId, card, taskIds, now = Date.now()) {
  if (!env.HUB_DB || !card || !taskIds.length) return false;
  const at = new Date(now).toISOString();
  await env.HUB_DB.prepare('INSERT INTO letters (id, card, pick, created_at, updated_at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET card = excluded.card, updated_at = excluded.updated_at')
    .bind(letterId, JSON.stringify(card), at, at).run();
  for (const t of taskIds) {
    await env.HUB_DB.prepare('INSERT OR IGNORE INTO letter_tasks (task_id, letter_id) VALUES (?, ?)').bind(t, letterId).run();
  }
  return true;
}

async function portals(env) {
  const { letter_portals: raw } = await readConfig(env, ['letter_portals']);
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

async function cardView(env, taskId) {
  const row = await env.HUB_DB.prepare(
    'SELECT l.id, l.card, l.pick, t.done_date, t.done_how FROM letter_tasks t JOIN letters l ON l.id = t.letter_id WHERE t.task_id = ?'
  ).bind(taskId).first();
  if (!row) return null;
  const card = JSON.parse(row.card);
  const pick = Number.isInteger(row.pick) && row.pick >= 0 && row.pick < card.options.length ? row.pick : null;
  return {
    taskId, letterId: row.id, ...card, pick,
    portal: portalFor(card.sender, await portals(env)),
    done: row.done_date ? { date: row.done_date, how: row.done_how } : null,
  };
}

const today = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

/* Tick the task in the list, as the app would. A task already done is left alone. */
async function tick(env, taskId, now) {
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
  const doc = await (await stub.fetch('https://list/export')).json();
  const it = doc.items && doc.items[taskId];
  if (!it || it.done) return false;
  const at = Math.max(now, it.updatedAt + 1);
  const op = cleanOp({ op: 'upsert', item: { ...it, done: true, doneAt: at, updatedAt: at } }, now);
  if (!op) return false;
  const r = await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [op] }), headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error('todo apply ' + r.status);
  return true;
}

/* rest is what follows /api/intake/:code/ ("cards" or "card", taskId). The code is checked by the caller. */
export async function handleLetters(request, env, rest, json, now = Date.now()) {
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  if (rest.length === 1 && rest[0] === 'cards') {
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    const { results } = await env.HUB_DB.prepare('SELECT task_id FROM letter_tasks').all();
    return json({ tasks: (results || []).map((r) => r.task_id) }, request);
  }
  if (rest.length !== 2 || rest[0] !== 'card' || !TASK.test(rest[1])) return json({ error: 'not found' }, request, 404);
  const taskId = rest[1];
  if (request.method === 'GET') {
    const card = await cardView(env, taskId);
    return card ? json({ card }, request) : json({ error: 'no card' }, request, 404);
  }
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const text = await request.text();
  if (text.length > 1000) return json({ error: 'too large' }, request, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, request, 400); }
  const card = await cardView(env, taskId);
  if (!card) return json({ error: 'no card' }, request, 404);

  if (body && Object.hasOwn(body, 'pick')) {
    const p = body.pick;
    if (p !== null && !(Number.isInteger(p) && p >= 0 && p < card.options.length)) return json({ error: 'pick: one of the options, or null' }, request, 400);
    await env.HUB_DB.prepare('UPDATE letters SET pick = ?, updated_at = ? WHERE id = ?').bind(p, new Date(now).toISOString(), card.letterId).run();
  } else if (body && body.done && typeof body.done === 'object') {
    const { date, how } = body.done;
    if (!isDate(date) || date > today(now)) return json({ error: 'done.date: YYYY-MM-DD, today or earlier' }, request, 400);
    if (!HOW.includes(how)) return json({ error: 'done.how: paid, form sent or called' }, request, 400);
    await tick(env, taskId, now);
    await env.HUB_DB.prepare('UPDATE letter_tasks SET done_date = ?, done_how = ?, done_at = ? WHERE task_id = ?')
      .bind(date, how, new Date(now).toISOString(), taskId).run();
  } else {
    return json({ error: 'send { pick } or { done: { date, how } }' }, request, 400);
  }
  return json({ ok: true, card: await cardView(env, taskId) }, request);
}
