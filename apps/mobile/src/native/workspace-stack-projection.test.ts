import * as NodeModule from "node:module";
import type { ParamListBase, StackNavigationState } from "@react-navigation/native";
import { describe, expect, it } from "vite-plus/test";

import {
  collapsedSplitTransition,
  nativeStackPopAction,
  nativeWorkspacePopAction,
  nativeWorkspacePopCount,
  projectWorkspaceStack,
  partitionStackPresentations,
  reconcileStackScreens,
  type CollapsedSplitColumn,
} from "./workspace-stack-projection";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter } = requireNavigation("@react-navigation/routers") as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
};

const home = { key: "home", name: "Home" };
const thread = { key: "thread", name: "Thread", params: { threadId: "draft-thread" } };
const files = { key: "files", name: "ThreadFiles", params: thread.params };
const settings = { key: "settings", name: "SettingsSheet" };
const legal = { key: "legal", name: "SettingsLegal" };

function history(
  routes: StackNavigationState<ParamListBase>["routes"],
): StackNavigationState<ParamListBase> {
  return {
    key: "router",
    type: "stack",
    stale: false,
    index: routes.length - 1,
    routeNames: ["Home", "Thread", "ThreadFiles", "SettingsSheet", "SettingsLegal"],
    routes,
    preloadedRoutes: [],
  };
}

describe("workspace router projection", () => {
  it("keeps workspace flows beside Home and restores them after a modal closes", () => {
    const draft = { key: "draft", name: "Thread", params: { draft: {} } };
    const modal = { key: "connect", name: "ConnectOnboarding" };
    const routes = [home, thread, draft, settings, legal];
    const isOverlay = (route: { name: string }) => route.name === "ConnectOnboarding";
    expect(projectWorkspaceStack(history([...routes, modal]), isOverlay)).toEqual({
      primary: home,
      detail: [thread, draft, settings, legal],
      overlays: [modal],
    });
    expect(projectWorkspaceStack(history(routes), isOverlay)).toEqual({
      primary: home,
      detail: [thread, draft, settings, legal],
      overlays: [],
    });
  });

  it("retains a cold-linked detail route without changing the router history", () => {
    const state = history([thread, files]);
    expect(projectWorkspaceStack(state, () => false)).toEqual({
      primary: undefined,
      detail: [thread, files],
      overlays: [],
    });
    expect(state.routes[0]).toBe(thread);
  });
});

describe("native workspace dismissal", () => {
  it("dismisses a sheet and its pushed pages without removing the underlying draft", () => {
    const state = history([home, thread, settings, legal]);
    const action = nativeWorkspacePopAction(state, settings.key)!;
    const next = StackRouter({}).getStateForAction(state, action, {
      routeNames: state.routeNames,
      routeParamList: {},
      routeGetIdList: {},
    });
    expect(next?.routes).toEqual([home, thread]);
    expect(next?.routes[1]).toBe(thread);
    expect(next?.index).toBe(1);
  });

  it("does not dismiss retained sheets beyond the active index", () => {
    const state = { ...history([home, thread, settings, legal]), index: 1 };
    expect(nativeWorkspacePopAction(state, settings.key)).toBeNull();
    expect(nativeWorkspacePopAction(state, legal.key)).toBeNull();
  });

  it("removes the descendants when UIKit dismisses their parent conversation", () => {
    expect(nativeWorkspacePopCount(history([home, thread, files]), thread.key)).toBe(2);
  });

  it("ignores delayed callbacks from JS removal and replacement", () => {
    expect(nativeWorkspacePopCount(history([home, thread]), files.key)).toBe(0);
    expect(
      nativeWorkspacePopCount(history([home, { ...thread, key: "replacement" }]), thread.key),
    ).toBe(0);
  });

  it("never removes the root or a route ahead of the active index", () => {
    const state = history([home, thread, files]);
    expect(nativeWorkspacePopCount(state, home.key)).toBe(0);
    expect(nativeWorkspacePopCount({ ...state, index: 1 }, files.key)).toBe(0);
  });
});

describe("native card pop handoff", () => {
  const routerOptions = {
    routeNames: history([home]).routeNames,
    routeParamList: {},
    routeGetIdList: {},
  };
  it("keeps a newly opened screen when an earlier swipe dismissal arrives late", () => {
    const state = history([home, thread, files, settings]);
    const next = StackRouter({}).getStateForAction(
      state,
      nativeStackPopAction(state, files.key)!,
      routerOptions,
    );
    expect(next?.routes).toEqual([home, thread, settings]);
    expect(next?.index).toBe(2);
    if (!next || next.stale !== false) throw new Error("Expected a rehydrated router history");
    expect(nativeStackPopAction(next, files.key)).toBeNull();
  });
  it("acknowledges a native pop to an earlier page without consuming a newer push", () => {
    const state = history([home, thread, files, settings]);
    const next = StackRouter({}).getStateForAction(
      state,
      nativeStackPopAction(state, files.key, home.key)!,
      routerOptions,
    );
    expect(next?.routes).toEqual([home, settings]);
    expect(next?.index).toBe(1);
  });
  it("allows reopening the same page after its destination finishes appearing", () => {
    const state = history([home, thread, files]);
    const router = StackRouter({});
    const popped = router.getStateForAction(
      state,
      nativeStackPopAction(state, files.key, thread.key)!,
      routerOptions,
    );
    if (!popped || popped.stale !== false) throw new Error("Expected a rehydrated router history");
    const reopened = router.getStateForAction(
      popped,
      { type: "NAVIGATE", payload: { name: files.name, params: files.params } },
      routerOptions,
    );
    expect(reopened?.routes.map((route) => route.name)).toEqual(["Home", "Thread", "ThreadFiles"]);
    expect(reopened?.routes.at(-1)?.key).not.toBe(files.key);
    if (!reopened || reopened.stale !== false)
      throw new Error("Expected a rehydrated router history");
    expect(nativeStackPopAction(reopened, files.key)).toBeNull();
  });
  it("leaves history intact when a swipe is cancelled or its source is already gone", () => {
    const state = history([home, thread, files]);
    expect(nativeStackPopAction(state, files.key, files.key)).toBeNull();
    expect(nativeStackPopAction(state, files.key, settings.key)).toBeNull();
    expect(nativeStackPopAction(state, home.key)).toBeNull();
    expect(nativeStackPopAction({ ...state, index: 1 }, files.key)).toBeNull();
  });
});

describe("collapsed split Back", () => {
  const routerOptions = {
    routeNames: history([home]).routeNames,
    routeParamList: {},
    routeGetIdList: {},
  };
  type Appearance = "willAppear" | "didAppear" | "willDisappear";
  // UIKit's appearance callbacks for one collapsed transition, against the router at each step.
  function replay(
    steps: ReadonlyArray<readonly [Appearance, string, StackNavigationState<ParamListBase>]>,
  ) {
    let column: CollapsedSplitColumn = { visible: "secondary", leaving: null };
    let pop: ReturnType<typeof nativeStackPopAction> = null;
    for (const [type, key, state] of steps) {
      const transition = collapsedSplitTransition(column, { type, key }, state, home.key);
      column = transition.column;
      pop ??= transition.pop;
    }
    return { visible: column.visible, pop };
  }

  it("returns the router to the list so the next selection opens a new detail", () => {
    const state = history([home, thread]);
    const back = replay([
      ["willDisappear", thread.key, state],
      ["willAppear", home.key, state],
      ["didAppear", home.key, state],
    ]);
    expect(back.visible).toBe("primary");
    const router = StackRouter({});
    const listed = router.getStateForAction(state, back.pop!, routerOptions);
    expect(listed?.routes).toEqual([home]);
    if (!listed || listed.stale !== false) throw new Error("Expected a rehydrated router history");
    const select = {
      type: "NAVIGATE",
      payload: { name: "Thread", params: { threadId: "next" } },
    } as const;
    expect(router.getStateForAction(listed, select, routerOptions)?.routes[1]?.key).not.toBe(
      thread.key,
    );
    // Left on the hidden detail, the selection would only rename it and never show the column.
    expect(router.getStateForAction(state, select, routerOptions)?.routes[1]?.key).toBe(thread.key);
  });

  it("clears every detail while keeping a presentation opened during the Back animation", () => {
    const leaving = history([home, thread, files]);
    const presented = history([home, thread, files, settings]);
    const { pop } = replay([
      ["willDisappear", files.key, leaving],
      ["didAppear", home.key, presented],
    ]);
    expect(StackRouter({}).getStateForAction(presented, pop!, routerOptions)?.routes).toEqual([
      home,
      settings,
    ]);
  });

  it("keeps the detail when it appears again before the list finishes appearing", () => {
    const state = history([home, thread]);
    const cancelledSwipe = replay([
      ["willDisappear", thread.key, state],
      ["willAppear", home.key, state],
      ["willAppear", thread.key, state],
      ["didAppear", thread.key, state],
    ]);
    expect(cancelledSwipe).toEqual({ visible: "secondary", pop: null });
    expect(
      replay([
        ["willDisappear", thread.key, state],
        ["willAppear", thread.key, state],
        ["didAppear", home.key, state],
      ]).pop,
    ).toBeNull();
  });

  it("does not mistake JS navigation or a cold link for native Back", () => {
    const pushed = history([home, thread, files]);
    expect(
      replay([
        ["willDisappear", thread.key, pushed],
        ["didAppear", files.key, pushed],
      ]),
    ).toEqual({ visible: "secondary", pop: null });
    const presented = history([home, thread, settings]);
    expect(
      replay([
        ["willDisappear", thread.key, presented],
        ["didAppear", home.key, presented],
      ]).pop,
    ).toBeNull();
    const popped = history([home]);
    expect(
      replay([
        ["willDisappear", thread.key, popped],
        ["didAppear", home.key, popped],
      ]).pop,
    ).toBeNull();
    // A linked thread whose list appears first still needs its detail column shown.
    expect(replay([["didAppear", home.key, history([home, thread])]])).toEqual({
      visible: "primary",
      pop: null,
    });
  });
});

describe("v5 stack handoff", () => {
  it("releases a completed native pop when the router acknowledges it", () => {
    const completed = new Set([files.key]);
    expect(reconcileStackScreens([home, thread, files], [home, thread, files], completed)).toEqual([
      home,
      thread,
      files,
    ]);
    expect(reconcileStackScreens([home, thread, files], [home, thread], completed)).toEqual([
      home,
      thread,
    ]);
  });
  it("still retains an unfinished JS pop beside a completed native pop", () => {
    expect(reconcileStackScreens([home, thread, files], [home], new Set([files.key]))).toEqual([
      home,
      thread,
    ]);
  });
  it("retains removed native screens through a pop followed immediately by a push", () => {
    const popped = reconcileStackScreens([home, thread, files], [home, thread]);
    const next = { ...files, key: "new-files" };
    const screens = reconcileStackScreens(popped, [home, thread, next]);
    expect(screens.map((route) => route.key)).toEqual(["home", "thread", "files", "new-files"]);
    expect(screens.filter((route) => [home, thread, next].includes(route))).toEqual([
      home,
      thread,
      next,
    ]);
    expect(screens[2]).toBe(files);
  });
  it("keeps the root and outgoing settings page in place until the JS pop finishes", () => {
    const environments = { ...files, key: "environments", name: "SettingsEnvironments" };
    const popped = reconcileStackScreens([settings, environments], [settings]);
    expect(popped).toEqual([settings, environments]);
    expect(reconcileStackScreens(popped, [settings])).toEqual(popped);
    const next = { ...environments, key: "next-environments" };
    expect(reconcileStackScreens(popped, [settings, next])).toEqual([settings, environments, next]);
    expect(reconcileStackScreens(popped, [settings], new Set([environments.key]))).toEqual([
      settings,
    ]);
  });
  // regression: #17231 keep native screens ordered during stack pops
  it("retains a multi-page pop in order without changing the active router order", () => {
    const replacement = { ...thread, key: "replacement" };
    const screens = reconcileStackScreens([home, thread, files], [home, replacement]);
    expect(screens).toEqual([home, thread, files, replacement]);
    expect(screens.filter((route) => route === home || route === replacement)).toEqual([
      home,
      replacement,
    ]);
  });
  it("updates params without retaining duplicate copies of the same screen", () => {
    const updated = { ...thread, params: { threadId: "another-thread" } };
    expect(reconcileStackScreens([home, thread], [home, updated])).toEqual([home, updated]);
  });
  it("keeps card pushes inside the modal they belong to", () => {
    const secondModal = { ...settings, key: "another-settings" };
    expect(
      partitionStackPresentations(
        [home, thread, settings, legal, secondModal],
        (route) => route.name === "SettingsSheet",
      ),
    ).toEqual([[home, thread], [settings, legal], [secondModal]]);
  });
});
