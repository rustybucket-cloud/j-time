/**
 * The two operations that send time to JIRA: filing a stopped chunk under an activity,
 * and the Done sweep.
 *
 * These are the forty lines every hard-won rule about rounding is about — `sweepSeconds`
 * rather than `roundSeconds`, `unloggedByActivity` rather than `trackedByActivity`,
 * labelling before the request and marking logged only after it. They live apart from
 * the IPC handlers that call them so there is exactly one copy: two would drift apart
 * and re-introduce those bugs one at a time.
 *
 * JIRA is injected rather than imported, which keeps this module (and therefore the
 * rules) reachable from the tests without an Electron main process around it.
 */

import type { ActivityShare } from './activities';
import { apportion } from './activities';
import type { TimerState } from './types';
import {
  classifiable,
  classifiableSeconds,
  labelClassifiable,
  markClassified,
  markDone,
  MIN_LOGGABLE_SECONDS,
  sweepSeconds,
  unloggedByActivity,
} from './timer-logic';

/** The slice of `lib/jira.ts` that writing time needs. */
export interface WorklogWriter {
  addWorklog(
    key: string,
    timeSpentSeconds: number,
    comment: string,
    startedMs: number,
  ): Promise<{ id: string }>;
  doTransition(key: string, transitionId: string): Promise<void>;
}

export interface WorklogDeps {
  writer: WorklogWriter;
  /** Persist mid-operation. Called more than once: the ordering is the point. */
  save(state: TimerState): Promise<void>;
  now: number;
}

export type FileTimeResult =
  | { ok: true; worklogId: string; loggedSeconds: number }
  | {
      ok: false;
      reason: 'unknown-story' | 'nothing-to-file' | 'jira-rejected';
      error: string;
      /** Labelled locally, not yet accepted by JIRA. The next attempt retries it. */
      pending?: boolean;
    };

/**
 * File every stopped, unlogged chunk on a story under one activity and push it to JIRA.
 *
 * The order is load-bearing. The label is written to state *before* the request and the
 * logged flag only *after* it succeeds, so a failed push leaves the chunk filed but
 * still pending — the next file, or Done, sends it under the label it already has.
 * Nothing is lost and nothing is double-sent.
 *
 * The worklog carries the chunk's exact length. Rounding here would inflate the total
 * badly — see the note in lib/activities.ts — so rounding is left to the Done sweep,
 * where a single bucket makes it safe.
 */
export async function fileTime(
  state: TimerState,
  key: string,
  activity: string,
  deps: WorklogDeps,
): Promise<FileTimeResult> {
  const story = state.stories[key];
  if (!story) return { ok: false, reason: 'unknown-story', error: `no timer for ${key}` };

  // Where the work began, for JIRA's worklog date — read before labelling so it
  // reflects the earliest chunk being filed.
  const startedMs = classifiable(story)[0]?.start ?? deps.now;

  // Checked before labelling, so a refused file leaves no trace. Sub-minute time is
  // refused rather than sent because `addWorklog` clamps to a minute: a four-second
  // chunk would be banked as sixty seconds of work, and `markClassified` would then
  // add that whole minute to `loggedSeconds`. Left pending it merges into the next
  // chunk filed, which is both honest and tidier. The UI hides the button below this
  // threshold; the MCP endpoint has no such affordance, which is how it got through.
  const waiting = classifiableSeconds(story);
  if (waiting < MIN_LOGGABLE_SECONDS) {
    return {
      ok: false,
      reason: 'nothing-to-file',
      error:
        waiting <= 0
          ? 'Nothing to file yet — stop the timer first.'
          : `Only ${waiting}s is waiting, and JIRA's smallest worklog is a minute. ` +
            'It stays pending and will merge into the next chunk you file.',
    };
  }

  const seconds = labelClassifiable(state, key, activity);
  await deps.save(state);

  try {
    const { id } = await deps.writer.addWorklog(
      key,
      seconds,
      `${activity} — Tracked via j-time`,
      startedMs,
    );
    markClassified(state, key, seconds, id);
    await deps.save(state);
    return { ok: true, worklogId: id, loggedSeconds: seconds };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: 'jira-rejected',
      // The label stuck; only the send failed. Say both, so the state on screen
      // (filed, still unsent) makes sense.
      error: `Filed as ${activity}, but JIRA wouldn't take the worklog: ${reason}`,
      pending: true,
    };
  }
}

export type FinishStoryResult =
  | { ok: true; loggedSeconds: number; breakdown: ActivityShare[]; worklogIds: string[] }
  | { ok: false; reason: 'unknown-story' | 'jira-rejected'; error: string };

export interface FinishStoryOptions {
  transitionId?: string;
  note?: string;
  roundMinutes: number;
}

/**
 * Sweep whatever filing didn't already send, then move the story's status.
 *
 * Nothing left to send is the normal case now that filing logs as you go, so it isn't
 * an error — Done is then a pure status change, which is what makes closing a story one
 * click instead of a dialog full of arithmetic.
 */
export async function finishStory(
  state: TimerState,
  key: string,
  opts: FinishStoryOptions,
  deps: WorklogDeps,
): Promise<FinishStoryResult> {
  const story = state.stories[key];
  if (!story) return { ok: false, reason: 'unknown-story', error: `no timer for ${key}` };

  const now = deps.now;
  // Whatever filing didn't already send: computed from the segments no worklog covers,
  // so Done can never re-send time JIRA already has. Sub-minute leftovers count as
  // nothing — see sweepSeconds.
  const rounded = sweepSeconds(story, now, opts.roundMinutes);

  if (rounded <= 0) {
    story.doneAt = now;
    if (state.activeKey === key) state.activeKey = null;
    await deps.save(state);
    try {
      if (opts.transitionId) await deps.writer.doTransition(key, opts.transitionId);
    } catch (e: unknown) {
      return {
        ok: false,
        reason: 'jira-rejected',
        error: e instanceof Error ? e.message : String(e),
      };
    }
    return { ok: true, loggedSeconds: 0, breakdown: [], worklogIds: [] };
  }

  const startedMs = story.segments[0]?.start ?? now;
  const suffix = opts.note ? `${opts.note} (via j-time)` : 'Tracked via j-time';

  // One worklog per activity, so the breakdown is visible in JIRA's Work Log tab.
  // `rounded` is apportioned rather than each activity being rounded on its own,
  // which would inflate the total (three 2m chunks -> three 5m worklogs).
  const shares = apportion(rounded, unloggedByActivity(story, now));
  const posts =
    shares.length > 0
      ? shares.map((s) => ({ seconds: s.seconds, comment: `${s.activity} — ${suffix}` }))
      : [{ seconds: rounded, comment: suffix }];

  try {
    const ids: string[] = [];
    // Sequential on purpose: JIRA recomputes timespent per worklog, and concurrent
    // writes to the same issue have been known to drop one.
    for (const p of posts) {
      const { id } = await deps.writer.addWorklog(key, p.seconds, p.comment, startedMs);
      ids.push(id);
    }
    if (opts.transitionId) await deps.writer.doTransition(key, opts.transitionId);
    markDone(state, key, now, ids[ids.length - 1], rounded);
    await deps.save(state);
    return { ok: true, loggedSeconds: rounded, breakdown: shares, worklogIds: ids };
  } catch (e: unknown) {
    return { ok: false, reason: 'jira-rejected', error: e instanceof Error ? e.message : String(e) };
  }
}
