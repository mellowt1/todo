# To-do

Paul's to-do list. Three sections, Today, Soon and Someday, and a Done history kept forever. Capture in one tap, swipe right for done, swipe left to move. Installable on iPhone, works offline, syncs when the signal comes back.

**No tasks live in this repo.** The app ships empty and loads the list from the `paul-hub` Worker using the code in the link, so the repo can be public without showing anyone's list.

## The link

```
https://mellowt1.github.io/todo/?c=<code>
```

`c` is the list code: exactly 16 lowercase letters and digits. It is remembered after the first visit and put back into the address, so Add to Home Screen keeps it. Without a code the app says so and shows nothing else.

The code, the Odysseus read token and the admin token live in `secrets.local.txt` next to this README. That file is gitignored. Keep a copy somewhere safe outside the repo.

## Setting it up (once)

Run these from the `worker` folder. Deploy first, so the Worker exists, then upload the three secrets in one go from a temporary JSON file that is deleted straight after, so nothing is typed or shown. Do not pipe values into `npx wrangler secret put` on Windows: the npx shim does not pass stdin through and the secret ends up empty.

```bash
cd worker
npx wrangler deploy
node -e 'const fs=require("fs");const o={};for(const l of fs.readFileSync("../secrets.local.txt","utf8").split(/\r?\n/)){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)o[m[1]]=m[2];}fs.writeFileSync("../.secrets.tmp.json",JSON.stringify(o))'
npx wrangler secret bulk ../.secrets.tmp.json
rm ../.secrets.tmp.json
```

Then switch on GitHub Pages with GitHub Actions as the source and publish:

```powershell
gh api -X POST repos/mellowt1/todo/pages -f build_type=workflow
gh workflow run pages.yml -R mellowt1/todo
```

1. **Worker**: `paul-hub`, from `worker/src/worker.js`. Three secrets for the to-do: `TODO_CODE` (the only list code it serves), `TODO_READ_TOKEN` (Odysseus), `ADMIN_TOKEN` (backups). Three more for the Morning Screen, see below.
2. **Storage**: the list lives in a SQLite-backed Durable Object (`TodoList`, `worker/src/list.js`), one per code, created by the first deploy. It handles one write at a time, so two devices can never overwrite each other's batch. SQLite Durable Objects are on the Workers Free plan. The KV namespace `paul-hub` (`HUB_KV`) belongs to the Morning Screen and is not used by the to-do.
3. **Site**: `.github/workflows/pages.yml` publishes the `app/` folder on every push to `main` that touches it. Until Pages is on, the workflow skips.

If the Worker lives somewhere other than `paul-hub.paul-o-a04.workers.dev`, add `&api=https://...` to the link once, or change the default near the top of `app/app.js`.

## Updating

* **App**: edit files in `app/`, commit, push. The Pages workflow names the offline cache after the commit, so phones pick up the new version on the next launch. Nothing to bump by hand.
* **Worker**: `cd worker; npx wrangler deploy`.
* **New code**: generate one (16 characters, `a-z0-9`), put it in `secrets.local.txt`, run the `TODO_CODE` line above, open the new link. The old list stays in its own Durable Object under the old code; copy it over with the admin export if needed.

## Morning Screen (`worker/src/morning.js`)

The Morning Screen (repo `mellowt1/morning`) reads everything from one route, with the same code as the to-do. The to-do itself is only read, never changed.

| Route | Auth | What |
|---|---|---|
| `GET /api/morning/:code` | the code | `{ now, todos, calendar, fixed, weather, arsenal, bins }`. Each block loads on its own; one that fails is `{ error: "..." }` and the rest still arrive. |
| `POST /api/morning/calendar` | `Bearer CALENDAR_PUSH_TOKEN` | Odysseus sends `{ sent, events: [{ title, start, end, allDay, location }] }` every 15 minutes. Timed events carry an offset, all day events are `YYYY-MM-DD` with the day after as end. At most 500 events, titles up to 200 characters, body up to 200 KB. Answers `{ ok: true, count }`. |

Where each block comes from:

* **todos**: open items in Today, from the list's Durable Object.
* **calendar**: the last Odysseus push (KV `morning:calendar`), today plus six days. `stale` is true when the last push is over an hour old.
* **fixed**: the `FIXED_EVENTS` secret, turned into real dates for the same seven days, plus countdowns. Missing or broken: empty lists, no error.
* **weather**: Open-Meteo, no key, The Hague. The 08:00 and 17:30 rides on the next ride day (weekdays; after 17:30 and at weekends, the next weekday), the next two hours in 15 minute steps, sunrise and sunset, and one verdict line. Cached 15 minutes.
* **arsenal**: ESPN's open JSON, all competitions (`site.web.api.espn.com/apis/site/v2/sports/soccer/all/teams/359/schedule`, plus `?fixture=true` for what is coming; `site.api.espn.com` is the fallback, as its bot filter refuses some callers). Next fixture and last result. Cached one hour. Unofficial: if ESPN changes it, the block says it can't load.
* **bins**: Den Haag's huisvuilkalender (`huisvuilkalender.denhaag.nl/rest/adressen/...`, no key) for `BIN_ADDRESS`. The next collection days with GFT, Restafval, Papier, PMD. Cached 12 hours. No address set: `null`.

If a source fails, the last good copy is served for a while (weather 3 hours, Arsenal a day, bins a week), then the block shows its error. Everything is fetched only when the page asks, so a day costs a few dozen KV writes, far inside the free plan.

**Headwind and tailwind.** The Worker does not know which way the ride to work goes, so by default it only says the wind's strength and direction. To get "headwind home", set `WORK_BEARING` near the top of `worker/src/morning.js` to the direction of the ride to work in degrees (0 north, 90 east, 45 north east) and deploy.

**The three secrets.** Add them to `secrets.local.txt` and upload them with the same `wrangler secret bulk` lines as above (it only adds or replaces the names in the file):

```
CALENDAR_PUSH_TOKEN=<long random string, also in Odysseus's .env.production>
FIXED_EVENTS={"events":[{"title":"Evening class","date":"2026-09-07","start":"20:00","end":"22:00","repeat":"weekly","until":"2026-10-26"}],"countdowns":[{"what":"the trip","date":"2026-12-01"}]}
BIN_ADDRESS=1234AB 5
```

`FIXED_EVENTS` is one line of JSON. An event without `start` is all day; `repeat` can only be `weekly`; `until` is the last date it may fall on. `BIN_ADDRESS` is postcode, space, house number (a letter or addition may follow). The values above are examples; the real ones live only in the secrets file and in Cloudflare. Piping a value into `npx wrangler secret put` stores an empty secret on Windows, so always use the temp JSON file.

## How the sync works

Every change is an operation on one task: `{ id, text, section, done, doneAt, pos, updatedAt }`. The app keeps them in a queue in `localStorage`, one per task, shows them at once, and sends the queue in batches 1.2 seconds after the last change (or straight away when the app goes to the background). A batch holds at most 200 ops and stays well under the Worker's body limit. Offline, the queue just waits; the pill says how many changes are waiting. The app cleans text exactly as the Worker does; if the Worker still refuses an op, it names it, that op alone is dropped and the sync banner shows.

The Durable Object merges per task: the newest `updatedAt` wins for that task only, so an offline edit on the phone and another on the desktop never overwrite each other. Each task is its own row, and a batch is read, merged and written with no other request in between. A delete leaves a tombstone (`id` plus `deletedAt`), so an older device cannot bring the task back. Tombstones older than 90 days are pruned, at most once a day, on a write.

The app polls `GET /api/todo/:code?since=<rev>` every ten seconds, only while it is visible. When nothing moved the answer is `{ unchanged: true }` and costs one row read; a batch that changes nothing writes nothing. Debounced batches keep a single person far below the free plan's Durable Object limits (100,000 rows written and 5 million read a day).

## API

| Route | Auth | What |
|---|---|---|
| `GET /api/todo/:code` | the code | `{ items, rev, updated }`, or `{ unchanged: true }` with `?since=<rev>` |
| `POST /api/todo/:code/ops` | the code | `{ ops: [{ op: "upsert" \| "delete", item }] }`, returns `{ rev, updated, items, rejected }`; `rejected` lists the indexes of ops that failed validation, the rest still land |
| `GET /api/todo/open` | `Bearer TODO_READ_TOKEN` | open tasks only, `[{ text, section }]`. No done history, no writes. The token works here and nowhere else. |
| `GET /api/admin/todo/export` | `Bearer ADMIN_TOKEN` | the whole stored document, tombstones included, for backups |
| `/api/morning/...` | | see Morning Screen above |

Input is whitelisted: text up to 500 characters, section one of `today`, `soon`, `someday`, ids 8 to 32 lowercase letters and digits, at most 200 ops per batch. An op that breaks these rules is skipped and reported; a malformed batch is refused. CORS allows `https://mellowt1.github.io` and localhost only. Routes are namespaced by module (`/api/todo/...`, `/api/morning/...`), so one app never touches another's.

Backup:

```powershell
curl.exe -s -H "Authorization: Bearer $($s.ADMIN_TOKEN)" https://paul-hub.paul-o-a04.workers.dev/api/admin/todo/export > todo-backup.json
```

## Local

```powershell
npm install
npm test                      # Worker unit tests: merge, tombstones, validation, tokens, CORS, morning blocks
cd worker; npx wrangler dev --persist-to C:\wd   # Worker on :8787, dev values from worker/.dev.vars
npm run serve                 # app on :8080, in a second window
npm run check                 # drives the app in Chromium and saves screenshots/
```

On localhost the app talks to `http://localhost:8787` and skips the service worker (add `&sw=1` to test it). `worker/.dev.vars` holds throwaway dev values, never the real ones, and is gitignored. Use PowerShell for wrangler on this PC; Git Bash wrangler crashes. Keep `--persist-to` short: local storage under a long Windows path fails.

`npm run icons` redraws the icons in `app/icons/` from the design's check circle.

## Files

```
app/        the PWA: index.html, app.css, app.js, sw.js, manifest, icons
worker/     paul-hub: wrangler.toml, src/worker.js (routes), src/list.js (the list's Durable Object), src/todo.js (merge, validation), src/morning.js (Morning Screen), test/
scripts/    icons, local server, end to end check
design/     the Claude Design brief
SPEC.md     what was agreed
```
