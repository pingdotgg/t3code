import { describe, expect, it } from "vite-plus/test";
import {
  initialWorkspaceTabsState,
  workspaceTabsReducer,
  workspaceTabForNativeSlot,
  resolveWorkspaceTabOrder,
  workspaceSearchBottomClearance,
  workspaceDockBottomClearance,
  workspaceUsesColumns,
} from "./workspace-tabs-state";

describe("compact list clearance", () => {
  it.each([
    { bottomInset: 34, keyboardHeight: 300, clearance: 380 },
    { bottomInset: 34, keyboardHeight: 0, clearance: 114 },
    { bottomInset: 34, keyboardHeight: 20, clearance: 114 },
  ])("keeps the last result above the keyboard and dock: %j", ({ clearance, ...input }) => {
    expect(workspaceDockBottomClearance(input)).toBe(clearance);
  });
});

describe("Duo list clearance", () => {
  it.each([18, 60])(
    "scrolls the last row above search with a %s-point native bar inset",
    (bottomBarInset) => {
      const clearance = workspaceSearchBottomClearance({
        bottomInset: 34,
        bottomBarInset,
        keyboardHeight: 0,
      });
      expect(clearance).toBe(bottomBarInset + 48 + 16);
    },
  );

  it("keeps the last row above search when the keyboard lifts the field", () => {
    expect(
      workspaceSearchBottomClearance({ bottomInset: 34, bottomBarInset: 18, keyboardHeight: 300 }),
    ).toBe(300 + 8 + 48 + 16);
  });

  it("falls back to the field's safe-area spacing before native bar metrics arrive", () => {
    expect(workspaceSearchBottomClearance({ bottomInset: 34, keyboardHeight: 0 })).toBe(
      34 + 48 + 16,
    );
    expect(workspaceSearchBottomClearance({ bottomInset: 0, keyboardHeight: 0 })).toBe(
      12 + 48 + 16,
    );
  });
});

describe("workspace root navigation", () => {
  it("pairs Settings, chats and pull requests with a detail column, and keeps Usage one page", () => {
    expect(workspaceUsesColumns("usage")).toBe(false);
    expect(workspaceUsesColumns("usage", true)).toBe(true);
    expect(workspaceUsesColumns("threads")).toBe(true);
    expect(workspaceUsesColumns("pullRequests")).toBe(true);
  });

  it("keeps the registered defaults while customization is unavailable", () => {
    expect(resolveWorkspaceTabOrder(undefined)).toEqual(["threads", "pullRequests", "usage"]);
    expect(resolveWorkspaceTabOrder(["home", "usage", "issues", "threads"])).toEqual(
      resolveWorkspaceTabOrder(undefined),
    );
  });

  it("retains separate queries and positions across tabs, and cancels only the current search", () => {
    let state = initialWorkspaceTabsState();
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 640 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "keyboard" });
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 160 });
    state = workspaceTabsReducer(state, { type: "expand" });
    state = workspaceTabsReducer(state, { type: "select", tab: "pullRequests" });
    expect(state.tabs.pullRequests.query).toBe("");
    state = workspaceTabsReducer(state, { type: "scroll", tab: "pullRequests", offset: 240 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "navigation" });
    state = workspaceTabsReducer(state, { type: "select", tab: "threads" });
    expect(state.tabs.threads).toMatchObject({
      query: "keyboard",
      scrollOffset: 160,
      searchMode: "expanded",
    });
    state = workspaceTabsReducer(state, { type: "cancel" });
    expect(state.tabs.threads).toMatchObject({
      query: "",
      scrollOffset: 640,
      searchMode: "resting",
    });
    expect(state.tabs.pullRequests).toMatchObject({
      query: "navigation",
      scrollOffset: 240,
      searchMode: "active",
    });
  });

  it("clear keeps search active without losing the position cancel restores", () => {
    let state = initialWorkspaceTabsState();
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 500 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "diff" });
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 80 });
    state = workspaceTabsReducer(state, { type: "query", query: "" });
    state = workspaceTabsReducer(state, { type: "search" });
    expect(state.tabs.threads).toMatchObject({
      query: "",
      searchMode: "active",
      searchEntryOffset: 500,
    });
    expect(workspaceTabsReducer(state, { type: "cancel" }).tabs.threads.scrollOffset).toBe(500);
  });

  it("keeps the Settings search apart from the tab Settings opened over", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), {
      type: "query",
      query: "diff",
      tab: "threads",
    });
    state = workspaceTabsReducer(state, { type: "search", tab: "settings" });
    state = workspaceTabsReducer(state, { type: "query", query: "theme", tab: "settings" });
    expect(state.tabs.settings).toMatchObject({ query: "theme", searchMode: "active" });
    state = workspaceTabsReducer(state, { type: "cancel", tab: "settings" });
    expect(state.tabs.settings).toMatchObject({ query: "", searchMode: "resting" });
    expect(state.tabs.threads.query).toBe("diff");
  });

  it("a late native blur cannot reopen a cancelled search", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
    state = workspaceTabsReducer(state, { type: "cancel" });
    expect(workspaceTabsReducer(state, { type: "expand" })).toBe(state);
  });

  it("a blur from the previous native tab cannot open search in the selected tab", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "keyboard" });
    state = workspaceTabsReducer(state, { type: "select", tab: "pullRequests" });
    state = workspaceTabsReducer(state, { type: "expand", tab: "threads" });
    expect(state.tabs.threads).toMatchObject({ query: "keyboard", searchMode: "expanded" });
    expect(state.tabs.pullRequests.searchMode).toBe("resting");
    expect(workspaceTabsReducer(state, { type: "select", tab: "pullRequests" })).toBe(state);
  });
  it("returns from Usage without losing list state", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), {
      type: "query",
      query: "retained",
      tab: "threads",
    });
    for (const tab of ["usage"] as const) {
      state = workspaceTabsReducer(state, { type: "select", tab });
      expect(state.selectedTab).toBe(tab);
      expect(workspaceTabsReducer(state, { type: "search" })).toBe(state);
    }
    state = workspaceTabsReducer(state, { type: "select", tab: "threads" });
    expect(state.tabs.threads.query).toBe("retained");
  });
  it("opens Settings on native reselection instead of selecting its overflow section", () => {
    const order = ["threads", "pullRequests", "usage"] as const;
    expect(workspaceTabForNativeSlot(order, "settings")).toBe("settings");
    expect(workspaceTabForNativeSlot(order, "first")).toBe("threads");
    expect(workspaceTabForNativeSlot(order, "third")).toBe("usage");
    expect(workspaceTabForNativeSlot(order, "removed")).toBeNull();
  });
});
