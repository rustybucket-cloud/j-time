/**
 * Pull requests, as the palette shows them.
 *
 * Pure: the ordering here is the whole product of the PR section, and it is the
 * same kind of thing as the board's stage order — easy to get subtly wrong and
 * impossible to eyeball. The renderer draws what these functions return.
 */

import type { Badge, Glyph } from './plugin';

export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null;
export type CheckState = 'success' | 'failure' | 'pending' | null;

export interface PullRequest {
  /** `owner/repo#123` — stable across refreshes and unique across hosts we ask. */
  id: string;
  number: number;
  repo: string;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  updatedAt: number;
  reviewDecision: ReviewDecision;
  checks: CheckState;
  /** Your review was asked for. The reason this section is worth having. */
  reviewRequested: boolean;
  /** You opened it. */
  mine: boolean;
}

export const NEEDS_REVIEW = 'Needs your review';
export const MINE = 'Your pull requests';

export interface PrItem {
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
  subsection: string;
  lead: Glyph;
  badges: Badge[];
  pr: PullRequest;
}

/**
 * Which PRs are waiting on you, and which are waiting on someone else.
 *
 * Review requests lead, oldest first: the question this section answers is "what
 * is blocked on me", and the one that has been blocked longest is the one to
 * unblock. Your own PRs follow, most recently touched first, because that list is
 * a status readout rather than a queue — you want the one you just pushed to.
 *
 * A PR you opened *and* were asked to review shows once, under review: acting on
 * it is what would clear it, and a row appearing twice in one section reads as a
 * bug rather than as emphasis.
 */
export function groupPulls(pulls: PullRequest[], now: number): PrItem[] {
  const seen = new Set<string>();
  const unique = pulls.filter((pr) => !seen.has(pr.id) && seen.add(pr.id));

  const review = unique
    .filter((pr) => pr.reviewRequested)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  const mine = unique
    .filter((pr) => !pr.reviewRequested && pr.mine)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return [
    ...review.map((pr) => item(pr, NEEDS_REVIEW, now)),
    ...mine.map((pr) => item(pr, MINE, now)),
  ];
}

function item(pr: PullRequest, subsection: string, now: number): PrItem {
  return {
    id: `pr:${pr.id}`,
    title: `${pr.repo}#${pr.number}`,
    subtitle: pr.title,
    keywords: [pr.repo, pr.author, String(pr.number)],
    subsection,
    lead: prGlyph(pr),
    badges: prBadges(pr, now),
    pr,
  };
}

/**
 * The leading mark, by meaning.
 *
 * Semantic rather than decorative so a PR waiting on you and an unfiled chunk of
 * time look the same without either plugin having chosen a colour. Draft is muted
 * even when a review is requested on it — a draft is explicitly not ready, and
 * lighting it up would train you to ignore the colour that matters.
 */
export function prGlyph(pr: PullRequest): Glyph {
  if (pr.draft) return 'muted';
  if (pr.reviewRequested) return 'attention';
  if (pr.reviewDecision === 'changes_requested') return 'blocked';
  if (pr.reviewDecision === 'approved') return 'ok';
  return 'dot';
}

export function prBadges(pr: PullRequest, now: number): Badge[] {
  const badges: Badge[] = [];
  if (pr.draft) badges.push({ text: 'Draft' });
  if (pr.reviewDecision === 'approved') badges.push({ text: 'Approved', tone: 'accent' });
  if (pr.reviewDecision === 'changes_requested') {
    badges.push({ text: 'Changes requested', tone: 'warn' });
  }
  // Only failures earn a chip. A green tick on every row is noise, and green is
  // the connection dot's colour rather than a UI colour in this app.
  if (pr.checks === 'failure') badges.push({ text: 'Checks failing', tone: 'danger' });
  badges.push({ text: formatAge(now - pr.updatedAt), kind: 'clock' });
  return badges;
}

/**
 * The single PR the shell may lift above every section: the one that has been
 * waiting on your review longest.
 *
 * Drafts are never it. Nothing is, when nothing is waiting on you — an empty
 * pinned section is worse than none, and a plugin that always pins something
 * teaches you to stop reading the top of the list.
 */
export function pinnedPull(items: PrItem[]): PrItem | null {
  return items.find((i) => i.subsection === NEEDS_REVIEW && !i.pr.draft) ?? null;
}

/** A coarse "how long ago", to one unit. Precision past that is not information. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
