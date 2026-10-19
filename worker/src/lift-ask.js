/* Lift's Ask: Paul types a gym question in Lift ("what's good for hamstrings with dumbbells") and
 * Claude answers with a few exercises, named as they are in his library where one fits, so the
 * phone can show their photos and add them to a routine (Paul, 2026-10-19: "finding out which
 * exercises would be good").
 *
 *   POST /api/lift/:code/ask   <- { question, library: [name], recent: [{ name, muscle, sets }], routines: [{ name, items: [name] }] }
 *                              -> { answer, picks: [{ name, why }] }
 *
 * library = the exercises in his own list (built-ins and his own); recent = what he did in the last
 * four weeks with the work-set count; routines = his rotation. Nothing is stored here except the
 * token count (KV lift-ask:usage:YYYY-MM). */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { anthropic, bumpUsage, dayOf } from './intake.js';
import { keptFor, lessonsText } from './lessons.js';

export const ASK_MODEL = 'claude-opus-5-5';
const MAX_BODY = 60000;

const Ask = z.object({
  answer: z.string().max(700).describe('two to four short sentences, plain words'),
  picks: z.array(z.object({
    name: z.string().max(80).describe('the exercise name, exactly as in the library when it is there'),
    why: z.string().max(160).describe('one short line: why this one, sets x reps to start with'),
  })).max(6),
});

/* Frozen per deploy, cached. The question and Paul's data go in the user message. */
export const SYSTEM = [
  'You help Paul pick gym exercises in his workout app, Lift. He trains in a regular gym with barbells, dumbbells, cables and machines.',
  'Answer his question in two to four short sentences, in plain words, in the language he asked in. Then give two to six exercises as picks, best first.',
  'For each pick, use the exercise name exactly as written in his library when a fitting one is there. Only when none fits, use the common gym name for it (for example "Nordic Hamstring Curl").',
  'Each pick gets one short line: why it fits, and a starting point such as "3 x 8-12".',
  'Use what he did in the last four weeks and his routines: prefer exercises that fill a gap, and do not suggest one he already does a lot unless he asks about it.',
  'If he mentions pain or an injury, keep to gentle, well-known options and say in one sentence that a physio should look at pain that stays. No diagnosis.',
  'No hype, no emoji.',
].join('\n');

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/* Pure: what the phone sent -> known shapes, or { error }. */
export function cleanAsk(b) {
  const question = str(b && b.question, 500);
  if (!question) return { error: 'question required' };
  const library = [...new Set((Array.isArray(b.library) ? b.library : []).map((n) => str(n, 80)).filter(Boolean))].slice(0, 400);
  const recent = (Array.isArray(b.recent) ? b.recent : []).slice(0, 80).map((r) => ({
    name: str(r && r.name, 80), muscle: str(r && r.muscle, 20), sets: Math.max(0, Math.min(999, Math.round(Number(r && r.sets) || 0))),
  })).filter((r) => r.name);
  const routines = (Array.isArray(b.routines) ? b.routines : []).slice(0, 12).map((r) => ({
    name: str(r && r.name, 60), items: (Array.isArray(r && r.items) ? r.items : []).slice(0, 20).map((n) => str(n, 80)).filter(Boolean),
  })).filter((r) => r.name);
  return { question, library, recent, routines };
}

/* Pure: Claude's answer -> what the phone shows. Empty picks go, names are not repeated. */
export function cleanAnswer(out) {
  const answer = str(out && out.answer, 700);
  const seen = new Set();
  const picks = [];
  for (const p of (out && out.picks) || []) {
    const name = str(p && p.name, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    picks.push({ name, why: str(p && p.why, 160) });
  }
  return { answer, picks: picks.slice(0, 6) };
}

export async function askLift(env, input) {
  const { question, library, recent, routines } = input;
  const rules = lessonsText(await keptFor(env, 'lift')); // Paul's kept rules, src/lessons.js
  const system = [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }];
  if (rules) system.push({ type: 'text', text: rules });
  const res = await anthropic(env).messages.parse({
    model: ASK_MODEL,
    max_tokens: 8000,
    system,
    messages: [{
      role: 'user',
      content: `His library: ${library.join('; ')}\n`
        + `Last four weeks (work sets): ${recent.length ? recent.map((r) => `${r.name} (${r.muscle}) ${r.sets}`).join('; ') : 'nothing logged'}\n`
        + `Routines, in rotation order: ${routines.length ? routines.map((r) => `${r.name}: ${r.items.join(', ')}`).join(' | ') : 'none yet'}\n\n`
        + `His question: ${question}`,
    }],
    output_config: { effort: 'low', format: zodOutputFormat(Ask) },
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

let asker = askLift;
export function _setAsker(fn) { asker = fn || askLift; }

/* Called by handleLift for POST /api/lift/:code/ask once the code checked out. */
export async function handleLiftAsk(request, env, json, now = Date.now()) {
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'not configured' }, request, 503);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, request, 413);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad json' }, request, 400); }
  const input = cleanAsk(body);
  if (input.error) return json({ error: input.error }, request, 400);
  let got;
  try {
    got = await asker(env, input);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'api rate limit' }, request, 429);
    return json({ error: 'could not answer' }, request, 502);
  }
  if (got.usage) await bumpUsage(env, dayOf(now).slice(0, 7), got.usage, 'lift-ask').catch(() => {});
  const out = cleanAnswer(got.out);
  if (!out.answer && !out.picks.length) return json({ error: 'no answer' }, request, 502);
  return json(out, request);
}
