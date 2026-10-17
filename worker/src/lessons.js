/* Lessons: Claude in the hub learns from Paul's corrections (Paul, 2026-10-17: "make you self
 * enhance with paul hub", option 1). Prepare, Paul approves, as everywhere else.
 *
 *   1. Feedback. Every time Paul takes, changes or throws away what Claude gave him, one row goes
 *      into D1 feedback. Desk writes it itself (src/desk.js, on each approve, copy, skip, undo);
 *      the To-do app reports Tidy's Undo and an edit of a tidied task:
 *        POST /api/lessons/:code/feedback  <- { app: "tidy", kind: "undone" | "edited", before, after }
 *   2. Sundays from 06:00, once (KV lessons:week:<monday>, reserved before the call): when the
 *      week holds at least MIN_CORRECTIONS corrections, Claude reads them with the rules already
 *      kept or dropped and proposes at most MAX_NEW short rules, each with one line on why.
 *   3. Morning's Week view shows them with Keep and Drop:
 *        POST /api/morning/:code/lesson    <- { id, action: "keep" | "drop" | "undo" }  -> { lessons }
 *      Kept rules (KV lessons:kept, rebuilt on every decision) go into the system prompts of Desk
 *      and Tidy from their next call on. Dropping a kept rule takes it out again.
 *
 * Writes only feedback, lessons and lessons:* keys. Never another app's data. */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { CODE, safeEqual, ID } from './todo.js';
import { anthropic, MODEL, randomId } from './intake.js';
import { local, addDays, zoned } from './morning.js';
import { maskSecrets, noDashes } from './mask.js';

export const APPS = ['desk', 'tidy'];
export const KINDS = ['approved', 'copied', 'edited', 'skipped', 'undone'];
export const CORRECTIONS = ['edited', 'skipped', 'undone'];
export const MIN_CORRECTIONS = 2;
export const MAX_NEW = 5;
export const MAX_KEPT = 12;          // per app; the newest kept rules win
export const LESSON_HOUR = 6;
export const KEPT_KEY = 'lessons:kept';
export const WEEK_PREFIX = 'lessons:week:';
const MAX_FIELD = 400;
const MAX_ROWS = 80;

const clip = (s, n = MAX_FIELD) => (typeof s === 'string' && s.trim() ? maskSecrets(s.replace(/\s+/g, ' ').trim()).slice(0, n) : null);
const mondayOf = (date) => addDays(date, -((new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7));

/* ---------- 1. Feedback ---------- */

/* Best effort: a failing log never fails what Paul was doing. */
export async function logFeedback(env, { app, kind, before, after, note }, now = Date.now()) {
  if (!env.HUB_DB || !APPS.includes(app) || !KINDS.includes(kind)) return false;
  try {
    await env.HUB_DB.prepare('INSERT INTO feedback (id, at, app, kind, before, after, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(randomId(), new Date(now).toISOString(), app, kind, clip(before), clip(after), clip(note, 300)).run();
    return true;
  } catch (e) {
    return false;
  }
}

/* Pure: what one Desk button says about Claude's action. `was` is the action as Claude gave it,
 * `now` the same action after the button. */
const deskShow = (a) => (a.kind === 'todo' ? `${a.text} [${a.section}]` : `${a.to ? 'to ' + a.to + ': ' : ''}${a.text}`);
export function deskSignal(was, now, action) {
  if (!was || !now) return null;
  // A second press on the same button (approve twice, copy twice) says nothing new.
  if (action !== 'undo' && was.state === now.state && was.text === now.text && was.section === now.section) return null;
  if (action === 'skip') return { kind: 'skipped', before: deskShow(was) };
  if (action === 'undo') return { kind: 'undone', before: deskShow(was) };
  const changed = was.text !== now.text || (was.kind === 'todo' && was.section !== now.section);
  if (changed) return { kind: 'edited', before: deskShow(was), after: deskShow(now) };
  if (action === 'approve') return { kind: 'approved', before: deskShow(was) };
  if (action === 'copied') return { kind: 'copied', before: deskShow(was) };
  return null;
}

/* ---------- Kept rules, for the prompts ---------- */

export async function rebuildKept(env) {
  const { results } = await env.HUB_DB.prepare("SELECT app, text FROM lessons WHERE state = 'kept' ORDER BY decided_at DESC").all();
  const kept = Object.fromEntries(APPS.map((a) => [a, []]));
  for (const r of results || []) if (kept[r.app] && kept[r.app].length < MAX_KEPT) kept[r.app].push(r.text);
  await env.HUB_KV.put(KEPT_KEY, JSON.stringify(kept));
  return kept;
}

export async function keptFor(env, app) {
  try {
    const kept = await env.HUB_KV.get(KEPT_KEY, 'json');
    return kept && Array.isArray(kept[app]) ? kept[app].slice(0, MAX_KEPT) : [];
  } catch (e) {
    return [];
  }
}

/* Pure: the rules as a block for a system prompt, or '' when there are none. */
export function lessonsText(rules) {
  if (!rules || !rules.length) return '';
  return ['Paul\'s own rules, learned from how he corrected you before. Follow them; they win over the examples above:', ...rules.map((r) => '- ' + r)].join('\n');
}

/* ---------- 2. Sunday: Claude proposes ---------- */

const SYSTEM = [
  'You help two small Claude features in Paul\'s own apps get better at what he wants. Desk: Paul types one line on his PC and Claude prepares to-do tasks and message drafts; he approves, edits, copies or skips each. Tidy: each to-do Paul types comes back cleaned up (typos, short, a date ending " · YYYY-MM-DD"); he can undo it or edit it after.',
  'You get this week\'s feedback rows: app, kind (edited = Paul changed Claude\'s version before keeping it, skipped = he threw it away, undone = he took it back, approved/copied = kept as given), before (Claude\'s version), after (Paul\'s), note (the line he typed). You also get the rules he already keeps and the ones he dropped.',
  `Propose at most ${MAX_NEW} new rules, only where the rows show a pattern or one very clear preference. Fewer is better; none is fine. Each rule: app, text (one instruction to Claude, under 140 characters, concrete, e.g. "Keep Dutch tasks in Dutch; never translate them."), why (under 120 characters, to Paul as "you", naming the corrections, e.g. "You undid 3 tidies that turned \\"tmrw\\" into a date.").`,
  'Never repeat or reword a kept rule or a dropped one. Never propose a rule that a single approved row contradicts. Use only what is in the rows; never invent tasks, names or numbers. Never use dashes as punctuation; use commas or full stops.',
].join('\n');

export const Proposal = z.object({
  lessons: z.array(z.object({
    app: z.enum(APPS),
    text: z.string().max(200),
    why: z.string().max(180),
  })).max(MAX_NEW),
});

export async function askClaude(env, facts) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const res = await anthropic(env).beta.messages.parse({
    model: MODEL,
    max_tokens: 3000,
    system: SYSTEM,
    messages: [{ role: 'user', content: 'The week (JSON):\n' + JSON.stringify(facts) }],
    output_config: { effort: 'medium', format: zodOutputFormat(Proposal) },
    fallbacks: 'default',
    betas: ['server-side-fallback-2026-07-01'],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return null;
  return res.parsed_output;
}

let asker = askClaude;
export function _setLessonAsker(fn) { asker = fn || askClaude; }

/* Pure: Claude's proposals, cleaned, without anything already kept, dropped or pending. */
export function cleanProposals(out, known) {
  const seen = new Set((known || []).map((t) => t.toLowerCase()));
  const res = [];
  for (const l of (out && Array.isArray(out.lessons) ? out.lessons : [])) {
    if (res.length >= MAX_NEW) break;
    if (!l || !APPS.includes(l.app)) continue;
    const text = noDashes(String(l.text || '')).replace(/\s+/g, ' ').trim().slice(0, 160);
    const why = noDashes(String(l.why || '')).replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    res.push({ app: l.app, text, why: why || 'From this week\'s corrections.' });
  }
  return res;
}

export async function weekLessons(env, now = Date.now()) {
  if (!env.HUB_DB) return { skip: 'not configured' };
  const l = local(now);
  if (l.weekday !== 0) return { skip: 'not Sunday' };
  if (l.minutes < LESSON_HOUR * 60) return { skip: 'too early' };
  const monday = mondayOf(l.date);
  const key = WEEK_PREFIX + monday;
  if (await env.HUB_KV.get(key)) return { skip: 'done' };
  await env.HUB_KV.put(key, JSON.stringify({ at: new Date(now).toISOString(), pending: true }), { expirationTtl: 60 * 24 * 3600 });

  const from = new Date(zoned(addDays(l.date, -6))).toISOString();
  const { results: rows } = await env.HUB_DB.prepare('SELECT app, kind, before, after, note FROM feedback WHERE at >= ? ORDER BY at DESC LIMIT ?').bind(from, MAX_ROWS).all();
  const corrections = (rows || []).filter((r) => CORRECTIONS.includes(r.kind)).length;
  let added = 0;
  if (corrections >= MIN_CORRECTIONS) {
    const { results: had } = await env.HUB_DB.prepare('SELECT app, text, state FROM lessons').all();
    const by = (s) => (had || []).filter((x) => x.state === s).map((x) => ({ app: x.app, text: x.text }));
    const facts = { rows: rows || [], kept: by('kept'), dropped: by('dropped'), waiting: by('proposed') };
    let out = null;
    try { out = await asker(env, facts); } catch (e) { out = null; }
    const at = new Date(now).toISOString();
    for (const p of cleanProposals(out, (had || []).map((x) => x.text))) {
      await env.HUB_DB.prepare("INSERT INTO lessons (id, app, text, why, state, week, at) VALUES (?, ?, ?, ?, 'proposed', ?, ?)")
        .bind(randomId(), p.app, p.text, p.why, monday, at).run();
      added++;
    }
  }
  await env.HUB_KV.put(key, JSON.stringify({ at: new Date(now).toISOString(), rows: (rows || []).length, corrections, added }), { expirationTtl: 60 * 24 * 3600 });
  return { rows: (rows || []).length, corrections, added };
}

/* ---------- 3. The Week view ---------- */

export async function lessonsFor(env) {
  if (!env.HUB_DB) return null;
  const { results } = await env.HUB_DB.prepare("SELECT id, app, text, why, state FROM lessons WHERE state IN ('proposed', 'kept') ORDER BY at DESC").all();
  const rows = results || [];
  const show = ({ id, app, text, why }) => ({ id, app, text, why });
  return { proposed: rows.filter((r) => r.state === 'proposed').slice(0, 10).map(show), kept: rows.filter((r) => r.state === 'kept').map(show) };
}

export async function actOnLesson(env, body, now = Date.now()) {
  if (!body || typeof body.id !== 'string' || !ID.test(body.id)) return { status: 400, error: 'id required' };
  const to = { keep: 'kept', drop: 'dropped', undo: 'proposed' }[body.action];
  if (!to) return { status: 400, error: 'action must be keep, drop or undo' };
  if (!env.HUB_DB) return { status: 503, error: 'not configured' };
  const row = await env.HUB_DB.prepare('SELECT id, state FROM lessons WHERE id = ?').bind(body.id).first();
  if (!row) return { status: 404, error: 'no such lesson' };
  await env.HUB_DB.prepare('UPDATE lessons SET state = ?, decided_at = ? WHERE id = ?').bind(to, to === 'proposed' ? null : new Date(now).toISOString(), body.id).run();
  await rebuildKept(env);
  return { lessons: await lessonsFor(env) };
}

export async function handleLesson(request, env, json, now = Date.now()) {
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const text = await request.text();
  if (text.length > 1000) return json({ error: 'too large' }, request, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, request, 400); }
  const out = await actOnLesson(env, body, now);
  if (out.error) return json({ error: out.error }, request, out.status);
  return json({ ok: true, ...out }, request);
}

/* POST /api/lessons/:code/feedback, from the To-do app (Tidy only; Desk logs its own). */
export async function handleLessons(request, env, rest, json, now = Date.now()) {
  if (rest.length !== 2 || rest[1] !== 'feedback' || !CODE.test(rest[0])) return json({ error: 'not found' }, request, 404);
  if (!env.TODO_CODE || !safeEqual(rest[0], env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const raw = await request.text();
  if (raw.length > 2000) return json({ error: 'too large' }, request, 413);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad json' }, request, 400); }
  if (!body || body.app !== 'tidy' || !['undone', 'edited'].includes(body.kind)) return json({ error: 'app tidy, kind undone or edited' }, request, 400);
  if (!clip(body.before) || !clip(body.after) || clip(body.before) === clip(body.after)) return json({ error: 'before and after required' }, request, 400);
  const ok = await logFeedback(env, { app: 'tidy', kind: body.kind, before: body.before, after: body.after }, now);
  return json({ ok }, request);
}
