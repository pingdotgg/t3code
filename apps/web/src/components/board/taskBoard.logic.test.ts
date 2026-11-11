import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_PANELS,
  groupThreadsByPanel,
  moveBoardPanel,
  resolveBoardDropEdge,
  resolveBoardLayout,
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
  const layout = (columns: string[][], collapsed: string[] = []) =>
    ({ columns, collapsed }) as BoardLayout;

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
    expect(resolveBoardLayout(null).columns).toEqual(BOARD_PANELS.map((panel) => [panel.id]));
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

  it("toggles collapse without touching the order", () => {
    const start = layout([["a"], ["b"]]);
    const collapsed = toggleBoardPanelCollapsed(start, "a" as never);
    expect(collapsed).toEqual(layout([["a"], ["b"]], ["a"]));
    expect(toggleBoardPanelCollapsed(collapsed, "a" as never)).toEqual(start);
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
