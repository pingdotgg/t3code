import { describe, expect, it } from "vite-plus/test";

import {
  resolveCompactThreadSelectionOverlayState,
  resolveFileSelectionNavigationAction,
} from "./adaptive-navigation";

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

describe("resolveCompactThreadSelectionOverlayState", () => {
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

  it.each([home, files])(
    "keeps $name in the back stack when pushing from beneath a sheet",
    (route) => {
      expect(
        resolveCompactThreadSelectionOverlayState({
          state: { ...stack, index: 1, routes: [route, settings] },
          workspaceRouteKey: route.key,
          params,
        }),
      ).toEqual({ ...stack, index: 1, routes: [route, { name: "Thread", params }] });
    },
  );

  it("leaves ordinary thread selection alone when no overlay is present", () => {
    expect(
      resolveCompactThreadSelectionOverlayState({
        state: { ...stack, index: 2, routes: [home, thread, files] },
        workspaceRouteKey: files.key,
        params,
      }),
    ).toBeNull();
  });
});
