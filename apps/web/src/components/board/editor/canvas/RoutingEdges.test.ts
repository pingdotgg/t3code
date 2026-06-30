import { describe, expect, it } from "vite-plus/test";

import type { WorkflowDefinitionEncoded } from "@t3tools/contracts";

import { computeCanvasLayout } from "./canvasLayout";
import { classifyEdge } from "./edgeRouting";
import { channelRoutedEdgeIds, deriveRoutingEdges, layoutLabels } from "./RoutingEdges";

// A long forward span (a -> far) routes as a local detour. Lane "a" has three
// route edges (success/failure/blocked) plus intermediate lanes so the span
// crosses several columns.
const definition = {
  name: "Spanning",
  lanes: [
    {
      key: "a",
      name: "A",
      entry: "manual",
      on: { success: "far", failure: "far", blocked: "far" },
    },
    { key: "b", name: "B", entry: "manual", on: { success: "c" } },
    { key: "c", name: "C", entry: "manual", on: { success: "far" } },
    { key: "far", name: "Far", entry: "manual", terminal: true },
  ],
} as never as WorkflowDefinitionEncoded;

const laneRect = (layout: ReturnType<typeof computeCanvasLayout>, laneKey: string) => {
  const lane = layout.lanes.find((candidate) => candidate.laneKey === laneKey)!;
  return { x: lane.x, y: lane.y, width: lane.width, height: lane.estimatedHeight };
};

describe("channelRoutedEdgeIds", () => {
  it("flags multi-column spans as channel (local detour) edges", () => {
    const layout = computeCanvasLayout(definition, 1400);
    const edges = deriveRoutingEdges(definition);
    const channelIds = channelRoutedEdgeIds(edges, layout);
    // The three a -> far route edges should all route through a local detour.
    expect(channelIds.size).toBeGreaterThanOrEqual(3);

    const source = laneRect(layout, "a");
    const target = laneRect(layout, "far");
    expect(classifyEdge(source, target).kind).toBe("channel");
  });
});

describe("layoutLabels", () => {
  it("leaves a non-overlapping label at its position", () => {
    const positions = layoutLabels([{ id: "only", x: 100, y: 200, w: 60 }]);
    expect(positions.get("only")).toEqual({ x: 100, y: 200 });
  });

  it("pushes an overlapping label down onto its own track", () => {
    const positions = layoutLabels([
      { id: "build", x: 300, y: 400, w: 80 },
      { id: "retry", x: 320, y: 400, w: 80 }, // overlaps build horizontally, same y
    ]);
    const build = positions.get("build")!;
    const retry = positions.get("retry")!;
    // x is preserved; the second label is staggered below the first.
    expect(retry.x).toBe(320);
    expect(retry.y).toBeGreaterThan(build.y);
  });

  it("keeps far-apart labels on the same line", () => {
    const positions = layoutLabels([
      { id: "left", x: 0, y: 300, w: 60 },
      { id: "right", x: 900, y: 300, w: 60 },
    ]);
    expect(positions.get("left")!.y).toBe(positions.get("right")!.y);
  });
});
