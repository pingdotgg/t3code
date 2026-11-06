import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type { AccountView } from "@t3tools/vibe-app-server/client";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

export const MISTRAL_USAGE_URL = "https://console.mistral.ai/usage";

/**
 * Maps the app server's `account/read` billing view to the native usage-limits
 * contract: the monthly Vibe Code allowance becomes a "monthly" window with a
 * reset timestamp. Accounts without a budget (API keys, self-hosted) report
 * unsupported plus a console link, like Codex's managed account.
 */
export function accountViewToUsageLimits(
  account: AccountView,
  checkedAt: string,
): ServerProviderUsageLimits {
  const budget = account.budget;
  if (budget === null || budget === undefined || !Number.isFinite(budget.usagePercentage)) {
    return {
      ...makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "This Vibe account does not expose a monthly allowance.",
      }),
      externalUsage: { label: "Mistral usage", url: MISTRAL_USAGE_URL },
    };
  }
  const window: ServerProviderUsageWindow = {
    id: "vibe-code-monthly",
    kind: "monthly",
    label: budget.paygEnabled === true ? "Monthly (pay-as-you-go)" : "Monthly",
    usedPercent: clampPercent(budget.usagePercentage),
    ...(budget.resetAt ? { resetsAt: budget.resetAt } : {}),
  };
  return makeUsageLimits({ checkedAt, windows: [window] });
}
