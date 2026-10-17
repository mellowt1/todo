/* The Mirror: one row per day from the apps the hub can read, and once each Sunday one finding
 * about Paul's own days from those rows, with a small experiment for the week and how last
 * week's went.
 *
 * Rows (D1 mirror_days, migrations/0006_mirror.sql), one per Amsterdam date:
 *   mood     Paul's Feeling face: 1 very bad, 2 bad, 3 okay, 4 good, 5 very good, 6 angry. From the
 *            circle relay (service binding FEELING); config mirror_feeling = {"code","id"} names
 *            Paul in one circle. The relay keeps 31 days, so these rows are the long copy.
 *   done     to-dos ticked off that day (the list's Durable Object)
 *   dinner   Paul's Kitchen dinner: recipe | pizza | text, or out when Day said he is out
 *   arsenal  W | D | L on a day Arsenal played (ESPN; a shootout decides a draw)
 *   temp rain sun          Den Haag: max °C, mm, hours of sunshine (Open-Meteo)
 *   cal_n cal_h cal_first  Day's calendar that day: events, hours of timed events, first start.
 *            Only from the day the Mirror started: the calendar push holds today onwards.
 *
 * The cron (mirrorCron, every run): once a day from 05:00 it writes the last 7 days again (late
 * faces and ticks) and today's calendar; the very first run writes the last 60 days. A source
 * that fails leaves its columns as they were.
 *
 * Sundays from 06:00, once (KV mirror:week:<monday>, reserved before the call):
 *   1. candidates(): for each outcome (mood, done) and each yes/no factor (the same day or the
 *      day before), both means, both counts, the effect size and a Welch p value. Code does all
 *      the counting; Claude never computes a number.
 *   2. Claude picks one candidate and writes it as a sentence, and picks one experiment for the
 *      seven days from today among the factors Paul controls (dinner, calendar, tasks).
 *   3. The Sunday after, the code scores the experiment (days hit, the outcome those days against
 *      the four weeks before) and Claude says in one sentence how it went.
 *   Morning shows it in the Week view (week.mirror). Read only: the Mirror writes nothing into
 *   any app, only mirror_days and mirror:* keys.
 */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { local, zoned, addDays, eventSpan, CAL_KEY, ESPN_HOSTS, ESPN_RESULTS, espnMatch } from './morning.js';
import { kitchen } from './kitchen-store.js';
import { readConfig } from './dinner.js';
import { anthropic, MODEL } from './intake.js';
import { noDashes } from './mask.js';

const DAY = 24 * 3600 * 1000;
export const COLLECT_HOUR = 5;
export const FIND_HOUR = 6;
export const FIRST_DAYS = 60;
export const AGAIN_DAYS = 7;
export const MIN_SIDE = 4;     // days on each side of a split before it counts at all
export const MAX_P = 0.2;      // a looser bar than science: this is a hint to try, said as one
export const MIN_D = 0.4;
export const COLLECTED_KEY = 'mirror:collected';
export const WEEK_PREFIX = 'mirror:week:';
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const COLS = ['mood', 'done', 'dinner', 'arsenal', 'temp', 'rain', 'sun', 'cal_n', 'cal_h', 'cal_first'];

/* ---------- Dates ---------- */

const dayOf = (ms) => local(ms).date;
const weekdayOf = (date) => new Date(date + 'T12:00:00Z').getUTCDay();
const mondayOf = (date) => addDays(date, -((weekdayOf(date) + 6) % 7));

/* "2026-W39" + "fri" -> "2026-09-25" (ISO weeks: week 1 holds 4 January). */
export function isoWeekDate(week, wd) {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  const i = WD.indexOf(wd);
  if (!m || i < 0) return null;
  const jan4 = `${m[1]}-01-04`;
  return addDays(mondayOf(jan4), (+m[2] - 1) * 7 + ((i + 6) % 7));
}

/* ---------- The sources (pure parts) ---------- */

/* To-dos ticked per date, and the first date anything was ticked: before it the list did not
 * exist yet, so those days are unknown, not zero. */
export function doneByDay(items) {
  const days = {};
  let first = null;
  for (const i of Object.values(items || {})) {
    if (!i || !i.done || !Number.isFinite(i.doneAt)) continue;
    const d = dayOf(i.doneAt);
    days[d] = (days[d] || 0) + 1;
    if (first === null || d < first) first = d;
  }
  return { days, first };
}

/* Paul's dinners per date from the kitchen export; a date Day marked away is "out". The export
 * keeps away entries as { base: { date, away, seq } } (the read route as a list of dates), and
 * drops them a week after the date: known lists the dates that still have one, so a dropped
 * entry never turns a night out back into the meal that was planned. */
export function dinnersByDay(data) {
  const days = {};
  const known = new Set();
  for (const r of Object.values((data && data.items) || {})) {
    if (!r || r.type !== 'day') continue;
    const m = /^(\d{4}-W\d{2}):([a-z]{3}):paul:dinner$/.exec(r.id || '');
    const date = m && isoWeekDate(m[1], m[2]);
    if (date && ['recipe', 'pizza', 'text'].includes(r.kind)) days[date] = r.kind;
  }
  const away = (data && data.away) || [];
  const list = Array.isArray(away) ? away.map((date) => ({ date, away: true })) : Object.values(away);
  for (const a of list) {
    if (!a || !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) continue;
    known.add(a.date);
    if (a.away) days[a.date] = 'out';
  }
  return { days, known: [...known].sort() };
}

/* Paul's faces from the circle's member list. */
export function moodsOf(members, id) {
  const me = (members || []).find((m) => m && m.id === id);
  const out = {};
  for (const [d, v] of Object.entries((me && me.days) || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v >= 1 && v <= 6) out[d] = Number(v);
  return out;
}

/* W, D or L per date from ESPN's results; a draw settled on penalties counts as its result. */
export function resultsByDay(results) {
  const out = {};
  for (const e of (results && results.events) || []) {
    const m = espnMatch(e);
    if (!m || !m.completed || m.us === null || m.them === null) continue;
    let r = m.us > m.them ? 'W' : m.us < m.them ? 'L' : 'D';
    if (r === 'D' && m.usPens !== null && m.themPens !== null && m.usPens !== m.themPens) r = m.usPens > m.themPens ? 'W' : 'L';
    out[dayOf(Date.parse(m.kickoff))] = r;
  }
  return out;
}

export const WEATHER_PAST = (days) => 'https://api.open-meteo.com/v1/forecast?latitude=52.08&longitude=4.30'
  + '&daily=temperature_2m_max,precipitation_sum,sunshine_duration&timezone=Europe%2FAmsterdam'
  + `&past_days=${Math.min(92, days)}&forecast_days=1`;

export function weatherByDay(w) {
  const d = w && w.daily;
  const out = {};
  if (!d || !Array.isArray(d.time)) return out;
  d.time.forEach((date, i) => {
    const n = (a, f = (x) => x) => (Array.isArray(a) && Number.isFinite(a[i]) ? f(a[i]) : null);
    out[date] = { temp: n(d.temperature_2m_max), rain: n(d.precipitation_sum), sun: n(d.sunshine_duration, (s) => Math.round(s / 360) / 10) };
  });
  return out;
}

/* A subscribed Arsenal fixture is not Paul's plan (the same test as Day's dinner rule). */
const fixture = (e) => /arsenal/i.test(e.title || '') && /\svs\.?\s/i.test(e.title || '');

/* Day's calendar for one date: count, hours of timed events inside the day, first start. */
export function calendarDay(events, date) {
  const from = zoned(date), to = zoned(addDays(date, 1));
  let n = 0, h = 0, first = null;
  for (const e of events || []) {
    if (fixture(e)) continue;
    let s, en;
    try { [s, en] = eventSpan(e); } catch (err) { continue; }
    if (!Number.isFinite(s) || !Number.isFinite(en)) continue;
    if (!(en > s ? s < to && en > from : s >= from && s < to)) continue;
    n++;
    if (e.allDay) continue;
    h += (Math.min(en, to) - Math.max(s, from)) / 3600000;
    if (s >= from) {
      const at = local(s).minutes / 60;
      if (first === null || at < first) first = at;
    }
  }
  return { cal_n: n, cal_h: Math.round(h * 10) / 10, cal_first: first === null ? null : Math.round(first * 100) / 100 };
}

/* ---------- Collecting ---------- */

async function getJson(url, fetcher) {
  const r = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': 'paul-hub mirror' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('status ' + r.status);
  return r.json();
}

async function readSources(env, back, fetcher) {
  const todo = async () => {
    const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
    const r = await stub.fetch('https://list/export');
    if (!r.ok) throw new Error('todo ' + r.status);
    return doneByDay((await r.json()).items);
  };
  const dinners = async () => {
    if (!env.KITCHEN_CODE || !env.KITCHEN_STORE) throw new Error('no kitchen');
    const r = await kitchen(env, env.KITCHEN_CODE, '/export');
    if (r.status !== 200) throw new Error('kitchen ' + r.status);
    return dinnersByDay(r.data);
  };
  const moods = async () => {
    const cfg = JSON.parse((await readConfig(env, ['mirror_feeling'])).mirror_feeling || 'null');
    if (!cfg || !env.FEELING) throw new Error('no feeling');
    const r = await env.FEELING.fetch('https://feeling-circle/api/circle/' + cfg.code);
    if (!r.ok) throw new Error('feeling ' + r.status);
    return moodsOf((await r.json()).members, cfg.id);
  };
  const arsenal = async () => {
    try { return resultsByDay(await getJson(ESPN_RESULTS, fetcher)); } catch (e) {
      return resultsByDay(await getJson(ESPN_RESULTS.replace(ESPN_HOSTS[0], ESPN_HOSTS[1]), fetcher));
    }
  };
  const weather = async () => weatherByDay(await getJson(WEATHER_PAST(back + 1), fetcher));
  const cal = async () => {
    const c = await env.HUB_KV.get(CAL_KEY, 'json');
    if (!c || !Array.isArray(c.events)) throw new Error('no calendar');
    return c.events;
  };
  const names = ['done', 'dinner', 'mood', 'arsenal', 'weather', 'cal'];
  const got = await Promise.allSettled([todo(), dinners(), moods(), arsenal(), weather(), cal()]);
  const out = {}, failed = [];
  got.forEach((g, i) => { if (g.status === 'fulfilled') out[names[i]] = g.value; else failed.push(names[i]); });
  return { ...out, failed };
}

/* Pure: the rows to write. A failed source gives NULL (kept as it was); a working source with
 * nothing on a date gives its "none" (0 ticks, no match). The calendar only for today. */
export function buildRows(src, dates, today) {
  return dates.map((date) => {
    const w = src.weather && src.weather[date];
    const cal = src.cal && date === today ? calendarDay(src.cal, date) : null;
    const past = date < today;
    return {
      date,
      mood: src.mood ? src.mood[date] ?? null : null,
      done: src.done && past && src.done.first && date >= src.done.first ? src.done.days[date] || 0 : null,
      dinner: src.dinner ? src.dinner.days[date] ?? null : null,
      keepOut: src.dinner ? !src.dinner.known.includes(date) : true,
      arsenal: src.arsenal ? src.arsenal[date] ?? null : null,
      temp: w && past ? w.temp : null,
      rain: w && past ? w.rain : null,
      sun: w && past ? w.sun : null,
      cal_n: cal ? cal.cal_n : null,
      cal_h: cal ? cal.cal_h : null,
      cal_first: cal ? cal.cal_first : null,
    };
  });
}

/* ?1 date, ?2..?11 the columns, ?12 updated_at, ?13 keep a stored "out" (no away entry is left to say otherwise). */
const UPSERT = `INSERT INTO mirror_days (date, ${COLS.join(', ')}, updated_at) VALUES (?1, ${COLS.map((c, i) => '?' + (i + 2)).join(', ')}, ?12)
  ON CONFLICT(date) DO UPDATE SET ${COLS.map((c) => (c === 'dinner'
    ? "dinner = CASE WHEN ?13 = 1 AND dinner = 'out' THEN dinner ELSE COALESCE(excluded.dinner, dinner) END"
    : `${c} = COALESCE(excluded.${c}, ${c})`)).join(', ')}, updated_at = excluded.updated_at`;

export async function collect(env, now = Date.now(), fetcher = fetch) {
  const today = dayOf(now);
  const any = await env.HUB_DB.prepare('SELECT date FROM mirror_days LIMIT 1').first();
  const back = any ? AGAIN_DAYS : FIRST_DAYS;
  const dates = [];
  for (let i = back; i >= 0; i--) dates.push(addDays(today, -i));
  const src = await readSources(env, back, fetcher);
  const at = new Date(now).toISOString();
  const rows = buildRows(src, dates, today);
  await env.HUB_DB.batch(rows.map((r) => env.HUB_DB.prepare(UPSERT).bind(r.date, ...COLS.map((c) => r[c]), at, r.keepOut ? 1 : 0)));
  return { days: rows.length, failed: src.failed };
}

/* ---------- Reading the rows (pure) ---------- */

/* Angry is not on the line from very bad to very good; for the maths it counts as bad. */
export const score = (mood) => (mood === 6 ? 2 : mood >= 1 && mood <= 5 ? mood : null);
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

export const OUTCOMES = {
  mood: { label: 'mood', get: (r) => score(r.mood) },
  done: { label: 'tasks done', get: (r) => r.done },
};

/* Yes/no factors. lag 1 reads the day before. ctl: Paul can choose it, so it can be an experiment;
 * track names the same-day factor an experiment counts. skip: the outcome it would only restate. */
export function factors(rows) {
  const doneMid = Math.max(1, median(rows.map((r) => r.done)) ?? 1);
  const tempMid = median(rows.map((r) => r.temp));
  const nul = (v, f) => (v === null || v === undefined ? null : f(v));
  return [
    { id: 'weekend', yes: 'weekends', no: 'weekdays', test: (r) => r.wd === 0 || r.wd === 6 },
    { id: 'rain', yes: 'rainy days (2 mm or more)', no: 'dry days', test: (r) => nul(r.rain, (v) => v >= 2) },
    { id: 'sun', yes: 'sunny days (4 hours of sun or more)', no: 'greyer days', test: (r) => nul(r.sun, (v) => v >= 4) },
    { id: 'warm', yes: `warmer days (${tempMid} °C or more)`, no: 'colder days', test: (r) => (tempMid === null ? null : nul(r.temp, (v) => v >= tempMid)) },
    { id: 'match', yes: 'Arsenal match days', no: 'days without a match', test: (r) => r.arsenal !== null },
    { id: 'dropped_y', lag: 1, yes: 'the day after Arsenal dropped points', no: 'other days', test: (r) => r.arsenal === 'L' || r.arsenal === 'D' },
    { id: 'won_y', lag: 1, yes: 'the day after an Arsenal win', no: 'other days', test: (r) => r.arsenal === 'W' },
    { id: 'cooked', ctl: true, yes: 'days you cooked a recipe for dinner', no: 'other days', test: (r) => nul(r.dinner, (v) => v === 'recipe') },
    { id: 'out', ctl: true, yes: 'days you were out for dinner', no: 'days you ate at home', test: (r) => nul(r.dinner, (v) => v === 'out') },
    { id: 'out_y', lag: 1, ctl: true, track: 'out', yes: 'the day after dinner out', no: 'the day after dinner at home', test: (r) => nul(r.dinner, (v) => v === 'out') },
    { id: 'busy', ctl: true, yes: 'days with 3 hours or more in the calendar', no: 'lighter days', test: (r) => nul(r.cal_h, (v) => v >= 3) },
    { id: 'busy_y', lag: 1, ctl: true, track: 'busy', yes: 'the day after a full calendar', no: 'the day after a lighter one', test: (r) => nul(r.cal_h, (v) => v >= 3) },
    { id: 'early', ctl: true, yes: 'days that start before 9:00', no: 'days that start later or are free', test: (r) => nul(r.cal_n, () => r.cal_first !== null && r.cal_first < 9) },
    { id: 'free', ctl: true, yes: 'days with nothing in the calendar', no: 'days with something on', test: (r) => nul(r.cal_n, (v) => v === 0) },
    { id: 'productive', ctl: true, skip: 'done', yes: `days you ticked off ${doneMid} or more`, no: `days with fewer than ${doneMid}`, test: (r) => nul(r.done, (v) => v >= doneMid) },
    { id: 'productive_y', lag: 1, ctl: true, track: 'productive', skip: 'done', yes: `the day after ticking off ${doneMid} or more`, no: 'the day after a quieter one', test: (r) => nul(r.done, (v) => v >= doneMid) },
    { id: 'goodmood', skip: 'mood', yes: 'good or very good days', no: 'okay or worse days', test: (r) => nul(score(r.mood), (v) => v >= 4) },
    { id: 'goodmood_y', lag: 1, skip: 'mood', yes: 'the day after a good day', no: 'the day after an okay or worse one', test: (r) => nul(score(r.mood), (v) => v >= 4) },
  ];
}

/* Two-sided p from Welch's t, normal approximation with a small-sample correction. */
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
export function welch(a, b) {
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const vari = (xs, m) => xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  const ma = mean(a), mb = mean(b), va = vari(a, ma), vb = vari(b, mb);
  const se = Math.sqrt(va / a.length + vb / b.length);
  const sd = Math.sqrt(((a.length - 1) * va + (b.length - 1) * vb) / (a.length + b.length - 2));
  if (!(se > 0) || !(sd > 0)) return { diff: ma - mb, d: 0, p: 1 };
  const t = (ma - mb) / se;
  const df = (va / a.length + vb / b.length) ** 2 / ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1));
  const z = Math.abs(t) * (1 - 1 / (4 * df)) / Math.sqrt(1 + t * t / (2 * df));
  return { diff: ma - mb, d: (ma - mb) / sd, p: 2 * (1 - phi(z)) };
}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

/* rows: [{ date, mood, done, ... }] for past days. Every split, strong or not, with its numbers. */
export function splits(rows) {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const withWd = rows.map((r) => ({ ...r, wd: weekdayOf(r.date) }));
  const fs = factors(withWd);
  const out = [];
  for (const [oid, o] of Object.entries(OUTCOMES)) {
    for (const f of fs) {
      if (f.skip === oid) continue;
      const yes = [], no = [];
      for (const r of withWd) {
        const y = o.get(r);
        if (y === null || y === undefined) continue;
        const src = f.lag ? byDate.get(addDays(r.date, -1)) : r;
        if (!src) continue;
        const v = f.test(f.lag ? { ...src, wd: weekdayOf(src.date) } : src);
        if (v === null || v === undefined) continue;
        (v ? yes : no).push(y);
      }
      if (yes.length < MIN_SIDE || no.length < MIN_SIDE) continue;
      const w = welch(yes, no);
      out.push({
        id: `${oid}.${f.id}`, outcome: oid, factor: f.id, yesLabel: f.yes, noLabel: f.no, ctl: !!f.ctl, track: f.track || f.id,
        yes: { n: yes.length, mean: r1(yes.reduce((s, x) => s + x, 0) / yes.length) },
        no: { n: no.length, mean: r1(no.reduce((s, x) => s + x, 0) / no.length) },
        d: r2(w.d), p: r2(w.p),
      });
    }
  }
  return out.sort((a, b) => a.p - b.p || Math.abs(b.d) - Math.abs(a.d));
}

export const strong = (list) => list.filter((s) => s.p <= MAX_P && Math.abs(s.d) >= MIN_D);

/* The numbers line Morning shows under the finding. */
export function numbersLine(s) {
  const unit = s.outcome === 'mood' ? ' of 5' : '';
  const what = s.outcome === 'mood' ? 'Mood' : 'Tasks done';
  return `${what} ${s.yes.mean}${unit} on ${s.yesLabel} (${s.yes.n} days), ${s.no.mean}${unit} on ${s.noLabel} (${s.no.n} days)`;
}

/* Pure: score last week's experiment from the rows. */
export function scoreExperiment(exp, rows) {
  if (!exp) return null;
  const withWd = rows.map((r) => ({ ...r, wd: weekdayOf(r.date) }));
  const f = factors(withWd).find((x) => x.id === exp.factor);
  if (!f) return null;
  const o = OUTCOMES[exp.outcome] || OUTCOMES.mood;
  const inWeek = withWd.filter((r) => r.date >= exp.from && r.date <= exp.to);
  const before = withWd.filter((r) => r.date < exp.from && r.date >= addDays(exp.from, -28));
  const hits = inWeek.filter((r) => f.test(r) === true).length;
  const avg = (rs) => { const v = rs.map(o.get).filter(Number.isFinite); return v.length ? { mean: r1(v.reduce((s, x) => s + x, 0) / v.length), n: v.length } : null; };
  return {
    hits, target: exp.target, want: exp.want,
    met: exp.want === 'fewer' ? hits <= exp.target : hits >= exp.target,
    week: avg(inWeek), before: avg(before), outcome: exp.outcome,
  };
}

/* ---------- Claude: one finding, one experiment, last week's result ---------- */

const SYSTEM = [
  "You are the Mirror on Paul's Morning screen. Once a week you tell him one true, useful thing about his own days, from numbers his apps counted: Feeling (his mood face each day, 1 very bad to 5 very good), To-do (tasks ticked off), Kitchen (what he had for dinner), Day (his calendar), the weather in Den Haag and Arsenal's results.",
  'The code did all the counting. You get candidate splits: an outcome (mood or tasks done), a yes/no factor, both means, both day counts, an effect size d and a p value. Lower p and more days mean less likely to be noise.',
  'Pick the one candidate that is most useful to Paul and least likely to be noise. Prefer something he can act on; a weather or Arsenal link is fine when it is clearly the strongest.',
  'finding: one or two sentences, under 220 characters, plain English, to Paul as "you", with the two means in the sentence. A same-day link can run either way, so say "tends to" or "on days when", never "causes". Say it is a hint from his own last weeks only if p is above 0.1.',
  'experiment: one week, starting today, built on one factor from the controllable list, as a change in how many of the next 7 days it happens (want "more" or "fewer", target 1 to 7 days). text: an instruction under 120 characters, like "Cook a recipe on 4 nights this week." Choose a target he can actually reach next to what the numbers show. Null only if the list is empty.',
  'last: if lastExperiment is given, one sentence under 200 characters on how it went, from its numbers only (days hit against the target, the outcome that week against the four weeks before). Otherwise an empty string.',
  'Use only the facts given; never invent numbers, names or events. Never use dashes as punctuation; use commas or full stops. No greeting, no markdown, no praise inflation.',
].join('\n');

export async function askClaude(env, facts) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const ids = facts.candidates.map((c) => c.id);
  const ctl = facts.controllable.map((c) => c.factor);
  const Out = z.object({
    pick: z.enum(ids),
    finding: z.string().max(300),
    experiment: ctl.length
      ? z.object({ factor: z.enum([...new Set(ctl)]), want: z.enum(['more', 'fewer']), target: z.number().int().min(1).max(7), text: z.string().max(160) }).nullable()
      : z.null(),
    last: z.string().max(260),
  });
  const res = await anthropic(env).beta.messages.parse({
    model: MODEL,
    max_tokens: 3000,
    system: SYSTEM,
    messages: [{ role: 'user', content: 'The facts (JSON):\n' + JSON.stringify(facts) }],
    output_config: { effort: 'medium', format: zodOutputFormat(Out) },
    fallbacks: 'default',
    betas: ['server-side-fallback-2026-07-01'],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return null;
  return res.parsed_output;
}

let asker = askClaude;
export function _setAsker(fn) { asker = fn || askClaude; }

const trimTo = (s, n) => (s ? noDashes(String(s)).slice(0, n).trim() : '');

/* Pure: what the week's card holds, from the rows, last week's card and Claude's answer (or none). */
export function weekCard(rows, last, today, answer) {
  const all = splits(rows);
  const cands = strong(all).slice(0, 8);
  const ctl = all.filter((s) => s.ctl && s.p <= 0.5).slice(0, 8);
  const lastExp = last && last.experiment ? { ...last.experiment, score: scoreExperiment(last.experiment, rows) } : null;
  const moodDays = rows.filter((r) => score(r.mood) !== null).length;
  const base = { days: rows.length, moodDays, last: null };
  if (lastExp && lastExp.score) {
    const s = lastExp.score;
    const fall = `${s.met ? 'You hit it' : 'Not quite'}: ${s.hits} of 7 days against a target of ${s.want === 'fewer' ? 'at most ' : ''}${s.target}.`;
    base.last = { text: trimTo(answer && answer.last, 240) || fall, experiment: lastExp.text, ...s };
  }
  const pick = cands.find((c) => answer && c.id === answer.pick) || cands[0];
  if (!pick) return { ...base, finding: null, experiment: null };
  const fallback = `Your ${OUTCOMES[pick.outcome].label} tends to be ${pick.yes.mean > pick.no.mean ? 'higher' : 'lower'} on ${pick.yesLabel}.`;
  const finding = { text: trimTo(answer && answer.finding, 280) || fallback, numbers: numbersLine(pick), id: pick.id, outcome: pick.outcome, factor: pick.factor, yes: pick.yes, no: pick.no, p: pick.p, d: pick.d };
  let experiment = null;
  const e = answer && answer.experiment;
  const from = ctl.find((c) => e && c.factor === e.factor);
  if (e && from) experiment = { text: trimTo(e.text, 160), factor: from.track, want: e.want, target: e.target, outcome: from.outcome, from: today, to: addDays(today, 6) };
  return { ...base, finding, experiment };
}

/* Pure: what Claude sees. */
export function factsFor(rows, last) {
  const all = splits(rows);
  const show = (s) => ({ id: s.id, outcome: s.outcome, factor: s.factor, yes: { label: s.yesLabel, ...s.yes }, no: { label: s.noLabel, ...s.no }, d: s.d, p: s.p });
  const lastExp = last && last.experiment ? { text: last.experiment.text, ...scoreExperiment(last.experiment, rows) } : null;
  return {
    days: rows.length,
    moodDays: rows.filter((r) => score(r.mood) !== null).length,
    candidates: strong(all).slice(0, 8).map(show),
    controllable: all.filter((s) => s.ctl && s.p <= 0.5).slice(0, 8).map(show),
    lastExperiment: lastExp,
  };
}

async function readRows(env, before) {
  const { results } = await env.HUB_DB.prepare(`SELECT date, ${COLS.join(', ')} FROM mirror_days WHERE date < ? ORDER BY date`).bind(before).all();
  return results || [];
}

/* Sundays from 06:00, once, after today's rows are in. */
export async function weekFinding(env, now = Date.now()) {
  const l = local(now);
  if (l.weekday !== 0) return { skip: 'not Sunday' };
  if (l.minutes < FIND_HOUR * 60) return { skip: 'too early' };
  if ((await env.HUB_KV.get(COLLECTED_KEY)) !== l.date) return { skip: 'rows not in yet' };
  const monday = mondayOf(l.date);
  const key = WEEK_PREFIX + monday;
  if (await env.HUB_KV.get(key)) return { skip: 'written' };
  await env.HUB_KV.put(key, JSON.stringify({ at: new Date(now).toISOString(), pending: true }));
  const rows = await readRows(env, l.date);
  const last = await env.HUB_KV.get(WEEK_PREFIX + addDays(monday, -7), 'json');
  const facts = factsFor(rows, last);
  let answer = null;
  if (facts.candidates.length || facts.lastExperiment) {
    try { answer = await asker(env, facts); } catch (e) { answer = null; }
  }
  const card = { at: new Date(now).toISOString(), ...weekCard(rows, last, l.date, answer) };
  await env.HUB_KV.put(key, JSON.stringify(card));
  return { written: !!card.finding, claude: !!answer };
}

/* For Morning's week block: this week's card, or null while it is not written. */
export async function mirrorFor(env, monday) {
  const m = await env.HUB_KV.get(WEEK_PREFIX + monday, 'json');
  return m && !m.pending ? m : null;
}

export async function mirrorCron(env, now = Date.now(), fetcher = fetch) {
  if (!env.HUB_DB || !env.TODO_CODE) return { skip: 'not configured' };
  const l = local(now);
  let collected = { skip: 'done today' };
  if (l.minutes >= COLLECT_HOUR * 60 && (await env.HUB_KV.get(COLLECTED_KEY)) !== l.date) {
    collected = await collect(env, now, fetcher);
    await env.HUB_KV.put(COLLECTED_KEY, l.date);
  }
  const found = await weekFinding(env, now);
  return { collected, found };
}
