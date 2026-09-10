import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, Snapshot } from '@shared/ipc';
import type { JiraConfig } from '@shared/conn';

/**
 * The renderer's entire view of the outside world. No `nodeIntegration`, no
 * `remote`, and above all no credentials: the API token never leaves the main
 * process, so a compromised renderer has nothing to leak.
 */
const bridge: Bridge = {
  getSnapshot: () => ipcRenderer.invoke('snapshot'),
  onSnapshot: (fn: (snapshot: Snapshot) => void) => {
    const listener = (_e: unknown, snapshot: Snapshot) => fn(snapshot);
    ipcRenderer.on('snapshot', listener);
    return () => ipcRenderer.removeListener('snapshot', listener);
  },
  refresh: () => ipcRenderer.invoke('refresh'),

  start: (key) => ipcRenderer.invoke('start', key),
  stop: (activity) => ipcRenderer.invoke('stop', activity),
  fileTime: (key, activity) => ipcRenderer.invoke('fileTime', key, activity),
  finish: (key, transitionId) => ipcRenderer.invoke('finish', key, transitionId),
  transition: (key, transitionId) => ipcRenderer.invoke('transition', key, transitionId),
  relabel: (key, from, to) => ipcRenderer.invoke('relabel', key, from, to),
  discard: (key, activity) => ipcRenderer.invoke('discard', key, activity),

  getTransitions: (key) => ipcRenderer.invoke('getTransitions', key),
  openIssue: (key) => ipcRenderer.invoke('openIssue', key),
  copy: (text) => ipcRenderer.invoke('copy', text),

  saveConfig: (patch: Partial<JiraConfig>) => ipcRenderer.invoke('saveConfig', patch),
  setHeight: (height) => ipcRenderer.invoke('setHeight', height),
  setDismissOnBlur: (value) => ipcRenderer.invoke('setDismissOnBlur', value),
  hide: () => ipcRenderer.invoke('hide'),
  openUrl: (url: string) => ipcRenderer.invoke('openUrl', url),
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
