/**
 * The JIRA plugin: the board, the timer, and the two actions that write to JIRA.
 *
 * This was `data.ts` when it was the whole app. What left is everything the shell
 * now owns — the config file, the snapshot broadcast, the polling and the
 * staleness rule. What stayed is every rule about *time*, unchanged.
 *
 * State mutations are still serialised. Read-modify-write on `state` is not
 * atomic across an `await`, and filing time saves twice on purpose (labelled
 * first, marked logged only after JIRA accepts it) — so two overlapping actions
 * could otherwise interleave and lose a segment.
 */

import type { MenuItemConstructorOptions } from 'electron';
import type { JiraBoard, JiraIssue, JiraSprint, TimerState } from '@shared/types';
import { defaultConfig, missingCreds, type JiraConfig, type MyselfResult } from '@shared/conn';
import type { ActionResult, QueryResult } from '@shared/plugin';
import type { JiraSnapshot, PublicJiraConfig } from '@shared/jira';
import {
  emptyState,
  pauseActive,
  relabelActivity,
  discardUnlogged,
  startTimer,
} from '@shared/timer-logic';
import { activeSeconds, formatBar } from '@shared/time';
import { fileTime as fileTimeCore, finishStory } from '@shared/worklog';
import { readState, writeState } from '../../store';
import { str, optionalStr, type MainPlugin, type MenuBarState, type PluginHost } from '../../plugin';
import { createJira, type JiraClient } from './client';
import { jiraTools } from './tools';

/** How often the board is re-read while the app is running. */
const POLL_MS = 60_000;

let config: JiraConfig = defaultConfig();
let state: TimerState = emptyState();
let jira: JiraClient = createJira(config);
let host: PluginHost = { changed: () => undefined, refresh: () => undefined };

// `checking` until the first getMyself answers. Later refreshes deliberately keep
// the last known result instead of returning here, for the same reason a failed
// fetch keeps the previous issues: a re-poll shouldn't unsettle what's on screen.
let conn: MyselfResult = { ok: false, status: 0, reason: 'checking', missing: [], baseUrl: null };
let boards: JiraBoard[] = [];
let sprint: JiraSprint | null = null;
let issues: JiraIssue[] = [];
let doneIssues: JiraIssue[] = [];

function publicConfig(): PublicJiraConfig {
  const { apiToken, ...rest } = config;
  return { ...rest, hasToken: Boolean(apiToken) };
}

/** Actions run one at a time, in the order they were requested. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function save(next: TimerState): Promise<void> {
  state = next;
  await writeState(state);
  host.changed();
}

const failed = (e: unknown): ActionResult => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e),
});

/** The timer's own view of a story, for when JIRA has no copy in the current fetch. */
function issueMeta(key: string) {
  const issue = [...issues, ...doneIssues].find((i) => i.key === key);
  if (issue) return issue;
  const story = state.stories[key];
  if (story) {
    return {
      key,
      summary: story.summary,
      status: story.status,
      assignee: story.assignee,
      estimateSeconds: story.estimateSeconds,
    };
  }
  return { key, summary: '', status: '', assignee: null, estimateSeconds: null };
}

// --- Timer actions. These never touch JIRA, so they work when it is down. ---

function start(key: string): Promise<ActionResult> {
  return serial(async () => {
    await save(startTimer(state, issueMeta(key), Date.now()));
    return { ok: true, message: `Started ${key}` } as ActionResult;
  });
}

function stop(activity?: string): Promise<ActionResult> {
  return serial(async () => {
    const key = state.activeKey;
    if (!key) return { ok: false, error: 'Nothing is running.' } as ActionResult;
    await save(pauseActive(state, Date.now(), activity));
    return { ok: true, message: activity ? `Stopped ${key} as ${activity}` : `Stopped ${key}` };
  });
}

function relabel(key: string, from: string, to: string): Promise<ActionResult> {
  return serial(async () => {
    await save(relabelActivity(state, key, from, to));
    return { ok: true, message: `Moved ${from} to ${to}` } as ActionResult;
  });
}

function discard(key: string, activity: string): Promise<ActionResult> {
  return serial(async () => {
    await save(discardUnlogged(state, key, activity));
    return { ok: true, message: `Discarded unlogged ${activity} time` } as ActionResult;
  });
}

// --- The two actions that write to JIRA. ---

/**
 * File every stopped, unlogged chunk under one activity.
 *
 * Stopping first is deliberate rather than convenient: the running chunk isn't
 * classifiable until it's closed, so filing while the clock runs would silently
 * leave the time you just spent out of the worklog.
 */
function fileTime(key: string, activity: string): Promise<ActionResult> {
  return serial(async () => {
    const now = Date.now();
    if (state.activeKey === key) await save(pauseActive(state, now, activity));

    const result = await fileTimeCore(state, key, activity, { writer: jira, save, now });
    if (!result.ok) return { ok: false, error: result.error } as ActionResult;

    host.refresh();
    return {
      ok: true,
      message: `Filed ${Math.round(result.loggedSeconds / 60)}m of ${activity} on ${key}`,
    };
  });
}

/**
 * Sweep whatever filing didn't send, then move the story's status. Usually there
 * is nothing left to sweep, which is what makes finishing a story one keystroke.
 */
function finish(key: string, transitionId?: string): Promise<ActionResult> {
  return serial(async () => {
    const now = Date.now();
    const result = await finishStory(
      state,
      key,
      { transitionId, roundMinutes: config.roundMinutes },
      { writer: jira, save, now },
    );
    if (!result.ok) return { ok: false, error: result.error } as ActionResult;

    host.refresh();
    const logged =
      result.loggedSeconds > 0 ? `, logged ${Math.round(result.loggedSeconds / 60)}m` : '';
    return { ok: true, message: `Finished ${key}${logged}` };
  });
}

/** A plain status change, with no time logged. */
function transition(key: string, transitionId: string): Promise<ActionResult> {
  return serial(async () => {
    try {
      await jira.doTransition(key, transitionId);
      host.refresh();
      return { ok: true, message: `Moved ${key}` } as ActionResult;
    } catch (e: unknown) {
      return failed(e);
    }
  });
}

/** What the menu bar needs: the open segment, if there is one. */
function running(): { key: string; summary: string } | null {
  const key = state.activeKey;
  if (!key) return null;
  const story = state.stories[key];
  const last = story?.segments[story.segments.length - 1];
  if (!story || !last || last.end !== null) return null;
  return { key, summary: story.summary };
}

/**
 * The MCP tools, built once.
 *
 * Every one of them goes through the same functions the palette's rows do —
 * `serial()` included, so a tool call and a keystroke can't interleave on the
 * state file. The deps are getters rather than values because this is built
 * before the first fetch and before the config is read.
 */
const TOOLS = jiraTools({
  now: () => Date.now(),
  state: () => state,
  config: () => config,
  // Done issues included: a story finished this sprint is exactly the one
  // somebody asks about after the fact.
  issues: () => [...issues, ...doneIssues],
  transitions: (key) => jira.getTransitions(key),
  start,
  stop,
  fileTime,
  finish,
  transition,
  relabel,
});

export const plugin: MainPlugin<JiraSnapshot, JiraConfig> = {
  id: 'jira',
  title: 'JIRA',
  secrets: ['apiToken'],
  refreshMs: POLL_MS,
  defaults: defaultConfig,

  init(h) {
    host = h;
    void readState().then((loaded) => {
      state = loaded;
      host.changed();
    });
  },

  configure(next) {
    config = { ...next };
    config.baseUrl = config.baseUrl.trim().replace(/\/$/, '');
    config.email = config.email.trim();
    jira = createJira(config);
  },

  configured: () => missingCreds(config).length === 0,

  snapshot: () => ({ conn, config: publicConfig(), boards, sprint, issues, doneIssues, state }),

  /**
   * Re-read the board.
   *
   * The previous issues stay on screen while this runs and survive a failure —
   * the shell guarantees that now, for every plugin.
   */
  async refresh() {
    conn = await jira.getMyself();
    if (!conn.ok) return { ok: false, error: conn.error ?? 'Not connected' };

    if (config.boardId == null) {
      const all = await jira.getAllMyBoardIssues(config.mineOnly);
      issues = all.issues;
      doneIssues = all.doneIssues;
      boards = all.boards;
      // "Current iteration" means nothing across several boards at once.
      sprint = null;
    } else {
      const one = await jira.getBoardIssues(config.boardId, config.mineOnly);
      issues = one.issues;
      doneIssues = one.doneIssues;
      sprint = one.sprint;
      // Kept fresh in the background so the board picker has something to show.
      jira.getMyBoards().then(
        (b) => {
          boards = b;
          host.changed();
        },
        () => undefined,
      );
    }
    return { ok: true };
  },

  commands: {
    start: (args) => start(str(args, 0)),
    stop: (args) => stop(optionalStr(args, 0)),
    fileTime: (args) => fileTime(str(args, 0), str(args, 1)),
    finish: (args) => finish(str(args, 0), optionalStr(args, 1)),
    transition: (args) => transition(str(args, 0), str(args, 1)),
    relabel: (args) => relabel(str(args, 0), str(args, 1), str(args, 2)),
    discard: (args) => discard(str(args, 0), str(args, 1)),
  },

  queries: {
    async transitions(args): Promise<QueryResult<unknown>> {
      return { ok: true, data: await jira.getTransitions(str(args, 0)) };
    },
  },

  mcp: () => TOOLS,

  /**
   * The title is the whole point of the menu bar item. A timer you have to open
   * something to check is a timer you forget is running, which is how tracked
   * time stops matching reality.
   */
  menuBar(): MenuBarState | null {
    const run = running();
    if (!run) return null;
    const story = state.stories[run.key];
    const seconds = story ? activeSeconds(story.segments, Date.now()) : 0;
    return {
      title: `▶ ${formatBar(seconds)}`,
      tooltip: `${run.key} — ${run.summary}`,
      live: true,
    };
  },

  trayMenu(): MenuItemConstructorOptions[] {
    const run = running();
    if (!run) return [{ label: 'Nothing running', enabled: false }];
    return [
      { label: `${run.key} — ${run.summary}`.slice(0, 60), enabled: false },
      { label: 'Stop timer', click: () => void stop() },
      {
        label: 'Stop and file as',
        enabled: config.activities.length > 0,
        submenu: config.activities.map((activity) => ({
          label: activity,
          click: () => void fileTime(run.key, activity),
        })),
      },
    ];
  },
};
