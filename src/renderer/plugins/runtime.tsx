/**
 * The one view every runtime plugin shares.
 *
 * A plugin loaded from `~/.j-time/plugins` never runs here: it returned rows as
 * data, and this puts the closures back — Enter on a row becomes an `invoke` of
 * the command it named. Settings is a form generated from the fields the plugin
 * declared, so a plugin that needs a token gets the same treatment as one built
 * in, without ever having to draw anything.
 */

import { useState, type ReactNode } from 'react';
import type { Ctx, PluginView, Row, SectionContent } from '@shared/plugin';
import { patchFrom, rowsFrom, type RuntimeField, type RuntimeSnapshot } from '@shared/runtime';

const handlers = (id: string, ctx: Ctx) => ({
  command: (name: string, args: unknown[], stay: boolean) =>
    (stay ? ctx.actStay : ctx.act)(() => window.jt.invoke(id, name, args)),
  url: (url: string) => void window.jt.openUrl(url),
});

function section(snapshot: RuntimeSnapshot, ctx: Ctx): SectionContent {
  const { id, content, loadError } = snapshot;
  const on = handlers(id, ctx);
  const actions: Row[] = [
    ...rowsFrom(content.actions ?? [], on),
    {
      id: 'refresh',
      title: 'Refresh',
      run: () => ctx.actStay(() => window.jt.refresh(id)),
    },
    {
      id: 'configure',
      title: snapshot.fields.length ? 'Configure…' : 'About this plugin…',
      run: () => ctx.openSettings(id),
    },
  ];
  return {
    rows: loadError ? [] : rowsFrom(content.rows, on),
    actions,
    // The shell's own error takes precedence; this covers the moment before
    // the first refresh has had a chance to report it.
    error: loadError,
  };
}

const initial = (fields: RuntimeField[], config: Record<string, unknown>) =>
  Object.fromEntries(
    fields.map((f) => {
      const value = f.secret ? '' : config[f.key];
      return [f.key, value === undefined || value === null ? '' : String(value)];
    }),
  );

function Settings({
  snapshot,
  onSaved,
}: {
  snapshot: RuntimeSnapshot;
  onSaved: (message: string) => void;
}): ReactNode {
  const { id, fields, config, secretsSet, dir, loadError } = snapshot;
  const [values, setValues] = useState<Record<string, string>>(() => initial(fields, config));
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    setSaving(true);
    const result = await window.jt.savePluginConfig(id, patchFrom(fields, values));
    setSaving(false);
    onSaved(result.ok ? (result.message ?? 'Saved') : result.error);
  }

  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

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
      {loadError && <div className="banner bad">{loadError}</div>}

      {fields.map((field, i) => (
        <div key={field.key} className="field">
          <label>
            {field.label}
            {field.secret && (
              <span className={`pill ${secretsSet[field.key] ? '' : 'warn'}`}>
                {secretsSet[field.key] ? 'Set' : 'Not set'}
              </span>
            )}
          </label>
          {field.type === 'textarea' ? (
            <textarea
              rows={5}
              value={values[field.key]}
              placeholder={field.placeholder}
              autoFocus={i === 0}
              onChange={(e) => set(field.key, e.target.value)}
            />
          ) : (
            <input
              type={field.type ?? 'text'}
              value={values[field.key]}
              placeholder={
                field.placeholder ?? (field.secret && secretsSet[field.key] ? '••••••••' : undefined)
              }
              autoFocus={i === 0}
              onChange={(e) => set(field.key, e.target.value)}
            />
          )}
          {field.note && <div className="note">{field.note}</div>}
        </div>
      ))}

      {fields.length === 0 && !loadError && (
        <div className="banner">This plugin has nothing to set up.</div>
      )}

      <div className="field">
        <label>Loaded from</label>
        <div className="note plugins-dir">
          <span className="path" title={dir}>
            {dir}/main.js
          </span>
          <button type="button" onClick={() => void window.jt.copy(dir)}>
            Copy path
          </button>
        </div>
        <div className="note">
          Edit it, then run “Reload plugins” from the j-time section to pick the change up.
        </div>
      </div>

      {fields.length > 0 && (
        <div className="row selected" onClick={() => void save()}>
          <span className="lead">↩</span>
          <span className="labels">
            <span className="title">{saving ? 'Saving…' : 'Save settings'}</span>
            <span className="subtitle">Re-reads the plugin</span>
          </span>
          <span className="accessories">
            <kbd>⌘↩</kbd>
          </span>
        </div>
      )}
    </div>
  );
}

const cache = new Map<string, PluginView<RuntimeSnapshot>>();

/** The view for one runtime plugin. Cached so the section builders stay stable. */
export function runtimeView(id: string): PluginView<RuntimeSnapshot> {
  let view = cache.get(id);
  if (!view) {
    view = {
      id,
      title: id,
      section,
      settings: (snapshot, onSaved) => <Settings snapshot={snapshot} onSaved={onSaved} />,
      configured: (snapshot) => snapshot.configured,
    };
    cache.set(id, view);
  }
  return view;
}
