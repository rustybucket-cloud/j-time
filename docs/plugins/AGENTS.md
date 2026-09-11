# Writing a j-time plugin

This folder is where j-time keeps its plugins. Each plugin is a directory named
after its id, holding that plugin's source:

    jira/      the JIRA board, and the timer
    claude/    which Claude Code sessions are open, and which one is waiting on you

j-time installs the two it ships with here on first launch, as worked examples.
They are copies: the app is built from the same files, so editing a copy changes
nothing until the change is built into the app (see *Building it in*, below).
Delete a copy and the next launch writes a fresh one. This guide is rewritten on
every launch, so change it in the j-time repository rather than here.

## What a plugin is

A plugin has two halves and a shared middle, laid out the way the app's own
`src/` tree is:

    <id>/
      plugin.json          id and title
      main/index.ts        runs in Electron's main process: fetching, credentials, writes
      renderer/view.tsx    runs in the palette: turns a snapshot into rows
      shared/<id>.ts       the snapshot type and any pure logic, used by both halves and by the tests

- **main** owns everything the plugin knows — its config, its service client,
  its state — and is the only thing that writes. It exports a `MainPlugin`; the
  contract is `src/main/plugin.ts` in the repository.
- **renderer** draws. It exports a `PluginView` (`src/shared/plugin.ts`) and
  never talks to a service or touches disk: it renders a snapshot and sends
  intents back.
- **shared** is imported by both sides and by the tests, so nothing in it may
  import `electron`.

The seam between the halves is a snapshot going one way and commands going the
other: `window.jt.invoke('<id>', 'name', [args])`. The arguments are untyped at
that seam on purpose, so each plugin wraps its own commands in a small typed
client — `renderer/client.ts` in both examples.

## Rules the shell relies on

- **Rows are data, not markup.** A row's `lead` is a meaning — `attention`,
  `active`, `ok`, `blocked`, `muted` — and an accessory is a `Badge`. One
  component decides what a meaning looks like, so two plugins wanting your
  attention look the same. `screen()` and `settings()` are the only places a
  plugin returns React, because a full screen answers to nothing else on the
  page.
- **Ordering is pure logic and lives in `shared/`, with tests.** The view only
  maps what `shared/` returns onto rows. `board.ts` (jira) and `claude.ts`
  (claude) are the examples; `npm test` runs anything named `*.test.ts` there.
- **Secrets are declared.** List credential fields in `secrets` and the store
  encrypts them. They never reach the renderer: the snapshot's public config
  replaces a token with `hasToken`.
- **`configured()` false means "not set up", not "broken".** The shell skips the
  fetch and says so on the section header instead of painting an error.
- **A fetch in flight, or one that fails, leaves the previous rows on screen.**
  The shell does that for you; return the error from `refresh` and keep your
  rows.
- **A row action's `shortcut` must be a letter the app menu doesn't own.** ⌘H
  hides, ⌘Q quits, ⌘W closes, and ⌘C, ⌘V, ⌘X, ⌘A are the Edit roles. The claude
  plugin uses ⌘D and ⌘E for exactly this reason.
- **At most one row per plugin is pinned**, and the user can turn a plugin's
  pinning off in Settings.
- **Timer-style actions must not depend on the network.** Anything that only
  touches local state should keep working when the service is down.

## A minimal plugin

`shared/hello.ts`:

```ts
export interface HelloSnapshot {
  greeting: string;
}
```

`main/index.ts`:

```ts
import type { HelloSnapshot } from '@shared/hello';
import type { MainPlugin, PluginHost } from '../../plugin';

interface HelloConfig {
  name: string;
}

let host: PluginHost;
let config: HelloConfig = { name: '' };
let greeting = '';

export const plugin: MainPlugin<HelloSnapshot, HelloConfig> = {
  id: 'hello',
  title: 'Hello',
  secrets: [],
  refreshMs: 60_000,
  defaults: () => ({ name: 'world' }),
  init: (h) => {
    host = h;
  },
  configure: (next) => {
    config = next;
  },
  configured: () => config.name !== '',
  snapshot: () => ({ greeting }),
  async refresh() {
    greeting = `Hello, ${config.name}`;
    host.changed();
    return { ok: true };
  },
  commands: {
    wave: () => ({ ok: true, message: 'Waved' }),
  },
};
```

`renderer/view.tsx`:

```tsx
import type { PluginView } from '@shared/plugin';
import type { HelloSnapshot } from '@shared/hello';

export const helloView: PluginView<HelloSnapshot> = {
  id: 'hello',
  title: 'Hello',
  section: (snapshot, ctx) => ({
    rows: [
      {
        id: 'greeting',
        title: snapshot.greeting || 'Nobody to greet yet',
        lead: 'dot',
        enterLabel: 'Wave',
        run: () => ctx.act(() => window.jt.invoke('hello', 'wave')),
      },
    ],
  }),
};
```

`Ctx` is what every row builder is handed: `act` runs a command and closes the
palette on success, `actStay` leaves it open, `push` opens a picker of more
rows, `open` shows one of the plugin's own screens, `openSettings` its form.

## Building it in

j-time does not load plugins from this folder at runtime. A row carries
closures, and a closure can't cross the bridge between the main process and the
palette — so a plugin is compiled into the app. Once yours takes shape here,
copy it into a checkout of the repository
(https://github.com/rustybucket-cloud/j-time) and register it with four edits:

1. The directory itself:
   `main/` → `src/main/plugins/<id>/`,
   `renderer/` → `src/renderer/plugins/<id>/`,
   `shared/` → `src/shared/`.
2. `src/main/plugins/index.ts` — add the plugin to `PLUGINS`.
3. `src/renderer/plugins/index.ts` — add the view to `VIEWS`.
4. `src/shared/ipc.ts` — add a line for its snapshot to `PluginSnapshots`. That
   line is deliberate friction: plugins are compiled in, so there is no reason
   to give up knowing their shapes.

Then:

```bash
npm run typecheck   # both halves
npm test            # the pure logic in shared/
npm run dev         # the app with renderer hot reload
npm run build       # typecheck, then bundle into out/
```

The new section appears at the bottom of the arrangement in Settings, where it
can be moved, collapsed, or have its pin switched off like any other.
