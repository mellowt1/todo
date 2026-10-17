/* Tidy: a task Paul types comes back clean (Paul, 2026-10-17: "format what I input so it looks
 * clean, like the letter tasks").
 *
 *   POST /api/tidy/:code   <- { text }  -> { text, changed }
 *
 * The app adds the task as typed at once, then asks here. Claude fixes typos, makes it a short
 * task in the language Paul typed it in, and turns a day or date in it into the list's date
 * ending (" · YYYY-MM-DD", which the app shows as a small label). Names, numbers and a leading
 * "Name:" or "Apply:" stay as they are. The app writes the tidy text and offers Undo; this route
 * writes nothing. KV: tidy:usage:YYYY-MM. */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { CODE, safeEqual, MAX_TEXT, cleanText } from './todo.js';
import { anthropic, bumpUsage, dayOf } from './intake.js';

export const TIDY_MODEL = 'claude-haiku-5-5';
import { local, addDays } from './morning.js';
import { noDashes } from './mask.js';
import { keptFor, lessonsText } from './lessons.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DUE_END = /\s*·\s*(\d{4}-\d{2}-\d{2})$/;
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const Tidy = z.object({
  name: z.string().max(300).describe('the task, clean, without any day or date in it'),
  due: z.string().nullable().describe('YYYY-MM-DD when the line names a day or date, else null'),
});

/* Frozen per deploy. Today's date goes in the user message. */
export const SYSTEM = [
  'You tidy one line Paul typed into his to-do list. Return the task clean and short, in the same language he typed it in (Dutch, English or Spanish). Never translate.',
  'Fix spelling mistakes and typos. Start with a capital letter. No full stop at the end. Keep it short: drop filler such as "remind me to", "I need to", "don\'t forget to", "ik moet nog".',
  'Write it as a plain task, usually starting with the verb ("Call the gemeente about the parking permit"). Keep his words where they are already clear; do not make it formal.',
  'Keep names, places, numbers, amounts and codes exactly as typed. Keep a leading "Name:" (a task done for someone) or "Apply:" as it is.',
  'If the line names a day or date (today, tomorrow, Friday, next week, 31 Oct, vrijdag, morgen, volgende week, el lunes), take it out of the name and give it as due, counted from today. A weekday means the next one after today; "next week" means next Monday. Otherwise due is null.',
  'Never add anything he did not write. If the line is already clean, return it unchanged.',
  'Check every word for spelling, also short ones. Examples (today Saturday 2026-10-17):',
  '"dad: fix his printr" -> name "Dad: fix his printer", due null',
  '"remind me to buy cat food tmrw" -> name "Buy cat food", due "2026-10-18"',
  '"bel de huisarts volgende week" -> name "Bel de huisarts", due "2026-10-19"',
].join('\n');

export async function tidyLine(env, text, now) {
  const l = local(now);
  // Haiku (Paul chose it for cost, 2026-10-17): a one-line tidy needs no more. Haiku has no
  // server-side refusal fallback; a refusal just leaves the task as typed.
  const rules = lessonsText(await keptFor(env, 'tidy')); // Paul's kept rules, src/lessons.js
  const res = await anthropic(env).messages.parse({
    model: TIDY_MODEL,
    max_tokens: 2000,
    system: rules ? SYSTEM + '\n' + rules : SYSTEM,
    messages: [{ role: 'user', content: `Today is ${WEEKDAY[l.weekday]} ${l.date}.\nThe line: ${text}` }],
    output_config: { effort: 'low', format: zodOutputFormat(Tidy) },
  });
  const usage = {
    input: res.usage?.input_tokens ?? 0,
    output: res.usage?.output_tokens ?? 0,
    cacheRead: res.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: res.usage?.cache_creation_input_tokens ?? 0,
  };
  if (res.stop_reason === 'refusal' || !res.parsed_output) return { usage };
  return { out: res.parsed_output, usage };
}

let tidier = tidyLine;
export function _setTidier(fn) { tidier = fn || tidyLine; }

/* Pure: Claude's answer -> the list's text. A due date must be real and not far in the past;
 * one the line already carried wins when Claude found none. */
export function toText(out, typed, today) {
  const kept = typed.match(DUE_END);
  let name = noDashes(String((out && out.name) || '')).replace(/[.]+$/, '').trim();
  if (!name) return typed;
  name = name.charAt(0).toUpperCase() + name.slice(1);
  let due = out && typeof out.due === 'string' && DATE.test(out.due) && !Number.isNaN(Date.parse(out.due)) ? out.due : null;
  if (due && due < addDays(today, -1)) due = null;
  if (!due && kept) due = kept[1];
  const tail = due ? ' · ' + due : '';
  return (cleanText(name.slice(0, MAX_TEXT - tail.length) + tail) || typed);
}

export async function handleTidy(request, env, rest, json, now = Date.now()) {
  if (rest.length !== 1 || !CODE.test(rest[0])) return json({ error: 'not found' }, request, 404);
  if (!env.TODO_CODE || !safeEqual(rest[0], env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'not configured' }, request, 503);
  const raw = await request.text();
  if (raw.length > 2000) return json({ error: 'too large' }, request, 413);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad json' }, request, 400); }
  const typed = cleanText(body && body.text);
  if (!typed) return json({ error: 'text required' }, request, 400);
  if (/\[intake\]$/.test(typed)) return json({ text: typed, changed: false }, request); // Intake's own tasks are tidy already

  let got;
  try {
    got = await tidier(env, typed, now);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'api rate limit' }, request, 429);
    return json({ error: 'could not tidy' }, request, 502);
  }
  if (got.usage) await bumpUsage(env, dayOf(now).slice(0, 7), got.usage, 'tidy').catch(() => {});
  if (!got.out) return json({ text: typed, changed: false }, request);
  const text = toText(got.out, typed, local(now).date);
  return json({ text, changed: text !== typed }, request);
}
