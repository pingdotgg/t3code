import type { ProjectId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { EnvironmentThreadShell } from "./models.ts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { planPinnedReorder, toSortableTimestamp } from "@t3tools/shared/threadOrderKeys";

// The ordering rules live in shared so the server computes the same keys; re-exported
// here so client callers keep their import path.
export {
  activeThreadAnchorTimestampMs,
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
  planPinnedReorder,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  toSortableTimestamp,
} from "@t3tools/shared/threadOrderKeys";

export interface ThreadSortInput {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestUserMessageAt?: string | null;
  readonly messages?: ReadonlyArray<{
    readonly createdAt: string;
    readonly role: string;
  }>;
}

export type SettledThreadTimestampInput = Pick<
  EnvironmentThreadShell,
  "settledAt" | "latestUserMessageAt" | "latestRun" | "updatedAt"
>;

/** The timestamp a settled row sorts and labels by on every client: settledAt
    when stamped, otherwise the latest message or turn stamp, then updatedAt. */
export function resolveSettledThreadTimestamp(thread: SettledThreadTimestampInput): string | null {
  if (thread.settledAt != null && toSortableTimestamp(thread.settledAt) !== null) {
    return thread.settledAt;
  }

  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestRun?.requestedAt,
    thread.latestRun?.startedAt,
    thread.latestRun?.completedAt,
  ]) {
    const parsed = toSortableTimestamp(candidate ?? undefined);
    if (candidate != null && parsed !== null && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  if (latest !== null) return latest;
  return toSortableTimestamp(thread.updatedAt) === null ? null : thread.updatedAt;
}

/** Settled rows are history, so they order by when the work ENDED, newest
    first, with an id tiebreak. Each key resolves once per sort, not once
    per comparison. Shared by web and mobile so both render the same order. */
export function sortSettledThreads<T extends SettledThreadTimestampInput & { readonly id: string }>(
  threads: readonly T[],
): T[] {
  return threads
    .map((thread) => {
      const timestamp = resolveSettledThreadTimestamp(thread);
      return { thread, timestampMs: timestamp === null ? 0 : Date.parse(timestamp) };
    })
    .sort(
      (left, right) =>
        right.timestampMs - left.timestampMs || left.thread.id.localeCompare(right.thread.id),
    )
    .map(({ thread }) => thread);
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
  if (threads.length < 2) return [...threads];
  return threads
    .map((thread) => ({ thread, timestamp: getThreadSortTimestamp(thread, sortOrder) }))
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        (left.thread.id < right.thread.id ? 1 : left.thread.id > right.thread.id ? -1 : 0),
    )
    .map(({ thread }) => thread);
}

export function getLatestThreadForProject<
  T extends {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly archivedAt: string | null;
  } & ThreadSortInput,
>(threads: readonly T[], projectId: ProjectId, sortOrder: SidebarThreadSortOrder): T | null {
  let latest: T | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const thread of threads) {
    if (thread.projectId !== projectId || thread.archivedAt !== null) continue;
    const timestamp = getThreadSortTimestamp(thread, sortOrder);
    if (
      latest === null ||
      timestamp > latestTimestamp ||
      (timestamp === latestTimestamp && thread.id > latest.id)
    ) {
      latest = thread;
      latestTimestamp = timestamp;
    }
  }
  return latest;
}

/**
 * planPinnedReorder specialized for mobile's Move up / Move down menu
 * actions: swap the moved thread with its displayed neighbor. Null when the
 * move falls off either end of the list. Same single-write-per-move
 * semantics as a web drag.
 */
export function planPinnedMove(input: {
  /** Reorder-capable pinned thread ids in displayed order. */
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
  readonly direction: "up" | "down";
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> | null {
  const { orderedIds, keysById, movedId, direction } = input;
  const from = orderedIds.indexOf(movedId);
  if (from === -1) return null;
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= orderedIds.length) return null;
  const newOrder = [...orderedIds];
  newOrder.splice(from, 1);
  newOrder.splice(to, 0, movedId);
  return planPinnedReorder({ orderedIds: newOrder, keysById, movedId });
}
