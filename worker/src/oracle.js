/* The Oracle question (Paul, 2026-10-22; Phase 6): once a week the hub sums up Paul's week from its
 * own data and asks Claude for one short, specific question about it. The question sits on top of
 * the Sunday reset and as one line in Morning until he answers or puts it aside ("Not this week").
 *
 *   GET  /api/oracle/:code           -> { current: { week, label, question, askedAt } | null }
 *   GET  /api/oracle/:code/list      -> { weeks: [{ week, label, question, state, answer, answeredAt }] }  newest first
 *   POST /api/oracle/:code/answer    <- { week, answer, source }     at most MAX_ANSWER characters
 *   POST /api/oracle/:code/aside     <- { week, source }             "Not this week"
 *
 * Paul's answers (2026-10-22): Sunday, the first cron run after 06:00 (with the Sunday paragraph);
 * Claude Opus 5.5 (MODEL, about $0.04 a week); all six fields of the summary (summaryFrom); the
 * system prompt below as he approved it, word for word; "Not this week" allowed. Mail excerpts
 * never go in. The summary goes only to the Claude API. The week is reserved before the call, so a
 * failure shows nothing that week and is logged without content.
 *
 * Stored in D1 `oracle` (migrations/0013); events oracle.asked { week } and oracle.answered
 * { week, aside? }, out of Morning's feed. */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { CODE, safeEqual } from './todo.js';
import { acceptEvent } from './hub.js';
import { anthropic, MODEL, bumpUsage, dayOf } from './intake.js';
import { readItems, nameAndDue } from './energy.js';
import { maskSecrets } from './mask.js';
import { local, zoned, addDays } from './morning.js';
import { weekBlock, mondayOf, isoWeek } from './week.js';

export const HOUR = 6; // Sundays from 06:00
export const MAX_QUESTION = 220;
export const MAX_ANSWER = 1000;
const SOURCES = ['todo', 'morning'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Paul approved this text on 2026-10-22; change it only with him.
export const SYSTEM = "You read a JSON summary of one week of Paul's own to-do data: tasks finished, tasks passed on, tasks archived or handed off, how much he dreaded the tasks he timed versus how long they took, his energy by day and time of day, and what he is still waiting on. Ask him exactly one question about this week. It must point at something specific in the data: a task, a number, a pattern or a contradiction. Under 25 words. No advice, no praise, no coaching phrases. Plain English. If there is too little data to ask something specific, return no question.";
const Question = z.object({ question: z.string().max(MAX_QUESTION) });

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
const clean = (s) => maskSecrets(nameAndDue(s).name).slice(0, 160);

/* Pure: the week block + this week's skip events + the list -> the six fields Claude sees. */
export function summaryFrom(block, skips, items) {
  const done = [];
  for (const g of block.done.groups || []) for (const x of g.items) done.push(clean(x.text));
  const passed = new Map();
  for (const r of skips) {
    let task = null;
    try { task = JSON.parse(r.payload).task; } catch (e) { /* skipped */ }
    if (typeof task === 'string') passed.set(task, (passed.get(task) || 0) + 1);
  }
  const d = block.dread;
  const a = block.archive;
  const e = block.energy;
  return {
    week: block.week,
    finished: { count: block.done.count, tasks: done.slice(0, 30) },
    passedOn: [...passed].filter(([id]) => items[id]).sort((x, y) => y[1] - x[1]).slice(0, 15)
      .map(([id, n]) => ({ task: clean(items[id].text), times: n })),
    archivedOrHandedOff: a ? {
      archived: a.archived.map((x) => ({ task: x.name, passedOn: x.skips })),
      handedOff: a.handedOff.map((x) => ({ task: x.name, to: x.who })),
    } : null,
    dreadVersusTime: d ? { biggestLies: d.lies.map((l) => ({ task: l.name, dread: l.dread, minutes: l.mins })), averageDreadByEnergy: d.byLevel, timed: d.started } : null,
    energy: e ? { days: e.days, mostOften: e.most } : null,
    waitingOn: block.waiting ? block.waiting.items.slice(0, 15).map((w) => ({ who: w.who, what: w.what, since: w.since, chaseDue: w.chaseDue })) : null,
  };
}

async function skipsFor(env, monday) {
  const from = new Date(zoned(monday)).toISOString();
  const to = new Date(zoned(addDays(monday, 7))).toISOString();
  const { results } = await env.HUB_DB.prepare("SELECT payload FROM events WHERE type IN ('energy.skipped', 'dread.skipped') AND at >= ? AND at < ?").bind(from, to).all();
  return results || [];
}

export async function askClaude(env, summary) {
  const res = await anthropic(env).beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: "Paul's week (JSON):\n" + JSON.stringify(summary) }],
    output_config: { effort: 'medium', format: zodOutputFormat(Question) },
    fallbacks: 'default',
    betas: ['server-side-fallback-2026-07-01'],
  });
  const usage = {
    input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0,
    cacheRead: res.usage?.cache_read_input_tokens ?? 0, cacheWrite: res.usage?.cache_creation_input_tokens ?? 0,
  };
  if (res.stop_reason === 'refusal' || !res.parsed_output) return { question: null, usage };
  return { question: String(res.parsed_output.question || '').trim() || null, usage };
}

let asker = askClaude;
export function _setAsker(fn) { asker = fn || askClaude; }

/* Sundays from 06:00, once a week. */
export async function oracleCron(env, now = Date.now()) {
  const l = local(now);
  if (l.weekday !== 0) return { skip: 'not Sunday' };
  if (l.minutes < HOUR * 60) return { skip: 'too early' };
  if (!env.HUB_DB || !env.TODO_CODE || !env.ANTHROPIC_API_KEY) return { skip: 'not configured' };
  const monday = mondayOf(l.date);
  const at = new Date(now).toISOString();
  const ins = await env.HUB_DB.prepare("INSERT INTO oracle (week, label, asked_at) VALUES (?, ?, ?) ON CONFLICT(week) DO NOTHING")
    .bind(monday, 'Week ' + isoWeek(l.date), at).run();
  if (!ins.meta || ins.meta.changes === 0) return { skip: 'asked' };
  let question = null;
  try {
    const [block, skips, items] = await Promise.all([weekBlock(env, now), skipsFor(env, monday), readItems(env)]);
    const got = await asker(env, summaryFrom(block, skips, items));
    if (got.usage) await bumpUsage(env, dayOf(now).slice(0, 7), got.usage, 'oracle').catch(() => {});
    question = got.question ? got.question.slice(0, MAX_QUESTION) : null;
  } catch (e) {
    console.log('oracle failed', String(e && e.name)); // never the summary or the question
    return { failed: true };
  }
  if (!question) return { skip: 'no question' };
  await env.HUB_DB.prepare("UPDATE oracle SET question = ?, state = 'open' WHERE week = ?").bind(question, monday).run();
  await emit(env, 'oracle.asked', 'hub', { week: monday }, now, 'The weekly question');
  return { asked: monday };
}

async function emit(env, type, source, payload, now, summary) {
  await acceptEvent(env, {
    id: type.replace('.', '-') + '-' + now + '-' + rand(), source, type, summary,
    payload, caused_by: null, hops: 0, at: new Date(now).toISOString(),
  }, { feed: false });
}

/* Pure: a row as the apps see it. */
export function view(r) {
  return { week: r.week, label: r.label, question: r.question, state: r.state, answer: r.answer || null, askedAt: r.asked_at, answeredAt: r.answered_at || null };
}

/* The newest week with a question, while it is still open. */
export async function currentQuestion(env) {
  const r = await env.HUB_DB.prepare('SELECT * FROM oracle WHERE question IS NOT NULL ORDER BY week DESC LIMIT 1').first();
  return r && r.state === 'open' ? view(r) : null;
}

/* For the Sunday block: this week's question, whatever its state. */
export async function oracleWeek(env, monday) {
  if (!env.HUB_DB) return null;
  const r = await env.HUB_DB.prepare('SELECT * FROM oracle WHERE week = ? AND question IS NOT NULL').bind(monday).first();
  return r ? view(r) : null;
}

async function readJson(request, max = 4000) {
  const raw = await request.text();
  if (raw.length > max) return { status: 413, error: 'too large' };
  try { return { body: raw ? JSON.parse(raw) : {} }; } catch (e) { return { status: 400, error: 'bad json' }; }
}

export async function handleOracle(request, env, rest, json, now = Date.now()) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  const sub = rest.slice(1);
  if (request.method === 'GET') {
    if (sub.length === 0) return json({ current: await currentQuestion(env) }, request);
    if (sub.length === 1 && sub[0] === 'list') {
      const { results } = await env.HUB_DB.prepare('SELECT * FROM oracle WHERE question IS NOT NULL ORDER BY week DESC LIMIT 200').all();
      return json({ weeks: (results || []).map(view) }, request);
    }
    return json({ error: 'not found' }, request, 404);
  }
  if (request.method !== 'POST' || sub.length !== 1 || !['answer', 'aside'].includes(sub[0])) return json({ error: 'not found' }, request, 404);
  const got = await readJson(request);
  if (got.error) return json({ error: got.error }, request, got.status);
  const b = got.body && typeof got.body === 'object' ? got.body : {};
  const src = SOURCES.includes(b.source) ? b.source : null;
  if (!src) return json({ error: 'source: todo or morning' }, request, 400);
  if (typeof b.week !== 'string' || !DATE.test(b.week)) return json({ error: 'week: YYYY-MM-DD' }, request, 400);
  const row = await env.HUB_DB.prepare('SELECT * FROM oracle WHERE week = ? AND question IS NOT NULL').bind(b.week).first();
  if (!row) return json({ error: 'no question that week' }, request, 404);
  const at = new Date(now).toISOString();
  if (sub[0] === 'answer') {
    const answer = typeof b.answer === 'string' ? b.answer.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_ANSWER) : '';
    if (!answer) return json({ error: 'answer: some text' }, request, 400);
    await env.HUB_DB.prepare("UPDATE oracle SET answer = ?, state = 'answered', answered_at = ? WHERE week = ?").bind(answer, at, b.week).run();
    await emit(env, 'oracle.answered', src, { week: b.week }, now, 'Answered the weekly question');
  } else {
    if (row.state === 'answered') return json({ error: 'already answered' }, request, 409);
    await env.HUB_DB.prepare("UPDATE oracle SET state = 'aside', answered_at = ? WHERE week = ?").bind(at, b.week).run();
    await emit(env, 'oracle.answered', src, { week: b.week, aside: true }, now, 'Put the weekly question aside');
  }
  return json({ week: view(await env.HUB_DB.prepare('SELECT * FROM oracle WHERE week = ?').bind(b.week).first()) }, request);
}
