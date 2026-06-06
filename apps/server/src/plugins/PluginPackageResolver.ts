import {
  PluginManifest,
  type PluginId,
  type PluginManifest as PluginManifestType,
  type PluginRouteSurface,
  type PluginUiPlacementPosition,
} from "@t3tools/contracts";
import {
  isPluginApiVersionCompatible,
  type FailedPluginDiscovery,
  type FailedServerPlugin,
  PluginPackageJson,
  type LoadedServerPlugin,
  type PluginPackageDescriptor,
} from "@t3tools/plugin-api/package";
import type { ServerPlugin } from "@t3tools/plugin-api/server";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { pathToFileURL } from "node:url";

import { ServerConfig } from "../config.ts";

const decodePluginPackageJson = Schema.decodeUnknownEffect(PluginPackageJson);
const decodePluginManifest = Schema.decodeUnknownEffect(PluginManifest);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const expectedRouteSurfaceByPlacement = {
  "sidebar.primary": "app",
  "sidebar.footer": "app",
  "settings.sidebar": "settings",
  "commandPalette.actions": null,
} satisfies Record<PluginUiPlacementPosition, PluginRouteSurface | null>;

class PluginPackageResolverError extends Data.TaggedError("PluginPackageResolverError")<{
  readonly message: string;
  readonly packageRoot?: string;
  readonly cause?: unknown;
}> {}

export interface PluginPackageResolverShape {
  readonly discover: Effect.Effect<ReadonlyArray<PluginDiscoveryResult>>;
  readonly discoverFromDirectory: (
    pluginsDir: string,
  ) => Effect.Effect<ReadonlyArray<PluginDiscoveryResult>>;
}

export class PluginPackageResolver extends Context.Service<
  PluginPackageResolver,
  PluginPackageResolverShape
>()("t3/plugins/PluginPackageResolver") {}

export type PluginDiscoveryResult =
  | { readonly status: "loaded"; readonly plugin: LoadedServerPlugin }
  | {
      readonly status: "failed";
      readonly plugin: FailedServerPlugin;
      readonly diagnostic: string;
    }
  | {
      readonly status: "discovery-failed";
      readonly plugin: FailedPluginDiscovery;
      readonly diagnostic: string;
    };

export interface PluginPackageMetadata {
  readonly descriptor: PluginPackageDescriptor;
  readonly manifest: PluginManifestType;
}

export interface PluginPackageDescriptorMetadata {
  readonly descriptor: PluginPackageDescriptor;
}

const failedDiscoveryFromPackageRoot = (packageRoot: string): FailedPluginDiscovery => ({
  discovery: { packageRoot },
});

const failedDiscoveryFromDescriptor = (
  descriptor: PluginPackageDescriptor,
): FailedPluginDiscovery => ({
  discovery: {
    pluginId: descriptor.pluginId,
    packageName: descriptor.packageName,
    packageVersion: descriptor.packageVersion,
    packageRoot: descriptor.packageRoot,
  },
});

function discoveredPluginId(result: PluginDiscoveryResult): PluginId | undefined {
  return result.status === "discovery-failed"
    ? result.plugin.discovery.pluginId
    : result.plugin.manifest.id;
}

function failedDiscoveryFromResult(result: PluginDiscoveryResult): FailedPluginDiscovery {
  if (result.status === "discovery-failed") {
    return result.plugin;
  }
  return failedDiscoveryFromDescriptor(result.plugin.descriptor);
}

function duplicatePluginIds(results: ReadonlyArray<PluginDiscoveryResult>): ReadonlySet<PluginId> {
  const seen = new Set<PluginId>();
  const duplicates = new Set<PluginId>();
  for (const result of results) {
    const pluginId = discoveredPluginId(result);
    if (pluginId === undefined) {
      continue;
    }
    if (seen.has(pluginId)) {
      duplicates.add(pluginId);
    } else {
      seen.add(pluginId);
    }
  }
  return duplicates;
}

function normalizeDuplicatePluginDiscoveryResults(
  results: ReadonlyArray<PluginDiscoveryResult>,
): ReadonlyArray<PluginDiscoveryResult> {
  const duplicateIds = duplicatePluginIds(results);
  if (duplicateIds.size === 0) {
    return results;
  }
  return results.map((result) => {
    const pluginId = discoveredPluginId(result);
    if (pluginId === undefined || !duplicateIds.has(pluginId)) {
      return result;
    }
    return {
      status: "discovery-failed",
      plugin: failedDiscoveryFromResult(result),
      diagnostic: `Duplicate plugin id ${pluginId} was discovered; plugin was not activated.`,
    };
  });
}

function parseJson(input: {
  readonly text: string;
  readonly packageRoot: string;
  readonly label: "package" | "manifest";
}) {
  return decodeUnknownJsonString(input.text).pipe(
    Effect.mapError(
      (cause) =>
        new PluginPackageResolverError({
          message:
            input.label === "package"
              ? "Plugin package JSON could not be parsed."
              : "Plugin manifest JSON could not be parsed.",
          packageRoot: input.packageRoot,
          cause,
        }),
    ),
  );
}

function extractServerPlugin(module: unknown, packageRoot: string): ServerPlugin {
  if (typeof module !== "object" || module === null) {
    throw new PluginPackageResolverError({
      message: "Plugin server entry did not export an object.",
      packageRoot,
    });
  }

  const exports = module as {
    readonly default?: unknown;
    readonly plugin?: unknown;
    readonly serverPlugin?: unknown;
  };
  const candidate = exports.default ?? exports.plugin ?? exports.serverPlugin;
  if (typeof candidate !== "object" || candidate === null) {
    throw new PluginPackageResolverError({
      message:
        "Plugin server entry must export a ServerPlugin as default, plugin, or serverPlugin.",
      packageRoot,
    });
  }

  const serverPlugin = candidate as {
    readonly manifest?: unknown;
    readonly activate?: unknown;
  };
  if (
    typeof serverPlugin.manifest !== "object" ||
    serverPlugin.manifest === null ||
    typeof serverPlugin.activate !== "function"
  ) {
    throw new PluginPackageResolverError({
      message:
        "Plugin server entry must export a ServerPlugin as default, plugin, or serverPlugin.",
      packageRoot,
    });
  }

  return candidate as ServerPlugin;
}

function rejectLegacyPluginNav(
  json: unknown,
  packageRoot: string,
): Effect.Effect<void, PluginPackageResolverError> {
  if (typeof json === "object" && json !== null && Object.hasOwn(json, "nav")) {
    return Effect.fail(
      new PluginPackageResolverError({
        message: "Plugin manifest uses legacy top-level nav. Use ui.placements instead.",
        packageRoot,
      }),
    );
  }
  return Effect.void;
}

function toManifestValidationError(
  cause: unknown,
  packageRoot: string,
): PluginPackageResolverError {
  return cause instanceof PluginPackageResolverError
    ? cause
    : new PluginPackageResolverError({
        message: "Plugin manifest references could not be validated.",
        packageRoot,
        cause,
      });
}

function validateManifestReferences(
  manifest: PluginManifestType,
  packageRoot: string,
): Effect.Effect<void, PluginPackageResolverError> {
  return Effect.try({
    try: () => {
      assertUniqueIds({
        label: "route",
        ids: manifest.routes.map((route) => route.id),
        packageRoot,
      });
      assertUniqueIds({
        label: "placement",
        ids: manifest.ui.placements.map((placement) => placement.id),
        packageRoot,
      });
      assertUniqueIds({
        label: "composer action",
        ids: (manifest.ui.composerActions ?? []).map((action) => action.id),
        packageRoot,
      });
      assertUniqueIds({
        label: "command",
        ids: manifest.commands.map((command) => command.name),
        packageRoot,
      });

      const routeById = new Map(manifest.routes.map((route) => [route.id, route]));
      for (const placement of manifest.ui.placements) {
        const route = routeById.get(placement.routeId);
        if (!route) {
          throw new PluginPackageResolverError({
            message: `Plugin manifest placement ${placement.id} references missing route ${placement.routeId}.`,
            packageRoot,
          });
        }

        const expectedSurface = expectedSurfaceForPlacement(placement.position);
        if (expectedSurface !== null && route.surface !== expectedSurface) {
          throw new PluginPackageResolverError({
            message: `Plugin manifest placement ${placement.id} at ${placement.position} must target ${routeSurfaceLabel(expectedSurface)}, but route ${route.id} is ${route.surface}.`,
            packageRoot,
          });
        }
      }
    },
    catch: (cause) => toManifestValidationError(cause, packageRoot),
  });
}

function assertUniqueIds(input: {
  readonly label: string;
  readonly ids: ReadonlyArray<string>;
  readonly packageRoot: string;
}): void {
  const seen = new Set<string>();
  for (const id of input.ids) {
    if (seen.has(id)) {
      throw new PluginPackageResolverError({
        message: `Plugin manifest has duplicate ${input.label} id: ${id}.`,
        packageRoot: input.packageRoot,
      });
    }
    seen.add(id);
  }
}

function expectedSurfaceForPlacement(
  position: PluginUiPlacementPosition,
): PluginRouteSurface | null {
  return expectedRouteSurfaceByPlacement[position];
}

function routeSurfaceLabel(surface: PluginRouteSurface): string {
  return surface === "app" ? "an app route" : "a settings route";
}

const resolveInsidePackage = (
  packageRoot: string,
  relativePath: string,
): Effect.Effect<string, PluginPackageResolverError, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const resolved = path.resolve(packageRoot, relativePath);
    const relative = path.relative(packageRoot, resolved);
    const escapesPackage =
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith("../") ||
      relative.startsWith("..\\");

    if (escapesPackage) {
      return yield* new PluginPackageResolverError({
        message: `Plugin path escapes package root: ${relativePath}.`,
        packageRoot,
      });
    }

    return resolved;
  });

const requireFile = (
  filePath: string,
  message: string,
  packageRoot: string,
): Effect.Effect<void, PluginPackageResolverError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(filePath).pipe(
      Effect.mapError(
        (cause) =>
          new PluginPackageResolverError({
            message,
            packageRoot,
            cause,
          }),
      ),
    );
    if (stat.type !== "File") {
      return yield* new PluginPackageResolverError({
        message,
        packageRoot,
      });
    }
  });

export const loadPluginPackageDescriptor = (
  packageRoot: string,
): Effect.Effect<
  PluginPackageDescriptorMetadata,
  PluginPackageResolverError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageJsonPath = path.join(packageRoot, "package.json");
    const packageJson = yield* fs.readFileString(packageJsonPath).pipe(
      Effect.mapError(
        (cause) =>
          new PluginPackageResolverError({
            message: "Plugin package.json could not be read.",
            packageRoot,
            cause,
          }),
      ),
      Effect.flatMap((text) => parseJson({ text, packageRoot, label: "package" })),
      Effect.flatMap((json) =>
        decodePluginPackageJson(json).pipe(
          Effect.mapError(
            (cause) =>
              new PluginPackageResolverError({
                message: "Plugin package.json does not match the T3 plugin package schema.",
                packageRoot,
                cause,
              }),
          ),
        ),
      ),
    );

    if (!isPluginApiVersionCompatible(packageJson.t3Plugin.apiVersion)) {
      return yield* new PluginPackageResolverError({
        message: `Plugin API version ${packageJson.t3Plugin.apiVersion} is not compatible with this host.`,
        packageRoot,
      });
    }

    const manifestPath = yield* resolveInsidePackage(packageRoot, packageJson.t3Plugin.manifest);
    const serverEntryPath = yield* resolveInsidePackage(packageRoot, packageJson.t3Plugin.server);
    const clientEntryPath = yield* resolveInsidePackage(packageRoot, packageJson.t3Plugin.client);

    const descriptor: PluginPackageDescriptor = {
      pluginId: packageJson.t3Plugin.id,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      packageRoot,
      apiVersion: packageJson.t3Plugin.apiVersion,
      manifestPath,
      serverEntryPath,
      clientEntryPath,
    };

    return { descriptor };
  });

export const loadPluginPackageMetadata = (
  packageRoot: string,
): Effect.Effect<
  PluginPackageMetadata,
  PluginPackageResolverError,
  FileSystem.FileSystem | Path.Path
> =>
  loadPluginPackageDescriptor(packageRoot).pipe(
    Effect.flatMap(({ descriptor }) => loadPluginPackageMetadataFromDescriptor(descriptor)),
  );

export const loadPluginPackageMetadataFromDescriptor = (
  descriptor: PluginPackageDescriptor,
): Effect.Effect<PluginPackageMetadata, PluginPackageResolverError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const packageRoot = descriptor.packageRoot;
    const manifest = yield* fs.readFileString(descriptor.manifestPath).pipe(
      Effect.mapError(
        (cause) =>
          new PluginPackageResolverError({
            message: "Plugin manifest could not be read.",
            packageRoot,
            cause,
          }),
      ),
      Effect.flatMap((text) => parseJson({ text, packageRoot, label: "manifest" })),
      Effect.flatMap((json) =>
        rejectLegacyPluginNav(json, packageRoot).pipe(
          Effect.flatMap(() =>
            decodePluginManifest(json).pipe(
              Effect.mapError(
                (cause) =>
                  new PluginPackageResolverError({
                    message: "Plugin manifest does not match the plugin manifest schema.",
                    packageRoot,
                    cause,
                  }),
              ),
            ),
          ),
        ),
      ),
      Effect.tap((manifest) => validateManifestReferences(manifest, packageRoot)),
    );

    if (manifest.id !== descriptor.pluginId) {
      return yield* new PluginPackageResolverError({
        message: `Plugin manifest id ${manifest.id} does not match package id ${descriptor.pluginId}.`,
        packageRoot,
      });
    }

    return { descriptor, manifest };
  });

const validateDeclaredPluginFiles = (
  metadata: PluginPackageMetadata,
): Effect.Effect<void, PluginPackageResolverError, FileSystem.FileSystem> =>
  Effect.all(
    [
      requireFile(
        metadata.descriptor.serverEntryPath,
        "Plugin server entry file could not be found.",
        metadata.descriptor.packageRoot,
      ),
      requireFile(
        metadata.descriptor.clientEntryPath,
        "Plugin client bundle could not be found.",
        metadata.descriptor.packageRoot,
      ),
    ],
    { concurrency: 1, discard: true },
  );

const loadServerPluginFromMetadata = (
  metadata: PluginPackageMetadata,
): Effect.Effect<LoadedServerPlugin, PluginPackageResolverError> =>
  Effect.gen(function* () {
    const { descriptor, manifest } = metadata;
    const packageRoot = descriptor.packageRoot;
    const module = yield* Effect.tryPromise({
      try: () => import(pathToFileURL(descriptor.serverEntryPath).href) as Promise<unknown>,
      catch: (cause) =>
        new PluginPackageResolverError({
          message: "Plugin server entry could not be imported.",
          packageRoot,
          cause,
        }),
    });
    const serverPlugin = yield* Effect.try({
      try: () => extractServerPlugin(module, packageRoot),
      catch: (cause) =>
        cause instanceof PluginPackageResolverError
          ? cause
          : new PluginPackageResolverError({
              message: "Plugin server entry export could not be resolved.",
              packageRoot,
              cause,
            }),
    });

    if (serverPlugin.manifest.id !== manifest.id) {
      return yield* new PluginPackageResolverError({
        message: `Plugin server manifest id ${serverPlugin.manifest.id} does not match package id ${manifest.id}.`,
        packageRoot,
      });
    }

    return {
      descriptor,
      manifest,
      serverPlugin,
    };
  });

const loadPluginPackageFromMetadata = (
  metadata: PluginPackageMetadata,
): Effect.Effect<LoadedServerPlugin, PluginPackageResolverError, FileSystem.FileSystem> =>
  validateDeclaredPluginFiles(metadata).pipe(
    Effect.andThen(loadServerPluginFromMetadata(metadata)),
  );

export const loadPluginPackage = (
  packageRoot: string,
): Effect.Effect<
  LoadedServerPlugin,
  PluginPackageResolverError,
  FileSystem.FileSystem | Path.Path
> =>
  loadPluginPackageMetadata(packageRoot).pipe(
    Effect.flatMap((metadata) => loadPluginPackageFromMetadata(metadata)),
  );

export const discoverPluginPackage = (
  packageRoot: string,
): Effect.Effect<PluginDiscoveryResult, never, FileSystem.FileSystem | Path.Path> =>
  loadPluginPackageDescriptor(packageRoot).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Effect.succeed({
          status: "discovery-failed",
          plugin: failedDiscoveryFromPackageRoot(packageRoot),
          diagnostic: cause.message,
        }),
      onSuccess: ({ descriptor }) =>
        loadPluginPackageMetadataFromDescriptor(descriptor).pipe(
          Effect.matchEffect({
            onFailure: (cause) =>
              Effect.succeed({
                status: "discovery-failed",
                plugin: failedDiscoveryFromDescriptor(descriptor),
                diagnostic: cause.message,
              }),
            onSuccess: (metadata) =>
              loadPluginPackageFromMetadata(metadata).pipe(
                Effect.match({
                  onFailure: (cause): PluginDiscoveryResult => ({
                    status: "failed",
                    plugin: metadata,
                    diagnostic: cause.message,
                  }),
                  onSuccess: (plugin): PluginDiscoveryResult => ({
                    status: "loaded",
                    plugin,
                  }),
                }),
              ),
          }),
        ),
    }),
  );

const makePluginPackageResolver = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  const discoverPluginPackageWithServices = (packageRoot: string) =>
    discoverPluginPackage(packageRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const discoverFromDirectory: PluginPackageResolverShape["discoverFromDirectory"] = (pluginsDir) =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(pluginsDir).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return [];
      }

      const entries = yield* fs.readDirectory(pluginsDir).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Plugin directory could not be read", {
            pluginsDir,
            cause,
          }).pipe(Effect.as([])),
        ),
      );
      const discovered: Array<PluginDiscoveryResult> = [];
      for (const entry of entries.toSorted()) {
        const discoveredPackageRoot = path.join(pluginsDir, entry);
        const stat = yield* fs
          .stat(discoveredPackageRoot)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (stat?.type !== "Directory" && stat?.type !== "SymbolicLink") {
          continue;
        }
        const packageRoot = yield* fs
          .realPath(discoveredPackageRoot)
          .pipe(Effect.catch(() => Effect.succeed(discoveredPackageRoot)));
        const result = yield* discoverPluginPackageWithServices(packageRoot);
        if (result.status !== "loaded") {
          yield* Effect.logWarning(
            result.status === "discovery-failed"
              ? "Plugin package discovery failed"
              : "Plugin package could not be loaded",
            {
              packageRoot: discoveredPackageRoot,
              message: result.diagnostic,
            },
          );
        }
        discovered.push(result);
      }
      return normalizeDuplicatePluginDiscoveryResults(discovered);
    });

  return PluginPackageResolver.of({
    discover: discoverFromDirectory(path.join(config.baseDir, "plugins")),
    discoverFromDirectory,
  });
});

export const PluginPackageResolverLive = Layer.effect(
  PluginPackageResolver,
  makePluginPackageResolver,
);
