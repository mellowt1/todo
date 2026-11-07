/* Lift heart rate. AirPods measure it while a tracking app runs; an iPhone Shortcut ("Lift heart
 * rate") reads the last hours of heart-rate samples from Apple Health and posts them here. Lift
 * then asks for the samples inside a workout and works out average, peak and calories itself.
 *
 *   POST /api/lift/:code/hr   <- text, one sample per line: "<date>;<bpm>" (also "," or tab),
 *                                or JSON { lines: "<that text>" } or { samples: [[ms, bpm]] }
 *                             -> { ok, added, days }
 *   GET  /api/lift/:code/hr?from=<ms>&to=<ms>   (at most 24 hours) -> { samples: [[ms, bpm]], at }
 *
 * KV: lift:hr:<YYYY-MM-DD UTC> = [[ms, bpm]] sorted, one per second at most (400 days),
 *     lift:hr:at = when the Shortcut last posted. */

const MAX_BODY = 2 * 1024 * 1024;
const MAX_SAMPLES = 40000;
const TTL = 400 * 86400;
const DAY = 86400000;
const AT = 'lift:hr:at';
const dayKey = (ms) => 'lift:hr:' + new Date(ms).toISOString().slice(0, 10);

/* Pure: what the Shortcut sent → [[ms, bpm]]. Dates as Shortcuts writes them (ISO 8601, or
 * anything Date.parse reads); bpm 25–250, rounded. Lines that do not read are skipped. */
export function parseSamples(body, now = Date.now()) {
  let rows = [];
  if (body && typeof body === 'object' && Array.isArray(body.samples)) rows = body.samples.map((s) => [Number(s?.[0]), Number(s?.[1])]);
  else {
    const text = typeof body === 'string' ? body : body && typeof body.lines === 'string' ? body.lines : '';
    for (const line of text.split(/\r?\n/)) {
      const m = line.trim().match(/^(.+?)\s*[;,\t]\s*([\d.,]+)(?:\s*[a-z/]+)?\s*$/i);
      if (!m) continue;
      rows.push([Date.parse(m[1].trim().replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')), Number(m[2].replace(',', '.'))]);
    }
  }
  const out = [];
  for (const [t, b] of rows) {
    if (!Number.isFinite(t) || !Number.isFinite(b) || b < 25 || b > 250) continue;
    if (t > now + 3600000 || t < now - 30 * DAY) continue;
    out.push([Math.round(t / 1000) * 1000, Math.round(b)]);
  }
  return out.slice(0, MAX_SAMPLES);
}

/* Pure: two sample lists → one, sorted, one sample per second (the newer list wins). */
export function mergeSamples(old, add) {
  const m = new Map(old.map(([t, b]) => [t, b]));
  for (const [t, b] of add) m.set(t, b);
  return [...m].sort((a, b) => a[0] - b[0]);
}

export async function saveSamples(env, samples, now = Date.now()) {
  const byDay = new Map();
  for (const s of samples) {
    const k = dayKey(s[0]);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }
  for (const [k, add] of byDay) {
    const old = (await env.HUB_KV.get(k, 'json')) || [];
    await env.HUB_KV.put(k, JSON.stringify(mergeSamples(old, add)), { expirationTtl: TTL });
  }
  await env.HUB_KV.put(AT, new Date(now).toISOString());
  return { added: samples.length, days: byDay.size };
}

export async function samplesBetween(env, from, to) {
  const keys = new Set([dayKey(from), dayKey(to)]);
  let all = [];
  for (const k of keys) all = all.concat((await env.HUB_KV.get(k, 'json')) || []);
  return all.filter(([t]) => t >= from && t <= to).sort((a, b) => a[0] - b[0]);
}

/* Called by handleLift for /api/lift/:code/hr once the code checked out. */
export async function handleLiftHr(request, env, json, now = Date.now()) {
  if (request.method === 'GET') {
    const u = new URL(request.url);
    const from = Number(u.searchParams.get('from')), to = Number(u.searchParams.get('to'));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > DAY) return json({ error: 'from and to, at most a day apart' }, request, 400);
    return json({ samples: await samplesBetween(env, from, to), at: await env.HUB_KV.get(AT) }, request);
  }
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, request, 413);
  let body = text;
  if (/^\s*[{[]/.test(text)) { try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, request, 400); } }
  const samples = parseSamples(body, now);
  if (!samples.length) return json({ error: 'no heart-rate samples in that' }, request, 400);
  return json({ ok: true, ...(await saveSamples(env, samples, now)) }, request);
}
