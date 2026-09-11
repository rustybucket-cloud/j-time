/**
 * The bridge's server half. Every channel is a thin call into the shell registry,
 * which owns the ordering and the persistence — nothing here decides anything.
 */

import { BrowserWindow, clipboard, ipcMain, shell as electronShell, app } from 'electron';
import type { LayoutState } from '@shared/layout';
import type { ShellConfig } from '@shared/shell';
import * as shell from './shell';
import { hidePanel, setDismissOnBlur, setPanelHeight } from './panel';
import { reloadRuntimePlugins } from './runtime';
import { setHarness } from './harness';

export function registerIpc(): void {
  ipcMain.handle('snapshot', () => shell.snapshot());
  ipcMain.handle('refresh', (_e, plugin?: string) =>
    plugin ? shell.refreshPlugin(plugin) : shell.refreshAll(),
  );

  ipcMain.handle('reloadPlugins', () => reloadRuntimePlugins());

  ipcMain.handle('invoke', (_e, plugin: string, command: string, args: unknown[] = []) =>
    shell.invoke(plugin, command, args),
  );
  ipcMain.handle('query', (_e, plugin: string, name: string, args: unknown[] = []) =>
    shell.query(plugin, name, args),
  );

  ipcMain.handle('savePluginConfig', (_e, plugin: string, patch: Record<string, unknown>) =>
    shell.savePluginConfig(plugin, patch),
  );
  ipcMain.handle('saveShellConfig', (_e, patch: Partial<ShellConfig>) =>
    shell.saveShellConfig(patch),
  );
  ipcMain.handle('setHarness', (_e, id: string, install: boolean) => setHarness(id, install));
  ipcMain.handle('saveLayout', (_e, layout: LayoutState) => shell.saveLayout(layout));

  ipcMain.handle('openUrl', (_e, url: string) => {
    // Only the palette's own links come through here, but openExternal hands
    // whatever it is given to the OS — so a non-web scheme must not reach it.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    // Opening a browser is a context switch; the palette has no business staying
    // in front of the page it just sent you to.
    hidePanel();
    return electronShell.openExternal(parsed.href);
  });

  ipcMain.handle('copy', (_e, text: string) => clipboard.writeText(text));
  ipcMain.handle('setHeight', (_e, height: number) => setPanelHeight(height));
  ipcMain.handle('setDismissOnBlur', (_e, value: boolean) => setDismissOnBlur(value));
  ipcMain.handle('hide', () => hidePanel());
  ipcMain.handle('quit', () => app.quit());

  // One broadcast for every change, so a timer started from the menu bar shows up
  // in an already-open palette without it having to poll.
  shell.events.on('change', (snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('snapshot', snapshot);
    }
  });
}
