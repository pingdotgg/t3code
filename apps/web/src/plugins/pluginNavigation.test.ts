import { PluginId, PluginRouteId } from "@t3tools/contracts";
import type { WsRpcClient } from "@t3tools/client-runtime";
import type { PluginUiFactory } from "@t3tools/plugin-api/ui";
import { describe, expect, it } from "vite-plus/test";

import { resolvePluginRouteReadiness, type PluginNavigationHostState } from "./pluginNavigation";
import { makePluginCatalogEntry } from "./testing/pluginPlacementFixtures";

const pluginId = PluginId.make("t3.navigation-test");
const routeId = PluginRouteId.make("main");
const client = {} as WsRpcClient;
const factory = (() => ({
  routes: {},
})) satisfies PluginUiFactory;

function hostState(patch: Partial<PluginNavigationHostState> = {}): PluginNavigationHostState {
  return {
    catalog: [
      makePluginCatalogEntry({
        pluginId,
        name: "Navigation Test",
        placementId: "main",
        placementLabel: "Navigation Test",
        placementPosition: "sidebar.primary",
      }),
    ],
    factories: new Map<string, PluginUiFactory>([[pluginId, factory]]),
    loadErrors: new Map<string, string>(),
    client,
    ...patch,
  };
}

describe("pluginNavigation", () => {
  it("reports loading before the catalog or client is available", () => {
    expect(
      resolvePluginRouteReadiness({
        hostState: hostState({ catalog: [] }),
        pluginId,
        routeId,
        surface: "app",
      }),
    ).toEqual({ status: "loading" });

    expect(
      resolvePluginRouteReadiness({
        hostState: hostState({ client: null }),
        pluginId,
        routeId,
        surface: "app",
      }),
    ).toEqual({ status: "loading" });
  });

  it("reports failed, disabled, missing, and wrong-surface routes", () => {
    expect(
      resolvePluginRouteReadiness({
        hostState: hostState({
          catalog: [
            makePluginCatalogEntry({
              pluginId,
              name: "Navigation Test",
              placementId: "main",
              placementLabel: "Navigation Test",
              placementPosition: "sidebar.primary",
              status: "failed",
            }),
          ],
        }),
        pluginId,
        routeId,
        surface: "app",
      }).status,
    ).toBe("failed");

    expect(
      resolvePluginRouteReadiness({
        hostState: hostState({
          catalog: [
            makePluginCatalogEntry({
              pluginId,
              name: "Navigation Test",
              placementId: "main",
              placementLabel: "Navigation Test",
              placementPosition: "sidebar.primary",
              status: "disabled",
            }),
          ],
        }),
        pluginId,
        routeId,
        surface: "app",
      }),
    ).toEqual({
      status: "missing",
      message: "Plugin t3.navigation-test is disabled.",
    });

    expect(
      resolvePluginRouteReadiness({
        hostState: hostState(),
        pluginId,
        routeId: PluginRouteId.make("missing"),
        surface: "app",
      }),
    ).toEqual({
      status: "missing",
      message: "Plugin route missing was not found.",
    });

    expect(
      resolvePluginRouteReadiness({
        hostState: hostState(),
        pluginId,
        routeId,
        surface: "settings",
      }),
    ).toEqual({
      status: "missing",
      message: "Plugin route main is not available on the settings surface.",
    });
  });

  it("reports load errors and ready route projections", () => {
    expect(
      resolvePluginRouteReadiness({
        hostState: hostState({
          factories: new Map<string, PluginUiFactory>(),
          loadErrors: new Map<string, string>([[pluginId, "boom"]]),
        }),
        pluginId,
        routeId,
        surface: "app",
      }),
    ).toEqual({
      status: "missing",
      message: "boom",
    });

    const readiness = resolvePluginRouteReadiness({
      hostState: hostState(),
      pluginId,
      routeId,
      surface: "app",
    });

    expect(readiness.status).toBe("ready");
    if (readiness.status === "ready") {
      expect(readiness.catalogEntry.manifest.id).toBe(pluginId);
      expect(readiness.route.id).toBe(routeId);
      expect(readiness.factory).toBe(factory);
      expect(readiness.client).toBe(client);
    }
  });
});
