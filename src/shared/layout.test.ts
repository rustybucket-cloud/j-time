import { describe, it, expect } from 'vitest';
import {
  defaultLayout,
  freezeOrder,
  moveSection,
  resolveLayout,
  toggleCollapsed,
  togglePins,
} from './layout';

describe('resolveLayout', () => {
  it('follows the saved order', () => {
    const layout = { ...defaultLayout(), order: ['prs', 'jira'] };
    expect(resolveLayout(layout, ['jira', 'prs']).map((s) => s.id)).toEqual(['prs', 'jira']);
  });

  // A plugin the user has never arranged announces itself at the bottom rather
  // than displacing whatever they put first.
  it('appends plugins the layout has never seen, in registration order', () => {
    const layout = { ...defaultLayout(), order: ['prs'] };
    expect(resolveLayout(layout, ['jira', 'prs', 'notes']).map((s) => s.id)).toEqual([
      'prs',
      'jira',
      'notes',
    ]);
  });

  // Uninstalling a plugin and putting it back shouldn't cost the arrangement.
  it('ignores saved ids that are not installed, without forgetting them', () => {
    const layout = { ...defaultLayout(), order: ['prs', 'gone', 'jira'] };
    expect(resolveLayout(layout, ['jira', 'prs']).map((s) => s.id)).toEqual(['prs', 'jira']);
    expect(layout.order).toContain('gone');
  });

  it('reports collapse and pin state per section', () => {
    const layout = { order: ['jira'], collapsed: ['jira'], pinsOff: ['jira'] };
    const [jira] = resolveLayout(layout, ['jira']);
    expect(jira.collapsed).toBe(true);
    expect(jira.pins).toBe(false);
  });

  it('leaves pins on by default', () => {
    expect(resolveLayout(defaultLayout(), ['jira'])[0].pins).toBe(true);
  });
});

describe('toggleCollapsed / togglePins', () => {
  it('round-trips', () => {
    const once = toggleCollapsed(defaultLayout(), 'jira');
    expect(once.collapsed).toEqual(['jira']);
    expect(toggleCollapsed(once, 'jira').collapsed).toEqual([]);
  });

  it('turns one plugin’s pin off without touching another’s', () => {
    const layout = togglePins(defaultLayout(), 'prs');
    expect(layout.pinsOff).toEqual(['prs']);
    expect(resolveLayout(layout, ['jira', 'prs']).map((s) => s.pins)).toEqual([true, false]);
  });
});

describe('moveSection', () => {
  it('moves a section among the ones that are visible', () => {
    const layout = { ...defaultLayout(), order: ['jira', 'prs'] };
    expect(moveSection(layout, ['jira', 'prs'], 'prs', -1).order).toEqual(['prs', 'jira']);
  });

  // Swapping with the neighbouring *stored* id would trade places with something
  // that isn't on screen, and the section would look like it hadn't moved.
  it('steps over a saved plugin that is not installed', () => {
    const layout = { ...defaultLayout(), order: ['jira', 'gone', 'prs'] };
    const moved = moveSection(layout, ['jira', 'prs'], 'prs', -1);
    expect(resolveLayout(moved, ['jira', 'prs']).map((s) => s.id)).toEqual(['prs', 'jira']);
  });

  it('refuses to move past either end', () => {
    const layout = { ...defaultLayout(), order: ['jira', 'prs'] };
    expect(moveSection(layout, ['jira', 'prs'], 'jira', -1)).toBe(layout);
    expect(moveSection(layout, ['jira', 'prs'], 'prs', 1)).toBe(layout);
  });

  // With nothing saved the resolved order is registration order, so this is a
  // real move and has to be written out in full.
  it('can move a section the stored order has never mentioned', () => {
    expect(moveSection(defaultLayout(), ['jira', 'prs'], 'prs', -1).order).toEqual([
      'prs',
      'jira',
    ]);
  });
});

describe('freezeOrder', () => {
  // Without this the first drag of an arranged section would jump an unarranged
  // one to the top, because the stored order never mentioned it.
  it('writes the order the user can actually see', () => {
    const layout = { ...defaultLayout(), order: ['prs'] };
    expect(freezeOrder(layout, ['jira', 'prs']).order).toEqual(['prs', 'jira']);
  });

  it('keeps absent plugins on the end', () => {
    const layout = { ...defaultLayout(), order: ['gone', 'prs'] };
    expect(freezeOrder(layout, ['prs']).order).toEqual(['prs', 'gone']);
  });
});
