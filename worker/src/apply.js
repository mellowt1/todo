/* Apply: an "Apply: ..." task in To-do is prepared on Paul's PC.
 *
 * Paul taps Prepare on the PC in the task's edit sheet (phone or PC). The task joins a queue. His PC
 * (PAUL AGENTS/applications/prep.mjs, every morning and on demand) takes the queue, reads the
 * vacancy, finds his two closest past motivation letters, asks this Worker for the draft, and
 * builds a folder: the right CV PDF, the letter as Word, the vacancy text and a checklist. Then it
 * reports the folder back and To-do shows it as ready.
 *
 *   The app (the to-do's code):
 *   GET  /api/apply/:code/:taskId          -> { state: "none" | "queued" | "ready", queuedAt?, folder?, draft? }
 *   POST /api/apply/:code/:taskId          -> { state: "queued" }   (again on a ready one: queued again)
 *   The PC (Authorization: Bearer <APPLY_PC_TOKEN>):
 *   GET  /api/apply/pc/queue               -> { jobs: [{ taskId, text, link, queuedAt }] }
 *   POST /api/apply/pc/:taskId/draft       <- { text, title?, organisation?, examples?: [text] }  -> { draft }
 *   POST /api/apply/pc/:taskId/ready       <- { folder }  -> { state: "ready" }   (one line on Morning's feed)
 *
 * Claude picks the best of Paul's CV versions, scores the fit, names up to three gaps, lists the
 * documents the vacancy asks for and writes the letter in the vacancy's language, in the voice
 * of the past letters the PC sends along (they are used for this call and never kept).
 * Nothing is sent anywhere: Paul checks the folder and applies himself.
 *
 * The CV versions are not in this public repo. They sit in KV apply:cvs
 *   { versions: [{ key, label, lang, text }] }
 * written from the PC (PAUL AGENTS/intake/scripts/put-cvs.mjs). No CVs, no drafts (503).
 *
 * KV: apply:r:<taskId> (the record, 90 days), apply:queue (task ids), apply:usage:YYYY-MM. */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { CODE, ID, safeEqual, bearer } from './todo.js';
import { anthropic, MODEL, bumpUsage, dayOf } from './intake.js';
import { noDashes } from './others.js';
import { putEvent } from './events.js';

export const CVS_KEY = 'apply:cvs';
export const QUEUE_KEY = 'apply:queue';
export const MIN_TEXT = 400;
export const MAX_POSTING = 20000;
export const MAX_EXAMPLE = 6000;
const KEEP_DAYS = 90;
const MAX_FOLDER = 200;
const APPLY = /^Apply:/i;

const stub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
const recKey = (id) => 'apply:r:' + id;
const ttl = { expirationTtl: KEEP_DAYS * 24 * 3600 };

/* ---------- Reading a vacancy page (pure; the PC uses it too) ---------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
const plain = (html) => decode(String(html).replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '\n- ').replace(/<[^>]+>/g, ' '))
  .replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n[ \n]*/g, '\n').trim();

/* The first complete JSON value in a string; some sites put more after it in the same tag. */
function firstJson(x) {
  const start = x.search(/[{[]/);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < x.length; i++) {
    const c = x[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) { try { return JSON.parse(x.slice(start, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}

/* A page's HTML -> { title, organisation, text }. JobPosting data first, the page's text otherwise. */
export function postingFromHtml(html) {
  for (const m of String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const j = firstJson(m[1]);
    const all = j ? [].concat(j['@graph'] || j) : [];
    for (const o of all) {
      if (o && o['@type'] === 'JobPosting' && o.description) {
        const org = o.hiringOrganization && (o.hiringOrganization.name || o.hiringOrganization);
        return { title: decode(o.title || ''), organisation: typeof org === 'string' ? decode(org).replace(/^werken bij\s+/i, '') : '', text: plain(o.description).slice(0, MAX_POSTING) };
      }
    }
  }
  const body = String(html).replace(/<(script|style|nav|header|footer|noscript)[\s\S]*?<\/\1>/gi, ' ');
  const t = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  return { title: decode(t).trim(), organisation: '', text: plain(body).slice(0, MAX_POSTING) };
}

/* ---------- The draft ---------- */

const Draft = (keys) => z.object({
  cv: z.enum(keys).describe('the CV version that fits this vacancy best'),
  fit: z.number().int().describe('1 to 10: how well Paul fits what the vacancy asks, honestly'),
  fit_line: z.string().max(200).describe('one sentence, English: why that score'),
  gaps: z.array(z.string().max(160)).max(3).describe('up to three things the vacancy asks that the CV does not show, English, each with a short tip how to cover it'),
  asks: z.array(z.string().max(80)).max(8).describe('the documents the vacancy asks to upload or send, in English (e.g. "CV", "Motivation letter", "Diploma", "Grade list", "VOG"); [] when it does not say'),
  deadline: z.string().nullable().describe('the closing date as YYYY-MM-DD when the vacancy states one, else null'),
  lang: z.enum(['nl', 'en']).describe('the language of the vacancy text'),
  letter: z.string().max(4000).describe('the cover letter, in the vacancy language'),
});

export function systemFor(cvs) {
  return [
    'You help Paul apply for jobs. You get his CV versions below, one vacancy, and sometimes past motivation letters he wrote himself. You never send anything; Paul reads, edits and sends the letter himself.',
    '1. Pick the CV version that fits the vacancy best (a Defensie vacancy: the Defensie version; NATO or international: the NAVO version; other Dutch employers: the Dutch master; English vacancies: the English master), unless the content clearly says otherwise.',
    '2. Score the fit 1 to 10 against the hard requirements (education level, years, clearances, languages, nationality) and the tasks. Be honest: a missing hard requirement caps the score at 4.',
    '3. Name up to three gaps: what the vacancy asks that the CV does not show, each with a short, practical tip.',
    '4. List the documents the vacancy asks for, and its closing date if it states one.',
    '5. Write the cover letter in the language of the vacancy (Dutch vacancy: Dutch, formal "u"). About 250 to 330 words, four short paragraphs: why this role, two concrete matches backed by the CV, how he handles the main gap or what he brings extra, a short close.',
    '   When past letters are given, match their voice, sentence length and way of opening and closing; do not copy their sentences or their facts about other employers.',
    '   Start with "Geachte heer/mevrouw," (or "Dear Sir or Madam,") unless the vacancy names a contact person; then use that name. End with "Met vriendelijke groet," or "Kind regards," and then "Paul Ortiz Marín" on its own line.',
    '   Use only facts in the chosen CV. Never invent degrees, dates, employers, numbers, clearances or skills. Plain, confident, not salesy. Never use dashes as punctuation; use commas or full stops.',
    '',
    'Paul\'s CV versions:',
    ...cvs.map((c) => `\n<cv key="${c.key}" label="${c.label}" lang="${c.lang}">\n${c.text}\n</cv>`),
  ].join('\n');
}

export async function writeApplication(env, { cvs, posting, task, examples = [] }) {
  const past = examples.map((e, i) => `<past_letter n="${i + 1}">\n${e}\n</past_letter>`).join('\n');
  const res = await anthropic(env).beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: 'text', text: systemFor(cvs), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: (past ? 'Past letters Paul wrote, for his voice only:\n' + past + '\n\n' : '') +
      `The task: ${task}\nVacancy title: ${posting.title || 'unknown'}\nOrganisation: ${posting.organisation || 'unknown'}\n\nVacancy text:\n${posting.text}` }],
    output_config: { effort: 'high', format: zodOutputFormat(Draft(cvs.map((c) => c.key))) },
    fallbacks: 'default',
    betas: ['server-side-fallback-2026-07-01'],
  });
  const usage = {
    input: res.usage?.input_tokens ?? 0,
    output: res.usage?.output_tokens ?? 0,
    cacheRead: res.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: res.usage?.cache_creation_input_tokens ?? 0,
  };
  if (res.stop_reason === 'refusal' || !res.parsed_output) return { error: 'could not write a draft', usage };
  return { out: res.parsed_output, usage };
}

let writer = writeApplication;
export function _setApplier(fn) { writer = fn || writeApplication; }

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* Pure: Claude's answer -> the draft kept and shown. */
export function toDraft(out, cvs, posting, { url, now, examples = 0 }) {
  const cv = cvs.find((c) => c.key === out.cv) || cvs[0];
  return {
    at: new Date(now).toISOString(),
    url: url || null,
    title: posting.title || null,
    organisation: posting.organisation || null,
    cv: cv.key,
    cvLabel: cv.label,
    fit: Math.min(10, Math.max(1, Math.round(Number(out.fit) || 1))),
    fitLine: noDashes(out.fit_line || ''),
    gaps: (out.gaps || []).slice(0, 3).map((g) => noDashes(g)),
    asks: (out.asks || []).slice(0, 8).map((a) => String(a).trim()).filter(Boolean),
    deadline: typeof out.deadline === 'string' && DATE.test(out.deadline) ? out.deadline : null,
    lang: out.lang === 'en' ? 'en' : 'nl',
    letter: String(out.letter || '').split('\n').map((l) => noDashes(l)).join('\n').trim(),
    examples,
  };
}

/* ---------- Storage ---------- */

async function readQueue(env) {
  const q = await env.HUB_KV.get(QUEUE_KEY, 'json');
  return Array.isArray(q) ? q : [];
}
async function writeQueue(env, q) {
  await env.HUB_KV.put(QUEUE_KEY, JSON.stringify(q.slice(-50)));
}
async function readTask(env, id) {
  const items = (await (await stub(env).fetch('https://list/read')).json()).items || [];
  return items.find((i) => i.id === id) || null;
}
const isApplyTask = (t) => !!t && !t.done && (APPLY.test(t.text) || !!t.link);

/* ---------- The routes ---------- */

async function readBodyJson(request, max) {
  const raw = await request.text();
  if (raw.length > max) return { error: 'too large', status: 413 };
  if (!raw) return { body: {} };
  try { return { body: JSON.parse(raw) || {} }; } catch (e) { return { error: 'bad json', status: 400 }; }
}

async function handlePc(request, env, rest, json, now) {
  if (!env.APPLY_PC_TOKEN || !safeEqual(bearer(request), env.APPLY_PC_TOKEN)) return json({ error: 'unauthorized' }, request, 401);
  if (rest.length === 1 && rest[0] === 'queue' && request.method === 'GET') {
    const ids = await readQueue(env);
    const recs = await Promise.all(ids.map((id) => env.HUB_KV.get(recKey(id), 'json')));
    const jobs = [];
    for (let i = 0; i < ids.length; i++) {
      const t = await readTask(env, ids[i]);
      if (recs[i] && recs[i].state === 'queued' && isApplyTask(t)) jobs.push({ taskId: ids[i], text: t.text, link: t.link || null, queuedAt: recs[i].queuedAt });
    }
    return json({ jobs }, request);
  }
  if (rest.length !== 2 || !ID.test(rest[0]) || request.method !== 'POST') return json({ error: 'not found' }, request, 404);
  const [taskId, what] = rest;
  const rec = await env.HUB_KV.get(recKey(taskId), 'json');
  if (!rec || rec.state !== 'queued') return json({ error: 'not queued' }, request, 409);
  const got = await readBodyJson(request, MAX_POSTING + 4 * MAX_EXAMPLE + 2000);
  if (got.error) return json({ error: got.error }, request, got.status);
  const body = got.body;

  if (what === 'draft') {
    const task = await readTask(env, taskId);
    if (!isApplyTask(task)) return json({ error: 'not an open Apply task' }, request, 404);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'not configured' }, request, 503);
    const store = await env.HUB_KV.get(CVS_KEY, 'json');
    const cvs = store && Array.isArray(store.versions) ? store.versions.filter((c) => c && c.key && c.text) : [];
    if (!cvs.length) return json({ error: 'no CVs on file' }, request, 503);
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_POSTING) : '';
    if (text.length < MIN_TEXT) return json({ error: 'vacancy text too short' }, request, 400);
    const posting = { title: String(body.title || '').slice(0, 200), organisation: String(body.organisation || '').slice(0, 120), text };
    const examples = (Array.isArray(body.examples) ? body.examples : []).filter((e) => typeof e === 'string' && e.trim()).slice(0, 2).map((e) => e.trim().slice(0, MAX_EXAMPLE));
    let res;
    try {
      res = await writer(env, { cvs, posting, task: task.text, examples });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) return json({ error: 'api rate limit, try again in a minute' }, request, 429);
      if (e instanceof Anthropic.APIError) return json({ error: 'api error' }, request, 502);
      return json({ error: 'could not write a draft' }, request, 502); // an answer that broke the schema: the PC tries again next run
    }
    if (res.usage) await bumpUsage(env, dayOf(now).slice(0, 7), res.usage, 'apply').catch(() => {});
    if (res.error) return json({ error: res.error }, request, 502);
    const draft = toDraft(res.out, cvs, posting, { url: task.link, now, examples: examples.length });
    await env.HUB_KV.put(recKey(taskId), JSON.stringify({ ...rec, draft }), ttl);
    return json({ draft }, request);
  }

  if (what === 'ready') {
    const folder = typeof body.folder === 'string' ? body.folder.replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_FOLDER) : '';
    if (!folder) return json({ error: 'folder required' }, request, 400);
    if (!rec.draft) return json({ error: 'no draft yet' }, request, 409);
    await env.HUB_KV.put(recKey(taskId), JSON.stringify({ ...rec, state: 'ready', folder, readyAt: new Date(now).toISOString() }), ttl);
    await writeQueue(env, (await readQueue(env)).filter((x) => x !== taskId));
    const name = rec.draft.title || rec.draft.organisation || 'a vacancy';
    await putEvent(env, { source: 'pc', kind: 'note', who: 'PC', text: `Application folder ready: ${name}`.slice(0, 140), at: new Date(now).toISOString() }, now).catch(() => {});
    return json({ state: 'ready' }, request);
  }
  return json({ error: 'not found' }, request, 404);
}

export async function handleApply(request, env, rest, json, now = Date.now()) {
  if (rest[0] === 'pc') return handlePc(request, env, rest.slice(1), json, now);
  if (rest.length !== 2 || !CODE.test(rest[0])) return json({ error: 'not found' }, request, 404);
  if (!env.TODO_CODE || !safeEqual(rest[0], env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  const taskId = rest[1];
  if (!ID.test(taskId)) return json({ error: 'bad task id' }, request, 400);
  const rec = await env.HUB_KV.get(recKey(taskId), 'json');

  if (request.method === 'GET') {
    if (!rec) return json({ state: 'none' }, request);
    return json({ state: rec.state, queuedAt: rec.queuedAt, folder: rec.folder || null, draft: rec.draft || null }, request);
  }
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  if (!isApplyTask(await readTask(env, taskId))) return json({ error: 'not an open Apply task' }, request, 404);
  if (rec && rec.state === 'queued') return json({ state: 'queued', queuedAt: rec.queuedAt }, request);
  const queuedAt = new Date(now).toISOString();
  await env.HUB_KV.put(recKey(taskId), JSON.stringify({ state: 'queued', queuedAt }), ttl);
  const q = await readQueue(env);
  if (!q.includes(taskId)) await writeQueue(env, [...q, taskId]);
  return json({ state: 'queued', queuedAt }, request);
}
