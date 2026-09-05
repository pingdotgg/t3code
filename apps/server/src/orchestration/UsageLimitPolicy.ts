import {
  DEFAULT_THREAD_CONTEXT_TOKEN_LIMIT,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
export { DEFAULT_THREAD_CONTEXT_TOKEN_LIMIT };
export type UsageLimitViolation = { readonly code: "context-limit"; readonly detail: string };
export function evaluateTurnStartLimits(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly contextTokenLimit?: number;
}): UsageLimitViolation | undefined {
  const usedTokens = latestContextTokens(input.activities);
  const contextTokenLimit = input.contextTokenLimit ?? DEFAULT_THREAD_CONTEXT_TOKEN_LIMIT;
  if (usedTokens !== undefined && usedTokens >= contextTokenLimit) {
    return {
      code: "context-limit",
      detail: `T3 usage limit: this thread has used ${usedTokens.toLocaleString("en-US")} context tokens. The hard limit is ${contextTokenLimit.toLocaleString("en-US")}. Start a new thread so the old conversation is not sent to the provider again.`,
    };
  }
  return undefined;
}

function latestContextTokens(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | undefined {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== "context-window.updated") continue;
    const payload = activity.payload as Record<string, unknown> | undefined;
    const usedTokens = payload?.["usedTokens"];
    if (typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0) {
      return usedTokens;
    }
  }
  return undefined;
}
