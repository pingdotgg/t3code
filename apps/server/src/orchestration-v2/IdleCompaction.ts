import type {
  OrchestrationV2ThreadProjection,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { COMPACTION_SUGGESTION_MIN_TOKENS } from "@t3tools/shared/claudeCompaction";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

// Claude Code's idleCompaction defaults to 200K and won't go below 100K. Below
// that a cold re-read is cheap, so compacting mostly loses context for little
// saving.
const MIN_CONTEXT_TOKENS = COMPACTION_SUGGESTION_MIN_TOKENS;
// Start this long before the cache expires: enough for the session to resume
// and send the compaction while the cache is still warm.
const LEAD_MS = 2 * 60_000;
// Close enough to a usage limit that the next turn may well be the one it stops.
const NEAR_USAGE_LIMIT_PERCENT = 95;

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
 * When an idle Claude thread should compact, or null when it should not. The
 * window ends when the prompt cache of Claude's last request expires (1h on
 * subscriptions, 5m on API keys); compacting after that pays a full uncached
 * read.
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
  if (thread.lineage.relationshipToParent === "subagent") return null;
  const latestRun = runs.reduce<(typeof runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  if (latestRun?.status !== "completed" || latestRun.completedAt === null) return null;
  const message = messages.find((candidate) => candidate.id === latestRun.userMessageId);
  // Never compact a compaction, so one idle spell compacts at most once.
  if (message === undefined || message.text.trim().toLowerCase() === "/compact") return null;
  if (
    runtimeRequests.some((request) => request.status === "pending") ||
    // A pending merge-back belongs to the user's next message.
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    ) ||
    // Background work reports into the next turn; compaction would swallow it.
    derivePendingBackgroundWork({
      latestRun,
      runs,
      providerThreads,
      turnItems,
      activeProviderThreadId: thread.activeProviderThreadId,
    }).length > 0
  )
    return null;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  // The thread's current selection receives the /compact, so it must still be this Claude session.
  if (
    providerThread?.driver !== "claudeAgent" ||
    providerThread.id !== latestRun.providerThreadId ||
    providerThread.providerInstanceId !== thread.providerInstanceId ||
    latestRun.providerInstanceId !== thread.providerInstanceId
  )
    return null;
  const usages = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  if ((usages[0]?.usedTokens ?? 0) < MIN_CONTEXT_TOKENS) return null;
  // A request served fully from cache creates no cache entry and reports no
  // TTL, but it still refreshes the cache. Treat it as unknown and skip.
  const expiresAt = usages[0]?.promptCacheExpiresAt;
  const endMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (!Number.isFinite(endMs) || nowMs >= endMs) return null;
  return { runId: latestRun.id, startMs: endMs - LEAD_MS, endMs };
}

/**
 * Whether a usage window is nearly spent and resets after `cacheExpiresMs`: a
 * stop on that limit would resume against an expired cache.
 */
export function usageLimitOutlastsCache(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  cacheExpiresMs: number,
): boolean {
  return windows.some(
    (window) =>
      window.usedPercent >= NEAR_USAGE_LIMIT_PERCENT &&
      window.resetsAt !== undefined &&
      Date.parse(window.resetsAt) > cacheExpiresMs,
  );
}
