import { describe, expect, it } from "vite-plus/test";

import {
  nextExpandedRuns,
  resolveRunInView,
  resolveWorkGroupScrollAnchor,
} from "./scrollAnchor.js";

describe("tool-group scroll anchors", () => {
  const data = Array.from({ length: 18 }, (_, index) => ({ id: `call-${index}` }));
  const state = { data, positionAtIndex: (index: number) => index * 33 };

  it("returns to the top after a fast flick even when the cached start is five rows behind", () => {
    const snapshot = { ...state, scroll: 0, start: 5 };
    expect(resolveWorkGroupScrollAnchor(snapshot)).toEqual({
      rowId: "call-0",
      offsetWithinRow: 0,
      scrollOffset: 0,
    });
  });
});

describe("runs a released reader is reading", () => {
  const rows = [
    { runId: "a" },
    { runId: "a" },
    { runId: "b" },
    { runId: null },
    { runId: "b" },
    { runId: "b" },
  ];
  const view = (scroll: number) => ({
    scroll,
    scrollLength: 100,
    positionAtIndex: (index: number) => index * 100,
  });

  it("finds the latest run when the view reaches its first row", () => {
    expect(resolveRunInView(rows, view(150), "b", (row) => row.runId)).toBe("b");
    expect(resolveRunInView(rows, view(400), "b", (row) => row.runId)).toBe("b");
  });

  it("ignores the latest run while the view is above it", () => {
    expect(resolveRunInView(rows, view(50), "b", (row) => row.runId)).toBeNull();
  });

  const running = { runId: "b", status: "running" };
  const completed = { runId: "b", status: "completed" };

  it("keeps a run open when it ends under the reader", () => {
    expect(nextExpandedRuns(new Set<string>(), running, completed, "b")).toEqual(new Set(["b"]));
    const none = new Set<string>();
    expect(nextExpandedRuns(none, running, completed, null)).toBe(none);
  });

  it("opens the reader's run's steer segments with it", () => {
    const folds = () => ["b", "b:steer:s1", "a:steer:s0"];
    expect(nextExpandedRuns(new Set<string>(), running, completed, "b", folds)).toEqual(
      new Set(["b", "b:steer:s1"]),
    );
    expect(
      nextExpandedRuns(
        new Set<string>(),
        running,
        { runId: "b", status: "interrupted" },
        null,
        folds,
      ),
    ).toEqual(new Set(["b"]));
  });

  it("opens an interrupted run wherever the reader is", () => {
    expect(
      nextExpandedRuns(new Set<string>(), running, { runId: "b", status: "interrupted" }, null),
    ).toEqual(new Set(["b"]));
  });

  it("closes the previous run when a newer one starts, unless the reader is still in it", () => {
    const open = new Set(["b"]);
    const next = { runId: "c", status: "running" };
    expect(nextExpandedRuns(open, completed, next, null)).toEqual(new Set());
    expect(nextExpandedRuns(open, completed, next, "b")).toBe(open);
  });
});
