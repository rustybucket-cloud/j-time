/**
 * The shell's own settings — the parts of the app that belong to no plugin.
 *
 * There is very little here on purpose. The shell owns the hotkey, the window and
 * the arrangement of the sections; everything else a plugin owns, including its
 * own credentials.
 */

import type { LayoutState } from './layout';
import { defaultMcpConfig, type McpConfig, type McpStatus } from './mcp';

export const DEFAULT_HOTKEY = 'Command+Shift+J';

export interface ShellConfig {
  /** Accelerator that toggles the palette. */
  hotkey: string;
  /**
   * The MCP endpoint, which belongs to the shell for the same reason the hotkey
   * does: there is one port, and every plugin's tools are served on it.
   */
  mcp: McpConfig;
}

export function defaultShellConfig(): ShellConfig {
  return { hotkey: DEFAULT_HOTKEY, mcp: defaultMcpConfig() };
}

/** What the renderer needs to know about an installed plugin before drawing it. */
export interface PluginMeta {
  id: string;
  title: string;
  /** False when the plugin has no credentials yet. */
  configured: boolean;
  /** A fetch is in flight. Its rows stay on screen while it is. */
  loading: boolean;
  /** Why the last fetch failed. The previous rows are still shown. */
  error: string | null;
  fetchedAt: number;
}

export interface ShellSnapshot {
  /**
   * The config file has been read.
   *
   * Before it has, every plugin looks unconfigured — its config is still the
   * defaults — and a first-run greeting that trusted that would bounce a
   * perfectly well set up user to a settings form for a frame.
   */
  loaded: boolean;
  config: ShellConfig;
  layout: LayoutState;
  /** In registration order. `layout` decides what the user actually sees. */
  plugins: PluginMeta[];
  /** False when another app already owns the hotkey, so Settings can say so. */
  hotkeyRegistered: boolean;
  /** The directory plugins are installed in, so Settings can hand it to the user. */
  pluginsDir: string;
  /** Whether the MCP endpoint is up, and which tools are on it. */
  mcp: McpStatus;
}
