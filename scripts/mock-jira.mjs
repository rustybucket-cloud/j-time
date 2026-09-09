/**
 * A pretend JIRA, so the timer can be exercised without touching a real board.
 *
 * Implements only the endpoints lib/jira.ts actually calls, and holds everything in
 * memory: worklogs accumulate into timespent, transitions change status. Restart it
 * and you're back to the starting fixtures.
 *
 * Run via scripts/sandbox.sh, which points the app's baseUrl here and sets JT_HOME to
 * a scratch directory, so neither a real board nor the real ~/.j-time is ever touched.
 *
 *   node scripts/mock-jira.mjs [port]
 */

import { createServer } from 'http';

const PORT = Number(process.argv[2] || 4199);
const ME = { displayName: 'Dana Ruiz', emailAddress: 'dana@example.test' };

/** The three status categories, keyed the way JIRA keys them. */
const NEW = { key: 'new', name: 'To Do' };
const DOING = { key: 'indeterminate', name: 'In Progress' };
const DONE = { key: 'done', name: 'Done' };

const BOARD = { id: 77, name: 'Checkout Revamp', type: 'scrum' };
const SPRINT = { id: 501, name: 'Revamp Sprint 3', state: 'active' };
const PROJECT = { key: 'SAND', name: 'Sandbox' };

/**
 * Statuses a story can move between. `Cancelled` is deliberately here and
 * deliberately in the done category — it's what makes the Done dialog's
 * "don't preselect abandonment" rule testable.
 */
const STATUSES = {
  'To Do': { id: '11', category: NEW },
  'In Progress': { id: '21', category: DOING },
  'In Review': { id: '41', category: DOING },
  Done: { id: '31', category: DONE },
  Cancelled: { id: '101', category: DONE },
};

const H = 3600;
const issues = [
  mk('SAND-101', 'Add an empty state to the saved-reports list', 'To Do', 2 * H, 0, ME.displayName,
    'First-time users land on a bare table header. Needs a line of copy and a create button.'),
  mk('SAND-102', 'Rework the checkout form validation', 'In Progress', 6 * H, 45 * 60, ME.displayName,
    'Inline errors should appear as soon as a field loses focus, not on submit. Card number and expiry need their own messages.'),
  mk('SAND-103', 'Cache the pricing table lookup', 'In Progress', 3 * H, 0, ME.displayName,
    'The pricing table is re-fetched on every render of the plan picker.'),
  mk('SAND-104', 'Tighten the mobile nav breakpoints', 'Done', 2 * H, 1 * H, ME.displayName, null),
  mk('SAND-105', 'Retire the legacy banner component', 'To Do', 1 * H, 0, 'Sam Okafor',
    'Nothing has imported it since the redesign. Assigned to someone else, so it only shows under "Everyone".'),
];

function mk(key, summary, status, estimate, spent, assignee, description) {
  // `baseSpent` stands in for worklogs made before the timer existed. The issue's
  // total is always that plus whatever we've posted since — see spentOf().
  return { key, summary, status, estimate, baseSpent: spent, assignee, description, worklogs: [] };
}

/** What JIRA would report as time spent: pre-existing time plus every worklog. */
const spentOf = (i) => i.baseSpent + i.worklogs.reduce((n, w) => n + w.seconds, 0);

const find = (key) => issues.find((i) => i.key.toLowerCase() === String(key).toLowerCase());

/** The shape lib/jira.ts's mapIssue expects. */
function serialize(i) {
  const st = STATUSES[i.status];
  const spent = spentOf(i);
  return {
    key: i.key,
    fields: {
      summary: i.summary,
      status: { name: i.status, statusCategory: st.category },
      assignee: i.assignee ? { displayName: i.assignee } : null,
      issuetype: { name: 'Story' },
      priority: { name: 'Medium' },
      project: PROJECT,
      timeoriginalestimate: i.estimate || null,
      timetracking: {
        originalEstimateSeconds: i.estimate || null,
        timeSpentSeconds: spent || null,
      },
      timespent: spent || null,
      // No subtasks in the fixtures, so this matches timespent — the app prefers it.
      aggregatetimespent: spent || null,
      description: i.description,
    },
  };
}

/**
 * Enough JQL understanding for what the app sends: the status-category split, and
 * the assignee filter behind the "Assigned to me" / "Everyone" toggle.
 */
function matchesJql(issue, jql = '') {
  const q = jql.toLowerCase();
  const category = STATUSES[issue.status].category.key;
  if (q.includes('statuscategory != done') && category === 'done') return false;
  if (q.includes('statuscategory = done') && category !== 'done') return false;
  if (q.includes('assignee = currentuser()') && issue.assignee !== ME.displayName) return false;
  return true;
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const q = url.searchParams;
  const log = (what) => console.log(`  ${req.method} ${path}${url.search ? '?…' : ''} → ${what}`);

  // Who am I. Any credentials are accepted; there's nothing to protect.
  if (path === '/rest/api/2/myself') {
    log(ME.displayName);
    return json(res, ME);
  }

  // Board list, board search by name, and boards for a project all land here.
  if (path === '/rest/agile/1.0/board') {
    const name = q.get('name');
    const values = name && !BOARD.name.toLowerCase().includes(name.toLowerCase()) ? [] : [BOARD];
    log(`${values.length} board(s)`);
    return json(res, { values, maxResults: 50, startAt: 0, isLast: true });
  }

  // Which projects I have work in. The app asks with fields=project.
  if (path === '/rest/api/3/search/jql') {
    const mine = issues.filter((i) => matchesJql(i, q.get('jql') ?? ''));
    log(`${mine.length} issue(s) for project discovery`);
    return json(res, { issues: mine.map(serialize), isLast: true });
  }

  const sprintList = path.match(/^\/rest\/agile\/1\.0\/board\/(\d+)\/sprint$/);
  if (sprintList) {
    // MOCK_NO_SPRINT=1 simulates the gap between one iteration closing and the next
    // starting, which is otherwise awkward to reach.
    if (process.env.MOCK_NO_SPRINT) {
      log('no active sprint (MOCK_NO_SPRINT)');
      return json(res, { values: [], isLast: true });
    }
    log(SPRINT.name);
    return json(res, { values: [SPRINT], isLast: true });
  }

  // The sprint's issues, split by the JQL the app passes.
  const sprintIssues = path.match(/^\/rest\/agile\/1\.0\/board\/(\d+)\/sprint\/(\d+)\/issue$/);
  const boardIssues = path.match(/^\/rest\/agile\/1\.0\/board\/(\d+)\/issue$/);
  if (sprintIssues || boardIssues) {
    const jql = q.get('jql') ?? '';
    const matched = issues.filter((i) => matchesJql(i, jql));
    log(`${matched.length} issue(s)`);
    return json(res, { issues: matched.map(serialize), maxResults: 100, startAt: 0, total: matched.length });
  }

  const transitions = path.match(/^\/rest\/api\/2\/issue\/([^/]+)\/transitions$/);
  if (transitions) {
    const issue = find(decodeURIComponent(transitions[1]));
    if (!issue) return json(res, { errorMessages: ['No such issue'] }, 404);

    if (req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body?.transition?.id ?? '');
      const target = Object.entries(STATUSES).find(([, s]) => s.id === id);
      if (!target) return json(res, { errorMessages: [`No transition ${id}`] }, 400);
      issue.status = target[0];
      log(`${issue.key} → ${issue.status}`);
      res.writeHead(204).end();
      return;
    }

    // Everything except the status it's already in.
    const available = Object.entries(STATUSES)
      .filter(([name]) => name !== issue.status)
      .map(([name, s]) => ({ id: s.id, name, to: { name, statusCategory: s.category } }));
    log(`${available.length} transition(s) from ${issue.status}`);
    return json(res, { transitions: available });
  }

  // One issue by key. The MCP endpoint asks for this when a caller names a story the
  // board queries never fetched. Matched after /transitions and before the 404, so the
  // sub-paths above keep their own handlers.
  const oneIssue = path.match(/^\/rest\/api\/2\/issue\/([^/]+)$/);
  if (oneIssue && req.method === 'GET') {
    const issue = find(decodeURIComponent(oneIssue[1]));
    if (!issue) return json(res, { errorMessages: ['Issue does not exist'] }, 404);
    log(`${issue.key} [${issue.status}]`);
    return json(res, serialize(issue));
  }

  const worklog = path.match(/^\/rest\/api\/2\/issue\/([^/]+)\/worklog$/);
  if (worklog && req.method === 'POST') {
    const issue = find(decodeURIComponent(worklog[1]));
    if (!issue) return json(res, { errorMessages: ['No such issue'] }, 404);
    const body = await readBody(req);
    const seconds = Number(body?.timeSpentSeconds ?? 0);
    if (!(seconds > 0)) return json(res, { errorMessages: ['timeSpentSeconds must be positive'] }, 400);
    const id = String(100000 + issue.worklogs.length + 1);
    issue.worklogs.push({ id, seconds, comment: body?.comment ?? '', started: body?.started });
    log(
      `${issue.key} +${Math.round(seconds / 60)}m "${body?.comment ?? ''}" ` +
        `(total ${Math.round(spentOf(issue) / 60)}m)`,
    );
    return json(res, { id, timeSpentSeconds: seconds });
  }

  log('404');
  return json(res, { errorMessages: [`Mock JIRA has no route for ${path}`] }, 404);
});

server.listen(PORT, () => {
  console.log(`Mock JIRA on http://localhost:${PORT}`);
  console.log(`  board  ${BOARD.name} (${BOARD.id}) · sprint ${SPRINT.name}`);
  console.log(`  issues ${issues.map((i) => `${i.key} [${i.status}]`).join(', ')}`);
  console.log(`  user   ${ME.displayName} — any token is accepted`);
  console.log('');
});
