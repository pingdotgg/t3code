import type { ProjectId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { Thread } from "../types";

export type ThreadSortInput = Pick<Thread, "createdAt" | "updatedAt"> & {
  latestUserMessageAt?: string | null;
  messages?: Pick<Thread["messages"][number], "createdAt" | "role">[];
};

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getLatestUserMessageTimestamp(thread: ThreadSortInput): number {
  if (thread.latestUserMessageAt) {
    return toSortableTimestamp(thread.latestUserMessageAt) ?? Number.NEGATIVE_INFINITY;
  }

  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return toSortableTimestamp(thread.updatedAt ?? thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return toSortableTimestamp(thread.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return getLatestUserMessageTimestamp(thread);
}

interface SortableThread<T> {
  readonly thread: T;
  readonly timestamp: number;
}

function compareSortableThreads<T extends Pick<Thread, "id">>(
  left: SortableThread<T>,
  right: SortableThread<T>,
): number {
  const byTimestamp =
    right.timestamp === left.timestamp ? 0 : right.timestamp > left.timestamp ? 1 : -1;
  if (byTimestamp !== 0) return byTimestamp;
  return right.thread.id.localeCompare(left.thread.id);
}

export function sortThreads<T extends Pick<Thread, "id"> & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
  limit?: number,
): T[] {
  const sortableThreads = threads.map((thread) => ({
    thread,
    timestamp: getThreadSortTimestamp(thread, sortOrder),
  }));

  if (limit === undefined || limit >= sortableThreads.length) {
    return sortableThreads.toSorted(compareSortableThreads).map(({ thread }) => thread);
  }

  const boundedLimit = Math.floor(limit);
  if (boundedLimit <= 0) {
    return [];
  }

  const sortedThreads: SortableThread<T>[] = [];
  for (const thread of sortableThreads) {
    let insertAt = 0;
    while (
      insertAt < sortedThreads.length &&
      compareSortableThreads(sortedThreads[insertAt]!, thread) <= 0
    ) {
      insertAt += 1;
    }
    if (insertAt === boundedLimit) {
      continue;
    }
    sortedThreads.splice(insertAt, 0, thread);
    if (sortedThreads.length > boundedLimit) {
      sortedThreads.pop();
    }
  }

  return sortedThreads.map(({ thread }) => thread);
}

export function getLatestThreadForProject<
  T extends Pick<Thread, "id" | "projectId" | "archivedAt"> & ThreadSortInput,
>(threads: readonly T[], projectId: ProjectId, sortOrder: SidebarThreadSortOrder): T | null {
  return (
    sortThreads(
      threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === null),
      sortOrder,
    )[0] ?? null
  );
}
