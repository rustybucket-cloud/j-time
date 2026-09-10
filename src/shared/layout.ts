/**
 * The user's arrangement of the sections: order, what's collapsed, whose pin is
 * allowed to jump the queue.
 *
 * Kept apart from the plugins themselves because it has to survive them. A plugin
 * that isn't installed this launch must not lose its place, and one that appears
 * for the first time must not land in the middle of an order the user arranged.
 */

export interface LayoutState {
  /** Plugin ids, in display order. May name plugins that aren't installed. */
  order: string[];
  /** Sections showing only their header. */
  collapsed: string[];
  /** Plugins whose pinned row the user does not want lifted to the top. */
  pinsOff: string[];
}

export function defaultLayout(): LayoutState {
  return { order: [], collapsed: [], pinsOff: [] };
}

/** One section's arrangement, resolved against what's actually installed. */
export interface ResolvedSection {
  id: string;
  collapsed: boolean;
  /** Whether this plugin's pinned row may be lifted above the sections. */
  pins: boolean;
}

/**
 * Apply a saved layout to the plugins that exist right now.
 *
 * Saved ids that aren't installed are dropped from the result but left in the
 * stored order by `moveSection`, so uninstalling a plugin and putting it back
 * doesn't cost the user their arrangement. Installed ids the layout has never
 * seen go to the end, in registration order: a new plugin announces itself at the
 * bottom rather than displacing whatever the user put first.
 */
export function resolveLayout(layout: LayoutState, available: string[]): ResolvedSection[] {
  const known = new Set(available);
  const placed = layout.order.filter((id) => known.has(id));
  const seen = new Set(placed);
  const appended = available.filter((id) => !seen.has(id));

  return [...placed, ...appended].map((id) => ({
    id,
    collapsed: layout.collapsed.includes(id),
    pins: !layout.pinsOff.includes(id),
  }));
}

export function toggleCollapsed(layout: LayoutState, id: string): LayoutState {
  const collapsed = layout.collapsed.includes(id)
    ? layout.collapsed.filter((x) => x !== id)
    : [...layout.collapsed, id];
  return { ...layout, collapsed };
}

export function togglePins(layout: LayoutState, id: string): LayoutState {
  const pinsOff = layout.pinsOff.includes(id)
    ? layout.pinsOff.filter((x) => x !== id)
    : [...layout.pinsOff, id];
  return { ...layout, pinsOff };
}

/**
 * Move a section one place up or down among the sections that are *visible*.
 *
 * `available` is not optional for a reason: the stored order can name plugins
 * that aren't installed, and swapping blindly with the neighbouring stored id
 * would trade places with something invisible — the section would appear not to
 * move at all. The move is computed over the resolved list instead, and written
 * back as a full order with the absent plugins parked on the end.
 */
export function moveSection(
  layout: LayoutState,
  available: string[],
  id: string,
  delta: number,
): LayoutState {
  const resolved = resolveLayout(layout, available).map((s) => s.id);
  const from = resolved.indexOf(id);
  if (from < 0) return layout;
  const to = from + delta;
  if (to < 0 || to >= resolved.length) return layout;

  const next = [...resolved];
  next.splice(to, 0, ...next.splice(from, 1));

  const absent = layout.order.filter((x) => !next.includes(x));
  return { ...layout, order: [...next, ...absent] };
}

/**
 * Record an arrangement the user can't see all of.
 *
 * `resolveLayout` appends unseen plugins on every call, which is stable to read
 * but means the stored order never mentions them — so the first drag of an old
 * section would jump a new one to the top. Freezing the resolved order at the
 * moment of a change keeps what's on screen and what's on disk in agreement.
 */
export function freezeOrder(layout: LayoutState, available: string[]): LayoutState {
  const resolved = resolveLayout(layout, available).map((s) => s.id);
  const absent = layout.order.filter((x) => !resolved.includes(x));
  return { ...layout, order: [...resolved, ...absent] };
}
