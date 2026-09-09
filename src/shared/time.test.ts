import { describe, it, expect } from 'vitest';
import {
  activeSeconds,
  roundSeconds,
  formatDurationShort,
  formatClock,
  isRunning,
  formatBar,
} from './time';

const S = 1000;
const M = 60 * S;

describe('activeSeconds', () => {
  it('sums closed segments', () => {
    expect(activeSeconds([{ start: 0, end: 60 * S }], 0)).toBe(60);
    expect(
      activeSeconds(
        [
          { start: 0, end: 60 * S },
          { start: 120 * S, end: 150 * S },
        ],
        999,
      ),
    ).toBe(90);
  });

  it('counts an open segment up to now, not wall-clock', () => {
    // segment opened at t=0, now = 5 min -> 300s regardless of any gap before it
    expect(activeSeconds([{ start: 0, end: null }], 5 * M)).toBe(300);
  });

  it('a paused timer left open for a "long session" adds nothing', () => {
    // one 10-min chunk, then paused; now is 3 days later
    const segments = [{ start: 0, end: 10 * M }];
    const threeDaysLater = 3 * 24 * 60 * M;
    expect(activeSeconds(segments, threeDaysLater)).toBe(600);
  });

  it('ignores zero-length / inverted segments', () => {
    expect(activeSeconds([{ start: 100, end: 100 }], 0)).toBe(0);
    expect(activeSeconds([{ start: 200, end: 100 }], 0)).toBe(0);
  });

  it('handles empty', () => {
    expect(activeSeconds([], 123)).toBe(0);
  });
});

describe('roundSeconds', () => {
  it('rounds to nearest increment', () => {
    expect(roundSeconds(200, 5)).toBe(300); // 3m20s -> nearest 5m = 5m
    expect(roundSeconds(400, 5)).toBe(300); // 6m40s -> 5m (rounds down)
    expect(roundSeconds(500, 5)).toBe(600); // 8m20s -> 10m (rounds up)
    expect(roundSeconds(0, 5)).toBe(0);
  });

  it('never drops a small-but-real duration to zero', () => {
    expect(roundSeconds(30, 5)).toBe(300); // 30s -> 5m, not 0
    expect(roundSeconds(130, 5)).toBe(300); // 2m10s rounds to 0 -> bumped to 5m
    expect(roundSeconds(1, 15)).toBe(15 * 60);
  });

  it('passes through when increment <= 0', () => {
    expect(roundSeconds(137, 0)).toBe(137);
  });
});

describe('formatDurationShort', () => {
  it('formats hours and minutes', () => {
    expect(formatDurationShort(0)).toBe('0m');
    expect(formatDurationShort(90)).toBe('1m');
    expect(formatDurationShort(60 * 60)).toBe('1h 0m');
    expect(formatDurationShort(5025)).toBe('1h 23m');
  });
});

describe('formatClock', () => {
  it('pads HH:MM:SS', () => {
    expect(formatClock(0)).toBe('00:00:00');
    expect(formatClock(5025)).toBe('01:23:45');
    expect(formatClock(59)).toBe('00:00:59');
  });
});

describe('isRunning', () => {
  it('true only when last segment is open', () => {
    expect(isRunning([])).toBe(false);
    expect(isRunning([{ start: 0, end: 10 }])).toBe(false);
    expect(isRunning([{ start: 0, end: 10 }, { start: 20, end: null }])).toBe(true);
  });
});

describe('formatBar', () => {
  it('omits hours until there are hours', () => {
    expect(formatBar(0)).toBe('00:00');
    expect(formatBar(59)).toBe('00:59');
    expect(formatBar(3599)).toBe('59:59');
  });

  it('shows hours unpadded once they exist', () => {
    expect(formatBar(3600)).toBe('1:00:00');
    expect(formatBar(45296)).toBe('12:34:56');
  });

  it('floors fractional seconds and clamps negatives', () => {
    expect(formatBar(90.9)).toBe('01:30');
    expect(formatBar(-5)).toBe('00:00');
  });
});
