import type { BoardLane, BoardLaneId } from "./boardLaneStore.ts";

/**
 * Resolves a local board placement. Environment snapshots deliberately do not
 * participate: a session can be visible from any connected environment, but
 * its position is a preference of the surface currently showing this board.
 */
export function resolveBoardLane(
  placement: BoardLaneId | null | undefined,
  lanes: ReadonlyArray<BoardLane>,
): BoardLaneId | null {
  if (placement === null) return null;
  if (placement !== undefined && lanes.some((lane) => lane.id === placement)) return placement;
  return leftmostLane(lanes);
}

/** Lowest `order` wins; ties keep registry order for a stable default. */
export function leftmostLane(lanes: ReadonlyArray<BoardLane>): BoardLaneId | null {
  let leftmost: BoardLane | null = null;
  for (const lane of lanes) {
    if (leftmost === null || lane.order < leftmost.order) leftmost = lane;
  }
  return leftmost?.id ?? null;
}

export function boardLaneLabel(laneId: BoardLaneId, lanes: ReadonlyArray<BoardLane>): string {
  return lanes.find((lane) => lane.id === laneId)?.name ?? laneId;
}

export function isBoardLane(value: string, lanes: ReadonlyArray<BoardLane>): value is BoardLaneId {
  return lanes.some((lane) => lane.id === value);
}
