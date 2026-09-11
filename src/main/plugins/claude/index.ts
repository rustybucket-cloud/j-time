/**
 * The Claude Code plugin: which sessions are open, and which one wants you.
 *
 * It owns no credentials and writes nothing — the whole plugin is a read of two
 * of Claude Code's own files, so `configured()` is true from the first launch and
 * the section has something to say before anybody has opened a settings form.
 *
 * The polling is fast because the reading is cheap: a session that isn't busy is
 * never waiting on anything, so its transcript is never opened.
 */

import os from 'os';
import type { MenuItemConstructorOptions } from 'electron';
import { shell as electronShell } from 'electron';
import type { ActionResult } from '@shared/plugin';
import {
  attentionCount,
  buildSessionItems,
  defaultClaudeConfig,
  describeSessions,
  type ClaudeConfig,
  type ClaudeSession,
  type ClaudeSnapshot,
} from '@shared/claude';
import { formatDurationShort } from '@shared/time';
import { str, type MainPlugin, type MenuBarState } from '../../plugin';
import { readSessions } from './sessions';

/**
 * Sessions change state in seconds, and the point of the plugin is being told
 * promptly. A poll costs one small file per session plus a tail for whichever of
 * them is busy, which is usually none of them.
 */
const POLL_MS = 5_000;

let config: ClaudeConfig = defaultClaudeConfig();
let sessions: ClaudeSession[] = [];
let read = false;

/** The sessions waiting on you, longest wait first. */
function waiting(): ClaudeSession[] {
  const now = Date.now();
  return buildSessionItems(sessions, now, { ...config, idleDays: 0 })
    .filter((item) => item.state === 'attention')
    .map((item) => item.session);
}

export const plugin: MainPlugin<ClaudeSnapshot, ClaudeConfig> = {
  id: 'claude',
  title: 'Claude Code',
  secrets: [],
  refreshMs: POLL_MS,
  defaults: defaultClaudeConfig,

  // Nothing to prepare: no state file of its own, and no client to build. The
  // shell's polling is the only thing that has to happen.
  init: () => undefined,

  configure(next) {
    config = {
      ...next,
      hidden: Array.isArray(next.hidden) ? next.hidden : [],
      dismissed: Array.isArray(next.dismissed) ? next.dismissed : [],
    };
  },

  // Nothing to set up: the files are already there or they are not, and a machine
  // that has never run Claude Code gets an empty section rather than a form.
  configured: () => true,

  snapshot: () => ({ config, sessions, read, home: os.homedir() }),

  async refresh() {
    sessions = await readSessions();
    read = true;
    return { ok: true };
  },

  commands: {
    /**
     * Show a session's working directory in Finder.
     *
     * The one thing j-time can actually do about a session that wants you: there
     * is no way to raise somebody else's terminal window, so the honest action is
     * to put you where that session is working.
     */
    async reveal(args): Promise<ActionResult> {
      const cwd = str(args, 0);
      const error = await electronShell.openPath(cwd);
      return error ? { ok: false, error } : { ok: true, message: `Opened ${cwd}` };
    },
  },

  /**
   * One tool, and it only reads.
   *
   * The plugin owns no credentials and writes nothing, so there is nothing here
   * to act on — and the read is worth exposing precisely because a session
   * cannot see its peers: the file it would have to interpret says `busy` for a
   * build and for a permission prompt alike, and `sessionState` is the rule that
   * tells them apart.
   */
  mcp: () => [
    {
      name: 'list_sessions',
      readOnly: true,
      description:
        'Every Claude Code session open on this machine, grouped by what it is doing: ' +
        'waiting on the user, working, just finished, or idle. A waiting session shows what ' +
        'it is blocked on and for how long — derived from its transcript, since the session ' +
        "file itself says only 'busy'. Sessions the user hid are left out.",
      run: () => describeSessions(sessions, Date.now(), config, os.homedir()),
    },
  ],

  /**
   * A count, and only when it isn't zero.
   *
   * JIRA registers first and so keeps the menu bar whenever a timer is running —
   * a clock you have forgotten is the more expensive thing to miss. This takes
   * the slot the rest of the time, which is exactly when a session that stopped
   * to ask you something would otherwise go unnoticed.
   */
  menuBar(): MenuBarState | null {
    const count = attentionCount(sessions, Date.now(), config);
    if (count === 0) return null;
    return {
      title: `⚑ ${count}`,
      tooltip: `${count} Claude session${count === 1 ? '' : 's'} waiting on you`,
      // The number changes when a session does, and every change already emits.
      live: false,
    };
  },

  /** Only contributes when something is waiting, so it never pads the menu. */
  trayMenu(): MenuItemConstructorOptions[] {
    const now = Date.now();
    const items = waiting();
    if (items.length === 0) return [];
    return [
      { label: 'Waiting on you', enabled: false },
      ...items.map((session) => {
        const since = session.open ? Math.floor((now - session.open.at) / 1000) : 0;
        return {
          label: `${session.name} — ${session.open?.tool ?? 'waiting'} · ${formatDurationShort(since)}`.slice(0, 60),
          click: () => void electronShell.openPath(session.cwd),
        };
      }),
    ];
  },
};
