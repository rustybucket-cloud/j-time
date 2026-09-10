# j-time

A menu-bar JIRA timer with a Raycast-style command palette. Press a hotkey, see
what you're in the middle of, put the clock on one of them, and file the time
against JIRA without leaving the keyboard.

![The palette](docs/images/palette.png)

## Download

Grab the latest `.dmg` from the [Releases page](https://github.com/rustybucket-cloud/j-time/releases)
— `arm64` for Apple silicon, `x64` for Intel. Open it and drag **j-time** to
Applications.

### The first launch

The build is unsigned — signing it needs a paid Apple Developer account — so
macOS blocks it once before it will ever run. What you'll see is a dialog saying
j-time "is damaged" or "cannot be opened because Apple cannot check it for
malicious software". Nothing is damaged; that's the wording for *no signature*.

**On macOS Sequoia (15) and later**, including Tahoe (26):

1. Double-click **j-time**. Dismiss the dialog it throws.
2. Open **System Settings → Privacy & Security** and scroll to the bottom. There's
   a line about j-time being blocked, with an **Open Anyway** button. Click it.
3. Confirm with Touch ID or your password, then **Open** in the last dialog.

Sequoia removed the old Control-click shortcut, so step 2 is not optional there.

**On Sonoma (14) and earlier**, the shorter dance still works: right-click (or
Control-click) the app in Applications, choose **Open**, then **Open** again in
the dialog that appears.

**Either version**, from a terminal, in one line:

```bash
xattr -dr com.apple.quarantine /Applications/j-time.app
```

That strips the quarantine flag macOS attaches to downloads, and the app opens
normally from then on.

You only do this once per install — but a new release is a new download, so
each upgrade asks again.

There's no window and no Dock icon — it lives in the menu bar. Press `⌘⇧J`.

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
| `⌘Q` | Quit |
| `⎋` or `⌫` | Back one level, then close |

The button at the bottom-left of the palette opens the app's own menu — Settings,
refresh, JIRA in a browser, and quitting. With no Dock icon and no application
menu, that button and the menu bar item are the only ways out that don't need a
keystroke.

The menu bar ticks whenever the clock is running. Right-click it for stop, file
and refresh.

**Start** opens a segment. **Stop** closes it and leaves it unfiled. **Filing**
it under an activity posts a worklog to JIRA immediately, at the chunk's exact
length. **Finish** sweeps anything still unfiled, then moves the status.

Time is measured, never estimated — an idle window accrues nothing.

## Where your data lives

`~/.j-time/` — `config.json` and `state.json`, both written `0600`. The API
token is encrypted with your login keychain before it touches disk.
