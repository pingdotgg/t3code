import { PluginId, type PluginId as PluginIdType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";

import type { PluginRegistryShape } from "./PluginRegistry.ts";

const PLUGIN_CLIENT_ASSET_PATH_PATTERN = /^\/plugins\/assets\/([^/]+)\/client\.js$/;

export const PLUGIN_CLIENT_ASSET_CONTENT_TYPE = "application/javascript; charset=utf-8";
export const PLUGIN_CLIENT_ASSET_CACHE_CONTROL = "no-store";

export type PluginClientAssetPath =
  | { readonly status: "ok"; readonly pluginId: PluginIdType }
  | { readonly status: "invalid" }
  | { readonly status: "not-found" };

export type PluginClientAssetResolution =
  | {
      readonly status: "ok";
      readonly script: string;
      readonly contentType: typeof PLUGIN_CLIENT_ASSET_CONTENT_TYPE;
      readonly cacheControl: typeof PLUGIN_CLIENT_ASSET_CACHE_CONTROL;
    }
  | { readonly status: "invalid" }
  | { readonly status: "not-found" };

export function pluginClientAssetUrl(pluginId: PluginIdType): string {
  return `/plugins/assets/${encodeURIComponent(pluginId)}/client.js`;
}

export function parsePluginClientAssetPath(pathname: string): PluginClientAssetPath {
  const match = PLUGIN_CLIENT_ASSET_PATH_PATTERN.exec(pathname);
  if (!match) {
    return { status: "not-found" };
  }

  try {
    return { status: "ok", pluginId: PluginId.make(decodeURIComponent(match[1] ?? "")) };
  } catch {
    return { status: "invalid" };
  }
}

export function resolvePluginClientAsset(input: {
  readonly pathname: string;
  readonly registry: Pick<PluginRegistryShape, "getClientAssetPath">;
}): Effect.Effect<PluginClientAssetResolution, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const assetPath = parsePluginClientAssetPath(input.pathname);
    if (assetPath.status !== "ok") {
      return assetPath;
    }

    const clientEntryPath = yield* input.registry
      .getClientAssetPath(assetPath.pluginId)
      .pipe(Effect.catchTag("PluginRpcError", () => Effect.succeed(null)));
    if (clientEntryPath === null) {
      return { status: "not-found" } as const;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const script = yield* fileSystem.readFileString(clientEntryPath);

    return {
      status: "ok",
      script,
      contentType: PLUGIN_CLIENT_ASSET_CONTENT_TYPE,
      cacheControl: PLUGIN_CLIENT_ASSET_CACHE_CONTROL,
    } as const;
  });
}
