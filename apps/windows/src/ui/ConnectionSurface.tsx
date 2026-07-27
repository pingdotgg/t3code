import { useState } from "react";

import type { LocalEnvironmentSession } from "../connection/desktopBootstrap.ts";
import { type ConnectionPhase, restartSidecar } from "../platform/ipc.ts";

/**
 * The detail column while there is no selected thread — the Windows shape of
 * `UI/Shell/EmptyStateView.swift`.
 *
 * It deliberately shows the sidecar's own failure text rather than a generic
 * "something went wrong": on macOS the two failures users actually hit are a
 * missing Node runtime and a server bundle that was never built, and both are
 * only actionable if the reason is on screen. The retry button drives the
 * supervisor's `restart` command, which is the same escape hatch as quitting
 * and relaunching, without losing the window.
 */
export function ConnectionSurface({
  phase,
  session,
}: {
  readonly phase: ConnectionPhase;
  readonly session: LocalEnvironmentSession | null;
}) {
  const [restarting, setRestarting] = useState(false);

  const retry = () => {
    setRestarting(true);
    void restartSidecar().finally(() => setRestarting(false));
  };

  if (phase.kind === "failed") {
    return (
      <div className="empty-state">
        <div className="empty-state__title">The local server did not start</div>
        <div className="empty-state__detail selectable">{phase.detail}</div>
        <button type="button" className="primary-button" onClick={retry} disabled={restarting}>
          {restarting ? "Restarting…" : "Try Again"}
        </button>
      </div>
    );
  }

  if (phase.kind !== "ready" || session === null) {
    return (
      <div className="empty-state">
        <div className="empty-state__title">
          {phase.kind === "launchingServer" ? "Launching Server…" : "Connecting…"}
        </div>
        <div className="empty-state__body">
          SurgeCode runs the SergeCode server on this PC and talks to it over a loopback WebSocket.
          Nothing leaves the machine unless you turn on LAN access for the iPhone companion.
        </div>
      </div>
    );
  }

  return (
    <div className="empty-state">
      <div className="empty-state__title">Connected to {session.label}</div>
      <div className="empty-state__body">
        Select a session from the sidebar, or start a new one.
      </div>
      <div className="empty-state__detail selectable">{session.httpBaseUrl}</div>
    </div>
  );
}
