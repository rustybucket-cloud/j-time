/**
 * Everything on disk: the timer state and the config, both under ~/.j-time.
 *
 * Deliberately NOT ~/.jira-timer. j-time is a second writer with no lock between
 * them, so sharing that file with an always-on jira-timer would interleave two
 * read-modify-write cycles and silently drop segments.
 *
 * config.json now holds a section per plugin rather than one flat JIRA config.
 * The old shape is migrated on read — a config written by 0.2 is somebody's real
 * credentials, and asking them to type an API token again because the app grew a
 * second plugin would be a poor trade.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { safeStorage } from 'electron';
import type { TimerState } from '@shared/types';
import { emptyState, normalizeState } from '@shared/timer-logic';
import { defaultLayout, type LayoutState } from '@shared/layout';
import { defaultShellConfig, type ShellConfig } from '@shared/shell';

/**
 * `JT_HOME` redirects everything to a scratch directory. That's what makes
 * scripts/sandbox.sh safe to run against the mock JIRA while your real tracked
 * time sits in the default location, untouched.
 */
export const DIR = process.env.JT_HOME
  ? path.resolve(process.env.JT_HOME)
  : path.join(os.homedir(), '.j-time');
export const STATE_FILE = path.join(DIR, 'state.json');
export const CONFIG_FILE = path.join(DIR, 'config.json');
/**
 * Where plugins live on disk: one directory per plugin, holding its source.
 *
 * The shipped plugins are installed here on first launch as worked examples,
 * next to a guide for writing another — see `plugins/install.ts`.
 */
export const PLUGINS_DIR = path.join(DIR, 'plugins');

/** Owner-only. Nothing in here is another account's business. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

let prepared: Promise<void> | null = null;

/**
 * Create the directory owner-only, once per run.
 *
 * `mkdir`'s mode applies only at creation, so a directory made by an earlier
 * version — or by a umask that widened it — keeps its old permissions. The chmod
 * is what actually narrows those, and it's best-effort: a directory we can't
 * chmod is still a directory we can write to, and refusing to save someone's
 * tracked time over a permission bit would be the worse failure.
 */
export function ensureDir(): Promise<void> {
  prepared ??= (async () => {
    await fs.mkdir(DIR, { recursive: true, mode: DIR_MODE });
    await fs.chmod(DIR, DIR_MODE).catch(() => undefined);
  })();
  return prepared;
}

/**
 * Write through a temp file in the same directory, then rename.
 *
 * A rename is atomic, so a crash or a quit mid-write leaves either the old file
 * or the new one — never a half-written state.json, which is the user's real
 * tracked time and has no other copy.
 *
 * The explicit chmod isn't redundant with `mode`: that only takes effect when the
 * file is created, and a temp file left behind by a crash with this same pid
 * would otherwise be reused at whatever permissions it already had.
 */
async function writeAtomic(file: string, contents: string): Promise<void> {
  await ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, contents, { encoding: 'utf8', mode: FILE_MODE });
  await fs.chmod(tmp, FILE_MODE);
  await fs.rename(tmp, file);
}

/**
 * The timer's state file, which stays exactly where it has always been.
 *
 * It belongs to the JIRA plugin now, but it is the one file in the app with no
 * second copy, so it does not move house for a refactor.
 */
export async function readState(): Promise<TimerState> {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    // Backfills fields added after a state file was written.
    return normalizeState({ activeKey: parsed.activeKey ?? null, stories: parsed.stories ?? {} });
  } catch {
    return emptyState();
  }
}

export async function writeState(state: TimerState): Promise<void> {
  await writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}

export type PluginConfigs = Record<string, Record<string, unknown>>;

export interface RootConfig {
  shell: ShellConfig;
  layout: LayoutState;
  plugins: PluginConfigs;
}

/**
 * Which fields of which plugin are secrets, by plugin id.
 *
 * The store has to be told rather than guessing: it is the only place that knows
 * how to encrypt, and the plugins are the only things that know which of their
 * fields is a credential.
 *
 * `{ list, field }` covers a plugin that holds *several* credentials — the PR
 * plugin keeps one token per account, because a fine-grained token can only
 * speak for one owner. Without it the choice would be encrypting a whole array
 * as an opaque blob, which makes the rest of the account unreadable, or leaving
 * the tokens in cleartext.
 */
export type SecretField = string | { list: string; field: string };
export type SecretFields = Record<string, readonly SecretField[]>;

/**
 * On disk a secret is encrypted under `<field>Enc`, so config.json can't be read
 * out of a backup or a synced home directory. The plaintext field is the fallback
 * for platforms with no OS keychain; it is never written when encryption works.
 *
 * That fallback is why the file mode matters as much as the encryption: on a
 * machine with no keychain these fields are the credentials, in cleartext.
 */
const encKey = (field: string): string => `${field}Enc`;

function decryptOne(raw: Record<string, unknown>, field: string): Record<string, unknown> {
  const out = { ...raw };
  const sealed = out[encKey(field)];
  delete out[encKey(field)];
  if (typeof sealed === 'string' && sealed) {
    try {
      out[field] = safeStorage.decryptString(Buffer.from(sealed, 'base64'));
      return out;
    } catch {
      // A keychain entry from another machine, or a reset login keychain. Treat
      // it as absent so the app asks again rather than sending garbage.
      out[field] = '';
      return out;
    }
  }
  if (typeof out[field] !== 'string') out[field] = '';
  return out;
}

function encryptOne(raw: Record<string, unknown>, field: string): Record<string, unknown> {
  const out = { ...raw };
  const value = out[field];
  delete out[field];
  if (typeof value !== 'string' || !value) return out;
  if (safeStorage.isEncryptionAvailable()) {
    out[encKey(field)] = safeStorage.encryptString(value).toString('base64');
  } else {
    out[field] = value;
  }
  return out;
}

/** Apply `fn` to a plugin's secret fields, whether flat or one per list entry. */
function mapSecrets(
  raw: Record<string, unknown>,
  fields: readonly SecretField[],
  fn: (obj: Record<string, unknown>, field: string) => Record<string, unknown>,
): Record<string, unknown> {
  let out = { ...raw };
  for (const spec of fields) {
    if (typeof spec === 'string') {
      out = fn(out, spec);
      continue;
    }
    const list = out[spec.list];
    if (!Array.isArray(list)) continue;
    out[spec.list] = list.map((entry) =>
      entry && typeof entry === 'object'
        ? fn(entry as Record<string, unknown>, spec.field)
        : entry,
    );
  }
  return out;
}

/**
 * A config written before the shell had plugins: one flat JIRA object with the
 * hotkey mixed in.
 *
 * Recognised by what it lacks. Anything with a `plugins` key is already current,
 * and an empty file is a first run rather than a migration.
 */
function migrate(stored: Record<string, unknown>): Record<string, unknown> {
  if (stored.plugins || Object.keys(stored).length === 0) return stored;
  const { hotkey, ...jira } = stored;
  return {
    shell: typeof hotkey === 'string' && hotkey ? { hotkey } : {},
    layout: {},
    plugins: { jira },
  };
}

export async function readConfig(secrets: SecretFields): Promise<RootConfig> {
  let stored: Record<string, unknown>;
  try {
    stored = migrate(JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')));
  } catch {
    stored = {};
  }

  const storedPlugins = (stored.plugins ?? {}) as PluginConfigs;
  const plugins: PluginConfigs = {};
  for (const [id, fields] of Object.entries(secrets)) {
    plugins[id] = mapSecrets(storedPlugins[id] ?? {}, fields, decryptOne);
  }
  // A section belonging to a plugin that isn't installed this launch is carried
  // through untouched, so uninstalling one doesn't wipe its credentials.
  for (const [id, raw] of Object.entries(storedPlugins)) {
    if (!(id in plugins)) plugins[id] = raw;
  }

  return {
    shell: { ...defaultShellConfig(), ...((stored.shell ?? {}) as Partial<ShellConfig>) },
    layout: { ...defaultLayout(), ...((stored.layout ?? {}) as Partial<LayoutState>) },
    plugins,
  };
}

export async function writeConfig(root: RootConfig, secrets: SecretFields): Promise<void> {
  const plugins: PluginConfigs = {};
  for (const [id, raw] of Object.entries(root.plugins)) {
    plugins[id] = mapSecrets(raw, secrets[id] ?? [], encryptOne);
  }
  await writeAtomic(
    CONFIG_FILE,
    JSON.stringify({ shell: root.shell, layout: root.layout, plugins }, null, 2),
  );
}
