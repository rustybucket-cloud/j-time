# j-time — notes for Claude

A menu-bar launcher with a Raycast-style command palette, hosting a plugin per
app. Electron + TypeScript + React, vanilla CSS, no database, no auth, no state
management library. Runs only on the user's machine.

Two plugins ship: **jira** (the board, and the timer) and **github** (pull
requests). The JIRA half was the whole app until the shell grew plugins;
everything about *time* is unchanged from that, and before that from
`../jira-timer`.

## Commands

```bash
npm run dev        # electron-vite with renderer HMR
npm test           # vitest, pure logic only (200 tests)
npm run typecheck  # both projects — main/preload, then renderer
npm run build      # typecheck + bundle into out/
sh scripts/sandbox.sh   # the app against a mock JIRA, with scratch state
```

## The three processes, and what each is allowed to know

- **main** owns everything: the config, the state file, every service client,
  the window and the menu bar. It is the only writer.
- **preload** exposes `window.jt`, typed by `Bridge` in `src/shared/ipc.ts`.
  No credential ever crosses it — each plugin's public config replaces its
  secret with `hasToken`.
- **renderer** renders a `Snapshot` and sends back intents. It never talks to a
  service and never touches disk.

`src/shared/` is imported by both sides *and* by the tests, so nothing in it may
import `electron`. That's the same constraint `lib/jira.ts`'s `import
'server-only'` enforced in the original, arrived at from the other direction.

## Shell and plugins

The split, in one line each:

- `src/main/shell.ts` — the registry. One owner of the config file, the
  snapshot, the polling and the staleness rule. Knows nothing about worklogs or
  pull requests.
- `src/main/plugin.ts` — the main-side contract. `snapshot()`, `refresh()`,
  `commands`, `queries`, and optionally `menuBar()` / `trayMenu()`.
- `src/shared/plugin.ts` — what a plugin may put on screen: `Row`, `Badge`,
  `Glyph`, `Ctx`, `PluginView`.
- `src/shared/sections.ts` — the root list: sections, subsections, pinning, the
  top hit, and cursor movement. Pure and tested.
- `src/shared/layout.ts` — the user's arrangement. Pure and tested.
- `src/{main,renderer}/plugins/<id>/` — one plugin, two halves.

**Adding a plugin is four edits**: `src/main/plugins/index.ts`,
`src/renderer/plugins/index.ts`, a line in `PluginSnapshots` in
`shared/ipc.ts`, and the plugin's own directory. That `PluginSnapshots` line is
deliberate friction — plugins are compiled in, so there is no reason to give up
knowing their shapes.

**Rows are data, not markup.** A `lead` is a *meaning* (`attention`, `blocked`,
`ok`) and an accessory is a `Badge`, so a PR waiting on you and a chunk of
unfiled time look the same without either plugin having picked a colour. One
place — `components/List.tsx` — decides what a meaning looks like. A plugin that
could return arbitrary JSX would undo the design tokens in an afternoon. The two
places a plugin *does* return React are `screen()` and `settings()`, which are
full screens rather than list rows and answer to nothing else on the page.

**Rows carry closures, not serialisable commands.** That's what keeps the
builders as direct as they were when there was only a board to draw, and it is
the thing that would have to change first for runtime-loaded third-party
plugins: a closure can't cross the bridge.

**Commands are addressed by plugin and name.** `window.jt.invoke('jira',
'start', [key])` — untyped at the seam, because it has to carry any plugin's
verbs. The argument names come back one layer up, in each plugin's
`plugins/<id>/client.ts`. Don't add named methods to `Bridge` for a plugin's
verbs; that list is what stopped scaling at the second plugin.

**The shell owns the two fetch rules, for everybody.** A fetch in flight leaves
the previous rows on screen; a failed one leaves them there too and puts the
message on that section's header. `refreshPlugin` also skips a plugin that isn't
configured — an app with no credentials is unset, not broken, and reporting it
as a fetch failure paints a red error on a section whose real problem is that
nobody filled its form in.

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

**Ranking lives in `shared/palette.ts`; arranging lives in `shared/sections.ts`.**
Both are pure and tested there, and the renderer draws what they return. The
rules the tests pin down:

- **An empty query keeps the caller's order** — inside a section that's the
  plugin's order, and between sections it's the user's. Reshuffling the default
  view undoes the one thing the app makes glanceable.
- **Ties fall back to the original index**, so the list can't jitter between
  keystrokes.
- **Typing sorts within a section and never moves the sections.** The
  arrangement is what the user set up; dissolving it the moment they search
  would make it useless exactly when they need it. What typing does instead is
  hoist the single best match into **Top hit** — and only when it isn't already
  the first row, or the heading would be announcing nothing.
- **A collapsed section auto-expands when the query finds something in it**,
  because one that silently swallowed the only match reads as "no results".
- **A section with no matches disappears; an empty one with no query does not.**
  A header reading "Not set up" is how you find out a plugin exists at all.

**Pinning is the shell's, and capped at one row per plugin.** JIRA pins the
running story, the PR section pins the review that has waited longest, and the
user can switch either off. Uncapped, a plugin that pinned everything would
simply be first. Pinned rows lose their own subsection headings on the way up —
carrying "In Progress" and "Needs your review" with them turned a two-row
section into four lines of heading.

**Section headers are selectable rows.** That is what makes collapsing (`↩`,
`←`/`→`) and reordering (`⌘↑`/`⌘↓`) reachable from the keyboard, and it is
where the cursor goes when the section under it closes — the one thing on
screen that certainly still exists.

**Selection is an id, not an index.** Filtering must not slide the cursor onto
whatever moved into the selected slot; a row that filters away hands the cursor
to the top.

**Every level of the palette is the same `Row` list.** Issues, PRs, per-row
actions, activity pickers and transition pickers all share one shape and one
component, which is what makes the keys mean the same thing everywhere.
Overlays go through `buildOverlay`, which is the same view with no headings —
a picker is already the answer to "which of these", so there is nothing for the
user's arrangement to say about it.

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

**config.json holds a section per plugin, and migrates itself.** A file written
before the shell had plugins is one flat JIRA object with the hotkey mixed in;
`migrate()` in `store.ts` recognises it by the absence of a `plugins` key and
wraps it. It is somebody's real credentials — asking them to paste an API token
again because the app grew a second plugin would be a poor trade. A section
belonging to a plugin that isn't installed this launch is carried through
untouched, for the same reason.

**Secrets are declared, not guessed.** Each plugin lists its credential fields
in `secrets`; the store encrypts those under `<field>Enc` and nothing else. The
plaintext fallback for machines with no keychain is why the file mode matters as
much as the encryption.

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
`wrote …`. `npm run dev` leaves exactly such an instance behind, and so does the
*installed* app from `release/`, which `pgrep -fl j-time/node_modules` does not
match — use `ps aux | grep -i j.time`.

The lock is keyed on `userData`, so `JT_HOME` now redirects that too
(`$JT_HOME/chromium`). A sandbox run no longer collides with a real j-time
sitting in the menu bar, which it silently did before.

**State mutations are serialised through `serial()` in `data.ts`.** Read-modify-
write on `state` isn't atomic across an `await`, and filing saves twice on purpose
(labelled first, marked logged only after JIRA accepts). Two overlapping actions
would interleave and lose a segment.

**`state.json` stays exactly where it is.** It belongs to the JIRA plugin now,
but it is the one file in the app with no second copy, so it did not move house
for a refactor.

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
JIRA works fine against stale rows. This is the shell's guarantee now, and it
applies per section: one plugin failing leaves the others live.

**An org enforcing SAML SSO withholds results silently.** REST answers 403 with
an `X-GitHub-SSO` header, which is easy. GraphQL *search* does not: it returns
HTTP 200, no header, and simply fewer pull requests — so an unauthorised token
makes a whole org's work vanish while the section reads "Nothing open". The only
signal is that REST `/user/orgs` still names the org and GraphQL
`viewer.organizations` doesn't; `unauthorizedOrgs` is that difference, and the
PR section renders it as a row rather than a note, because a failure that is
invisible by construction cannot be reported by something you have to notice the
absence of. The membership probe is best-effort — a diagnostic that can fail a
working fetch is worse than no diagnostic.

**`review-requested:@me` already covers team requests.** Checked against the
docs rather than assumed: "if the requested person is on a team that is
requested for review, then review requests for that team will also appear".
`user-review-requested:` is the direct-only one — don't "fix" the query to that.

**GitHub is GraphQL, not REST search.** `reviewDecision` and the check rollup
don't exist on REST's issue search results, and those two things are most of
what the PR section is *for* — REST would mean one search plus an N+1 of per-PR
requests. A GraphQL error arrives with HTTP 200 and a body full of `errors`, so
checking the status is not enough.

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
`conn`, `worklog`, `palette`, `board`, `sections`, `layout`, `prs`, `keys`. There
are no component or IPC tests — if you add a feature with real logic in it, put
that logic in `src/shared/` and test it there rather than reaching for a
rendering harness.

`sections.ts` is the worked example, and the reason the plugin shell was worth
doing this way: ranking, pinning, the top hit, collapse and cursor movement are
all pure functions with tests, leaving the renderer to draw what they return.
`layout.ts` is the same for the user's arrangement. A new plugin's *ordering*
belongs in `shared/` next to `prs.ts`; only the mapping onto rows belongs in
`renderer/plugins/`.

`scripts/sandbox.sh` runs the app against both mocks — `mock-jira.mjs` and
`mock-github.mjs` — with a scratch `JT_HOME`.

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
