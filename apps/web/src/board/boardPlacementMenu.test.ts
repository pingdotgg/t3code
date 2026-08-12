import { describe, expect, it } from "vite-plus/test";

import type { BoardLane } from "./boardLaneStore.ts";
import {
  boardLaneForPlacementAction,
  buildBoardPlacementContextMenuItems,
} from "./boardPlacementMenu.ts";

const LANES: ReadonlyArray<BoardLane> = [
  { id: "shaping", name: "Grilling / shaping", description: "Shape it", order: 0 },
  { id: "ready", name: "Ready", description: "Ready", order: 1 },
];

describe("board placement context menu", () => {
  it("offers every locally-defined lane and an explicit removal", () => {
    expect(buildBoardPlacementContextMenuItems(LANES)).toEqual([
      {
        id: "place-in-lane",
        label: "Place in lane…",
        children: LANES.map((lane) => ({
          id: `place-in-lane:${lane.id}`,
          label: lane.name,
        })),
      },
      { id: "remove-from-board", label: "Remove from board" },
    ]);
  });

  it.each(LANES)("maps the $id placement action to its local lane", (lane) => {
    expect(boardLaneForPlacementAction(`place-in-lane:${lane.id}`, LANES)).toBe(lane.id);
  });

  it("maps removal to null and ignores stale or unrelated actions", () => {
    expect(boardLaneForPlacementAction("remove-from-board", LANES)).toBeNull();
    expect(boardLaneForPlacementAction("rename", LANES)).toBeUndefined();
    expect(boardLaneForPlacementAction("place-in-lane:retired", LANES)).toBeUndefined();
  });
});
