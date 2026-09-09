/**
 * A deliberately tiny application menu.
 *
 * Electron installs a default menu when you don't, and its Window submenu binds
 * ⌘W to *close* — which would destroy a panel this app only ever hides and
 * recreates never, leaving the hotkey pressing on a window that isn't there.
 *
 * Setting it to null instead would take the Edit roles with it, and on macOS the
 * clipboard shortcuts in a text field are those roles: without them you cannot
 * paste an API token into Settings. So the menu keeps exactly that, and nothing
 * that can close or resize anything.
 */

import { Menu, app } from 'electron';

export function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [{ role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ]),
  );
}
