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

export function appCommands(ctx: Ctx): Row[] {
  return [
    {
      id: 'app:settings',
      title: 'Settings…',
      subtitle: 'Hotkey, section order, and each app’s connection',
      keywords: ['config', 'preferences', 'plugins'],
      badges: [{ text: '⌘,', kind: 'key' }],
      run: () => ctx.openSettings(''),
    },
    {
      id: 'app:refresh',
      title: 'Refresh everything',
      keywords: ['reload', 'fetch'],
      badges: [{ text: '⌘R', kind: 'key' }],
      run: () => ctx.actStay(() => window.jt.refresh()),
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
