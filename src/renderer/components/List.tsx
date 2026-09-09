import { useEffect, useRef, type ReactNode } from 'react';
import { sectioned, type Ranked } from '@shared/palette';
import type { Entry } from '../entries';

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

function Row({
  ranked,
  selected,
  onSelect,
  onActivate,
}: {
  ranked: Ranked<Entry>;
  selected: boolean;
  onSelect: () => void;
  onActivate: () => void;
}): ReactNode {
  const node = useRef<HTMLDivElement>(null);
  const { item } = ranked;

  // Keyboard navigation has to bring its target into view; the mouse doesn't need
  // it and shouldn't cause a jump, so this only fires for the selected row.
  useEffect(() => {
    if (selected) node.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div
      ref={node}
      className={`row${selected ? ' selected' : ''}${item.running ? ' running' : ''}`}
      onMouseMove={selected ? undefined : onSelect}
      onClick={onActivate}
    >
      <span className="lead">{item.lead}</span>
      <span className="labels">
        <span className="title">
          <Highlight text={item.title} indices={ranked.titleIndices} />
        </span>
        {item.subtitle && (
          <span className="subtitle">
            <Highlight text={item.subtitle} indices={ranked.subtitleIndices} />
          </span>
        )}
      </span>
      <span className="accessories">{item.accessories}</span>
    </div>
  );
}

export function List({
  ranked,
  selectedId,
  onSelect,
  onActivate,
  empty,
}: {
  ranked: Ranked<Entry>[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** What a click on a row does. Not the same as Enter — see App. */
  onActivate: (entry: Entry) => void;
  empty: ReactNode;
}): ReactNode {
  if (ranked.length === 0) return <div className="empty">{empty}</div>;

  return (
    <div className="list">
      {sectioned(ranked).map((group, gi) => (
        <div key={`${group.section}-${gi}`}>
          {group.section && <div className="section-label">{group.section}</div>}
          {(group.items as Ranked<Entry>[]).map((r) => (
            <Row
              key={r.item.id}
              ranked={r}
              selected={r.item.id === selectedId}
              onSelect={() => onSelect(r.item.id)}
              onActivate={() => onActivate(r.item)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
