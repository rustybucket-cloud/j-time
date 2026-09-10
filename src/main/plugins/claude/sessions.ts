/**
 * Reading Claude Code's own files. Nothing here decides anything.
 *
 * Two sources, both of them Claude Code's rather than ours, and both read-only:
 * `<config>/sessions/<pid>.json`, which every live session keeps up to date, and
 * `<config>/projects/<escaped cwd>/<session id>.jsonl`, its transcript. The rule
 * that turns them into a state lives in `@shared/claude`, where it is testable.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { ClaudeSession, OpenCall } from '@shared/claude';

/**
 * `CLAUDE_CONFIG_DIR` is Claude Code's own override, so honouring it costs a line
 * and makes this plugin point at a scratch directory the way `JT_HOME` does.
 */
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(os.homedir(), '.claude');

const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/**
 * How much of the tail to read.
 *
 * Only the last few records matter — an unanswered call is by definition at the
 * end, and `ai-title` is rewritten every turn — and transcripts run to megabytes,
 * which is not a thing to read every few seconds. A record longer than this
 * window is dropped as a partial line, which costs an "attention" we'd otherwise
 * have inferred rather than inventing one.
 */
const TAIL_BYTES = 128 * 1024;

/** Claude Code's own escaping: every character that isn't alphanumeric becomes a dash. */
const projectDir = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Is the process still there?
 *
 * Signal 0 checks without delivering anything. `EPERM` means it exists and isn't
 * ours, which counts as alive — dead is only `ESRCH`. Stale files accumulate:
 * every crashed session leaves one behind, and listing those as idle sessions
 * would be listing things that cannot be gone back to.
 */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The last `TAIL_BYTES` of a file, minus whatever line the window cut in half. */
async function tail(file: string): Promise<string[]> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // The first line is only whole when the window happened to start at the top.
    if (size > length) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

/** What names this particular call, for the row that reports it. */
function callDetail(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };

  if (name === 'AskUserQuestion') {
    const questions = args.questions;
    const one = Array.isArray(questions) ? (questions[0] as Record<string, unknown>) : null;
    const asked = one && typeof one.question === 'string' ? one.question : '';
    return asked || 'Waiting on an answer';
  }
  return first('command', 'file_path', 'description', 'pattern', 'url', 'path', 'prompt');
}

const ts = (record: Record<string, unknown>): number => {
  const raw = record.timestamp;
  const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
};

interface Tail {
  /** The last `ai-title` in the window — what `/resume` lists the session under. */
  title: string | null;
  /**
   * The last tool call nothing has answered.
   *
   * Results always follow their call, so a call inside the window has its result
   * inside the window too if it has one at all — which is what makes a fixed-size
   * tail sound rather than merely cheap.
   */
  open: OpenCall | null;
}

export async function readTail(file: string): Promise<Tail> {
  let lines: string[];
  try {
    lines = await tail(file);
  } catch {
    return { title: null, open: null };
  }

  let title: string | null = null;
  const pending = new Map<string, OpenCall>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Rewritten every turn, so the last one in the window is the current one.
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle) {
      title = record.aiTitle;
      continue;
    }

    const message = record.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        const name = typeof b.name === 'string' ? b.name : 'a tool';
        pending.set(b.id, { tool: name, detail: callDetail(name, b.input), at: ts(record) });
      }
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        pending.delete(b.tool_use_id);
      }
    }
  }

  // Several can be outstanding at once — parallel calls in one turn. The last is
  // the one whose prompt is on screen.
  const outstanding = [...pending.values()];
  return { title, open: outstanding.length > 0 ? outstanding[outstanding.length - 1] : null };
}

/** Where a session's transcript lives, if it is where the cwd says it should be. */
function transcriptPath(id: string, cwd: string): string {
  return path.join(PROJECTS_DIR, projectDir(cwd), `${id}.jsonl`);
}

/**
 * What the last read of a transcript found, against the mtime it found it at.
 *
 * The title is the reason this exists. Reading it means opening every session's
 * transcript rather than only the busy ones, and an idle session's transcript
 * does not change — so the file is read once and afterwards costs a `stat`. A
 * blocked session writes nothing either, which is why the open call is cached
 * alongside rather than re-read: while it sits there, nothing about it moves.
 */
const cache = new Map<string, Tail & { mtimeMs: number }>();

interface StateFile {
  sessionId?: unknown;
  pid?: unknown;
  name?: unknown;
  cwd?: unknown;
  status?: unknown;
  statusUpdatedAt?: unknown;
  updatedAt?: unknown;
  startedAt?: unknown;
}

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Every session that is still running. */
export async function readSessions(): Promise<ClaudeSession[]> {
  let names: string[];
  try {
    names = await fs.readdir(SESSIONS_DIR);
  } catch {
    // No Claude Code on this machine, or none has run yet. Not a failure.
    return [];
  }

  const sessions: ClaudeSession[] = [];
  await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        let raw: StateFile;
        try {
          raw = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, name), 'utf8')) as StateFile;
        } catch {
          return;
        }

        const pid = num(raw.pid);
        const id = typeof raw.sessionId === 'string' ? raw.sessionId : '';
        const cwd = typeof raw.cwd === 'string' ? raw.cwd : '';
        if (!id || !alive(pid)) return;

        const startedAt = num(raw.startedAt);
        sessions.push({
          id,
          pid,
          name: typeof raw.name === 'string' && raw.name ? raw.name : id.slice(0, 8),
          title: null,
          cwd,
          busy: raw.status === 'busy',
          changedAt: num(raw.statusUpdatedAt, num(raw.updatedAt, startedAt)),
          startedAt,
          open: null,
        });
      }),
  );

  await Promise.all(
    sessions.map(async (session) => {
      const file = transcriptPath(session.id, session.cwd);
      let mtimeMs: number;
      try {
        ({ mtimeMs } = await fs.stat(file));
      } catch {
        // A session whose transcript isn't under its cwd — the IDE extension
        // writes one of these. It keeps its name and never reports as waiting.
        return;
      }

      const cached = cache.get(session.id);
      const found = cached?.mtimeMs === mtimeMs ? cached : await readTail(file);
      cache.set(session.id, { ...found, mtimeMs });

      session.title = found.title;
      // Only a busy session can be waiting on something. An unanswered call left
      // in an idle one's tail is what it was killed in the middle of.
      session.open = session.busy ? found.open : null;
    }),
  );

  // A session that has ended is never coming back under the same id.
  const live = new Set(sessions.map((session) => session.id));
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);

  return sessions;
}
