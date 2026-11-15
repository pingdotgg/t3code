import { describe, expect, it } from "vite-plus/test";

import {
  closeTabs,
  cycleTab,
  EMPTY_WORKSPACE_TABS,
  moveTab,
  neighborAfterClose,
  openSplit,
  otherTabKeys,
  reopenClosedTab,
  sanitizeWorkspaceTabs,
  tabKeysToRight,
  togglePinnedTab,
  visitTab,
  type WorkspaceTabsState,
} from "./workspaceTabs.logic";

const open = (...keys: string[]): WorkspaceTabsState =>
  keys.reduce((state, key) => visitTab(state, key), EMPTY_WORKSPACE_TABS);
const keys = (state: WorkspaceTabsState) => state.tabs.map((tab) => tab.key);

describe("workspace tabs", () => {
  it("adds a visited thread once, at the end, and evicts the oldest unpinned tab past the cap", () => {
    expect(keys(visitTab(open("a", "b"), "a"))).toEqual(["a", "b"]);
    const pinned = togglePinnedTab(open("p"), "p");
    const full = Array.from({ length: 25 }, (_, index) => `t${index}`).reduce(
      (state, key) => visitTab(state, key),
      pinned,
    );
    expect(keys(full)).toHaveLength(25);
    expect(keys(full)[0]).toBe("p");
    expect(keys(full)).not.toContain("t0");
  });

  it("closes to the next tab, else the previous, and remembers closed tabs for reopening", () => {
    const state = open("a", "b", "c");
    expect(neighborAfterClose(state, "b")).toBe("c");
    expect(neighborAfterClose(state, "c")).toBe("b");
    expect(neighborAfterClose(open("a"), "a")).toBeNull();
    expect(neighborAfterClose(open("a", "b", "c", "d"), "b", ["b", "c", "d"])).toBe("a");

    const closed = closeTabs(closeTabs(state, ["a"]), ["c"]);
    expect(keys(closed)).toEqual(["b"]);
    const first = reopenClosedTab(closed);
    expect(first.key).toBe("c");
    const second = reopenClosedTab(first.state);
    expect(second.key).toBe("a");
    expect(keys(second.state)).toEqual(["b", "c", "a"]);
    expect(reopenClosedTab(second.state).key).toBeNull();
  });

  it("keeps pinned tabs first and closes only unpinned tabs as others or to the right", () => {
    const state = togglePinnedTab(open("a", "b", "c", "d"), "c");
    expect(keys(state)).toEqual(["c", "a", "b", "d"]);
    expect(otherTabKeys(state, "b")).toEqual(["a", "d"]);
    expect(tabKeysToRight(state, "a")).toEqual(["b", "d"]);
    expect(keys(togglePinnedTab(state, "c"))).toEqual(["c", "a", "b", "d"]);
    expect(togglePinnedTab(state, "c").tabs[0]?.pinned).toBe(false);
  });

  it("reorders within a group but not across the pinned boundary", () => {
    const state = togglePinnedTab(open("a", "b", "c"), "a");
    expect(keys(moveTab(state, "c", "b"))).toEqual(["a", "c", "b"]);
    expect(moveTab(state, "c", "a")).toBe(state);
  });

  it("cycles with wraparound", () => {
    const state = open("a", "b", "c");
    expect(cycleTab(state, "c", 1)).toBe("a");
    expect(cycleTab(state, "a", -1)).toBe("c");
    expect(cycleTab(state, null, 1)).toBe("a");
    expect(cycleTab(EMPTY_WORKSPACE_TABS, null, 1)).toBeNull();
  });

  it("splits beside another thread and drops the split when that tab closes", () => {
    const state = openSplit(open("a"), "b", "a");
    expect(state.split).toEqual({ key: "b", ratio: 0.5 });
    expect(keys(state)).toEqual(["a", "b"]);
    expect(openSplit(state, "a", "a")).toBe(state);
    expect(closeTabs(state, ["b"]).split).toBeNull();
  });

  it("restores only valid persisted state", () => {
    expect(
      sanitizeWorkspaceTabs({
        tabs: [{ key: "a" }, { key: "b", pinned: true }, { key: "a" }, { key: 3 }, null],
        closed: ["x", 5],
        split: { key: "a", ratio: 2 },
      }),
    ).toEqual({
      tabs: [
        { key: "b", pinned: true },
        { key: "a", pinned: false },
      ],
      closed: ["x"],
      split: { key: "a", ratio: 0.75 },
    });
    expect(
      sanitizeWorkspaceTabs({ tabs: [], split: { key: "gone", ratio: 0.5 } }).split,
    ).toBeNull();
    expect(sanitizeWorkspaceTabs("junk")).toEqual(EMPTY_WORKSPACE_TABS);
  });
});
