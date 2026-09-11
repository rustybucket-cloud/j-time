/**
 * The MCP endpoint: JSON-RPC framing, and how a plugin's tools get their names.
 *
 * Hand-rolled rather than pulled from `@modelcontextprotocol/sdk`. What MCP needs
 * over streamable HTTP is four methods — initialize, tools/list, tools/call, ping —
 * and a notification that gets no reply; carrying a dependency tree for that would
 * be the only one in a repo that otherwise runs on electron/react. Keeping it here
 * also keeps it in `shared/`, free of `electron` and of I/O, so the dispatch is
 * unit-tested like every other rule in the app rather than only over HTTP.
 *
 * The other half of this file is the same boundary `runtime.ts` draws: a tool a
 * plugin declared is *data* until it has been checked. A runtime plugin writing
 * `name: 'Open Thing'` must cost that one tool, not the whole tool list — an MCP
 * client that rejects the list on one bad name would take every other plugin's
 * tools down with it.
 */

/** The spec revision this server implements. */
export const PROTOCOL_VERSION = '2025-06-18';

/**
 * Revisions we can speak. A client asking for one of these gets it echoed back;
 * anything else is answered with our own, which the spec allows and which lets a
 * newer client decide for itself whether to continue.
 */
const SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export const DEFAULT_MCP_PORT = 4100;

/**
 * Both paths are served. `/mcp` is what this app would have picked; `/api/mcp` is
 * where the predecessor served it, and a registration pointing there is somebody's
 * working setup — declining it would mean re-registering the server to gain
 * nothing.
 */
export const MCP_PATHS = ['/mcp', '/api/mcp'] as const;

/** The shell's own MCP settings. Loopback only, so there is no host to configure. */
export interface McpConfig {
  enabled: boolean;
  port: number;
  /**
   * Qualified names of the tools the user has turned off.
   *
   * The exceptions are stored, not the permissions — the same way `layout`
   * stores `collapsed` and `pinsOff`. A plugin that gains a tool in an upgrade
   * then arrives switched on, which is the only behaviour that doesn't need
   * every user to go and find it; and an empty list means "everything", which is
   * what a config file written before any of this existed says.
   */
  disabled: string[];
}

export const defaultMcpConfig = (): McpConfig => ({
  enabled: true,
  port: DEFAULT_MCP_PORT,
  disabled: [],
});

/** Is this tool served? */
export const toolEnabled = (disabled: string[], name: string): boolean => !disabled.includes(name);

/**
 * Flip one tool, returning the new exception list.
 *
 * Nothing prunes names whose tool is gone: a plugin can be unloaded for an
 * afternoon — a `main.js` mid-edit, credentials not pasted yet — and forgetting
 * that the user had switched its tool off would turn it back on behind them.
 */
export function toggleTool(disabled: string[], name: string, enabled: boolean): string[] {
  const without = disabled.filter((n) => n !== name);
  return enabled ? without : [...without, name];
}

/** Flip several at once — what a plugin's "all" and "none" buttons do. */
export function toggleTools(disabled: string[], names: string[], enabled: boolean): string[] {
  const set = new Set(names);
  const without = disabled.filter((n) => !set.has(n));
  return enabled ? without : [...without, ...names];
}

export const mcpUrl = (port: number): string => `http://localhost:${port}${MCP_PATHS[1]}`;

/**
 * One tool as the settings page lists it.
 *
 * Every registered tool appears, switched off ones included — a page that only
 * showed what was being served would be a page you could not switch anything
 * back on from.
 */
export interface McpToolInfo {
  /** Qualified: what a client calls, and the key the user's choice is stored by. */
  name: string;
  plugin: string;
  /** The plugin's title, for the heading it is grouped under. */
  section: string;
  description: string;
  enabled: boolean;
  readOnly: boolean;
  destructive: boolean;
}

/** What the renderer needs to say whether the endpoint is up, and what is on it. */
export interface McpStatus {
  listening: boolean;
  port: number;
  url: string;
  /** Why it isn't listening — a port already taken, usually. */
  error: string | null;
  /** Every registered tool, in registration order, served or not. */
  tools: McpToolInfo[];
}

/**
 * A failure of the *protocol* — an unknown method, malformed params. Distinct from
 * a tool that ran and failed, which is reported inside a successful result with
 * `isError` so the model can read the message and try something else. Throwing
 * this from a tool would look to the client like the server is broken.
 */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export type RpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: RpcId;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A tool as advertised by tools/list. `inputSchema` is JSON Schema, object-typed. */
export interface ToolSpec {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /** Hints, not guarantees — a client may surface them when asking for approval. */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ToolResult {
  text: string;
  /** The tool ran and failed. Reported as a result, not an RpcError — see above. */
  isError?: boolean;
}

export interface McpHandlers {
  info: { name: string; version: string };
  /** Shown to the client once, at initialize. */
  instructions?: string;
  listTools(): ToolSpec[] | Promise<ToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

function ok(id: RpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: RpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function dispatch(method: string, params: unknown, h: McpHandlers): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const asked = asRecord(params).protocolVersion;
      return {
        protocolVersion:
          typeof asked === 'string' && SUPPORTED_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
        // Only tools. No resources, prompts, sampling or logging, so they go
        // unadvertised rather than declared-and-empty, which would invite calls
        // we would only reject.
        //
        // The list genuinely does change while the app runs — reloading the
        // plugins directory is exactly that — but `listChanged` promises a
        // *notification*, and this transport is POST-only with no stream to send
        // one down. So it stays false, and a client that reloaded its plugins
        // reconnects to see them.
        capabilities: { tools: { listChanged: false } },
        serverInfo: h.info,
        ...(h.instructions ? { instructions: h.instructions } : {}),
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      // No pagination: a handful of plugins' worth of tools, so a nextCursor would
      // only ever be absent. Clients treat a missing cursor as "that's all".
      return { tools: await h.listTools() };
    case 'tools/call': {
      const p = asRecord(params);
      const name = p.name;
      if (typeof name !== 'string' || !name) {
        throw new RpcError(RPC_INVALID_PARAMS, 'tools/call requires a tool name');
      }
      const { text, isError } = await h.callTool(name, asRecord(p.arguments));
      return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
    }
    default:
      throw new RpcError(RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

async function respond(raw: unknown, h: McpHandlers): Promise<JsonRpcResponse | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(null, RPC_INVALID_REQUEST, 'Request must be a JSON-RPC object');
  }
  const req = raw as JsonRpcRequest;

  // No `id` means a notification: the client wants no reply, not even to an error.
  // `notifications/initialized` is the one that actually arrives; the rest are
  // ignored for the same reason.
  const isNotification = req.id === undefined;
  const id = req.id ?? null;

  if (typeof req.method !== 'string') {
    return isNotification ? null : fail(id, RPC_INVALID_REQUEST, 'Request must have a method');
  }
  if (isNotification) return null;

  try {
    return ok(id, await dispatch(req.method, req.params, h));
  } catch (e: unknown) {
    if (e instanceof RpcError) return fail(id, e.code, e.message, e.data);
    return fail(id, RPC_INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Turn a parsed request body into the response to send back, or null when there is
 * nothing to send — every message in it was a notification, which the transport
 * answers with 202 and an empty body.
 *
 * Arrays are accepted because clients built against the 2025-03-26 revision may
 * still batch; the current one dropped it.
 */
export async function handleRpc(
  payload: unknown,
  h: McpHandlers,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return fail(null, RPC_INVALID_REQUEST, 'Batch must not be empty');
    }
    const out = (await Promise.all(payload.map((m) => respond(m, h)))).filter(
      (r): r is JsonRpcResponse => r !== null,
    );
    return out.length > 0 ? out : null;
  }
  return respond(payload, h);
}

// --- What a plugin declares, and what the shell does with it ---

/**
 * One tool, as a plugin describes it.
 *
 * `input` is JSON Schema properties rather than a whole schema: every MCP tool's
 * schema is an object at the top, so making each plugin write that wrapper would
 * be four copies of the same two lines waiting to be got wrong.
 *
 * The name is the plugin's alone — the shell prefixes it, so two plugins may both
 * declare `status` without either knowing the other exists.
 */
export interface ToolDeclaration {
  name: string;
  description: string;
  input?: Record<string, unknown>;
  required?: string[];
  /** Reads and does not write. Lets a client skip an approval prompt. */
  readOnly?: boolean;
  /** Writes something a person would want to be asked about first. */
  destructive?: boolean;
}

/**
 * What a tool name may be, before the shell's prefix.
 *
 * Lowercase and underscores only, which is narrower than MCP allows. A tool name
 * is something a model types from a list, and `file_time` next to `list-stories`
 * is a mixed convention that only ever costs a retry.
 */
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;

/** A plugin id as it appears in a tool name. Ids may hold dashes; tool names don't. */
const prefixOf = (pluginId: string): string => pluginId.replace(/-/g, '_');

/** `jira` + `start_timer` → `jira_start_timer`. */
export const qualify = (pluginId: string, name: string): string =>
  `${prefixOf(pluginId)}_${name}`;

/**
 * Which plugin a qualified name belongs to, and what it calls the tool.
 *
 * Longest prefix first: `claude` and `claude_code` would otherwise both claim
 * `claude_code_sessions`, and the wrong one answers.
 */
export function resolveTool(
  qualified: string,
  pluginIds: string[],
): { plugin: string; tool: string } | null {
  const candidates = [...pluginIds].sort((a, b) => prefixOf(b).length - prefixOf(a).length);
  for (const id of candidates) {
    const prefix = `${prefixOf(id)}_`;
    if (qualified.startsWith(prefix)) {
      const tool = qualified.slice(prefix.length);
      if (tool) return { plugin: id, tool };
    }
  }
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A declaration with every field checked, or null when it can't be a tool.
 *
 * A name and a description are the minimum: an unnamed tool can't be called, and
 * an undescribed one won't be — the description is the only thing a model has to
 * go on. Anything else of the wrong shape is dropped, so a bad `required` costs
 * the argument list, not the tool.
 */
export function sanitiseDeclaration(v: unknown): ToolDeclaration | null {
  if (!isRecord(v)) return null;
  const name = typeof v.name === 'string' ? v.name : '';
  const description = typeof v.description === 'string' ? v.description.trim() : '';
  if (!TOOL_NAME.test(name) || !description) return null;
  const out: ToolDeclaration = { name, description };
  if (isRecord(v.input)) {
    // Each property has to be a schema of its own; a string where an object
    // belongs would make the whole schema invalid for the client.
    const input = Object.fromEntries(Object.entries(v.input).filter(([, s]) => isRecord(s)));
    if (Object.keys(input).length) out.input = input;
  }
  if (Array.isArray(v.required)) {
    // Required names that aren't in `input` would have the client refuse to call
    // a tool it can never satisfy.
    const required = v.required.filter(
      (k): k is string => typeof k === 'string' && Boolean(out.input && k in out.input),
    );
    if (required.length) out.required = required;
  }
  if (v.readOnly === true) out.readOnly = true;
  if (v.destructive === true) out.destructive = true;
  return out;
}

export function sanitiseDeclarations(v: unknown): ToolDeclaration[] {
  if (!Array.isArray(v)) return [];
  const out: ToolDeclaration[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const tool = sanitiseDeclaration(item);
    // A second tool by the same name would be unaddressable, so the first wins.
    if (!tool || seen.has(tool.name)) continue;
    seen.add(tool.name);
    out.push(tool);
  }
  return out;
}

/** A declaration as the wire wants it: namespaced, with the object schema built. */
export function toolSpec(pluginId: string, title: string, d: ToolDeclaration): ToolSpec {
  return {
    name: qualify(pluginId, d.name),
    description: d.description,
    inputSchema: {
      type: 'object',
      properties: d.input ?? {},
      ...(d.required?.length ? { required: d.required } : {}),
    },
    annotations: {
      // The section's own name, so a client's approval prompt says where the tool
      // came from rather than only what it is called.
      title: `${title}: ${d.name.replace(/_/g, ' ')}`,
      readOnlyHint: d.readOnly === true,
      destructiveHint: d.destructive === true,
    },
  };
}
