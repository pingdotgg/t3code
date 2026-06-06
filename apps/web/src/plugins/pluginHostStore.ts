import type { PluginCatalogEntry, PluginId } from "@t3tools/contracts";
import type { PluginUiFactory } from "@t3tools/plugin-api/ui";
import { useSyncExternalStore } from "react";

import type { WsRpcClient } from "@t3tools/client-runtime";

import { hasPluginManifest } from "./pluginCatalogEntry";
import {
  type PluginAssetLifecycle,
  pluginAssetFactoryKey,
  pluginAssetFactoryKeysForCatalog,
} from "./pluginNavigation";

export type PluginCatalogLoadStatus = "idle" | "loading" | "ready" | "failed";

export interface PluginHostState {
  readonly catalog: ReadonlyArray<PluginCatalogEntry>;
  readonly catalogStatus: PluginCatalogLoadStatus;
  readonly assets: ReadonlyMap<string, PluginAssetLifecycle>;
  readonly client: WsRpcClient | null;
  readonly hostScope: string | null;
  readonly generation: number;
}

let state: PluginHostState = {
  catalog: [],
  catalogStatus: "idle",
  assets: new Map(),
  client: null,
  hostScope: null,
  generation: 0,
};

const listeners = new Set<() => void>();
let nextHostGeneration = 0;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function updateState(updater: (current: PluginHostState) => PluginHostState) {
  state = updater(state);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readPluginHostState(): PluginHostState {
  return state;
}

export function resetPluginHostState(hostScope: string, client: WsRpcClient | null): number {
  nextHostGeneration += 1;
  const generation = nextHostGeneration;
  updateState(() => ({
    catalog: [],
    catalogStatus: "loading",
    assets: new Map(),
    client,
    hostScope,
    generation,
  }));
  return generation;
}

export function clearPluginHostState(hostScope: string, client: WsRpcClient) {
  updateState((current) =>
    current.hostScope === hostScope && current.client === client
      ? {
          catalog: [],
          catalogStatus: "idle",
          assets: new Map(),
          client: null,
          hostScope: null,
          generation: current.generation,
        }
      : current,
  );
}

export function setPluginCatalogReady(input: {
  readonly client: WsRpcClient | null;
  readonly hostScope: string;
  readonly generation: number;
  readonly catalog: ReadonlyArray<PluginCatalogEntry>;
}) {
  updateState((current) =>
    current.hostScope === input.hostScope &&
    current.client === input.client &&
    current.generation === input.generation
      ? {
          ...current,
          catalog: input.catalog,
          catalogStatus: "ready",
          assets: retainPluginAssetsForCatalog(current.assets, input),
        }
      : current,
  );
}

function retainPluginAssetsForCatalog(
  assets: ReadonlyMap<string, PluginAssetLifecycle>,
  input: {
    readonly hostScope: string;
    readonly generation: number;
    readonly catalog: ReadonlyArray<PluginCatalogEntry>;
  },
): ReadonlyMap<string, PluginAssetLifecycle> {
  const activeAssetKeys = pluginAssetFactoryKeysForCatalog(input);
  if (assets.size === 0) return assets;

  const nextAssets = new Map<string, PluginAssetLifecycle>();
  for (const [assetKey, asset] of assets) {
    if (activeAssetKeys.has(assetKey)) {
      nextAssets.set(assetKey, asset);
    }
  }
  return nextAssets.size === assets.size ? assets : nextAssets;
}

export function setPluginCatalogFailed(input: {
  readonly client: WsRpcClient | null;
  readonly hostScope: string;
  readonly generation: number;
}) {
  updateState((current) =>
    current.hostScope === input.hostScope &&
    current.client === input.client &&
    current.generation === input.generation
      ? { ...current, catalogStatus: "failed" }
      : current,
  );
}

export function registerPluginAssetFactory(input: {
  readonly pluginId: string;
  readonly assetKey: string | undefined;
  readonly factory: PluginUiFactory;
}) {
  updateState((current) => {
    if (!current.hostScope) return current;
    const catalogEntry = current.catalog
      .filter(hasPluginManifest)
      .find((entry) => entry.manifest.id === input.pluginId && entry.status.status === "active");
    if (!catalogEntry) return current;
    const expectedAssetKey = pluginAssetFactoryKey(
      current.hostScope,
      current.generation,
      catalogEntry,
    );
    if (input.assetKey !== expectedAssetKey) return current;
    const assets = new Map(current.assets);
    assets.set(expectedAssetKey, {
      status: "registered",
      pluginId: catalogEntry.manifest.id,
      factory: input.factory,
    });
    return { ...current, assets };
  });
}

export function markPluginAssetLoading(input: {
  readonly hostScope: string;
  readonly generation: number;
  readonly pluginId: PluginId;
  readonly assetKey: string;
}) {
  updateState((current) => {
    const currentAsset = current.assets.get(input.assetKey);
    if (
      current.hostScope !== input.hostScope ||
      current.generation !== input.generation ||
      (currentAsset !== undefined && currentAsset.status !== "failed")
    ) {
      return current;
    }
    const assets = new Map(current.assets);
    assets.set(input.assetKey, {
      status: "loading",
      pluginId: input.pluginId,
    });
    return { ...current, assets };
  });
}

function isCurrentActiveAsset(input: {
  readonly current: PluginHostState;
  readonly hostScope: string;
  readonly generation: number;
  readonly pluginId: string;
  readonly assetKey: string;
}) {
  const { current } = input;
  if (current.hostScope !== input.hostScope || current.generation !== input.generation) {
    return false;
  }
  const catalogEntry = current.catalog
    .filter(hasPluginManifest)
    .find((entry) => entry.manifest.id === input.pluginId && entry.status.status === "active");
  return (
    catalogEntry !== undefined &&
    current.hostScope !== null &&
    pluginAssetFactoryKey(current.hostScope, current.generation, catalogEntry) === input.assetKey
  );
}

export function markPluginAssetRegistrationMissing(input: {
  readonly hostScope: string;
  readonly generation: number;
  readonly pluginId: string;
  readonly assetKey: string;
}) {
  updateState((current) => {
    const currentAsset = current.assets.get(input.assetKey);
    if (currentAsset?.status !== "loading") return current;
    if (!isCurrentActiveAsset({ current, ...input })) {
      const assets = new Map(current.assets);
      assets.delete(input.assetKey);
      return { ...current, assets };
    }
    const assets = new Map(current.assets);
    assets.set(input.assetKey, {
      status: "failed",
      pluginId: currentAsset.pluginId,
      message: "Plugin client bundle loaded but did not register.",
    });
    return { ...current, assets };
  });
}

export function markPluginAssetFailed(input: {
  readonly hostScope: string;
  readonly generation: number;
  readonly pluginId: string;
  readonly assetKey: string;
  readonly message: string;
}) {
  updateState((current) => {
    const currentAsset = current.assets.get(input.assetKey);
    if (currentAsset?.status !== "loading") return current;
    if (!isCurrentActiveAsset({ current, ...input })) {
      const assets = new Map(current.assets);
      assets.delete(input.assetKey);
      return { ...current, assets };
    }
    const assets = new Map(current.assets);
    assets.set(input.assetKey, {
      status: "failed",
      pluginId: currentAsset.pluginId,
      message: input.message,
    });
    return { ...current, assets };
  });
}

export function usePluginHostState(): PluginHostState {
  return useSyncExternalStore(subscribe, readPluginHostState, readPluginHostState);
}

export function usePluginCatalog(): ReadonlyArray<PluginCatalogEntry> {
  return usePluginHostState().catalog;
}
