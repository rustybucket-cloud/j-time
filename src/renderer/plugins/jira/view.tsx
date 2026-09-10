/**
 * The JIRA section: what it lists, and what each row does.
 *
 * This was `entries.tsx` when the board was the whole palette. The rows are now
 * `Row` values rather than markup — a lead is a *meaning* and an accessory is a
 * badge, so the JIRA section and the PR section can't drift apart visually no
 * matter which one is edited. The two places this plugin still returns React
 * outright are its Detail readout and its settings form, which are full screens
 * rather than list rows and answer to nothing else on the page.
 */

import type { ReactNode } from 'react';
import type { Badge, Ctx, PluginView, Row, SectionContent } from '@shared/plugin';
import type { JiraSnapshot } from '@shared/jira';
import type { JiraTransition } from '@shared/types';
import { buildIssueItems, type IssueItem } from '@shared/board';
import { groupByStage, preferredDoneTransition } from '@shared/stages';
import { formatClock, formatDurationShort } from '@shared/time';
import { MIN_LOGGABLE_SECONDS, trackedByActivity, unloggedBreakdown } from '@shared/timer-logic';
import { RUNNING, UNTRACKED } from '@shared/activities';
import { connMessage } from '@shared/conn';
import { jira } from './client';
import { Detail } from './Detail';
import { Settings } from './Settings';

const ID = 'jira';

/** Below a minute JIRA has nothing to log, so there is nothing to file. */
const fileable = (item: IssueItem) => item.unloggedSeconds >= MIN_LOGGABLE_SECONDS;

function issueBadges(item: IssueItem): Badge[] {
  const badges: Badge[] = [];
  if (item.row.boardName) badges.push({ text: item.row.boardName });
  badges.push({ text: item.row.status });
  if (item.unloggedSeconds >= MIN_LOGGABLE_SECONDS) {
    badges.push({ text: `${formatDurationShort(item.unloggedSeconds)} unfiled`, tone: 'warn' });
  }
  if (item.running) {
    badges.push({ text: formatClock(item.trackedSeconds), kind: 'clock', live: true });
  } else if (item.trackedSeconds > 0) {
    badges.push({ text: formatDurationShort(item.trackedSeconds), kind: 'clock' });
  }
  return badges;
}

/** The activity list, as a pickable overlay. */
function activityRows(
  snapshot: JiraSnapshot,
  onPick: (activity: string) => void,
  extra: Row[] = [],
): Row[] {
  return [
    ...snapshot.config.activities.map((activity) => ({
      id: `activity:${activity}`,
      title: activity,
      subsection: 'Activity',
      run: () => onPick(activity),
    })),
    ...extra,
  ];
}

function transitionRow(t: JiraTransition, subsection: string, run: () => void): Row {
  return {
    id: `transition:${t.id}`,
    title: t.name,
    subtitle: `→ ${t.to}`,
    keywords: [t.to],
    subsection,
    run,
  };
}

function issueActions(item: IssueItem, snapshot: JiraSnapshot, ctx: Ctx): Row[] {
  const key = item.row.key;
  const story = item.row.timer;
  const running = item.running;

  const timerAction: Row = running
    ? {
        id: 'act:stop',
        title: 'Stop timer',
        subtitle: 'Leaves the chunk unfiled, to attribute later',
        badges: [{ text: '↩', kind: 'key' }],
        run: () => ctx.actStay(() => jira.stop()),
      }
    : {
        id: 'act:start',
        title: story && story.segments.length > 0 ? 'Resume timer' : 'Start timer',
        badges: [{ text: '↩', kind: 'key' }],
        run: () => ctx.actStay(() => jira.start(key)),
      };

  const file: Row = {
    id: 'act:file',
    title: 'File time as…',
    subtitle: running
      ? 'Stops the clock, then logs the chunk to JIRA'
      : `Logs ${formatDurationShort(item.unloggedSeconds)} to JIRA`,
    keywords: ['worklog', 'log', 'classify'],
    badges: [{ text: '⌘F', kind: 'key' }],
    shortcut: 'f',
    run: () =>
      ctx.push({
        title: `File ${key} as`,
        placeholder: 'Which activity was this?',
        rows: activityRows(snapshot, (activity) => ctx.act(() => jira.fileTime(key, activity))),
      }),
  };

  const finish: Row = {
    id: 'act:finish',
    title: 'Finish story…',
    subtitle: 'Sweeps anything unfiled, then moves the status',
    keywords: ['done', 'complete', 'close'],
    badges: [{ text: '⌘D', kind: 'key' }],
    shortcut: 'd',
    run: () =>
      ctx.pushAsync(`Finish ${key}`, 'Move it to…', async () => {
        const transitions = await jira.transitions(key);
        // JIRA's Done *category* includes cancellation, and the endpoint doesn't
        // order its transitions — so the one that means "finished" is chosen
        // explicitly rather than taken as the first match.
        const preferred = preferredDoneTransition(transitions);
        const rest = transitions.filter((t) => t.id !== preferred?.id);
        return [
          ...(preferred
            ? [transitionRow(preferred, 'Finish', () => ctx.act(() => jira.finish(key, preferred.id)))]
            : []),
          ...rest.map((t) =>
            transitionRow(t, 'Other transitions', () => ctx.act(() => jira.finish(key, t.id))),
          ),
          {
            id: 'finish:no-transition',
            title: 'Finish without changing status',
            subtitle: 'Logs the leftover time and leaves the story where it is',
            subsection: 'Other transitions',
            run: () => ctx.act(() => jira.finish(key)),
          },
        ];
      }),
  };

  const move: Row = {
    id: 'act:move',
    title: 'Change status…',
    subtitle: 'Moves the story without logging any time',
    keywords: ['transition', 'status'],
    run: () =>
      ctx.pushAsync(`Move ${key}`, 'Move it to…', async () => {
        const transitions = await jira.transitions(key);
        return transitions.map((t) =>
          transitionRow(t, 'Transitions', () => ctx.act(() => jira.transition(key, t.id))),
        );
      }),
  };

  // Relabelling reaches logged chunks too: a logged segment is never re-sent, so
  // the change is display-only — and refusing it left every finished story stuck
  // reading "Unlabelled" forever.
  const labels = trackedByActivity(story, ctx.now, item.row.secondsSpent).filter(
    (r) => !r.untracked && r.activity !== RUNNING,
  );

  const relabel: Row = {
    id: 'act:relabel',
    title: 'Relabel tracked time…',
    subtitle: 'Move time from one activity to another',
    keywords: ['rename', 'category'],
    run: () =>
      ctx.push({
        title: `Relabel on ${key}`,
        placeholder: 'Which time is mislabelled?',
        rows: labels.map((row) => ({
          id: `from:${row.activity}`,
          title: row.activity,
          badges: [{ text: formatDurationShort(row.seconds), kind: 'clock' as const }],
          subsection: 'Currently',
          run: () =>
            ctx.push({
              title: `${row.activity} becomes`,
              placeholder: 'Move it to…',
              rows: activityRows(snapshot, (to) =>
                ctx.actStay(() => jira.relabel(key, row.activity, to)),
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

  const discard: Row = {
    id: 'act:discard',
    title: 'Discard unlogged time…',
    subtitle: 'Throw away a mis-start. Logged time is never touched',
    keywords: ['delete', 'remove'],
    run: () =>
      ctx.push({
        title: `Discard on ${key}`,
        placeholder: 'Which unlogged time should go?',
        rows: discardable.map((row) => ({
          id: `discard:${row.activity}`,
          title: row.activity,
          subtitle: 'Press ↩ to discard — this cannot be undone',
          badges: [{ text: formatDurationShort(row.seconds), kind: 'clock' as const }],
          subsection: 'Unlogged',
          run: () => ctx.actStay(() => jira.discard(key, row.activity)),
        })),
      }),
  };

  const rest: Row[] = [
    {
      id: 'act:detail',
      title: 'Show tracked time',
      subtitle: 'Clock, activity breakdown and estimate',
      keywords: ['detail', 'breakdown'],
      badges: [{ text: '⌘I', kind: 'key' }],
      shortcut: 'i',
      run: () => ctx.open({ plugin: ID, view: 'detail', arg: key }),
    },
    {
      id: 'act:open',
      title: 'Open in JIRA',
      badges: [{ text: '⌘O', kind: 'key' }],
      shortcut: 'o',
      run: () => void window.jt.openUrl(jira.issueUrl(snapshot.config.baseUrl, key)),
    },
    {
      id: 'act:copy-key',
      title: 'Copy issue key',
      badges: [{ text: '⌘C', kind: 'key' }],
      shortcut: 'c',
      run: () =>
        ctx.act(async () => {
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

function issueRows(snapshot: JiraSnapshot, ctx: Ctx): Row[] {
  const groups = groupByStage({
    issues: snapshot.issues,
    doneIssues: snapshot.doneIssues,
    stories: snapshot.state.stories,
    now: ctx.now,
    activeKey: snapshot.state.activeKey,
  });

  return buildIssueItems(groups, ctx.now).map((item) => ({
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    keywords: item.keywords,
    subsection: item.subsection,
    lead: item.running ? ('active' as const) : item.trackedSeconds > 0 ? ('dot' as const) : ('none' as const),
    badges: issueBadges(item),
    live: item.running,
    // The running story is the one row whose state changes while you're looking
    // at it, so it is what this plugin asks the shell to lift to the top.
    pin: item.running,
    enterLabel: item.running ? 'Stop' : 'Start',
    // Enter is the thing you came here to do: put the clock on this story, or
    // take it off. Everything else is one more keystroke away under ⌘K.
    //
    // It stays open afterwards: starting a timer produces nothing you can see
    // anywhere else, so a panel that vanished on Enter left you guessing whether
    // the clock was running.
    run: () =>
      item.running ? ctx.actStay(() => jira.stop()) : ctx.actStay(() => jira.start(item.row.key)),
    actions: issueActions(item, snapshot, ctx),
  }));
}

/** What the section header says while there is nothing to list. */
function note(snapshot: JiraSnapshot, rows: Row[]): string | undefined {
  if (snapshot.conn.reason === 'unconfigured') return 'Not set up';
  if (!snapshot.conn.ok && snapshot.conn.reason !== 'checking') return connMessage(snapshot.conn);
  if (rows.length === 0) return snapshot.config.mineOnly ? 'Nothing assigned to you' : 'Nothing here';
  return undefined;
}

export const jiraView: PluginView<JiraSnapshot> = {
  id: ID,
  title: 'JIRA',

  section(snapshot, ctx): SectionContent {
    const rows = issueRows(snapshot, ctx);
    return {
      rows,
      note: note(snapshot, rows),
      actions: [
        {
          id: 'sec:refresh',
          title: 'Refresh board',
          run: () => ctx.actStay(() => window.jt.refresh(ID)),
        },
        {
          id: 'sec:settings',
          title: 'JIRA settings…',
          run: () => ctx.openSettings(ID),
        },
      ],
    };
  },

  commands(snapshot, ctx): Row[] {
    const boardName =
      snapshot.boards.find((b) => b.id === snapshot.config.boardId)?.name ?? 'All my boards';
    const baseUrl = snapshot.config.baseUrl.trim();

    return [
      {
        id: 'cmd:board',
        title: 'Switch board…',
        subtitle: boardName,
        keywords: ['project', 'sprint', 'jira'],
        run: () =>
          ctx.push({
            title: 'Show issues from',
            placeholder: 'Which board?',
            rows: [
              {
                id: 'board:all',
                title: 'All my boards',
                subtitle: 'Every board you have work in, merged',
                subsection: 'Boards',
                run: () =>
                  ctx.actStay(() => window.jt.savePluginConfig(ID, { boardId: null })),
              },
              ...snapshot.boards.map((board) => ({
                id: `board:${board.id}`,
                title: board.name,
                subtitle: board.type,
                subsection: 'Boards',
                run: () =>
                  ctx.actStay(() => window.jt.savePluginConfig(ID, { boardId: board.id })),
              })),
            ],
          }),
      },
      {
        id: 'cmd:mine',
        title: snapshot.config.mineOnly ? 'Show everyone’s issues' : 'Show only my issues',
        keywords: ['assignee', 'filter', 'jira'],
        run: () =>
          ctx.actStay(() =>
            window.jt.savePluginConfig(ID, { mineOnly: !snapshot.config.mineOnly }),
          ),
      },
      ...(baseUrl
        ? [
            {
              id: 'cmd:open-jira',
              title: 'Open JIRA in browser',
              subtitle: baseUrl,
              keywords: ['web', 'browser', 'site'],
              run: () => void window.jt.openUrl(baseUrl),
            },
          ]
        : []),
    ];
  },

  screen(snapshot, ctx, view, arg): ReactNode {
    if (view !== 'detail' || !arg) return null;
    return <Detail snapshot={snapshot} issueKey={arg} now={ctx.now} />;
  },

  settings(snapshot, onSaved): ReactNode {
    return <Settings snapshot={snapshot} onSaved={onSaved} />;
  },

  configured: (snapshot) => snapshot.conn.reason !== 'unconfigured',
};
