import type { ReactNode } from 'react';
import type { JiraSnapshot } from '@shared/jira';
import { groupByStage } from '@shared/stages';
import { activeSeconds, formatClock, formatDurationShort } from '@shared/time';
import { trackedByActivity } from '@shared/timer-logic';

/**
 * One story's full readout: the clock, where its time went, and how that compares
 * to the estimate.
 *
 * A story the timer has never seen still renders the whole shape — 00:00:00, the
 * estimate line, and an Untracked bar for JIRA's own hours. A story with hours on
 * it looking emptier than its siblings is what prompted keeping the furniture.
 */
export function Detail({
  snapshot,
  issueKey,
  now,
}: {
  snapshot: JiraSnapshot;
  issueKey: string;
  now: number;
}): ReactNode {
  const groups = groupByStage({
    issues: snapshot.issues,
    doneIssues: snapshot.doneIssues,
    stories: snapshot.state.stories,
    now,
    activeKey: snapshot.state.activeKey,
  });
  const row =
    [...groups.doing, ...groups.todo, ...groups.done, ...groups.elsewhere].find(
      (r) => r.key === issueKey,
    ) ?? null;

  if (!row) {
    return (
      <div className="empty">
        <strong>{issueKey} isn’t on this board</strong>
        Switch boards, or refresh.
      </div>
    );
  }

  const story = row.timer;
  const tracked = story ? activeSeconds(story.segments, now) : 0;
  // JIRA's total is the source of truth for "time spent"; our own tally is only
  // what this app sent. Conflating them cancels a user's pre-existing worklogs.
  const rows = trackedByActivity(story, now, row.secondsSpent);
  const total = rows.reduce((n, r) => n + r.seconds, 0) || 1;

  return (
    <div className="detail">
      <h2>{row.key}</h2>
      <div className="summary">{row.summary}</div>

      <div className="bigclock clock">{formatClock(tracked)}</div>
      <div className="meta">
        {row.status}
        {row.estimateSeconds != null && ` · ${formatDurationShort(row.estimateSeconds)} estimated`}
        {row.secondsSpent != null && ` · ${formatDurationShort(row.secondsSpent)} spent in JIRA`}
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <strong>No time tracked yet</strong>
          Press ↩ on this story to start the clock.
        </div>
      ) : (
        rows.map((r) => {
          const banked = (r.loggedSeconds / total) * 100;
          const pending = ((r.seconds - r.loggedSeconds) / total) * 100;
          return (
            <div key={r.activity} className={`bar${r.untracked ? ' untracked' : ''}`}>
              <div className="bar-head">
                <span className="name">{r.activity}</span>
                <span className="clock">{formatDurationShort(r.seconds)}</span>
              </div>
              <div className="track">
                <span className="banked" style={{ width: `${banked}%` }} />
                <span className="pending" style={{ width: `${pending}%` }} />
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
