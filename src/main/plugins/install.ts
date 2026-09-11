/**
 * Seed `~/.j-time/plugins` with what ships in the repository's `plugins/`.
 *
 * The directory is read by `runtime.ts`; this only makes sure a first launch has
 * something in it to read — a guide, and one working plugin to copy from. A
 * worked example you can open beats a contract you have to read.
 *
 * Two rules, by depth. A plugin directory is written only when it is missing,
 * so a copy someone has been editing survives an upgrade, and deleting one gets
 * a fresh copy on the next launch. The top-level files are the app's rather than
 * the user's, and are kept current instead.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { ensureDir, PLUGINS_DIR } from '../store';

/**
 * Embedded at build time: a packaged .app carries only `out/`, so the files
 * travel inside the bundle to be there to write out. Vite reads the options off
 * the call site and accepts only an object literal there.
 */
const SHIPPED = import.meta.glob('../../../plugins/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const PREFIX = '../../../plugins/';

const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false,
  );

/**
 * Write a plugin next to where it goes, then rename it into place.
 *
 * A directory that exists is a directory that is installed, so a launch that
 * dies halfway through must not leave one behind: the temp directory is what a
 * crash leaves, and the next launch starts over.
 */
async function installPlugin(id: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(PLUGINS_DIR, id);
  if (await exists(dir)) return;

  const tmp = `${dir}.${process.pid}.tmp`;
  await fs.rm(tmp, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
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
 * Put the guide and the example plugin in the plugins directory.
 *
 * Never fatal: the app is a clock and a palette, and neither depends on an
 * example being on disk.
 */
export async function installPluginsDir(): Promise<void> {
  try {
    // Through the store, so a first launch that reaches here before anything
    // has been saved still gets the owner-only ~/.j-time it would have had.
    await ensureDir();
    await fs.mkdir(PLUGINS_DIR, { recursive: true, mode: 0o700 });

    const byPlugin = new Map<string, Record<string, string>>();
    for (const [key, text] of Object.entries(SHIPPED)) {
      const [head, ...rest] = key.slice(PREFIX.length).split('/');
      if (rest.length === 0) {
        await writeIfChanged(path.join(PLUGINS_DIR, head), text);
        // Both names, same text: AGENTS.md is the convention most tools read,
        // and CLAUDE.md is the one Claude Code reads.
        if (head === 'AGENTS.md') await writeIfChanged(path.join(PLUGINS_DIR, 'CLAUDE.md'), text);
        continue;
      }
      const files = byPlugin.get(head) ?? {};
      files[rest.join('/')] = text;
      byPlugin.set(head, files);
    }
    for (const [id, files] of byPlugin) await installPlugin(id, files);
  } catch (e: unknown) {
    console.error('Could not seed the plugins directory:', e);
  }
}
