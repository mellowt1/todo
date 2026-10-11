/* Intake: paper in, tasks out.
 *
 * Paul drops a PDF, a photo of a letter, or some pasted text. Claude reads it and
 * returns one record: who it concerns, what it is, the deadline, the amount, the
 * actions, and the lines those dates and amounts were read from. Every action becomes
 * a dated task in the to-do list, marked [intake]. The record is kept in KV for 90
 * days. The file itself is never stored anywhere; it goes to the API and is dropped.
 *
 * Routes (the list code in the link is the key, same as /api/todo):
 *   POST /api/intake/:code   <- { files: [{ name, media_type, data (base64) }], text? }
 *                            -> { id, record, tasks, usage }  or  { duplicate: true, id, record }
 *   GET  /api/intake/:code   ?limit=20  -> { items: [{ id, at, record, taskIds }] }  newest first
 *
 * KV keys: intake:<id> (record), intake:hash:<sha256> (dedupe), intake:usage:YYYY-MM (tokens).
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { cleanBatch, MAX_TEXT } from './todo.js';

export const MODEL = 'claude-opus-5-5';
export const MAX_FILES = 10;
export const MAX_BODY = 20 * 1024 * 1024; // base64 JSON, about 15 MB of files
export const MAX_TEXT_IN = 20000;
export const KEEP_DAYS = 90;
export const MEDIA = {
  'application/pdf': 'document',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
};

const DAY = 24 * 3600 * 1000;
const WHO = ['me', 'mom', 'dad', 'lucho', 'nick', 'derreck', 'olivia', 'other'];
const KIND = ['letter', 'bill', 'contract', 'credit-report', 'job', 'note', 'other'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* The one shape everything comes back in. Zod keeps the model honest and gives the
 * SDK a JSON schema for structured output. */
export const Record = z.object({
  readable: z.boolean().describe('false when the pages are too blurry, dark or cut off to trust'),
  who: z.enum(WHO).describe('whose matter this is'),
  kind: z.enum(KIND),
  summary: z.string().max(160).describe('one or two plain sentences in English, what this is and what it wants'),
  deadline: z.string().nullable().describe('the single most important date as YYYY-MM-DD, or null'),
  amount: z.object({ value: z.number(), currency: z.string().max(3) }).nullable(),
  actions: z.array(z.object({
    text: z.string().max(120).describe('one thing Paul has to do, imperative, English'),
    due: z.string().nullable().describe('YYYY-MM-DD or null'),
  })).max(8),
  needs_paul: z.boolean().describe('true when a decision or a reply is needed, false when it is only a wait or nothing'),
  quotes: z.array(z.string().max(200)).max(12).describe('the exact lines the dates and amounts were read from, in the original language'),
  note: z.string().max(200).nullable().describe('anything Paul should know that does not fit above: an unreadable page, two clauses that disagree'),
});

/* Frozen per deploy. Nothing that changes per request goes in here, so the prefix caches.
 * Who the people behind the `who` values are is not in this public file: it comes from the
 * INTAKE_PEOPLE secret (a few lines of text) and is appended at the end. */
export const SYSTEM = [
  'You read documents for Paul and turn them into a short record and dated tasks.',
  'Paul handles paperwork for himself and for a few people close to him. The `who` field names whose matter it is;',
  'me = Paul himself, other = anyone not listed. A description of the others follows at the end of this prompt when it is configured.',
  'Inputs arrive as PDFs, photos of letters, screenshots, or pasted text, in Dutch, Spanish or English.',
  'Write the summary and the actions in English. Keep quotes in the original language.',
  'Rules:',
  '1. Every date you put in deadline or due, and every amount, must be visible in the input and copied into quotes. Never infer a date that is not written. If a deadline is relative ("within 14 days of this letter"), compute it from the letter date, quote both, and say so in note.',
  '2. Make a task only for something Paul has to do. A payment that already happened, a pure notification, or a newsletter gets actions: [] and needs_paul: false.',
  '   Keep tasks few. Merge related steps into one task. Three tasks at most, unless the document names more separate deadlines. A report or statement with no deadline gives one or two tasks at most, or none.',
  '3. When two parts of a document disagree on a date or an amount that an action depends on, do not pick one: make one task to resolve it and put both lines in quotes. Other inconsistencies go in note, not in tasks.',
  '4. If the pages cannot be read, set readable: false, actions: [], and say in note what is missing. Do not guess.',
  '5. Pasted text with no document is a note from Paul: extract the actions and dates it names, kind = note.',
  '6. Dates use the year of the document when the text omits it; if the year is unclear, prefer the next occurrence after today.',
].join('\n');

let client = null;
function anthropic(env) {
  if (!client || client._key !== env.ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120000 });
    client._key = env.ANTHROPIC_API_KEY;
  }
  return client;
}

/* One call: files and text in, a Record out. Exported and swappable so the route can be
 * tested without the network (see _setReader). */
export async function readItem(env, { files, text, today }) {
  const content = [];
  for (const f of files) {
    const type = MEDIA[f.media_type];
    content.push({ type, source: { type: 'base64', media_type: f.media_type, data: f.data } });
  }
  if (text) content.push({ type: 'text', text: 'Pasted text:\n' + text });
  content.push({ type: 'text', text: `Today is ${today}. Read the input above and fill the record.` });

  const people = typeof env.INTAKE_PEOPLE === 'string' && env.INTAKE_PEOPLE.trim() ? '\nWho is who:\n' + env.INTAKE_PEOPLE.trim() : '';
  const res = await anthropic(env).beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: 'text', text: SYSTEM + people, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    output_config: { effort: 'high', format: zodOutputFormat(Record) },
    fallbacks: 'default',
    betas: ['server-side-fallback-2026-07-01'],
  });

  const usage = {
    model: res.model,
    input: res.usage?.input_tokens ?? 0,
    output: res.usage?.output_tokens ?? 0,
    cacheRead: res.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: res.usage?.cache_creation_input_tokens ?? 0,
  };
  if (res.stop_reason === 'refusal') {
    return { error: 'refused', detail: res.stop_details?.category || null, usage };
  }
  if (res.stop_reason === 'max_tokens') return { error: 'cut off', usage };
  const record = res.parsed_output;
  if (!record) return { error: 'no record', usage };
  return { record, usage };
}

let reader = readItem;
export function _setReader(fn) { reader = fn || readItem; }

/* Pure. Turn a record into to-do upserts. Section by how soon the task is due:
 * within 2 days today, within 14 soon, else someday. No due date: soon when Paul
 * has to act, someday otherwise. */
export function toOps(record, now = Date.now(), newId = randomId) {
  if (!record || !record.readable || !Array.isArray(record.actions)) return [];
  const todayMs = Date.parse(dayOf(now));
  return record.actions.map((a) => {
    const due = typeof a.due === 'string' && DATE.test(a.due) ? a.due : null;
    let section = record.needs_paul ? 'soon' : 'someday';
    if (due) {
      const days = Math.round((Date.parse(due) - todayMs) / DAY);
      section = days <= 2 ? 'today' : days <= 14 ? 'soon' : 'someday';
    }
    const tail = (due ? ' · ' + due : '') + ' [intake]';
    const text = String(a.text || '').trim().slice(0, MAX_TEXT - tail.length) + tail;
    return { op: 'upsert', item: { id: newId(), text, section, done: false, doneAt: null, updatedAt: now, pos: now } };
  });
}

export function dayOf(ms, tz = 'Europe/Amsterdam') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

export function randomId() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (const x of crypto.getRandomValues(new Uint8Array(16))) s += a[x % 36];
  return s;
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Validate the body. Returns { files, text } or { error, status }. */
export function cleanInput(body) {
  if (!body || typeof body !== 'object') return { error: 'send { files, text }', status: 400 };
  const files = [];
  const raw = Array.isArray(body.files) ? body.files : [];
  if (raw.length > MAX_FILES) return { error: `at most ${MAX_FILES} files`, status: 400 };
  for (const f of raw) {
    if (!f || typeof f !== 'object' || !MEDIA[f.media_type]) return { error: 'media_type must be pdf, jpeg, png, webp or gif', status: 400 };
    if (typeof f.data !== 'string' || !f.data || /[^A-Za-z0-9+/=]/.test(f.data)) return { error: 'data must be base64', status: 400 };
    files.push({ name: typeof f.name === 'string' ? f.name.slice(0, 120) : '', media_type: f.media_type, data: f.data });
  }
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT_IN) : '';
  if (!files.length && !text) return { error: 'nothing to read', status: 400 };
  return { files, text };
}

async function bumpUsage(env, month, u) {
  const key = 'intake:usage:' + month;
  const cur = (await env.HUB_KV.get(key, 'json')) || { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  cur.calls += 1;
  cur.input += u.input; cur.output += u.output; cur.cacheRead += u.cacheRead; cur.cacheWrite += u.cacheWrite;
  await env.HUB_KV.put(key, JSON.stringify(cur));
  return cur;
}

/* The route. `list` and `json` come from worker.js so this module never reaches
 * into the Durable Object or CORS on its own. */
export async function handleIntake(request, env, rest, url, { json, list, code: CODE }) {
  if (rest.length !== 1 || !CODE.test(rest[0])) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || rest[0] !== env.TODO_CODE) return json({ error: 'not found' }, request, 404);
  if (!env.ANTHROPIC_API_KEY && request.method === 'POST') return json({ error: 'not configured' }, request, 503);

  if (request.method === 'GET') {
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 20));
    const keys = await env.HUB_KV.list({ prefix: 'intake:r:' });
    const names = keys.keys.map((k) => k.name).sort().reverse().slice(0, limit);
    const items = (await Promise.all(names.map((k) => env.HUB_KV.get(k, 'json')))).filter(Boolean);
    return json({ items }, request);
  }
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, request, 413);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad json' }, request, 400); }
  const input = cleanInput(body);
  if (input.error) return json({ error: input.error }, request, input.status);

  const now = Date.now();
  const today = dayOf(now);
  const hash = await sha256(input.files.map((f) => f.media_type + ':' + f.data).join('|') + '|' + input.text);
  const seen = await env.HUB_KV.get('intake:hash:' + hash, 'json');
  if (seen) {
    const rec = await env.HUB_KV.get('intake:r:' + seen.key, 'json');
    return json({ duplicate: true, id: seen.id, at: seen.at, record: rec ? rec.record : null, tasks: rec ? rec.tasks : [] }, request);
  }

  let read;
  try {
    read = await reader(env, { files: input.files, text: input.text, today });
  } catch (e) {
    // Most specific first, so a bad key, a rate limit and a network failure each say what they are.
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'api key refused' }, request, 502);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'api rate limit, try again in a minute' }, request, 429);
    if (e instanceof Anthropic.APIStatusError) return json({ error: 'api error ' + e.status, detail: String(e.message).slice(0, 300) }, request, 502);
    if (e instanceof Anthropic.APIConnectionError) return json({ error: 'api unreachable' }, request, 502);
    throw e;
  }
  const month = today.slice(0, 7);
  if (read.usage) await bumpUsage(env, month, read.usage).catch(() => {});
  if (read.error) return json({ error: read.error, detail: read.detail || null, usage: read.usage || null }, request, 502);

  const ops = toOps(read.record, now);
  let tasks = [];
  if (ops.length) {
    const batch = cleanBatch({ ops }, now);
    if (batch.error) return json({ error: batch.error }, request, 500);
    const out = await list(env, env.TODO_CODE, '/apply', { ops: batch.ops });
    if (out.data.error) return json(out.data, request, out.status);
    tasks = batch.ops.map((o) => ({ id: o.item.id, text: o.item.text, section: o.item.section }));
  }

  const id = randomId();
  // Key sorts by time so GET can list newest first without reading every record.
  const key = String(now).padStart(14, '0') + ':' + id;
  const stored = { id, at: new Date(now).toISOString(), names: input.files.map((f) => f.name), hadText: !!input.text, record: read.record, tasks, usage: read.usage };
  const ttl = KEEP_DAYS * 24 * 3600;
  await Promise.all([
    env.HUB_KV.put('intake:r:' + key, JSON.stringify(stored), { expirationTtl: ttl }),
    env.HUB_KV.put('intake:hash:' + hash, JSON.stringify({ id, key, at: stored.at }), { expirationTtl: ttl }),
  ]);
  return json({ id, at: stored.at, record: read.record, tasks, usage: read.usage }, request);
}
