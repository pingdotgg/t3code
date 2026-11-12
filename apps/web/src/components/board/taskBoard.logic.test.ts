import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_PANELS,
  groupThreadsByPanel,
  moveBoardPanel,
  resetBoardColumnWeights,
  resolveBoardDropEdge,
  resolveBoardLayout,
  setBoardColumnWidth,
  setBoardPanelWeights,
  splitBoardPanelPair,
  toggleBoardPanelCollapsed,
  type BoardLayout,
  type BoardThread,
} from "./taskBoard.logic";

const NOW = "2026-01-01T12:00:00.000Z";

function thread(id: string, overrides: Partial<BoardThread> = {}): BoardThread & { id: string } {
  return {
    id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    archivedAt: null,
    settledOverride: null,
    pinnedAt: null,
    updatedAt: "2026-01-01T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    snoozedUntil: null,
    ...overrides,
  } as BoardThread & { id: string };
}

const ids = (threads: ReadonlyArray<{ id: string }>) => threads.map((t) => t.id);

describe("groupThreadsByPanel", () => {
  it("places threads by status, settled and snoozed taking precedence, and drops hidden ones", () => {
    const groups = groupThreadsByPanel(
      [
        thread("approval", { hasPendingApprovals: true }),
        thread("done"),
        thread("settled", { settledOverride: "settled", hasPendingApprovals: true }),
        thread("snoozed", { snoozedUntil: "2026-01-02T00:00:00.000Z" }),
        thread("archived", { archivedAt: "2026-01-01T00:00:00.000Z" }),
        thread("sub", {
          lineage: {
            parentThreadId: ThreadId.make("done"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("done"),
          },
        }),
      ],
      NOW,
    );
    expect(ids(groups.attention)).toEqual(["approval"]);
    expect(ids(groups.done)).toEqual(["done"]);
    expect(ids(groups.settled)).toEqual(["settled"]);
    expect(ids(groups.snoozed)).toEqual(["snoozed"]);
    expect(ids(groups.working)).toEqual([]);
  });

  it("orders pinned first, then newest update", () => {
    const groups = groupThreadsByPanel(
      [
        thread("old", { updatedAt: "2026-01-01T01:00:00.000Z" }),
        thread("new", { updatedAt: "2026-01-01T09:00:00.000Z" }),
        thread("pinned", { pinnedAt: NOW, updatedAt: "2025-12-01T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(ids(groups.done)).toEqual(["pinned", "new", "old"]);
  });
});

describe("board layout", () => {
  const layout = (
    columns: string[][],
    collapsed: string[] = [],
    weights: Record<string, number> = {},
    widths: Record<string, number> = {},
  ) => ({ columns, collapsed, weights, widths }) as BoardLayout;

  it("keeps a saved layout, ignoring unknown and repeated ids and appending new panels", () => {
    const resolved = resolveBoardLayout({
      columns: [["done", "gone"], ["working", "done"], ["gone"], ["attention", "failed"]],
      collapsed: ["failed", "gone", "failed"],
    });
    expect(resolved.columns).toEqual([
      ["done"],
      ["working"],
      ["attention", "failed"],
      ["waiting"],
      ["snoozed"],
      ["settled"],
    ]);
    expect(resolved.collapsed).toEqual(["failed"]);
    expect(resolved.weights).toEqual({});
    expect(resolveBoardLayout(null).columns).toEqual(BOARD_PANELS.map((panel) => [panel.id]));
  });

  it("keeps valid saved weights and drops unknown or non-positive ones", () => {
    const resolved = resolveBoardLayout({
      columns: [["done", "working"]],
      collapsed: [],
      weights: { done: 1.5, working: 0, gone: 2, failed: Number.NaN },
    });
    expect(resolved.weights).toEqual({ done: 1.5 });
  });

  it.each([
    [
      "left opens a column before the target",
      "d",
      [["a"], ["c"], ["b", "d"]],
      "c",
      "left",
      [["a"], ["d"], ["c"], ["b"]],
    ],
    [
      "right opens a column after the target",
      "a",
      [["a"], ["b"], ["c"]],
      "c",
      "right",
      [["b"], ["c"], ["a"]],
    ],
    ["top stacks above the target", "a", [["a"], ["b", "c"]], "c", "top", [["b", "a", "c"]]],
    [
      "bottom stacks below the target",
      "c",
      [["a"], ["b", "c"]],
      "a",
      "bottom",
      [["a", "c"], ["b"]],
    ],
    [
      "unstacking keeps the rest of the stack",
      "b",
      [["a", "b", "c"]],
      "a",
      "right",
      [["a", "c"], ["b"]],
    ],
    ["dropping on itself changes nothing", "a", [["a", "b"]], "a", "left", [["a", "b"]]],
  ] as const)("%s", (_name, moved, columns, target, edge, expected) => {
    const result = moveBoardPanel(
      layout(
        columns.map((column) => [...column]),
        ["b"],
      ),
      moved as never,
      { panelId: target as never, edge },
    );
    expect(result.columns).toEqual(expected);
    expect(result.collapsed).toEqual(["b"]);
  });

  it("toggles collapse without touching the order or weights", () => {
    const start = layout([["a", "b"]], [], { a: 2 });
    const collapsed = toggleBoardPanelCollapsed(start, "a" as never);
    expect(collapsed).toEqual(layout([["a", "b"]], ["a"], { a: 2 }));
    expect(toggleBoardPanelCollapsed(collapsed, "a" as never)).toEqual(start);
  });

  it.each([
    ["moves the boundary and keeps the combined weight", 50, [1.25, 0.75]],
    ["clamps the upper panel to the minimum", -500, [0.5, 1.5]],
    ["clamps the lower panel to the minimum", 500, [1.5, 0.5]],
  ] as const)("resizing a pair %s", (_name, delta, expected) => {
    const pair = { upperWeight: 1, lowerWeight: 1, upperHeight: 200, lowerHeight: 200 };
    expect(splitBoardPanelPair(pair, delta, 100)).toEqual(expected);
  });

  it("leaves a pair too short for two minimum heights unchanged", () => {
    const pair = { upperWeight: 2, lowerWeight: 1, upperHeight: 80, lowerHeight: 40 };
    expect(splitBoardPanelPair(pair, 20, 100)).toEqual([2, 1]);
  });

  it("stacking gives the newcomer an average share of the expanded panels it joins", () => {
    const start = layout([["a", "b", "c"], ["d"]], ["c"], { a: 3, b: 1, c: 5, d: 7 });
    const stacked = moveBoardPanel(start, "d" as never, { panelId: "b" as never, edge: "bottom" });
    expect(stacked.columns).toEqual([["a", "b", "d", "c"]]);
    expect(stacked.weights).toEqual({ a: 3, b: 1, c: 5, d: 2 });

    const unstacked = moveBoardPanel(stacked, "a" as never, {
      panelId: "b" as never,
      edge: "left",
    });
    expect(unstacked.columns).toEqual([["a"], ["b", "d", "c"]]);
    expect(unstacked.weights).toEqual({ b: 1, c: 5, d: 2 });

    const equal = moveBoardPanel(layout([["a", "b"], ["c"]], [], { c: 4 }), "c" as never, {
      panelId: "a" as never,
      edge: "top",
    });
    expect(equal.weights).toEqual({});
  });

  it("sets weights and resets only the column that holds a panel", () => {
    const start = layout([
      ["a", "b"],
      ["c", "d"],
    ]);
    const resized = setBoardPanelWeights(setBoardPanelWeights(start, { a: 1.5, b: 0.5 } as never), {
      c: 0.25,
      d: 1.75,
    } as never);
    expect(resized.weights).toEqual({ a: 1.5, b: 0.5, c: 0.25, d: 1.75 });
    expect(resetBoardColumnWeights(resized, "b" as never).weights).toEqual({ c: 0.25, d: 1.75 });
  });

  it("keeps saved column widths under the top panel, clamped to the allowed range", () => {
    const resolved = resolveBoardLayout({
      columns: [["done", "working"], ["failed"], ["waiting"]],
      collapsed: [],
      widths: { done: 400.4, working: 500, failed: 10, waiting: 9000, gone: 300 },
    });
    expect(resolved.widths).toEqual({ done: 400, failed: 224, waiting: 640 });
  });

  it("a column keeps its width when its top panel changes, and a new column starts at the default", () => {
    const start = setBoardColumnWidth(layout([["a", "b"], ["c"]]), "b" as never, 400);
    expect(start.widths).toEqual({ a: 400 });
    expect(setBoardColumnWidth(start, "a" as never, null).widths).toEqual({});
    const onTop = moveBoardPanel(start, "c" as never, { panelId: "a" as never, edge: "top" });
    expect(onTop.widths).toEqual({ c: 400 });
    const split = moveBoardPanel(start, "a" as never, { panelId: "c" as never, edge: "right" });
    expect(split.columns).toEqual([["b"], ["c"], ["a"]]);
    expect(split.widths).toEqual({ b: 400 });
  });

  it.each([
    [{ x: 10, y: 50 }, "left"],
    [{ x: 95, y: 50 }, "right"],
    [{ x: 50, y: 10 }, "top"],
    [{ x: 50, y: 90 }, "bottom"],
  ] as const)("a drop at %o lands on the %s edge", (point, edge) => {
    expect(resolveBoardDropEdge({ left: 0, top: 0, width: 100, height: 100 }, point)).toBe(edge);
  });
});
