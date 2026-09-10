import { useState, type ReactNode } from 'react';
import type { JiraSnapshot } from '@shared/jira';
import { connDotClass, CRED_LABELS, connMessage } from '@shared/conn';

/**
 * Where the JIRA credentials live.
 *
 * A packaged .app inherits none of your shell's environment, so unlike jira-timer
 * there is no `.env.local` to fall back on — this form is the only way in, which
 * is why the first launch opens straight to it.
 *
 * The hotkey moved out when the shell grew plugins: it is the shell's, not
 * JIRA's, and having it on one plugin's form would have made that plugin look
 * like the app.
 */
export function Settings({
  snapshot,
  onSaved,
}: {
  snapshot: JiraSnapshot;
  onSaved: (message: string) => void;
}): ReactNode {
  const { config, conn } = snapshot;
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [email, setEmail] = useState(config.email);
  // Left blank when a token is already stored: it never crosses the bridge, and
  // an untouched blank field must not be able to erase it.
  const [apiToken, setApiToken] = useState('');
  const [activities, setActivities] = useState(config.activities.join(', '));
  const [roundMinutes, setRoundMinutes] = useState(String(config.roundMinutes));
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    setSaving(true);
    const result = await window.jt.savePluginConfig('jira', {
      baseUrl,
      email,
      ...(apiToken.trim() ? { apiToken: apiToken.trim() } : {}),
      activities: activities
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      roundMinutes: Number(roundMinutes) || 0,
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
      <div className={`banner${connDotClass(conn) === 'bad' ? ' bad' : ''}`}>
        <span className={`dot ${connDotClass(conn)}`} /> {connMessage(conn)}
      </div>

      <div className="field">
        <label>{CRED_LABELS.baseUrl}</label>
        <input
          type="text"
          value={baseUrl}
          autoFocus
          placeholder="https://your-org.atlassian.net"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>

      <div className="field">
        <label>{CRED_LABELS.email}</label>
        <input
          type="text"
          value={email}
          placeholder="you@example.com"
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="field">
        <label>{CRED_LABELS.apiToken}</label>
        <input
          type="password"
          value={apiToken}
          placeholder={config.hasToken ? '•••••••• stored — type to replace' : 'paste-your-token-here'}
          onChange={(e) => setApiToken(e.target.value)}
        />
        <div className="note">
          Create one at id.atlassian.com → Security → API tokens. It’s encrypted with your
          login keychain before it touches disk.
        </div>
      </div>

      <div className="field">
        <label>Activities</label>
        <input type="text" value={activities} onChange={(e) => setActivities(e.target.value)} />
        <div className="note">
          Comma separated. These are the labels you file time under; leave it empty to turn
          filing off.
        </div>
      </div>

      <div className="field">
        <label>Rounding (minutes)</label>
        <input
          type="number"
          min={0}
          value={roundMinutes}
          onChange={(e) => setRoundMinutes(e.target.value)}
        />
        <div className="note">Applies to the Done sweep only. Filing is always exact.</div>
      </div>

      <div className="row selected" onClick={() => void save()}>
        <span className="lead">↩</span>
        <span className="labels">
          <span className="title">{saving ? 'Saving…' : 'Save settings'}</span>
          <span className="subtitle">Reconnects and re-reads the board</span>
        </span>
        <span className="accessories">
          <kbd>⌘↩</kbd>
        </span>
      </div>
    </div>
  );
}
