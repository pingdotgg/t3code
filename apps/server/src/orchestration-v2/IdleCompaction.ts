import {
  ANTIGRAVITY_DEFAULT_MODEL,
  isListedThreadLineage,
  supportsIdleCompactionDriver,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  antigravityPromptCacheTtlMs,
  COMPACT_COMMAND_PATTERN,
  COMPACTION_SUGGESTION_MIN_TOKENS,
} from "@t3tools/shared/claudeCompaction";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

// Claude Code's idleCompaction defaults to 200K and won't go below 100K. Below
// that a cold re-read is cheap, so compacting mostly loses context for little
// saving.
const MIN_CONTEXT_TOKENS = COMPACTION_SUGGESTION_MIN_TOKENS;
// Start this long before the cache expires: enough for the session to resume
// and send the compaction while the cache is still warm.
const LEAD_MS = 2 * 60_000;

export type IdleCompactionRecords = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "messages"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "turnItems"
  | "contextTransfers"
>;

/**
 * When an idle thread should compact, or null when it should not. The window
 * ends when the prompt cache of the last request expires (1h on Claude
 * subscriptions, 5m on Claude API keys, 15m on Antigravity Gemini models);
 * compacting after that pays a full uncached read.
 */
export function idleCompactionWindow(
  {
    thread,
    runs,
    messages,
    providerThreads,
    providerTurns,
    runtimeRequests,
    turnItems,
    contextTransfers,
  }: IdleCompactionRecords,
  nowMs: number,
): {
  readonly runId: (typeof runs)[number]["id"];
  readonly startMs: number;
  readonly endMs: number;
} | null {
  if (thread.deletedAt !== null || thread.archivedAt !== null) return null;
  if (thread.settledAt !== null || thread.settledOverride === "settled") return null;
  if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
    return null;
  if (!isListedThreadLineage(thread.lineage)) return null;
  // A removed or steered queued message leaves a cancelled run that never started.
  const latestRun = runs
    .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
    .reduce<(typeof runs)[number] | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );
  if (latestRun?.status !== "completed" || latestRun.completedAt === null) return null;
  const message = messages.find((candidate) => candidate.id === latestRun.userMessageId);
  // Never compact a compaction, so one idle spell compacts at most once.
  if (message === undefined || COMPACT_COMMAND_PATTERN.test(message.text.trim())) return null;
  if (
    runtimeRequests.some((request) => request.status === "pending") ||
    // A pending merge-back belongs to the user's next message.
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    ) ||
    // Background work reports into the next turn; compaction would swallow it. A delegated
    // child's result arrives later as its own message, so it does not count.
    derivePendingBackgroundWork({
      latestRun,
      runs,
      providerThreads,
      turnItems: turnItems.filter(
        (item) => item.type !== "subagent" || item.origin !== "app_owned",
      ),
      activeProviderThreadId: thread.activeProviderThreadId,
    }).length > 0
  )
    return null;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  // The thread's current selection receives the /compact, so it must still be this session.
  // On Antigravity, switching models on the same instance (for example Gemini -> Claude)
  // invalidates the cached model assumption, so require the same model selection as well.
  if (
    !supportsIdleCompactionDriver(providerThread?.driver) ||
    providerThread?.id !== latestRun.providerThreadId ||
    providerThread.providerInstanceId !== thread.providerInstanceId ||
    latestRun.providerInstanceId !== thread.providerInstanceId ||
    (providerThread.driver === "antigravity" &&
      (thread.modelSelection.model !== latestRun.modelSelection.model ||
        (thread.modelSelection.model !== ANTIGRAVITY_DEFAULT_MODEL &&
          antigravityPromptCacheTtlMs(thread.modelSelection.model) === undefined)))
  )
    return null;
  const latestUsageTurn = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .toSorted(
      (left, right) =>
        Date.parse(right.tokenUsage!.updatedAt) - Date.parse(left.tokenUsage!.updatedAt),
    )[0];
  const latestUsage = latestUsageTurn?.tokenUsage;
  if (
    latestUsageTurn === undefined ||
    latestUsage === undefined ||
    (providerThread.driver === "antigravity" && latestUsageTurn.nodeId !== latestRun.rootNodeId)
  )
    return null;
  let effectiveUsedTokens = latestUsage.usedTokens;
  const providerUsage = providerThread.contextUsage;
  if (providerUsage?.updatedAt !== undefined) {
    const providerUsageUpdatedMs = Date.parse(providerUsage.updatedAt);
    const latestUsageUpdatedMs = Date.parse(latestUsage.updatedAt);
    if (
      Number.isFinite(providerUsageUpdatedMs) &&
      Number.isFinite(latestUsageUpdatedMs) &&
      providerUsageUpdatedMs >= latestUsageUpdatedMs &&
      providerUsage.usedTokens !== latestUsage.usedTokens
    ) {
      effectiveUsedTokens = providerUsage.usedTokens;
    }
  }
  if (effectiveUsedTokens < MIN_CONTEXT_TOKENS) return null;
  // A request served fully from cache creates no cache entry and reports no
  // TTL, but it still refreshes the cache. Treat it as unknown and skip.
  const expiresAt = latestUsage.promptCacheExpiresAt;
  const endMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (!Number.isFinite(endMs) || nowMs >= endMs) return null;
  return { runId: latestRun.id, startMs: endMs - LEAD_MS, endMs };
}
