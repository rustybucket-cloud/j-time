/**
 * All GitHub HTTP.
 *
 * GraphQL rather than the REST search endpoint, for one reason: `reviewDecision`
 * and the check rollup don't exist on REST's issue search results, and the PR
 * section is mostly about exactly those two things. REST would mean one search
 * plus an N+1 of per-PR requests to colour the rows.
 *
 * `host` is the API root rather than a hard-coded github.com, so the same plugin
 * works against an Enterprise install where the API lives under the company's
 * own domain.
 */

import type { CheckState, PullRequest, ReviewDecision } from '@shared/prs';
import { unauthorizedOrgs } from '@shared/prs';
import type { GithubAccount } from '@shared/github';

const PR_FIELDS = `
  number
  title
  url
  isDraft
  updatedAt
  reviewDecision
  repository { nameWithOwner }
  author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

const QUERY = `
query($review: String!, $mine: String!, $limit: Int!) {
  viewer { login organizations(first: 100) { nodes { login } } }
  review: search(query: $review, type: ISSUE, first: $limit) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
  mine: search(query: $mine, type: ISSUE, first: $limit) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

interface RawPull {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  reviewDecision: string | null;
  repository: { nameWithOwner: string } | null;
  author: { login: string } | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

export interface GithubResult {
  login: string;
  pulls: PullRequest[];
  /** Orgs whose results were silently withheld. See `unauthorizedOrgs`. */
  blockedOrgs: string[];
}

export interface GithubClient {
  getPulls(): Promise<GithubResult>;
}

/** GraphQL enums are SCREAMING_CASE; everything downstream of here is not. */
function decision(raw: string | null): ReviewDecision {
  switch (raw) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
    default:
      return null;
  }
}

/**
 * A rollup of nothing is `null` — a PR with no CI at all, which is not the same
 * as one whose checks haven't finished. Only an outright failure is worth a chip,
 * so `ERROR` folds in with `FAILURE` and everything unfinished reads as pending.
 */
function checks(raw: string | null | undefined): CheckState {
  switch (raw) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return null;
  }
}

function toPull(raw: RawPull, login: string, reviewRequested: boolean): PullRequest {
  const repo = raw.repository?.nameWithOwner ?? '';
  const author = raw.author?.login ?? '';
  return {
    id: `${repo}#${raw.number}`,
    number: raw.number,
    repo,
    title: raw.title,
    url: raw.url,
    author,
    draft: raw.isDraft,
    updatedAt: Date.parse(raw.updatedAt) || 0,
    reviewDecision: decision(raw.reviewDecision),
    checks: checks(raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    reviewRequested,
    mine: author === login,
  };
}

/** One client per account: one token, one host, one owner's worth of work. */
export function createGithub(account: GithubAccount, limit: number): GithubClient {
  const base = (account.host || '').trim().replace(/\/$/, '');

  async function graphql(variables: Record<string, unknown>): Promise<Record<string, never>> {
    const response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.token}`,
        'Content-Type': 'application/json',
        // GitHub rejects requests with no user agent outright.
        'User-Agent': 'j-time',
      },
      body: JSON.stringify({ query: QUERY, variables }),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error('GitHub rejected this token. Check it has `repo` and `read:org` scope.');
    }
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

    const body = await response.json();
    // A GraphQL error arrives with HTTP 200 and a body full of `errors`, so the
    // status check above is not enough on its own.
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new Error(String(body.errors[0]?.message ?? 'GitHub returned an error'));
    }
    return body.data;
  }

  /**
   * Org memberships according to REST, which unlike GraphQL still names the
   * ones this token isn't authorised for.
   *
   * Best-effort on purpose: this is a diagnostic, and a diagnostic that can
   * turn a perfectly good fetch into a failed one is worse than no diagnostic.
   */
  async function memberships(): Promise<string[]> {
    try {
      const response = await fetch(`${base}/user/orgs?per_page=100`, {
        headers: {
          Authorization: `Bearer ${account.token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'j-time',
        },
      });
      if (!response.ok) return [];
      const body = await response.json();
      return Array.isArray(body)
        ? body.map((o: { login?: string }) => o.login ?? '').filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }

  return {
    async getPulls(): Promise<GithubResult> {
      // `archived:false` keeps read-only repositories out of a list of things you
      // are supposed to act on.
      const data = (await graphql({
        review: 'is:open is:pr review-requested:@me archived:false',
        mine: 'is:open is:pr author:@me archived:false',
        limit,
      })) as unknown as {
        viewer: { login: string; organizations: { nodes: ({ login: string } | null)[] } };
        review: { nodes: (RawPull | null)[] };
        mine: { nodes: (RawPull | null)[] };
      };

      const login = data.viewer?.login ?? '';
      const visible = (data.viewer?.organizations?.nodes ?? [])
        .map((o) => o?.login ?? '')
        .filter(Boolean);
      // A search for issues can return an issue, which the PR fragment leaves as
      // an empty object — hence the number check rather than a bare null check.
      const keep = (nodes: (RawPull | null)[]): RawPull[] =>
        nodes.filter((n): n is RawPull => Boolean(n && typeof n.number === 'number'));

      return {
        login,
        blockedOrgs: unauthorizedOrgs(await memberships(), visible),
        pulls: [
          ...keep(data.review?.nodes ?? []).map((n) => toPull(n, login, true)),
          ...keep(data.mine?.nodes ?? []).map((n) => toPull(n, login, false)),
        ],
      };
    },
  };
}
