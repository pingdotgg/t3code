import type { ProviderSession, ThreadId } from "@t3tools/contracts";
export const MAX_CONCURRENT_PROVIDER_TURNS = 8;

export type UsageLimitViolation = {
  readonly code: "concurrent-turn-limit" | "handover-in-progress";
  readonly detail: string;
};

function concurrentTurnLimitViolation(runningTurnCount: number): UsageLimitViolation | undefined {
  if (runningTurnCount < MAX_CONCURRENT_PROVIDER_TURNS) {
    return undefined;
  }
  return {
    code: "concurrent-turn-limit",
    detail: `T3 usage limit: ${runningTurnCount} provider turns are already running. The hard limit is ${MAX_CONCURRENT_PROVIDER_TURNS}. Wait for one to finish or interrupt it before starting more work.`,
  };
}

function isRunningSession(session: ProviderSession): boolean {
  return session.status === "connecting" || session.status === "running";
}

function runningTurnThreadIds(
  sessions: ReadonlyArray<ProviderSession>,
  reservedTurnThreadIds: ReadonlyArray<ThreadId>,
): ReadonlySet<ThreadId> {
  return new Set([
    ...sessions.filter(isRunningSession).map((session) => session.threadId),
    ...reservedTurnThreadIds,
  ]);
}

export function evaluateTurnStartLimits(input: {
  readonly threadId: ThreadId;
  readonly sessions: ReadonlyArray<ProviderSession>;
  readonly reservedTurnThreadIds?: ReadonlyArray<ThreadId>;
  readonly reservedHandoverCount?: number;
}): UsageLimitViolation | undefined {
  const currentThreadIsRunning =
    input.sessions.some(
      (session) => session.threadId === input.threadId && isRunningSession(session),
    ) || input.reservedTurnThreadIds?.includes(input.threadId) === true;
  const runningTurnCount =
    runningTurnThreadIds(input.sessions, input.reservedTurnThreadIds ?? []).size +
    (input.reservedHandoverCount ?? 0);
  return currentThreadIsRunning ? undefined : concurrentTurnLimitViolation(runningTurnCount);
}

export function evaluateHandoverStartLimits(input: {
  readonly sessions: ReadonlyArray<ProviderSession>;
  readonly reservedTurnThreadIds?: ReadonlyArray<ThreadId>;
  readonly reservedHandoverCount?: number;
}): UsageLimitViolation | undefined {
  return concurrentTurnLimitViolation(
    runningTurnThreadIds(input.sessions, input.reservedTurnThreadIds ?? []).size +
      (input.reservedHandoverCount ?? 0),
  );
}
