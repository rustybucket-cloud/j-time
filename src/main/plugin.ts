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
  secrets: readonly string[];
  /** How often to re-read while the app runs. */
  refreshMs: number;
  defaults(): C;
  /** Called once, before any config is applied. */
  init(host: PluginHost): void;
  /** Applied at startup and after every save. */
  configure(config: C): Promise<void> | void;
  /** False when there aren't enough credentials to try. */
  configured(): boolean;
  /** The plugin's slice of the snapshot, as the renderer will see it. */
  snapshot(): S;
  /** `force: false` means "only if what's on screen has gone stale". */
  refresh(force: boolean): Promise<ActionResult>;
  commands: Record<string, Command>;
  queries?: Record<string, Query>;

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
