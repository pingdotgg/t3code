import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
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
/** The allowance renews monthly, so the window spans the calendar month before its reset. */
function monthlyWindowDuration(resetAt: string | null | undefined) {
  const end = resetAt ? DateTime.make(resetAt) : Option.none();
  if (Option.isNone(end)) return {};
  const start = DateTime.subtract(end.value, { months: 1 });
  return {
    windowDurationMins: Math.round(
      (DateTime.toEpochMillis(end.value) - DateTime.toEpochMillis(start)) / 60_000,
    ),
  };
}

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
    ...monthlyWindowDuration(budget.resetAt),
  };
  return makeUsageLimits({ checkedAt, windows: [window] });
}
