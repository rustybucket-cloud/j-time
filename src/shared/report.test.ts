import { describe, expect, it } from 'vitest';
import { describeBoard, describeStory, describeTimer, storyTotals, unfiledStories } from './report';
import type { JiraIssue, StoryTimer, TimerState } from './types';

const M = 60 * 1000;
const NOW = 100 * M;

const story = (over: Partial<StoryTimer> & { key: string }): StoryTimer => ({
  summary: `${over.key} summary`,
  status: 'In Progress',
  assignee: 'Ferenc',
  estimateSeconds: null,
  segments: [],
  doneAt: null,
  worklogId: null,
  loggedSeconds: null,
  ...over,
});

const state = (stories: StoryTimer[], activeKey: string | null = null): TimerState => ({
  activeKey,
  stories: Object.fromEntries(stories.map((s) => [s.key, s])),
});

const issue = (over: Partial<JiraIssue> & { key: string }): JiraIssue => ({
  summary: `${over.key} summary`,
  status: 'In Progress',
  stage: 'doing',
  assignee: 'Ferenc',
  issuetype: 'Story',
  priority: null,
  estimateSeconds: null,
  secondsSpent: null,
  description: null,
  ...over,
});

describe('storyTotals', () => {
  it('splits tracked time into what has been filed and what has not', () => {
    const s = state([
      story({
        key: 'AB-1',
        segments: [
          { start: 0, end: 10 * M, activity: 'Building', logged: true },
          { start: 20 * M, end: 25 * M, activity: 'Review' },
        ],
      }),
    ]);
    expect(storyTotals(s, 'AB-1', NOW)).toEqual({ tracked: 900, filed: 600, unfiled: 300 });
  });

  it('is all zeroes for a story this app has never tracked', () => {
    expect(storyTotals(state([]), 'AB-9', NOW)).toEqual({ tracked: 0, filed: 0, unfiled: 0 });
  });
});

describe('describeTimer', () => {
  it('names the running story, its open chunk and the filed split', () => {
    const s = state(
      [
        story({
          key: 'AB-1',
          segments: [
            { start: 0, end: 10 * M, activity: 'Building', logged: true },
            { start: 95 * M, end: null },
          ],
        }),
      ],
      'AB-1',
    );
    const text = describeTimer(s, NOW);
    expect(text).toContain('Running: AB-1 — AB-1 summary');
    expect(text).toContain('Open chunk: 5m.');
    expect(text).toContain('Tracked here: 15m — 10m filed, 5m not filed yet.');
  });

  it('says so plainly when the clock is stopped', () => {
    expect(describeTimer(state([]), NOW)).toBe('Nothing is running.');
  });

  it('lists stopped time nobody has filed, longest first, and never the running story twice', () => {
    const s = state(
      [
        story({ key: 'AB-1', segments: [{ start: 95 * M, end: null }] }),
        story({ key: 'AB-2', segments: [{ start: 0, end: 5 * M }] }),
        story({ key: 'AB-3', segments: [{ start: 0, end: 20 * M }] }),
        story({ key: 'AB-4', segments: [{ start: 0, end: 9 * M, logged: true }] }),
      ],
      'AB-1',
    );
    const lines = describeTimer(s, NOW).split('\n');
    const listed = lines.filter((l) => l.startsWith('  ')).map((l) => l.trim().split(' ')[0]);
    expect(listed).toEqual(['AB-3', 'AB-2']);
  });
});

describe('unfiledStories', () => {
  it('leaves out stories whose time is all filed', () => {
    const s = state([
      story({ key: 'AB-1', segments: [{ start: 0, end: 5 * M, logged: true }] }),
      story({ key: 'AB-2', segments: [{ start: 0, end: 5 * M }] }),
    ]);
    expect(unfiledStories(s, NOW).map((x) => x.key)).toEqual(['AB-2']);
  });
});

describe('describeStory', () => {
  it("keeps JIRA's total and this app's tracked time as separate statements", () => {
    const s = state([
      story({
        key: 'AB-1',
        loggedSeconds: 600,
        segments: [{ start: 0, end: 10 * M, activity: 'Building', logged: true }],
      }),
    ]);
    const text = describeStory('AB-1', issue({ key: 'AB-1', secondsSpent: 3600 }), s, NOW);
    expect(text).toContain('JIRA has 1h 0m spent');
    expect(text).toContain('Tracked here: 10m — 10m filed, 0m not filed yet.');
    // The part of JIRA's total this app never sent, so the rows add up to it.
    expect(text).toContain('Untracked: 50m (in JIRA already)');
  });

  it('calls the open chunk Running, since no label covers it yet', () => {
    const s = state([story({ key: 'AB-1', segments: [{ start: 95 * M, end: null }] })], 'AB-1');
    expect(describeStory('AB-1', null, s, NOW)).toContain('Running: 5m (not filed)');
  });

  it('says it knows nothing rather than inventing an empty story', () => {
    expect(describeStory('AB-9', null, state([]), NOW)).toContain("isn't on the board or tracked here");
  });
});

describe('describeBoard', () => {
  it('groups by column and marks the running story', () => {
    const s = state([story({ key: 'AB-1', segments: [{ start: 95 * M, end: null }] })], 'AB-1');
    const text = describeBoard(
      [
        issue({ key: 'AB-1' }),
        issue({ key: 'AB-2', stage: 'todo', status: 'To Do' }),
      ],
      s,
      NOW,
    );
    expect(text.split('\n')).toEqual([
      'To Do:',
      '  AB-2 — AB-2 summary [To Do]',
      'In Progress:',
      '  AB-1 — AB-1 summary [In Progress · tracked 5m · 5m unfiled · running]',
    ]);
  });

  it('says the board is empty rather than returning nothing', () => {
    expect(describeBoard([], state([]), NOW)).toBe('No stories on the board right now.');
  });
});
