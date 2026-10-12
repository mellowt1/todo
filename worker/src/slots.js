/* Others slots: the weekly time blocks Paul keeps for tasks he does for other people.
 *
 * Hub config others_slots, Amsterdam time, one or more blocks:  "Sat 10:00-12:00; Wed 19:00-20:00"
 * Starts empty. Pure functions only, so dinner.js (the config check) and morning.js can share them. */

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ONE = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/i;

/* "Sat 10:00-12:00; wed 19:00 - 20:00" -> [{ day: 6, start: 600, end: 720 }, ...], or null if any part is bad. */
export function parseSlots(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const out = [];
  for (const part of text.split(/[;,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const m = ONE.exec(part);
    if (!m) return null;
    const start = +m[2] * 60 + +m[3];
    const end = +m[4] * 60 + +m[5];
    if (end <= start) return null; // one day only, never across midnight
    out.push({ day: DAYS.findIndex((d) => d.toLowerCase() === m[1].slice(0, 3).toLowerCase()), start, end });
  }
  return out.length && out.length <= 14 ? out : null;
}

const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

export function formatSlots(slots) {
  return slots.map((s) => `${DAYS[s.day]} ${hhmm(s.start)}-${hhmm(s.end)}`).join('; ');
}

/* Where now stands: inside a slot (and until when), and when the next one starts.
 * l is { weekday, minutes } in Amsterdam. */
export function slotState(slots, l) {
  if (!slots || !slots.length) return { inSlot: null, next: null };
  const cur = slots.find((s) => s.day === l.weekday && l.minutes >= s.start && l.minutes < s.end);
  let next = null;
  for (let ahead = 0; ahead <= 7 && !next; ahead++) {
    const day = (l.weekday + ahead) % 7;
    const cands = slots.filter((s) => s.day === day && (ahead > 0 || s.start > l.minutes)).sort((a, b) => a.start - b.start);
    if (cands.length) {
      const s = cands[0];
      next = { day: DAYS[day], start: hhmm(s.start), label: (ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : DAYS[day]) + ' ' + hhmm(s.start) };
    }
  }
  return { inSlot: cur ? { day: DAYS[cur.day], start: hhmm(cur.start), end: hhmm(cur.end) } : null, next };
}
