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
import {
  defaultMcpConfig,
  mcpUrl,
  resolveTool,
  toolEnabled,
  toolSpec,
  type McpStatus,
  type McpToolInfo,
  type ToolResult,
  type ToolSpec,
} from '@shared/mcp';
import type { MainPlugin, MenuBarState } from './plugin';
import { PLUGINS_DIR, readConfig, writeConfig, type RootConfig, type SecretFields } from './store';

/** Opening the palette re-reads only what's older than this. */
const STALE_MS = 15_000;

export const events = new EventEmitter();

interface Registered {
  plugin: MainPlugin;
  meta: PluginMeta;
  timer: NodeJS.Timeout | null;
}

const registry = new Map<string, Registered>();
let root: RootConfig = {
  shell: { hotkey: '', mcp: defaultMcpConfig() },
  layout: { order: [], collapsed: [], pinsOff: [] },
  plugins: {},
};
let hotkeyRegistered = true;
let loaded = false;
let mcp: McpStatus = {
  listening: false,
  port: defaultMcpConfig().port,
  url: mcpUrl(defaultMcpConfig().port),
  error: null,
  tools: [],
};

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

export function has(id: string): boolean {
  return registry.has(id);
}

/** Forget a plugin. Its config section stays in the file, as an uninstalled one's would. */
export function unregister(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  if (entry.timer) clearInterval(entry.timer);
  registry.delete(id);
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
      pluginsDir: PLUGINS_DIR,
      // The tool list comes from the plugins rather than from the server, so
      // the settings page can list what *would* be served while the endpoint is
      // off — and every tool, not only the ones switched on, since otherwise
      // there is nowhere to switch one back on from.
      mcp: { ...mcp, tools: mcpToolInfo() },
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
  // `mcp` is merged rather than replaced, so a form that only means to flip the
  // toggle doesn't have to resend the port to keep it.
  const next: ShellConfig = { ...root.shell, ...patch, mcp: { ...root.shell.mcp, ...patch.mcp } };
  root = { ...root, shell: next };
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

/**
 * The endpoint reporting whether it came up.
 *
 * Same shape as the hotkey: the shell holds the fact and the renderer says so. A
 * port already taken is the hotkey problem all over again — the only symptom is
 * a client that can't connect, which reads as a broken app rather than as a
 * number to change.
 */
export function setMcpStatus(next: McpStatus): void {
  mcp = next;
  emit();
}

export function mcpConfig(): ShellConfig['mcp'] {
  return root.shell.mcp;
}

interface RegisteredTool {
  plugin: string;
  tool: string;
  /** False when the user has switched this one off. It is still registered. */
  enabled: boolean;
  spec: ToolSpec;
  readOnly: boolean;
  destructive: boolean;
}

/**
 * Every plugin's tools, namespaced, in registration order.
 *
 * Built here rather than in the server for the same reason the snapshot is: a
 * plugin mounted since launch has to appear without anything restarting, and
 * `reloadRuntimePlugins` changes the registry, not the socket.
 */
export function mcpTools(): RegisteredTool[] {
  const disabled = root.shell.mcp.disabled ?? [];
  const out: RegisteredTool[] = [];
  for (const { plugin } of registry.values()) {
    for (const tool of plugin.mcp?.() ?? []) {
      const spec = toolSpec(plugin.id, plugin.title, tool);
      out.push({
        plugin: plugin.id,
        tool: tool.name,
        enabled: toolEnabled(disabled, spec.name),
        spec,
        readOnly: tool.readOnly === true,
        destructive: tool.destructive === true,
      });
    }
  }
  return out;
}

/** What `tools/list` advertises: the ones the user has left on. */
export function mcpServedTools(): ToolSpec[] {
  return mcpTools()
    .filter((t) => t.enabled)
    .map((t) => t.spec);
}

/** The same list as the settings page reads it. */
export function mcpToolInfo(): McpToolInfo[] {
  return mcpTools().map((t) => ({
    name: t.spec.name,
    plugin: t.plugin,
    section: registry.get(t.plugin)?.plugin.title ?? t.plugin,
    description: t.spec.description,
    enabled: t.enabled,
    readOnly: t.readOnly,
    destructive: t.destructive,
  }));
}

/**
 * Run a tool by its qualified name.
 *
 * Null means no such tool, which is a protocol error rather than a tool that
 * failed — the caller asked for something that isn't there. Everything else is a
 * result, including a throw: a plugin's bad day belongs in the text the model
 * reads, not in the JSON-RPC envelope.
 */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult | null> {
  const resolved = resolveTool(name, pluginIds());
  const entry = resolved ? registry.get(resolved.plugin) : undefined;
  const tool = entry?.plugin.mcp?.().find((t) => t.name === resolved?.tool);
  if (!tool) return null;

  // A tool the user switched off is absent from `tools/list`, but a client
  // holding a list from before the change would otherwise get "no such tool" —
  // which reads as a bug rather than as a setting somebody chose.
  if (!toolEnabled(root.shell.mcp.disabled ?? [], name)) {
    return { text: `${name} is switched off in j-time's settings.`, isError: true };
  }

  // A tool on a plugin nobody has set up yet would fail deep inside a client
  // with whatever error a missing token produces. Say which form to fill in.
  if (!entry!.plugin.configured()) {
    return { text: `${entry!.plugin.title} is not set up yet in j-time.`, isError: true };
  }

  try {
    const result = await tool.run(args);
    if (typeof result === 'string') return { text: result };
    if (result.ok) return { text: result.message ?? 'Done' };
    return { text: result.error, isError: true };
  } catch (e: unknown) {
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
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
