/**
 * The JIRA board, flattened into the rows its section shows.
 *
 * Lived in `palette.ts` when the board was the only thing the palette listed.
 * The ranking stayed; this moved out, because a shell that hosts a second plugin
 * cannot have JIRA's columns compiled into its ranking module.
 */

import { activeSeconds, isRunning } from './time';
import type { Searchable } from './palette';
import type { StageGroups, StageRow } from './stages';
import { unloggedSeconds } from './timer-logic';

export const SUBSECTION_LABELS = {
  doing: 'In Progress',
  todo: 'To Do',
  done: 'Done',
  elsewhere: 'Tracked elsewhere',
} as const;

export interface IssueItem extends Searchable {
  kind: 'issue';
  row: StageRow;
  /** The board column this issue sits in, as a heading inside the JIRA section. */
  subsection: string;
  running: boolean;
  /** Every second this app has measured against the story. */
  trackedSeconds: number;
  /** Tracked time no worklog covers yet — what filing or Done would still send. */
  unloggedSeconds: number;
}

/**
 * One item per issue, in board order.
 *
 * In Progress leads because it is the reason this app opens on a keystroke: the
 * question being answered is "which of the things I'm in the middle of am I about
 * to work on". To Do follows, then Done, then stories the current board no longer
 * lists.
 *
 * The running story is *not* hoisted here any more. It carries `running`, and the
 * shell lifts it into the pinned section above every plugin — which is the same
 * treatment it had when JIRA was the only list, now available to the PR section
 * too and switchable off per plugin.
 */
export function buildIssueItems(groups: StageGroups, now: number): IssueItem[] {
  const order: (keyof typeof SUBSECTION_LABELS)[] = ['doing', 'todo', 'done', 'elsewhere'];
  const items: IssueItem[] = [];

  for (const stage of order) {
    for (const row of groups[stage]) {
      const timer = row.timer;
      const running = timer ? isRunning(timer.segments) : false;
      items.push({
        kind: 'issue',
        id: `issue:${row.key}`,
        title: row.key,
        subtitle: row.summary,
        keywords: [row.status, row.boardName ?? '', row.assignee ?? ''].filter(Boolean),
        row,
        subsection: SUBSECTION_LABELS[stage],
        running,
        trackedSeconds: timer ? activeSeconds(timer.segments, now) : 0,
        unloggedSeconds: timer ? unloggedSeconds(timer, now) : 0,
      });
    }
  }

  return items;
}
