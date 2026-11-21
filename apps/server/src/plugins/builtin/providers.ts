import { builtinServiceLayer, builtinLifecycleLayer } from "@t3tools/shared/pluginKernel";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../config.ts";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as ResetCreditCoordinator from "../../provider/resetCreditCoordinator.ts";
import * as EventNdjsonLogger from "../../provider/EventNdjsonLogger.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderInstanceRegistryHydration from "../../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import * as AcpRegistryPlugin from "./providers/acp-registry.ts";
import * as AntigravityPlugin from "./providers/antigravity.ts";
import * as CodexPlugin from "./providers/codex.ts";
import * as OpenCodePlugin from "./providers/opencode.ts";
import { layerServerSettings } from "./settings.ts";

// One rotating store behind both logger views, so driver instances never race
// its rotation. Diagnostics must not block startup: a store that cannot open
// degrades to the no-op loggers.
const layerProviderEventLoggers = builtinServiceLayer("t3.server")(
  ProviderEventLoggers.ProviderEventLoggers,
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig.ServerConfig;
    const attribution = yield* ResourceAttribution.ResourceAttribution;
    const store = yield* EventNdjsonLogger.makeEventNdjsonLogStore(providerEventLogPath, {
      attribution,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(error.message, { error }).pipe(
          Effect.annotateLogs({ scope: "provider-observability" }),
          Effect.as(undefined),
        ),
      ),
    );
    if (!store) return ProviderEventLoggers.NoOpProviderEventLoggers;
    yield* Effect.addFinalizer(() => store.close());
    return { native: store.logger("native"), canonical: store.logger("canonical") };
  }),
);

export const layerProviderInstallationRefresh = builtinLifecycleLayer(
  "t3.providers",
  "t3/server/root/lifecycle-3",
  Effect.gen(function* () {
    const antigravityChanges = yield* AntigravityPlugin.installationChanges;
    const codexChanges = yield* CodexPlugin.installationChanges;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    yield* Stream.merge(antigravityChanges, codexChanges).pipe(
      Stream.runForEach((state) =>
        instances.listInstances.pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter((instance) => instance.driverKind === state.driver),
              (instance) => providers.refreshInstance(instance.instanceId),
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

export const layerProviderRegistry = ProviderRegistry.layer;

export const layerProviderInstanceRegistryHydration = ProviderInstanceRegistryHydration.layer.pipe(
  Layer.provide(SqlitePersistence.layerConfig),
);

export const layerProviderInstallations = Layer.mergeAll(
  AntigravityPlugin.layerInstallation.pipe(Layer.provide(layerServerSettings)),
  CodexPlugin.layerInstallation,
);

export const layerAcpRegistrySupport = AcpRegistryPlugin.layerSupport;

export const layerProviderRuntimeServices = Layer.mergeAll(
  layerProviderEventLoggers,
  ModelManifest.layerModelCatalog.pipe(Layer.provideMerge(ModelManifest.layer)),
  ResetCreditCoordinator.layer,
  ProviderLatestVersions.layer,
  McpProviderSessions.layer,
);

export const layerOpenCodeRuntime = OpenCodePlugin.layerRuntime;

export const layerProviderAdapterRegistry =
  ProviderAdapterRegistry.layerFromProviderInstanceRegistry;
