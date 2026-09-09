/**
 * The menu bar item: a live clock while something is running, and the small set
 * of actions worth having without opening the palette.
 *
 * The title is the whole point. A timer you have to open something to check is a
 * timer you forget is running, which is how tracked time stops matching reality.
 */

import { Menu, Tray, nativeImage, app } from 'electron';
import { activeSeconds, formatBar } from '@shared/time';
import * as data from './data';
import { showPanel } from './panel';

let tray: Tray | null = null;
let tick: NodeJS.Timeout | null = null;

/** Variation selector 15 keeps this monochrome rather than a colour emoji. */
const IDLE_TITLE = '⏱︎';

function elapsedSeconds(): number | null {
  const run = data.running();
  if (!run) return null;
  const story = data.currentState().stories[run.key];
  return story ? activeSeconds(story.segments, Date.now()) : 0;
}

function render(): void {
  if (!tray) return;
  const run = data.running();
  const seconds = elapsedSeconds();

  if (run && seconds !== null) {
    tray.setTitle(`▶ ${formatBar(seconds)}`);
    tray.setToolTip(`${run.key} — ${run.summary}`);
  } else {
    // A glyph rather than an empty title, so the item stays clickable and stays
    // in the same place in the menu bar whether or not the clock is running.
    tray.setTitle(IDLE_TITLE);
    tray.setToolTip('j-time — nothing running');
  }
}

function buildMenu(): Menu {
  const run = data.running();
  const config = data.currentConfig();
  const activities = config.activities;

  const header = run
    ? [
        { label: `${run.key} — ${run.summary}`.slice(0, 60), enabled: false },
        { type: 'separator' as const },
        { label: 'Stop timer', click: () => void data.stop() },
        {
          label: 'Stop and file as',
          enabled: activities.length > 0,
          submenu: activities.map((activity) => ({
            label: activity,
            click: () => void data.fileTime(run.key, activity),
          })),
        },
        { type: 'separator' as const },
      ]
    : [{ label: 'Nothing running', enabled: false }, { type: 'separator' as const }];

  return Menu.buildFromTemplate([
    ...header,
    { label: 'Open j-time', accelerator: config.hotkey, click: showPanel },
    { label: 'Refresh board', click: () => void data.refresh() },
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

  // Only ticks while a segment is open; idle costs nothing.
  data.events.on('change', () => {
    render();
    const shouldTick = data.running() !== null;
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
