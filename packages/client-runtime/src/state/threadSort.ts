import type { ProjectId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ThreadSortInput {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestUserMessageAt?: string | null;
  readonly messages?: ReadonlyArray<{
    readonly createdAt: string;
    readonly role: string;
  }>;
}

export type ThreadListV2Priority = "woke" | "unsettled" | "default";

const THREAD_LIST_V2_PRIORITY_RANK: Record<ThreadListV2Priority, number> = {
  woke: 0,
  unsettled: 1,
  default: 2,
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
    const latestUserMessageTimestamp = toSortableTimestamp(thread.latestUserMessageAt);
    if (latestUserMessageTimestamp !== null) {
      return latestUserMessageTimestamp;
    }
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

/** Priority from server-backed state only so web and mobile derive the same
    order. A manual un-settle supersedes an older retained wake marker. */
export function threadListV2Priority(
  thread: { readonly settledOverride: "settled" | "active" | null },
  options: { readonly wokeAt: string | null },
): ThreadListV2Priority {
  if (thread.settledOverride === "active") return "unsettled";
  if (options.wokeAt !== null) return "woke";
  return "default";
}

/** Attention transitions first, then static creation order within a group. */
export function sortThreadsForListV2<T extends { readonly id: string; readonly createdAt: string }>(
  threads: readonly T[],
  getPriority: (thread: T) => ThreadListV2Priority = () => "default",
): T[] {
  // Hermes does not ship the ES2023 change-by-copy array methods.
  return [...threads].sort(
    (left, right) =>
      THREAD_LIST_V2_PRIORITY_RANK[getPriority(left)] -
        THREAD_LIST_V2_PRIORITY_RANK[getPriority(right)] ||
      (toSortableTimestamp(right.createdAt) ?? 0) - (toSortableTimestamp(left.createdAt) ?? 0) ||
      left.id.localeCompare(right.id),
  );
}

export interface SettledSortInput {
  readonly settledAt: string | null;
  readonly latestUserMessageAt: string | null;
  readonly latestTurn: {
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly updatedAt: string;
}

/** Timestamp shared by settled-row ordering and labels. */
export function resolveSettledTimestamp(thread: SettledSortInput): string | null {
  if (thread.settledAt !== null && toSortableTimestamp(thread.settledAt) !== null) {
    return thread.settledAt;
  }
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    if (candidate == null) continue;
    const parsed = toSortableTimestamp(candidate);
    if (parsed !== null && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  if (latest !== null) return latest;
  return toSortableTimestamp(thread.updatedAt) !== null ? thread.updatedAt : null;
}

export function sortSettledThreadsForListV2<T extends SettledSortInput & { readonly id: string }>(
  threads: readonly T[],
): T[] {
  const timestampMs = (thread: T) => {
    const timestamp = resolveSettledTimestamp(thread);
    return timestamp === null ? 0 : (toSortableTimestamp(timestamp) ?? 0);
  };
  return [...threads].sort(
    (left, right) => timestampMs(right) - timestampMs(left) || left.id.localeCompare(right.id),
  );
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

export function sortThreads<T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[] {
  return Arr.sort(
    threads,
    Order.mapInput(
      Order.Struct({
        timestamp: Order.flip(Order.Number),
        id: Order.flip(Order.String),
      }),
      (thread: T) => ({
        timestamp: getThreadSortTimestamp(thread, sortOrder),
        id: thread.id,
      }),
    ),
  );
}

export function getLatestThreadForProject<
  T extends {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly archivedAt: string | null;
  } & ThreadSortInput,
>(threads: readonly T[], projectId: ProjectId, sortOrder: SidebarThreadSortOrder): T | null {
  return (
    sortThreads(
      threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === null),
      sortOrder,
    )[0] ?? null
  );
}
