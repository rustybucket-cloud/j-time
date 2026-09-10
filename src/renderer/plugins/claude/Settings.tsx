import { useState, type ReactNode } from 'react';
import type { ClaudeSnapshot } from '@shared/claude';

/**
 * Two numbers, and no credentials.
 *
 * The plugin reads Claude Code's own files, so there is nothing to authorise and
 * nothing to paste — what is worth setting is the one inferred number in it, and
 * how much of a fortnight's leftovers to keep on screen.
 */
export function Settings({
  snapshot,
  onSaved,
}: {
  snapshot: ClaudeSnapshot;
  onSaved: (message: string) => void;
}): ReactNode {
  const { config } = snapshot;
  const [attentionSeconds, setAttentionSeconds] = useState(String(config.attentionSeconds));
  const [completedMinutes, setCompletedMinutes] = useState(String(config.completedMinutes));
  const [idleDays, setIdleDays] = useState(String(config.idleDays));
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    setSaving(true);
    const result = await window.jt.savePluginConfig('claude', {
      attentionSeconds: Math.max(1, Number(attentionSeconds) || 45),
      completedMinutes: Math.max(0, Number(completedMinutes) || 0),
      idleDays: Math.max(0, Number(idleDays) || 0),
    });
    setSaving(false);
    onSaved(result.ok ? (result.message ?? 'Saved') : result.error);
  }

  return (
    <div
      className="settings"
      onKeyDown={(e) => {
        // Escape belongs to the shell — it's how you get back to the list.
        if (e.key === 'Escape') return;
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void save();
          return;
        }
        // Everything else is typing, and must not reach the palette's navigation.
        e.stopPropagation();
      }}
    >
      <div className="banner">
        <span className="dot ok" /> {snapshot.sessions.length} session
        {snapshot.sessions.length === 1 ? '' : 's'} running
      </div>

      <div className="field">
        <label>Call it waiting after (seconds)</label>
        <input
          type="number"
          min={1}
          value={attentionSeconds}
          autoFocus
          onChange={(e) => setAttentionSeconds(e.target.value)}
        />
        <div className="note">
          A permission prompt and a slow tool look identical on disk — both are a call with
          no result yet — so age is what separates them. A question Claude asks outright is
          reported immediately and ignores this. Raise it if a long build keeps showing up as
          waiting.
        </div>
      </div>

      <div className="field">
        <label>Show finished for (minutes)</label>
        <input
          type="number"
          min={0}
          value={completedMinutes}
          onChange={(e) => setCompletedMinutes(e.target.value)}
        />
        <div className="note">
          How long a session that has just stopped stays called out as finished, before it
          settles into Idle. Dismissing one sends it there early, and only that result — the
          same session finishing again says so. 0 turns the state off.
        </div>
      </div>

      <div className="field">
        <label>Hide idle sessions after (days)</label>
        <input
          type="number"
          min={0}
          value={idleDays}
          onChange={(e) => setIdleDays(e.target.value)}
        />
        <div className="note">
          Terminals left open collect sessions nobody will go back to, and thirty of those
          hide the two that want you. 0 shows every one. A session that is waiting is never
          hidden, however long it has waited.
        </div>
      </div>

      <div className="row selected" onClick={() => void save()}>
        <span className="lead">↩</span>
        <span className="labels">
          <span className="title">{saving ? 'Saving…' : 'Save settings'}</span>
          <span className="subtitle">Re-reads the session list</span>
        </span>
        <span className="accessories">
          <kbd>⌘↩</kbd>
        </span>
      </div>
    </div>
  );
}
