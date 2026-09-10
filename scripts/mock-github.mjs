/**
 * A pretend GitHub, so the PR section can be exercised without a token.
 *
 * Implements two endpoints. POST /graphql answers the single query the plugin
 * sends, by its aliases (`viewer`, `review`, `mine`). GET /user/orgs answers the
 * membership probe — and names one org that `viewer.organizations` does not, so
 * the SSO-withheld case has something to render. Everything is in memory and
 * fixed; restart it and you're back to the same pull requests.
 *
 * Run via scripts/sandbox.sh, which points the plugin's `host` here.
 *
 *   node scripts/mock-github.mjs [port]
 */

import { createServer } from 'http';

const PORT = Number(process.argv[2] || 4198);
const ME = 'dana';
const MINUTE = 60_000;

const now = Date.now();

/**
 * A spread that exercises every glyph and badge the section can draw: one review
 * that has waited two days (the one the shell should pin), a draft that must
 * *not* be pinned despite also awaiting review, a PR with failing checks, and an
 * approved one.
 */
const REVIEW = [
  pull(41, 'org/checkout', 'Extract the pricing table cache', 'amir', {
    updatedAt: now - 2 * 24 * 60 * MINUTE,
  }),
  pull(38, 'org/platform', 'Retry webhook delivery on 5xx', 'lin', {
    updatedAt: now - 90 * MINUTE,
    checks: 'FAILURE',
  }),
  pull(52, 'org/checkout', 'Spike: replace the form library', 'amir', {
    updatedAt: now - 20 * MINUTE,
    isDraft: true,
  }),
];

const MINE = [
  pull(44, 'org/checkout', 'Validate expiry before submit', ME, {
    updatedAt: now - 12 * MINUTE,
    reviewDecision: 'APPROVED',
  }),
  pull(45, 'org/platform', 'Drop the legacy search endpoint', ME, {
    updatedAt: now - 5 * 60 * MINUTE,
    reviewDecision: 'CHANGES_REQUESTED',
  }),
  pull(46, 'org/checkout', 'Bump electron to 38.8.6', ME, {
    updatedAt: now - 3 * 24 * 60 * MINUTE,
    isDraft: true,
  }),
];

function pull(number, repo, title, login, over = {}) {
  const { checks = null, ...rest } = over;
  return {
    number,
    title,
    url: `https://github.test/${repo}/pull/${number}`,
    isDraft: false,
    updatedAt: new Date(now).toISOString(),
    reviewDecision: null,
    repository: { nameWithOwner: repo },
    author: { login },
    commits: { nodes: [{ commit: { statusCheckRollup: checks ? { state: checks } : null } }] },
    ...rest,
    // `updatedAt` arrives as a number in the fixtures above; GitHub sends ISO.
    ...(rest.updatedAt ? { updatedAt: new Date(rest.updatedAt).toISOString() } : {}),
  };
}

/**
 * `org-locked` is a membership REST admits to and GraphQL doesn't — which is
 * exactly what an org enforcing SAML SSO looks like to an unauthorised token,
 * and the only signal there is that a whole org's pull requests are missing.
 */
const VISIBLE_ORGS = ['org'];
const ALL_ORGS = ['org', 'org-locked'];

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * A second token, standing in for a work org's *fine-grained* one.
 *
 * It behaves the way GitHub says one does: /user/orgs answers 200 with an empty
 * list, and `viewer.organizations` is refused outright with "Resource not
 * accessible by personal access token". That refusal used to fail the whole
 * fetch, so this is the case worth keeping — the pull requests must still
 * arrive.
 */
const WORK_TOKEN = 'sandbox-work-token';
const WORK = [
  pull(7, 'org-work/api', 'Paginate the exports endpoint', ME, {
    updatedAt: now - 45 * MINUTE,
  }),
];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (!/^Bearer .+/.test(req.headers.authorization ?? '')) {
      json(res, 401, { message: 'Bad credentials' });
      return;
    }
    const work = (req.headers.authorization ?? '').endsWith(WORK_TOKEN);
    if (req.method === 'GET' && req.url.startsWith('/user/orgs')) {
      console.log('user/orgs', work ? '(fine-grained → empty)' : '');
      // Fine-grained tokens get an empty list, whatever they were granted.
      json(res, 200, work ? [] : ALL_ORGS.map((login) => ({ login })));
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/graphql')) {
      res.writeHead(404).end('not found');
      return;
    }
    const query = JSON.parse(body).query ?? '';
    if (work && query.includes('organizations')) {
      console.log('graphql (work) organizations → refused');
      json(res, 200, {
        data: { viewer: null },
        errors: [
          {
            message: 'Resource not accessible by personal access token',
            path: ['viewer', 'organizations'],
          },
        ],
      });
      return;
    }
    console.log('graphql', work ? '(work)' : '', JSON.parse(body).variables?.limit ?? '');
    const visible = VISIBLE_ORGS;
    json(res, 200, {
      data: {
        viewer: { login: ME, organizations: { nodes: visible.map((login) => ({ login })) } },
        review: { nodes: work ? [] : REVIEW },
        mine: { nodes: work ? WORK : MINE },
      },
    });
  });
});

server.listen(PORT, () => console.log(`mock github on http://localhost:${PORT}`));
