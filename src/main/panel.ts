/**
 * The palette window: a frameless, always-on-top panel that appears under the
 * cursor's display and disappears the moment it loses focus.
 *
 * It is created once at launch and only ever hidden, never closed. Building it on
 * each hotkey press costs a visible beat of white while the renderer boots, which
 * is the whole difference between a launcher and a window.
 */

import { join } from 'path';
import { BrowserWindow, app, screen, shell } from 'electron';
import * as data from './data';

const WIDTH = 720;
/** Just the search field. The renderer reports its real height once it has drawn. */
const INITIAL_HEIGHT = 64;
/** Where the top edge sits, as a fraction of the screen's working area. */
const TOP_FRACTION = 0.16;

let panel: BrowserWindow | null = null;
let quitting = false;
let dismissOnBlur = true;

/**
 * Whether losing focus should dismiss the panel.
 *
 * Off while Settings is open. Pasting an API token means switching to a browser
 * to copy it, and blur-to-hide threw away the URL and email you'd already typed
 * every single time you did.
 */
export function setDismissOnBlur(value: boolean): void {
  dismissOnBlur = value;
}

/** Let the panel actually close once the app is on its way out. */
export function beginQuit(): void {
  quitting = true;
}

export function getPanel(): BrowserWindow | null {
  return panel;
}

/** Centre horizontally on whichever display holds the cursor, near the top. */
function place(win: BrowserWindow, height: number): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height * TOP_FRACTION),
    width: WIDTH,
    height,
  });
}

export function createPanel(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: INITIAL_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    // Real blur needs the OS; CSS backdrop-filter can't see the desktop behind a
    // transparent window. The panel's own background is opaque enough to read
    // even where vibrancy isn't available.
    vibrancy: 'under-window',
    visualEffectState: 'active',
    useContentSize: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Nothing here is remote, and a spellcheck underline in a command palette
      // is noise.
      spellcheck: false,
    },
  });

  win.setWindowButtonVisibility?.(false);
  // Above fullscreen apps and on every Space, so the hotkey means the same thing
  // wherever you are.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');

  // The panel is created once and only ever hidden. Anything that would destroy
  // it — a stray ⌘W, a script — leaves the hotkey pressing on nothing.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hidePanel();
  });

  // Losing focus is the dismissal gesture. Suppressed while devtools are open,
  // or clicking into them would close the thing you're inspecting.
  win.on('blur', () => {
    if (!dismissOnBlur) return;
    if (win.webContents.isDevToolsOpened()) return;
    hidePanel();
  });

  // A link in an issue belongs in the browser, not in a 720px chrome-less window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  panel = win;
  return win;
}

export function showPanel(): void {
  if (!panel) return;
  // Cheap when the 60-second poll has already been round recently, and the
  // difference between a launcher and a dashboard is that a launcher is current.
  data.refreshIfStale();
  place(panel, panel.getBounds().height);
  panel.show();
  panel.focus();
  // The renderer clears the query and drops the selection back to the first row:
  // a launcher that reopens holding last time's search is a launcher you have to
  // clear before you can use.
  panel.webContents.send('palette:opened');
}

export function hidePanel(): void {
  if (!panel || !panel.isVisible()) return;
  panel.hide();
  // Hand focus back to whatever you were doing, rather than leaving a hidden
  // agent app frontmost.
  if (process.platform === 'darwin') app.hide();
}

export function togglePanel(): void {
  if (panel?.isVisible()) hidePanel();
  else showPanel();
}

/**
 * Grow or shrink to fit the list, keeping the top edge where it is — a panel that
 * re-centres itself on every keystroke is unusable.
 */
export function setPanelHeight(height: number): void {
  if (!panel) return;
  const clamped = Math.max(INITIAL_HEIGHT, Math.min(Math.round(height), 640));
  const bounds = panel.getBounds();
  if (bounds.height === clamped) return;
  panel.setBounds({ ...bounds, height: clamped });
}
