// Epoch-millisecond timestamps throughout.

/**
 * The board's three columns, from JIRA's status categories. Lives here rather than
 * in `stages.ts` so `JiraIssue` can name it without importing back the other way.
 */
export type Stage = 'todo' | 'doing' | 'done';

export interface Segment {
  start: number;
  end: number | null; // null = currently running
  /** What this chunk was spent on. Absent on pre-activity data → Unlabelled. */
  activity?: string | null;
  /** True once a worklog has covered this chunk, so Done won't re-log it. */
  logged?: boolean;
}

export interface StoryTimer {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  estimateSeconds: number | null;
  segments: Segment[];
  doneAt: number | null;
  worklogId: string | null;
  loggedSeconds: number | null;
}

export interface TimerState {
  activeKey: string | null;
  stories: Record<string, StoryTimer>;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  /**
   * Which board column this status belongs to, from JIRA's own status category.
   * Grouping on this rather than on `status` survives a team renaming its columns.
   */
  stage: Stage;
  assignee: string | null;
  issuetype: string;
  priority: string | null;
  estimateSeconds: number | null;
  /**
   * JIRA's total time spent on the issue — the source of truth. Includes worklogs
   * created before this app was installed, or outside it, or by someone else.
   * Distinct from StoryTimer.loggedSeconds, which is only what this app sent.
   */
  secondsSpent: number | null;
  description: string | null;
  /** Which board this came from. Only set in the all-boards view. */
  boardName?: string | null;
}

export interface JiraTransition {
  id: string;
  name: string;
  /** Display name of the status this lands on. */
  to: string;
  /** Which board column `to` belongs to. */
  toStage: Stage;
}

export interface JiraBoard {
  id: number;
  name: string;
  type: string;
}

export interface JiraSprint {
  id: number;
  name: string;
}
