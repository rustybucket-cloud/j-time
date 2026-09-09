import type { Segment } from './types';

/**
 * Total ACTIVE seconds across segments. An open segment (end === null) counts
 * up to `now`. This is the core of the "open session != time spent" guarantee:
 * only start->stop intervals count, never wall-clock.
 */
export function activeSeconds(segments: Segment[], now: number): number {
  let totalMs = 0;
  for (const s of segments) {
    const end = s.end ?? now;
    if (end > s.start) totalMs += end - s.start;
  }
  return Math.floor(totalMs / 1000);
}

/**
 * Round seconds to the nearest `incrementMinutes`. A small-but-real duration is
 * never rounded down to zero (that would silently drop logged work).
 */
export function roundSeconds(seconds: number, incrementMinutes: number): number {
  if (incrementMinutes <= 0) return seconds;
  const inc = incrementMinutes * 60;
  const rounded = Math.round(seconds / inc) * inc;
  if (seconds > 0 && rounded === 0) return inc;
  return rounded;
}

/** "1h 23m" / "23m" / "0m" — compact display. */
export function formatDurationShort(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "HH:MM:SS" — the live readout. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

/** True when the last segment is open (timer running). */
export function isRunning(segments: Segment[]): boolean {
  return segments.length > 0 && segments[segments.length - 1].end === null;
}

/**
 * "12:34" / "1:02:03" — the menu bar readout.
 *
 * Narrower than `formatClock` on purpose: the hours field is dropped until there
 * are hours, because every character here is space taken from the menu bar
 * forever, not just while the timer runs.
 */
export function formatBar(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
