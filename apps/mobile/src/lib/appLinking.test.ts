import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

import type { NavigationState } from "@react-navigation/native";
import { restoreSettingsLinkState } from "../features/settings/settings-navigation";
import {
  findLinkedRoute,
  findStackRoute,
  restoreDraftLinkState,
  runningAppLinkAction,
  shouldHandleAppLink,
  updateLinkedRoute,
} from "./appLinking";

const requireFromNative = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const requireFromCore = NodeModule.createRequire(
  requireFromNative.resolve("@react-navigation/core/package.json"),
);
const { getActionFromState, getStateFromPath } = requireFromNative("@react-navigation/core") as {
  readonly getActionFromState: typeof import("@react-navigation/native").getActionFromState;
  readonly getStateFromPath: typeof import("@react-navigation/native").getStateFromPath;
};
const { StackRouter } = requireFromCore("@react-navigation/routers") as {
  readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
};

describe("shouldHandleAppLink", () => {
  it.each(["t3code://", "t3code:///", "t3code-dev://", "t3code-preview://"])(
    "ignores scheme-only URL %s",
    (url) => {
      expect(shouldHandleAppLink(url, true)).toBe(false);
    },
  );

  it.each([
    "t3code://threads/env-1/thread-1",
    "t3code://pair?pairingUrl=x",
    "t3code-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url, true)).toBe(true);
  });

  it.each(["t3code://expo-development-client/?url=x", "t3code://expo-sharing/anything"])(
    "ignores lifecycle URL %s",
    (url) => {
      expect(shouldHandleAppLink(url, true)).toBe(false);
    },
  );
});

describe("cloud-only deep links", () => {
  it.each([
    "t3code://connect-onboarding",
    "t3code-dev://connect-onboarding/?source=x",
    "t3code://settings/waitlist",
    "t3code://settings/auth",
    "exp://192.168.1.2:8081/--/settings/auth",
  ])("ignores %s without cloud config", (url) => {
    expect(shouldHandleAppLink(url, false)).toBe(false);
    expect(shouldHandleAppLink(url, true)).toBe(true);
  });

  it.each([
    "t3code://settings",
    "t3code://settings/authors",
    "t3code://pair?next=settings/auth",
    "t3code://threads/env/thread/files/scripts/connect-onboarding",
    "t3code://new/draft/files/settings/auth",
    "exp://192.168.1.2:8081/--/threads/env/thread/files/settings/waitlist",
  ])("still handles %s without cloud config", (url) => {
    expect(shouldHandleAppLink(url, false)).toBe(true);
  });
});

describe("draft deep links", () => {
  it("opens the old draft URL on the thread screen with its draft identity", () => {
    const draft = { projectId: "project-1", environmentId: "env-1", draftId: "draft-1" };
    expect(
      restoreDraftLinkState(
        { routes: [{ name: "Home" }, { name: "Thread", params: draft }] },
        "/new/draft?draftId=draft-1",
      ),
    ).toEqual({
      index: 1,
      routes: [{ name: "Home" }, { name: "Thread", params: { draft } }],
    });
  });

  it.each([
    ["environment", "NewTaskEnvironment"],
    ["branch", "NewTaskBranch"],
    ["files", "NewTaskFiles"],
    ["files/src/index.ts", "NewTaskFile"],
    ["attachments/attachment-1", "NewTaskAttachment"],
    ["settings", "NewTaskThreadSettings"],
  ])("restores a draft beneath its %s screen", (path, name) => {
    const params = { environmentId: "env-1", projectId: "project-1" };
    const target = { name, params };
    expect(
      restoreDraftLinkState({ routes: [{ name: "Home" }, target] }, `/new/draft/${path}`),
    ).toEqual({
      index: 2,
      routes: [{ name: "Home" }, { name: "Thread", params: { draft: params } }, target],
    });
  });

  it("leaves live-thread and project-selection links unchanged", () => {
    const state = { routes: [{ name: "Thread", params: { threadId: "thread-1" } }] };
    expect(restoreDraftLinkState(state, "/threads/env-1/thread-1")).toBe(state);
    expect(restoreDraftLinkState(state, "/new")).toBe(state);
    expect(restoreDraftLinkState(undefined, "/new/draft")).toBeUndefined();
  });
});

describe("nested link routes", () => {
  const settingsLink = {
    routes: [
      { name: "Home" },
      {
        name: "SettingsSheet",
        state: {
          routes: [
            { name: "Settings" },
            { name: "SettingsEnvironmentNew", params: { pairingUrl: "x", autoConnect: "1" } },
          ],
        },
      },
    ],
  };

  it("finds a route the link opens inside a nested navigator", () => {
    expect(findLinkedRoute(settingsLink, ["SettingsEnvironmentNew"])?.params).toEqual({
      pairingUrl: "x",
      autoConnect: "1",
    });
    expect(findLinkedRoute(settingsLink, ["ConnectionsNew"])).toBeUndefined();
  });

  it("rewrites a nested route without touching the rest of the state", () => {
    const next = updateLinkedRoute(settingsLink, ["SettingsEnvironmentNew"], (route) => ({
      ...route,
      params: { pairingUrl: "x" },
    }));
    expect(findLinkedRoute(next, ["SettingsEnvironmentNew"])?.params).toEqual({ pairingUrl: "x" });
    expect(next?.routes[0]).toBe(settingsLink.routes[0]);
    expect(updateLinkedRoute(settingsLink, ["ConnectionsNew"], (route) => route)).toBe(
      settingsLink,
    );
  });
});

describe("findStackRoute", () => {
  const stack = (key: string, routes: NavigationState["routes"]) =>
    ({
      key,
      index: routes.length - 1,
      routeNames: routes.map((route) => route.name),
      routes,
      stale: false,
      type: "stack",
    }) as NavigationState;

  it("finds a nested screen with the navigator that holds it", () => {
    const root = stack("root", [
      { key: "home", name: "Home" },
      {
        key: "settings",
        name: "Settings",
        state: stack("settings-stack", [{ key: "new-task", name: "NewTaskProject" }]),
      },
    ]);
    expect(findStackRoute(root, "NewTaskProject")).toEqual({
      navigatorKey: "settings-stack",
      routeKey: "new-task",
      focused: true,
    });
  });

  it("reports whether the screen is its navigator's focused route", () => {
    const covered = stack("root", [
      { key: "new-task", name: "NewTaskProject" },
      { key: "add-project", name: "AddProject" },
    ]);
    expect(findStackRoute(covered, "NewTaskProject")?.focused).toBe(false);
    expect(findStackRoute(covered, "AddProject")?.focused).toBe(true);
  });

  it("prefers the top-most screen and reports a missing one", () => {
    const root = stack("root", [
      { key: "first", name: "NewTaskProject" },
      { key: "second", name: "NewTaskProject" },
    ]);
    expect(findStackRoute(root, "NewTaskProject")?.routeKey).toBe("second");
    expect(findStackRoute(root, "Thread")).toBeUndefined();
  });
});

describe("links that arrive while the app runs", () => {
  const linking = {
    initialRouteName: "Home",
    screens: {
      Home: "",
      Thread: { path: "threads/:environmentId?/:threadId?", alias: ["new/draft"] },
      NewTaskFiles: "new/draft/files",
      Settings: "settings",
      SettingsAbout: "settings/about",
      SettingsUsage: "settings/usage",
    },
  };
  const router = StackRouter({});
  const options = {
    routeNames: Object.keys(linking.screens),
    routeParamList: {},
    routeGetIdList: {},
  };
  const open = (...names: string[]) =>
    router.getRehydratedState(
      { index: names.length - 1, routes: names.map((name) => ({ name })) },
      options,
    );

  // The running app's link handling: parse as App.tsx does, then dispatch on the root stack.
  function follow(root: ReturnType<typeof open>, path: string) {
    const link = restoreSettingsLinkState(
      restoreDraftLinkState(getStateFromPath(path, linking), path),
      undefined,
    )!;
    const action = runningAppLinkAction(link, root, getActionFromState(link, linking))!;
    const next = router.getStateForAction(root, { target: root.key, ...action }, options);
    if (!next) throw new Error(`Root stack rejected ${action.type}`);
    // React Navigation rehydrates a partial state a RESET leaves behind.
    return router.getRehydratedState(next as typeof root, options);
  }

  it.each([
    ["settings/about", ["Home", "Settings", "SettingsAbout"]],
    ["new/draft/files?environmentId=env-1&projectId=project-1", ["Home", "Thread", "NewTaskFiles"]],
  ])("%s opens its page over the live workspace instead of replacing it", (path, names) => {
    const root = open("Home");
    const next = follow(root, path);
    expect(next.routes.map((route) => route.name)).toEqual(names);
    expect({ stack: next.key, home: next.routes[0]?.key }).toEqual({
      stack: root.key,
      home: root.routes[0]?.key,
    });
  });

  it("a draft page link keeps the open draft it names", () => {
    const root = follow(open("Home"), "new/draft?environmentId=env-1&projectId=project-1");
    const next = follow(root, "new/draft/files?environmentId=env-1&projectId=project-1");
    expect(next.routes.map((route) => route.name)).toEqual(["Home", "Thread", "NewTaskFiles"]);
    expect(next.routes.slice(0, 2).map((route) => route.key)).toEqual(
      root.routes.slice(0, 2).map((route) => route.key),
    );
  });

  it("a repeated settings link reopens its page so the link's params apply again", () => {
    const root = follow(open("Home"), "settings/usage?tab=limits");
    const next = follow(root, "settings/usage?tab=limits");
    expect(next.routes.map((route) => route.name)).toEqual(["Home", "Settings", "SettingsUsage"]);
    expect(next.routes.slice(0, 2).map((route) => route.key)).toEqual(
      root.routes.slice(0, 2).map((route) => route.key),
    );
    expect(next.routes[2]?.key).not.toBe(root.routes[2]?.key);
  });

  it("a bare settings link over an open Settings page goes back to the Settings tab", () => {
    const root = open("Home", "Settings", "SettingsAbout");
    const next = follow(root, "settings");
    expect(next.routes.map((route) => route.name)).toEqual(["Home", "Settings"]);
    expect(next.routes.map((route) => route.key)).toEqual(
      root.routes.slice(0, 2).map((route) => route.key),
    );
  });
});
