/**
 * Activity labels for chunks of tracked time, and the arithmetic for splitting a
 * rounded total across them.
 *
 * Pure and free of `server-only` so it can be unit-tested and imported from the
 * client as well as the API routes.
 */

export const DEFAULT_ACTIVITIES = ['Meeting', 'Building', 'Testing', 'Review', 'Other'] as const;

/** Time that was stopped without choosing an activity — a real gap to attribute. */
export const UNLABELLED = 'Unlabelled';

/**
 * The chunk accruing right now. Display-only: it isn't unattributed by choice, it
 * just hasn't been stopped yet, so it shouldn't sit in the same bucket as time
 * you paused and left unlabelled. Worklogs never use this name — by the time
 * anything is logged, the chunk is closed and genuinely unlabelled.
 */
export const RUNNING = 'Running';

/**
 * Time JIRA has that this app didn't send: logged before the timer existed, logged
 * by someone else, or entered in JIRA directly. Display-only, and never relabelled or
 * removed — there are no local segments behind it to change.
 */
export const UNTRACKED = 'Untracked';

/**
 * Parse JIRA_ACTIVITIES. Unset falls back to the default set; an explicitly blank
 * value means "off", so Pause behaves as it did before activities existed.
 */
export function parseActivities(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_ACTIVITIES];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface ActivityRaw {
  activity: string;
  /** Unrounded tracked seconds for this activity. */
  seconds: number;
}

export interface ActivityShare {
  activity: string;
  /** Seconds to log for this activity. Always > 0. */
  seconds: number;
}

/**
 * Split `totalSeconds` across activities in proportion to their raw time.
 *
 * Rounding each activity separately would inflate the total — three 2-minute
 * chunks at a 5-minute increment would become 15 minutes. So the caller rounds
 * once, and this distributes that exact amount using the largest-remainder
 * method: the parts always sum to `totalSeconds`.
 *
 * Works in whole minutes when the total is a whole number of minutes, so the
 * worklogs read tidily; falls back to seconds otherwise. Activities that come out
 * at zero are dropped, because JIRA rejects a zero-length worklog.
 */
export function apportion(totalSeconds: number, raw: ActivityRaw[]): ActivityShare[] {
  if (totalSeconds <= 0 || raw.length === 0) return [];

  const unit = totalSeconds % 60 === 0 ? 60 : 1;
  const units = Math.round(totalSeconds / unit);
  if (units <= 0) return [];

  const rawTotal = raw.reduce((sum, r) => sum + Math.max(0, r.seconds), 0);
  // All-zero durations shouldn't divide by zero or silently drop time.
  const weights = rawTotal > 0 ? raw.map((r) => Math.max(0, r.seconds)) : raw.map(() => 1);
  const weightTotal = weights.reduce((a, b) => a + b, 0);

  const exact = weights.map((w) => (units * w) / weightTotal);
  const allocated = exact.map((n) => Math.floor(n));
  let left = units - allocated.reduce((a, b) => a + b, 0);

  // Hand out what floor() shaved off, biggest fractional part first. Ties go to
  // the larger raw duration so the result is stable rather than index-dependent.
  const order = exact
    .map((n, i) => ({ i, frac: n - Math.floor(n), weight: weights[i] }))
    .sort((a, b) => b.frac - a.frac || b.weight - a.weight || a.i - b.i);

  for (const { i } of order) {
    if (left <= 0) break;
    allocated[i] += 1;
    left -= 1;
  }

  return raw
    .map((r, i) => ({ activity: r.activity, seconds: allocated[i] * unit }))
    .filter((p) => p.seconds > 0);
}
