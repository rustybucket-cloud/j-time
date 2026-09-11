/**
 * The MCP endpoint, served by the app itself.
 *
 * Inside the running app rather than as a stdio sidecar, for the same reason the
 * renderer never touches disk: there has to be one of everything. j-time is
 * already the process that holds the credentials, owns `state.json` and knows
 * what the clock is doing — a second process answering MCP calls would be a
 * second writer racing the first, and it could not see a timer that is running
 * in this one.
 *
 * Loopback only, and POST only. There is no session to resume and no
 * server-initiated stream, so the transport's other two verbs are declined
 * rather than left hanging: a client waiting on an SSE stream that will never
 * open looks exactly like a server that is down.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { app } from 'electron';
import {
  handleRpc,
  mcpUrl,
  MCP_PATHS,
  PROTOCOL_VERSION,
  RPC_INVALID_PARAMS,
  RPC_PARSE_ERROR,
  RpcError,
  type McpConfig,
  type McpStatus,
} from '@shared/mcp';
import * as shell from './shell';

/** Enough for any tool call; a body larger than this is a mistake or an attack. */
const MAX_BODY = 1_000_000;

const SERVER_NAME = 'j-time';

/**
 * What the client is told once, at initialize.
 *
 * The shell's half only: every tool is named `<plugin>_<tool>`, and which
 * plugins exist is up to the user. What a particular tool means is that tool's
 * description to give.
 */
const INSTRUCTIONS = [
  'j-time is a menu-bar launcher on this machine, hosting a plugin per app. Its',
  'tools are named for the plugin they belong to: jira_*, claude_*, and one prefix',
  'per plugin the user has installed in ~/.j-time/plugins.',
  '',
  'The tools read and act on what the user is actually looking at — the board in',
  "front of them, the clock that is running now. Tools flagged as destructive write",
  'to a real service; do not call them speculatively, and never to tidy something',
  'up the user has not asked you to.',
].join('\n');

let server: Server | null = null;
/** The port we are on, or trying to be on, for the status the renderer reads. */
let current: McpConfig = { enabled: false, port: 0, disabled: [] };

function report(listening: boolean, error: string | null): void {
  const status: McpStatus = {
    listening,
    port: current.port,
    url: mcpUrl(current.port),
    error,
    // Filled in by the shell, which is the one that knows the plugins.
    tools: [],
  };
  shell.setMcpStatus(status);
}

/**
 * Refuse a cross-origin request, the way the spec asks.
 *
 * A browser on any page can POST to localhost; what it cannot do is forge the
 * Origin header. A request with no Origin at all is a local client — that is
 * every MCP client there is — so the check is on the header being *wrong*, not
 * on it being absent.
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0].replace(/\/$/, '') || '/';
  if (!(MCP_PATHS as readonly string[]).includes(path)) {
    return send(res, 404, { error: `Not found. The MCP endpoint is ${MCP_PATHS.join(' or ')}.` });
  }
  if (!originAllowed(req.headers.origin)) {
    return send(res, 403, { error: 'Cross-origin requests are not accepted.' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, {
      error: 'This server only accepts POST — it opens no SSE stream and keeps no session.',
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: RPC_PARSE_ERROR, message: 'Invalid JSON' },
    });
  }

  const response = await handleRpc(payload, {
    info: { name: SERVER_NAME, version: app.getVersion() },
    instructions: INSTRUCTIONS,
    listTools: () => shell.mcpServedTools(),
    async callTool(name, args) {
      const result = await shell.callMcpTool(name, args);
      // A tool that isn't there is the caller asking for something that doesn't
      // exist — a protocol error. A tool that ran and failed is a result.
      if (!result) throw new RpcError(RPC_INVALID_PARAMS, `No such tool: ${name}`);
      return result;
    },
  });

  // Every message was a notification. The spec wants 202 and an empty body.
  if (response === null) return send(res, 202, null);
  send(res, 200, response);
}

/** Stop listening, if we are. Safe to call when we aren't. */
export function stopMcp(): Promise<void> {
  const listening = server;
  server = null;
  if (!listening) return Promise.resolve();
  return new Promise((resolve) => listening.close(() => resolve()));
}

/**
 * Bring the endpoint up, or take it down, to match the config.
 *
 * A port already in use is reported rather than thrown: it is the hotkey problem
 * again — the only symptom is a client that cannot connect, which reads as a
 * broken app rather than as a number to change in Settings. The usual cause is
 * j-time's own predecessor still running on 4100.
 */
export async function startMcp(config: McpConfig): Promise<void> {
  await stopMcp();
  current = config;

  if (!config.enabled) {
    report(false, null);
    return;
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    report(false, `${config.port} is not a usable port. Pick one between 1024 and 65535.`);
    return;
  }

  const next = createServer((req, res) => {
    void onRequest(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    });
  });

  next.on('error', (e: NodeJS.ErrnoException) => {
    server = null;
    next.close();
    report(
      false,
      e.code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use — something else is on it.`
        : e.message,
    );
  });

  next.listen(config.port, '127.0.0.1', () => {
    server = next;
    report(true, null);
  });
}
