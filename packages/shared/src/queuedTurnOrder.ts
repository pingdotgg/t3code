/**
 * Queue delivery order for a thread's queued messages.
 *
 * Shared by the server projector, the queued-turn reactor, and the web store so
 * all three agree on what "next" means — a divergence here would show the user
 * one order and dispatch another.
 *
 * @module queuedTurnOrder
 */

/** The subset of a queued turn this ordering needs. */
export interface QueueOrderable {
  readonly id: string;
  readonly createdAt: string;
  readonly queuePosition?: number | undefined;
}

/**
 * Order by explicit `queuePosition`, falling back to creation order.
 *
 * A turn without a position was replayed from an event log written before
 * explicit ordering existed; it sorts last so it can never displace a turn the
 * user explicitly positioned. `id` breaks remaining ties so the order is total
 * and stable across processes.
 */
export function compareQueuedTurns(left: QueueOrderable, right: QueueOrderable): number {
  const leftPosition = left.queuePosition;
  const rightPosition = right.queuePosition;
  if (leftPosition !== rightPosition) {
    if (leftPosition === undefined) return 1;
    if (rightPosition === undefined) return -1;
    return leftPosition - rightPosition;
  }
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/**
 * Position for a newly queued turn: one past the highest explicit position.
 * Position-less turns are ignored so a pre-ordering turn cannot push the next
 * append to an arbitrary offset.
 */
export function nextQueuePosition(queuedTurns: ReadonlyArray<QueueOrderable>): number {
  return queuedTurns.reduce(
    (highest, queuedTurn) =>
      queuedTurn.queuePosition === undefined
        ? highest
        : Math.max(highest, queuedTurn.queuePosition + 1),
    0,
  );
}
