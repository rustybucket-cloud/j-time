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
  /** Which configured account this came back from. */
  account?: string;
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

/**
 * Orgs the token belongs to but cannot actually read.
 *
 * The only way to know. An org that enforces SAML SSO and hasn't authorised this
 * token is not an error and not a 403: GraphQL search simply returns fewer
 * results, with HTTP 200 and no header saying so. REST's membership list still
 * names it, though, and GraphQL's `viewer.organizations` doesn't — so the
 * difference between the two lists is exactly the set of orgs whose pull
 * requests are being silently withheld.
 *
 * Getting this wrong in the quiet direction is what makes it worth detecting: a
 * whole org's work vanishes and the section just says "Nothing open".
 *
 * It stays a *difference of two lists* rather than a confirmed diagnosis, and
 * the wording it produces says only what was observed. Confirming SSO
 * specifically would need a probe, and there isn't one: `/orgs/<org>/repos`,
 * `/orgs/<org>/members`, `/orgs/<org>/teams` and `/user/memberships/orgs/<org>`
 * all answer 200 for a blocked org. Only fetching one of its *private* repos
 * returns the 403 with `X-GitHub-SSO`, and a token that can't see them can't
 * name one to ask about. A fine-grained token, which is scoped to a single
 * owner, can also land here for reasons that aren't SSO at all — so the row
 * this feeds reports the symptom and offers the usual fix, rather than
 * announcing a cause.
 */
export function unauthorizedOrgs(memberships: string[], visible: string[]): string[] {
  const seen = new Set(visible.map((o) => o.toLowerCase()));
  return memberships.filter((org) => !seen.has(org.toLowerCase()));
}

/**
 * Where to go to authorise a token for an org.
 *
 * Built from the *web* host, which the API host is not: github.com's API lives
 * on `api.github.com`, while an Enterprise install puts it under `/api` on the
 * company's own domain. Both fold back to the same origin the browser wants.
 */
export function ssoAuthorizeUrl(apiHost: string, org: string): string {
  const trimmed = apiHost.trim().replace(/\/+$/, '');
  let web: string;
  try {
    const url = new URL(trimmed);
    url.hostname = url.hostname.replace(/^api\./, '');
    url.pathname = url.pathname.replace(/\/api$/, '');
    web = url.origin + (url.pathname === '/' ? '' : url.pathname);
  } catch {
    web = 'https://github.com';
  }
  return `${web}/orgs/${encodeURIComponent(org)}/sso`;
}

/**
 * The dashboard pages a browser account reads.
 *
 * The same two questions the API asks, asked of GitHub's own UI: what you have
 * open, and what is waiting on you. Deliberately the `q=` form rather than the
 * `/pulls/review-requested` shortcut, so both lists are built the same way and
 * the filters stay visible here rather than being implied by a path.
 */
export const PULLS_QUERIES = {
  mine: 'is:open is:pr author:@me archived:false',
  review: 'is:open is:pr review-requested:@me archived:false',
} as const;

export function pullsUrl(webHost: string, query: string): string {
  const base = webHost.trim().replace(/\/+$/, '') || 'https://github.com';
  return `${base}/pulls?q=${encodeURIComponent(query)}`;
}

/**
 * Pull `owner/repo` and a number out of a pull request link.
 *
 * Keying on the URL shape rather than on class names is the whole trick to
 * scraping this page without it breaking every time GitHub restyles: the markup
 * around a pull request changes, `/{owner}/{repo}/pull/{number}` does not.
 * Returns null for the many other links on the page.
 */
export function parsePullUrl(href: string): { repo: string; number: number } | null {
  const match = /^(?:https?:\/\/[^/]+)?\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(
    href.trim(),
  );
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { repo: `${match[1]}/${match[2]}`, number };
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
