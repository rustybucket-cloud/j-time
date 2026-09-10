import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { filterPalette, nextIndex } from '@shared/palette';
import { connDotClass, connMessage } from '@shared/conn';
import type { Snapshot } from '@shared/ipc';
import { prettyAccelerator } from '@shared/keys';
import { activeSeconds, formatClock } from '@shared/time';
import {
  appMenuEntries,
  commandEntries,
  issueEntries,
  runningRow,
  type Ctx,
  type Entry,
  type Overlay,
  type Screen,
} from './entries';
import { List } from './components/List';
import { Detail } from './components/Detail';
import { Settings } from './components/Settings';
import { useAutoHeight, useNow, useReopened, useSnapshot } from './hooks';

interface Toast {
  text: string;
  bad?: boolean;
  /** Clears itself. Only for "it worked" — a progress toast is cleared by its own
      promise, and an error should stay until something replaces it. */
  transient?: boolean;
}

/** ⌘-shortcuts that run one of the selected story's actions by id. */
const ACTION_SHORTCUTS: Record<string, string> = {
  f: 'act:file',
  d: 'act:finish',
  i: 'act:detail',
  o: 'act:open',
  c: 'act:copy-key',
};

export function App(): ReactNode {
  const snapshot = useSnapshot();
  const now = useNow(true);

  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  /** The footer menu: a popover over the panel, not a level of the palette. */
  const [menu, setMenu] = useState<number | null>(null);

  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useAutoHeight(root);

  const overlay = overlays[overlays.length - 1] ?? null;

  // Read through a ref so `reset` can stay dependency-free: it is called from
  // the reopen listener, which is registered once for the life of the window.
  const latest = useRef<Snapshot | null>(null);
  latest.current = snapshot;

  /**
   * Back to a clean palette — what reopening, and finishing an action, both want.
   *
   * Unconfigured, that means Settings rather than the list. Nothing works without
   * credentials, and an empty list pointing at a shortcut is a worse first
   * impression than the form it points to.
   */
  const reset = useCallback(() => {
    const current = latest.current;
    setScreen(current?.conn.reason === 'unconfigured' ? { kind: 'settings' } : { kind: 'list' });
    setOverlays([]);
    setQuery('');
    setSelectedId(null);
    setToast(null);
    setMenu(null);
  }, []);

  // `palette:opened` can be sent before the renderer has finished loading, in
  // which case it is simply lost — so the first snapshot decides too.
  const greeted = useRef(false);
  useEffect(() => {
    if (greeted.current || !snapshot) return;
    // `checking` is not an answer yet, so don't spend the one greeting on it:
    // the panel opens before the first getMyself lands, and an unconfigured user
    // would then never be shown the form.
    if (snapshot.conn.reason === 'checking') return;
    greeted.current = true;
    if (snapshot.conn.reason === 'unconfigured') setScreen({ kind: 'settings' });
  }, [snapshot]);

  // Settings is a form, and a form that vanishes when you switch apps to copy
  // something out of a browser is a form you cannot fill in.
  useEffect(() => {
    void window.jt.setDismissOnBlur(screen.kind !== 'settings');
  }, [screen.kind]);

  useReopened(() => {
    reset();
    input.current?.focus();
  });

  // Starting a timer no longer closes the panel, so its toast now sits in the
  // footer in front of you — and that footer is also where the running clock
  // lives. Hand it back once the message has been read.
  useEffect(() => {
    if (!toast?.transient) return;
    const id = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  // A new level is a new list; carrying the old query into it would filter it to
  // nothing and look broken.
  useEffect(() => {
    setQuery('');
    setSelectedId(null);
    input.current?.focus();
  }, [overlays.length, screen.kind]);

  const ctx: Ctx | null = useMemo(() => {
    if (!snapshot) return null;
    const finish = (result: { ok: boolean; message?: string; error?: string }, stay: boolean) => {
      if (!result.ok) {
        setToast({ text: result.error ?? 'Something went wrong', bad: true });
        return;
      }
      if (stay) {
        setOverlays([]);
        setQuery('');
        setToast(result.message ? { text: result.message, transient: true } : null);
      } else {
        reset();
        void window.jt.hide();
      }
    };
    return {
      snapshot,
      now,
      act: (fn) => void fn().then((r) => finish(r, false), (e: Error) => finish({ ok: false, error: e.message }, false)),
      actStay: (fn) => void fn().then((r) => finish(r, true), (e: Error) => finish({ ok: false, error: e.message }, true)),
      push: (next) => setOverlays((stack) => [...stack, next]),
      pushAsync: (title, placeholder, load) => {
        setToast({ text: `${title}…` });
        void load().then(
          (entries) => {
            setToast(null);
            setOverlays((stack) => [...stack, { title, placeholder, entries }]);
          },
          (e: Error) => setToast({ text: e.message, bad: true }),
        );
      },
      go: (next) => {
        setOverlays([]);
        setScreen(next);
      },
    };
  }, [snapshot, now, reset]);

  const entries: Entry[] = useMemo(() => {
    if (!ctx) return [];
    if (overlay) return overlay.entries;
    if (screen.kind !== 'list') return [];
    return [...issueEntries(ctx), ...commandEntries(ctx)];
  }, [ctx, overlay, screen.kind]);

  const ranked = useMemo(() => filterPalette(entries, query), [entries, query]);

  // Selection follows the list rather than an index: filtering shouldn't move the
  // cursor off the row you were aiming at, and a row that filters away should
  // hand the cursor to the top rather than to whatever slid into its slot.
  const selectedIndex = ranked.findIndex((r) => r.item.id === selectedId);
  const index = selectedIndex >= 0 ? selectedIndex : ranked.length > 0 ? 0 : -1;
  const selected = index >= 0 ? ranked[index].item : null;

  const move = (delta: number) => {
    const next = nextIndex(ranked.length, index, delta);
    setSelectedId(next >= 0 ? ranked[next].item.id : null);
  };

  /**
   * The action list for a row, which is what ⌘K opens — and what a click does.
   *
   * Returns false when the row has none, so the caller can fall back to running
   * it: the command rows and every picker level are single-purpose, and a click
   * that drilled into nothing would leave them dead to the mouse.
   */
  const openActions = (entry: Entry): boolean => {
    if (!entry.actions?.length) return false;
    ctx?.push({
      title: entry.title,
      placeholder: `Actions for ${entry.title}`,
      entries: entry.actions,
    });
    return true;
  };

  const menuEntries = useMemo(() => (ctx ? appMenuEntries(ctx) : []), [ctx]);

  const back = () => {
    if (overlays.length > 0) setOverlays((stack) => stack.slice(0, -1));
    else if (screen.kind !== 'list') setScreen({ kind: 'list' });
    else void window.jt.hide();
  };

  function onKeyDown(e: React.KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey;

    // The popover takes the arrows and Enter off the list underneath it. ⌘-keys
    // fall through on purpose: ⌘Q and ⌘, do the same thing either way.
    if (menu !== null && !e.metaKey) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenu(null);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (e.ctrlKey && 'np'.includes(e.key.toLowerCase()))) {
        e.preventDefault();
        const delta = e.key === 'ArrowUp' || e.key.toLowerCase() === 'p' ? -1 : 1;
        setMenu(nextIndex(menuEntries.length, menu, delta));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const entry = menuEntries[menu];
        setMenu(null);
        entry?.run();
        return;
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      back();
      return;
    }
    if (meta && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      void window.jt.quit();
      return;
    }
    if (meta && e.key === ',') {
      e.preventDefault();
      ctx?.go({ kind: 'settings' });
      return;
    }
    if (meta && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      ctx?.actStay(() => window.jt.refresh());
      return;
    }
    if (screen.kind !== 'list') return;

    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) {
      e.preventDefault();
      move(1);
      return;
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) {
      e.preventDefault();
      move(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      selected?.run();
      return;
    }
    // Backspace on an empty query steps out of a sub-list, so getting somewhere by
    // mistake costs one key rather than a reach for Escape.
    if (e.key === 'Backspace' && query === '' && overlays.length > 0) {
      e.preventDefault();
      back();
      return;
    }
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (selected) openActions(selected);
      return;
    }
    const shortcut = meta ? ACTION_SHORTCUTS[e.key.toLowerCase()] : undefined;
    if (shortcut) {
      const action = selected?.actions?.find((a) => a.id === shortcut);
      if (action) {
        e.preventDefault();
        action.run();
      }
    }
  }

  if (!snapshot || !ctx) {
    return (
      <div className="panel" ref={root}>
        <div className="search">
          <span className="glyph"><SearchGlyph /></span>
          <input placeholder="Starting up…" readOnly />
        </div>
      </div>
    );
  }

  const running = runningRow(snapshot);
  const runningSeconds = running?.timer ? activeSeconds(running.timer.segments, now) : 0;

  const placeholder = overlay
    ? overlay.placeholder
    : screen.kind === 'settings'
      ? 'Settings'
      : screen.kind === 'detail'
        ? screen.key
        : snapshot.conn.ok
          ? 'Search your in-progress work…'
          : snapshot.conn.reason === 'checking'
            ? 'Checking your JIRA connection…'
            : 'Not connected — press ⌘, to set up';

  return (
    <div className="panel" ref={root} onKeyDown={onKeyDown}>
      <div className="search">
        {overlay || screen.kind !== 'list' ? (
          <button
            type="button"
            className="glyph back-btn"
            title="Back (⎋)"
            aria-label="Back"
            // The search field owns the keyboard; letting the button take focus
            // would send the palette's own keys nowhere.
            onMouseDown={(e) => e.preventDefault()}
            onClick={back}
          >
            <BackGlyph />
          </button>
        ) : (
          <span className="glyph">
            <SearchGlyph />
          </span>
        )}
        {overlay && <span className="back">{overlay.title}</span>}
        <input
          ref={input}
          autoFocus
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          readOnly={screen.kind !== 'list'}
          onChange={(e) => setQuery(e.target.value)}
        />
        {snapshot.loading && <span className="pill">Refreshing…</span>}
      </div>
      <div className="divider" />

      {screen.kind === 'settings' ? (
        <Settings snapshot={snapshot} onSaved={(text) => setToast({ text })} />
      ) : screen.kind === 'detail' ? (
        <Detail snapshot={snapshot} issueKey={screen.key} now={now} />
      ) : (
        <List
          ranked={ranked}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          // A click opens the actions rather than running the row. Enter is a
          // deliberate keystroke on a row you moved the cursor to; a click is
          // one gesture at whatever is under the pointer, and having that put a
          // clock on a story — or take one off — is too much to hang on it.
          onActivate={(entry) => {
            if (!openActions(entry)) entry.run();
          }}
          empty={<EmptyState snapshot={snapshot} query={query} inOverlay={overlay !== null} />}
        />
      )}

      {menu !== null && (
        <>
          {/* Click-away. mousedown rather than click, so the press that dismisses
              the menu doesn't also land on whatever is underneath it. */}
          <div className="scrim" onMouseDown={() => setMenu(null)} />
          <div className="app-menu-pop" role="menu">
            {menuEntries.map((entry, i) => (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                className={`app-menu-item${i === menu ? ' on' : ''}`}
                onMouseEnter={() => setMenu(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setMenu(null);
                  entry.run();
                }}
              >
                <span className="label">{entry.title}</span>
                {entry.accessories}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="divider" />
      <div className="footer">
        <button
          type="button"
          className="app-menu"
          title="j-time"
          aria-label="j-time menu"
          // The search field owns the keyboard; letting the button take focus
          // would send the palette's own keys nowhere.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setMenu((open) => (open === null ? 0 : null))}
        >
          <MenuGlyph />
        </button>
        <span className={`dot ${connDotClass(snapshot.conn)}`} />
        {toast ? (
          <span className={`toast${toast.bad ? ' bad' : ''}`}>{toast.text}</span>
        ) : running ? (
          <span>
            {running.key} <span className="clock live">{formatClock(runningSeconds)}</span>
          </span>
        ) : (
          <span>{snapshot.conn.ok ? prettyAccelerator(snapshot.config.hotkey) : connMessage(snapshot.conn)}</span>
        )}
        <span className="spacer" />
        {screen.kind === 'list' && selected && (
          <>
            <span className="hint">
              {selected.running ? 'Stop' : selected.issue ? 'Start' : 'Run'} <kbd>↩</kbd>
            </span>
            {selected.actions && (
              <span className="hint">
                Actions <kbd>⌘</kbd>
                <kbd>K</kbd>
              </span>
            )}
          </>
        )}
        {(screen.kind !== 'list' || overlays.length > 0) && (
          <span className="hint">
            Back <kbd>⎋</kbd>
          </span>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  snapshot,
  query,
  inOverlay,
}: {
  snapshot: Snapshot;
  query: string;
  inOverlay: boolean;
}): ReactNode {
  if (snapshot.conn.reason === 'checking') return <strong>{connMessage(snapshot.conn)}</strong>;
  if (!snapshot.conn.ok) {
    return (
      <>
        <strong>{connMessage(snapshot.conn)}</strong>
        Press ⌘, to open Settings.
      </>
    );
  }
  if (query) {
    return (
      <>
        <strong>No matches for “{query}”</strong>
        {inOverlay ? 'Press ⎋ to go back.' : 'Try an issue key, or part of a summary.'}
      </>
    );
  }
  if (snapshot.loading) return <strong>Loading your board…</strong>;
  return (
    <>
      <strong>Nothing on this board</strong>
      {snapshot.config.mineOnly
        ? 'Nothing is assigned to you in the current iteration.'
        : 'This board has no issues in the current iteration.'}
    </>
  );
}

/* Drawn rather than typed: the Unicode magnifier renders as a wan little circle at
   this size in the system font, and it sits next to 17px text. */
function SearchGlyph(): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* Three bars rather than a gear: the button behind it is the whole app now —
   settings, links and quitting — and a cog would promise only the first. */
function MenuGlyph(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4.5 H13.5 M2.5 8 H13.5 M2.5 11.5 H13.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BackGlyph(): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M10 2.5 L4.5 8 L10 13.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
