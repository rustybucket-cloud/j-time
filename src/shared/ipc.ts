/**
 * The contract between the main process and the palette.
 *
 * The renderer never talks to JIRA and never touches disk: it renders a Snapshot
 * and sends back intents. That's what keeps the credentials, the state file and
 * the ordering rules in one process with one writer.
 */

import type { JiraBoard, JiraIssue, JiraSprint, JiraTransition, TimerState } from './types';
import type { JiraConfig, MyselfResult } from './conn';

/** Config as the renderer sees it. The API token is never sent across the bridge. */
export type PublicConfig = Omit<JiraConfig, 'apiToken'> & { hasToken: boolean };

export interface Snapshot {
  conn: MyselfResult;
  config: PublicConfig;
  /** Boards you have work in. Empty until the first successful fetch. */
  boards: JiraBoard[];
  sprint: JiraSprint | null;
  issues: JiraIssue[];
  doneIssues: JiraIssue[];
  state: TimerState;
  /** A fetch is in flight. The list stays on screen while it is. */
  loading: boolean;
  /** Why the last fetch failed, if it did. Stale issues are still shown. */
  error: string | null;
  fetchedAt: number;
  /** False when another app already owns the hotkey, so Settings can say so. */
  hotkeyRegistered: boolean;
}

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/** Everything `window.jt` exposes. Kept here so both sides typecheck against it. */
export interface Bridge {
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(fn: (snapshot: Snapshot) => void): () => void;
  refresh(): Promise<ActionResult>;

  start(key: string): Promise<ActionResult>;
  stop(activity?: string): Promise<ActionResult>;
  fileTime(key: string, activity: string): Promise<ActionResult>;
  finish(key: string, transitionId?: string): Promise<ActionResult>;
  transition(key: string, transitionId: string): Promise<ActionResult>;
  relabel(key: string, from: string, to: string): Promise<ActionResult>;
  discard(key: string, activity: string): Promise<ActionResult>;

  getTransitions(key: string): Promise<{ ok: true; transitions: JiraTransition[] } | { ok: false; error: string }>;
  openIssue(key: string): Promise<void>;
  /** Any http(s) link the app built — the JIRA home page, say. */
  openUrl(url: string): Promise<void>;
  copy(text: string): Promise<void>;

  saveConfig(patch: Partial<JiraConfig>): Promise<ActionResult>;
  setHeight(height: number): Promise<void>;
  /** Off while a form is open, so switching apps to copy a token doesn't lose it. */
  setDismissOnBlur(value: boolean): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<void>;
}
