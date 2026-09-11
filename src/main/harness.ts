/**
 * Writing this app's endpoint into the config of the clients that call it.
 *
 * The only place in j-time that edits a file belonging to another application,
 * which is why it does as little as possible: read, fold one key, write the
 * whole thing back atomically. `shared/harness.ts` holds the fold, so what is
 * left here is the path and the I/O.
 *
 * There is no lock between us and the client — Claude Code writes
 * `~/.claude.json` on its own schedule — so the read and the write are as close
 * together as they can be, and the rest of the file is carried through
 * untouched. That is a button pressed once, not a poller, so a read-modify-write
 * is the right size of risk; a client running at the exact moment would lose at
 * most the key it happened to be writing.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { ActionResult } from '@shared/plugin';
import {
  HARNESSES,
  registeredName,
  withServer,
  withoutServer,
  type HarnessStatus,
} from '@shared/harness';
import { mcpUrl } from '@shared/mcp';
import * as shell from './shell';

/**
 * Claude Code's user-scope config.
 *
 * `CLAUDE_CONFIG_DIR` is its own override and puts the file *inside* that
 * directory, where by default it sits beside `~/.claude` rather than in it —
 * honouring it is what lets a sandbox run point at a fixture the way `JT_HOME`
 * points the rest of the app at one.
 */
function claudeConfigFile(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(path.resolve(process.env.CLAUDE_CONFIG_DIR), '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

function fileFor(id: string): string | null {
  return id === 'claude-code' ? claudeConfigFile() : null;
}

/** Its own config, parsed. `null` means there is no file — not an error. */
async function read(file: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(text) as unknown;
}

/**
 * Replace the file, keeping the permissions it already had.
 *
 * Same rename as `store.writeAtomic`, and for a stronger reason: this file is
 * the client's onboarding state and a record per project, and there is no copy
 * of it either. Its mode is preserved rather than forced — it is not ours to
 * decide how private another app's config should be, only not to widen it.
 */
async function write(file: string, config: unknown): Promise<void> {
  const mode = await fs
    .stat(file)
    .then((s) => s.mode & 0o777)
    .catch(() => 0o600);
  const tmp = `${file}.j-time.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode });
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, file);
}

async function status(id: string, title: string, what: string, port: number): Promise<HarnessStatus> {
  const file = fileFor(id);
  if (!file) return { id, title, what, path: '', name: null, error: 'Unknown client' };
  try {
    const config = await read(file);
    return { id, title, what, path: file, name: registeredName(config, port), error: null };
  } catch (e) {
    // A config we cannot parse is one we must not overwrite, and the page has to
    // say why the button did nothing rather than showing it as "not installed".
    return {
      id,
      title,
      what,
      path: file,
      name: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Re-read every client's config and hand the result to the shell. */
export async function refreshHarnesses(): Promise<void> {
  const port = shell.mcpConfig().port;
  shell.setHarnesses(
    await Promise.all(HARNESSES.map((h) => status(h.id, h.title, h.what, port))),
  );
}

/**
 * Register the endpoint with a client, or take it back out.
 *
 * Installing while the endpoint is switched off is allowed on purpose: a
 * registration is a line in a file, and a client that finds the server down
 * says so plainly the next time it starts. Refusing here would mean the order
 * the two switches are flipped in mattered.
 */
export async function setHarness(id: string, install: boolean): Promise<ActionResult> {
  const file = fileFor(id);
  if (!file) return { ok: false, error: `No client called ${id}` };
  const { port } = shell.mcpConfig();

  try {
    const config = await read(file);
    if (!install && config === null) return { ok: true, message: 'Nothing to remove' };
    const next = install
      ? withServer(config, mcpUrl(port), port)
      : withoutServer(config, port);
    await write(file, next);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  await refreshHarnesses();
  return {
    ok: true,
    // Restarting is the client's business, not ours, and it is the one step the
    // user has to take themselves — so the message says so rather than implying
    // an already-running session picked the tools up.
    message: install
      ? 'Registered. Restart the client to pick the tools up.'
      : 'Removed. Restart the client to drop the tools.',
  };
}
