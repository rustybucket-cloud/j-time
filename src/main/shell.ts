/**
 * The registry: the one owner of the config file, the snapshot and the polling.
 *
 * This is what `data.ts` used to be, minus everything that knew about JIRA. It
 * holds the plugins, hands each its own slice of config, assembles their
 * snapshots into one, and broadcasts a change whenever any of them says so — so
 * the palette and the menu bar can never disagree about what's running.
 *
 * Two rules that used to be JIRA's are the shell's now, and apply to every
 * plugin: a fetch in flight leaves the previous rows on screen, and a failed one
 * leaves them there too. A dropped VPN shouldn't blank a list you're about to act
 * on, and most actions work fine against stale rows.
 */

import { EventEmitter } from 'events';
import type { ActionResult, QueryResult } from '@shared/plugin';
import type { PluginSnapshots, Snapshot } from '@shared/ipc';
import { freezeOrder, type LayoutState } from '@shared/layout';
import type { PluginMeta, ShellConfig } from '@shared/shell';
import type { MainPlugin, MenuBarState } from './plugin';
import { readConfig, writeConfig, type RootConfig, type SecretFields } from './store';

/** Opening the palette re-reads only what's older than this. */
const STALE_MS = 15_000;

export const events = new EventEmitter();

interface Registered {
  plugin: MainPlugin;
  meta: PluginMeta;
  timer: NodeJS.Timeout | null;
}

const registry = new Map<string, Registered>();
let root: RootConfig = { shell: { hotkey: '' }, layout: { order: [], collapsed: [], pinsOff: [] }, plugins: {} };
let hotkeyRegistered = true;
let loaded = false;

export function register(plugin: MainPlugin): void {
  registry.set(plugin.id, {
    plugin,
    meta: {
      id: plugin.id,
      title: plugin.title,
      configured: false,
      loading: false,
      error: null,
      fetchedAt: 0,
    },
    timer: null,
  });
  plugin.init({ changed: emit, refresh: () => void refreshPlugin(plugin.id) });
}

export function plugins(): MainPlugin[] {
  return [...registry.values()].map((r) => r.plugin);
}

export function pluginIds(): string[] {
  return [...registry.keys()];
}

function secretFields(): SecretFields {
  return Object.fromEntries([...registry.values()].map((r) => [r.plugin.id, r.plugin.secrets]));
}

/** One plugin's config, defaults filled in for anything the file didn't have. */
function configFor(id: string): Record<string, unknown> {
  const entry = registry.get(id);
  if (!entry) return {};
  return { ...(entry.plugin.defaults() as Record<string, unknown>), ...(root.plugins[id] ?? {}) };
}

export function snapshot(): Snapshot {
  const slices: Record<string, unknown> = {};
  for (const { plugin, meta } of registry.values()) {
    slices[plugin.id] = plugin.snapshot();
    meta.configured = plugin.configured();
  }
  return {
    shell: {
      loaded,
      config: root.shell,
      layout: root.layout,
      plugins: [...registry.values()].map((r) => ({ ...r.meta })),
      hotkeyRegistered,
    },
    plugins: slices as unknown as PluginSnapshots,
  };
}

function emit(): void {
  events.emit('change', snapshot());
}

const failed = (e: unknown): ActionResult => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e),
});

export async function load(): Promise<void> {
  root = await readConfig(secretFields());
  for (const { plugin } of registry.values()) {
    await plugin.configure(configFor(plugin.id));
  }
  loaded = true;
  emit();
}

/**
 * Re-read one plugin.
 *
 * The staleness rule lives here rather than in each plugin: opening the palette
 * asks everything to refresh, and every plugin wanting the same "don't bother if
 * it's seconds old" logic would be four copies of it waiting to drift.
 */
export async function refreshPlugin(id: string, force = true): Promise<ActionResult> {
  const entry = registry.get(id);
  if (!entry) return { ok: false, error: `No plugin called ${id}` };
  const { plugin, meta } = entry;

  // A plugin with no credentials isn't broken, it's unset — and reporting that
  // as a fetch failure paints a red error on a section whose real problem is
  // that nobody has filled its form in yet.
  if (!plugin.configured()) return { ok: true };
  if (!force && Date.now() - meta.fetchedAt < STALE_MS) return { ok: true };
  if (meta.loading) return { ok: true };

  meta.loading = true;
  emit();
  try {
    const result = await plugin.refresh(force);
    meta.error = result.ok ? null : result.error;
    if (result.ok) meta.fetchedAt = Date.now();
    return result;
  } catch (e: unknown) {
    const result = failed(e);
    meta.error = result.ok ? null : result.error;
    return result;
  } finally {
    meta.loading = false;
    emit();
  }
}

/** Re-read everything, and report the first failure without stopping at it. */
export async function refreshAll(force = true): Promise<ActionResult> {
  const results = await Promise.all(pluginIds().map((id) => refreshPlugin(id, force)));
  return results.find((r) => !r.ok) ?? { ok: true };
}

/** Called when the palette opens: cheap if every list is already current. */
export function refreshIfStale(): void {
  void refreshAll(false);
}

export function startPolling(): void {
  for (const entry of registry.values()) {
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = entry.plugin.refreshMs
      ? setInterval(() => void refreshPlugin(entry.plugin.id), entry.plugin.refreshMs)
      : null;
  }
}

export function stopPolling(): void {
  for (const entry of registry.values()) {
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = null;
  }
}

export async function invoke(id: string, command: string, args: unknown[]): Promise<ActionResult> {
  const entry = registry.get(id);
  const fn = entry?.plugin.commands[command];
  if (!fn) return { ok: false, error: `${id} has no command called ${command}` };
  try {
    return await fn(args);
  } catch (e: unknown) {
    return failed(e);
  }
}

export async function query(
  id: string,
  name: string,
  args: unknown[],
): Promise<QueryResult<unknown>> {
  const entry = registry.get(id);
  const fn = entry?.plugin.queries?.[name];
  if (!fn) return { ok: false, error: `${id} has no query called ${name}` };
  try {
    return await fn(args);
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function persist(): Promise<ActionResult> {
  try {
    await writeConfig(root, secretFields());
    return { ok: true };
  } catch (e: unknown) {
    return failed(e);
  }
}

/**
 * Apply a plugin's config change and re-read it with the new one.
 *
 * A patch that omits a secret leaves the stored one alone — a settings form never
 * receives a token, so an untouched field must not be able to erase it.
 */
export async function savePluginConfig(
  id: string,
  patch: Record<string, unknown>,
): Promise<ActionResult> {
  const entry = registry.get(id);
  if (!entry) return { ok: false, error: `No plugin called ${id}` };

  const previous = configFor(id);
  let next: Record<string, unknown>;
  if (entry.plugin.mergeConfig) {
    next = entry.plugin.mergeConfig(previous, patch) as Record<string, unknown>;
  } else {
    next = { ...previous, ...patch };
    // A form never receives a token, so an untouched field must not erase one.
    // Only flat secrets are handled here; a plugin with a list of them supplies
    // `mergeConfig` instead, because only it knows how the entries line up.
    for (const spec of entry.plugin.secrets) {
      if (typeof spec !== 'string') continue;
      if (patch[spec] === undefined) next[spec] = previous[spec];
    }
  }
  root = { ...root, plugins: { ...root.plugins, [id]: next } };

  const written = await persist();
  if (!written.ok) return written;

  await entry.plugin.configure(next);
  emit();
  // Credentials that aren't complete yet would only produce a confusing error.
  if (entry.plugin.configured()) await refreshPlugin(id);
  return { ok: true, message: 'Settings saved' };
}

export async function saveShellConfig(patch: Partial<ShellConfig>): Promise<ActionResult> {
  root = { ...root, shell: { ...root.shell, ...patch } };
  const written = await persist();
  if (!written.ok) return written;
  events.emit('shell-config', root.shell);
  emit();
  return { ok: true, message: 'Settings saved' };
}

/**
 * Store an arrangement.
 *
 * Frozen against what's installed first: `resolveLayout` appends unseen plugins
 * on every read, so an order that never mentioned them would let the first move
 * of an arranged section jump an unarranged one to the top.
 */
export async function saveLayout(layout: LayoutState): Promise<ActionResult> {
  root = { ...root, layout: freezeOrder(layout, pluginIds()) };
  const written = await persist();
  if (!written.ok) return written;
  emit();
  return { ok: true };
}

export function shellConfig(): ShellConfig {
  return root.shell;
}

export function setHotkeyRegistered(ok: boolean): void {
  hotkeyRegistered = ok;
  emit();
}

/** The first plugin with something to say in the menu bar. */
export function menuBar(): MenuBarState | null {
  for (const { plugin } of registry.values()) {
    const state = plugin.menuBar?.();
    if (state) return state;
  }
  return null;
}

export function trayMenu(): ReturnType<NonNullable<MainPlugin['trayMenu']>> {
  return [...registry.values()].flatMap((r) => r.plugin.trayMenu?.() ?? []);
}
