import type { TurnTokenUsage } from "@t3tools/contracts";

export function sumOf(
  usages: ReadonlyArray<TurnTokenUsage>,
  field:
    | "inputTokens"
    | "cachedInputTokens"
    | "cacheCreationTokens"
    | "outputTokens"
    | "reasoningTokens",
  requireAll: boolean,
): number | undefined {
  const values = usages.map((usage) => usage[field]);
  const known = values.filter((value) => value !== undefined);
  if (known.length === 0 || (requireAll && known.length < values.length)) return undefined;
  return known.reduce((sum, value) => sum + value, 0);
}

/** complete only when every turn is complete; partial when any turn has counts. */
export function combinedStatus(
  usages: ReadonlyArray<TurnTokenUsage | undefined>,
): "complete" | "partial" | "unavailable" {
  if (usages.length > 0 && usages.every((usage) => usage?.usageStatus === "complete")) {
    return "complete";
  }
  return usages.some(
    (usage) => usage?.inputTokens !== undefined || usage?.outputTokens !== undefined,
  )
    ? "partial"
    : "unavailable";
}
