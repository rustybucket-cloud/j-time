import { describe, it, expect } from 'vitest';
import {
  accountName,
  defaultGithubConfig,
  GITHUB_HOST,
  githubConfigured,
  GITHUB_WEB,
  normalizeGithubConfig,
} from './github';

describe('normalizeGithubConfig', () => {
  // Nobody should have to paste a credential again because the plugin learned
  // to hold two of them.
  it('turns a one-token config into account one', () => {
    const config = normalizeGithubConfig({
      host: 'https://api.github.com',
      token: 'ghp_x',
      limit: 25,
    });
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0].token).toBe('ghp_x');
    expect(config.accounts[0].host).toBe(GITHUB_HOST);
  });

  it('prefers a real account list over a leftover top-level token', () => {
    const config = normalizeGithubConfig({
      token: 'stale',
      accounts: [{ id: 'a1', label: 'Work', kind: 'token' as const, host: GITHUB_HOST, token: 'fresh' }],
    });
    expect(config.accounts.map((a) => a.token)).toEqual(['fresh']);
  });

  it('keeps several accounts, each with its own host', () => {
    const config = normalizeGithubConfig({
      accounts: [
        { id: 'a1', label: 'Personal', kind: 'token' as const, host: GITHUB_HOST, token: 't1' },
        { id: 'a2', label: 'Work', kind: 'token' as const, host: 'https://git.example.com/api', token: 't2' },
      ],
    });
    expect(config.accounts.map((a) => a.host)).toEqual([
      GITHUB_HOST,
      'https://git.example.com/api',
    ]);
  });

  it('defaults a missing host and strips a trailing slash', () => {
    const config = normalizeGithubConfig({
      accounts: [{ token: 't', host: 'https://git.example.com/api/' } as never],
    });
    expect(config.accounts[0].host).toBe('https://git.example.com/api');
  });

  it('gives an account an id when the file has none', () => {
    const config = normalizeGithubConfig({ accounts: [{ token: 't' } as never] });
    expect(config.accounts[0].id).toBe('a1');
  });

  // The editor starts a row before it has anything in it.
  it('drops a row that is neither named nor credentialled', () => {
    const config = normalizeGithubConfig({
      accounts: [
        { id: 'a1', label: '', kind: 'token' as const, host: GITHUB_HOST, token: '' },
        { id: 'a2', label: 'Work', kind: 'token' as const, host: GITHUB_HOST, token: '' },
      ],
    });
    expect(config.accounts.map((a) => a.id)).toEqual(['a2']);
  });

  it('clamps the limit into what GitHub will accept', () => {
    expect(normalizeGithubConfig({ limit: 0 }).limit).toBe(1);
    expect(normalizeGithubConfig({ limit: 5000 }).limit).toBe(100);
    expect(normalizeGithubConfig({}).limit).toBe(25);
  });

  it('survives an empty file', () => {
    expect(normalizeGithubConfig({})).toEqual(defaultGithubConfig());
  });
});

describe('accountName', () => {
  it('prefers the label, then the login', () => {
    expect(accountName({ label: 'Work', id: 'a1' }, 'dana')).toBe('Work');
    expect(accountName({ label: '', id: 'a1' }, 'dana')).toBe('dana');
    expect(accountName({ label: '', id: 'a1' }, null)).toBe('Account a1');
  });
});

describe('githubConfigured', () => {
  it('needs at least one account with a token', () => {
    expect(githubConfigured({ limit: 25, accounts: [] })).toBe(false);
    expect(
      githubConfigured({
        limit: 25,
        accounts: [{ id: 'a1', label: '', kind: 'token' as const, host: GITHUB_HOST, hasToken: false }],
      }),
    ).toBe(false);
    expect(
      githubConfigured({
        limit: 25,
        accounts: [{ id: 'a1', label: '', kind: 'token' as const, host: GITHUB_HOST, hasToken: true }],
      }),
    ).toBe(true);
  });
});

describe('normalizeGithubConfig, browser accounts', () => {
  // An account written before there was more than one way to sign in.
  it('treats a config with no kind as a token account', () => {
    expect(normalizeGithubConfig({ accounts: [{ token: 't' } as never] }).accounts[0].kind).toBe(
      'token',
    );
  });

  // A browser account is real before it has signed in — signing in is the next
  // thing it does, and it can't do that if the config drops it first.
  it('keeps a browser account that has no credential yet', () => {
    const config = normalizeGithubConfig({
      accounts: [{ id: 'a1', label: '', kind: 'browser', host: '', token: '' } as never],
    });
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0].host).toBe(GITHUB_WEB);
  });

  // The host means different things per kind: an API root for one, the site you
  // sign in to for the other.
  it('defaults a browser account to the web host, not the API host', () => {
    const config = normalizeGithubConfig({
      accounts: [
        { id: 'a1', label: 'Work', kind: 'browser', token: '' } as never,
        { id: 'a2', label: 'Personal', kind: 'token', token: 't' } as never,
      ],
    });
    expect(config.accounts.map((a) => a.host)).toEqual([GITHUB_WEB, GITHUB_HOST]);
  });

  it('never keeps a token on a browser account', () => {
    const config = normalizeGithubConfig({
      accounts: [{ id: 'a1', label: 'W', kind: 'browser', token: 'leftover' } as never],
    });
    expect(config.accounts[0].token).toBe('');
  });

  it('counts a browser account as configured before it has signed in', () => {
    expect(
      githubConfigured({
        limit: 25,
        accounts: [{ id: 'a1', label: 'W', kind: 'browser', host: GITHUB_WEB, hasToken: false }],
      }),
    ).toBe(true);
  });
});
