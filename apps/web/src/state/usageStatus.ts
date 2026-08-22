import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, UsageSummary } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

const USAGE_REPORT_ERROR = "This environment could not report usage.";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

type UsageConnectionState = "connected" | "transitioning" | "terminal";

/**
 * Connection phases decide whether a usage request can still make progress.
 * Keeping this exhaustive makes a newly added phase an explicit product
 * decision instead of silently treating it as a failure.
 */
function classifyUsageConnection(phase: EnvironmentConnectionPhase): UsageConnectionState {
  switch (phase) {
    case "connected":
      return "connected";
    case "connecting":
    case "reconnecting":
      return "transitioning";
    case "available":
    case "offline":
    case "error":
      return "terminal";
  }
}

/** Projects transport and SWR state into the status rendered for one environment. */
export function deriveEnvironmentUsageStatus<E>(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly result: AsyncResult.AsyncResult<UsageSummary, E>;
}): EnvironmentUsageStatus {
  const connection = classifyUsageConnection(input.connectionPhase);
  const isPending =
    connection === "transitioning" ||
    (connection === "connected" && (input.result.waiting || input.result._tag === "Initial"));
  const summary = Option.getOrNull(AsyncResult.value(input.result));
  const hasTerminalQueryFailure = input.result._tag === "Failure" && !isPending;
  return {
    environmentId: input.environmentId,
    label: input.label,
    isPending,
    error:
      hasTerminalQueryFailure || (connection === "terminal" && summary === null)
        ? USAGE_REPORT_ERROR
        : null,
    summary: hasTerminalQueryFailure ? null : summary,
  };
}

/** Derives the page gate for the current request generation. */
export function deriveUsageSettlingState(environments: readonly EnvironmentUsageStatus[]): {
  readonly isPending: boolean;
  readonly isPartial: boolean;
} {
  // SWR preserves the previous summary while a refresh is in flight. A
  // retained value belongs to the previous request, so it does not count as
  // this request having answered until `waiting` clears.
  const answeredCount = environments.filter(
    (environment) => environment.summary !== null && !environment.isPending,
  ).length;
  const stillReporting = environments.filter(
    (environment) => environment.isPending && environment.error === null,
  ).length;

  return {
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
  };
}
