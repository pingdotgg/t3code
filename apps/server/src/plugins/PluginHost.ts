import type { PluginId } from "@t3tools/contracts";
import type { LoadedServerPlugin } from "@t3tools/plugin-api/package";
import type { PluginActivationContext, PluginCollection } from "@t3tools/plugin-api/server";
import { PluginStoreError as ApiPluginStoreError } from "@t3tools/plugin-api/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { PluginPackageResolver } from "./PluginPackageResolver.ts";
import { PluginRegistry } from "./PluginRegistry.ts";
import { makePluginRuntimeAdapter } from "./PluginRuntimeAdapter.ts";
import { PluginStore } from "./PluginStore.ts";

export interface PluginHostShape {
  readonly activateInstalledPlugins: Effect.Effect<void>;
}

export class PluginHost extends Context.Service<PluginHost, PluginHostShape>()(
  "t3/plugins/PluginHost",
) {}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function toApiStoreError(error: unknown): ApiPluginStoreError {
  return error instanceof ApiPluginStoreError
    ? error
    : new ApiPluginStoreError("Plugin store operation failed.", error);
}

function makeActivationContext(input: {
  readonly pluginId: PluginId;
  readonly store: PluginStore["Service"];
  readonly registry: PluginRegistry["Service"];
  readonly runtime: PluginActivationContext["runtime"];
}): PluginActivationContext {
  const { pluginId, store, registry, runtime } = input;
  const collectionAdapter = <A>(collection: string): PluginCollection<A> => ({
    list: () => store.list<A>(pluginId, collection).pipe(Effect.mapError(toApiStoreError)),
    get: (documentId) =>
      store.get<A>(pluginId, collection, documentId).pipe(Effect.mapError(toApiStoreError)),
    upsert: (documentId, document) =>
      store
        .upsert(pluginId, collection, documentId, document)
        .pipe(Effect.mapError(toApiStoreError)),
    delete: (documentId) =>
      store.delete(pluginId, collection, documentId).pipe(Effect.mapError(toApiStoreError)),
  });

  return {
    pluginId,
    store: {
      registerCollection: <A, I>(collection: string, schema: Schema.Codec<A, I>) =>
        store
          .registerCollection(pluginId, collection, schema as Schema.Codec<unknown, unknown>)
          .pipe(Effect.as(collectionAdapter<A>(collection))),
    },
    commands: {
      register: (command, registration) =>
        registry.registerCommand(pluginId, command, registration),
    },
    ui: {
      setPlacementBadgeProvider: (placementId, provider) =>
        registry.setPlacementBadgeProvider(pluginId, placementId, provider),
    },
    runtime,
    events: {
      publish: (event) => registry.publish(pluginId, event),
    },
  };
}

const makePluginHost = Effect.gen(function* () {
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

  const activatePlugin = (pluginPackage: LoadedServerPlugin) =>
    Effect.gen(function* () {
      const plugin = pluginPackage.serverPlugin;
      const pluginId = pluginPackage.manifest.id;
      const pluginScope = yield* Scope.make("sequential");
      yield* Scope.addFinalizer(
        pluginScope,
        registry.clearPluginContributions(pluginId).pipe(Effect.ignoreCause({ log: true })),
      );
      pluginScopes.set(pluginId, pluginScope);
      const context = makeActivationContext({
        pluginId,
        store,
        registry,
        runtime,
      });
      yield* plugin.activate(context).pipe(Effect.provideService(Scope.Scope, pluginScope));
      yield* registry.registerActivePlugin(pluginPackage);
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const pluginId = pluginPackage.manifest.id;
          const pluginScope = pluginScopes.get(pluginId);
          if (pluginScope) {
            pluginScopes.delete(pluginId);
            yield* Scope.close(pluginScope, Exit.void).pipe(Effect.ignoreCause({ log: true }));
          }
          yield* registry.registerFailedPlugin(pluginPackage, errorMessage(error));
        }).pipe(
          Effect.flatMap(() =>
            Effect.logWarning("Plugin activation failed", {
              pluginId: pluginPackage.manifest.id,
              error,
            }),
          ),
        ),
      ),
    );

  const activateInstalledPlugins = packageResolver.discover.pipe(
    Effect.flatMap((packages) =>
      Effect.forEach(packages, activatePlugin, {
        concurrency: 1,
        discard: true,
      }),
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
