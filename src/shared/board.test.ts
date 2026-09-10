import { describe, it, expect } from 'vitest';
import { buildIssueItems } from './board';
import type { StageGroups, StageRow } from './stages';
import type { Segment, StoryTimer } from './types';

const NOW = 1_700_000_000_000;

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
    expect(items.map((i) => i.subsection)).toEqual([
      'In Progress',
      'To Do',
      'Done',
      'Tracked elsewhere',
    ]);
  });

  // The running story used to be hoisted here. It now stays in its column and is
  // marked instead — the shell lifts it into the pinned section above every
  // plugin, which is a treatment the PR section can have too and which the user
  // can switch off per plugin.
  it('leaves the running story in its column and marks it', () => {
    const running = row('T-9', { timer: timer('T-9', [{ start: NOW - 60_000, end: null }]) });
    const items = buildIssueItems(groups({ todo: [running], doing: [row('D-1')] }), NOW);
    expect(items.map((i) => i.title)).toEqual(['D-1', 'T-9']);
    const t9 = items.find((i) => i.title === 'T-9');
    expect(t9?.running).toBe(true);
    expect(t9?.subsection).toBe('To Do');
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

