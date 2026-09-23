// In memory stand-ins for the Durable Object storage API and namespace, enough for the tests.
import { TodoList } from '../src/list.js';

export class MemStorage {
  constructor() { this.m = new Map(); this.writes = 0; }
  async get(k) {
    if (Array.isArray(k)) return new Map(k.filter((x) => this.m.has(x)).map((x) => [x, structuredClone(this.m.get(x))]));
    return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined;
  }
  async put(k, v) {
    this.writes++;
    if (typeof k === 'object') { const e = Object.entries(k); if (e.length > 128) throw new Error('too many keys'); for (const [a, b] of e) this.m.set(a, structuredClone(b)); }
    else this.m.set(k, structuredClone(v));
  }
  async delete(k) {
    this.writes++;
    const ks = Array.isArray(k) ? k : [k];
    if (ks.length > 128) throw new Error('too many keys');
    for (const x of ks) this.m.delete(x);
  }
  async list({ prefix = '' } = {}) {
    return new Map([...this.m.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => [k, structuredClone(this.m.get(k))]));
  }
}

export function memNamespace(Klass = TodoList) {
  const objs = new Map();
  const storages = new Map();
  return {
    storages,
    idFromName: (n) => n,
    get(id) {
      if (!objs.has(id)) { const s = new MemStorage(); storages.set(id, s); objs.set(id, new Klass({ storage: s })); }
      const o = objs.get(id);
      return { fetch: (url, init) => o.fetch(new Request(url, init)) };
    },
  };
}
