# Simple to-do: SPEC

Status: approved by Paul on 23 Sept 2026. No code, no repo yet.

## Purpose
Replace the iOS Notes to-do page with the simplest possible list: capture in one tap, done with a swipe, three sections. It opens instantly, works offline and syncs when back online. Its Worker becomes shared infrastructure for the Morning Screen.

## User and devices
* Only Paul.
* iPhone: installed PWA from a home screen icon.
* Desktop: the same private link in a browser.

## Day one must dos
1. **Capture in one tap.** One always visible add button opens a text field with the keyboard up. The new task lands in the section on screen (Today by default).
2. **Swipe to done.** A swipe marks a task done and moves it to the done history. A tap on a done task reopens it.
3. **Move between sections.** Move a task to Today, Soon or Someday in one gesture or tap.

## Must nots
* No tags, no priorities.
* No accounts or login. Access is a private link with a code, like Runway.
* No AI features.
* No due dates, no repeats, no reminders or push (not now).
* No sub-tasks in v1. Ask Paul again after a month of use.

## Sections and done history
* Three sections: **Today**, **Soon**, **Someday**. The list starts empty; nothing is migrated from Notes.
* Done tasks are **kept forever** in a visible Done history, newest first, showing when each was done.
* Delete is possible (from the task's edit view) but is not the normal path; done is.

## Look and feel
Calm and minimal, Things 3 style. One accent colour (to choose). Follows system light and dark. All copy in English, with no em dashes or dashes used as punctuation. Visual design goes through Claude Design and Figma before build.

## Data and privacy
* Data lives in Cloudflare KV behind a Cloudflare Worker. The site is on GitHub Pages.
* The app ships empty and loads everything from the Worker using the code in the link (`?c=<code>`), as Runway does. Anyone with the link can read and write the list, so the code is 16 random characters and never committed. The Worker is named `paul-hub`.
* **Public repo holds:** app code, service worker, Worker code, `wrangler.toml` (KV id only), README.
* **Secrets (never in git):** the list code, `TODO_READ_TOKEN`, `ADMIN_TOKEN`. Kept as Cloudflare secrets or in gitignored local files.
* **Odysseus:** gets its own read only token. It sees **open tasks only, with their section**: no done history, and no write access. The token works on that one route and nowhere else. The Odysseus side (replacing the Shortcut mirror) is a later, separate change that needs Paul's OK.

## Offline and sync
* The service worker caches the app shell (Feeling App pattern, versioned cache), so the app opens with no signal.
* The list is kept in local storage and shown immediately; the server copy is fetched after.
* Every change is an operation on one task (id, text, section, done, doneAt, updatedAt). Offline changes wait in a local queue and are sent when the connection returns.
* The server merges **per task**: the newest `updatedAt` wins for that task, so offline edits on phone and desktop do not overwrite each other.
* Deleted tasks become **tombstones** (id plus deletedAt) so a delete is not undone by an older device. Tombstones are kept for 90 days.
* A `rev` counter makes "nothing changed" cheap. Polling runs only while the page is visible; writes are debounced, as in Runway.

## API sketch (draft)
* `GET /api/todo/:code` returns `{ items, rev, updated }`. `?since=<rev>` returns `{ unchanged: true }` when nothing moved.
* `POST /api/todo/:code/ops` accepts a batch `[{ op: "upsert" | "delete", item }]`, merges per task, returns `{ rev }`.
* `GET /api/todo/open` with `Authorization: Bearer <TODO_READ_TOKEN>` returns open tasks with section only. For Odysseus.
* Later, Morning Screen: `GET /api/morning` returns Today's open tasks plus cached blocks (weather, fixtures and so on) that a Cron Trigger refreshes into KV. Its own token or code, decided in that project.
* KV keys: `todo:<code>` (items, tombstones, rev, updated); later `cache:<block>` for Morning Screen data. Routes are namespaced by module (`/api/todo/...`, `/api/morning`) so more can be added without breaking the to-do.
* CORS limited to `https://mellowt1.github.io` and localhost, as in Runway.

## Hosting and cost
GitHub Pages plus one Cloudflare Worker and one KV namespace, free tier only. The KV free tier write budget (per Cloudflare's current published limit, 1,000 writes a day) is the constraint to design around: batched, debounced writes and one KV key per list keep a single user far below it. Reads are polled only while the app is visible.

## Decisions (23 Sept 2026)
* Sub-tasks: maybe later, not in v1.
* Worker name: `paul-hub`.
* Shortcut and Notes mirror: retired immediately once Odysseus reads the new list.
* Tombstones: 90 days. Private code: 16 characters.

* Accent colour: Sage green, light `#3F7D5C`, dark `#7DBF98`.
* Design lives in the Claude Design canvas https://claude.ai/artifact/3zVN5pUVb5cmudBuPvD6sj. No Figma file for this project (Paul's call).
