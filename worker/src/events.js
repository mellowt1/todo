/* Events: the hub's inbox. Every other app or job posts one line when something happens, and
 * Morning shows the last few days as one feed. Nothing here owns the other apps' data; it only
 * hears about it.
 *
 *   POST /api/event   Authorization: Bearer <EVENT_TOKEN>  <- { source, text, kind?, who?, at? }  -> { ok: true, id }
 *   GET  /api/event   Authorization: Bearer <EVENT_TOKEN>  ?days=3  -> { events: [...] }  newest first
 *
 * `source` names the app or job (feeling, runway, plan-regreso, arsenal-watch, pc, ...), lower case.
 * `text` is the line a person reads ("Nick checked in"). `kind` is a short word for grouping
 * (checkin, cheer, task, spend, drop, job). `who` is a first name. `at` is when it happened;
 * when it is missing or in the future, now is used.
 *
 * KV: event:<ms, 14 digits>:<id> { id, source, kind, who, text, at }, 30 days.
 * Secret: EVENT_TOKEN (shared with every sender; one token, it only lets you post a line).
 *
 * A body with a `type` is a typed event for the hub's rules (src/hub.js), authorised by its
 * source's own HUB_SECRET_<SOURCE>, not by EVENT_TOKEN. */

import { safeEqual, bearer } from './todo.js';
import { handleHubEvent } from './hub.js';

const PREFIX = 'event:';
const DAY = 86400000;
export const KEEP_DAYS = 30;
const SOURCE = /^[a-z0-9-]{2,24}$/;
const WORD = /^[a-z0-9-]{1,16}$/;
const clean = (v, max) => String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/* Pure: body in, a stored record or { error }. */
export function cleanEvent(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return { error: 'send { source, text }' };
  const source = typeof body.source === 'string' ? body.source.trim().toLowerCase() : '';
  if (!SOURCE.test(source)) return { error: 'source: 2 to 24 of a-z, 0-9, -' };
  const text = typeof body.text === 'string' ? clean(body.text, 140) : '';
  if (!text) return { error: 'text required' };
  const kind = typeof body.kind === 'string' && WORD.test(body.kind.trim().toLowerCase()) ? body.kind.trim().toLowerCase() : 'note';
  const who = typeof body.who === 'string' ? clean(body.who, 24) : '';
  let at = typeof body.at === 'string' ? Date.parse(body.at) : NaN;
  if (!Number.isFinite(at) || at > now + 60000 || at < now - KEEP_DAYS * DAY) at = now;
  return { source, kind, who, text, at: new Date(at).toISOString() };
}

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
const keyOf = (rec, id) => PREFIX + String(Date.parse(rec.at)).padStart(14, '0') + ':' + id;

export async function putEvent(env, rec, now = Date.now()) {
  const id = newId();
  const left = KEEP_DAYS * DAY - (now - Date.parse(rec.at));
  await env.HUB_KV.put(keyOf(rec, id), JSON.stringify({ id, ...rec }), { expirationTtl: Math.max(60, Math.floor(left / 1000)) });
  return id;
}

/* The last `days` days, newest first, at most `limit`. */
export async function listEvents(env, now = Date.now(), days = 3, limit = 40) {
  const listed = await env.HUB_KV.list({ prefix: PREFIX, limit: 1000 });
  const floor = now - days * DAY;
  const names = listed.keys.map((k) => k.name).filter((k) => (Number(k.slice(PREFIX.length, PREFIX.length + 14)) || 0) >= floor).sort().reverse().slice(0, limit);
  const recs = await Promise.all(names.map((k) => env.HUB_KV.get(k, 'json')));
  return recs.filter((r) => r && typeof r.text === 'string');
}

/* Morning's block: the feed plus a per-source "last heard" so a quiet app shows as quiet. */
export async function eventsBlock(env, now = Date.now()) {
  const events = await listEvents(env, now, 3, 30);
  if (!events.length) return null;
  const sources = {};
  for (const e of events) if (!sources[e.source]) sources[e.source] = e.at;
  return { events: events.map(({ id, source, kind, who, text, at }) => ({ id, source, kind, who, text, at })), sources };
}

export async function handleEvent(request, env, rest, url, json, now = Date.now()) {
  if (rest.length) return json({ error: 'not found' }, request, 404);
  if (request.method === 'POST') {
    const text = await request.text();
    if (text.length > 6000) return json({ error: 'too large' }, request, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, request, 400); }
    if (body && typeof body === 'object' && body.type !== undefined) return handleHubEvent(request, env, body, json, now);
    if (!env.EVENT_TOKEN || !safeEqual(bearer(request), env.EVENT_TOKEN)) return json({ error: 'unauthorized' }, request, 401);
    if (text.length > 2000) return json({ error: 'too large' }, request, 413);
    const rec = cleanEvent(body, now);
    if (rec.error) return json({ error: rec.error }, request, 400);
    const id = await putEvent(env, rec, now);
    return json({ ok: true, id, at: rec.at }, request);
  }
  if (!env.EVENT_TOKEN || !safeEqual(bearer(request), env.EVENT_TOKEN)) return json({ error: 'unauthorized' }, request, 401);
  if (request.method === 'GET') {
    const days = Math.min(KEEP_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 3));
    return json({ events: await listEvents(env, now, days, 200) }, request);
  }
  return json({ error: 'method' }, request, 405);
}
