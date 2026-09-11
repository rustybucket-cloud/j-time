/**
 * The main-process half of a plugin.
 *
 * A plugin owns its credentials, its fetching and its writes; the shell owns the
 * window, the hotkey, the arrangement and the one config file they all live in.
 * Nothing here knows what a worklog or a pull request is.
 *
 * Commands take `unknown[]` because this is the dynamic seam: the renderer sends
 * a plugin id, a command name and some arguments. The arguments get their names
 * back one layer up, in each plugin's typed renderer client — putting `any` here
 * instead would only spread the looseness further.
 */

import type { MenuItemConstructorOptions } from 'electron';
import type { ActionResult, QueryResult } from '@shared/plugin';
import type { ToolDeclaration } from '@shared/mcp';
import type { SecretField } from './store';

export type Command = (args: unknown[]) => Promise<ActionResult> | ActionResult;
export type Query = (args: unknown[]) => Promise<QueryResult<unknown>>;

export interface PluginHost {
  /** Announce that this plugin's slice of the snapshot changed. */
  changed(): void;
  /**
   * Ask the shell to re-read this plugin.
   *
   * Through the shell rather than by calling `refresh` directly, so the fetch
   * still reports as in flight and a failure still lands on the section header.
   */
  refresh(): void;
}

export interface MainPlugin<S = unknown, C = Record<string, unknown>> {
  id: string;
  title: string;
  /** Config fields that are credentials, so the store knows what to encrypt. */
  secrets: readonly SecretField[];
  /** How often to re-read while the app runs. */
  refreshMs: number;
  defaults(): C;
  /** Called once, before any config is applied. */
  init(host: PluginHost): void;
  /** Applied at startup and after every save. */
  configure(config: C): Promise<void> | void;
  /**
   * Fold a settings patch onto the stored config.
   *
   * The default keeps any secret the patch left out, so a form that never
   * received a token can't erase one. A plugin holding *several* credentials
   * has to say how they line up — the shell can't know that an account keeps
   * its token when the patch identifies it by id and sends the field blank.
   */
  mergeConfig?(previous: C, patch: Partial<C>): C;
  /** False when there aren't enough credentials to try. */
  configured(): boolean;
  /** The plugin's slice of the snapshot, as the renderer will see it. */
  snapshot(): S;
  /** `force: false` means "only if what's on screen has gone stale". */
  refresh(force: boolean): Promise<ActionResult>;
  commands: Record<string, Command>;
  queries?: Record<string, Query>;
  /**
   * The tools this plugin puts on the MCP endpoint, if any.
   *
   * Same idea as `commands`, addressed the same way, and deliberately not the
   * same list: a command is a keystroke on a row the user is already looking at,
   * so `start` with the key it was pressed on is all it needs. A tool is called
   * by something that cannot see the screen, which is why it takes named
   * arguments, why it answers in prose, and why the read-only ones exist at all —
   * nothing in the palette needs a command that only tells you what is running.
   *
   * Called on every snapshot, so it must be a constant rather than built each
   * time. The shell namespaces the names and assembles the wire format.
   */
  mcp?(): McpTool[];

  /**
   * What this plugin wants in the menu bar, if anything.
   *
   * The running clock was the whole reason the tray exists — a timer you have to
   * open something to check is a timer you forget is running. It is still that,
   * but the tray no longer knows it is a timer: the first plugin with something
   * to say gets the title, and `live` is what decides whether the tray ticks
   * once a second or costs nothing.
   */
  menuBar?(): MenuBarState | null;
  /** This plugin's own items in the menu bar's context menu. */
  trayMenu?(): MenuItemConstructorOptions[];
}

/**
 * One tool, with the function behind it.
 *
 * `run` may answer with a string, which is the text the caller gets, or with the
 * `ActionResult` a command already returns — so wiring a tool onto an existing
 * command is one line, and a failure reads as a failed tool rather than a broken
 * server.
 */
export interface McpTool extends ToolDeclaration {
  run(args: Record<string, unknown>): Promise<string | ActionResult> | string | ActionResult;
}

export interface MenuBarState {
  title: string;
  tooltip: string;
  /** Changes on its own between snapshots, so the tray needs a clock of its own. */
  live: boolean;
}

/** Pull a positional argument out of the dynamic seam. */
export function str(args: unknown[], at: number): string {
  const value = args[at];
  if (typeof value !== 'string') throw new Error(`Expected a string argument at ${at}`);
  return value;
}

export function optionalStr(args: unknown[], at: number): string | undefined {
  const value = args[at];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Pull a named argument out of a tool call.
 *
 * Throwing is right here: the shell turns it into a failed *tool*, message and
 * all, which is the one thing a model can act on. A schema says an argument is
 * required, but the caller is a language model and the schema is a hint.
 */
export function argStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required argument: ${key}`);
  }
  return value.trim();
}

export function optionalArgStr(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
