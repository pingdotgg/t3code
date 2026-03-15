import type { ThreadId } from "@t3tools/contracts";

import type { Thread } from "../types";

export type OptimisticUserSendAtByThreadId = Partial<Record<ThreadId, string>>;

export function getLatestUserMessageAt(thread: Thread): string | null {
  let latestUserMessageAt: string | null = null;
  for (const message of thread.messages) {
    if (message.role !== "user") continue;
    if (latestUserMessageAt === null || message.createdAt.localeCompare(latestUserMessageAt) > 0) {
      latestUserMessageAt = message.createdAt;
    }
  }
  return latestUserMessageAt;
}

export function getThreadSidebarRecency(thread: Thread, optimisticAt?: string | null): string {
  const confirmedRecency = getLatestUserMessageAt(thread) ?? thread.createdAt;
  if (optimisticAt == null) {
    return confirmedRecency;
  }
  return optimisticAt.localeCompare(confirmedRecency) > 0 ? optimisticAt : confirmedRecency;
}

export function compareThreadsForSidebar(
  left: Thread,
  right: Thread,
  optimisticUserSendAtByThreadId: OptimisticUserSendAtByThreadId,
): number {
  const byRecency = getThreadSidebarRecency(
    right,
    optimisticUserSendAtByThreadId[right.id],
  ).localeCompare(getThreadSidebarRecency(left, optimisticUserSendAtByThreadId[left.id]));
  if (byRecency !== 0) return byRecency;

  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;

  return right.id.localeCompare(left.id);
}
