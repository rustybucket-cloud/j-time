/**
 * Everything on disk: the timer state and the config, both under ~/.j-time.
 *
 * Deliberately NOT ~/.jira-timer. j-time is a second writer with no lock between
 * them, so sharing that file with an always-on jira-timer would interleave two
 * read-modify-write cycles and silently drop segments.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { safeStorage } from 'electron';
import type { TimerState } from '@shared/types';
import { emptyState, normalizeState } from '@shared/timer-logic';
import { defaultConfig, type JiraConfig } from '@shared/conn';

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
function ensureDir(): Promise<void> {
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

/**
 * On disk the token is encrypted, so config.json can't be read out of a backup or
 * a synced home directory. `apiToken` is the plaintext fallback for the platforms
 * where the OS keychain isn't available; it is never written when encryption is.
 *
 * That fallback is why the file mode matters as much as the encryption: on a
 * machine with no keychain this field is the token, in cleartext.
 */
interface StoredConfig extends Partial<Omit<JiraConfig, 'apiToken'>> {
  apiToken?: string;
  apiTokenEnc?: string;
}

function decryptToken(stored: StoredConfig): string {
  if (stored.apiTokenEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.apiTokenEnc, 'base64'));
    } catch {
      // A keychain entry from another machine, or a reset login keychain. Treat it
      // as absent so the app asks for the token again rather than sending garbage.
      return '';
    }
  }
  return stored.apiToken ?? '';
}

export async function readConfig(): Promise<JiraConfig> {
  const base = defaultConfig();
  let stored: StoredConfig;
  try {
    stored = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return base;
  }
  return {
    ...base,
    ...stored,
    apiToken: decryptToken(stored),
    // Arrays and numbers from an older file can be the wrong shape; keep the
    // defaults rather than letting a bad config break the palette.
    activities: Array.isArray(stored.activities) ? stored.activities : base.activities,
    roundMinutes: Number.isFinite(stored.roundMinutes) ? Number(stored.roundMinutes) : base.roundMinutes,
    boardId: typeof stored.boardId === 'number' ? stored.boardId : null,
    hotkey: stored.hotkey || base.hotkey,
  };
}

export async function writeConfig(config: JiraConfig): Promise<void> {
  const { apiToken, ...rest } = config;
  const stored: StoredConfig = { ...rest };
  if (apiToken && safeStorage.isEncryptionAvailable()) {
    stored.apiTokenEnc = safeStorage.encryptString(apiToken).toString('base64');
  } else if (apiToken) {
    stored.apiToken = apiToken;
  }
  await writeAtomic(CONFIG_FILE, JSON.stringify(stored, null, 2));
}
