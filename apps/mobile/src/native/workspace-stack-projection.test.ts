import * as NodeModule from "node:module";
import type { ParamListBase, StackNavigationState } from "@react-navigation/native";
import { describe, expect, it } from "vite-plus/test";

import {
  nativeWorkspacePopAction,
  nativeWorkspacePopCount,
  projectWorkspaceStack,
  partitionStackPresentations,
  reconcileStackScreens,
} from "./workspace-stack-projection";

// Load the same router as native navigation without importing React Native into Node.
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
    const draft = { key: "draft", name: "NewTaskSheet" };
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
