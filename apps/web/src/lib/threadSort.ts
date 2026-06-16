import type { ProjectId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import type { Thread } from "../types";

/**
 * Reorders `items` to match `preferredIds` first, then appends any items not
 * listed in `preferredIds` in their original order. Duplicates and unknown ids
 * are ignored. Generic so it can order projects, threads, or anything keyed.
 */
export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
}): TItem[] {
  const { getId, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const itemsById = new Map(items.map((item) => [getId(item), item] as const));
  const preferredIdSet = new Set(preferredIds);
  const emittedPreferredIds = new Set<TId>();
  const ordered = preferredIds.flatMap((id) => {
    if (emittedPreferredIds.has(id)) {
      return [];
    }
    const item = itemsById.get(id);
    if (!item) {
      return [];
    }
    emittedPreferredIds.add(id);
    return [item];
  });
  const remaining = items.filter((item) => !preferredIdSet.has(getId(item)));
  return [...ordered, ...remaining];
}

export type ThreadSortInput = Pick<Thread, "createdAt" | "updatedAt"> & {
  latestUserMessageAt?: string | null;
  messages?: Pick<Thread["messages"][number], "createdAt" | "role">[];
};

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getFirstSortableTimestamp(...values: Array<string | null | undefined>): number | null {
  for (const value of values) {
    const timestamp = toSortableTimestamp(value ?? undefined);
    if (timestamp !== null) {
      return timestamp;
    }
  }

  return null;
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

  return getFirstSortableTimestamp(thread.updatedAt, thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return (
      getFirstSortableTimestamp(thread.createdAt, thread.updatedAt) ?? Number.NEGATIVE_INFINITY
    );
  }
  return getLatestUserMessageTimestamp(thread);
}

export function sortThreads<T extends Pick<Thread, "id"> & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[] {
  // Manual sort preserves the incoming order; the caller layers the
  // user-defined order on top via `orderItemsByPreferredIds`.
  if (sortOrder === "manual") {
    return [...threads];
  }
  return threads.toSorted((left, right) => {
    const rightTimestamp = getThreadSortTimestamp(right, sortOrder);
    const leftTimestamp = getThreadSortTimestamp(left, sortOrder);
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return right.id.localeCompare(left.id);
  });
}

export function getLatestThreadForProject<
  T extends Pick<Thread, "id" | "projectId" | "archivedAt" | "environmentId"> & ThreadSortInput,
>(
  threads: readonly T[],
  projectId: ProjectId,
  sortOrder: SidebarThreadSortOrder,
  // Manual order (scoped thread keys) so "latest" matches the sidebar's
  // user-defined order rather than raw store order under manual sort.
  manualThreadOrder: readonly string[] = [],
): T | null {
  const sorted = sortThreads(
    threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === null),
    sortOrder,
  );
  const ordered =
    sortOrder === "manual" && manualThreadOrder.length > 0
      ? orderItemsByPreferredIds({
          items: sorted,
          preferredIds: manualThreadOrder,
          getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        })
      : sorted;
  return ordered[0] ?? null;
}
