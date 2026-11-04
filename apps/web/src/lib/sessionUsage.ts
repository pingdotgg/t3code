import type { UsageTokenTotals } from "@t3tools/contracts";

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
