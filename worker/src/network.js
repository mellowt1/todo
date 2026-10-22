/* The Network map (Paul, 2026-10-22; wave 2 Phase 1): the people he knows, grouped by sector, who
 * introduced whom and who works together, and when he last spoke to each. Private behind the to-do's
 * code; Morning draws it (morning/app/network/). Never public, never on his website.
 *
 *   GET  /api/network/:code                    -> { today, fadeMonths, sectors, people, ties }
 *   POST /api/network/:code/person             <- { name, org?, role?, sector?, metWhere?, metWhen?, topics?,
 *                                                   notes?, email?, phone?, linkedin?, lastContact? }  -> { person }
 *   POST /api/network/:code/person/:id         <- any of those; null clears (not the name)          -> { person }
 *   POST /api/network/:code/person/:id/delete                                                         -> { ok }
 *   POST /api/network/:code/person/:id/talked  <- { date? }  Last contact today (or that day)         -> { person }
 *   POST /api/network/:code/person/:id/reach   <- { section: today | soon, energy }  a To-do task "Reach out to
 *                                                 <name>" linking back to the card                   -> { person, task }
 *   POST /api/network/:code/person/:id/sent    <- { what, channel, chaseDays }  a Waiting on item    -> { person, waiting }
 *   POST /api/network/:code/tie                <- { a, b, kind: introduced | works_with, remove? }  -> { ties }
 *   POST /api/network/:code/import             <- { csv, dry: true }  LinkedIn's Connections.csv, read, matched,
 *                                                 a sector suggested                                 -> { rows, counts }
 *                                              <- { csv, sectors: { key: sector } }                  -> { added, matched }
 *
 * Last contact only moves forward, and only on something Paul did: Talked today, ticking the Reach out
 * task in To-do (checked on every read and every cron run), or an answer to a "Sent a message" wait
 * (src/waiting.js, through src/people.js). LinkedIn's "Connected on" is kept but never counts.
 * Nothing is ever sent to anyone and nothing talks to LinkedIn: Paul downloads the file himself.
 *
 * Paul's answers (2026-10-22): his seven fields plus sector, last contact, LinkedIn link, email and
 * phone; sectors Embassies, Ministries, Industry, NATO and EU, Other, and To sort (off the map) for an
 * import with no suggestion; fade after 6 months; LinkedIn's email addresses are not kept; Reach out
 * goes to Soon with energy Normal unless he picks otherwise; a sent message is chased after 7 days unless
 * he picks 3 or 14; a Morning page only; no PIN on top of the code. Someone never contacted fades too
 * (my call: an import of hundreds should not outshine the people he really talks to).
 *
 * D1 `people` and `ties` (migrations/0014_network.sql). Events with ids only, out of Morning's feed:
 * person.added, person.updated, person.deleted, person.contacted, person.reach, person.imported,
 * tie.added, tie.removed. Sector suggestions are fixed word rules, never Claude. */

import { CODE, ENERGY, safeEqual, cleanOp, cleanText } from './todo.js';
import { acceptEvent } from './hub.js';
import { local } from './morning.js';
import { cleanNew, createItem, CHASE_CHOICES } from './waiting.js';
import { touchPerson } from './people.js';

export const FADE_MONTHS = 6;
export const SECTORS = [
  { id: 'emb', name: 'Embassies' }, { id: 'min', name: 'Ministries' }, { id: 'ind', name: 'Industry' },
  { id: 'nato', name: 'NATO and EU' }, { id: 'other', name: 'Other' },
];
const SECTOR_IDS = [...SECTORS.map((s) => s.id), 'sort'];
export const PAGE = 'https://mellowt1.github.io/morning/network/?p=';
const KINDS = ['introduced', 'works_with'];
const PID = /^[a-z0-9]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX = { name: 120, org: 120, role: 120, metWhere: 120, topic: 40, topics: 12, notes: 1000, email: 254, phone: 40, linkedin: 200 };
const MAX_CSV = 3000000;
const MAX_ROWS = 10000;

const line = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const realDate = (s) => typeof s === 'string' && DATE.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

/* ---------- Pure ---------- */

/* A LinkedIn profile link, made comparable: https://www.linkedin.com/in/<slug>, or null. */
export function normalizeLinkedIn(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  let u;
  try { u = new URL(v.trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || !/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  const path = decodeURIComponent(u.pathname).replace(/\/+$/, '').toLowerCase();
  if (!/^\/(in|pub)\/[^/\s]+/.test(path)) return null;
  const out = 'https://www.linkedin.com' + path;
  return out.length <= MAX.linkedin ? out : null;
}

/* The same day n months earlier (31 March - 1 month = 28 or 29 February). */
export function monthsBefore(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 - n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
export const isFading = (lastContact, today) => !lastContact || lastContact < monthsBefore(today, FADE_MONTHS);

/* A sector from a company name, by fixed words; 'sort' when nothing fits. NATO and EU first, so a
 * Permanent Representation to NATO is not taken for an embassy. Paul confirms every one. */
const RULES = [
  ['nato', /\b(nato|otan|nspa|ncia|shape|jfc|european defence agency|eda|european commission|european union|european parliament|council of the eu|eeas|european external action|frontex|europol|eurocontrol|dg defis|occar|eu)\b/i],
  ['emb', /\b(embassy|ambassade|botschaft|embajada|ambasciata|consulate|consulaat|consulado|high commission|permanent representation|permanent mission)\b/i],
  ['min', /\b(ministerie|ministry|ministère|ministerio|bundesministerium|rijksoverheid|rijksdienst|defensie|dmo|rvo|buitenlandse zaken|economische zaken|government of|gemeente|provincie)\b/i],
  ['ind', /\b(b\.?v\.?|n\.?v\.?|ltd|limited|inc|gmbh|plc|llc|s\.a\.|aerospace|defence industry|defense industry|thales|damen|airbus|saab|rheinmetall|lockheed|boeing|bae|leonardo|kongsberg|tno|nidv|fokker|stork|naval|systems)\b/i],
];
export function suggestSector(org) {
  const s = typeof org === 'string' ? org : '';
  if (!s.trim()) return 'sort';
  for (const [id, re] of RULES) if (re.test(s)) return id;
  return 'sort';
}

/* Body in, the columns to write or { error }. `partial`: only the fields sent; null clears. */
export function cleanPerson(body, today, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'send { name, ... }' };
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  const textField = (k, col, max) => {
    if (!has(k)) return null;
    if (body[k] === null || body[k] === '') { out[col] = null; return null; }
    if (typeof body[k] !== 'string') return k + ': text';
    out[col] = line(body[k], max) || null;
    return null;
  };
  if (!partial || has('name')) {
    const name = line(body.name, MAX.name);
    if (!name) return { error: 'name required' };
    out.name = name;
  }
  for (const [k, col] of [['org', 'org'], ['role', 'role'], ['metWhere', 'met_where']]) {
    const e = textField(k, col, MAX[k]);
    if (e) return { error: e };
  }
  if (has('sector')) {
    if (!SECTOR_IDS.includes(body.sector)) return { error: 'sector: ' + SECTOR_IDS.join(', ') };
    out.sector = body.sector;
  }
  if (has('metWhen')) {
    if (body.metWhen === null || body.metWhen === '') out.met_when = null;
    else if (typeof body.metWhen !== 'string' || !MONTH.test(body.metWhen)) return { error: 'metWhen: YYYY-MM' };
    else out.met_when = body.metWhen;
  }
  if (has('topics')) {
    if (body.topics === null) out.topics = '[]';
    else if (!Array.isArray(body.topics)) return { error: 'topics: a list' };
    else {
      const seen = new Set(), list = [];
      for (const t of body.topics) {
        const c = line(t, MAX.topic);
        if (c && !seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); list.push(c); }
      }
      if (list.length > MAX.topics) return { error: 'topics: at most ' + MAX.topics };
      out.topics = JSON.stringify(list);
    }
  }
  if (has('notes')) {
    if (body.notes === null || body.notes === '') out.notes = null;
    else if (typeof body.notes !== 'string') return { error: 'notes: text' };
    else {
      const n = body.notes.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (n.length > MAX.notes) return { error: 'notes: at most ' + MAX.notes + ' characters' };
      out.notes = n || null;
    }
  }
  if (has('email')) {
    if (body.email === null || body.email === '') out.email = null;
    else {
      const e = line(body.email, MAX.email + 1);
      if (e.length > MAX.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { error: 'email: an address' };
      out.email = e;
    }
  }
  if (has('phone')) {
    if (body.phone === null || body.phone === '') out.phone = null;
    else {
      const p = line(body.phone, MAX.phone + 1);
      if (p.length > MAX.phone || !/^[0-9+()\s./-]{3,}$/.test(p) || !/\d/.test(p)) return { error: 'phone: a number' };
      out.phone = p;
    }
  }
  if (has('linkedin')) {
    if (body.linkedin === null || body.linkedin === '') out.linkedin = null;
    else {
      const l = normalizeLinkedIn(body.linkedin);
      if (!l) return { error: 'linkedin: a linkedin.com profile link' };
      out.linkedin = l;
    }
  }
  if (has('lastContact')) {
    if (body.lastContact === null || body.lastContact === '') out.last_contact = null;
    else if (!realDate(body.lastContact) || body.lastContact > today) return { error: 'lastContact: a date, not in the future' };
    else out.last_contact = body.lastContact;
  }
  return { fields: out };
}

/* CSV text in, rows of cells out (quotes, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
export function connectedOn(v) {
  const s = line(v, 40);
  let m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-](\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    const d = mo && `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return d && realDate(d) ? d : null;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m && realDate(s) ? s : null;
}
const nameKey = (name, org) => 'n:' + name.toLowerCase() + '|' + (org || '').toLowerCase();

/* LinkedIn's Connections.csv in, { rows } or { error }. Its "Notes:" lines above the header are skipped
 * and the email column is never read. */
export function parseConnections(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'csv: the file is empty' };
  const all = parseCsv(text);
  const h = all.findIndex((r) => { const l = r.map((c) => c.trim().toLowerCase()); return l.includes('first name') && l.includes('last name'); });
  if (h < 0) return { error: 'csv: no "First Name, Last Name" header; is this Connections.csv?' };
  const head = all[h].map((c) => c.trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  const [fi, la, ur, co, po, on] = ['first name', 'last name', 'url', 'company', 'position', 'connected on'].map(col);
  const rows = [], keys = new Set();
  for (const r of all.slice(h + 1)) {
    if (rows.length >= MAX_ROWS) break;
    const name = line([r[fi] || '', r[la] || ''].join(' '), MAX.name);
    if (!name) continue;
    const org = line(r[co] || '', MAX.org) || null;
    const role = line(r[po] || '', MAX.role) || null;
    const linkedin = ur >= 0 ? normalizeLinkedIn(r[ur]) : null;
    const key = linkedin || nameKey(name, org);
    if (keys.has(key)) continue;
    keys.add(key);
    rows.push({ key, name, org, role, linkedin, connectedOn: on >= 0 ? connectedOn(r[on]) : null });
  }
  return { rows };
}

function view(r, today, waits) {
  const w = waits.get(r.id);
  let topics = [];
  try { topics = JSON.parse(r.topics); } catch (e) { /* stored clean */ }
  return {
    id: r.id, name: r.name, org: r.org, role: r.role, sector: r.sector, metWhere: r.met_where, metWhen: r.met_when,
    topics, notes: r.notes, email: r.email, phone: r.phone, linkedin: r.linkedin, lastContact: r.last_contact,
    fading: isFading(r.last_contact, today), source: r.source, connectedOn: r.connected_on, reachTask: r.reach_task,
    waiting: w ? { id: w.id, what: w.what, nextChase: w.next_chase } : null, updatedAt: r.updated_at,
  };
}

/* ---------- Storage ---------- */

async function emit(env, type, payload, now, summary, source = 'morning') {
  await acceptEvent(env, {
    id: type.replace('.', '-') + '-' + now + '-' + rand(6), source, type, summary,
    payload, caused_by: null, hops: 0, at: new Date(now).toISOString(),
  }, { feed: false });
}
const getRow = (env, id) => env.HUB_DB.prepare('SELECT * FROM people WHERE id = ?').bind(id).first();
async function waitsByPerson(env) {
  const { results } = await env.HUB_DB.prepare("SELECT id, what, next_chase, person FROM waiting WHERE state = 'open' AND person IS NOT NULL ORDER BY created_at").all();
  return new Map((results || []).map((w) => [w.person, w]));
}
async function personOut(env, id, now) {
  const row = await getRow(env, id);
  return row ? view(row, local(now).date, await waitsByPerson(env)) : null;
}
async function allTies(env) {
  const { results } = await env.HUB_DB.prepare('SELECT a, b, kind FROM ties ORDER BY created_at, a, b').all();
  return results || [];
}
/* Many statements: D1's batch where there is one, in chunks. */
async function runAll(env, stmts) {
  for (let i = 0; i < stmts.length; i += 50) {
    const part = stmts.slice(i, i + 50);
    if (env.HUB_DB.batch) await env.HUB_DB.batch(part);
    else for (const s of part) await s.run();
  }
}
const listStub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
async function listDoc(env) {
  const r = await listStub(env).fetch('https://list/export');
  if (!r.ok) throw new Error('todo export ' + r.status);
  return r.json();
}

/* A Reach out task ticked in To-do moves Last contact to the day it was ticked; a deleted one is let go. */
export async function settleReach(env, now = Date.now()) {
  if (!env.HUB_DB || !env.TODO_CODE || !env.TODO_LIST) return { checked: 0 };
  const { results } = await env.HUB_DB.prepare('SELECT id, reach_task FROM people WHERE reach_task IS NOT NULL').all();
  if (!results || !results.length) return { checked: 0 };
  const doc = await listDoc(env);
  const at = new Date(now).toISOString();
  let touched = 0;
  for (const r of results) {
    const it = doc.items && doc.items[r.reach_task];
    if (it && !it.done) continue;
    if (it && it.done && Number.isFinite(it.doneAt) && await touchPerson(env, r.id, local(it.doneAt).date, 'task', 'todo', now)) touched++;
    await env.HUB_DB.prepare('UPDATE people SET reach_task = NULL, updated_at = ? WHERE id = ? AND reach_task = ?').bind(at, r.id, r.reach_task).run();
  }
  return { checked: results.length, touched };
}
export const networkCron = (env, now) => settleReach(env, now);

/* ---------- Routes ---------- */

async function readJson(request, max) {
  const raw = await request.text();
  if (raw.length > max) return { status: 413, error: 'too large' };
  try { const b = raw ? JSON.parse(raw) : {}; return { body: b && typeof b === 'object' && !Array.isArray(b) ? b : {} }; } catch (e) { return { status: 400, error: 'bad json' }; }
}

async function everything(env, now) {
  await settleReach(env, now).catch((e) => console.log('network reach', String(e && e.message)));
  const today = local(now).date;
  const [{ results }, ties, waits] = await Promise.all([
    env.HUB_DB.prepare('SELECT * FROM people ORDER BY name COLLATE NOCASE, id').all(),
    allTies(env),
    waitsByPerson(env),
  ]);
  return { today, fadeMonths: FADE_MONTHS, sectors: SECTORS, people: (results || []).map((r) => view(r, today, waits)), ties };
}

async function create(env, body, now) {
  const today = local(now).date;
  const c = cleanPerson(body, today);
  if (c.error) return { status: 400, error: c.error };
  const f = c.fields;
  if (f.linkedin && await env.HUB_DB.prepare('SELECT 1 FROM people WHERE linkedin = ?').bind(f.linkedin).first()) return { status: 409, error: 'someone with that LinkedIn link is already here' };
  const id = rand(12);
  const at = new Date(now).toISOString();
  await env.HUB_DB.prepare(
    `INSERT INTO people (id, name, org, role, sector, met_where, met_when, topics, notes, email, phone, linkedin, last_contact, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hand', ?, ?)`
  ).bind(id, f.name, f.org ?? null, f.role ?? null, f.sector || 'other', f.met_where ?? null, f.met_when ?? null, f.topics || '[]', f.notes ?? null,
    f.email ?? null, f.phone ?? null, f.linkedin ?? null, f.last_contact ?? null, at, at).run();
  await emit(env, 'person.added', { id }, now, 'Person added');
  return { body: { person: await personOut(env, id, now) } };
}

async function update(env, id, body, now) {
  const c = cleanPerson(body, local(now).date, { partial: true });
  if (c.error) return { status: 400, error: c.error };
  const cols = Object.keys(c.fields);
  if (!cols.length) return { body: { person: await personOut(env, id, now) } };
  if (c.fields.linkedin && await env.HUB_DB.prepare('SELECT 1 FROM people WHERE linkedin = ? AND id != ?').bind(c.fields.linkedin, id).first()) return { status: 409, error: 'someone else has that LinkedIn link' };
  const at = new Date(now).toISOString();
  await env.HUB_DB.prepare('UPDATE people SET ' + cols.map((k) => k + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?')
    .bind(...cols.map((k) => c.fields[k]), at, id).run();
  await emit(env, 'person.updated', { id }, now, 'Person changed');
  return { body: { person: await personOut(env, id, now) } };
}

async function remove(env, id, now) {
  await runAll(env, [
    env.HUB_DB.prepare('DELETE FROM ties WHERE a = ? OR b = ?').bind(id, id),
    env.HUB_DB.prepare('UPDATE waiting SET person = NULL WHERE person = ?').bind(id),
    env.HUB_DB.prepare('DELETE FROM people WHERE id = ?').bind(id),
  ]);
  await emit(env, 'person.deleted', { id }, now, 'Person removed');
  return { body: { ok: true } };
}

async function reach(env, row, body, now) {
  const section = body.section === undefined ? 'soon' : body.section;
  const energy = body.energy === undefined ? 'normal' : body.energy;
  if (!['today', 'soon'].includes(section)) return { status: 400, error: 'section: today or soon' };
  if (!ENERGY.includes(energy)) return { status: 400, error: 'energy: ' + ENERGY.join(', ') };
  if (!env.TODO_CODE || !env.TODO_LIST) return { status: 503, error: 'not configured' };
  if (row.reach_task) {
    const doc = await listDoc(env);
    const it = doc.items && doc.items[row.reach_task];
    if (it && !it.done) return { status: 409, error: 'a Reach out task is already in To-do' };
  }
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('reach:' + row.id + ':' + now));
  const taskId = Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
  const text = cleanText('Reach out to ' + row.name);
  const op = cleanOp({ op: 'upsert', item: { id: taskId, text, section, done: false, doneAt: null, updatedAt: now, pos: now, link: PAGE + row.id, energy } }, now);
  if (!op) return { status: 400, error: 'could not make the task' };
  const r = await listStub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [op] }), headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) return { status: 502, error: 'To-do did not take the task' };
  await env.HUB_DB.prepare('UPDATE people SET reach_task = ?, updated_at = ? WHERE id = ?').bind(taskId, new Date(now).toISOString(), row.id).run();
  await emit(env, 'person.reach', { id: row.id, task: taskId }, now, 'Reach out task made');
  return { body: { person: await personOut(env, row.id, now), task: { id: taskId, text } } };
}

async function sent(env, row, body, now) {
  const days = body.chaseDays === undefined ? 7 : body.chaseDays;
  if (!CHASE_CHOICES.includes(days)) return { status: 400, error: 'chaseDays: ' + CHASE_CHOICES.join(', ') };
  const fields = cleanNew({ who: row.name, what: body.what, channel: body.channel, chaseDays: days, person: row.id }, local(now).date);
  if (fields.error) return { status: 400, error: fields.error };
  const item = await createItem(env, fields, 'morning', now);
  if (!item) return { status: 409, error: 'not made' };
  return { body: { person: await personOut(env, row.id, now), waiting: { id: item.id } } };
}

async function tie(env, body, now) {
  const { a, b, kind } = body;
  if (!PID.test(a || '') || !PID.test(b || '') || a === b) return { status: 400, error: 'a and b: two different people' };
  if (!KINDS.includes(kind)) return { status: 400, error: 'kind: introduced or works_with' };
  const [x, y] = kind === 'works_with' && b < a ? [b, a] : [a, b];
  if (body.remove === true) {
    const r = await env.HUB_DB.prepare('DELETE FROM ties WHERE a = ? AND b = ? AND kind = ?').bind(x, y, kind).run();
    if (r.meta && r.meta.changes) await emit(env, 'tie.removed', { kind }, now, 'Link removed');
  } else {
    const found = await env.HUB_DB.prepare('SELECT COUNT(*) AS n FROM people WHERE id IN (?, ?)').bind(x, y).first();
    if (!found || found.n !== 2) return { status: 404, error: 'no such person' };
    const r = await env.HUB_DB.prepare('INSERT OR IGNORE INTO ties (a, b, kind, created_at) VALUES (?, ?, ?, ?)').bind(x, y, kind, new Date(now).toISOString()).run();
    if (r.meta && r.meta.changes) await emit(env, 'tie.added', { kind }, now, 'Link added');
  }
  return { body: { ties: await allTies(env) } };
}

/* Match each row to someone already here: the LinkedIn link first, else the same name and company. */
export async function importRows(env, csv) {
  const parsed = parseConnections(csv);
  if (parsed.error) return parsed;
  const { results } = await env.HUB_DB.prepare('SELECT id, name, org, linkedin FROM people').all();
  const byLink = new Map(), byName = new Map();
  for (const p of results || []) {
    if (p.linkedin) byLink.set(p.linkedin, p.id);
    byName.set(nameKey(p.name, p.org), p.id);
  }
  const rows = parsed.rows.map((r) => {
    const match = (r.linkedin && byLink.get(r.linkedin)) || byName.get(nameKey(r.name, r.org)) || null;
    return { ...r, status: match ? 'match' : 'new', match, sector: suggestSector(r.org) };
  });
  return { rows };
}

async function importCsv(env, body, now) {
  if (typeof body.csv !== 'string' || body.csv.length > MAX_CSV) return { status: 400, error: 'csv: the text of Connections.csv' };
  const got = await importRows(env, body.csv);
  if (got.error) return { status: 400, error: got.error };
  const counts = { total: got.rows.length, new: got.rows.filter((r) => r.status === 'new').length, match: got.rows.filter((r) => r.status === 'match').length };
  if (body.dry === true) return { body: { rows: got.rows.map(({ match, ...r }) => r), counts } };
  const chosen = body.sectors && typeof body.sectors === 'object' ? body.sectors : {};
  const at = new Date(now).toISOString();
  const stmts = [];
  for (const r of got.rows) {
    if (r.status === 'match') {
      stmts.push(env.HUB_DB.prepare('UPDATE people SET org = COALESCE(org, ?), role = COALESCE(role, ?), linkedin = COALESCE(linkedin, ?), connected_on = COALESCE(connected_on, ?), updated_at = ? WHERE id = ?')
        .bind(r.org, r.role, r.linkedin, r.connectedOn, at, r.match));
    } else {
      const sector = SECTOR_IDS.includes(chosen[r.key]) ? chosen[r.key] : r.sector;
      stmts.push(env.HUB_DB.prepare(
        `INSERT INTO people (id, name, org, role, sector, linkedin, connected_on, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'linkedin', ?, ?)`
      ).bind(rand(12), r.name, r.org, r.role, sector, r.linkedin, r.connectedOn, at, at));
    }
  }
  await runAll(env, stmts);
  await emit(env, 'person.imported', { added: counts.new, matched: counts.match }, now, 'LinkedIn import');
  return { body: { added: counts.new, matched: counts.match } };
}

export async function handleNetwork(request, env, rest, json, now = Date.now()) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  const sub = rest.slice(1);
  if (request.method === 'GET') {
    if (sub.length) return json({ error: 'not found' }, request, 404);
    return json(await everything(env, now), request);
  }
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const got = await readJson(request, sub[0] === 'import' ? MAX_CSV + 200000 : 8000);
  if (got.error) return json({ error: got.error }, request, got.status);
  const b = got.body;
  let out;
  if (sub.length === 1 && sub[0] === 'person') out = await create(env, b, now);
  else if (sub.length === 1 && sub[0] === 'tie') out = await tie(env, b, now);
  else if (sub.length === 1 && sub[0] === 'import') out = await importCsv(env, b, now);
  else if (sub[0] === 'person' && PID.test(sub[1] || '') && sub.length <= 3) {
    const row = await getRow(env, sub[1]);
    if (!row) return json({ error: 'no such person' }, request, 404);
    const act = sub[2];
    if (!act) out = await update(env, row.id, b, now);
    else if (act === 'delete') out = await remove(env, row.id, now);
    else if (act === 'talked') {
      const today = local(now).date;
      const date = b.date === undefined ? today : b.date;
      if (!realDate(date) || date > today) return json({ error: 'date: a day, not in the future' }, request, 400);
      await touchPerson(env, row.id, date, 'talked', 'morning', now);
      out = { body: { person: await personOut(env, row.id, now) } };
    } else if (act === 'reach') out = await reach(env, row, b, now);
    else if (act === 'sent') out = await sent(env, row, b, now);
    else return json({ error: 'not found' }, request, 404);
  } else return json({ error: 'not found' }, request, 404);
  if (out.error) return json({ error: out.error }, request, out.status);
  return json(out.body, request);
}
