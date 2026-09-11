# Writing a j-time plugin

This folder is where j-time loads plugins from. A plugin is a directory named
for its id, with a `main.js` inside:

    ~/.j-time/plugins/
      AGENTS.md          this guide (CLAUDE.md is the same text)
      bookmarks/
        main.js          an example, installed on first launch — open it first

Every directory here that has a `main.js` becomes a section of the palette.
Plugins load when the app starts, and **Reload plugins** in the palette (type
"reload", or ⌘K on the j-time section) picks up new folders and edits without
restarting. A file that fails to load still gets a section, with the error on
its header, so a typo is never silent.

This guide is rewritten by the app on launch; the `bookmarks` folder is written
only if it is missing, so delete it to get a fresh copy.

## What main.js is

A CommonJS module — `module.exports = { … }` — that runs in the app's main
process. That means Node and Electron are both there: `require('fs')`,
`require('electron').clipboard`, `fetch`, `child_process`. It runs with the
app's full privileges, so only load plugins you have read.

The plugin never draws anything. It returns **rows as data** and names
**commands** the rows can run; the app renders the rows exactly the way it
renders its built-in sections, so every plugin gets the same keys, the same
search, the same pinning and the same look.

```js
module.exports = {
  title: 'Weather',                  // section name; the folder name is the id
  refreshMs: 300000,                 // poll interval; 0 = only when opened

  fields: [                          // the settings form, drawn by the app
    { key: 'city', label: 'City', placeholder: 'Oslo' },
    { key: 'token', label: 'API token', secret: true },
  ],
  defaults: () => ({ city: '' }),
  configured: (config) => Boolean(config.city && config.token),

  async refresh(config, host) {      // what is on screen
    const r = await fetch(`https://example.test/${config.city}?key=${config.token}`);
    const data = await r.json();
    return {
      rows: [
        {
          id: 'now',
          title: `${data.temp}° in ${config.city}`,
          subtitle: data.summary,
          lead: data.alert ? 'attention' : 'dot',
          badges: [{ text: data.wind, kind: 'pill' }],
          run: { url: data.link },
          actions: [
            { id: 'copy', title: 'Copy summary', run: { command: 'copy', args: [data.summary] }, shortcut: 'l' },
          ],
        },
      ],
      menuBar: data.alert ? { title: '⚠', tooltip: data.alert } : null,
    };
  },

  commands: {                        // what rows can name
    copy: ([text], host, config) => {
      require('electron').clipboard.writeText(text);
      return 'Copied';
    },
  },
};
```

## The contract

| Export | | |
|---|---|---|
| `title` | string | Section name. Defaults to the folder name. |
| `refreshMs` | number | How often `refresh` runs. Default 60000; minimum 2000; 0 never polls, but the palette opening still refreshes anything older than 15 seconds. |
| `fields` | array | The settings form. See *Settings* below. |
| `defaults()` | → object | Config for a fresh install. |
| `configured(config)` | → boolean | False shows **Not set up** on the header and skips `refresh`. Default true. |
| `configure(config, host)` | | Called at startup and after every save, before the next refresh. Optional. |
| `refresh(config, host)` | → content | Required. Return `{ rows, actions?, menuBar? }`, or just an array of rows. May be async. Throwing puts the message on the section header and leaves the previous rows up. |
| `commands` | object | Functions rows can name: `(args, host, config)`. Return a string for a toast, `{ ok: false, error }` to complain, or nothing. |
| `tools` | array | What this plugin puts on j-time's MCP endpoint. See *MCP tools* below. |

`host` is `{ dir, refresh }`: `dir` is the plugin's own folder, for anything it
wants to keep; `refresh()` asks the app to run `refresh` again now, which is
what a command does after it changes something.

## Rows

A row needs an `id` (unique within the plugin, stable across refreshes so the
cursor can follow it) and a `title`. Everything else is optional:

| Field | |
|---|---|
| `subtitle` | Grey text after the title. |
| `keywords` | Extra words that match a search but aren't shown. |
| `subsection` | Groups rows under a small heading inside the section. |
| `lead` | The mark before the title, by meaning: `dot`, `active`, `attention`, `ok`, `blocked`, `muted`, `none`. The app picks the colour. |
| `badges` | Chips after the title: `{ text, kind?: 'pill' \| 'clock' \| 'key', tone?: 'plain' \| 'accent' \| 'warn' \| 'danger' }`. |
| `live` | Draws the row as running. |
| `pin` | Lifts the row above every section. One per plugin is honoured, and the user can turn it off. |
| `enterLabel` | What the footer calls Enter. |
| `run` | What Enter does: `{ command, args?, stay? }` runs a command (`stay: true` keeps the palette open), `{ url }` opens a link. |
| `actions` | Rows for ⌘K. Each may carry a `shortcut` letter for ⌘-letter. One level deep. |

Anything that isn't the right shape is dropped — a bad badge costs the badge,
not the row.

`content.actions` are the section's own commands (⌘K on the header); the app
adds **Refresh** and **Configure…** to them. `content.menuBar` is
`{ title, tooltip? }` for the menu bar, and only shows if no earlier plugin —
the JIRA clock, say — already has it.

## Settings

Each entry in `fields` is one input on a form the app draws:

```js
{ key: 'token', label: 'API token', type: 'text' | 'password' | 'number' | 'textarea',
  secret: true, placeholder: '…', note: 'Shown under the input.' }
```

A `secret` field is encrypted on disk and never sent to the form; the form
shows whether one is set, and leaving it blank keeps the stored one. Numbers
arrive in `config` as numbers. Config lives in `~/.j-time/config.json` under
the plugin's id.

## MCP tools

j-time serves an MCP endpoint on localhost, and every plugin's `tools` appear on
it. That is how Claude Code — or any MCP client — reads your section and acts on
it without a keystroke. The endpoint, and a switch for each tool, are on the
**MCP server** page — type "mcp" in the palette. Yours arrive switched on.

```js
tools: [
  {
    name: 'search',                    // lowercase and underscores; served as bookmarks_search
    description: 'Search the saved bookmarks by name or host.',
    input: { q: { type: 'string', description: 'Part of a name or hostname.' } },
    required: ['q'],
    readOnly: true,                    // reads only; a client may skip asking permission
    // destructive: true,              // writes something worth being asked about
    run: ({ q }, host, config) => `…text the caller reads…`,
  },
]
```

| Field | |
|---|---|
| `name` | Lowercase letters, digits and underscores. The app prefixes it with your plugin id, so `search` in `bookmarks/` is called `bookmarks_search`. |
| `description` | The only thing the caller has to go on. Say what it returns and when to use it, not just what it is called. |
| `input` | JSON Schema per argument — `{ type, description }` is usually enough. The app builds the object schema around them. |
| `required` | Which of those must be present. Names not in `input` are dropped. |
| `readOnly` / `destructive` | Hints a client may surface when asking the user for approval. |
| `run(args, host, config)` | Same `host` and `config` as a command. Return a string (the text the caller reads), `{ ok: false, error }`, or any other value — which is sent as JSON. May be async. |

A tool is not a command with a different name: the caller cannot see the palette,
so its arguments are **named** rather than positional, and its answer is prose
rather than a toast. Write the text for somebody who has never seen your section
— name the thing, its state, and the units.

**The user can switch any of your tools off** on the **MCP server** page (type
"mcp" in the palette), and a tool switched off is not offered to a client at
all. So don't write one tool that only works if another was called first; each
should stand on its own.

Anything malformed is dropped, one tool at a time: a bad name costs that tool and
nothing else. A tool with no `run` is not served at all. The names actually being
served show up on your plugin's own settings screen.

## Rules worth knowing

- **Shortcut letters the app menu owns don't reach you**: ⌘H hides, ⌘Q quits,
  ⌘W closes, and ⌘C, ⌘V, ⌘X, ⌘A are the Edit roles. ⌘R and ⌘K are the palette's.
- **A fetch that fails keeps the last rows on screen.** Throw, or return
  `{ ok: false, error }` from a command; don't return an empty list to signal a
  problem.
- **Keep `refresh` cheap** at the interval you chose. It also runs when the
  palette opens.
- **Ids are stable, not indexes.** The cursor and pinning follow ids.

## Built-in plugins

JIRA and Claude Code are compiled into the app rather than loaded from here:
they have screens and pickers the data-only contract doesn't cover. Their source
is in the repository under `src/main/plugins` and `src/renderer/plugins`, and
`src/shared/runtime.ts` there is the exact contract this guide describes.
