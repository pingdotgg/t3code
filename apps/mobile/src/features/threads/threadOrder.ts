import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
  planPinnedReorder,
} from "@t3tools/client-runtime/state/thread-sort";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";

export type ThreadMoveDestination =
  | "up"
  | "down"
  | {
      readonly targetId: string | null;
      readonly section?: "pinned" | "active" | "settled";
      readonly placement: "before" | "after";
    };

/** Resolve against stable row identities, including rows hidden by a filter. */
export function threadOrderAfterMove(
  orderedIds: readonly string[],
  movedId: string,
  destination: ThreadMoveDestination,
): string[] | null {
  if (typeof destination === "object" && destination.section === "settled") return null;
  const from = orderedIds.indexOf(movedId);
  if (from < 0 && (typeof destination === "string" || destination.section === undefined))
    return null;
  const result = orderedIds.filter((id) => id !== movedId);
  let to: number;
  if (typeof destination === "string") {
    to = from + (destination === "up" ? -1 : 1);
    if (to < 0 || to >= orderedIds.length) return null;
  } else {
    if (destination.targetId === null) {
      if (destination.section === undefined) return null;
      to = destination.placement === "before" ? 0 : result.length;
    } else {
      const target = result.indexOf(destination.targetId);
      if (target < 0) return null;
      to = target + (destination.placement === "after" ? 1 : 0);
    }
  }
  if (to === from) return null;
  result.splice(to, 0, movedId);
  return result;
}

export type OrderRow = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "pinOrderKey"
  | "activeOrderKey"
  | "createdAt"
  | "unsettledAt"
  | "pinnedAt"
>;

export interface PendingThreadOrder {
  readonly section: "pinned" | "active";
  readonly orderedIds: readonly string[];
  readonly before: ReadonlyMap<string, { readonly key: string | null; readonly anchor: string }>;
  readonly assignments: ReadonlyMap<string, string>;
  readonly confirmed: ReadonlySet<string>;
  readonly commandsComplete: boolean;
}

function rowId(row: OrderRow): string {
  return `${row.environmentId}:${row.id}`;
}

function rowOrder(row: OrderRow, section: PendingThreadOrder["section"]) {
  return {
    key: (section === "pinned" ? row.pinOrderKey : row.activeOrderKey) ?? null,
    anchor: section === "pinned" ? (row.pinnedAt ?? "") : (row.unsettledAt ?? row.createdAt),
  };
}

/** Keep every visible row as an anchor, but only offer plans whose key writes
 * are supported. Menu availability and execution use this same planner. */
export function createThreadMovePlanner(input: {
  readonly ordered: readonly OrderRow[];
  readonly allThreads?: readonly OrderRow[];
  readonly section: PendingThreadOrder["section"];
  readonly reorderableEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const orderedIds = input.ordered.map(rowId);
  const keysById = new Map(
    (input.allThreads ?? input.ordered).map((row) => [
      rowId(row),
      rowOrder(row, input.section).key,
    ]),
  );
  const writableIds = new Set(
    (input.allThreads ?? input.ordered)
      .filter((row) => input.reorderableEnvironmentIds.has(row.environmentId))
      .map(rowId),
  );
  return (movedId: string, direction: ThreadMoveDestination) => {
    if (!writableIds.has(movedId)) return null;
    const nextIds = threadOrderAfterMove(orderedIds, movedId, direction);
    if (nextIds === null) return null;
    const assignments = planPinnedReorder({ orderedIds: nextIds, keysById, movedId });
    return assignments === null ||
      assignments.length === 0 ||
      assignments.some((assignment) => !writableIds.has(assignment.id))
      ? null
      : assignments;
  };
}

export interface ThreadMoveAvailability {
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

/**
 * Batch form of "call `createThreadMovePlanner` once per card": one pass over
 * the section answers up/down availability for every ordered row, so list
 * construction stays linear instead of one full planner probe (array copies,
 * hidden-key rescans) per row on the minute-tick rebuild path. The mirror of
 * the planner's plan rules lives in the body below; the reference-parity test
 * pins them row-by-row, including adversarial keys and hidden reservations.
 */
export function computeThreadMoveAvailability(input: {
  readonly ordered: readonly OrderRow[];
  readonly allThreads?: readonly OrderRow[];
  readonly section: PendingThreadOrder["section"];
  readonly reorderableEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly pendingOrder?: PendingThreadOrder | null;
}): Map<string, ThreadMoveAvailability> {
  const result = new Map<string, ThreadMoveAvailability>();
  // A reorder in flight locks the whole list until its receipt lands.
  if (input.pendingOrder != null) return result;
  const rows = input.ordered;
  const orderedIds = rows.map(rowId);
  const indexById = new Map(orderedIds.map((id, index) => [id, index] as const));
  const keysById = new Map(
    (input.allThreads ?? input.ordered).map(
      (row) => [rowId(row), rowOrder(row, input.section).key] as const,
    ),
  );
  const writableIds = new Set(
    (input.allThreads ?? input.ordered)
      .filter((row) => input.reorderableEnvironmentIds.has(row.environmentId))
      .map(rowId),
  );
  const visibleIds = new Set(orderedIds);
  const reservedKeys = new Set(
    [...keysById].flatMap(([id, key]) => (!visibleIds.has(id) && key != null ? [key] : [])),
  );
  // Mirror of `planPinnedReorder` for adjacent swaps, hoisted so every row is
  // answered in O(1) amortized instead of one planner probe per row:
  //
  // Fast path (both neighbors keyed): the fresh key between the landing
  // neighbors, walking forward while hidden reserved keys block it. The walk
  // depends only on the neighbor key pair - each adjacency is probed by at
  // most two rows (down of the left member, up of the right member) - so the
  // memo keeps even a fully adversarial reserved-key layout linear per build.
  //
  // Rewrite path (keyless/unusable neighbor, or key space exhausted): fresh
  // spread keys for every row; only positions whose current key differs get
  // written. A swap permutes two rows without changing the multiset, so the
  // assignment set differs from the unswapped baseline at at most those two
  // positions, and mismatch/writability tallies computed once per section
  // answer each row with a constant-size delta.
  const midpoints = new Map<string, string | null>();
  const fastPathKey = (beforeKey: string | null, afterKey: string | null): string | null => {
    const memoKey = `${beforeKey ?? ""}\u0000${afterKey ?? ""}`;
    const cached = midpoints.get(memoKey);
    if (cached !== undefined) return cached;
    let key = pinOrderKeyBetween(beforeKey, afterKey);
    while (key !== null && reservedKeys.has(key)) key = pinOrderKeyBetween(key, afterKey);
    midpoints.set(memoKey, key);
    return key;
  };
  const spreadKeys = generateSpreadPinOrderKeys(orderedIds.length + reservedKeys.size)
    .filter((key) => !reservedKeys.has(key))
    .slice(0, orderedIds.length);
  const currentKeys = orderedIds.map((id) => keysById.get(id) ?? null);
  const writableRow = orderedIds.map((id) => writableIds.has(id));
  let baselineWrites = 0;
  let baselineUnwritableWrites = 0;
  for (let position = 0; position < orderedIds.length; position += 1) {
    if (currentKeys[position] === spreadKeys[position]) continue;
    baselineWrites += 1;
    if (!writableRow[position]) baselineUnwritableWrites += 1;
  }
  // `movedId` swaps with its neighbor; ids at the two swapped positions change,
  // so only their tally contributions are recomputed.
  const rewriteViable = (index: number): boolean => {
    let writes = baselineWrites;
    let unwritableWrites = baselineUnwritableWrites;
    for (const position of [index, index + 1]) {
      const other = position === index ? index + 1 : index;
      if (currentKeys[position] !== spreadKeys[position]) {
        writes -= 1;
        if (!writableRow[position]) unwritableWrites -= 1;
      }
      // After the swap this position holds the row that was at `other`.
      if (currentKeys[other] !== spreadKeys[position]) {
        writes += 1;
        if (!writableRow[other]) unwritableWrites += 1;
      }
    }
    return writes > 0 && unwritableWrites === 0;
  };
  for (const row of rows) {
    const movedId = rowId(row);
    const denied = { canMoveUp: false, canMoveDown: false };
    if (!writableIds.has(movedId)) {
      result.set(movedId, denied);
      continue;
    }
    const index = indexById.get(movedId);
    if (index === undefined) {
      result.set(movedId, denied);
      continue;
    }
    const adjacentAvailable = (towardUp: boolean): boolean => {
      const shifted = index + (towardUp ? -1 : 1);
      if (shifted < 0 || shifted >= orderedIds.length) return false;
      // The swap exchanges the row with its neighbor; afterwards the moved row
      // sits at `shifted` between `beforeIndex` and `afterIndex` of the OLD
      // order: moving up it lands between old(index-2) and old(index-1),
      // moving down between old(index+1) and old(index+2).
      const beforeIndex = towardUp ? index - 2 : index + 1;
      const afterIndex = towardUp ? index - 1 : index + 2;
      const beforeId = beforeIndex < 0 ? null : (orderedIds[beforeIndex] ?? null);
      const afterId = afterIndex >= orderedIds.length ? null : (orderedIds[afterIndex] ?? null);
      const beforeKey = beforeId === null ? null : (keysById.get(beforeId) ?? null);
      const afterKey = afterId === null ? null : (keysById.get(afterId) ?? null);
      if ((beforeId === null || beforeKey != null) && (afterId === null || afterKey != null)) {
        const key = fastPathKey(beforeKey, afterKey);
        // A fresh key is a single-write plan for the (writable) moved row.
        if (key !== null) return true;
      }
      // Keyless neighbor or exhausted key space: the section rewrite runs.
      return rewriteViable(Math.min(index, shifted));
    };
    result.set(movedId, {
      canMoveUp: adjacentAvailable(true),
      canMoveDown: adjacentAvailable(false),
    });
  }
  return result;
}

export function createPendingThreadOrder(input: {
  readonly section: PendingThreadOrder["section"];
  readonly ordered: readonly OrderRow[];
  readonly movedId: string;
  readonly direction: ThreadMoveDestination;
  readonly assignments: readonly { readonly id: string; readonly orderKey: string }[];
}): PendingThreadOrder {
  const orderedIds = threadOrderAfterMove(input.ordered.map(rowId), input.movedId, input.direction);
  if (orderedIds === null) throw new Error("Cannot begin an invalid thread move");
  return {
    section: input.section,
    orderedIds,
    before: new Map(input.ordered.map((row) => [rowId(row), rowOrder(row, input.section)])),
    assignments: new Map(input.assignments.map(({ id, orderKey }) => [id, orderKey])),
    confirmed: new Set(),
    commandsComplete: false,
  };
}

/** Receipts and shell updates arrive independently. Only our own key writes
 * may pass through the hold; membership and other arrangement changes win. */
export function reconcilePendingThreadOrder(
  pending: PendingThreadOrder,
  ordered: readonly OrderRow[],
): PendingThreadOrder | null {
  if (ordered.length !== pending.before.size) return null;
  const confirmed = new Set(pending.confirmed);
  for (const row of ordered) {
    const id = rowId(row);
    const before = pending.before.get(id);
    const current = rowOrder(row, pending.section);
    if (before === undefined || current.anchor !== before.anchor) return null;
    const assigned = pending.assignments.get(id);
    if (assigned !== undefined && current.key === assigned) confirmed.add(id);
    else if (current.key !== before.key || confirmed.has(id)) return null;
  }
  if (pending.commandsComplete && confirmed.size === pending.assignments.size) return null;
  return confirmed.size === pending.confirmed.size ? pending : { ...pending, confirmed };
}

/** Apply the full section's pending order after search/environment filtering. */
export function applyPendingThreadOrder<T extends OrderRow>(
  rows: readonly T[],
  section: PendingThreadOrder["section"],
  pending: PendingThreadOrder | null | undefined,
): T[] {
  if (pending == null || pending.section !== section) return [...rows];
  const rank = new Map(pending.orderedIds.map((id, index) => [id, index]));
  return [...rows].sort(
    (left, right) => (rank.get(rowId(left)) ?? Infinity) - (rank.get(rowId(right)) ?? Infinity),
  );
}

/** Match desktop re-entry: a pin wakes the thread on the server; Active clears
 * each underlying parked state before assigning its destination order key. */
export function threadDropLifecycle(
  thread: EnvironmentThreadShell,
  section: "pinned" | "active",
  now: string,
) {
  if (section === "pinned") return { pin: true, unpin: false, unsettle: false, unsnooze: false };
  return {
    pin: false,
    unpin: thread.pinnedAt != null,
    unsettle: thread.settledOverride === "settled",
    unsnooze: effectiveSnoozed(thread, { now }),
  };
}

export type ThreadDragSection = "pinned" | "active" | "snoozed" | "settled";

/** The action shown during hover describes the lifecycle change made on drop. */
export function threadDragAction(source: ThreadDragSection, destination: ThreadDragSection) {
  if (destination === "snoozed") return null;
  if (destination === "settled") return source === "settled" ? null : "Settle";
  if (source === destination) return "Reorder";
  if (destination === "pinned") return "Pin";
  if (source === "pinned") return "Unpin";
  if (source === "settled") return "Unsettle";
  return "Unsnooze";
}
