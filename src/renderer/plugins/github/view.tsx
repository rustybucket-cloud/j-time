/**
 * The PR section: what is waiting on you, and what you have open.
 *
 * Small on purpose. Every row does one thing — open it — and the ordering that
 * makes the section worth having is in `shared/prs.ts`, tested there. This file
 * is the mapping from those items onto the shell's row vocabulary and nothing
 * else, which is roughly what a second plugin should cost.
 */

import type { ReactNode } from 'react';
import type { Ctx, PluginView, Row, SectionContent } from '@shared/plugin';
import { githubConfigured, type GithubSnapshot } from '@shared/github';
import { groupPulls, pinnedPull, ssoAuthorizeUrl, type PrItem } from '@shared/prs';
import { Settings } from './Settings';

const ID = 'github';

function actions(item: PrItem, ctx: Ctx): Row[] {
  const { pr } = item;
  return [
    {
      id: 'act:open',
      title: 'Open in browser',
      badges: [{ text: '↩', kind: 'key' }],
      run: () => void window.jt.openUrl(pr.url),
    },
    {
      id: 'act:copy-url',
      title: 'Copy link',
      badges: [{ text: '⌘C', kind: 'key' }],
      shortcut: 'c',
      run: () =>
        ctx.act(async () => {
          await window.jt.copy(pr.url);
          return { ok: true, message: `Copied ${item.title}` };
        }),
    },
    {
      id: 'act:copy-ref',
      title: 'Copy reference',
      subtitle: item.title,
      run: () =>
        ctx.act(async () => {
          await window.jt.copy(item.title);
          return { ok: true, message: `Copied ${item.title}` };
        }),
    },
  ];
}

/**
 * One row per thing wrong with an account, above that account's pull requests.
 *
 * Rows rather than a note on the header, because both failures they report are
 * invisible by construction: an org withheld by SSO arrives as HTTP 200 with
 * fewer pull requests, and an account that failed entirely still leaves the
 * other accounts' rows on screen. The honest rendering of "a whole org is
 * missing from this list" cannot be something you have to notice the absence
 * of. Both disappear on their own once the cause is fixed.
 */
function problemRows(snapshot: GithubSnapshot, ctx: Ctx): Row[] {
  const hostFor = (id: string) =>
    snapshot.config.accounts.find((a) => a.id === id)?.host ?? '';
  const many = snapshot.accounts.length > 1;
  const rows: Row[] = [];

  for (const account of snapshot.accounts) {
    const who = many ? `${account.label}: ` : '';
    // A dead session is a thing to do, not an error to read — so it offers the
    // sign-in rather than telling you about it.
    if (account.needsSignIn) {
      rows.push({
        id: `signin:${account.id}`,
        title: `Sign in to GitHub${many ? ` as ${account.label}` : ''}`,
        subtitle: 'Its pull requests are missing until you do. ↩ opens the real login.',
        keywords: ['sign in', 'login', 'session', 'browser', account.label],
        subsection: 'Not connected',
        lead: 'attention',
        enterLabel: 'Sign in',
        run: () =>
          ctx.actStay(() => window.jt.invoke('github', 'signIn', [account.id])),
      });
      continue;
    }
    if (account.error) {
      rows.push({
        id: `err:${account.id}`,
        title: `${who}couldn’t be reached`,
        subtitle: account.error,
        keywords: ['error', 'failed', account.label],
        subsection: 'Not connected',
        lead: 'blocked',
        enterLabel: 'Retry',
        run: () => void window.jt.refresh('github'),
      });
    }
    for (const org of account.blockedOrgs) {
      rows.push({
        id: `sso:${account.id}:${org}`,
        title: `${org} can’t be read${many ? ` by ${account.label}` : ' by this token'}`,
        subtitle: 'You’re a member, so its pull requests are missing here. ↩ to authorise it.',
        keywords: ['sso', 'saml', 'permission', 'missing', org, account.label],
        subsection: 'Not connected',
        lead: 'blocked',
        enterLabel: 'Authorise',
        run: () => void window.jt.openUrl(ssoAuthorizeUrl(hostFor(account.id), org)),
      });
    }
  }
  return rows;
}

function note(snapshot: GithubSnapshot, rows: Row[]): string | undefined {
  if (!githubConfigured(snapshot.config)) return 'Not set up';
  if (rows.length === 0) return 'Nothing open';
  return undefined;
}

export const githubView: PluginView<GithubSnapshot> = {
  id: ID,
  title: 'Pull Requests',

  section(snapshot, ctx): SectionContent {
    const items = groupPulls(snapshot.pulls, ctx.now);
    const pinned = pinnedPull(items);
    // Only worth saying which account a row came from when there's more than
    // one; on a single-account setup it's a chip that never varies.
    const many = snapshot.accounts.length > 1;
    const labelFor = (id?: string) =>
      snapshot.accounts.find((a) => a.id === id)?.label ?? '';

    const rows: Row[] = [
      ...problemRows(snapshot, ctx),
      ...items.map((item) => ({
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        keywords: [...item.keywords, labelFor(item.pr.account)].filter(Boolean),
        subsection: item.subsection,
        lead: item.lead,
        badges: many
          ? [{ text: labelFor(item.pr.account) || '?' }, ...item.badges]
          : item.badges,
        pin: item.id === pinned?.id,
        enterLabel: 'Open',
        run: () => void window.jt.openUrl(item.pr.url),
        actions: actions(item, ctx),
      })),
    ];

    return {
      rows,
      note: note(snapshot, rows),
      actions: [
        {
          id: 'sec:refresh',
          title: 'Refresh pull requests',
          run: () => ctx.actStay(() => window.jt.refresh(ID)),
        },
        {
          id: 'sec:settings',
          title: 'GitHub settings…',
          run: () => ctx.openSettings(ID),
        },
      ],
    };
  },

  settings(snapshot, onSaved): ReactNode {
    return <Settings snapshot={snapshot} onSaved={onSaved} />;
  },

  configured: (snapshot) => githubConfigured(snapshot.config),
};
