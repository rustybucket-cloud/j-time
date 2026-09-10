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

/**
 * A pretend /pulls dashboard, for the browser-session account.
 *
 * Shaped like GitHub's: a row per pull request, the link carrying
 * /{owner}/{repo}/pull/{number}, a <relative-time datetime> for when, and the
 * "opened … by someone" line the author is read out of. Deliberately wrapped in
 * unrelated markup and padded with links that are *not* pull requests — the
 * extractor has to pick these out of a real page, so it should have to here.
 *
 * And, like GitHub's, the rows are **rendered in the browser** rather than
 * served in the HTML, after a delay. Reading the page the moment it loads is
 * therefore a race, which is the bug this mock exists to keep caught. It
 * paginates at two rows for the same reason.
 *
 * MOCK_GH_REQUIRE_LOGIN=1 makes it redirect to /login instead, which is the
 * expired-session path.
 */
const REQUIRE_LOGIN = process.env.MOCK_GH_REQUIRE_LOGIN === '1';

const PAGE_SIZE = 2;
const RENDER_DELAY_MS = 400;

const DASHBOARD = {
  'is:open is:pr author:@me archived:false': [
    { repo: 'org-work/api', number: 7, title: 'Paginate the exports endpoint', by: 'dana', ago: 45 },
    { repo: 'org-work/api', number: 9, title: 'Drop the v1 serialiser', by: 'dana', ago: 300, draft: true },
    // On page two, so a truncated read is visible as a missing row.
    { repo: 'org-work/tools', number: 3, title: 'Vendor the schema fixtures', by: 'dana', ago: 5000 },
  ],
  'is:open is:pr review-requested:@me archived:false': [
    { repo: 'org-work/web', number: 88, title: 'Cache the pedigree lookup', by: 'amir', ago: 2880 },
  ],
};

const row = (pr) => `
  <div id="issue_${pr.number}" class="js-issue-row Box-row">
    <div class="flex-auto">
      <a id="issue_${pr.number}_link" class="Link--primary markdown-title"
         href="/${pr.repo}/pull/${pr.number}">${pr.title}</a>
      ${pr.draft ? '<span class="State">Draft</span>' : ''}
      <div class="mt-1 text-small color-fg-muted">
        <span class="opened-by">#${pr.number} opened
          <relative-time datetime="${new Date(now - pr.ago * MINUTE).toISOString()}">then</relative-time>
          by <a class="Link--muted" href="/${pr.by}">${pr.by}</a>
        </span>
      </div>
    </div>
  </div>`;

const dashboardHtml = (query, page) => {
  const all = DASHBOARD[query] ?? [];
  const prs = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const more = all.length > page * PAGE_SIZE;
  const next = more
    ? `<a rel="next" href="/pulls?q=${encodeURIComponent(query)}&page=${page + 1}">Next</a>`
    : '';
  const body = prs.length === 0 ? '<p>No results matched your search.</p>' : prs.map(row).join('');

  // The rows arrive from a script, the way GitHub's do. The served HTML has no
  // pull request links in it at all — check by curling this page.
  return `<!doctype html><html><head><title>Pull requests</title></head><body>
    <header><a href="/notifications">Notifications</a><a href="/pulls">Pull requests</a></header>
    <div id="react-app" data-target="react-app"></div>
    <a href="/org-work/api/issues/3">An issue, which is not a pull request</a>
    <footer><a href="/about">About</a></footer>
    <script>
      setTimeout(function () {
        document.getElementById('react-app').innerHTML = ${JSON.stringify(
          `<div class="Box">${body}</div>${next}`,
        )};
      }, ${RENDER_DELAY_MS});
    </script>
  </body></html>`;
};

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/pulls') {
      const signedIn = /user_session=/.test(req.headers.cookie ?? '');
      if (REQUIRE_LOGIN && !signedIn) {
        console.log('pulls → /login (no session)');
        res.writeHead(302, { location: '/login' }).end();
        return;
      }
      const query = url.searchParams.get('q') ?? '';
      const page = Number(url.searchParams.get('page') ?? '1') || 1;
      console.log('pulls', JSON.stringify(query), 'page', page);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml(query, page));
      return;
    }

    if (url.pathname === '/login') {
      console.log('login');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // A real login sets these once SSO is done; here the button stands in.
        'set-cookie': ['user_session=mock; Path=/', 'dotcom_user=dana; Path=/'],
      });
      res.end('<!doctype html><title>Sign in</title><h1>Mock GitHub sign-in</h1>');
      return;
    }

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
