/**
 * The contract for a plugin loaded from `~/.j-time/plugins` while the app runs.
 *
 * A compiled-in plugin hands the palette rows that carry closures, and a closure
 * can't cross the bridge — which is why a plugin that arrives at runtime has to
 * describe what it wants on screen as *data*: the same `Row` shape, with a
 * `run` that names a command instead of being one. Nothing of the plugin ever
 * executes in the renderer; its file runs in the main process, and the renderer
 * draws what came back the same way it draws everything else.
 *
 * Everything the plugin returns is untrusted as far as the shell is concerned —
 * not because the user's own code is hostile, but because a typo in it must land
 * on that plugin's section header rather than take the palette down.
 * `sanitiseContent` is that boundary, and it is pure so it can be tested.
 */

import type { ActionResult, Badge, Glyph, Row, Tone } from './plugin';

export type RuntimeFieldType = 'text' | 'password' | 'number' | 'textarea';

/** One input on the plugin's settings form. */
export interface RuntimeField {
  key: string;
  label: string;
  type?: RuntimeFieldType;
  /** Encrypted on disk, never sent to the renderer. Implies `password`. */
  secret?: boolean;
  placeholder?: string;
  /** Shown under the input. */
  note?: string;
}

/** What Enter does on a row: run one of the plugin's commands, or open a link. */
export type RuntimeRun =
  | { command: string; args?: unknown[]; /** Leave the palette open on success. */ stay?: boolean }
  | { url: string };

export interface RuntimeRow {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  subsection?: string;
  lead?: Glyph;
  badges?: Badge[];
  live?: boolean;
  pin?: boolean;
  enterLabel?: string;
  run?: RuntimeRun;
  actions?: RuntimeRow[];
  /** Only meaningful inside `actions`: a letter for ⌘-letter. */
  shortcut?: string;
}

/** What a plugin's `refresh` returns. */
export interface RuntimeContent {
  rows: RuntimeRow[];
  /** Section-level commands, opened with ⌘K on the header. */
  actions?: RuntimeRow[];
  /** Something for the menu bar, if no earlier plugin already has it. */
  menuBar?: { title: string; tooltip?: string } | null;
}

/** A runtime plugin's slice of the snapshot. */
export interface RuntimeSnapshot {
  id: string;
  title: string;
  /** Where its file lives, so Settings can say. */
  dir: string;
  fields: RuntimeField[];
  /** The config with every secret removed. */
  config: Record<string, unknown>;
  /** Whether each secret field currently holds something. */
  secretsSet: Record<string, boolean>;
  configured: boolean;
  content: RuntimeContent;
  /** The MCP tools it declared, already namespaced, so Settings can list them. */
  tools: string[];
  /** Why the file could not be loaded, when it couldn't. */
  loadError: string | null;
}

export const RUNTIME_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const GLYPHS: readonly Glyph[] = ['none', 'dot', 'active', 'attention', 'ok', 'blocked', 'muted'];
const TONES: readonly Tone[] = ['plain', 'accent', 'warn', 'danger'];
const KINDS = ['pill', 'clock', 'key'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const oneOf = <T extends string>(v: unknown, of: readonly T[]): T | undefined =>
  typeof v === 'string' && (of as readonly string[]).includes(v) ? (v as T) : undefined;

function badge(v: unknown): Badge | null {
  if (!isRecord(v) || typeof v.text !== 'string') return null;
  const out: Badge = { text: v.text };
  const kind = oneOf(v.kind, KINDS);
  const tone = oneOf(v.tone, TONES);
  if (kind) out.kind = kind;
  if (tone) out.tone = tone;
  if (v.live === true) out.live = true;
  return out;
}

function run(v: unknown): RuntimeRun | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.command === 'string' && v.command) {
    const out: RuntimeRun = { command: v.command };
    if (Array.isArray(v.args)) out.args = v.args;
    if (v.stay === true) out.stay = true;
    return out;
  }
  if (typeof v.url === 'string' && v.url) return { url: v.url };
  return undefined;
}

/**
 * A row with every field checked, or null when it can't be a row at all.
 *
 * An id and a title are the minimum: without an id the cursor has nothing to
 * follow, and a row with no title is a blank line. Anything else that is the
 * wrong shape is simply dropped, so one bad badge costs a badge, not the row.
 */
function row(v: unknown, depth: number): RuntimeRow | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const title = str(v.title);
  if (!id || !title) return null;
  const out: RuntimeRow = { id, title };
  const subtitle = str(v.subtitle);
  const subsection = str(v.subsection);
  const enterLabel = str(v.enterLabel);
  const lead = oneOf(v.lead, GLYPHS);
  if (subtitle) out.subtitle = subtitle;
  if (subsection) out.subsection = subsection;
  if (enterLabel) out.enterLabel = enterLabel;
  if (lead) out.lead = lead;
  if (Array.isArray(v.keywords)) {
    const keywords = v.keywords.filter((k): k is string => typeof k === 'string');
    if (keywords.length) out.keywords = keywords;
  }
  if (Array.isArray(v.badges)) {
    const badges = v.badges.map(badge).filter((b): b is Badge => b !== null);
    if (badges.length) out.badges = badges;
  }
  if (v.live === true) out.live = true;
  if (v.pin === true) out.pin = true;
  const r = run(v.run);
  if (r) out.run = r;
  // Actions of actions would be a third level the palette has no keys for.
  if (depth === 0 && Array.isArray(v.actions)) {
    const actions = rows(v.actions, 1);
    if (actions.length) out.actions = actions;
  }
  if (depth > 0) {
    const shortcut = str(v.shortcut);
    if (shortcut && shortcut.length === 1) out.shortcut = shortcut.toLowerCase();
  }
  return out;
}

function rows(v: unknown, depth: number): RuntimeRow[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => row(item, depth)).filter((r): r is RuntimeRow => r !== null);
}

/** Whatever a plugin's `refresh` returned, reduced to what the palette can draw. */
export function sanitiseContent(input: unknown): RuntimeContent {
  const out: RuntimeContent = { rows: [] };
  // A bare array is the common case and deserves to just work.
  if (Array.isArray(input)) {
    out.rows = rows(input, 0);
    return out;
  }
  if (!isRecord(input)) return out;
  out.rows = rows(input.rows, 0);
  const actions = rows(input.actions, 0);
  if (actions.length) out.actions = actions;
  if (isRecord(input.menuBar) && typeof input.menuBar.title === 'string') {
    out.menuBar = { title: input.menuBar.title };
    const tooltip = str(input.menuBar.tooltip);
    if (tooltip) out.menuBar.tooltip = tooltip;
  }
  return out;
}

/** The settings form a plugin declared, with anything malformed left out. */
export function sanitiseFields(input: unknown): RuntimeField[] {
  if (!Array.isArray(input)) return [];
  const out: RuntimeField[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!isRecord(item)) continue;
    const key = str(item.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const field: RuntimeField = { key, label: str(item.label) || key };
    const type = oneOf(item.type, ['text', 'password', 'number', 'textarea'] as const);
    if (type) field.type = type;
    if (item.secret === true) {
      field.secret = true;
      field.type = 'password';
    }
    const placeholder = str(item.placeholder);
    const note = str(item.note);
    if (placeholder) field.placeholder = placeholder;
    if (note) field.note = note;
    out.push(field);
  }
  return out;
}

/** The names of the fields the store must encrypt. */
export const secretKeys = (fields: RuntimeField[]): string[] =>
  fields.filter((f) => f.secret).map((f) => f.key);

/**
 * The config as the renderer may see it: every secret replaced by whether it is
 * set, which is all a form needs to say "there is a token here already".
 */
export function publicConfig(
  config: Record<string, unknown>,
  fields: RuntimeField[],
): Pick<RuntimeSnapshot, 'config' | 'secretsSet'> {
  const secrets = new Set(secretKeys(fields));
  const out: Record<string, unknown> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(config)) {
    if (secrets.has(key)) secretsSet[key] = typeof value === 'string' && value !== '';
    else out[key] = value;
  }
  for (const key of secrets) secretsSet[key] ??= false;
  return { config: out, secretsSet };
}

/**
 * Turn a settings form's values into the patch to save.
 *
 * A blank secret is left out rather than sent, so the store keeps the one it
 * has — the form never received it, so it can't be asked to give it back.
 * Numbers arrive as the strings an input holds and go out as numbers.
 */
export function patchFrom(
  fields: RuntimeField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key] ?? '';
    if (field.secret) {
      if (raw !== '') patch[field.key] = raw;
      continue;
    }
    patch[field.key] = field.type === 'number' ? Number(raw) || 0 : raw;
  }
  return patch;
}

/** What a runtime row needs from the renderer to become a real one. */
export interface RuntimeHandlers {
  command(name: string, args: unknown[], stay: boolean): void;
  url(url: string): void;
}

/**
 * The rows as the palette wants them: same shape, with the closures put back.
 *
 * A row without a `run` still needs one — Enter on it opens its actions, if it
 * has any, and otherwise does nothing — so it gets a no-op rather than making
 * every caller check.
 */
export function rowsFrom(rows: RuntimeRow[], on: RuntimeHandlers): Row[] {
  return rows.map((r) => {
    const out: Row = {
      id: r.id,
      title: r.title,
      run: () => {
        if (!r.run) return;
        if ('url' in r.run) on.url(r.run.url);
        else on.command(r.run.command, r.run.args ?? [], r.run.stay === true);
      },
    };
    if (r.subtitle) out.subtitle = r.subtitle;
    if (r.keywords) out.keywords = r.keywords;
    if (r.subsection) out.subsection = r.subsection;
    if (r.lead) out.lead = r.lead;
    if (r.badges) out.badges = r.badges;
    if (r.live) out.live = true;
    if (r.pin) out.pin = true;
    if (r.enterLabel) out.enterLabel = r.enterLabel;
    else if (r.run && 'url' in r.run) out.enterLabel = 'Open';
    if (r.shortcut) out.shortcut = r.shortcut;
    if (r.actions) out.actions = rowsFrom(r.actions, on);
    return out;
  });
}

export const emptyRuntimeContent = (): RuntimeContent => ({ rows: [] });

export type { ActionResult };
