/* What Claude costs (Paul, 2026-11-08: "do that api spend"): the hub's monthly token counters
 * (KV <feature>:usage:YYYY-MM, written by bumpUsage in src/intake.js) priced per model, for a
 * card on Morning and GET /api/spend/:code. Dollars, as the Anthropic Console bills them.
 *
 * Counters carry a bucket per model (`m`) since 2026-11-08. Counts from before that have none:
 * they are priced at the model the feature used then (FEATURES[k].was).
 *
 * Not in here: the Runway money clerk (its own Worker and key), Odysseus (its own ledger,
 * /ops/model-spend on the Mac) and the PC's headless jobs (the Claude subscription, not the API). */

import { CODE, safeEqual } from './todo.js';
import { dayOf } from './intake.js';

const HAIKU = 'claude-haiku-5-5', SONNET = 'claude-sonnet-5-5', OPUS = 'claude-opus-5-5';

// $ per million tokens: input, output, cache read, cache write (5-minute, 1.25x input).
export const PRICES = {
  [HAIKU]: { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  [SONNET]: { input: 2, output: 10, cacheRead: 0.20, cacheWrite: 2.5 },
  [OPUS]: { input: 4, output: 20, cacheRead: 0.20, cacheWrite: 5 },
};

// KV prefix -> the name on the card and the model its old counts are priced at.
export const FEATURES = {
  tidy: { label: 'Tidy', was: HAIKU },
  intake: { label: 'Letters read', was: OPUS },
  letters: { label: 'Letter steps', was: HAIKU },
  desk: { label: 'Claude answers', was: OPUS },
  apply: { label: 'Applications', was: OPUS },
  talk: { label: 'Talk points', was: OPUS },
  mixtape: { label: 'Playlists', was: OPUS },
  'lift-ask': { label: 'Lift', was: OPUS },
  energy: { label: 'Energy', was: HAIKU },
  skills: { label: 'Skills gap', was: OPUS },
  taskskills: { label: 'Task skills', was: HAIKU },
  oracle: { label: 'Oracle', was: OPUS },
  mirror: { label: 'Mirror', was: OPUS },
  lessons: { label: 'Lessons', was: OPUS },
  week: { label: 'Your week', was: OPUS },
  status: { label: 'Hub summary', was: OPUS },
};

const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/* Pure: one bucket of tokens in dollars. An unknown model is priced as Opus (the dearest here). */
export function priceOf(bucket, model) {
  const p = PRICES[model] || PRICES[OPUS];
  return KINDS.reduce((s, k) => s + n(bucket && bucket[k]) * p[k], 0) / 1e6;
}

/* Pure: one feature's counter for a month in dollars, its per-model buckets first, the rest
 * (counts from before the buckets) at the feature's old model. */
export function costOf(cur, was) {
  if (!cur || typeof cur !== 'object') return { calls: 0, usd: 0 };
  let usd = 0;
  const left = Object.fromEntries(KINDS.map((k) => [k, n(cur[k])]));
  for (const [model, b] of Object.entries(cur.m && typeof cur.m === 'object' ? cur.m : {})) {
    usd += priceOf(b, model);
    for (const k of KINDS) left[k] = Math.max(0, left[k] - n(b && b[k]));
  }
  usd += priceOf(left, was);
  return { calls: n(cur.calls), usd };
}

const prevMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const cents = (usd) => Math.round(usd * 100) / 100;

async function monthOf(env, ym) {
  const rows = await Promise.all(Object.entries(FEATURES).map(async ([key, f]) => {
    const cur = await env.HUB_KV.get(`${key}:usage:${ym}`, 'json').catch(() => null);
    return { key, label: f.label, ...costOf(cur, f.was) };
  }));
  const used = rows.filter((r) => r.calls > 0).sort((a, b) => b.usd - a.usd);
  return { month: ym, usd: used.reduce((s, r) => s + r.usd, 0), calls: used.reduce((s, r) => s + r.calls, 0), features: used };
}

/* This month and last, in dollars to the cent (the features to a tenth of a cent). */
export async function spendBlock(env, now = Date.now()) {
  const ym = dayOf(now).slice(0, 7);
  const [cur, last] = await Promise.all([monthOf(env, ym), monthOf(env, prevMonth(ym))]);
  const day = Number(dayOf(now).slice(8, 10));
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    month: ym,
    usd: cents(cur.usd),
    calls: cur.calls,
    // A straight line from the month so far; null in the first two days (too little to go on).
    pace: day >= 3 ? cents((cur.usd / day) * days) : null,
    features: cur.features.map((r) => ({ key: r.key, label: r.label, calls: r.calls, usd: Math.round(r.usd * 1000) / 1000 })),
    last: { month: last.month, usd: cents(last.usd) },
  };
}

export const spendForMorning = (env, now) => spendBlock(env, now);

/*   GET /api/spend/:code   (the to-do's code) */
export async function handleSpend(request, env, rest, json) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (request.method !== 'GET' || rest.length !== 1) return json({ error: 'not found' }, request, 404);
  return json(await spendBlock(env), request);
}
