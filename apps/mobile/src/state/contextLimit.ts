import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { compareThreadActivityOrder } from "../lib/threadActivity";

export function threadContextReachedLimit(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  contextTokenLimit: number | undefined,
): boolean {
  if (contextTokenLimit === undefined) return false;
  let latest:
    | { readonly activity: OrchestrationThreadActivity; readonly usedTokens: number }
    | undefined;
  for (const activity of activities) {
    if (activity?.kind !== "context-window.updated") continue;
    const payload = activity.payload as Record<string, unknown> | undefined;
    const usedTokens = payload?.usedTokens;
    if (typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0) {
      if (latest === undefined || compareThreadActivityOrder(latest.activity, activity) <= 0) {
        latest = { activity, usedTokens };
      }
    }
  }
  return latest !== undefined && latest.usedTokens >= contextTokenLimit;
}
