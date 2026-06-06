import type { PluginCatalogEntry } from "@t3tools/contracts";
import type { T3PluginHostGlobal } from "@t3tools/plugin-api/ui";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import { hasPluginManifest, type PluginCatalogManifestEntry } from "./pluginCatalogEntry";
import { pluginAssetFactoryKey } from "./pluginNavigation";
import {
  markPluginAssetFailed,
  markPluginAssetLoading,
  markPluginAssetRegistrationMissing,
  readPluginHostState,
  registerPluginAssetFactory,
} from "./pluginHostStore";

function globalPluginHost(): Window & { T3PluginHost?: T3PluginHostGlobal } {
  return window as Window & { T3PluginHost?: T3PluginHostGlobal };
}

function currentScriptAssetKey(pluginId: string): string | undefined {
  const currentScript = document.currentScript;
  if (!(currentScript instanceof HTMLScriptElement)) return undefined;
  if (currentScript.dataset.t3PluginId !== pluginId) return undefined;
  return currentScript.dataset.t3PluginAssetKey;
}

export function installGlobalPluginHost() {
  if (typeof window === "undefined") {
    return;
  }

  globalPluginHost().T3PluginHost = {
    register: (pluginIdInput, factory, options) => {
      const pluginId = String(pluginIdInput);
      registerPluginAssetFactory({
        pluginId,
        assetKey: options?.assetKey ?? currentScriptAssetKey(pluginId),
        factory,
      });
    },
  };
}

function scriptUrlFor(entry: PluginCatalogManifestEntry): string {
  return resolvePrimaryEnvironmentHttpUrl(entry.assets.client);
}

export function removePluginScriptsForScope(hostScope: string) {
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    "script[data-t3-plugin-host-scope]",
  )) {
    if (script.dataset.t3PluginHostScope === hostScope) {
      script.remove();
    }
  }
}

export function removePluginScriptsForAssetKeys(assetKeys: Iterable<string>) {
  const keys = new Set(assetKeys);
  if (keys.size === 0) return;

  for (const script of document.querySelectorAll<HTMLScriptElement>(
    "script[data-t3-plugin-asset-key]",
  )) {
    if (script.dataset.t3PluginAssetKey && keys.has(script.dataset.t3PluginAssetKey)) {
      script.remove();
    }
  }
}

function removePluginScriptForAssetKey(assetKey: string) {
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    "script[data-t3-plugin-asset-key]",
  )) {
    if (script.dataset.t3PluginAssetKey === assetKey) {
      script.remove();
    }
  }
}

function loadPluginScript(
  hostScope: string,
  generation: number,
  entry: PluginCatalogManifestEntry,
) {
  const pluginId = entry.manifest.id;
  const assetKey = pluginAssetFactoryKey(hostScope, generation, entry);
  const currentState = readPluginHostState();
  const currentAsset = currentState.assets.get(assetKey);
  if (
    currentState.hostScope !== hostScope ||
    currentState.generation !== generation ||
    (currentAsset !== undefined && currentAsset.status !== "failed")
  ) {
    return;
  }
  markPluginAssetLoading({ hostScope, generation, pluginId, assetKey });
  removePluginScriptForAssetKey(assetKey);

  const script = document.createElement("script");
  script.async = true;
  script.src = scriptUrlFor(entry);
  script.dataset.t3PluginId = pluginId;
  script.dataset.t3PluginHostScope = hostScope;
  script.dataset.t3PluginGeneration = String(generation);
  script.dataset.t3PluginAssetKey = assetKey;
  script.addEventListener(
    "load",
    () => {
      window.queueMicrotask(() =>
        markPluginAssetRegistrationMissing({ hostScope, generation, pluginId, assetKey }),
      );
    },
    {
      once: true,
    },
  );
  script.addEventListener(
    "error",
    () => {
      script.remove();
      markPluginAssetFailed({
        hostScope,
        generation,
        pluginId,
        assetKey,
        message: "Failed to load plugin client bundle.",
      });
    },
    { once: true },
  );
  document.head.appendChild(script);
}

export function loadActivePluginScripts(
  hostScope: string,
  generation: number,
  catalog: ReadonlyArray<PluginCatalogEntry>,
) {
  for (const entry of catalog) {
    if (hasPluginManifest(entry) && entry.status.status === "active") {
      loadPluginScript(hostScope, generation, entry);
    }
  }
}
