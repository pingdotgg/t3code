import {
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2ProviderThread,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadStructure, ThreadStructureTurnItem } from "./models.ts";

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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

/**
 * Newest report by timestamp among the active provider thread's turns, since a provider switch leaves
 * the previous provider's report behind. Without an active provider thread, every turn is a candidate.
 */
export function latestProviderTurnTokenUsage(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "tokenUsage">>,
  projection?: Pick<ThreadStructure, "thread" | "contextTransfers"> | null,
  providerThread?: Pick<OrchestrationV2ProviderThread, "id" | "contextUsage"> | null,
): OrchestrationV2ProviderTurnTokenUsage | null {
  let latest: OrchestrationV2ProviderTurnTokenUsage | null = null;
  for (const { providerThreadId, tokenUsage } of turns) {
    if (tokenUsage === undefined) continue;
    if (providerThread != null && providerThreadId !== providerThread.id) continue;
    // Ties go to the later entry, since live upserts append.
    if (latest === null || Date.parse(tokenUsage.updatedAt) >= Date.parse(latest.updatedAt)) {
      latest = tokenUsage;
    }
  }
  if (latest !== null || projection == null || providerThread?.contextUsage != null) return latest;
  const forkedFrom = projection.thread.forkedFrom;
  if (forkedFrom?.type !== "run") return null;
  return (
    projection.contextTransfers.find(
      (transfer) =>
        transfer.type === "fork" &&
        transfer.targetThreadId === projection.thread.id &&
        transfer.sourceThreadId === forkedFrom.threadId &&
        transfer.sourcePoint.runId === forkedFrom.runId &&
        transfer.sourceProviderInstanceId === projection.thread.modelSelection.instanceId &&
        (transfer.status === "pending" || transfer.resolution?.strategy === "native_fork"),
    )?.sourceTokenUsage ?? null
  );
}

type CompactionItem = Extract<ThreadStructureTurnItem, { readonly type: "compaction" }>;

// A retired provider thread's items say nothing about the active conversation.
function isRetiredProviderThreadItem(
  item: CompactionItem,
  providerThread: Pick<OrchestrationV2ProviderThread, "id"> | null | undefined,
): boolean {
  return (
    providerThread != null &&
    item.providerThreadId != null &&
    item.providerThreadId !== providerThread.id
  );
}

function compactionSnapshot(
  item: CompactionItem,
  maxTokens: number | null,
  updatedAt: string,
): ContextWindowSnapshot | null {
  const usedTokens = asFiniteNumber(item.afterTokenCount);
  if (usedTokens === null || usedTokens < 0) return null;
  const usedPercentage =
    maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
  return {
    usedTokens,
    totalProcessedTokens: asFiniteNumber(item.beforeTokenCount),
    maxTokens,
    remainingTokens: maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null,
    usedPercentage,
    remainingPercentage: usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: true,
    autoCompactThreshold: null,
    cost: null,
    updatedAt,
  };
}

export function deriveLatestContextWindowSnapshot(
  entries: ReadonlyArray<{
    readonly item: ThreadStructureTurnItem;
  }>,
  liveUsage?: OrchestrationV2ProviderTurnTokenUsage | null,
  providerThread?: Pick<OrchestrationV2ProviderThread, "id" | "contextUsage" | "updatedAt"> | null,
): ContextWindowSnapshot | null {
  const latestCompletedCompaction = entries.findLast(
    (entry): entry is { readonly item: CompactionItem } =>
      entry.item.type === "compaction" &&
      entry.item.status === "completed" &&
      !isRetiredProviderThreadItem(entry.item, providerThread),
  )?.item;
  const usageUpdatedAt =
    liveUsage?.updatedAt ??
    (providerThread?.contextUsage != null ? DateTime.formatIso(providerThread.updatedAt) : null);
  if (latestCompletedCompaction !== undefined) {
    const compactedAt = DateTime.formatIso(
      latestCompletedCompaction.completedAt ?? latestCompletedCompaction.updatedAt,
    );
    // Usage reported before the compaction describes the context it just discarded; usage at
    // the same instant is the provider's own post-compaction report.
    if (usageUpdatedAt === null || Date.parse(compactedAt) > Date.parse(usageUpdatedAt)) {
      return compactionSnapshot(
        latestCompletedCompaction,
        liveUsage?.maxTokens ?? asFiniteNumber(providerThread?.contextUsage?.maxTokens),
        compactedAt,
      );
    }
  }

  if (liveUsage != null) {
    const usedTokens = Math.max(0, liveUsage.usedTokens);
    const maxTokens = liveUsage.maxTokens ?? null;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;
    return {
      usedTokens,
      totalProcessedTokens: null,
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: liveUsage.inputTokens ?? null,
      cachedInputTokens: liveUsage.cachedInputTokens ?? null,
      outputTokens: liveUsage.outputTokens ?? null,
      reasoningOutputTokens: liveUsage.reasoningOutputTokens ?? null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: true,
      autoCompactThreshold: liveUsage.autoCompactThreshold ?? null,
      cost: null,
      updatedAt: liveUsage.updatedAt,
    };
  }
  const providerUsage = providerThread?.contextUsage;
  const providerUsageUpdatedAt = providerThread?.updatedAt;
  if (
    providerUsage !== null &&
    providerUsage !== undefined &&
    providerUsageUpdatedAt !== undefined
  ) {
    const maxTokens = asFiniteNumber(providerUsage.maxTokens);
    const usedTokens = providerUsage.usedTokens;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(providerUsage.totalProcessedTokens),
      maxTokens,
      remainingTokens: maxTokens === null ? null : Math.max(0, Math.round(maxTokens - usedTokens)),
      usedPercentage,
      remainingPercentage: usedPercentage === null ? null : Math.max(0, 100 - usedPercentage),
      inputTokens: asFiniteNumber(providerUsage.inputTokens),
      cachedInputTokens: asFiniteNumber(providerUsage.cachedInputTokens),
      outputTokens: asFiniteNumber(providerUsage.outputTokens),
      reasoningOutputTokens: asFiniteNumber(providerUsage.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(providerUsage.lastUsedTokens),
      lastInputTokens: asFiniteNumber(providerUsage.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(providerUsage.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(providerUsage.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(providerUsage.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(providerUsage.toolUses),
      durationMs: asFiniteNumber(providerUsage.durationMs),
      compactsAutomatically: providerUsage.compactsAutomatically ?? null,
      cost: providerUsage.cost ?? null,
      autoCompactThreshold: providerUsage.autoCompactThreshold ?? null,
      updatedAt: DateTime.formatIso(providerUsageUpdatedAt),
    };
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index]?.item;
    if (item?.type !== "compaction" || isRetiredProviderThreadItem(item, providerThread)) {
      continue;
    }
    const snapshot = compactionSnapshot(
      item,
      null,
      DateTime.formatIso(item.startedAt ?? item.updatedAt),
    );
    if (snapshot !== null) return snapshot;
  }

  return null;
}
