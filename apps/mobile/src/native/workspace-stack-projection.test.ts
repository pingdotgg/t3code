import type { ParamListBase, StackNavigationState } from "@react-navigation/native";
import { describe, expect, it } from "vite-plus/test";

import {
  nativeWorkspacePopCount,
  projectWorkspaceStack,
  partitionStackPresentations,
  reconcileStackScreens,
} from "./workspace-stack-projection";

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
  it("keeps the thread and file history in the detail column when a modal is opened", () => {
    const state = history([home, thread, files, settings, legal]);
    const projection = projectWorkspaceStack(state, (route) => route.name === "SettingsSheet");
    expect(projection).toEqual({
      primary: home,
      detail: [thread, files],
      overlays: [settings, legal],
    });
    expect(projection.detail[0]).toBe(thread);
    expect(state.routes).toEqual([home, thread, files, settings, legal]);
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

  it("restores the empty detail column after Back reaches the thread list", () => {
    expect(projectWorkspaceStack(history([home]), () => false)).toEqual({
      primary: home,
      detail: [],
      overlays: [],
    });
  });
});

describe("native workspace dismissal", () => {
  it("pops a native dismissed file while keeping the conversation and its draft mounted", () => {
    expect(nativeWorkspacePopCount(history([home, thread, files]), files.key)).toBe(1);
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

describe("v5 stack handoff", () => {
  it("retains removed native screens through a pop followed immediately by a push", () => {
    const popped = reconcileStackScreens([home, thread, files], [home, thread]);
    const next = { ...files, key: "new-files" };
    const screens = reconcileStackScreens(popped, [home, thread, next]);
    expect(screens.map((route) => route.key)).toEqual(["files", "home", "thread", "new-files"]);
    expect(screens.filter((route) => [home, thread, next].includes(route))).toEqual([
      home,
      thread,
      next,
    ]);
    expect(screens[0]).toBe(files);
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
