import { describe, expect, it } from 'vitest';
import {
  HARNESS_SERVER_NAME,
  pointsAtUs,
  registeredName,
  withServer,
  withoutServer,
} from './harness';

const url = (port: number, path = '/api/mcp'): string => `http://localhost:${port}${path}`;

describe('pointsAtUs', () => {
  it('accepts both served paths, on either spelling of loopback', () => {
    expect(pointsAtUs('http://localhost:4100/api/mcp', 4100)).toBe(true);
    expect(pointsAtUs('http://127.0.0.1:4100/mcp', 4100)).toBe(true);
    expect(pointsAtUs('http://[::1]:4100/mcp', 4100)).toBe(true);
  });

  it('rejects another port, another host, another path', () => {
    expect(pointsAtUs('http://localhost:4200/api/mcp', 4100)).toBe(false);
    expect(pointsAtUs('http://example.com:4100/api/mcp', 4100)).toBe(false);
    expect(pointsAtUs('http://localhost:4100/something', 4100)).toBe(false);
  });

  it('rejects anything that isn\'t a url', () => {
    expect(pointsAtUs(undefined, 4100)).toBe(false);
    expect(pointsAtUs('nonsense', 4100)).toBe(false);
    expect(pointsAtUs(42, 4100)).toBe(false);
  });
});

describe('registeredName', () => {
  it('finds us by destination, whatever the user called us', () => {
    const config = { mcpServers: { 'jira-timer': { type: 'http', url: url(4100) } } };
    expect(registeredName(config, 4100)).toBe('jira-timer');
  });

  it('is null when nothing points at this port', () => {
    const config = { mcpServers: { 'j-time': { type: 'http', url: url(4100) } } };
    expect(registeredName(config, 4200)).toBe(null);
  });

  it('tolerates a config with no servers at all', () => {
    expect(registeredName({}, 4100)).toBe(null);
    expect(registeredName(null, 4100)).toBe(null);
    expect(registeredName({ mcpServers: 'nonsense' }, 4100)).toBe(null);
  });
});

describe('withServer', () => {
  it('leaves every other key, and every other server, alone', () => {
    const config = {
      numStartups: 12,
      mcpServers: { other: { type: 'http', url: 'http://localhost:9/mcp' } },
    };
    const next = withServer(config, url(4100), 4100);
    expect(next.numStartups).toBe(12);
    expect(next.mcpServers).toEqual({
      other: { type: 'http', url: 'http://localhost:9/mcp' },
      [HARNESS_SERVER_NAME]: { type: 'http', url: url(4100) },
    });
  });

  it('rewrites an existing registration in place rather than adding a second', () => {
    const config = { mcpServers: { 'jira-timer': { type: 'http', url: url(4100, '/mcp') } } };
    const next = withServer(config, url(4100), 4100);
    expect(next.mcpServers).toEqual({ 'jira-timer': { type: 'http', url: url(4100) } });
  });

  it('writes into a config file that does not exist yet', () => {
    expect(withServer(null, url(4100), 4100)).toEqual({
      mcpServers: { [HARNESS_SERVER_NAME]: { type: 'http', url: url(4100) } },
    });
  });
});

describe('withoutServer', () => {
  it('drops every entry pointing at us, under any name', () => {
    const config = {
      hasCompletedOnboarding: true,
      mcpServers: {
        'jira-timer': { type: 'http', url: url(4100, '/mcp') },
        'j-time': { type: 'http', url: url(4100) },
        keep: { type: 'http', url: 'http://localhost:9/mcp' },
      },
    };
    const next = withoutServer(config, 4100);
    expect(next.hasCompletedOnboarding).toBe(true);
    expect(next.mcpServers).toEqual({ keep: { type: 'http', url: 'http://localhost:9/mcp' } });
  });

  it('leaves a registration on another port, which is not ours to remove', () => {
    const config = { mcpServers: { 'j-time': { type: 'http', url: url(4200) } } };
    expect(withoutServer(config, 4100).mcpServers).toEqual({
      'j-time': { type: 'http', url: url(4200) },
    });
  });
});
