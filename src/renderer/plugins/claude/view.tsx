/**
 * The Claude Code section: which sessions are open, and which one wants you.
 *
 * The states are the shell's existing vocabulary rather than three new colours —
 * a session waiting on an answer is `attention`, the same lead a chunk of unfiled
 * time gets, because it is the same fact about the world: something is sitting
 * there wanting you to deal with it.
 */

import type { ReactNode } from 'react';
import type { Badge, Ctx, PluginView, Row, SectionContent } from '@shared/plugin';
import {
  buildSessionItems,
  dismissCompletion,
  hiddenSessions,
  hideSession,
  type ClaudeSnapshot,
  type SessionItem,
} from '@shared/claude';
import { formatDurationShort } from '@shared/time';
import { claude } from './client';
import { Settings } from './Settings';

const ID = 'claude';

/** Long enough to recognise the command, short enough not to wrap the row. */
const clip = (text: string, at = 64): string =>
  text.length > at ? `${text.slice(0, at - 1)}…` : text;

// `ok` is a dim tick rather than green: green is the connection dot's colour and
// not a UI one, so a finished session reads as settled instead of as a light.
const LEADS = {
  attention: 'attention',
  busy: 'active',
  completed: 'ok',
  idle: 'muted',
} as const;

/**
 * What the row says under the name.
 *
 * For a session that wants you it is the question itself — the whole reason to
 * look at this list is to find out which one to go to, and the directory doesn't
 * answer that. Everything else says where it is working.
 */
function subtitle(item: SessionItem): string {
  const open = item.session.open;
  if (item.state !== 'attention' || !open) return item.subtitle ?? '';
  return open.detail ? `${open.tool} · ${clip(open.detail)}` : `Waiting on ${open.tool}`;
}

function badges(item: SessionItem): Badge[] {
  const clock: Badge = {
    text: formatDurationShort(item.forSeconds),
    kind: 'clock',
    live: item.state === 'attention' || item.state === 'busy',
  };
  if (item.state === 'attention') return [{ text: 'needs you', tone: 'warn' }, clock];
  if (item.state === 'busy') return [{ text: 'working', tone: 'accent' }, clock];
  // Plain on purpose. It is worth noticing, not worth a colour that competes with
  // the one row here that actually wants something from you.
  if (item.state === 'completed') return [{ text: 'finished' }, clock];
  return [clock];
}

function actions(item: SessionItem, snapshot: ClaudeSnapshot, ctx: Ctx): Row[] {
  const { cwd, name, id, pid } = item.session;
  const copy = (text: string, what: string) => () =>
    ctx.act(async () => {
      await window.jt.copy(text);
      return { ok: true, message: `Copied ${what}` };
    });

  return [
    {
      id: 'act:reveal',
      title: 'Open working directory',
      subtitle: item.subtitle,
      badges: [{ text: '⌘O', kind: 'key' }],
      shortcut: 'o',
      run: () => ctx.act(() => claude.reveal(cwd)),
    },
    {
      id: 'act:copy-name',
      title: 'Copy session name',
      subtitle: 'What another session addresses this one by',
      keywords: ['message', 'peer', 'send'],
      badges: [{ text: '⌘C', kind: 'key' }],
      shortcut: 'c',
      run: copy(name, name),
    },
    {
      id: 'act:copy-id',
      title: 'Copy session id',
      subtitle: 'For claude --resume',
      keywords: ['resume', 'uuid', 'transcript'],
      run: copy(id, 'the session id'),
    },
    {
      id: 'act:copy-path',
      title: 'Copy working directory',
      keywords: ['cd', 'path', 'folder'],
      run: copy(cwd, cwd),
    },
    // Only on a row that has a result to acknowledge: on an idle one it would be
    // an action that visibly does nothing.
    ...(item.state === 'completed'
      ? [
          {
            id: 'act:dismiss',
            title: 'Dismiss',
            subtitle: 'Marks this result seen — the row goes back to Idle',
            keywords: ['seen', 'clear', 'acknowledge', 'done'],
            badges: [{ text: '⌘E', kind: 'key' as const }],
            shortcut: 'e',
            run: () =>
              ctx.actStay(() =>
                window.jt.savePluginConfig(ID, {
                  dismissed: dismissCompletion(
                    snapshot.config.dismissed,
                    item.session,
                    snapshot.sessions,
                  ),
                }),
              ),
          },
        ]
      : []),
    {
      // ⌘H is the system Hide accelerator — `menu.ts` keeps that role so the app
      // can be hidden at all — and a menu accelerator never reaches the renderer.
      id: 'act:hide',
      title: 'Hide this session',
      subtitle: 'Off the list until it ends. Nothing is stopped or closed',
      keywords: ['dismiss', 'remove', 'ignore', 'mute'],
      badges: [{ text: '⌘D', kind: 'key' }],
      shortcut: 'd',
      run: () =>
        ctx.actStay(() =>
          window.jt.savePluginConfig(ID, {
            hidden: hideSession(snapshot.config.hidden, item.session.id, snapshot.sessions),
          }),
        ),
    },
    {
      id: 'act:copy-pid',
      title: 'Copy process id',
      subtitle: String(pid),
      keywords: ['kill', 'ps', 'process'],
      run: copy(String(pid), `pid ${pid}`),
    },
  ];
}

function sessionRows(snapshot: ClaudeSnapshot, ctx: Ctx): Row[] {
  const items = buildSessionItems(snapshot.sessions, ctx.now, snapshot.config, snapshot.home);

  return items.map((item, index) => ({
    id: item.id,
    title: item.title,
    subtitle: subtitle(item),
    keywords: item.keywords,
    subsection: item.subsection,
    lead: LEADS[item.state],
    badges: badges(item),
    live: item.state === 'busy',
    // The longest wait, and only it: the one row here whose state is a claim on
    // your attention rather than a fact about your machine. `items` is already
    // ordered, so the first attention row is that one.
    pin: item.state === 'attention' && index === 0,
    enterLabel: 'Open folder',
    run: () => ctx.act(() => claude.reveal(item.session.cwd)),
    actions: actions(item, snapshot, ctx),
  }));
}

/** What the header says while there is nothing to list. */
function note(snapshot: ClaudeSnapshot, rows: Row[], hiddenCount: number): string | undefined {
  if (!snapshot.read) return 'Reading…';
  if (snapshot.sessions.length === 0) return 'No sessions running';
  if (rows.length === 0) {
    // Which empty this is matters: a list emptied by your own hiding reads as a
    // broken plugin if the header only says nothing is here.
    if (hiddenCount === snapshot.sessions.length) return `All ${hiddenCount} hidden`;
    const days = snapshot.config.idleDays;
    return `Nothing active in ${days} day${days === 1 ? '' : 's'}`;
  }
  return undefined;
}

export const claudeView: PluginView<ClaudeSnapshot> = {
  id: ID,
  title: 'Claude Code',

  section(snapshot, ctx): SectionContent {
    const rows = sessionRows(snapshot, ctx);
    // Only the ones still running: a stored id for a session that has ended is
    // about to be pruned anyway, and offering to bring back four when two exist
    // would be advertising the bookkeeping rather than the list.
    const hidden = hiddenSessions(snapshot.sessions, snapshot.config);

    return {
      rows,
      note: note(snapshot, rows, hidden.length),
      actions: [
        {
          id: 'sec:refresh',
          title: 'Refresh sessions',
          run: () => ctx.actStay(() => window.jt.refresh(ID)),
        },
        ...(hidden.length > 0
          ? [
              {
                id: 'sec:unhide',
                title: `Show ${hidden.length} hidden session${hidden.length === 1 ? '' : 's'}`,
                subtitle: hidden.map((session) => session.name).join(', '),
                keywords: ['unhide', 'restore', 'reset'],
                run: () =>
                  ctx.actStay(() => window.jt.savePluginConfig(ID, { hidden: [] })),
              },
            ]
          : []),
        {
          id: 'sec:settings',
          title: 'Claude Code settings…',
          run: () => ctx.openSettings(ID),
        },
      ],
    };
  },

  settings(snapshot, onSaved): ReactNode {
    return <Settings snapshot={snapshot} onSaved={onSaved} />;
  },
};
