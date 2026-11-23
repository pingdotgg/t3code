import {
  ANTIGRAVITY_DEFAULT_MODEL,
  resolveIdleCompaction,
  supportsIdleCompactionDriver,
  type ModelSelection,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type ServerSettings,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import {
  antigravityPromptCacheTtlMs,
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  COMPACT_COMMAND_PATTERN,
  COMPACTION_SUGGESTION_MIN_TOKENS,
  isClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import * as DateTime from "effect/DateTime";

import { resolvePendingHandoff } from "../handoff.ts";
import type { ThreadStructure, ThreadStructureTurnItem } from "./models.ts";

// Fallback TTL: Claude's 1h cache plus slack.
const CLAUDE_RESUME_COMPACTION_FALLBACK_MS = 70 * 60_000;

// A typed `/compact`, with or without instructions, is already the compaction. Queueing a
// bare one ahead of it would run an uninstructed compaction first and charge for two.
export { COMPACT_COMMAND_PATTERN };

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
  const providerUsage = providerThread?.contextUsage;
  const providerUsageUpdatedAt = providerThread?.updatedAt;
  const providerUsageUpdatedIso =
    providerUsage == null
      ? null
      : (providerUsage.updatedAt ??
        (providerUsageUpdatedAt !== undefined ? DateTime.formatIso(providerUsageUpdatedAt) : null));
  // A newer provider-thread usage report with an explicit measurement timestamp (for example,
  // a post-terminal ACP `usage_update` correction) supersedes an earlier finalized turn snapshot
  // when the token counts actually changed. Undated `providerThread.contextUsage` copies carried
  // across turn updates (such as Claude's) never override a dated turn snapshot.
  const providerUsageNewer =
    liveUsage != null &&
    providerUsage?.updatedAt !== undefined &&
    Date.parse(providerUsage.updatedAt) >= Date.parse(liveUsage.updatedAt) &&
    (providerUsage.usedTokens !== liveUsage.usedTokens ||
      (asFiniteNumber(providerUsage.maxTokens) ?? null) !== (liveUsage.maxTokens ?? null));
  const usageUpdatedAt = providerUsageNewer
    ? providerUsageUpdatedIso
    : (liveUsage?.updatedAt ?? providerUsageUpdatedIso);
  const isCompactionClearUsage =
    liveUsage != null &&
    !providerUsageNewer &&
    liveUsage.usedTokens === 0 &&
    liveUsage.maxTokens == null &&
    liveUsage.promptCacheTtlMs == null &&
    providerUsage == null;
  if (latestCompletedCompaction !== undefined) {
    const compactedAt = DateTime.formatIso(
      latestCompletedCompaction.completedAt ?? latestCompletedCompaction.updatedAt,
    );
    // Usage reported before the compaction describes the context it just discarded; usage at
    // the same instant is the provider's own post-compaction report. A synthetic 0-token clear
    // emitted on turn finalization after a mid-turn compaction also yields to the compaction item.
    if (
      usageUpdatedAt === null ||
      Date.parse(compactedAt) > Date.parse(usageUpdatedAt) ||
      isCompactionClearUsage
    ) {
      return compactionSnapshot(
        latestCompletedCompaction,
        liveUsage?.maxTokens ?? asFiniteNumber(providerThread?.contextUsage?.maxTokens),
        compactedAt,
      );
    }
  }
  if (isCompactionClearUsage) {
    return null;
  }

  if (liveUsage != null && !providerUsageNewer) {
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
      compactsAutomatically:
        providerUsage != null ? (providerUsage.compactsAutomatically ?? null) : true,
      autoCompactThreshold: liveUsage.autoCompactThreshold ?? null,
      cost: providerUsage?.cost ?? null,
      updatedAt: liveUsage.updatedAt,
    };
  }
  if (providerUsage !== null && providerUsage !== undefined && providerUsageUpdatedIso !== null) {
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
      updatedAt: providerUsageUpdatedIso,
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
  readonly model?: string | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly promptCacheTtlMs?: number | undefined;
  /** True when the turn itself reported live tokenUsage (even without a cache TTL). */
  readonly hasLiveUsage?: boolean | undefined;
  readonly now: string;
}): boolean {
  if (
    !supportsIdleCompactionDriver(input.provider) ||
    (input.usedTokens ?? 0) < COMPACTION_SUGGESTION_MIN_TOKENS
  ) {
    return false;
  }

  let ttlMs: number | undefined;
  if (input.provider === "claudeAgent") {
    ttlMs = input.promptCacheTtlMs ?? CLAUDE_RESUME_COMPACTION_FALLBACK_MS;
  } else {
    // Switching from Gemini to a non-Gemini model on the same Antigravity instance
    // must not inherit the prior Gemini turn's cache TTL.
    if (
      input.model != null &&
      input.model !== ANTIGRAVITY_DEFAULT_MODEL &&
      antigravityPromptCacheTtlMs(input.model) === undefined
    ) {
      return false;
    }
    // Fall back to the model-based TTL only for legacy threads that have no live turn usage;
    // a live non-Gemini turn intentionally omits `promptCacheTtlMs` and stays skipped even if
    // the composer switches to a Gemini model before sending.
    ttlMs =
      input.promptCacheTtlMs ??
      (input.hasLiveUsage === true ? undefined : antigravityPromptCacheTtlMs(input.model));
  }
  if (ttlMs === undefined) {
    return false;
  }

  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  return Number.isFinite(updatedAt) && Number.isFinite(now) && now - updatedAt >= ttlMs;
}

/**
 * True when a newer started run on the active provider thread has no token usage of its own,
 * so the latest recorded usage belongs to an earlier run and cannot time "When you return".
 */
export function hasInterveningRunWithoutUsage(
  runs: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadProjection["runs"][number],
      "ordinal" | "status" | "startedAt" | "rootNodeId" | "providerThreadId"
    >
  >,
  providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "nodeId" | "tokenUsage">
  >,
  providerThread: Pick<OrchestrationV2ProviderThread, "id"> | null | undefined,
  usageUpdatedAt?: string | null | undefined,
): boolean {
  if (providerThread == null) return false;
  let latestRun: (typeof runs)[number] | null = null;
  for (const run of runs) {
    if (run.status === "rolled_back" || run.startedAt === null) {
      continue;
    }
    if (run.providerThreadId !== undefined && run.providerThreadId !== providerThread.id) {
      continue;
    }
    if (latestRun === null || run.ordinal > latestRun.ordinal) {
      latestRun = run;
    }
  }
  if (latestRun === null) return false;
  let latestUsageTurn: (typeof providerTurns)[number] | null = null;
  for (const turn of providerTurns) {
    if (turn.providerThreadId !== providerThread.id || turn.tokenUsage === undefined) continue;
    if (
      latestUsageTurn === null ||
      Date.parse(turn.tokenUsage.updatedAt) >= Date.parse(latestUsageTurn.tokenUsage!.updatedAt)
    ) {
      latestUsageTurn = turn;
    }
  }
  if (
    latestUsageTurn !== null &&
    latestUsageTurn.nodeId !== undefined &&
    latestRun.rootNodeId !== undefined &&
    latestUsageTurn.nodeId !== latestRun.rootNodeId
  ) {
    return true;
  }
  if (latestRun.startedAt != null && usageUpdatedAt != null) {
    const startedMs =
      typeof latestRun.startedAt === "string"
        ? Date.parse(latestRun.startedAt)
        : DateTime.toEpochMillis(latestRun.startedAt);
    const usageMs = Date.parse(usageUpdatedAt);
    if (
      Number.isFinite(startedMs) &&
      Number.isFinite(usageMs) &&
      (latestUsageTurn === null ? startedMs >= usageMs : startedMs > usageMs)
    ) {
      return true;
    }
  }
  return false;
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
  if (
    contextWindow === null ||
    (provider.driver === "antigravity" &&
      hasInterveningRunWithoutUsage(
        projection.runs,
        projection.providerTurns,
        providerThread,
        contextWindow.updatedAt,
      ))
  ) {
    return null;
  }
  return shouldOfferResumeCompaction({
    provider: provider.driver,
    model: input.selection.model,
    usedTokens: contextWindow.usedTokens,
    updatedAt: contextWindow.updatedAt,
    promptCacheTtlMs: liveUsage?.promptCacheTtlMs,
    hasLiveUsage: liveUsage !== null,
    now: input.now,
  })
    ? contextWindow.usedTokens
    : null;
}
