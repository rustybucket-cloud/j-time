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

/**
 * The pull requests, and nothing else.
 *
 * `viewer.organizations` used to be in here, for the "org you can't read"
 * diagnostic. It cost a fine-grained token the entire fetch: GitHub denies that
 * field to one and answers the whole request with
 * "Resource not accessible by personal access token", so a section that could
 * have listed pull requests listed an error instead. A diagnostic must not be
 * able to sink the thing it is diagnosing — it lives in its own request now,
 * and only classic tokens ever send it.
 */
const QUERY = `
query($review: String!, $mine: String!, $limit: Int!) {
  viewer { login }
  review: search(query: $review, type: ISSUE, first: $limit) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
  mine: search(query: $mine, type: ISSUE, first: $limit) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

const ORGS_QUERY = `query { viewer { organizations(first: 100) { nodes { login } } } }`;

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

  interface GraphqlError {
    message?: string;
    path?: (string | number)[];
  }

  interface GraphqlBody {
    data?: Record<string, unknown> | null;
    errors?: GraphqlError[];
  }

  /**
   * Run a query and hand back whatever came with it.
   *
   * Errors are *not* thrown here, because GraphQL routinely answers with both:
   * HTTP 200, the fields it could resolve in `data`, and an `errors` entry for
   * each one it couldn't. Throwing on the first error threw away good pull
   * requests whenever any single field was denied. The caller decides whether
   * what arrived is enough.
   */
  async function graphql(query: string, variables: Record<string, unknown>): Promise<GraphqlBody> {
    const response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.token}`,
        'Content-Type': 'application/json',
        // GitHub rejects requests with no user agent outright.
        'User-Agent': 'j-time',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error('GitHub rejected this token — check it hasn’t expired or been revoked.');
    }
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return (await response.json()) as GraphqlBody;
  }

  /** "Resource not accessible…" is far more useful with the field it refused. */
  function describe(errors: GraphqlError[] | undefined): string {
    const first = errors?.[0];
    const message = first?.message ?? 'GitHub returned an error';
    const path = first?.path?.join('.');
    return path ? `${message} (${path})` : message;
  }

  /**
   * Org memberships according to REST, which unlike GraphQL still names the
   * ones this token isn't authorised for.
   *
   * Best-effort on purpose: this is a diagnostic, and a diagnostic that can
   * turn a perfectly good fetch into a failed one is worse than no diagnostic.
   *
   * It is also classic-token-only, by GitHub's design rather than by ours:
   * "requests using a fine-grained access token will receive a 200 Success
   * response with an empty list". That degrades the right way — an empty
   * membership list makes `unauthorizedOrgs` return nothing, so a fine-grained
   * token gets no org warnings rather than a warning about every org it holds.
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

  /**
   * Orgs this account can't read, or nothing at all.
   *
   * Ordered so a fine-grained token never reaches the GraphQL half: REST tells
   * us the memberships, and it answers a fine-grained token with an empty list
   * by design, so there is nothing to compare against and no second request to
   * make. Only a classic token gets as far as asking for `viewer.organizations`
   * — which is the field that denied one costs the whole fetch.
   */
  async function blocked(): Promise<string[]> {
    const all = await memberships();
    if (all.length === 0) return [];
    try {
      const body = await graphql(ORGS_QUERY, {});
      const nodes =
        ((body.data as { viewer?: { organizations?: { nodes?: ({ login?: string } | null)[] } } })
          ?.viewer?.organizations?.nodes ?? []);
      const visible = nodes.map((o) => o?.login ?? '').filter(Boolean);
      // No answer at all is not evidence that every org is blocked.
      if (visible.length === 0 && body.errors?.length) return [];
      return unauthorizedOrgs(all, visible);
    } catch {
      return [];
    }
  }

  return {
    async getPulls(): Promise<GithubResult> {
      // `archived:false` keeps read-only repositories out of a list of things you
      // are supposed to act on.
      const body = await graphql(QUERY, {
        review: 'is:open is:pr review-requested:@me archived:false',
        mine: 'is:open is:pr author:@me archived:false',
        limit,
      });
      const data = (body.data ?? {}) as unknown as {
        viewer?: { login?: string };
        review?: { nodes: (RawPull | null)[] };
        mine?: { nodes: (RawPull | null)[] };
      };

      // Only a failure when neither search resolved. One of them coming back
      // denied is a thinner list, not a broken section — and the field that was
      // refused is named, because "Resource not accessible by personal access
      // token" on its own tells you nothing about what to grant.
      if (!data.review && !data.mine) throw new Error(describe(body.errors));

      const login = data.viewer?.login ?? '';
      // A search for issues can return an issue, which the PR fragment leaves as
      // an empty object — hence the number check rather than a bare null check.
      const keep = (nodes: (RawPull | null)[]): RawPull[] =>
        nodes.filter((n): n is RawPull => Boolean(n && typeof n.number === 'number'));

      return {
        login,
        blockedOrgs: await blocked(),
        pulls: [
          ...keep(data.review?.nodes ?? []).map((n) => toPull(n, login, true)),
          ...keep(data.mine?.nodes ?? []).map((n) => toPull(n, login, false)),
        ],
      };
    },
  };
}
