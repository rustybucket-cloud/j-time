/**
 * What the command palette shows and in what order.
 *
 * Pure, and tested on its own: the ranking is the part of a Raycast-style launcher
 * that is easy to get subtly wrong and impossible to eyeball. The renderer only
 * draws what these functions return.
 */

/** Anything the palette can list. `id` must be unique across the whole list. */
export interface Searchable {
  id: string;
  title: string;
  subtitle?: string;
  /** Extra terms that should match but aren't shown, e.g. a status or board name. */
  keywords?: string[];
}

export interface Ranked<T extends Searchable> {
  item: T;
  score: number;
  /** Character offsets to highlight, for the field they were found in. */
  titleIndices: number[];
  subtitleIndices: number[];
}

export interface Match {
  score: number;
  indices: number[];
}

const WORD_BREAK = /[^a-z0-9]/;

/**
 * Score `query` against `text` as an ordered subsequence, or null when the
 * characters don't all appear in order.
 *
 * The bonuses are what make "og12" beat "o…g…1…2 scattered across a sentence":
 * consecutive characters and characters starting a word are worth far more than
 * a bare match, so typing the start of an issue key or of a word in the summary
 * ranks that issue above an incidental letter-by-letter hit.
 */
export function fuzzyMatch(text: string, query: string): Match | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();

  const indices: number[] = [];
  let score = 0;
  let at = 0;
  let previous = -2;

  for (const ch of q) {
    // Spaces in a query mean "and then later", not a literal space to find.
    if (ch === ' ') {
      previous = -2;
      continue;
    }
    const found = t.indexOf(ch, at);
    if (found === -1) return null;

    score += 10;
    if (found === previous + 1) score += 15;
    else if (found === 0 || WORD_BREAK.test(t[found - 1])) score += 12;
    // A long jump to find the next character is weak evidence; cap the penalty so
    // a match late in a long summary still beats no match at all.
    else score -= Math.min(6, found - at);

    indices.push(found);
    previous = found;
    at = found + 1;
  }

  // Among equally good matches, prefer the shorter text — "OG-12" over a summary
  // that happens to contain the same letters.
  return { score: score - text.length * 0.05, indices };
}

const TITLE_WEIGHT = 1.6;
const KEYWORD_WEIGHT = 0.6;

/** Best score across an item's fields, keeping the highlights for each. */
export function rank<T extends Searchable>(item: T, query: string): Ranked<T> | null {
  if (!query.trim()) {
    return { item, score: 0, titleIndices: [], subtitleIndices: [] };
  }
  const title = fuzzyMatch(item.title, query);
  const subtitle = item.subtitle ? fuzzyMatch(item.subtitle, query) : null;
  const keyword = (item.keywords ?? [])
    .map((k) => fuzzyMatch(k, query))
    .reduce<Match | null>((best, m) => (m && (!best || m.score > best.score) ? m : best), null);

  const best = Math.max(
    title ? title.score * TITLE_WEIGHT : -Infinity,
    subtitle ? subtitle.score : -Infinity,
    keyword ? keyword.score * KEYWORD_WEIGHT : -Infinity,
  );
  if (best === -Infinity) return null;

  return {
    item,
    score: best,
    titleIndices: title?.indices ?? [],
    subtitleIndices: subtitle?.indices ?? [],
  };
}

/**
 * Filter and order a list for the current query.
 *
 * An empty query keeps the caller's order untouched — that order is the board's
 * own, and reshuffling the default view would undo the one thing this app is
 * meant to make glanceable. Only once you type does score take over, and ties
 * fall back to the original order so the list never jitters between keystrokes.
 */
export function filterPalette<T extends Searchable>(items: T[], query: string): Ranked<T>[] {
  const ranked = items
    .map((item, i) => ({ i, r: rank(item, query) }))
    .filter((x): x is { i: number; r: Ranked<T> } => x.r !== null);

  if (query.trim()) ranked.sort((a, b) => b.r.score - a.r.score || a.i - b.i);
  return ranked.map((x) => x.r);
}

/** Move a selection by `delta`, wrapping at both ends. Empty lists stay at -1. */
export function nextIndex(length: number, current: number, delta: number): number {
  if (length <= 0) return -1;
  const from = current < 0 ? (delta > 0 ? -1 : 0) : current;
  return (((from + delta) % length) + length) % length;
}
