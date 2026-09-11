/**
 * Plugins loaded from `~/.j-time/plugins` while the app runs.
 *
 * Each is a directory named for its id with a `main.js` inside, which is a
 * CommonJS module exporting one object. The file runs here, in the main
 * process, with everything the app itself has — it is the user's own code on
 * the user's own machine, the same trust as any script they would run. Nothing
 * of it reaches the renderer: what the palette gets is the data the plugin
 * returned, checked by `sanitiseContent`, and the renderer's generic view draws
 * that the way it draws everything else.
 *
 * A plugin that can't be loaded is still registered, as a section whose header
 * carries the error. Silently leaving it out would make a typo in main.js look
 * exactly like the directory being ignored, which is the one failure a plugin
 * author can't debug from the palette.
 */

import { promises as fs } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import type { ActionResult } from '@shared/plugin';
import {
  emptyRuntimeContent,
  publicConfig,
  RUNTIME_ID,
  sanitiseContent,
  sanitiseFields,
  secretKeys,
  type RuntimeContent,
  type RuntimeField,
  type RuntimeSnapshot,
} from '@shared/runtime';
import type { Command, MainPlugin, MenuBarState, PluginHost } from './plugin';
import * as shell from './shell';
import { PLUGINS_DIR } from './store';

/** What a plugin's file hands the app. */
export interface RuntimeHost {
  /** The plugin's own directory, for anything it wants to keep. */
  dir: string;
  /** Ask to be re-read now — after a command changed something, say. */
  refresh(): void;
}

type Config = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

/** The shape main.js may export. Everything but `refresh` is optional. */
interface RuntimeModule {
  title?: unknown;
  refreshMs?: unknown;
  fields?: unknown;
  defaults?: unknown;
  configured?: unknown;
  configure?: unknown;
  refresh?: unknown;
  commands?: unknown;
}

const DEFAULT_REFRESH_MS = 60_000;
/** Faster than this and a plugin that shells out would never finish a poll. */
const MIN_REFRESH_MS = 2_000;

const load = createRequire(import.meta.url);

/**
 * Read a plugin's file fresh.
 *
 * `require` caches by path, and a reload that handed back the cached module
 * would be a reload that did nothing — so the entry is dropped first.
 */
function readModule(file: string): RuntimeModule {
  delete load.cache[load.resolve(file)];
  const mod: unknown = load(file);
  if (typeof mod !== 'object' || mod === null) throw new Error('main.js must export an object');
  return mod as RuntimeModule;
}

const fn = (v: unknown): Fn | null => (typeof v === 'function' ? (v as Fn) : null);

/**
 * Wrap a loaded module as a plugin the shell can host.
 *
 * `mod` is null when the file couldn't be read, in which case the plugin is a
 * placeholder that reports the error on every refresh and holds no rows.
 */
function adapt(id: string, dir: string, mod: RuntimeModule | null, loadError: string | null): MainPlugin {
  const title = (mod && typeof mod.title === 'string' && mod.title) || id;
  const fields: RuntimeField[] = mod ? sanitiseFields(mod.fields) : [];
  const defaults = fn(mod?.defaults);
  const configuredFn = fn(mod?.configured);
  const configureFn = fn(mod?.configure);
  const refreshFn = fn(mod?.refresh);
  const rawRefresh = mod && typeof mod.refreshMs === 'number' ? mod.refreshMs : DEFAULT_REFRESH_MS;
  const refreshMs = rawRefresh > 0 ? Math.max(MIN_REFRESH_MS, rawRefresh) : 0;

  let host: PluginHost | null = null;
  let config: Config = {};
  let content: RuntimeContent = emptyRuntimeContent();
  const runtimeHost: RuntimeHost = { dir, refresh: () => host?.refresh() };

  const commands: Record<string, Command> = {};
  if (mod && typeof mod.commands === 'object' && mod.commands !== null) {
    for (const [name, value] of Object.entries(mod.commands)) {
      const command = fn(value);
      if (!command) continue;
      commands[name] = async (args) => {
        const result = await command(args, runtimeHost, config);
        // A command that returns nothing did its job; a string is a message.
        if (result === undefined || result === null) return { ok: true };
        if (typeof result === 'string') return { ok: true, message: result };
        if (typeof result === 'object' && 'ok' in result) return result as ActionResult;
        return { ok: true };
      };
    }
  }

  const snapshot = (): RuntimeSnapshot => ({
    id,
    title,
    dir,
    fields,
    ...publicConfig(config, fields),
    configured: configured(),
    content,
    loadError,
  });

  const configured = (): boolean => {
    if (loadError) return true; // so the error is fetched and shown
    if (!configuredFn) return true;
    try {
      return configuredFn(config) === true;
    } catch {
      return false;
    }
  };

  return {
    id,
    title,
    secrets: secretKeys(fields),
    refreshMs,
    defaults: () => {
      const value = defaults?.();
      return typeof value === 'object' && value !== null ? (value as Config) : {};
    },
    init: (h) => {
      host = h;
    },
    configure: async (next: Config) => {
      config = next;
      await configureFn?.(config, runtimeHost);
    },
    configured,
    snapshot,
    refresh: async () => {
      if (loadError) return { ok: false, error: loadError };
      if (!refreshFn) return { ok: false, error: 'main.js exports no refresh()' };
      content = sanitiseContent(await refreshFn(config, runtimeHost));
      host?.changed();
      return { ok: true };
    },
    commands,
    menuBar: (): MenuBarState | null =>
      content.menuBar
        ? { title: content.menuBar.title, tooltip: content.menuBar.tooltip ?? title, live: false }
        : null,
  };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Every plugin directory, as a plugin — loadable or not. */
async function scan(): Promise<MainPlugin[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(PLUGINS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const out: MainPlugin[] = [];
  for (const id of entries) {
    if (!RUNTIME_ID.test(id)) continue;
    const dir = path.join(PLUGINS_DIR, id);
    const file = path.join(dir, 'main.js');
    try {
      await fs.access(file);
    } catch {
      continue; // a folder with no main.js is notes, or a plugin not written yet
    }
    // A runtime plugin can't shadow a built-in: the config file keys on id.
    if (shell.has(id) && !mounted.has(id)) continue;
    try {
      out.push(adapt(id, dir, readModule(file), null));
    } catch (e: unknown) {
      out.push(adapt(id, dir, null, `Could not load main.js: ${message(e)}`));
    }
  }
  return out;
}

const mounted = new Set<string>();

/**
 * Register every plugin in the directory. Before `shell.load()`, so the config
 * file is read with their secrets known and decrypted.
 */
export async function mountRuntimePlugins(): Promise<void> {
  for (const plugin of await scan()) {
    shell.register(plugin);
    mounted.add(plugin.id);
  }
}

/**
 * Drop and re-read every runtime plugin, picking up new directories and edits.
 *
 * Going back through `shell.load()` is what makes a plugin added since launch
 * get its secrets decrypted: the store only knows which fields to decrypt for
 * plugins that are registered at the time it reads.
 */
export async function reloadRuntimePlugins(): Promise<ActionResult> {
  shell.stopPolling();
  for (const id of mounted) shell.unregister(id);
  mounted.clear();
  await mountRuntimePlugins();
  await shell.load();
  shell.startPolling();
  void shell.refreshAll();
  const n = mounted.size;
  return { ok: true, message: `${n} plugin${n === 1 ? '' : 's'} loaded from ${PLUGINS_DIR}` };
}
