import { describe, expect, it } from "vite-plus/test";

import type { BoardLane } from "./boardLaneStore.ts";
import { leftmostLane, resolveBoardLane } from "./boardLanes.ts";

const LANES: ReadonlyArray<BoardLane> = [
  { id: "triage", name: "Triage", description: "Unplaced", order: -1 },
  { id: "ready", name: "Ready", description: "Ready", order: 1 },
];

describe("resolveBoardLane", () => {
  it("uses an explicit local placement when the local registry contains it", () => {
    expect(resolveBoardLane("ready", LANES)).toBe("ready");
  });

  it("puts never-placed or obsolete cards in the local leftmost lane", () => {
    expect(resolveBoardLane(undefined, LANES)).toBe("triage");
    expect(resolveBoardLane("archived-lane", LANES)).toBe("triage");
  });

  it("keeps an explicitly removed session off this board", () => {
    expect(resolveBoardLane(null, LANES)).toBeNull();
  });
});

describe("leftmostLane", () => {
  it("picks lowest order and returns null for an empty local registry", () => {
    expect(leftmostLane(LANES)).toBe("triage");
    expect(leftmostLane([])).toBeNull();
  });
});
