import { isListedThreadLineage, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  CLAUDE_RESUME_COMPACTION_FALLBACK_MS,
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

/** The latest run that started; a removed or steered queued message leaves a cancelled run that never did. */
export function latestIdleCompactionRun<R extends IdleCompactionRecords["runs"][number]>(
  runs: ReadonlyArray<R>,
): R | null {
  return runs
    .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
    .reduce<R | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );
}

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
  if (!isListedThreadLineage(thread.lineage)) return null;
  const latestRun = latestIdleCompactionRun(runs);
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

// A typed `/compact`, with or without instructions, compacts the conversation.
const COMPACT_COMMAND = /^\/compact(?:\s|$)/i;

/**
 * Whether a compaction a client sent on return is no longer needed. The client decides from its
 * own copy of the thread, which can trail the server while it syncs: the last run may already
 * have compacted, or the cache the copy shows as expired was refreshed since and is still warm.
 * `turnItems` needs the latest run's completed compaction items.
 */
export function returnCompactionIsMoot(
  {
    thread,
    runs,
    messages,
    providerTurns,
    turnItems,
  }: Pick<IdleCompactionRecords, "thread" | "runs" | "messages" | "providerTurns" | "turnItems">,
  nowMs: number,
): boolean {
  const latestRun = latestIdleCompactionRun(runs);
  const message = messages.find((candidate) => candidate.id === latestRun?.userMessageId);
  // Only a compaction that finished counts; a failed or stopped one left the context as it was.
  if (
    message !== undefined &&
    COMPACT_COMMAND.test(message.text.trim()) &&
    turnItems.some(
      (item) =>
        item.runId === latestRun?.id && item.type === "compaction" && item.status === "completed",
    )
  )
    return true;
  const usage = providerTurns
    .filter(
      (turn) =>
        turn.providerThreadId === thread.activeProviderThreadId && turn.tokenUsage !== undefined,
    )
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  if (usage === undefined) return false;
  // A request served fully from cache reports no expiry, so the TTL from its time stands in, as
  // the client reads it.
  const reportedExpiry = Date.parse(usage.promptCacheExpiresAt ?? "");
  const expiresAt = Number.isFinite(reportedExpiry)
    ? reportedExpiry
    : Date.parse(usage.updatedAt) +
      (usage.promptCacheTtlMs ?? CLAUDE_RESUME_COMPACTION_FALLBACK_MS);
  return Number.isFinite(expiresAt) && nowMs < expiresAt;
}
