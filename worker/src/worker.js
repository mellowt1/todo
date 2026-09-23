/* paul-hub
 *
 * One small Worker for Paul's own apps. Routes are namespaced by module, so the
 * Morning Screen can add /api/morning later without touching the to-do.
 *
 * To-do (the code in the link is the key; there are no accounts):
 *   GET  /api/todo/:code             -> { items, rev, updated }
 *   GET  /api/todo/:code?since=<rev> -> { unchanged: true, rev } when nothing moved
 *   POST /api/todo/:code/ops         <- { ops: [{ op: "upsert" | "delete", item }] }
 *                                    -> { rev, updated, items }
 *   GET  /api/todo/open              Authorization: Bearer <TODO_READ_TOKEN>
 *                                    -> { items: [{ text, section }], updated }  open tasks only
 *
 * Admin (backup):
 *   GET  /api/admin/todo/export      Authorization: Bearer <ADMIN_TOKEN>
 *                                    -> the whole stored document, tombstones included
 *
 * Only the one list code the Worker knows as TODO_CODE is served. Any other code
 * gets a 404, so nobody can use this KV as free storage.
 */

import {
  CODE, MAX_ITEMS, emptyDoc, cleanBatch, applyOps, pruneTombs, openView, itemList, safeEqual, bearer,
} from './todo.js';

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

async function readDoc(env, code) {
  const raw = await env.HUB_KV.get(`todo:${code}`);
  if (!raw) return emptyDoc();
  try {
    const d = JSON.parse(raw);
    return { items: d.items || {}, tombs: d.tombs || {}, rev: d.rev || 0, updated: d.updated || null };
  } catch (e) {
    return emptyDoc();
  }
}

async function todoList(request, env, code, url) {
  const doc = await readDoc(env, code);
  const since = url.searchParams.get('since');
  if (since !== null && /^\d{1,12}$/.test(since) && Number(since) === doc.rev) {
    return json({ unchanged: true, rev: doc.rev }, request);
  }
  return json({ items: itemList(doc), rev: doc.rev, updated: doc.updated }, request);
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
  const now = Date.now();
  const batch = cleanBatch(body, now);
  if (batch.error) return json({ error: batch.error }, request, 400);

  const doc = await readDoc(env, code);
  const { changed } = applyOps(doc, batch.ops);
  if (changed) {
    if (Object.keys(doc.items).length > MAX_ITEMS) return json({ error: 'list full' }, request, 413);
    pruneTombs(doc, now);
    doc.rev += 1;
    doc.updated = new Date(now).toISOString();
    await env.HUB_KV.put(`todo:${code}`, JSON.stringify(doc));
  }
  // Nothing new means no KV write at all, which keeps a resent batch free.
  return json({ rev: doc.rev, updated: doc.updated, items: itemList(doc) }, request);
}

async function todoOpen(request, env) {
  // The read token is checked here and nowhere else, so it opens this route only.
  if (!env.TODO_READ_TOKEN || !safeEqual(bearer(request), env.TODO_READ_TOKEN)) {
    return json({ error: 'token required' }, request, 401);
  }
  if (!env.TODO_CODE) return json({ error: 'not configured' }, request, 503);
  const doc = await readDoc(env, env.TODO_CODE);
  return json({ items: openView(doc), updated: doc.updated }, request);
}

async function handleTodo(request, env, rest, url) {
  if (rest.length === 1 && rest[0] === 'open') {
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    return todoOpen(request, env);
  }
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);

  if (rest.length === 1) {
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    return todoList(request, env, code, url);
  }
  if (rest.length === 2 && rest[1] === 'ops') {
    if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
    return todoOps(request, env, code);
  }
  return json({ error: 'not found' }, request, 404);
}

async function handleAdmin(request, env, rest) {
  if (!env.ADMIN_TOKEN || !safeEqual(bearer(request), env.ADMIN_TOKEN)) {
    return json({ error: 'admin token required' }, request, 401);
  }
  if (request.method === 'GET' && rest.join('/') === 'todo/export') {
    if (!env.TODO_CODE) return json({ error: 'not configured' }, request, 503);
    return json(await readDoc(env, env.TODO_CODE), request);
  }
  return json({ error: 'not found' }, request, 404);
}

// Add a module here. Each handler gets the path segments after /api/<module>/.
const MODULES = {
  todo: handleTodo,
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
