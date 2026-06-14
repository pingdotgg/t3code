import { describe, expect, it } from "vite-plus/test";

import { UNASSIGNED_OWNER_KEY } from "./t3work-planningSpaceLayout";
import {
  buildPlanningNavigationOrder,
  navigatePlanningItem,
  planningGroupKeyOf,
} from "./t3work-planningSpaceNavigation";
import type { PackedFrame } from "./t3work-planningSpaceScene";

function frame(id: string, centerX: number, centerY: number): PackedFrame {
  return { id, centerX, centerY, height: 100 };
}

describe("planningGroupKeyOf", () => {
  it("maps grouping modes to cluster keys", () => {
    const story = {
      epicId: "E1",
      ownerId: "alice",
      inSprint: true,
    };
    expect(planningGroupKeyOf(story, "epic")).toBe("E1");
    expect(planningGroupKeyOf(story, "owner")).toBe("alice");
    expect(planningGroupKeyOf(story, "sprint")).toBe("true");
    expect(planningGroupKeyOf({ ...story, ownerId: null }, "owner")).toBe(UNASSIGNED_OWNER_KEY);
  });
});

describe("buildPlanningNavigationOrder", () => {
  const storyById = new Map([
    ["S1", { epicId: "E1", ownerId: "alice", inSprint: true }],
    ["S2", { epicId: "E1", ownerId: "bob", inSprint: true }],
    ["S3", { epicId: "E2", ownerId: "alice", inSprint: false }],
  ]);
  const frames = new Map([
    ["S1", frame("S1", 0, 10)],
    ["S2", frame("S2", 0, 30)],
    ["S3", frame("S3", 1000, 10)],
  ]);

  it("orders clusters then frames within each cluster", () => {
    const order = buildPlanningNavigationOrder({
      grouping: "epic",
      frames,
      storyById,
      clusterOrder: ["E1", "E2"],
      filtersActive: false,
    });
    expect(order).toEqual(["S1", "S2", "S3"]);
  });

  it("restricts to filter matches across clusters", () => {
    const order = buildPlanningNavigationOrder({
      grouping: "epic",
      frames,
      storyById,
      clusterOrder: ["E1", "E2"],
      filtersActive: true,
      storyMatches: new Set(["S2", "S3"]),
    });
    expect(order).toEqual(["S2", "S3"]);
  });
});

describe("navigatePlanningItem", () => {
  const storyById = new Map([
    ["S1", { epicId: "E1", ownerId: "alice", inSprint: true }],
    ["S2", { epicId: "E1", ownerId: "bob", inSprint: true }],
    ["S3", { epicId: "E2", ownerId: "alice", inSprint: false }],
  ]);
  const frames = new Map([
    ["S1", frame("S1", 0, 10)],
    ["S2", frame("S2", 0, 30)],
    ["S3", frame("S3", 1000, 10)],
  ]);
  const base = {
    grouping: "epic" as const,
    frames,
    storyById,
    clusterOrder: ["E1", "E2"],
    filtersActive: false,
  };

  it("steps within a cluster and wraps into the next parent", () => {
    expect(navigatePlanningItem({ ...base, currentId: "S1", direction: 1 })?.id).toBe("S2");
    expect(navigatePlanningItem({ ...base, currentId: "S2", direction: 1 })?.id).toBe("S3");
    expect(navigatePlanningItem({ ...base, currentId: "S3", direction: 1 })?.id).toBe("S1");
  });

  it("skips non-matching items when a filter is active", () => {
    const filtered = {
      ...base,
      filtersActive: true,
      storyMatches: new Set(["S1", "S3"]),
    };
    expect(navigatePlanningItem({ ...filtered, currentId: "S1", direction: 1 })?.id).toBe("S3");
    expect(navigatePlanningItem({ ...filtered, currentId: "S3", direction: -1 })?.id).toBe("S1");
  });

  it("advances from a filtered-out current frame", () => {
    const filtered = {
      ...base,
      filtersActive: true,
      storyMatches: new Set(["S2", "S3"]),
    };
    expect(navigatePlanningItem({ ...filtered, currentId: "S1", direction: 1 })?.id).toBe("S2");
  });
});
