/**
 * What a plugin may put on screen, and what the shell will draw.
 *
 * The vocabulary here is deliberately small. Plugins hand back data, not markup:
 * a `Glyph` is a *meaning* ("this needs attention"), not a colour or a character,
 * and a `Badge` picks from the handful of shapes `styles.css` already defines. The
 * design tokens survive a second plugin only if the second plugin cannot invent a
 * new pill — one accent, warn and danger for things wanting attention, green for
 * status alone. A plugin returning arbitrary JSX would undo that in an afternoon.
 *
 * Rows carry closures rather than serialisable commands, which is what keeps the
 * builders as direct as they were when there was only a board to draw. The cost is
 * that plugins are compiled in: a runtime-loaded plugin can't ship a closure across
 * the bridge, and moving to one later means revisiting `run`.
 */

import type { ReactNode } from 'react';

/** The result of anything a row can do. Same shape for every plugin. */
export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

export type QueryResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * A row's leading mark, by meaning rather than appearance.
 *
 * Semantic on purpose: `attention` is a PR waiting on you and an unfiled chunk of
 * time, and both should look the same without either plugin having said "orange".
 */
export type Glyph = 'none' | 'dot' | 'active' | 'attention' | 'ok' | 'blocked' | 'muted';

export type Tone = 'plain' | 'accent' | 'warn' | 'danger';

/**
 * A trailing chip. `pill` is a label, `clock` a duration in the tabular figures the
 * timer uses, `key` a keyboard hint.
 */
export interface Badge {
  text: string;
  kind?: 'pill' | 'clock' | 'key';
  tone?: Tone;
  /** Ticking, so the clock style knows to look live. */
  live?: boolean;
}

/** One line in the palette, whatever level it appears at. */
export interface Row {
  /** Unique within its plugin. The shell namespaces it before it reaches a list. */
  id: string;
  title: string;
  subtitle?: string;
  /** Extra terms that should match a query but aren't shown. */
  keywords?: string[];
  /** Groups rows inside the plugin's own section. Absent means the section body. */
  subsection?: string;
  lead?: Glyph;
  badges?: Badge[];
  /** Draws the row as live — the running-timer treatment. */
  live?: boolean;
  /**
   * Asks the shell to lift this row above every section. At most one row per
   * plugin is honoured, and the user can turn a plugin's pin off entirely, so a
   * plugin cannot colonise the top of the list.
   */
  pin?: boolean;
  /** What the footer calls Enter on this row. Defaults to "Run". */
  enterLabel?: string;
  /** What Enter does. */
  run: () => void;
  /** What ⌘K opens. Absent means the row has no further actions. */
  actions?: Row[];
  /**
   * A ⌘-chord that runs this action directly while its parent row is selected,
   * e.g. `f` for ⌘F. Only meaningful inside `actions`.
   */
  shortcut?: string;
}

/** A plugin's contribution to the root list, before the user's layout is applied. */
export interface SectionContent {
  rows: Row[];
  /** Section-level commands: Refresh, Configure, anything not about one row. */
  actions?: Row[];
  /** Shown next to the section title when a fetch is in flight or has failed. */
  note?: string;
  /** A failed fetch. The rows stay on screen — they're the last good ones. */
  error?: string | null;
}

/** A screen a plugin owns outright, addressed by name so the shell can route to it. */
export interface PluginScreen {
  plugin: string;
  view: string;
  arg?: string;
}

/** What every entry builder is handed. Keeps the builders free of React state. */
export interface Ctx {
  now: number;
  /** Run an action, report the result, and close the palette when it succeeds. */
  act: (fn: () => Promise<ActionResult>) => void;
  /** Same, but leave the palette open — for things you'd do several of in a row. */
  actStay: (fn: () => Promise<ActionResult>) => void;
  push: (overlay: Overlay) => void;
  pushAsync: (title: string, placeholder: string, load: () => Promise<Row[]>) => void;
  /** Open one of this plugin's own screens. */
  open: (screen: PluginScreen) => void;
  openSettings: (plugin: string) => void;
}

export interface Overlay {
  title: string;
  placeholder: string;
  rows: Row[];
}

/**
 * The renderer half of a plugin: everything that turns a snapshot into rows.
 *
 * `screen` and `settings` are the two places a plugin may return React outright.
 * A list is a shared visual language and stays constrained; a full-screen form or
 * readout is one at a time and answers to nothing else on screen.
 */
export interface PluginView<S = unknown> {
  id: string;
  title: string;
  /** The section body. Called on every render, so it must stay cheap and pure. */
  section(snapshot: S, ctx: Ctx): SectionContent;
  /** Rows offered in the global command list, e.g. "Switch board…". */
  commands?(snapshot: S, ctx: Ctx): Row[];
  screen?(snapshot: S, ctx: Ctx, view: string, arg?: string): ReactNode;
  settings?(snapshot: S, onSaved: (message: string) => void): ReactNode;
  /** False when the plugin has no credentials yet, so the shell can say so. */
  configured?(snapshot: S): boolean;
}
