/* Status: the hub reads back what it holds and says, in one line, how things stand.
 *
 * Once an hour the cron gathers facts from the hub's own KV and the to-do list (events of the
 * last 24 h, which jobs went quiet, how old the backup is, open to-dos, repos not pushed,
 * parked items) and writes a deterministic sentence from them. Once a day, at the first run
 * after 06:00 Amsterdam, Claude turns the same facts into two short sentences. Morning shows
 * the summary when there is one, the sentence otherwise.
 *
 * Reads everything, writes only hub:status and hub:status:summaryAt. Never touches an app's data.
 *
 * KV: hub:status { at, line, summary, summaryAt, facts }   hub:status:summaryAt <iso>
 * Secret: ANTHROPIC_API_KEY (shared with intake). No key, no summary; the line still works. */

import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { JOBS, lastBeats } from './health.js';
import { local, daysBetween, PROJECTS_KEY, REPOS_KEY, cleanRepos } from './morning.js';
import { listEvents } from './events.js';
import { anthropic, MODEL } from './intake.js';

export const STATUS_KEY = 'hub:status';
export const SUMMARY_AT_KEY = 'hub:status:summaryAt';
export const SUMMARY_HOUR = 6;
export const MAX_SUMMARY = 240;
const HOUR = 3600000;
const DAY = 24 * HOUR;

/* ---------- Facts: read only ---------- */

async function eventFacts(env, now) {
  const all = await listEvents(env, now, 2, 200);
  const recent = all.filter((e) => now - Date.parse(e.at) <= DAY);
  const sources = {};
  for (const e of recent) {
    const s = sources[e.source] || (sources[e.source] = { count: 0, lastAt: e.at, latest: [] });
    s.count++;
    if (s.latest.length < 3) s.latest.push(e.text);
  }
  return { total: recent.length, sources };
}

async function jobFacts(env, now) {
  const beats = await lastBeats(env);
  const quiet = [], unknown = [];
  let ok = 0;
  for (const [job, def] of Object.entries(JOBS)) {
    const at = beats[job];
    if (!at) { unknown.push(job); continue; }
    const hoursAgo = Math.round((now - at) / HOUR);
    if (now - at > def.hours * HOUR) quiet.push({ job, name: def.name, hoursAgo, limit: def.hours });
    else ok++;
  }
  return { quiet, ok, unknown };
}

async function backupFacts(env, now) {
  const b = await env.HUB_KV.get('beat:backup', 'json');
  const at = b && Date.parse(b.at);
  return { ageDays: at ? Math.floor((now - at) / DAY) : null };
}

async function todoFacts(env) {
  if (!env.TODO_LIST || !env.TODO_CODE) return null;
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
  const d = await (await stub.fetch('https://list/read')).json();
  if (!Array.isArray(d.items)) return null;
  const open = d.items.filter((i) => !i.done);
  return { open: open.length, today: open.filter((i) => i.section === 'today').length };
}

async function repoFacts(env) {
  const r = cleanRepos(await env.HUB_KV.get(REPOS_KEY, 'json'));
  if (!r) return null;
  return { notPushed: r.repos.length, names: r.repos.slice(0, 5).map((x) => x.name) };
}

async function parkedFacts(env, now) {
  const p = await env.HUB_KV.get(PROJECTS_KEY, 'json');
  if (!p) return { count: 0, oldestDays: null };
  const today = local(now).date;
  const items = [];
  for (const x of Array.isArray(p.projects) ? p.projects : []) if (x && x.status === 'parked') items.push(x);
  for (const x of Array.isArray(p.parked) ? p.parked : []) if (x) items.push(x);
  const ages = items.map((x) => (typeof x.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.since) ? Math.max(0, daysBetween(x.since, today)) : null)).filter((a) => a !== null);
  return { count: items.length, oldestDays: ages.length ? Math.max(...ages) : null };
}

/* Everything the hub knows, as plain numbers and short texts. One failing part is left null. */
export async function gatherFacts(env, now = Date.now()) {
  const part = (p) => p.catch(() => null);
  const [events, jobs, backup, todos, repos, parked] = await Promise.all([
    part(eventFacts(env, now)), part(jobFacts(env, now)), part(backupFacts(env, now)),
    part(todoFacts(env)), part(repoFacts(env)), part(parkedFacts(env, now)),
  ]);
  return { at: new Date(now).toISOString(), hours: 24, events, jobs, backup, todos, repos, parked };
}

/* ---------- The line: pure, always works ---------- */

const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;

export function rulesLine(f) {
  const parts = [];
  if (f.jobs) for (const q of f.jobs.quiet) parts.push(`${q.name} quiet ${q.hoursAgo < 48 ? n(q.hoursAgo, 'hour', 'hours') : n(Math.round(q.hoursAgo / 24), 'day', 'days')}`);
  if (f.backup && f.backup.ageDays !== null && f.backup.ageDays > 8) parts.push(`backup ${n(f.backup.ageDays, 'day', 'days')} old`);
  const late = parts.length;
  if (f.events && f.events.total) {
    const apps = Object.keys(f.events.sources).length;
    parts.push(`${n(f.events.total, 'thing', 'things')} happened in ${n(apps, 'app', 'apps')}`);
  } else if (!late) parts.push('A quiet night');
  if (f.todos) parts.push(n(f.todos.open, 'open to-do', 'open to-dos'));
  if (f.repos && f.repos.notPushed) parts.push(`${n(f.repos.notPushed, 'repo', 'repos')} not pushed`);
  if (f.parked && f.parked.count) parts.push(n(f.parked.count, 'thing parked', 'things parked'));
  if (!parts.length) return 'Nothing to report.';
  const line = parts.join(', ');
  return line.charAt(0).toUpperCase() + line.slice(1) + '.';
}

/* ---------- The summary: Claude, once a day, from the facts only ---------- */

const SYSTEM = "You write the one-line status at the top of Paul's morning screen, from a JSON of facts about his own small apps and jobs. " +
  'At most two short sentences, under 220 characters, plain English, no greeting, no markdown, no advice. ' +
  'Use only numbers and names that appear in the facts; never invent. ' +
  'Say first anything quiet or late, then what happened most; if everything is fine say so in a few words.';

const Summary = z.object({ summary: z.string().max(MAX_SUMMARY) });

export async function writeSummary(env, facts) {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await anthropic(env).beta.messages.parse({
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM,
      messages: [{ role: 'user', content: 'Facts (last 24 h, times UTC):\n' + JSON.stringify(facts) }],
      output_config: { effort: 'low', format: zodOutputFormat(Summary) },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens' || !res.parsed_output) return null;
    const text = String(res.parsed_output.summary || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY);
    return text || null;
  } catch (e) {
    return null;
  }
}

let writer = writeSummary;
export function _setWriter(fn) { writer = fn || writeSummary; }

/* Pure: the first run on or after SUMMARY_HOUR (Amsterdam) that has not summarised today. */
export function shouldSummarise(now, lastAt) {
  const l = local(now);
  if (l.minutes < SUMMARY_HOUR * 60) return false;
  const last = lastAt ? Date.parse(lastAt) : NaN;
  return !Number.isFinite(last) || local(last).date !== l.date;
}

/* The hourly job. Facts and the line every time; the summary once a day, one attempt only:
 * the day is reserved before the call, so a failed call waits for tomorrow. */
export async function refreshStatus(env, now = Date.now(), write = writer) {
  const [facts, prev, lastAt] = await Promise.all([gatherFacts(env, now), env.HUB_KV.get(STATUS_KEY, 'json'), env.HUB_KV.get(SUMMARY_AT_KEY)]);
  const line = rulesLine(facts);
  let summary = prev && typeof prev.summary === 'string' ? prev.summary : null;
  let summaryAt = prev && prev.summaryAt ? prev.summaryAt : null;
  if (shouldSummarise(now, lastAt)) {
    summaryAt = new Date(now).toISOString();
    await env.HUB_KV.put(SUMMARY_AT_KEY, summaryAt);
    try { summary = await write(env, facts); } catch (e) { summary = null; }
  }
  const rec = { at: new Date(now).toISOString(), line, summary, summaryAt, facts };
  await env.HUB_KV.put(STATUS_KEY, JSON.stringify(rec));
  return rec;
}
