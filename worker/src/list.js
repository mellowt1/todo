/* One to-do list, kept in a SQLite-backed Durable Object.
 *
 * Why a Durable Object and not a KV key: a Durable Object handles one request at a
 * time for its list and reads its own writes at once, so two devices posting at the
 * same moment can never overwrite each other's batch. KV is eventually consistent
 * and has no compare-and-set, so a read-modify-write on one key could lose a batch.
 * SQLite-backed Durable Objects are on the Workers Free plan.
 *
 * Storage, one row per task (the storage API on the SQLite backend):
 *   i:<id>  the task
 *   t:<id>  deletedAt, the tombstone of a deleted task
 *   meta    { rev, updated, count, pruned }
 *
 * The Worker validates everything first; this class only ever sees clean ops.
 */

import { applyOps, openView, TOMB_DAYS, MAX_ITEMS } from './todo.js';

const DAY = 24 * 3600 * 1000;
const CHUNK = 128; // the storage API takes at most 128 keys per call

function chunks(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
}

export class ListStore {
  constructor(storage) {
    this.s = storage;
  }

  async meta() {
    return (await this.s.get('meta')) || { rev: 0, updated: null, count: 0, pruned: 0 };
  }

  async items() {
    return Array.from((await this.s.list({ prefix: 'i:' })).values());
  }

  async read(since) {
    const m = await this.meta();
    if (since !== null && since === m.rev) return { unchanged: true, rev: m.rev };
    return { items: await this.items(), rev: m.rev, updated: m.updated };
  }

  /* Apply clean ops. Everything is written in one go with no await in between,
   * which the storage API commits atomically. */
  async apply(ops, now = Date.now()) {
    const m = await this.meta();
    const ids = [...new Set(ops.map((o) => o.item.id))];
    const doc = { items: {}, tombs: {} };
    for (const part of chunks(ids.flatMap((id) => ['i:' + id, 't:' + id]))) {
      for (const [k, v] of await this.s.get(part)) {
        if (k.startsWith('i:')) doc.items[k.slice(2)] = v;
        else doc.tombs[k.slice(2)] = v;
      }
    }
    const before = new Map(ids.map((id) => [id, [doc.items[id], doc.tombs[id]]]));
    const { changed } = applyOps(doc, ops);
    if (!changed) return { rev: m.rev, updated: m.updated, items: await this.items() };

    const puts = {};
    const dels = [];
    let count = m.count;
    for (const id of ids) {
      const [bi, bt] = before.get(id);
      const ai = doc.items[id];
      const at = doc.tombs[id];
      if (ai !== bi) { if (ai) puts['i:' + id] = ai; else dels.push('i:' + id); }
      if (at !== bt) { if (at !== undefined) puts['t:' + id] = at; else dels.push('t:' + id); }
      count += (ai ? 1 : 0) - (bi ? 1 : 0);
    }
    if (count > MAX_ITEMS) return { error: 'list full' };

    // Prune old tombstones at most once a day.
    let pruned = m.pruned || 0;
    if (now - pruned > DAY) {
      const cutoff = now - TOMB_DAYS * DAY;
      for (const [k, at] of await this.s.list({ prefix: 't:' })) {
        if (at < cutoff && !(k in puts)) dels.push(k);
      }
      pruned = now;
    }

    const meta = { rev: m.rev + 1, updated: new Date(now).toISOString(), count, pruned };
    const writes = [];
    for (const part of chunks(Object.keys(puts))) writes.push(this.s.put(Object.fromEntries(part.map((k) => [k, puts[k]]))));
    for (const part of chunks(dels)) writes.push(this.s.delete(part));
    writes.push(this.s.put('meta', meta));
    await Promise.all(writes);
    return { rev: meta.rev, updated: meta.updated, items: await this.items() };
  }

  async open() {
    const m = await this.meta();
    const items = {};
    for (const i of await this.items()) items[i.id] = i;
    return { items: openView({ items }), updated: m.updated };
  }

  async exportAll() {
    const m = await this.meta();
    const items = {};
    for (const i of await this.items()) items[i.id] = i;
    const tombs = {};
    for (const [k, v] of await this.s.list({ prefix: 't:' })) tombs[k.slice(2)] = v;
    return { items, tombs, rev: m.rev, updated: m.updated };
  }
}

/* The Durable Object class. Reached only from the Worker, never from the internet. */
export class TodoList {
  constructor(ctx) {
    this.store = new ListStore(ctx.storage);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const st = this.store;
    let out;
    switch (url.pathname) {
      case '/read': {
        const since = url.searchParams.get('since');
        out = await st.read(since === null ? null : Number(since));
        break;
      }
      case '/apply':
        out = await st.apply((await request.json()).ops);
        break;
      case '/open':
        out = await st.open();
        break;
      case '/export':
        out = await st.exportAll();
        break;
      default:
        return new Response('not found', { status: 404 });
    }
    return Response.json(out, { status: out.error ? 413 : 200 });
  }
}
