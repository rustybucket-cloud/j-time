/**
 * Reading pull requests out of a signed-in GitHub session.
 *
 * The last resort, and sometimes the only one: an org can enforce SAML SSO and
 * decline to authorise any token you're allowed to make, at which point the API
 * shows you nothing and says nothing. Your browser session is the credential
 * that still works, because it's the one you use yourself. This reads the same
 * two dashboard pages you'd read.
 *
 * No new dependency and no Chromium download: j-time is already Electron. A
 * hidden `BrowserWindow` on a persistent partition is the whole mechanism.
 *
 * The extractor keys on the *URL shape* of a pull request link rather than on
 * class names. The markup around a pull request is restyled regularly;
 * `/{owner}/{repo}/pull/{number}` is not. What can't be read reliably —
 * review decisions, check rollups — is simply left out rather than guessed at
 * from an icon's class name.
 *
 * **The page renders its rows in the browser, not on the server.** GitHub's
 * pull request lists come back as a React shell — the raw HTML holds no
 * `/pull/` links at all — so a read taken when `loadURL` resolves catches
 * however much had hydrated by then, which is some of the list, or none of it,
 * depending on the day. Everything here therefore waits for the rows to exist
 * before looking, and treats "still nothing" as a failure rather than as an
 * empty inbox.
 */

import { BrowserWindow, session, type Session } from 'electron';
import type { GithubAccount } from '@shared/github';
import { GITHUB_WEB } from '@shared/github';
import { parsePullUrl, PULLS_QUERIES, pullsUrl, webHostFor, type PullRequest } from '@shared/prs';
import type { GithubResult } from './client';

/** A page that hasn't answered by now isn't going to. */
const LOAD_TIMEOUT_MS = 20_000;
/** How long to let the client-side render finish once the shell has loaded. */
const RENDER_TIMEOUT_MS = 12_000;
/** The dashboard paginates; more than this is somebody else's problem. */
const MAX_PAGES = 4;

/** Raw rows as the page hands them over, before they mean anything. */
interface ScrapedPull {
  href: string;
  title: string;
  updatedAt: string | null;
  draft: boolean;
  author: string | null;
}

/**
 * Runs inside the page, not here.
 *
 * Serialised as a string and evaluated in the tab, so it has the DOM and none
 * of this process. Everything it returns is plain JSON.
 */
const EXTRACT = `(() => {
  /**
   * Resolve once the list is on the page, then read it.
   *
   * The wait is the important half. These rows are rendered by React after the
   * document has loaded, so checking once is a race — and losing it looks
   * exactly like having no pull requests.
   */
  const EMPTY = /No results matched|no open pull requests|didn.t match any|0 Open/i;

  const scrape = () => {
    const rows = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/pull/"]')) {
      const href = a.getAttribute('href') || '';
      if (!/\\/pull\\/\\d+(?:[/?#]|$)/.test(href)) continue;
      const title = (a.textContent || '').trim();
      // Links with no words are the icons and counters beside the real one.
      if (!title) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      // The row is whichever ancestor holds the metadata. Bounded so a page
      // without the expected shape can't walk to <body> and scoop up everything.
      let row = a;
      for (let i = 0; i < 8 && row.parentElement; i++) {
        row = row.parentElement;
        if (row.querySelector('relative-time, time-ago, time')) break;
      }
      const when = row.querySelector('relative-time, time-ago, time');
      const text = (row.textContent || '').replace(/\\s+/g, ' ');
      const opened = /opened .* by ([A-Za-z0-9-]+)/.exec(text);

      rows.push({
        href,
        title,
        updatedAt: when ? when.getAttribute('datetime') : null,
        draft: /\\bDraft\\b/.test(text),
        author: opened ? opened[1] : null,
      });
    }
    return rows;
  };

  const isEmpty = () => EMPTY.test(document.body ? document.body.innerText : '');
  const hasNext = () =>
    Boolean(document.querySelector('a[rel="next"], a[aria-label="Next Page"], a[aria-label="Next"]'));

  const answer = (timedOut) => ({
    rows: scrape(),
    empty: isEmpty(),
    hasNext: hasNext(),
    url: location.href,
    timedOut: Boolean(timedOut),
  });

  return new Promise((resolve) => {
    const ready = () => scrape().length > 0 || isEmpty();
    if (ready()) return resolve(answer(false));

    const observer = new MutationObserver(() => {
      if (!ready()) return;
      observer.disconnect();
      clearTimeout(timer);
      // One more tick: the first row to appear is rarely the last.
      setTimeout(() => resolve(answer(false)), 250);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(answer(true));
    }, ${RENDER_TIMEOUT_MS});
  });
})()`;

interface PageResult {
  rows: ScrapedPull[];
  /** The page said so itself — no results, rather than none read. */
  empty: boolean;
  hasNext: boolean;
  url: string;
  /** The rows never appeared. Not the same as there being none. */
  timedOut: boolean;
}

/** One persistent session per account, so two logins can't tread on each other. */
export function sessionFor(account: GithubAccount): Session {
  return session.fromPartition(`persist:github-${account.id}`);
}

/**
 * The site to load pages from.
 *
 * Coerced rather than trusted: an account switched from token to browser can
 * still be carrying `https://api.github.com`, and that host's `/login` is a 404
 * rather than a sign-in page — which is exactly how this went wrong the first
 * time. `webHostFor` folds either kind of host back to the one a browser wants.
 */
function webHost(account: GithubAccount): string {
  return account.host.trim() ? webHostFor(account.host) : GITHUB_WEB;
}

/** GitHub sends you here when the session is gone. */
const isLoginPage = (url: string): boolean => /\/login|\/session|\/sessions\//.test(url);

async function read_(account: GithubAccount, url: string): Promise<PageResult> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: sessionFor(account),
      // It renders somebody else's HTML. It gets nothing.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: true,
    },
  });

  try {
    await Promise.race([
      window.loadURL(url),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('GitHub took too long to answer')), LOAD_TIMEOUT_MS),
      ),
    ]);
    return (await window.webContents.executeJavaScript(EXTRACT, true)) as PageResult;
  } finally {
    // Always: a leaked hidden window is an invisible tab left running forever.
    if (!window.isDestroyed()) window.destroy();
  }
}

/** Thrown when the session is gone, so the caller can offer a sign-in instead. */
export class NeedsSignIn extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'NeedsSignIn';
  }
}

function toPull(
  raw: ScrapedPull,
  host: string,
  login: string,
  reviewRequested: boolean,
): PullRequest | null {
  const parsed = parsePullUrl(raw.href);
  if (!parsed) return null;
  const author = raw.author ?? '';
  return {
    id: `${parsed.repo}#${parsed.number}`,
    number: parsed.number,
    repo: parsed.repo,
    title: raw.title,
    // Dashboard links are root-relative; the row has to open a real URL, and on
    // Enterprise that isn't github.com.
    url: raw.href.startsWith('http') ? raw.href : `${host}${raw.href}`,
    author,
    draft: raw.draft,
    updatedAt: raw.updatedAt ? Date.parse(raw.updatedAt) || 0 : 0,
    // Not on the page in any form worth trusting. Left absent rather than
    // guessed from an icon's class name, which is exactly the kind of reading
    // that breaks silently and wrongly.
    reviewDecision: null,
    checks: null,
    reviewRequested,
    mine: reviewRequested ? author === login : true,
  };
}

interface ListResult {
  rows: ScrapedPull[];
  /** Every page either yielded rows or said it had none. */
  read: boolean;
}

/**
 * One dashboard list, following its pages.
 *
 * The dashboard shows 25 at a time, so a list longer than that used to arrive
 * truncated with nothing to say it had been. Stops as soon as a page reports no
 * next link, which is also what a single-page list reports.
 */
async function readList(account: GithubAccount, host: string, query: string): Promise<ListResult> {
  const rows: ScrapedPull[] = [];
  let read = true;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${pullsUrl(host, query)}${page > 1 ? `&page=${page}` : ''}`;
    const result = await read_(account, url);
    if (isLoginPage(result.url)) throw new NeedsSignIn();

    rows.push(...result.rows);
    // Rows that never rendered are not an empty list; remember the difference.
    if (result.timedOut && result.rows.length === 0 && !result.empty) read = false;
    if (!result.hasNext || result.rows.length === 0) break;
  }

  return { rows, read };
}

/**
 * Both dashboard lists, as pull requests.
 *
 * Sequential rather than parallel: two hidden windows racing on one session is
 * a good way to get rate-limited by the thing you're trying not to annoy.
 */
export async function getPullsViaBrowser(account: GithubAccount): Promise<GithubResult> {
  const host = webHost(account);
  const mine = await readList(account, host, PULLS_QUERIES.mine);
  const review = await readList(account, host, PULLS_QUERIES.review);

  const login = await signedInAs(account);
  const pulls = [
    ...review.rows.map((r) => toPull(r, host, login, true)),
    ...mine.rows.map((r) => toPull(r, host, login, false)),
  ].filter((pr): pr is PullRequest => pr !== null);

  // A list whose rows never rendered is not an empty list, and reporting it as
  // one is the failure this whole plugin exists to avoid. Say it plainly
  // instead — an error the user can see beats a shorter list they can't.
  if (!mine.read || !review.read) {
    throw new Error('Signed in, but GitHub’s list didn’t finish loading — try refreshing');
  }

  return { login, pulls, blockedOrgs: [] };
}

/** Whoever the session belongs to, from the cookie GitHub sets on login. */
async function signedInAs(account: GithubAccount): Promise<string> {
  try {
    const cookies = await sessionFor(account).cookies.get({ name: 'dotcom_user' });
    return cookies[0]?.value ?? '';
  } catch {
    return '';
  }
}

/**
 * Show the real GitHub login, and wait for it to finish.
 *
 * A visible window on purpose: the whole point is that a human completes SSO,
 * two-factor and any device check, exactly as they would in their browser. It
 * closes itself once the session cookie appears.
 */
export function signIn(account: GithubAccount): Promise<void> {
  const host = webHost(account);
  const store = sessionFor(account);

  return new Promise((resolve) => {
    const window = new BrowserWindow({
      width: 980,
      height: 780,
      title: 'Sign in to GitHub',
      autoHideMenuBar: true,
      webPreferences: {
        session: store,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      if (!window.isDestroyed()) window.destroy();
      resolve();
    };

    // Polling the cookie rather than matching on a URL: SSO bounces through the
    // identity provider and back, and which URL you land on differs by org.
    const poll = setInterval(() => {
      void store.cookies.get({ name: 'user_session' }).then((cookies) => {
        if (cookies.length > 0) finish();
      });
    }, 1000);

    // Giving up is a legitimate outcome; the account just stays signed out.
    window.on('closed', finish);
    void window.loadURL(`${host}/login`);
  });
}

/** Forget a session — the only way to sign out, and what removing an account must do. */
export async function signOut(account: GithubAccount): Promise<void> {
  await sessionFor(account).clearStorageData();
}
