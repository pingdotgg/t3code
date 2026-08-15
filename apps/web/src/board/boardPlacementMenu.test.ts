import { describe, expect, it } from "vite-plus/test";

import type { BoardLane } from "./boardLaneStore.ts";
import {
  boardLaneForPlacementAction,
  buildBoardPlacementContextMenuItems,
} from "./boardPlacementMenu.ts";

const LANES: ReadonlyArray<BoardLane> = [
  { id: "settled", name: "Settled", description: "Finished", order: -10 },
  { id: "triage", name: "Triage", description: "New", order: 100 },
  { id: "shaping", name: "Grilling / shaping", description: "Shape it", order: 0 },
  { id: "ready", name: "Ready", description: "Ready", order: 1 },
  { id: "snoozed", name: "Snoozed", description: "Later", order: -20 },
];

const WORKFLOW_LANES = [LANES[1]!, LANES[2]!, LANES[3]!];

describe("board placement context menu", () => {
  it("offers ordered workflow lanes without lifecycle or removal actions", () => {
    expect(buildBoardPlacementContextMenuItems(LANES)).toEqual([
      {
        id: "place-in-lane",
        label: "Place in lane…",
        children: WORKFLOW_LANES.map((lane) => ({
          id: `place-in-lane:${lane.id}`,
          label: lane.name,
        })),
      },
    ]);
  });

  it.each(WORKFLOW_LANES)("maps the $id placement action to its local lane", (lane) => {
    expect(boardLaneForPlacementAction(`place-in-lane:${lane.id}`, LANES)).toBe(lane.id);
  });

  it("ignores lifecycle, removed, stale, and unrelated actions", () => {
    expect(boardLaneForPlacementAction("remove-from-board", LANES)).toBeUndefined();
    expect(boardLaneForPlacementAction("place-in-lane:snoozed", LANES)).toBeUndefined();
    expect(boardLaneForPlacementAction("place-in-lane:settled", LANES)).toBeUndefined();
    expect(boardLaneForPlacementAction("rename", LANES)).toBeUndefined();
    expect(boardLaneForPlacementAction("place-in-lane:retired", LANES)).toBeUndefined();
  });
});
