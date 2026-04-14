import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@t3tools/contracts";

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const {
      payload: {
        usedTokens,
        totalProcessedTokens,
        maxTokens,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        lastUsedTokens,
        lastInputTokens,
        lastCachedInputTokens,
        lastOutputTokens,
        lastReasoningOutputTokens,
        toolUses,
        durationMs,
        compactsAutomatically,
      },
    } = activity;
    if (!Number.isFinite(usedTokens) || usedTokens <= 0) {
      continue;
    }

    const usedPercentage =
      maxTokens !== undefined && maxTokens > 0
        ? Math.min(100, (usedTokens / maxTokens) * 100)
        : null;
    const remainingTokens =
      maxTokens !== undefined ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: totalProcessedTokens ?? null,
      maxTokens: maxTokens ?? null,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: inputTokens ?? null,
      cachedInputTokens: cachedInputTokens ?? null,
      outputTokens: outputTokens ?? null,
      reasoningOutputTokens: reasoningOutputTokens ?? null,
      lastUsedTokens: lastUsedTokens ?? null,
      lastInputTokens: lastInputTokens ?? null,
      lastCachedInputTokens: lastCachedInputTokens ?? null,
      lastOutputTokens: lastOutputTokens ?? null,
      lastReasoningOutputTokens: lastReasoningOutputTokens ?? null,
      toolUses: toolUses ?? null,
      durationMs: durationMs ?? null,
      compactsAutomatically: compactsAutomatically ?? false,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
