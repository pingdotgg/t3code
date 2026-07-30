import { describe, expect, it } from "vite-plus/test";

import {
  isBaseThreadRoute,
  resolveFileSelectionNavigationAction,
  resolveThreadSelectionNavigationAction,
  resolveWorkspaceDetailInvalidationAction,
  shouldInvalidateSelectedThreadDetail,
} from "./adaptive-navigation";

describe("isBaseThreadRoute", () => {
  it("recognizes only the thread detail route", () => {
    expect(isBaseThreadRoute("/threads/environment/thread")).toBe(true);
    expect(isBaseThreadRoute("/threads/environment/thread/")).toBe(true);
    expect(isBaseThreadRoute("/threads/environment/thread/files")).toBe(false);
    expect(isBaseThreadRoute("/threads/environment/thread/review")).toBe(false);
  });
});

describe("resolveThreadSelectionNavigationAction", () => {
  it("updates params when a persistent sidebar selects a peer thread", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/threads/environment/thread",
      }),
    ).toBe("set-params");
  });

  it("replaces nested thread content when a persistent sidebar selects a peer", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/threads/environment/thread/files/path",
      }),
    ).toBe("replace");
  });

  it("pushes from Home so the back stack survives collapsing to compact", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/",
      }),
    ).toBe("push");
  });

  it("pushes compact list selections onto the native stack", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: false,
        pathname: "/threads/environment/thread",
      }),
    ).toBe("push");
  });
});

describe("resolveFileSelectionNavigationAction", () => {
  it("replaces the wide file browser with the selected preview", () => {
    expect(resolveFileSelectionNavigationAction({ hasPersistentFileInspector: true })).toBe(
      "replace",
    );
  });

  it("pushes a preview above the compact file browser", () => {
    expect(resolveFileSelectionNavigationAction({ hasPersistentFileInspector: false })).toBe(
      "push",
    );
  });
});

describe("shouldInvalidateSelectedThreadDetail", () => {
  const active = {
    key: "environment:thread-a",
    present: true,
    settled: false,
    snoozed: false,
  } as const;

  it("invalidates when the selected shell is removed", () => {
    expect(
      shouldInvalidateSelectedThreadDetail({
        previous: active,
        current: { ...active, present: false },
      }),
    ).toBe(true);
  });

  it("invalidates when the selected shell becomes settled", () => {
    expect(
      shouldInvalidateSelectedThreadDetail({
        previous: active,
        current: { ...active, settled: true },
      }),
    ).toBe(true);
  });

  it("invalidates when the selected shell becomes snoozed", () => {
    expect(
      shouldInvalidateSelectedThreadDetail({
        previous: active,
        current: { ...active, snoozed: true },
      }),
    ).toBe(true);
  });

  it("preserves detail while the selected shell initially loads", () => {
    expect(
      shouldInvalidateSelectedThreadDetail({
        previous: { ...active, present: false },
        current: active,
      }),
    ).toBe(false);
  });

  it("preserves detail when selecting an already-settled thread", () => {
    expect(
      shouldInvalidateSelectedThreadDetail({
        previous: active,
        current: {
          key: "environment:thread-b",
          present: true,
          settled: true,
          snoozed: false,
        },
      }),
    ).toBe(false);
  });

  it("preserves detail when the selected shell remains active", () => {
    expect(
      shouldInvalidateSelectedThreadDetail({
        previous: active,
        current: active,
      }),
    ).toBe(false);
  });
});

describe("resolveWorkspaceDetailInvalidationAction", () => {
  const overlays = new Set(["SettingsSheet", "NewTaskSheet", "GitOverview"]);

  it("removes the thread route without dismissing a root overlay", () => {
    expect(
      resolveWorkspaceDetailInvalidationAction({
        routes: [
          { key: "home", name: "Home" },
          { key: "thread", name: "Thread" },
          { key: "settings", name: "SettingsSheet" },
        ],
        overlayRouteNames: overlays,
      }),
    ).toEqual({ type: "pop", count: 1, source: "thread" });
  });

  it("removes the whole thread workspace stack below an overlay", () => {
    expect(
      resolveWorkspaceDetailInvalidationAction({
        routes: [
          { key: "home", name: "Home" },
          { key: "thread", name: "Thread" },
          { key: "files", name: "ThreadFiles" },
          { key: "new-task", name: "NewTaskSheet" },
        ],
        overlayRouteNames: overlays,
      }),
    ).toEqual({ type: "pop", count: 2, source: "files" });
  });

  it("resets a deep-linked workspace route while preserving overlays", () => {
    expect(
      resolveWorkspaceDetailInvalidationAction({
        routes: [
          { key: "thread", name: "Thread" },
          { key: "git", name: "GitOverview" },
        ],
        overlayRouteNames: overlays,
      }),
    ).toEqual({
      type: "reset",
      routes: [{ name: "Home" }, { key: "git", name: "GitOverview" }],
    });
  });

  it("removes a deep-linked workspace stack while preserving overlays", () => {
    expect(
      resolveWorkspaceDetailInvalidationAction({
        routes: [
          { key: "thread", name: "Thread" },
          { key: "files", name: "ThreadFiles" },
          { key: "settings", name: "SettingsSheet" },
        ],
        overlayRouteNames: overlays,
      }),
    ).toEqual({
      type: "reset",
      routes: [{ name: "Home" }, { key: "settings", name: "SettingsSheet" }],
    });
  });

  it("does nothing when the underlying workspace is already home", () => {
    expect(
      resolveWorkspaceDetailInvalidationAction({
        routes: [
          { key: "home", name: "Home" },
          { key: "settings", name: "SettingsSheet" },
        ],
        overlayRouteNames: overlays,
      }),
    ).toBeNull();
  });
});
