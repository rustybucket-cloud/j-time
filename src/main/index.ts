/**
 * App lifecycle. j-time is a menu bar agent: no dock icon, no window in the
 * window list, and closing the palette never quits it — the clock has to keep
 * running when nothing is on screen.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { app, globalShortcut } from 'electron';
import { DEFAULT_HOTKEY } from '@shared/shell';
import * as shell from './shell';
import { PLUGINS } from './plugins';
import { installPluginsDir } from './plugins/install';
import { mountRuntimePlugins } from './runtime';
import { registerIpc } from './ipc';
import { startMcp, stopMcp } from './mcp';
import { refreshHarnesses } from './harness';
import { beginQuit, createPanel, getPanel, showPanel, togglePanel } from './panel';
import { createTray, destroyTray } from './tray';
import { installMenu } from './menu';

/**
 * Bind the palette hotkey, reporting rather than throwing when it's taken.
 *
 * `register` returns false when another app already owns the combination. Left
 * silent that reads as a broken app, since the only symptom is a keystroke doing
 * nothing — so it's surfaced in Settings instead.
 */
function bindHotkey(accelerator: string): void {
  globalShortcut.unregisterAll();
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, togglePanel);
  } catch {
    ok = false;
  }
  // Never leave the app with no way in: fall back to the default, which is at
  // least documented, before giving up.
  if (!ok && accelerator !== DEFAULT_HOTKEY) {
    try {
      ok = globalShortcut.register(DEFAULT_HOTKEY, togglePanel);
    } catch {
      ok = false;
    }
  }
  shell.setHotkeyRegistered(ok);
}

/**
 * A sandbox run gets its own Chromium profile as well as its own state.
 *
 * The single-instance lock is keyed on `userData`, so without this a sandbox
 * launched while the real j-time is running loses the lock and quits on the
 * spot — no window, no request, and `scripts/sandbox.sh` still printing `wrote
 * …`. Which is exactly the symptom you'd least expect to be about a lock.
 */
if (process.env.JT_HOME) {
  app.setPath('userData', path.join(path.resolve(process.env.JT_HOME), 'chromium'));
}

/**
 * What the endpoint is currently on, so a save that didn't touch it is free.
 *
 * Only the two things that need a socket. Switching a tool off changes what
 * `tools/list` answers, not what is listening.
 */
let served = { enabled: false, port: 0 };

// A second copy would be a second writer on state.json and a second menu bar
// item. The first instance takes the hotkey press instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showPanel);

  void app.whenReady().then(async () => {
    app.dock?.hide();

    installMenu();
    for (const plugin of PLUGINS) shell.register(plugin);
    // The directory is seeded before it is read, so a first launch shows the
    // example plugin; and both happen before the config is read, so a plugin's
    // secrets are known to the store when it decrypts.
    await installPluginsDir();
    await mountRuntimePlugins();
    registerIpc();
    createPanel();
    createTray();

    await shell.load();
    bindHotkey(shell.shellConfig().hotkey);
    served = { enabled: shell.mcpConfig().enabled, port: shell.mcpConfig().port };
    void startMcp(shell.mcpConfig());
    void refreshHarnesses();
    shell.events.on('shell-config', (config) => {
      bindHotkey(config.hotkey);
      // Only when the endpoint itself changed: every settings save comes through
      // here, and restarting the server each time would drop a client's
      // connection to save a hotkey.
      const mcp = shell.mcpConfig();
      if (mcp.enabled !== served.enabled || mcp.port !== served.port) {
        served = { enabled: mcp.enabled, port: mcp.port };
        void startMcp(mcp);
        // A moved port makes a registration at the old one stale, and the page
        // has to stop claiming a client is set up when it is pointed elsewhere.
        void refreshHarnesses();
      }
    });

    void shell.refreshAll();
    shell.startPolling();

    // Launch opens the panel: a menu-bar app that starts silently looks like it
    // failed to start, and with no credentials there is nothing to show anyway
    // and no reason to expect the user to guess the hotkey.
    showPanel();

    if (process.env.JT_CAPTURE) void capture(process.env.JT_CAPTURE);
  });

  // Hiding the palette must not quit: the whole app is the clock in the menu bar.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', beginQuit);

  app.on('will-quit', () => {
    void stopMcp();
    globalShortcut.unregisterAll();
    shell.stopPolling();
    destroyTray();
  });
}

/**
 * Development affordance: `JT_CAPTURE=path.png` shows the panel, saves a picture
 * of it and quits.
 *
 * A borderless always-on-top overlay is exactly the kind of window that a normal
 * screenshot tool can't be pointed at reliably, and the palette is the whole
 * product — so it needs to be reviewable without a human at the keyboard.
 */
async function capture(file: string): Promise<void> {
  showPanel();
  const panel = getPanel();
  if (!panel) return app.quit();
  // JT_CAPTURE_DELAY buys more time for a plugin that is slower than a fetch —
  // a shot taken mid-refresh looks exactly like a short list.
  const settle = Number(process.env.JT_CAPTURE_DELAY) || 1800;
  await new Promise((r) => setTimeout(r, settle));

  // JT_CAPTURE_KEYS drives the palette first, so the screens you can only reach by
  // typing are reviewable too: "cmd+k" for the action list, "cmd+," for Settings.
  for (const chord of (process.env.JT_CAPTURE_KEYS ?? '').split(',').filter(Boolean)) {
    // "click:x:y" for the things only a pointer can reach — colons, so the list
    // stays comma-separated. `modifiers` matters here for the same reason it does
    // below: omitting it drops the event, which looks exactly like a click that
    // missed the row.
    if (chord.startsWith('click:')) {
      const [x, y] = chord.slice(6).split(':').map(Number);
      const at = { x, y, button: 'left', clickCount: 1, modifiers: [] };
      panel.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers: [] } as never);
      panel.webContents.sendInputEvent({ type: 'mouseDown', ...at } as never);
      panel.webContents.sendInputEvent({ type: 'mouseUp', ...at } as never);
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    // "scroll:x:y:ticks" for a page taller than the panel — a settings screen
    // with a plugin's worth of rows on it can't be reviewed any other way, and
    // the arrows belong to the search field rather than to the scroller.
    if (chord.startsWith('scroll:')) {
      const [x, y, ticks] = chord.slice(7).split(':').map(Number);
      panel.webContents.sendInputEvent({
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY: -(ticks || 3) * 40,
        canScroll: true,
        modifiers: [],
      } as never);
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const parts = chord.split('+').map((p) => p.trim().toLowerCase());
    const keyCode = parts.pop() ?? '';
    const modifiers = parts.map((m) => (m === 'cmd' ? 'meta' : m));
    // A chord needs rawKeyDown — a plain keyDown is eaten looking for a menu
    // accelerator. Typing needs keyDown followed by char, and rawKeyDown drops
    // the char, so the two cases genuinely differ.
    // rawKeyDown throughout: a plain keyDown is eaten looking for a menu
    // accelerator. `modifiers` must be present even when empty — omitting it
    // silently drops the event.
    panel.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode, modifiers } as never);
    // Named keys like "Enter" have no character; sending one types the word.
    if (modifiers.length === 0 && keyCode.length === 1) {
      panel.webContents.sendInputEvent({ type: 'char', keyCode, modifiers } as never);
    }
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers } as never);
    await new Promise((r) => setTimeout(r, 500));
  }

  // An action that succeeds hides the panel, and capturePage on a hidden window
  // never settles — so show it again and never wait on it forever. Only if it
  // really is hidden, though: showPanel broadcasts `palette:opened`, and the
  // renderer resets on it, which would throw away the screen the keys just
  // reached.
  if (!panel.isVisible()) showPanel();
  await new Promise((r) => setTimeout(r, 300));
  const image = await Promise.race([
    panel.webContents.capturePage(),
    new Promise<null>((r) => setTimeout(() => r(null), 4000)),
  ]);
  if (image) await fs.writeFile(file, image.toPNG());
  app.quit();
}
