/**
 * The board and the clock in prose, for a caller with no screen.
 *
 * An MCP tool answers in text, and that text is the whole interface: a model
 * cannot see the card the numbers came off, so it has to be told which of the
 * three time quantities it is reading. Hence "tracked here", "filed" and "JIRA
 * has" as separate phrases throughout — `tracked` is local segments,
 * `loggedSeconds` is what this app sent, and `secondsSpent` is JIRA's own total
 * including worklogs from before the app existed. A summary that collapsed them
 * would have the caller file time JIRA already has.
 *
 * Pure, and here rather than in the plugin, for the same reason the ranking is:
 * it is a rule about what the app says, so it is testable without a JIRA.
 */

import type { JiraIssue, TimerState } from './types';
import { activeSeconds, formatDurationShort, isRunning } from './time';
import { trackedByActivity, unloggedSeconds } from './timer-logic';
import { STAGE_LABELS, STAGE_ORDER } from './stages';

const dur = (seconds: number): string => formatDurationShort(Math.max(0, Math.round(seconds)));

/** What this app has measured on a story, and how much of it JIRA has. */
export function storyTotals(
  state: TimerState,
  key: string,
  now: number,
): { tracked: number; filed: number; unfiled: number } {
  const story = state.stories[key];
  if (!story) return { tracked: 0, filed: 0, unfiled: 0 };
  const tracked = activeSeconds(story.segments, now);
  const unfiled = unloggedSeconds(story, now);
  return { tracked, filed: Math.max(0, tracked - unfiled), unfiled };
}

/** Every story with time nothing has filed yet, longest first. */
export function unfiledStories(
  state: TimerState,
  now: number,
): { key: string; summary: string; seconds: number }[] {
  return Object.values(state.stories)
    .map((story) => ({
      key: story.key,
      summary: story.summary,
      seconds: unloggedSeconds(story, now),
    }))
    .filter((s) => s.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
}

/**
 * What the clock is doing.
 *
 * The unfiled list is included even when nothing is running, because that is
 * exactly the state where it matters: time that has been measured and not sent
 * is invisible until somebody files it.
 */
export function describeTimer(state: TimerState, now: number): string {
  const lines: string[] = [];
  const key = state.activeKey;
  const active = key ? state.stories[key] : null;

  if (active && isRunning(active.segments)) {
    const open = active.segments[active.segments.length - 1];
    const totals = storyTotals(state, active.key, now);
    lines.push(`Running: ${active.key} — ${active.summary || '(no summary)'}`);
    lines.push(`Open chunk: ${dur((now - open.start) / 1000)}.`);
    lines.push(
      `Tracked here: ${dur(totals.tracked)} — ${dur(totals.filed)} filed, ` +
        `${dur(totals.unfiled)} not filed yet.`,
    );
  } else {
    lines.push('Nothing is running.');
  }

  const unfiled = unfiledStories(state, now).filter((s) => s.key !== active?.key);
  if (unfiled.length > 0) {
    lines.push('', 'Stopped time nobody has filed:');
    for (const story of unfiled) {
      lines.push(
        `  ${story.key} — ${dur(story.seconds)}${story.summary ? ` (${story.summary})` : ''}`,
      );
    }
    lines.push('', "Filing posts a worklog to JIRA at the chunk's exact length.");
  }
  return lines.join('\n');
}

/** One story in full: status, the three time quantities, and the breakdown. */
export function describeStory(
  key: string,
  issue: JiraIssue | null,
  state: TimerState,
  now: number,
): string {
  const story = state.stories[key] ?? null;
  if (!issue && !story) {
    return `Nothing known about ${key} — it isn't on the board or tracked here.`;
  }

  const summary = issue?.summary ?? story?.summary ?? '';
  const totals = storyTotals(state, key, now);
  const lines = [`${key} — ${summary || '(no summary)'}`];

  const facts: string[] = [];
  const status = issue?.status ?? story?.status;
  if (status) facts.push(`status ${status}`);
  const estimate = issue?.estimateSeconds ?? story?.estimateSeconds;
  if (estimate) facts.push(`estimate ${dur(estimate)}`);
  if (issue?.secondsSpent) facts.push(`JIRA has ${dur(issue.secondsSpent)} spent`);
  if (facts.length) lines.push(facts.join(' · '));

  lines.push(
    `Tracked here: ${dur(totals.tracked)} — ${dur(totals.filed)} filed, ` +
      `${dur(totals.unfiled)} not filed yet.`,
  );

  // The display breakdown, which includes filed chunks — so it is the only one
  // that adds up to the tracked total above it. "Running" is the open chunk and
  // no label covers it until it is stopped.
  for (const row of trackedByActivity(story, now, issue?.secondsSpent ?? null)) {
    const filed = row.untracked
      ? 'in JIRA already'
      : row.loggedSeconds > 0
        ? `${dur(row.loggedSeconds)} filed`
        : 'not filed';
    lines.push(`  ${row.activity}: ${dur(row.seconds)} (${filed})`);
  }
  return lines.join('\n');
}

/** The board as its three columns, with this app's tracked time folded in. */
export function describeBoard(issues: JiraIssue[], state: TimerState, now: number): string {
  if (issues.length === 0) return 'No stories on the board right now.';
  const lines: string[] = [];
  for (const stage of STAGE_ORDER) {
    const inStage = issues.filter((i) => i.stage === stage);
    if (inStage.length === 0) continue;
    lines.push(`${STAGE_LABELS[stage]}:`);
    for (const issue of inStage) {
      const totals = storyTotals(state, issue.key, now);
      const notes: string[] = [issue.status];
      if (totals.tracked > 0) notes.push(`tracked ${dur(totals.tracked)}`);
      if (totals.unfiled > 0) notes.push(`${dur(totals.unfiled)} unfiled`);
      if (state.activeKey === issue.key) notes.push('running');
      lines.push(`  ${issue.key} — ${issue.summary} [${notes.join(' · ')}]`);
    }
  }
  return lines.join('\n');
}
