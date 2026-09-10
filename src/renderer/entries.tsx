/**
 * Everything the palette can list, and what each thing does.
 *
 * One `Entry` shape covers issues, per-issue actions, activity pickers and
 * transition pickers, so every level of the palette is the same component with
 * the same keys — which is the whole reason a launcher is faster than a menu.
 */

import type { ReactNode } from 'react';
import type { Snapshot } from '@shared/ipc';
import type { JiraTransition } from '@shared/types';
import type { IssueItem, Searchable } from '@shared/palette';
import { buildIssueItems, SECTION_RUNNING } from '@shared/palette';
import { groupByStage, preferredDoneTransition, type StageRow } from '@shared/stages';
import { formatClock, formatDurationShort, isRunning } from '@shared/time';
import { MIN_LOGGABLE_SECONDS, trackedByActivity, unloggedBreakdown } from '@shared/timer-logic';
import { RUNNING, UNTRACKED } from '@shared/activities';

export interface Entry extends Searchable {
  section: string;
  lead?: ReactNode;
  accessories?: ReactNode;
  running?: boolean;
  /** What Enter does. */
  run: () => void;
  /** What ⌘K opens. Absent means the row has no further actions. */
  actions?: Entry[];
  /** Set on issue rows, so the shell can offer the shortcuts that need a story. */
  issue?: IssueItem;
}

export interface Overlay {
  title: string;
  placeholder: string;
  entries: Entry[];
}

export type Screen = { kind: 'list' } | { kind: 'settings' } | { kind: 'detail'; key: string };

/** The primitives an entry needs from the shell. Keeps the builders free of state. */
export interface Ctx {
  snapshot: Snapshot;
  now: number;
  /** Run an action, report the result, and close the palette when it succeeds. */
  act: (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => void;
  /** Same, but leave the palette open — for things you'd do several of in a row. */
  actStay: (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => void;
  push: (overlay: Overlay) => void;
  pushAsync: (title: string, placeholder: string, load: () => Promise<Entry[]>) => void;
  go: (screen: Screen) => void;
}

const ACTIONS = 'Actions';

/** Below a minute JIRA has nothing to log, so there is nothing to file. */
const fileable = (item: IssueItem) => item.unloggedSeconds >= MIN_LOGGABLE_SECONDS;

function issueAccessories(item: IssueItem): ReactNode {
  const timer = item.row.timer;
  const unfiled = item.unloggedSeconds;
  return (
    <>
      {item.row.boardName && <span className="pill">{item.row.boardName}</span>}
      <span className="pill">{item.row.status}</span>
      {unfiled >= MIN_LOGGABLE_SECONDS && (
        <span className="pill warn">{formatDurationShort(unfiled)} unfiled</span>
      )}
      {item.running && timer ? (
        <span className="clock live">{formatClock(item.trackedSeconds)}</span>
      ) : (
        item.trackedSeconds > 0 && (
          <span className="clock">{formatDurationShort(item.trackedSeconds)}</span>
        )
      )}
    </>
  );
}

/** The activity list, as a pickable overlay. */
function activityEntries(
  ctx: Ctx,
  onPick: (activity: string) => void,
  extra: Entry[] = [],
): Entry[] {
  const activities = ctx.snapshot.config.activities;
  return [
    ...activities.map((activity) => ({
      id: `activity:${activity}`,
      title: activity,
      section: 'Activity',
      run: () => onPick(activity),
    })),
    ...extra,
  ];
}

function transitionEntry(t: JiraTransition, section: string, run: () => void): Entry {
  return {
    id: `transition:${t.id}`,
    title: t.name,
    subtitle: `→ ${t.to}`,
    keywords: [t.to],
    section,
    run,
  };
}

function issueActions(item: IssueItem, ctx: Ctx): Entry[] {
  const key = item.row.key;
  const story = item.row.timer;
  const running = item.running;

  const timerAction: Entry = running
    ? {
        id: 'act:stop',
        title: 'Stop timer',
        subtitle: 'Leaves the chunk unfiled, to attribute later',
        section: ACTIONS,
        accessories: <kbd>↩</kbd>,
        run: () => ctx.actStay(() => window.jt.stop()),
      }
    : {
        id: 'act:start',
        title: story && story.segments.length > 0 ? 'Resume timer' : 'Start timer',
        section: ACTIONS,
        accessories: <kbd>↩</kbd>,
        run: () => ctx.actStay(() => window.jt.start(key)),
      };

  const file: Entry = {
    id: 'act:file',
    title: 'File time as…',
    subtitle: running
      ? 'Stops the clock, then logs the chunk to JIRA'
      : `Logs ${formatDurationShort(item.unloggedSeconds)} to JIRA`,
    keywords: ['worklog', 'log', 'classify'],
    section: ACTIONS,
    accessories: <kbd>⌘F</kbd>,
    run: () =>
      ctx.push({
        title: `File ${key} as`,
        placeholder: 'Which activity was this?',
        entries: activityEntries(ctx, (activity) =>
          ctx.act(() => window.jt.fileTime(key, activity)),
        ),
      }),
  };

  const finish: Entry = {
    id: 'act:finish',
    title: 'Finish story…',
    subtitle: 'Sweeps anything unfiled, then moves the status',
    keywords: ['done', 'complete', 'close'],
    section: ACTIONS,
    accessories: <kbd>⌘D</kbd>,
    run: () =>
      ctx.pushAsync(`Finish ${key}`, 'Move it to…', async () => {
        const result = await window.jt.getTransitions(key);
        if (!result.ok) throw new Error(result.error);
        // JIRA's Done *category* includes cancellation, and the endpoint doesn't
        // order its transitions — so the one that means "finished" is chosen
        // explicitly rather than taken as the first match.
        const preferred = preferredDoneTransition(result.transitions);
        const rest = result.transitions.filter((t) => t.id !== preferred?.id);
        return [
          ...(preferred
            ? [transitionEntry(preferred, 'Finish', () => ctx.act(() => window.jt.finish(key, preferred.id)))]
            : []),
          ...rest.map((t) =>
            transitionEntry(t, 'Other transitions', () => ctx.act(() => window.jt.finish(key, t.id))),
          ),
          {
            id: 'finish:no-transition',
            title: 'Finish without changing status',
            subtitle: 'Logs the leftover time and leaves the story where it is',
            section: 'Other transitions',
            run: () => ctx.act(() => window.jt.finish(key)),
          },
        ];
      }),
  };

  const move: Entry = {
    id: 'act:move',
    title: 'Change status…',
    subtitle: 'Moves the story without logging any time',
    keywords: ['transition', 'status'],
    section: ACTIONS,
    run: () =>
      ctx.pushAsync(`Move ${key}`, 'Move it to…', async () => {
        const result = await window.jt.getTransitions(key);
        if (!result.ok) throw new Error(result.error);
        return result.transitions.map((t) =>
          transitionEntry(t, 'Transitions', () => ctx.act(() => window.jt.transition(key, t.id))),
        );
      }),
  };

  // Relabelling reaches logged chunks too: a logged segment is never re-sent, so
  // the change is display-only — and refusing it left every finished story stuck
  // reading "Unlabelled" forever.
  const labels = trackedByActivity(story, ctx.now, item.row.secondsSpent).filter(
    (r) => !r.untracked && r.activity !== RUNNING,
  );

  const relabel: Entry = {
    id: 'act:relabel',
    title: 'Relabel tracked time…',
    subtitle: 'Move time from one activity to another',
    keywords: ['rename', 'category'],
    section: ACTIONS,
    run: () =>
      ctx.push({
        title: `Relabel on ${key}`,
        placeholder: 'Which time is mislabelled?',
        entries: labels.map((row) => ({
          id: `from:${row.activity}`,
          title: row.activity,
          accessories: <span className="clock">{formatDurationShort(row.seconds)}</span>,
          section: 'Currently',
          run: () =>
            ctx.push({
              title: `${row.activity} becomes`,
              placeholder: 'Move it to…',
              entries: activityEntries(ctx, (to) =>
                ctx.actStay(() => window.jt.relabel(key, row.activity, to)),
              ),
            }),
        })),
      }),
  };

  // Unlike relabelling this stays on unlogged chunks only: dropping a logged one
  // would leave the story showing less tracked time than it has already sent.
  const discardable = story
    ? unloggedBreakdown(story, ctx.now).filter((r) => !r.running && r.activity !== UNTRACKED)
    : [];

  const discard: Entry = {
    id: 'act:discard',
    title: 'Discard unlogged time…',
    subtitle: 'Throw away a mis-start. Logged time is never touched',
    keywords: ['delete', 'remove'],
    section: ACTIONS,
    run: () =>
      ctx.push({
        title: `Discard on ${key}`,
        placeholder: 'Which unlogged time should go?',
        entries: discardable.map((row) => ({
          id: `discard:${row.activity}`,
          title: row.activity,
          subtitle: 'Press ↩ to discard — this cannot be undone',
          accessories: <span className="clock">{formatDurationShort(row.seconds)}</span>,
          section: 'Unlogged',
          run: () => ctx.actStay(() => window.jt.discard(key, row.activity)),
        })),
      }),
  };

  const rest: Entry[] = [
    {
      id: 'act:detail',
      title: 'Show tracked time',
      subtitle: 'Clock, activity breakdown and estimate',
      keywords: ['detail', 'breakdown'],
      section: ACTIONS,
      accessories: <kbd>⌘I</kbd>,
      run: () => ctx.go({ kind: 'detail', key }),
    },
    {
      id: 'act:open',
      title: 'Open in JIRA',
      section: ACTIONS,
      accessories: <kbd>⌘O</kbd>,
      run: () => void window.jt.openIssue(key),
    },
    {
      id: 'act:copy-key',
      title: 'Copy issue key',
      section: ACTIONS,
      accessories: <kbd>⌘C</kbd>,
      run: () => ctx.act(async () => {
        await window.jt.copy(key);
        return { ok: true, message: `Copied ${key}` };
      }),
    },
  ];

  return [
    timerAction,
    ...(fileable(item) ? [file] : []),
    finish,
    move,
    ...(labels.length > 0 ? [relabel] : []),
    ...(discardable.length > 0 ? [discard] : []),
    ...rest,
  ];
}

/** One row per issue, in the board's order with the running story pinned on top. */
export function issueEntries(ctx: Ctx): Entry[] {
  const { snapshot, now } = ctx;
  const groups = groupByStage({
    issues: snapshot.issues,
    doneIssues: snapshot.doneIssues,
    stories: snapshot.state.stories,
    now,
    activeKey: snapshot.state.activeKey,
  });

  return buildIssueItems(groups, now).map((item) => ({
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    keywords: item.keywords,
    section: item.section,
    running: item.running,
    lead: item.running ? '▶' : item.trackedSeconds > 0 ? '•' : '',
    accessories: issueAccessories(item),
    issue: item,
    // Enter is the thing you came here to do: put the clock on this story, or
    // take it off. Everything else is one more keystroke away under ⌘K.
    //
    // It stays open afterwards: starting a timer produces nothing you can see
    // anywhere else, so a panel that vanished on Enter left you guessing whether
    // the clock was running. Now the row moves under Running and the footer
    // starts counting, in front of you.
    run: () =>
      item.running
        ? ctx.actStay(() => window.jt.stop())
        : ctx.actStay(() => window.jt.start(item.row.key)),
    actions: issueActions(item, ctx),
  }));
}

/** The commands that aren't about one story. Always last, so they never crowd the board. */
/**
 * The app itself, rather than any story: what the footer button opens.
 *
 * Kept as `Entry` values like everything else, so the same list component draws
 * it — and so `commandEntries` can hand the same rows to the search field
 * instead of defining a second copy that drifts.
 */
export function appMenuEntries(ctx: Ctx): Entry[] {
  const { snapshot } = ctx;
  const baseUrl = snapshot.config.baseUrl.trim();

  return [
    {
      id: 'app:settings',
      title: 'Settings…',
      subtitle: 'JIRA connection, activities, hotkey',
      keywords: ['config', 'preferences', 'token', 'jira'],
      section: 'j-time',
      accessories: <kbd>⌘,</kbd>,
      run: () => ctx.go({ kind: 'settings' }),
    },
    {
      id: 'app:refresh',
      title: 'Refresh board',
      keywords: ['reload', 'fetch'],
      section: 'j-time',
      accessories: <kbd>⌘R</kbd>,
      run: () => ctx.actStay(() => window.jt.refresh()),
    },
    ...(baseUrl
      ? [
          {
            id: 'app:jira',
            title: 'Open JIRA in browser',
            subtitle: baseUrl,
            keywords: ['web', 'browser', 'site'],
            section: 'j-time',
            run: () => void window.jt.openUrl(baseUrl),
          },
        ]
      : []),
    {
      id: 'app:quit',
      title: 'Quit j-time',
      subtitle: 'Stops the menu bar clock. Tracked time is already saved.',
      keywords: ['exit', 'close'],
      section: 'j-time',
      accessories: <kbd>⌘Q</kbd>,
      run: () => void window.jt.quit(),
    },
  ];
}

export function commandEntries(ctx: Ctx): Entry[] {
  const { snapshot } = ctx;
  const boardName =
    snapshot.boards.find((b) => b.id === snapshot.config.boardId)?.name ?? 'All my boards';

  return [
    {
      id: 'cmd:board',
      title: 'Switch board…',
      subtitle: boardName,
      keywords: ['project', 'sprint'],
      section: 'Commands',
      run: () =>
        ctx.push({
          title: 'Show issues from',
          placeholder: 'Which board?',
          entries: [
            {
              id: 'board:all',
              title: 'All my boards',
              subtitle: 'Every board you have work in, merged',
              section: 'Boards',
              run: () => ctx.actStay(() => window.jt.saveConfig({ boardId: null })),
            },
            ...snapshot.boards.map((board) => ({
              id: `board:${board.id}`,
              title: board.name,
              subtitle: board.type,
              section: 'Boards',
              run: () => ctx.actStay(() => window.jt.saveConfig({ boardId: board.id })),
            })),
          ],
        }),
    },
    {
      id: 'cmd:mine',
      title: snapshot.config.mineOnly ? 'Show everyone’s issues' : 'Show only my issues',
      keywords: ['assignee', 'filter'],
      section: 'Commands',
      run: () => ctx.actStay(() => window.jt.saveConfig({ mineOnly: !snapshot.config.mineOnly })),
    },
    ...appMenuEntries(ctx).map((entry) => ({ ...entry, section: 'Commands' })),
  ];
}

/** The story whose clock is running, if the palette should say so in the footer. */
export function runningRow(snapshot: Snapshot): StageRow | null {
  const key = snapshot.state.activeKey;
  const story = key ? snapshot.state.stories[key] : null;
  if (!story || !isRunning(story.segments)) return null;
  return {
    key: story.key,
    summary: story.summary,
    status: story.status,
    assignee: story.assignee,
    estimateSeconds: story.estimateSeconds,
    secondsSpent: story.loggedSeconds,
    description: null,
    timer: story,
  };
}

export { SECTION_RUNNING };
