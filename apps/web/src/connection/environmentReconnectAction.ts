import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

/**
 * Label for the explicit retry on an unavailable environment.
 *
 * Reconnecting is the backoff wait, which an explicit retry skips. The first
 * connecting attempt is already in flight, so it has no action. Every other
 * unavailable phase keeps the chat banner's existing Reconnect control.
 * Connections settings only renders the "Retry now" case; a failed connection
 * stays on its own recovery.
 */
export function environmentReconnectActionLabel(
  phase: EnvironmentConnectionPhase,
): "Retry now" | "Reconnect" | null {
  switch (phase) {
    case "reconnecting":
      return "Retry now";
    case "connecting":
    case "connected":
      return null;
    case "available":
    case "offline":
    case "error":
    case "unsupported":
      return "Reconnect";
  }
}
