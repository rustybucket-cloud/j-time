import type { Bridge } from '@shared/ipc';

declare global {
  interface Window {
    jt: Bridge;
    /** Subscribe to the panel being opened by the hotkey. Returns an unsubscribe. */
    jtOpened: (fn: () => void) => () => void;
  }
}

export {};
