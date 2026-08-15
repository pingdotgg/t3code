import {
  SETTLED_BOARD_LANE_ID,
  SNOOZED_BOARD_LANE_ID,
  TRIAGE_BOARD_LANE_ID,
  type BoardLane,
  type BoardLaneId,
} from "./boardLaneStore.ts";

export function isBoardLifecycleLaneId(laneId: BoardLaneId): boolean {
  return laneId === SNOOZED_BOARD_LANE_ID || laneId === SETTLED_BOARD_LANE_ID;
}

export function isBoardFixedLaneId(laneId: BoardLaneId): boolean {
  return laneId === TRIAGE_BOARD_LANE_ID || isBoardLifecycleLaneId(laneId);
}

/** Triage is a fixed-position workflow lane; only lifecycle lanes are excluded. */
export function isBoardWorkflowLane(lane: BoardLane): boolean {
  return !isBoardLifecycleLaneId(lane.id);
}

/**
 * One canonical column order: fixed Triage, user-ordered workflow, then the
 * two fixed lifecycle tails. Persisted `order` values never move fixed lanes.
 */
export function orderBoardLanes(lanes: ReadonlyArray<BoardLane>): ReadonlyArray<BoardLane> {
  const triage = lanes.find((lane) => lane.id === TRIAGE_BOARD_LANE_ID);
  const snoozed = lanes.find((lane) => lane.id === SNOOZED_BOARD_LANE_ID);
  const settled = lanes.find((lane) => lane.id === SETTLED_BOARD_LANE_ID);
  const workflow = lanes
    .filter((lane) => !isBoardFixedLaneId(lane.id))
    .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return [
    ...(triage === undefined ? [] : [triage]),
    ...workflow,
    ...(snoozed === undefined ? [] : [snoozed]),
    ...(settled === undefined ? [] : [settled]),
  ];
}

/**
 * Resolves a local board placement. Environment snapshots deliberately do not
 * participate: a session can be visible from any connected environment, but
 * its position is a preference of the surface currently showing this board.
 */
export function resolveBoardLane(
  placement: BoardLaneId | undefined,
  lanes: ReadonlyArray<BoardLane>,
): BoardLaneId | null {
  if (
    placement !== undefined &&
    !isBoardLifecycleLaneId(placement) &&
    lanes.some((lane) => lane.id === placement)
  ) {
    return placement;
  }
  return leftmostLane(lanes);
}

/** Triage wins; malformed registries fall back to the first ordered workflow lane. */
export function leftmostLane(lanes: ReadonlyArray<BoardLane>): BoardLaneId | null {
  return orderBoardLanes(lanes).find(isBoardWorkflowLane)?.id ?? null;
}

export function boardLaneLabel(laneId: BoardLaneId, lanes: ReadonlyArray<BoardLane>): string {
  return lanes.find((lane) => lane.id === laneId)?.name ?? laneId;
}

export function isBoardLane(value: string, lanes: ReadonlyArray<BoardLane>): value is BoardLaneId {
  return lanes.some((lane) => lane.id === value);
}
