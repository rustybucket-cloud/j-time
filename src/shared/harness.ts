/**
 * Registering this app's MCP endpoint with the clients that would call it.
 *
 * A loopback server nobody has been told about answers nothing, and the gap
 * between "listening" and "usable" is a JSON file in another app's home
 * directory that the user is expected to edit by hand. The settings page already
 * offers the `claude mcp add` line to copy; this is the same registration
 * without the terminal.
 *
 * Pure, like everything else in `shared/`: a harness is described here and its
 * file is folded here, and `main/harness.ts` is the only part that reads or
 * writes a disk. Claude Code is the only harness so far — the shape is a list
 * because the next one is a descriptor and a path, not a second design.
 */

import { MCP_PATHS } from './mcp';

/** The name we register under, when we are the ones creating the entry. */
export const HARNESS_SERVER_NAME = 'j-time';

export interface Harness {
  id: string;
  title: string;
  /** Where the registration lives, for the page to say what it is about to edit. */
  what: string;
}

export const HARNESSES: Harness[] = [
  {
    id: 'claude-code',
    title: 'Claude Code',
    what: '~/.claude.json — every project, the way `claude mcp add -s user` writes it',
  },
];

/** What the settings page draws: one harness, and whether we are in its config. */
export interface HarnessStatus {
  id: string;
  title: string;
  what: string;
  /** The file we would edit, expanded — the page shows it, errors quote it. */
  path: string;
  /** The name our endpoint is registered under there, or null if it isn't. */
  name: string | null;
  /** Why we could not tell. A harness that isn't installed at all is not an error. */
  error: string | null;
}

/** An http MCP server, as every client that speaks this transport records one. */
export interface HarnessEntry {
  type: 'http';
  url: string;
}

export const harnessEntry = (url: string): HarnessEntry => ({ type: 'http', url });

/**
 * Is this registration ours?
 *
 * By destination rather than by name: the endpoint has one URL, and an entry the
 * user added themselves under some other name — `jira-timer`, from before this
 * app was called j-time — is the same registration and must not end up
 * duplicated by a button that only looked for `j-time`. Both served paths count,
 * for the reason `MCP_PATHS` has two.
 */
export function pointsAtUs(url: unknown, port: number): boolean {
  if (typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return false;
  if (Number(parsed.port) !== port) return false;
  const path = parsed.pathname.replace(/\/$/, '');
  return (MCP_PATHS as readonly string[]).includes(path);
}

function servers(config: unknown): Record<string, unknown> {
  const root = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  const found = root.mcpServers;
  return found && typeof found === 'object' && !Array.isArray(found)
    ? (found as Record<string, unknown>)
    : {};
}

/** The name our endpoint is registered under in this config, or null. */
export function registeredName(config: unknown, port: number): string | null {
  for (const [name, entry] of Object.entries(servers(config))) {
    const url = entry && typeof entry === 'object' ? (entry as { url?: unknown }).url : undefined;
    if (pointsAtUs(url, port)) return name;
  }
  return null;
}

/**
 * Add the registration, leaving everything else in the file alone.
 *
 * The whole config is spread through rather than rebuilt: this is the client's
 * own file, holding its onboarding state and a record per project, and a button
 * in another app has no business discarding a key it doesn't recognise. An
 * entry that already points at us is rewritten in place under its own name, so
 * clicking Install twice doesn't leave two.
 */
export function withServer(config: unknown, url: string, port: number): Record<string, unknown> {
  const root = config && typeof config === 'object' ? { ...(config as object) } : {};
  const name = registeredName(config, port) ?? HARNESS_SERVER_NAME;
  return { ...root, mcpServers: { ...servers(config), [name]: harnessEntry(url) } };
}

/** Drop every registration pointing at us — under whatever name it was given. */
export function withoutServer(config: unknown, port: number): Record<string, unknown> {
  const root = config && typeof config === 'object' ? { ...(config as object) } : {};
  const kept = Object.fromEntries(
    Object.entries(servers(config)).filter(([, entry]) => {
      const url = entry && typeof entry === 'object' ? (entry as { url?: unknown }).url : undefined;
      return !pointsAtUs(url, port);
    }),
  );
  return { ...root, mcpServers: kept };
}
