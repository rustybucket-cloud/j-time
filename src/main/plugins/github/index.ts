/**
 * The PR plugin: what is waiting on you, and what you have open.
 *
 * Deliberately small. It fetches, and Enter opens a browser — there is no state
 * file, nothing to serialise and nothing to write back to GitHub. That asymmetry
 * with the JIRA plugin is the point: the shell's contract only has to be as wide
 * as the widest plugin, not as wide as every plugin.
 */

import type { ActionResult } from '@shared/plugin';
import {
  defaultGithubConfig,
  type GithubConfig,
  type GithubSnapshot,
  type PublicGithubConfig,
} from '@shared/github';
import type { PullRequest } from '@shared/prs';
import type { MainPlugin } from '../../plugin';
import { createGithub, type GithubClient } from './client';

/** PRs move on other people's schedules, so a slower poll than the board's. */
const POLL_MS = 180_000;

let config: GithubConfig = defaultGithubConfig();
let client: GithubClient = createGithub(config);

let pulls: PullRequest[] = [];
let login: string | null = null;

function publicConfig(): PublicGithubConfig {
  const { token, ...rest } = config;
  return { ...rest, hasToken: Boolean(token) };
}

export const plugin: MainPlugin<GithubSnapshot, GithubConfig> = {
  id: 'github',
  title: 'Pull Requests',
  secrets: ['token'],
  refreshMs: POLL_MS,
  defaults: defaultGithubConfig,

  // Nothing to set up: this plugin has no state file and never changes on its
  // own between fetches, so it has no reason to announce anything to the shell.
  init() {},

  configure(next) {
    config = { ...next };
    config.host = config.host.trim().replace(/\/$/, '');
    // A limit of zero would fetch nothing and read as a broken connection.
    config.limit = Math.max(1, Math.min(100, Math.trunc(config.limit) || 25));
    client = createGithub(config);
  },

  configured: () => Boolean(config.token) && config.host.trim().length > 0,

  snapshot: () => ({ config: publicConfig(), pulls, login }),

  async refresh(): Promise<ActionResult> {
    if (!plugin.configured()) return { ok: false, error: 'No GitHub token yet' };
    const result = await client.getPulls();
    pulls = result.pulls;
    login = result.login;
    return { ok: true };
  },

  commands: {},
};
