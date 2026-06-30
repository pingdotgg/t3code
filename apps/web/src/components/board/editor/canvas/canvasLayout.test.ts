import { describe, expect, it } from "vite-plus/test";

import type { WorkflowDefinitionEncoded } from "@t3tools/contracts";

import { computeCanvasLayout, LANE_CARD_WIDTH, LANE_GAP_X, LANE_GAP_Y } from "./canvasLayout";

const definition = {
  name: "Delivery",
  lanes: [
    { key: "queue", name: "Queue", entry: "manual", on: { success: "run" } },
    {
      key: "run",
      name: "Run",
      entry: "auto",
      pipeline: [{ key: "review", type: "approval" }],
      on: { success: "done", failure: "needs" },
    },
    { key: "needs", name: "Needs", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
} satisfies WorkflowDefinitionEncoded;

const COLUMN = LANE_CARD_WIDTH + LANE_GAP_X;

describe("canvasLayout", () => {
  it("layers lanes by routing depth and stacks same-depth lanes vertically", () => {
    const layout = computeCanvasLayout(definition, 400, {
      queue: 120,
      run: 180,
      needs: 100,
      done: 100,
    });

    expect(layout.lanes.map((lane) => [lane.laneKey, lane.x, lane.y, lane.width])).toEqual([
      ["queue", 0, 0, LANE_CARD_WIDTH],
      ["run", COLUMN, 0, LANE_CARD_WIDTH],
      ["needs", COLUMN * 2, 0, LANE_CARD_WIDTH],
      ["done", COLUMN * 2, 100 + LANE_GAP_Y, LANE_CARD_WIDTH],
    ]);
    expect(layout.height).toBe(100 + LANE_GAP_Y + 100);
    // The canvas grows horizontally past the container instead of wrapping
    // and destroying the topology.
    expect(layout.width).toBe(COLUMN * 2 + LANE_CARD_WIDTH);
  });

  it("ignores loops when layering", () => {
    const looping = {
      name: "Loop",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual", on: { success: "run" } },
        {
          key: "run",
          name: "Run",
          entry: "auto",
          transitions: [{ when: { "<": [{ var: "lane.runCount" }, 3] }, to: "run" }],
          on: { success: "done" },
          actions: [{ label: "Back", to: "queue" }],
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    } as never as WorkflowDefinitionEncoded;

    const layout = computeCanvasLayout(looping, 400, { queue: 100, run: 100, done: 100 });
    expect(layout.lanes.map((lane) => [lane.laneKey, lane.x])).toEqual([
      ["queue", 0],
      ["run", COLUMN],
      ["done", COLUMN * 2],
    ]);
  });

  it("honors per-lane position overrides and leaves other lanes in their slots", () => {
    const layout = computeCanvasLayout(
      definition,
      400,
      { queue: 120, run: 180, needs: 100, done: 100 },
      { run: { x: 600, y: 400 } },
    );

    expect(layout.lanes.map((lane) => [lane.laneKey, lane.x, lane.y])).toEqual([
      ["queue", 0, 0],
      ["run", 600, 400],
      ["needs", COLUMN * 2, 0],
      ["done", COLUMN * 2, 100 + LANE_GAP_Y],
    ]);
  });

  it("keeps a dropped lane exactly at its drop point, and reserves detour depth below", () => {
    // A back-edge (run -> queue) now routes as a local detour below the cards,
    // so the layout reserves extra height below the card band instead of
    // insetting the lanes from the top.
    const looping = {
      name: "Loop",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual", on: { success: "run" } },
        { key: "mid", name: "Mid", entry: "manual", on: { success: "run" } },
        { key: "run", name: "Run", entry: "auto", on: { failure: "queue" } },
      ],
    } as never as WorkflowDefinitionEncoded;
    const heights = { queue: 100, mid: 100, run: 100 };

    const initial = computeCanvasLayout(looping, 1200, heights);
    const run = initial.lanes.find((lane) => lane.laneKey === "run");
    // mid stacks below queue (col 0, row 1); the back-edge detour reserves below.
    const cardBand = 100 + LANE_GAP_Y + 100;
    expect(initial.height).toBeGreaterThan(cardBand);
    // Lanes are NOT inset from the top — the card band starts at y = 0.
    expect(Math.min(...initial.lanes.map((lane) => lane.y))).toBe(0);

    // Simulate a drag: the drop handler stores rendered position + delta.
    const dropped = { x: (run?.x ?? 0) + 30, y: (run?.y ?? 0) + 40 };
    const next = computeCanvasLayout(looping, 1200, heights, { run: dropped });
    const moved = next.lanes.find((lane) => lane.laneKey === "run");
    expect(moved?.x).toBe(dropped.x);
    expect(moved?.y).toBe(dropped.y);

    // Re-laying out with the same override stays byte-stable (no creep).
    const again = computeCanvasLayout(looping, 1200, heights, { run: dropped });
    expect(again.lanes.find((lane) => lane.laneKey === "run")?.y).toBe(dropped.y);
  });

  it("expands the canvas bounds to fit a lane moved beyond the layout", () => {
    const layout = computeCanvasLayout(
      definition,
      LANE_CARD_WIDTH,
      { queue: 120, run: 180, needs: 100, done: 100 },
      { done: { x: 900, y: 700 } },
    );

    expect(layout.width).toBeGreaterThanOrEqual(900 + LANE_CARD_WIDTH);
    expect(layout.height).toBeGreaterThanOrEqual(700 + 100);
  });
});
