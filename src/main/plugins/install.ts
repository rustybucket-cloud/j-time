/**
 * The plugins directory: `~/.j-time/plugins`, one directory per plugin.
 *
 * Plugins are compiled into the app — a row carries closures, and a closure
 * can't cross the bridge — so nothing here is *loaded*. What the directory is
 * for is the next plugin: the two that ship are installed as their source, in
 * the layout the app's own tree uses, next to a guide for writing a third. A
 * worked example you can open beats a contract you have to read.
 *
 * A plugin's directory is written only when it is missing, so a copy someone
 * has been editing survives an upgrade, and deleting one gets a fresh copy on
 * the next launch. The guide is the app's rather than the user's, and is kept
 * current instead.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';
import type { MainPlugin } from '../plugin';
import { ensureDir, PLUGINS_DIR } from '../store';
import GUIDE from '../../../docs/plugins/AGENTS.md?raw';

/**
 * The source, embedded at build time.
 *
 * A packaged .app carries only `out/`, so the files have to travel inside the
 * bundle to be there to write out. `?raw` keeps them as text: the same files are
 * also imported as code by the registry, and the two never meet. The options are
 * spelled out three times because Vite reads them off the call site and accepts
 * only an object literal there.
 */
const MAIN = import.meta.glob('./*/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const RENDERER = import.meta.glob('../../renderer/plugins/*/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const SHARED = import.meta.glob('../../shared/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Which of `src/shared/` is a plugin's own.
 *
 * The rest — time formatting, the palette, the layout — is the shell's, and a
 * plugin imports it rather than owning it. Tests travel with their module, since
 * "ordering belongs in shared, with tests" is the example worth copying.
 */
const OWNED_SHARED: Record<string, string[]> = {
  jira: ['jira', 'conn', 'types', 'timer-logic', 'worklog', 'activities', 'board', 'stages'],
  claude: ['claude'],
};

/** Every file of one plugin, keyed by where it goes under the plugin's directory. */
function filesFor(plugin: MainPlugin): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (bundle: Record<string, string>, prefix: string, into: string) => {
    for (const [key, text] of Object.entries(bundle)) {
      const [id, ...rest] = key.slice(prefix.length).split('/');
      if (id === plugin.id && rest.length) out[[into, ...rest].join('/')] = text;
    }
  };
  take(MAIN, './', 'main');
  take(RENDERER, '../../renderer/plugins/', 'renderer');
  for (const name of OWNED_SHARED[plugin.id] ?? []) {
    for (const file of [`${name}.ts`, `${name}.test.ts`]) {
      const text = SHARED[`../../shared/${file}`];
      if (text !== undefined) out[`shared/${file}`] = text;
    }
  }
  out['plugin.json'] = `${JSON.stringify(
    { id: plugin.id, title: plugin.title, appVersion: app.getVersion() },
    null,
    2,
  )}\n`;
  return out;
}

const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false,
  );

/**
 * Write the plugin next to where it goes, then rename it into place.
 *
 * A directory that exists is a directory that is installed, so a launch that
 * dies halfway through must not leave one behind: the temp directory is what a
 * crash leaves, and the next launch starts over.
 */
async function installPlugin(plugin: MainPlugin): Promise<void> {
  const dir = path.join(PLUGINS_DIR, plugin.id);
  if (await exists(dir)) return;

  const tmp = `${dir}.${process.pid}.tmp`;
  await fs.rm(tmp, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(filesFor(plugin))) {
    const file = path.join(tmp, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
  }
  try {
    await fs.rename(tmp, dir);
  } catch (e: unknown) {
    // Something else got there first. Theirs is as good as ours.
    await fs.rm(tmp, { recursive: true, force: true });
    if (!(await exists(dir))) throw e;
  }
}

async function writeIfChanged(file: string, text: string): Promise<void> {
  const current = await fs.readFile(file, 'utf8').catch(() => null);
  if (current === text) return;
  await fs.writeFile(file, text, 'utf8');
}

/**
 * Put every shipped plugin, and the guide, in the plugins directory.
 *
 * Never fatal: the app is a clock and a palette, and neither depends on a copy
 * of its own source being on disk.
 */
export async function installShippedPlugins(plugins: MainPlugin[]): Promise<void> {
  try {
    // Through the store, so a first launch that reaches here before anything
    // has been saved still gets the owner-only ~/.j-time it would have had.
    await ensureDir();
    await fs.mkdir(PLUGINS_DIR, { recursive: true, mode: 0o700 });
    for (const plugin of plugins) await installPlugin(plugin);
    // Both names, same text: AGENTS.md is the convention most tools read, and
    // CLAUDE.md is the one Claude Code reads.
    await writeIfChanged(path.join(PLUGINS_DIR, 'AGENTS.md'), GUIDE);
    await writeIfChanged(path.join(PLUGINS_DIR, 'CLAUDE.md'), GUIDE);
  } catch (e: unknown) {
    console.error('Could not install the plugins directory:', e);
  }
}
