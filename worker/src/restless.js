/* The Restless list (Paul, 2026-10-24; wave 2 Phase 4): things to do with spare energy. When the
 * Energy dial says wired, Morning and Day show "Restless?": Go picks one that fits the time Paul has,
 * Another skips it, Not for me hides it for today, Done logs it. Items done come up more often,
 * items skipped less. Added by a small form in Morning and Day, by "restless: ..." in To-do's New task
 * and by mail to hub@ with a "restless:" subject (src/mail.js).
 *
 *   GET  /api/restless/:code                    -> { items, kinds, counts }
 *   POST /api/restless/:code/add                <- { text, kind?, mins?, place?, costs?, source }   -> { item }
 *   POST /api/restless/:code/item/:id           <- { text?, kind?, mins?, place?, costs? }           -> { item }
 *   POST /api/restless/:code/item/:id/delete                                                         -> { ok }
 *   POST /api/restless/:code/pick               <- { mins: n | null, skip: [id], another?: id, source } -> { item, fit, dark }
 *   POST /api/restless/:code/done               <- { id, source }                                    -> { item }
 *   POST /api/restless/:code/notforme           <- { id, source }                                    -> { item }
 *   GET/POST /api/hub/restless/day[/pick | /done | /notforme | /add]   the same for Day, Bearer HUB_SECRET_DAY
 *
 * Paul's answers (2026-10-24, "do it" on the recommendations): fields what, kind (move, build,
 * outside, social, learn, home), about how long (15, 30, 60, 120 = 2 h or more), inside or outside,
 * costs money; the free time comes from the apps (until the next calendar event, or a chip); the only
 * time rule is no outside things between sunset and sunrise (The Hague); Done multiplies the weight
 * by 1.25, Another by 0.8, Not for me by 0.5 and hides it until tomorrow; a kind not given is guessed
 * from fixed words, else the item waits in To sort. The list starts empty: only Paul's own items.
 *
 * Events, through acceptEvent, kept out of Morning's feed, ids and kinds only:
 *   restless.picked { item, mins }   restless.done { item, kind }   restless.skipped { item, why: another | notforme }
 *   restless.added { item, source } */

import { CODE, safeEqual, bearer } from './todo.js';
import { acceptEvent } from './hub.js';
import { local, zoned, addDays } from './morning.js';

export const KINDS = ['move', 'build', 'outside', 'social', 'learn', 'home'];
export const MINS = [15, 30, 60, 120];
export const DRIFT = { done: 1.25, another: 0.8, notforme: 0.5 }; // Paul's OK, 2026-10-24
export const WEIGHT_MIN = 0.05;
export const WEIGHT_MAX = 20;
export const TEXT_MAX = 80;
export const HAGUE = { lat: 52.08, lng: 4.31 };
const ID = /^[a-z0-9]{12}$/;
const SOURCES = ['todo', 'morning', 'day', 'mail'];
const HOUR = 3600000;

const rand = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/* ---------- Reading "restless: ..." ---------- */

// Fixed words for a kind, checked in this order; the first that matches wins. No Claude.
const KIND_WORDS = [
  ['move', /\b(push-?ups?|sit-?ups?|pull-?ups?|planks?|squats?|burpees?|opdrukken|dance|dancing|dansen|run|running|jog|gym|climb|climbing|boulder\w*|swim\w*|yoga|workout|train|training|football|padel|tennis|squash|stretch\w*|row|rowing|box|boxing|sport|fitness|hardlopen|zwemmen)\b/i],
  ['build', /\b(build|fix|make|solder|code|coding|repair|assemble|print|3d|project|tinker|wire|wiring|sand|varnish|bouw\w*|maak|maken|repareer)\b/i],
  ['social', /\b(call|text|meet|friend|friends|coffee with|drinks|dinner with|visit|bel|bellen|afspreken|vrienden)\b/i],
  ['learn', /\b(read|learn|study|course|german|deutsch|spanish|duolingo|practi[cs]e|lesson|podcast|lecture|lezen|leren|cursus)\b/i],
  ['home', /\b(clean|tidy|cook|bake|laundry|declutter|sort out|organi[sz]e|vacuum|iron|wash|schoonmaken|opruimen|koken)\b/i],
  ['outside', /\b(walk|hike|park|beach|kayak|canoe|sail|garden|picnic|bike|cycle|cycling|ride|forest|dunes|fiets\w*|wandel\w*|strand)\b/i],
];

/* Pure: "kayak on the Vliet 2h outside €" -> { text, kind, mins, place, costs }. Words for time,
 * place and money are taken out of the text; a kind is only guessed. */
export function readLine(raw) {
  let s = clean(raw, 300).replace(/^restless\s*:\s*/i, '');
  let mins = null;
  let place = null;
  let costs = null;
  const take = (re, fn) => { s = s.replace(re, (...m) => { fn(m); return ' '; }); };
  take(/(?:^|\s)(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours|u|uur)\b/i, (m) => { mins = bucket(parseFloat(m[1].replace(',', '.')) * 60); });
  take(/(?:^|\s)(\d+)\s*(?:m|min|mins|minute|minutes|minuten)\b/i, (m) => { if (mins === null) mins = bucket(+m[1]); });
  take(/(?:^|\s)(?:outside|outdoors?|buiten)\b/i, () => { place = 'outside'; });
  take(/(?:^|\s)(?:inside|indoors?|binnen)\b/i, () => { if (!place) place = 'inside'; });
  take(/(?:^|\s)(?:free|gratis)\b(?!\s+\w)/i, () => { costs = 0; });
  take(/\s*(?:€|\$|£)\s*\d*(?:[.,]\d+)?/, () => { costs = 1; });
  take(/(?:^|\s)(?:costs? money|paid|kost geld)\b/i, () => { costs = 1; });
  let text = clean(s, TEXT_MAX).replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, '');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return { text, kind: guessKind(text), mins, place, costs };
}

export function guessKind(text) {
  for (const [kind, re] of KIND_WORDS) if (re.test(text)) return kind;
  return null;
}

/* Pure: any number of minutes -> the bucket it belongs in. */
export function bucket(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n <= 15 ? 15 : n <= 30 ? 30 : n <= 60 ? 60 : 120;
}

/* ---------- The sun, for "no outside things in the dark" ---------- */

/* Pure: sunrise and sunset (ms) on a date at a place, by the sunrise equation; a few minutes out at most. */
export function sunTimes(date, { lat, lng } = HAGUE) {
  const rad = Math.PI / 180;
  const jdate = Date.parse(date + 'T00:00:00Z') / 86400000 + 2440587.5; // midnight: n is this day
  const n = Math.ceil(jdate - 2451545.0 + 0.0008);
  const jstar = n - lng / 360;
  const M = (357.5291 + 0.98560028 * jstar) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545.0 + jstar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
  const dec = Math.asin(Math.sin(lambda * rad) * Math.sin(23.4397 * rad));
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
  const w = Math.acos(Math.max(-1, Math.min(1, cosW))) / rad;
  const ms = (j) => Math.round((j - 2440587.5) * 86400000);
  return { rise: ms(transit - w / 360), set: ms(transit + w / 360) };
}

export function isDark(now) {
  const { rise, set } = sunTimes(local(now).date);
  return now < rise || now >= set;
}

/* ---------- Picking ---------- */

/* Pure: the items that fit: not deleted, not hidden today, short enough for the time he has (an item
 * with no time fits any), no outside thing in the dark, none skipped this round. */
export function fits(items, { mins = null, dark = false, today, skip = [] } = {}) {
  return items.filter((it) => !it.deleted_at
    && !(it.hidden_until && it.hidden_until > today)
    && (mins === null || it.mins === null || it.mins <= mins)
    && !(dark && it.place === 'outside')
    && !skip.includes(it.id));
}

/* Pure: one of them, by weight: a weight of 2 comes up twice as often as a weight of 1. */
export function pickOne(items, random = Math.random) {
  const total = items.reduce((t, it) => t + Math.max(WEIGHT_MIN, it.weight), 0);
  let r = random() * total;
  for (const it of items) {
    r -= Math.max(WEIGHT_MIN, it.weight);
    if (r < 0) return it;
  }
  return items[items.length - 1] || null;
}

export const drift = (weight, why) => Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, Math.round(weight * DRIFT[why] * 1000) / 1000));

/* ---------- Storage ---------- */

export const view = (it) => it && ({
  id: it.id, text: it.text, kind: it.kind, mins: it.mins, place: it.place, costs: it.costs === null ? null : !!it.costs,
  weight: Math.round(it.weight * 100) / 100, done: it.done_n, skipped: it.skip_n, hiddenUntil: it.hidden_until, source: it.source, createdAt: it.created_at,
});

async function emit(env, type, source, payload, now) {
  await acceptEvent(env, {
    id: type.replace('.', '-') + '-' + now + '-' + rand(6), source, type, summary: type,
    payload, caused_by: null, hops: 0, at: new Date(now).toISOString(),
  }, { feed: false });
}

const one = (env, id) => env.HUB_DB.prepare('SELECT * FROM restless_items WHERE id = ? AND deleted_at IS NULL').bind(id).first();
const all = async (env) => (await env.HUB_DB.prepare('SELECT * FROM restless_items WHERE deleted_at IS NULL ORDER BY created_at').all()).results || [];

/* Explicit fields win over what the line says. */
export function fields(b, parsed) {
  const out = { ...parsed };
  if (KINDS.includes(b.kind) || b.kind === null) out.kind = b.kind;
  if (MINS.includes(b.mins) || b.mins === null) out.mins = b.mins;
  if (b.place === 'inside' || b.place === 'outside' || b.place === null) out.place = b.place;
  if (typeof b.costs === 'boolean') out.costs = b.costs ? 1 : 0; else if (b.costs === null) out.costs = null;
  return out;
}

export async function addItem(env, raw, extra, source, now = Date.now()) {
  const f = fields(extra || {}, readLine(raw));
  if (!f.text) return { error: 'What is it? Give it a few words.', status: 400 };
  const id = rand();
  const at = new Date(now).toISOString();
  await env.HUB_DB.prepare('INSERT INTO restless_items (id, text, kind, mins, place, costs, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, f.text, f.kind, f.mins, f.place, f.costs, source, at, at).run();
  await emit(env, 'restless.added', source, { item: id, source }, now);
  return { item: view(await one(env, id)) };
}

async function editItem(env, id, b, now) {
  const it = await one(env, id);
  if (!it) return { error: 'not there', status: 404 };
  const text = b.text === undefined ? it.text : clean(b.text, TEXT_MAX);
  if (!text) return { error: 'What is it? Give it a few words.', status: 400 };
  const f = fields(b, { kind: it.kind, mins: it.mins, place: it.place, costs: it.costs });
  await env.HUB_DB.prepare('UPDATE restless_items SET text = ?, kind = ?, mins = ?, place = ?, costs = ?, updated_at = ? WHERE id = ?')
    .bind(text, f.kind, f.mins, f.place, f.costs, new Date(now).toISOString(), id).run();
  return { item: view(await one(env, id)) };
}

async function skipItem(env, id, why, source, now) {
  const it = await one(env, id);
  if (!it) return { error: 'not there', status: 404 };
  const hidden = why === 'notforme' ? addDays(local(now).date, 1) : it.hidden_until;
  await env.HUB_DB.prepare('UPDATE restless_items SET weight = ?, skip_n = skip_n + 1, hidden_until = ?, updated_at = ? WHERE id = ?')
    .bind(drift(it.weight, why), hidden, new Date(now).toISOString(), id).run();
  await emit(env, 'restless.skipped', source, { item: id, why }, now);
  return { item: view(await one(env, id)) };
}

async function doneItem(env, id, source, now) {
  const it = await one(env, id);
  if (!it) return { error: 'not there', status: 404 };
  await env.HUB_DB.prepare('UPDATE restless_items SET weight = ?, done_n = done_n + 1, updated_at = ? WHERE id = ?')
    .bind(drift(it.weight, 'done'), new Date(now).toISOString(), id).run();
  await emit(env, 'restless.done', source, { item: id, kind: it.kind }, now);
  return { item: view(await one(env, id)) };
}

export async function pick(env, { mins = null, skip = [], another = null }, source, now = Date.now(), random = Math.random) {
  if (another) await skipItem(env, another, 'another', source, now);
  const dark = isDark(now);
  const pool = fits(await all(env), { mins, dark, today: local(now).date, skip: another ? [...skip, another] : skip });
  const it = pickOne(pool, random);
  if (it) await emit(env, 'restless.picked', source, { item: it.id, mins }, now);
  return { item: view(it), fit: pool.length, dark };
}

/* ---------- The Sunday card ---------- */

/* Pure: the week's events (oldest first) + the items -> what the spare energy went to. */
export function restlessWeek(rows, items) {
  const byId = new Map((items || []).map((it) => [it.id, it]));
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const done = [];
  let skipped = 0;
  let wired = 0;
  for (const r of rows) {
    let p = {};
    try { p = JSON.parse(r.payload) || {}; } catch (e) { /* none */ }
    if (r.type === 'energy.set' && p.level === 'wired') wired++;
    else if (r.type === 'restless.skipped') skipped++;
    else if (r.type === 'restless.done') {
      const it = byId.get(p.item);
      const kind = (it && it.kind) || p.kind || null;
      if (kind && byKind[kind] !== undefined) byKind[kind]++;
      done.push({ item: p.item, text: it ? it.text : 'Something since removed', kind, at: r.at });
    }
  }
  return { wired, done, skipped, byKind };
}

export async function restlessFor(env, monday) {
  if (!env.HUB_DB) return null;
  const from = new Date(zoned(monday)).toISOString();
  const to = new Date(zoned(addDays(monday, 7))).toISOString();
  const { results } = await env.HUB_DB.prepare(
    "SELECT type, payload, at FROM events WHERE type IN ('energy.set', 'restless.done', 'restless.skipped') AND at >= ? AND at < ? ORDER BY at, rowid"
  ).bind(from, to).all();
  const items = (await env.HUB_DB.prepare('SELECT id, text, kind FROM restless_items').all()).results || [];
  return restlessWeek(results || [], items);
}

/* ---------- Routes ---------- */

async function readJson(request, max = 2000) {
  const raw = await request.text();
  if (raw.length > max) return { status: 413, error: 'too large' };
  try { return { body: raw ? JSON.parse(raw) : {} }; } catch (e) { return { status: 400, error: 'bad json' }; }
}

async function restlessRoute(request, env, sub, sourceFixed, json, now) {
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  if (sub.length === 0 && request.method === 'GET') {
    const items = await all(env);
    return json({
      items: items.map(view), kinds: KINDS,
      counts: { total: items.length, done: items.reduce((n, it) => n + it.done_n, 0), skipped: items.reduce((n, it) => n + it.skip_n, 0) },
    }, request);
  }
  if (request.method !== 'POST') return json({ error: 'not found' }, request, 404);
  const got = await readJson(request);
  if (got.error) return json({ error: got.error }, request, got.status);
  const b = got.body && typeof got.body === 'object' ? got.body : {};
  const source = sourceFixed || (SOURCES.includes(b.source) && b.source !== 'mail' ? b.source : null);
  const send = (out) => json(out.error ? { error: out.error } : out, request, out.status || 200);
  const id = typeof b.id === 'string' && ID.test(b.id) ? b.id : null;

  if (sub.length === 1 && ['add', 'pick', 'done', 'notforme'].includes(sub[0]) && !source) return json({ error: 'source: todo, morning or day' }, request, 400);
  if (sub.length === 1) {
    switch (sub[0]) {
      case 'add':
        if (typeof b.text !== 'string' || b.text.length > 300) return json({ error: 'text' }, request, 400);
        return send(await addItem(env, b.text, b, source, now));
      case 'pick': {
        const mins = b.mins === null || b.mins === undefined ? null : Number.isFinite(b.mins) && b.mins > 0 && b.mins <= 1440 ? Math.round(b.mins) : NaN;
        if (Number.isNaN(mins)) return json({ error: 'mins: minutes or null' }, request, 400);
        const skip = Array.isArray(b.skip) ? b.skip.filter((s) => typeof s === 'string' && ID.test(s)).slice(0, 100) : [];
        const another = typeof b.another === 'string' && ID.test(b.another) ? b.another : null;
        return send(await pick(env, { mins, skip, another }, source, now));
      }
      case 'done':
        if (!id) return json({ error: 'id' }, request, 400);
        return send(await doneItem(env, id, source, now));
      case 'notforme':
        if (!id) return json({ error: 'id' }, request, 400);
        return send(await skipItem(env, id, 'notforme', source, now));
    }
  }
  if (!sourceFixed && sub[0] === 'item' && ID.test(sub[1] || '')) {
    if (sub.length === 2) return send(await editItem(env, sub[1], b, now));
    if (sub.length === 3 && sub[2] === 'delete') {
      const r = await env.HUB_DB.prepare('UPDATE restless_items SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .bind(new Date(now).toISOString(), new Date(now).toISOString(), sub[1]).run();
      return r.meta.changes ? json({ ok: true }, request) : json({ error: 'not there' }, request, 404);
    }
  }
  return json({ error: 'not found' }, request, 404);
}

export async function handleRestless(request, env, rest, json, now = Date.now()) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  return restlessRoute(request, env, rest.slice(1), null, json, now);
}

/* /api/hub/restless/day[/pick | /done | /notforme | /add]: Day on the Mac, through the Odysseus backend. */
export async function handleRestlessDay(request, env, sub, json, now = Date.now()) {
  if (!env.HUB_SECRET_DAY || !safeEqual(bearer(request), env.HUB_SECRET_DAY)) return json({ error: 'unauthorized' }, request, 401);
  if (sub.length > 1 || (sub.length === 1 && !['pick', 'done', 'notforme', 'add'].includes(sub[0]))) return json({ error: 'not found' }, request, 404);
  return restlessRoute(request, env, sub, 'day', json, now);
}
