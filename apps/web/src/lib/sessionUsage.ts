import { UsageDay, type UsageTokenTotals } from "@t3tools/contracts";

export const SESSION_USAGE_WINDOW = {
  sinceDay: UsageDay.make("2000-01-01"),
  untilDay: UsageDay.make("9999-12-31"),
  timeZone: "UTC",
  includeThreadUsage: true,
};

export function sessionSpendRate(
  previousCost: number,
  previousAt: number,
  cost: number,
  at: number,
): number {
  const elapsed = at - previousAt;
  // Ignore initial history, reconnect gaps and tiny intervals that magnify rounding.
  if (previousAt === 0 || elapsed < 30_000 || elapsed > 120_000) return 0;
  return (Math.max(0, cost - previousCost) * 60_000) / elapsed;
}

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
