/**
 * The single owner of everything the app knows: config, timer state, and the last
 * board fetch. Every mutation goes through here and every change is broadcast, so
 * the palette and the menu bar can never disagree about what's running.
 *
 * State mutations are serialised. Read-modify-write on `state` is not atomic
 * across an `await`, and filing time saves twice on purpose (labelled first,
 * marked logged only after JIRA accepts it) — so two overlapping actions could
 * otherwise interleave and lose a segment.
 */

import { EventEmitter } from 'events';
import type { JiraBoard, JiraIssue, JiraSprint, JiraTransition, TimerState } from '@shared/types';
import type { JiraConfig, MyselfResult } from '@shared/conn';
import { defaultConfig, missingCreds } from '@shared/conn';
import type { ActionResult, PublicConfig, Snapshot } from '@shared/ipc';
import { emptyState, pauseActive, relabelActivity, discardUnlogged, startTimer } from '@shared/timer-logic';
import { fileTime as fileTimeCore, finishStory } from '@shared/worklog';
import { createJira, type JiraClient } from './jira';
import { readConfig, readState, writeConfig, writeState } from './store';

/** How often the board is re-read while the app is running. */
export const POLL_MS = 60_000;
/** Opening the palette refreshes only if what's on screen is older than this. */
const STALE_MS = 15_000;

let config: JiraConfig = defaultConfig();
let state: TimerState = emptyState();
let jira: JiraClient = createJira(config);

// `checking` until the first getMyself answers. Later refreshes deliberately keep
// the last known result instead of returning here, for the same reason a failed
// fetch keeps the previous issues: a re-poll shouldn't unsettle what's on screen.
let conn: MyselfResult = { ok: false, status: 0, reason: 'checking', missing: [], baseUrl: null };
let boards: JiraBoard[] = [];
let sprint: JiraSprint | null = null;
let issues: JiraIssue[] = [];
let doneIssues: JiraIssue[] = [];
let loading = false;
let error: string | null = null;
let fetchedAt = 0;
let hotkeyRegistered = true;

export const events = new EventEmitter();

function publicConfig(): PublicConfig {
  const { apiToken, ...rest } = config;
  return { ...rest, hasToken: Boolean(apiToken) };
}

export function snapshot(): Snapshot {
  return {
    conn,
    config: publicConfig(),
    boards,
    sprint,
    issues,
    doneIssues,
    state,
    loading,
    error,
    fetchedAt,
    hotkeyRegistered,
  };
}

function emit(): void {
  events.emit('change', snapshot());
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
  emit();
}

const failed = (e: unknown): ActionResult => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e),
});

export async function load(): Promise<void> {
  config = await readConfig();
  jira = createJira(config);
  state = await readState();
  emit();
}

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

/**
 * Re-read the board.
 *
 * The previous issues stay on screen while this runs and survive a failure: a
 * dropped VPN shouldn't blank a list you're about to act on, and every action
 * except the two that call JIRA works fine against stale rows.
 */
export async function refresh(force = true): Promise<ActionResult> {
  if (!force && Date.now() - fetchedAt < STALE_MS) return { ok: true };
  if (loading) return { ok: true };

  loading = true;
  emit();
  try {
    conn = await jira.getMyself();
    if (!conn.ok) {
      error = conn.error ?? null;
      return { ok: false, error: error ?? 'Not connected' };
    }
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
          emit();
        },
        () => undefined,
      );
    }
    error = null;
    fetchedAt = Date.now();
    return { ok: true };
  } catch (e: unknown) {
    const result = failed(e);
    error = result.ok ? null : result.error;
    return result;
  } finally {
    loading = false;
    emit();
  }
}

/** Called when the palette opens: cheap if the list is already current. */
export function refreshIfStale(): void {
  void refresh(false);
}

export function startPolling(): NodeJS.Timeout {
  return setInterval(() => void refresh(), POLL_MS);
}

// --- Timer actions. These never touch JIRA, so they work when it is down. ---

export function start(key: string): Promise<ActionResult> {
  return serial(async () => {
    await save(startTimer(state, issueMeta(key), Date.now()));
    return { ok: true, message: `Started ${key}` } as ActionResult;
  });
}

export function stop(activity?: string): Promise<ActionResult> {
  return serial(async () => {
    const key = state.activeKey;
    if (!key) return { ok: false, error: 'Nothing is running.' } as ActionResult;
    await save(pauseActive(state, Date.now(), activity));
    return { ok: true, message: activity ? `Stopped ${key} as ${activity}` : `Stopped ${key}` };
  });
}

export function relabel(key: string, from: string, to: string): Promise<ActionResult> {
  return serial(async () => {
    await save(relabelActivity(state, key, from, to));
    return { ok: true, message: `Moved ${from} to ${to}` } as ActionResult;
  });
}

export function discard(key: string, activity: string): Promise<ActionResult> {
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
export function fileTime(key: string, activity: string): Promise<ActionResult> {
  return serial(async () => {
    const now = Date.now();
    if (state.activeKey === key) await save(pauseActive(state, now, activity));

    const result = await fileTimeCore(state, key, activity, {
      writer: jira,
      save,
      now,
    });
    if (!result.ok) return { ok: false, error: result.error } as ActionResult;

    void refresh();
    return { ok: true, message: `Filed ${Math.round(result.loggedSeconds / 60)}m of ${activity} on ${key}` };
  });
}

/**
 * Sweep whatever filing didn't send, then move the story's status. Usually there
 * is nothing left to sweep, which is what makes finishing a story one keystroke.
 */
export function finish(key: string, transitionId?: string): Promise<ActionResult> {
  return serial(async () => {
    const now = Date.now();
    const result = await finishStory(
      state,
      key,
      { transitionId, roundMinutes: config.roundMinutes },
      { writer: jira, save, now },
    );
    if (!result.ok) return { ok: false, error: result.error } as ActionResult;

    void refresh();
    const logged = result.loggedSeconds > 0 ? `, logged ${Math.round(result.loggedSeconds / 60)}m` : '';
    return { ok: true, message: `Finished ${key}${logged}` };
  });
}

/** A plain status change, with no time logged. */
export function transition(key: string, transitionId: string): Promise<ActionResult> {
  return serial(async () => {
    try {
      await jira.doTransition(key, transitionId);
      void refresh();
      return { ok: true, message: `Moved ${key}` } as ActionResult;
    } catch (e: unknown) {
      return failed(e);
    }
  });
}

export async function getTransitions(key: string) {
  try {
    return { ok: true as const, transitions: await jira.getTransitions(key) };
  } catch (e: unknown) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

export function issueUrl(key: string): string {
  return jira.issueUrl(key);
}

export function setHotkeyRegistered(ok: boolean): void {
  hotkeyRegistered = ok;
  emit();
}

export function currentConfig(): JiraConfig {
  return config;
}

/**
 * Apply a config change and re-read the board with it.
 *
 * A patch that omits `apiToken` leaves the stored one alone — the settings form
 * never receives the token, so an untouched field must not be able to erase it.
 */
export async function saveConfigPatch(patch: Partial<JiraConfig>): Promise<ActionResult> {
  const next: JiraConfig = { ...config, ...patch };
  if (patch.apiToken === undefined) next.apiToken = config.apiToken;
  next.baseUrl = next.baseUrl.trim().replace(/\/$/, '');
  next.email = next.email.trim();

  config = next;
  jira = createJira(config);
  try {
    await writeConfig(config);
  } catch (e: unknown) {
    return failed(e);
  }
  events.emit('config', config);
  emit();

  // Credentials that aren't complete yet would only produce a confusing error.
  if (missingCreds(config).length === 0) await refresh();
  return { ok: true, message: 'Settings saved' };
}

export interface RunningSummary {
  key: string;
  summary: string;
  since: number;
}

/** What the menu bar needs: the open segment, if there is one. */
export function running(): RunningSummary | null {
  const key = state.activeKey;
  if (!key) return null;
  const story = state.stories[key];
  const last = story?.segments[story.segments.length - 1];
  if (!story || !last || last.end !== null) return null;
  return { key, summary: story.summary, since: last.start };
}

export function currentState(): TimerState {
  return state;
}

export type { JiraTransition };
