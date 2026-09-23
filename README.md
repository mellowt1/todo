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

Run these in PowerShell from the `worker` folder. Each `secret put` reads the value straight from `secrets.local.txt`, so nothing is typed or shown.

```powershell
cd worker
$s = Get-Content ..\secrets.local.txt | Where-Object { $_ -match '^[A-Z_]+=' } | ConvertFrom-StringData
$s.TODO_CODE       | npx wrangler secret put TODO_CODE
$s.TODO_READ_TOKEN | npx wrangler secret put TODO_READ_TOKEN
$s.ADMIN_TOKEN     | npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

Then switch on GitHub Pages with GitHub Actions as the source and publish:

```powershell
gh api -X POST repos/mellowt1/todo/pages -f build_type=workflow
gh workflow run pages.yml -R mellowt1/todo
```

1. **KV**: one namespace, `paul-hub`, already created. Its id is in `worker/wrangler.toml` and reached from the Worker as `HUB_KV`.
2. **Worker**: `paul-hub`, from `worker/src/worker.js`. Three secrets: `TODO_CODE` (the only list code it serves), `TODO_READ_TOKEN` (Odysseus), `ADMIN_TOKEN` (backups).
3. **Site**: `.github/workflows/pages.yml` publishes the `app/` folder on every push to `main` that touches it. Until Pages is on, the workflow skips.

If the Worker lives somewhere other than `paul-hub.paul-o-a04.workers.dev`, add `&api=https://...` to the link once, or change the default near the top of `app/app.js`.

## Updating

* **App**: edit files in `app/`, bump `CACHE` in `app/sw.js` (`todo-v1` to `todo-v2`), commit, push. Phones pick it up on the next launch after that.
* **Worker**: `cd worker; npx wrangler deploy`.
* **New code**: generate one (16 characters, `a-z0-9`), put it in `secrets.local.txt`, run the `TODO_CODE` line above, open the new link. The old list stays in KV under the old code; copy it over with the admin export if needed.

## How the sync works

Every change is an operation on one task: `{ id, text, section, done, doneAt, pos, updatedAt }`. The app keeps them in a queue in `localStorage`, one per task, shows them at once, and sends the queue in one batch 1.2 seconds after the last change (or straight away when the app goes to the background). Offline, the queue just waits; the pill says how many changes are waiting.

The Worker merges per task: the newest `updatedAt` wins for that task only, so an offline edit on the phone and another on the desktop never overwrite each other. A delete leaves a tombstone (`id` plus `deletedAt`), so an older device cannot bring the task back. Tombstones older than 90 days are pruned on the next write.

The app polls `GET /api/todo/:code?since=<rev>` every ten seconds, only while it is visible. When nothing moved the answer is `{ unchanged: true }`, and a batch that changes nothing costs no KV write at all. One key per list and debounced batches keep a single person far below the KV free tier's 1,000 writes a day.

## API

| Route | Auth | What |
|---|---|---|
| `GET /api/todo/:code` | the code | `{ items, rev, updated }`, or `{ unchanged: true }` with `?since=<rev>` |
| `POST /api/todo/:code/ops` | the code | `{ ops: [{ op: "upsert" \| "delete", item }] }`, returns `{ rev, updated, items }` |
| `GET /api/todo/open` | `Bearer TODO_READ_TOKEN` | open tasks only, `[{ text, section }]`. No done history, no writes. The token works here and nowhere else. |
| `GET /api/admin/todo/export` | `Bearer ADMIN_TOKEN` | the whole stored document, tombstones included, for backups |

Input is whitelisted: text up to 500 characters, section one of `today`, `soon`, `someday`, ids 8 to 32 lowercase letters and digits, at most 200 ops per batch. Anything else is refused. CORS allows `https://mellowt1.github.io` and localhost only. Routes are namespaced by module (`/api/todo/...`), so `/api/morning` can be added later without touching the to-do.

Backup:

```powershell
curl.exe -s -H "Authorization: Bearer $($s.ADMIN_TOKEN)" https://paul-hub.paul-o-a04.workers.dev/api/admin/todo/export > todo-backup.json
```

## Local

```powershell
npm install
npm test                      # Worker unit tests: merge, tombstones, validation, tokens, CORS
cd worker; npx wrangler dev   # Worker on :8787 with the dev values in worker/.dev.vars
npm run serve                 # app on :8080, in a second window
npm run check                 # drives the app in Chromium and saves screenshots/
```

On localhost the app talks to `http://localhost:8787` and skips the service worker (add `&sw=1` to test it). `worker/.dev.vars` holds throwaway dev values, never the real ones, and is gitignored. Use PowerShell for wrangler on this PC; Git Bash wrangler crashes.

`npm run icons` redraws the icons in `app/icons/` from the design's check circle.

## Files

```
app/        the PWA: index.html, app.css, app.js, sw.js, manifest, icons
worker/     paul-hub: wrangler.toml, src/worker.js (routes), src/todo.js (merge), test/
scripts/    icons, local server, end to end check
design/     the Claude Design brief
SPEC.md     what was agreed
```
