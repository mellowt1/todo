/* Task skills for the tasks already on the list (Paul, 2026-11-04: "go", with one back-fill).
 *
 * Tidy gives every new task the OSRS skill it trains (src/tidy.js). This once-only cron job, like
 * src/lanes.js, does the same for the tasks that were there before: open and done, except an Apply
 * (Slayer already) and an Intake task (Defence already). Claude Haiku reads them in batches of
 * BATCH and answers a skill or none per id; only `skill` is added (text, section, pos and done
 * stay, so Attack still pays), and a task that has one already is left alone. The next Hiscores
 * scan then pays each done task its skill at the time it was done (src/hiscores.js, ts:<id>).
 *
 * KV taskskills:v1 holds what it did. It is reserved before the first call; a failed run says so
 * there and tries again on a later cron run, at most TRIES times. */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { cleanOp, TASK_SKILLS } from './todo.js';
import { anthropic, bumpUsage, dayOf } from './intake.js';
import { TIDY_MODEL, SKILL_LINES } from './tidy.js';
import { APPLY } from './hiscores.js';

export const KEY = 'taskskills:v1';
export const BATCH = 40;
export const TRIES = 3;
const INTAKE_MARK = /\s*\[intake\]$/;

const Answer = z.object({ tasks: z.array(z.object({ id: z.string(), skill: z.enum([...TASK_SKILLS, 'none']) })) });

const SYSTEM = [
  'Paul\'s to-do list pays XP into Old School RuneScape skills. Every task pays Woodcutting; a task may also train one other skill.',
  'For each task you get (id and text), give the one skill it trains besides Woodcutting, or none. The main thing the task is about decides:',
  ...SKILL_LINES.map((l) => '- ' + l),
  'A leading "Name:" means the task is done for that person; judge the task itself. Answer every id once.',
].join('\n');

/* Pure: the tasks that still need a skill. */
export function needSkill(items) {
  return Object.values(items || {}).filter((it) => it && typeof it.text === 'string' && !it.skill && !APPLY.test(it.text) && !INTAKE_MARK.test(it.text));
}

export async function askSkills(env, tasks) {
  const res = await anthropic(env).messages.parse({
    model: TIDY_MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(tasks.map((t) => ({ id: t.id, text: t.text.replace(/\s*·\s*\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/, '') }))) }],
    output_config: { effort: 'low', format: zodOutputFormat(Answer) },
  });
  const usage = { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0 };
  return { tasks: res.stop_reason === 'refusal' || !res.parsed_output ? [] : res.parsed_output.tasks, usage };
}

let asker = askSkills;
export function _setSkillAsker(fn) { asker = fn || askSkills; }

/* Pure: Claude's answers against the list -> the ops (only a known skill, only on a task without one). */
export function skillOps(items, answers, now) {
  const ops = [];
  for (const a of answers || []) {
    const it = a && items[a.id];
    if (!it || it.skill || !TASK_SKILLS.includes(a.skill)) continue;
    const at = Math.max(now, it.updatedAt + 1);
    const op = cleanOp({ op: 'upsert', item: { ...it, skill: a.skill, updatedAt: at } }, at);
    if (op) ops.push(op);
  }
  return ops;
}

export async function taskSkillsOnce(env, now = Date.now()) {
  if (!env.TODO_CODE || !env.HUB_KV || !env.TODO_LIST) return { skip: 'not configured' };
  if (!env.ANTHROPIC_API_KEY) return { skip: 'no key' };
  const was = await env.HUB_KV.get(KEY, 'json');
  if (was && (was.done || was.pending || (was.tries || 0) >= TRIES)) return { skip: was.done ? 'done' : was.pending ? 'running' : 'gave up' };
  const tries = ((was && was.tries) || 0) + 1;
  await env.HUB_KV.put(KEY, JSON.stringify({ pending: true, tries, at: new Date(now).toISOString() }), { expirationTtl: 3600 });
  try {
    const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
    const doc = await (await stub.fetch('https://list/export')).json();
    const items = doc.items || {};
    const todo = needSkill(items);
    const answers = [];
    for (let i = 0; i < todo.length; i += BATCH) {
      const got = await asker(env, todo.slice(i, i + BATCH));
      answers.push(...got.tasks);
      if (got.usage) await bumpUsage(env, dayOf(now).slice(0, 7), got.usage, 'tidy').catch(() => {});
    }
    // Read again just before writing, so a task changed meanwhile keeps its change.
    const fresh = (await (await stub.fetch('https://list/export')).json()).items || {};
    const ops = skillOps(fresh, answers, Date.now());
    if (ops.length) {
      const r = await stub.fetch('https://list/apply', { method: 'POST', body: JSON.stringify({ ops }), headers: { 'Content-Type': 'application/json' } });
      if (!r.ok) throw new Error('todo apply ' + r.status);
    }
    const by = {};
    for (const o of ops) by[o.item.skill] = (by[o.item.skill] || 0) + 1;
    await env.HUB_KV.put(KEY, JSON.stringify({ done: true, at: new Date(now).toISOString(), read: todo.length, set: ops.length, by }));
    return { read: todo.length, set: ops.length };
  } catch (e) {
    await env.HUB_KV.put(KEY, JSON.stringify({ tries, error: String((e && e.message) || e).slice(0, 200), at: new Date(now).toISOString() }));
    return { error: String((e && e.message) || e) };
  }
}
