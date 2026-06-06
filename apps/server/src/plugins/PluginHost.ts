import type { PluginId, PluginRpcError } from "@t3tools/contracts";
import type { FailedPluginDiscovery, LoadedServerPlugin } from "@t3tools/plugin-api/package";
import type { PluginActivationContext, PluginCollection } from "@t3tools/plugin-api/server";
import { PluginStoreError as ApiPluginStoreError } from "@t3tools/plugin-api/server";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { PlatformError } from "effect/PlatformError";

import { ServerConfig } from "../config.ts";
import { PluginPackageResolver, type PluginDiscoveryResult } from "./PluginPackageResolver.ts";
import { PluginRegistry, type PluginActivationRegistration } from "./PluginRegistry.ts";
import { makePluginRuntimeAdapter } from "./PluginRuntimeAdapter.ts";
import { PluginStore, type PluginStoreCollection } from "./PluginStore.ts";

export interface PluginHostShape {
  readonly activateInstalledPlugins: Effect.Effect<void, PlatformError | PluginRpcError>;
}

export class PluginHost extends Context.Service<PluginHost, PluginHostShape>()(
  "t3/plugins/PluginHost",
) {}

function toApiStoreError(error: unknown): ApiPluginStoreError {
  return error instanceof ApiPluginStoreError
    ? error
    : new ApiPluginStoreError("Plugin store operation failed.", error);
}

function makeActivationContext(input: {
  readonly pluginId: PluginId;
  readonly paths: PluginActivationContext["paths"];
  readonly store: PluginStore["Service"];
  readonly registry: PluginRegistry["Service"];
  readonly activationRegistration: PluginActivationRegistration;
  readonly runtime: PluginActivationContext["runtime"];
}): PluginActivationContext {
  const { pluginId, paths, store, registry, activationRegistration, runtime } = input;
  const collectionAdapter = <A>(collection: PluginStoreCollection<A>): PluginCollection<A> => ({
    list: () => collection.list().pipe(Effect.mapError(toApiStoreError)),
    get: (documentId) => collection.get(documentId).pipe(Effect.mapError(toApiStoreError)),
    upsert: (documentId, document) =>
      collection.upsert(documentId, document).pipe(Effect.mapError(toApiStoreError)),
    delete: (documentId) => collection.delete(documentId).pipe(Effect.mapError(toApiStoreError)),
  });

  return {
    pluginId,
    paths,
    store: {
      registerCollection: <A, I>(collection: string, schema: Schema.Codec<A, I>) =>
        store.registerCollection(pluginId, collection, schema).pipe(Effect.map(collectionAdapter)),
    },
    commands: {
      register: (command, registration) =>
        activationRegistration.registerCommand(command, registration),
    },
    ui: {
      setPlacementBadgeProvider: (placementId, provider) =>
        activationRegistration.setPlacementBadgeProvider(placementId, provider),
    },
    runtime,
    events: {
      publish: (event) => registry.publish(pluginId, event),
    },
  };
}

const makePluginHost = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* PluginStore;
  const registry = yield* PluginRegistry;
  const packageResolver = yield* PluginPackageResolver;
  const runtime = yield* makePluginRuntimeAdapter;
  const pluginScopes = new Map<PluginId, Scope.Scope>();

  yield* Effect.addFinalizer(() =>
    Effect.forEach(pluginScopes.values(), (scope) => Scope.close(scope, Exit.void), {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const makeActivationPaths = (pluginId: PluginId): PluginActivationContext["paths"] => ({
    dataDir: path.join(config.stateDir, "plugins", pluginId, "data"),
    cacheDir: path.join(config.pluginsCacheDir, pluginId),
    tempDir: path.join(config.stateDir, "plugins", pluginId, "tmp"),
  });

  const ensureActivationPaths = (paths: PluginActivationContext["paths"]) =>
    Effect.all(
      [
        fs.makeDirectory(paths.dataDir, { recursive: true }),
        fs.makeDirectory(paths.cacheDir, { recursive: true }),
        fs.makeDirectory(paths.tempDir, { recursive: true }),
      ],
      { concurrency: "unbounded", discard: true },
    );

  const deactivatePlugin = (pluginId: PluginId) =>
    Effect.gen(function* () {
      const previousScope = pluginScopes.get(pluginId);
      if (previousScope) {
        pluginScopes.delete(pluginId);
        yield* Scope.close(previousScope, Exit.void).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const deactivatePlugins = (pluginIds: ReadonlyArray<PluginId>) =>
    Effect.forEach(pluginIds, deactivatePlugin, { concurrency: 1, discard: true });

  const activatePlugin = (pluginPackage: LoadedServerPlugin) =>
    Effect.gen(function* () {
      const plugin = pluginPackage.serverPlugin;
      const pluginId = pluginPackage.manifest.id;
      const paths = makeActivationPaths(pluginId);
      yield* ensureActivationPaths(paths);

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const pluginScope = yield* Scope.make("sequential");
          const previousScope = pluginScopes.get(pluginId);
          const activationRegistration = yield* registry.beginActivation(
            pluginPackage,
            pluginScope,
          );
          const context = makeActivationContext({
            pluginId,
            paths,
            store,
            registry,
            activationRegistration,
            runtime,
          });
          const activated = yield* Effect.exit(
            restore(plugin.activate(context).pipe(Effect.provideService(Scope.Scope, pluginScope))),
          );
          if (Exit.isFailure(activated)) {
            yield* Scope.close(pluginScope, Exit.void).pipe(Effect.ignoreCause({ log: true }));
            if (Cause.hasInterrupts(activated.cause)) {
              yield* activationRegistration.cancel;
              return yield* Effect.interrupt;
            }
            const displacedPluginIds = yield* activationRegistration.commitFailed(
              Cause.pretty(activated.cause),
            );
            if (previousScope) {
              pluginScopes.delete(pluginId);
              yield* Scope.close(previousScope, Exit.void).pipe(Effect.ignoreCause({ log: true }));
            }
            yield* deactivatePlugins(displacedPluginIds);
            yield* Effect.logWarning("Plugin activation failed", {
              pluginId,
              cause: Cause.pretty(activated.cause),
            });
            return;
          }

          const displacedPluginIds = yield* activationRegistration.commitActive.pipe(
            Effect.catch((error) =>
              Scope.close(pluginScope, Exit.void).pipe(Effect.andThen(Effect.fail(error))),
            ),
          );
          pluginScopes.set(pluginId, pluginScope);
          if (previousScope) {
            yield* Scope.close(previousScope, Exit.void).pipe(Effect.ignoreCause({ log: true }));
          }
          yield* deactivatePlugins(displacedPluginIds);
        }),
      );
    });

  const registerFailedDiscovery = (plugin: FailedPluginDiscovery, diagnostic: string) =>
    Effect.gen(function* () {
      if (plugin.discovery.pluginId !== undefined) {
        yield* deactivatePlugin(plugin.discovery.pluginId);
      }
      const displacedPluginIds = yield* registry.registerFailedDiscovery(plugin, diagnostic);
      yield* deactivatePlugins(displacedPluginIds);
    });

  const registerFailedDiscoveredPlugin = (
    result: Extract<PluginDiscoveryResult, { readonly status: "failed" | "discovery-failed" }>,
  ) =>
    result.status === "discovery-failed"
      ? registerFailedDiscovery(result.plugin, result.diagnostic)
      : Effect.gen(function* () {
          const pluginId = result.plugin.manifest.id;
          yield* deactivatePlugin(pluginId);
          const displacedPluginIds = yield* registry.registerFailedPlugin(
            result.plugin,
            result.diagnostic,
          );
          yield* deactivatePlugins(displacedPluginIds);
        });

  const activateInstalledPlugins = packageResolver.discover.pipe(
    Effect.flatMap((results) =>
      Effect.forEach(
        results,
        (result) =>
          result.status === "loaded"
            ? activatePlugin(result.plugin)
            : registerFailedDiscoveredPlugin(result),
        {
          concurrency: 1,
          discard: true,
        },
      ),
    ),
  );

  return PluginHost.of({
    activateInstalledPlugins,
  });
});

export const PluginHostLive = Layer.effect(PluginHost, makePluginHost);

export const PluginHostStartupLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const host = yield* PluginHost;
    yield* host.activateInstalledPlugins;
  }),
);
