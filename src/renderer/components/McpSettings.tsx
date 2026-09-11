import { useMemo, useState, type ReactNode } from 'react';
import type { Snapshot } from '@shared/ipc';
import {
  DEFAULT_MCP_PORT,
  toggleTool,
  toggleTools,
  type McpConfig,
  type McpToolInfo,
} from '@shared/mcp';

/**
 * The MCP server's own page: the port, and which tools it may serve.
 *
 * A page rather than a block on the shell's settings screen, because the tool
 * list is as long as the plugins make it — JIRA alone has ten — and a list that
 * long buried under the hotkey would push the plugin arrangement off the bottom
 * of a panel that is deliberately the size of a palette.
 *
 * Switching a tool off is the point of the page. Every plugin's tools arrive on
 * by default, which is the only behaviour that doesn't require a visit here
 * after every upgrade; this is where you say no to the ones you don't want a
 * model reaching for — the three that write to JIRA, most likely.
 */
export function McpSettings({
  snapshot,
  onSaved,
}: {
  snapshot: Snapshot;
  onSaved: (message: string) => void;
}): ReactNode {
  const { config, mcp } = snapshot.shell;
  const stored = config.mcp;
  const [port, setPort] = useState(String(stored.port));
  const [saving, setSaving] = useState(false);

  const addCommand = `claude mcp add --transport http j-time ${mcp.url}`;
  const off = mcp.tools.filter((t) => !t.enabled).length;

  /** The tools as the page lists them: by plugin, in registration order. */
  const groups = useMemo(() => {
    const out: { plugin: string; section: string; tools: McpToolInfo[] }[] = [];
    for (const tool of mcp.tools) {
      const group = out.find((g) => g.plugin === tool.plugin);
      if (group) group.tools.push(tool);
      else out.push({ plugin: tool.plugin, section: tool.section, tools: [tool] });
    }
    return out;
  }, [mcp.tools]);

  /**
   * Write the endpoint's settings.
   *
   * Everything on this page saves on the spot except the port, which is applied
   * by the Save row — a checkbox you tick while halfway through typing a port
   * number must not take the endpoint down on `419`.
   */
  async function write(next: Partial<McpConfig>): Promise<void> {
    setSaving(true);
    const result = await window.jt.saveShellConfig({ mcp: { ...stored, ...next } });
    setSaving(false);
    onSaved(result.ok ? (result.message ?? 'Saved') : result.error);
  }

  function savePort(): void {
    const typed = Number.parseInt(port, 10);
    void write({ port: Number.isFinite(typed) ? typed : DEFAULT_MCP_PORT });
  }

  async function copyAddCommand(): Promise<void> {
    await window.jt.copy(addCommand);
    onSaved('Copied the registration command');
  }

  return (
    <div
      className="settings"
      onKeyDown={(e) => {
        // Escape belongs to the shell — it's how you get back to the list.
        if (e.key === 'Escape') return;
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          savePort();
          return;
        }
        // Everything else is typing, and must not reach the palette's navigation.
        e.stopPropagation();
      }}
    >
      {mcp.error && <div className="banner warn">{mcp.error}</div>}

      <div className="field">
        <label>
          Endpoint
          {mcp.listening ? (
            <span className="pill accent">listening</span>
          ) : (
            <span className="pill">off</span>
          )}
        </label>
        <div className="note">
          Lets Claude Code — or any MCP client — call your plugins’ tools: the board, the
          clock, which sessions are waiting. Loopback only, so nothing outside this machine
          can reach it.
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={stored.enabled}
            onChange={() => void write({ enabled: !stored.enabled })}
          />
          Serve on localhost
        </label>
        <div className="copy-row">
          <span className="path" title={addCommand}>
            {addCommand}
          </span>
          <button type="button" onClick={() => void copyAddCommand()}>
            Copy
          </button>
        </div>
      </div>

      <div className="field">
        <label>Port</label>
        <input
          type="number"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder={String(DEFAULT_MCP_PORT)}
        />
        <div className="note">
          Save below to move the endpoint. A client already registered at the old port has
          to be pointed at the new one.
        </div>
      </div>

      <div className="field">
        <label>
          Tools
          <span className="pill">
            {mcp.tools.length - off} of {mcp.tools.length} on
          </span>
        </label>
        <div className="note">
          Every plugin’s tools, on unless you say otherwise. A tool switched off is not
          offered to a client at all — the ones marked <em>writes</em> are the ones that
          change something outside this app.
        </div>

        {mcp.tools.length === 0 && (
          <div className="banner">No plugin has registered a tool yet.</div>
        )}

        {groups.map((group) => {
          const names = group.tools.map((t) => t.name);
          const allOn = group.tools.every((t) => t.enabled);
          return (
            <div className="tool-group" key={group.plugin}>
              <div className="tool-group-head">
                <span className="name">{group.section}</span>
                <button
                  type="button"
                  onClick={() => void write({ disabled: toggleTools(stored.disabled, names, !allOn) })}
                >
                  {allOn ? 'Turn all off' : 'Turn all on'}
                </button>
              </div>
              {group.tools.map((tool) => (
                <label
                  className={`tool-setting${tool.enabled ? '' : ' off'}`}
                  key={tool.name}
                  title={tool.description}
                >
                  <input
                    type="checkbox"
                    checked={tool.enabled}
                    onChange={() =>
                      void write({
                        disabled: toggleTool(stored.disabled, tool.name, !tool.enabled),
                      })
                    }
                  />
                  <span className="body">
                    <span className="name">
                      {tool.name}
                      {tool.destructive && <span className="pill warn">writes</span>}
                    </span>
                    <span className="what">{tool.description}</span>
                  </span>
                </label>
              ))}
            </div>
          );
        })}
      </div>

      <div className="row selected" onClick={() => savePort()}>
        <span className="lead">↩</span>
        <span className="labels">
          <span className="title">{saving ? 'Saving…' : 'Save port'}</span>
          <span className="subtitle">Restarts the endpoint. Everything else saved as you clicked it.</span>
        </span>
        <span className="accessories">
          <kbd>⌘↩</kbd>
        </span>
      </div>
    </div>
  );
}
