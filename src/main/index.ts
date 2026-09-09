/**
 * App lifecycle. j-time is a menu bar agent: no dock icon, no window in the
 * window list, and closing the palette never quits it — the clock has to keep
 * running when nothing is on screen.
 */

import { promises as fs } from 'fs';
import { app, globalShortcut } from 'electron';
import { DEFAULT_HOTKEY, missingCreds } from '@shared/conn';
import * as data from './data';
import { registerIpc } from './ipc';
import { beginQuit, createPanel, getPanel, showPanel, togglePanel } from './panel';
import { createTray, destroyTray } from './tray';
import { installMenu } from './menu';

let poll: NodeJS.Timeout | null = null;

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
  data.setHotkeyRegistered(ok);
}

// A second copy would be a second writer on state.json and a second menu bar
// item. The first instance takes the hotkey press instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showPanel);

  void app.whenReady().then(async () => {
    app.dock?.hide();

    installMenu();
    registerIpc();
    createPanel();
    createTray();

    await data.load();
    bindHotkey(data.currentConfig().hotkey);
    data.events.on('config', (config) => bindHotkey(config.hotkey));

    void data.refresh();
    poll = data.startPolling();

    // With no credentials there is nothing to show and no reason to expect the
    // user to guess the hotkey, so the first launch opens itself.
    if (missingCreds(data.currentConfig()).length > 0) showPanel();

    if (process.env.JT_CAPTURE) void capture(process.env.JT_CAPTURE);
  });

  // Hiding the palette must not quit: the whole app is the clock in the menu bar.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', beginQuit);

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (poll) clearInterval(poll);
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
  await new Promise((r) => setTimeout(r, 1800));

  // JT_CAPTURE_KEYS drives the palette first, so the screens you can only reach by
  // typing are reviewable too: "cmd+k" for the action list, "cmd+," for Settings.
  for (const chord of (process.env.JT_CAPTURE_KEYS ?? '').split(',').filter(Boolean)) {
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
  // never settles — so show it again and never wait on it forever.
  showPanel();
  await new Promise((r) => setTimeout(r, 300));
  const image = await Promise.race([
    panel.webContents.capturePage(),
    new Promise<null>((r) => setTimeout(() => r(null), 4000)),
  ]);
  if (image) await fs.writeFile(file, image.toPNG());
  app.quit();
}
