/**
 * Reading pull requests out of a signed-in GitHub session, with Playwright.
 *
 * The last resort, and sometimes the only one: an org can enforce SAML SSO and
 * decline to authorise any token you're allowed to make, at which point the API
 * shows you nothing and says nothing. Your browser session still works, because
 * it's the one you use yourself. This reads the same two dashboard pages you'd
 * read.
 *
 * **The page renders its rows in the browser, not on the server.** GitHub's
 * pull request lists come back as a React shell — curl one and there isn't a
 * single `/pull/` link in the HTML — so anything that reads the document as
 * loaded catches however much had hydrated, which is some of the list or none
 * of it. Playwright is here for exactly that: `waitForSelector` is a real
 * answer to "wait until the rows exist", where hand-rolled observers are a
 * guess that usually works.
 *
 * The extractor still keys on the *URL shape* of a pull request link rather
 * than on class names. The markup around a pull request is restyled regularly;
 * `/{owner}/{repo}/pull/{number}` is not. What can't be read reliably — review
 * decisions, check rollups — is left out rather than guessed from an icon's
 * class name, because a wrong badge is worse than a missing one.
 */

import path from 'path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { GithubAccount } from '@shared/github';
import { GITHUB_WEB } from '@shared/github';
import { parsePullUrl, PULLS_QUERIES, pullsUrl, webHostFor, type PullRequest } from '@shared/prs';
import { DIR } from '../../store';
import type { GithubResult } from './client';

/** How long to let the client-side render finish before calling it a failure. */
const RENDER_TIMEOUT_MS = 15_000;
/** The dashboard paginates; more than this is somebody else's problem. */
const MAX_PAGES = 4;

/** Rows as the page hands them over, before they mean anything. */
interface ScrapedPull {
  href: string;
  title: string;
  updatedAt: string | null;
  draft: boolean;
  author: string | null;
}

/** Thrown when the session is gone, so the caller can offer a sign-in instead. */
export class NeedsSignIn extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'NeedsSignIn';
  }
}

/**
 * The profile directory for an account's session.
 *
 * Under `DIR`, so `JT_HOME` redirects it with everything else and a sandbox run
 * can't touch a real login. One per account: two orgs may want two identities.
 */
const profileDir = (account: GithubAccount): string =>
  path.join(DIR, 'browser', account.id);

/**
 * The site to load pages from.
 *
 * Coerced rather than trusted: an account switched from token to browser can
 * still be carrying `https://api.github.com`, and that host's `/login` is a 404
 * rather than a sign-in page.
 */
const webHost = (account: GithubAccount): string =>
  account.host.trim() ? webHostFor(account.host) : GITHUB_WEB;

/**
 * A persistent context locks its profile directory, so two of them for one
 * account is an error rather than a race. Everything an account does queues.
 */
const queues = new Map<string, Promise<unknown>>();

function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  queues.set(
    id,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Launch against the browser this machine actually has.
 *
 * Playwright's own Chromium is a ~150MB download that a packaged app has no
 * good way to fetch, and a corporate network may not allow at all. Installed
 * Chrome is already there, already updated by somebody else, and — being a real
 * branded browser — is the one GitHub is least likely to treat as a robot. The
 * bundled build is the fallback for a machine with no Chrome that ran
 * `npx playwright install`.
 */
async function open(account: GithubAccount, headless: boolean): Promise<BrowserContext> {
  const dir = profileDir(account);
  const attempts: { channel?: string }[] = [{ channel: 'chrome' }, {}, { channel: 'msedge' }];
  let last: unknown;

  for (const options of attempts) {
    try {
      return await chromium.launchPersistentContext(dir, {
        headless,
        viewport: { width: 1280, height: 1000 },
        ...options,
      });
    } catch (e: unknown) {
      last = e;
    }
  }
  throw new Error(
    `Couldn’t start a browser. Install Google Chrome, or run \`npx playwright install chromium\`. (${
      last instanceof Error ? last.message.split('\n')[0] : String(last)
    })`,
  );
}

/** GitHub sends you here when the session is gone. */
const isLoginPage = (url: string): boolean => /\/login|\/session|\/sessions\//.test(url);

const PULL_LINK = 'a[href*="/pull/"]';
const EMPTY_TEXT = /No results matched|no open pull requests|didn.t match any/i;

interface PageResult {
  rows: ScrapedPull[];
  /** The page said so itself — no results, rather than none read. */
  empty: boolean;
  hasNext: boolean;
  url: string;
  /** The rows never appeared. Not the same as there being none. */
  timedOut: boolean;
}

async function readPage(page: Page, url: string): Promise<PageResult> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });

  // Whichever comes first: rows, or the page saying there are none. Both are
  // answers; neither arriving is not.
  let timedOut = false;
  try {
    await Promise.race([
      page.waitForSelector(PULL_LINK, { timeout: RENDER_TIMEOUT_MS }),
      page.waitForFunction(
        (pattern) => new RegExp(pattern, 'i').test(document.body?.innerText ?? ''),
        EMPTY_TEXT.source,
        { timeout: RENDER_TIMEOUT_MS },
      ),
    ]);
  } catch {
    timedOut = true;
  }

  const scraped = await page.evaluate(
    ({ linkSelector, emptyPattern }) => {
      const rows: {
        href: string;
        title: string;
        updatedAt: string | null;
        draft: boolean;
        author: string | null;
      }[] = [];
      const seen = new Set<string>();

      for (const a of Array.from(document.querySelectorAll(linkSelector))) {
        const href = a.getAttribute('href') ?? '';
        if (!/\/pull\/\d+(?:[/?#]|$)/.test(href)) continue;
        const title = (a.textContent ?? '').trim();
        // Links with no words are the icons and counters beside the real one.
        if (!title || seen.has(href)) continue;
        seen.add(href);

        // The row is whichever ancestor holds the metadata. Bounded, so a page
        // in an unexpected shape can't walk to <body> and scoop up everything.
        let row: Element = a;
        for (let i = 0; i < 8 && row.parentElement; i++) {
          row = row.parentElement;
          if (row.querySelector('relative-time, time-ago, time')) break;
        }
        const when = row.querySelector('relative-time, time-ago, time');
        const text = (row.textContent ?? '').replace(/\s+/g, ' ');
        const opened = /opened .* by ([A-Za-z0-9-]+)/.exec(text);

        rows.push({
          href,
          title,
          updatedAt: when?.getAttribute('datetime') ?? null,
          draft: /\bDraft\b/.test(text),
          author: opened ? opened[1] : null,
        });
      }

      return {
        rows,
        empty: new RegExp(emptyPattern, 'i').test(document.body?.innerText ?? ''),
        hasNext: Boolean(
          document.querySelector('a[rel="next"], a[aria-label="Next Page"], a[aria-label="Next"]'),
        ),
      };
    },
    { linkSelector: PULL_LINK, emptyPattern: EMPTY_TEXT.source },
  );

  return { ...scraped, url: page.url(), timedOut };
}

interface ListResult {
  rows: ScrapedPull[];
  /** Every page either yielded rows or said it had none. */
  read: boolean;
}

/**
 * One dashboard list, following its pages.
 *
 * The dashboard shows 25 at a time, so a longer list used to arrive truncated
 * with nothing to say it had been.
 */
async function readList(page: Page, host: string, query: string): Promise<ListResult> {
  const rows: ScrapedPull[] = [];
  let read = true;

  for (let n = 1; n <= MAX_PAGES; n++) {
    const url = `${pullsUrl(host, query)}${n > 1 ? `&page=${n}` : ''}`;
    const result = await readPage(page, url);
    if (isLoginPage(result.url)) throw new NeedsSignIn();

    rows.push(...result.rows);
    // Rows that never rendered are not an empty list; remember the difference.
    if (result.timedOut && result.rows.length === 0 && !result.empty) read = false;
    if (!result.hasNext || result.rows.length === 0) break;
  }

  return { rows, read };
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
    // Not on the page in any form worth trusting.
    reviewDecision: null,
    checks: null,
    reviewRequested,
    mine: reviewRequested ? author === login : true,
  };
}

/** Whoever the session belongs to, from the cookie GitHub sets on login. */
async function signedInAs(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.find((c) => c.name === 'dotcom_user')?.value ?? '';
}

/** Both dashboard lists, as pull requests. */
export function getPullsViaBrowser(account: GithubAccount): Promise<GithubResult> {
  return serial(account.id, async () => {
    const host = webHost(account);
    const context = await open(account, true);
    try {
      const page = await context.newPage();
      const mine = await readList(page, host, PULLS_QUERIES.mine);
      const review = await readList(page, host, PULLS_QUERIES.review);
      const login = await signedInAs(context);

      const pulls = [
        ...review.rows.map((r) => toPull(r, host, login, true)),
        ...mine.rows.map((r) => toPull(r, host, login, false)),
      ].filter((pr): pr is PullRequest => pr !== null);

      // A list whose rows never rendered is not an empty list, and reporting it
      // as one is the failure this plugin exists to avoid.
      if (!mine.read || !review.read) {
        throw new Error('Signed in, but GitHub’s list didn’t finish loading — try refreshing');
      }

      return { login, pulls, blockedOrgs: [] };
    } finally {
      await context.close();
    }
  });
}

/**
 * Show the real GitHub login, and wait for it to finish.
 *
 * Headed on purpose: the whole point is that a human completes SSO, two-factor
 * and any device check, exactly as they would in their browser. It closes
 * itself once the session cookie appears.
 */
export function signIn(account: GithubAccount): Promise<void> {
  return serial(account.id, async () => {
    const context = await open(account, false);
    try {
      const page = await context.newPage();
      await page.goto(`${webHost(account)}/login`, { waitUntil: 'domcontentloaded' });

      // Polling the cookie rather than matching on a URL: SSO bounces through
      // the identity provider and back, and where you land differs by org.
      // Closing the window is a legitimate outcome — the account stays signed
      // out — so a closed context ends the wait too.
      let closed = false;
      context.on('close', () => (closed = true));
      page.on('close', () => (closed = true));

      const deadline = Date.now() + 5 * 60_000;
      while (!closed && Date.now() < deadline) {
        const cookies = await context.cookies().catch(() => []);
        if (cookies.some((c) => c.name === 'user_session')) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}

/** Forget a session — the only way to sign out, and what removing an account must do. */
export async function signOut(account: GithubAccount): Promise<void> {
  await serial(account.id, async () => {
    const context = await open(account, true);
    await context.clearCookies();
    await context.close();
  });
}
