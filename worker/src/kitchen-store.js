/* The kitchen, kept in a SQLite-backed Durable Object, one per kitchen code.
 *
 * Same idea as the to-do's list (src/list.js): one request at a time, so two phones
 * posting at once never overwrite each other's batch. SQLite Durable Objects are on
 * the Workers Free plan.
 *
 * Storage, one row per record (the storage API on the SQLite backend):
 *   r:<type>:<id>  the record, type included
 *   t:<type>:<id>  deletedAt, the tombstone of a deleted record
 *   meta           { rev, updated, count, pruned }
 *
 * The Worker validates everything first; this class only ever sees clean ops.
 */

import { applyOps, keyOf, LIMITS, TOMB_DAYS } from './kitchen.js';

const DAY = 24 * 3600 * 1000;
const CHUNK = 128; // the storage API takes at most 128 keys per call

function chunks(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
}

export class KitchenData {
  constructor(storage) {
    this.s = storage;
  }

  async meta() {
    return (await this.s.get('meta')) || { rev: 0, updated: null, count: 0, pruned: 0 };
  }

  async items() {
    return Array.from((await this.s.list({ prefix: 'r:' })).values());
  }

  async read(since) {
    const m = await this.meta();
    if (since !== null && since === m.rev) return { unchanged: true, rev: m.rev };
    return { items: await this.items(), rev: m.rev, updated: m.updated };
  }

  /* Apply clean ops, all written in one go with no await in between (committed atomically).
   * win: true (the admin route) restamps each op just past what is stored for that record,
   * so it always lands, even over an edit from a phone whose clock runs ahead.
   * The answer lists the ids of ops that did not land (an older or equal stamp) as skipped. */
  async apply(ops, now = Date.now(), win = false) {
    const m = await this.meta();
    const keys = [...new Set(ops.map((o) => keyOf(o.type, o.item.id)))];
    const doc = { items: {}, tombs: {} };
    for (const part of chunks(keys.flatMap((k) => ['r:' + k, 't:' + k]))) {
      for (const [k, v] of await this.s.get(part)) {
        if (k.startsWith('r:')) doc.items[k.slice(2)] = v;
        else doc.tombs[k.slice(2)] = v;
      }
    }
    const before = new Map(keys.map((k) => [k, [doc.items[k], doc.tombs[k]]]));
    if (win) {
      for (const o of ops) {
        const k = keyOf(o.type, o.item.id);
        const cur = doc.items[k];
        const tomb = doc.tombs[k];
        o.item.updatedAt = Math.max(o.item.updatedAt, cur ? cur.updatedAt + 1 : 0, tomb !== undefined ? tomb + 1 : 0);
      }
    }
    const { changed } = applyOps(doc, ops);
    const skipped = ops.filter((o) => {
      const k = keyOf(o.type, o.item.id);
      return o.op === 'upsert' ? doc.items[k] !== o.item : doc.tombs[k] !== o.item.updatedAt;
    }).map((o) => o.item.id);
    if (!changed) return { rev: m.rev, updated: m.updated, items: await this.items(), skipped };

    const puts = {};
    const dels = [];
    let count = m.count;
    for (const k of keys) {
      const [bi, bt] = before.get(k);
      const ai = doc.items[k];
      const at = doc.tombs[k];
      if (ai !== bi) { if (ai) puts['r:' + k] = ai; else dels.push('r:' + k); }
      if (at !== bt) { if (at !== undefined) puts['t:' + k] = at; else dels.push('t:' + k); }
      count += (ai ? 1 : 0) - (bi ? 1 : 0);
    }
    if (count > LIMITS.rows) return { error: 'kitchen full' };

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
    return { rev: meta.rev, updated: meta.updated, items: await this.items(), skipped };
  }

  async exportAll() {
    const m = await this.meta();
    const tombs = {};
    for (const [k, v] of await this.s.list({ prefix: 't:' })) tombs[k.slice(2)] = v;
    return { items: await this.items(), tombs, rev: m.rev, updated: m.updated };
  }
}

/* Talk to a kitchen's Durable Object from the Worker (the kitchen routes and the Morning
 * Screen). The host name is never resolved; it only has to parse. */
export async function kitchen(env, code, path, body) {
  const stub = env.KITCHEN_STORE.get(env.KITCHEN_STORE.idFromName('kitchen:' + code));
  const init = body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
  const r = await stub.fetch('https://kitchen' + path, init);
  return { status: r.status, data: await r.json() };
}

/* The Durable Object class. Reached only from the Worker, never from the internet. */
export class KitchenStore {
  constructor(ctx) {
    this.data = new KitchenData(ctx.storage);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const d = this.data;
    let out;
    switch (url.pathname) {
      case '/read': {
        const since = url.searchParams.get('since');
        out = await d.read(since === null ? null : Number(since));
        break;
      }
      case '/apply':
      {
        const body = await request.json();
        out = await d.apply(body.ops, Date.now(), body.win === true);
      }
        break;
      case '/export':
        out = await d.exportAll();
        break;
      default:
        return new Response('not found', { status: 404 });
    }
    return Response.json(out, { status: out.error ? 413 : 200 });
  }
}
