# j-time — notes for Claude

A menu-bar launcher with a Raycast-style command palette, hosting a plugin per
app. Electron + TypeScript + React, vanilla CSS, no database, no auth, no state
management library. Runs only on the user's machine.

Two plugins ship:

- **jira** — the board, and the timer. It was the whole app until the shell
  grew plugins, and everything about *time* is unchanged from that, and before
  that from `../jira-timer`.
- **claude** — which Claude Code sessions are open, and which one is waiting on
  you. It owns no credentials and writes nothing: the whole plugin is a read of
  two files Claude Code already keeps.

A third (**github**, pull requests) was built and then removed; it is in this
branch's history if another worked example is ever useful. The shell was worth
drawing for exactly the reason `claude` demonstrates: it cost a directory and
three registration lines, and nothing in the shell learned what a session is.

## Commands

```bash
npm run dev        # electron-vite with renderer HMR
npm test           # vitest, pure logic only (337 tests)
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
  `commands`, `queries`, and optionally `mcp()` / `menuBar()` / `trayMenu()`.
- `src/shared/plugin.ts` — what a plugin may put on screen: `Row`, `Badge`,
  `Glyph`, `Ctx`, `PluginView`.
- `src/shared/sections.ts` — the root list: sections, subsections, pinning, the
  top hit, and cursor movement. Pure and tested.
- `src/shared/layout.ts` — the user's arrangement. Pure and tested.
- `src/shared/mcp.ts` — the MCP endpoint's framing and tool names. Pure and
  tested; `src/main/mcp.ts` is the socket.
- `src/{main,renderer}/plugins/<id>/` — one plugin, two halves.

**Adding a plugin is four edits**: `src/main/plugins/index.ts`,
`src/renderer/plugins/index.ts`, a line in `PluginSnapshots` in
`shared/ipc.ts`, and the plugin's own directory. That `PluginSnapshots` line is
deliberate friction — plugins are compiled in, so there is no reason to give up
knowing their shapes.

**Runtime plugins load from `~/.j-time/plugins`, and they are data, not code, as
far as the renderer is concerned.** `<id>/main.js` is a CommonJS module that
`main/runtime.ts` `require`s in the main process — the user's own code, on the
user's own machine, with everything the app has. What it returns from `refresh`
goes through `sanitiseContent` in `shared/runtime.ts` (pure, tested) and comes
out as `RuntimeRow`s: the `Row` shape with `run` naming a command or a url
instead of being a closure. `renderer/plugins/runtime.tsx` is the one view they
all share, which puts the closures back as `invoke(id, command, args)` and
draws a settings form from the `fields` the plugin declared. Secrets are the
fields marked `secret`, so the store encrypts them like anyone else's. A file
that fails to load is still registered, with the error on its header — a typo
that made the section vanish would be indistinguishable from the folder being
ignored. `reloadRuntimePlugins` unregisters and re-mounts, then goes back
through `shell.load()` so a plugin added since launch has its secrets decrypted.
`PluginSnapshots` has an index signature for them; the built-ins stay listed.

**`plugins/` in the repo is what a fresh `~/.j-time/plugins` gets.**
`plugins/install.ts` embeds it with `?raw` imports (a packaged .app carries only
`out/`) and writes it out on launch: a plugin directory only when missing, so an
edited copy survives an upgrade; `AGENTS.md` whenever it changed, and to
`CLAUDE.md` as well. `bookmarks/main.js` is the worked example and the guide is
the contract in prose — change `shared/runtime.ts` and change the guide.
`JT_HOME` redirects this directory with the rest.

**Two parts of the contract currently have no user**, both kept because they
are the shell's, not any plugin's: `SecretField`'s `{ list, field }` form, for
a plugin holding several credentials rather than one, and `mergeConfig`, for
folding a settings patch when the default "keep the secrets the form omitted"
isn't enough. The removed PR plugin needed both. Delete them if a year goes by
and nothing does.

**Rows are data, not markup.** A `lead` is a *meaning* (`attention`, `blocked`,
`ok`) and an accessory is a `Badge`, so a Claude session waiting on you and a
chunk of unfiled time look the same without either plugin having picked a
colour. One
place — `components/List.tsx` — decides what a meaning looks like. A plugin that
could return arbitrary JSX would undo the design tokens in an afternoon. The two
places a plugin *does* return React are `screen()` and `settings()`, which are
full screens rather than list rows and answer to nothing else on the page.

**Built-in rows carry closures; runtime rows carry names.** Closures are what
keep the compiled-in builders as direct as they were when there was only a
board to draw, and a closure can't cross the bridge — which is why a runtime
plugin describes `run` as `{ command, args }` or `{ url }` and the runtime view
turns that back into a closure on the renderer side.

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

## The MCP endpoint

**The shell owns one port and every plugin's tools are on it.** `src/main/mcp.ts`
is the HTTP server; `src/shared/mcp.ts` is the JSON-RPC framing, the names and
the sanitising, pure and tested. A compiled-in plugin declares `mcp(): McpTool[]`
in `src/main/plugin.ts`; a runtime plugin declares `tools` in its `main.js`. The
shell namespaces them — `<plugin>_<tool>`, dashes in an id becoming underscores —
so two plugins may both call something `status`, and `resolveTool` takes the
**longest** matching prefix because `claude` and `claude-code` would otherwise
both claim `claude_code_sessions`.

**Served by the app itself, not a stdio sidecar.** j-time is already the process
holding the credentials and the only writer to `state.json`. A sidecar would be a
second writer racing this one, and it could not see a timer running in here. This
is the same reasoning that put the endpoint inside Next in the predecessor.

**Loopback, POST-only, and the Origin header is checked.** There is no session to
resume and no server-initiated stream, so GET and DELETE are 405 rather than left
hanging — a client waiting on an SSE stream that never opens looks exactly like a
server that is down. A browser on any page can POST to localhost but cannot forge
`Origin`, so a request with a *wrong* origin is refused and one with none at all
is a local client, which is every MCP client there is.

**`/mcp` and `/api/mcp` both work.** The second is where the predecessor served
it, and a registration pointing there is somebody's working setup.

**`listChanged` is false even though the list does change.** Reloading the
plugins directory changes the tools, but the capability promises a
*notification*, and a POST-only transport has nothing to send one down.

**A tool is not a command with a longer name.** A command is a keystroke on a row
the user is looking at, so `start` takes the key it was pressed on. A tool is
called by something that cannot see the screen: named arguments, prose answers,
and read-only tools that no row would ever need. `argStr` throws, and the shell
turns that into a failed *tool* rather than a broken server — a schema is a hint
when the caller is a language model.

**The prose is in `shared/report.ts` and `describeSessions`, and it is tested.**
The text *is* the interface, which is why the three time quantities are named
separately in it — "tracked here", "filed", "JIRA has". A summary that collapsed
them would have the caller file time JIRA already has.

**`callMcpTool` refuses a plugin that isn't configured**, saying which form to
fill in, for the same reason `refreshPlugin` skips it: an app with no credentials
is unset, not broken, and a missing token surfacing as a deep client error is the
one failure nobody can act on.

**The user can switch any tool off, and the shell stores the exceptions.**
`mcp.disabled` in the shell config holds *qualified* names, the way `layout`
holds `collapsed` and `pinsOff` — so a plugin that gains a tool in an upgrade
arrives with it on, which is the only behaviour that doesn't need every user to
go and find it. Nothing prunes a name whose tool isn't loaded: a `main.js`
mid-edit unregisters its tools for an afternoon, and turning one back on behind
the user would be worse than a stale entry nobody sees. A switched-off tool is
absent from `tools/list` **and** refused by name, saying it was switched off —
a client holding a list from before the change would otherwise get "no such
tool", which reads as a bug rather than a setting.

**The endpoint has its own settings page, `components/McpSettings.tsx`.** The
shell's own page keeps a one-line summary and a way in; the tool list is as long
as the plugins make it — JIRA alone has ten — and that under the hotkey would
push the plugin arrangement off the bottom of a panel deliberately the size of a
palette. It is the shell's second screen, so `App`'s `Screen` union gained `mcp`
and `appCommands` takes a `ShellScreens` — *not* a new verb on `Ctx`, which is
the plugin contract and has no business carrying "open the shell's settings".

**Everything on that page saves on the click except the port.** A checkbox
ticked halfway through typing a port must not take the endpoint down on `419`,
so the port is applied by its own Save row and the toggles send the stored one.

**A runtime plugin's tools are data, but its handlers are closures.** Unlike a
row's `run`, nothing has to cross the bridge — the file already runs in the main
process. They are sanitised once at load rather than per call, because `mcp()` is
asked on every snapshot. A tool with no `run` is dropped: a name in the list that
always fails is worse than a name that isn't there.

**The sandbox gets its own MCP port (4198).** Same reason `JT_HOME` exists — a
sandbox run answering calls meant for the real j-time would be a mock board
replying about your actual board.

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
running story, the Claude section pins the session that has waited longest, and
the user can switch either off. Uncapped, a plugin that pinned everything would
simply be first. Pinned rows lose their own subsection headings on the way up —
carrying "In Progress" and "Waiting on you" with them turned a two-row section
into four lines of heading.

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

**A menu accelerator beats a row's `shortcut`.** The menu that stays is still a
menu: ⌘H is `role: 'hide'` and ⌘Q is `role: 'quit'`, and a plugin that gives a
row action `shortcut: 'h'` gets the app hidden instead. Pick a letter the menu
doesn't own — the Claude section's "Hide this session" is ⌘D for exactly this
reason, and "Dismiss" is ⌘E.

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

**One token per account, because a fine-grained token speaks for one owner.**
A fine-grained PAT has exactly one resource owner — your user, or one org — so
a single token cannot span personal repos and two work orgs, and orgs that
mandate them make "one token" wrong outright. `GithubConfig.accounts` is the
unit; the store encrypts each entry's token via `{ list, field }`, and
`mergeConfig` on the plugin matches accounts **by id** when the form sends a
blank token, because lining them up by index moves one account's token onto
another's host the first time somebody reorders the list. Accounts fail
independently: `allSettled`, a row per broken one, and the section only counts
as failed when every account is.

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

## The Claude Code plugin

**Claude Code's own session file knows only `idle` and `busy`, and neither is
the state worth being told about.** `~/.claude/sessions/<pid>.json` is written
by every live session. A session that has stopped to ask you something reads as
`busy`, exactly like one running a build — that was measured, not assumed: the
status stays `busy` across a whole turn with a permission prompt up, and
`statusUpdatedAt` does not move while it sits there. So the third state is
derived, and `sessionState` in `shared/claude.ts` is where.

**A transcript records a tool call when it is made, not when it returns.** That
is the whole basis of the derivation: a call at the tail with no result after it
is either a tool that is running or a question waiting on a person. The evidence
it is a real signal is in the transcripts — an `AskUserQuestion` sat unanswered
for 862 seconds, an `Edit` for 216.

**`AskUserQuestion` and `ExitPlanMode` are certain; everything else is a
guess.** Nothing is running that could answer those two, so they report
immediately. Any other call has to age past `attentionSeconds` (45 by default)
before it counts as waiting, because a permission prompt and a slow tool are the
same two records on disk. **The false positive that buys is a build longer than
the threshold showing as "needs you"** — that is the known cost of the read-only
approach, and raising the number in Settings is the fix. `Notification` hooks
would make it exact, at the price of writing to the user's global Claude config.

**The row is the session name and the title `/resume` would list it under.**
Claude Code writes an `ai-title` record — `{ type, aiTitle, sessionId }` — and
rewrites it every turn, so the last one in the tail is the current one. That
gives the rows the shape every other row in the app has, a key then a summary:
three sessions in the same repo are indistinguishable by name and path alone. A
session with no title yet falls back to its path, and the path stays in
`keywords` either way so searching for the repo still finds it.

**Transcripts are read once and then `stat`ed.** Reading the title means opening
*every* session's transcript rather than only the busy ones, which was the thing
that made a 5-second poll affordable. An idle session's transcript does not
change, and neither does a blocked one's — so the tail is parsed only when the
mtime moves, and the open call is cached alongside the title rather than re-read.
The cache drops sessions that have ended; an id is never reused.

**128KB of tail is roughly four times what is needed.** Measured across every
live session: the furthest a last `ai-title` sat from EOF was 33KB. Two
transcripts had none at all, which is what the path fallback is for — not a
window that was too small.

**Only the tail is read, and a half-line is dropped.** Results always follow
their call, so a call inside the window has its result inside the window too —
which is what makes a fixed 128KB tail sound rather than merely cheap. A record
longer than the window loses an "attention" we might have inferred; it never
invents one.

**A dead pid is `ESRCH`, and only `ESRCH`.** `process.kill(pid, 0)` checks
without delivering anything, and `EPERM` means the process is there and isn't
ours — alive. Every crashed session leaves its file behind, and listing those
would be listing sessions that cannot be gone back to.

**A transcript lives at `projects/<cwd with every non-alphanumeric turned into a
dash>/<session id>.jsonl`.** `/Users/x/.config/nvim` becomes
`-Users-x--config-nvim`, double dash and all. A session whose transcript isn't
where its cwd says — the IDE extension writes one of these — simply never
reports as waiting, which beats scanning every project directory on a poll.

**A session that has stopped recently reads as finished, and that leans on
`statusUpdatedAt` being written on a transition rather than as a heartbeat.**
Sessions idle for eight and thirteen days still carry stamps that old, which a
heartbeat would have overwritten long ago — so the field really does mean "when
this last crossed between busy and idle", and `now - changedAt` inside
`completedMinutes` really does mean "a turn just ended here".

**A freshly launched session has its status stamped at launch**, which without a
guard would have it announcing a result it never produced for the whole window.
`LAUNCH_SLACK_MS` is that guard: a session whose status has never moved more than
a couple of seconds past its own start has not finished anything.

**Dismissing a result is not muting a session.** The key is
`<session id>@<finished at>`, so the same session finishing *again* is a
different key and says so — which is the difference between acknowledging what
you just read and never hearing from it again. `dismissCompletion` prunes both
ways: entries whose session has ended, and that session's own earlier keys, since
only its latest result can still be on screen. What survives is at most one key
per running session.

**Hiding a session is by id, so it lapses when the session ends.** A session id
dies with the session, which is what keeps `config.hidden` from becoming a
permanent blocklist of things that no longer exist. `hideSession` prunes every
id whose session is gone each time another is added, so the list is bounded by
what is actually running and there is no sweep to schedule and no second place
for the rule to live.

**Hiding outranks the rule that keeps a waiting session on screen.** The idle
cutoff deliberately never hides a session that wants you; an explicit hide does,
because the user said so and it only lasts as long as that session. The menu bar
count leaves hidden sessions out for the same reason.

**`CLAUDE_CONFIG_DIR` is honoured**, so the plugin can be pointed at a fixture
the way `JT_HOME` points the rest of the app at one.

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
`conn`, `worklog`, `palette`, `board`, `sections`, `layout`, `keys`, `claude`,
`runtime`, `mcp`, `report`. There
are no component or IPC tests — if you add a feature with real logic in it, put
that logic in `src/shared/` and test it there rather than reaching for a
rendering harness.

`sections.ts` is the worked example, and the reason the plugin shell was worth
doing this way: ranking, pinning, the top hit, collapse and cursor movement are
all pure functions with tests, leaving the renderer to draw what they return.
`layout.ts` is the same for the user's arrangement. A new plugin's *ordering*
belongs in `shared/` alongside `board.ts`; only the mapping onto rows belongs
in `renderer/plugins/`.

`scripts/sandbox.sh` runs the app against `mock-jira.mjs` with a scratch
`JT_HOME`.

**For the UI itself, screenshot it.** A borderless always-on-top overlay can't be
pointed at with a normal screenshot tool. `JT_CAPTURE=path.png` shows the panel,
saves a picture and quits; `JT_CAPTURE_KEYS="cmd+k,Enter"` drives it there first.
`JT_CAPTURE_DELAY=20000` waits longer before the shot, for a plugin slower than
a fetch — the default 1.8s catches the panel mid-refresh, which reads exactly
like a truncated list.

`JT_CAPTURE_KEYS` also takes `click:x:y` and `scroll:x:y:ticks`. The scroll one
is what makes a settings page taller than the panel reviewable at all — the
arrows belong to the search field, not to the scroller, so there is no other way
down the page.

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
