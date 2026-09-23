import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { pinOrderKeyBetween, planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
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
 * construction stays O(N + T) instead of O(N * (N + T)) (the per-card planner
 * copies and rescans the whole ordered list and the hidden-key map twice).
 *
 * Answers are exact for adjacent swaps except for rows whose fresh key collides
 * with a hidden row's reserved key — a case the reference planner resolves by
 * iterating — which are answered by the planner itself, keeping both menus
 * identical by construction. Falls back wholesale while `fastPath` inputs look
 * adversarial, which they never do in practice.
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
  const sourceRows = input.allThreads ?? input.ordered;
  const keysById = new Map(
    sourceRows.map((row) => [rowId(row), rowOrder(row, input.section).key] as const),
  );
  // Composite row ids are not parseable — ids may themselves contain `:` — so
  // writability maps through the row's own environmentId like the planner's.
  const environmentById = new Map(
    sourceRows.map((row) => [rowId(row), row.environmentId] as const),
  );
  const isWritable = (id: string): boolean => {
    const environmentId = environmentById.get(id);
    return environmentId !== undefined && input.reorderableEnvironmentIds.has(environmentId);
  };
  const visibleIds = new Set(orderedIds);
  const reservedKeys = new Set(
    [...keysById].flatMap(([id, key]) => (!visibleIds.has(id) && key != null ? [key] : [])),
  );
  // `planPinnedReorder`'s section-rewrite fallback writes every row in the
  // section, so it is a viable plan for all rows or for none.
  const bulkViable = orderedIds.every(isWritable);
  let plannerRef:
    | ((movedId: string, direction: ThreadMoveDestination) => readonly unknown[] | null)
    | null = null;
  for (const row of rows) {
    const movedId = rowId(row);
    const denied = { canMoveUp: false, canMoveDown: false };
    if (!isWritable(movedId)) {
      result.set(movedId, denied);
      continue;
    }
    const index = indexById.get(movedId);
    if (index === undefined) {
      result.set(movedId, denied);
      continue;
    }
    let ambiguous = false;
    const adjacentAvailable = (towardUp: boolean): boolean => {
      const shifted = index + (towardUp ? -1 : 1);
      if (shifted < 0 || shifted >= orderedIds.length) return false;
      // The swap exchanges the row with its neighbor; afterwards the moved row
      // sits at `shifted` between `beforeIndex` and `afterIndex` of the OLD
      // order: moving up it lands between old(index-2) and old(index-1),
      // moving down between old(index+1) and old(index+2).
      const beforeIndex = towardUp ? index - 2 : index + 1;
      const afterIndex = towardUp ? index - 1 : index + 2;
      const beforeKey = keysById.get(orderedIds[beforeIndex] ?? "") ?? null;
      const afterKey = keysById.get(orderedIds[afterIndex] ?? "") ?? null;
      const beforeUsable = beforeIndex < 0 || beforeKey != null;
      const afterUsable = afterIndex >= orderedIds.length || afterKey != null;
      if (beforeUsable && afterUsable) {
        const key = pinOrderKeyBetween(beforeKey, afterKey);
        if (key === null) return bulkViable;
        if (!reservedKeys.has(key)) return true;
        ambiguous = true; // reserved-key walk: defer to the reference planner
      }
      return bulkViable;
    };
    const canMoveUp = adjacentAvailable(true);
    const canMoveDown = adjacentAvailable(false);
    if (!ambiguous) {
      result.set(movedId, { canMoveUp, canMoveDown });
    } else {
      // The rare reserved-key collision keeps the exact reference answer.
      const planner =
        plannerRef ??
        (plannerRef = createThreadMovePlanner({
          ordered: rows,
          allThreads: sourceRows,
          section: input.section,
          reorderableEnvironmentIds: input.reorderableEnvironmentIds,
        }));
      result.set(movedId, {
        canMoveUp: planner(movedId, "up") !== null,
        canMoveDown: planner(movedId, "down") !== null,
      });
    }
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
