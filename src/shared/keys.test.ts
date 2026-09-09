import { describe, it, expect } from 'vitest';
import { prettyAccelerator } from './keys';

describe('prettyAccelerator', () => {
  it('renders modifiers as macOS symbols', () => {
    expect(prettyAccelerator('Command+Shift+J')).toBe('⌘⇧J');
  });

  it('accepts every spelling of the same modifier', () => {
    expect(prettyAccelerator('CommandOrControl+K')).toBe('⌘K');
    expect(prettyAccelerator('CmdOrCtrl+K')).toBe('⌘K');
    expect(prettyAccelerator('Cmd+K')).toBe('⌘K');
  });

  it('renders Control and Option distinctly from Command', () => {
    expect(prettyAccelerator('Control+Alt+Space')).toBe('⌃⌥Space');
  });

  it('names the keys that have no single glyph', () => {
    expect(prettyAccelerator('Space')).toBe('Space');
  });

  it('renders the editing keys', () => {
    expect(prettyAccelerator('Enter')).toBe('↩');
    expect(prettyAccelerator('Escape')).toBe('⎋');
    expect(prettyAccelerator('Up')).toBe('↑');
  });

  it('upper-cases an unrecognised key rather than dropping it', () => {
    expect(prettyAccelerator('Command+F13')).toBe('⌘F13');
  });

  it('tolerates stray whitespace', () => {
    expect(prettyAccelerator(' Command + Shift + J ')).toBe('⌘⇧J');
  });
});
