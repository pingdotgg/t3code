import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, OrchestrationLatestTurn, ThreadId } from "@t3tools/contracts";

export interface ThreadCompletionStatusInput {
  latestTurn: Pick<OrchestrationLatestTurn, "completedAt"> | null;
  lastVisitedAt?: string | null | undefined;
}

export interface ScopedThreadCompletionInput extends ThreadCompletionStatusInput {
  environmentId: EnvironmentId;
  id: ThreadId;
  archivedAt?: string | null | undefined;
}

export function hasUnseenCompletion(thread: ThreadCompletionStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function countUnseenCompletedThreads(
  threads: readonly ScopedThreadCompletionInput[],
  threadLastVisitedAtById: Readonly<Record<string, string | undefined>>,
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null && thread.archivedAt !== undefined) {
      continue;
    }
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (
      hasUnseenCompletion({
        latestTurn: thread.latestTurn,
        lastVisitedAt: threadLastVisitedAtById[threadKey],
      })
    ) {
      count += 1;
    }
  }
  return count;
}
