/* Cut account numbers and long reference numbers down to their last four characters.
 *
 * Used on every text that leaves the letter card: task text in the list (it syncs to every
 * device), Morning's to-dos and Read for you, and the intake answers the To-do app keeps.
 * The full values live only on the card (src/letters.js).
 *
 *   "Pay to NL86 INGB 0002 4455 88, kenmerk 5123 4567 8901 2340"
 *   -> "Pay to IBAN ··5588, kenmerk ··2340"
 *
 * Dates (2026-11-14), amounts (1.247,00) and short numbers stay as they are. */

const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const LONG = /\b\d(?:[ .]?\d){7,}\b/g; // eight digits or more, spaces or dots between

const last4 = (s) => s.replace(/[^A-Za-z0-9]/g, '').slice(-4);

export function maskSecrets(s) {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(IBAN, (m) => 'IBAN ··' + last4(m)).replace(LONG, (m) => '··' + last4(m));
}
