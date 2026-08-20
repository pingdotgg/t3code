import * as NodeURL from "node:url";

import {
  PluginCommandInvocationResult,
  PluginPackageNotFoundError,
  PluginPackageOperationError,
  type PluginPackageDiscoveryError,
  type PluginPackageOperation,
  type PluginPackageStatus,
  type PluginPackageStatusSnapshot,
} from "@t3tools/contracts";
import type { PluginActivationContext, PluginDefinition } from "@t3tools/plugin-runtime";
import {
  PluginManifest,
  type PluginManifest as PluginManifestType,
} from "@t3tools/plugin-runtime/manifest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PluginCommandCatalog from "./PluginCommandCatalog.ts";

const MANIFEST_FILE_NAME = "t3-plugin.json";
const COMMAND_CAPABILITY = "t3.commands@1";

interface DiscoveredPackage {
  readonly directory: string;
  readonly manifest: PluginManifestType;
}

interface DiscoveryResult {
  readonly errors: ReadonlyArray<PluginPackageDiscoveryError>;
  readonly packages: ReadonlyMap<string, DiscoveredPackage>;
}

interface LoadedDefinition {
  readonly cacheDirectory: string;
  readonly definition: PluginDefinition;
  readonly retired: Promise<void>;
}

export interface PluginPackageApi {
  readonly onDispose: (cleanup: () => void | Promise<void>) => void;
  readonly registerCommand: (
    command: {
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly surfaces: ReadonlyArray<"web" | "desktop" | "mobile">;
    },
    handler: () => unknown | Promise<unknown>,
  ) => void;
}

type PluginPackageActivator = (api: PluginPackageApi) => void | Promise<void>;

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));
const decodeInvocationResult = Schema.decodeUnknownEffect(PluginCommandInvocationResult);
const isPluginPackageOperationError = Schema.is(PluginPackageOperationError);

const detailFromUnknown = (error: unknown): string => {
  if (isPluginPackageOperationError(error)) {
    if (error.detail !== undefined) return error.detail;
    if (error.cause !== undefined) return detailFromUnknown(error.cause);
  }
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = error.cause;
    if (cause !== undefined && cause !== error) return detailFromUnknown(cause);
  }
  const detail = error instanceof Error ? error.message : String(error);
  const trimmed = detail.trim();
  return (trimmed.length === 0 ? "unknown error" : trimmed).slice(0, 2_000);
};

const detailFromCause = (cause: Cause.Cause<unknown>): string =>
  detailFromUnknown(Cause.squash(cause));

const operationError = (
  operation: PluginPackageOperation,
  error: unknown,
  id?: string,
): PluginPackageOperationError => {
  if (isPluginPackageOperationError(error)) return error;
  return new PluginPackageOperationError({
    ...(id === undefined ? {} : { id }),
    operation,
    ...(typeof error === "string" ? { detail: error } : { cause: error }),
  });
};

const makeDefinition = (
  discovered: DiscoveredPackage,
  activatePackage: PluginPackageActivator,
  onRetired: () => void,
  onCleanupError: (error: unknown) => void,
): PluginDefinition => {
  const declaredCommands = new Set(discovered.manifest.contributes?.commands ?? []);

  return {
    id: discovered.manifest.id,
    version: discovered.manifest.version,
    activate(context: PluginActivationContext) {
      context.onDispose(onRetired);
      const api: PluginPackageApi = {
        onDispose(cleanup) {
          context.onDispose(async () => {
            try {
              await cleanup();
            } catch (error) {
              onCleanupError(error);
              throw error;
            }
          });
        },
        registerCommand(command, handler) {
          if (!discovered.manifest.capabilities.includes(COMMAND_CAPABILITY)) {
            throw new Error(`Manifest does not declare capability ${COMMAND_CAPABILITY}`);
          }
          if (!declaredCommands.has(command.id)) {
            throw new Error(`Command ${command.id} is not declared in the manifest`);
          }
          PluginCommandCatalog.registerPluginCommand(context, {
            command,
            handler: Effect.tryPromise({
              try: async () => handler(),
              catch: (cause) => new PluginCommandCatalog.PluginCommandExecutionError({ cause }),
            }).pipe(
              Effect.flatMap((result) =>
                decodeInvocationResult(result).pipe(
                  Effect.mapError(
                    (cause) => new PluginCommandCatalog.PluginCommandExecutionError({ cause }),
                  ),
                ),
              ),
            ),
          });
        },
      };
      return activatePackage(api);
    },
  };
};

export class PluginPackageManager extends Context.Service<
  PluginPackageManager,
  {
    readonly status: Effect.Effect<PluginPackageStatusSnapshot, PluginPackageOperationError>;
    readonly enable: (
      id: string,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
    readonly disable: (
      id: string,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
    readonly reload: (
      id: string,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
  }
>()("t3/plugins/PluginPackageManager") {}

export const make = Effect.fn("PluginPackageManager.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
  const semaphore = yield* Semaphore.make(1);
  const pluginsDirectory = path.join(config.stateDir, "plugins");
  const pluginCacheDirectory = path.join(config.stateDir, "plugin-cache");
  const activeDefinitions = new Map<string, PluginDefinition>();
  const activeCacheDirectories = new Map<string, string>();
  const activeManifests = new Map<string, PluginManifestType>();
  const activeRetirements = new Map<string, Promise<void>>();
  const packageErrors = new Map<string, string>();
  let loadSequence = 0;

  const removeCacheDirectory = (directory: string) =>
    fileSystem
      .remove(directory, { recursive: true, force: true })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to remove local plugin package cache", { directory, error }),
        ),
      );

  const validatePackageTree = Effect.fn("PluginPackageManager.validatePackageTree")(function* (
    discovered: DiscoveredPackage,
    operation: PluginPackageOperation,
  ) {
    const canonicalPluginsDirectory = yield* fileSystem
      .realPath(pluginsDirectory)
      .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
    const relativeRoot = path.relative(pluginsDirectory, discovered.directory);
    const pending: Array<readonly [lexical: string, expectedCanonical: string]> = [
      [discovered.directory, path.resolve(canonicalPluginsDirectory, relativeRoot)],
    ];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      const [lexical, expectedCanonical] = current;
      const canonical = yield* fileSystem
        .realPath(lexical)
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
      if (path.normalize(canonical) !== path.normalize(expectedCanonical)) {
        return yield* operationError(
          operation,
          "symbolic links are not supported in trusted local plugin packages",
          discovered.manifest.id,
        );
      }
      const info = yield* fileSystem
        .stat(lexical)
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
      if (info.type !== "Directory") continue;
      const entries = yield* fileSystem
        .readDirectory(lexical)
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
      for (const entry of entries) {
        pending.push([path.join(lexical, entry), path.join(expectedCanonical, entry)]);
      }
    }
  });

  const discover = Effect.fn("PluginPackageManager.discover")(function* (
    operation: PluginPackageOperation,
  ) {
    yield* fileSystem
      .makeDirectory(pluginsDirectory, { recursive: true })
      .pipe(Effect.mapError((error) => operationError(operation, error)));
    const entries = yield* fileSystem
      .readDirectory(pluginsDirectory)
      .pipe(Effect.mapError((error) => operationError(operation, error)));
    const discovered = new Map<string, DiscoveredPackage>();
    const errors: Array<PluginPackageDiscoveryError> = [];

    for (const entry of [...entries].sort()) {
      const directory = path.join(pluginsDirectory, entry);
      const manifestPath = path.join(directory, MANIFEST_FILE_NAME);
      if (
        !(yield* fileSystem
          .exists(manifestPath)
          .pipe(Effect.mapError((error) => operationError(operation, error))))
      )
        continue;

      const decoded = yield* Effect.exit(
        fileSystem.readFileString(manifestPath).pipe(Effect.flatMap(decodeManifestJson)),
      );
      if (decoded._tag === "Failure") {
        errors.push({ directory: entry, error: detailFromUnknown(decoded.cause) });
        continue;
      }
      const packageManifest = decoded.value;
      if (packageManifest.entrypoints.server === undefined) {
        errors.push({ directory: entry, error: "manifest must define entrypoints.server" });
        continue;
      }
      if (discovered.has(packageManifest.id)) {
        errors.push({ directory: entry, error: `duplicate package id ${packageManifest.id}` });
        continue;
      }
      discovered.set(packageManifest.id, { directory, manifest: packageManifest });
    }

    return { errors, packages: discovered } satisfies DiscoveryResult;
  });

  const loadDefinition = Effect.fn("PluginPackageManager.loadDefinition")(function* (
    discovered: DiscoveredPackage,
    operation: PluginPackageOperation,
  ) {
    const serverEntrypoint = discovered.manifest.entrypoints.server;
    if (serverEntrypoint === undefined) {
      return yield* operationError(
        operation,
        "manifest must define entrypoints.server",
        discovered.manifest.id,
      );
    }
    yield* validatePackageTree(discovered, operation);
    const sourceEntrypointPath = path.resolve(discovered.directory, serverEntrypoint);
    const relativeEntrypoint = path.relative(discovered.directory, sourceEntrypointPath);
    if (
      relativeEntrypoint === ".." ||
      relativeEntrypoint.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeEntrypoint)
    ) {
      return yield* operationError(
        operation,
        "entrypoint escapes the package directory",
        discovered.manifest.id,
      );
    }

    const cacheDirectory = path.join(
      pluginCacheDirectory,
      discovered.manifest.id,
      String(loadSequence++),
    );
    yield* fileSystem
      .makeDirectory(path.dirname(cacheDirectory), { recursive: true })
      .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
    const copied = yield* Effect.exit(
      fileSystem
        .copy(discovered.directory, cacheDirectory)
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id))),
    );
    if (copied._tag === "Failure") {
      yield* removeCacheDirectory(cacheDirectory);
      return yield* Effect.failCause(copied.cause);
    }
    const entrypointPath = path.resolve(cacheDirectory, serverEntrypoint);

    const loaded = yield* Effect.exit(
      Effect.gen(function* () {
        const moduleUrl = NodeURL.pathToFileURL(entrypointPath);
        const module = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ moduleUrl.href) as Promise<Record<string, unknown>>,
          catch: (cause) => operationError(operation, cause, discovered.manifest.id),
        });
        if (typeof module.default !== "function") {
          return yield* operationError(
            operation,
            "server entrypoint must export a default activation function",
            discovered.manifest.id,
          );
        }
        return module.default as PluginPackageActivator;
      }),
    );
    if (loaded._tag === "Failure") {
      yield* removeCacheDirectory(cacheDirectory);
      return yield* Effect.failCause(loaded.cause);
    }

    let markRetired: () => void = () => {};
    const retired = new Promise<void>((resolve) => {
      markRetired = resolve;
    });
    return {
      cacheDirectory,
      definition: makeDefinition(discovered, loaded.value, markRetired, (error) => {
        packageErrors.set(discovered.manifest.id, detailFromUnknown(error));
      }),
      retired,
    } satisfies LoadedDefinition;
  });

  const definitionList = (replacement?: readonly [string, PluginDefinition | undefined]) => {
    const definitions = new Map(activeDefinitions);
    if (replacement !== undefined) {
      const [id, definition] = replacement;
      if (definition === undefined) definitions.delete(id);
      else definitions.set(id, definition);
    }
    return [...definitions.values()].sort((left, right) => left.id.localeCompare(right.id));
  };

  const readEnabledIds = settings.getSettings.pipe(
    Effect.map((current) => new Set(current.enabledPluginIds)),
  );

  const persistEnabledIds = (
    ids: ReadonlySet<string>,
    operation: PluginPackageOperation,
    id?: string,
  ) =>
    settings.setEnabledPluginIds([...ids].sort()).pipe(
      Effect.mapError((error) => operationError(operation, error, id)),
      Effect.asVoid,
    );

  const statusUnlocked = Effect.fn("PluginPackageManager.status")(function* (
    operation: PluginPackageOperation,
  ): Effect.fn.Return<PluginPackageStatusSnapshot, PluginPackageOperationError> {
    const [discovery, enabledIds] = yield* Effect.all(
      [
        discover(operation),
        readEnabledIds.pipe(Effect.mapError((error) => operationError(operation, error))),
      ],
      { concurrency: "unbounded" },
    );
    const discovered = discovery.packages;
    const errors = [...discovery.errors];
    const packages: Array<PluginPackageStatus> = [];
    const packageIds = new Set([...discovered.keys(), ...activeManifests.keys()]);

    for (const id of [...packageIds].sort()) {
      const activeManifest = activeManifests.get(id);
      const packageManifest = activeManifest ?? discovered.get(id)?.manifest;
      if (packageManifest === undefined) continue;
      const enabled = enabledIds.has(id);
      const active = activeDefinitions.has(id);
      const error =
        packageErrors.get(id) ?? (enabled && !active ? "enabled package is not active" : undefined);
      packages.push({
        id: packageManifest.id,
        version: packageManifest.version,
        apiVersion: packageManifest.apiVersion,
        enabled,
        state: error !== undefined ? "error" : active ? "active" : "disabled",
        capabilities: [...packageManifest.capabilities],
        contributions: { commands: [...(packageManifest.contributes?.commands ?? [])] },
        ...(error === undefined ? {} : { error }),
      });
    }

    for (const id of [...enabledIds].sort()) {
      if (!discovered.has(id)) {
        errors.push({ directory: id, error: "enabled package was not discovered" });
      }
    }

    return { errors, packages };
  });

  const transition = Effect.fn("PluginPackageManager.transition")(
    (operation: "enable" | "reload", id: string) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const discovery = yield* restore(discover(operation));
          const pluginPackage = discovery.packages.get(id);
          if (pluginPackage === undefined) return yield* new PluginPackageNotFoundError({ id });
          const enabledIds = yield* restore(
            readEnabledIds.pipe(Effect.mapError((error) => operationError(operation, error, id))),
          );
          if (operation === "reload" && !enabledIds.has(id)) {
            return yield* operationError(operation, "package is not enabled", id);
          }
          if (operation === "enable" && activeDefinitions.has(id) && enabledIds.has(id)) {
            return yield* statusUnlocked(operation);
          }
          packageErrors.delete(id);

          const previousEnabledIds = new Set(enabledIds);
          const previousCacheDirectory = activeCacheDirectories.get(id);
          const previousRetirement = activeRetirements.get(id);
          const loadedExit = yield* Effect.exit(restore(loadDefinition(pluginPackage, operation)));
          if (loadedExit._tag === "Failure") {
            packageErrors.set(id, detailFromCause(loadedExit.cause));
            return yield* Effect.failCause(loadedExit.cause);
          }
          const loaded = loadedExit.value;
          if (operation === "enable") {
            enabledIds.add(id);
            const persisted = yield* Effect.exit(persistEnabledIds(enabledIds, operation, id));
            if (persisted._tag === "Failure") {
              packageErrors.set(id, detailFromCause(persisted.cause));
              yield* removeCacheDirectory(loaded.cacheDirectory);
              return yield* Effect.failCause(persisted.cause);
            }
          }
          const previousCatalog = yield* catalog.list;
          const reconciled = yield* Effect.exit(
            restore(
              catalog
                .reconcile(definitionList([id, loaded.definition]))
                .pipe(Effect.mapError((error) => operationError(operation, error, id))),
            ),
          );
          if (reconciled._tag === "Failure") {
            const currentCatalog = yield* catalog.list;
            if (currentCatalog.generation === previousCatalog.generation) {
              if (operation === "enable") {
                const rolledBack = yield* Effect.exit(
                  persistEnabledIds(previousEnabledIds, operation, id),
                );
                if (rolledBack._tag === "Failure") {
                  packageErrors.set(id, detailFromCause(reconciled.cause));
                  yield* removeCacheDirectory(loaded.cacheDirectory);
                  yield* Effect.logWarning("Failed to restore enabled package settings", {
                    id,
                    error: rolledBack.cause,
                  });
                  return yield* Effect.failCause(reconciled.cause);
                }
              }
              packageErrors.set(id, detailFromCause(reconciled.cause));
              yield* removeCacheDirectory(loaded.cacheDirectory);
              return yield* Effect.failCause(reconciled.cause);
            }
          }

          activeDefinitions.set(id, loaded.definition);
          activeCacheDirectories.set(id, loaded.cacheDirectory);
          activeManifests.set(id, pluginPackage.manifest);
          activeRetirements.set(id, loaded.retired);
          if (previousCacheDirectory !== undefined) {
            if (reconciled._tag === "Failure" && previousRetirement !== undefined) {
              yield* Effect.promise(() => previousRetirement);
            }
            yield* removeCacheDirectory(previousCacheDirectory);
          }
          if (reconciled._tag === "Failure") return yield* Effect.failCause(reconciled.cause);
          return yield* statusUnlocked(operation);
        }),
      ),
  );

  const disableUnlocked = Effect.fn("PluginPackageManager.disable")((id: string) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const discovery = yield* restore(discover("disable"));
        const enabledIds = yield* restore(
          readEnabledIds.pipe(Effect.mapError((error) => operationError("disable", error, id))),
        );
        if (!discovery.packages.has(id) && !enabledIds.has(id) && !activeDefinitions.has(id)) {
          return yield* new PluginPackageNotFoundError({ id });
        }
        packageErrors.delete(id);

        const previousEnabledIds = new Set(enabledIds);
        enabledIds.delete(id);
        const persisted = yield* Effect.exit(persistEnabledIds(enabledIds, "disable", id));
        if (persisted._tag === "Failure") return yield* Effect.failCause(persisted.cause);
        const previousCatalog = yield* catalog.list;
        const reconciled = yield* Effect.exit(
          restore(
            catalog
              .reconcile(definitionList([id, undefined]))
              .pipe(Effect.mapError((error) => operationError("disable", error, id))),
          ),
        );
        if (reconciled._tag === "Failure") {
          const currentCatalog = yield* catalog.list;
          if (currentCatalog.generation === previousCatalog.generation) {
            const rolledBack = yield* Effect.exit(
              persistEnabledIds(previousEnabledIds, "disable", id),
            );
            if (rolledBack._tag === "Failure") {
              yield* Effect.logWarning("Failed to restore enabled package settings", {
                id,
                error: rolledBack.cause,
              });
              return yield* Effect.failCause(reconciled.cause);
            }
            return yield* Effect.failCause(reconciled.cause);
          }
        }

        activeDefinitions.delete(id);
        activeManifests.delete(id);
        const cacheDirectory = activeCacheDirectories.get(id);
        const retirement = activeRetirements.get(id);
        activeCacheDirectories.delete(id);
        activeRetirements.delete(id);
        if (cacheDirectory !== undefined) {
          if (reconciled._tag === "Failure" && retirement !== undefined) {
            yield* Effect.promise(() => retirement);
          }
          yield* removeCacheDirectory(cacheDirectory);
        }
        if (reconciled._tag === "Failure") return yield* Effect.failCause(reconciled.cause);
        return yield* statusUnlocked("disable");
      }),
    ),
  );

  yield* settings.start.pipe(Effect.mapError((error) => operationError("status", error)));
  yield* fileSystem
    .remove(pluginCacheDirectory, { recursive: true, force: true })
    .pipe(Effect.mapError((error) => operationError("status", error)));
  yield* fileSystem
    .makeDirectory(pluginCacheDirectory, { recursive: true })
    .pipe(Effect.mapError((error) => operationError("status", error)));
  yield* fileSystem
    .makeDirectory(pluginsDirectory, { recursive: true })
    .pipe(Effect.mapError((error) => operationError("status", error)));

  const startupDiscovery = yield* discover("status");
  for (const error of startupDiscovery.errors) {
    yield* Effect.logWarning("Invalid local plugin package", error);
  }
  const startupEnabledIds = yield* readEnabledIds.pipe(
    Effect.mapError((error) => operationError("status", error)),
  );
  for (const id of [...startupEnabledIds].sort()) {
    const pluginPackage = startupDiscovery.packages.get(id);
    if (pluginPackage === undefined) {
      yield* Effect.logWarning("Enabled local plugin package was not discovered", { id });
      continue;
    }
    const startup = yield* Effect.exit(
      Effect.gen(function* () {
        const loaded = yield* loadDefinition(pluginPackage, "status");
        const reconciled = yield* Effect.exit(
          catalog
            .reconcile(definitionList([id, loaded.definition]))
            .pipe(Effect.mapError((error) => operationError("status", error, id))),
        );
        if (reconciled._tag === "Failure") {
          yield* removeCacheDirectory(loaded.cacheDirectory);
          return yield* Effect.failCause(reconciled.cause);
        }
        activeDefinitions.set(id, loaded.definition);
        activeCacheDirectories.set(id, loaded.cacheDirectory);
        activeManifests.set(id, pluginPackage.manifest);
        activeRetirements.set(id, loaded.retired);
      }),
    );
    if (startup._tag === "Failure") {
      const detail = detailFromCause(startup.cause);
      packageErrors.set(id, detail);
      yield* Effect.logWarning("Failed to activate enabled local plugin package", { id, detail });
    }
  }

  yield* Effect.addFinalizer(() =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const shutdown = yield* Effect.exit(catalog.reconcile([]));
        if (shutdown._tag === "Failure") {
          yield* Effect.logWarning("Failed to retire local plugin packages during shutdown", {
            error: detailFromCause(shutdown.cause),
          });
        }
        for (const [id, error] of packageErrors) {
          yield* Effect.logWarning("Local plugin package reported a shutdown error", { id, error });
        }
        yield* removeCacheDirectory(pluginCacheDirectory);
      }),
    ),
  );

  return {
    status: semaphore.withPermits(1)(statusUnlocked("status")),
    enable: (id: string) => semaphore.withPermits(1)(transition("enable", id)),
    disable: (id: string) => semaphore.withPermits(1)(disableUnlocked(id)),
    reload: (id: string) => semaphore.withPermits(1)(transition("reload", id)),
  } as const;
});

export const layer = Layer.effect(PluginPackageManager, make());
