import {
  PluginId,
  PluginRouteId,
  PluginUiPlacementId,
  type PluginCommandContribution,
  type PluginRouteSurface,
  type PluginUiPlacementPosition,
} from "@t3tools/contracts";

import type { PluginCatalogManifestEntry } from "../pluginCatalogEntry";
import type { PluginPlacementEntry } from "../pluginPlacements";

export function makePluginCatalogEntry(input: {
  readonly pluginId: string;
  readonly name: string;
  readonly routeId?: string;
  readonly routeLabel?: string;
  readonly routeSurface?: PluginRouteSurface;
  readonly placementId: string;
  readonly placementLabel: string;
  readonly placementPosition: PluginUiPlacementPosition;
  readonly placementDescription?: string;
  readonly order?: number;
  readonly badgeCount?: number;
  readonly status?: "active" | "failed" | "disabled";
  readonly commands?: ReadonlyArray<PluginCommandContribution>;
}): PluginCatalogManifestEntry {
  const pluginId = PluginId.make(input.pluginId);
  const routeId = PluginRouteId.make(input.routeId ?? "main");
  const placementId = PluginUiPlacementId.make(input.placementId);

  return {
    manifest: {
      id: pluginId,
      name: input.name,
      version: "0.1.0",
      routes: [
        {
          id: routeId,
          label: input.routeLabel ?? input.name,
          surface: input.routeSurface ?? "app",
        },
      ],
      ui: {
        placements: [
          {
            id: placementId,
            position: input.placementPosition,
            label: input.placementLabel,
            routeId,
            ...(input.placementDescription === undefined
              ? {}
              : { description: input.placementDescription }),
            ...(input.order === undefined ? {} : { order: input.order }),
            ...(input.badgeCount === undefined ? {} : { badgeCount: input.badgeCount }),
          },
        ],
      },
      commands: input.commands ?? [],
    },
    status: {
      pluginId,
      status: input.status ?? "active",
    },
    assets: {
      client: `/plugins/assets/${pluginId}/client.js`,
    },
  };
}

export function makePluginPlacementEntry(
  input: Parameters<typeof makePluginCatalogEntry>[0],
): PluginPlacementEntry {
  const catalogEntry = makePluginCatalogEntry(input);
  const placement = catalogEntry.manifest.ui.placements[0];
  const route = catalogEntry.manifest.routes[0];
  if (!placement || !route) {
    throw new Error("Plugin placement fixture must create a placement and route.");
  }
  return { catalogEntry, placement, route };
}
