/**
 * The menu bar item: whatever a plugin wants to say, and the small set of
 * actions worth having without opening the palette.
 *
 * It no longer knows that the thing in the title is a clock. A plugin returns a
 * `MenuBarState` or nothing, and the first one with something to say gets the
 * title — which is what lets the running timer keep the behaviour it had while
 * leaving the slot open to whatever comes next.
 */

import { Menu, Tray, nativeImage, app } from 'electron';
import * as shell from './shell';
import { showPanel } from './panel';

let tray: Tray | null = null;
let tick: NodeJS.Timeout | null = null;

/** Variation selector 15 keeps this monochrome rather than a colour emoji. */
const IDLE_TITLE = '⏱︎';

function render(): void {
  if (!tray) return;
  const state = shell.menuBar();

  if (state) {
    tray.setTitle(state.title);
    tray.setToolTip(state.tooltip);
  } else {
    // A glyph rather than an empty title, so the item stays clickable and stays
    // in the same place in the menu bar whether or not anything is running.
    tray.setTitle(IDLE_TITLE);
    tray.setToolTip('j-time — nothing running');
  }
}

function buildMenu(): Menu {
  const plugin = shell.trayMenu();
  return Menu.buildFromTemplate([
    ...plugin,
    { type: 'separator' },
    { label: 'Open j-time', accelerator: shell.shellConfig().hotkey, click: showPanel },
    { label: 'Refresh everything', click: () => void shell.refreshAll() },
    { type: 'separator' },
    { label: 'Quit j-time', click: () => app.quit() },
  ]);
}

export function createTray(): Tray {
  // No icon asset: on macOS a title-only item reads as native, and an emoji or a
  // badly-scaled PNG next to the system items reads as neither.
  tray = new Tray(nativeImage.createEmpty());
  tray.on('click', showPanel);
  tray.on('right-click', () => tray?.popUpContextMenu(buildMenu()));
  render();

  // Only ticks while some plugin says its title changes on its own; idle costs
  // nothing.
  shell.events.on('change', () => {
    render();
    const shouldTick = shell.menuBar()?.live ?? false;
    if (shouldTick && !tick) tick = setInterval(render, 1000);
    if (!shouldTick && tick) {
      clearInterval(tick);
      tick = null;
    }
  });

  return tray;
}

export function destroyTray(): void {
  if (tick) clearInterval(tick);
  tick = null;
  tray?.destroy();
  tray = null;
}
