import { useState, type ReactNode } from 'react';
import type { Snapshot } from '@shared/ipc';
import { DEFAULT_HOTKEY } from '@shared/shell';
import { moveSection, resolveLayout, toggleCollapsed, togglePins } from '@shared/layout';
import { prettyAccelerator } from '@shared/keys';

/**
 * The app's own settings: the hotkey, and the arrangement of the plugins.
 *
 * Everything else belongs to a plugin and is edited on that plugin's own form.
 * What is here is what would still exist if every plugin were uninstalled.
 */
export function ShellSettings({
  snapshot,
  onSaved,
  onConfigure,
}: {
  snapshot: Snapshot;
  onSaved: (message: string) => void;
  onConfigure: (plugin: string) => void;
}): ReactNode {
  const { config, layout, plugins, hotkeyRegistered, pluginsDir } = snapshot.shell;
  const [hotkey, setHotkey] = useState(config.hotkey);
  const [saving, setSaving] = useState(false);

  const ids = plugins.map((p) => p.id);
  const sections = resolveLayout(layout, ids);
  const meta = (id: string) => plugins.find((p) => p.id === id);

  async function saveHotkey(): Promise<void> {
    setSaving(true);
    const result = await window.jt.saveShellConfig({ hotkey: hotkey.trim() || DEFAULT_HOTKEY });
    setSaving(false);
    onSaved(result.ok ? (result.message ?? 'Saved') : result.error);
  }

  const apply = (next: ReturnType<typeof toggleCollapsed>) => void window.jt.saveLayout(next);

  // The path, not the folder: opening Finder over an always-on-top panel is a
  // context switch the user didn't ask for, and a path pastes into anything.
  async function copyPluginsDir(): Promise<void> {
    await window.jt.copy(pluginsDir);
    onSaved('Copied the plugins folder path');
  }

  return (
    <div
      className="settings"
      onKeyDown={(e) => {
        // Escape belongs to the shell — it's how you get back to the list.
        if (e.key === 'Escape') return;
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void saveHotkey();
          return;
        }
        // Everything else is typing, and must not reach the palette's navigation.
        e.stopPropagation();
      }}
    >
      {!hotkeyRegistered && (
        <div className="banner warn">
          Another app already owns {prettyAccelerator(config.hotkey)}. Pick a different
          shortcut below — until you do, the menu bar item is the only way in.
        </div>
      )}

      <div className="field">
        <label>Hotkey</label>
        <input type="text" value={hotkey} onChange={(e) => setHotkey(e.target.value)} />
        <div className="note">
          Electron accelerator, e.g. Command+Shift+J — currently{' '}
          {prettyAccelerator(hotkey || DEFAULT_HOTKEY)}.
        </div>
      </div>

      <div className="field">
        <label>Plugins</label>
        <div className="note">
          The order the palette lists them in. A pinned row is one a plugin may lift
          above the others — the running timer, say.
        </div>
        <div className="sections-editor">
          {sections.map((section, i) => (
            <div key={section.id} className="section-setting">
              <span className="name">
                {meta(section.id)?.title ?? section.id}
                {meta(section.id)?.configured === false && <span className="pill warn">Not set up</span>}
              </span>
              <button
                type="button"
                disabled={i === 0}
                title="Move up"
                onClick={() => apply(moveSection(layout, ids, section.id, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={i === sections.length - 1}
                title="Move down"
                onClick={() => apply(moveSection(layout, ids, section.id, 1))}
              >
                ↓
              </button>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!section.collapsed}
                  onChange={() => apply(toggleCollapsed(layout, section.id))}
                />
                Expanded
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={section.pins}
                  onChange={() => apply(togglePins(layout, section.id))}
                />
                Allow pin
              </label>
              <button type="button" onClick={() => onConfigure(section.id)}>
                Configure…
              </button>
            </div>
          ))}
        </div>
        <div className="plugins-dir">
          <span className="path" title={pluginsDir}>
            {pluginsDir}
          </span>
          <button type="button" onClick={() => void copyPluginsDir()}>
            Copy path
          </button>
        </div>
        <div className="note">
          A folder with a main.js in it is a plugin. There’s an example and a guide there;
          “Reload plugins” in the palette picks up changes.
        </div>
      </div>

      <div className="row selected" onClick={() => void saveHotkey()}>
        <span className="lead">↩</span>
        <span className="labels">
          <span className="title">{saving ? 'Saving…' : 'Save settings'}</span>
          <span className="subtitle">Rebinds the hotkey</span>
        </span>
        <span className="accessories">
          <kbd>⌘↩</kbd>
        </span>
      </div>
    </div>
  );
}
