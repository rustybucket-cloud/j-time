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
 * One row per org this token can't read.
 *
 * A row rather than a note on the header, because the failure it reports is
 * invisible by construction: SSO-withheld results arrive as HTTP 200 with fewer
 * pull requests, so the honest rendering of "your whole work org is missing"
 * cannot be something you have to notice the absence of. It goes away by itself
 * once the token is authorised.
 */
function blockedRows(snapshot: GithubSnapshot): Row[] {
  return snapshot.blockedOrgs.map((org) => ({
    id: `sso:${org}`,
    title: `${org} can’t be read by this token`,
    subtitle: 'You’re a member, so its pull requests are missing here. ↩ to authorise it.',
    keywords: ['sso', 'saml', 'permission', 'missing', org],
    subsection: 'Not connected',
    lead: 'blocked' as const,
    enterLabel: 'Authorise',
    run: () => void window.jt.openUrl(ssoAuthorizeUrl(snapshot.config.host, org)),
  }));
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

    const rows: Row[] = [
      ...blockedRows(snapshot),
      ...items.map((item) => ({
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        keywords: item.keywords,
        subsection: item.subsection,
        lead: item.lead,
        badges: item.badges,
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
