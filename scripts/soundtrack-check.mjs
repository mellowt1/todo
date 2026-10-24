// The Energy soundtrack, against a mocked Worker (no wrangler needed): Play under the dial opens the
// level's first playlist (a spotify: link) and tells the hub, a level without one offers to add one,
// the sheet reads a pasted link's name, adds, refuses an album in plain words and removes, and a
// running timer shows "Music for this?" until Not now or Play. With Spotify connected the same tap
// asks the hub to start it on this device (phone or computer), and the paste form offers his own
// playlists; Disconnect turns the row back into Connect. Every playlist and task is made up.
//   PORT=8121 npm run serve, then: APP_URL=http://localhost:8121/ npm run soundtrack-check
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL || 'http://localhost:8121/';
const CODE = 'abcdefgh23456789';
const OUT = new URL('../screenshots/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const file = (n) => fileURLToPath(new URL(n + '.png', OUT));
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.error('FAIL:', what); } else console.log('ok:', what); };

const P = { low: '37i9dQZF1DX4sWSpwq3LiO', rain: '3cEYpjA9oz9GiPac4AsH4n', desk: '1h0CEZCm6IbFTbxThn6Xcs' };
const TITLE = { [P.low]: 'Low tide', [P.rain]: 'Rain on the window', [P.desk]: 'Desk hours' };
const entry = (id, pid, title = TITLE[pid]) => ({ id, title, url: 'https://open.spotify.com/playlist/' + pid, uri: 'spotify:playlist:' + pid });

function world() {
  const now = Date.now();
  let k = 0;
  const t = (id, text, section, extra = {}) => ({ id, text, section, done: false, doneAt: null, updatedAt: now - 1000 * ++k, pos: now - 1000 * k, ...extra });
  const items = Object.fromEntries([
    t('todaylucho01', 'Ticket for Lucho November', 'today', { energy: 'drained' }),
    t('todaylamp001', 'Return the lamp', 'today', { energy: 'normal' }),
  ].map((i) => [i.id, i]));
  const w = {
    items, posts: [], running: null, offer: null, spotify: { configured: true, connected: true },
    mine: [{ pid: '5ABHKGoOzxkaa28ttQV9sE', title: 'Full send', count: 40, url: 'https://open.spotify.com/playlist/5ABHKGoOzxkaa28ttQV9sE', uri: 'spotify:playlist:5ABHKGoOzxkaa28ttQV9sE' }],
    lists: { wired: [], normal: [], drained: [entry('lowtide001', P.low), entry('rainwind01', P.rain)] },
    state: { level: 'drained', setAt: new Date().toISOString(), until: new Date(Date.now() + 3 * 3600e3).toISOString(), source: 'todo' },
    play() { const e = w.state.level && w.lists[w.state.level][0]; return e ? { level: w.state.level, title: e.title, url: e.url, uri: e.uri } : null; },
    route(req) {
      const p = new URL(req.url()).pathname;
      const body = req.method() === 'POST' ? req.postDataJSON() : null;
      if (p === `/api/todo/${CODE}`) return { items: Object.values(items), rev: 1, updated: new Date().toISOString() };
      if (p === `/api/todo/${CODE}/ops`) return { items: Object.values(items), rev: 2, updated: new Date().toISOString(), rejected: [] };
      if (p === `/api/energy/${CODE}`) {
        if (body) w.state = body.level ? { level: body.level, setAt: new Date().toISOString(), until: new Date(Date.now() + 4 * 3600e3).toISOString(), source: 'todo' } : { level: null, setAt: null, until: null, source: null };
        return { ...w.state, pick: null, play: w.play() };
      }
      if (p === `/api/dread/${CODE}`) return { running: w.running, stopped: null, offer: w.offer };
      if (p === `/api/spotify/${CODE}`) return w.spotify;
      if (p === `/api/spotify/${CODE}/playlists`) return { playlists: w.mine };
      if (p === `/api/spotify/${CODE}/play`) { w.posts.push({ sub: 'spotify-play', ...body }); return { ok: true, device: 'iPhone' }; }
      if (p === `/api/spotify/${CODE}/disconnect`) { w.posts.push({ sub: 'disconnect' }); w.spotify = { configured: true, connected: false }; return { connected: false }; }
      if (p.startsWith(`/api/soundtrack/${CODE}`)) {
        const sub = p.slice(`/api/soundtrack/${CODE}`.length).replace('/', '');
        if (!sub) return { lists: w.lists, max: 3 };
        w.posts.push({ sub, ...body });
        if (sub === 'played' || sub === 'notnow') return { ok: true };
        const pid = (String(body.url || '').match(/playlist\/([A-Za-z0-9]{22})/) || [])[1];
        if (sub === 'peek') return pid ? { pid, title: TITLE[pid] || null, url: 'https://open.spotify.com/playlist/' + pid, uri: 'spotify:playlist:' + pid } : { status: 400, error: 'That is an album, not a playlist.' };
        if (sub === 'add') { const e = entry('added' + (w.posts.length + 10000), pid, body.title || TITLE[pid]); w.lists[body.level].push(e); return { lists: w.lists, added: e }; }
        if (sub === 'remove') { w.lists[body.level] = w.lists[body.level].filter((e) => e.id !== body.id); return { lists: w.lists }; }
      }
      if (p === `/api/tidy/${CODE}`) return { text: 'x', changed: false, kind: 'task' };
      if (p === `/api/intake/${CODE}/cards`) return { tasks: [] };
      if (p === `/api/intake/${CODE}`) return { items: [] };
      if (p.startsWith('/api/hiscores/')) return { skills: [] };
      if (p === `/api/waiting/${CODE}`) return { items: [], open: 0, due: 0, names: [] };
      if (p === `/api/archive/${CODE}`) return { due: null };
      return null;
    },
  };
  return w;
}

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [['soundtrack-phone', { width: 390, height: 844 }, 'light'], ['soundtrack-desk', { width: 1280, height: 900 }, 'dark']]) {
  const w = world();
  const phone = viewport.width < 700;
  const ua = phone ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' : undefined;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: scheme, userAgent: ua });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', async (r) => {
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
    const out = w.route(r.request());
    if (out && out.status) return r.fulfill({ status: out.status, json: { error: out.error }, headers: h });
    return out ? r.fulfill({ json: out, headers: h }) : r.fulfill({ status: 404, json: { error: 'not found' }, headers: h });
  });
  await page.goto(APP + '?c=' + CODE + '&api=' + encodeURIComponent('http://localhost:8799'));
  // A spotify: link would leave the page: the check keeps it here and only watches the hub.
  await page.evaluate(() => window.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href^="spotify:"]'); if (a) e.preventDefault(); }, true));
  await page.waitForSelector('.row[data-id="todaylucho01"]');
  await page.waitForTimeout(2200); // the playlists load after the list
  const tap = (sel) => page.locator(sel).first().click();
  const last = (sub) => w.posts.filter((d) => d.sub === sub).at(-1);
  const poll = async (n = 3) => { for (let i = 0; i < n; i++) { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(300); } };

  // Drained is on: Play opens Low tide.
  check(await page.isVisible('#playRow'), name + ': Play shows under the dial');
  check((await page.textContent('#playTitle')) === 'Play Low tide', name + ': it plays the first Drained playlist');
  check((await page.getAttribute('#playLink', 'href')) === 'spotify:playlist:' + P.low, name + ': a spotify: link, so the app opens');
  check((await page.textContent('#playMeta')) === 'Your Drained playlist · plays in Spotify', name + ': says which level, and that Spotify plays it');
  await page.screenshot({ path: file(name + '-play') });
  await tap('#playLink');
  await page.waitForTimeout(300);
  const played = last('played');
  check(played && played.level === 'drained' && played.from === 'dial' && played.source === 'todo' && !played.startedAt, name + ': the hub heard Play from the dial ' + JSON.stringify(played));
  const sp1 = last('spotify-play');
  check(sp1 && sp1.uri === 'spotify:playlist:' + P.low && sp1.kind === (phone ? 'phone' : 'computer'), name + ': the hub is asked to start it on this ' + (phone ? 'phone' : 'computer') + ' ' + JSON.stringify(sp1));
  check((await page.getAttribute('#playLink', 'href')) === 'spotify:playlist:' + P.low, name + ': the link still opens Spotify');

  // Normal has none yet: a quiet way in, and the sheet opens at the paste form.
  await tap('#energySeg [data-level="normal"]');
  await page.waitForTimeout(400);
  check(!(await page.isVisible('#playRow')) && (await page.textContent('#playSetup')) === 'Music for Normal? Add a playlist', name + ': a level without music offers to add some');
  await tap('#playSetup');
  await page.waitForSelector('#sound:not([hidden]) #soundUrl');
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'soundUrl'), name + ': the link field has the focus');
  await page.fill('#soundUrl', 'https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC');
  await page.dispatchEvent('#soundUrl', 'change');
  await page.waitForSelector('#soundBody .sound-err');
  check((await page.textContent('#soundBody .sound-err')) === 'That is an album, not a playlist.', name + ': an album is refused in plain words');
  await page.fill('#soundUrl', 'https://open.spotify.com/playlist/' + P.desk + '?si=abc');
  await page.waitForFunction(() => document.getElementById('soundName') && document.getElementById('soundName').value === 'Desk hours');
  check(true, name + ': the name is read from Spotify');
  await page.screenshot({ path: file(name + '-paste') });
  await tap('#soundBody [data-act="save"]');
  await page.waitForFunction(() => !document.getElementById('soundUrl'));
  const added = last('add');
  check(added && added.level === 'normal' && added.title === 'Desk hours' && added.url.includes(P.desk), name + ': the hub heard add ' + JSON.stringify(added));
  const normalRows = await page.locator('#soundBody .sound-list').nth(0).locator('.sound-name').allTextContents();
  check(JSON.stringify(normalRows) === '["Desk hours"]', name + ': Normal lists Desk hours ' + JSON.stringify(normalRows));

  // Remove the second Drained one; the first still plays.
  await tap('#soundBody [data-act="remove"][data-id="rainwind01"]');
  await page.waitForTimeout(300);
  check(last('remove') && last('remove').id === 'rainwind01' && last('remove').level === 'drained', name + ': the hub heard remove');
  check(!(await page.locator('#soundBody .sound-name', { hasText: 'Rain on the window' }).count()), name + ': Rain on the window is gone');
  check((await page.textContent('#soundBody .sp-row .sound-name')) === 'Spotify is connected', name + ': the sheet says Spotify is connected');
  // His own playlists in the paste form: pick one, add it.
  await tap('#soundBody [data-act="add"][data-level="wired"]');
  await page.waitForSelector('#soundBody .sp-list button');
  await tap('#soundBody .sp-list button');
  check((await page.inputValue('#soundUrl')).includes('5ABHKGoOzxkaa28ttQV9sE') && (await page.inputValue('#soundName')) === 'Full send', name + ': picking one of his fills the link and name');
  await tap('#soundBody [data-act="save"]');
  await page.waitForFunction(() => !document.getElementById('soundUrl'));
  check(last('add') && last('add').level === 'wired' && last('add').url.includes('5ABHKGoOzxkaa28ttQV9sE') && last('add').title === 'Full send', name + ': the picked one is added to Wired');
  // Disconnect: the row turns into Connect, which goes to the hub's login.
  await tap('#soundBody [data-act="disconnect"]');
  await page.waitForSelector('#soundBody .sp-connect');
  check((await page.getAttribute('#soundBody .sp-connect', 'href')).endsWith('/api/spotify/' + CODE + '/login'), name + ': Disconnect turns the row into Connect');
  w.spotify = { configured: true, connected: true };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // back from connecting
  await page.waitForSelector('#soundBody .sp-row [data-act="disconnect"]');
  check(true, name + ': coming back to the app reads the connection again');
  await page.screenshot({ path: file(name + '-sheet') });
  if (phone) await tap('#soundClose'); else await page.keyboard.press('Escape');
  await page.waitForSelector('#sound', { state: 'hidden' });
  check((await page.textContent('#playTitle')) === 'Play Desk hours', name + ': Normal now plays Desk hours');

  // A timer runs and the hub offers music: Not now ends it.
  const startedAt = new Date(Date.now() - 60e3).toISOString();
  w.running = { task: 'todaylamp001', name: 'Return the lamp', startedAt, dread: 3, source: 'todo', mins: 1, level: 'normal' };
  w.offer = { level: 'normal', title: 'Desk hours', url: 'https://open.spotify.com/playlist/' + P.desk, uri: 'spotify:playlist:' + P.desk, startedAt };
  await poll();
  await page.waitForSelector('#runOffer:not([hidden])');
  check((await page.textContent('#runOffer .offer-words')).trim() === 'Music for this? Desk hours', name + ': Music for this? under the timer');
  check(await page.evaluate(() => document.getElementById('running').classList.contains('has-offer')), name + ': the pill and the offer are one block');
  await page.screenshot({ path: file(name + '-offer') });
  await tap('#offerNot');
  await page.waitForTimeout(200);
  check(!(await page.isVisible('#runOffer')) && last('notnow') && last('notnow').startedAt === startedAt, name + ': Not now hides it and tells the hub');
  w.offer = null;

  // A new timer, a new offer: Play from it.
  const s2 = new Date().toISOString();
  w.running = { ...w.running, startedAt: s2 };
  w.offer = { ...w.offer || {}, level: 'normal', title: 'Desk hours', url: 'https://open.spotify.com/playlist/' + P.desk, uri: 'spotify:playlist:' + P.desk, startedAt: s2 };
  await poll();
  await page.waitForSelector('#runOffer:not([hidden])');
  await tap('#offerLink');
  await page.waitForTimeout(200);
  check(last('spotify-play') && last('spotify-play').uri === 'spotify:playlist:' + P.desk, name + ': Play from the offer starts it too');
  const fromOffer = last('played');
  check(fromOffer && fromOffer.from === 'offer' && fromOffer.startedAt === s2 && fromOffer.level === 'normal', name + ': Play from the offer ' + JSON.stringify(fromOffer));
  check(!(await page.isVisible('#runOffer')), name + ': the offer goes after Play');

  // No level: no Play and nothing to add.
  await tap('#energySeg [data-level="normal"]'); // the level that is on: off
  await page.waitForTimeout(300);
  check(!(await page.isVisible('#playRow')) && !(await page.isVisible('#playSetup')), name + ': no level, no Play');
  check(!errors.length, name + ': no page errors ' + JSON.stringify(errors));
  await ctx.close();
}
await browser.close();
if (failed) { console.error('soundtrack-check: FAILED'); process.exit(1); }
console.log('soundtrack-check: all good');
