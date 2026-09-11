import { describe, expect, it, vi } from 'vitest';
import {
  patchFrom,
  publicConfig,
  rowsFrom,
  sanitiseContent,
  sanitiseFields,
  secretKeys,
  RUNTIME_ID,
} from './runtime';

describe('sanitiseContent', () => {
  it('accepts a bare array of rows', () => {
    expect(sanitiseContent([{ id: 'a', title: 'A' }])).toEqual({
      rows: [{ id: 'a', title: 'A' }],
    });
  });

  it('drops rows without an id or a title, and keeps the rest', () => {
    const out = sanitiseContent({
      rows: [{ id: 'a', title: 'A' }, { title: 'no id' }, { id: 'no-title' }, 'junk', null],
    });
    expect(out.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('keeps only the fields the palette knows, at the types it expects', () => {
    const out = sanitiseContent({
      rows: [
        {
          id: 'a',
          title: 'A',
          subtitle: 'sub',
          keywords: ['k', 3],
          subsection: 'S',
          lead: 'attention',
          badges: [{ text: 'x', kind: 'pill', tone: 'warn' }, { text: 'y', kind: 'nope' }, 'z'],
          live: 'yes',
          pin: true,
          enterLabel: 'Go',
          run: { command: 'do', args: [1], stay: true },
          extra: 'ignored',
        },
      ],
    });
    expect(out.rows[0]).toEqual({
      id: 'a',
      title: 'A',
      subtitle: 'sub',
      keywords: ['k'],
      subsection: 'S',
      lead: 'attention',
      badges: [{ text: 'x', kind: 'pill', tone: 'warn' }, { text: 'y' }],
      pin: true,
      enterLabel: 'Go',
      run: { command: 'do', args: [1], stay: true },
    });
  });

  it('rejects a lead that is not a glyph, and a run that names nothing', () => {
    const out = sanitiseContent({ rows: [{ id: 'a', title: 'A', lead: 'red', run: {} }] });
    expect(out.rows[0]).toEqual({ id: 'a', title: 'A' });
  });

  it('accepts a url run', () => {
    const out = sanitiseContent({ rows: [{ id: 'a', title: 'A', run: { url: 'https://x' } }] });
    expect(out.rows[0].run).toEqual({ url: 'https://x' });
  });

  it('keeps one level of actions, with shortcuts, and no deeper', () => {
    const out = sanitiseContent({
      rows: [
        {
          id: 'a',
          title: 'A',
          shortcut: 'x',
          actions: [
            { id: 'b', title: 'B', shortcut: 'L', actions: [{ id: 'c', title: 'C' }] },
            { id: 'd', title: 'D', shortcut: 'too long' },
          ],
        },
      ],
    });
    const [a] = out.rows;
    expect(a.shortcut).toBeUndefined();
    expect(a.actions).toEqual([
      { id: 'b', title: 'B', shortcut: 'l' },
      { id: 'd', title: 'D' },
    ]);
  });

  it('takes section actions and a menu bar title', () => {
    const out = sanitiseContent({
      rows: [],
      actions: [{ id: 'r', title: 'Refresh', run: { command: 'refresh' } }],
      menuBar: { title: '3', tooltip: 'three things' },
    });
    expect(out.actions).toHaveLength(1);
    expect(out.menuBar).toEqual({ title: '3', tooltip: 'three things' });
  });

  it('turns anything else into an empty section', () => {
    expect(sanitiseContent(undefined)).toEqual({ rows: [] });
    expect(sanitiseContent('rows')).toEqual({ rows: [] });
    expect(sanitiseContent({ rows: 'no', menuBar: 'no' })).toEqual({ rows: [] });
  });
});

describe('sanitiseFields', () => {
  it('needs a key, defaults the label, and makes a secret a password', () => {
    expect(
      sanitiseFields([
        { key: 'name' },
        { key: 'token', label: 'API token', secret: true, type: 'text' },
        { key: 'n', type: 'number', note: 'a note' },
        { label: 'no key' },
        { key: 'name', label: 'duplicate' },
      ]),
    ).toEqual([
      { key: 'name', label: 'name' },
      { key: 'token', label: 'API token', secret: true, type: 'password' },
      { key: 'n', label: 'n', type: 'number', note: 'a note' },
    ]);
  });

  it('lists the secrets for the store', () => {
    expect(secretKeys(sanitiseFields([{ key: 'a', secret: true }, { key: 'b' }]))).toEqual(['a']);
  });
});

describe('publicConfig', () => {
  const fields = sanitiseFields([{ key: 'name' }, { key: 'token', secret: true }]);

  it('strips secrets and says whether they are set', () => {
    expect(publicConfig({ name: 'x', token: 'sekret' }, fields)).toEqual({
      config: { name: 'x' },
      secretsSet: { token: true },
    });
    expect(publicConfig({ name: 'x' }, fields)).toEqual({
      config: { name: 'x' },
      secretsSet: { token: false },
    });
  });
});

describe('patchFrom', () => {
  const fields = sanitiseFields([
    { key: 'name' },
    { key: 'count', type: 'number' },
    { key: 'token', secret: true },
  ]);

  it('sends every plain field, numbers as numbers, and a secret only when typed', () => {
    expect(patchFrom(fields, { name: 'x', count: '4', token: '' })).toEqual({
      name: 'x',
      count: 4,
    });
    expect(patchFrom(fields, { name: '', count: 'abc', token: 't' })).toEqual({
      name: '',
      count: 0,
      token: 't',
    });
  });
});

describe('rowsFrom', () => {
  it('wires a command run through the handler, with its args and stay flag', () => {
    const on = { command: vi.fn(), url: vi.fn() };
    const [row] = rowsFrom(
      [{ id: 'a', title: 'A', run: { command: 'go', args: [1, 'two'], stay: true } }],
      on,
    );
    row.run();
    expect(on.command).toHaveBeenCalledWith('go', [1, 'two'], true);
    expect(on.url).not.toHaveBeenCalled();
  });

  it('opens a url run, and labels Enter for it', () => {
    const on = { command: vi.fn(), url: vi.fn() };
    const [row] = rowsFrom([{ id: 'a', title: 'A', run: { url: 'https://x' } }], on);
    row.run();
    expect(on.url).toHaveBeenCalledWith('https://x');
    expect(row.enterLabel).toBe('Open');
  });

  it('gives a row with no run a harmless one, and maps actions recursively', () => {
    const on = { command: vi.fn(), url: vi.fn() };
    const [row] = rowsFrom(
      [
        {
          id: 'a',
          title: 'A',
          lead: 'ok',
          actions: [{ id: 'b', title: 'B', shortcut: 'l', run: { command: 'x' } }],
        },
      ],
      on,
    );
    expect(() => row.run()).not.toThrow();
    expect(on.command).not.toHaveBeenCalled();
    expect(row.lead).toBe('ok');
    expect(row.actions?.[0].shortcut).toBe('l');
    row.actions?.[0].run();
    expect(on.command).toHaveBeenCalledWith('x', [], false);
  });
});

describe('RUNTIME_ID', () => {
  it('is a directory name that can also be a key', () => {
    expect(RUNTIME_ID.test('bookmarks')).toBe(true);
    expect(RUNTIME_ID.test('my_plugin-2')).toBe(true);
    expect(RUNTIME_ID.test('Bookmarks')).toBe(false);
    expect(RUNTIME_ID.test('.hidden')).toBe(false);
    expect(RUNTIME_ID.test('a b')).toBe(false);
  });
});
