/**
 * The PR plugin's config and its slice of the snapshot.
 *
 * `host` is here rather than assumed so the same plugin works against GitHub
 * Enterprise, where the API lives under the company's own domain.
 */

import type { PullRequest } from './prs';

export interface GithubConfig {
  /** API root. github.com's GraphQL endpoint, or an Enterprise install's. */
  host: string;
  token: string;
  /** How many PRs to ask for per query. */
  limit: number;
}

export const GITHUB_HOST = 'https://api.github.com';

export function defaultGithubConfig(): GithubConfig {
  return { host: GITHUB_HOST, token: '', limit: 25 };
}

/** Config as the renderer sees it. The token never crosses the bridge. */
export type PublicGithubConfig = Omit<GithubConfig, 'token'> & { hasToken: boolean };

export interface GithubSnapshot {
  config: PublicGithubConfig;
  /** Empty until the first successful fetch, and kept across a failed one. */
  pulls: PullRequest[];
  /** Who the token belongs to, once we've asked. */
  login: string | null;
}

/** A token is the only thing this plugin cannot work without. */
export function githubConfigured(config: PublicGithubConfig): boolean {
  return config.hasToken && config.host.trim().length > 0;
}
