/* Make a new one (Paul, 2026-11-04: "Create Spotify playlists for my mood"): the soundtrack sheet in
 * To-do asks the hub for a new playlist for a level, with a few words of mood if he likes. Spotify
 * has no suggestions for small apps any more, so Claude picks. Since 2026-11-05 (Paul: "just 25 new
 * songs that match the vibe, but look at what I have been listening to recently") every song is new
 * to him: his listening (recent plays first, then this month's top, liked songs, the last months'
 * top) only shows Claude his taste. Claude names a few more than 15, each is found with Spotify
 * search, and anything he already plays or search cannot find is left out. The playlist is private,
 * named "Drained · rainy Sunday · 4 Nov", and takes the level's first place (Play starts it).
 *
 *   POST /api/spotify/:code/make   <- { level, words? }
 *                                  -> { title, songs, fresh (= songs, all new), url, uri, lists, dropped }
 *                                   | { error, reconnect? }  409 connect again, 429 one is being made,
 *                                     422 too few songs found, 502 Claude or Spotify
 *
 * Paul's answers, 2026-11-04: level and words both; only on a tap; Opus 5.5. 2026-11-05: all new; then "do 15 songs".
 * What he listens to goes to Claude and back and is not kept; the words go into the title. KV keeps
 * the token count (mixtape:usage:YYYY-MM). Nothing is logged but counts. */

import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { CODE, ENERGY, safeEqual } from './todo.js';
import { anthropic, bumpUsage, dayOf } from './intake.js';
import { accessToken, canMake, configured, API } from './spotify.js';
import { addMade } from './soundtrack.js';

export const MIX_MODEL = 'claude-opus-5-5';
export const SIZE = { songs: 15, ask: 20, perArtist: 2, least: 10, listening: 150, searches: 30 };
export const WORDS_MAX = 80;
const BUSY = 'spotify:making';
const TID = /^[A-Za-z0-9]{22}$/;
const LNAME = { wired: 'Wired', normal: 'Normal', drained: 'Drained' };
const MON = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

const Mix = z.object({
  songs: z.array(z.object({
    artist: z.string(),
    song: z.string(),
  })),
});

/* Frozen per deploy, cached. The level, the words and his listening go in the user message. */
export const SYSTEM = [
  'You make Spotify playlists for Paul that fit his energy and mood.',
  'He gives an energy level: Wired (lots of energy, restless), Normal, or Drained (low energy, tired). Sometimes he adds a few words about his mood; they are the vibe he wants, so let them lead the picks.',
  'Below is what he has been listening to, most recent first. Read it to understand his taste right now: the genres, the eras, the sound, the artists. The top of the list counts most.',
  `Pick ${SIZE.ask} songs that are NEW to him and match the vibe he asks for, in a way that fits his taste:`,
  '- None of the songs in his listening. Other songs by artists he plays are fine, but mostly choose artists close to his taste that he does not play yet.',
  '- Only songs that really exist, by real artists, with the artist and title exactly as they are on Spotify.',
  `- At most ${SIZE.perArtist} songs by the same artist.`,
  '- Order the songs so the energy flows from one to the next.',
  'Answer with the songs only, in playing order.',
].join('\n');

/* ---------- Pure ---------- */

export const cleanWords = (w) => (typeof w === 'string' ? w.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, WORDS_MAX) : '');

/* 'Drained · rainy Sunday · 4 Nov', in Dutch time, within the 60 the lists hold. */
export function titleFor(level, words, now) {
  const [, m, d] = dayOf(now).split('-');
  const date = Number(d) + ' ' + MON[Number(m) - 1];
  const w = words.length > 30 ? words.slice(0, 29).replace(/\s+\S*$/, '') + '…' : words;
  return [LNAME[level], w, date].filter(Boolean).join(' · ');
}

/* Spotify's answers (top tracks, liked, recent) -> one list, played most first, each song once.
 * Saved and recent items wrap the track (`track`, or `item` since 2026). */
export function listening(pages) {
  const out = [];
  const seen = new Set();
  for (const d of pages) {
    for (const it of (d && d.items) || []) {
      const t = it && (it.track || it.item || it);
      if (!t || (t.type && t.type !== 'track') || t.is_local || !TID.test(t.id || '') || !t.name) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const artist = (t.artists || []).map((a) => a && a.name).filter(Boolean).slice(0, 2).join(', ');
      out.push({ uri: 'spotify:track:' + t.id, artist: artist || 'Unknown', song: String(t.name) });
      if (out.length >= SIZE.listening) return out;
    }
  }
  return out;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/\s[-–]\s.*$/, '').replace(/[([].*?[)\]]/g, '').replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const near = (a, b) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));

/* Pure: search results -> the track that is this artist's song, or null. */
export function matchTrack(items, artist, song) {
  const wantA = norm(artist.split(/,|&| feat\.? | ft\.? /i)[0]);
  const wantS = norm(song);
  for (const t of items || []) {
    if (!t || !TID.test(t.id || '')) continue;
    if ((t.artists || []).some((a) => near(norm(a && a.name), wantA)) && near(norm(t.name), wantS)) return 'spotify:track:' + t.id;
  }
  return null;
}

const key = (artist, song) => norm(String(artist).split(/,|&| feat\.? | ft\.? /i)[0]) + '|' + norm(song);

/* Pure: Claude's picks -> [{ artist, song }] to search, in playing order: each song once, none he
 * already plays (by name), at most SIZE.perArtist by one artist, a nameless one left out. */
export function settle(songs, heard) {
  const order = [];
  const known = new Set(heard.map((h) => key(h.artist, h.song)));
  const per = new Map();
  for (const s of songs || []) {
    const artist = String((s && s.artist) || '').trim().slice(0, 100);
    const song = String((s && s.song) || '').trim().slice(0, 150);
    if (!artist || !song) continue;
    const k = key(artist, song);
    if (known.has(k)) continue;
    known.add(k);
    const a = k.split('|')[0];
    if ((per.get(a) || 0) >= SIZE.perArtist) continue;
    per.set(a, (per.get(a) || 0) + 1);
    order.push({ artist, song });
  }
  return order.slice(0, SIZE.ask);
}

/* ---------- Spotify ---------- */

async function sget(token, path) {
  try {
    const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;
  }
}

/* Most recent first: what he just played, this month's top, liked songs (newest saved first),
 * then the last six months' top. */
async function heardBy(token) {
  const pages = await Promise.all([
    sget(token, '/me/player/recently-played?limit=50'),
    sget(token, '/me/top/tracks?time_range=short_term&limit=50'),
    sget(token, '/me/tracks?limit=50'),
    sget(token, '/me/top/tracks?time_range=medium_term&limit=50'),
  ]);
  return listening(pages);
}

const search = async (token, q, artist, song) => {
  const d = await sget(token, '/search?type=track&limit=5&q=' + encodeURIComponent(q));
  return matchTrack(d && d.tracks && d.tracks.items, artist, song);
};

/* Each pick searched, five at a time, in Claude's order; a miss gets a looser second search while
 * searches are left (SIZE.searches keeps the whole make inside the Worker's 50 calls). Songs he
 * already plays (by id) and doubles are left out; stops once SIZE.songs are found. */
async function findAll(token, order, heard) {
  const known = new Set(heard.map((h) => h.uri));
  let left = SIZE.searches;
  const hits = new Array(order.length).fill(null);
  const count = () => new Set(hits.filter((u) => u && !known.has(u))).size;
  const pass = async (idx, q) => {
    for (let k = 0; k < idx.length && left > 0 && count() < SIZE.songs; k += 5) {
      const batch = idx.slice(k, k + 5).slice(0, left);
      left -= batch.length;
      await Promise.all(batch.map(async (i) => { hits[i] = await search(token, q(order[i]), order[i].artist, order[i].song); }));
    }
  };
  await pass(order.map((_, i) => i), (s) => 'track:' + s.song + ' artist:' + s.artist);
  await pass(hits.map((u, i) => (u ? -1 : i)).filter((i) => i >= 0), (s) => s.artist + ' ' + s.song);
  const seen = new Set();
  return hits.filter((u) => u && !known.has(u) && !seen.has(u) && seen.add(u)).slice(0, SIZE.songs).map((uri) => ({ uri }));
}

async function create(token, title, level, words, uris) {
  const r = await fetch(API + '/me/playlists', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: title, public: false, description: 'Made by paul-hub for ' + LNAME[level] + (words ? ': ' + words : '') + '.' }),
    signal: AbortSignal.timeout(10000),
  });
  const d = r.ok ? await r.json().catch(() => null) : null;
  if (!d || !TID.test(d.id || '')) return { status: r.status };
  const add = await fetch(API + '/playlists/' + d.id + '/items', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris }), signal: AbortSignal.timeout(10000),
  });
  return { pid: d.id, status: add.status, ok: add.ok };
}

/* ---------- Claude ---------- */

export async function pickSongs(env, { level, words, heard }) {
  const lines = heard.map((h) => h.artist + ' – ' + h.song).join('\n');
  const res = await anthropic(env).messages.parse({
    model: MIX_MODEL,
    max_tokens: 4000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Energy: ${LNAME[level]}\n${words ? 'His words: ' + words + '\n' : ''}\nWhat he has been listening to, most recent first (artist – song):\n${lines}` }],
    output_config: { effort: 'medium', format: zodOutputFormat(Mix) },
  });
  const usage = {
    input: res.usage?.input_tokens ?? 0,
    output: res.usage?.output_tokens ?? 0,
    cacheRead: res.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: res.usage?.cache_creation_input_tokens ?? 0,
  };
  if (res.stop_reason === 'refusal' || !res.parsed_output) return { usage };
  return { songs: res.parsed_output.songs, usage };
}

let picker = pickSongs;
export function _setPicker(fn) { picker = fn || pickSongs; }

/* ---------- Making one ---------- */

export async function makeMix(env, level, words, now = Date.now()) {
  const token = await accessToken(env, now);
  if (!token) return { error: 'Connect Spotify first.', reconnect: true, status: 409 };
  if (!(await canMake(env))) return { error: 'Connect Spotify again so the hub can make playlists.', reconnect: true, status: 409 };
  const heard = await heardBy(token);
  if (heard.length < 10) return { error: 'Spotify did not show enough of what you play. Try again later.', status: 502 };
  let got;
  try {
    got = await picker(env, { level, words, heard });
  } catch (e) {
    console.log('mixtape claude failed', e && e.status);
    return { error: 'Claude did not answer. Try again.', status: 502 };
  }
  if (got.usage) await bumpUsage(env, dayOf(now).slice(0, 7), got.usage, 'mixtape');
  if (!got.songs) return { error: 'Claude did not answer. Try again.', status: 502 };
  const songs = await findAll(token, settle(got.songs, heard), heard);
  const fresh = songs.length; // every one is new to him
  console.log('mixtape', level, 'asked', got.songs.length, 'kept', songs.length);
  if (songs.length < SIZE.least) return { error: 'Only ' + songs.length + ' songs were found on Spotify. Try again.', status: 422 };
  const title = titleFor(level, words, now);
  const made = await create(token, title, level, words, songs.map((s) => s.uri));
  if (!made.pid) return { error: made.status === 403 ? 'Spotify said no. Connect again from this sheet.' : 'Spotify did not make it. Try again.', reconnect: made.status === 403, status: 502 };
  if (!made.ok) return { error: 'Spotify made it but did not take the songs. Try again.', status: 502 };
  const out = await addMade(env, level, made.pid, title);
  return { title, songs: songs.length, fresh, url: out.added.url, uri: out.added.uri, lists: out.lists, dropped: out.dropped };
}

export async function handleMake(request, env, rest, json, ctx, now = Date.now()) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (request.method !== 'POST' || rest.length !== 2) return json({ error: 'not found' }, request, 404);
  if (!configured(env) || !env.ANTHROPIC_API_KEY) return json({ error: 'not set up' }, request, 503);
  const raw = await request.text();
  if (raw.length > 1000) return json({ error: 'too large' }, request, 413);
  let b;
  try { b = raw ? JSON.parse(raw) : {}; } catch (e) { return json({ error: 'bad json' }, request, 400); }
  const level = b && ENERGY.includes(b.level) ? b.level : null;
  if (!level) return json({ error: 'level: wired, normal or drained' }, request, 400);
  if (await env.HUB_KV.get(BUSY)) return json({ error: 'One is being made. Give it half a minute.' }, request, 429);
  await env.HUB_KV.put(BUSY, '1', { expirationTtl: 120 });
  // Finishes even when the phone locks halfway: the new playlist is then in the lists on the next look.
  const work = makeMix(env, level, cleanWords(b.words), now).finally(() => env.HUB_KV.delete(BUSY));
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  const out = await work;
  if (out.error) return json({ error: out.error, ...(out.reconnect ? { reconnect: true } : {}) }, request, out.status);
  return json(out, request);
}
