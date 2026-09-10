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
 */

import { BrowserWindow, session, type Session } from 'electron';
import type { GithubAccount } from '@shared/github';
import { GITHUB_WEB } from '@shared/github';
import { parsePullUrl, PULLS_QUERIES, pullsUrl, type PullRequest } from '@shared/prs';
import type { GithubResult } from './client';

/** A page that hasn't answered by now isn't going to. */
const LOAD_TIMEOUT_MS = 20_000;

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
    for (let i = 0; i < 6 && row.parentElement; i++) {
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
  return { rows, url: location.href, title: document.title };
})()`;

interface PageResult {
  rows: ScrapedPull[];
  url: string;
  title: string;
}

/** One persistent session per account, so two logins can't tread on each other. */
export function sessionFor(account: GithubAccount): Session {
  return session.fromPartition(`persist:github-${account.id}`);
}

function webHost(account: GithubAccount): string {
  return account.host.trim().replace(/\/+$/, '') || GITHUB_WEB;
}

/** GitHub sends you here when the session is gone. */
const isLoginPage = (url: string): boolean => /\/login|\/session|\/sessions\//.test(url);

async function read(account: GithubAccount, url: string): Promise<PageResult> {
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

/**
 * Both dashboard lists, as pull requests.
 *
 * Sequential rather than parallel: two hidden windows racing on one session is
 * a good way to get rate-limited by the thing you're trying not to annoy.
 */
export async function getPullsViaBrowser(account: GithubAccount): Promise<GithubResult> {
  const host = webHost(account);
  const mine = await read(account, pullsUrl(host, PULLS_QUERIES.mine));
  if (isLoginPage(mine.url)) throw new NeedsSignIn();

  const review = await read(account, pullsUrl(host, PULLS_QUERIES.review));
  if (isLoginPage(review.url)) throw new NeedsSignIn();

  const login = await signedInAs(account);
  const pulls = [
    ...review.rows.map((r) => toPull(r, host, login, true)),
    ...mine.rows.map((r) => toPull(r, host, login, false)),
  ].filter((pr): pr is PullRequest => pr !== null);

  // A page that loaded, wasn't the login screen, and yielded nothing is either
  // an empty dashboard or a dashboard we can no longer read. Those look
  // identical from here, so say so rather than reporting "nothing open".
  if (pulls.length === 0 && !looksEmpty(mine) && !looksEmpty(review)) {
    throw new Error('Signed in, but couldn’t read the pull request list');
  }

  return { login, pulls, blockedOrgs: [] };
}

/** GitHub says so in as many words when a filter matches nothing. */
function looksEmpty(page: PageResult): boolean {
  return /No results matched|no open pull requests|didn’t match any/i.test(page.title)
    ? true
    : page.rows.length === 0 && /pull requests/i.test(page.title);
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
