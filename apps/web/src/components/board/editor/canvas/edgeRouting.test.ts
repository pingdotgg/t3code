import { describe, expect, it } from "vite-plus/test";

import {
  classifyEdge,
  clearBottomForSpan,
  DETOUR_CLEARANCE,
  DETOUR_TRACK_GAP,
  edgeEndpointSides,
  packDetourLanes,
  routeDetour,
  routeEdge,
  type DetourSpan,
  type EdgeRect,
} from "./edgeRouting";

const rect = (x: number, y: number, width = 240, height = 140): EdgeRect => ({
  x,
  y,
  width,
  height,
});

const pathNumbers = (d: string): number[] => d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
const yNumbers = (d: string): number[] => pathNumbers(d).filter((_, index) => index % 2 === 1);

describe("classifyEdge", () => {
  it("classifies adjacent columns as forward", () => {
    expect(classifyEdge(rect(0, 0), rect(312, 0))).toEqual({ kind: "forward" });
  });

  it("classifies stacked lanes as vertical", () => {
    expect(classifyEdge(rect(0, 0), rect(0, 300))).toEqual({ kind: "vertical" });
  });

  it("classifies multi-column spans as a channel (local detour)", () => {
    expect(classifyEdge(rect(0, 0), rect(936, 0))).toEqual({ kind: "channel" });
  });

  it("classifies back-edges as a channel (local detour)", () => {
    expect(classifyEdge(rect(936, 0), rect(0, 0))).toEqual({ kind: "channel" });
  });
});

describe("edgeEndpointSides", () => {
  it("maps forward edges to right -> left", () => {
    expect(edgeEndpointSides(rect(0, 0), rect(312, 0))).toEqual({
      source: "right",
      target: "left",
    });
  });

  it("maps stacked lanes to their travel sides", () => {
    expect(edgeEndpointSides(rect(0, 0), rect(0, 300))).toEqual({
      source: "bottom",
      target: "top",
    });
  });

  it("maps channel detours through both bottoms", () => {
    expect(edgeEndpointSides(rect(936, 0), rect(0, 0))).toEqual({
      source: "bottom",
      target: "bottom",
    });
    expect(edgeEndpointSides(rect(0, 0), rect(936, 100))).toEqual({
      source: "bottom",
      target: "bottom",
    });
  });
});

describe("routeEdge (forward / vertical)", () => {
  it("fans out parallel forward edges across distinct ports", () => {
    const shared = { source: rect(0, 0), target: rect(312, 0), targetSlot: 0, targetCount: 1 };
    const first = routeEdge({ ...shared, sourceSlot: 0, sourceCount: 2 });
    const second = routeEdge({ ...shared, sourceSlot: 1, sourceCount: 2 });
    expect(pathNumbers(first.d)[1]).not.toBe(pathNumbers(second.d)[1]);
  });

  it("connects stacked lanes bottom-to-top", () => {
    const route = routeEdge({
      source: rect(0, 0, 240, 140),
      target: rect(0, 300, 240, 140),
      sourceSlot: 0,
      sourceCount: 1,
      targetSlot: 0,
      targetCount: 1,
    });
    const numbers = pathNumbers(route.d);
    expect(numbers[1]).toBe(140); // leaves source bottom
    expect(numbers.at(-1)).toBe(300); // enters target top
  });
});

describe("routeDetour", () => {
  it("runs along the assigned track and labels on that line", () => {
    const route = routeDetour({
      source: rect(936, 0),
      target: rect(0, 0),
      sourceSlot: 0,
      sourceCount: 1,
      targetSlot: 0,
      targetCount: 1,
      laneY: 220,
    });
    const ys = yNumbers(route.d);
    expect(Math.max(...ys)).toBe(220); // deepest point is the track
    expect(route.labelY).toBe(220); // pill sits on the track line
  });

  it("drops from the source bottom and rises to the target bottom", () => {
    const route = routeDetour({
      source: rect(0, 0, 240, 140),
      target: rect(600, 0, 240, 140),
      sourceSlot: 0,
      sourceCount: 1,
      targetSlot: 0,
      targetCount: 1,
      laneY: 220,
    });
    const numbers = pathNumbers(route.d);
    expect(numbers[1]).toBe(140); // M starts at source bottom
    expect(numbers.at(-1)).toBe(140); // L ends at target bottom
  });
});

describe("clearBottomForSpan", () => {
  it("returns the bottom-most card the run passes over", () => {
    const cards = [rect(0, 0, 240, 140), rect(300, 0, 240, 300), rect(900, 0, 240, 140)];
    // a run from x=120 to x=420 passes over the first two cards (the taller wins)
    expect(clearBottomForSpan(120, 420, cards)).toBe(300);
  });

  it("returns 0 when the run clears no cards", () => {
    expect(clearBottomForSpan(2000, 2200, [rect(0, 0)])).toBe(0);
  });
});

describe("packDetourLanes", () => {
  it("keeps a single detour at its own clearance (no bump)", () => {
    const { lanes, extent } = packDetourLanes([{ left: 0, right: 500, clearBottom: 140 }]);
    expect(lanes[0]).toBe(140 + DETOUR_CLEARANCE);
    expect(extent).toBe(140 + DETOUR_CLEARANCE);
  });

  it("stacks two overlapping detours into separate tracks", () => {
    const spans: DetourSpan[] = [
      { left: 0, right: 500, clearBottom: 140 },
      { left: 100, right: 600, clearBottom: 140 },
    ];
    const { lanes } = packDetourLanes(spans);
    expect(Math.abs(lanes[0]! - lanes[1]!)).toBe(DETOUR_TRACK_GAP);
  });

  it("lets non-overlapping detours share a track", () => {
    const spans: DetourSpan[] = [
      { left: 0, right: 200, clearBottom: 140 },
      { left: 900, right: 1100, clearBottom: 140 },
    ];
    const { lanes } = packDetourLanes(spans);
    expect(lanes[0]).toBe(lanes[1]);
  });
});
