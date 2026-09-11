/**
 * The contract between the main process and the palette.
 *
 * The renderer never talks to a service and never touches disk: it renders a
 * Snapshot and sends back intents. That's what keeps every plugin's credentials,
 * its state file and its ordering rules in one process with one writer.
 *
 * There used to be a named bridge method per JIRA verb. With more than one plugin
 * that list is the wrong shape — so commands are addressed by plugin and name,
 * and each plugin's renderer half wraps them in a typed client of its own. The
 * typing is not lost, just moved next to the code that knows what the arguments
 * mean.
 */

import type { ActionResult, QueryResult } from './plugin';
import type { LayoutState } from './layout';
import type { ShellConfig, ShellSnapshot } from './shell';
import type { JiraSnapshot } from './jira';
import type { ClaudeSnapshot } from './claude';

/**
 * Every installed plugin's slice, by id.
 *
 * The built-ins are listed rather than left as `Record<string, unknown>`: they
 * are compiled in, so there is no reason to give up knowing their shapes, and
 * adding one means adding a line here. The index signature is for the plugins
 * loaded from `~/.j-time/plugins`, whose ids nobody knows at compile time and
 * whose slices are all the one `RuntimeSnapshot` shape.
 */
export interface PluginSnapshots {
  jira: JiraSnapshot;
  claude: ClaudeSnapshot;
  [runtime: string]: unknown;
}

export type BuiltinId = 'jira' | 'claude';
export type PluginId = string;

export interface Snapshot {
  shell: ShellSnapshot;
  plugins: PluginSnapshots;
}

export type { ActionResult, QueryResult };

/** Everything `window.jt` exposes. Kept here so both sides typecheck against it. */
export interface Bridge {
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(fn: (snapshot: Snapshot) => void): () => void;

  /** Run something a plugin offers. The plugin decides what the arguments mean. */
  invoke(plugin: string, command: string, args?: unknown[]): Promise<ActionResult>;
  /** Ask a plugin for data — a transition list, say — rather than to do something. */
  query(plugin: string, command: string, args?: unknown[]): Promise<QueryResult<unknown>>;
  /** Re-read one plugin, or all of them. */
  refresh(plugin?: string): Promise<ActionResult>;
  /** Re-read the plugins directory: new directories, and edits to main.js. */
  reloadPlugins(): Promise<ActionResult>;
  savePluginConfig(plugin: string, patch: Record<string, unknown>): Promise<ActionResult>;

  saveShellConfig(patch: Partial<ShellConfig>): Promise<ActionResult>;
  /** Add or remove this app's MCP endpoint in another client's own config. */
  setHarness(id: string, install: boolean): Promise<ActionResult>;
  saveLayout(layout: LayoutState): Promise<ActionResult>;

  /** Any http(s) link a plugin built. */
  openUrl(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  setHeight(height: number): Promise<void>;
  /** Off while a form is open, so switching apps to copy a token doesn't lose it. */
  setDismissOnBlur(value: boolean): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<void>;
}
