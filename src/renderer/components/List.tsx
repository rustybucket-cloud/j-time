import { useEffect, useRef, type ReactNode } from 'react';
import type { Badge, Glyph } from '@shared/plugin';
import type { PaletteHeader, PaletteRow, PaletteView } from '@shared/sections';

/** Wrap the characters the query matched, so a fuzzy hit is legible as one. */
function Highlight({ text, indices }: { text: string; indices: number[] }): ReactNode {
  if (indices.length === 0) return text;
  const hit = new Set(indices);
  const parts: ReactNode[] = [];
  let run = '';
  let runHit = false;

  const flush = (i: number) => {
    if (!run) return;
    parts.push(runHit ? <mark key={i}>{run}</mark> : run);
    run = '';
  };

  for (let i = 0; i < text.length; i++) {
    const isHit = hit.has(i);
    if (isHit !== runHit) {
      flush(i);
      runHit = isHit;
    }
    run += text[i];
  }
  flush(text.length);
  return parts;
}

/**
 * A row's leading mark.
 *
 * Drawn from a fixed set rather than from anything a plugin passes in: the whole
 * point of `Glyph` being a meaning is that "waiting on you" looks the same in
 * every section, and it can only do that if one place decides what it looks like.
 */
const GLYPHS: Record<Glyph, string> = {
  none: '',
  dot: '•',
  active: '▶',
  attention: '●',
  ok: '✓',
  blocked: '✕',
  muted: '·',
};

function Badges({ badges }: { badges?: Badge[] }): ReactNode {
  if (!badges?.length) return null;
  return (
    <>
      {badges.map((badge, i) => {
        if (badge.kind === 'key') return <kbd key={i}>{badge.text}</kbd>;
        if (badge.kind === 'clock') {
          return (
            <span key={i} className={`clock${badge.live ? ' live' : ''}`}>
              {badge.text}
            </span>
          );
        }
        return (
          <span key={i} className={`pill${badge.tone && badge.tone !== 'plain' ? ` ${badge.tone}` : ''}`}>
            {badge.text}
          </span>
        );
      })}
    </>
  );
}

function Row({
  entry,
  selected,
  onSelect,
  onActivate,
}: {
  entry: PaletteRow;
  selected: boolean;
  onSelect: () => void;
  onActivate: () => void;
}): ReactNode {
  const node = useRef<HTMLDivElement>(null);
  const { row } = entry;

  // Keyboard navigation has to bring its target into view; the mouse doesn't need
  // it and shouldn't cause a jump, so this only fires for the selected row.
  useEffect(() => {
    if (selected) node.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div
      ref={node}
      className={`row${selected ? ' selected' : ''}${row.live ? ' running' : ''}`}
      onMouseMove={selected ? undefined : onSelect}
      onClick={onActivate}
    >
      <span className={`lead glyph-${row.lead ?? 'none'}`}>{GLYPHS[row.lead ?? 'none']}</span>
      <span className="labels">
        <span className="title">
          <Highlight text={row.title} indices={entry.titleIndices} />
        </span>
        {row.subtitle && (
          <span className="subtitle">
            <Highlight text={row.subtitle} indices={entry.subtitleIndices} />
          </span>
        )}
      </span>
      <span className="accessories">
        <Badges badges={row.badges} />
      </span>
    </div>
  );
}

/**
 * A section heading, and a place for the cursor to land.
 *
 * Selectable on purpose: it is what makes collapsing and reordering reachable
 * from the keyboard, and it is where the cursor goes when the section under it
 * closes — the one thing on screen that certainly still exists.
 */
function Header({
  entry,
  selected,
  onSelect,
  onToggle,
}: {
  entry: PaletteHeader;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}): ReactNode {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) node.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!entry.title) return null;

  return (
    <div
      ref={node}
      className={`section-head${selected ? ' selected' : ''}${entry.fixed ? ' fixed' : ''}`}
      onMouseMove={selected ? undefined : onSelect}
      onClick={onToggle}
    >
      {!entry.fixed && (
        <span className={`twist${entry.collapsed ? ' closed' : ''}`} aria-hidden>
          ▾
        </span>
      )}
      <span className="section-label">{entry.title}</span>
      {entry.error ? (
        <span className="pill danger">{entry.error}</span>
      ) : (
        entry.note && <span className="section-note">{entry.note}</span>
      )}
      {entry.collapsed && entry.hidden > 0 && <span className="pill">{entry.hidden}</span>}
    </div>
  );
}

export function List({
  view,
  selectedId,
  onSelect,
  onActivate,
  onToggle,
  empty,
}: {
  view: PaletteView;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** What a click on a row does. Not the same as Enter — see App. */
  onActivate: (entry: PaletteRow) => void;
  onToggle: (sectionId: string) => void;
  empty: ReactNode;
}): ReactNode {
  if (view.flat.length === 0) return <div className="empty">{empty}</div>;

  return (
    <div className="list">
      {view.sections.map((section) => (
        <div key={section.header.id} className="section">
          <Header
            entry={section.header}
            selected={section.header.id === selectedId}
            onSelect={() => onSelect(section.header.id)}
            onToggle={() => onToggle(section.header.sectionId)}
          />
          {section.groups.map((group, gi) => (
            <div key={`${group.subsection ?? ''}-${gi}`}>
              {group.subsection && <div className="subsection-label">{group.subsection}</div>}
              {group.rows.map((entry) => (
                <Row
                  key={entry.id}
                  entry={entry}
                  selected={entry.id === selectedId}
                  onSelect={() => onSelect(entry.id)}
                  onActivate={() => onActivate(entry)}
                />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
