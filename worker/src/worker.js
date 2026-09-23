/* paul-hub
 *
 * One small Worker for Paul's own apps. Routes are namespaced by module
 * (/api/<module>/...), so each app has its own corner and never touches another's.
 *
 * To-do (the code in the link is the key; there are no accounts):
 *   GET  /api/todo/:code             -> { items, rev, updated }
 *   GET  /api/todo/:code?since=<rev> -> { unchanged: true, rev } when nothing moved
 *   POST /api/todo/:code/ops         <- { ops: [{ op: "upsert" | "delete", item }] }
 *                                    -> { rev, updated, items, rejected: [index, ...] }
 *   GET  /api/todo/open              Authorization: Bearer <TODO_READ_TOKEN>
 *                                    -> { items: [{ text, section }], updated }  open tasks only
 *
 * Morning Screen (src/morning.js; the to-do's code, read only):
 *   GET  /api/morning/:code          -> { now, todos, calendar, fixed, weather, arsenal, bins }
 *                                    every block loads on its own; a failed one is { error }
 *   POST /api/morning/calendar       Authorization: Bearer <CALENDAR_PUSH_TOKEN>
 *                                    <- { sent, events: [{ title, start, end, allDay, location }] }
 *                                    -> { ok: true, count }   (Odysseus, every 15 minutes)
 *
 * Kitchen (src/kitchen.js; its own code, KITCHEN_CODE, never the to-do's):
 *   GET  /api/kitchen/:code             -> { items, rev, updated }
 *   GET  /api/kitchen/:code?since=<rev> -> { unchanged: true, rev } when nothing moved
 *   POST /api/kitchen/:code/ops         <- { ops: [{ op: "upsert" | "delete", type, item }] }
 *                                       -> { rev, updated, items, rejected: [index, ...] }
 *
 * Admin (Authorization: Bearer <ADMIN_TOKEN>):
 *   GET  /api/admin/todo/export         -> the whole list, tombstones included
 *   POST /api/admin/kitchen/recipes     <- { recipes: [recipe, ...] }  (no id: a new recipe)
 *                                       -> { ok: true, ids, rev }  all or nothing; errors name the recipe
 *   GET  /api/admin/kitchen/export      -> every kitchen record, tombstones included
 *
 * The list itself lives in a Durable Object (src/list.js), one per code, so writes
 * are serialised. Only the one list code the Worker knows as TODO_CODE is served.
 * Any other code gets a 404, so nobody can use this as free storage. The kitchen works
 * the same way with its own Durable Object (src/kitchen-store.js) and KITCHEN_CODE.
 * HUB_KV (KV) holds the Morning Screen's calendar push and its weather, Arsenal and bin cache.
 */

import { CODE, cleanBatch, safeEqual, bearer } from './todo.js';
import { handleMorning } from './morning.js';
import { cleanBatch as cleanKitchenBatch, cleanRecipe, ID as KITCHEN_ID } from './kitchen.js';
import { kitchen } from './kitchen-store.js';

export { TodoList } from './list.js';
export { KitchenStore } from './kitchen-store.js';

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const PAGES = 'https://mellowt1.github.io';
const MAX_BODY = 200000;

export function cors(request) {
  const o = request.headers.get('Origin') || '';
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
  if (o === PAGES || LOCAL.test(o)) h['Access-Control-Allow-Origin'] = o;
  return h;
}

const json = (data, request, status = 200) => Response.json(data, { status, headers: cors(request) });

// Talk to the list's Durable Object. The host name is never resolved; it only has to parse.
async function list(env, code, path, body) {
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + code));
  const init = body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
  const r = await stub.fetch('https://list' + path, init);
  return { status: r.status, data: await r.json() };
}

async function readBody(request, max) {
  const text = await request.text();
  if (text.length > max) return { status: 413, error: 'too large' };
  try {
    return { body: JSON.parse(text) };
  } catch (e) {
    return { status: 400, error: 'bad json' };
  }
}

async function todoOps(request, env, code) {
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, request, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return json({ error: 'bad json' }, request, 400);
  }
  const batch = cleanBatch(body, Date.now());
  if (batch.error) return json({ error: batch.error }, request, 400);
  const out = batch.ops.length
    ? await list(env, code, '/apply', { ops: batch.ops })
    : await list(env, code, '/read');
  if (out.data.error) return json(out.data, request, out.status);
  return json({ rev: out.data.rev, updated: out.data.updated, items: out.data.items, rejected: batch.rejected }, request);
}

async function handleTodo(request, env, rest, url) {
  if (rest.length === 1 && rest[0] === 'open') {
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    // The read token is checked here and nowhere else, so it opens this route only.
    if (!env.TODO_READ_TOKEN || !safeEqual(bearer(request), env.TODO_READ_TOKEN)) {
      return json({ error: 'token required' }, request, 401);
    }
    if (!env.TODO_CODE) return json({ error: 'not configured' }, request, 503);
    return json((await list(env, env.TODO_CODE, '/open')).data, request);
  }
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);

  if (rest.length === 1) {
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    const since = url.searchParams.get('since');
    const q = since !== null && /^\d{1,12}$/.test(since) ? '?since=' + since : '';
    return json((await list(env, code, '/read' + q)).data, request);
  }
  if (rest.length === 2 && rest[1] === 'ops') {
    if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
    return todoOps(request, env, code);
  }
  return json({ error: 'not found' }, request, 404);
}

async function handleKitchen(request, env, rest, url) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.KITCHEN_CODE || !safeEqual(code, env.KITCHEN_CODE)) return json({ error: 'unknown code' }, request, 404);

  if (rest.length === 1) {
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    const since = url.searchParams.get('since');
    const q = since !== null && /^\d{1,12}$/.test(since) ? '?since=' + since : '';
    return json((await kitchen(env, code, '/read' + q)).data, request);
  }
  if (rest.length === 2 && rest[1] === 'ops') {
    if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
    const got = await readBody(request, MAX_BODY);
    if (got.error) return json({ error: got.error }, request, got.status);
    const batch = cleanKitchenBatch(got.body, Date.now());
    if (batch.error) return json({ error: batch.error }, request, 400);
    const out = batch.ops.length ? await kitchen(env, code, '/apply', { ops: batch.ops }) : await kitchen(env, code, '/read');
    if (out.data.error) return json(out.data, request, out.status);
    return json({ rev: out.data.rev, updated: out.data.updated, items: out.data.items, rejected: batch.rejected }, request);
  }
  return json({ error: 'not found' }, request, 404);
}

export const MAX_ADMIN_RECIPES = 25;
const MAX_ADMIN_BODY = 1024 * 1024;

function newId() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (const x of crypto.getRandomValues(new Uint8Array(16))) s += a[x % 36];
  return s;
}

/* Claude Code adds cleaned up recipes here. All or nothing: one bad recipe refuses the
 * call, and the answer says which one and why, so it can be fixed and sent again.
 * A recipe with the id of one already stored replaces it. */
async function adminRecipes(request, env) {
  if (!env.KITCHEN_CODE) return json({ error: 'not configured' }, request, 503);
  const got = await readBody(request, MAX_ADMIN_BODY);
  if (got.error) return json({ error: got.error }, request, got.status);
  const b = got.body;
  const list = Array.isArray(b) ? b
    : b && Array.isArray(b.recipes) ? b.recipes
    : b && typeof b === 'object' && b.title !== undefined ? [b] : null;
  if (!list || !list.length) return json({ error: 'send { "recipes": [ ... ] }' }, request, 400);
  if (list.length > MAX_ADMIN_RECIPES) return json({ error: `at most ${MAX_ADMIN_RECIPES} recipes per call` }, request, 400);
  const now = Date.now();
  const errors = [];
  const ops = [];
  list.forEach((r, index) => {
    const id = r && typeof r === 'object' && r.id !== undefined ? r.id : newId();
    if (typeof id !== 'string' || !KITCHEN_ID.test(id)) {
      errors.push({ index, error: 'id must be 8 to 32 lowercase letters and digits, or left out' });
      return;
    }
    const c = cleanRecipe(r);
    if (c.error) {
      errors.push({ index, title: r && typeof r.title === 'string' ? r.title.slice(0, 80) : undefined, error: c.error });
      return;
    }
    ops.push({ op: 'upsert', type: 'recipe', item: { type: 'recipe', id, ...c.value, updatedAt: now } });
  });
  if (errors.length) return json({ error: 'invalid recipes', errors }, request, 400);
  const out = await kitchen(env, env.KITCHEN_CODE, '/apply', { ops });
  if (out.data.error) return json(out.data, request, out.status);
  return json({ ok: true, ids: ops.map((o) => o.item.id), rev: out.data.rev }, request);
}

async function handleAdmin(request, env, rest) {
  if (!env.ADMIN_TOKEN || !safeEqual(bearer(request), env.ADMIN_TOKEN)) {
    return json({ error: 'admin token required' }, request, 401);
  }
  if (request.method === 'GET' && rest.join('/') === 'todo/export') {
    if (!env.TODO_CODE) return json({ error: 'not configured' }, request, 503);
    return json((await list(env, env.TODO_CODE, '/export')).data, request);
  }
  if (rest.join('/') === 'kitchen/recipes') {
    if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
    return adminRecipes(request, env);
  }
  if (request.method === 'GET' && rest.join('/') === 'kitchen/export') {
    if (!env.KITCHEN_CODE) return json({ error: 'not configured' }, request, 503);
    return json((await kitchen(env, env.KITCHEN_CODE, '/export')).data, request);
  }
  return json({ error: 'not found' }, request, 404);
}

// Add a module here. Each handler gets the path segments after /api/<module>/.
const MODULES = {
  todo: handleTodo,
  morning: (request, env, rest) => handleMorning(request, env, rest, json),
  kitchen: handleKitchen,
  admin: handleAdmin,
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || !MODULES[parts[1]]) return json({ error: 'not found' }, request, 404);
    try {
      return await MODULES[parts[1]](request, env, parts.slice(2), url);
    } catch (e) {
      return json({ error: 'server' }, request, 500);
    }
  },
};
