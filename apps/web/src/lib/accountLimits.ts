import type { AccountRateLimitsSnapshot, OrchestrationThreadActivity } from "@t3tools/contracts";
import { normalizeAccountRateLimits } from "@t3tools/shared/accountLimits";

export function deriveLatestAccountLimitSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AccountRateLimitsSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "account-rate-limits.updated") {
      continue;
    }

    const snapshot = normalizeAccountRateLimits(activity.payload);
    if (snapshot?.selected) {
      return snapshot;
    }
  }

  return null;
}
