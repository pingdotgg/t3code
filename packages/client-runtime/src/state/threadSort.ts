import type { PinnedThreadOrder, ProjectId } from "@t3tools/contracts";
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

export interface PinnedThreadSortInput {
  readonly id: string;
  readonly environmentId?: string | undefined;
  readonly createdAt: string;
  readonly pinnedOrder?: PinnedThreadOrder | null | undefined;
}

function pinnedThreadIdentity(thread: PinnedThreadSortInput): string {
  return thread.environmentId ? `${thread.environmentId}:${thread.id}` : thread.id;
}

type RationalOrder = {
  readonly numerator: bigint;
  readonly denominator: bigint;
};

const DEFAULT_ORDER_TIMESTAMP_CEILING = 10_000_000_000_000_000n;
const DEFAULT_ORDER_ID_BUCKET = 1n << 64n;
const FNV_OFFSET_BASIS_64 = 14_695_981_039_346_656_037n;
const FNV_PRIME_64 = 1_099_511_628_211n;
const PINNED_THREAD_ORDER_MAX_DIGITS = 256;

function stableIdHash(id: string): bigint {
  let hash = FNV_OFFSET_BASIS_64;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= BigInt(id.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * FNV_PRIME_64);
  }
  return hash;
}

function parsePinnedThreadOrder(order: PinnedThreadOrder): RationalOrder {
  const separator = order.indexOf("/");
  return {
    numerator: BigInt(order.slice(0, separator)),
    denominator: BigInt(order.slice(separator + 1)),
  };
}

function defaultPinnedThreadOrder(thread: PinnedThreadSortInput): RationalOrder {
  const parsedTimestamp = Date.parse(thread.createdAt);
  const timestamp = Number.isFinite(parsedTimestamp) ? Math.max(0, Math.trunc(parsedTimestamp)) : 0;
  const invertedTimestamp = DEFAULT_ORDER_TIMESTAMP_CEILING - BigInt(timestamp);
  return {
    numerator:
      invertedTimestamp * DEFAULT_ORDER_ID_BUCKET + stableIdHash(pinnedThreadIdentity(thread)) + 1n,
    denominator: 1n,
  };
}

function effectivePinnedThreadOrder(thread: PinnedThreadSortInput): RationalOrder {
  return thread.pinnedOrder
    ? parsePinnedThreadOrder(thread.pinnedOrder)
    : defaultPinnedThreadOrder(thread);
}

function compareRationalOrder(left: RationalOrder, right: RationalOrder): number {
  const leftProduct = left.numerator * right.denominator;
  const rightProduct = right.numerator * left.denominator;
  return leftProduct < rightProduct ? -1 : leftProduct > rightProduct ? 1 : 0;
}

/** Sorts pinned threads by their synced position, falling back to the v2
 * creation order for threads pinned by a pre-reordering client. */
export function sortPinnedThreads<T extends PinnedThreadSortInput>(threads: readonly T[]): T[] {
  return threads
    .map((thread) => ({
      thread,
      identity: pinnedThreadIdentity(thread),
      order: effectivePinnedThreadOrder(thread),
    }))
    .sort((left, right) => {
      const order = compareRationalOrder(left.order, right.order);
      return order !== 0
        ? order
        : left.identity < right.identity
          ? -1
          : left.identity > right.identity
            ? 1
            : 0;
    })
    .map(({ thread }) => thread);
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let dividend = left;
  let divisor = right;
  while (divisor !== 0n) {
    const remainder = dividend % divisor;
    dividend = divisor;
    divisor = remainder;
  }
  return dividend;
}

function serializePinnedThreadOrder(order: RationalOrder): PinnedThreadOrder | null {
  const divisor = greatestCommonDivisor(order.numerator, order.denominator);
  const numerator = order.numerator / divisor;
  const denominator = order.denominator / divisor;
  const numeratorText = numerator.toString();
  const denominatorText = denominator.toString();
  if (
    numerator <= 0n ||
    denominator <= 0n ||
    numeratorText.length > PINNED_THREAD_ORDER_MAX_DIGITS ||
    denominatorText.length > PINNED_THREAD_ORDER_MAX_DIGITS
  ) {
    return null;
  }
  return `${numeratorText}/${denominatorText}` as PinnedThreadOrder;
}

function reorderPinnedThreads<T extends PinnedThreadSortInput>(
  orderedThreads: readonly T[],
  threadId: string,
  overThreadId: string,
): { readonly reordered: T[]; readonly moved: T } | null {
  const fromIndex = orderedThreads.findIndex((thread) => pinnedThreadIdentity(thread) === threadId);
  const toIndex = orderedThreads.findIndex(
    (thread) => pinnedThreadIdentity(thread) === overThreadId,
  );
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;

  const reordered = [...orderedThreads];
  const [moved] = reordered.splice(fromIndex, 1);
  if (!moved) return null;
  reordered.splice(toIndex, 0, moved);
  return { reordered, moved };
}

function boundedOrderForMovedThread<T extends PinnedThreadSortInput>(
  reordered: readonly T[],
  moved: T,
): PinnedThreadOrder | null {
  const movedIndex = reordered.indexOf(moved);
  const previous = movedIndex > 0 ? reordered[movedIndex - 1] : undefined;
  const next = movedIndex + 1 < reordered.length ? reordered[movedIndex + 1] : undefined;

  if (previous && next) {
    const left = effectivePinnedThreadOrder(previous);
    const right = effectivePinnedThreadOrder(next);
    const candidate = {
      numerator: left.numerator + right.numerator,
      denominator: left.denominator + right.denominator,
    };
    if (compareRationalOrder(left, candidate) >= 0 || compareRationalOrder(candidate, right) >= 0) {
      return null;
    }
    return serializePinnedThreadOrder(candidate);
  }
  if (next) {
    const right = effectivePinnedThreadOrder(next);
    return serializePinnedThreadOrder({
      numerator: right.numerator,
      denominator: right.numerator + right.denominator,
    });
  }
  if (previous) {
    const left = effectivePinnedThreadOrder(previous);
    return serializePinnedThreadOrder({
      numerator: left.numerator + left.denominator,
      denominator: left.denominator,
    });
  }
  return "1/1" as PinnedThreadOrder;
}

/**
 * Returns a new stable position for one thread dragged over another. The
 * mediant of adjacent rational positions is always strictly between them, so
 * only the moved thread needs a server command and sibling environments do
 * not need a coordinated renumber.
 */
export function pinnedThreadOrderForMove<T extends PinnedThreadSortInput>(
  orderedThreads: readonly T[],
  threadId: string,
  overThreadId: string,
): PinnedThreadOrder | null {
  const result = reorderPinnedThreads(orderedThreads, threadId, overThreadId);
  return result ? boundedOrderForMovedThread(result.reordered, result.moved) : null;
}

export interface PinnedThreadOrderUpdate {
  readonly threadId: string;
  readonly pinnedOrder: PinnedThreadOrder;
  readonly previousPinnedOrder: PinnedThreadOrder;
}

/** Returns the usual single-thread update, or a compact full-list rebalance
 * when no rational within the wire contract remains between two neighbors. */
export function pinnedThreadOrderUpdatesForMove<T extends PinnedThreadSortInput>(
  orderedThreads: readonly T[],
  threadId: string,
  overThreadId: string,
): readonly PinnedThreadOrderUpdate[] | null {
  const result = reorderPinnedThreads(orderedThreads, threadId, overThreadId);
  if (!result) return null;

  const movedOrder = boundedOrderForMovedThread(result.reordered, result.moved);
  if (movedOrder !== null) {
    const previousPinnedOrder = serializePinnedThreadOrder(
      effectivePinnedThreadOrder(result.moved),
    );
    return previousPinnedOrder === null
      ? null
      : [
          {
            threadId: pinnedThreadIdentity(result.moved),
            pinnedOrder: movedOrder,
            previousPinnedOrder,
          },
        ];
  }

  const compacted = result.reordered.map((thread, index) => {
    const pinnedOrder = serializePinnedThreadOrder({
      numerator: BigInt(index + 1),
      denominator: 1n,
    });
    const previousPinnedOrder = serializePinnedThreadOrder(effectivePinnedThreadOrder(thread));
    return pinnedOrder === null || previousPinnedOrder === null
      ? null
      : { threadId: pinnedThreadIdentity(thread), pinnedOrder, previousPinnedOrder };
  });
  return compacted.some((update) => update === null)
    ? null
    : (compacted as PinnedThreadOrderUpdate[]);
}
