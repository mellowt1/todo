// Morning Screen module: routes, parsers and cache paths. fetch is mocked; no network.
// Every name, place and address here is made up.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  local, zoned, isoLocal, rideDay, cleanCalendar, inWindow, calendarBlock, parseFixed, fixedBlock,
  trimWeather, weatherBlock, rainSlots, rainLine, relativeWind, compass, parseArsenal, arsenalBlock,
  parseAddress, parseBins, streamNames, binsBlock, cached, handleMorning, CAL_KEY,
  WEATHER_URL, ESPN_RESULTS, ESPN_FIXTURES, BINS_BASE,
  parseBirthdays, birthdaysBlock, parseNews, NEWS_URL, addDays as addDaysW,
} from '../src/morning.js';
import { memNamespace } from './mem.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const CODE = 'abcdefgh23456789';
const BASE = 'https://paul-hub.example.workers.dev';
const TOKEN = 'push-token-for-tests';
const ADDRESS = '9999ZZ 12'; // not a real address

/* ---------- Stand-ins ---------- */

function memKV() {
  const m = new Map();
  const kv = {
    m, gets: 0, puts: 0, fail: false,
    async get(k, type) {
      kv.gets++;
      if (kv.fail) throw new Error('kv down');
      const v = m.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { kv.puts++; if (kv.fail) throw new Error('kv down'); m.set(k, v); },
  };
  return kv;
}

function makeEnv(over = {}) {
  return {
    TODO_LIST: memNamespace(),
    TODO_CODE: CODE,
    HUB_KV: memKV(),
    CALENDAR_PUSH_TOKEN: TOKEN,
    ...over,
  };
}

// fetch mock: a map of URL prefix -> () => body (object) | Response | Error.
let calls;
let routes;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  routes = {};
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.startsWith(k));
    if (!key) throw new Error('no route for ' + url);
    const out = routes[key](url);
    if (out instanceof Error) throw out;
    if (out instanceof Response) return out;
    return Response.json(out);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const hits = (prefix) => calls.filter((u) => u.startsWith(prefix)).length;

/* ---------- Fixtures ---------- */

const pad = (n) => String(n).padStart(2, '0');
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// Open-Meteo shaped answer. hour(dateTime) and quarter(endTime) return the values.
function openMeteo({ from = '2026-10-05', days = 9, hour = () => ({}), quarterFrom = '2026-10-07T07:30', quarter = () => 0 } = {}) {
  const h = { time: [], temperature_2m: [], precipitation_probability: [], precipitation: [], wind_speed_10m: [], wind_gusts_10m: [], wind_direction_10m: [] };
  for (let d = 0; d < days; d++) {
    const date = addDays(from, d);
    for (let i = 0; i < 24; i++) {
      const t = `${date}T${pad(i)}:00`;
      const v = { temp: 14, prob: 0, mm: 0, wind: 10, gusts: 20, dir: 225, ...hour(t) };
      h.time.push(t);
      h.temperature_2m.push(v.temp);
      h.precipitation_probability.push(v.prob);
      h.precipitation.push(v.mm);
      h.wind_speed_10m.push(v.wind);
      h.wind_gusts_10m.push(v.gusts);
      h.wind_direction_10m.push(v.dir);
    }
  }
  const m = { time: [], precipitation: [] };
  let t = zoned(quarterFrom.slice(0, 10), quarterFrom.slice(11));
  for (let i = 0; i < 24; i++, t += 15 * MIN) {
    const l = local(t);
    const key = `${l.date}T${l.time}`;
    m.time.push(key);
    m.precipitation.push(quarter(key));
  }
  const daily = { time: [], sunrise: [], sunset: [] };
  for (let d = 0; d < days; d++) {
    const date = addDays(from, d);
    daily.time.push(date);
    daily.sunrise.push(`${date}T07:55`);
    daily.sunset.push(`${date}T19:05`);
  }
  return { latitude: 52.08, longitude: 4.3, timezone: 'Europe/Amsterdam', hourly: h, minutely_15: m, daily };
}

function espnEvent({ date, opp = 'Fictional Rovers', oppShort, home = true, us, them, completed = false, state, league = 'Premier League', usPens, themPens, usWin, themWin }) {
  const score = (v, pens, win) => (v === undefined ? undefined : { value: v, displayValue: String(v), ...(pens !== undefined ? { shootoutScore: pens } : {}), winner: !!win });
  const a = { homeAway: home ? 'home' : 'away', winner: !!usWin, team: { id: '359', displayName: 'Arsenal', shortDisplayName: 'Arsenal' }, score: score(us, usPens, usWin) };
  const b = { homeAway: home ? 'away' : 'home', winner: !!themWin, team: { id: '9001', displayName: opp, shortDisplayName: oppShort || opp }, score: score(them, themPens, themWin) };
  return {
    date,
    league: { name: 'English ' + league, shortName: league, abbreviation: league },
    competitions: [{ competitors: home ? [a, b] : [b, a], status: { type: { completed, state: state || (completed ? 'post' : 'pre') } } }],
  };
}

/* ---------- Time in Amsterdam ---------- */

test('local time and zoned time agree across the October clock change', () => {
  assert.equal(zoned('2026-10-24', '08:00'), Date.parse('2026-10-24T06:00:00Z'));
  assert.equal(zoned('2026-10-26', '08:00'), Date.parse('2026-10-26T07:00:00Z'));
  assert.equal(zoned('2026-03-30', '08:00'), Date.parse('2026-03-30T06:00:00Z'));
  const l = local(Date.parse('2026-10-25T23:30:00Z'));
  assert.equal(l.date, '2026-10-26');
  assert.equal(l.time, '00:30');
  assert.equal(l.weekday, 1);
  assert.equal(isoLocal(zoned('2026-10-07', '20:00')), '2026-10-07T20:00:00+02:00');
  assert.equal(isoLocal(zoned('2026-11-02', '20:00')), '2026-11-02T20:00:00+01:00');
});

test('ride day: weekdays until 17:30, then the next weekday', () => {
  assert.equal(rideDay(zoned('2026-10-07', '07:00')), '2026-10-07'); // Wednesday morning
  assert.equal(rideDay(zoned('2026-10-07', '17:30')), '2026-10-07');
  assert.equal(rideDay(zoned('2026-10-07', '17:31')), '2026-10-08');
  assert.equal(rideDay(zoned('2026-10-09', '18:00')), '2026-10-12'); // Friday evening -> Monday
  assert.equal(rideDay(zoned('2026-10-10', '09:00')), '2026-10-12'); // Saturday -> Monday
  assert.equal(rideDay(zoned('2026-10-11', '23:59')), '2026-10-12'); // Sunday -> Monday
});

/* ---------- Calendar push ---------- */

const ev = (over = {}) => ({ title: 'Book club', start: '2026-10-08T19:30:00+02:00', end: '2026-10-08T21:00:00+02:00', allDay: false, location: 'Library', ...over });

test('cleanCalendar keeps the contract and nothing else', () => {
  const out = cleanCalendar({ sent: '2026-10-07T07:30:00+02:00', events: [ev({ notes: 'secret', attendees: ['x'] })], extra: 1 });
  assert.deepEqual(out.doc.events, [ev()]);
  assert.equal(out.doc.sent, '2026-10-07T07:30:00+02:00');
  assert.ok(out.doc.received);
  // All day, location missing or null, empty title.
  assert.ok(cleanCalendar({ sent: '2026-10-07T05:30:00Z', events: [{ title: '', start: '2026-10-09', end: '2026-10-10', allDay: true }] }).doc);
  assert.equal(cleanCalendar({ sent: '2026-10-07T05:30:00Z', events: [ev({ location: null })] }).doc.events[0].location, '');
  // A long place is cut, not refused.
  assert.equal(cleanCalendar({ sent: '2026-10-07T05:30:00Z', events: [ev({ location: 'x'.repeat(400) })] }).doc.events[0].location.length, 200);
});

test('cleanCalendar refuses anything off contract, naming the event', () => {
  const bad = (events, sent = '2026-10-07T05:30:00Z') => cleanCalendar({ sent, events }).error;
  assert.ok(bad([], 'yesterday'));
  assert.ok(bad([], '2026-10-07T05:30:00')); // no offset
  assert.ok(cleanCalendar(null).error);
  assert.ok(cleanCalendar([]).error);
  assert.ok(cleanCalendar({ sent: '2026-10-07T05:30:00Z' }).error);
  assert.match(bad([ev(), ev({ title: 'x'.repeat(201) })]), /^event 1: title/);
  assert.ok(bad([ev({ title: 42 })]));
  assert.ok(bad([ev({ allDay: 'no' })]));
  assert.ok(bad([ev({ start: '2026-10-08T19:30:00' })]));
  assert.ok(bad([ev({ start: '2026-10-08' })])); // a date on a timed event
  assert.ok(bad([ev({ allDay: true })])); // ISO on an all day event
  assert.ok(bad([ev({ allDay: true, start: '2026-02-30', end: '2026-03-01' })]));
  assert.ok(bad([ev({ end: '2026-10-08T18:00:00+02:00' })])); // end before start
  assert.ok(bad([ev({ location: 5 })]));
  assert.ok(bad(Array.from({ length: 501 }, () => ev())));
  assert.equal(cleanCalendar({ sent: '2026-10-07T05:30:00Z', events: Array.from({ length: 500 }, () => ev()) }).doc.events.length, 500);
});

test('POST /api/morning/calendar: token, method, size, JSON, then stored', async () => {
  const env = makeEnv();
  const push = (body, headers = { Authorization: 'Bearer ' + TOKEN }, method = 'POST') =>
    worker.fetch(new Request(BASE + '/api/morning/calendar', { method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined }), env);
  const good = { sent: '2026-10-07T07:30:00+02:00', events: [ev(), ev({ title: 'Trip', start: '2026-10-10', end: '2026-10-12', allDay: true, location: '' })] };

  assert.equal((await push(good, {})).status, 401);
  assert.equal((await push(good, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await push(good, { Authorization: 'Bearer ' + CODE })).status, 401);
  assert.equal((await push(null, { Authorization: 'Bearer ' + TOKEN }, 'GET')).status, 405);
  assert.equal((await push('{nope')).status, 400);
  assert.equal((await push({ sent: 'x', events: [] })).status, 400);
  assert.equal((await push('x'.repeat(200 * 1024 + 1))).status, 413);
  assert.equal(env.HUB_KV.m.has(CAL_KEY), false);

  const r = await push(good);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, count: 2 });
  assert.equal(JSON.parse(env.HUB_KV.m.get(CAL_KEY)).events.length, 2);

  // Without the secret set, nobody can push.
  const env2 = makeEnv({ CALENDAR_PUSH_TOKEN: undefined });
  const r2 = await worker.fetch(new Request(BASE + '/api/morning/calendar', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(good) }), env2);
  assert.equal(r2.status, 401);
});

test('calendar window: today and six more days, all day ends are exclusive, end equal to start is fine', () => {
  const now = zoned('2026-10-07', '07:40'); // Wednesday
  const events = [
    ev({ title: 'over', start: '2026-10-07T06:00:00+02:00', end: '2026-10-07T07:00:00+02:00' }),
    ev({ title: 'today', start: '2026-10-07T10:00:00+02:00', end: '2026-10-07T11:00:00+02:00' }),
    ev({ title: 'no end', start: '2026-10-08T14:00:00+02:00', end: '2026-10-08T14:00:00+02:00' }),
    ev({ title: 'one day', start: '2026-10-09', end: '2026-10-10', allDay: true }),
    ev({ title: 'yesterday all day', start: '2026-10-06', end: '2026-10-07', allDay: true }),
    ev({ title: 'three days', start: '2026-10-05', end: '2026-10-08', allDay: true }), // Mon to Wed
    ev({ title: 'last day', start: '2026-10-13T23:00:00+02:00', end: '2026-10-13T23:30:00+02:00' }),
    ev({ title: 'too far', start: '2026-10-14T00:00:00+02:00', end: '2026-10-14T01:00:00+02:00' }),
    ev({ title: 'too far all day', start: '2026-10-14', end: '2026-10-15', allDay: true }),
    ev({ title: 'utc', start: '2026-10-08T08:00:00Z', end: '2026-10-08T09:00:00Z' }),
  ];
  const titles = inWindow(events, now).map((e) => e.title);
  assert.deepEqual(titles, ['three days', 'today', 'utc', 'no end', 'one day', 'last day']);
});

test('calendar block: stale after an hour, empty and stale before the first push', async () => {
  const env = makeEnv();
  const now = zoned('2026-10-07', '07:40');
  assert.deepEqual(await calendarBlock(env, now), { events: [], sent: null, stale: true });
  env.HUB_KV.m.set(CAL_KEY, JSON.stringify({ sent: '2026-10-07T07:30:00+02:00', received: new Date(now - 10 * MIN).toISOString(), events: [ev()] }));
  let b = await calendarBlock(env, now);
  assert.equal(b.stale, false);
  assert.equal(b.events.length, 1);
  assert.equal(b.sent, '2026-10-07T07:30:00+02:00');
  b = await calendarBlock(env, now + 61 * MIN);
  assert.equal(b.stale, true);
});

/* ---------- Fixed events and countdowns ---------- */

const FIXED = JSON.stringify({
  events: [
    { title: 'Choir, group B', date: '2026-09-07', start: '20:00', end: '22:00', repeat: 'weekly', until: '2026-10-26' },
    { title: 'Theme night', date: '2026-10-09', start: '19:00', end: '21:30' },
    { title: 'Open day', date: '2026-10-10' },
    { title: 'Late shift', date: '2026-10-08', start: '23:00', end: '01:00' },
    { title: 'Broken', date: 'soon' },
    { title: 'Bad time', date: '2026-10-08', start: '25:00' },
  ],
  countdowns: [
    { what: 'the trip', date: '2026-10-19' },
    { what: 'today thing', date: '2026-10-07' },
    { what: 'gone', date: '2026-10-01' },
    { what: 'no date' },
  ],
});

test('fixed events: weekly repeats until their end date, one offs, all day, overnight', () => {
  const now = zoned('2026-10-07', '07:40'); // Wednesday
  const b = fixedBlock(FIXED, now);
  assert.deepEqual(b.events.map((e) => [e.title, e.start, e.end, e.allDay]), [
    ['Late shift', '2026-10-08T23:00:00+02:00', '2026-10-09T01:00:00+02:00', false],
    ['Theme night', '2026-10-09T19:00:00+02:00', '2026-10-09T21:30:00+02:00', false],
    ['Open day', '2026-10-10', '2026-10-11', true],
    ['Choir, group B', '2026-10-12T20:00:00+02:00', '2026-10-12T22:00:00+02:00', false],
  ]);
  assert.deepEqual(b.countdowns, [
    { what: 'today thing', date: '2026-10-07', days: 0 },
    { what: 'the trip', date: '2026-10-19', days: 12 },
  ]);
  // The weekly event stops after its until date, and uses winter time after the switch.
  const later = fixedBlock(FIXED, zoned('2026-10-20', '08:00'));
  assert.deepEqual(later.events.filter((e) => e.title.startsWith('Choir')).map((e) => e.start), ['2026-10-26T20:00:00+01:00']);
  assert.equal(fixedBlock(FIXED, zoned('2026-10-27', '08:00')).events.filter((e) => e.title.startsWith('Choir')).length, 0);
  // Tonight's session still shows before it ends, not after.
  assert.equal(fixedBlock(FIXED, zoned('2026-10-12', '21:00')).events.filter((e) => e.title.startsWith('Choir')).length, 1);
  assert.equal(fixedBlock(FIXED, zoned('2026-10-12', '22:30')).events.filter((e) => e.title.startsWith('Choir')).length, 0);
});

test('fixed events: a missing or broken secret is just empty', () => {
  const now = zoned('2026-10-07', '07:40');
  for (const raw of [undefined, '', 'not json', '[]', '{"events":"x"}', 'null']) {
    assert.deepEqual(fixedBlock(raw, now), { events: [], countdowns: [] });
  }
  assert.equal(parseFixed(FIXED).events.length, 4);
});

/* ---------- Weather ---------- */

test('weather: rides read at 08:00 and 17:30, rain from the hour the ride falls in', () => {
  const w = trimWeather(openMeteo({
    hour: (t) => ({
      '2026-10-07T08:00': { temp: 9.6, wind: 18.4, gusts: 31.6, dir: 225 },
      '2026-10-07T09:00': { temp: 11, prob: 70, mm: 0.8, wind: 20, gusts: 34, dir: 225 },
      '2026-10-07T17:00': { temp: 16, wind: 14, gusts: 26, dir: 350 },
      '2026-10-07T18:00': { temp: 18, prob: 5, mm: 0, wind: 18, gusts: 30, dir: 10 },
    }[t] || {}),
  }));
  const b = weatherBlock(w, zoned('2026-10-07', '06:00'), null);
  assert.equal(b.day, '2026-10-07');
  const [a, h] = b.rides;
  assert.deepEqual([a.time, a.label, a.temp, a.rainProb, a.rainMm, a.wind, a.gusts, a.compass, a.relative, a.past], ['08:00', 'to work', 10, 70, 0.8, 18, 32, 'SW', null, false]);
  assert.deepEqual([h.time, h.label, h.temp, h.rainProb, h.wind, h.gusts, h.compass], ['17:30', 'home', 17, 5, 16, 28, 'N']);
  assert.equal(h.dir, 0); // halfway between 350 and 10 is north, not south
  assert.equal(b.sun[0].sunrise, '2026-10-05T07:55');
});

test('weather: rain soon near the morning ride gives a leave time', () => {
  const w = trimWeather(openMeteo({ quarter: (t) => (t === '2026-10-07T08:15' || t === '2026-10-07T08:30' ? 0.4 : 0) }));
  const b = weatherBlock(w, zoned('2026-10-07', '07:40'), null);
  assert.deepEqual(b.rain.slots.map((s) => s.time), ['07:30', '07:45', '08:00', '08:15', '08:30', '08:45', '09:00', '09:15']);
  assert.deepEqual(b.rain.slots.map((s) => s.mm), [0, 0, 0.4, 0.4, 0, 0, 0, 0]);
  assert.equal(b.rain.line, 'Rain from 08:00 to 08:30');
  assert.equal(b.verdict, 'Rain around 08:00. Leave at 08:30 and stay dry.');
});

test('weather: the 15 minute forecast overrides the hourly one for the next ride', () => {
  // Hourly says rain at 08:00, but the next two hours are dry.
  const w = trimWeather(openMeteo({ hour: (t) => (t === '2026-10-07T09:00' ? { prob: 80, mm: 1.2 } : {}) }));
  assert.equal(weatherBlock(w, zoned('2026-10-07', '07:40'), null).verdict, 'Dry both ways.');
  // Rain that keeps going past the strip: plain rain, no leave time.
  const w2 = trimWeather(openMeteo({ quarter: (t) => (t >= '2026-10-07T08:00' ? 0.5 : 0) }));
  const b2 = weatherBlock(w2, zoned('2026-10-07', '07:40'), null);
  assert.equal(b2.verdict, 'Rain going in, dry home.');
  assert.equal(b2.rain.line, 'Dry until 07:45');
});

test('weather: verdict lines for tomorrow, Monday, the ride home only, wind and cold', () => {
  const windyHome = trimWeather(openMeteo({ hour: (t) => (t.endsWith('T17:00') || t.endsWith('T18:00') ? { wind: 30, gusts: 50 } : {}) }));
  let b = weatherBlock(windyHome, zoned('2026-10-07', '18:00'), null);
  assert.equal(b.day, '2026-10-08');
  assert.equal(b.verdict, 'Dry both ways tomorrow, windy home.');

  const wetMonday = trimWeather(openMeteo({ hour: (t) => (t === '2026-10-12T09:00' ? { prob: 80, mm: 1 } : {}) }));
  b = weatherBlock(wetMonday, zoned('2026-10-09', '18:00'), null);
  assert.equal(b.day, '2026-10-12');
  assert.equal(b.verdict, 'Monday: rain going in, dry home.');

  // At 10:00 the morning ride is over: the verdict is about the ride home.
  b = weatherBlock(windyHome, zoned('2026-10-07', '10:00'), null);
  assert.equal(b.rides[0].past, true);
  assert.equal(b.verdict, 'Dry home, windy.');

  const cold = trimWeather(openMeteo({ hour: (t) => ({ temp: 1, prob: 30 }) }));
  assert.equal(weatherBlock(cold, zoned('2026-10-07', '18:00'), null).verdict, 'Showers possible both ways tomorrow. Cold, gloves on.');
});

test('weather: headwind and tailwind only when a work bearing is set', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(359), 'N');
  assert.equal(compass(202), 'S');
  assert.equal(compass(203), 'SW');
  assert.equal(relativeWind(240, 60, 20), 'tailwind');
  assert.equal(relativeWind(240, 240, 20), 'headwind');
  assert.equal(relativeWind(240, 150, 20), null);
  assert.equal(relativeWind(240, 240, 5), null); // too light to matter
  assert.equal(relativeWind(240, null, 30), null);
  const sw = trimWeather(openMeteo({ hour: () => ({ wind: 20, gusts: 30, dir: 240 }) }));
  const b = weatherBlock(sw, zoned('2026-10-07', '18:00'), 60);
  assert.deepEqual(b.rides.map((r) => r.relative), ['tailwind', 'headwind']);
  assert.equal(b.verdict, 'Dry both ways tomorrow, headwind home.');
  assert.deepEqual(weatherBlock(sw, zoned('2026-10-07', '18:00'), null).rides.map((r) => r.relative), [null, null]);
});

test('rain line wording', () => {
  const s = (mm) => mm.map((v, i) => ({ time: `08:${pad(i * 15 % 60)}`, mm: v, startMs: i * 15 * MIN, endMs: (i + 1) * 15 * MIN }));
  assert.equal(rainLine(s([0, 0, 0, 0, 0, 0, 0, 0])), 'Dry for the next 2 hours');
  assert.match(rainLine(s([0.2, 0.2, 0, 0, 0, 0, 0, 0])), /^Rain until \d\d:\d\d$/);
  assert.equal(rainLine(s([0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3])), 'Rain for the next 2 hours');
  assert.equal(rainLine(s([0, 0, 0, 0, 0, 0, 0.5, 0.5])), 'Dry until 08:30');
  assert.match(rainLine(s([0, 0, 0.1, 0, 0, 0, 0, 0])), /^Rain from 08:30 to \d\d:\d\d$/);
  assert.equal(rainLine([]), '');
});

test('rain slots start at the current quarter and are labelled by their start', () => {
  const w = trimWeather(openMeteo({ quarterFrom: '2026-10-07T19:30' }));
  const slots = rainSlots(w, zoned('2026-10-07', '19:44'));
  assert.equal(slots.length, 8);
  assert.equal(slots[0].time, '19:30'); // 19:30 to 19:45, now is inside it
  assert.equal(slots[7].time, '21:15');
});

test('trimWeather refuses an answer without the parts it needs', () => {
  assert.throws(() => trimWeather({}));
  assert.throws(() => trimWeather({ hourly: { time: [] }, daily: { time: [] } }));
});

/* ---------- Arsenal ---------- */

const RESULTS = { events: [
  espnEvent({ date: '2026-09-19T14:00Z', opp: 'Seaside Albion', oppShort: 'Seaside', home: false, us: 0, them: 3, completed: true, themWin: true }),
  espnEvent({ date: '2026-09-15T19:00Z', opp: 'Harbour Town', home: false, us: 4, them: 2, completed: true, usWin: true, league: 'Carabao Cup' }),
] };
const FIXTURES = { events: [
  espnEvent({ date: '2026-10-13T19:00Z', opp: 'Lakeside', home: true, league: 'UEFA Champions League' }),
  espnEvent({ date: '2026-10-10T11:30Z', opp: 'Northern United', oppShort: 'Northern', home: true }),
] };

test('arsenal: next fixture across competitions and the last result', () => {
  const data = parseArsenal(RESULTS, FIXTURES);
  assert.deepEqual(data.last, { opponent: 'Seaside', home: false, competition: 'Premier League', kickoff: '2026-09-19T14:00:00.000Z', us: 0, them: 3, result: 'Lost', pens: null });
  const b = arsenalBlock(data, Date.parse('2026-10-01T08:00:00Z'));
  assert.deepEqual(b.next, { opponent: 'Northern', home: true, competition: 'Premier League', kickoff: '2026-10-10T11:30:00.000Z', live: false });
  // During the match it is still next, and live; after it, the one after.
  assert.equal(arsenalBlock(data, Date.parse('2026-10-10T12:00:00Z')).next.live, true);
  assert.equal(arsenalBlock(data, Date.parse('2026-10-10T15:00:00Z')).next.opponent, 'Lakeside');
  assert.equal(arsenalBlock(data, Date.parse('2026-10-10T15:00:00Z')).next.competition, 'Champions League');
});

test('arsenal: draws, wins on penalties, and half broken feeds', () => {
  const drew = parseArsenal({ events: [espnEvent({ date: '2026-08-01T18:00Z', us: 1, them: 1, completed: true })] }, null);
  assert.equal(drew.last.result, 'Drew');
  assert.deepEqual(drew.upcoming, []);
  const pens = parseArsenal({ events: [espnEvent({ date: '2026-08-12T18:30Z', us: 1, them: 1, usPens: 4, themPens: 3, usWin: true, completed: true })] }, null);
  assert.equal(pens.last.result, 'Won');
  assert.equal(pens.last.pens, '4 to 3');
  const noResults = parseArsenal(null, FIXTURES);
  assert.equal(noResults.last, null);
  assert.equal(noResults.upcoming.length, 2);
  assert.throws(() => parseArsenal({ events: [] }, { events: [{ nonsense: true }] }));
});

test('arsenal: when the first ESPN host refuses, the second one is asked', async () => {
  const env = makeEnv();
  allSources();
  routes[ESPN_RESULTS] = routes[ESPN_FIXTURES] = () => new Response('Forbidden', { status: 403 });
  routes['https://site.api.espn.com/'] = (u) => (u.includes('fixture=true') ? FIXTURES : RESULTS);
  const b = await (await get(env, zoned('2026-10-07', '07:40'))).json();
  assert.equal(b.arsenal.next.opponent, 'Northern');
  assert.equal(b.arsenal.last.opponent, 'Seaside');
  assert.equal(hits('https://site.api.espn.com/'), 2);
});

/* ---------- Bins ---------- */

test('bins: address parsing, stream names, next collections grouped by day', () => {
  assert.deepEqual(parseAddress('9999ZZ 12'), { postcode: '9999ZZ', number: '12', extra: '' });
  assert.deepEqual(parseAddress(' 9999 zz 12 a '), { postcode: '9999ZZ', number: '12', extra: 'a' });
  assert.deepEqual(parseAddress('9999ZZ 12-3'), { postcode: '9999ZZ', number: '12', extra: '3' });
  assert.equal(parseAddress('Somewhere 12'), null);
  assert.equal(parseAddress(undefined), null);

  const names = streamNames([{ id: 1, title: 'GFT' }, { id: 4, title: 'Rest' }, { id: 7, title: 'Textiel' }, { bad: true }]);
  assert.equal(names[4], 'Restafval');
  assert.equal(names[7], 'Textiel');
  assert.equal(streamNames(null)[3], 'Papier');

  const list = parseBins([[
    { afvalstroom_id: 1, ophaaldatum: '2026-10-06' },
    { afvalstroom_id: 1, ophaaldatum: '2026-10-07' },
    { afvalstroom_id: 4, ophaaldatum: '2026-10-07' },
    { afvalstroom_id: 3, ophaaldatum: '2026-10-13' },
    { afvalstroom_id: 99, ophaaldatum: '2026-10-08' },
    { afvalstroom_id: 1, ophaaldatum: 'soon' },
  ]], names);
  const b = binsBlock(list, zoned('2026-10-07', '07:00'));
  assert.deepEqual(b.collections, [{ date: '2026-10-07', types: ['GFT', 'Restafval'] }, { date: '2026-10-13', types: ['Papier'] }]);
});

/* ---------- The GET route ---------- */

function allSources({ weather = openMeteo(), results = RESULTS, fixtures = FIXTURES, streams = [{ id: 1, title: 'GFT' }, { id: 3, title: 'Papier' }], cal = [{ afvalstroom_id: 1, ophaaldatum: '2026-10-08' }, { afvalstroom_id: 3, ophaaldatum: '2026-10-13' }] } = {}) {
  routes[WEATHER_URL] = () => weather;
  routes[ESPN_FIXTURES] = () => fixtures;
  routes[ESPN_RESULTS] = (u) => (u.includes('fixture=true') ? fixtures : results);
  routes[BINS_BASE + '9999ZZ-12'] = () => [{ bagId: '0000000000000001', huisletter: '', huisnummerToevoeging: '' }];
  routes[BINS_BASE + '0000000000000001/afvalstromen'] = () => streams;
  routes[BINS_BASE + '0000000000000001/kalender/'] = () => cal;
  routes[NEWS_URL] = () => new Response(RSS, { headers: { 'Content-Type': 'text/xml' } });
}

const get = (env, now, path = '/api/morning/' + CODE, init = {}) =>
  handleMorning(new Request(BASE + path, init), env, path.split('/').filter(Boolean).slice(2), (d, _r, status = 200) => Response.json(d, { status }), now);

async function addTasks(env) {
  const n = Date.now();
  const t = (id, section, done, pos) => ({ op: 'upsert', item: { id, text: 'Task ' + id, section, done, doneAt: done ? n : null, updatedAt: n, pos } });
  const r = await worker.fetch(new Request(`${BASE}/api/todo/${CODE}/ops`, { method: 'POST', body: JSON.stringify({ ops: [t('aaaaaaaa', 'today', false, n - 2), t('bbbbbbbb', 'today', false, n - 1), t('cccccccc', 'soon', false, n), t('dddddddd', 'today', true, n)] }) }), env);
  assert.equal(r.status, 200);
}

test('GET /api/morning/:code: same code as the to-do, GET only', async () => {
  const env = makeEnv();
  allSources();
  const call = (path, init) => worker.fetch(new Request(BASE + path, init), env);
  assert.equal((await call('/api/morning/short')).status, 400);
  assert.equal((await call('/api/morning/abcdefgh2345678x')).status, 404);
  assert.equal((await call('/api/morning/' + CODE, { method: 'POST' })).status, 405);
  assert.equal((await call('/api/morning/' + CODE + '/extra')).status, 404);
  assert.equal((await call('/api/morning')).status, 404);
  const r = await call('/api/morning/' + CODE, { headers: { Origin: 'https://mellowt1.github.io' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://mellowt1.github.io');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(calls.length > 0, true);
});

test('GET: every block in one answer; to-dos are open Today items only, newest first', async () => {
  const now = zoned('2026-10-07', '07:40');
  const env = makeEnv({ BIN_ADDRESS: ADDRESS, FIXED_EVENTS: FIXED });
  allSources();
  await addTasks(env);
  env.HUB_KV.m.set(CAL_KEY, JSON.stringify({ sent: '2026-10-07T07:30:00+02:00', received: new Date(now - 5 * MIN).toISOString(), events: [ev()] }));
  const b = await (await get(env, now)).json();
  assert.deepEqual(b.todos.items, [{ text: 'Task bbbbbbbb' }, { text: 'Task aaaaaaaa' }]);
  assert.ok(b.todos.updated);
  assert.equal(b.calendar.events.length, 1);
  assert.equal(b.calendar.stale, false);
  assert.equal(b.fixed.events.length, 4);
  assert.equal(b.fixed.countdowns.length, 2);
  assert.equal(b.weather.day, '2026-10-07');
  assert.equal(b.weather.rides.length, 2);
  assert.equal(b.weather.rain.slots.length, 8);
  assert.equal(b.arsenal.next.opponent, 'Northern');
  assert.equal(b.arsenal.last.result, 'Lost');
  assert.deepEqual(b.bins.collections, [{ date: '2026-10-08', types: ['GFT'] }, { date: '2026-10-13', types: ['Papier'] }]);
  assert.equal(b.now, new Date(now).toISOString());
});

test('GET: one failing source never breaks the others', async () => {
  const now = zoned('2026-10-07', '07:40');
  const env = makeEnv({ BIN_ADDRESS: ADDRESS });
  allSources();
  routes[WEATHER_URL] = () => new Response('oops', { status: 502 });
  routes[ESPN_RESULTS] = routes[ESPN_FIXTURES] = () => new Error('network');
  for (const k of Object.keys(routes)) if (k.startsWith(BINS_BASE)) routes[k] = () => new Error('network');
  const b = await (await get(env, now)).json();
  assert.deepEqual(b.weather, { error: "Weather can't load right now" });
  assert.deepEqual(b.arsenal, { error: "Arsenal can't load right now" });
  assert.deepEqual(b.bins, { error: "Bin days can't load right now" });
  assert.deepEqual(b.todos, { items: [], updated: null, yesterday: { count: 0, items: [] } });
  assert.deepEqual(b.fixed, { events: [], countdowns: [] });
  assert.equal(b.calendar.stale, true);

  // A broken to-do store or KV only takes its own block down.
  const env2 = makeEnv({ TODO_LIST: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error('down'); } }) } });
  env2.HUB_KV.fail = true;
  allSources();
  const b2 = await (await get(env2, now)).json();
  assert.deepEqual(b2.todos, { error: "To-dos can't load right now" });
  assert.deepEqual(b2.calendar, { error: "Calendar can't load right now" });
  assert.equal(b2.weather.rides.length, 2); // no cache, still served
  assert.equal(b2.bins, null); // no address set: no bin block, not an error
});

test('GET: garbage from a source is an error in that block only', async () => {
  const now = zoned('2026-10-07', '07:40');
  const env = makeEnv({ BIN_ADDRESS: ADDRESS });
  allSources({ weather: { hourly: 'nope' }, results: { events: 'x' }, fixtures: { nothing: 1 } });
  routes[BINS_BASE + '9999ZZ-12'] = () => [];
  const b = await (await get(env, now)).json();
  assert.ok(b.weather.error);
  assert.deepEqual(b.arsenal, { error: "Arsenal can't load right now" });
  assert.ok(b.bins.error);
  // Weather for a day the forecast does not cover.
  allSources({ weather: openMeteo({ from: '2026-01-01', days: 2 }) });
  const env2 = makeEnv();
  assert.ok((await (await get(env2, now)).json()).weather.error);
});

/* ---------- Cache paths ---------- */

test('cache: weather 15 minutes, Arsenal 1 hour, bins 12 hours', async () => {
  const now = zoned('2026-10-07', '07:40');
  const env = makeEnv({ BIN_ADDRESS: ADDRESS });
  allSources();
  await get(env, now);
  assert.equal(hits(WEATHER_URL), 1);
  assert.equal(hits(ESPN_RESULTS), 2); // results and fixtures
  assert.equal(hits(BINS_BASE), 3); // address, streams, calendar

  await get(env, now + 14 * MIN);
  assert.equal(hits(WEATHER_URL), 1);
  await get(env, now + 16 * MIN);
  assert.equal(hits(WEATHER_URL), 2);
  assert.equal(hits(ESPN_RESULTS), 2);
  await get(env, now + 61 * MIN);
  assert.equal(hits(ESPN_RESULTS), 4);
  assert.equal(hits(BINS_BASE), 3);
  await get(env, now + 12 * HOUR + MIN);
  assert.equal(hits(BINS_BASE), 6);
  // The cache holds the trimmed data, never the address.
  const keys = [...env.HUB_KV.m.keys()];
  assert.ok(keys.includes('cache:weather') && keys.includes('cache:arsenal'));
  assert.ok(keys.some((k) => k.startsWith('cache:bins:')));
  for (const [k, v] of env.HUB_KV.m) assert.ok(!k.includes('9999') && !v.includes('9999ZZ'));
});

test('cache: a failing source falls back to the last good copy for a while', async () => {
  const now = zoned('2026-10-07', '07:40');
  const env = makeEnv();
  allSources();
  await get(env, now);
  routes[WEATHER_URL] = () => new Error('down');
  routes[ESPN_RESULTS] = routes[ESPN_FIXTURES] = () => new Error('down');
  let b = await (await get(env, now + 2 * HOUR)).json();
  assert.equal(b.weather.rides.length, 2);
  assert.ok(b.arsenal.next);
  b = await (await get(env, now + 4 * HOUR)).json();
  assert.deepEqual(b.weather, { error: "Weather can't load right now" });
  assert.ok(b.arsenal.next); // Arsenal keeps its copy for a day
  b = await (await get(env, now + 25 * HOUR)).json();
  assert.deepEqual(b.arsenal, { error: "Arsenal can't load right now" });
});

test('cached(): fresh hit, miss, stale fallback, and a KV that is down', async () => {
  const env = makeEnv();
  let n = 0;
  const load = async () => ++n;
  assert.equal(await cached(env, 'k', 1000, 5000, 0, load), 1);
  assert.equal(await cached(env, 'k', 1000, 5000, 500, load), 1);
  assert.equal(await cached(env, 'k', 1000, 5000, 1500, load), 2);
  const boom = async () => { throw new Error('x'); };
  assert.equal(await cached(env, 'k', 1000, 5000, 3000, boom), 2);
  await assert.rejects(cached(env, 'k', 1000, 5000, 9000, boom));
  env.HUB_KV.fail = true;
  assert.equal(await cached(env, 'k', 1000, 5000, 9000, load), 3);
});

/* ---------- Second pass: yesterday's wins, birthdays, news ---------- */

test("todos: yesterday's wins, from done items finished yesterday in Amsterdam", async () => {
  const env = makeEnv();
  const now = Date.now();
  const today = local(now).date;
  const y = addDaysW(today, -1);
  const at = (date, time) => zoned(date, time);
  const t = (id, text, done, doneAt, section = 'today') => ({ op: 'upsert', item: { id, text, section, done, doneAt: done ? doneAt : null, updatedAt: now - 1000, pos: now - 1000 } });
  const ops = [
    t('aaaaaaaa', 'Water the plants', true, at(y, '09:00')),
    t('bbbbbbbb', 'Call the garage', true, at(y, '23:30'), 'soon'),
    t('cccccccc', 'Two days ago', true, at(addDaysW(today, -2), '12:00')),
    t('dddddddd', 'Still open', false, null),
    t('eeeeeeee', 'Just before midnight the day before', true, at(y, '00:00') - 60000),
    ...['ffffffff', 'gggggggg', 'hhhhhhhh', 'iiiiiiii'].map((id, n) => t(id, 'Win ' + n, true, at(y, '10:0' + n))),
  ];
  const r = await worker.fetch(new Request(`${BASE}/api/todo/${CODE}/ops`, { method: 'POST', body: JSON.stringify({ ops }) }), env);
  assert.equal(r.status, 200);
  const b = await (await get(env, now)).json();
  assert.equal(b.todos.yesterday.count, 6);
  assert.deepEqual(b.todos.yesterday.items, ['Call the garage', 'Win 3', 'Win 2', 'Win 1', 'Win 0']);
  assert.deepEqual(b.todos.items, [{ text: 'Still open' }]);
});

test('birthdays: the next 14 days, ages when the year is known, 29 February', () => {
  const raw = JSON.stringify([
    { name: 'Nick', date: '1986-10-12' },
    { name: 'Ada', date: '10-07' },
    { name: 'Bea', date: '10-21' },
    { name: 'Cas', date: '10-22' }, // 15 days: out
    { name: 'Dora', date: '2001-10-06' }, // yesterday: next year, out
    { name: '  ', date: '10-08' },
    { name: 'Bad', date: '13-01' },
    { name: 'Bad2', date: '1999-02-29' },
    { name: 'Bad3' },
  ]);
  const b = birthdaysBlock(raw, zoned('2026-10-07', '07:40'));
  assert.deepEqual(b.birthdays, [
    { name: 'Ada', date: '2026-10-07', days: 0, age: null },
    { name: 'Nick', date: '2026-10-12', days: 5, age: 40 },
    { name: 'Bea', date: '2026-10-21', days: 14, age: null },
  ]);
  assert.equal(parseBirthdays(raw).length, 5);
  // Leap day birthdays land on 28 February in other years; across the new year too.
  const leap = JSON.stringify([{ name: 'Leo', date: '2000-02-29' }, { name: 'Noor', date: '1990-01-02' }]);
  assert.deepEqual(birthdaysBlock(leap, zoned('2027-02-20', '09:00')).birthdays, [{ name: 'Leo', date: '2027-02-28', days: 8, age: 27 }]);
  assert.deepEqual(birthdaysBlock(leap, zoned('2026-12-30', '09:00')).birthdays, [{ name: 'Noor', date: '2027-01-02', days: 3, age: 37 }]);
  for (const bad of [undefined, '', 'nope', '{}', 'null', '[1,2]']) assert.deepEqual(birthdaysBlock(bad, Date.now()), { birthdays: [] });
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>News</title>
  <item><title><![CDATA[First headline about the harbour]]></title><link>https://nos.nl/l/1</link><description><![CDATA[<p>body</p>]]></description></item>
  <item><title>Second &amp; plain &#8220;quoted&#8221; title - with a dash</title><link>https://nos.nl/l/2</link></item>
  <item><title><![CDATA[Not NOS]]></title><link>https://example.com/x</link></item>
  <item><title><![CDATA[Insecure]]></title><link>http://nos.nl/l/9</link></item>
  <item><title><![CDATA[Third one]]></title><link>https://nos.nl/l/3</link></item>
  <item><title><![CDATA[Fourth, not shown]]></title><link>https://nos.nl/l/4</link></item>
</channel></rss>`;

test('news: top three NOS headlines, https nos.nl links only, no dashes', () => {
  assert.deepEqual(parseNews(RSS).items, [
    { title: 'First headline about the harbour', link: 'https://nos.nl/l/1' },
    { title: 'Second & plain “quoted” title: with a dash', link: 'https://nos.nl/l/2' },
    { title: 'Third one', link: 'https://nos.nl/l/3' },
  ]);
  assert.throws(() => parseNews('<html>nope</html>'));
  assert.throws(() => parseNews('<rss><channel></channel></rss>'));
  assert.throws(() => parseNews(undefined));
});

test('GET: birthdays and news blocks, news cached 30 minutes, errors stay in their block', async () => {
  const now = zoned('2026-10-07', '07:40');
  const env = makeEnv({ BIRTHDAYS: JSON.stringify([{ name: 'Ada', date: '1990-10-09' }]) });
  allSources();
  let b = await (await get(env, now)).json();
  assert.deepEqual(b.birthdays, { birthdays: [{ name: 'Ada', date: '2026-10-09', days: 2, age: 36 }] });
  assert.equal(b.news.items.length, 3);
  assert.equal(hits(NEWS_URL), 1);
  await get(env, now + 29 * MIN);
  assert.equal(hits(NEWS_URL), 1);
  await get(env, now + 31 * MIN);
  assert.equal(hits(NEWS_URL), 2);
  // NOS down with no cached copy: an error in the news block only.
  const env2 = makeEnv();
  routes[NEWS_URL] = () => new Response('nope', { status: 503 });
  b = await (await get(env2, now)).json();
  assert.deepEqual(b.news, { error: "News can't load right now" });
  assert.deepEqual(b.birthdays, { birthdays: [] });
  assert.equal(b.weather.rides.length, 2);
  // Garbage instead of RSS is an error too.
  routes[NEWS_URL] = () => new Response('<html></html>');
  assert.deepEqual((await (await get(makeEnv(), now)).json()).news, { error: "News can't load right now" });
});
