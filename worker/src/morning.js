/* The Morning Screen module: everything the page shows, in one answer.
 *
 *   GET  /api/morning/:code        -> { now, todos, calendar, fixed, weather, arsenal, bins, birthdays, news, kitchen, projects }
 *   POST /api/morning/calendar     Authorization: Bearer <CALENDAR_PUSH_TOKEN>
 *                                  <- { sent, events: [{ title, start, end, allDay, location }] }
 *                                  -> { ok: true, count }
 *
 * Every block is loaded on its own. A block that fails answers { error: "..." } in its
 * slot and the others still arrive. Times are Europe/Amsterdam unless they carry an offset.
 *
 * HUB_KV keys:
 *   morning:calendar     the last push from Odysseus, { sent, received, events }
 *   morning:projects     projects and parked items, { updated, projects, parked }, set
 *                        with POST /api/admin/morning/projects (ADMIN_TOKEN)
 *   cache:weather        Open-Meteo, 15 minutes
 *   cache:arsenal        ESPN, 1 hour
 *   cache:bins:<hash>    Den Haag huisvuilkalender, 12 hours
 *   cache:news           NOS headlines, 30 minutes
 * Cached entries are { at, data }. If a source fails, the last good copy is used for a
 * while (see STALE), so one bad minute at ESPN does not blank the block.
 *
 * Secrets (never in this repo): TODO_CODE, CALENDAR_PUSH_TOKEN, FIXED_EVENTS, BIN_ADDRESS, BIRTHDAYS.
 * The kitchen block is read inside the Worker with KITCHEN_CODE; that code never leaves it.
 */

import { CODE, safeEqual, bearer } from './todo.js';
import { kitchen } from './kitchen-store.js';
import { tonightView } from './kitchen.js';

export const TZ = 'Europe/Amsterdam';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// The direction of the ride to work, in degrees (0 north, 90 east). Unset means the
// page never says headwind or tailwind, only the wind's strength and direction.
// Set it, for example to 60 for a ride heading north east, and redeploy.
export const WORK_BEARING = null;

export const RIDES = [
  { time: '08:00', label: 'to work', leg: 'in' },
  { time: '17:30', label: 'home', leg: 'home' },
];

const TTL = { weather: 15 * MIN, arsenal: HOUR, bins: 12 * HOUR, news: 30 * MIN };
const STALE = { weather: 3 * HOUR, arsenal: DAY, bins: 7 * DAY, news: 6 * HOUR };
const KEEP_SECONDS = 8 * 24 * 3600; // KV expiry for cache entries
const FETCH_MS = 6000;

export const CAL_KEY = 'morning:calendar';
export const MAX_EVENTS = 500;
export const MAX_TITLE = 200;
export const MAX_PLACE = 200;
export const MAX_CAL_BODY = 200 * 1024;

/* ---------- Time in Amsterdam ---------- */

const fmts = new Map();
function fmt(tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  return fmts.get(tz);
}

/* { date: 'YYYY-MM-DD', time: 'HH:MM', minutes, weekday (0 Sunday), offset (ms) } */
export function local(ms, tz = TZ) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(ms))) p[type] = value;
  const hour = p.hour === '24' ? '00' : p.hour;
  const date = `${p.year}-${p.month}-${p.day}`;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return {
    date,
    time: `${hour}:${p.minute}`,
    minutes: +hour * 60 + +p.minute,
    weekday: new Date(date + 'T12:00:00Z').getUTCDay(),
    offset: asUtc - Math.floor(ms / 1000) * 1000,
  };
}

/* A wall clock time in Amsterdam to ms since epoch, correct across the DST switch. */
export function zoned(date, time = '00:00', tz = TZ) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ms = guess - local(guess, tz).offset;
  const off = local(ms, tz).offset;
  if (guess - off !== ms) ms = guess - off;
  return ms;
}

export function isoLocal(ms, tz = TZ) {
  const l = local(ms, tz);
  const o = l.offset / MIN;
  const sign = o < 0 ? '-' : '+';
  const a = Math.abs(o);
  return `${l.date}T${l.time}:00${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function validDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function validIso(s) {
  return typeof s === 'string' && ISO_RE.test(s) && Number.isFinite(Date.parse(s)) && validDay(s.slice(0, 10));
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ---------- Small helpers ---------- */

const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

async function getJson(url) {
  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'paul-hub morning screen' },
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!r.ok) throw new Error('status ' + r.status);
  return r.json();
}

/* Read through the HUB_KV cache. Returns the fresh or cached data, or throws. */
export async function cached(env, key, ttl, stale, now, load) {
  let hit = null;
  try { hit = await env.HUB_KV.get(key, 'json'); } catch (e) { hit = null; }
  if (hit && typeof hit.at === 'number' && now - hit.at < ttl) return hit.data;
  let data;
  try {
    data = await load();
  } catch (e) {
    if (hit && typeof hit.at === 'number' && now - hit.at < stale) return hit.data;
    throw e;
  }
  try { await env.HUB_KV.put(key, JSON.stringify({ at: now, data }), { expirationTtl: KEEP_SECONDS }); } catch (e) { /* cache is optional */ }
  return data;
}

/* ---------- To-dos: open items in Today, and yesterday's wins ---------- */

export const WINS_SHOWN = 5;

export async function todosBlock(env, now = Date.now()) {
  const stub = env.TODO_LIST.get(env.TODO_LIST.idFromName('todo:' + env.TODO_CODE));
  const r = await stub.fetch('https://list/read');
  const d = await r.json();
  if (!Array.isArray(d.items)) throw new Error('no items');
  const items = d.items
    .filter((i) => !i.done && i.section === 'today')
    .sort((a, b) => b.pos - a.pos)
    .map((i) => ({ text: i.text }));
  // Everything ticked off yesterday (Amsterdam), in any section, newest first. Read only.
  const yesterday = addDays(local(now).date, -1);
  const won = d.items
    .filter((i) => i.done && Number.isFinite(i.doneAt) && local(i.doneAt).date === yesterday)
    .sort((a, b) => b.doneAt - a.doneAt);
  return {
    items,
    updated: d.updated || null,
    yesterday: { count: won.length, items: won.slice(0, WINS_SHOWN).map((i) => i.text) },
  };
}

/* ---------- Calendar: pushed by Odysseus ---------- */

/* Validate a push. Returns { doc } or { error }. Nothing outside the contract is kept. */
export function cleanCalendar(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  if (!validIso(body.sent)) return { error: 'sent must be an ISO time with offset' };
  if (!Array.isArray(body.events)) return { error: 'events must be a list' };
  if (body.events.length > MAX_EVENTS) return { error: `at most ${MAX_EVENTS} events` };
  const events = [];
  for (let i = 0; i < body.events.length; i++) {
    const e = body.events[i];
    const bad = (why) => ({ error: `event ${i}: ${why}` });
    if (!e || typeof e !== 'object') return bad('not an object');
    if (typeof e.title !== 'string') return bad('title must be text');
    const title = clean(e.title);
    if (title.length > MAX_TITLE) return bad(`title over ${MAX_TITLE} characters`);
    if (typeof e.allDay !== 'boolean') return bad('allDay must be true or false');
    let s, en;
    if (e.allDay) {
      if (!validDay(e.start) || !validDay(e.end)) return bad('all day start and end must be YYYY-MM-DD');
      if (e.end < e.start) return bad('end before start');
    } else {
      if (!validIso(e.start) || !validIso(e.end)) return bad('start and end must be ISO times with offset');
      s = Date.parse(e.start);
      en = Date.parse(e.end);
      if (en < s) return bad('end before start');
    }
    if (e.location !== undefined && e.location !== null && typeof e.location !== 'string') return bad('location must be text');
    const location = e.location ? clean(e.location).slice(0, MAX_PLACE) : '';
    events.push({ title, start: e.start, end: e.end, allDay: e.allDay, location });
  }
  return { doc: { sent: body.sent, received: new Date(now).toISOString(), events } };
}

/* Start and end of an event in ms. All day ends are exclusive (the day after), as in
 * iCalendar; an all day event whose end equals its start is taken as one day. */
export function eventSpan(e) {
  if (e.allDay) {
    const end = e.end > e.start ? e.end : addDays(e.start, 1);
    return [zoned(e.start), zoned(end)];
  }
  return [Date.parse(e.start), Date.parse(e.end)];
}

/* Today and the next six days: from now until midnight at the start of day eight. */
export function windowEnd(now) {
  return zoned(addDays(local(now).date, 7));
}

export function inWindow(events, now) {
  const to = windowEnd(now);
  return events
    .map((e) => [e, eventSpan(e)])
    .filter(([, [s, en]]) => (en > now || (en === s && s >= now)) && s < to)
    .sort((a, b) => a[1][0] - b[1][0])
    .map(([e]) => e);
}

export async function calendarBlock(env, now) {
  const doc = await env.HUB_KV.get(CAL_KEY, 'json');
  if (!doc) return { events: [], sent: null, stale: true };
  const received = Date.parse(doc.received);
  return {
    events: inWindow(doc.events || [], now),
    sent: doc.sent,
    stale: !Number.isFinite(received) || now - received > HOUR,
  };
}

async function pushCalendar(request, env, json) {
  if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
  if (!env.CALENDAR_PUSH_TOKEN || !safeEqual(bearer(request), env.CALENDAR_PUSH_TOKEN)) {
    return json({ error: 'token required' }, request, 401);
  }
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_CAL_BODY) return json({ error: 'too large' }, request, 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_CAL_BODY) return json({ error: 'too large' }, request, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return json({ error: 'bad json' }, request, 400);
  }
  const out = cleanCalendar(body);
  if (out.error) return json({ error: out.error }, request, 400);
  await env.HUB_KV.put(CAL_KEY, JSON.stringify(out.doc));
  return json({ ok: true, count: out.doc.events.length }, request);
}

/* ---------- Fixed events and countdowns, from the FIXED_EVENTS secret ---------- */

/* Tolerant: a missing or broken secret, or a broken entry, is skipped, never an error. */
export function parseFixed(raw) {
  let cfg = raw;
  if (typeof raw === 'string') {
    try { cfg = JSON.parse(raw); } catch (e) { cfg = null; }
  }
  const out = { events: [], countdowns: [] };
  if (!cfg || typeof cfg !== 'object') return out;
  for (const e of Array.isArray(cfg.events) ? cfg.events : []) {
    if (!e || typeof e.title !== 'string' || !clean(e.title) || !validDay(e.date)) continue;
    if (e.start !== undefined && !TIME_RE.test(e.start)) continue;
    if (e.end !== undefined && (!TIME_RE.test(e.end) || e.start === undefined)) continue;
    if (e.until !== undefined && !validDay(e.until)) continue;
    out.events.push({
      title: clean(e.title).slice(0, MAX_TITLE),
      date: e.date,
      start: e.start,
      end: e.end,
      weekly: e.repeat === 'weekly',
      until: e.until,
      location: typeof e.location === 'string' ? clean(e.location).slice(0, MAX_PLACE) : '',
    });
  }
  for (const c of Array.isArray(cfg.countdowns) ? cfg.countdowns : []) {
    if (!c || typeof c.what !== 'string' || !clean(c.what) || !validDay(c.date)) continue;
    out.countdowns.push({ what: clean(c.what).slice(0, MAX_TITLE), date: c.date });
  }
  return out;
}

export function fixedBlock(raw, now) {
  const cfg = parseFixed(raw);
  const today = local(now).date;
  const last = addDays(today, 6);
  const events = [];
  for (const e of cfg.events) {
    const dates = [];
    if (e.weekly) {
      const stop = e.until && e.until < last ? e.until : last;
      let d = e.date;
      if (d < today) d = addDays(d, Math.ceil(daysBetween(d, today) / 7) * 7);
      for (; d <= stop; d = addDays(d, 7)) dates.push(d);
    } else if (e.date >= today && e.date <= last) {
      dates.push(e.date);
    }
    for (const d of dates) {
      let ev;
      if (!e.start) {
        ev = { title: e.title, start: d, end: addDays(d, 1), allDay: true, location: e.location };
      } else {
        const s = zoned(d, e.start);
        let en = e.end ? zoned(d, e.end) : s + HOUR;
        if (en <= s) en = zoned(addDays(d, 1), e.end);
        ev = { title: e.title, start: isoLocal(s), end: isoLocal(en), allDay: false, location: e.location };
      }
      events.push(ev);
    }
  }
  const countdowns = cfg.countdowns
    .map((c) => ({ what: c.what, date: c.date, days: daysBetween(today, c.date) }))
    .filter((c) => c.days >= 0)
    .sort((a, b) => a.days - b.days);
  return { events: inWindow(events, now), countdowns };
}

/* ---------- Bike weather: Open-Meteo ---------- */

export const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=52.08&longitude=4.30'
  + '&timezone=Europe%2FAmsterdam'
  + '&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m'
  + '&minutely_15=precipitation&forecast_minutely_15=24'
  + '&daily=sunrise,sunset&forecast_days=5';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const angle = (a, b) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
};

/* Wind comes FROM windDeg. Heading into it is a headwind. */
export function relativeWind(windDeg, bearing, speed) {
  if (bearing === null || bearing === undefined || speed < 10) return null;
  if (angle(windDeg, bearing) <= 45) return 'headwind';
  if (angle(windDeg, bearing + 180) <= 45) return 'tailwind';
  return null;
}

/* The ride day: today on a weekday until 17:30, otherwise the next weekday. */
export function rideDay(now) {
  const l = local(now);
  let d = l.date;
  let wd = l.weekday;
  if (wd >= 1 && wd <= 5 && l.minutes <= 17 * 60 + 30) return d;
  do {
    d = addDays(d, 1);
    wd = (wd + 1) % 7;
  } while (wd === 0 || wd === 6);
  return d;
}

/* Keep only what the block needs, so the cache stays small. */
export function trimWeather(raw) {
  const h = raw && raw.hourly;
  const m = raw && raw.minutely_15;
  const d = raw && raw.daily;
  if (!h || !Array.isArray(h.time) || !m || !Array.isArray(m.time) || !d || !Array.isArray(d.time)) throw new Error('bad weather');
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  return {
    hourly: pick(h, ['time', 'temperature_2m', 'precipitation_probability', 'precipitation', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m']),
    minutely_15: pick(m, ['time', 'precipitation']),
    daily: pick(d, ['time', 'sunrise', 'sunset']),
  };
}

const pad = (n) => String(n).padStart(2, '0');

/* One ride from the hourly forecast. Temperature and wind are read at the ride's time
 * (between two hours, halfway); rain is the hour the ride falls in, which Open-Meteo
 * files under the hour it ends. */
export function rideForecast(w, day, ride, now, bearing) {
  const h = w.hourly;
  const idx = (t) => h.time.indexOf(t);
  const [hh, mm] = ride.time.split(':').map(Number);
  const i0 = idx(`${day}T${pad(hh)}:00`);
  if (i0 < 0) throw new Error('no forecast for ' + day);
  const i1 = Math.min(i0 + 1, h.time.length - 1);
  const f = mm / 60;
  const lerp = (k) => {
    const a = h[k][i0];
    const b = h[k][i1];
    if (typeof a !== 'number') throw new Error('missing ' + k);
    return typeof b === 'number' ? a + (b - a) * f : a;
  };
  const rad = (x) => (x * Math.PI) / 180;
  const d0 = h.wind_direction_10m[i0];
  const d1 = typeof h.wind_direction_10m[i1] === 'number' ? h.wind_direction_10m[i1] : d0;
  const x = Math.cos(rad(d0)) * (1 - f) + Math.cos(rad(d1)) * f;
  const y = Math.sin(rad(d0)) * (1 - f) + Math.sin(rad(d1)) * f;
  const dir = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
  const legBearing = bearing === null || bearing === undefined ? null : ride.leg === 'in' ? bearing : (bearing + 180) % 360;
  const wind = Math.round(lerp('wind_speed_10m'));
  const startMs = zoned(day, ride.time);
  return {
    time: ride.time,
    label: ride.label,
    leg: ride.leg,
    temp: Math.round(lerp('temperature_2m')),
    rainProb: Math.round(h.precipitation_probability[i1] ?? h.precipitation_probability[i0] ?? 0),
    rainMm: Math.round((h.precipitation[i1] ?? h.precipitation[i0] ?? 0) * 10) / 10,
    wind,
    gusts: Math.round(lerp('wind_gusts_10m')),
    dir,
    compass: compass(dir),
    relative: relativeWind(dir, legBearing, wind),
    past: now > startMs + 30 * MIN,
    startMs,
  };
}

const WET = 0.1; // mm in 15 minutes

/* The next two hours as eight 15 minute slots. Open-Meteo files each slot under the
 * time it ends; here each slot is labelled with the time it starts. */
export function rainSlots(w, now) {
  const m = w.minutely_15;
  const out = [];
  for (let i = 0; i < m.time.length && out.length < 8; i++) {
    const [date, time] = m.time[i].split('T');
    const endMs = zoned(date, time);
    if (endMs <= now) continue;
    const startMs = endMs - 15 * MIN;
    out.push({ time: local(startMs).time, mm: Math.round((m.precipitation[i] || 0) * 10) / 10, startMs, endMs });
  }
  return out;
}

export function rainLine(slots) {
  if (!slots.length) return '';
  const wet = slots.map((s) => s.mm >= WET);
  const first = wet.indexOf(true);
  if (first < 0) return 'Dry for the next 2 hours';
  let end = first;
  while (end + 1 < slots.length && wet[end + 1]) end++;
  const closes = end + 1 < slots.length;
  const until = local(slots[end].endMs).time;
  if (first === 0) return closes ? `Rain until ${until}` : 'Rain for the next 2 hours';
  return closes ? `Rain from ${slots[first].time} to ${until}` : `Dry until ${slots[first].time}`;
}

const rainClass = (r) => (r.rainProb >= 50 || r.rainMm >= 0.5 ? 'rain' : r.rainProb >= 25 || r.rainMm >= 0.1 ? 'showers' : 'dry');
const RAIN_WORD = { dry: 'dry', showers: 'showers possible', rain: 'rain' };
const isWindy = (r) => r.gusts >= 45 || r.wind >= 28;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* One plain line for the rides still to come on the ride day. */
export function verdict(rides, slots, now, dayName) {
  const left = rides.filter((r) => !r.past);
  if (!left.length) return '';
  const cls = left.map(rainClass);
  const later = dayName !== 'today';
  const suffix = dayName === 'tomorrow' ? ' tomorrow' : later ? ' on ' + dayName : '';
  const prefix = dayName === 'tomorrow' ? 'Tomorrow: ' : later ? dayName + ': ' : '';

  // The next ride falls inside the 15 minute forecast: trust it over the hourly one.
  const next = left[0];
  if (!later && slots.length && next.startMs - now <= 2 * HOUR) {
    const rideEnd = next.startMs + 30 * MIN;
    const i = slots.findIndex((s) => s.mm >= WET && s.endMs > next.startMs && s.startMs < rideEnd);
    if (i < 0) {
      cls[0] = 'dry';
    } else {
      let j = i;
      while (j > 0 && slots[j - 1].mm >= WET) j--;
      let k = i;
      while (k + 1 < slots.length && slots[k + 1].mm >= WET) k++;
      const stops = k + 1 < slots.length;
      if (stops && slots[k].endMs - next.startMs <= 75 * MIN) {
        const leave = local(slots[k].endMs).time;
        const head = slots[j].startMs <= now ? 'Raining now.' : `Rain around ${local(slots[j].startMs).time}.`;
        const tail = left.length > 1 && cls[1] === 'rain' ? ' Rain home too.' : '';
        return `${head} Leave at ${leave} and stay dry.${tail}`;
      }
      cls[0] = 'rain';
    }
  }

  const legName = (r) => (r.leg === 'in' ? 'going in' : 'home');
  let text;
  if (left.length === 1) {
    text = prefix ? prefix + RAIN_WORD[cls[0]] + ' ' + legName(left[0]) : cap(RAIN_WORD[cls[0]]) + ' ' + legName(left[0]);
  } else if (cls[0] === cls[1]) {
    text = cap(RAIN_WORD[cls[0]]) + ' both ways' + suffix;
  } else {
    const body = `${RAIN_WORD[cls[0]]} going in, ${RAIN_WORD[cls[1]]} home`;
    text = prefix ? prefix + body : cap(body);
  }

  const windWord = (r) => {
    const head = r.relative === 'headwind' && r.wind >= 15;
    if (isWindy(r)) return head ? 'strong headwind' : 'windy';
    return head ? 'headwind' : null;
  };
  const ww = left.map(windWord);
  if (left.length === 1) {
    if (ww[0]) text += ', ' + ww[0];
  } else if (ww[0] && ww[0] === ww[1]) {
    text += `, ${ww[0]} both ways`;
  } else {
    left.forEach((r, n) => { if (ww[n]) text += `, ${ww[n]} ${legName(r)}`; });
  }
  text += '.';
  if (Math.min(...left.map((r) => r.temp)) <= 3) text += ' Cold, gloves on.';
  return text;
}

/* The weather block from a (trimmed) Open-Meteo answer, for the moment `now`. */
export function weatherBlock(w, now, bearing = WORK_BEARING) {
  const day = rideDay(now);
  const today = local(now).date;
  const dayName = day === today ? 'today' : day === addDays(today, 1) ? 'tomorrow' : WEEKDAYS[new Date(day + 'T12:00:00Z').getUTCDay()];
  const rides = RIDES.map((r) => rideForecast(w, day, r, now, bearing));
  const slots = rainSlots(w, now);
  const sun = w.daily.time.map((date, i) => ({ date, sunrise: w.daily.sunrise[i], sunset: w.daily.sunset[i] }));
  return {
    day,
    rides: rides.map(({ startMs, leg, ...r }) => r),
    verdict: verdict(rides, slots, now, dayName),
    rain: { line: rainLine(slots), slots: slots.map(({ time, mm }) => ({ time, mm })) },
    sun,
  };
}

async function weather(env, now) {
  const w = await cached(env, 'cache:weather', TTL.weather, STALE.weather, now, async () => trimWeather(await getJson(WEATHER_URL)));
  return weatherBlock(w, now);
}

/* ---------- Arsenal: ESPN's open JSON ---------- */

export const ARSENAL = '359';
// Two hosts serve the same feed. site.api.espn.com sits behind a bot filter that refuses
// some callers (403), so site.web.api.espn.com is asked first and the other is the fallback.
const ESPN_PATH = '/apis/site/v2/sports/soccer/all/teams/359/schedule';
export const ESPN_HOSTS = ['https://site.web.api.espn.com', 'https://site.api.espn.com'];
export const ESPN_RESULTS = ESPN_HOSTS[0] + ESPN_PATH;
export const ESPN_FIXTURES = ESPN_RESULTS + '?fixture=true';

async function espn(query) {
  let err;
  for (const host of ESPN_HOSTS) {
    try { return await getJson(host + ESPN_PATH + query); } catch (e) { err = e; }
  }
  throw err;
}

const competitionName = (e) => {
  const n = (e.league && (e.league.shortName || e.league.abbreviation || e.league.name)) || '';
  return n.replace(/^(UEFA|English|FIFA)\s+/, '');
};

/* One ESPN event from Arsenal's side, or null if it does not parse. */
export function espnMatch(e) {
  const c = e && Array.isArray(e.competitions) && e.competitions[0];
  if (!c || !Array.isArray(c.competitors) || c.competitors.length !== 2) return null;
  const us = c.competitors.find((x) => x.team && String(x.team.id) === ARSENAL);
  const them = c.competitors.find((x) => x !== us);
  if (!us || !them || !them.team) return null;
  const kickoff = Date.parse(e.date);
  if (!Number.isFinite(kickoff)) return null;
  const score = (x) => {
    const v = x.score && typeof x.score === 'object' ? x.score.value : x.score;
    const n = Number(v);
    return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n;
  };
  const shoot = (x) => (x.score && typeof x.score === 'object' && Number.isFinite(Number(x.score.shootoutScore)) ? Number(x.score.shootoutScore) : null);
  const type = (c.status && c.status.type) || {};
  return {
    opponent: them.team.shortDisplayName || them.team.displayName || 'Opponent',
    home: us.homeAway === 'home',
    competition: competitionName(e),
    kickoff: new Date(kickoff).toISOString(),
    state: type.state || (type.completed ? 'post' : 'pre'),
    completed: type.completed === true,
    us: score(us),
    them: score(them),
    usPens: shoot(us),
    themPens: shoot(them),
    won: us.winner === true,
    lost: them.winner === true,
  };
}

/* Last result and the next few fixtures. Kept in the cache; `next` is picked per request. */
export function parseArsenal(results, fixtures) {
  const done = (results && Array.isArray(results.events) ? results.events : [])
    .map(espnMatch)
    .filter((m) => m && m.completed && m.us !== null && m.them !== null)
    .sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff));
  const upcoming = (fixtures && Array.isArray(fixtures.events) ? fixtures.events : [])
    .map(espnMatch)
    .filter((m) => m && !m.completed && m.state !== 'post')
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff))
    .slice(0, 6);
  if (!done.length && !upcoming.length) throw new Error('no matches');
  let last = null;
  if (done[0]) {
    const m = done[0];
    let result = m.us > m.them ? 'Won' : m.us < m.them ? 'Lost' : 'Drew';
    let pens = null;
    if (result === 'Drew' && m.usPens !== null && m.themPens !== null && m.usPens !== m.themPens) {
      result = m.usPens > m.themPens ? 'Won' : 'Lost';
      pens = m.usPens + ' to ' + m.themPens;
    } else if (result === 'Drew' && (m.won || m.lost)) {
      result = m.won ? 'Won' : 'Lost';
      pens = '';
    }
    last = { opponent: m.opponent, home: m.home, competition: m.competition, kickoff: m.kickoff, us: m.us, them: m.them, result, pens };
  }
  return {
    last,
    upcoming: upcoming.map((m) => ({ opponent: m.opponent, home: m.home, competition: m.competition, kickoff: m.kickoff })),
  };
}

export function arsenalBlock(data, now) {
  // A match that kicked off less than two and a half hours ago is still "next": it is on now.
  const m = data.upcoming.find((x) => Date.parse(x.kickoff) > now - 150 * MIN);
  const next = m ? { ...m, live: Date.parse(m.kickoff) <= now } : null;
  return { next, last: data.last };
}

async function arsenal(env, now) {
  const data = await cached(env, 'cache:arsenal', TTL.arsenal, STALE.arsenal, now, async () => {
    const [r, f] = await Promise.allSettled([espn(''), espn('?fixture=true')]);
    if (r.status === 'rejected' && f.status === 'rejected') throw new Error('espn down');
    return parseArsenal(r.value, f.value);
  });
  return arsenalBlock(data, now);
}

/* ---------- Bin day: Den Haag's huisvuilkalender ---------- */

export const BINS_BASE = 'https://huisvuilkalender.denhaag.nl/rest/adressen/';
const WASTE = { GFT: 'GFT', PMD: 'PMD', Papier: 'Papier', Rest: 'Restafval', Restafval: 'Restafval', Kerstbomen: 'Kerstbomen', Grofvuil: 'Grofvuil' };

/* "1234AB 5", "1234 ab 5a", "1234AB 5 bis" -> { postcode, number, extra } */
export function parseAddress(s) {
  const m = typeof s === 'string' && s.trim().match(/^(\d{4})\s*([A-Za-z]{2})\s+(\d{1,5})\s*(.*)$/);
  if (!m) return null;
  return { postcode: m[1] + m[2].toUpperCase(), number: m[3], extra: m[4].replace(/[\s-]+/g, '').toLowerCase() };
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// The city's waste stream ids, used when the list of streams itself cannot be read.
const STREAM_IDS = { 1: 'GFT', 2: 'PMD', 3: 'Papier', 4: 'Restafval', 5: 'Kerstbomen' };

/* Stream id -> plain Dutch name, from /afvalstromen ([{ id, title, ... }]). */
export function streamNames(streams) {
  const names = { ...STREAM_IDS };
  for (const s of Array.isArray(streams) ? streams : []) {
    if (s && Number.isInteger(s.id) && typeof s.title === 'string' && clean(s.title)) names[s.id] = WASTE[s.title.trim()] || clean(s.title).slice(0, 40);
  }
  return names;
}

/* /kalender/<year> ([{ afvalstroom_id, ophaaldatum }]) -> [{ date, type }] */
export function parseBins(calendars, names) {
  const out = [];
  for (const list of calendars) {
    if (!Array.isArray(list)) throw new Error('bad bins');
    for (const c of list) {
      if (!c || !validDay(c.ophaaldatum) || !names[c.afvalstroom_id]) continue;
      out.push({ date: c.ophaaldatum, type: names[c.afvalstroom_id] });
    }
  }
  return out;
}

export function binsBlock(list, now) {
  const today = local(now).date;
  const byDate = new Map();
  for (const c of list) {
    if (c.date < today) continue;
    if (!byDate.has(c.date)) byDate.set(c.date, []);
    if (!byDate.get(c.date).includes(c.type)) byDate.get(c.date).push(c.type);
  }
  const collections = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(0, 4)
    .map(([date, types]) => ({ date, types }));
  return { collections };
}

async function bins(env, now) {
  const a = parseAddress(env.BIN_ADDRESS);
  if (!a) return null;
  const list = await cached(env, 'cache:bins:' + hash(a.postcode + a.number + a.extra), TTL.bins, STALE.bins, now, async () => {
    const found = await getJson(BINS_BASE + encodeURIComponent(`${a.postcode}-${a.number}`));
    if (!Array.isArray(found) || !found.length) throw new Error('address not found');
    const pick = found.find((x) => ((x.huisletter || '') + (x.huisnummerToevoeging || '')).toLowerCase() === a.extra) || found[0];
    if (!pick.bagId || !/^\d{1,20}$/.test(String(pick.bagId))) throw new Error('no bag id');
    const base = BINS_BASE + pick.bagId;
    // This year's calendar, and next year's too in December.
    const year = Number(local(now).date.slice(0, 4));
    const years = local(now).date.slice(5, 7) === '12' ? [year, year + 1] : [year];
    const [streams, ...cals] = await Promise.allSettled([getJson(base + '/afvalstromen'), ...years.map((y) => getJson(`${base}/kalender/${y}`))]);
    if (cals[0].status === 'rejected') throw new Error('no calendar');
    const names = streamNames(streams.status === 'fulfilled' ? streams.value : null);
    return parseBins(cals.filter((c) => c.status === 'fulfilled').map((c) => c.value), names);
  });
  return binsBlock(list, now);
}

/* ---------- Birthdays, from the BIRTHDAYS secret ---------- */

export const BIRTHDAY_DAYS = 14;

/* [{ name, date: "MM-DD" | "YYYY-MM-DD" }]. Tolerant: a missing or broken secret, or a
 * broken entry, is skipped, never an error. */
export function parseBirthdays(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch (e) { list = null; }
  }
  const out = [];
  for (const b of Array.isArray(list) ? list : []) {
    if (!b || typeof b.name !== 'string' || !clean(b.name) || typeof b.date !== 'string') continue;
    const m = b.date.match(/^(?:(\d{4})-)?(\d{2})-(\d{2})$/);
    if (!m) continue;
    const year = m[1] ? Number(m[1]) : null;
    // Any real date, 29 February included; with a year, it must exist in that year.
    if (!validDay(`${m[1] || '2000'}-${m[2]}-${m[3]}`)) continue;
    out.push({ name: clean(b.name).slice(0, 60), year, month: m[2], day: m[3] });
  }
  return out;
}

/* Birthdays today and in the next 14 days, with the age they turn when the year is known.
 * 29 February counts on 28 February in other years. */
export function birthdaysBlock(raw, now) {
  const today = local(now).date;
  const thisYear = Number(today.slice(0, 4));
  const on = (y, b) => (validDay(`${y}-${b.month}-${b.day}`) ? `${y}-${b.month}-${b.day}` : `${y}-02-28`);
  const birthdays = [];
  for (const b of parseBirthdays(raw)) {
    let date = on(thisYear, b);
    if (date < today) date = on(thisYear + 1, b);
    const days = daysBetween(today, date);
    if (days > BIRTHDAY_DAYS) continue;
    const age = b.year ? Number(date.slice(0, 4)) - b.year : null;
    birthdays.push({ name: b.name, date, days, age: age !== null && age > 0 && age < 130 ? age : null });
  }
  birthdays.sort((a, b) => a.days - b.days || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { birthdays };
}

/* ---------- News: NOS headlines ---------- */

export const NEWS_URL = 'https://feeds.nos.nl/nosnieuwsalgemeen';
export const NEWS_SHOWN = 3;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function tag(xml, name) {
  const re = new RegExp('<' + name + '\\b[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</' + name + '>', 'i');
  const m = xml.match(re);
  if (!m) return '';
  return m[1] !== undefined ? m[1] : decode(m[2] || '');
}

/* The first items of an RSS feed as [{ title, link }]. Only https links on nos.nl are kept.
 * A spaced dash in a title becomes a colon, to match the page's no dash style. */
export function parseNews(xml) {
  if (typeof xml !== 'string' || !/<rss\b|<channel\b/i.test(xml)) throw new Error('not rss');
  const items = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title = clean(tag(m[1], 'title').replace(/<[^>]*>/g, ' '))
      .replace(/\s+[–—-]\s+/g, ': ')
      .replace(/[–—]/g, ', ')
      .slice(0, 200);
    let url;
    try { url = new URL(clean(tag(m[1], 'link'))); } catch (e) { continue; }
    if (!title || url.protocol !== 'https:' || !/(^|\.)nos\.nl$/.test(url.hostname)) continue;
    items.push({ title, link: url.href });
    if (items.length === NEWS_SHOWN) break;
  }
  if (!items.length) throw new Error('no items');
  return { items };
}

async function news(env, now) {
  return cached(env, 'cache:news', TTL.news, STALE.news, now, async () => {
    const r = await fetch(NEWS_URL, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'paul-hub morning screen' },
      signal: AbortSignal.timeout(FETCH_MS),
    });
    if (!r.ok) throw new Error('status ' + r.status);
    return parseNews(await r.text());
  });
}

/* ---------- Projects: what is pending, set by Claude Code through the admin route ---------- */

export const PROJECTS_KEY = 'morning:projects';
export const PROJECT_STATUS = ['active', 'waiting', 'live', 'next', 'parked'];
export const MAX_PROJECTS = 20;
export const MAX_PARKED = 30;
const MAX_LINE = 240;

/* Validate a projects push. Returns { doc } or { error }. The page only reads it.
 *   { projects: [{ name, status, next }], parked: [{ text, from }] }
 * status is one of PROJECT_STATUS; next and from may be left out. */
export function cleanProjects(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  if (!Array.isArray(body.projects)) return { error: 'projects must be a list' };
  const parkedIn = body.parked === undefined ? [] : body.parked;
  if (!Array.isArray(parkedIn)) return { error: 'parked must be a list' };
  if (body.projects.length > MAX_PROJECTS) return { error: `at most ${MAX_PROJECTS} projects` };
  if (parkedIn.length > MAX_PARKED) return { error: `at most ${MAX_PARKED} parked items` };
  const text = (v, max) => (typeof v === 'string' ? clean(v).slice(0, max) : '');
  const projects = [];
  for (let i = 0; i < body.projects.length; i++) {
    const p = body.projects[i];
    if (!p || typeof p !== 'object') return { error: `project ${i}: not an object` };
    const name = text(p.name, 80);
    if (!name) return { error: `project ${i}: name is required` };
    if (!PROJECT_STATUS.includes(p.status)) return { error: `project ${i}: status must be one of ${PROJECT_STATUS.join(', ')}` };
    if (p.next !== undefined && typeof p.next !== 'string') return { error: `project ${i}: next must be text` };
    projects.push({ name, status: p.status, next: text(p.next, MAX_LINE) });
  }
  const parked = [];
  for (let i = 0; i < parkedIn.length; i++) {
    const p = typeof parkedIn[i] === 'string' ? { text: parkedIn[i] } : parkedIn[i];
    if (!p || typeof p !== 'object') return { error: `parked ${i}: not an object` };
    const t = text(p.text, MAX_LINE);
    if (!t) return { error: `parked ${i}: text is required` };
    if (p.from !== undefined && typeof p.from !== 'string') return { error: `parked ${i}: from must be text` };
    parked.push({ text: t, from: text(p.from, 80) });
  }
  return { doc: { updated: new Date(now).toISOString(), projects, parked } };
}

/* Null until the first push, so the page can hide the block. */
export async function projectsBlock(env) {
  const doc = await env.HUB_KV.get(PROJECTS_KEY, 'json');
  return doc || null;
}

export async function putProjects(env, body, now = Date.now()) {
  const out = cleanProjects(body, now);
  if (out.error) return out;
  await env.HUB_KV.put(PROJECTS_KEY, JSON.stringify(out.doc));
  return out;
}

/* ---------- The route ---------- */

/* ---------- Kitchen: tonight's dinner and the pizza dough's mix day ---------- */

/* { tonight: { kind, title, veg } | null, mixToday, pizzaOn } from the kitchen's Durable
 * Object, or null when KITCHEN_CODE is not set or there is nothing to say today. */
export async function kitchenBlock(env, now = Date.now()) {
  if (!env.KITCHEN_CODE || !env.KITCHEN_STORE) return null;
  const d = (await kitchen(env, env.KITCHEN_CODE, '/read')).data;
  if (!d || !Array.isArray(d.items)) throw new Error('no items');
  return tonightView(d.items, local(now).date);
}

const block = (fn, message) => Promise.resolve().then(fn).catch(() => ({ error: message }));

export async function handleMorning(request, env, rest, json, now = Date.now()) {
  if (rest.length === 1 && rest[0] === 'calendar') return pushCalendar(request, env, json);
  if (rest.length !== 1) return json({ error: 'not found' }, request, 404);
  const code = rest[0];
  if (!CODE.test(code)) return json({ error: 'bad code' }, request, 400);
  if (!env.TODO_CODE || !safeEqual(code, env.TODO_CODE)) return json({ error: 'unknown code' }, request, 404);
  if (request.method !== 'GET') return json({ error: 'method' }, request, 405);

  const [todos, calendar, weatherB, arsenalB, binsB, fixed, birthdays, newsB, kitchenB, projects] = await Promise.all([
    block(() => todosBlock(env, now), "To-dos can't load right now"),
    block(() => calendarBlock(env, now), "Calendar can't load right now"),
    block(() => weather(env, now), "Weather can't load right now"),
    block(() => arsenal(env, now), "Arsenal can't load right now"),
    block(() => bins(env, now), "Bin days can't load right now"),
    block(() => fixedBlock(env.FIXED_EVENTS, now), 'Fixed events could not be read'),
    block(() => birthdaysBlock(env.BIRTHDAYS, now), 'Birthdays could not be read'),
    block(() => news(env, now), "News can't load right now"),
    block(() => kitchenBlock(env, now), "Kitchen can't load right now"),
    block(() => projectsBlock(env), "Projects can't load right now"),
  ]);
  return json({
    now: new Date(now).toISOString(),
    todos,
    calendar,
    fixed: fixed.error ? { events: [], countdowns: [] } : fixed,
    weather: weatherB,
    arsenal: arsenalB,
    bins: binsB,
    birthdays: birthdays.error ? { birthdays: [] } : birthdays,
    news: newsB,
    kitchen: kitchenB,
    projects,
  }, request);
}
