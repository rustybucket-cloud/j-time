/**
 * The root list: several plugins' rows, arranged the way the user arranged them,
 * narrowed by whatever they've typed.
 *
 * Pure and tested here for the same reason the ranking is. Sectioning, pinning
 * and moving a cursor over collapsed groups are all things you cannot eyeball —
 * the renderer draws what this returns and decides nothing.
 */

import { rank } from './palette';
import type { Row } from './plugin';

/** A plugin's section, with the user's arrangement already applied to it. */
export interface SectionInput {
  id: string;
  title: string;
  rows: Row[];
  collapsed: boolean;
  /** Whether this plugin's pinned row may be lifted above the sections. */
  pins: boolean;
  note?: string;
  error?: string | null;
}

export interface PaletteRow {
  kind: 'row';
  /** Namespaced with the owning plugin, so two plugins can both have a `refresh`. */
  id: string;
  sectionId: string;
  row: Row;
  titleIndices: number[];
  subtitleIndices: number[];
}

export interface PaletteHeader {
  kind: 'header';
  id: string;
  sectionId: string;
  title: string;
  collapsed: boolean;
  /** How many rows the collapse is hiding, so the header can say what's behind it. */
  hidden: number;
  note?: string;
  error?: string | null;
  /** Pinned and Top hit are the shell's own; they don't collapse and don't move. */
  fixed: boolean;
}

export interface PaletteGroup {
  /** The plugin's own subsection heading, if it gave one. */
  subsection?: string;
  rows: PaletteRow[];
}

export interface PaletteSection {
  header: PaletteHeader;
  groups: PaletteGroup[];
}

export interface PaletteView {
  sections: PaletteSection[];
  /** Everything the cursor can land on, in the order it appears. */
  flat: (PaletteHeader | PaletteRow)[];
}

export const PINNED_SECTION = 'Pinned';
export const TOP_HIT_SECTION = 'Top hit';

export const headerId = (sectionId: string): string => `sec:${sectionId}`;
export const rowId = (sectionId: string, row: Row): string => `${sectionId}:${row.id}`;

interface Scored {
  row: PaletteRow;
  score: number;
  /** Position in the plugin's own order, so ties can't jitter between keystrokes. */
  index: number;
}

function score(section: SectionInput, query: string): Scored[] {
  const out: Scored[] = [];
  section.rows.forEach((row, index) => {
    const ranked = rank(row, query);
    if (!ranked) return;
    out.push({
      row: {
        kind: 'row',
        id: rowId(section.id, row),
        sectionId: section.id,
        row,
        titleIndices: ranked.titleIndices,
        subtitleIndices: ranked.subtitleIndices,
      },
      score: ranked.score,
      index,
    });
  });
  return out;
}

/** Contiguous runs of the same subsection, so a plugin can group inside its own section. */
function group(rows: PaletteRow[]): PaletteGroup[] {
  const out: PaletteGroup[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.subsection === row.row.subsection) last.rows.push(row);
    else out.push({ subsection: row.row.subsection, rows: [row] });
  }
  return out;
}

/**
 * Pinned and Top hit, which the shell builds rather than a plugin.
 *
 * Deliberately *not* grouped by subsection: these rows are lifted out of several
 * plugins at once, and carrying "In Progress" and "Needs your review" up with
 * them turned a two-row section into four lines of heading. Up here the row's
 * own section is the context that matters, and it's a scroll away.
 */
function fixedSection(title: string, rows: PaletteRow[]): PaletteSection {
  return {
    header: {
      kind: 'header',
      id: headerId(title),
      sectionId: title,
      title,
      collapsed: false,
      hidden: 0,
      fixed: true,
    },
    groups: rows.length > 0 ? [{ rows }] : [],
  };
}

/**
 * Build the whole list.
 *
 * With no query the sections keep the user's order and each plugin keeps its own
 * order inside its section — the same rule the single-board palette had, one level
 * up. Typing sorts *within* each section and leaves the sections themselves where
 * they are: the arrangement is the thing the user set up, and dissolving it the
 * moment they search would make it useless exactly when they're looking for
 * something. What typing does instead is lift the single best match across every
 * section to the top, so a strong hit in the last section is still one Enter away.
 *
 * A collapsed section auto-expands when the query finds something in it; a section
 * with no matches disappears entirely rather than leaving a wall of empty headings.
 */
export function buildPalette(sections: SectionInput[], query: string): PaletteView {
  const searching = query.trim().length > 0;
  const out: PaletteSection[] = [];

  // Pins are a property of the resting list. While searching, the top hit occupies
  // that slot instead — two competing claims on the first row is one too many.
  const pinned: PaletteRow[] = [];
  const scored = sections.map((section) => ({ section, hits: score(section, query) }));

  if (!searching) {
    for (const { section, hits } of scored) {
      if (!section.pins) continue;
      // One per plugin. A plugin that pinned everything would just be first.
      const at = hits.findIndex((h) => h.row.row.pin);
      if (at >= 0) pinned.push(...hits.splice(at, 1).map((h) => h.row));
    }
    if (pinned.length > 0) out.push(fixedSection(PINNED_SECTION, pinned));
  }

  const body: PaletteSection[] = [];
  for (const { section, hits } of scored) {
    if (searching) {
      if (hits.length === 0) continue;
      hits.sort((a, b) => b.score - a.score || a.index - b.index);
    }
    // Auto-expanded while searching: a collapsed section that silently swallowed
    // the only match would read as "no results".
    const collapsed = section.collapsed && !searching;
    body.push({
      header: {
        kind: 'header',
        id: headerId(section.id),
        sectionId: section.id,
        title: section.title,
        collapsed,
        hidden: collapsed ? hits.length : 0,
        note: section.note,
        error: section.error ?? null,
        fixed: false,
      },
      groups: collapsed ? [] : group(hits.map((h) => h.row)),
    });
  }

  if (searching) {
    const top = bestHit(scored);
    // Only worth its own heading when it isn't already the row under the cursor.
    if (top && body[0]?.groups[0]?.rows[0]?.id !== top.row.id) {
      remove(body, top.row.id);
      out.push(fixedSection(TOP_HIT_SECTION, [top.row]));
    }
  }

  // A section emptied by the hoist has nothing left to head. With no query the
  // empty ones stay: a header reading "not set up yet" is how you find out a
  // plugin exists at all.
  out.push(...(searching ? body.filter((s) => s.groups.length > 0) : body));

  const flat: (PaletteHeader | PaletteRow)[] = [];
  for (const section of out) {
    flat.push(section.header);
    for (const g of section.groups) flat.push(...g.rows);
  }
  return { sections: out, flat };
}

function bestHit(scored: { hits: Scored[] }[]): Scored | null {
  let best: Scored | null = null;
  for (const { hits } of scored) {
    for (const hit of hits) if (!best || hit.score > best.score) best = hit;
  }
  return best;
}

/** Pull a row back out of the section it was ranked into, once it's been hoisted. */
function remove(sections: PaletteSection[], id: string): void {
  for (const section of sections) {
    for (const g of section.groups) {
      const at = g.rows.findIndex((r) => r.id === id);
      if (at >= 0) g.rows.splice(at, 1);
    }
    section.groups = section.groups.filter((g) => g.rows.length > 0);
  }
}

/**
 * Move the cursor, wrapping at both ends.
 *
 * Selection is an id rather than an index, so a row that filters away hands the
 * cursor to the top instead of to whatever slid into its slot — and a section that
 * collapses hands it to that section's header, which is the one thing on screen
 * that certainly still exists.
 */
export function moveSelection(view: PaletteView, current: string | null, delta: number): string | null {
  const { flat } = view;
  if (flat.length === 0) return null;
  const at = flat.findIndex((e) => e.id === current);
  const from = at < 0 ? (delta > 0 ? -1 : 0) : at;
  const next = (((from + delta) % flat.length) + flat.length) % flat.length;
  return flat[next].id;
}

/** Where the cursor should sit after `sectionId` collapses under it. */
export function selectionAfterCollapse(current: string | null, sectionId: string): string {
  return current && current.startsWith(`${sectionId}:`) ? headerId(sectionId) : (current ?? headerId(sectionId));
}

export function findEntry(view: PaletteView, id: string | null): PaletteHeader | PaletteRow | null {
  if (!id) return null;
  return view.flat.find((e) => e.id === id) ?? null;
}

/** The first row the cursor should take when a list is first shown. */
export function firstSelectable(view: PaletteView): string | null {
  return view.flat.find((e) => e.kind === 'row')?.id ?? view.flat[0]?.id ?? null;
}

/**
 * A drilled-into level — an action list, an activity picker — as the same view.
 *
 * One list, no section headers, ranked as a whole rather than per section: a
 * picker is already the answer to "which of these", so there is nothing for the
 * user's section arrangement to say about it. Grouping still applies, so a picker
 * can head its own runs the way the Finish dialog separates the preferred
 * transition from the rest.
 */
export function buildOverlay(rows: Row[], query: string): PaletteView {
  const hits = score({ id: '', title: '', rows, collapsed: false, pins: false }, query);
  if (query.trim()) hits.sort((a, b) => b.score - a.score || a.index - b.index);

  const groups = group(hits.map((h) => h.row));
  const flat: (PaletteHeader | PaletteRow)[] = groups.flatMap((g) => g.rows);
  return { sections: [{ header: overlayHeader(), groups }], flat };
}

/** Overlays have no heading of their own — the search field's title says where you are. */
function overlayHeader(): PaletteHeader {
  return {
    kind: 'header',
    id: headerId(''),
    sectionId: '',
    title: '',
    collapsed: false,
    hidden: 0,
    fixed: true,
  };
}
