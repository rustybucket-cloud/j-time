/**
 * The PR plugin's config and its slice of the snapshot.
 *
 * **Several accounts, not one token.** A fine-grained personal access token has
 * exactly one resource owner — your user, or one organisation — so a single
 * token cannot span your own repos and two work orgs. Orgs that mandate
 * fine-grained tokens therefore make "one token" the wrong shape outright: you
 * end up seeing one owner's pull requests and silently losing the rest, which
 * is the same failure as an unauthorised token wearing a different hat.
 *
 * So the unit of configuration is an *account*: one token, one host, one owner's
 * worth of work. Classic tokens still fit — they're just an account that happens
 * to see everything.
 *
 * `host` is per account rather than global for the same reason it was a field at
 * all: one of them may be an Enterprise install on the company's own domain.
 */

import type { PullRequest } from './prs';

export const GITHUB_HOST = 'https://api.github.com';

export interface GithubAccount {
  /** Stable within a config. Only used to key rows and statuses. */
  id: string;
  /** What to call it — "Personal", "fs-eng". Falls back to the login. */
  label: string;
  /** API root: api.github.com, or an Enterprise install's `/api`. */
  host: string;
  token: string;
}

export interface GithubConfig {
  accounts: GithubAccount[];
  /** How many PRs to ask each account for, per query. */
  limit: number;
}

export function defaultGithubConfig(): GithubConfig {
  return { accounts: [], limit: 25 };
}

/** Config as written before the plugin understood more than one token. */
interface LegacyGithubConfig {
  host?: unknown;
  token?: unknown;
}

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

/**
 * Fill in a config from whatever is on disk, including the one-token shape.
 *
 * The migration is done here rather than in `store.ts` because the store knows
 * how to decrypt a field, not what the field means. A config written by the
 * single-token version decrypts to a top-level `token`, which becomes account
 * one — nobody has to paste a credential again because the plugin learned to
 * hold two.
 */
export function normalizeGithubConfig(raw: Partial<GithubConfig> & LegacyGithubConfig): GithubConfig {
  const limitRaw = Number((raw as { limit?: unknown }).limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 25;

  const listed = Array.isArray(raw.accounts) ? raw.accounts : [];
  const accounts = listed
    .map((account, i) => normalizeAccount(account as Partial<GithubAccount>, i))
    // A blank row in the settings editor isn't an account yet.
    .filter((account) => account.token || account.label);

  if (accounts.length === 0) {
    const token = str(raw.token);
    const host = str(raw.host);
    if (token || host) return { accounts: [normalizeAccount({ token, host }, 0)], limit };
  }

  return { accounts, limit };
}

function normalizeAccount(raw: Partial<GithubAccount>, index: number): GithubAccount {
  const host = str(raw.host, GITHUB_HOST).trim().replace(/\/+$/, '') || GITHUB_HOST;
  return {
    id: str(raw.id) || `a${index + 1}`,
    label: str(raw.label).trim(),
    host,
    token: str(raw.token),
  };
}

/** An account as the renderer sees it. The token never crosses the bridge. */
export type PublicGithubAccount = Omit<GithubAccount, 'token'> & { hasToken: boolean };

export type PublicGithubConfig = { accounts: PublicGithubAccount[]; limit: number };

/** How one account's last fetch went. One failing token must not blank the rest. */
export interface AccountStatus {
  id: string;
  label: string;
  /** Who the token belongs to, once we've asked. */
  login: string | null;
  error: string | null;
  /** Orgs this account is a member of but cannot read. See `unauthorizedOrgs`. */
  blockedOrgs: string[];
}

export interface GithubSnapshot {
  config: PublicGithubConfig;
  /** Every account's pull requests, merged. Kept across a failed fetch. */
  pulls: PullRequest[];
  accounts: AccountStatus[];
}

/** What to call an account on screen, in decreasing order of what we know. */
export function accountName(account: { label: string; id: string }, login?: string | null): string {
  return account.label || login || `Account ${account.id}`;
}

/** Nothing to fetch until at least one account has a token. */
export function githubConfigured(config: PublicGithubConfig): boolean {
  return config.accounts.some((a) => a.hasToken);
}
