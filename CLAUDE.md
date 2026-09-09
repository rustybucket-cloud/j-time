# j-time — notes for Claude

A menu-bar JIRA timer with a Raycast-style command palette. Electron +
TypeScript + React, vanilla CSS, no database, no auth, no state management
library. Runs only on the user's machine.

Ported from `../jira-timer`, a Next.js widget. Everything about *time* came
across unchanged — the segment model, the three grouping functions, every
rounding rule. What changed is the shell: no server, no browser tab, no
environment variables.

## Commands

```bash
npm run dev        # electron-vite with renderer HMR
npm test           # vitest, pure logic only (200 tests)
npm run typecheck  # both projects — main/preload, then renderer
npm run build      # typecheck + bundle into out/
sh scripts/sandbox.sh   # the app against a mock JIRA, with scratch state
```

## The three processes, and what each is allowed to know

- **main** owns everything: the config, the state file, the JIRA client, the
  window and the menu bar. It is the only writer.
- **preload** exposes `window.jt`, typed by `Bridge` in `src/shared/ipc.ts`.
  The API token never crosses it — `PublicConfig` replaces it with `hasToken`.
- **renderer** renders a `Snapshot` and sends back intents. It never talks to
  JIRA and never touches disk.

`src/shared/` is imported by both sides *and* by the tests, so nothing in it may
import `electron`. That's the same constraint `lib/jira.ts`'s `import
'server-only'` enforced in the original, arrived at from the other direction.

## The one important design rule

**Time is stored as segments, never as a running total.** A `Segment` is
`{start, end, activity?, logged?}` with `end: null` meaning currently running.
Active time is the sum of segment durations (`activeSeconds`). This is the whole
point of the app: an idle window accrues nothing, so never compute elapsed time
as `now - firstStart`.

## Start, Stop, file, finish

1. **Start** opens a segment.
2. **Stop** closes it and leaves it *unfiled*.
3. **Filing** it under an activity posts a worklog to JIRA immediately, at the
   chunk's exact length.
4. **Finish** sweeps anything still unfiled, then transitions. Usually there's
   nothing to sweep, which is what makes it one keystroke.

`fileTime` stops the clock first if the story is running. The running chunk isn't
classifiable until it's closed, so filing while it runs would silently leave the
time you just spent out of the worklog.

**Filing is exact; only the Done sweep rounds.** Rounding each chunk inflates
badly — see the note in `shared/activities.ts` about three 2-minute chunks. The
sweep is a single bucket, so rounding there is safe.

**Filing refuses sub-minute time.** `addWorklog` clamps to `Math.max(60, …)`, so
filing a four-second chunk banks a whole minute *and* adds that minute to
`loggedSeconds`. The guard is in `fileTime`, before labelling, so a refusal
leaves no trace. Left pending, the time merges into the next chunk filed.

**`roundSeconds` floors at one whole increment.** Any positive value becomes 5
minutes by default. Go through `sweepSeconds`, which returns 0 below
`MIN_LOGGABLE_SECONDS`. Calling `roundSeconds` on a leftover reintroduces a bug
where the UI says "nothing left to log" and the app posts five minutes anyway.

## Three time quantities, easily conflated

`tracked` (local segments), `StoryTimer.loggedSeconds` (what *this app* sent), and
`JiraIssue.secondsSpent` (JIRA's total, including worklogs from before this app
existed). Display uses JIRA's total; pending calculations subtract only our own.
Swapping those cancels a user's pre-existing time against newly tracked work and
silently logs nothing.

## Display grouping and logging grouping are different functions

Three of them, and mixing them up breaks something each way:

- `trackedByActivity` — **display.** All tracked time per activity, logged chunks
  included. The clock counts everything, so this is the only one that adds up to
  it. Also appends JIRA's own untracked time as a trailing row.
- `unloggedBreakdown` — display, unlogged only, running chunk in its own `Running`
  row.
- `unloggedByActivity` — **logging.** Folds the running chunk into `Unlabelled`. A
  worklog must never read "Running".

`finishStory` must use `unloggedByActivity`. Pointing it at `trackedByActivity`
would re-send time JIRA already has on every finish.

**Relabelling and discarding have deliberately different reach.** Both ignore the
open segment. `relabelActivity` *does* touch logged segments — safe, because a
logged segment is never re-sent, so a label change is display-only; restricting it
left every finished story permanently reading "Unlabelled". `discardUnlogged`
*must not* — dropping a logged segment pulls `activeSeconds` below
`loggedSeconds`.

## The palette

**Ranking lives in `shared/palette.ts` and is tested there.** The renderer draws
what it returns. Two rules the tests pin down:

- **An empty query keeps the caller's order.** That order is the board's own.
  Reshuffling the default view undoes the one thing the app makes glanceable.
- **Ties fall back to the original index**, so the list can't jitter between
  keystrokes.

**In Progress leads, and the running story is pinned above it in its own
section.** The question the hotkey answers is "which of the things I'm in the
middle of am I about to work on". The running story is pinned rather than sorted
in place, so it keeps its column identity in the section label.

**Selection is an id, not an index.** Filtering must not slide the cursor onto
whatever moved into the selected slot; a row that filters away hands the cursor
to the top.

**Every level of the palette is the same `Entry` list.** Issues, per-issue
actions, activity pickers and transition pickers all share one shape and one
component, which is what makes the keys mean the same thing everywhere.

## Things that will bite you

**`showPanel()` broadcasts `palette:opened`, and the renderer resets on it.** A
screen set anywhere else is undone the next time the panel opens. That's why
"open on Settings when unconfigured" lives *inside* `reset()` rather than in a
one-shot effect — the effect version was silently reverted a frame later.

**Electron installs a default menu if you don't.** Its Window submenu binds ⌘W to
*close*, which destroys a panel this app only ever hides and never recreates —
the hotkey then presses on nothing. `installMenu()` replaces it. Setting the menu
to `null` instead is worse: on macOS the clipboard shortcuts in a text field
*are* the Edit roles, so without them you cannot paste an API token into Settings.
`panel.on('close')` prevents it a second way.

**Blur dismisses the panel — except over Settings.** Pasting a token means
switching to a browser to copy it. Blur-to-hide threw away the URL and email you'd
already typed every single time. `setDismissOnBlur(false)` while the form is open.

**A packaged .app inherits none of your shell's environment.** There is no
`.env.local` and no way for the user to set one, which is why credentials are
config fields in `~/.j-time/config.json` rather than env vars, and why
`missingCreds` takes a config object rather than `process.env`.

**State is written atomically, and owner-only.** `writeAtomic` renames a temp file
into place, so a quit mid-write leaves either the old state or the new one — it's
the user's real tracked time and there is no other copy. Both files are `0600` in
a `0700` directory. `mkdir`'s `mode` only applies at creation, so the separate
`chmod` in `ensureDir` is what narrows a directory an earlier version left wide;
it is best-effort, because refusing to save tracked time over a permission bit
would be the worse failure. The `chmod` on the temp file isn't redundant either:
`mode` is ignored when the file already exists, which a crash can arrange.

**A stale instance makes every later launch a silent no-op.**
`requestSingleInstanceLock` means a second copy calls `app.quit()` immediately —
no window, no JIRA request, no error, and `scripts/sandbox.sh` still prints
`wrote …`. `npm run dev` leaves exactly such an instance behind. If a sandbox run
seems to do nothing at all, `pgrep -fl j-time/node_modules` before debugging
anything else.

**State mutations are serialised through `serial()` in `data.ts`.** Read-modify-
write on `state` isn't atomic across an `await`, and filing saves twice on purpose
(labelled first, marked logged only after JIRA accepts). Two overlapping actions
would interleave and lose a segment.

**`~/.j-time`, never `~/.jira-timer`.** Sharing the state file with an always-on
jira-timer means two unlocked writers. That was a deliberate choice, not an
oversight.

**`JT_HOME` redirects the whole state directory.** That's what makes
`scripts/sandbox.sh` safe. Never test writes against a real board — filing posts a
worklog the moment an activity is picked.

**Timer actions must not depend on JIRA.** `start`, `stop`, `relabel` and
`discard` only touch the local state file. The timer has to work when JIRA is
down.

**A failed fetch keeps the previous issues on screen.** A dropped VPN shouldn't
blank a list you're about to act on, and every action except the two that call
JIRA works fine against stale rows.

**JIRA's Done category includes cancellation.** Most boards have both `Done` and
`Cancelled` in `statusCategory = done`, and `/transitions` doesn't guarantee an
order. `preferredDoneTransition` skips the abandonment ones and returns null
rather than guessing.

**`/rest/api/2/search` is 410 Gone on current JIRA Cloud.** Use
`/rest/api/3/search/jql`, which is token-paginated and returns **no** `total`.

**`aggregatetimespent` rolls subtasks up; `timespent` doesn't**, so a parent whose
work happens in its subtasks reads as zero. Both are requested and the aggregate
wins.

**There is no user→board endpoint.** `getMyBoards` bridges via projects. Kanban
boards return 400 from the active-sprint endpoint; that's "no sprint", not an
error.

## Design tokens

`styles.css` opens with the palette. Two rules that are easy to undo:

- **One accent.** `--accent` is every interactive thing. `--warn` and `--danger`
  are only for things wanting attention. Green (`--ok`) is **status only** — the
  connection dot — and deliberately not a UI colour.
- **Neutrals are near-black at ~8% saturation.** They were 26% once, which read as
  navy. Keep new surfaces in the same family rather than introducing a new tint.

The window is transparent and `.panel` is the only visible surface, so it owns the
radius and the hairline border. Real blur comes from the window's `vibrancy`; CSS
`backdrop-filter` can't see the desktop behind a transparent window, so don't
reach for it.

## Testing

`npm test` covers pure logic only: `time`, `timer-logic`, `activities`, `stages`,
`conn`, `worklog`, `palette`, `keys`. There are no component or IPC tests — if you
add a feature with real logic in it, put that logic in `src/shared/` and test it
there rather than reaching for a rendering harness. `palette.ts` is the worked
example: ranking, sectioning and selection movement are all pure and all tested,
leaving the renderer to draw what they return.

**For the UI itself, screenshot it.** A borderless always-on-top overlay can't be
pointed at with a normal screenshot tool. `JT_CAPTURE=path.png` shows the panel,
saves a picture and quits; `JT_CAPTURE_KEYS="cmd+k,Enter"` drives it there first.

Two things about `sendInputEvent`, both established the hard way:

- **`rawKeyDown`, not `keyDown`** — a plain `keyDown` is eaten looking for a menu
  accelerator and never reaches the renderer. Printable keys additionally need a
  `char` event; named keys like `Enter` must not get one, or the word is typed
  into the search field.
- **`modifiers` must be present even when empty.** Omitting the field silently
  drops the event, which looks exactly like the app ignoring the keystroke.

## Style

Match what's there: named exports, no default exports, no comment restating what
the code does — comments explain *why*, especially around the segment model and
anything JIRA's API does unexpectedly. 2-space indent, single quotes, trailing
commas, ~100 column lines. No Prettier or ESLint config ships with the repo, so
follow the surrounding file.
