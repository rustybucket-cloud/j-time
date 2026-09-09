/**
 * The bridge's server half. Every channel is a thin call into `data`, which owns
 * the ordering and the persistence — nothing here decides anything.
 */

import { BrowserWindow, clipboard, ipcMain, shell, app } from 'electron';
import type { JiraConfig } from '@shared/conn';
import * as data from './data';
import { hidePanel, setDismissOnBlur, setPanelHeight } from './panel';

export function registerIpc(): void {
  ipcMain.handle('snapshot', () => data.snapshot());
  ipcMain.handle('refresh', () => data.refresh());

  ipcMain.handle('start', (_e, key: string) => data.start(key));
  ipcMain.handle('stop', (_e, activity?: string) => data.stop(activity));
  ipcMain.handle('fileTime', (_e, key: string, activity: string) => data.fileTime(key, activity));
  ipcMain.handle('finish', (_e, key: string, transitionId?: string) => data.finish(key, transitionId));
  ipcMain.handle('transition', (_e, key: string, id: string) => data.transition(key, id));
  ipcMain.handle('relabel', (_e, key: string, from: string, to: string) => data.relabel(key, from, to));
  ipcMain.handle('discard', (_e, key: string, activity: string) => data.discard(key, activity));

  ipcMain.handle('getTransitions', (_e, key: string) => data.getTransitions(key));

  ipcMain.handle('openIssue', (_e, key: string) => {
    // Opening a browser is a context switch; the palette has no business staying
    // in front of the page it just sent you to.
    hidePanel();
    return shell.openExternal(data.issueUrl(key));
  });
  ipcMain.handle('copy', (_e, text: string) => clipboard.writeText(text));

  ipcMain.handle('saveConfig', (_e, patch: Partial<JiraConfig>) => data.saveConfigPatch(patch));
  ipcMain.handle('setHeight', (_e, height: number) => setPanelHeight(height));
  ipcMain.handle('setDismissOnBlur', (_e, value: boolean) => setDismissOnBlur(value));
  ipcMain.handle('hide', () => hidePanel());
  ipcMain.handle('quit', () => app.quit());

  // One broadcast for every change, so a timer started from the menu bar shows up
  // in an already-open palette without it having to poll.
  data.events.on('change', (snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('snapshot', snapshot);
    }
  });
}
