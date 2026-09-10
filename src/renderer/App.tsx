import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Overlay, PluginScreen, Row, Ctx } from '@shared/plugin';
import type { Snapshot, PluginId } from '@shared/ipc';
import { moveSection, resolveLayout, toggleCollapsed } from '@shared/layout';
import {
  buildOverlay,
  buildPalette,
  findEntry,
  firstSelectable,
  headerId,
  moveSelection,
  type PaletteRow,
  type SectionInput,
} from '@shared/sections';
import { prettyAccelerator } from '@shared/keys';
import { VIEWS } from './plugins';
import { appCommands, COMMANDS_SECTION } from './commands';
import { List } from './components/List';
import { ShellSettings } from './components/ShellSettings';
import { useAutoHeight, useNow, useReopened, useSnapshot } from './hooks';

interface Toast {
  text: string;
  bad?: boolean;
  /** Clears itself. Only for "it worked" — a progress toast is cleared by its own
      promise, and an error should stay until something replaces it. */
  transient?: boolean;
}

/** `plugin: ''` is the shell's own settings; a plugin id is that plugin's form. */
type Screen =
  | { kind: 'list' }
  | { kind: 'settings'; plugin: string }
  | { kind: 'plugin'; screen: PluginScreen };

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
   * With nothing set up at all that means a settings form rather than a list of
   * empty sections. It opens the first plugin's own form rather than the shell's:
   * the shell's page is an arrangement editor, and what a new user needs is
   * somewhere to paste a token.
   */
  const reset = useCallback(() => {
    const current = latest.current;
    const plugins = current?.shell.plugins ?? [];
    const anyConfigured = plugins.some((p) => p.configured);
    setScreen(
      !anyConfigured && plugins.length > 0
        ? { kind: 'settings', plugin: plugins[0].id }
        : { kind: 'list' },
    );
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
    // Not until the config file has actually been read: before that every plugin
    // reports as unconfigured, and spending the one greeting on that would send
    // a perfectly well set up user to a form.
    const { loaded, plugins } = snapshot.shell;
    if (!loaded || plugins.length === 0) return;
    greeted.current = true;
    if (!plugins.some((p) => p.configured)) setScreen({ kind: 'settings', plugin: plugins[0].id });
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
      now,
      act: (fn) =>
        void fn().then(
          (r) => finish(r, false),
          (e: Error) => finish({ ok: false, error: e.message }, false),
        ),
      actStay: (fn) =>
        void fn().then(
          (r) => finish(r, true),
          (e: Error) => finish({ ok: false, error: e.message }, true),
        ),
      push: (next) => setOverlays((stack) => [...stack, next]),
      pushAsync: (title, placeholder, load) => {
        setToast({ text: `${title}…` });
        void load().then(
          (rows) => {
            setToast(null);
            setOverlays((stack) => [...stack, { title, placeholder, rows }]);
          },
          (e: Error) => setToast({ text: e.message, bad: true }),
        );
      },
      open: (next) => {
        setOverlays([]);
        setScreen({ kind: 'plugin', screen: next });
      },
      openSettings: (plugin) => {
        setOverlays([]);
        setScreen({ kind: 'settings', plugin });
      },
    };
  }, [snapshot, now, reset]);

  const layout = snapshot?.shell.layout;
  const pluginIds = useMemo(
    () => (snapshot?.shell.plugins ?? []).map((p) => p.id),
    [snapshot?.shell.plugins],
  );

  /**
   * Every section, in the user's order.
   *
   * The commands section is appended rather than arranged: it is the app's own
   * menu rather than one of the apps, so it stays last. It still collapses —
   * `layout.collapsed` takes any id — it just can't be moved above a plugin.
   */
  const sections: SectionInput[] = useMemo(() => {
    if (!snapshot || !ctx || !layout) return [];
    const out: SectionInput[] = [];

    for (const { id, collapsed, pins } of resolveLayout(layout, pluginIds)) {
      const view = VIEWS[id as PluginId];
      const meta = snapshot.shell.plugins.find((p) => p.id === id);
      if (!view || !meta) continue;
      const content = view.section(snapshot.plugins[id as PluginId] as never, ctx);
      out.push({
        id,
        title: view.title,
        rows: content.rows,
        collapsed,
        pins,
        // A fetch in flight says so on the section it is fetching, and a failure
        // stays on that section — the other sections are still good.
        note: meta.loading ? 'Refreshing…' : content.note,
        error: meta.error ?? content.error ?? null,
      });
    }

    const commands: Row[] = [
      ...out.flatMap((section) => {
        const view = VIEWS[section.id as PluginId];
        return view?.commands?.(snapshot.plugins[section.id as PluginId] as never, ctx) ?? [];
      }),
      ...appCommands(ctx),
    ];
    out.push({
      id: COMMANDS_SECTION,
      title: 'j-time',
      rows: commands,
      collapsed: layout.collapsed.includes(COMMANDS_SECTION),
      pins: false,
    });

    return out;
  }, [snapshot, ctx, layout, pluginIds]);

  const view = useMemo(
    () => (overlay ? buildOverlay(overlay.rows, query) : buildPalette(sections, query)),
    [overlay, sections, query],
  );

  // Selection follows the list rather than an index: filtering shouldn't move the
  // cursor off the row you were aiming at, and a row that filters away should
  // hand the cursor to the top rather than to whatever slid into its slot.
  const current = findEntry(view, selectedId) ?? findEntry(view, firstSelectable(view));
  const selectedRow = current?.kind === 'row' ? current : null;

  const move = (delta: number) => setSelectedId(moveSelection(view, current?.id ?? null, delta));

  const toggle = (sectionId: string) => {
    if (!layout) return;
    void window.jt.saveLayout(toggleCollapsed(layout, sectionId));
    // The cursor lands on the header, which is the one thing that certainly
    // still exists once the rows under it are gone.
    setSelectedId(headerId(sectionId));
  };

  const reorder = (sectionId: string, delta: number) => {
    if (!layout || sectionId === COMMANDS_SECTION) return;
    void window.jt.saveLayout(moveSection(layout, pluginIds, sectionId, delta));
    setSelectedId(headerId(sectionId));
  };

  /**
   * The action list for a row, which is what ⌘K opens — and what a click does.
   *
   * Returns false when there is nothing to open, so the caller can fall back to
   * running the row: the command rows and every picker level are single-purpose,
   * and a click that drilled into nothing would leave them dead to the mouse.
   */
  const openActions = (rows: Row[] | undefined, title: string): boolean => {
    if (!rows?.length) return false;
    ctx?.push({ title, placeholder: `Actions for ${title}`, rows });
    return true;
  };

  /** ⌘K on a section header opens that section's own commands. */
  const sectionActions = (sectionId: string): Row[] => {
    if (!snapshot || !ctx) return [];
    const view = VIEWS[sectionId as PluginId];
    return view?.section(snapshot.plugins[sectionId as PluginId] as never, ctx).actions ?? [];
  };

  const menuRows = useMemo(() => (ctx ? appCommands(ctx) : []), [ctx]);

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
      if (
        e.key === 'ArrowDown' ||
        e.key === 'ArrowUp' ||
        (e.ctrlKey && 'np'.includes(e.key.toLowerCase()))
      ) {
        e.preventDefault();
        const delta = e.key === 'ArrowUp' || e.key.toLowerCase() === 'p' ? -1 : 1;
        const length = menuRows.length;
        setMenu((((menu + delta) % length) + length) % length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const row = menuRows[menu];
        setMenu(null);
        row?.run();
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
      ctx?.openSettings('');
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

    // Section arrangement, from the keyboard. ⌘↑/⌘↓ moves the section the cursor
    // is in; the bare arrows collapse and expand it.
    if (current && !overlay) {
      const sectionId = current.sectionId;
      const fixed = current.kind === 'header' && current.fixed;
      if (meta && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        if (!fixed) reorder(sectionId, e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (!fixed && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && query === '') {
        e.preventDefault();
        const collapsed = layout?.collapsed.includes(sectionId) ?? false;
        if (collapsed === (e.key === 'ArrowLeft')) setSelectedId(headerId(sectionId));
        else toggle(sectionId);
        return;
      }
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (current?.kind === 'header') toggle(current.sectionId);
      else selectedRow?.row.run();
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
      if (current?.kind === 'header') openActions(sectionActions(current.sectionId), current.title);
      else if (selectedRow) openActions(selectedRow.row.actions, selectedRow.row.title);
      return;
    }
    if (meta && selectedRow) {
      const action = selectedRow.row.actions?.find((a) => a.shortcut === e.key.toLowerCase());
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
          <span className="glyph">
            <SearchGlyph />
          </span>
          <input placeholder="Starting up…" readOnly />
        </div>
      </div>
    );
  }

  const settingsView = screen.kind === 'settings' ? VIEWS[screen.plugin as PluginId] : undefined;
  const pluginScreen =
    screen.kind === 'plugin' ? VIEWS[screen.screen.plugin as PluginId] : undefined;

  const placeholder = overlay
    ? overlay.placeholder
    : screen.kind === 'settings'
      ? 'Settings'
      : screen.kind === 'plugin'
        ? (screen.screen.arg ?? screen.screen.view)
        : 'Search your work…';

  const anyLoading = snapshot.shell.plugins.some((p) => p.loading);

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
        {anyLoading && <span className="pill">Refreshing…</span>}
      </div>
      <div className="divider" />

      {screen.kind === 'settings' ? (
        settingsView?.settings ? (
          settingsView.settings(snapshot.plugins[screen.plugin as PluginId] as never, (text) =>
            setToast({ text }),
          )
        ) : (
          <ShellSettings
            snapshot={snapshot}
            onSaved={(text) => setToast({ text })}
            onConfigure={(plugin) => setScreen({ kind: 'settings', plugin })}
          />
        )
      ) : screen.kind === 'plugin' ? (
        (pluginScreen?.screen?.(
          snapshot.plugins[screen.screen.plugin as PluginId] as never,
          ctx,
          screen.screen.view,
          screen.screen.arg,
        ) ?? <div className="empty">Nothing to show.</div>)
      ) : (
        <List
          view={view}
          selectedId={current?.id ?? null}
          onSelect={setSelectedId}
          onToggle={toggle}
          // A click opens the actions rather than running the row. Enter is a
          // deliberate keystroke on a row you moved the cursor to; a click is
          // one gesture at whatever is under the pointer, and having that put a
          // clock on a story — or take one off — is too much to hang on it.
          onActivate={(entry: PaletteRow) => {
            if (!openActions(entry.row.actions, entry.row.title)) entry.row.run();
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
            {menuRows.map((row, i) => (
              <button
                key={row.id}
                type="button"
                role="menuitem"
                className={`app-menu-item${i === menu ? ' on' : ''}`}
                onMouseEnter={() => setMenu(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setMenu(null);
                  row.run();
                }}
              >
                <span className="label">{row.title}</span>
                {row.badges?.[0] && <kbd>{row.badges[0].text}</kbd>}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="divider" />
      <Footer
        snapshot={snapshot}
        toast={toast}
        enterLabel={selectedRow?.row.enterLabel}
        hasActions={Boolean(selectedRow?.row.actions?.length)}
        onHeader={current?.kind === 'header' && !current.fixed}
        showBack={screen.kind !== 'list' || overlays.length > 0}
        inList={screen.kind === 'list'}
        onMenu={() => setMenu((open) => (open === null ? 0 : null))}
      />
    </div>
  );
}

/**
 * The status line.
 *
 * The connection dot went with the JIRA plugin's monopoly on this app: with more
 * than one connection there is no single dot to paint, so the footer counts the
 * ones that are unhappy instead and stays quiet when they all are.
 */
function Footer({
  snapshot,
  toast,
  enterLabel,
  hasActions,
  onHeader,
  showBack,
  inList,
  onMenu,
}: {
  snapshot: Snapshot;
  toast: Toast | null;
  enterLabel?: string;
  hasActions: boolean;
  onHeader: boolean;
  showBack: boolean;
  inList: boolean;
  onMenu: () => void;
}): ReactNode {
  const plugins = snapshot.shell.plugins;
  // An app that is *broken* and an app that was never set up are different
  // things, and only the first is worth painting red — a section you have no
  // intention of configuring shouldn't make the whole app look unwell.
  const broken = plugins.filter((p) => p.error);
  const unset = plugins.filter((p) => !p.configured && !p.error);

  const dot = broken.length > 0 ? 'bad' : plugins.some((p) => p.configured) ? 'ok' : '';
  const status =
    broken.length > 0
      ? (broken[0].error ?? `${broken[0].title} failed`)
      : unset.length === 1
        ? `${unset[0].title} is not set up`
        : unset.length > 1
          ? `${unset.length} apps are not set up`
          : prettyAccelerator(snapshot.shell.config.hotkey);

  return (
    <div className="footer">
      <button
        type="button"
        className="app-menu"
        title="j-time"
        aria-label="j-time menu"
        // The search field owns the keyboard; letting the button take focus
        // would send the palette's own keys nowhere.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onMenu}
      >
        <MenuGlyph />
      </button>
      <span className={`dot ${dot}`} />
      {toast ? <span className={`toast${toast.bad ? ' bad' : ''}`}>{toast.text}</span> : <span>{status}</span>}
      <span className="spacer" />
      {inList && onHeader && (
        <>
          <span className="hint">
            Collapse <kbd>↩</kbd>
          </span>
          <span className="hint">
            Move <kbd>⌘</kbd>
            <kbd>↕</kbd>
          </span>
        </>
      )}
      {inList && !onHeader && enterLabel && (
        <span className="hint">
          {enterLabel} <kbd>↩</kbd>
        </span>
      )}
      {inList && !onHeader && hasActions && (
        <span className="hint">
          Actions <kbd>⌘</kbd>
          <kbd>K</kbd>
        </span>
      )}
      {showBack && (
        <span className="hint">
          Back <kbd>⎋</kbd>
        </span>
      )}
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
  if (query) {
    return (
      <>
        <strong>No matches for “{query}”</strong>
        {inOverlay ? 'Press ⎋ to go back.' : 'Try an issue key, or part of a summary.'}
      </>
    );
  }
  if (snapshot.shell.plugins.some((p) => p.loading)) return <strong>Loading…</strong>;
  return (
    <>
      <strong>Nothing to show</strong>
      Press ⌘, to set up an app.
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
