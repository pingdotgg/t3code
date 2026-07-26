import { type ConnectionPhase, phaseLabel } from "../platform/ipc.ts";

/**
 * Port of `UI/Shell/ConnectionStatusPill.swift`. Sits in the toolbar next to
 * the sidebar toggle, in a fixed slot, so it never moves as the sidebar
 * collapses.
 */
export function ConnectionStatusPill({ phase }: { readonly phase: ConnectionPhase }) {
  const label = phaseLabel(phase);
  return (
    <div
      className="status-pill no-drag"
      data-phase={phase.kind}
      role="status"
      aria-live="polite"
      title={label}
    >
      <span className="status-pill__dot" />
      <span>{label}</span>
    </div>
  );
}
