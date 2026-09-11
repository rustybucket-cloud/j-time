/**
 * Every plugin's renderer half, keyed by the id its main half registered under.
 *
 * The built-ins are listed; anything else the shell reports is a plugin loaded
 * from `~/.j-time/plugins`, and they all draw through the one runtime view. A
 * built-in listed in `main/plugins` but missing here simply draws nothing —
 * which is a better failure than a crash on a half-installed plugin.
 */

import type { PluginView } from '@shared/plugin';
import type { BuiltinId } from '@shared/ipc';
import { jiraView } from './jira/view';
import { claudeView } from './claude/view';
import { runtimeView } from './runtime';

const BUILTIN: Record<BuiltinId, PluginView<never>> = {
  jira: jiraView as PluginView<never>,
  claude: claudeView as PluginView<never>,
};

export function viewFor(id: string): PluginView<never> {
  return (BUILTIN as Partial<Record<string, PluginView<never>>>)[id] ?? (runtimeView(id) as PluginView<never>);
}
