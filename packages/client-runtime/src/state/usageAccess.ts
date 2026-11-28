import {
  AuthDiagnosticsReadScope,
  sessionGrantsScope,
  type ServerSettings,
  type SessionGrantInput,
  type UsageAccessRequest,
  type UsageSummary,
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

/**
 * The agents a session can still answer for. A summary lists who was unanswered when its scan
 * began, and a first scan can run long, so answers the settings already hold are left out.
 */
export function unansweredUsageAccessRequests(input: {
  readonly canAnswer: boolean;
  readonly summary: Pick<UsageSummary, "accessRequests"> | null;
  readonly providerInstances: ServerSettings["providerInstances"] | undefined;
}): readonly UsageAccessRequest[] {
  if (!input.canAnswer) return [];
  return (input.summary?.accessRequests ?? []).filter(
    (request) => input.providerInstances?.[request.instanceId]?.usageAccess === undefined,
  );
}
