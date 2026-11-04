// Music, against a mocked Worker (no wrangler needed): the note at the top turns green when the level
// that is on has a playlist and opens the Music sheet: three levels, their playlists (tap one to play
// it: a spotify: link, the hub told, Spotify started on this device), Add link (the name read from
// Spotify, an album refused in plain words, or one of his own picked), a small x to remove, and Make
// new playlist (the words go to the hub, Making shows, the new one comes first marked as made). A
// login from before the make scopes asks to connect again; Disconnect turns into Connect. A running
// timer shows "Music for this?" until Not now or Play. Every playlist and task is made up.
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
    items, posts: [], running: null, offer: null, spotify: { configured: true, connected: true, canMake: true },
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
      if (p === `/api/spotify/${CODE}/make`) {
        w.posts.push({ sub: 'make', ...body });
        const e = { ...entry('madenew001', '7aBcDeFgHiJkLmNoPqRsTu', 'Drained · ' + body.words + ' · 4 Nov'), made: true };
        w.lists[body.level] = [e, ...w.lists[body.level]].slice(0, 3);
        return { title: e.title, songs: 24, fresh: 8, url: e.url, uri: e.uri, lists: w.lists, dropped: null };
      }
      if (p === `/api/spotify/${CODE}/disconnect`) { w.posts.push({ sub: 'disconnect' }); w.spotify = { configured: true, connected: false, canMake: false }; return { connected: false }; }
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
    if (r.request().url().endsWith('/make')) await new Promise((ok) => setTimeout(ok, 900)); // Claude takes a while
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
  const openMusic = async () => { await tap('#musicBtn'); await page.waitForSelector('#sound:not([hidden]) .mu-level'); await page.waitForTimeout(450); };
  const closeMusic = async () => { if (phone) await tap('#soundClose'); else await page.keyboard.press('Escape'); await page.waitForSelector('#sound', { state: 'hidden' }); };
  const rows = (level) => page.locator(`#soundBody .mu-level[aria-label="${level}"] .mu-name`).allTextContents();

  // Today: no Play card any more, the note at the top is green (Drained has music).
  check(!(await page.locator('#playRow').count()), name + ': no Play card under the dial');
  check(await page.isVisible('#musicBtn'), name + ': the note is at the top');
  check(await page.evaluate(() => document.getElementById('musicBtn').classList.contains('on')), name + ': green, Drained has music');
  await page.screenshot({ path: file(name + '-today') });

  // The sheet: three levels, Drained is Now, no intro text.
  await openMusic();
  const heads = await page.locator('#soundBody .mu-head').allTextContents();
  check(JSON.stringify(heads) === '["Wired","Normal","DrainedNow"]', name + ': three levels, Drained marked Now ' + JSON.stringify(heads));
  check(!(await page.locator('#sound .sort-intro').count()) && (await page.textContent('#soundHead')) === 'Music', name + ': headed Music, no intro text');
  check(!(await page.locator('#soundBody .mu-connect').count()), name + ': connected: no Spotify row');
  check(JSON.stringify(await rows('Drained')) === '["Low tide","Rain on the window"]', name + ': Drained lists its two');
  await page.screenshot({ path: file(name + '-sheet') });

  // Tap a playlist: it plays and the sheet steps aside.
  await tap('#soundBody .mu-play[href="spotify:playlist:' + P.rain + '"]');
  await page.waitForSelector('#sound', { state: 'hidden' });
  const played = last('played');
  check(played && played.level === 'drained' && played.from === 'dial' && played.source === 'todo', name + ': the hub heard Play ' + JSON.stringify(played));
  const sp1 = last('spotify-play');
  check(sp1 && sp1.uri === 'spotify:playlist:' + P.rain && sp1.kind === (phone ? 'phone' : 'computer'), name + ': the hub starts it on this ' + (phone ? 'phone' : 'computer') + ' ' + JSON.stringify(sp1));

  // Normal has none: the note is grey; Add link reads the name, refuses an album.
  await tap('#energySeg [data-level="normal"]');
  await page.waitForTimeout(400);
  check(!(await page.evaluate(() => document.getElementById('musicBtn').classList.contains('on'))), name + ': Normal has no music: the note is grey');
  await openMusic();
  await tap('#soundBody [data-act="add"][data-level="normal"]');
  await page.waitForSelector('#soundUrl');
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'soundUrl'), name + ': the link field has the focus');
  await page.fill('#soundUrl', 'https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC');
  await page.dispatchEvent('#soundUrl', 'change');
  await page.waitForSelector('#soundBody .mu-err');
  check((await page.textContent('#soundBody .mu-err')) === 'That is an album, not a playlist.', name + ': an album is refused in plain words');
  await page.fill('#soundUrl', 'https://open.spotify.com/playlist/' + P.desk + '?si=abc');
  await page.waitForFunction(() => (document.querySelector('#soundBody .mu-found') || {}).textContent === 'Desk hours');
  check(!(await page.locator('#soundName').count()), name + ': the name is read from Spotify, no name field');
  await page.screenshot({ path: file(name + '-paste') });
  await tap('#soundBody [data-act="save"]');
  await page.waitForFunction(() => !document.getElementById('soundUrl'));
  const added = last('add');
  check(added && added.level === 'normal' && added.title === 'Desk hours' && added.url.includes(P.desk), name + ': the hub heard add ' + JSON.stringify(added));
  check(JSON.stringify(await rows('Normal')) === '["Desk hours"]', name + ': Normal lists Desk hours');
  check(await page.evaluate(() => !!document.querySelector('#soundBody .mu-row.fresh')), name + ': the new one slides in');

  // Remove: the row folds away.
  await tap('#soundBody [data-act="remove"][data-id="rainwind01"]');
  await page.waitForFunction(() => !document.querySelector('#soundBody .mu-row[data-id="rainwind01"]'));
  check(last('remove') && last('remove').id === 'rainwind01' && last('remove').level === 'drained', name + ': the hub heard remove');

  // His own playlists in the link form: pick one, add it to Wired.
  await tap('#soundBody [data-act="add"][data-level="wired"]');
  await page.waitForSelector('#soundBody .sp-list button');
  await tap('#soundBody .sp-list button');
  check((await page.inputValue('#soundUrl')).includes('5ABHKGoOzxkaa28ttQV9sE'), name + ': picking one of his fills the link');
  await tap('#soundBody [data-act="save"]');
  await page.waitForFunction(() => !document.getElementById('soundUrl'));
  check(last('add') && last('add').level === 'wired' && last('add').title === 'Full send', name + ': the picked one is added to Wired');

  // Disconnect: Connect; connected before the make scopes: Connect again, no Make chips.
  await tap('#soundBody [data-act="disconnect"]');
  await page.waitForSelector('#soundBody .mu-connect');
  check((await page.textContent('#soundBody .mu-connect span')) === 'Connect Spotify to play here' && (await page.getAttribute('#soundBody .sp-connect', 'href')).endsWith('/api/spotify/' + CODE + '/login'), name + ': Disconnect turns into Connect');
  w.spotify = { configured: true, connected: true, canMake: false };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // back from connecting
  await page.waitForFunction(() => (document.querySelector('#soundBody .mu-connect span') || {}).textContent === 'Connect Spotify again to make playlists');
  check(!(await page.locator('#soundBody [data-act="make"]').count()), name + ': an old login: Connect again and no Make');
  w.spotify = { configured: true, connected: true, canMake: true };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => !document.querySelector('#soundBody .mu-connect'));
  check(true, name + ': coming back reads the connection again');

  // Make new playlist for Drained, with a few words.
  await tap('#soundBody [data-act="make"][data-level="drained"]');
  await page.waitForSelector('#soundWords');
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'soundWords'), name + ': the words field has the focus');
  await page.fill('#soundWords', 'rainy Sunday');
  await page.screenshot({ path: file(name + '-make') });
  await tap('#soundBody [data-act="make-go"]');
  await page.waitForSelector('#soundBody .mu-making');
  check((await page.textContent('#soundBody .mu-making')).trim() === 'Making your Drained playlist', name + ': Making shows');
  await page.waitForTimeout(250);
  await page.screenshot({ path: file(name + '-making') });
  await page.waitForFunction(() => !document.querySelector('#soundBody .mu-making'));
  const made = last('make');
  check(made && made.level === 'drained' && made.words === 'rainy Sunday', name + ': the hub heard make ' + JSON.stringify(made));
  check(JSON.stringify(await rows('Drained')) === '["Drained · rainy Sunday · 4 Nov","Low tide"]', name + ': the new one comes first');
  check(await page.evaluate(() => !!document.querySelector('#soundBody .mu-row.fresh[data-id="madenew001"] .mu-made')), name + ': it slides in, marked as made');
  check((await page.textContent('#say')) === 'Made Drained · rainy Sunday · 4 Nov: 24 songs, 8 new to you', name + ': it says what was made');
  await page.waitForTimeout(700);
  await page.screenshot({ path: file(name + '-made') });
  await closeMusic();

  // A timer runs and the hub offers music: Not now ends it.
  const startedAt = new Date(Date.now() - 60e3).toISOString();
  w.running = { task: 'todaylamp001', name: 'Return the lamp', startedAt, dread: 3, source: 'todo', mins: 1, level: 'normal' };
  w.offer = { level: 'normal', title: 'Desk hours', url: 'https://open.spotify.com/playlist/' + P.desk, uri: 'spotify:playlist:' + P.desk, startedAt };
  await poll();
  await page.waitForSelector('#runOffer:not([hidden])');
  check((await page.textContent('#runOffer .offer-words')).trim() === 'Desk hours', name + ': the playlist under the timer');
  await page.screenshot({ path: file(name + '-offer') });
  await tap('#offerNot');
  await page.waitForTimeout(200);
  check(!(await page.isVisible('#runOffer')) && last('notnow') && last('notnow').startedAt === startedAt, name + ': Not now hides it and tells the hub');
  w.offer = null;

  // A new timer, a new offer: Play from it.
  const s2 = new Date().toISOString();
  w.running = { ...w.running, startedAt: s2 };
  w.offer = { level: 'normal', title: 'Desk hours', url: 'https://open.spotify.com/playlist/' + P.desk, uri: 'spotify:playlist:' + P.desk, startedAt: s2 };
  await poll();
  await page.waitForSelector('#runOffer:not([hidden])');
  await tap('#offerLink');
  await page.waitForTimeout(200);
  check(last('spotify-play') && last('spotify-play').uri === 'spotify:playlist:' + P.desk, name + ': Play from the offer starts it too');
  const fromOffer = last('played');
  check(fromOffer && fromOffer.from === 'offer' && fromOffer.startedAt === s2 && fromOffer.level === 'normal', name + ': Play from the offer ' + JSON.stringify(fromOffer));
  check(!(await page.isVisible('#runOffer')), name + ': the offer goes after Play');

  // No level: the note stays, grey.
  await tap('#energySeg [data-level="normal"]'); // the level that is on: off
  await page.waitForTimeout(300);
  check(await page.isVisible('#musicBtn') && !(await page.evaluate(() => document.getElementById('musicBtn').classList.contains('on'))), name + ': no level: the note is grey');
  check(!errors.length, name + ': no page errors ' + JSON.stringify(errors));
  await ctx.close();
}
await browser.close();
if (failed) { console.error('soundtrack-check: FAILED'); process.exit(1); }
console.log('soundtrack-check: all good');
