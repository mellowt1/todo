/* Spotify, for real (Paul, 2026-10-24): a link only opens a playlist, so the hub now starts it.
 * Play in To-do, Morning or Day still opens Spotify (the spotify: link) and, at the same tap, asks
 * here; the hub plays the playlist on the Spotify of the device Paul tapped on (an iPhone on the
 * phone, the Spotify app on the PC), waiting a few seconds for it to show up when Spotify was closed.
 *
 *   GET  /api/spotify/:code                -> { configured, connected }
 *   GET  /api/spotify/:code/login          -> 302 to Spotify's consent page (once)
 *   GET  /api/spotify/callback             <- Spotify (?code&state) -> a small page; the login kept, encrypted
 *   GET  /api/spotify/:code/playlists      -> { playlists: [{ pid, title, count, url, uri }] }   his own and followed
 *   POST /api/spotify/:code/play           <- { uri, kind: "phone" | "computer" }  -> { ok, device? } | { ok: false, why, waiting? }
 *   POST /api/spotify/:code/disconnect     -> { connected: false }
 *   POST /api/hub/spotify/day/play         the same for Day, Bearer HUB_SECRET_DAY, always "phone"
 *
 * Scopes, and only these (Paul, 2026-10-24): playlist-read-private (his playlists, read only),
 * user-read-playback-state (which devices are there), user-modify-playback-state (play on one).
 * Never a playlist written, nothing public, nothing followed.
 *
 * Secrets: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET (his developer app) and SPOTIFY_KEY (32 random
 * bytes, base64). Spotify can hand out a new refresh token at any time and a Worker cannot write its
 * own secrets, so the login lives in KV (spotify:login), sealed with AES-GCM under SPOTIFY_KEY
 * (Paul's OK, 2026-10-24). Nothing from Spotify is logged; tokens never leave the hub. */

import { CODE, safeEqual, bearer } from './todo.js';

export const SCOPES = 'playlist-read-private user-read-playback-state user-modify-playback-state';
export const REDIRECT = 'https://paul-hub.paul-o-a04.workers.dev/api/spotify/callback';
const LOGIN = 'spotify:login';
const STATE = 'spotify:state:';
const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const URI = /^spotify:playlist:[A-Za-z0-9]{22}$/;
export const KINDS = { phone: ['Smartphone', 'Tablet'], computer: ['Computer'] };
export const WAIT = { tries: 14, every: 1500 }; // about 20 seconds for Spotify to come up
const BACK = 'https://mellowt1.github.io/todo/';

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n = 16) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const configured = (env) => !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET && env.SPOTIFY_KEY && env.HUB_KV);

/* ---------- The sealed login ---------- */

async function aesKey(env) {
  return crypto.subtle.importKey('raw', unb64(env.SPOTIFY_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(JSON.stringify(obj))));
  return b64(iv) + '.' + b64(ct);
}
export async function unseal(env, s) {
  try {
    const [iv, ct] = String(s).split('.');
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct))));
  } catch (e) {
    return null;
  }
}
const readLogin = async (env) => { const s = await env.HUB_KV.get(LOGIN); return s ? unseal(env, s) : null; };
const writeLogin = async (env, login) => env.HUB_KV.put(LOGIN, await seal(env, login));

async function tokenCall(env, params) {
  const r = await fetch(ACCOUNTS + '/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.SPOTIFY_CLIENT_ID + ':' + env.SPOTIFY_CLIENT_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && !!d.access_token, status: r.status, d };
}

/* A live access token, refreshed when it is within a minute of running out. A refused refresh
 * (the app's access was taken back in Spotify) forgets the login. */
export async function accessToken(env, now = Date.now()) {
  if (!configured(env)) return null;
  const login = await readLogin(env);
  if (!login || !login.refresh) return null;
  if (login.access && login.expiresAt - 60000 > now) return login.access;
  const got = await tokenCall(env, { grant_type: 'refresh_token', refresh_token: login.refresh });
  if (!got.ok) {
    if (got.status === 400 && got.d.error === 'invalid_grant') await env.HUB_KV.delete(LOGIN);
    return null;
  }
  await writeLogin(env, { refresh: got.d.refresh_token || login.refresh, access: got.d.access_token, expiresAt: now + (got.d.expires_in || 3600) * 1000 });
  return got.d.access_token;
}

/* ---------- Devices and playing ---------- */

/* Pure: Spotify's device list -> the one to play on for this kind: an active one first. */
export function pickDevice(devices, kind) {
  const types = KINDS[kind] || [];
  const fit = (devices || []).filter((d) => d && d.id && !d.is_restricted && types.includes(d.type));
  return fit.find((d) => d.is_active) || fit[0] || null;
}

async function devices(token) {
  const r = await fetch(API + '/me/player/devices', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  return ((await r.json().catch(() => ({}))).devices) || [];
}

async function startOn(token, device, uri) {
  const r = await fetch(API + '/me/player/play?device_id=' + encodeURIComponent(device.id), {
    method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ context_uri: uri }), signal: AbortSignal.timeout(8000),
  });
  return r.status;
}

/* A Spotify that is open but not the one playing (the PC's app while the phone played last) can
 * answer Play with 404 until playback has been moved to it: move it, then play again. */
async function moveTo(token, device) {
  const r = await fetch(API + '/me/player', {
    method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [device.id], play: false }), signal: AbortSignal.timeout(8000),
  });
  return r.status;
}

const PLAYED = [200, 202, 204];
export const MOVE = { ms: 800 }; // how long Spotify gets to take the move

async function tryOnce(token, kind, uri) {
  const list = await devices(token);
  const dev = list && pickDevice(list, kind);
  // Only kinds, codes and whether one is active: never a name (wrangler tail shows these lines).
  const seen = (list || []).map((d) => d.type + (d.is_active ? '*' : '')).join(',') || '-';
  if (!dev) { console.log('spotify play', kind, list ? 'no device' : 'devices failed', seen); return { ok: false, why: list ? 'no device' : 'spotify' }; }
  let status = await startOn(token, dev, uri);
  let moved = null;
  if (status === 404 || status === 502) {
    moved = await moveTo(token, dev);
    await sleep(MOVE.ms);
    status = await startOn(token, dev, uri);
  }
  console.log('spotify play', kind, status, moved ? 'moved ' + moved : '', seen);
  if (PLAYED.includes(status)) return { ok: true, device: dev.name };
  return { ok: false, why: status === 403 ? 'premium' : status === 429 ? 'busy' : 'spotify' };
}

/* Plays now when Spotify is there; otherwise keeps trying in the background while the app the tap
 * opened comes up (`wait` = ctx.waitUntil, absent in tests that wait themselves). */
export async function play(env, uri, kind, wait, now = Date.now()) {
  const token = await accessToken(env, now);
  if (!token) return { ok: false, why: configured(env) ? 'not connected' : 'not set up' };
  const first = await tryOnce(token, kind, uri);
  if (first.ok || first.why !== 'no device') return first;
  const later = (async () => {
    for (let i = 0; i < WAIT.tries; i++) {
      await sleep(WAIT.every);
      const r = await tryOnce(token, kind, uri);
      if (r.ok || r.why !== 'no device') return r;
    }
    return { ok: false, why: 'no device' };
  })();
  if (wait) wait(later);
  return { ok: false, why: 'no device', waiting: true, later };
}

/* His playlists (own and followed), for the sheet: up to 100. */
export async function playlists(env, now = Date.now()) {
  const token = await accessToken(env, now);
  if (!token) return null;
  const out = [];
  let next = API + '/me/playlists?limit=50';
  for (let page = 0; next && page < 2; page++) {
    const r = await fetch(next, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    for (const p of d.items || []) {
      if (!p || !/^[A-Za-z0-9]{22}$/.test(p.id || '')) continue;
      const count = (p.items && p.items.total) ?? (p.tracks && p.tracks.total) ?? null; // "tracks" became "items" in 2026
      out.push({ pid: p.id, title: String(p.name || '').slice(0, 60) || 'Untitled', count, url: 'https://open.spotify.com/playlist/' + p.id, uri: 'spotify:playlist:' + p.id });
    }
    next = d.next && d.next.startsWith(API) ? d.next : null;
  }
  return out.slice(0, 100);
}

/* ---------- Connecting ---------- */

export async function loginUrl(env) {
  const state = rand();
  await env.HUB_KV.put(STATE + state, '1', { expirationTtl: 600 });
  const q = new URLSearchParams({ client_id: env.SPOTIFY_CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES, state, show_dialog: 'true' });
  return ACCOUNTS + '/authorize?' + q.toString();
}

const page = (title, line, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;font:17px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#fff;color:#1c1c1e;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:340px;padding:24px}h1{font-size:24px;margin:0 0 8px}a{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:12px;background:#3F7D5C;color:#fff;text-decoration:none;font-weight:600}@media (prefers-color-scheme:dark){body{background:#000;color:#f2f2f7}a{background:#7DBF98;color:#000}}</style></head>
<body><main><h1>${title}</h1><p>${line}</p><a href="${BACK}">Back to To-do</a></main></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function callback(env, url, now = Date.now()) {
  const state = url.searchParams.get('state') || '';
  if (!/^[a-f0-9]{32}$/.test(state) || !(await env.HUB_KV.get(STATE + state))) return page('That link has run out', 'Start again from To-do: Edit › Connect Spotify.', 400);
  await env.HUB_KV.delete(STATE + state);
  if (url.searchParams.get('error')) return page('Not connected', 'Spotify was not given access. Nothing was kept.', 400);
  const code = url.searchParams.get('code') || '';
  if (!code || code.length > 1000) return page('Not connected', 'Spotify sent no answer. Try again from To-do.', 400);
  const got = await tokenCall(env, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
  if (!got.ok || !got.d.refresh_token) return page('Not connected', 'Spotify did not finish the login. Try again from To-do.', 502);
  await writeLogin(env, { refresh: got.d.refresh_token, access: got.d.access_token, expiresAt: now + (got.d.expires_in || 3600) * 1000 });
  return page('Spotify is connected', 'Play now starts the music on the phone or PC you tap it on. Close this page to go back to To-do.');
}

/* ---------- Routes ---------- */

async function readJson(request, max = 1000) {
  const raw = await request.text();
  if (raw.length > max) return { status: 413, error: 'too large' };
  try { return { body: raw ? JSON.parse(raw) : {} }; } catch (e) { return { status: 400, error: 'bad json' }; }
}

async function playRoute(request, env, json, wait, kindFixed) {
  const got = await readJson(request);
  if (got.error) return json({ error: got.error }, request, got.status);
  const b = got.body && typeof got.body === 'object' ? got.body : {};
  const kind = kindFixed || (KINDS[b.kind] ? b.kind : null);
  if (!kind || typeof b.uri !== 'string' || !URI.test(b.uri)) return json({ error: 'uri: spotify:playlist:..., kind: phone or computer' }, request, 400);
  const { later, ...out } = await play(env, b.uri, kind, wait);
  return json(out, request);
}

export async function handleSpotify(request, env, rest, url, json, ctx) {
  if (rest[0] === 'callback' && rest.length === 1 && request.method === 'GET') {
    if (!configured(env)) return page('Not set up', 'The hub has no Spotify app yet.', 503);
    return callback(env, url);
  }
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  const sub = rest.slice(1);
  if (sub.length === 0 && request.method === 'GET') {
    return json({ configured: configured(env), connected: configured(env) && !!(await env.HUB_KV.get(LOGIN)) }, request);
  }
  if (!configured(env)) return json({ error: 'not set up' }, request, 503);
  const wait = ctx && ctx.waitUntil ? (p) => ctx.waitUntil(p) : null;
  if (sub.length === 1 && request.method === 'GET') {
    if (sub[0] === 'login') return Response.redirect(await loginUrl(env), 302);
    if (sub[0] === 'playlists') {
      const list = await playlists(env);
      return list ? json({ playlists: list }, request) : json({ error: 'not connected' }, request, 409);
    }
  }
  if (sub.length === 1 && request.method === 'POST') {
    if (sub[0] === 'play') return playRoute(request, env, json, wait, null);
    if (sub[0] === 'disconnect') { await env.HUB_KV.delete(LOGIN); return json({ connected: false }, request); }
  }
  return json({ error: 'not found' }, request, 404);
}

/* /api/hub/spotify/day/play: Day on the Mac, through the Odysseus backend. Day is the phone. */
export async function handleSpotifyDay(request, env, sub, json, ctx) {
  if (!env.HUB_SECRET_DAY || !safeEqual(bearer(request), env.HUB_SECRET_DAY)) return json({ error: 'unauthorized' }, request, 401);
  if (sub.length !== 1 || sub[0] !== 'play' || request.method !== 'POST') return json({ error: 'not found' }, request, 404);
  if (!configured(env)) return json({ ok: false, why: 'not set up' }, request);
  return playRoute(request, env, json, ctx && ctx.waitUntil ? (p) => ctx.waitUntil(p) : null, 'phone');
}
