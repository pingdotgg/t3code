import type { ThreadCleanupInactiveDays } from "@forma/contracts/settings";
import type { SidebarThreadSummary } from "../types";

export type ThreadCleanupThread = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "createdAt"
  | "id"
  | "latestUserMessageAt"
  | "queuedTurnCount"
  | "session"
  | "updatedAt"
>;

export interface ThreadCleanupBuckets<TThread extends ThreadCleanupThread = ThreadCleanupThread> {
  eligible: TThread[];
  skippedQueued: TThread[];
  skippedRunning: TThread[];
}

export function formatThreadCleanupWindowLabel(inactiveDays: ThreadCleanupInactiveDays): string {
  return `${inactiveDays} day${inactiveDays === 1 ? "" : "s"}`;
}

export function resolveThreadCleanupActivityAt(thread: ThreadCleanupThread): string {
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
}

export function resolveThreadCleanupActivityTimestamp(thread: ThreadCleanupThread): number {
  const timestamp = Date.parse(resolveThreadCleanupActivityAt(thread));
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function isThreadStaleForCleanup(input: {
  thread: ThreadCleanupThread;
  inactiveDays: ThreadCleanupInactiveDays;
  now?: number | Date;
}): boolean {
  const nowMs =
    input.now instanceof Date ? input.now.getTime() : (input.now ?? globalThis.Date.now());
  const cutoffMs = nowMs - input.inactiveDays * 24 * 60 * 60 * 1000;
  return resolveThreadCleanupActivityTimestamp(input.thread) < cutoffMs;
}

function sortThreadsOldestFirst<TThread extends ThreadCleanupThread>(
  threads: readonly TThread[],
): TThread[] {
  return threads.toSorted((left, right) => {
    const byActivity =
      resolveThreadCleanupActivityTimestamp(left) - resolveThreadCleanupActivityTimestamp(right);
    if (byActivity !== 0) {
      return byActivity;
    }
    return left.id.localeCompare(right.id);
  });
}

export function bucketThreadsForCleanup<TThread extends ThreadCleanupThread>(input: {
  threads: readonly TThread[];
  inactiveDays: ThreadCleanupInactiveDays;
  now?: number | Date;
}): ThreadCleanupBuckets<TThread> {
  const eligible: TThread[] = [];
  const skippedQueued: TThread[] = [];
  const skippedRunning: TThread[] = [];

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    if (
      !isThreadStaleForCleanup(
        input.now === undefined
          ? { thread, inactiveDays: input.inactiveDays }
          : { thread, inactiveDays: input.inactiveDays, now: input.now },
      )
    ) {
      continue;
    }
    if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
      skippedRunning.push(thread);
      continue;
    }
    if (thread.queuedTurnCount > 0) {
      skippedQueued.push(thread);
      continue;
    }
    eligible.push(thread);
  }

  return {
    eligible: sortThreadsOldestFirst(eligible),
    skippedQueued: sortThreadsOldestFirst(skippedQueued),
    skippedRunning: sortThreadsOldestFirst(skippedRunning),
  };
}
