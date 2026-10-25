import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadSelectionNavigationAction,
  resolveThreadSelectionOverlayState,
} from "./adaptive-navigation";

describe("resolveThreadSelectionNavigationAction", () => {
  it("retains the draft screen despite its query-shaped path", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/threads?draft=local",
        workspaceRouteName: "Thread",
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
});

describe("resolveThreadSelectionOverlayState", () => {
  const stack = {
    key: "workspace",
    type: "stack",
    stale: false as const,
    routeNames: ["Home", "Thread", "ThreadFiles", "Connections", "SettingsLegal"],
  };
  const home = { key: "home", name: "Home" };
  const thread = {
    key: "thread",
    name: "Thread",
    params: { environmentId: "environment", threadId: "old-thread" },
  };
  const files = { key: "files", name: "ThreadFiles", params: thread.params };
  const settings = { key: "settings", name: "Connections" };
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
});

it("replacing a draft underneath an overlay removes its draft identity", () => {
  const result = resolveThreadSelectionOverlayState({
    state: {
      key: "root",
      type: "stack",
      stale: false,
      routeNames: ["Thread", "Connections"],
      index: 1,
      routes: [
        { key: "draft", name: "Thread", params: { draft: { draftId: "old" } } },
        { key: "settings", name: "Connections" },
      ],
    },
    workspaceRouteKey: "draft",
    action: "set-params",
    params: { environmentId: "env", threadId: "live" },
  });
  expect(result?.routes[0]?.params).toEqual({ environmentId: "env", threadId: "live" });
});
