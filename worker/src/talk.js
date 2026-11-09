/* Talk points: Feeling's entries since the last session come back as a few short bullets Paul can
 * read at the psychologist (Paul, 2026-10-18: "so when I'm at the psychologist I know immediately
 * what I need to talk about").
 *
 *   POST /api/talk/:code   <- { range, entries: [{ day, time, mood, text, bring }] }
 *                          -> { sections: [{ title, items: [string] }] }
 *
 * Feeling builds a plain version on the phone; this one is only asked when Paul taps "Write with
 * Claude" there. The entries pass through to Claude and back. Nothing is stored here except the
 * token count (KV talk:usage:YYYY-MM). */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { CODE, safeEqual } from './todo.js';
import { anthropic, bumpUsage, dayOf } from './intake.js';
import { DUE_END } from './tidy.js';
import { maskSecrets } from './mask.js';
import { local, addDays } from './morning.js';

export const TALK_MODEL = 'claude-opus-5-5';
const MAX_BODY = 160000;
const MAX_ENTRIES = 400;
const MOODS = new Set(['very bad', 'bad', 'okay', 'good', 'very good', 'angry', '']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

const Talk = z.object({
  sections: z.array(z.object({
    title: z.string().max(60),
    items: z.array(z.string().max(220)).max(5),
  })).max(5),
});

/* Frozen per deploy, cached. The entries go in the user message. */
export const SYSTEM = [
  'Paul keeps a mood journal in his Feeling app. Each entry has a day, a time, a mood (very bad, bad, okay, good, very good, or angry) and what he wrote. Some entries are marked bring: true, which means he flagged them himself to bring up.',
  'He is about to see his psychologist. Turn the entries into short talk points he can glance at in the room and know at once what to talk about.',
  'Sections, in this order, leaving out any that would be empty:',
  '1. "Important to mention": only if an entry mentions not wanting to be here, hurting himself, or feeling unsafe. Say it plainly in one bullet with the day. Never skip this when it applies.',
  '2. "You flagged": every entry marked bring: true, one bullet each, with the day.',
  '3. "What weighed most": the two to four heaviest things, each as one bullet that names the situation and the feeling, with the days it came up.',
  '4. "Patterns": things that repeat (a time of day, a trigger, a person, sleep, work), or a change compared with earlier in the range. Only what the entries show.',
  '5. "What helped": what went well or made things lighter.',
  'Write in the first person, as notes Paul wrote for himself ("I froze when the work email came in at 21:00 (Thu 8 Oct)"). Write in the language most of the entries are in.',
  'Keep each bullet under 25 words. Use his own words where they are strong. Days as "Thu 8 Oct".',
  'Only use what is in the entries. No advice, no diagnosis, no labels, no reassurance, no questions to him. Do not soften or dramatise.',
].join('\n');

/* 'YYYY-MM-DD' -> 'Thu 8 Oct', so Claude never works out a weekday itself. */
export function dayLabel(k) {
  const d = new Date(k + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }) + ' ' + d.getUTCDate() + ' ' + 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[d.getUTCMonth()];
}

export async function writeTalk(env, { range, entries }) {
  const rows = entries.map((e) => ({ ...e, day: dayLabel(e.day) }));
  const res = await anthropic(env).messages.parse({
    model: TALK_MODEL,
    max_tokens: 4000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Range: ${range}\nEntries, oldest first (JSON):\n${JSON.stringify(rows)}` }],
    output_config: { effort: 'medium', format: zodOutputFormat(Talk) },
  });
  const usage = {
    input: res.usage?.input_tokens ?? 0,
    output: res.usage?.output_tokens ?? 0,
    cacheRead: res.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: res.usage?.cache_creation_input_tokens ?? 0, model: res.model,
  };
  if (res.stop_reason === 'refusal' || !res.parsed_output) return { usage };
  return { out: res.parsed_output, usage };
}

let writer = writeTalk;
export function _setTalker(fn) { writer = fn || writeTalk; }

/* Pure: what the phone sent -> clean entries, oldest first. Anything malformed is dropped. */
export function cleanEntries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list.slice(0, MAX_ENTRIES)) {
    if (!e || !DAY.test(e.day) || !TIME.test(e.time || '00:00')) continue;
    const mood = typeof e.mood === 'string' && MOODS.has(e.mood) ? e.mood : '';
    const text = typeof e.text === 'string' ? e.text.replace(/\s+/g, ' ').trim().slice(0, 4000) : '';
    if (!mood && !text) continue;
    const row = { day: e.day, time: e.time || '00:00', mood, text };
    if (e.bring === true) row.bring = true;
    out.push(row);
  }
  return out.sort((a, b) => (a.day + a.time < b.day + b.time ? -1 : 1));
}

/* Pure: Claude's answer -> what the phone shows. Empty sections and items are dropped. */
export function cleanSections(out) {
  const secs = [];
  for (const s of (out && out.sections) || []) {
    const items = (s.items || []).map((i) => String(i).replace(/\s+/g, ' ').trim()).filter(Boolean);
    const title = String(s.title || '').trim();
    if (title && items.length) secs.push({ title, items });
  }
  return secs;
}

/* Next session (Paul, 2026-11-09: Feeling "will be able to see when my next appointment is with my
 * psychologist" and has the flagged things ready for it).
 *
 *   GET /api/talk/:code/next  -> { next: { title, kind, date, time } | null, past: ['YYYY-MM-DD'], at }
 *
 * A session is a dated to-do (" · YYYY-MM-DD[ HH:MM]", src/tidy.js) whose name holds a name from the
 * SESSION_NAMES secret ("Name=kind,Name=kind"; the names stay out of this public repo) or a word
 * like psychologist, psycholoog, psychiater or therapist. `next` is the first open one that has not
 * ended (start + SESSION_OPEN_MIN); `past` holds the days of the ones that have, so Feeling marks
 * them as sessions by itself. Nothing from Feeling is sent or kept. */
export const SESSION_OPEN_MIN = 90;
export const SESSION_PAST_DAYS = 120;
const SESSION_WORDS = [
  [/\bpsycholo/i, 'psychologist'],
  [/\bpsychiat/i, 'psychiatrist'],
  [/\btherap/i, 'therapist'],
  [/\bggz\b/i, 'session'],
];
const SESSION_KINDS = new Set(['psychologist', 'psychiatrist', 'therapist', 'session']);
const SESSION_INTAKE = /\s*\[intake\]$/;

/* Pure: "Name=psychologist, Other=psychiatrist" -> [[RegExp, kind]]. Unknown kinds become 'session'. */
export function sessionNames(raw) {
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const [name, kind] = part.split('=').map((s) => (s || '').trim());
    if (!/^[\p{L}][\p{L}' -]{1,40}$/u.test(name || '')) continue;
    const k = (kind || '').toLowerCase();
    out.push([new RegExp('(^|[^\\p{L}])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}])', 'iu'), SESSION_KINDS.has(k) ? k : 'session']);
  }
  return out;
}

/* Pure: a task's name -> its kind of session, or null. Names from the secret win over the words. */
export function sessionKind(title, names = []) {
  for (const [re, kind] of [...names, ...SESSION_WORDS]) if (re.test(title)) return kind;
  return null;
}

/* Pure: the list's items + now in Amsterdam ({ date, minutes }) -> { next, past }. */
export function sessionsFrom(items, names, now) {
  const from = addDays(now.date, -SESSION_PAST_DAYS);
  const ended = (date, time) => {
    if (date !== now.date) return date < now.date;
    if (!time) return false; // a whole-day one stays on until the day is over
    const [h, m] = time.split(':').map(Number);
    return now.minutes >= h * 60 + m + SESSION_OPEN_MIN;
  };
  let next = null;
  const past = new Set();
  for (const it of items || []) {
    if (!it || typeof it.text !== 'string') continue;
    const text = it.text.replace(SESSION_INTAKE, '');
    const m = text.match(DUE_END);
    if (!m || Number.isNaN(Date.parse(m[1]))) continue;
    const title = maskSecrets(text.slice(0, m.index)).trim().slice(0, 60);
    const kind = title && sessionKind(title, names);
    if (!kind) continue;
    const date = m[1], time = m[2] ? m[2] + ':' + m[3] : null;
    if (ended(date, time)) { if (date >= from) past.add(date); continue; }
    if (it.done) continue;
    if (!next || date + (time || '24') < next.date + (next.time || '24')) next = { title, kind, date, time };
  }
  return { next, past: [...past].sort() };
}

async function nextSession(env, now) {
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
  const d = await (await stub.fetch('https://list/read')).json();
  if (!Array.isArray(d.items)) throw new Error('no items');
  return { ...sessionsFrom(d.items, sessionNames(env.SESSION_NAMES), local(now)), at: now };
}

export async function handleTalk(request, env, rest, json, now = Date.now()) {
  if (rest.length < 1 || rest.length > 2 || !CODE.test(rest[0])) return json({ error: 'not found' }, request, 404);
  if (!env.TODO_CODE || !safeEqual(rest[0], env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (rest.length === 2) {
    if (rest[1] !== 'next') return json({ error: 'not found' }, request, 404);
    if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
    try { return json(await nextSession(env, now), request); } catch (e) { return json({ error: 'list unavailable' }, request, 502); }
  }
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'not configured' }, request, 503);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, request, 413);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad json' }, request, 400); }
  const entries = cleanEntries(body && body.entries);
  if (!entries.length) return json({ error: 'entries required' }, request, 400);
  const range = typeof body.range === 'string' ? body.range.slice(0, 80) : '';

  let got;
  try {
    got = await writer(env, { range, entries });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'api rate limit' }, request, 429);
    return json({ error: 'could not write' }, request, 502);
  }
  if (got.usage) await bumpUsage(env, dayOf(now).slice(0, 7), got.usage, 'talk').catch(() => {});
  const sections = cleanSections(got.out);
  if (!sections.length) return json({ error: 'no answer' }, request, 502);
  return json({ sections }, request);
}
