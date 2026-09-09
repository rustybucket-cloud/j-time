/**
 * Rendering an Electron accelerator the way macOS writes it.
 *
 * Shared because the menu bar and the palette's footer both print the same
 * shortcut, and two spellings of one hotkey is the kind of small wrongness that
 * makes a launcher feel unfinished.
 */

const SYMBOLS: Record<string, string> = {
  command: '⌘',
  cmd: '⌘',
  commandorcontrol: '⌘',
  cmdorctrl: '⌘',
  super: '⌘',
  meta: '⌘',
  control: '⌃',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  enter: '↩',
  return: '↩',
  escape: '⎋',
  esc: '⎋',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  space: 'Space',
};

/** "Command+Shift+J" → "⌘⇧J". Unknown parts are upper-cased and kept. */
export function prettyAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => {
      const key = part.trim().toLowerCase();
      return SYMBOLS[key] ?? part.trim().toUpperCase();
    })
    .join('');
}
