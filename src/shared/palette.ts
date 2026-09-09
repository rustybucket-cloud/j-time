/**
 * What the command palette shows and in what order.
 *
 * Pure, and tested on its own: the ranking is the part of a Raycast-style launcher
 * that is easy to get subtly wrong and impossible to eyeball. The renderer only
 * draws what these functions return.
 */

import { activeSeconds, isRunning } from './time';
import type { StageGroups, StageRow } from './stages';
import { unloggedSeconds } from './timer-logic';

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

export const SECTION_RUNNING = 'Running';
export const SECTION_LABELS = {
  doing: 'In Progress',
  todo: 'To Do',
  done: 'Done',
  elsewhere: 'Tracked elsewhere',
} as const;

export interface IssueItem extends Searchable {
  kind: 'issue';
  row: StageRow;
  section: string;
  running: boolean;
  /** Every second this app has measured against the story. */
  trackedSeconds: number;
  /** Tracked time no worklog covers yet — what filing or Done would still send. */
  unloggedSeconds: number;
}

/**
 * The board, flattened into one ranked-and-sectioned list.
 *
 * In Progress leads because it is the reason this app opens on a keystroke: the
 * question being answered is "which of the things I'm in the middle of am I about
 * to work on". To Do follows, then Done, then stories the current board no longer
 * lists. The running story is lifted into its own section at the very top — it is
 * the one row whose state changes while you're looking at it.
 */
export function buildIssueItems(groups: StageGroups, now: number): IssueItem[] {
  const order: (keyof typeof SECTION_LABELS)[] = ['doing', 'todo', 'done', 'elsewhere'];
  const items: IssueItem[] = [];

  for (const stage of order) {
    for (const row of groups[stage]) {
      const timer = row.timer;
      const running = timer ? isRunning(timer.segments) : false;
      items.push({
        kind: 'issue',
        id: `issue:${row.key}`,
        title: row.key,
        subtitle: row.summary,
        keywords: [row.status, row.boardName ?? '', row.assignee ?? ''].filter(Boolean),
        row,
        section: running ? SECTION_RUNNING : SECTION_LABELS[stage],
        running,
        trackedSeconds: timer ? activeSeconds(timer.segments, now) : 0,
        unloggedSeconds: timer ? unloggedSeconds(timer, now) : 0,
      });
    }
  }

  // Pinned rather than sorted in place, so a story keeps its column identity in
  // the label while still being the first thing under the cursor.
  return [...items.filter((i) => i.running), ...items.filter((i) => !i.running)];
}

/** Group an already-ordered list into contiguous runs, for section headings. */
export function sectioned<T extends { section: string }>(
  ranked: { item: T }[],
): { section: string; items: { item: T }[] }[] {
  const out: { section: string; items: { item: T }[] }[] = [];
  for (const entry of ranked) {
    const last = out[out.length - 1];
    if (last && last.section === entry.item.section) last.items.push(entry);
    else out.push({ section: entry.item.section, items: [entry] });
  }
  return out;
}
