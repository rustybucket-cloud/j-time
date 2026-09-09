/**
 * All JIRA HTTP, ported from jira-timer's lib/jira.ts.
 *
 * The one structural change: credentials arrive as a config object rather than
 * being read from `process.env` at call time. A packaged .app is launched by
 * Finder with none of your shell's environment, so env vars aren't a thing the
 * user could set even if we wanted them.
 *
 * Every JIRA quirk the original documents still applies and is preserved here —
 * `/rest/api/2/search` being 410 Gone, Kanban boards 400ing on the sprint
 * endpoint, `aggregatetimespent` rolling up subtasks, and there being no
 * user-to-board endpoint at all.
 */

import type { JiraBoard, JiraIssue, JiraSprint, JiraTransition } from '@shared/types';
import { missingCreds, reasonForStatus, type JiraConfig, type MyselfResult } from '@shared/conn';
import { stageFor } from '@shared/stages';

const ISSUE_FIELDS =
  'summary,status,assignee,issuetype,priority,timeoriginalestimate,timetracking,' +
  'timespent,aggregatetimespent,description';

export interface JiraClient {
  getMyself(): Promise<MyselfResult>;
  getMyBoards(): Promise<JiraBoard[]>;
  searchBoards(name: string): Promise<JiraBoard[]>;
  getActiveSprint(boardId: number): Promise<JiraSprint | null>;
  getBoardIssues(
    boardId: number,
    mineOnly: boolean,
  ): Promise<{ issues: JiraIssue[]; doneIssues: JiraIssue[]; sprint: JiraSprint | null }>;
  getAllMyBoardIssues(
    mineOnly: boolean,
  ): Promise<{ issues: JiraIssue[]; doneIssues: JiraIssue[]; boards: JiraBoard[] }>;
  getTransitions(key: string): Promise<JiraTransition[]>;
  addWorklog(
    key: string,
    timeSpentSeconds: number,
    comment: string,
    startedMs: number,
  ): Promise<{ id: string }>;
  doTransition(key: string, transitionId: string): Promise<void>;
  issueUrl(key: string): string;
}

export function createJira(config: JiraConfig): JiraClient {
  const base = (config.baseUrl || '').trim().replace(/\/$/, '');

  function authHeader(): string {
    const email = config.email?.trim();
    const token = config.apiToken?.trim();
    if (!email || !token) throw new Error('JIRA credentials are not set — open Settings.');
    return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  }

  async function jira(pathname: string, init?: RequestInit): Promise<Response> {
    if (!base) throw new Error('JIRA URL is not set (e.g. https://your-org.atlassian.net).');
    return fetch(`${base}${pathname}`, {
      ...init,
      headers: {
        Authorization: authHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
      cache: 'no-store',
    });
  }

  async function bodyText(res: Response): Promise<string> {
    try {
      return (await res.text()).slice(0, 400);
    } catch {
      return '';
    }
  }

  const byName = (a: JiraBoard, b: JiraBoard) => a.name.localeCompare(b.name);
  const toBoard = (b: any): JiraBoard => ({ id: b.id, name: b.name, type: b.type });

  async function getMyself(): Promise<MyselfResult> {
    const missing = missingCreds(config);
    // baseUrl is echoed back so the setup view can show what's already known.
    // Suppressed while it's one of the missing fields, so we never hand back a placeholder.
    const baseUrl = missing.includes('baseUrl') ? null : base || null;
    const common = { missing, baseUrl };

    if (missing.length) {
      return {
        ok: false,
        status: 0,
        reason: 'unconfigured',
        ...common,
        error: `Not configured: ${missing.join(', ')}`,
      };
    }
    try {
      const res = await jira('/rest/api/2/myself');
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          reason: reasonForStatus(res.status),
          ...common,
          error: await bodyText(res),
        };
      }
      const d = await res.json();
      return {
        ok: true,
        status: 200,
        reason: 'ok',
        ...common,
        name: d.displayName,
        email: d.emailAddress,
      };
    } catch (e: unknown) {
      // A thrown fetch means DNS failure, refused connection, or offline.
      return {
        ok: false,
        status: 0,
        reason: 'unreachable',
        ...common,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Flatten Atlassian Document Format (ADF) — or a plain string — to readable text. */
  function adfToText(node: any): string {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'mention') return node.attrs?.text ?? '';
    if (node.type === 'emoji') return node.attrs?.shortName ?? '';
    const children = Array.isArray(node.content) ? node.content.map(adfToText).join('') : '';
    const block = ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'rule'];
    if (block.includes(node.type)) return children + '\n';
    return children;
  }

  /** Strip the most common JIRA wiki-markup markers so plain-text descriptions read cleanly. */
  function wikiToText(s: string): string {
    return s
      .replace(/\r\n/g, '\n')
      .replace(/^h[1-6]\.\s*/gm, '')
      .replace(/^\s*bq\.\s*/gm, '')
      .replace(/\{code(:[^}]*)?\}/g, '')
      .replace(/\{\{([^}]*)\}\}/g, '$1')
      .replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1')
      .replace(/\[([^\]]+)\]/g, '$1')
      .replace(/^\s*[*#-]\s+/gm, '• ')
      .replace(/(^|[^\w])[*_]([^*_\n]+)[*_]/g, '$1$2')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function descriptionToText(desc: unknown): string | null {
    if (!desc) return null;
    if (typeof desc === 'string') return wikiToText(desc) || null;
    return adfToText(desc).replace(/\n{3,}/g, '\n\n').trim() || null;
  }

  function mapIssue(i: any): JiraIssue {
    const f = i.fields ?? {};
    return {
      key: i.key,
      summary: f.summary ?? '',
      status: f.status?.name ?? '?',
      // The board column, which a renamed status can't disturb. Nested inside the
      // `status` field already being requested, so it costs nothing to read.
      stage: stageFor(f.status?.statusCategory?.key),
      assignee: f.assignee?.displayName ?? null,
      issuetype: f.issuetype?.name ?? '?',
      priority: f.priority?.name ?? null,
      estimateSeconds: f.timeoriginalestimate ?? f.timetracking?.originalEstimateSeconds ?? null,
      // JIRA's own total, including worklogs made before this app existed or
      // outside it. `aggregatetimespent` rolls up subtasks; `timespent` doesn't,
      // so a parent whose work happens in its subtasks would read as zero.
      secondsSpent:
        f.aggregatetimespent ?? f.timespent ?? f.timetracking?.timeSpentSeconds ?? null,
      description: descriptionToText(f.description),
    };
  }

  /** Boards matching a name fragment, filtered by JIRA rather than by us. */
  async function searchBoards(name: string): Promise<JiraBoard[]> {
    const params = new URLSearchParams({ maxResults: '50', name });
    const res = await jira(`/rest/agile/1.0/board?${params.toString()}`);
    if (!res.ok) throw new Error(`Board search failed: ${res.status} ${await bodyText(res)}`);
    const data = await res.json();
    return (data.values ?? []).map(toBoard).sort(byName);
  }

  /**
   * Projects the user has issues assigned in, any resolution — so someone who has
   * finished everything still gets their boards.
   *
   * `/rest/api/2/search` is 410 Gone on current JIRA Cloud. The replacement is
   * token-paginated and reports no `total`, so don't reach for one.
   */
  async function myProjectKeys(): Promise<string[]> {
    const keys = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({
        maxResults: '100',
        fields: 'project',
        jql: 'assignee = currentUser() ORDER BY updated DESC',
      });
      if (token) params.set('nextPageToken', token);
      const res = await jira(`/rest/api/3/search/jql?${params.toString()}`);
      if (!res.ok) throw new Error(`Find my projects failed: ${res.status} ${await bodyText(res)}`);
      const data = await res.json();
      for (const issue of data.issues ?? []) {
        const key = issue.fields?.project?.key;
        if (key) keys.add(key);
      }
      token = data.nextPageToken;
      if (!token || data.isLast) break;
    }
    return [...keys];
  }

  /**
   * Boards belonging to the projects the user has work in. JIRA has no user→board
   * endpoint, so the project is the bridge: find my issues, take their projects,
   * ask for each project's boards. This can include sibling boards holding none of
   * my work — accepted, since it's a handful instead of hundreds.
   */
  async function getMyBoards(): Promise<JiraBoard[]> {
    const projects = await myProjectKeys();
    if (projects.length === 0) return [];

    const perProject = await Promise.all(
      projects.map(async (key) => {
        const params = new URLSearchParams({ maxResults: '50', projectKeyOrId: key });
        const res = await jira(`/rest/agile/1.0/board?${params.toString()}`);
        // A project can be board-less, or hidden from us; skip rather than fail the lot.
        if (!res.ok) return [] as JiraBoard[];
        const data = await res.json();
        return (data.values ?? []).map(toBoard);
      }),
    );
    const byId = new Map<number, JiraBoard>();
    for (const list of perProject) for (const b of list) byId.set(b.id, b);
    return [...byId.values()].sort(byName);
  }

  /** The board's active sprint, or null for Kanban / no active sprint. */
  async function getActiveSprint(boardId: number): Promise<JiraSprint | null> {
    const res = await jira(`/rest/agile/1.0/board/${boardId}/sprint?state=active`);
    if (!res.ok) return null; // Kanban boards 400 here — treated as "no sprint".
    const data = await res.json();
    const s = (data.values ?? [])[0];
    return s ? { id: s.id, name: s.name } : null;
  }

  async function fetchIssues(path: string, clauses: string[], order: string): Promise<JiraIssue[]> {
    const jql = `${clauses.join(' AND ')} ORDER BY ${order}`;
    const params = new URLSearchParams({ maxResults: '100', fields: ISSUE_FIELDS, jql });
    const res = await jira(`${path}?${params.toString()}`);
    if (!res.ok) throw new Error(`Board issues failed: ${res.status} ${await bodyText(res)}`);
    const data = await res.json();
    return (data.issues ?? []).map(mapIssue);
  }

  /**
   * The board's current iteration, split into the Done column and everything
   * before it. The split is on `statusCategory`, not `resolution`: a story parked
   * in Done without a resolution is Done as far as the board is concerned.
   */
  async function getBoardIssues(boardId: number, mineOnly: boolean) {
    const sprint = await getActiveSprint(boardId);
    const path = sprint
      ? `/rest/agile/1.0/board/${boardId}/sprint/${sprint.id}/issue`
      : `/rest/agile/1.0/board/${boardId}/issue`;
    const mine = mineOnly ? ['assignee = currentUser()'] : [];

    const [issues, doneIssues] = await Promise.all([
      fetchIssues(path, [...mine, 'statusCategory != Done'], 'status ASC, updated DESC'),
      fetchIssues(path, [...mine, 'statusCategory = Done'], 'updated DESC'),
    ]);
    return { issues, doneIssues, sprint };
  }

  /** First occurrence wins — an issue can sit on several boards. */
  function dedupeByKey(items: JiraIssue[]): JiraIssue[] {
    const byKey = new Map<string, JiraIssue>();
    for (const i of items) if (!byKey.has(i.key)) byKey.set(i.key, i);
    return [...byKey.values()];
  }

  /**
   * Every board you have work in, merged. A board that fails is skipped rather
   * than failing the whole view — one misconfigured board shouldn't blank the list.
   */
  async function getAllMyBoardIssues(mineOnly: boolean) {
    const boards = await getMyBoards();
    const results = await Promise.all(
      boards.map(async (board) => {
        try {
          const { issues, doneIssues } = await getBoardIssues(board.id, mineOnly);
          const tag = (list: JiraIssue[]) => list.map((i) => ({ ...i, boardName: board.name }));
          return { issues: tag(issues), doneIssues: tag(doneIssues) };
        } catch {
          return null;
        }
      }),
    );
    const ok = results.filter((r): r is NonNullable<typeof r> => r !== null);
    return {
      issues: dedupeByKey(ok.flatMap((r) => r.issues)),
      doneIssues: dedupeByKey(ok.flatMap((r) => r.doneIssues)),
      boards,
    };
  }

  async function getTransitions(key: string): Promise<JiraTransition[]> {
    const res = await jira(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`);
    if (!res.ok) throw new Error(`Get transitions failed: ${res.status} ${await bodyText(res)}`);
    const data = await res.json();
    return (data.transitions ?? []).map((t: any) => ({
      id: String(t.id),
      name: t.name,
      to: t.to?.name ?? '',
      // Which column this lands in, so Done can preselect a transition that
      // actually finishes the story rather than cancelling it.
      toStage: stageFor(t.to?.statusCategory?.key),
    }));
  }

  /** JIRA wants: yyyy-MM-ddTHH:mm:ss.SSS+hhmm */
  function toJiraDate(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number, l = 2) => String(n).padStart(l, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
      `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
    );
  }

  async function addWorklog(
    key: string,
    timeSpentSeconds: number,
    comment: string,
    startedMs: number,
  ): Promise<{ id: string }> {
    const res = await jira(`/rest/api/2/issue/${encodeURIComponent(key)}/worklog`, {
      method: 'POST',
      body: JSON.stringify({
        timeSpentSeconds: Math.max(60, Math.round(timeSpentSeconds)),
        comment,
        started: toJiraDate(startedMs),
      }),
    });
    if (!res.ok) throw new Error(`Add worklog failed: ${res.status} ${await bodyText(res)}`);
    return { id: String((await res.json()).id) };
  }

  async function doTransition(key: string, transitionId: string): Promise<void> {
    const res = await jira(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
    if (!res.ok) throw new Error(`Transition failed: ${res.status} ${await bodyText(res)}`);
  }

  return {
    getMyself,
    getMyBoards,
    searchBoards,
    getActiveSprint,
    getBoardIssues,
    getAllMyBoardIssues,
    getTransitions,
    addWorklog,
    doTransition,
    issueUrl: (key: string) => `${base}/browse/${encodeURIComponent(key)}`,
  };
}
