import {
  EMPTY_PLUGIN_LOCKFILE,
  PluginId,
  PluginManifest,
  type PluginInfo,
  type PluginLockfile,
  type PluginLockfilePlugin,
} from "@t3tools/contracts/plugin";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import { pluginManifestPath, pluginVersionDir } from "./PluginPaths.ts";
import { PluginRuntimeRegistry, type ActivePluginRuntime } from "./PluginRuntimeRegistry.ts";

export class PluginCatalog extends Context.Service<
  PluginCatalog,
  {
    readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>;
  }
>()("t3/plugins/PluginCatalog") {}

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

const pluginInfoFromRuntime = (
  runtime: ActivePluginRuntime,
  lockfile: PluginLockfile,
): PluginInfo => {
  const entry = lockfile.plugins[runtime.manifest.id];
  return {
    id: runtime.manifest.id,
    name: runtime.manifest.name,
    version: runtime.manifest.version,
    state: entry?.state ?? "active",
    capabilities: Array.from(runtime.manifest.capabilities),
    hasWeb: runtime.manifest.entries.web !== undefined,
    hasStyles: runtime.manifest.entries.styles !== undefined,
    lastError: entry?.lastError ?? null,
  };
};

const fallbackPluginInfo = (pluginId: string, entry: PluginLockfilePlugin): PluginInfo => ({
  id: PluginId.make(pluginId),
  name: pluginId,
  version: entry.version,
  state: entry.state,
  capabilities: [],
  hasWeb: false,
  hasStyles: false,
  lastError: entry.lastError,
});

export const make = Effect.fn("PluginCatalog.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registry = yield* PluginRuntimeRegistry;
  const lockfileStore = yield* PluginLockfileStore;

  const readInstalledManifest = (pluginId: string, entry: PluginLockfilePlugin) =>
    fs
      .readFileString(
        pluginManifestPath(
          pluginVersionDir(config.pluginsDir, pluginId, entry.version, path.join),
          path.join,
        ),
      )
      .pipe(Effect.flatMap(decodeManifestJson));

  const pluginInfoFromLockfileEntry = (pluginId: string, entry: PluginLockfilePlugin) =>
    readInstalledManifest(pluginId, entry).pipe(
      Effect.map(
        (manifest): PluginInfo => ({
          // Always use the lockfile key, not manifest.id: management actions
          // target the installed entry. A mismatched manifest id would otherwise
          // make catalog rows point at the wrong / nonexistent plugin.
          id: PluginId.make(pluginId),
          name: manifest.name,
          version: manifest.version,
          state: entry.state,
          capabilities: Array.from(manifest.capabilities),
          hasWeb: manifest.entries.web !== undefined,
          hasStyles: manifest.entries.styles !== undefined,
          lastError: entry.lastError,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to read installed plugin manifest for plugin list", {
          pluginId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(fallbackPluginInfo(pluginId, entry))),
      ),
    );

  const list = Effect.gen(function* () {
    const activeRuntimes = yield* registry.list;
    const lockfile = yield* lockfileStore.readLockfile.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to read plugin lockfile for plugin list", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(EMPTY_PLUGIN_LOCKFILE)),
      ),
    );
    const activePluginIds = new Set<string>(activeRuntimes.map((runtime) => runtime.manifest.id));
    const activeInfos = activeRuntimes.map((runtime) => pluginInfoFromRuntime(runtime, lockfile));
    const inactiveInfos = yield* Effect.forEach(
      Object.entries(lockfile.plugins).filter(([pluginId]) => !activePluginIds.has(pluginId)),
      ([pluginId, entry]) => pluginInfoFromLockfileEntry(pluginId, entry),
      { concurrency: 4 },
    );
    return [...activeInfos, ...inactiveInfos].toSorted((left, right) =>
      left.id.localeCompare(right.id),
    );
  });

  return PluginCatalog.of({ list });
});

export const layer = Layer.effect(PluginCatalog, make());
