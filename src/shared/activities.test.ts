import { describe, it, expect } from 'vitest';
import { parseActivities, apportion, DEFAULT_ACTIVITIES, UNLABELLED } from './activities';

const M = 60;

describe('parseActivities', () => {
  it('falls back to the default set when unset', () => {
    expect(parseActivities(undefined)).toEqual([...DEFAULT_ACTIVITIES]);
  });

  it('treats an explicitly blank value as "feature off"', () => {
    // Distinct from unset: someone who empties the var wants the old Pause behaviour.
    expect(parseActivities('')).toEqual([]);
    expect(parseActivities('   ')).toEqual([]);
    expect(parseActivities(' , , ')).toEqual([]);
  });

  it('splits on commas and trims', () => {
    expect(parseActivities('Meeting, Building ,Testing')).toEqual([
      'Meeting',
      'Building',
      'Testing',
    ]);
  });

  it('drops empties and duplicates, keeping first spelling and order', () => {
    expect(parseActivities('Design,,Research,design,Design ')).toEqual(['Design', 'Research']);
  });
});

describe('apportion', () => {
  const raw = (pairs: [string, number][]) => pairs.map(([activity, seconds]) => ({ activity, seconds }));

  it('gives a single activity the whole amount', () => {
    expect(apportion(45 * M, raw([['Building', 47 * M]]))).toEqual([
      { activity: 'Building', seconds: 45 * M },
    ]);
  });

  it('splits proportionally and sums exactly to the total', () => {
    // The worked example: 47m raw, 45m to send.
    const out = apportion(45 * M, raw([['Building', 30 * M], ['Meeting', 12 * M], ['Testing', 5 * M]]));
    expect(out.reduce((s, p) => s + p.seconds, 0)).toBe(45 * M);
    expect(out).toEqual([
      { activity: 'Building', seconds: 29 * M },
      { activity: 'Meeting', seconds: 11 * M },
      { activity: 'Testing', seconds: 5 * M },
    ]);
  });

  it('always sums exactly, across many awkward splits', () => {
    const cases: [number, [string, number][]][] = [
      [10 * M, [['a', 100], ['b', 100], ['c', 100]]],
      [5 * M, [['a', 7], ['b', 993]]],
      [60 * M, [['a', 1], ['b', 1], ['c', 1], ['d', 1], ['e', 1], ['f', 1], ['g', 1]]],
      [15 * M, [['a', 3600], ['b', 1], ['c', 59]]],
    ];
    for (const [total, groups] of cases) {
      const out = apportion(total, raw(groups));
      expect(out.reduce((s, p) => s + p.seconds, 0)).toBe(total);
    }
  });

  it('produces whole minutes when the total is a whole number of minutes', () => {
    const out = apportion(45 * M, raw([['a', 31], ['b', 29], ['c', 7]]));
    for (const p of out) expect(p.seconds % 60).toBe(0);
  });

  it('never emits a zero-length worklog, and still sums exactly', () => {
    // 2 minutes across 5 activities: three of them must drop out entirely.
    const out = apportion(2 * M, raw([['a', 50], ['b', 40], ['c', 5], ['d', 3], ['e', 2]]));
    expect(out.every((p) => p.seconds > 0)).toBe(true);
    expect(out.reduce((s, p) => s + p.seconds, 0)).toBe(2 * M);
    expect(out.length).toBe(2);
  });

  it('returns nothing when there is no time to send', () => {
    expect(apportion(0, raw([['a', 60]]))).toEqual([]);
    expect(apportion(-30, raw([['a', 60]]))).toEqual([]);
    expect(apportion(5 * M, [])).toEqual([]);
  });

  it('splits evenly when raw durations are all zero', () => {
    // Degenerate but shouldn't divide by zero or lose time.
    const out = apportion(4 * M, raw([['a', 0], ['b', 0]]));
    expect(out.reduce((s, p) => s + p.seconds, 0)).toBe(4 * M);
  });

  it('groups unlabelled time under a readable name', () => {
    const out = apportion(10 * M, raw([[UNLABELLED, 600]]));
    expect(out[0].activity).toBe(UNLABELLED);
  });
});
