import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Snapshot } from '@shared/ipc';

/** The snapshot, kept live by the main process's broadcast. */
export function useSnapshot(): Snapshot | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    void window.jt.getSnapshot().then(setSnapshot);
    return window.jt.onSnapshot(setSnapshot);
  }, []);

  return snapshot;
}

/**
 * A clock for the running segment.
 *
 * Stops when nothing is running and while the panel is hidden — a launcher spends
 * almost all of its life invisible, and a 1 Hz re-render of a window nobody can
 * see is pure battery.
 */
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (!document.hidden) setNow(Date.now());
    };
    tick();
    const id = setInterval(tick, 1000);
    const onVisible = () => tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  return now;
}

/**
 * Keep the window exactly as tall as its contents.
 *
 * The window can't size itself: only the renderer knows how many rows survived
 * the filter, and a fixed-height panel showing two results over 400px of empty
 * surface is the thing that makes a launcher feel like a dialog.
 */
export function useAutoHeight(ref: RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const report = () => void window.jt.setHeight(node.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
}

/** Run `fn` whenever the hotkey brings the panel back up. */
export function useReopened(fn: () => void): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => window.jtOpened(() => latest.current()), []);
}
