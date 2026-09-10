import { useState, type ReactNode } from 'react';
import type { GithubSnapshot } from '@shared/github';
import { GITHUB_HOST } from '@shared/github';

/**
 * Where the GitHub token lives.
 *
 * `host` is a field rather than a constant so the same plugin works against an
 * Enterprise install, where the API sits under the company's own domain — the
 * same reason the JIRA form asks for a base URL.
 */
export function Settings({
  snapshot,
  onSaved,
}: {
  snapshot: GithubSnapshot;
  onSaved: (message: string) => void;
}): ReactNode {
  const { config, login } = snapshot;
  const [host, setHost] = useState(config.host);
  // Left blank when a token is already stored: it never crosses the bridge, and
  // an untouched blank field must not be able to erase it.
  const [token, setToken] = useState('');
  const [limit, setLimit] = useState(String(config.limit));
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    setSaving(true);
    const result = await window.jt.savePluginConfig('github', {
      host: host.trim() || GITHUB_HOST,
      ...(token.trim() ? { token: token.trim() } : {}),
      limit: Number(limit) || 25,
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
        {login ? `Connected as ${login}` : 'Not connected — add a token below.'}
      </div>

      <div className="field">
        <label>API root</label>
        <input
          type="text"
          value={host}
          autoFocus
          placeholder={GITHUB_HOST}
          onChange={(e) => setHost(e.target.value)}
        />
        <div className="note">
          {GITHUB_HOST} for github.com, or https://your-company.com/api for Enterprise.
        </div>
      </div>

      <div className="field">
        <label>Personal access token</label>
        <input
          type="password"
          value={token}
          placeholder={config.hasToken ? '•••••••• stored — type to replace' : 'ghp_…'}
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="note">
          Needs <code>repo</code> and <code>read:org</code>. It’s encrypted with your login
          keychain before it touches disk.
        </div>
      </div>

      <div className="field">
        <label>Pull requests per list</label>
        <input
          type="number"
          min={1}
          max={100}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
        <div className="note">Applies to each of the two queries separately.</div>
      </div>

      <div className="row selected" onClick={() => void save()}>
        <span className="lead">↩</span>
        <span className="labels">
          <span className="title">{saving ? 'Saving…' : 'Save settings'}</span>
          <span className="subtitle">Reconnects and re-reads your pull requests</span>
        </span>
        <span className="accessories">
          <kbd>⌘↩</kbd>
        </span>
      </div>
    </div>
  );
}
