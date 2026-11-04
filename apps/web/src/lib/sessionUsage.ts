import { UsageDay, type UsageTokenTotals } from "@t3tools/contracts";

export const SESSION_USAGE_WINDOW = {
  sinceDay: UsageDay.make("2000-01-01"),
  untilDay: UsageDay.make("9999-12-31"),
  timeZone: "UTC",
  includeThreadUsage: true,
};

export function sessionTokenCount(tokens: UsageTokenTotals): number {
  return (
    tokens.uncachedInputTokens +
    tokens.cachedInputTokens +
    tokens.cacheCreationTokens +
    tokens.outputTokens
  );
}

export function formatSessionCost(costUsd: number, partial = false): string {
  return `${partial ? "≥" : ""}$${Math.round(costUsd).toLocaleString("en-US")}`;
}
