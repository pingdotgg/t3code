import { describe, expect, it, vi } from "vite-plus/test";
import { act, createElement, createContext, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceRootScreen } from "./WorkspaceRootScreen.android";
import {
  initialWorkspaceTabsState,
  workspaceTabsReducer,
  shouldRestoreNativeSearch,
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

  it("keeps an empty search closed after iOS closes it with only a blur", () => {
    const opened = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
    const closed = workspaceTabsReducer(opened, { type: "expand" });
    const filtered = workspaceTabsReducer(closed, { type: "query", query: "skia" });

    expect(shouldRestoreNativeSearch(closed.tabs.threads, false)).toBe(false);
    expect(shouldRestoreNativeSearch(closed.tabs.threads, true)).toBe(true);
    expect(shouldRestoreNativeSearch(filtered.tabs.threads, false)).toBe(true);
    expect(shouldRestoreNativeSearch(opened.tabs.threads, false)).toBe(true);
    expect(shouldRestoreNativeSearch(initialWorkspaceTabsState().tabs.threads, true)).toBe(false);
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

const mocks = vi.hoisted(() => ({ split: false, floating: false }));

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAndroidFloatingTabs: () => mocks.floating,
}));
vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaInsetsContext: createContext({ top: 0, right: 0, bottom: 24, left: 0 }),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }),
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: mocks.split },
    startNewTask: () => undefined,
  }),
}));
vi.mock("./navigation-tabs", () => ({
  useEnabledNavigationTabs: () => ["threads", "pullRequests", "usage"],
}));
vi.mock("./WorkspaceTabsContext", () => ({
  WorkspaceTabsContext: createContext(null),
  useWorkspaceTabs: () => ({ state: { selectedTab: "usage" } }),
}));
vi.mock("./WorkspaceExtraTab", () => ({
  WorkspaceExtraTab: function UsageProbe() {
    const [tab, setTab] = useState("Limits");
    return createElement("button", { onClick: () => setTab("Usage") }, tab);
  },
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ fabClearance: 64, scale: 1, fabSize: 56 }),
}));
vi.mock("../home/HomeRouteScreen", () => ({ HomeRouteScreen: () => null }));
vi.mock("../pull-requests/PullRequestFilterMenuContext", () => ({
  PullRequestFilterMenuProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("../pull-requests/PullRequestsScreen", () => ({ PullRequestsScreen: () => null }));
vi.mock("../pull-requests/PullRequestToolbar.android", () => ({ PullRequestToolbar: () => null }));
vi.mock("./AndroidWorkspaceNavigation", () => ({
  AndroidWorkspaceNavigation: () => null,
  FloatingWorkspaceTabs: () => null,
}));
vi.mock("./WorkspaceNoTabs", () => ({ WorkspaceNoTabs: () => null }));

function setup(split: boolean, floating: boolean) {
  mocks.split = split;
  mocks.floating = floating;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return { [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "keeps the Usage page mounted through layout transitions (split: %s, floating: %s)",
  async (split, floating) => {
    using _actEnvironment = setup(split, floating);
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    await act(async () => root.render(createElement(WorkspaceRootScreen)));

    const button = container.querySelector("button")!;
    await act(async () => button.click());
    expect(button.textContent).toBe("Usage");

    for (const nextSplit of [!split, split, !split, split]) {
      mocks.split = nextSplit;
      await act(async () => root.render(createElement(WorkspaceRootScreen)));
      expect(container.querySelector("button")?.textContent).toBe("Usage");
      expect(container.querySelector("button")).toBe(button);
    }
  },
);
