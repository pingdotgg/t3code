import type { ConnectionPhase } from "../platform/ipc.ts";

/**
 * Sidebar column. Port target: `UI/Shell/SidebarView.swift` (projects, threads
 * grouped by status, archived section, search). Until the client-runtime shell
 * subscription is wired, it renders the connection's own state so the column
 * is never a blank rectangle during launch — the macOS sidebar behaves the
 * same way while the server is coming up.
 */
export function Sidebar({ phase }: { readonly phase: ConnectionPhase }) {
  return (
    <div className="column column--sidebar">
      <div className="content-header">
        <span style={{ font: "var(--font-thread-title)" }}>Sessions</span>
      </div>
      <div className="pane-scroll">
        <div className="empty-state">
          <div className="empty-state__body">
            {phase.kind === "ready"
              ? "No sessions yet. Start one from the toolbar."
              : "Sessions appear once the local server is connected."}
          </div>
        </div>
      </div>
    </div>
  );
}
