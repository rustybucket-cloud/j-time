# j-time

A menu-bar JIRA timer with a Raycast-style command palette. Press a hotkey, see
what you're in the middle of, put the clock on one of them, and file the time
against JIRA without leaving the keyboard.

![The palette](docs/images/palette.png)

## Download

Grab the latest `.dmg` from the [Releases page](https://github.com/rustybucket-cloud/j-time/releases)
— `arm64` for Apple silicon, `x64` for Intel. Open it and drag **j-time** to
Applications.

The build is unsigned, so the first launch needs one extra step: right-click the
app and choose **Open**, then **Open** again in the dialog. (Or clear the
quarantine flag: `xattr -dr com.apple.quarantine /Applications/j-time.app`.)

There's no window in the Dock — it lives in the menu bar. Press `⌘⇧J`.

## Build it yourself

```bash
npm install
npm run build
npm start
```

## Set up

The first launch opens straight to Settings. You need three things:

- your JIRA URL, e.g. `https://your-org.atlassian.net`
- the email on the account
- an API token from **id.atlassian.com → Security → API tokens**

Also configurable there: the activity labels you file time under, the rounding
increment, and the hotkey.

Atlassian API token is stored encrypted with Electron's safeStorage.

## Use it

Press `⌘⇧J` for the palette. In Progress leads; the running story is pinned to
the top with a live clock.

| Key | |
|---|---|
| `⌘⇧J` | Show or hide the palette |
| `↩` | Start or stop the clock on the selected story |
| `⌘K` | Every action for the selected story |
| `⌘F` | File its unfiled time under an activity |
| `⌘D` | Finish it — sweep any unfiled time, then transition |
| `⌘I` | Clock, activity breakdown, estimate |
| `⌘O` / `⌘C` | Open in JIRA / copy the key |
| `⌘R` / `⌘,` | Refresh the board / Settings |
| `⎋` or `⌫` | Back one level, then close |

The menu bar ticks whenever the clock is running. Right-click it for stop, file
and refresh.

**Start** opens a segment. **Stop** closes it and leaves it unfiled. **Filing**
it under an activity posts a worklog to JIRA immediately, at the chunk's exact
length. **Finish** sweeps anything still unfiled, then moves the status.

Time is measured, never estimated — an idle window accrues nothing.

## Where your data lives

`~/.j-time/` — `config.json` and `state.json`, both written `0600`. The API
token is encrypted with your login keychain before it touches disk.
