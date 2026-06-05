import { PluginId, PluginRouteId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getActivePluginPlacementEntries,
  isPluginPlacementPathActive,
  pluginPlacementKey,
  resolvePluginPlacementPath,
  resolvePluginPlacementRouteTarget,
} from "./pluginPlacements";
import { makePluginCatalogEntry } from "./testing/pluginPlacementFixtures";

describe("pluginPlacements", () => {
  it("filters active placements by fixed position and applies stable ordering", () => {
    const entries = getActivePluginPlacementEntries(
      [
        makePluginCatalogEntry({
          pluginId: "t3.zeta",
          name: "Zeta",
          placementId: "main",
          placementLabel: "Zeta",
          placementPosition: "sidebar.primary",
          order: 2,
        }),
        makePluginCatalogEntry({
          pluginId: "t3.alpha",
          name: "Alpha",
          placementId: "main",
          placementLabel: "Alpha",
          placementPosition: "sidebar.primary",
          order: 1,
        }),
        makePluginCatalogEntry({
          pluginId: "t3.footer",
          name: "Footer",
          placementId: "main",
          placementLabel: "Footer",
          placementPosition: "sidebar.footer",
          order: 0,
        }),
        makePluginCatalogEntry({
          pluginId: "t3.failed",
          name: "Failed",
          placementId: "main",
          placementLabel: "Failed",
          placementPosition: "sidebar.primary",
          status: "failed",
        }),
      ],
      "sidebar.primary",
    );

    expect(entries.map((entry) => entry.catalogEntry.manifest.id)).toEqual(["t3.alpha", "t3.zeta"]);
  });

  it("resolves app and settings placement paths", () => {
    const [appEntry] = getActivePluginPlacementEntries(
      [
        makePluginCatalogEntry({
          pluginId: "t3.app",
          name: "App",
          placementId: "main",
          placementLabel: "App",
          placementPosition: "commandPalette.actions",
          routeSurface: "app",
        }),
      ],
      "commandPalette.actions",
    );
    const [settingsEntry] = getActivePluginPlacementEntries(
      [
        makePluginCatalogEntry({
          pluginId: "t3.settings",
          name: "Settings",
          placementId: "settings",
          placementLabel: "Settings",
          placementPosition: "settings.sidebar",
          routeId: "settings",
          routeSurface: "settings",
        }),
      ],
      "settings.sidebar",
    );

    expect(appEntry ? resolvePluginPlacementPath(appEntry) : null).toBe("/plugins/t3.app/main");
    expect(settingsEntry ? resolvePluginPlacementPath(settingsEntry) : null).toBe(
      "/settings/plugins/t3.settings/settings",
    );
    expect(appEntry ? resolvePluginPlacementRouteTarget(appEntry) : null).toEqual({
      to: "/plugins/$pluginId/$routeId",
      params: {
        pluginId: PluginId.make("t3.app"),
        routeId: PluginRouteId.make("main"),
      },
    });
    expect(settingsEntry ? resolvePluginPlacementRouteTarget(settingsEntry) : null).toEqual({
      to: "/settings/plugins/$pluginId/$routeId",
      params: {
        pluginId: PluginId.make("t3.settings"),
        routeId: PluginRouteId.make("settings"),
      },
    });
  });

  it("provides stable keys and active path checks for rendered placements", () => {
    const [entry] = getActivePluginPlacementEntries(
      [
        makePluginCatalogEntry({
          pluginId: "t3.rendered",
          name: "Rendered",
          placementId: "primary",
          placementLabel: "Rendered",
          placementPosition: "sidebar.primary",
        }),
      ],
      "sidebar.primary",
    );

    expect(entry ? pluginPlacementKey(entry) : null).toBe("t3.rendered:primary");
    expect(entry ? isPluginPlacementPathActive(entry, "/plugins/t3.rendered/main") : false).toBe(
      true,
    );
    expect(
      entry ? isPluginPlacementPathActive(entry, "/plugins/t3.rendered/main/details") : false,
    ).toBe(true);
    expect(entry ? isPluginPlacementPathActive(entry, "/plugins/t3.rendered") : true).toBe(false);
  });
});
