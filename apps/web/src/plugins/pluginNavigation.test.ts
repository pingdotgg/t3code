import { PluginId, PluginRouteId } from "@t3tools/contracts";
import type { WsRpcClient } from "@t3tools/client-runtime";
import type { PluginUiFactory } from "@t3tools/plugin-api/ui";
import { describe, expect, it } from "vite-plus/test";

import {
  pluginAssetFactoryKey,
  resolvePluginRouteReadiness,
  type PluginAssetLifecycle,
  type PluginNavigationHostState,
} from "./pluginNavigation";
import { makePluginCatalogEntry } from "./testing/pluginPlacementFixtures";

const pluginId = PluginId.make("t3.navigation-test");
const routeId = PluginRouteId.make("main");
const hostScope = "primary";
const generation = 1;
const client = {} as WsRpcClient;
const factory = (() => ({
  routes: {},
})) satisfies PluginUiFactory;

const activeCatalogEntry = makePluginCatalogEntry({
  pluginId,
  name: "Navigation Test",
  placementId: "main",
  placementLabel: "Navigation Test",
  placementPosition: "sidebar.primary",
});

function hostState(patch: Partial<PluginNavigationHostState> = {}): PluginNavigationHostState {
  return {
    catalog: [activeCatalogEntry],
    catalogStatus: "ready",
    assets: new Map<string, PluginAssetLifecycle>([
      [
        pluginAssetFactoryKey(hostScope, generation, activeCatalogEntry),
        {
          status: "registered",
          pluginId,
          factory,
        },
      ],
    ]),
    client,
    hostScope,
    generation,
    ...patch,
  };
}

describe("pluginNavigation", () => {
  it("reports loading before the catalog or client is available", () => {
    expect(
      resolvePluginRouteReadiness({
        hostState: hostState({ catalog: [], catalogStatus: "loading" }),
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

  it("reports missing after an empty catalog has loaded", () => {
    expect(
      resolvePluginRouteReadiness({
        hostState: hostState({ catalog: [], catalogStatus: "ready" }),
        pluginId,
        routeId,
        surface: "app",
      }),
    ).toEqual({
      status: "missing",
      message: "Plugin t3.navigation-test was not found.",
    });
  });

  it("reports missing after catalog load failure", () => {
    expect(
      resolvePluginRouteReadiness({
        hostState: hostState({ catalog: [], catalogStatus: "failed" }),
        pluginId,
        routeId,
        surface: "app",
      }),
    ).toEqual({
      status: "missing",
      message: "Plugin catalog could not be loaded.",
    });
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
          assets: new Map<string, PluginAssetLifecycle>([
            [
              pluginAssetFactoryKey(hostScope, generation, activeCatalogEntry),
              {
                status: "failed",
                pluginId,
                message: "boom",
              },
            ],
          ]),
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

  it("does not use factories registered for a stale scope", () => {
    expect(
      resolvePluginRouteReadiness({
        hostState: hostState({
          assets: new Map<string, PluginAssetLifecycle>([
            [
              pluginAssetFactoryKey("old-scope", generation, activeCatalogEntry),
              {
                status: "registered",
                pluginId,
                factory,
              },
            ],
          ]),
        }),
        pluginId,
        routeId,
        surface: "app",
      }),
    ).toEqual({ status: "loading" });
  });

  it("does not use factories registered for a stale generation", () => {
    expect(
      resolvePluginRouteReadiness({
        hostState: hostState({
          assets: new Map<string, PluginAssetLifecycle>([
            [
              pluginAssetFactoryKey(hostScope, generation - 1, activeCatalogEntry),
              {
                status: "registered",
                pluginId,
                factory,
              },
            ],
          ]),
        }),
        pluginId,
        routeId,
        surface: "app",
      }),
    ).toEqual({ status: "loading" });
  });
});
