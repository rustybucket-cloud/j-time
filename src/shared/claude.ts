/**
 * The Claude Code plugin's slice of the snapshot, and the rule that orders it.
 *
 * Claude Code leaves a small state file per live session under
 * `~/.claude/sessions/<pid>.json`, and that file knows two states: `idle` and
 * `busy`. Neither is the one worth being told about. A session that has stopped
 * to ask you something is `busy` — measured, not assumed: the status stays busy
 * across a whole turn, permission prompt included, and `statusUpdatedAt` doesn't
 * move while the prompt is up. So "waiting on you" is indistinguishable from
 * "running a build" in that file, and has to be derived from the other thing a
 * session leaves on disk: its transcript.
 *
 * The derivation is here, pure, so the rule that decides a session wants you can
 * be tested without a Claude session to point it at. Reading the files is
 * `main/plugins/claude/sessions.ts`; only the meaning lives here.
 */

import type { Searchable } from './palette';
import { formatDurationShort } from './time';

/** What a session is doing, as the section groups them. */
export type SessionState = 'attention' | 'busy' | 'completed' | 'idle';

/**
 * A tool call at the tail of a transcript with nothing after it.
 *
 * The transcript records a call when it is *made*, not when it returns — an
 * `AskUserQuestion` sat unanswered in one of these for 862 seconds, an `Edit`
 * for 216 — so a call still unanswered is either a tool that is running or a
 * question waiting on a person. Telling those two apart is the whole job below.
 */
export interface OpenCall {
  tool: string;
  /** The command, path or heading that names this particular call. */
  detail: string;
  at: number;
}

export interface ClaudeSession {
  /** Claude Code's session id, which is also the name of its transcript file. */
  id: string;
  pid: number;
  /** What peer sessions address it by, e.g. `j-time-fb`. */
  name: string;
  /**
   * The generated title, the same one `/resume` lists a session under.
   *
   * Null until Claude Code has written one: a session that has only just started
   * has no subject yet, and a title invented from the path would only be the
   * name again.
   */
  title: string | null;
  cwd: string;
  /** What the session file says. True for a whole turn, prompts included. */
  busy: boolean;
  /** When it last crossed between busy and idle. */
  changedAt: number;
  startedAt: number;
  open: OpenCall | null;
}

export interface ClaudeConfig {
  /**
   * How long an unanswered call sits before it reads as a prompt rather than a
   * tool taking a while. The one genuinely inferred number in the plugin.
   */
  attentionSeconds: number;
  /**
   * How long a session that has just finished stays called out as finished.
   *
   * The window is the whole idea: a turn that ended an hour ago is not news, and
   * the state exists to catch the one you walked away from and came back to.
   */
  completedMinutes: number;
  /** Idle sessions older than this drop out of the list. 0 keeps every one. */
  idleDays: number;
  /**
   * Session ids the user has taken off the list.
   *
   * Ids rather than paths or names, so hiding lasts exactly as long as the
   * session does: the id dies with it, and `hideSession` drops the dead ones
   * every time another is added. That is what keeps this from growing into a
   * permanent blocklist of sessions that no longer exist.
   */
  hidden: string[];
  /**
   * Finished turns the user has already seen, as `<session id>@<finished at>`.
   *
   * The timestamp is what makes this a dismissal of one *result* rather than of
   * the session: the same session finishing again is a new key, and says so.
   */
  dismissed: string[];
}

export function defaultClaudeConfig(): ClaudeConfig {
  return { attentionSeconds: 45, completedMinutes: 10, idleDays: 7, hidden: [], dismissed: [] };
}

export interface ClaudeSnapshot {
  config: ClaudeConfig;
  sessions: ClaudeSession[];
  /** The home directory, so the renderer can shorten a path it never computed. */
  home: string;
  /** False until the first read, so an empty list can say which empty it is. */
  read: boolean;
}

/**
 * Take a session off the list, and drop any hidden session that has since ended.
 *
 * The pruning rides along with the hiding on purpose: the list can only grow
 * when the user hides something, and every hide clears out the dead — so it is
 * bounded by the number of sessions actually open, with nothing to sweep and no
 * second place for the rule to live.
 */
export function hideSession(hidden: string[], id: string, live: ClaudeSession[]): string[] {
  const open = new Set(live.map((session) => session.id));
  return [...hidden.filter((was) => was !== id && open.has(was)), id];
}

/** Names one finished turn: the same session finishing again is a different key. */
export function completionKey(session: ClaudeSession): string {
  return `${session.id}@${session.changedAt}`;
}

/**
 * Mark a finished turn as seen, and drop what no longer means anything.
 *
 * Prunes on the same principle as `hideSession`, and one step further: entries
 * for a session that has ended go, and so does that session's own previous
 * entry, because only its latest result can still be on screen. What is left is
 * at most one key per running session.
 */
export function dismissCompletion(
  dismissed: string[],
  session: ClaudeSession,
  live: ClaudeSession[],
): string[] {
  const open = new Set(live.map((s) => s.id));
  const kept = dismissed.filter((entry) => {
    const id = entry.slice(0, entry.lastIndexOf('@'));
    return id !== session.id && open.has(id);
  });
  return [...kept, completionKey(session)];
}

/** The hidden sessions still running — what "show hidden" would put back. */
export function hiddenSessions(sessions: ClaudeSession[], config: ClaudeConfig): ClaudeSession[] {
  const hidden = new Set(config.hidden);
  return sessions.filter((session) => hidden.has(session.id));
}

/**
 * Tools whose answer can only come from a person.
 *
 * A session sitting on one of these is waiting however briefly it has been —
 * there is nothing running that could finish on its own — so they skip the
 * threshold that a permission prompt needs.
 */
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * A session that has never been busy has not finished anything.
 *
 * A freshly launched one is idle with its status stamped at launch, and without
 * this it would announce itself as just-finished for ten minutes having done
 * nothing at all. The slack is for the stamp not landing on exactly the same
 * millisecond as the start.
 */
const LAUNCH_SLACK_MS = 2_000;

export function sessionState(
  session: ClaudeSession,
  now: number,
  config: ClaudeConfig,
): SessionState {
  if (session.busy) {
    if (!session.open) return 'busy';
    if (ASKS.has(session.open.tool)) return 'attention';
    // A permission prompt and a slow tool are the same two records on disk: a
    // call, and no result yet. Age is the only thing that separates them.
    return now - session.open.at >= config.attentionSeconds * 1000 ? 'attention' : 'busy';
  }

  // Not busy, so whatever it was doing has ended. Recently enough to be news,
  // and not already acknowledged, makes it a result rather than another idle row.
  const finished =
    session.changedAt - session.startedAt > LAUNCH_SLACK_MS &&
    now - session.changedAt <= config.completedMinutes * 60_000 &&
    !config.dismissed.includes(completionKey(session));

  return finished ? 'completed' : 'idle';
}

export const SUBSECTION_LABELS: Record<SessionState, string> = {
  attention: 'Waiting on you',
  busy: 'Working',
  completed: 'Finished',
  idle: 'Idle',
};

export interface SessionItem extends Searchable {
  kind: 'session';
  session: ClaudeSession;
  state: SessionState;
  subsection: string;
  /** How long it has been in this state — the wait, when it is waiting. */
  forSeconds: number;
}

/** `~/dev/apps/j-time` rather than the whole path, which is mostly your name. */
export function shortenPath(cwd: string, home: string): string {
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
  return cwd;
}

/**
 * One item per live session, in the order the section lists them.
 *
 * Waiting first, because that is the only reason to open this section on a
 * keystroke; then what's working, then what's merely open. Inside the waiting
 * group the *longest* wait leads — a session you left hanging twenty minutes ago
 * has more claim on you than one that asked a moment ago.
 *
 * Everything else is most-recent-first, which puts the session you were last in
 * at the top of its group.
 */
export function buildSessionItems(
  sessions: ClaudeSession[],
  now: number,
  config: ClaudeConfig,
  home = '',
): SessionItem[] {
  const items: SessionItem[] = [];
  const hidden = new Set(config.hidden);

  for (const session of sessions) {
    // Hiding is the user saying "not this one", and it outranks every other rule
    // here — including the one that keeps a waiting session on screen. It costs
    // nothing to be absolute about it, because it lapses when the session ends.
    if (hidden.has(session.id)) continue;
    const state = sessionState(session, now, config);
    const since = state === 'attention' && session.open ? session.open.at : session.changedAt;
    const forSeconds = Math.max(0, Math.floor((now - since) / 1000));

    // A machine left running for a fortnight collects sessions nobody will go
    // back to, and a list of thirty of those hides the two that want you.
    if (state === 'idle' && config.idleDays > 0 && forSeconds > config.idleDays * 86_400) continue;

    items.push({
      kind: 'session',
      id: `session:${session.id}`,
      // The name stays the identifier and the title says what it is about, which
      // is the shape every other row in the app already has: a key, then a
      // summary. Three sessions in the same repo are indistinguishable otherwise.
      title: session.name,
      subtitle: session.title ?? shortenPath(session.cwd, home),
      keywords: [
        session.cwd,
        shortenPath(session.cwd, home),
        String(session.pid),
        // Carried explicitly because a waiting row shows what it is blocked on
        // instead of its title, and typing the subject should still find it.
        session.title ?? '',
        session.open?.tool ?? '',
        state,
      ].filter(Boolean),
      session,
      state,
      subsection: SUBSECTION_LABELS[state],
      forSeconds,
    });
  }

  const rank: Record<SessionState, number> = { attention: 0, busy: 1, completed: 2, idle: 3 };
  return items.sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    // Longest wait first while waiting; most recent first everywhere else.
    return a.state === 'attention' ? b.forSeconds - a.forSeconds : a.forSeconds - b.forSeconds;
  });
}

/**
 * The sessions as a caller with no screen reads them.
 *
 * Grouped by the same four states the section uses, and the wait is spelled out
 * rather than badged: "waiting 14m on AskUserQuestion" is the whole point of the
 * plugin, and it is the one thing a peer session cannot find out for itself.
 */
export function describeSessions(
  sessions: ClaudeSession[],
  now: number,
  config: ClaudeConfig,
  home = '',
): string {
  const items = buildSessionItems(sessions, now, config, home);
  if (items.length === 0) return 'No Claude Code sessions are open.';

  const lines: string[] = [];
  let group: SessionState | null = null;
  for (const item of items) {
    if (item.state !== group) {
      group = item.state;
      lines.push(`${SUBSECTION_LABELS[item.state]}:`);
    }
    const wait = formatDurationShort(item.forSeconds);
    const what =
      item.state === 'attention' && item.session.open
        ? `${item.session.open.tool}${item.session.open.detail ? ` (${item.session.open.detail})` : ''} for ${wait}`
        : item.state === 'busy'
          ? `working for ${wait}`
          : item.state === 'completed'
            ? `finished ${wait} ago`
            : `idle ${wait}`;
    lines.push(
      `  ${item.session.name} — ${item.session.title ?? '(no title yet)'} · ` +
        `${shortenPath(item.session.cwd, home)} · ${what}`,
    );
  }
  return lines.join('\n');
}

/** How many sessions want you — what the menu bar counts. Hidden ones don't. */
export function attentionCount(sessions: ClaudeSession[], now: number, config: ClaudeConfig): number {
  const hidden = new Set(config.hidden);
  return sessions.filter(
    (s) => !hidden.has(s.id) && sessionState(s, now, config) === 'attention',
  ).length;
}
