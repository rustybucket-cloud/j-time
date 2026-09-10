import { describe, it, expect } from 'vitest';
import {
  connDotClass,
  connMessage,
  defaultConfig,
  missingCreds,
  reasonForStatus,
  type MyselfResult,
} from './conn';

const conn = (over: Partial<MyselfResult>): MyselfResult => ({
  ok: false,
  status: 0,
  reason: 'unconfigured',
  missing: [],
  baseUrl: null,
  ...over,
});

describe('missingCreds', () => {
  it('reports every field on a blank config', () => {
    expect(missingCreds(defaultConfig())).toEqual(['baseUrl', 'email', 'apiToken']);
  });

  it('accepts a fully filled config', () => {
    const cfg = { baseUrl: 'https://acme.atlassian.net', email: 'a@b.c', apiToken: 'tok' };
    expect(missingCreds(cfg)).toEqual([]);
  });

  it('treats whitespace as absent', () => {
    const cfg = { baseUrl: 'https://acme.atlassian.net', email: '   ', apiToken: 'tok' };
    expect(missingCreds(cfg)).toEqual(['email']);
  });

  // A half-filled config should send you to Settings, not to a confusing 401.
  it('treats the documented placeholders as unset', () => {
    const cfg = {
      baseUrl: 'https://your-org.atlassian.net',
      email: 'you@example.com',
      apiToken: 'paste-your-token-here',
    };
    expect(missingCreds(cfg)).toEqual(['baseUrl', 'email', 'apiToken']);
  });

  it('reports fields in a stable order regardless of which are set', () => {
    expect(missingCreds({ email: 'a@b.c' })).toEqual(['baseUrl', 'apiToken']);
  });
});

describe('reasonForStatus', () => {
  it('maps 2xx to ok', () => {
    expect(reasonForStatus(200)).toBe('ok');
    expect(reasonForStatus(204)).toBe('ok');
  });

  it('maps auth failures to rejected', () => {
    expect(reasonForStatus(401)).toBe('rejected');
    expect(reasonForStatus(403)).toBe('rejected');
  });

  // 0 is what a thrown fetch reports: DNS failure, refused connection, offline.
  it('maps everything else to unreachable', () => {
    expect(reasonForStatus(0)).toBe('unreachable');
    expect(reasonForStatus(404)).toBe('unreachable');
    expect(reasonForStatus(500)).toBe('unreachable');
  });
});

describe('connMessage', () => {
  // The panel opens before the first getMyself lands, and every other reason is a
  // failure — so an unanswered check must not read as one.
  it('says it is still checking before the first answer', () => {
    expect(connMessage(conn({ reason: 'checking' }))).toBe('Checking your JIRA connection…');
  });

  it('names the connected user', () => {
    expect(connMessage(conn({ ok: true, reason: 'ok', name: 'Ada' }))).toBe('Connected as Ada');
  });

  it('names the missing fields in words, not variable names', () => {
    const msg = connMessage(conn({ reason: 'unconfigured', missing: ['baseUrl', 'apiToken'] }));
    expect(msg).toBe('Not set up — missing JIRA URL, API token');
  });

  it('points at the credentials when JIRA rejects them', () => {
    expect(connMessage(conn({ reason: 'rejected', status: 401 }))).toMatch(/API token/);
  });

  it('names the host it could not reach', () => {
    const msg = connMessage(conn({ reason: 'unreachable', baseUrl: 'https://acme.atlassian.net' }));
    expect(msg).toBe("Can't reach https://acme.atlassian.net");
  });
});

describe('connDotClass', () => {
  it('is green connected and red on every failure', () => {
    expect(connDotClass(conn({ ok: true, reason: 'ok' }))).toBe('ok');
    expect(connDotClass(conn({ reason: 'unconfigured' }))).toBe('bad');
    expect(connDotClass(conn({ reason: 'rejected', status: 401 }))).toBe('bad');
    expect(connDotClass(conn({ reason: 'unreachable' }))).toBe('bad');
  });

  // Neither colour: a pending check is not a rejection.
  it('leaves the dot neutral while the check is out', () => {
    expect(connDotClass(conn({ reason: 'checking' }))).toBe('');
  });
});
