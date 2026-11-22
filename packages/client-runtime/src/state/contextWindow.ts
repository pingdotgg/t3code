import {
  resolveIdleCompaction,
  type ModelSelection,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2ProviderThread,
  type ServerProvider,
  type ServerSettings,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  COMPACTION_SUGGESTION_MIN_TOKENS,
  isClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import * as DateTime from "effect/DateTime";

import { resolvePendingHandoff } from "../handoff.ts";
import type { ThreadStructure, ThreadStructureTurnItem } from "./models.ts";

// Fallback TTL: Claude's 1h cache plus slack.
const CLAUDE_RESUME_COMPACTION_FALLBACK_MS = 70 * 60_000;

/** Absolute context size above which even 1M-window threads warn before pricey cache misses. */
export const CONTEXT_USAGE_WARNING_TOKENS = 150_000;

export type ContextUsageTone = "error" | "warning" | null;

export interface ThreadCacheMetrics {
  /** Cumulative prompt-cache hit ratio (0..1) across observed turns on the active provider thread. */
  readonly threadHitRate: number;
  /** Prompt-cache hit ratio (0..1) on the latest observed turn. */
  readonly lastTurnHitRate: number;
  readonly totalInputTokens: number;
  readonly cachedInputTokens: number;
  readonly uncachedInputTokens: number;
  readonly lastTurnInputTokens: number;
  readonly lastTurnCachedInputTokens: number;
  readonly turnCount: number;
}

export function deriveContextUsageTone(input: {
  readonly usedTokens: number;
  readonly usedPercentage: number | null;
}): ContextUsageTone {
  if (input.usedPercentage !== null && input.usedPercentage >= 90) return "error";
  if (
    (input.usedPercentage !== null && input.usedPercentage >= 80) ||
    input.usedTokens >= CONTEXT_USAGE_WARNING_TOKENS
  ) {
    return "warning";
  }
  return null;
}

function clampCachedTokens(cached: number, input: number): number {
  if (!Number.isFinite(cached) || cached <= 0) return 0;
  return Math.min(cached, input);
}

/**
 * Derives cumulative and last-turn prompt cache hit metrics for the active provider thread from
 * completed turn token usage (falling back to live/thread snapshots when per-turn counters lack
 * cache fields). Returns null when the provider has not reported cache telemetry.
 */
export function deriveThreadCacheMetrics(
  turns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "ordinal" | "turnTokenUsage">
  >,
  providerThread?: Pick<OrchestrationV2ProviderThread, "id" | "contextUsage"> | null,
  liveUsage?: Pick<
    OrchestrationV2ProviderTurnTokenUsage,
    "inputTokens" | "cachedInputTokens"
  > | null,
): ThreadCacheMetrics | null {
  const eligible = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => {
      if (providerThread != null && turn.providerThreadId !== providerThread.id) return false;
      const usage = turn.turnTokenUsage;
      return (
        usage !== undefined &&
        usage.localCommand !== true &&
        typeof usage.inputTokens === "number" &&
        Number.isFinite(usage.inputTokens) &&
        usage.inputTokens > 0
      );
    })
    .sort((left, right) => left.turn.ordinal - right.turn.ordinal || left.index - right.index);

  const cacheEligible = eligible.filter(({ turn }) => {
    const cached = turn.turnTokenUsage?.cachedInputTokens;
    return typeof cached === "number" && Number.isFinite(cached);
  });

  if (cacheEligible.length > 0) {
    let totalInputTokens = 0;
    let cachedInputTokens = 0;
    let lastTurnInputTokens = 0;
    let lastTurnCachedInputTokens = 0;

    for (const { turn } of cacheEligible) {
      const usage = turn.turnTokenUsage!;
      const inputTokens = usage.inputTokens!;
      const cached = clampCachedTokens(usage.cachedInputTokens!, inputTokens);
      totalInputTokens += inputTokens;
      cachedInputTokens += cached;
      lastTurnInputTokens = inputTokens;
      lastTurnCachedInputTokens = cached;
    }

    if (totalInputTokens > 0 && lastTurnInputTokens > 0) {
      return {
        threadHitRate: cachedInputTokens / totalInputTokens,
        lastTurnHitRate: lastTurnCachedInputTokens / lastTurnInputTokens,
        totalInputTokens,
        cachedInputTokens,
        uncachedInputTokens: Math.max(0, totalInputTokens - cachedInputTokens),
        lastTurnInputTokens,
        lastTurnCachedInputTokens,
        turnCount: cacheEligible.length,
      };
    }
  }

  const livePair =
    typeof liveUsage?.inputTokens === "number" &&
    Number.isFinite(liveUsage.inputTokens) &&
    liveUsage.inputTokens > 0 &&
    typeof liveUsage.cachedInputTokens === "number" &&
    Number.isFinite(liveUsage.cachedInputTokens)
      ? { inputTokens: liveUsage.inputTokens, cachedInputTokens: liveUsage.cachedInputTokens }
      : null;
  const snapshotPair =
    typeof providerThread?.contextUsage?.inputTokens === "number" &&
    Number.isFinite(providerThread.contextUsage.inputTokens) &&
    providerThread.contextUsage.inputTokens > 0 &&
    typeof providerThread.contextUsage.cachedInputTokens === "number" &&
    Number.isFinite(providerThread.contextUsage.cachedInputTokens)
      ? {
          inputTokens: providerThread.contextUsage.inputTokens,
          cachedInputTokens: providerThread.contextUsage.cachedInputTokens,
        }
      : null;
  const fallbackPair = livePair ?? snapshotPair;
  if (fallbackPair !== null) {
    const cached = clampCachedTokens(fallbackPair.cachedInputTokens, fallbackPair.inputTokens);
    const lastInput = livePair === null ? providerThread?.contextUsage?.lastInputTokens : undefined;
    const lastCached =
      livePair === null ? providerThread?.contextUsage?.lastCachedInputTokens : undefined;
    const hasLast =
      typeof lastInput === "number" &&
      Number.isFinite(lastInput) &&
      lastInput > 0 &&
      typeof lastCached === "number" &&
      Number.isFinite(lastCached);
    const lastTurnInputTokens = hasLast ? lastInput : fallbackPair.inputTokens;
    const lastTurnCachedInputTokens = hasLast ? clampCachedTokens(lastCached, lastInput) : cached;
    return {
      threadHitRate: cached / fallbackPair.inputTokens,
      lastTurnHitRate: lastTurnCachedInputTokens / lastTurnInputTokens,
      totalInputTokens: fallbackPair.inputTokens,
      cachedInputTokens: cached,
      uncachedInputTokens: Math.max(0, fallbackPair.inputTokens - cached),
      lastTurnInputTokens,
      lastTurnCachedInputTokens,
      turnCount: 1,
    };
  }

  return null;
}

// A typed `/compact`, with or without instructions, is already the compaction. Queueing a
// bare one ahead of it would run an uninstructed compaction first and charge for two.
export const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s|$)/i;

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

export function hasDismissedResumeCompaction(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): boolean {
  return activities.some((activity) => {
    if (activity.kind !== "user-input.resolved") return false;
    const payload = activity.payload;
    if (!payload || typeof payload !== "object") return false;
    const answers = (payload as { readonly answers?: unknown }).answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;

    return Object.entries(answers).some(
      ([question, answer]) =>
        isClaudeResumeCompactionQuestion(question) &&
        answer === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
    );
  });
}

export function shouldOfferResumeCompaction(input: {
  readonly provider: string | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly promptCacheTtlMs?: number | undefined;
  readonly now: string;
}): boolean {
  if (
    input.provider !== "claudeAgent" ||
    (input.usedTokens ?? 0) < COMPACTION_SUGGESTION_MIN_TOKENS
  ) {
    return false;
  }

  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  return (
    Number.isFinite(updatedAt) &&
    Number.isFinite(now) &&
    now - updatedAt >= (input.promptCacheTtlMs ?? CLAUDE_RESUME_COMPACTION_FALLBACK_MS)
  );
}

/**
 * The tokens a plain send into an idle thread compacts first, as web's composer does under
 * "When you return", or null when it sends as is. Web reads the same state for its "Compact and
 * send" button. A send that hands off to another conversation starts that one fresh, so only the
 * resumed one counts.
 */
export function compactBeforeSendTokens(input: {
  readonly projection: Pick<
    ThreadStructure,
    | "thread"
    | "contextTransfers"
    | "providerThreads"
    | "providerTurns"
    | "runtimeRequests"
    | "runs"
    | "visibleTurnItems"
  >;
  readonly visibleTurnItems: ReadonlyArray<{ readonly item: ThreadStructureTurnItem }>;
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<
    ServerSettings,
    "providerInstances" | "compactIdleThreads" | "idleCompaction"
  >;
  readonly text: string;
  readonly threadIdle: boolean;
  readonly now: string;
}): number | null {
  const { projection } = input;
  const provider = input.providers.find((entry) => entry.instanceId === input.selection.instanceId);
  if (
    provider === undefined ||
    !input.threadIdle ||
    COMPACT_COMMAND_PATTERN.test(input.text) ||
    resolveIdleCompaction(input.settings, provider.instanceId) === "off" ||
    !provider.slashCommands.some((command) => command.name === "compact") ||
    resolvePendingHandoff(projection, input.selection, input.providers) !== null ||
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    projection.runs.some((run) => run.status === "queued" && run.queueHeld === true) ||
    (!input.visibleTurnItems.some(
      ({ item }) =>
        item.type === "user_message" &&
        (item.text.trim().toLowerCase() !== "/compact" || item.attachments.length > 0),
    ) &&
      !projection.runs.some(
        (run) =>
          run.status !== "rolled_back" &&
          run.startedAt !== null &&
          !input.visibleTurnItems.some(
            ({ item }) => item.type === "user_message" && item.runId === run.id,
          ),
      )) ||
    hasDismissedResumeCompaction(
      projection.runtimeRequests
        .filter((request) => request.kind === "user_input" && request.status === "resolved")
        .map((request) => ({ kind: "user-input.resolved", payload: { answers: request.answers } })),
    )
  ) {
    return null;
  }
  const activeProviderThreadId = projection.thread.activeProviderThreadId;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === activeProviderThreadId,
  );
  const liveUsage = latestProviderTurnTokenUsage(
    projection.providerTurns.filter((turn) => turn.providerThreadId === activeProviderThreadId),
    input.selection.instanceId === projection.thread.modelSelection.instanceId ? projection : null,
    providerThread,
  );
  const contextWindow = deriveLatestContextWindowSnapshot(
    input.visibleTurnItems,
    liveUsage,
    providerThread,
  );
  return contextWindow !== null &&
    shouldOfferResumeCompaction({
      provider: provider.driver,
      usedTokens: contextWindow.usedTokens,
      updatedAt: contextWindow.updatedAt,
      promptCacheTtlMs: liveUsage?.promptCacheTtlMs,
      now: input.now,
    })
    ? contextWindow.usedTokens
    : null;
}
