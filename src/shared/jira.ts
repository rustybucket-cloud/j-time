/**
 * The JIRA plugin's slice of the snapshot.
 *
 * Everything the board section draws comes from here. `state` is the timer, and
 * it is the one part of this app whose file has no other copy — see `store.ts`.
 */

import type { MyselfResult } from './conn';
import type { JiraBoard, JiraIssue, JiraSprint, TimerState } from './types';
import type { JiraConfig } from './conn';

/** Config as the renderer sees it. The API token is never sent across the bridge. */
export type PublicJiraConfig = Omit<JiraConfig, 'apiToken'> & { hasToken: boolean };

export interface JiraSnapshot {
  conn: MyselfResult;
  config: PublicJiraConfig;
  /** Boards you have work in. Empty until the first successful fetch. */
  boards: JiraBoard[];
  sprint: JiraSprint | null;
  issues: JiraIssue[];
  doneIssues: JiraIssue[];
  state: TimerState;
}
