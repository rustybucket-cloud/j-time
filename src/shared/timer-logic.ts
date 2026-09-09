import type { TimerState, StoryTimer, JiraIssue, Segment } from './types';
import { roundSeconds } from './time';
import { UNLABELLED, RUNNING, UNTRACKED, type ActivityRaw } from './activities';

export type IssueMeta = Pick<JiraIssue, 'key' | 'summary' | 'status' | 'assignee' | 'estimateSeconds'>;

export function emptyState(): TimerState {
  return { activeKey: null, stories: {} };
}

function ensureStory(state: TimerState, issue: IssueMeta): StoryTimer {
  const existing = state.stories[issue.key];
  if (existing) {
    existing.summary = issue.summary;
    existing.status = issue.status;
    existing.assignee = issue.assignee;
    // Only adopt JIRA's estimate if we don't already have one recorded.
    if (existing.estimateSeconds == null) existing.estimateSeconds = issue.estimateSeconds;
    return existing;
  }
  const created: StoryTimer = {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    assignee: issue.assignee,
    estimateSeconds: issue.estimateSeconds,
    segments: [],
    doneAt: null,
    worklogId: null,
    loggedSeconds: null,
  };
  state.stories[issue.key] = created;
  return created;
}

/**
 * Close the open segment on the active story, if any, and clear activeKey.
 * `activity` labels the chunk that just ended — omitted when simply stepping away,
 * which leaves it unlabelled to be attributed later.
 */
export function pauseActive(state: TimerState, now: number, activity?: string): TimerState {
  const key = state.activeKey;
  if (key) {
    const story = state.stories[key];
    const last = story?.segments[story.segments.length - 1];
    if (last && last.end === null) {
      last.end = now;
      if (activity) last.activity = activity;
    }
  }
  state.activeKey = null;
  return state;
}

export interface ActivityRow extends ActivityRaw {
  /** True for the chunk still accruing. Display concern only. */
  running?: boolean;
}

/**
 * Unlogged tracked time per activity. Segments already covered by a worklog are
 * excluded, so a second Done only breaks down new work.
 *
 * `splitRunning` separates the open segment into its own row, pinned first — the
 * display wants it distinguished and in a fixed position, while logging wants it
 * folded into Unlabelled like any other unattributed chunk.
 */
function collectUnlogged(story: StoryTimer, now: number, splitRunning: boolean): ActivityRow[] {
  const totals = new Map<string, number>();
  let runningSeconds = 0;

  for (const seg of story.segments) {
    if (seg.logged) continue;
    const isOpen = seg.end === null;
    const seconds = Math.max(0, Math.round(((seg.end ?? now) - seg.start) / 1000));
    if (seconds <= 0) continue;

    if (splitRunning && isOpen) {
      runningSeconds += seconds;
      continue;
    }
    const name = seg.activity?.trim() || UNLABELLED;
    totals.set(name, (totals.get(name) ?? 0) + seconds);
  }

  // First-seen order for the rest, so labelling something doesn't reshuffle the list.
  const rows: ActivityRow[] = [...totals.entries()].map(([activity, seconds]) => ({
    activity,
    seconds,
  }));
  return runningSeconds > 0
    ? [{ activity: RUNNING, seconds: runningSeconds, running: true }, ...rows]
    : rows;
}

/** For logging: the open chunk counts as Unlabelled, same as any unattributed time. */
export function unloggedByActivity(story: StoryTimer, now: number): ActivityRaw[] {
  return collectUnlogged(story, now, false);
}

/** For display: the running chunk is its own row, always first. */
export function unloggedBreakdown(story: StoryTimer, now: number): ActivityRow[] {
  return collectUnlogged(story, now, true);
}

/**
 * How a segment's label appears in the breakdown. Absent, blank and whitespace all
 * read as Unlabelled, which is what the UI offers to relabel.
 */
function labelOf(seg: Segment): string {
  return seg.activity?.trim() || UNLABELLED;
}

/**
 * Closed segments under one activity. The open chunk is always excluded: it isn't
 * finished, the breakdown shows it as `Running` rather than under a label, and
 * stopping is what attributes it.
 */
function closedUnder(story: StoryTimer, activity: string): Segment[] {
  return story.segments.filter((seg) => seg.end !== null && labelOf(seg) === activity);
}

/**
 * Chunks a classification can act on: finished, and not yet covered by a worklog.
 *
 * The running chunk is excluded because it isn't finished — stopping is what makes
 * time classifiable. That's the whole shape of the model: Start, Stop, then file the
 * chunk under a category.
 */
export function classifiable(story: StoryTimer): Segment[] {
  return story.segments.filter((seg) => seg.end !== null && !seg.logged);
}

/** How much a classification would send to JIRA right now. */
export function classifiableSeconds(story: StoryTimer): number {
  return classifiable(story).reduce(
    (n, seg) => n + Math.max(0, Math.round(((seg.end as number) - seg.start) / 1000)),
    0,
  );
}

/**
 * File every unfiled chunk under one activity, and report what should be logged.
 *
 * Called before the JIRA request, so the label survives even if that request fails —
 * the chunks stay unlogged and the next classify or Done retries them. Returns 0 when
 * there's nothing waiting, which the caller treats as "nothing to do".
 */
export function labelClassifiable(state: TimerState, key: string, activity: string): number {
  const story = state.stories[key];
  if (!story) return 0;
  const target = activity.trim();
  const pending = classifiable(story);
  for (const seg of pending) {
    // Unlabelled is the absence of a label, not a label reading "Unlabelled".
    seg.activity = target && target !== UNLABELLED ? target : null;
  }
  return classifiableSeconds(story);
}

/**
 * Mark the filed chunks as covered, once JIRA has actually accepted the worklog.
 *
 * Separate from `labelClassifiable` on purpose: a chunk must never read as logged
 * because we *tried* to log it. `loggedSeconds` grows by what JIRA accepted, which is
 * what stops a later Done from re-sending the same time.
 */
export function markClassified(
  state: TimerState,
  key: string,
  loggedSeconds: number,
  worklogId: string,
): TimerState {
  const story = state.stories[key];
  if (!story) return state;
  for (const seg of classifiable(story)) seg.logged = true;
  story.loggedSeconds = (story.loggedSeconds ?? 0) + loggedSeconds;
  story.worklogId = worklogId;
  return state;
}

/**
 * JIRA's smallest worklog. Below this there's nothing it would accept, so both the UI
 * and `/api/done` treat sub-minute time as nothing — shared so they can't disagree,
 * which they did: the dialog said "nothing left to log" while the route posted five
 * minutes for it.
 */
export const MIN_LOGGABLE_SECONDS = 60;

/**
 * What Done should still send: the unfiled leftover, rounded — or nothing at all when
 * it's under a minute.
 *
 * `roundSeconds` deliberately floors at one full increment, so *any* positive value
 * becomes 5 minutes by default. That was right when Done was the only writer and the
 * leftover was real work. It's wrong now: classification sends time as you go, so
 * what's left at Done is usually a few seconds between Stop and Done, and inflating
 * that to five logged minutes corrupts the estimate-vs-actual data the app exists for.
 */
export function sweepSeconds(story: StoryTimer, now: number, roundMinutes: number): number {
  const leftover = unloggedSeconds(story, now);
  if (leftover < MIN_LOGGABLE_SECONDS) return 0;
  return roundSeconds(leftover, roundMinutes);
}

/** Tracked time no worklog covers yet — what a future Done still has to send. */
export function unloggedSeconds(story: StoryTimer, now: number): number {
  let total = 0;
  for (const seg of story.segments) {
    if (seg.logged) continue;
    total += Math.max(0, Math.round(((seg.end ?? now) - seg.start) / 1000));
  }
  return total;
}

/**
 * Move time from one activity to another — the fix for a chunk stopped without a
 * label, or labelled wrongly.
 *
 * Applies to logged chunks as well as unlogged ones, which is safe because a logged
 * segment is never re-sent: `unloggedByActivity` skips it and `pendingLogSeconds`
 * subtracts it. So this only changes what the breakdown *displays*. The one thing it
 * can't do is rewrite the comment on a worklog JIRA already has — every Done story
 * has all its segments logged, so refusing outright just left "Unlabelled" rows
 * permanently unfixable.
 */
export function relabelActivity(
  state: TimerState,
  key: string,
  from: string,
  to: string,
): TimerState {
  const story = state.stories[key];
  if (!story) return state;
  const target = to.trim();
  for (const seg of closedUnder(story, from)) {
    // Unlabelled is the absence of a label, not a label reading "Unlabelled".
    seg.activity = target && target !== UNLABELLED ? target : null;
  }
  return state;
}

/**
 * Throw away unlogged time under one activity — a mis-start, or a stretch that
 * shouldn't be billed to this story.
 *
 * Unlike relabelling, this stays restricted to **unlogged** segments. Dropping a
 * logged one would pull `activeSeconds` below `loggedSeconds`, leaving the story
 * showing less tracked time than it has already sent to JIRA and throwing off
 * `pendingLogSeconds` for good.
 *
 * `loggedSeconds` is deliberately left alone: it records what was sent, and those
 * worklogs still exist regardless of what happens to the local segments.
 */
export function discardUnlogged(state: TimerState, key: string, activity: string): TimerState {
  const story = state.stories[key];
  if (!story) return state;
  const doomed = new Set(closedUnder(story, activity).filter((seg) => !seg.logged));
  story.segments = story.segments.filter((seg) => !doomed.has(seg));
  return state;
}

export interface TrackedRow extends ActivityRow {
  /** How much of `seconds` is already covered by a worklog. */
  loggedSeconds: number;
  /** JIRA's own time that this app never measured. Not backed by any local segment. */
  untracked?: boolean;
}

/**
 * Every tracked second on a story grouped by activity, including chunks already
 * sent to JIRA — which is what separates this from `unloggedBreakdown`.
 *
 * Display needs the whole picture: the card's clock counts all tracked time, so a
 * breakdown that dropped logged chunks didn't add up to the number printed directly
 * above it, and a story whose time had all been sent showed no categories at all.
 * `loggedSeconds` keeps the already-banked portion distinguishable rather than
 * indistinguishable — the reason the logged part used to be omitted entirely.
 *
 * `jiraSpent` is JIRA's own total for the issue. Whatever part of it this app never
 * sent becomes a trailing `Untracked` row: time logged before the timer existed, by
 * someone else, or in JIRA directly. Without it the bars silently disagreed with the
 * "N spent" figure printed immediately above them, and a story whose time came entirely
 * from elsewhere showed no bars at all despite having hours against it.
 *
 * `story` may be null for exactly that case — an issue this app has never tracked.
 *
 * Not for logging. `/api/done` must keep using `unloggedByActivity`, or every Done
 * would re-send time JIRA already has.
 */
export function trackedByActivity(
  story: StoryTimer | null,
  now: number,
  jiraSpent?: number | null,
): TrackedRow[] {
  const totals = new Map<string, { seconds: number; loggedSeconds: number }>();
  let runningSeconds = 0;

  for (const seg of story?.segments ?? []) {
    const seconds = Math.max(0, Math.round(((seg.end ?? now) - seg.start) / 1000));
    if (seconds <= 0) continue;
    // An open chunk can't have been logged, and gets its own row pinned first.
    if (seg.end === null) {
      runningSeconds += seconds;
      continue;
    }
    const name = seg.activity?.trim() || UNLABELLED;
    const row = totals.get(name) ?? { seconds: 0, loggedSeconds: 0 };
    row.seconds += seconds;
    if (seg.logged) row.loggedSeconds += seconds;
    totals.set(name, row);
  }

  // First-seen order, so labelling something doesn't reshuffle the list.
  const rows: TrackedRow[] = [...totals.entries()].map(([activity, t]) => ({
    activity,
    seconds: t.seconds,
    loggedSeconds: t.loggedSeconds,
  }));
  if (runningSeconds > 0) {
    rows.unshift({ activity: RUNNING, seconds: runningSeconds, loggedSeconds: 0, running: true });
  }

  // Trails the rest: it's history, and the least actionable thing on the card.
  const untracked = Math.max(0, (jiraSpent ?? 0) - (story?.loggedSeconds ?? 0));
  if (untracked > 0) {
    rows.push({
      activity: UNTRACKED,
      seconds: untracked,
      // Wholly in JIRA already, so it renders as banked rather than pending.
      loggedSeconds: untracked,
      untracked: true,
    });
  }
  return rows;
}

/**
 * Backfill the `logged` flag for state written before activities existed.
 *
 * Those stories were logged as one lump, so their segments carry no flag; without
 * this, resuming one would count its already-sent time as unlogged and over-report
 * what Done will add. A story with `doneAt` and a logged total had all its closed
 * segments covered, so marking them is accurate.
 *
 * Idempotent, and safe to run on every read: `startTimer` clears `doneAt`, so
 * segments added after a resume are never caught by it.
 */
export function normalizeState(state: TimerState): TimerState {
  for (const story of Object.values(state.stories)) {
    if (story.doneAt == null || (story.loggedSeconds ?? 0) <= 0) continue;
    for (const seg of story.segments) {
      if (seg.end !== null && seg.logged === undefined) seg.logged = true;
    }
  }
  return state;
}

/** Mark every unlogged segment as covered, once its time has been sent. */
export function markSegmentsLogged(story: StoryTimer): void {
  for (const seg of story.segments) {
    if (seg.end !== null) seg.logged = true;
  }
}

/** Start or resume the timer on a story: pause whatever is active, then open a fresh segment. */
export function startTimer(state: TimerState, issue: IssueMeta, now: number): TimerState {
  pauseActive(state, now);
  const story = ensureStory(state, issue);
  story.doneAt = null; // resuming un-completes
  // loggedSeconds and worklogId are deliberately KEPT. Any worklog we already
  // pushed still exists in JIRA, so forgetting it here would re-send that time
  // on the next Done. pendingLogSeconds() subtracts it instead.
  story.segments.push({ start: now, end: null });
  state.activeKey = issue.key;
  return state;
}

/**
 * How many seconds to send to JIRA now: the rounded total minus whatever we've
 * already logged. Rounding the total rather than the delta keeps repeated logs
 * consistent with what a single log at the end would have produced.
 *
 * Zero or negative means there's nothing new to log.
 */
export function pendingLogSeconds(
  activeSecs: number,
  alreadyLogged: number,
  roundMinutes: number,
): number {
  return roundSeconds(activeSecs, roundMinutes) - alreadyLogged;
}

/**
 * Mark a story done: close its segment(s) and record the worklog we just pushed.
 * `loggedSeconds` accumulates, because JIRA keeps every worklog — the story's
 * logged total is the sum, not the size of the latest one.
 */
export function markDone(
  state: TimerState,
  key: string,
  now: number,
  worklogId: string,
  loggedSeconds: number,
): TimerState {
  if (state.activeKey === key) {
    pauseActive(state, now);
  } else {
    const story = state.stories[key];
    const last = story?.segments[story.segments.length - 1];
    if (last && last.end === null) last.end = now;
  }
  const story = state.stories[key];
  if (story) {
    story.doneAt = now;
    story.worklogId = worklogId;
    story.loggedSeconds = (story.loggedSeconds ?? 0) + loggedSeconds;
    // Everything closed is now covered by a worklog; a later Done starts fresh.
    markSegmentsLogged(story);
  }
  return state;
}
