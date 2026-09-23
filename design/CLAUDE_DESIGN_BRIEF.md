# Simple to-do: Claude Design brief

Paul Ortiz · 2026-09-23 · Source: `todo/SPEC.md` (approved 23 Sept 2026)

How to use: paste the master prompt first, then the screen blocks you want designed. Attach `SPEC.md` if Claude Design asks for more context.

## Master prompt for Claude Design

> Design a personal to-do app called To-do for exactly one user, Paul. It replaces the to-do page he kept in iOS Notes. He uses it as an installed PWA on his iPhone (home screen icon, standalone, no browser bars) and in a desktop browser through the same private link. There is no login, no onboarding, no marketing and no second user. The job is three things only: capture a task in one tap, mark it done with a swipe, and move it between three sections called Today, Soon and Someday. Done tasks are kept forever in a Done history.
>
> **Feeling.** Calm and minimal, in the spirit of Things 3: lots of air, quiet surfaces, content first, nothing competing with the list. One accent colour only, used for the add button, the active section, the done check and focus rings. Everything else is neutral greys. The app follows the system light and dark setting; design both for every screen.
>
> **Type.** The system font stack (SF Pro on iPhone, system UI on desktop). Task text 17px regular, line height 1.35, wraps to two lines then truncates. Section title 28px semibold on phone, 24px on desktop. Meta text (done time, counts, status) 13px regular in secondary grey. No more than three sizes on any screen.
>
> **Spacing.** 4px base grid. 16px side gutter on phone, task rows at least 52px tall with 12px vertical padding, hit targets at least 44 by 44. Hairline separators inset to the text, or no separators at all; pick one and keep it. Respect the iPhone safe areas top and bottom.
>
> **Motion.** Short and physical. 180 to 240ms ease out for sheets and row moves. A swiped row follows the finger, snaps past a threshold, then collapses out of the list. The check fills with the accent before the row leaves. Respect reduced motion: swap slides for fades.
>
> **Iconography.** A small set of thin line icons at 1.5px stroke, rounded caps, 24px grid: plus, check circle, arrow to move, trash, clock for history, cloud with slash for offline. No filled icon sets, no emoji, no illustrations beyond one quiet empty state glyph.
>
> **Avoid.** Tags, labels, priorities, flags, stars, due dates, calendars, reminders, repeats, sub-tasks, projects, avatars, accounts, settings screens, onboarding carousels, gradients, glassy blur stacks, drop shadow heavy cards, badges with counts everywhere, and anything that hints at AI (no sparkles, no suggestions, no smart anything).
>
> **Copy.** English only. Short and plain, in sentence case. Never use em dashes, en dashes or hyphens as punctuation in any UI text; use a full stop, a comma or a new line instead. Hyphens inside words (to-do) are fine. No exclamation marks.

## Screens

Design each block at phone 390 x 844 first, then desktop at 1440 x 900. Show light and dark for each.

### 1. Main list with Today, Soon, Someday

> Phone: one section on screen at a time, Today by default. The large section title sits top left. A segmented switcher with Today, Soon, Someday sits at the bottom of the screen within thumb reach, above the home indicator, with the active segment in the accent. A quieter fourth entry for Done history sits at the top right as a clock icon, not in the switcher. Do not use a horizontal page swipe to change sections, because horizontal swipes on rows mean done and move. Each section shows a small open count next to its name in the switcher only if it stays calm; otherwise leave counts out. Rows are plain text with an empty circle on the left that is also tappable to mark done.
>
> Desktop: a narrow left sidebar lists Today, Soon, Someday and, separated below, Done. The selected section fills a centred list column about 640px wide. Same rows, same add button, same behaviour. Keyboard: N adds a task, 1 2 3 switch sections, arrow keys move focus, Enter edits, Space marks done.

### 2. One tap capture

> One add button is always visible: a round accent button bottom right on phone, sitting above the section switcher, and a plus next to the section title on desktop. One tap opens a bottom sheet on phone with a single text field focused and the keyboard up; nothing else on the sheet except a small line telling where it will land, for example "Adds to Today". Return saves the task and keeps the sheet open for the next one; tapping outside or swiping the sheet down closes it. On desktop the field appears inline at the top of the list. The new task lands in the section on screen and appears at the top of it with a gentle slide in. Show the sheet empty, with text typed, and just after a save.

### 3. Swipe to done

> Swipe a row right to mark it done. As the finger moves, the accent fills in from the left behind the row with a check icon; past about 40 percent width the check pops and the row commits on release, then collapses out. A toast appears at the bottom: "Done. Undo" with Undo in the accent, for 4 seconds. Show three frames: at rest, mid swipe before the threshold, and committed with the toast. Affordance: on first use only, the top row nudges right by 24px once to hint at the gesture, and the empty circle on each row is also a tap target for done, so the gesture is never the only way. On desktop, hovering a row shows the circle in the accent outline; clicking it marks done.

### 4. Move between sections

> Swipe a row left to reveal three compact buttons in the row: Today, Soon, Someday, with the current one dimmed. One tap moves the task and the row slides out; a toast says "Moved to Soon. Undo". Long press on a row opens the same three choices as a small menu, for people who do not swipe. On desktop, a right click or a small move icon on hover opens the same menu, and dragging a row onto a sidebar section also moves it. Show the revealed state and the toast.

### 5. Task edit view

> Tap a row's text to open it. Phone: a sheet with the task text as an editable multi line field, the three sections as a segmented control showing where it lives, and at the very bottom a plain red text button "Delete task". Delete asks once: "Delete this task? It will not go to Done." with Delete and Cancel. Changes save as you type; there is no Save button, only Close. Desktop: the same content in a small panel anchored to the row or a centred dialog. Nothing else lives here: no notes field, no dates, no tags.

### 6. Done history

> A list of every done task, kept forever, newest first. Group by day with quiet headers: Today, Yesterday, then dates like "Mon 21 Sept". Each row shows the task text with a filled accent check and struck through or dimmed text, the section it came from in small grey text, and the time it was done, for example "14:32". Tap a row to reopen it: it returns to its old section and a toast says "Reopened in Today. Undo". Long lists scroll smoothly; show a screen with around 40 items across several days. No delete, no clear all, no search in v1.

### 7. Install and first open

> The very first open, in Safari before install: an empty Today with one calm line, "Nothing here yet. Tap plus to add a task.", and below it a small dismissible card: "Add To-do to your Home Screen. Tap Share, then Add to Home Screen." with the two iOS glyphs inline. Once installed and opened from the home screen, the card never appears again. Also show the installed first open: same empty Today, no card. Desktop first open: empty Today with "Nothing here yet. Press N or click plus to add a task."

## States

Design each on phone, light and dark; desktop only where it differs.

* **Empty, one section.** Today: "Nothing for today." Soon: "Nothing coming up." Someday: "Nothing for someday." One small glyph at most, centred slightly above middle. The add button stays.
* **Empty, whole list.** Same as first open without the install card: "Nothing here yet. Tap plus to add a task."
* **Empty, Done history.** "Done tasks will show up here."
* **Loading.** The app shows the locally saved list at once, so there is no spinner on open. The only loading visual is for the rare cold start with no local copy: three faint placeholder rows, no shimmer.
* **Error.** When the server cannot be reached or refuses the link code, a small neutral banner under the title: "Could not sync. Your changes are saved on this device." with Retry. A bad or missing code shows a full screen message: "This link is missing its code. Open the private link again." No red panic styling.
* **Offline with queued changes.** A small pill near the title in secondary grey with the cloud slash icon: "Offline. 3 changes waiting". Everything keeps working; changes show immediately in the list.
* **Syncing and synced.** While sending, the pill reads "Syncing". When done it briefly reads "Synced" with a check, then fades out. Normal synced state shows nothing at all.

## Accent colour

Show the recommended accent across all screens, and include the other two as swatches on the tokens page so Paul can pick. Each has a light and a dark value; both pass 4.5:1 for text on the app background.

| Name | Light | Dark | Rationale |
|---|---|---|---|
| **Harbour blue** (recommended) | `#3A6EA5` | `#7FA8D6` | Calm and familiar as the tappable colour on iPhone, close to the Things 3 feel, and it never clashes with the red of Delete. |
| Sage green | `#3F7D5C` | `#7DBF98` | Reads as done and growth, so the swipe to done feels rewarding; softer than a pure system green. |
| Terracotta | `#B4562F` | `#E08A62` | Warm and personal, stands out from every stock app on the home screen; keep Delete a cooler red so the two never look alike. |

Neutrals to start from: light background `#FFFFFF`, grouped surface `#F5F5F7`, text `#1C1C1E`, secondary `#8A8A8E`; dark background `#000000`, surface `#1C1C1E`, text `#F2F2F7`, secondary `#8E8E93`. Destructive red: light `#C62828`, dark `#FF6B60`.

## Deliverables

Please return:

1. All screens and states above at phone 390 x 844 and desktop 1440 x 900, light and dark, with the recommended accent.
2. A small component set with variants: task row (open, done, swiping right, revealed move actions, focused), section header, section switcher, add button, bottom sheet (capture and edit), swipe action backgrounds, toast with Undo, offline and sync pill, empty state.
3. Tokens for colour (light and dark, all three accent options) and type (sizes, weights, line heights), plus spacing and radius, as a table and as a JSON or CSS variables file.
4. The app icon: a simple check mark or ticked circle in the accent on a neutral ground, readable at home screen size, exported at 180 x 180 (apple touch icon) and 512 x 512 (PWA manifest), plus a maskable version with safe padding. Home screen label: To-do.
5. Everything exported as a handoff bundle into `todo/design/handoff/`: screens as PNG, the tokens file, icons, and a short README listing each screen and component.
