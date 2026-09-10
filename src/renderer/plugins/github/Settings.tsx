import { useState, type ReactNode } from 'react';
import { GITHUB_HOST, type GithubAccount, type GithubSnapshot } from '@shared/github';

/**
 * Where the GitHub tokens live — one row per account.
 *
 * Several, because a fine-grained personal access token speaks for exactly one
 * resource owner. An org that mandates them needs a token of its own next to
 * your personal one, and a form with a single token field would quietly show
 * you one owner's work and hide the rest.
 *
 * `host` is per row for the same reason it exists at all: one of them may be an
 * Enterprise install on the company's own domain.
 */

/** What the form edits: an account plus whether a token is already stored. */
interface Draft extends GithubAccount {
  hasToken: boolean;
}

export function Settings({
  snapshot,
  onSaved,
}: {
  snapshot: GithubSnapshot;
  onSaved: (message: string) => void;
}): ReactNode {
  const [accounts, setAccounts] = useState<Draft[]>(() =>
    snapshot.config.accounts.map((a) => ({ ...a, token: '' })),
  );
  const [limit, setLimit] = useState(String(snapshot.config.limit));
  const [saving, setSaving] = useState(false);

  const status = (id: string) => snapshot.accounts.find((a) => a.id === id);

  const update = (id: string, patch: Partial<Draft>) =>
    setAccounts((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const add = () =>
    setAccounts((list) => [
      ...list,
      {
        // Not the length: removing then adding would reuse an id, and the merge
        // that keeps a stored token matches on exactly that.
        id: `a${Date.now().toString(36)}`,
        label: '',
        host: GITHUB_HOST,
        token: '',
        hasToken: false,
      },
    ]);

  const remove = (id: string) => setAccounts((list) => list.filter((a) => a.id !== id));

  async function save(): Promise<void> {
    setSaving(true);
    const result = await window.jt.savePluginConfig('github', {
      // A blank token means "leave the stored one alone" — the main process
      // matches these up by id.
      accounts: accounts.map(({ hasToken, ...account }) => ({
        ...account,
        host: account.host.trim() || GITHUB_HOST,
        label: account.label.trim(),
      })),
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
        One account per token. A fine-grained token only ever speaks for one owner,
        so a work org needs its own alongside your personal one.
      </div>

      {accounts.map((account) => {
        const state = status(account.id);
        return (
          <div key={account.id} className="account">
            <div className="account-head">
              <input
                type="text"
                className="account-label"
                value={account.label}
                placeholder={state?.login ?? 'Name — e.g. Personal, or your work org'}
                onChange={(e) => update(account.id, { label: e.target.value })}
              />
              <button type="button" onClick={() => remove(account.id)}>
                Remove
              </button>
            </div>

            {state?.error && <div className="note bad">{state.error}</div>}
            {state?.blockedOrgs.map((org) => (
              <div key={org} className="note bad">
                {org} can’t be read by this token.
              </div>
            ))}

            <div className="field">
              <label>Token</label>
              <input
                type="password"
                value={account.token}
                placeholder={
                  account.hasToken ? '•••••••• stored — type to replace' : 'github_pat_… or ghp_…'
                }
                onChange={(e) => update(account.id, { token: e.target.value })}
              />
              <div className="note">
                Fine-grained: <code>Pull requests: Read</code> and{' '}
                <code>Metadata: Read</code> on the repositories you want, plus{' '}
                <code>Members: Read</code> to be told about orgs it can’t see. Classic:{' '}
                <code>repo</code> and <code>read:org</code>.
              </div>
            </div>

            <div className="field">
              <label>API root</label>
              <input
                type="text"
                value={account.host}
                placeholder={GITHUB_HOST}
                onChange={(e) => update(account.id, { host: e.target.value })}
              />
            </div>
          </div>
        );
      })}

      <div className="field">
        <button type="button" className="add-account" onClick={add}>
          Add an account
        </button>
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
        <div className="note">Applies to each query, for each account.</div>
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
