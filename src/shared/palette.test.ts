import { describe, it, expect } from 'vitest';
import {
  buildIssueItems,
  filterPalette,
  fuzzyMatch,
  nextIndex,
  rank,
  sectioned,
  SECTION_RUNNING,
  type Searchable,
} from './palette';
import type { StageGroups, StageRow } from './stages';
import type { Segment, StoryTimer } from './types';

const NOW = 1_700_000_000_000;

const item = (id: string, title: string, subtitle?: string, keywords?: string[]): Searchable => ({
  id,
  title,
  subtitle,
  keywords,
});

describe('fuzzyMatch', () => {
  it('matches an exact substring', () => {
    expect(fuzzyMatch('OG-1234', 'og-12')?.indices).toEqual([0, 1, 2, 3, 4]);
  });

  it('matches a scattered subsequence', () => {
    expect(fuzzyMatch('Refactor the parser', 'rtp')).not.toBeNull();
  });

  it('rejects characters that are out of order', () => {
    expect(fuzzyMatch('abc', 'cb')).toBeNull();
  });

  it('rejects a character that is absent', () => {
    expect(fuzzyMatch('abc', 'abd')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('Refactor', 'REF')).not.toBeNull();
  });

  it('scores an empty query as zero rather than failing', () => {
    expect(fuzzyMatch('anything', '   ')).toEqual({ score: 0, indices: [] });
  });

  // The bonus that makes typing the start of a word do the obvious thing.
  it('ranks consecutive characters above scattered ones', () => {
    const tight = fuzzyMatch('parser', 'par')!.score;
    const loose = fuzzyMatch('polar bears', 'par')!.score;
    expect(tight).toBeGreaterThan(loose);
  });

  it('ranks a word-boundary start above a mid-word one', () => {
    const boundary = fuzzyMatch('the parser', 'par')!.score;
    const midWord = fuzzyMatch('comparser', 'par')!.score;
    expect(boundary).toBeGreaterThan(midWord);
  });

  it('prefers the shorter of two equally good matches', () => {
    const short = fuzzyMatch('OG-12', 'og')!.score;
    const long = fuzzyMatch('OG-12 something much longer', 'og')!.score;
    expect(short).toBeGreaterThan(long);
  });

  it('treats a space as "and then later", not a literal character', () => {
    expect(fuzzyMatch('Refactor the parser', 'ref parser')).not.toBeNull();
  });
});

describe('rank', () => {
  it('weights the title above the subtitle', () => {
    const onTitle = rank(item('a', 'parser', 'unrelated'), 'parser')!.score;
    const onSubtitle = rank(item('b', 'unrelated', 'parser'), 'parser')!.score;
    expect(onTitle).toBeGreaterThan(onSubtitle);
  });

  it('matches on keywords, which carry the least weight', () => {
    const onKeyword = rank(item('a', 'zzz', 'zzz', ['In Review']), 'review');
    expect(onKeyword).not.toBeNull();
    expect(onKeyword!.score).toBeLessThan(rank(item('b', 'review'), 'review')!.score);
  });

  it('returns highlights for each field separately', () => {
    const r = rank(item('a', 'OG-12', 'parser work'), 'og')!;
    expect(r.titleIndices).toEqual([0, 1]);
    expect(r.subtitleIndices).toEqual([]);
  });

  it('returns null when nothing matches', () => {
    expect(rank(item('a', 'abc', 'def'), 'xyz')).toBeNull();
  });
});

describe('filterPalette', () => {
  const items = [
    item('1', 'OG-1', 'Fix the parser'),
    item('2', 'OG-2', 'Write the docs'),
    item('3', 'OG-3', 'Parser benchmarks'),
  ];

  // The default view is the board's order; reshuffling it would undo the one thing
  // the app makes glanceable.
  it('leaves the caller order untouched for an empty query', () => {
    expect(filterPalette(items, '').map((r) => r.item.id)).toEqual(['1', '2', '3']);
  });

  it('drops non-matching items', () => {
    expect(filterPalette(items, 'parser').map((r) => r.item.id)).toEqual(['1', '3']);
  });

  it('orders by score once a query is typed', () => {
    expect(filterPalette(items, 'og-3')[0].item.id).toBe('3');
  });

  it('breaks ties by the original order, so the list never jitters', () => {
    const same = [item('a', 'dup'), item('b', 'dup'), item('c', 'dup')];
    expect(filterPalette(same, 'dup').map((r) => r.item.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing when the query matches nothing', () => {
    expect(filterPalette(items, 'zzzz')).toEqual([]);
  });
});

describe('nextIndex', () => {
  it('advances and wraps at the end', () => {
    expect(nextIndex(3, 0, 1)).toBe(1);
    expect(nextIndex(3, 2, 1)).toBe(0);
  });

  it('retreats and wraps at the start', () => {
    expect(nextIndex(3, 0, -1)).toBe(2);
  });

  it('enters at the first row going down from nothing selected', () => {
    expect(nextIndex(3, -1, 1)).toBe(0);
  });

  it('enters at the last row going up from nothing selected', () => {
    expect(nextIndex(3, -1, -1)).toBe(2);
  });

  it('stays at -1 for an empty list', () => {
    expect(nextIndex(0, -1, 1)).toBe(-1);
  });
});

const timer = (key: string, segments: Segment[], over: Partial<StoryTimer> = {}): StoryTimer => ({
  key,
  summary: '',
  status: '',
  assignee: null,
  estimateSeconds: null,
  segments,
  doneAt: null,
  worklogId: null,
  loggedSeconds: null,
  ...over,
});

const row = (key: string, over: Partial<StageRow> = {}): StageRow => ({
  key,
  summary: `${key} summary`,
  status: 'In Progress',
  assignee: null,
  estimateSeconds: null,
  secondsSpent: null,
  description: null,
  timer: null,
  ...over,
});

const groups = (over: Partial<StageGroups> = {}): StageGroups => ({
  todo: [],
  doing: [],
  done: [],
  elsewhere: [],
  ...over,
});

describe('buildIssueItems', () => {
  it('leads with In Progress, then To Do, Done and off-board work', () => {
    const items = buildIssueItems(
      groups({
        todo: [row('T-1')],
        doing: [row('D-1')],
        done: [row('N-1')],
        elsewhere: [row('E-1')],
      }),
      NOW,
    );
    expect(items.map((i) => i.title)).toEqual(['D-1', 'T-1', 'N-1', 'E-1']);
    expect(items.map((i) => i.section)).toEqual([
      'In Progress',
      'To Do',
      'Done',
      'Tracked elsewhere',
    ]);
  });

  it('pins the running story to the top, in its own section', () => {
    const running = row('T-9', { timer: timer('T-9', [{ start: NOW - 60_000, end: null }]) });
    const items = buildIssueItems(groups({ todo: [running], doing: [row('D-1')] }), NOW);
    expect(items[0].title).toBe('T-9');
    expect(items[0].section).toBe(SECTION_RUNNING);
    expect(items[0].running).toBe(true);
  });

  it('counts tracked and unlogged seconds per row', () => {
    const segments: Segment[] = [
      { start: NOW - 600_000, end: NOW - 300_000, logged: true },
      { start: NOW - 120_000, end: NOW - 60_000 },
    ];
    const items = buildIssueItems(groups({ doing: [row('D-1', { timer: timer('D-1', segments) })] }), NOW);
    expect(items[0].trackedSeconds).toBe(360);
    expect(items[0].unloggedSeconds).toBe(60);
  });

  it('reports zeroes for a story the timer has never seen', () => {
    const items = buildIssueItems(groups({ doing: [row('D-1')] }), NOW);
    expect(items[0].trackedSeconds).toBe(0);
    expect(items[0].unloggedSeconds).toBe(0);
    expect(items[0].running).toBe(false);
  });

  it('makes status, board and assignee searchable without showing them', () => {
    const items = buildIssueItems(
      groups({ doing: [row('D-1', { status: 'In Review', boardName: 'Platform' })] }),
      NOW,
    );
    expect(items[0].keywords).toEqual(['In Review', 'Platform']);
  });
});

describe('sectioned', () => {
  it('groups contiguous runs and preserves order', () => {
    const entries = [
      { item: { section: 'A', id: '1' } },
      { item: { section: 'A', id: '2' } },
      { item: { section: 'B', id: '3' } },
    ];
    expect(sectioned(entries).map((s) => [s.section, s.items.length])).toEqual([
      ['A', 2],
      ['B', 1],
    ]);
  });

  // Filtering can leave the same section on both sides of a gap; two headings is
  // the honest rendering of a list that is no longer contiguous.
  it('starts a new run when a section reappears later', () => {
    const entries = [
      { item: { section: 'A', id: '1' } },
      { item: { section: 'B', id: '2' } },
      { item: { section: 'A', id: '3' } },
    ];
    expect(sectioned(entries).map((s) => s.section)).toEqual(['A', 'B', 'A']);
  });

  it('returns nothing for an empty list', () => {
    expect(sectioned([])).toEqual([]);
  });
});
