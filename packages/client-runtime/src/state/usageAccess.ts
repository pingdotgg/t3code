import { AuthDiagnosticsReadScope, type AuthSessionState } from "@t3tools/contracts";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

export function resolveUsageAccess(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly hasSessionError: boolean;
}) {
  if (input.hasSessionError) {
    return {
      canReadDiagnostics: false,
      isPending: false,
      error: "Could not check this connection's access to diagnostics and usage.",
    };
  }
  if (input.session === null) {
    // An unprepared offline connection cannot finish its session check. Keep
    // it out of pending totals until the connection starts another attempt.
    const isPending =
      input.connectionPhase === "connected" ||
      input.connectionPhase === "connecting" ||
      input.connectionPhase === "reconnecting";
    return {
      canReadDiagnostics: false,
      isPending,
      error: isPending ? null : "This environment is not connected.",
    };
  }
  const canReadDiagnostics =
    input.session.authenticated &&
    input.session.scopes?.includes(AuthDiagnosticsReadScope) === true;
  return {
    canReadDiagnostics,
    isPending: false,
    error: canReadDiagnostics
      ? null
      : "This connection does not have access to diagnostics and usage.",
  };
}
