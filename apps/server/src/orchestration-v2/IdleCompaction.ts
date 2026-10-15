import type { OrchestrationV2ThreadProjection, ProviderDriverKind } from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

const MINUTE_MS = 60 * 1_000;

// How long each provider keeps a prompt cache warm through T3's runtime, from
// provider docs as of 2026-10. Claude subscriptions get 1h (API keys get 5m,
// whose cache has already expired by then). Modern OpenAI models keep about
// 30m; providers without a documented TTL use the same conservative 30m.
// Only drivers whose adapters expose compactThread are listed. ACP Registry
// flavors do not advertise supportsCompaction and must not receive /compact.
export const PROMPT_CACHE_TTL_MS: Readonly<Record<string, number>> = {
  claudeAgent: 60 * MINUTE_MS,
  codex: 30 * MINUTE_MS,
  cursor: 30 * MINUTE_MS,
  opencode: 30 * MINUTE_MS,
  muse: 30 * MINUTE_MS,
  pi: 30 * MINUTE_MS,
  grok: 30 * MINUTE_MS,
  antigravity: 30 * MINUTE_MS,
};
const DEFAULT_PROMPT_CACHE_TTL_MS = 30 * MINUTE_MS;
export const MAX_PROMPT_CACHE_TTL_MS = Math.max(...Object.values(PROMPT_CACHE_TTL_MS));

// Summarizing small contexts can cost more than re-reading them. Require the
// same measured occupancy shown by the context meter, at least 20k tokens.
export const MIN_IDLE_COMPACTION_CONTEXT_TOKENS = 20_000;

/**
 * The window, in epoch ms, when an idle thread should compact: the last 10% of
 * its provider's cache TTL. Past `endMs` the cache is cold, so compacting would
 * pay a full uncached read for a thread that may never be reopened.
 */
export function idleCompactionWindow(
  completedAt: DateTime.Utc,
  driver: ProviderDriverKind,
  delayOverrideMs?: number,
): { readonly startMs: number; readonly endMs: number } {
  const completedMs = DateTime.toEpochMillis(completedAt);
  const ttl = PROMPT_CACHE_TTL_MS[driver] ?? DEFAULT_PROMPT_CACHE_TTL_MS;
  const margin = Math.round(ttl / 10);
  const delay = delayOverrideMs ?? ttl - margin;
  return { startMs: completedMs + delay, endMs: completedMs + delay + margin };
}

/** Rechecked inside serialized message dispatch, so a stale sweep cannot wake work. */
export function idleCompactionCandidate(
  projection: OrchestrationV2ThreadProjection,
  enabled: boolean,
  nowMs: number,
) {
  const { thread, runs, messages, providerThreads, providerTurns, runtimeRequests, turnItems } =
    projection;
  if (!enabled || thread.deletedAt !== null || thread.archivedAt !== null) return null;
  if (thread.lineage.relationshipToParent === "subagent") return null;
  // A pending merge-back belongs to the user's next message; compaction would
  // consume it and bind the merged context to the current provider thread.
  if (
    projection.contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    )
  )
    return null;
  if (thread.settledOverride === "settled" || thread.settledAt !== null) return null;
  if (runtimeRequests.some((request) => request.status === "pending")) return null;
  if (
    runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    )
  ) {
    return null;
  }
  const latestRun = runs.reduce<(typeof runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  if (latestRun?.status !== "completed" || latestRun.completedAt === null) return null;
  if (latestRun.idleCompactionOfRunId !== undefined) return null;
  const message = messages.find((candidate) => candidate.id === latestRun.userMessageId);
  if (message === undefined || message.text.trim().toLowerCase() === "/compact") return null;
  // A snooze that already woke on normal completion may compact, but a parked
  // snooze must retain its wake time and never be resumed by maintenance.
  if (
    thread.snoozedUntil != null &&
    DateTime.toEpochMillis(thread.snoozedUntil) > nowMs &&
    (thread.snoozedAt == null || DateTime.Order(latestRun.completedAt, thread.snoozedAt) <= 0)
  )
    return null;
  // Any pending background work (even a dev server that does not hold
  // completion) can report into the next turn; a hidden compaction would
  // swallow that report, notably when Claude resumes a released process.
  if (
    derivePendingBackgroundWork({
      latestRun,
      runs,
      providerThreads,
      turnItems,
      activeProviderThreadId: thread.activeProviderThreadId,
      pullRequests: thread.pullRequests,
    }).length > 0 ||
    // Persistent monitors are left out of pending background work but still report.
    turnItems.some(
      (item) =>
        (item.type === "command_execution" ||
          item.type === "dynamic_tool" ||
          item.type === "subagent") &&
        (item.status === "pending" || item.status === "running" || item.status === "waiting"),
    )
  )
    return null;
  // Include unadopted messages, even if a queued run has not been persisted yet.
  if (
    messages.some(
      (candidate) =>
        candidate.role === "user" &&
        DateTime.Order(candidate.updatedAt, latestRun.completedAt!) > 0,
    )
  )
    return null;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  if (
    providerThread === undefined ||
    providerThread.id !== latestRun.providerThreadId ||
    providerThread.providerInstanceId !== thread.providerInstanceId ||
    latestRun.providerInstanceId !== thread.providerInstanceId ||
    !Object.hasOwn(PROMPT_CACHE_TTL_MS, providerThread.driver)
  )
    return null;
  const usage = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  const usedTokens = usage?.usedTokens ?? providerThread.contextUsage?.usedTokens;
  if (
    usedTokens === undefined ||
    !Number.isFinite(usedTokens) ||
    usedTokens < MIN_IDLE_COMPACTION_CONTEXT_TOKENS
  )
    return null;
  return {
    threadId: thread.id,
    runId: latestRun.id,
    completedAt: latestRun.completedAt,
    driver: providerThread.driver,
  };
}
