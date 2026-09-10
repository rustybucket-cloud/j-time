import type { ActionResult } from '@shared/plugin';

/**
 * The PR plugin has nothing to send.
 *
 * Every action it offers is "open this in a browser", which is a shell facility
 * — so this is a refresh and nothing else. Worth keeping as a file anyway: it is
 * where a "request changes" or "merge" command would land, and its emptiness is
 * a fair summary of how much of the shell contract a small plugin needs.
 */
export const github = {
  refresh: (): Promise<ActionResult> => window.jt.refresh('github'),
};
