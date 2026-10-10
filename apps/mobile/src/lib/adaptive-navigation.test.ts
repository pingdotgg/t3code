import { describe, expect, it } from "vite-plus/test";

import {
  isBaseThreadRoute,
  resolveFileSelectionNavigationAction,
  resolveThreadSelectionNavigationAction,
  resolveThreadSelectionOverlayState,
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

describe("resolveThreadSelectionOverlayState", () => {
  const stack = {
    key: "workspace",
    type: "stack",
    stale: false as const,
    routeNames: ["Home", "Thread", "ThreadFiles", "SettingsSheet", "SettingsLegal"],
  };
  const home = { key: "home", name: "Home" };
  const thread = {
    key: "thread",
    name: "Thread",
    params: { environmentId: "environment", threadId: "old-thread" },
  };
  const files = { key: "files", name: "ThreadFiles", params: thread.params };
  const settings = { key: "settings", name: "SettingsSheet" };
  const params = { environmentId: "environment", threadId: "new-thread" };

  it("replaces the underlying file route and dismisses every overlay above it", () => {
    expect(
      resolveThreadSelectionOverlayState({
        state: {
          ...stack,
          index: 4,
          routes: [home, thread, files, settings, { key: "legal", name: "SettingsLegal" }],
        },
        workspaceRouteKey: files.key,
        action: "replace",
        params,
      }),
    ).toEqual({ ...stack, index: 2, routes: [home, thread, { name: "Thread", params }] });
  });

  it("dismisses an overlay when selecting the current thread without replacing its route key", () => {
    expect(
      resolveThreadSelectionOverlayState({
        state: { ...stack, index: 2, routes: [home, thread, settings] },
        workspaceRouteKey: thread.key,
        action: "set-params",
        params: thread.params,
      }),
    ).toEqual({ ...stack, index: 1, routes: [home, thread] });
  });

  it.each([home, files])(
    "keeps $name in the back stack when pushing from beneath a sheet",
    (route) => {
      expect(
        resolveThreadSelectionOverlayState({
          state: { ...stack, index: 1, routes: [route, settings] },
          workspaceRouteKey: route.key,
          action: "push",
          params,
        }),
      ).toEqual({ ...stack, index: 1, routes: [route, { name: "Thread", params }] });
    },
  );

  it("leaves ordinary thread selection alone when no overlay is present", () => {
    expect(
      resolveThreadSelectionOverlayState({
        state: { ...stack, index: 2, routes: [home, thread, files] },
        workspaceRouteKey: files.key,
        action: "replace",
        params,
      }),
    ).toBeNull();
  });
});
