/**
 * Every plugin's renderer half, keyed by the id its main half registered under.
 *
 * The shell walks the snapshot's plugin metadata rather than this map, so a
 * plugin listed in `main/plugins` but missing here simply draws nothing — which
 * is a better failure than a crash on a half-installed plugin.
 */

import type { PluginView } from '@shared/plugin';
import type { PluginId } from '@shared/ipc';
import { jiraView } from './jira/view';

export const VIEWS: Record<PluginId, PluginView<never>> = {
  jira: jiraView as PluginView<never>,
};
