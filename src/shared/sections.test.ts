import { describe, it, expect } from 'vitest';
import {
  buildOverlay,
  buildPalette,
  findEntry,
  firstSelectable,
  headerId,
  moveSelection,
  PINNED_SECTION,
  TOP_HIT_SECTION,
  type SectionInput,
} from './sections';
import type { Row } from './plugin';

const row = (id: string, title: string, over: Partial<Row> = {}): Row => ({
  id,
  title,
  run: () => undefined,
  ...over,
});

const section = (id: string, rows: Row[], over: Partial<SectionInput> = {}): SectionInput => ({
  id,
  title: id.toUpperCase(),
  rows,
  collapsed: false,
  pins: true,
  ...over,
});

const titles = (view: ReturnType<typeof buildPalette>): string[] =>
  view.flat.map((e) => (e.kind === 'header' ? `# ${e.title}` : e.row.title));

describe('buildPalette', () => {
  it('keeps each plugin’s order inside its section, and the sections in the given order', () => {
    const view = buildPalette(
      [section('jira', [row('a', 'OG-1'), row('b', 'OG-2')]), section('prs', [row('c', 'PR 9')])],
      '',
    );
    expect(titles(view)).toEqual(['# JIRA', 'OG-1', 'OG-2', '# PRS', 'PR 9']);
  });

  it('heads a section even when the plugin has no rows to show', () => {
    const view = buildPalette([section('jira', [], { note: 'Not set up' })], '');
    expect(titles(view)).toEqual(['# JIRA']);
    expect(view.sections[0].header.note).toBe('Not set up');
  });

  it('groups a plugin’s rows into its own subsections', () => {
    const view = buildPalette(
      [
        section('jira', [
          row('a', 'OG-1', { subsection: 'In Progress' }),
          row('b', 'OG-2', { subsection: 'To Do' }),
        ]),
      ],
      '',
    );
    expect(view.sections[0].groups.map((g) => g.subsection)).toEqual(['In Progress', 'To Do']);
  });

  describe('pinning', () => {
    it('lifts a pinned row above every section', () => {
      const view = buildPalette(
        [section('jira', [row('a', 'OG-1'), row('b', 'OG-2', { pin: true })])],
        '',
      );
      expect(titles(view)).toEqual([`# ${PINNED_SECTION}`, 'OG-2', '# JIRA', 'OG-1']);
    });

    // Otherwise a plugin that pinned everything would simply be first.
    it('honours only one pin per plugin', () => {
      const view = buildPalette(
        [section('jira', [row('a', 'OG-1', { pin: true }), row('b', 'OG-2', { pin: true })])],
        '',
      );
      expect(titles(view)).toEqual([`# ${PINNED_SECTION}`, 'OG-1', '# JIRA', 'OG-2']);
    });

    // Carrying each plugin's own headings up with the rows turned a two-row
    // section into four lines of heading.
    it('drops the rows\u2019 own subsections once they are pinned', () => {
      const view = buildPalette(
        [
          section('jira', [row('a', 'OG-1', { pin: true, subsection: 'In Progress' })]),
          section('prs', [row('b', 'PR 9', { pin: true, subsection: 'Needs your review' })]),
        ],
        '',
      );
      expect(view.sections[0].groups).toHaveLength(1);
      expect(view.sections[0].groups[0].subsection).toBeUndefined();
    });

    it('takes one from each plugin, in section order', () => {
      const view = buildPalette(
        [
          section('jira', [row('a', 'OG-1', { pin: true })]),
          section('prs', [row('b', 'PR 9', { pin: true })]),
        ],
        '',
      );
      expect(titles(view).slice(0, 3)).toEqual([`# ${PINNED_SECTION}`, 'OG-1', 'PR 9']);
    });

    it('leaves the row where it is when the user turned that plugin’s pins off', () => {
      const view = buildPalette(
        [section('jira', [row('a', 'OG-1', { pin: true })], { pins: false })],
        '',
      );
      expect(titles(view)).toEqual(['# JIRA', 'OG-1']);
    });

    // While searching the top hit claims that slot instead; two things competing
    // for the first row is one too many.
    it('does not pin while a query is running', () => {
      const view = buildPalette(
        [section('jira', [row('a', 'OG-1'), row('b', 'OG-2', { pin: true })])],
        'og-2',
      );
      expect(view.sections[0].header.title).not.toBe(PINNED_SECTION);
    });
  });

  describe('searching', () => {
    it('sorts within a section but leaves the sections where they are', () => {
      const view = buildPalette(
        [
          section('jira', [row('a', 'apricot'), row('b', 'apple pie')]),
          section('prs', [row('c', 'apple')]),
        ],
        'ap',
      );
      // JIRA is still second-from-top even though the strongest match was in PRS;
      // what typing changes is the order *within* each section, plus the hoist.
      expect(titles(view)).toEqual([
        `# ${TOP_HIT_SECTION}`,
        'apple',
        '# JIRA',
        'apricot',
        'apple pie',
      ]);
    });

    it('drops sections with no matches', () => {
      const view = buildPalette(
        [section('jira', [row('a', 'zebra')]), section('prs', [row('b', 'apple')])],
        'apple',
      );
      // And no Top hit heading either: the best match is already the first row,
      // so a heading announcing it would be a heading over nothing.
      expect(titles(view)).toEqual(['# PRS', 'apple']);
    });

    // A collapsed section that swallowed the only match would read as "no results".
    it('auto-expands a collapsed section that has matches', () => {
      const view = buildPalette([section('jira', [row('a', 'apple')], { collapsed: true })], 'app');
      expect(titles(view)).toEqual(['# JIRA', 'apple']);
    });

    it('leaves the best match in place when it is already first', () => {
      const view = buildPalette([section('jira', [row('a', 'apple'), row('b', 'apricot')])], 'ap');
      expect(titles(view)).toEqual(['# JIRA', 'apple', 'apricot']);
    });
  });

  describe('collapsing', () => {
    it('hides the rows and says how many', () => {
      const view = buildPalette(
        [section('jira', [row('a', 'OG-1'), row('b', 'OG-2')], { collapsed: true })],
        '',
      );
      expect(titles(view)).toEqual(['# JIRA']);
      expect(view.sections[0].header.hidden).toBe(2);
    });
  });
});

describe('moveSelection', () => {
  const view = buildPalette([section('jira', [row('a', 'OG-1')]), section('prs', [row('b', 'PR')])], '');

  // The header is a landing place, which is what makes collapsing reachable from
  // the keyboard at all.
  it('steps through headers as well as rows', () => {
    expect(view.flat.map((e) => e.id)).toEqual([
      headerId('jira'),
      'jira:a',
      headerId('prs'),
      'prs:b',
    ]);
  });

  it('wraps at both ends', () => {
    expect(moveSelection(view, 'prs:b', 1)).toBe(headerId('jira'));
    expect(moveSelection(view, headerId('jira'), -1)).toBe('prs:b');
  });

  // A row that filtered away must not hand the cursor to whatever slid into its
  // slot; an unknown id starts over from the top.
  it('starts from the top when the selection is gone', () => {
    expect(moveSelection(view, 'jira:vanished', 1)).toBe(headerId('jira'));
  });

  it('stays null on an empty list', () => {
    expect(moveSelection(buildPalette([], ''), null, 1)).toBeNull();
  });
});

describe('firstSelectable', () => {
  it('prefers a row over the header above it', () => {
    const view = buildPalette([section('jira', [row('a', 'OG-1')])], '');
    expect(firstSelectable(view)).toBe('jira:a');
  });

  it('falls back to the header when a section is empty', () => {
    const view = buildPalette([section('jira', [])], '');
    expect(firstSelectable(view)).toBe(headerId('jira'));
  });
});

describe('findEntry', () => {
  it('finds a row by its namespaced id', () => {
    const view = buildPalette([section('jira', [row('a', 'OG-1')])], '');
    expect(findEntry(view, 'jira:a')?.kind).toBe('row');
    expect(findEntry(view, null)).toBeNull();
  });
});

describe('buildOverlay', () => {
  it('is one list with no heading', () => {
    const view = buildOverlay([row('a', 'Meeting'), row('b', 'Building')], '');
    expect(view.flat.every((e) => e.kind === 'row')).toBe(true);
    expect(view.flat.map((e) => e.id)).toEqual([':a', ':b']);
  });

  it('ranks the whole list rather than per section', () => {
    const view = buildOverlay([row('a', 'zebra'), row('b', 'apple')], 'ap');
    expect(view.flat.map((e) => (e.kind === 'row' ? e.row.title : ''))).toEqual(['apple']);
  });

  it('still groups a picker’s own runs', () => {
    const view = buildOverlay(
      [row('a', 'Done', { subsection: 'Finish' }), row('b', 'Cancelled', { subsection: 'Other' })],
      '',
    );
    expect(view.sections[0].groups.map((g) => g.subsection)).toEqual(['Finish', 'Other']);
  });
});
