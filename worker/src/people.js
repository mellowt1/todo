/* Last contact for a person on the Network map (src/network.js), shared with Waiting on (src/waiting.js)
 * so an answer to a "Sent a message" wait moves it without the two modules importing each other.
 * It only ever moves forward. The event carries the id and how, never the name. */

import { acceptEvent } from './hub.js';

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');

/* how: talked | task | answer. Returns true when Last contact moved. */
export async function touchPerson(env, id, date, how, source, now = Date.now()) {
  if (!id || !env.HUB_DB) return false;
  const at = new Date(now).toISOString();
  const r = await env.HUB_DB.prepare('UPDATE people SET last_contact = ?, updated_at = ? WHERE id = ? AND (last_contact IS NULL OR last_contact < ?)')
    .bind(date, at, id, date).run();
  if (!r.meta || r.meta.changes === 0) return false;
  await acceptEvent(env, {
    id: 'person-contacted-' + now + '-' + rand(), source, type: 'person.contacted', summary: 'Contact logged',
    payload: { id, how }, caused_by: null, hops: 0, at,
  }, { feed: false });
  return true;
}
