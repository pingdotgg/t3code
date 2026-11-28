import {
  AuthDiagnosticsReadScope,
  sessionGrantsScope,
  type SessionGrantInput,
} from "@t3tools/contracts";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export function resolveUsageAccess(
  input: {
    readonly connectionPhase: EnvironmentConnectionPhase;
    readonly session: SessionGrantInput | null;
    readonly hasSessionError: boolean;
  },
  resolve: MFunctionType = mFallback,
) {
  if (input.hasSessionError) {
    return {
      canReadDiagnostics: false,
      isPending: false,
      error: resolve(msg("Could not check this connection's access to diagnostics and usage.")),
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
      error: isPending ? null : resolve(msg("This environment is not connected.")),
    };
  }
  const canReadDiagnostics = sessionGrantsScope(input.session, AuthDiagnosticsReadScope);
  return {
    canReadDiagnostics,
    isPending: false,
    error: canReadDiagnostics
      ? null
      : resolve(msg("This connection does not have access to diagnostics and usage.")),
  };
}
