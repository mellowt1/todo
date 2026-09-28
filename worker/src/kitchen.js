/* The kitchen module: validation, the per record merge and the calendar maths.
 *
 * Pure functions only, so they can be tested in Node without a Worker runtime.
 *
 * Five record types, each merged on its own (newest updatedAt wins, deletes leave a
 * tombstone), so two phones editing different things never lose each other's work:
 *
 *   recipe  { id, title, servings, time, veg, ingredients: [{ qty, unit, item, aisle, group? }], steps: [text], notes }
 *   day     { id: "<YYYY-Www>:<mon..sun>:<person>:<meal>", kind: "recipe" | "text" | "pizza", recipeId, text, servings }
 *           one meal of one person. The old "<YYYY-Www>:<mon..sun>" (a dinner for both, before
 *           each had a plan) is still accepted, so a phone on the old page keeps working.
 *   extra   { id, week, text, qty, aisle }         a free item on the shopping list of one week
 *   tick    { id: "<YYYY-Www>|<item key>", on }     a ticked line on that week's list
 *   dough   { id: "dough", size, count, thickness, gf, night, tweaks }   one settings record
 *
 * Every record also carries updatedAt (ms since epoch) and its type. An op is
 *   { op: "upsert", type, item }   or   { op: "delete", type, item: { id, updatedAt } }
 */

export const TYPES = ['recipe', 'day', 'extra', 'tick', 'dough'];
// The shop's order. app/logic.js has the same list; keep the two identical.
export const AISLES = ['produce', 'bread', 'dairy', 'meat', 'vegetarian', 'pasta', 'tins', 'baking', 'spices', 'frozen', 'drinks', 'household', 'other'];
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const THICKNESS = ['thin', 'regular', 'thick'];
// Whose plan and which meal a day record is. app/logic.js has the same.
export const PEOPLE = ['paul', 'olivia'];
export const MEALS = ['breakfast', 'lunch', 'dinner'];

export const ID = /^[a-z0-9]{8,32}$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const LIMITS = {
  title: 200, time: 40, unit: 20, item: 120, group: 60, step: 1000, steps: 40, ingredients: 80,
  notes: 4000, dayText: 200, extraText: 200, qty: 40, key: 120, servings: 50,
  recipeBytes: 60000, ops: 200, rows: 20000,
};
// Baker's percentages the dough may be tweaked to, in percent of the flour.
export const TWEAKS = { water: [40, 100], yeast: [0, 5], salt: [0, 6], sugar: [0, 10], oil: [0, 15], gfWater: [40, 110] };
export const TOMB_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;
const MIN_TIME = Date.UTC(2020, 0, 1);
const SKEW = 5 * 60 * 1000;

/* ---------- Calendar: ISO weeks, Monday first ---------- */

export function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function addDays(date, n) {
  const t = Date.parse(date + 'T00:00:00Z') + n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/* 'YYYY-MM-DD' -> { week: 'YYYY-Www', day: 'mon'..'sun' } */
export function isoWeek(date) {
  const d = new Date(date + 'T00:00:00Z');
  const wd = (d.getUTCDay() + 6) % 7; // 0 Monday
  const thu = new Date(d.getTime() + (3 - wd) * DAY_MS);
  const year = thu.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mon1 = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY_MS;
  const n = 1 + Math.round((d.getTime() - wd * DAY_MS - mon1) / (7 * DAY_MS));
  return { week: `${year}-W${String(n).padStart(2, '0')}`, day: WEEKDAYS[wd] };
}

/* The Monday of an ISO week, 'YYYY-MM-DD'. */
export function weekStart(week) {
  const m = WEEK_RE.exec(week);
  const jan4 = new Date(Date.UTC(+m[1], 0, 4));
  const mon1 = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(mon1 + (+m[2] - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
}

export function validWeek(s) {
  if (typeof s !== 'string') return false;
  const m = WEEK_RE.exec(s);
  if (!m || +m[1] < 2020 || +m[1] > 2100 || +m[2] < 1) return false;
  return isoWeek(`${m[1]}-12-28`).week >= s; // Dec 28 is always in the year's last week
}

export function dayDate(dayId) {
  const [week, day] = dayId.split(':');
  return addDays(weekStart(week), WEEKDAYS.indexOf(day));
}

/* ---------- Text ---------- */

// One line: control characters dropped, whitespace collapsed. app/logic.js has the same.
export function cleanLine(v, max, allowEmpty = false) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if ((!t && !allowEmpty) || t.length > max) return null;
  return t;
}

// Several lines (notes): line breaks kept, at most two in a row.
export function cleanBlock(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? null : t;
}

/* Recipe titles: capitals on the words that need them. app/logic.js has the same; keep the two identical.
 * "chickpea and spinach curry" -> "Chickpea and Spinach Curry", "seco de pollo" -> "Seco de Pollo",
 * "pasta alla norma" -> "Pasta alla Norma", "bucatini all'amatriciana" -> "Bucatini all'Amatriciana".
 * Small words stay small unless first, last or after a colon. BBQ, BLT and a few more are always
 * in capitals; any other word with a capital after its first letter (McCain) is kept as typed.
 * A title typed in capitals starts from lower case. Running it twice changes nothing. */
const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'n', 'but', 'or', 'nor', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'onto', 'per', 'to', 'via', 'vs', 'with',
  'al', 'alla', 'alle', 'allo', 'ai', 'agli', 'di', 'del', 'della', 'delle', 'dello', 'dei', 'degli', 'da', 'dalla', 'e', 'con',
  'de', 'la', 'las', 'los', 'el', 'y', 'en', 'à', 'au', 'aux', 'du', 'des', 'le', 'les', 'et',
  'met', 'van', 'het',
]);
// Always in capitals, however they were typed.
const UPPER_WORDS = new Set(['bbq', 'blt', 'kfc', 'pb&j', 'ny', 'nyc', 'uk', 'usa', 'gf', 'df', 'vg']);
// l'orange, all'amatriciana; not the English 's of "Nell's".
const ELISION = /^(\P{L}*)(l|d|all|dell|nell|sull|dall)(['’])(?![sS]$)(\p{L}.*)$/iu;
// Hyphens (the two Unicode ones too) and slashes join the parts of a word.
const JOINERS = /([-\u2010\u2011/])/u;
const wordCore = (w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
// Upper case the letter a word starts with (not the h of 4th). Letters that would not come back
// in lower case (ß, ı) and scripts with no capitals for titles (Georgian, the dž letters) stay.
const capFirst = (w) => w.replace(/^([^\p{L}\p{N}]*)(\p{L})/u, (m, pre, c) => {
  const u = c.toUpperCase();
  return pre + (u.length === 1 && u.toLowerCase() === c && !/\p{Script=Georgian}|[\u01c4-\u01cc\u01f1-\u01f3]/u.test(c) ? u : c);
});

function titleWord(w, first, last) {
  const core = wordCore(w);
  if (!core) return w;
  if (/^['’]t$/i.test(w)) return w.toLowerCase(); // Dutch 't, as in "Hachee van 't Oosten"
  if (!first && !last && SMALL_WORDS.has(core)) return w.toLowerCase();
  if (UPPER_WORDS.has(core)) return w.toUpperCase();
  if (/\p{L}.*\p{Lu}/u.test(w)) return w; // McCain, all'Amatriciana: as typed
  const el = ELISION.exec(w);
  if (el) return el[1] + (first ? capFirst(el[2]) : el[2].toLowerCase()) + el[3] + capFirst(el[4]);
  if (/^ij\p{L}/u.test(core)) return w.replace(/ij/i, 'IJ'); // Dutch IJskoffie
  return capFirst(w);
}

// Typed in capitals: no lower-case letter after a letter, and at least three capitals after one
// (TOM YUM, CHICKEN CURRY). BBQ and the like count neither way. The answer is then the same for
// the formatted title, so a second run changes nothing.
function typedInCaps(t) {
  const rest = t.split(/[ \-\u2010\u2011/]/u).filter((p) => !UPPER_WORDS.has(wordCore(p))).join(' ');
  if (/\p{L}\p{Ll}/u.test(rest)) return false;
  let n = 0;
  for (const m of rest.match(/\p{L}\p{Lu}+/gu) || []) n += [...m].length - 1;
  return n >= 3;
}

export function titleCase(v) {
  // The page's cleanLine(v) without a limit: the same cleaning, nothing cut.
  let t = cleanLine(String(v == null ? '' : v), Infinity, true);
  // İ as a plain I, so the title keeps its length.
  if (typedInCaps(t)) t = t.replace(/İ/g, 'I').toLowerCase();
  const words = t ? t.split(' ') : [];
  let lastWord = words.length - 1;
  while (lastWord > 0 && !/[\p{L}\p{N}]/u.test(words[lastWord])) lastWord--;
  let first = true;
  return words.map((w, i) => {
    const parts = w.split(JOINERS);
    const out = parts.map((p, j) => (j % 2 ? p : titleWord(p, first && j === 0, i === lastWord && j === parts.length - 1))).join('');
    if (/[\p{L}\p{N}]/u.test(w)) first = /:$/.test(w);
    return out;
  }).join(' ');
}

/* ---------- Records ---------- */

const bad = (error) => ({ error });
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/* A recipe, from the app or the admin route. Returns { value } or { error } with a reason. */
export function cleanRecipe(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return bad('recipe must be an object');
  const typed = cleanLine(it.title, LIMITS.title);
  if (typed === null) return bad(`title must be text, 1 to ${LIMITS.title} characters`);
  // Stored in Title Case, as typed when that would run past the limit.
  const titled = titleCase(typed);
  const title = titled.length > LIMITS.title ? typed : titled;
  if (!int(it.servings, 1, LIMITS.servings)) return bad(`servings must be a whole number from 1 to ${LIMITS.servings}`);
  const time = it.time === undefined || it.time === null ? '' : cleanLine(it.time, LIMITS.time, true);
  if (time === null) return bad(`time must be text up to ${LIMITS.time} characters, like "35 min"`);
  if (typeof it.veg !== 'boolean') return bad('veg must be true or false');
  if (!Array.isArray(it.ingredients) || it.ingredients.length > LIMITS.ingredients) return bad(`ingredients must be a list of at most ${LIMITS.ingredients}`);
  const ingredients = [];
  for (let i = 0; i < it.ingredients.length; i++) {
    const g = it.ingredients[i];
    const no = (why) => bad(`ingredient ${i + 1}: ${why}`);
    if (!g || typeof g !== 'object' || Array.isArray(g)) return no('must be an object');
    let qty = g.qty === undefined ? null : g.qty;
    if (qty !== null) {
      if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0 || qty > 100000) return no('qty must be a number above 0, or null');
      qty = Math.round(qty * 1000) / 1000;
    }
    const unit = g.unit === undefined || g.unit === null ? '' : cleanLine(g.unit, LIMITS.unit, true);
    if (unit === null) return no(`unit must be text up to ${LIMITS.unit} characters`);
    const item = cleanLine(g.item, LIMITS.item);
    if (item === null) return no(`item must be text, 1 to ${LIMITS.item} characters`);
    if (!AISLES.includes(g.aisle)) return no('aisle must be one of ' + AISLES.join(', '));
    // The section an ingredient is under, like "For the marinade". Left off when there is none.
    const group = g.group === undefined || g.group === null ? '' : cleanLine(g.group, LIMITS.group, true);
    if (group === null) return no(`group must be text up to ${LIMITS.group} characters`);
    ingredients.push(group ? { qty, unit, item, aisle: g.aisle, group } : { qty, unit, item, aisle: g.aisle });
  }
  if (!Array.isArray(it.steps) || it.steps.length > LIMITS.steps) return bad(`steps must be a list of at most ${LIMITS.steps}`);
  const steps = [];
  for (let i = 0; i < it.steps.length; i++) {
    const s = cleanLine(it.steps[i], LIMITS.step);
    if (s === null) return bad(`step ${i + 1}: must be text, 1 to ${LIMITS.step} characters`);
    steps.push(s);
  }
  const notes = it.notes === undefined || it.notes === null ? '' : cleanBlock(it.notes, LIMITS.notes);
  if (notes === null) return bad(`notes must be text up to ${LIMITS.notes} characters`);
  const value = { title, servings: it.servings, time, veg: it.veg, ingredients, steps, notes };
  if (JSON.stringify(value).length > LIMITS.recipeBytes) return bad('recipe too large');
  return { value };
}

function cleanDay(it) {
  if (!['recipe', 'text', 'pizza'].includes(it.kind)) return bad('kind');
  const servings = it.servings === undefined || it.servings === null ? null : it.servings;
  if (servings !== null && !int(servings, 1, LIMITS.servings)) return bad('servings');
  if (it.kind === 'recipe') {
    if (typeof it.recipeId !== 'string' || !ID.test(it.recipeId)) return bad('recipeId');
    return { value: { kind: 'recipe', recipeId: it.recipeId, text: '', servings } };
  }
  if (it.kind === 'text') {
    const text = cleanLine(it.text, LIMITS.dayText);
    if (text === null) return bad('text');
    return { value: { kind: 'text', recipeId: null, text, servings } };
  }
  const text = it.text === undefined || it.text === null ? '' : cleanLine(it.text, LIMITS.dayText, true);
  if (text === null) return bad('text');
  return { value: { kind: 'pizza', recipeId: null, text, servings } };
}

function cleanExtra(it) {
  if (!validWeek(it.week)) return bad('week');
  const text = cleanLine(it.text, LIMITS.extraText);
  if (text === null) return bad('text');
  const qty = it.qty === undefined || it.qty === null ? '' : cleanLine(it.qty, LIMITS.qty, true);
  if (qty === null) return bad('qty');
  if (!AISLES.includes(it.aisle)) return bad('aisle');
  return { value: { week: it.week, text, qty, aisle: it.aisle } };
}

function cleanDough(it) {
  if (!int(it.size, 6, 24)) return bad('size');
  if (!int(it.count, 1, 20)) return bad('count');
  if (!THICKNESS.includes(it.thickness)) return bad('thickness');
  if (typeof it.gf !== 'boolean') return bad('gf');
  const night = it.night === undefined || it.night === null ? null : it.night;
  if (night !== null && !validDate(night)) return bad('night');
  const raw = it.tweaks === undefined || it.tweaks === null ? {} : it.tweaks;
  if (typeof raw !== 'object' || Array.isArray(raw)) return bad('tweaks');
  const tweaks = {};
  for (const [k, v] of Object.entries(raw)) {
    const range = Object.prototype.hasOwnProperty.call(TWEAKS, k) ? TWEAKS[k] : null;
    if (!range) return bad('tweaks');
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < range[0] || v > range[1]) return bad('tweaks');
    tweaks[k] = Math.round(v * 100) / 100;
  }
  return { value: { size: it.size, count: it.count, thickness: it.thickness, gf: it.gf, night, tweaks } };
}

export function validId(type, id) {
  if (typeof id !== 'string') return false;
  switch (type) {
    case 'recipe':
    case 'extra':
      return ID.test(id);
    case 'day': {
      const [week, day, who, meal, more] = id.split(':');
      if (!validWeek(week) || !WEEKDAYS.includes(day) || more !== undefined) return false;
      return who === undefined || (PEOPLE.includes(who) && MEALS.includes(meal));
    }
    case 'tick': {
      const i = id.indexOf('|');
      if (i < 0) return false;
      const key = id.slice(i + 1);
      return validWeek(id.slice(0, i)) && key.length > 0 && key.length <= LIMITS.key && !/[|\u0000-\u001f\u007f]/.test(key) && key.trim() === key;
    }
    case 'dough':
      return id === 'dough';
    default:
      return false;
  }
}

function cleanTime(v, now) {
  const n = Number(v);
  if (v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(n) || n < MIN_TIME) return undefined;
  return Math.round(Math.min(n, now + SKEW));
}

/* One op in, one clean op out, or null. Anything not on the whitelist is dropped. */
export function cleanOp(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || !TYPES.includes(raw.type)) return null;
  const { type } = raw;
  const it = raw.item;
  if (!it || typeof it !== 'object' || Array.isArray(it) || !validId(type, it.id)) return null;
  const updatedAt = cleanTime(it.updatedAt, now);
  if (updatedAt === undefined) return null;
  if (raw.op === 'delete') return { op: 'delete', type, item: { type, id: it.id, updatedAt } };
  if (raw.op !== 'upsert') return null;
  let out;
  if (type === 'recipe') out = cleanRecipe(it);
  else if (type === 'day') out = cleanDay(it);
  else if (type === 'extra') out = cleanExtra(it);
  else if (type === 'tick') out = typeof it.on === 'boolean' ? { value: { on: it.on } } : bad('on');
  else out = cleanDough(it);
  if (out.error) return null;
  return { op: 'upsert', type, item: { type, id: it.id, ...out.value, updatedAt } };
}

/* Validate a batch: { ops, rejected } or { error }. A bad op is skipped and reported by index. */
export function cleanBatch(body, now = Date.now()) {
  const list = body && Array.isArray(body.ops) ? body.ops : null;
  if (!list) return { error: 'ops required' };
  if (list.length === 0) return { error: 'ops empty' };
  if (list.length > LIMITS.ops) return { error: 'too many ops' };
  const ops = [];
  const rejected = [];
  list.forEach((raw, index) => {
    const op = cleanOp(raw, now);
    if (op) ops.push(op);
    else rejected.push(index);
  });
  return { ops, rejected };
}

export const keyOf = (type, id) => type + ':' + id;

/* Apply clean ops to { items: { key: record }, tombs: { key: deletedAt } }. Mutates.
 * Per record the newest updatedAt wins; ties go to what is stored, so a resent batch is a no-op. */
export function applyOps(doc, ops) {
  let changed = false;
  for (const { op, type, item } of ops) {
    const k = keyOf(type, item.id);
    const cur = doc.items[k];
    const tomb = doc.tombs[k];
    if (op === 'upsert') {
      if (tomb !== undefined && tomb >= item.updatedAt) continue;
      if (cur && cur.updatedAt >= item.updatedAt) continue;
      doc.items[k] = item;
      if (tomb !== undefined) delete doc.tombs[k];
      changed = true;
    } else {
      if (cur && cur.updatedAt > item.updatedAt) continue;
      if (tomb !== undefined && tomb >= item.updatedAt) continue;
      delete doc.items[k];
      doc.tombs[k] = item.updatedAt;
      changed = true;
    }
  }
  return { doc, changed };
}

/* ---------- Pizza nights and tonight ---------- */

// How many days before a pizza night the dough is mixed. app/logic.js has the same.
export const MIX_DAYS = { regular: 3, gf: 1 };

/* What the Morning Screen shows, from all kitchen records and today's Amsterdam date.
 * { tonight: { kind, title, veg } | null, mixToday, pizzaOn } or null when there is nothing to say. */
export function tonightView(items, today) {
  const byKey = {};
  for (const r of items) byKey[keyOf(r.type, r.id)] = r;
  const dough = byKey['dough:dough'] || null;
  const gf = !!(dough && dough.gf);
  const { week, day } = isoWeek(today);
  // The Morning Screen is Paul's: his dinner, else an old shared one.
  const dinner = (id, who) => byKey[keyOf('day', id + ':' + who + ':dinner')];
  const rec = dinner(week + ':' + day, 'paul') || byKey[keyOf('day', week + ':' + day)];
  let tonight = null;
  if (rec && rec.kind === 'pizza') tonight = { kind: 'pizza', title: 'Pizza night', veg: false };
  else if (rec && rec.kind === 'text') tonight = { kind: 'text', title: rec.text, veg: false };
  else if (rec && rec.kind === 'recipe') {
    const r = byKey[keyOf('recipe', rec.recipeId)];
    if (r) tonight = { kind: 'recipe', title: r.title, veg: !!r.veg };
  }
  const night = addDays(today, gf ? MIX_DAYS.gf : MIX_DAYS.regular);
  const nightWeek = isoWeek(night);
  const nightId = nightWeek.week + ':' + nightWeek.day;
  const pizza = (r) => !!(r && r.kind === 'pizza');
  const mixToday = (dough && dough.night === night) || pizza(byKey[keyOf('day', nightId)]) || PEOPLE.some((p) => pizza(dinner(nightId, p)));
  if (!tonight && !mixToday) return null;
  return { tonight, mixToday: !!mixToday, pizzaOn: mixToday ? night : null };
}
