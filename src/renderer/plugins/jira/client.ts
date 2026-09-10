/**
 * The typed half of the JIRA bridge.
 *
 * `window.jt.invoke` is deliberately untyped — it has to be, to carry any
 * plugin's commands — so the argument names live here instead, next to the code
 * that knows what they mean. The old named bridge methods are these, moved.
 */

import type { ActionResult } from '@shared/plugin';
import type { JiraTransition } from '@shared/types';

const run = (command: string, ...args: unknown[]): Promise<ActionResult> =>
  window.jt.invoke('jira', command, args);

export const jira = {
  start: (key: string) => run('start', key),
  stop: (activity?: string) => run('stop', activity),
  fileTime: (key: string, activity: string) => run('fileTime', key, activity),
  finish: (key: string, transitionId?: string) => run('finish', key, transitionId),
  transition: (key: string, transitionId: string) => run('transition', key, transitionId),
  relabel: (key: string, from: string, to: string) => run('relabel', key, from, to),
  discard: (key: string, activity: string) => run('discard', key, activity),

  async transitions(key: string): Promise<JiraTransition[]> {
    const result = await window.jt.query('jira', 'transitions', [key]);
    if (!result.ok) throw new Error(result.error);
    return result.data as JiraTransition[];
  },

  /** The browse URL, built here because the renderer already has the base URL. */
  issueUrl: (baseUrl: string, key: string) =>
    `${baseUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(key)}`,
};
