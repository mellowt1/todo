/* The Energy soundtrack (Paul, 2026-10-24): Spotify playlists for each energy level. When a level is
 * set, To-do, Morning and Day show Play, which opens the level's first playlist in the Spotify app;
 * when a task starts (the Dread meter's dread.started, the hub's task.started), the running pill asks
 * "Music for this?". Nothing plays by itself and nothing in Spotify changes: links only.
 *
 *   GET  /api/soundtrack/:code                -> { lists, max }
 *   POST /api/soundtrack/:code/peek           <- { url }                  -> { pid, title, url, uri }   adds nothing
 *   POST /api/soundtrack/:code/add            <- { level, url, title? }   -> { lists, added }
 *   POST /api/soundtrack/:code/remove         <- { level, id }            -> { lists }
 *   POST /api/soundtrack/:code/played         <- { level, startedAt?, from: "dial" | "offer", source }  -> { ok }
 *   POST /api/soundtrack/:code/notnow         <- { startedAt, source }    -> { ok }
 *   POST /api/hub/soundtrack/day/(played | notnow)   the same for Day, Bearer HUB_SECRET_DAY, source "day"
 *
 *   lists = { wired: [entry], normal: [...], drained: [...] }, entry = { id, title, url, uri }
 *
 * The lists live in KV (soundtrack:lists), the only copy. The answers that already carry the level
 * carry the music too, so no app polls for it: the energy routes add `play` (src/energy.js) and the
 * Dread meter's add `offer` (src/dread.js). Play and Not now are hub events in D1 `events`, kept out
 * of Morning's feed, with no titles or links: soundtrack.played { level, startedAt, from } and
 * soundtrack.declined { startedAt }. The offer goes once Not now or Play was tapped for that timer,
 * or once Play was tapped at all since the level was set (the music is on already).
 *
 * Paul's answers, 2026-10-24: up to 3 playlists a level, Play opens the first; Play shows the whole
 * time a level is set; no level, no Play; set up in To-do only; on the PC the Spotify app opens. */

import { CODE, ENERGY, safeEqual, bearer } from './todo.js';
import { acceptEvent } from './hub.js';

export const MAX_PER_LEVEL = 3;
export const TITLE_MAX = 60;
const KEY = 'soundtrack:lists';
const PID = /^[A-Za-z0-9]{22}$/;
const ENTRY_ID = /^[a-z0-9]{10}$/;
const CODE_SOURCES = ['todo', 'morning'];
const NOT_PLAYLIST = { track: 'a song', album: 'an album', artist: 'an artist', episode: 'a podcast episode', show: 'a podcast', user: 'a profile' };

const rand = (n = 6) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b % 36).toString(36)).join('');
const empty = () => ({ wired: [], normal: [], drained: [] });

/* ---------- Links ---------- */

/* Pure: a pasted Spotify link -> { pid } for a playlist, { short } for a spotify.link that has to be
 * followed first, or { error } in plain words. */
export function readLink(raw) {
  const s = String(raw || '').trim();
  const uri = s.match(/^spotify:(playlist|track|album|artist|episode|show|user):([A-Za-z0-9]+)/);
  if (uri) return uri[1] === 'playlist' && PID.test(uri[2]) ? { pid: uri[2] } : { error: 'That is ' + (NOT_PLAYLIST[uri[1]] || 'not a playlist') + ', not a playlist.' };
  let u;
  try { u = new URL(s); } catch (e) { return { error: 'Paste a Spotify playlist link (Share › Copy link).' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Paste a Spotify playlist link (Share › Copy link).' };
  if (u.hostname === 'spotify.link') return { short: 'https://spotify.link' + u.pathname };
  if (u.hostname !== 'open.spotify.com' && u.hostname !== 'play.spotify.com') return { error: 'Only a Spotify playlist link counts.' };
  const parts = u.pathname.split('/').filter(Boolean);
  if (/^intl-[a-z]{2}(-[a-z]{2})?$/i.test(parts[0] || '')) parts.shift();
  if (parts[0] === 'user' && parts[2] === 'playlist') parts.splice(0, 2); // the old /user/<name>/playlist/<id>
  if (parts[0] === 'playlist' && PID.test(parts[1] || '')) return { pid: parts[1] };
  if (NOT_PLAYLIST[parts[0]]) return { error: 'That is ' + NOT_PLAYLIST[parts[0]] + ', not a playlist.' };
  return { error: 'That is not a playlist link.' };
}

export const webUrl = (pid) => 'https://open.spotify.com/playlist/' + pid;
export const appUri = (pid) => 'spotify:playlist:' + pid;

/* A spotify.link goes to open.spotify.com, by a redirect or inside the page it serves. */
async function followShort(short) {
  try {
    const r = await fetch(short, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (paul-hub soundtrack)' }, signal: AbortSignal.timeout(8000) });
    const direct = readLink(r.url);
    if (direct.pid || /^That is /.test(direct.error || '')) return direct;
    const html = (await r.text()).slice(0, 200000);
    const m = html.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{22})/);
    return m ? { pid: m[1] } : { error: 'That link is not a playlist.' };
  } catch (e) {
    return { error: 'Could not open that link. Try the open.spotify.com one.' };
  }
}

/* The playlist's name, from Spotify's public oEmbed (no login). Null when it cannot be read. */
export async function readTitle(pid) {
  try {
    const r = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(webUrl(pid)), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const t = cleanTitle((await r.json()).title);
    return t || null;
  } catch (e) {
    return null;
  }
}

export const cleanTitle = (t) => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) : '');

async function resolve(raw) {
  const got = readLink(raw);
  return got.short ? followShort(got.short) : got;
}

/* ---------- The lists ---------- */

/* Pure: whatever KV holds -> three clean lists. */
export function cleanLists(v) {
  const out = empty();
  for (const k of ENERGY) {
    for (const e of (v && Array.isArray(v[k]) ? v[k] : [])) {
      if (!e || !ENTRY_ID.test(e.id) || !PID.test(e.pid) || !cleanTitle(e.title)) continue;
      if (out[k].length < MAX_PER_LEVEL) out[k].push({ id: e.id, pid: e.pid, title: cleanTitle(e.title) });
    }
  }
  return out;
}

export async function readLists(env) {
  return cleanLists(await env.HUB_KV.get(KEY, 'json').catch(() => null));
}

/* Pure: the lists as the apps see them. */
export function listsView(lists) {
  const out = empty();
  for (const k of ENERGY) out[k] = lists[k].map((e) => ({ id: e.id, title: e.title, url: webUrl(e.pid), uri: appUri(e.pid) }));
  return out;
}

/* Pure: what Play opens for a level: its first playlist, or null. */
export function playFrom(lists, level) {
  if (!ENERGY.includes(level)) return null;
  const e = lists[level][0];
  return e ? { level, title: e.title, url: webUrl(e.pid), uri: appUri(e.pid) } : null;
}

export async function playFor(env, level) {
  if (!ENERGY.includes(level) || !env.HUB_KV) return null;
  return playFrom(await readLists(env), level);
}

export async function addPlaylist(env, level, raw, title) {
  const got = await resolve(raw);
  if (got.error) return { error: got.error, status: 400 };
  const lists = await readLists(env);
  if (lists[level].some((e) => e.pid === got.pid)) return { error: 'That one is in ' + cap(level) + ' already.', status: 409 };
  if (lists[level].length >= MAX_PER_LEVEL) return { error: cap(level) + ' has ' + MAX_PER_LEVEL + ' already. Remove one first.', status: 409 };
  const name = cleanTitle(title) || (await readTitle(got.pid));
  if (!name) return { error: 'Give it a name.', status: 400 };
  const added = { id: rand(10), pid: got.pid, title: name };
  lists[level].push(added);
  await env.HUB_KV.put(KEY, JSON.stringify(lists));
  return { lists: listsView(lists), added: { id: added.id, title: name, url: webUrl(got.pid), uri: appUri(got.pid) } };
}

export async function removePlaylist(env, level, id) {
  const lists = await readLists(env);
  const before = lists[level].length;
  lists[level] = lists[level].filter((e) => e.id !== id);
  if (lists[level].length === before) return { error: 'not there', status: 404 };
  await env.HUB_KV.put(KEY, JSON.stringify(lists));
  return { lists: listsView(lists) };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- Play, Not now, and the offer on Start ---------- */

async function emit(env, type, source, payload, now, summary) {
  await acceptEvent(env, {
    id: type.replace('.', '-') + '-' + now + '-' + rand(), source, type, summary,
    payload, caused_by: null, hops: 0, at: new Date(now).toISOString(),
  }, { feed: false });
}

/* Pure: does the offer for this timer still stand, given the Play / Not now events since the level
 * was set (or the timer started, whichever came first)? */
export function offerStands(rows, startedAt) {
  for (const r of rows) {
    if (r.type === 'soundtrack.played') return false;
    let p = {};
    try { p = JSON.parse(r.payload) || {}; } catch (e) { /* none */ }
    if (r.type === 'soundtrack.declined' && p.startedAt === startedAt) return false;
  }
  return true;
}

/* `running` from the Dread meter, `state` the level now (src/energy.js energyNow). The music is for
 * the level now: a cleared or lapsed level offers nothing. */
export async function offerFor(env, running, state) {
  if (!running || !state || !state.level || !env.HUB_KV || !env.HUB_DB) return null;
  const play = await playFor(env, state.level);
  if (!play) return null;
  const since = [running.startedAt, state.setAt].filter(Boolean).sort()[0];
  const { results } = await env.HUB_DB.prepare("SELECT type, payload FROM events WHERE type IN ('soundtrack.played', 'soundtrack.declined') AND at >= ?")
    .bind(since).all();
  return offerStands(results || [], running.startedAt) ? { ...play, startedAt: running.startedAt } : null;
}

const ISO = (v) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);

/* ---------- Routes ---------- */

async function readJson(request, max = 2000) {
  const raw = await request.text();
  if (raw.length > max) return { status: 413, error: 'too large' };
  try { return { body: raw ? JSON.parse(raw) : {} }; } catch (e) { return { status: 400, error: 'bad json' }; }
}

async function soundtrackRoute(request, env, sub, source, json, now) {
  if (!env.HUB_KV || !env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  if (sub.length === 0 && request.method === 'GET' && !source) return json({ lists: listsView(await readLists(env)), max: MAX_PER_LEVEL }, request);
  if (request.method !== 'POST' || sub.length !== 1) return json({ error: 'not found' }, request, 404);
  const got = await readJson(request);
  if (got.error) return json({ error: got.error }, request, got.status);
  const b = got.body && typeof got.body === 'object' ? got.body : {};
  const send = (out) => json(out.error ? { error: out.error } : out, request, out.status || 200);
  const level = ENERGY.includes(b.level) ? b.level : null;

  if (sub[0] === 'played' || sub[0] === 'notnow') {
    const src = source || (CODE_SOURCES.includes(b.source) ? b.source : null);
    if (!src) return json({ error: 'source: todo or morning' }, request, 400);
    const startedAt = ISO(b.startedAt);
    if (sub[0] === 'notnow') {
      if (!startedAt) return json({ error: 'startedAt: the timer\'s start' }, request, 400);
      await emit(env, 'soundtrack.declined', src, { startedAt }, now, 'Music: not now');
    } else {
      if (!level) return json({ error: 'level: wired, normal or drained' }, request, 400);
      await emit(env, 'soundtrack.played', src, { level, startedAt, from: b.from === 'offer' ? 'offer' : 'dial' }, now, 'Music played');
    }
    return json({ ok: true }, request);
  }
  if (source) return json({ error: 'not found' }, request, 404); // Day plays; the lists are set in To-do
  switch (sub[0]) {
    case 'peek': {
      const r = await resolve(b.url);
      if (r.error) return json({ error: r.error }, request, 400);
      return json({ pid: r.pid, title: await readTitle(r.pid), url: webUrl(r.pid), uri: appUri(r.pid) }, request);
    }
    case 'add':
      if (!level) return json({ error: 'level: wired, normal or drained' }, request, 400);
      if (typeof b.url !== 'string' || b.url.length > 500) return json({ error: 'url: a Spotify playlist link' }, request, 400);
      return send(await addPlaylist(env, level, b.url, b.title));
    case 'remove':
      if (!level || typeof b.id !== 'string' || !ENTRY_ID.test(b.id)) return json({ error: 'level and id' }, request, 400);
      return send(await removePlaylist(env, level, b.id));
    default:
      return json({ error: 'not found' }, request, 404);
  }
}

export async function handleSoundtrack(request, env, rest, json, now = Date.now()) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  return soundtrackRoute(request, env, rest.slice(1), null, json, now);
}

/* /api/hub/soundtrack/day/(played | notnow): Day on the Mac, through the Odysseus backend. */
export async function handleSoundtrackDay(request, env, sub, json, now = Date.now()) {
  if (!env.HUB_SECRET_DAY || !safeEqual(bearer(request), env.HUB_SECRET_DAY)) return json({ error: 'unauthorized' }, request, 401);
  return soundtrackRoute(request, env, sub, 'day', json, now);
}
