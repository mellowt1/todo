/* Heartbeats: is everything that should run on its own still running?
 *
 *   POST /api/health/beat   Authorization: Bearer <BEAT_TOKEN>   <- { job, note? }  -> { ok: true }
 *   GET  /api/health        Authorization: Bearer <BEAT_TOKEN>   -> { jobs: [{ job, name, at, late }] }
 *
 * Each job reports in after it has done its work (the Mac's watcher, the PC's daily run, a
 * GitHub Action after a routine's commit). The calendar needs no beat: Odysseus's push is it.
 * Once an hour the cron looks at every job. One that has gone quiet for longer than its
 * `hours` sends one ntfy alert; when it reports in again, one "running again" note follows.
 * A job that has never reported is not checked yet, so a new job can't alert before it is set up.
 *
 * KV: beat:<job> { at, note }   health:alerted { <job>: <iso> }
 * Secrets: BEAT_TOKEN (the beat route), NTFY_TOPIC (where alerts go; no topic, no alerts). */

import { safeEqual, bearer } from './todo.js';
import { CAL_KEY } from './morning.js';

export const JOBS = {
  'arsenal-watch': { name: 'Arsenal ticket watch', hours: 3, how: 'On the Mac: tail ~/arsenal-tx-watch/watch.log' },
  calendar: { name: 'Calendar push from Odysseus', hours: 3, how: 'Odysseus on the Mac stopped sending the calendar.' },
  'morning-projects': { name: 'Morning Projects refresh', hours: 50, how: 'On the PC: PAUL AGENTS\\morning-projects\\run.log' },
  'defence-digest': { name: 'Defence digest email', hours: 62, how: 'Check the defence-digest routine on claude.ai.' },
  'icc-briefing': { name: 'ICC briefing', hours: 30, how: 'Check the ICC briefing routine on claude.ai.' },
  backup: { name: 'Weekly backup', hours: 8 * 24 + 6, how: 'On the PC: PAUL AGENTS\\morning-projects\\run.log' },
};

const ALERTED_KEY = 'health:alerted';
const JOB = /^[a-z0-9-]{2,32}$/;

/* When each job last showed a sign of life: { job: ms | null }. */
export async function lastBeats(env) {
  const out = {};
  await Promise.all(Object.keys(JOBS).map(async (job) => {
    if (job === 'calendar') {
      const c = await env.HUB_KV.get(CAL_KEY, 'json');
      out[job] = c && Date.parse(c.received) ? Date.parse(c.received) : null;
      return;
    }
    const b = await env.HUB_KV.get('beat:' + job, 'json');
    out[job] = b && Date.parse(b.at) ? Date.parse(b.at) : null;
  }));
  return out;
}

export const ago = (ms) => {
  const h = Math.round(ms / 3600000);
  if (h < 1) return 'under an hour ago';
  if (h < 48) return h === 1 ? '1 hour ago' : h + ' hours ago';
  return Math.round(h / 24) + ' days ago';
};

/* Pure: what to send, given the beats and who was already alerted. */
export function healthChanges(beats, alerted, now) {
  const send = [];
  const next = { ...alerted };
  for (const [job, def] of Object.entries(JOBS)) {
    const at = beats[job];
    if (!at) continue;
    const late = now - at > def.hours * 3600000;
    if (late && !next[job]) {
      send.push({ title: `${def.name} stopped`, message: `Last sign of life ${ago(now - at)}. ${def.how}`, priority: 4, tags: ['warning'] });
      next[job] = new Date(now).toISOString();
    } else if (!late && next[job]) {
      send.push({ title: `${def.name} is running again`, message: 'Nothing to do.', priority: 2, tags: ['white_check_mark'] });
      delete next[job];
    }
  }
  for (const job of Object.keys(next)) if (!JOBS[job]) delete next[job];
  return { send, alerted: next };
}

export async function checkHealth(env, now = Date.now(), fetcher = fetch) {
  const [beats, alerted] = await Promise.all([lastBeats(env), env.HUB_KV.get(ALERTED_KEY, 'json')]);
  const out = healthChanges(beats, alerted || {}, now);
  if (!out.send.length) return out;
  if (!env.NTFY_TOPIC) return out; // nowhere to send: keep the old state so it alerts once a topic is set
  const sent = [];
  for (const m of out.send) {
    const r = await fetcher('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: env.NTFY_TOPIC, ...m }) });
    if (r.ok) sent.push(m);
  }
  // Only remember what actually went out, so a failed send is tried again next hour.
  if (sent.length === out.send.length) await env.HUB_KV.put(ALERTED_KEY, JSON.stringify(out.alerted));
  return { ...out, sent };
}

export async function handleHealth(request, env, rest, json, now = Date.now()) {
  if (!env.BEAT_TOKEN || !safeEqual(bearer(request), env.BEAT_TOKEN)) return json({ error: 'unauthorized' }, request, 401);
  if (rest.length === 0 && request.method === 'GET') {
    const beats = await lastBeats(env);
    return json({ jobs: Object.entries(JOBS).map(([job, d]) => ({ job, name: d.name, at: beats[job] ? new Date(beats[job]).toISOString() : null, late: !!beats[job] && now - beats[job] > d.hours * 3600000 })) }, request);
  }
  if (rest.length === 1 && rest[0] === 'beat' && request.method === 'POST') {
    const text = await request.text();
    if (text.length > 1000) return json({ error: 'too large' }, request, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, request, 400); }
    const job = body && body.job;
    if (typeof job !== 'string' || !JOB.test(job) || !JOBS[job] || job === 'calendar') return json({ error: 'unknown job' }, request, 400);
    const note = typeof body.note === 'string' ? body.note.slice(0, 200) : '';
    await env.HUB_KV.put('beat:' + job, JSON.stringify({ at: new Date(now).toISOString(), note }));
    return json({ ok: true }, request);
  }
  return json({ error: 'not found' }, request, 404);
}
