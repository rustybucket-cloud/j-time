import { describe, expect, it, vi } from 'vitest';
import {
  handleRpc,
  PROTOCOL_VERSION,
  qualify,
  resolveTool,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RpcError,
  sanitiseDeclaration,
  sanitiseDeclarations,
  toolEnabled,
  toggleTool,
  toggleTools,
  toolSpec,
  type McpHandlers,
  type ToolSpec,
} from './mcp';

const TOOL: ToolSpec = {
  name: 'jira_current_timer',
  description: 'What the clock is doing.',
  inputSchema: { type: 'object', properties: {} },
};

function handlers(over: Partial<McpHandlers> = {}): McpHandlers {
  return {
    info: { name: 'j-time', version: '0.3.0' },
    instructions: 'A menu-bar launcher.',
    listTools: () => [TOOL],
    callTool: async () => ({ text: 'Nothing is running.' }),
    ...over,
  };
}

const one = async (message: unknown, over?: Partial<McpHandlers>) => {
  const out = await handleRpc(message, handlers(over));
  if (out === null || Array.isArray(out)) throw new Error('expected a single response');
  return out;
};

describe('initialize', () => {
  it('echoes a revision it can speak', async () => {
    const res = await one({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    expect((res.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
  });

  it('answers with its own revision when asked for one it cannot', async () => {
    const res = await one({ id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect((res.result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('advertises tools and nothing else, plus the instructions', async () => {
    const result = (await one({ id: 1, method: 'initialize' })).result as Record<string, unknown>;
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.instructions).toBe('A menu-bar launcher.');
    expect(result.serverInfo).toEqual({ name: 'j-time', version: '0.3.0' });
  });
});

describe('dispatch', () => {
  it('lists tools', async () => {
    const res = await one({ id: 2, method: 'tools/list' });
    expect(res.result).toEqual({ tools: [TOOL] });
  });

  it('wraps a tool result as content', async () => {
    const res = await one({ id: 3, method: 'tools/call', params: { name: 'jira_current_timer' } });
    expect(res.result).toEqual({ content: [{ type: 'text', text: 'Nothing is running.' }] });
  });

  it('passes the arguments through as an object, defaulting to an empty one', async () => {
    const callTool = vi.fn(async () => ({ text: 'ok' }));
    await one({ id: 4, method: 'tools/call', params: { name: 't', arguments: { key: 'AB-1' } } }, { callTool });
    await one({ id: 5, method: 'tools/call', params: { name: 't' } }, { callTool });
    expect(callTool.mock.calls).toEqual([
      ['t', { key: 'AB-1' }],
      ['t', {}],
    ]);
  });

  it('reports a tool that ran and failed as a result, not an error', async () => {
    const res = await one(
      { id: 6, method: 'tools/call', params: { name: 't' } },
      { callTool: async () => ({ text: 'JIRA said no', isError: true }) },
    );
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ content: [{ type: 'text', text: 'JIRA said no' }], isError: true });
  });

  it('reports a tool that does not exist as a protocol error', async () => {
    const res = await one(
      { id: 7, method: 'tools/call', params: { name: 'nope' } },
      {
        callTool: async () => {
          throw new RpcError(RPC_INVALID_PARAMS, 'No such tool: nope');
        },
      },
    );
    expect(res.error?.code).toBe(RPC_INVALID_PARAMS);
  });

  it('needs a tool name', async () => {
    const res = await one({ id: 8, method: 'tools/call', params: {} });
    expect(res.error?.code).toBe(RPC_INVALID_PARAMS);
  });

  it('answers ping with an empty result', async () => {
    expect((await one({ id: 9, method: 'ping' })).result).toEqual({});
  });

  it('rejects an unknown method', async () => {
    expect((await one({ id: 10, method: 'resources/list' })).error?.code).toBe(RPC_METHOD_NOT_FOUND);
  });

  it('turns a thrown error into an internal error rather than losing it', async () => {
    const res = await one(
      { id: 11, method: 'tools/call', params: { name: 't' } },
      {
        callTool: async () => {
          throw new Error('the socket closed');
        },
      },
    );
    expect(res.error?.message).toBe('the socket closed');
  });
});

describe('notifications and batches', () => {
  it('says nothing at all to a message with no id', async () => {
    expect(await handleRpc({ method: 'notifications/initialized' }, handlers())).toBeNull();
  });

  it('answers only the requests in a batch', async () => {
    const out = await handleRpc(
      [{ id: 1, method: 'ping' }, { method: 'notifications/initialized' }, { id: 2, method: 'ping' }],
      handlers(),
    );
    expect(Array.isArray(out) && out.map((r) => r.id)).toEqual([1, 2]);
  });

  it('rejects an empty batch and a non-object message', async () => {
    expect((await handleRpc([], handlers()) as { error: { code: number } }).error.code).toBe(
      RPC_INVALID_REQUEST,
    );
    expect((await one('hello')).error?.code).toBe(RPC_INVALID_REQUEST);
  });

  it('rejects a request with no method, but stays silent when it was a notification', async () => {
    expect((await one({ id: 1 })).error?.code).toBe(RPC_INVALID_REQUEST);
    expect(await handleRpc({ params: {} }, handlers())).toBeNull();
  });
});

describe('names', () => {
  it('prefixes a tool with its plugin, underscoring the dashes in an id', () => {
    expect(qualify('jira', 'start_timer')).toBe('jira_start_timer');
    expect(qualify('my-notes', 'search')).toBe('my_notes_search');
  });

  it('resolves a qualified name back to its plugin and tool', () => {
    expect(resolveTool('jira_start_timer', ['jira', 'claude'])).toEqual({
      plugin: 'jira',
      tool: 'start_timer',
    });
    expect(resolveTool('my_notes_search', ['my-notes'])).toEqual({
      plugin: 'my-notes',
      tool: 'search',
    });
  });

  it('gives an ambiguous name to the longest prefix that claims it', () => {
    expect(resolveTool('claude_code_sessions', ['claude', 'claude-code'])).toEqual({
      plugin: 'claude-code',
      tool: 'sessions',
    });
  });

  it('resolves nothing for an unknown plugin, or a prefix with no tool after it', () => {
    expect(resolveTool('github_prs', ['jira'])).toBeNull();
    expect(resolveTool('jira_', ['jira'])).toBeNull();
  });
});

describe('which tools are served', () => {
  it('treats a tool nobody has switched off as on, so a new one arrives working', () => {
    expect(toolEnabled([], 'jira_file_time')).toBe(true);
    expect(toolEnabled(['jira_finish_story'], 'jira_file_time')).toBe(true);
    expect(toolEnabled(['jira_file_time'], 'jira_file_time')).toBe(false);
  });

  it('stores the exceptions, and stores each of them once', () => {
    let off = toggleTool([], 'jira_file_time', false);
    expect(off).toEqual(['jira_file_time']);
    off = toggleTool(off, 'jira_file_time', false);
    expect(off).toEqual(['jira_file_time']);
    expect(toggleTool(off, 'jira_file_time', true)).toEqual([]);
  });

  it('leaves other plugins alone when one of them is switched off', () => {
    const off = toggleTool(['claude_list_sessions'], 'jira_file_time', false);
    expect(off).toEqual(['claude_list_sessions', 'jira_file_time']);
    expect(toggleTool(off, 'jira_file_time', true)).toEqual(['claude_list_sessions']);
  });

  it('switches a whole plugin off and on without disturbing the rest', () => {
    const jira = ['jira_start_timer', 'jira_file_time'];
    const off = toggleTools(['claude_list_sessions'], jira, false);
    expect(off).toEqual(['claude_list_sessions', ...jira]);
    expect(toggleTools(off, jira, true)).toEqual(['claude_list_sessions']);
  });

  it('keeps a name whose tool is not loaded right now', () => {
    // A plugin can be unloaded for an afternoon — a main.js mid-edit — and
    // turning its tool back on behind the user's back would be worse than a
    // stale entry nobody sees.
    const off = toggleTool(['bookmarks_search'], 'jira_file_time', false);
    expect(off).toContain('bookmarks_search');
  });
});

describe('sanitiseDeclaration', () => {
  it('needs a usable name and a description', () => {
    expect(sanitiseDeclaration({ name: 'ok', description: 'Does a thing.' })).toEqual({
      name: 'ok',
      description: 'Does a thing.',
    });
    expect(sanitiseDeclaration({ name: 'Not Ok', description: 'x' })).toBeNull();
    expect(sanitiseDeclaration({ name: 'has-dash', description: 'x' })).toBeNull();
    expect(sanitiseDeclaration({ name: 'ok', description: '   ' })).toBeNull();
    expect(sanitiseDeclaration({ description: 'no name' })).toBeNull();
    expect(sanitiseDeclaration('junk')).toBeNull();
  });

  it('keeps only properties that are schemas of their own', () => {
    const out = sanitiseDeclaration({
      name: 'search',
      description: 'Search.',
      input: { q: { type: 'string' }, bad: 'string' },
    });
    expect(out?.input).toEqual({ q: { type: 'string' } });
  });

  it('drops required names the input does not declare', () => {
    const out = sanitiseDeclaration({
      name: 'search',
      description: 'Search.',
      input: { q: { type: 'string' } },
      required: ['q', 'missing', 7],
    });
    expect(out?.required).toEqual(['q']);
  });

  it('keeps the two hints, and only when they are true', () => {
    const out = sanitiseDeclaration({
      name: 'wipe',
      description: 'Wipes.',
      readOnly: 'yes',
      destructive: true,
    });
    expect(out).toEqual({ name: 'wipe', description: 'Wipes.', destructive: true });
  });

  it('keeps the first of two tools by the same name, since the second is unaddressable', () => {
    const out = sanitiseDeclarations([
      { name: 'a', description: 'first' },
      { name: 'a', description: 'second' },
      { name: 'b', description: 'other' },
    ]);
    expect(out.map((t) => t.description)).toEqual(['first', 'other']);
  });

  it('is empty for anything that is not an array', () => {
    expect(sanitiseDeclarations({ name: 'a', description: 'b' })).toEqual([]);
    expect(sanitiseDeclarations(undefined)).toEqual([]);
  });
});

describe('toolSpec', () => {
  it('builds the object schema MCP wants around the declared properties', () => {
    const spec = toolSpec('jira', 'JIRA', {
      name: 'story_time',
      description: 'One story.',
      input: { key: { type: 'string' } },
      required: ['key'],
      readOnly: true,
    });
    expect(spec.name).toBe('jira_story_time');
    expect(spec.inputSchema).toEqual({
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    });
    expect(spec.annotations).toEqual({
      title: 'JIRA: story time',
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it('gives a tool with no arguments an empty object schema rather than none', () => {
    const spec = toolSpec('claude', 'Claude Code', { name: 'list', description: 'Lists.' });
    expect(spec.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});
