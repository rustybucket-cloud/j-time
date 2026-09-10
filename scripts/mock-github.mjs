/**
 * A pretend GitHub, so the PR section can be exercised without a token.
 *
 * Implements one endpoint — POST /graphql — and answers the single query the
 * plugin sends, by its aliases (`viewer`, `review`, `mine`). Everything is in
 * memory and fixed; restart it and you're back to the same pull requests.
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

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.startsWith('/graphql')) {
      res.writeHead(404).end('not found');
      return;
    }
    if (!/^Bearer .+/.test(req.headers.authorization ?? '')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
      return;
    }
    console.log('graphql', JSON.parse(body).variables?.limit ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: { viewer: { login: ME }, review: { nodes: REVIEW }, mine: { nodes: MINE } },
      }),
    );
  });
});

server.listen(PORT, () => console.log(`mock github on http://localhost:${PORT}`));
