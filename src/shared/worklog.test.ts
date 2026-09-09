import { describe, it, expect, vi } from 'vitest';
import { fileTime, finishStory, type WorklogWriter } from './worklog';
import type { Segment, StoryTimer, TimerState } from './types';

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const NOW = T0 + 200 * MIN;

/** `[startMinute, endMinute | null, activity?, logged?]` */
type Seg = [number, number | null, string?, boolean?];

function seg([start, end, activity, logged]: Seg): Segment {
  return {
    start: T0 + start * MIN,
    end: end === null ? null : T0 + end * MIN,
    ...(activity === undefined ? {} : { activity }),
    ...(logged === undefined ? {} : { logged }),
  };
}

function state(segs: Seg[], over: Partial<StoryTimer> = {}): TimerState {
  const story: StoryTimer = {
    key: 'AB-1',
    summary: 'A story',
    status: 'In Progress',
    assignee: null,
    estimateSeconds: null,
    segments: segs.map(seg),
    doneAt: null,
    worklogId: null,
    loggedSeconds: null,
    ...over,
  };
  return { activeKey: null, stories: { 'AB-1': story } };
}

function writer(over: Partial<WorklogWriter> = {}) {
  let n = 0;
  const base = {
    addWorklog: vi.fn(async (_key: string, _seconds: number, _comment: string, _started: number) => ({
      id: `w${++n}`,
    })),
    doTransition: vi.fn(async (_key: string, _transitionId: string) => {}),
  };
  return Object.assign(base, over);
}

const deps = (w: WorklogWriter, save = vi.fn(async () => {})) => ({ writer: w, save, now: NOW });

describe('fileTime', () => {
  it('posts the chunk at its exact length, unrounded', async () => {
    // Rounding per chunk is what inflates a total — three 2m chunks becoming 15m.
    const s = state([[0, 2]]);
    const w = writer();
    const result = await fileTime(s, 'AB-1', 'Building', deps(w));

    expect(result).toMatchObject({ ok: true, loggedSeconds: 120, worklogId: 'w1' });
    expect(w.addWorklog).toHaveBeenCalledWith(
      'AB-1',
      120,
      'Building — Tracked via j-time',
      T0,
    );
  });

  it('dates the worklog from the earliest chunk being filed, not from now', async () => {
    const s = state([[10, 12], [20, 25]]);
    const w = writer();
    await fileTime(s, 'AB-1', 'Testing', deps(w));
    expect(w.addWorklog.mock.calls[0][3]).toBe(T0 + 10 * MIN);
  });

  it('sweeps every stopped unfiled chunk into one worklog', async () => {
    const s = state([[0, 5], [10, 15]]);
    const w = writer();
    const result = await fileTime(s, 'AB-1', 'Building', deps(w));
    expect(result).toMatchObject({ loggedSeconds: 600 });
    expect(w.addWorklog).toHaveBeenCalledTimes(1);
  });

  it('leaves the running chunk alone — stopping is what makes time filable', async () => {
    const s = state([[0, 5], [190, null]]);
    const w = writer();
    await fileTime(s, 'AB-1', 'Building', deps(w));

    expect(w.addWorklog.mock.calls[0][1]).toBe(300);
    expect(s.stories['AB-1'].segments[1].logged).toBeUndefined();
  });

  it("refuses sub-minute time rather than letting JIRA's clamp inflate it", async () => {
    // addWorklog floors at 60s, so filing a 20s chunk would bank a whole minute and
    // markClassified would add that minute to loggedSeconds.
    const s = state([]);
    s.stories['AB-1'].segments.push({ start: NOW - 20_000, end: NOW });
    const w = writer();
    const result = await fileTime(s, 'AB-1', 'Building', deps(w));

    expect(result).toMatchObject({ ok: false, reason: 'nothing-to-file' });
    if (!result.ok) expect(result.error).toContain('20s');
    expect(w.addWorklog).not.toHaveBeenCalled();
  });

  it('leaves a refused sub-minute chunk unlabelled, so nothing was half-done', async () => {
    const s = state([]);
    s.stories['AB-1'].segments.push({ start: NOW - 20_000, end: NOW });
    const save = vi.fn(async () => {});
    await fileTime(s, 'AB-1', 'Building', deps(writer(), save));

    expect(s.stories['AB-1'].segments[0].activity).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it('files exactly one minute, the smallest JIRA accepts', async () => {
    const s = state([[0, 1]]);
    const w = writer();
    expect(await fileTime(s, 'AB-1', 'Building', deps(w))).toMatchObject({ loggedSeconds: 60 });
  });

  it('refuses when only a running chunk exists', async () => {
    const s = state([[190, null]]);
    const w = writer();
    const result = await fileTime(s, 'AB-1', 'Building', deps(w));

    expect(result).toMatchObject({ ok: false, reason: 'nothing-to-file' });
    expect(w.addWorklog).not.toHaveBeenCalled();
  });

  it('never re-sends a chunk a worklog already covers', async () => {
    const s = state([[0, 30, 'Building', true], [40, 45]]);
    const w = writer();
    const result = await fileTime(s, 'AB-1', 'Review', deps(w));
    expect(result).toMatchObject({ loggedSeconds: 300 });
  });

  it('reports an unknown story rather than throwing', async () => {
    const result = await fileTime(state([]), 'ZZ-9', 'Building', deps(writer()));
    expect(result).toMatchObject({ ok: false, reason: 'unknown-story' });
  });

  it('accumulates loggedSeconds across separate filings', async () => {
    const s = state([[0, 5]]);
    await fileTime(s, 'AB-1', 'Building', deps(writer()));
    s.stories['AB-1'].segments.push(seg([10, 20]));
    await fileTime(s, 'AB-1', 'Review', deps(writer()));
    expect(s.stories['AB-1'].loggedSeconds).toBe(300 + 600);
  });

  describe('when JIRA rejects the worklog', () => {
    const rejecting = () =>
      writer({
        addWorklog: vi.fn(async () => {
          throw new Error('403 Forbidden');
        }),
      });

    it('keeps the label but not the logged flag, so the next attempt retries it', async () => {
      const s = state([[0, 5]]);
      const result = await fileTime(s, 'AB-1', 'Building', deps(rejecting()));

      expect(result).toMatchObject({ ok: false, reason: 'jira-rejected', pending: true });
      expect(s.stories['AB-1'].segments[0].activity).toBe('Building');
      expect(s.stories['AB-1'].segments[0].logged).toBeUndefined();
      expect(s.stories['AB-1'].loggedSeconds).toBeNull();
    });

    it('says both what stuck and what did not', async () => {
      const result = await fileTime(state([[0, 5]]), 'AB-1', 'Building', deps(rejecting()));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Filed as Building');
        expect(result.error).toContain('403 Forbidden');
      }
    });

    it('has already persisted the label before the request went out', async () => {
      // The whole point of saving twice: a crash mid-request must not lose the label.
      const save = vi.fn(async () => {});
      await fileTime(state([[0, 5]]), 'AB-1', 'Building', deps(rejecting(), save));
      expect(save).toHaveBeenCalledTimes(1);
    });
  });

  it('stores Unlabelled as the absence of a label, not as the word', async () => {
    const s = state([[0, 5]]);
    await fileTime(s, 'AB-1', 'Unlabelled', deps(writer()));
    expect(s.stories['AB-1'].segments[0].activity).toBeNull();
  });
});

describe('finishStory', () => {
  const opts = { roundMinutes: 5 };

  it('is a pure status change when everything is already filed', async () => {
    const s = state([[0, 30, 'Building', true]]);
    const w = writer();
    const result = await finishStory(s, 'AB-1', { ...opts, transitionId: '31' }, deps(w));

    expect(result).toMatchObject({ ok: true, loggedSeconds: 0, breakdown: [], worklogIds: [] });
    expect(w.addWorklog).not.toHaveBeenCalled();
    expect(w.doTransition).toHaveBeenCalledWith('AB-1', '31');
    expect(s.stories['AB-1'].doneAt).toBe(NOW);
  });

  it('treats a few seconds between Stop and Done as nothing, not as five minutes', async () => {
    // roundSeconds floors at a whole increment, so going through it directly here
    // would post 5m for a 20s leftover.
    const s = state([[0, 30, 'Building', true]]);
    s.stories['AB-1'].segments.push({ start: NOW - 20_000, end: NOW });
    const w = writer();
    const result = await finishStory(s, 'AB-1', opts, deps(w));

    expect(result).toMatchObject({ loggedSeconds: 0 });
    expect(w.addWorklog).not.toHaveBeenCalled();
  });

  it('rounds the leftover total and splits it across activities', async () => {
    const s = state([[0, 2, 'Building'], [10, 12, 'Testing'], [20, 22, 'Review']]);
    const w = writer();
    const result = await finishStory(s, 'AB-1', opts, deps(w));

    // 6 minutes of work rounds to 5, apportioned — not three 5m worklogs for 15m.
    expect(result).toMatchObject({ ok: true, loggedSeconds: 300 });
    if (result.ok) {
      expect(result.breakdown.reduce((n, b) => n + b.seconds, 0)).toBe(300);
      expect(result.worklogIds).toHaveLength(3);
    }
  });

  it('names each worklog after its activity', async () => {
    const s = state([[0, 10, 'Building'], [20, 30, 'Review']]);
    const w = writer();
    await finishStory(s, 'AB-1', opts, deps(w));
    const comments = w.addWorklog.mock.calls.map((c) => c[2]);
    expect(comments).toEqual([
      'Building — Tracked via j-time',
      'Review — Tracked via j-time',
    ]);
  });

  it('folds a note into the comment', async () => {
    const s = state([[0, 10, 'Building']]);
    const w = writer();
    await finishStory(s, 'AB-1', { ...opts, note: 'pairing' }, deps(w));
    expect(w.addWorklog.mock.calls[0][2]).toBe('Building — pairing (via j-time)');
  });

  it('excludes time JIRA already has from the sweep', async () => {
    const s = state([[0, 60, 'Building', true], [100, 110, 'Review']]);
    const w = writer();
    const result = await finishStory(s, 'AB-1', opts, deps(w));
    expect(result).toMatchObject({ loggedSeconds: 600 });
  });

  it('closes the running chunk and folds it in as unlabelled', async () => {
    const s = state([[190, null]]);
    s.activeKey = 'AB-1';
    const w = writer();
    const result = await finishStory(s, 'AB-1', opts, deps(w));

    expect(result).toMatchObject({ ok: true, loggedSeconds: 600 });
    // A worklog must never read "Running".
    expect(w.addWorklog.mock.calls[0][2]).not.toContain('Running');
    expect(s.stories['AB-1'].segments[0].end).toBe(NOW);
    expect(s.activeKey).toBeNull();
  });

  it('marks every closed segment logged so a second Done sends nothing', async () => {
    const s = state([[0, 10, 'Building']]);
    await finishStory(s, 'AB-1', opts, deps(writer()));
    const again = await finishStory(s, 'AB-1', opts, deps(writer()));
    expect(again).toMatchObject({ loggedSeconds: 0 });
  });

  it('leaves the status alone when given no transition', async () => {
    const w = writer();
    await finishStory(state([[0, 10, 'Building']]), 'AB-1', opts, deps(w));
    expect(w.doTransition).not.toHaveBeenCalled();
  });

  it('does not mark the story done when the worklog is refused', async () => {
    const s = state([[0, 10, 'Building']]);
    const w = writer({
      addWorklog: vi.fn(async () => {
        throw new Error('502 Bad Gateway');
      }),
    });
    const result = await finishStory(s, 'AB-1', opts, deps(w));

    expect(result).toMatchObject({ ok: false, reason: 'jira-rejected' });
    expect(s.stories['AB-1'].doneAt).toBeNull();
    expect(s.stories['AB-1'].segments[0].logged).toBeUndefined();
  });

  it('reports a failed transition even though the sweep succeeded', async () => {
    const s = state([[0, 30, 'Building', true]]);
    const w = writer({
      doTransition: vi.fn(async () => {
        throw new Error('transition 99 is not available');
      }),
    });
    const result = await finishStory(s, 'AB-1', { ...opts, transitionId: '99' }, deps(w));

    expect(result).toMatchObject({ ok: false, reason: 'jira-rejected' });
    // Locally it is finished regardless — that write happened before the attempt.
    expect(s.stories['AB-1'].doneAt).toBe(NOW);
  });

  it('reports an unknown story rather than throwing', async () => {
    const result = await finishStory(state([]), 'ZZ-9', opts, deps(writer()));
    expect(result).toMatchObject({ ok: false, reason: 'unknown-story' });
  });
});
