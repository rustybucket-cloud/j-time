/**
 * Every plugin the app ships with, in the order a fresh install sees them.
 *
 * Registration order is only the *default*; `layout.order` is what the user
 * actually sees, and a plugin added here later appears at the bottom of an
 * existing arrangement rather than displacing anything.
 */

import { plugin as jira } from './jira';
import { plugin as github } from './github';
import type { MainPlugin } from '../plugin';

/**
 * The casts are the price of plugins keeping their own config types.
 *
 * `configure` takes the plugin's own config, which makes it contravariant, so a
 * `MainPlugin<JiraSnapshot, JiraConfig>` is not assignable to the erased type
 * the registry stores. Erasing the config type on the interface instead would
 * push the cast into every plugin — one per author rather than one per app.
 */
export const PLUGINS: MainPlugin[] = [
  jira as unknown as MainPlugin,
  github as unknown as MainPlugin,
];
