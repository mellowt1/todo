/* Tidy: a task Paul types comes back clean (Paul, 2026-10-17: "format what I input so it looks
 * clean, like the letter tasks").
 *
 *   POST /api/tidy/:code   <- { text }  -> { text, changed }
 *
 * The app adds the task as typed at once, then asks here. Claude fixes typos, makes it a short
 * task in the language Paul typed it in, and turns a day or date in it into the list's date
 * ending (" · YYYY-MM-DD", which the app shows as a small label), with " HH:MM" after it when
 * the line names a clock time (2026-10-19: Day plans dated tasks, src/dayplan.js). Names, numbers and a leading
 * "Name:" or "Apply:" stay as they are. The app writes the tidy text and offers Undo; this route
 * writes nothing. KV: tidy:usage:YYYY-MM.
 *
 * Desk folded in (Paul, 2026-10-19: "I don't really know when to use Desk"): the answer also says
 * what the line is. kind "task" is the default; "ask" is a question for Claude, "write" asks Claude
 * to write a message. For those two the text comes back as typed, and the app takes the line out
 * of the list again and sends it to Desk (POST /api/desk/:code), which answers or drafts in a
 * sheet. One place to type.
 *
 * Where it goes and what it is (Paul, 2026-11-04, after a psychologist visit typed with no date
 * never reached Day): the same answer also gives a place (Today, Soon, Someday or a lane) and
 * whether the line is an appointment. The app moves a new task only when it was typed on Today
 * (or the Lanes tab, then only between lanes); typed anywhere else it stays where Paul put it.
 * An appointment with no date stays in Today, on top, labelled "No date yet", and Day lists it
 * until a date is added (src/dayplan.js). Paul's recent corrections of these answers (D1 feedback,
 * src/lessons.js recentFor) go into each call as examples, so the next similar line lands right
 * without waiting for the Sunday rules. Still one Haiku call per line.
 *
 *   -> { text, changed, kind, energy, place, appt, skill, repeat? }   place null: leave it where it is
 *
 * The skill (Paul, 2026-11-04: "not every task is woodcutting, it can be a task plus job
 * application"): the OSRS skill the task trains besides Woodcutting (TASK_SKILLS, src/hiscores.js
 * pays it on the tick), or null for an ordinary task. The same call; SKILL_LINES says which is which.
 *
 * Repeats in words (weekly fix 2026-11-08, after Paul edited "Uren sturen werk" into "Uren sturen
 * werk every week"): "every week", "elke 2 weken", "cada mes" and the like make it a repeat
 * (repeatOf, no extra call). The words leave the text, a date is added when there is none (today,
 * as the edit sheet's Repeat does), and the answer carries repeat "week" | "2weeks" | "month". */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { CODE, safeEqual, MAX_TEXT, cleanText, LANES, TASK_SKILLS } from './todo.js';
import { anthropic, bumpUsage, dayOf } from './intake.js';

export const TIDY_MODEL = 'claude-haiku-5-5';
import { local, addDays } from './morning.js';
import { noDashes } from './mask.js';
import { keptFor, lessonsText, recentFor, examplesText } from './lessons.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// The list's date ending, its time optional. src/dayplan.js and app/app.js (DUE) read the same.
export const DUE_END = /\s*·\s*(\d{4}-\d{2}-\d{2})(?: ([01]\d|2[0-3]):([0-5]\d))?$/;
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const Tidy = z.object({
  name: z.string().max(300).describe('the task, clean, without any day or date in it'),
  due: z.string().nullable().describe('YYYY-MM-DD when the line names a day or date, else null'),
  time: z.string().nullable().describe('HH:MM, 24-hour, when the line names a clock time, else null'),
  kind: z.enum(['task', 'ask', 'write']).describe('task: something to do or remember (the default). ask: a question for Claude to answer now. write: Paul asks Claude to write a message for him'),
  energy: z.enum(['wired', 'normal', 'drained']).describe('the energy the task takes: wired (needs real focus), normal (ordinary, some thinking), drained (small and easy)'),
  place: z.enum(['keep', 'today', 'soon', 'someday', 'build', 'fun', 'others']).describe('where the task belongs; keep when unsure'),
  appointment: z.boolean().describe('true when Paul has to be somewhere, or on a call, at a set moment'),
  skill: z.enum([...TASK_SKILLS, 'none']).describe('the one OSRS skill the task trains besides Woodcutting; none for an ordinary task'),
});

/* What each task skill stands for, in Paul's own tasks (he picked the table, 2026-11-04). Also the
 * prompt of the one-off pass over his old tasks (src/taskskills.js). */
export const SKILL_LINES = [
  'slayer: job hunting: applications, interview prep, networking or follow-ups for a job ("Prep call with JCD", "Jeroen Blom follow up", "Upload Rik notes and send thank you email")',
  'defence: official things: government, bills to pay, insurance, legal, contracts, forms ("Call DUO and RLO", "Pay Energie", "Full evidence for the interpleader", "Cancel Amazon Prime")',
  'thieving: money: banks, claims, credit, refunds, budgets ("Hans claim", "Call Capital One", "Derreck credit check")',
  'herblore: health: medicine, pharmacy, doctors, psychologist, dentist ("Xanax apotheek", "Psychologist visit", "Change doctors")',
  'construction: home, DIY, repairs, furniture, cleaning, the bike ("Waterproof the VanMoof", "Order bed frame", "Deshrink wool sweaters")',
  'smithing: building his own apps and sites, code ("Layout fixes on all new features", "Day doesn\'t pick up the AirPods mic")',
  'crafting: making things by hand, art, costumes, drawing ("Finish foam of Agamemnon and costume", "Draw Saoirse")',
  'cooking: food, cooking, groceries for a meal ("Pumpkin ricotta to Yvonne")',
  'farming: pets and plants ("Deworm cats", "Vet appointment Mani")',
  'sailing: travel, trips, tickets to go somewhere ("Book London", "Book grandpa ticket")',
  'magic: learning, courses, languages ("Dutch on his diploma application")',
  'runecraft: writing: articles, letters, translations, posts ("LinkedIn article", "Translate letter into Dutch")',
  'firemaking: people and social life: invites, replies, birthdays, presents, meeting friends ("Thanksgiving invite", "Answer Chris")',
  'none: anything else ("Upload mom\'s books", "Print Olivia label"). When unsure between a skill and none, none.',
];
export const PLACES = ['today', 'soon', 'someday', ...LANES];
export const KINDS = ['task', 'ask', 'write'];

/* Frozen per deploy. Today's date goes in the user message. */
export const SYSTEM = [
  'You tidy one line Paul typed into his to-do list. Return the task clean and short, in the same language he typed it in (Dutch, English or Spanish). Never translate.',
  'Fix spelling mistakes and typos. Start with a capital letter. No full stop at the end. Keep it short: drop filler such as "remind me to", "I need to", "don\'t forget to", "ik moet nog".',
  'Write it as a plain task, usually starting with the verb ("Call the gemeente about the parking permit"). Keep his words where they are already clear; do not make it formal.',
  'Keep names, brands, places, numbers, amounts and codes exactly as typed (VanMoof is his bike; RVO, SVOM and EZK are work). Keep a leading "Name:" (a task done for someone) or "Apply:" as it is.',
  'If the line names a day or date (today, tomorrow, Friday, next week, 31 Oct, vrijdag, morgen, volgende week, el lunes), take it out of the name and give it as due, counted from today. A weekday means the next one after today; "next week" means next Monday. Otherwise due is null.',
  'If the line names a clock time (14:00, 2pm, half 3, om drie uur, a las 5), take it out of the name too and give it as time, 24-hour HH:MM. A time with no day: due is today if the time is still to come, else tomorrow. Never guess a time from words such as morning or evening. Otherwise time is null.',
  'Never add anything he did not write. If the line is already clean, return it unchanged.',
  'kind: almost every line is "task", also a note to himself phrased as a question ("call mum?", "ask Mark about Saturday", "text Olivia"). Use "ask" only when he asks you a question that wants an answer now ("what do I have on Thursday?", "how long do I boil an egg", "wat is de deadline van de huurtoeslag"). Use "write" only when he asks you to write the words of a message, email or reply for him ("write to the landlord that the heater is broken", "draft a WhatsApp to mum saying I land at 8", "mail de gemeente dat ik verhuisd ben"). When unsure, "task".',
  'energy: your guess at the energy the task takes, which Paul confirms himself. "wired": needs real focus or drive (building, writing, applying for a job, a hard conversation, anything long or new). "normal": an ordinary task with some thinking (a meeting, booking, sorting out an account). "drained": small and easy, fine on a tired evening (buy, text, return, look up one thing). When unsure between two, the lower one.',
  'place: "keep" (the default, and whenever unsure). "build": an idea, bug or feature for one of his own apps or sites (To-do, Day, Morning, Lift, Kitchen, Feeling, Door, Odysseus, Runway, paul-hub, his website). "fun": leisure, games, hobbies, a match to watch. "others": done for or on behalf of someone else (Grandpa, Nick, Olivia, Dad, Mom, a friend); then the name starts with that person and a colon, or keeps the "Name:" he wrote. His own task that only names someone is not others ("Call dad", "Tell Nick to split payments"). "someday" only when he says so (someday, ooit, algún día); "soon" for soon, this week, binnenkort; "today" for today, now. A dated line is "keep" unless it is for a lane.',
  'appointment: true when he has to be somewhere, or on a call or meeting with someone, at a set moment (doctor, psychologist, dentist, vet, haircut, a class, an afspraak or cita, a name with a time like "Peronik 12:45"). False otherwise, also for arranging one ("Book a haircut", "Change doctors") and for calls he can make any time ("Call Capital One"). Never add a date or time an appointment does not have.',
  'skill: the one skill the task trains besides Woodcutting (every task pays that). The main thing the task is about decides:',
  ...SKILL_LINES.map((l) => '- ' + l),
  'Check every word for spelling, also short ones. Examples (today Saturday 2026-10-17):',
  '"dad: fix his printr" -> name "Dad: fix his printer", due null, time null, kind "task", place "others", appointment false',
  '"remind me to buy cat food tmrw" -> name "Buy cat food", due "2026-10-18", time null, kind "task", place "keep", appointment false',
  '"bel de huisarts volgende week" -> name "Bel de huisarts", due "2026-10-19", time null, kind "task", place "keep", appointment false',
  '"dentist friday 2pm" -> name "Dentist", due "2026-10-23", time "14:00", kind "task", place "keep", appointment true',
  '"psychologist visit" -> name "Psychologist visit", due null, time null, kind "task", place "keep", appointment true',
  '"order bed frame for grandpa" -> name "Grandpa: Order bed frame", due null, time null, kind "task", place "others", appointment false',
  '"day doesnt pick up airpods mic" -> name "Day doesn\'t pick up the AirPods mic", due null, time null, kind "task", place "build", appointment false',
  '"text mark about saturday" -> name "Text Mark about Saturday", due null, time null, kind "task", place "keep", appointment false',
  '"what do i have on thursday" -> name "What do I have on Thursday", due null, time null, kind "ask"',
  '"write to the landlord that the heater is broken again" -> name "Write to the landlord that the heater is broken again", due null, time null, kind "write"',
].join('\n');

export async function tidyLine(env, text, now, examples = []) {
  const l = local(now);
  // Haiku (Paul chose it for cost, 2026-10-17): a one-line tidy needs no more. Haiku has no
  // server-side refusal fallback; a refusal just leaves the task as typed.
  const rules = lessonsText(await keptFor(env, 'tidy')); // Paul's kept rules, src/lessons.js
  const res = await anthropic(env).messages.parse({
    model: TIDY_MODEL,
    max_tokens: 2000,
    // Cached (Haiku 5.5 caches from 512 tokens): lines typed one after another read it at a tenth
    // of the price, which keeps the longer prompt (places, appointments) near the old cost.
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }, ...(rules ? [{ type: 'text', text: rules }] : [])],
    // His recent corrections go with the line, not in the frozen system prompt: a few hundred tokens.
    messages: [{ role: 'user', content: (examples.length ? examplesText(examples) + '\n\n' : '') + `Today is ${WEEKDAY[l.weekday]} ${l.date}.\nThe line: ${text}` }],
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
  let time = due && out && typeof out.time === 'string' && TIME.test(out.time) ? out.time : null;
  if (!due && kept) { due = kept[1]; time = kept[2] ? kept[2] + ':' + kept[3] : null; }
  const tail = due ? ' · ' + due + (time ? ' ' + time : '') : '';
  return (cleanText(name.slice(0, MAX_TEXT - tail.length) + tail) || typed);
}

/* Pure: the repeat a line asks for in words, or null. Only "every …" forms (English, Dutch,
 * Spanish): a bare "weekly report" is a name, not a schedule. Longest first. */
const REPEAT_WORDS = [
  ['2weeks', /\b(?:every (?:2|two|other) weeks?|every other week|om de (?:2 |twee )?week|(?:elke|iedere) (?:2|twee) weken|cada (?:2|dos) semanas)\b/i],
  ['week', /\b(?:every week|each week|(?:elke|iedere) week|cada semana|todas las semanas)\b/i],
  ['month', /\b(?:every month|each month|(?:elke|iedere) maand|cada mes|todos los meses)\b/i],
];
export function repeatOf(line) {
  for (const [every, re] of REPEAT_WORDS) if (re.test(line || '')) return every;
  return null;
}

/* Pure: the tidy text with the repeat words taken out, dated today when it has no date yet.
 * Null when the words were the whole task: no task left to repeat, so no repeat. */
export function withRepeat(text, today) {
  const due = text.match(DUE_END);
  let name = due ? text.slice(0, due.index) : text;
  for (const [, re] of REPEAT_WORDS) name = name.replace(new RegExp(re.source, 'gi'), ' ');
  name = (cleanText(name) || '').replace(/[\s,;]+$/, '');
  if (!name) return null;
  name = name.charAt(0).toUpperCase() + name.slice(1);
  const tail = due ? due[0].trim() : '· ' + today;
  return name.slice(0, MAX_TEXT - tail.length - 1) + ' ' + tail;
}

/* Pure: Claude's place and appointment -> where the app puts a new task (null: where it is).
 * Due today or before is Today (the hub would move it there anyway, src/due.js). A lane wins over
 * a later date, except Build and Fun for an appointment: a later date is Soon, and the hub brings
 * it back on its day. An appointment with no date stays in Today, seen until it has one. */
export function toPlace(out, due, today) {
  const p = out && PLACES.includes(out.place) ? out.place : null;
  const appt = !!out && out.appointment === true;
  if (due && due <= today) return 'today';
  if (p && LANES.includes(p) && (!appt || p === 'others')) return p;
  if (due) return 'soon';
  if (appt) return 'today';
  return p;
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
    got = await tidier(env, typed, now, await recentFor(env, typed));
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'api rate limit' }, request, 429);
    return json({ error: 'could not tidy' }, request, 502);
  }
  if (got.usage) await bumpUsage(env, dayOf(now).slice(0, 7), got.usage, 'tidy').catch(() => {});
  if (!got.out) return json({ text: typed, changed: false }, request);
  const kind = KINDS.includes(got.out.kind) ? got.out.kind : 'task';
  if (kind !== 'task') return json({ text: typed, changed: false, kind }, request); // the app hands it to Desk as typed
  const tidied = toText(got.out, typed, local(now).date);
  const repeated = repeatOf(typed) ? withRepeat(tidied, local(now).date) : null;
  const repeat = repeated ? repeatOf(typed) : null; // only the words, nothing to repeat: none
  const text = repeated || tidied;
  // A guess only: the app stores it as energyGuess and Paul confirms it (Energy dial, src/energy.js).
  const energy = ['wired', 'normal', 'drained'].includes(got.out.energy) ? got.out.energy : null;
  const due = (text.match(DUE_END) || [])[1] || null;
  const skill = TASK_SKILLS.includes(got.out.skill) ? got.out.skill : null;
  return json({ text, changed: text !== typed, kind, energy, place: toPlace(got.out, due, local(now).date), appt: got.out.appointment === true, skill, ...(repeat ? { repeat } : null) }, request);
}
