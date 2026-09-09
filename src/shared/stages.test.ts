import { describe, it, expect } from 'vitest';
import {
  focusKey,
  groupByStage,
  preferredDoneTransition,
  stageFor,
  STAGE_LABELS,
} from './stages';
import type { JiraIssue, Segment, StoryTimer } from './types';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function issue(key: string, stage: JiraIssue['stage'], extra: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    summary: `${key} summary`,
    status: stage === 'done' ? 'Done' : stage === 'doing' ? 'In Progress' : 'To Do',
    stage,
    assignee: 'Dana',
    issuetype: 'Story',
    priority: null,
    estimateSeconds: null,
    secondsSpent: null,
    description: null,
    ...extra,
  };
}

/** A story whose last segment is still open — the timer is running on it. */
function running(key: string, minutesSoFar: number, extra: Partial<StoryTimer> = {}) {
  const story = tracked(key, 1, 0, extra);
  story.segments = [{ start: NOW - minutesSoFar * MIN, end: null }];
  return story;
}

/** A story with one closed segment of `minutes`, ending `endedMinsAgo` before NOW. */
function tracked(key: string, minutes: number, endedMinsAgo = 0, extra: Partial<StoryTimer> = {}) {
  const end = NOW - endedMinsAgo * MIN;
  const segments: Segment[] = [{ start: end - minutes * MIN, end }];
  const story: StoryTimer = {
    key,
    summary: `${key} summary`,
    status: 'In Progress',
    assignee: 'Dana',
    estimateSeconds: null,
    segments,
    doneAt: null,
    worklogId: null,
    loggedSeconds: null,
    ...extra,
  };
  return story;
}

function group(args: Partial<Parameters<typeof groupByStage>[0]> = {}) {
  return groupByStage({ issues: [], doneIssues: [], stories: {}, now: NOW, ...args });
}

const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

describe('stageFor', () => {
  it('maps JIRA status categories onto the three board columns', () => {
    expect(stageFor('new')).toBe('todo');
    expect(stageFor('indeterminate')).toBe('doing');
    expect(stageFor('done')).toBe('done');
  });

  // The board's columns are what the user sees, but the API keys are these three
  // strings. Anything else means JIRA changed or the field wasn't requested.
  it('falls back to doing for an absent or unrecognised category', () => {
    expect(stageFor(undefined)).toBe('doing');
    expect(stageFor(null)).toBe('doing');
    expect(stageFor('')).toBe('doing');
    expect(stageFor('something-new')).toBe('doing');
  });

  it('ignores case, since the key is compared not displayed', () => {
    expect(stageFor('Done')).toBe('done');
    expect(stageFor('NEW')).toBe('todo');
  });

  it('labels every stage', () => {
    expect(STAGE_LABELS.todo).toBe('To Do');
    expect(STAGE_LABELS.doing).toBe('In Progress');
    expect(STAGE_LABELS.done).toBe('Done');
  });
});

describe('groupByStage', () => {
  it('files each open issue under the stage JIRA gives it', () => {
    const g = group({
      issues: [issue('A-1', 'todo'), issue('A-2', 'doing'), issue('A-3', 'todo')],
    });
    expect(keys(g.todo)).toEqual(['A-1', 'A-3']);
    expect(keys(g.doing)).toEqual(['A-2']);
    expect(g.done).toEqual([]);
    expect(g.elsewhere).toEqual([]);
  });

  it('keeps JIRA’s ordering within a stage', () => {
    const g = group({ issues: [issue('A-9', 'todo'), issue('A-2', 'todo'), issue('A-5', 'todo')] });
    expect(keys(g.todo)).toEqual(['A-9', 'A-2', 'A-5']);
  });

  it('puts resolved issues under Done even when the timer never saw them', () => {
    const g = group({ doneIssues: [issue('A-4', 'done')] });
    expect(keys(g.done)).toEqual(['A-4']);
    expect(g.done[0].timer).toBeNull();
  });

  // The new JQL splits on statusCategory, so this shouldn't arrive — but a
  // Done-column issue must not land under In Progress if it ever does.
  it('files a done-stage issue under Done even if it arrives in the open list', () => {
    const g = group({ issues: [issue('A-6', 'done')] });
    expect(keys(g.done)).toEqual(['A-6']);
    expect(g.doing).toEqual([]);
  });

  it('attaches the local timer to the issue it belongs to', () => {
    const g = group({
      issues: [issue('A-1', 'doing')],
      stories: { 'A-1': tracked('A-1', 30) },
    });
    expect(g.doing[0].timer?.key).toBe('A-1');
  });

  it('prefers JIRA’s metadata over the timer’s stale copy', () => {
    const g = group({
      doneIssues: [issue('A-1', 'done', { summary: 'Renamed in JIRA', assignee: 'Sam' })],
      stories: { 'A-1': tracked('A-1', 30, 0, { summary: 'Old name', assignee: 'Dana' }) },
    });
    expect(g.done[0].summary).toBe('Renamed in JIRA');
    expect(g.done[0].assignee).toBe('Sam');
  });

  describe('stories that have fallen off the board', () => {
    it('collects tracked work JIRA no longer lists here', () => {
      const g = group({
        issues: [issue('A-1', 'doing')],
        stories: { 'A-1': tracked('A-1', 30), 'B-7': tracked('B-7', 45) },
      });
      expect(keys(g.elsewhere)).toEqual(['B-7']);
    });

    // Without this the row would claim a stage the app cannot actually know:
    // all it knows is that the story isn't on the board currently displayed.
    it('does not promote them into Done', () => {
      const g = group({ stories: { 'B-7': tracked('B-7', 45) } });
      expect(g.done).toEqual([]);
      expect(keys(g.elsewhere)).toEqual(['B-7']);
    });

    it('ignores stories with no meaningful recorded time', () => {
      const g = group({
        stories: {
          'B-1': tracked('B-1', 0),
          'B-2': tracked('B-2', 0.5), // under a minute — would render as 0m
          'B-3': tracked('B-3', 0, 0, { loggedSeconds: 1800 }), // logged, so worth showing
        },
      });
      expect(keys(g.elsewhere)).toEqual(['B-3']);
    });

    it('orders the most recently worked first', () => {
      const g = group({
        stories: {
          'B-1': tracked('B-1', 10, 300),
          'B-2': tracked('B-2', 10, 5),
          'B-3': tracked('B-3', 10, 60),
        },
      });
      expect(keys(g.elsewhere)).toEqual(['B-2', 'B-3', 'B-1']);
    });

    it('orders by doneAt when the story was finished', () => {
      const g = group({
        stories: {
          'B-1': tracked('B-1', 10, 300, { doneAt: NOW - MIN }),
          'B-2': tracked('B-2', 10, 5),
        },
      });
      expect(keys(g.elsewhere)).toEqual(['B-1', 'B-2']);
    });

    it('falls back to the timer’s own tally when JIRA has no figure', () => {
      const g = group({ stories: { 'B-7': tracked('B-7', 45, 0, { loggedSeconds: 2700 }) } });
      expect(g.elsewhere[0].secondsSpent).toBe(2700);
    });

    // Switching boards while the clock runs must not make the clock disappear.
    it('keeps the running story even below the one-minute floor', () => {
      const g = group({
        stories: { 'B-7': running('B-7', 0.2) },
        activeKey: 'B-7',
      });
      expect(keys(g.elsewhere)).toEqual(['B-7']);
    });

    it('sorts a running story ahead of one finished moments ago', () => {
      const g = group({
        stories: { 'B-1': tracked('B-1', 10, 1), 'B-2': running('B-2', 3) },
        activeKey: 'B-2',
      });
      expect(keys(g.elsewhere)).toEqual(['B-2', 'B-1']);
    });
  });

  it('never lists the same key in two stages', () => {
    const g = group({
      issues: [issue('A-1', 'doing')],
      doneIssues: [issue('A-1', 'done')],
      stories: { 'A-1': tracked('A-1', 30) },
    });
    const all = [...g.todo, ...g.doing, ...g.done, ...g.elsewhere];
    expect(all.filter((r) => r.key === 'A-1')).toHaveLength(1);
  });

  it('carries the fields the rows render', () => {
    const g = group({
      issues: [
        issue('A-1', 'todo', {
          estimateSeconds: 7200,
          secondsSpent: 3600,
          description: 'Some detail',
          boardName: 'Platform',
        }),
      ],
    });
    expect(g.todo[0]).toMatchObject({
      key: 'A-1',
      status: 'To Do',
      estimateSeconds: 7200,
      secondsSpent: 3600,
      description: 'Some detail',
      boardName: 'Platform',
    });
  });
});

describe('preferredDoneTransition', () => {
  const t = (name: string, toStage: 'todo' | 'doing' | 'done', to = name) => ({
    id: name,
    name,
    to,
    toStage,
  });

  // The board this was written against returns exactly this shape.
  const board = [
    t('To Do', 'todo'),
    t('In Progress', 'doing'),
    t('Done', 'done'),
    t('In Test', 'doing'),
    t('Cancelled', 'done'),
  ];

  it('picks the transition that finishes the story', () => {
    expect(preferredDoneTransition(board)?.name).toBe('Done');
  });

  // The whole reason this isn't a `.find(toStage === 'done')`: JIRA's Done category
  // includes abandonment, and the endpoint's ordering isn't guaranteed.
  it('skips Cancelled even when it comes first', () => {
    const reordered = [t('Cancelled', 'done'), t('Done', 'done')];
    expect(preferredDoneTransition(reordered)?.name).toBe('Done');
  });

  it('recognises the usual ways of saying not-actually-finished', () => {
    for (const name of [
      'Cancelled',
      'Rejected',
      "Won't Do",
      'Wont do',
      'Abandoned',
      'Duplicate',
      'Invalid',
      'Declined',
      'Obsolete',
    ]) {
      expect(preferredDoneTransition([t(name, 'done')]), name).toBeNull();
    }
  });

  it('reads the destination status too, not just the transition name', () => {
    expect(preferredDoneTransition([t('Close issue', 'done', 'Cancelled')])).toBeNull();
  });

  it('is null when nothing leads into Done', () => {
    expect(preferredDoneTransition([t('To Do', 'todo'), t('In Progress', 'doing')])).toBeNull();
    expect(preferredDoneTransition([])).toBeNull();
  });
});

describe('focusKey', () => {
  it('is the running story whenever one is running', () => {
    const g = group({
      issues: [issue('A-1', 'doing'), issue('A-2', 'doing')],
      stories: { 'A-1': tracked('A-1', 90, 200), 'A-2': running('A-2', 3) },
      activeKey: 'A-2',
    });
    expect(focusKey(g, 'A-2', NOW)).toBe('A-2');
  });

  // The point of the whole function: pausing nulls activeKey, and the clock,
  // breakdown and estimate line must not vanish with it.
  it('survives a pause by falling back to the story worked most recently', () => {
    const g = group({
      issues: [issue('A-1', 'doing'), issue('A-2', 'doing')],
      stories: { 'A-1': tracked('A-1', 90, 200), 'A-2': tracked('A-2', 20, 2) },
    });
    expect(focusKey(g, null, NOW)).toBe('A-2');
  });

  it('focuses a To Do story that has time on it', () => {
    const g = group({
      issues: [issue('A-1', 'todo')],
      stories: { 'A-1': tracked('A-1', 20, 2) },
    });
    expect(focusKey(g, null, NOW)).toBe('A-1');
  });

  it('is nothing when no open story has been worked', () => {
    const g = group({ issues: [issue('A-1', 'todo'), issue('A-2', 'doing')] });
    expect(focusKey(g, null, NOW)).toBeNull();
  });

  // A finished story shouldn't reclaim the big card just by being the last thing
  // touched, and an off-board one has no column here to be focused in.
  it('ignores Done and off-board stories', () => {
    const g = group({
      doneIssues: [issue('A-3', 'done')],
      stories: { 'A-3': tracked('A-3', 60, 1), 'B-7': tracked('B-7', 60, 1) },
    });
    expect(focusKey(g, null, NOW)).toBeNull();
  });

  it('prefers the open story even when a Done one was touched later', () => {
    const g = group({
      issues: [issue('A-1', 'doing')],
      doneIssues: [issue('A-3', 'done')],
      stories: { 'A-1': tracked('A-1', 60, 90), 'A-3': tracked('A-3', 60, 1) },
    });
    expect(focusKey(g, null, NOW)).toBe('A-1');
  });
});

