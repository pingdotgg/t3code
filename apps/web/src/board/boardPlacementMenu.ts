import type { ContextMenuItem } from "@t3tools/contracts";

import type { BoardLane, BoardLaneId } from "./boardLaneStore.ts";
import { boardLaneLabel, isBoardLane, isBoardWorkflowLane, orderBoardLanes } from "./boardLanes.ts";

const PLACE_IN_LANE_PREFIX = "place-in-lane:";

export function buildBoardPlacementContextMenuItems(
  lanes: ReadonlyArray<BoardLane>,
): ReadonlyArray<ContextMenuItem> {
  const workflowLanes = orderBoardLanes(lanes).filter(isBoardWorkflowLane);
  return [
    {
      id: "place-in-lane",
      label: "Place in lane…",
      children: workflowLanes.map((lane) => ({
        id: `${PLACE_IN_LANE_PREFIX}${lane.id}`,
        label: boardLaneLabel(lane.id, lanes),
      })),
    },
  ];
}

export function boardLaneForPlacementAction(
  action: string | null,
  lanes: ReadonlyArray<BoardLane>,
): BoardLaneId | undefined {
  if (action?.startsWith(PLACE_IN_LANE_PREFIX) !== true) return undefined;

  const lane = action.slice(PLACE_IN_LANE_PREFIX.length);
  if (!isBoardLane(lane, lanes)) return undefined;
  const targetLane = lanes.find((candidate) => candidate.id === lane);
  if (targetLane === undefined || !isBoardWorkflowLane(targetLane)) return undefined;
  return lane;
}
