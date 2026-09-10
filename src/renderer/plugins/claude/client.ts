/**
 * The typed half of the Claude Code bridge.
 *
 * One verb, because the plugin only reads: the single thing j-time can do about
 * another session is put you where it is working.
 */

import type { ActionResult } from '@shared/plugin';

export const claude = {
  reveal: (cwd: string): Promise<ActionResult> => window.jt.invoke('claude', 'reveal', [cwd]),
};
