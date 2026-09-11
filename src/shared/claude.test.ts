import { describe, it, expect } from 'vitest';
import {
  attentionCount,
  buildSessionItems,
  completionKey,
  defaultClaudeConfig,
  describeSessions,
  dismissCompletion,
  hiddenSessions,
  hideSession,
  sessionState,
  shortenPath,
  type ClaudeSession,
  type OpenCall,
} from './claude';

const NOW = 1_700_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Idle, and long enough ago not to count as just-finished — the state most of
 * these tests want as their starting point.
 */
const session = (id: string, over: Partial<ClaudeSession> = {}): ClaudeSession => ({
  id,
  pid: 100,
  name: id,
  title: null,
  cwd: '/Users/x/dev/thing',
  busy: false,
  changedAt: NOW - HOUR,
  startedAt: NOW - 24 * HOUR,
  open: null,
  ...over,
});

const call = (tool: string, agoSeconds: number): OpenCall => ({
  tool,
  detail: '',
  at: NOW - agoSeconds * SECOND,
});

const CONFIG = defaultClaudeConfig();

describe('sessionState', () => {
  it('calls a session that is not busy idle, whatever is in its transcript', () => {
    // A session between turns has ended whatever it was doing; an unanswered call
    // left in the tail is the one it was killed in the middle of, not a question.
    expect(sessionState(session('a'), NOW, CONFIG)).toBe('idle');
    expect(sessionState(session('a', { open: call('Bash', 600) }), NOW, CONFIG)).toBe('idle');
  });

  it('calls a busy session with nothing outstanding busy', () => {
    expect(sessionState(session('a', { busy: true }), NOW, CONFIG)).toBe('busy');
  });

  it('needs attention the moment a question is asked, with no threshold', () => {
    // Nothing is running that could answer these, so waiting on the clock would
    // only delay telling you about the one state you opened the section for.
    for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
      const s = session('a', { busy: true, open: call(tool, 0) });
      expect(sessionState(s, NOW, CONFIG)).toBe('attention');
    }
  });

  it('gives any other call the threshold before calling it a prompt', () => {
    const seconds = CONFIG.attentionSeconds;
    const young = session('a', { busy: true, open: call('Bash', seconds - 1) });
    const old = session('a', { busy: true, open: call('Bash', seconds + 1) });
    expect(sessionState(young, NOW, CONFIG)).toBe('busy');
    expect(sessionState(old, NOW, CONFIG)).toBe('attention');
  });

  it('takes the threshold from config, so a slow machine can raise it', () => {
    const s = session('a', { busy: true, open: call('Edit', 60) });
    expect(sessionState(s, NOW, { ...CONFIG, attentionSeconds: 45 })).toBe('attention');
    expect(sessionState(s, NOW, { ...CONFIG, attentionSeconds: 120 })).toBe('busy');
  });
});

describe('the finished state', () => {
  const justFinished = (id: string, agoMinutes: number): ClaudeSession =>
    session(id, { changedAt: NOW - agoMinutes * MINUTE });

  it('calls a session that stopped inside the window finished', () => {
    expect(sessionState(justFinished('a', 3), NOW, CONFIG)).toBe('completed');
  });

  it('lets it fall back to idle once the window passes', () => {
    // A turn that ended an hour ago is not news. The state exists for the one you
    // walked away from and came back to.
    expect(sessionState(justFinished('a', CONFIG.completedMinutes + 1), NOW, CONFIG)).toBe('idle');
  });

  it('takes the window from config', () => {
    const s = justFinished('a', 20);
    expect(sessionState(s, NOW, { ...CONFIG, completedMinutes: 30 })).toBe('completed');
    expect(sessionState(s, NOW, { ...CONFIG, completedMinutes: 10 })).toBe('idle');
  });

  it('never calls a session that has only just launched finished', () => {
    // Its status is stamped at launch, so without the guard a session sitting at
    // an empty prompt would announce a result it never produced.
    const fresh = session('a', { startedAt: NOW - 30 * SECOND, changedAt: NOW - 30 * SECOND });
    expect(sessionState(fresh, NOW, CONFIG)).toBe('idle');
  });

  it('never outranks a session that is busy or waiting', () => {
    const busy = session('a', { busy: true, changedAt: NOW - MINUTE });
    expect(sessionState(busy, NOW, CONFIG)).toBe('busy');
    const waiting = session('b', {
      busy: true,
      changedAt: NOW - MINUTE,
      open: call('AskUserQuestion', 5),
    });
    expect(sessionState(waiting, NOW, CONFIG)).toBe('attention');
  });

  it('goes back to idle once dismissed', () => {
    const s = justFinished('a', 3);
    const config = { ...CONFIG, dismissed: [completionKey(s)] };
    expect(sessionState(s, NOW, config)).toBe('idle');
  });

  it('reports the next result even though the last one was dismissed', () => {
    // The key carries when it finished, so dismissing acknowledges one result
    // rather than muting the session.
    const first = justFinished('a', 3);
    const config = { ...CONFIG, dismissed: [completionKey(first)] };
    const again = session('a', { changedAt: NOW - MINUTE });
    expect(sessionState(again, NOW, config)).toBe('completed');
  });
});

describe('dismissCompletion', () => {
  const live = [session('a'), session('b'), session('c')];

  it('stores the result that was seen, not the session', () => {
    const s = session('b', { changedAt: NOW - MINUTE });
    expect(dismissCompletion([], s, live)).toEqual([`b@${NOW - MINUTE}`]);
  });

  it('drops entries for sessions that have since ended', () => {
    const s = session('a', { changedAt: NOW - MINUTE });
    expect(dismissCompletion([`gone@${NOW}`, `b@${NOW}`], s, live)).toEqual([
      `b@${NOW}`,
      `a@${NOW - MINUTE}`,
    ]);
  });

  it('keeps only the latest result per session', () => {
    // Only the newest can still be on screen, so an older key for the same
    // session is bookkeeping nobody will read.
    const s = session('a', { changedAt: NOW });
    expect(dismissCompletion([`a@${NOW - HOUR}`], s, live)).toEqual([`a@${NOW}`]);
  });

  it('is bounded by one entry per running session, however often it is called', () => {
    let dismissed: string[] = ['old@1', 'older@2'];
    for (const id of ['a', 'b', 'a', 'c', 'b', 'a']) {
      dismissed = dismissCompletion(dismissed, session(id, { changedAt: NOW }), live);
    }
    expect(dismissed.sort()).toEqual([`a@${NOW}`, `b@${NOW}`, `c@${NOW}`]);
  });
});

describe('buildSessionItems', () => {
  it('orders the states: waiting, working, finished, then merely open', () => {
    const items = buildSessionItems(
      [
        session('idle-one'),
        session('finished', { changedAt: NOW - 2 * MINUTE }),
        session('busy-one', { busy: true }),
        session('waiting', { busy: true, open: call('AskUserQuestion', 5) }),
      ],
      NOW,
      CONFIG,
    );
    expect(items.map((i) => i.title)).toEqual(['waiting', 'busy-one', 'finished', 'idle-one']);
    expect(items.map((i) => i.subsection)).toEqual([
      'Waiting on you',
      'Working',
      'Finished',
      'Idle',
    ]);
  });

  it('leads with the longest wait, not the newest one', () => {
    const items = buildSessionItems(
      [
        session('just-asked', { busy: true, open: call('AskUserQuestion', 5) }),
        session('left-hanging', { busy: true, open: call('AskUserQuestion', 900) }),
      ],
      NOW,
      CONFIG,
    );
    expect(items.map((i) => i.title)).toEqual(['left-hanging', 'just-asked']);
  });

  it('leads with the most recent session everywhere else', () => {
    const items = buildSessionItems(
      [
        session('older', { changedAt: NOW - 3 * HOUR }),
        session('newer', { changedAt: NOW - 2 * HOUR }),
      ],
      NOW,
      CONFIG,
    );
    expect(items.map((i) => i.title)).toEqual(['newer', 'older']);
  });

  it('measures a waiting session from the question, not from the turn it started', () => {
    const s = session('a', {
      busy: true,
      changedAt: NOW - HOUR,
      open: call('AskUserQuestion', 120),
    });
    expect(buildSessionItems([s], NOW, CONFIG)[0].forSeconds).toBe(120);
  });

  it('drops idle sessions past the cutoff, so the stale ones stop hiding the live', () => {
    const stale = session('stale', { changedAt: NOW - 20 * 24 * HOUR });
    const fresh = session('fresh', { changedAt: NOW - 2 * HOUR });
    expect(buildSessionItems([stale, fresh], NOW, CONFIG).map((i) => i.title)).toEqual(['fresh']);
    expect(
      buildSessionItems([stale, fresh], NOW, { ...CONFIG, idleDays: 0 }).map((i) => i.title),
    ).toEqual(['fresh', 'stale']);
  });

  it('never drops a session that wants you, however long it has waited', () => {
    // The cutoff is about clutter, and a fortnight-old question is not clutter.
    const s = session('a', {
      busy: true,
      changedAt: NOW - 20 * 24 * HOUR,
      open: call('AskUserQuestion', 20 * 24 * 3600),
    });
    expect(buildSessionItems([s], NOW, CONFIG)).toHaveLength(1);
  });

  it('says what the session is about, the way /resume lists it', () => {
    const s = session('a', { title: 'Rework the checkout form validation' });
    const [item] = buildSessionItems([s], NOW, CONFIG);
    expect(item.title).toBe('a');
    expect(item.subtitle).toBe('Rework the checkout form validation');
  });

  it('falls back to the path for a session too new to have a title', () => {
    const [item] = buildSessionItems([session('a')], NOW, { ...CONFIG }, '/Users/x');
    expect(item.subtitle).toBe('~/dev/thing');
  });

  it('still matches on the path once the title has taken its place', () => {
    // The subtitle is what the palette searches, so a title pushing the path off
    // the row would otherwise stop "oralgen" finding the session in oralgen.
    const s = session('a', { title: 'Something else entirely' });
    const [item] = buildSessionItems([s], NOW, CONFIG, '/Users/x');
    expect(item.keywords).toContain('~/dev/thing');
  });

  it('matches on the path and the pid, which are not what the row shows', () => {
    const items = buildSessionItems([session('a', { pid: 4242 })], NOW, CONFIG);
    expect(items[0].keywords).toContain('4242');
    expect(items[0].keywords).toContain('/Users/x/dev/thing');
  });
});

describe('hideSession', () => {
  const live = [session('a'), session('b'), session('c')];

  it('adds the session to the list', () => {
    expect(hideSession([], 'b', live)).toEqual(['b']);
  });

  it('drops hidden sessions that have since ended', () => {
    // The pruning is what stops this becoming a permanent blocklist: an id only
    // means anything while the session it names is still running.
    expect(hideSession(['gone', 'a', 'also-gone'], 'c', live)).toEqual(['a', 'c']);
  });

  it('does not list the same session twice', () => {
    expect(hideSession(['a', 'b'], 'b', live)).toEqual(['a', 'b']);
  });

  it('is bounded by what is actually open, however often it is called', () => {
    let hidden: string[] = ['one', 'two', 'three', 'four'];
    for (const id of ['a', 'b', 'c', 'a', 'b']) hidden = hideSession(hidden, id, live);
    expect(hidden.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('hidden sessions', () => {
  it('leaves a hidden session out of the list', () => {
    const items = buildSessionItems([session('a'), session('b')], NOW, {
      ...CONFIG,
      hidden: ['a'],
    });
    expect(items.map((i) => i.session.id)).toEqual(['b']);
  });

  it('hides one that is waiting, unlike the idle cutoff', () => {
    // Hiding is the user saying "not this one", and it only lasts as long as the
    // session does — so it is allowed to be absolute where the cutoff is not.
    const waiting = session('a', { busy: true, open: call('AskUserQuestion', 30) });
    expect(buildSessionItems([waiting], NOW, { ...CONFIG, hidden: ['a'] })).toHaveLength(0);
  });

  it('does not count a hidden session in the menu bar', () => {
    const sessions = [
      session('a', { busy: true, open: call('AskUserQuestion', 5) }),
      session('b', { busy: true, open: call('AskUserQuestion', 5) }),
    ];
    expect(attentionCount(sessions, NOW, CONFIG)).toBe(2);
    expect(attentionCount(sessions, NOW, { ...CONFIG, hidden: ['a'] })).toBe(1);
  });

  it('ignores an id for a session that is not running', () => {
    const items = buildSessionItems([session('a')], NOW, { ...CONFIG, hidden: ['long-gone'] });
    expect(items).toHaveLength(1);
  });

  it('lists only the hidden sessions still running', () => {
    const sessions = [session('a'), session('b')];
    const config = { ...CONFIG, hidden: ['a', 'ended-yesterday'] };
    expect(hiddenSessions(sessions, config).map((s) => s.id)).toEqual(['a']);
  });
});

describe('attentionCount', () => {
  it('counts only what is waiting — the number the menu bar shows', () => {
    const sessions = [
      session('a', { busy: true, open: call('AskUserQuestion', 5) }),
      session('b', { busy: true, open: call('Bash', 2) }),
      session('c'),
      session('d', { changedAt: NOW - MINUTE }),
    ];
    expect(attentionCount(sessions, NOW, CONFIG)).toBe(1);
  });
});

describe('describeSessions', () => {
  it('groups by state and says what a waiting session is blocked on, and for how long', () => {
    const sessions = [
      session('a', {
        title: 'Port the palette',
        busy: true,
        open: { tool: 'AskUserQuestion', detail: 'Which board?', at: NOW - 14 * MINUTE },
      }),
      session('b', { busy: true, open: call('Bash', 2) }),
      session('c'),
    ];
    const lines = describeSessions(sessions, NOW, CONFIG, '/Users/x').split('\n');
    expect(lines[0]).toBe('Waiting on you:');
    expect(lines[1]).toContain('a — Port the palette · ~/dev/thing · AskUserQuestion (Which board?) for 14m');
    expect(lines[2]).toBe('Working:');
    expect(lines[4]).toBe('Idle:');
  });

  it('leaves out hidden sessions, and says so plainly when there are none at all', () => {
    expect(describeSessions([], NOW, CONFIG)).toBe('No Claude Code sessions are open.');
    const hidden = { ...CONFIG, hidden: ['a'] };
    expect(describeSessions([session('a')], NOW, hidden)).toBe('No Claude Code sessions are open.');
  });
});

describe('shortenPath', () => {
  it('folds the home directory, which is mostly your own name', () => {
    expect(shortenPath('/Users/x/dev/j-time', '/Users/x')).toBe('~/dev/j-time');
    expect(shortenPath('/Users/x', '/Users/x')).toBe('~');
  });

  it('leaves a path outside home alone, and survives an unknown home', () => {
    expect(shortenPath('/opt/src', '/Users/x')).toBe('/opt/src');
    expect(shortenPath('/Users/x/dev', '')).toBe('/Users/x/dev');
  });
});
