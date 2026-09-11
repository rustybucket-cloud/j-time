/**
 * The app itself, rather than any plugin: the rows in the footer menu, and the
 * section of commands at the bottom of the list.
 *
 * Plain data now that rows carry badges rather than markup, which is why this is
 * a `.ts` and the plugin views are not — the only React left in a row is in the
 * screens a plugin owns outright.
 */

import type { Ctx, Row } from '@shared/plugin';

export const COMMANDS_SECTION = 'shell';

/**
 * The shell's own screens, which no plugin owns and so are not in `Ctx`.
 *
 * `Ctx` is the plugin contract; putting "open the MCP page" on it would hand
 * every plugin a verb about the shell's own settings.
 */
export interface ShellScreens {
  openMcp: () => void;
}

export function appCommands(ctx: Ctx, screens: ShellScreens): Row[] {
  return [
    {
      id: 'app:settings',
      title: 'Settings…',
      subtitle: 'Hotkey, plugin order, and each app’s connection',
      keywords: ['config', 'preferences', 'plugins'],
      badges: [{ text: '⌘,', kind: 'key' }],
      run: () => ctx.openSettings(''),
    },
    {
      id: 'app:mcp',
      title: 'MCP server…',
      subtitle: 'The endpoint Claude Code calls, and which tools it may use',
      keywords: ['mcp', 'claude', 'tools', 'port', 'api', 'agent'],
      run: screens.openMcp,
    },
    {
      id: 'app:refresh',
      title: 'Refresh everything',
      keywords: ['reload', 'fetch'],
      badges: [{ text: '⌘R', kind: 'key' }],
      run: () => ctx.actStay(() => window.jt.refresh()),
    },
    {
      id: 'app:reload-plugins',
      title: 'Reload plugins',
      subtitle: 'Re-reads ~/.j-time/plugins — new folders, and edits to a main.js',
      keywords: ['plugin', 'load', 'develop'],
      run: () => ctx.actStay(() => window.jt.reloadPlugins()),
    },
    {
      id: 'app:quit',
      title: 'Quit j-time',
      subtitle: 'Stops the menu bar clock. Tracked time is already saved.',
      keywords: ['exit', 'close'],
      badges: [{ text: '⌘Q', kind: 'key' }],
      run: () => void window.jt.quit(),
    },
  ];
}
