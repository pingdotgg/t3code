import type {
  PluginCatalogEntry,
  PluginId,
  PluginRouteContribution,
  PluginRouteId,
  PluginRouteSurface,
} from "@t3tools/contracts";
import type { WsRpcClient } from "@t3tools/client-runtime";
import type { PluginUiFactory } from "@t3tools/plugin-api/ui";

export interface PluginNavigationHostState {
  readonly catalog: ReadonlyArray<PluginCatalogEntry>;
  readonly factories: ReadonlyMap<string, PluginUiFactory>;
  readonly loadErrors: ReadonlyMap<string, string>;
  readonly client: WsRpcClient | null;
}

export type PluginRouteReadiness =
  | { readonly status: "loading" }
  | { readonly status: "missing"; readonly message: string }
  | { readonly status: "failed"; readonly catalogEntry: PluginCatalogEntry }
  | {
      readonly status: "ready";
      readonly catalogEntry: PluginCatalogEntry;
      readonly route: PluginRouteContribution;
      readonly factory: PluginUiFactory;
      readonly client: WsRpcClient;
    };

export function resolvePluginRouteReadiness(input: {
  readonly hostState: PluginNavigationHostState;
  readonly pluginId: PluginId;
  readonly routeId: PluginRouteId;
  readonly surface: PluginRouteSurface;
}): PluginRouteReadiness {
  const catalogEntry = input.hostState.catalog.find(
    (entry) => entry.manifest.id === input.pluginId,
  );
  if (!catalogEntry) {
    return input.hostState.catalog.length === 0
      ? { status: "loading" }
      : {
          status: "missing",
          message: `Plugin ${input.pluginId} was not found.`,
        };
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

  const route = catalogEntry.manifest.routes.find((candidate) => candidate.id === input.routeId);
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

  const factory = input.hostState.factories.get(input.pluginId);
  if (!factory) {
    const loadError = input.hostState.loadErrors.get(input.pluginId);
    return loadError ? { status: "missing", message: loadError } : { status: "loading" };
  }
  if (!input.hostState.client) {
    return { status: "loading" };
  }

  return {
    status: "ready",
    catalogEntry,
    route,
    factory,
    client: input.hostState.client,
  };
}
