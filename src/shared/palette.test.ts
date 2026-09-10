import { describe, it, expect } from 'vitest';
import { filterPalette, fuzzyMatch, nextIndex, rank, type Searchable } from './palette';

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
