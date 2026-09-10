import { useState, type ReactNode } from 'react';
import {
  GITHUB_HOST,
  GITHUB_WEB,
  type GithubAccount,
  type GithubAuth,
  type GithubSnapshot,
} from '@shared/github';

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
        kind: 'token',
        host: GITHUB_HOST,
        token: '',
        hasToken: false,
      },
    ]);

  const remove = (id: string) => setAccounts((list) => list.filter((a) => a.id !== id));

  /** Switching how an account signs in also switches what its host means. */
  const setKind = (id: string, kind: GithubAuth) =>
    update(id, { kind, host: kind === 'browser' ? GITHUB_WEB : GITHUB_HOST, token: '' });

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
        One account per credential. A fine-grained token only ever speaks for one owner,
        so a work org needs its own alongside your personal one — and where no token can
        reach an org at all, browser sign-in reads the same pages you would.
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

            <div className="kinds">
              <label className="check">
                <input
                  type="radio"
                  name={`kind-${account.id}`}
                  checked={account.kind === 'token'}
                  onChange={() => setKind(account.id, 'token')}
                />
                Token
              </label>
              <label className="check">
                <input
                  type="radio"
                  name={`kind-${account.id}`}
                  checked={account.kind === 'browser'}
                  onChange={() => setKind(account.id, 'browser')}
                />
                Browser sign-in
              </label>
            </div>

            {state?.error && <div className="note bad">{state.error}</div>}
            {state?.blockedOrgs.map((org) => (
              <div key={org} className="note bad">
                {org} can’t be read by this token.
              </div>
            ))}

            {account.kind === 'token' ? (
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
                  <code>Metadata: Read</code> on the repositories you pick. Classic:{' '}
                  <code>repo</code> and <code>read:org</code>, plus{' '}
                  <strong>Configure SSO → Authorize</strong> for any org that enforces it.
                </div>
              </div>
            ) : (
              <div className="field">
                <label>Session</label>
                <div className="signin">
                  <button
                    type="button"
                    onClick={() => void window.jt.invoke('github', 'signIn', [account.id])}
                  >
                    {state?.needsSignIn === false && state.login
                      ? `Signed in as ${state.login} — sign in again`
                      : 'Sign in to GitHub…'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.jt.invoke('github', 'signOut', [account.id])}
                  >
                    Sign out
                  </button>
                </div>
                <div className="note">
                  Opens the real GitHub login, so SSO and two-factor work exactly as they do
                  in your browser. Save first if you’ve just changed the host. The session is
                  kept for this account alone and never leaves your machine — it is a broader
                  credential than a token, so sign out when you’re done with it.
                </div>
              </div>
            )}

            <div className="field">
              <label>{account.kind === 'browser' ? 'Site' : 'API root'}</label>
              <input
                type="text"
                value={account.host}
                placeholder={account.kind === 'browser' ? GITHUB_WEB : GITHUB_HOST}
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
