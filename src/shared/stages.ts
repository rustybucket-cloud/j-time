import { activeSeconds } from './time';
import type { JiraIssue, Stage, StoryTimer } from './types';

/**
 * The board's three columns. JIRA calls these status *categories*; every status,
 * however a project renames it, maps to exactly one of them. Grouping on the
 * category rather than the status name is what keeps this app's sections and the
 * real board in agreement no matter what a team calls its columns.
 */
export type { Stage };

export const STAGE_LABELS: Record<Stage, string> = {
  todo: 'To Do',
  doing: 'In Progress',
  done: 'Done',
};

/** Board order, so the page reads top-to-bottom the way the board reads left-to-right. */
export const STAGE_ORDER: Stage[] = ['todo', 'doing', 'done'];

/**
 * `statusCategory.key` is one of `new` | `indeterminate` | `done`.
 *
 * Anything else falls back to `doing`: an unrecognised category means JIRA changed
 * or the field went unrequested, and in-flight is the bucket where a story stays
 * visible next to the work rather than being quietly filed as finished.
 */
export function stageFor(categoryKey: string | null | undefined): Stage {
  switch ((categoryKey ?? '').toLowerCase()) {
    case 'new':
      return 'todo';
    case 'done':
      return 'done';
    default:
      return 'doing';
  }
}

/** Statuses that close a story without it having been completed. */
const NOT_COMPLETED = /cancel|reject|won'?t\s*do|abandon|duplicate|invalid|declin|obsolete/i;

/**
 * Which transition the Done dialog should preselect — one that lands in the Done
 * column, and specifically one that means the work got finished.
 *
 * JIRA's Done *category* covers abandonment as well as completion: most boards
 * have both "Done" and "Cancelled" in it, and the order the transitions endpoint
 * returns them in isn't guaranteed. Preselecting the first match would sometimes
 * arm the dialog to write finished work off as cancelled.
 *
 * Returns null when the only way into Done is one of those, so the dialog falls
 * back to leaving the status alone rather than guessing.
 */
export function preferredDoneTransition<T extends { name: string; to: string; toStage: Stage }>(
  transitions: T[],
): T | null {
  const intoDone = transitions.filter((t) => t.toStage === 'done');
  return intoDone.find((t) => !NOT_COMPLETED.test(`${t.name} ${t.to}`)) ?? null;
}

/** One story as the page renders it, whether JIRA, the local timer, or both know it. */
export interface StageRow {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  estimateSeconds: number | null;
  secondsSpent: number | null;
  description: string | null;
  boardName?: string | null;
  timer: StoryTimer | null;
}

export interface StageGroups {
  todo: StageRow[];
  doing: StageRow[];
  done: StageRow[];
  /**
   * Tracked time for stories the current board and assignee filter no longer list.
   * They have no stage here — all the app knows is that they aren't on this board —
   * so they get their own group instead of being asserted as Done.
   */
  elsewhere: StageRow[];
}

function rowFromIssue(issue: JiraIssue, timer: StoryTimer | null): StageRow {
  return {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    assignee: issue.assignee,
    estimateSeconds: issue.estimateSeconds,
    secondsSpent: issue.secondsSpent,
    description: issue.description,
    boardName: issue.boardName,
    timer,
  };
}

function rowFromTimer(story: StoryTimer): StageRow {
  return {
    key: story.key,
    summary: story.summary,
    status: story.status,
    assignee: story.assignee,
    estimateSeconds: story.estimateSeconds,
    // Our own tally is the best figure available when JIRA has no copy of this issue.
    secondsSpent: story.loggedSeconds,
    description: null,
    timer: story,
  };
}

/** Below a minute a duration renders as "0m", which is noise rather than a signal. */
function hasRecordedTime(story: StoryTimer, now: number): boolean {
  return activeSeconds(story.segments, now) >= 60 || (story.loggedSeconds ?? 0) > 0;
}

function lastActivity(story: StoryTimer, now: number): number {
  const last = story.segments[story.segments.length - 1];
  // A running segment has no end. Left to fall through it would sort as epoch 0,
  // putting the story you're working on right now at the bottom of the list.
  if (last && last.end === null) return now;
  return story.doneAt ?? last?.end ?? 0;
}

/**
 * The story whose full readout stays on screen — clock, activity breakdown,
 * estimate line — as opposed to a one-line row.
 *
 * It's the running story, or when nothing is running the open story worked most
 * recently. Pausing sets `activeKey` to null, so keying the expanded card off the
 * timer alone made every one of those figures vanish the moment you stopped, and
 * the only way back was to press Resume and start the clock again.
 *
 * Only To Do and In Progress are eligible: a Done story is finished and recedes,
 * and an off-board one has no column here to be focused in.
 */
export function focusKey(
  groups: StageGroups,
  activeKey: string | null,
  now: number,
): string | null {
  if (activeKey) return activeKey;
  let best: { key: string; at: number } | null = null;
  for (const row of [...groups.todo, ...groups.doing]) {
    const story = row.timer;
    if (!story || activeSeconds(story.segments, now) <= 0) continue;
    const at = lastActivity(story, now);
    if (!best || at > best.at) best = { key: row.key, at };
  }
  return best?.key ?? null;
}

/**
 * Split everything the page knows about into the board's columns, plus the
 * off-board leftovers.
 *
 * `issues` is the open list and `doneIssues` the resolved one, but neither is
 * trusted to imply a stage — each issue is filed by its own `stage`, so a
 * Done-column story that shows up in the open list still lands under Done.
 */
export function groupByStage({
  issues,
  doneIssues,
  stories,
  now,
  activeKey = null,
}: {
  issues: JiraIssue[];
  doneIssues: JiraIssue[];
  stories: Record<string, StoryTimer>;
  now: number;
  /** Never dropped from `elsewhere`, so a running clock can't go missing. */
  activeKey?: string | null;
}): StageGroups {
  const groups: StageGroups = { todo: [], doing: [], done: [], elsewhere: [] };
  const seen = new Set<string>();

  // Open issues first, so their (more current) copy wins if a key somehow appears
  // in both lists.
  for (const issue of [...issues, ...doneIssues]) {
    if (seen.has(issue.key)) continue;
    seen.add(issue.key);
    groups[issue.stage].push(rowFromIssue(issue, stories[issue.key] ?? null));
  }

  const orphans = Object.values(stories)
    .filter((s) => !seen.has(s.key) && (s.key === activeKey || hasRecordedTime(s, now)))
    .sort((a, b) => lastActivity(b, now) - lastActivity(a, now));
  for (const story of orphans) groups.elsewhere.push(rowFromTimer(story));

  return groups;
}
