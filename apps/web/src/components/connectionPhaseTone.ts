import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import type { StatusDotTone } from "~/components/ui/status-dot";

/** Canonical connection-phase → status tone mapping shared by every connection dot. */
export function connectionPhaseTone(phase: EnvironmentConnectionPhase): StatusDotTone {
  switch (phase) {
    case "connected":
      return "success";
    case "connecting":
    case "reconnecting":
      return "warning";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

/** Transitional phases ring their dot. */
export function connectionPhasePings(phase: EnvironmentConnectionPhase): boolean {
  return phase === "connecting" || phase === "reconnecting";
}
