import { describe, expect, it, vi } from "vite-plus/test";

// The store binds its persist storage at import, and Node has no localStorage.
vi.hoisted(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
});

import { snapSplitRatio, useWorkspaceTabsStore } from "./workspaceTabsStore";

function setup() {
  useWorkspaceTabsStore.setState({ keys: ["a", "b"], split: null });
  return useWorkspaceTabsStore.getState();
}

describe("workspace split", () => {
  it("opens a split on a tab, swaps its thread, resizes and closes it", () => {
    const store = setup();
    store.openSplit("c", "right");
    expect(useWorkspaceTabsStore.getState()).toMatchObject({
      keys: ["a", "b", "c"],
      split: { key: "c", direction: "right", ratio: 0.5 },
    });

    store.setSplitKey("a");
    store.setSplitRatio(0.95);
    expect(useWorkspaceTabsStore.getState().split).toEqual({
      key: "a",
      direction: "right",
      ratio: 0.8,
    });

    store.openSplit("b", "down");
    expect(useWorkspaceTabsStore.getState().split).toEqual({
      key: "b",
      direction: "down",
      ratio: 0.8,
    });

    store.closeSplit();
    expect(useWorkspaceTabsStore.getState().split).toBeNull();
  });

  it("closes the split with its tab, and only then", () => {
    const store = setup();
    store.openSplit("b", "right");
    store.close("a");
    expect(useWorkspaceTabsStore.getState().split?.key).toBe("b");
    store.close("b");
    expect(useWorkspaceTabsStore.getState()).toMatchObject({ keys: [], split: null });
  });

  it("snaps a dragged handle to thirds and the middle within 12px", () => {
    expect(snapSplitRatio(0.51, 1000)).toEqual({ ratio: 0.5, snapped: true });
    expect(snapSplitRatio(0.34, 600)).toEqual({ ratio: 1 / 3, snapped: true });
    expect(snapSplitRatio(0.6, 1000)).toEqual({ ratio: 0.6, snapped: false });
    expect(snapSplitRatio(0.05, 1000)).toEqual({ ratio: 0.2, snapped: false });
  });
});
