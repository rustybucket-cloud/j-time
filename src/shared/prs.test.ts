import { describe, it, expect } from 'vitest';
import {
  formatAge,
  groupPulls,
  ssoAuthorizeUrl,
  unauthorizedOrgs,
  MINE,
  NEEDS_REVIEW,
  parsePullUrl,
  pinnedPull,
  prBadges,
  prGlyph,
  pullsUrl,
  webHostFor,
  type PullRequest,
} from './prs';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const pr = (id: string, over: Partial<PullRequest> = {}): PullRequest => ({
  id,
  number: Number(id.split('#')[1] ?? 1),
  repo: id.split('#')[0] ?? 'org/repo',
  title: `${id} title`,
  url: `https://github.com/${id}`,
  author: 'someone',
  draft: false,
  updatedAt: NOW - MINUTE,
  reviewDecision: null,
  checks: null,
  reviewRequested: false,
  mine: false,
  ...over,
});

describe('groupPulls', () => {
  // What is blocked on you comes first, and the thing blocked longest comes first
  // within that — the section is a queue, not a feed.
  it('leads with review requests, oldest first', () => {
    const items = groupPulls(
      [
        pr('o/r#1', { reviewRequested: true, updatedAt: NOW - 10 * MINUTE }),
        pr('o/r#2', { reviewRequested: true, updatedAt: NOW - 60 * MINUTE }),
      ],
      NOW,
    );
    expect(items.map((i) => i.title)).toEqual(['o/r#2', 'o/r#1']);
    expect(items.every((i) => i.subsection === NEEDS_REVIEW)).toBe(true);
  });

  // Your own list is a status readout: you want the one you just pushed to.
  it('follows with your own, most recently touched first', () => {
    const items = groupPulls(
      [
        pr('o/r#1', { mine: true, updatedAt: NOW - 60 * MINUTE }),
        pr('o/r#2', { mine: true, updatedAt: NOW - 10 * MINUTE }),
      ],
      NOW,
    );
    expect(items.map((i) => i.title)).toEqual(['o/r#2', 'o/r#1']);
    expect(items.every((i) => i.subsection === MINE)).toBe(true);
  });

  it('puts review requests above your own', () => {
    const items = groupPulls(
      [pr('o/r#1', { mine: true }), pr('o/r#2', { reviewRequested: true })],
      NOW,
    );
    expect(items.map((i) => i.subsection)).toEqual([NEEDS_REVIEW, MINE]);
  });

  // Acting on the review is what would clear it, and a row appearing twice in one
  // section reads as a bug rather than as emphasis.
  it('shows a PR that is both yours and awaiting your review once, under review', () => {
    const items = groupPulls([pr('o/r#1', { mine: true, reviewRequested: true })], NOW);
    expect(items).toHaveLength(1);
    expect(items[0].subsection).toBe(NEEDS_REVIEW);
  });

  // The two GitHub searches overlap, so the same PR arrives twice.
  it('drops duplicates from the two queries', () => {
    const items = groupPulls([pr('o/r#1', { mine: true }), pr('o/r#1', { mine: true })], NOW);
    expect(items).toHaveLength(1);
  });

  it('ignores a PR that is neither yours nor waiting on you', () => {
    expect(groupPulls([pr('o/r#1')], NOW)).toEqual([]);
  });

  it('makes the repo, author and number searchable', () => {
    const items = groupPulls([pr('o/r#42', { mine: true, author: 'ada' })], NOW);
    expect(items[0].keywords).toEqual(['o/r', 'ada', '42']);
  });
});

describe('prGlyph', () => {
  it('marks a review request as needing attention', () => {
    expect(prGlyph(pr('o/r#1', { reviewRequested: true }))).toBe('attention');
  });

  // A draft is explicitly not ready; lighting it up would train you to ignore the
  // colour that matters.
  it('mutes a draft even when a review is requested on it', () => {
    expect(prGlyph(pr('o/r#1', { draft: true, reviewRequested: true }))).toBe('muted');
  });

  it('distinguishes approved from changes requested', () => {
    expect(prGlyph(pr('o/r#1', { reviewDecision: 'approved' }))).toBe('ok');
    expect(prGlyph(pr('o/r#1', { reviewDecision: 'changes_requested' }))).toBe('blocked');
  });

  it('falls back to a plain dot', () => {
    expect(prGlyph(pr('o/r#1', { mine: true }))).toBe('dot');
  });
});

describe('prBadges', () => {
  it('always ends with the age', () => {
    const badges = prBadges(pr('o/r#1', { updatedAt: NOW - 90 * MINUTE }), NOW);
    expect(badges[badges.length - 1]).toEqual({ text: '1h', kind: 'clock' });
  });

  // A green tick on every row is noise, and green is the connection dot's colour
  // rather than a UI colour in this app.
  it('chips a failure but not a pass', () => {
    expect(prBadges(pr('o/r#1', { checks: 'success' }), NOW).map((b) => b.text)).toEqual(['1m']);
    expect(prBadges(pr('o/r#1', { checks: 'failure' }), NOW).map((b) => b.text)).toContain(
      'Checks failing',
    );
  });

  it('says when a PR is a draft or has a decision', () => {
    expect(prBadges(pr('o/r#1', { draft: true }), NOW).map((b) => b.text)).toContain('Draft');
    expect(
      prBadges(pr('o/r#1', { reviewDecision: 'changes_requested' }), NOW).map((b) => b.text),
    ).toContain('Changes requested');
  });
});

describe('pinnedPull', () => {
  it('is the oldest review request', () => {
    const items = groupPulls(
      [
        pr('o/r#1', { reviewRequested: true, updatedAt: NOW - 10 * MINUTE }),
        pr('o/r#2', { reviewRequested: true, updatedAt: NOW - 60 * MINUTE }),
      ],
      NOW,
    );
    expect(pinnedPull(items)?.title).toBe('o/r#2');
  });

  it('skips a draft', () => {
    const items = groupPulls(
      [
        pr('o/r#1', { reviewRequested: true, draft: true, updatedAt: NOW - 60 * MINUTE }),
        pr('o/r#2', { reviewRequested: true, updatedAt: NOW - 10 * MINUTE }),
      ],
      NOW,
    );
    expect(pinnedPull(items)?.title).toBe('o/r#2');
  });

  // An empty pinned section is worse than none, and a plugin that always pins
  // something teaches you to stop reading the top of the list.
  it('pins nothing when nothing is waiting on you', () => {
    expect(pinnedPull(groupPulls([pr('o/r#1', { mine: true })], NOW))).toBeNull();
  });
});

describe('formatAge', () => {
  it('reports one unit', () => {
    expect(formatAge(5 * MINUTE)).toBe('5m');
    expect(formatAge(3 * 60 * MINUTE)).toBe('3h');
    expect(formatAge(3 * 24 * 60 * MINUTE)).toBe('3d');
    expect(formatAge(21 * 24 * 60 * MINUTE)).toBe('3w');
  });

  it('never goes negative on a clock that is slightly behind', () => {
    expect(formatAge(-5000)).toBe('0m');
  });
});

describe('unauthorizedOrgs', () => {
  // The whole point: an org that enforces SSO and hasn't authorised the token
  // answers with HTTP 200 and fewer results. REST still names it in the
  // membership list; GraphQL's viewer drops it. The difference is the evidence.
  it('is what REST lists and GraphQL does not', () => {
    expect(unauthorizedOrgs(['fs-webdev', 'fs-eng', 'votary'], ['fs-webdev', 'votary'])).toEqual([
      'fs-eng',
    ]);
  });

  it('is empty when everything is visible', () => {
    expect(unauthorizedOrgs(['a', 'b'], ['b', 'a'])).toEqual([]);
  });

  // Org logins are case-insensitive, and the two endpoints don't always agree
  // on casing — a false positive here would nag about a working org forever.
  it('ignores case', () => {
    expect(unauthorizedOrgs(['FS-Eng'], ['fs-eng'])).toEqual([]);
  });

  it('keeps the membership order', () => {
    expect(unauthorizedOrgs(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });
});

describe('ssoAuthorizeUrl', () => {
  // The API host is not the web host: github.com's API is on api.github.com,
  // and sending someone to api.github.com/orgs/... is a dead end.
  it('drops the api. prefix for github.com', () => {
    expect(ssoAuthorizeUrl('https://api.github.com', 'fs-eng')).toBe(
      'https://github.com/orgs/fs-eng/sso',
    );
  });

  it('drops the /api suffix for Enterprise', () => {
    expect(ssoAuthorizeUrl('https://git.example.com/api', 'acme')).toBe(
      'https://git.example.com/orgs/acme/sso',
    );
  });

  it('tolerates a trailing slash', () => {
    expect(ssoAuthorizeUrl('https://api.github.com/', 'x')).toBe(
      'https://github.com/orgs/x/sso',
    );
  });

  it('falls back to github.com rather than building a broken link', () => {
    expect(ssoAuthorizeUrl('not a url', 'x')).toBe('https://github.com/orgs/x/sso');
  });
});

describe('parsePullUrl', () => {
  // Keying on the URL shape is what keeps the scrape working across GitHub's
  // restyles: the markup around a pull request changes, this path doesn't.
  it('reads owner, repo and number from a relative link', () => {
    expect(parsePullUrl('/fs-eng/oralgen-api/pull/412')).toEqual({
      repo: 'fs-eng/oralgen-api',
      number: 412,
    });
  });

  it('reads an absolute link too', () => {
    expect(parsePullUrl('https://github.com/o/r/pull/7')).toEqual({ repo: 'o/r', number: 7 });
  });

  it('tolerates a trailing path, query or fragment', () => {
    expect(parsePullUrl('/o/r/pull/7/files')?.number).toBe(7);
    expect(parsePullUrl('/o/r/pull/7?diff=split')?.number).toBe(7);
    expect(parsePullUrl('/o/r/pull/7#issuecomment-1')?.number).toBe(7);
  });

  // The dashboard is full of links that are not pull requests.
  it('rejects anything else on the page', () => {
    expect(parsePullUrl('/o/r/issues/7')).toBeNull();
    expect(parsePullUrl('/pulls')).toBeNull();
    expect(parsePullUrl('/o/r/pull/notanumber')).toBeNull();
    expect(parsePullUrl('')).toBeNull();
  });
});

describe('pullsUrl', () => {
  it('builds a dashboard search for a host', () => {
    expect(pullsUrl('https://github.com', 'is:open is:pr')).toBe(
      'https://github.com/pulls?q=is%3Aopen%20is%3Apr',
    );
  });

  it('tolerates a trailing slash and an empty host', () => {
    expect(pullsUrl('https://git.example.com/', 'x')).toBe('https://git.example.com/pulls?q=x');
    expect(pullsUrl('', 'x')).toBe('https://github.com/pulls?q=x');
  });
});

describe('webHostFor', () => {
  // An account switched from token to browser can still be carrying an API
  // root, and https://api.github.com/login is a 404, not a sign-in page.
  it('folds an API root back to the site a browser visits', () => {
    expect(webHostFor('https://api.github.com')).toBe('https://github.com');
    expect(webHostFor('https://git.example.com/api')).toBe('https://git.example.com');
  });

  it('leaves a web host alone', () => {
    expect(webHostFor('https://github.com')).toBe('https://github.com');
    expect(webHostFor('https://git.example.com')).toBe('https://git.example.com');
  });

  it('tolerates a trailing slash, and falls back rather than build a 404', () => {
    expect(webHostFor('https://github.com/')).toBe('https://github.com');
    expect(webHostFor('nonsense')).toBe('https://github.com');
  });
});
