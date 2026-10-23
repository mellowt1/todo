/* The Skills gap tracker (Paul, 2026-10-22; wave 2 Phase 2): the roles he tracks, what each one asks for,
 * how his own side matches it (have, partly, missing), and the gaps that come up most often, which he
 * can plan, turn into To-do tasks and close. Morning draws it (morning/app/skills/); To-do's Apply card
 * has "Track this role".
 *
 *   GET  /api/skills/:code                      -> { today, side, roles, gaps }
 *   GET  /api/skills/:code/side                 -> { lines, updatedAt }
 *   GET  /api/skills/:code/track/:taskId        -> { role | null }      (To-do's Apply card)
 *   POST /api/skills/:code/side                 <- { text }             his CV Studio blocks, pasted
 *   POST /api/skills/:code/track                <- { taskId }           an Apply task in To-do
 *   POST /api/skills/:code/role                 <- { title, org?, link?, text }   a pasted job
 *   POST /api/skills/:code/role/:id/(text | recheck | past | delete)
 *   POST /api/skills/:code/gap/:key/(step | options | close | reopen)
 *   POST /api/skills/:code/gap/:key/step/:id/(task | delete)
 *
 * Paul's rule (master prompt, wave 2): never invent facts about him. His side is only what he pastes
 * from CV Studio and the gaps he closes in his own words. A Have or Partly must name one of those lines;
 * one that does not is turned into Missing here, whatever Claude said. The CV versions in KV apply:cvs
 * are never read.
 *
 * Claude (Opus 5.5, Paul's pick; the prompts below as shown to him on 2026-10-22, left to me after):
 * reading a vacancy and checking it against his side run on the hub's queue (TARGETS.skills in
 * src/hub.js), so tapping Track answers at once; options for a gap run while he waits. A live run on a
 * made-up vacancy (2026-10-22) took 11 s and about 3 cents for a role, 5 s for options. Usage in KV
 * skills:usage:YYYY-MM.
 *
 * My calls where Paul left them to me (2026-10-22): the hub reads the vacancy page once when he tracks
 * it, and asks for the text when the page cannot be read; Skills is a Morning page; must-haves rank first,
 * nice-to-haves count too; a step becomes a task in Soon with Normal energy unless he picks otherwise;
 * "I have this now" adds his words as a line on his side and moves every role that asked for it to Have;
 * a role goes to Past the day after its closing date; a new side checks every active role again, up to
 * 30, through the queue.
 *
 * D1 (migrations/0015_skills.sql): skill_roles, skill_reqs, skill_lines, skill_gaps, skill_steps.
 * Events with ids only, out of Morning's feed: skills.tracked, skills.read, skills.matched, skills.side,
 * gap.step, gap.task, gap.options, gap.closed, gap.reopened. */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { CODE, ENERGY, safeEqual, cleanOp, cleanText, cleanLink } from './todo.js';
import { acceptEvent } from './hub.js';
import { anthropic, MODEL, bumpUsage, dayOf } from './intake.js';
import { postingFromHtml, MIN_TEXT, MAX_POSTING } from './apply.js';
import { local } from './morning.js';

export const KINDS = ['skill', 'experience', 'language', 'clearance', 'qualification'];
const STATUS = ['have', 'partly', 'missing'];
export const PAGE = 'https://mellowt1.github.io/morning/skills/';
const MAX_LINES = 400;
const MAX_LINE = 400;
const MAX_SIDE = 60000;
const MAX_RECHECK = 30;
const MIN_PASTE = 200;
const RID = /^[a-z0-9]{12}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SID = /^s[a-z0-9]{8}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Shown to Paul on 2026-10-22; he chose the model and left the wording to me. Change them only with him.
export const READ_PROMPT = "You read one job vacancy (Dutch or English). List what it asks of a candidate in five kinds: skills, experience, languages, clearances, qualifications. One requirement per item, in short plain English (under 12 words), even when the vacancy is Dutch. Mark each must-have or nice-to-have as the vacancy says; when it does not say, must-have. Reuse a label from the existing list when it means the same. Only what the vacancy states: no guesses, no advice.";
export const MATCH_PROMPT = "Compare these job requirements with Paul's own lines: his CV Studio blocks and the gaps he closed himself. For each, say have, partly or missing. Have or partly must name the line that shows it. If no line shows it, it is missing. Never assume anything not written in the lines. No advice.";
export const OPTIONS_PROMPT = "Paul wants to close one gap for the jobs he tracks. Give three concrete options he can start himself (a course, an exam, a project, a conversation): a short title and one sentence each. No invented prices, dates or providers; write 'check' where a detail must be looked up.";

const Read = z.object({ requirements: z.array(z.object({ kind: z.enum(KINDS), label: z.string().max(100), must: z.boolean() })).max(40) });
const Match = z.object({ matches: z.array(z.object({ label: z.string().max(100), status: z.enum(STATUS), line: z.string().max(20).nullable(), why: z.string().max(160).nullable() })) });
const Options = z.object({ options: z.array(z.object({ title: z.string().max(80), text: z.string().max(240) })).max(3) });

const line = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const iso = (ms) => new Date(ms).toISOString();

/* ---------- Pure ---------- */

/* A label made comparable across roles: "French (B2)" -> "french-b2". */
export function keyOf(label) {
  return String(label || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
}

/* What Paul pasted from CV Studio -> his lines. A JSON export of CV Studio's blocks ({ blocks: { id:
 * { kind, data } } }, or a list of them) gives one line per job, bullet, degree and language; anything
 * else is read as text, one line per line. Contact details (an address with @, a phone number) and the
 * header, references and letters are left out: they never show a skill. */
export function sideLines(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'text: paste your CV Studio blocks' };
  if (text.length > MAX_SIDE) return { error: 'text: at most ' + MAX_SIDE + ' characters' };
  let out = [];
  const t = text.trim();
  let j = null;
  if (/^[[{]/.test(t)) { try { j = JSON.parse(t); } catch (e) { j = null; } }
  if (j) {
    const raw = Array.isArray(j) ? j : j.blocks ? (Array.isArray(j.blocks) ? j.blocks : Object.values(j.blocks)) : Object.values(j);
    for (const b of raw) {
      if (!b || typeof b !== 'object') continue;
      const d = b.data && typeof b.data === 'object' ? b.data : b;
      const at = (...xs) => xs.filter((x) => typeof x === 'string' && x.trim()).join(', ');
      const when = typeof d.dates === 'string' && d.dates.trim() ? ' (' + d.dates.trim() + ')' : '';
      switch (b.kind) {
        case 'profile': out.push(d.text); break;
        case 'job': {
          const head = at(d.role, d.org);
          out.push(head + when + (d.detail ? ': ' + d.detail : ''));
          for (const x of Array.isArray(d.bullets) ? d.bullets : []) out.push(head + ': ' + x);
          break;
        }
        case 'earlier': out.push(at(d.role, d.org, d.place) + when + (d.text ? ': ' + d.text : '')); break;
        case 'education': out.push(at(d.degree, d.school, d.place) + when + (d.text ? ': ' + d.text : '')); break;
        case 'languages': for (const x of Array.isArray(d.items) ? d.items : []) out.push('Language: ' + x); break;
        default: break; // header, references, letter
      }
    }
  } else {
    out = t.split(/\r?\n/).map((x) => x.replace(/^\s*[-•*·]\s*/, ''));
  }
  const lines = [];
  const seen = new Set();
  for (const x of out) {
    const c = line(x, MAX_LINE);
    if (c.length < 3 || /@/.test(c) || /(\+|00)\d[\d\s().-]{7,}/.test(c) || /^\d[\d\s().-]{8,}$/.test(c)) continue;
    if (seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    lines.push(c);
    if (lines.length >= MAX_LINES) break;
  }
  if (!lines.length) return { error: 'text: no lines found' };
  return { lines };
}

/* "Apply: Policy officer (Ministry of Defence) · 2026-11-04" -> { title, org, deadline }. */
export function fromApplyTask(text) {
  const t = String(text || '').replace(/\s*\[intake\]$/i, '').trim();
  const m = t.match(/^(?:apply|sollicit\w*)\b\s*:?\s*(?:(?:for|to|at|bij|voor|naar)\s+)?(.*)$/i);
  if (!m) return null;
  let rest = m[1].trim();
  let deadline = null;
  const d = rest.match(/\s*·\s*(\d{4}-\d{2}-\d{2})\s*$/);
  if (d) { deadline = d[1]; rest = rest.slice(0, d.index).trim(); }
  const o = rest.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  const title = line(o ? o[1] : rest, 200);
  return title ? { title, org: o ? line(o[2], 120) : null, deadline } : null;
}

/* Claude's matches -> rows; a Have or Partly that names no line of his side becomes Missing. */
export function settleMatches(reqs, matches, lineIds, closedByKey = {}) {
  const byKey = new Map(matches.map((m) => [keyOf(m.label), m]));
  return reqs.map((r) => {
    if (closedByKey[r.key]) return { ...r, status: 'have', line_id: closedByKey[r.key], why: 'You closed this gap' };
    const m = byKey.get(r.key);
    if (!m) return { ...r, status: 'missing', line_id: null, why: null };
    const id = typeof m.line === 'string' ? m.line.trim() : '';
    if ((m.status === 'have' || m.status === 'partly') && lineIds.has(id)) return { ...r, status: m.status, line_id: id, why: m.why ? line(m.why, 160) : null };
    return { ...r, status: 'missing', line_id: null, why: m.status === 'missing' && m.why ? line(m.why, 160) : null };
  });
}

/* The gaps across active roles: missing or partly, must-haves first, then how many roles, then missing
 * before partly; closed last. */
export function gapsFrom(roles, gapRows, steps) {
  const active = roles.filter((r) => r.state === 'ready');
  const by = new Map();
  const meta = new Map(gapRows.map((g) => [g.key, g]));
  for (const r of active) for (const q of r.reqs) {
    const closed = meta.get(q.key) && meta.get(q.key).closed === 1;
    if (!closed && q.status !== 'missing' && q.status !== 'partly') continue;
    const g = by.get(q.key) || { key: q.key, label: q.label, roles: [], must: 0, total: 0, worst: 'partly' };
    g.roles.push(r.id); g.total++; if (q.must) g.must++;
    if (q.status === 'missing') g.worst = 'missing';
    by.set(q.key, g);
  }
  for (const g of gapRows) if (g.closed === 1 && !by.has(g.key)) by.set(g.key, { key: g.key, label: g.label, roles: [], must: 0, total: 0, worst: 'missing' });
  const stepsBy = new Map();
  for (const s of steps) { if (!stepsBy.has(s.gap)) stepsBy.set(s.gap, []); stepsBy.get(s.gap).push({ id: s.id, text: s.text, taskId: s.task_id, source: s.source }); }
  const out = [...by.values()].map((g) => {
    const m = meta.get(g.key);
    const st = stepsBy.get(g.key) || [];
    let options = null;
    if (m && m.options) { try { options = JSON.parse(m.options); } catch (e) { options = null; } }
    return {
      ...g, active: active.length,
      state: m && m.closed === 1 ? 'closed' : st.length ? 'working' : 'open',
      closedNote: m && m.closed === 1 ? m.closed_note : null, closedAt: m && m.closed === 1 ? m.closed_at : null,
      steps: st, options,
    };
  });
  const rank = (g) => (g.state === 'closed' ? 1 : 0);
  const worst = (g) => (g.worst === 'missing' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.must - a.must || b.total - a.total || worst(a) - worst(b) || a.label.localeCompare(b.label));
}

/* ---------- Claude ---------- */

const usageOf = (res) => ({
  input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0,
  cacheRead: res.usage?.cache_read_input_tokens ?? 0, cacheWrite: res.usage?.cache_creation_input_tokens ?? 0,
});
async function call(env, system, content, schema, effort) {
  const res = await anthropic(env).beta.messages.parse({
    model: MODEL, max_tokens: 8000, system,
    messages: [{ role: 'user', content }],
    output_config: { effort, format: zodOutputFormat(schema) },
    fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'],
  });
  await bumpUsage(env, dayOf(Date.now()).slice(0, 7), usageOf(res), 'skills').catch(() => {});
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error('no answer');
  return res.parsed_output;
}
const real = {
  read: (env, text, labels) => call(env, READ_PROMPT,
    'Existing labels:\n' + (labels.length ? labels.map((l) => '- ' + l).join('\n') : '(none yet)') + '\n\n<vacancy>\n' + text + '\n</vacancy>', Read, 'medium'),
  match: (env, reqs, lines) => call(env, MATCH_PROMPT,
    "Paul's lines:\n" + lines.map((l) => l.id + ': ' + l.text).join('\n') + '\n\nRequirements:\n' + reqs.map((r) => '- ' + r.label + ' (' + r.kind + (r.must ? '' : ', nice to have') + ')').join('\n'), Match, 'medium'),
  options: (env, label, roles) => call(env, OPTIONS_PROMPT,
    'The gap: ' + label + '\nThe roles that ask for it: ' + roles.join('; '), Options, 'low'),
};
let claude = real;
export function _setClaude(fake) { claude = fake ? { ...real, ...fake } : real; }

/* ---------- Storage ---------- */

async function emit(env, type, payload, now, summary, source = 'morning') {
  await acceptEvent(env, {
    id: type.replace('.', '-') + '-' + now + '-' + rand(6), source, type, summary,
    payload, caused_by: null, hops: 0, at: iso(now),
  }, { feed: false });
}
const getRole = (env, id) => env.HUB_DB.prepare('SELECT * FROM skill_roles WHERE id = ?').bind(id).first();
async function sideAll(env) {
  const { results } = await env.HUB_DB.prepare('SELECT id, text, source, gap FROM skill_lines ORDER BY source = \'closed\', pos, created_at').all();
  return results || [];
}
async function runAll(env, stmts) {
  for (let i = 0; i < stmts.length; i += 50) {
    const part = stmts.slice(i, i + 50);
    if (env.HUB_DB.batch) await env.HUB_DB.batch(part);
    else for (const s of part) await s.run();
  }
}
const listStub = (env) => env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
async function listDoc(env) {
  const r = await listStub(env).fetch('https://list/export');
  if (!r.ok) throw new Error('todo export ' + r.status);
  return r.json();
}

/* One read or check goes on the queue as its own message; the consumer is idempotent per event id. */
async function enqueue(env, kind, role, now) {
  const runs = (role.runs || 0) + 1;
  await env.HUB_DB.prepare('UPDATE skill_roles SET runs = ?, updated_at = ? WHERE id = ?').bind(runs, iso(now), role.id).run();
  const body = { event_id: 'skills-' + kind + '-' + role.id + '-' + runs, target: 'skills', type: 'skills.' + kind, source: 'hub', summary: 'Skills ' + kind, payload: { role: role.id } };
  if (env.HUB_QUEUE) await env.HUB_QUEUE.send(body);
  return body;
}

function roleOut(r, reqs, lines) {
  const counts = { have: 0, partly: 0, missing: 0, unknown: 0 };
  for (const q of reqs) counts[q.status]++;
  return {
    id: r.id, title: r.title, org: r.org, link: r.link, deadline: r.deadline, source: r.source, taskId: r.task_id,
    state: r.state, error: r.error, counts, createdAt: r.created_at, readAt: r.read_at, matchedAt: r.matched_at,
    reqs: reqs.map((q) => ({ key: q.key, label: q.label, kind: q.kind, must: q.must === 1, status: q.status, line: q.line_id && lines.get(q.line_id) ? { id: q.line_id, ...lines.get(q.line_id) } : null, why: q.why })),
  };
}

export async function everything(env, now = Date.now()) {
  const today = local(now).date;
  const [{ results: roles }, { results: reqs }, side, { results: gapRows }, { results: steps }, meta] = await Promise.all([
    env.HUB_DB.prepare('SELECT * FROM skill_roles').all(),
    env.HUB_DB.prepare('SELECT * FROM skill_reqs ORDER BY role_id, pos').all(),
    sideAll(env),
    env.HUB_DB.prepare('SELECT * FROM skill_gaps').all(),
    env.HUB_DB.prepare('SELECT * FROM skill_steps ORDER BY created_at, id').all(),
    env.HUB_KV.get('skills:side', 'json'),
  ]);
  const lines = new Map(side.map((l) => [l.id, { text: l.text, source: l.source }]));
  const reqsBy = new Map();
  for (const q of reqs || []) { if (!reqsBy.has(q.role_id)) reqsBy.set(q.role_id, []); reqsBy.get(q.role_id).push(q); }
  const order = (r) => (r.state === 'past' ? 1 : 0);
  const out = (roles || []).map((r) => roleOut(r, reqsBy.get(r.id) || [], lines))
    .sort((a, b) => order(a) - order(b) || (a.deadline || '9999').localeCompare(b.deadline || '9999') || b.createdAt.localeCompare(a.createdAt));
  return {
    today,
    side: { lines: side.filter((l) => l.source === 'cv').length, closed: side.filter((l) => l.source === 'closed').length, updatedAt: meta && meta.at ? meta.at : null },
    roles: out,
    gaps: gapsFrom(out, gapRows || [], steps || []),
  };
}

/* ---------- The queue: read a vacancy, check it against his side ---------- */

async function fetchPosting(link) {
  const r = await fetch(link, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (paul-hub skills)', Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('page ' + r.status);
  return bestPosting(await r.text());
}

/* The longer of the page's JobPosting data and its own text: werkenvoornederland.nl puts only one line
 * in its JobPosting and the vacancy in the page; werkenbijdefensie.nl the other way round (2026-10-23). */
export function bestPosting(html) {
  const data = postingFromHtml(html);
  const page = postingFromHtml(String(html).replace(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi, ''));
  return (page.text || '').length > (data.text || '').length ? { ...page, title: data.title || page.title, organisation: data.organisation || page.organisation } : data;
}

async function readRole(env, role, now) {
  // Text Paul pasted counts from MIN_PASTE characters; a page the hub reads must give MIN_TEXT.
  let text = role.text;
  if (!text || text.length < MIN_PASTE) {
    let posting = null;
    if (role.link) { try { posting = await fetchPosting(role.link); } catch (e) { posting = null; } }
    if (!posting || !posting.text || posting.text.length < MIN_TEXT) {
      await env.HUB_DB.prepare("UPDATE skill_roles SET state = 'needs_text', error = NULL, updated_at = ? WHERE id = ?").bind(iso(now), role.id).run();
      return { needs: 'text' };
    }
    text = posting.text.slice(0, MAX_POSTING);
    await env.HUB_DB.prepare('UPDATE skill_roles SET text = ? WHERE id = ?').bind(text, role.id).run();
  }
  const { results: known } = await env.HUB_DB.prepare('SELECT label FROM skill_reqs GROUP BY key ORDER BY COUNT(*) DESC, label LIMIT 200').all();
  const got = await claude.read(env, text, (known || []).map((k) => k.label));
  const seen = new Set();
  const reqs = [];
  for (const q of got.requirements || []) {
    const label = line(q.label, 100);
    const key = keyOf(label);
    if (!label || !key || seen.has(key) || !KINDS.includes(q.kind)) continue;
    seen.add(key);
    reqs.push({ key, label, kind: q.kind, must: q.must === false ? 0 : 1 });
  }
  const at = iso(now);
  await runAll(env, [
    env.HUB_DB.prepare('DELETE FROM skill_reqs WHERE role_id = ?').bind(role.id),
    ...reqs.map((q, i) => env.HUB_DB.prepare("INSERT INTO skill_reqs (role_id, key, label, kind, must, status, pos) VALUES (?, ?, ?, ?, ?, 'unknown', ?)").bind(role.id, q.key, q.label, q.kind, q.must, i)),
    env.HUB_DB.prepare('UPDATE skill_roles SET read_at = ?, updated_at = ? WHERE id = ?').bind(at, at, role.id),
  ]);
  await emit(env, 'skills.read', { id: role.id, reqs: reqs.length }, now, 'Vacancy read', 'hub');
  return matchRole(env, role, now);
}

async function matchRole(env, role, now) {
  const at = iso(now);
  const { results: reqs } = await env.HUB_DB.prepare('SELECT * FROM skill_reqs WHERE role_id = ? ORDER BY pos').bind(role.id).all();
  const side = await sideAll(env);
  const { results: closed } = await env.HUB_DB.prepare("SELECT key FROM skill_gaps WHERE closed = 1").all();
  const closedLine = new Map(side.filter((l) => l.source === 'closed' && l.gap).map((l) => [l.gap, l.id]));
  const closedByKey = Object.fromEntries((closed || []).filter((g) => closedLine.has(g.key)).map((g) => [g.key, closedLine.get(g.key)]));
  let rows;
  if (!side.length || !(reqs || []).length) {
    rows = (reqs || []).map((q) => (closedByKey[q.key] ? { ...q, status: 'have', line_id: closedByKey[q.key], why: 'You closed this gap' } : { ...q, status: 'unknown', line_id: null, why: null }));
  } else {
    const got = await claude.match(env, reqs.map((q) => ({ label: q.label, kind: q.kind, must: q.must === 1 })), side.map((l) => ({ id: l.id, text: l.text })));
    rows = settleMatches(reqs, got.matches || [], new Set(side.map((l) => l.id)), closedByKey);
  }
  await runAll(env, [
    ...rows.map((q) => env.HUB_DB.prepare('UPDATE skill_reqs SET status = ?, line_id = ?, why = ? WHERE role_id = ? AND key = ?').bind(q.status, q.line_id, q.why, role.id, q.key)),
    env.HUB_DB.prepare("UPDATE skill_roles SET state = CASE WHEN state = 'past' THEN 'past' ELSE 'ready' END, error = NULL, matched_at = ?, updated_at = ? WHERE id = ?").bind(at, at, role.id),
  ]);
  await emit(env, 'skills.matched', { id: role.id }, now, 'Role checked', 'hub');
  return { done: role.id };
}

/* TARGETS.skills (src/hub.js). A failure from Claude or the page is kept on the role (no retry, so a
 * bad vacancy never costs twice); only a storage error is thrown, for the queue to try again. */
export async function skillsTarget(env, msg, now = Date.now()) {
  const id = msg.payload && msg.payload.role;
  const role = RID.test(id || '') ? await getRole(env, id) : null;
  if (!role) return { skip: 'no such role' };
  try {
    if (msg.type === 'skills.read') return await readRole(env, role, now);
    if (msg.type === 'skills.match') return await matchRole(env, role, now);
    return { skip: 'no skills reaction for ' + msg.type };
  } catch (e) {
    const why = String((e && e.message) || 'failed').slice(0, 120);
    if (/D1|SQLITE/i.test(why)) throw e;
    console.log('skills failed', role.id, (e && e.name) || 'Error');
    await env.HUB_DB.prepare("UPDATE skill_roles SET state = CASE WHEN state = 'past' THEN 'past' ELSE 'failed' END, error = ?, updated_at = ? WHERE id = ?")
      .bind('Claude could not read this one just now. Try again later.', iso(now), role.id).run();
    return { failed: role.id };
  }
}

/* The day after its closing date a role is past: out of the gaps, kept in the list. */
export async function skillsCron(env, now = Date.now()) {
  if (!env.HUB_DB) return { skip: 'not configured' };
  const today = local(now).date;
  const r = await env.HUB_DB.prepare("UPDATE skill_roles SET state = 'past', updated_at = ? WHERE deadline IS NOT NULL AND deadline < ? AND state != 'past'").bind(iso(now), today).run();
  // A page that could not be read is tried once more by itself (it may have been down), then waits for text.
  const { results } = await env.HUB_DB.prepare("SELECT * FROM skill_roles WHERE state = 'needs_text' AND link IS NOT NULL AND runs < 2").all();
  for (const role of results || []) {
    await env.HUB_DB.prepare("UPDATE skill_roles SET state = 'reading', updated_at = ? WHERE id = ?").bind(iso(now), role.id).run();
    await enqueue(env, 'read', role, now);
  }
  // A role last checked before his side changed is checked again (a side written outside the page, too).
  const side = await env.HUB_KV.get('skills:side', 'json').catch(() => null);
  let stale = [];
  if (side && side.at) {
    ({ results: stale } = await env.HUB_DB.prepare("SELECT * FROM skill_roles WHERE state = 'ready' AND matched_at IS NOT NULL AND matched_at < ? ORDER BY deadline IS NULL, deadline LIMIT ?").bind(side.at, MAX_RECHECK).all());
    for (const role of stale || []) {
      await env.HUB_DB.prepare("UPDATE skill_roles SET state = 'reading', updated_at = ? WHERE id = ?").bind(iso(now), role.id).run();
      await enqueue(env, 'match', role, now);
    }
  }
  return { past: r.meta ? r.meta.changes : 0, retried: (results || []).length, rechecked: (stale || []).length };
}

/* ---------- Routes ---------- */

async function readJson(request, max) {
  const raw = await request.text();
  if (raw.length > max) return { status: 413, error: 'too large' };
  try { const b = raw ? JSON.parse(raw) : {}; return { body: b && typeof b === 'object' && !Array.isArray(b) ? b : {} }; } catch (e) { return { status: 400, error: 'bad json' }; }
}
const ok = (body) => ({ body });
const bad = (status, error) => ({ status, error });

async function roleBody(env, id, now) {
  const all = await everything(env, now);
  return all.roles.find((r) => r.id === id) || null;
}
async function gapBody(env, key, now) {
  const all = await everything(env, now);
  return all.gaps.find((g) => g.key === key) || null;
}
async function newRole(env, f, now) {
  const id = rand(12);
  const at = iso(now);
  await env.HUB_DB.prepare(
    `INSERT INTO skill_roles (id, title, org, link, deadline, source, task_id, text, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reading', ?, ?)`
  ).bind(id, f.title, f.org, f.link, f.deadline, f.source, f.taskId, f.text, at, at).run();
  const role = await getRole(env, id);
  await emit(env, 'skills.tracked', { id }, now, 'Role tracked', f.source === 'digest' ? 'todo' : 'morning');
  await enqueue(env, 'read', role, now);
  return id;
}

async function track(env, b, now) {
  if (typeof b.taskId !== 'string' || !/^[a-z0-9]{8,32}$/.test(b.taskId)) return bad(400, 'taskId: an Apply task');
  const had = await env.HUB_DB.prepare('SELECT id FROM skill_roles WHERE task_id = ?').bind(b.taskId).first();
  if (had) return ok({ role: await roleBody(env, had.id, now) });
  if (!env.TODO_CODE || !env.TODO_LIST) return bad(503, 'not configured');
  const it = (await listDoc(env)).items[b.taskId];
  if (!it) return bad(404, 'no such task');
  const t = fromApplyTask(it.text);
  if (!t) return bad(400, 'not an Apply task');
  const id = await newRole(env, { ...t, link: cleanLink(it.link) || null, source: 'digest', taskId: b.taskId, text: null }, now);
  return ok({ role: await roleBody(env, id, now) });
}

async function paste(env, b, now) {
  const title = line(b.title, 200);
  if (!title) return bad(400, 'title required');
  const text = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n').trim().slice(0, MAX_POSTING) : '';
  if (text.length < MIN_PASTE) return bad(400, 'text: the job text, at least ' + MIN_PASTE + ' characters');
  const link = b.link ? cleanLink(b.link) : null;
  if (b.link && !link) return bad(400, 'link: an http(s) address');
  const id = await newRole(env, { title, org: line(b.org, 120) || null, link, deadline: null, source: 'paste', taskId: null, text }, now);
  return ok({ role: await roleBody(env, id, now) });
}

async function setSide(env, b, now) {
  const got = sideLines(b.text);
  if (got.error) return bad(400, got.error);
  const at = iso(now);
  await runAll(env, [
    env.HUB_DB.prepare("DELETE FROM skill_lines WHERE source = 'cv'"),
    env.HUB_DB.prepare("UPDATE skill_reqs SET status = 'unknown', line_id = NULL, why = NULL WHERE line_id IS NULL OR line_id NOT LIKE 'c%'"),
    ...got.lines.map((t, i) => env.HUB_DB.prepare("INSERT INTO skill_lines (id, text, source, pos, created_at) VALUES (?, ?, 'cv', ?, ?)").bind('l' + (i + 1), t, i, at)),
  ]);
  await env.HUB_KV.put('skills:side', JSON.stringify({ at, lines: got.lines.length }));
  const { results } = await env.HUB_DB.prepare("SELECT * FROM skill_roles WHERE state IN ('ready', 'failed') ORDER BY deadline IS NULL, deadline LIMIT ?").bind(MAX_RECHECK).all();
  for (const r of results || []) {
    if (r.state === 'failed') await env.HUB_DB.prepare("UPDATE skill_roles SET state = 'reading' WHERE id = ?").bind(r.id).run();
    await enqueue(env, r.state === 'failed' || !r.read_at ? 'read' : 'match', r, now);
  }
  await emit(env, 'skills.side', { lines: got.lines.length }, now, 'Your side updated');
  return ok({ lines: got.lines.length, rechecks: (results || []).length });
}

async function roleAct(env, role, act, b, now) {
  const at = iso(now);
  if (act === 'text') {
    const text = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n').trim().slice(0, MAX_POSTING) : '';
    if (text.length < MIN_PASTE) return bad(400, 'text: the job text, at least ' + MIN_PASTE + ' characters');
    await env.HUB_DB.prepare("UPDATE skill_roles SET text = ?, state = 'reading', error = NULL, updated_at = ? WHERE id = ?").bind(text, at, role.id).run();
    await enqueue(env, 'read', role, now);
  } else if (act === 'recheck') {
    if (role.state === 'reading') return bad(409, 'already being read');
    await env.HUB_DB.prepare("UPDATE skill_roles SET state = CASE WHEN state = 'past' THEN 'past' ELSE 'reading' END, error = NULL, updated_at = ? WHERE id = ?").bind(at, role.id).run();
    await enqueue(env, role.read_at && role.state !== 'failed' ? 'match' : 'read', role, now);
  } else if (act === 'past') {
    if (typeof b.past !== 'boolean') return bad(400, 'past: true or false');
    const next = b.past ? 'past' : role.read_at && role.matched_at ? 'ready' : 'reading';
    await env.HUB_DB.prepare('UPDATE skill_roles SET state = ?, updated_at = ? WHERE id = ?').bind(next, at, role.id).run();
    if (next === 'reading') await enqueue(env, 'read', role, now);
  } else if (act === 'delete') {
    await runAll(env, [
      env.HUB_DB.prepare('DELETE FROM skill_reqs WHERE role_id = ?').bind(role.id),
      env.HUB_DB.prepare('DELETE FROM skill_roles WHERE id = ?').bind(role.id),
    ]);
    return ok({ ok: true });
  } else return bad(404, 'not found');
  return ok({ role: await roleBody(env, role.id, now) });
}

async function gapRow(env, key, now) {
  let g = await env.HUB_DB.prepare('SELECT * FROM skill_gaps WHERE key = ?').bind(key).first();
  if (g) return g;
  const q = await env.HUB_DB.prepare('SELECT label FROM skill_reqs WHERE key = ? LIMIT 1').bind(key).first();
  if (!q) return null;
  await env.HUB_DB.prepare('INSERT OR IGNORE INTO skill_gaps (key, label, updated_at) VALUES (?, ?, ?)').bind(key, q.label, iso(now)).run();
  return env.HUB_DB.prepare('SELECT * FROM skill_gaps WHERE key = ?').bind(key).first();
}
async function rolesAsking(env, key) {
  const { results } = await env.HUB_DB.prepare("SELECT r.* FROM skill_roles r JOIN skill_reqs q ON q.role_id = r.id WHERE q.key = ? AND r.state IN ('ready', 'past')").bind(key).all();
  return results || [];
}

async function gapAct(env, key, sub, b, now) {
  const g = await gapRow(env, key, now);
  if (!g) return bad(404, 'no such gap');
  const at = iso(now);
  const [act, sid, sact] = sub;
  if (act === 'step' && sub.length === 1) {
    const text = cleanText(typeof b.text === 'string' ? b.text.slice(0, 300) : '');
    if (!text) return bad(400, 'text: the step');
    await env.HUB_DB.prepare("INSERT INTO skill_steps (id, gap, text, source, created_at) VALUES (?, ?, ?, ?, ?)").bind('s' + rand(8), key, text, b.source === 'claude' ? 'claude' : 'paul', at).run();
    await emit(env, 'gap.step', {}, now, 'Plan step added');
  } else if (act === 'step' && SID.test(sid || '') && sub.length === 3) {
    const step = await env.HUB_DB.prepare('SELECT * FROM skill_steps WHERE id = ? AND gap = ?').bind(sid, key).first();
    if (!step) return bad(404, 'no such step');
    if (sact === 'delete') {
      await env.HUB_DB.prepare('DELETE FROM skill_steps WHERE id = ?').bind(sid).run();
    } else if (sact === 'task') {
      const section = b.section === undefined ? 'soon' : b.section;
      const energy = b.energy === undefined ? 'normal' : b.energy;
      if (!['today', 'soon'].includes(section)) return bad(400, 'section: today or soon');
      if (!ENERGY.includes(energy)) return bad(400, 'energy: ' + ENERGY.join(', '));
      if (step.task_id) return bad(409, 'already a task');
      if (!env.TODO_CODE || !env.TODO_LIST) return bad(503, 'not configured');
      const b2 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('skillstep:' + sid));
      const taskId = Array.from(new Uint8Array(b2), (x) => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
      const text = cleanText(step.text);
      const op = cleanOp({ op: 'upsert', item: { id: taskId, text, section, done: false, doneAt: null, updatedAt: now, pos: now, link: PAGE + '?g=' + key, energy } }, now);
      if (!op) return bad(400, 'could not make the task');
      const r = await listStub(env).fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops: [op] }), headers: { 'Content-Type': 'application/json' } });
      if (!r.ok) return bad(502, 'To-do did not take the task');
      await env.HUB_DB.prepare('UPDATE skill_steps SET task_id = ? WHERE id = ?').bind(taskId, sid).run();
      await emit(env, 'gap.task', { task: taskId }, now, 'Plan step to To-do');
      return ok({ gap: await gapBody(env, key, now), task: { id: taskId, text } });
    } else return bad(404, 'not found');
  } else if (act === 'options' && sub.length === 1) {
    const roles = await rolesAsking(env, key);
    let got;
    try { got = await claude.options(env, g.label, roles.map((r) => r.title + (r.org ? ' (' + r.org + ')' : ''))); } catch (e) { return bad(503, 'Claude could not answer just now'); }
    const options = (got.options || []).slice(0, 3).map((o) => ({ title: line(o.title, 80), text: line(o.text, 240) })).filter((o) => o.title);
    await env.HUB_DB.prepare('UPDATE skill_gaps SET options = ?, options_at = ?, updated_at = ? WHERE key = ?').bind(JSON.stringify(options), at, at, key).run();
    await emit(env, 'gap.options', {}, now, 'Options asked');
  } else if (act === 'close' && sub.length === 1) {
    const note = line(b.note, 300);
    if (!note) return bad(400, 'note: how, in your words');
    await runAll(env, [
      env.HUB_DB.prepare("DELETE FROM skill_lines WHERE source = 'closed' AND gap = ?").bind(key),
      env.HUB_DB.prepare("INSERT INTO skill_lines (id, text, source, gap, pos, created_at) VALUES (?, ?, 'closed', ?, 0, ?)").bind('c' + rand(8), g.label + ': ' + note, key, at),
      env.HUB_DB.prepare('UPDATE skill_gaps SET closed = 1, closed_note = ?, closed_at = ?, updated_at = ? WHERE key = ?').bind(note, at, at, key),
    ]);
    const cl = await env.HUB_DB.prepare("SELECT id FROM skill_lines WHERE source = 'closed' AND gap = ?").bind(key).first();
    await env.HUB_DB.prepare("UPDATE skill_reqs SET status = 'have', line_id = ?, why = 'You closed this gap' WHERE key = ?").bind(cl.id, key).run();
    await emit(env, 'gap.closed', {}, now, 'Gap closed');
  } else if (act === 'reopen' && sub.length === 1) {
    if (g.closed !== 1) return bad(409, 'not closed');
    await runAll(env, [
      env.HUB_DB.prepare("DELETE FROM skill_lines WHERE source = 'closed' AND gap = ?").bind(key),
      env.HUB_DB.prepare('UPDATE skill_gaps SET closed = 0, closed_note = NULL, closed_at = NULL, updated_at = ? WHERE key = ?').bind(at, key),
      env.HUB_DB.prepare("UPDATE skill_reqs SET status = 'unknown', line_id = NULL, why = NULL WHERE key = ?").bind(key),
    ]);
    for (const r of await rolesAsking(env, key)) if (r.state === 'ready') await enqueue(env, 'match', r, now);
    await emit(env, 'gap.reopened', {}, now, 'Gap reopened');
  } else return bad(404, 'not found');
  return ok({ gap: await gapBody(env, key, now) });
}

export async function handleSkills(request, env, rest, json, now = Date.now()) {
  const code = rest[0] || '';
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (!env.HUB_DB) return json({ error: 'not configured' }, request, 503);
  const sub = rest.slice(1);
  if (request.method === 'GET') {
    if (!sub.length) return json(await everything(env, now), request);
    if (sub.length === 1 && sub[0] === 'side') {
      const meta = await env.HUB_KV.get('skills:side', 'json');
      return json({ lines: (await sideAll(env)).map((l) => ({ id: l.id, text: l.text, source: l.source, gap: l.gap || null })), updatedAt: meta && meta.at ? meta.at : null }, request);
    }
    if (sub.length === 2 && sub[0] === 'track' && /^[a-z0-9]{8,32}$/.test(sub[1])) {
      const had = await env.HUB_DB.prepare('SELECT id FROM skill_roles WHERE task_id = ?').bind(sub[1]).first();
      return json({ role: had ? await roleBody(env, had.id, now) : null }, request);
    }
    return json({ error: 'not found' }, request, 404);
  }
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  const got = await readJson(request, sub[0] === 'side' ? MAX_SIDE + 2000 : MAX_POSTING + 4000);
  if (got.error) return json({ error: got.error }, request, got.status);
  const b = got.body;
  let out;
  if (sub.length === 1 && sub[0] === 'side') out = await setSide(env, b, now);
  else if (sub.length === 1 && sub[0] === 'track') out = await track(env, b, now);
  else if (sub.length === 1 && sub[0] === 'role') out = await paste(env, b, now);
  else if (sub[0] === 'role' && RID.test(sub[1] || '') && sub.length === 3) {
    const role = await getRole(env, sub[1]);
    if (!role) return json({ error: 'no such role' }, request, 404);
    out = await roleAct(env, role, sub[2], b, now);
  } else if (sub[0] === 'gap' && KEY.test(sub[1] || '') && sub.length >= 3) out = await gapAct(env, sub[1], sub.slice(2), b, now);
  else return json({ error: 'not found' }, request, 404);
  if (out.error) return json({ error: out.error }, request, out.status);
  return json(out.body, request);
}
