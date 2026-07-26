import type { ConnectionPhase } from "../platform/ipc.ts";
import { ConnectionStatusPill } from "./ConnectionStatusPill.tsx";

/**
 * Port of the window toolbar vended by `ContentView.swift`.
 *
 * The macOS layout rule carries over verbatim, and for the same reason: the
 * sidebar toggle and the connection pill share one leading slot so the toggle
 * is anchored to the pill and cannot drift as the sidebar collapses. The
 * inspector toggle owns the trailing slot.
 *
 * The band itself is a drag region (Windows has no unified titlebar API in
 * Tauri, so the app drags from its own chrome); every control opts out with
 * `no-drag`, or clicking it would start a window move instead.
 */
export function Toolbar({
  phase,
  sidebarVisible,
  inspectorVisible,
  canToggleInspector,
  onToggleSidebar,
  onToggleInspector,
  onNewSession,
}: {
  readonly phase: ConnectionPhase;
  readonly sidebarVisible: boolean;
  readonly inspectorVisible: boolean;
  readonly canToggleInspector: boolean;
  readonly onToggleSidebar: () => void;
  readonly onToggleInspector: () => void;
  readonly onNewSession: () => void;
}) {
  const sidebarTitle = sidebarVisible ? "Hide Sidebar" : "Show Sidebar";
  return (
    <div className="toolbar">
      <button
        type="button"
        className="icon-button"
        onClick={onToggleSidebar}
        title={sidebarTitle}
        aria-label={sidebarTitle}
        aria-pressed={sidebarVisible}
      >
        <SidebarLeadingGlyph />
      </button>
      <ConnectionStatusPill phase={phase} />
      <div className="toolbar__spacer" />
      <button
        type="button"
        className="primary-button"
        onClick={onNewSession}
        disabled={phase.kind !== "ready"}
        title="Start a new session"
      >
        New Session
      </button>
      <button
        type="button"
        className="icon-button"
        onClick={onToggleInspector}
        disabled={!canToggleInspector}
        title="Inspector"
        aria-label="Inspector"
        aria-pressed={inspectorVisible}
      >
        <SidebarTrailingGlyph />
      </button>
    </div>
  );
}

/* `sidebar.leading` / `sidebar.right` equivalents. SF Symbols are Apple-only,
   so the two structural glyphs are inlined rather than pulling an icon font in
   for them. */

function SidebarLeadingGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" stroke="currentColor" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" />
    </svg>
  );
}

function SidebarTrailingGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" stroke="currentColor" />
      <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" />
    </svg>
  );
}
