import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, Snapshot } from '@shared/ipc';
import type { LayoutState } from '@shared/layout';
import type { ShellConfig } from '@shared/shell';

/**
 * The renderer's entire view of the outside world. No `nodeIntegration`, no
 * `remote`, and above all no credentials: no plugin's token ever leaves the main
 * process, so a compromised renderer has nothing to leak.
 *
 * The plugin channels are generic on purpose — a named method per verb stopped
 * scaling at the second plugin. Each plugin's renderer half wraps `invoke` and
 * `query` in typed functions of its own, so the argument names live next to the
 * code that knows what they mean.
 */
const bridge: Bridge = {
  getSnapshot: () => ipcRenderer.invoke('snapshot'),
  onSnapshot: (fn: (snapshot: Snapshot) => void) => {
    const listener = (_e: unknown, snapshot: Snapshot) => fn(snapshot);
    ipcRenderer.on('snapshot', listener);
    return () => ipcRenderer.removeListener('snapshot', listener);
  },

  invoke: (plugin, command, args = []) => ipcRenderer.invoke('invoke', plugin, command, args),
  query: (plugin, name, args = []) => ipcRenderer.invoke('query', plugin, name, args),
  refresh: (plugin) => ipcRenderer.invoke('refresh', plugin),
  reloadPlugins: () => ipcRenderer.invoke('reloadPlugins'),
  savePluginConfig: (plugin, patch) => ipcRenderer.invoke('savePluginConfig', plugin, patch),

  saveShellConfig: (patch: Partial<ShellConfig>) => ipcRenderer.invoke('saveShellConfig', patch),
  saveLayout: (layout: LayoutState) => ipcRenderer.invoke('saveLayout', layout),

  openUrl: (url: string) => ipcRenderer.invoke('openUrl', url),
  copy: (text) => ipcRenderer.invoke('copy', text),
  setHeight: (height) => ipcRenderer.invoke('setHeight', height),
  setDismissOnBlur: (value) => ipcRenderer.invoke('setDismissOnBlur', value),
  hide: () => ipcRenderer.invoke('hide'),
  quit: () => ipcRenderer.invoke('quit'),
};

/** Fired when the hotkey opens the panel, so the palette can reset itself. */
const onOpened = (fn: () => void): (() => void) => {
  const listener = () => fn();
  ipcRenderer.on('palette:opened', listener);
  return () => ipcRenderer.removeListener('palette:opened', listener);
};

contextBridge.exposeInMainWorld('jt', bridge);
contextBridge.exposeInMainWorld('jtOpened', onOpened);
