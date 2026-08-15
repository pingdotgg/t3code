import { describe, expect, it } from "vite-plus/test";

import type { BoardLane } from "./boardLaneStore.ts";
import {
  isBoardFixedLaneId,
  isBoardLifecycleLaneId,
  isBoardWorkflowLane,
  leftmostLane,
  orderBoardLanes,
  resolveBoardLane,
} from "./boardLanes.ts";

const LANES: ReadonlyArray<BoardLane> = [
  { id: "settled", name: "Settled", description: "Finished", order: -100 },
  { id: "triage", name: "Triage", description: "Unplaced", order: 100 },
  { id: "ready", name: "Ready", description: "Ready", order: 1 },
  { id: "blocked", name: "Blocked", description: "Blocked", order: 0 },
  { id: "snoozed", name: "Snoozed", description: "Later", order: -200 },
];

describe("resolveBoardLane", () => {
  it("uses an explicit local placement when the local registry contains it", () => {
    expect(resolveBoardLane("ready", LANES)).toBe("ready");
  });

  it("puts never-placed or obsolete cards in the local leftmost lane", () => {
    expect(resolveBoardLane(undefined, LANES)).toBe("triage");
    expect(resolveBoardLane("archived-lane", LANES)).toBe("triage");
  });

  it("rejects lifecycle ids as persisted workflow placement", () => {
    expect(resolveBoardLane("snoozed", LANES)).toBe("triage");
    expect(resolveBoardLane("settled", LANES)).toBe("triage");
  });
});

describe("leftmostLane", () => {
  it("pins Triage left regardless of persisted order", () => {
    expect(leftmostLane(LANES)).toBe("triage");
  });

  it("falls back to the first ordered workflow lane for a malformed registry", () => {
    expect(leftmostLane(LANES.filter((lane) => lane.id !== "triage"))).toBe("blocked");
    expect(leftmostLane([])).toBeNull();
  });
});

describe("board lane invariants", () => {
  it("pins lifecycle lanes to the right of user-ordered workflow lanes", () => {
    expect(orderBoardLanes(LANES).map((lane) => lane.id)).toEqual([
      "triage",
      "blocked",
      "ready",
      "snoozed",
      "settled",
    ]);
  });

  it("distinguishes fixed, lifecycle, and workflow lanes", () => {
    expect(isBoardFixedLaneId("triage")).toBe(true);
    expect(isBoardFixedLaneId("snoozed")).toBe(true);
    expect(isBoardFixedLaneId("ready")).toBe(false);
    expect(isBoardLifecycleLaneId("settled")).toBe(true);
    expect(isBoardLifecycleLaneId("triage")).toBe(false);
    expect(isBoardWorkflowLane(LANES.find((lane) => lane.id === "triage")!)).toBe(true);
    expect(isBoardWorkflowLane(LANES.find((lane) => lane.id === "settled")!)).toBe(false);
  });
});
