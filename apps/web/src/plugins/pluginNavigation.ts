import type {
  PluginCatalogEntry,
  PluginId,
  PluginRouteContribution,
  PluginRouteId,
  PluginRouteSurface,
} from "@t3tools/contracts";
import type { WsRpcClient } from "@t3tools/client-runtime";
import type { PluginUiFactory } from "@t3tools/plugin-api/ui";

import { hasPluginManifest, type PluginCatalogManifestEntry } from "./pluginCatalogEntry";

export type PluginAssetLifecycle =
  | { readonly status: "loading"; readonly pluginId: PluginId }
  | {
      readonly status: "registered";
      readonly pluginId: PluginId;
      readonly factory: PluginUiFactory;
    }
  | { readonly status: "failed"; readonly pluginId: PluginId; readonly message: string };

export interface PluginNavigationHostState {
  readonly catalog: ReadonlyArray<PluginCatalogEntry>;
  readonly catalogStatus: "idle" | "loading" | "ready" | "failed";
  readonly assets: ReadonlyMap<string, PluginAssetLifecycle>;
  readonly client: WsRpcClient | null;
  readonly hostScope: string | null;
  readonly generation: number;
}

export type PluginRouteReadiness =
  | { readonly status: "loading" }
  | { readonly status: "missing"; readonly message: string }
  | { readonly status: "failed"; readonly catalogEntry: PluginCatalogManifestEntry }
  | {
      readonly status: "ready";
      readonly catalogEntry: PluginCatalogManifestEntry;
      readonly route: PluginRouteContribution;
      readonly factory: PluginUiFactory;
      readonly factoryKey: string;
      readonly client: WsRpcClient;
    };

export type PluginContributionReadiness<TContribution> =
  | { readonly status: "loading" }
  | { readonly status: "missing"; readonly message: string }
  | { readonly status: "failed"; readonly catalogEntry: PluginCatalogManifestEntry }
  | {
      readonly status: "ready";
      readonly catalogEntry: PluginCatalogManifestEntry;
      readonly contribution: TContribution;
      readonly factory: PluginUiFactory;
      readonly factoryKey: string;
      readonly client: WsRpcClient;
    };

export function pluginAssetFactoryKey(
  hostScope: string,
  generation: number,
  entry: PluginCatalogManifestEntry,
): string {
  return [
    hostScope,
    String(generation),
    entry.manifest.id,
    entry.manifest.version,
    entry.assets.client,
  ].join("\u0000");
}

export function pluginAssetFactoryKeysForCatalog(input: {
  readonly hostScope: string;
  readonly generation: number;
  readonly catalog: ReadonlyArray<PluginCatalogEntry>;
}): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const entry of input.catalog) {
    if (hasPluginManifest(entry) && entry.status.status === "active") {
      keys.add(pluginAssetFactoryKey(input.hostScope, input.generation, entry));
    }
  }
  return keys;
}

export function resolvePluginContributionReadiness<TContribution>(input: {
  readonly hostState: PluginNavigationHostState;
  readonly pluginId: PluginId;
  readonly resolveContribution: (catalogEntry: PluginCatalogManifestEntry) =>
    | { readonly status: "ready"; readonly contribution: TContribution }
    | {
        readonly status: "missing";
        readonly message: string;
      };
}): PluginContributionReadiness<TContribution> {
  const catalogEntry = input.hostState.catalog
    .filter(hasPluginManifest)
    .find((entry) => entry.manifest.id === input.pluginId);
  if (!catalogEntry) {
    if (input.hostState.catalogStatus === "failed") {
      return { status: "missing", message: "Plugin catalog could not be loaded." };
    }
    return input.hostState.catalogStatus === "ready"
      ? {
          status: "missing",
          message: `Plugin ${input.pluginId} was not found.`,
        }
      : { status: "loading" };
  }
  if (catalogEntry.status.status === "failed") {
    return { status: "failed", catalogEntry };
  }
  if (catalogEntry.status.status !== "active") {
    return {
      status: "missing",
      message: `Plugin ${input.pluginId} is ${catalogEntry.status.status}.`,
    };
  }

  const contribution = input.resolveContribution(catalogEntry);
  if (contribution.status === "missing") {
    return contribution;
  }

  if (!input.hostState.hostScope) {
    return { status: "loading" };
  }

  const factoryKey = pluginAssetFactoryKey(
    input.hostState.hostScope,
    input.hostState.generation,
    catalogEntry,
  );
  const asset = input.hostState.assets.get(factoryKey);
  if (!asset) {
    return { status: "loading" };
  }
  if (asset.status === "failed") {
    return { status: "missing", message: asset.message };
  }
  if (asset.status === "loading") {
    return { status: "loading" };
  }
  if (!input.hostState.client) {
    return { status: "loading" };
  }

  return {
    status: "ready",
    catalogEntry,
    contribution: contribution.contribution,
    factory: asset.factory,
    factoryKey,
    client: input.hostState.client,
  };
}

export function resolvePluginRouteReadiness(input: {
  readonly hostState: PluginNavigationHostState;
  readonly pluginId: PluginId;
  readonly routeId: PluginRouteId;
  readonly surface: PluginRouteSurface;
}): PluginRouteReadiness {
  const readiness = resolvePluginContributionReadiness({
    hostState: input.hostState,
    pluginId: input.pluginId,
    resolveContribution: (catalogEntry) => {
      const route = catalogEntry.manifest.routes.find(
        (candidate) => candidate.id === input.routeId,
      );
      if (!route) {
        return {
          status: "missing",
          message: `Plugin route ${input.routeId} was not found.`,
        };
      }
      if (route.surface !== input.surface) {
        return {
          status: "missing",
          message: `Plugin route ${input.routeId} is not available on the ${input.surface} surface.`,
        };
      }

      return { status: "ready", contribution: route };
    },
  });

  return readiness.status === "ready"
    ? {
        status: "ready",
        catalogEntry: readiness.catalogEntry,
        route: readiness.contribution,
        factory: readiness.factory,
        factoryKey: readiness.factoryKey,
        client: readiness.client,
      }
    : readiness;
}
