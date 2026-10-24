import * as NodeModule from "node:module";
import type { StackRouter as StackRouterType } from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

function loadRouters() {
  const require = NodeModule.createRequire(import.meta.url);
  const requireFromNative = NodeModule.createRequire(
    require.resolve("@react-navigation/native/package.json"),
  );
  const requireFromCore = NodeModule.createRequire(
    requireFromNative.resolve("@react-navigation/core/package.json"),
  );
  return requireFromCore("@react-navigation/routers") as {
    readonly CommonActions: typeof import("@react-navigation/native").CommonActions;
    readonly StackActions: typeof import("@react-navigation/native").StackActions;
    readonly StackRouter: typeof StackRouterType;
  };
}

vi.mock("@react-navigation/native", () => {
  const { CommonActions, StackActions } = loadRouters();
  return { CommonActions, StackActions };
});

import { settingsSectionNavigationAction } from "./settings-section-navigation";

function setup() {
  const { StackRouter, CommonActions, StackActions } = loadRouters();
  const router = StackRouter({ initialRouteName: "Settings" });
  const options = {
    routeNames: [
      "Settings",
      "SettingsAppearance",
      "SettingsEnvironments",
      "SettingsEnvironmentDetail",
    ],
    routeParamList: {},
    routeGetIdList: {},
  };
  const initial = router.getInitialState(options);
  const apply = (state: typeof initial, action: Parameters<typeof router.getStateForAction>[1]) => {
    const next = router.getStateForAction(state, action, options);
    expect(next).not.toBeNull();
    return router.getRehydratedState(next!, options);
  };
  return { initial, apply, CommonActions, StackActions };
}

describe("Settings category navigation", () => {
  it("switches categories without retaining the previous category's detail history", () => {
    const { initial, apply, CommonActions, StackActions } = setup();
    const environments = apply(initial, CommonActions.navigate("SettingsEnvironments"));
    const detail = apply(
      environments,
      CommonActions.navigate("SettingsEnvironmentDetail", { environmentId: "demo" }),
    );
    const appearance = apply(
      detail,
      settingsSectionNavigationAction(detail, "SettingsAppearance")!,
    );
    expect(appearance.routes.map((route) => route.name)).toEqual([
      "Settings",
      "SettingsAppearance",
    ]);
    expect(appearance.routes[0]?.key).toBe(initial.routes[0]?.key);
    const back = apply(appearance, StackActions.pop());
    expect(back.routes.map((route) => route.name)).toEqual(["Settings"]);
    expect(back.index).toBe(0);
  });

  it("returns to the selected category while preserving its route and parameters", () => {
    const { initial, apply, CommonActions } = setup();
    const environments = apply(
      initial,
      CommonActions.navigate("SettingsEnvironments", { selection: "demo" }),
    );
    const detail = apply(
      environments,
      CommonActions.navigate("SettingsEnvironmentDetail", { environmentId: "demo" }),
    );
    const selected = apply(
      detail,
      settingsSectionNavigationAction(detail, "SettingsEnvironments")!,
    );
    expect(selected.routes).toEqual(environments.routes);
    expect(selected.index).toBe(1);
  });
});
