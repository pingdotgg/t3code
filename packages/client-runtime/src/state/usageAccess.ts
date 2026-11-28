import {
  AuthDiagnosticsReadScope,
  sessionGrantsScope,
  type ServerConfig,
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
 * began, and a first scan can run long, so it is checked against the live settings.
 */
export function unansweredUsageAccessRequests(input: {
  readonly canAnswer: boolean;
  readonly summary: Pick<UsageSummary, "accessRequests"> | null;
  /** Null until the environment's settings and provider list have loaded. */
  readonly config: Pick<ServerConfig, "settings" | "providers"> | null;
}): readonly UsageAccessRequest[] {
  const { config } = input;
  // An answer is saved by rewriting the instance from live settings, so nothing is asked before they load.
  if (!input.canAnswer || config === null) return [];
  return (input.summary?.accessRequests ?? []).filter(
    (request) =>
      config.settings.providerInstances[request.instanceId]?.usageAccess === undefined &&
      // An agent removed or turned off since the scan must not be saved back into settings.
      config.providers.some(
        (provider) => provider.instanceId === request.instanceId && provider.enabled,
      ),
  );
}

/** What usage access lets T3 Code read for an agent, as the short note beside its switch. */
export function usageAccessReadsLabel(driver: string, resolve: MFunctionType = mFallback): string {
  switch (driver) {
    case "claudeAgent":
    case "grok":
      return resolve(msg("Session history and sign-in"));
    case "opencode":
      return resolve(msg("Usage database and Go key"));
    case "antigravity":
      return resolve(msg("Conversation history"));
    case "cursor":
      return resolve(msg("Account usage from Cursor"));
    default:
      return resolve(msg("Session history"));
  }
}
