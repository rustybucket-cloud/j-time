/**
 * The PR plugin: what is waiting on you, and what you have open.
 *
 * Fetches once per account and merges. Accounts exist because a fine-grained
 * token speaks for exactly one owner — see `shared/github.ts` — so an org that
 * mandates them needs a token of its own alongside your personal one.
 *
 * Still deliberately small: no state file, nothing to serialise, nothing
 * written back to GitHub. That asymmetry with the JIRA plugin is the point —
 * the shell's contract only has to be as wide as the widest plugin.
 */

import type { ActionResult } from '@shared/plugin';
import {
  accountName,
  defaultGithubConfig,
  normalizeGithubConfig,
  type AccountStatus,
  type GithubConfig,
  type GithubSnapshot,
  type PublicGithubConfig,
} from '@shared/github';
import type { PullRequest } from '@shared/prs';
import type { MainPlugin } from '../../plugin';
import { str } from '../../plugin';
import { createGithub, type GithubResult } from './client';
import { getPullsViaBrowser, NeedsSignIn, signIn, signOut } from './browser';

/** PRs move on other people's schedules, so a slower poll than the board's. */
const POLL_MS = 180_000;

let config: GithubConfig = defaultGithubConfig();
let pulls: PullRequest[] = [];
let accounts: AccountStatus[] = [];

function publicConfig(): PublicGithubConfig {
  return {
    limit: config.limit,
    accounts: config.accounts.map(({ token, ...rest }) => ({
      ...rest,
      hasToken: Boolean(token),
    })),
  };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const plugin: MainPlugin<GithubSnapshot, GithubConfig> = {
  id: 'github',
  title: 'Pull Requests',
  // One token per account, so the store encrypts each entry's rather than a
  // single field. `token` stays listed so a config written by the one-token
  // version still decrypts, and `normalizeGithubConfig` turns it into account one.
  secrets: [{ list: 'accounts', field: 'token' }, 'token'],
  refreshMs: POLL_MS,
  defaults: defaultGithubConfig,

  // Nothing to set up: this plugin has no state file and never changes on its
  // own between fetches, so it has no reason to announce anything to the shell.
  init() {},

  configure(next) {
    config = normalizeGithubConfig(next);
  },

  /**
   * Keep each account's token when the form sends it back blank.
   *
   * Matched by id rather than position: the settings editor can add, remove and
   * reorder accounts, and lining them up by index would quietly move one
   * account's token onto another's host — which is the sort of mistake that
   * looks like a rejected credential.
   */
  mergeConfig(previous, patch) {
    const merged = normalizeGithubConfig({ ...previous, ...patch });
    const before = new Map(previous.accounts.map((a) => [a.id, a.token]));
    return {
      ...merged,
      accounts: merged.accounts.map((account) => ({
        ...account,
        token: account.token || before.get(account.id) || '',
      })),
    };
  },

  configured: () => config.accounts.some((a) => Boolean(a.token) || a.kind === 'browser'),

  snapshot: () => ({ config: publicConfig(), pulls, accounts }),

  /**
   * Ask every account, and let them fail independently.
   *
   * `allSettled` rather than `all`: one expired token must not blank the pull
   * requests belonging to the others. A failed account keeps its previous rows
   * and reports on its own row, the same bargain the shell makes per section.
   */
  async refresh(): Promise<ActionResult> {
    const usable = config.accounts.filter((a) => a.token || a.kind === 'browser');
    if (usable.length === 0) return { ok: false, error: 'No GitHub account yet' };

    const settled = await Promise.allSettled(
      usable.map((account): Promise<GithubResult> =>
        account.kind === 'browser'
          ? getPullsViaBrowser(account)
          : createGithub(account, config.limit).getPulls(),
      ),
    );

    const merged: PullRequest[] = [];
    const statuses: AccountStatus[] = [];

    settled.forEach((result, i) => {
      const account = usable[i];
      if (result.status === 'rejected') {
        // Keep whatever this account last showed; only its status changes.
        merged.push(...pulls.filter((pr) => pr.account === account.id));
        // A dead session isn't an error to report, it's a thing to do — the row
        // it produces offers the sign-in rather than the message.
        const needsSignIn = result.reason instanceof NeedsSignIn;
        statuses.push({
          id: account.id,
          label: accountName(account),
          kind: account.kind,
          login: null,
          error: needsSignIn ? null : message(result.reason),
          blockedOrgs: [],
          needsSignIn,
        });
        return;
      }
      const { login, blockedOrgs, pulls: fetched } = result.value;
      merged.push(...fetched.map((pr) => ({ ...pr, account: account.id })));
      statuses.push({
        id: account.id,
        label: accountName(account, login),
        kind: account.kind,
        login,
        error: null,
        blockedOrgs,
        needsSignIn: false,
      });
    });

    pulls = merged;
    accounts = statuses;

    // The section is only *failed* when nothing came back at all. One account
    // down out of three is a row, not a dead list — and an account merely
    // waiting to be signed into is a row too, never a failure.
    const failed = statuses.filter((s) => s.error);
    if (failed.length > 0 && failed.length === statuses.length) {
      return { ok: false, error: failed[0]?.error ?? 'GitHub is unreachable' };
    }
    return { ok: true };
  },

  commands: {
    /**
     * Sign a browser account in, then re-read it.
     *
     * A visible window, because a human has to complete SSO and two-factor
     * exactly as they would in their own browser — that being the entire reason
     * this mode exists.
     */
    async signIn(args) {
      const id = str(args, 0);
      const account = config.accounts.find((a) => a.id === id);
      if (!account) return { ok: false, error: `No account called ${id}` };
      await signIn(account);
      return { ok: true, message: `Signed in to ${accountName(account)}` };
    },

    async signOut(args) {
      const id = str(args, 0);
      const account = config.accounts.find((a) => a.id === id);
      if (!account) return { ok: false, error: `No account called ${id}` };
      await signOut(account);
      pulls = pulls.filter((pr) => pr.account !== id);
      return { ok: true, message: `Signed out of ${accountName(account)}` };
    },
  },
};
