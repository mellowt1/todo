/* The hub: typed events, rules and reactions.
 *
 * An event is a fact one app tells the hub ("defence-digest found a vacancy"). It is stored once
 * in D1 (HUB_DB). Each enabled rule that matches its source and type puts one message on the
 * queue (HUB_QUEUE), carrying only the payload fields the rule allows. The queue consumer hands
 * the message to the target's handler, which reacts (the to-do gets a task; Kitchen marks Paul out
 * for dinner, src/dinner.js).
 *
 *   POST /api/event   Authorization: Bearer <HUB_SECRET_<SOURCE>>
 *                     <- { id, source, type, summary, payload, caused_by?, hops? }
 *                     -> { ok: true, id, queued }  or  { ok: true, id, duplicate: true }
 *   GET  /api/admin/rules              (ADMIN_TOKEN)  -> { rules: [...] }
 *   POST /api/admin/rules/:id          (ADMIN_TOKEN)  <- { enabled: true | false }  -> { ok: true, rule }
 *
 * `id` comes from the sender and must be stable, so a resent event is a no-op (a vacancy: the
 * sha256 of its URL). A source's secret is HUB_SECRET_ plus the source in capitals, dashes as
 * underscores (defence-digest -> HUB_SECRET_DEFENCE_DIGEST). An event with hops >= 1 is stored
 * but never queued: no chained reactions yet.
 *
 * A one-line event without `type` ({ source, text }, EVENT_TOKEN) still goes to src/events.js.
 * A typed event also writes one line there, so Morning's feed shows it.
 *
 * The consumer is idempotent: a message whose (target, event_id) is in `handled` is skipped,
 * and the row is written after the handler succeeds, so a failed attempt is retried, not lost.
 * The to-do task's id is derived from the event id, so a retry can never make a second task.
 * After 5 attempts a message goes to the dead letter queue (wrangler.toml). */

import { safeEqual, bearer, cleanText, cleanLink, cleanOp } from './todo.js';
import { putEvent } from './events.js';
import { kitchenTarget } from './dinner.js';

const SOURCE = /^[a-z0-9-]{2,24}$/;
const TYPE = /^[a-z0-9-]{2,24}(\.[a-z0-9-]{2,24}){1,2}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{8,100}$/;
const RULE_ID = /^[a-z0-9-]{2,48}$/;
const MAX_PAYLOAD = 4000;
const MAX_HOPS = 10;
const clean = (v, max) => String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export const secretName = (source) => 'HUB_SECRET_' + source.toUpperCase().replace(/-/g, '_');

/* Pure: body in, a clean event or { error }. */
export function cleanHubEvent(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'send { id, source, type, summary, payload }' };
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!EVENT_ID.test(id)) return { error: 'id: 8 to 100 of A-Z, a-z, 0-9, . _ : -' };
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  if (!SOURCE.test(source)) return { error: 'source: 2 to 24 of a-z, 0-9, -' };
  const type = typeof body.type === 'string' ? body.type.trim() : '';
  if (!TYPE.test(type)) return { error: 'type: like vacancy.found' };
  const summary = typeof body.summary === 'string' ? clean(body.summary, 200) : '';
  if (!summary) return { error: 'summary required' };
  const payload = body.payload === undefined ? {} : body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'payload: an object' };
  const pj = JSON.stringify(payload);
  if (pj.length > MAX_PAYLOAD) return { error: 'payload too large' };
  let causedBy = null;
  if (body.caused_by !== undefined && body.caused_by !== null) {
    if (typeof body.caused_by !== 'string' || !EVENT_ID.test(body.caused_by)) return { error: 'caused_by: an event id' };
    causedBy = body.caused_by;
  }
  const hops = body.hops === undefined ? 0 : body.hops;
  if (!Number.isInteger(hops) || hops < 0 || hops > MAX_HOPS) return { error: 'hops: 0 to ' + MAX_HOPS };
  return { id, source, type, summary, payload: JSON.parse(pj), caused_by: causedBy, hops, at: new Date(now).toISOString() };
}

/* Pure: only the fields the rule allows. */
export function pick(payload, fields) {
  const out = {};
  for (const f of fields) if (typeof f === 'string' && Object.prototype.hasOwnProperty.call(payload, f)) out[f] = payload[f];
  return out;
}

const parseFields = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; } };

/* Store, match, enqueue. Returns the response body and status. */
export async function acceptEvent(env, ev) {
  const ins = await env.HUB_DB.prepare(
    'INSERT INTO events (id, source, type, summary, payload, caused_by, hops, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
  ).bind(ev.id, ev.source, ev.type, ev.summary, JSON.stringify(ev.payload), ev.caused_by, ev.hops, ev.at).run();
  if (!ins.meta || ins.meta.changes === 0) return { status: 200, body: { ok: true, id: ev.id, duplicate: true } };

  let queued = 0;
  if (ev.hops < 1) {
    const { results } = await env.HUB_DB.prepare('SELECT id, target, fields FROM rules WHERE source = ? AND type = ? AND enabled = 1')
      .bind(ev.source, ev.type).all();
    const messages = (results || []).map((r) => ({ body: {
      event_id: ev.id, rule: r.id, target: r.target, source: ev.source, type: ev.type, summary: ev.summary,
      payload: pick(ev.payload, parseFields(r.fields)),
    } }));
    if (messages.length) {
      try {
        await env.HUB_QUEUE.sendBatch(messages);
      } catch (e) {
        // Nothing was queued: forget the event, so the sender's retry is not a duplicate.
        await env.HUB_DB.prepare('DELETE FROM events WHERE id = ?').bind(ev.id).run();
        return { status: 503, body: { error: 'queue unavailable, send again' } };
      }
    }
    queued = messages.length;
  }
  try {
    await putEvent(env, { source: ev.source, kind: ev.type.split('.')[0].slice(0, 16), who: '', text: ev.summary.slice(0, 140), at: ev.at });
  } catch (e) { /* the feed line is a nicety; the event is stored */ }
  return { status: 200, body: { ok: true, id: ev.id, queued } };
}

/* POST /api/event with a `type`: called from events.js once the body is parsed. */
export async function handleHubEvent(request, env, body, json, now = Date.now()) {
  const source = body && typeof body.source === 'string' ? body.source.trim() : '';
  const secret = SOURCE.test(source) ? env[secretName(source)] : '';
  if (!secret || !safeEqual(bearer(request), secret)) return json({ error: 'unauthorized' }, request, 401);
  if (!env.HUB_DB || !env.HUB_QUEUE) return json({ error: 'not configured' }, request, 503);
  const ev = cleanHubEvent(body, now);
  if (ev.error) return json({ error: ev.error }, request, 400);
  const out = await acceptEvent(env, ev);
  return json(out.body, request, out.status);
}

/* ---------- Reactions ---------- */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function cleanDate(v) {
  if (typeof v !== 'string' || !DATE.test(v.trim())) return null;
  const s = v.trim();
  const d = new Date(s + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

async function hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
}

/* The to-do task id for a vacancy event: derived, so a retry never makes a second task, and
 * Morning's Week view can find the task an event made (src/week.js). */
export async function todoTaskId(eventId) {
  return (await hex('todo:' + eventId)).slice(0, 24);
}

/* Pure: a vacancy payload in, the task out, or { skip } when it can never become one. */
export function vacancyTask(payload, id, now) {
  const title = typeof payload.title === 'string' ? clean(payload.title, 200) : '';
  if (!title) return { skip: 'no title' };
  const org = typeof payload.organisation === 'string' ? clean(payload.organisation, 120) : '';
  const due = cleanDate(payload.deadline); // only a real date from the payload, never a guess
  const text = cleanText('Apply: ' + title + (org ? ' (' + org + ')' : '') + (due ? ' · ' + due : ''));
  if (!text) return { skip: 'text too long' };
  const item = { id, text, section: 'soon', done: false, doneAt: null, updatedAt: now, pos: now };
  const link = cleanLink(payload.link);
  if (link) item.link = link;
  const op = cleanOp({ op: 'upsert', item }, now);
  return op ? { op } : { skip: 'invalid task' };
}

const TARGETS = {
  /* The to-do list. A task that already exists, or was deleted, is left alone. */
  async todo(env, msg, now) {
    if (msg.type !== 'vacancy.found') return { skip: 'no todo reaction for ' + msg.type };
    if (!env.TODO_CODE) throw new Error('TODO_CODE missing');
    const id = await todoTaskId(msg.event_id);
    const t = vacancyTask(msg.payload || {}, id, now);
    if (t.skip) return t;
    const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
    const doc = await (await stub.fetch('https://list/export')).json();
    if ((doc.items && doc.items[id]) || (doc.tombs && doc.tombs[id] !== undefined)) return { skip: 'already there' };
    const r = await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [t.op] }), headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error('todo apply ' + r.status);
    return { done: id };
  },

  /* Kitchen: Paul out for dinner on a date (src/dinner.js). Sets or clears a flag; never a meal. */
  kitchen: (env, msg) => kitchenTarget(env, msg),
};

/* One message: skip if handled, react, then mark handled. Throws to have it retried. */
export async function handleMessage(env, body, now = Date.now()) {
  const handler = TARGETS[body && body.target];
  if (!handler) throw new Error('unknown target ' + (body && body.target));
  const seen = await env.HUB_DB.prepare('SELECT 1 FROM handled WHERE target = ? AND event_id = ?').bind(body.target, body.event_id).first();
  if (seen) return { skip: 'handled' };
  const out = await handler(env, body, now);
  await env.HUB_DB.prepare('INSERT OR IGNORE INTO handled (target, event_id, at) VALUES (?, ?, ?)')
    .bind(body.target, body.event_id, new Date(now).toISOString()).run();
  return out;
}

/* The queue consumer (worker.js `queue`). */
export async function consume(batch, env) {
  for (const msg of batch.messages) {
    try {
      const out = await handleMessage(env, msg.body);
      console.log('hub', msg.body.target, msg.body.event_id, JSON.stringify(out));
      msg.ack();
    } catch (e) {
      console.log('hub retry', msg.body && msg.body.target, msg.body && msg.body.event_id, msg.attempts, String(e && e.message));
      msg.retry({ delaySeconds: Math.min(600, 30 * (msg.attempts || 1)) });
    }
  }
}

/* ---------- Admin: list rules, flip one ---------- */

const ruleOut = (r) => ({ id: r.id, source: r.source, type: r.type, target: r.target, fields: parseFields(r.fields), enabled: r.enabled === 1 });

export async function adminRules(request, env, rest, json, readBody) {
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  if (rest.length === 0) {
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    const { results } = await env.HUB_DB.prepare('SELECT * FROM rules ORDER BY id').all();
    return json({ rules: (results || []).map(ruleOut) }, request);
  }
  if (rest.length !== 1 || !RULE_ID.test(rest[0])) return json({ error: 'not found' }, request, 404);
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const got = await readBody(request, 1000);
  if (got.error) return json({ error: got.error }, request, got.status);
  if (!got.body || typeof got.body.enabled !== 'boolean') return json({ error: 'send { "enabled": true | false }' }, request, 400);
  const r = await env.HUB_DB.prepare('UPDATE rules SET enabled = ? WHERE id = ?').bind(got.body.enabled ? 1 : 0, rest[0]).run();
  if (!r.meta || r.meta.changes === 0) return json({ error: 'no such rule' }, request, 404);
  const row = await env.HUB_DB.prepare('SELECT * FROM rules WHERE id = ?').bind(rest[0]).first();
  return json({ ok: true, rule: ruleOut(row) }, request);
}
