import {
  defaultInstanceIdForDriver,
  INFERENCE_DRIVERS,
  INFERENCE_HARNESSES,
  isInferenceProviderConfig,
  isInferenceRoutingEnabled,
  ProviderDriverKind,
  ProviderInstanceId,
  providerInstanceConfigEnabledFlag,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@t3tools/contracts";
import * as NodeUtil from "node:util";
import { openCodeRouteProblem, routeProvider } from "../inference/routes.ts";

import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ManagedProviders from "../policy/managedProviders.ts";
import * as Settings from "../serverSettings.ts";
import * as SecretResolver from "../secrets/SecretResolver.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "./builtInDrivers.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import type * as PortScanner from "../preview/PortScanner.ts";
import * as TraexProviderRoutes from "../inference/TraexProviderRoutes.ts";

type ProviderInstanceRegistryHydrationEnv =
  | Exclude<
      BuiltInDriversEnv,
      | ProviderOrchestrationAdapterInfrastructure.ProviderOrchestrationAdapterInfrastructure
      | AcpRegistrySupport.AcpRegistryCatalog
      | ProviderHost.ProviderHost
    >
  | Settings.ServerSettingsService
  | BackgroundPolicy.BackgroundPolicy
  | ServerConfig.ServerConfig
  | Path.Path
  | FileSystem.FileSystem
  // Secret provider reads.
  | SecureRandom.SecureRandom
  // The Claude runner counts its CLIs as running agents for port discovery.
  | PortScanner.PortDiscovery
  // Adapter ids read which subagent threads predate short ids.
  | SqlClient.SqlClient;

export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
  hostEnvironment: NodeJS.ProcessEnv = {},
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVERS) {
    if (driver.metadata.hasDefaultInstance === false) continue;
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) continue;
    merged[instanceId] = { driver: driver.driverKind };
  }

  // Project enables apply before routing validation, which must still reject incomplete routes.
  for (const overrides of Object.values(settings.projectSettingsOverrides)) {
    for (const [rawInstanceId, projectOverride] of Object.entries(
      overrides?.providerInstances ?? {},
    )) {
      if (projectOverride.enabled !== true) continue;
      const instanceId = rawInstanceId as ProviderInstanceId;
      const existing = merged[instanceId];
      if (existing === undefined || resolveProviderInstanceEnabled(existing)) continue;
      merged[instanceId] = {
        ...existing,
        enabled: true,
        ...(providerInstanceConfigEnabledFlag(existing.config) === false
          ? { config: { ...(existing.config as Record<string, unknown>), enabled: true } }
          : {}),
      };
    }
  }

  for (const driver of INFERENCE_DRIVERS) {
    const id = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
    const native = merged[id];
    if (!native || !isInferenceRoutingEnabled(native.config)) continue;
    const { replacesAccounts } = INFERENCE_HARNESSES[driver];
    if (!isInferenceProviderConfig(native.config)) {
      if (replacesAccounts) merged[id] = { ...native, enabled: false };
      continue;
    }
    const route = native.config;
    if (
      driver === "opencode" &&
      openCodeRouteProblem(native.environment, hostEnvironment.OPENCODE_CONFIG_CONTENT)
    )
      continue;
    const proxy = routeProvider(driver, route.inferenceHostLabel || null, {
      baseUrl: route.inferenceBaseUrl,
      key: route.inferenceKey,
      models: route.inferenceModels,
      homePath: route.inferenceHomePath,
      current: (name) => {
        const value = native.environment?.find((entry) => entry.name === name)?.value;
        return typeof value === "string" ? value : hostEnvironment[name];
      },
    });
    const names = new Set(proxy.environment.map((entry) => entry.name));
    merged[id] = {
      ...native,
      ...(replacesAccounts ? { displayName: proxy.displayName } : {}),
      config: { ...native.config, ...proxy.config },
      environment: [
        ...(native.environment ?? []).filter((entry) => !names.has(entry.name)),
        ...proxy.environment,
      ],
    };
  }

  return merged as ProviderInstanceConfigMap;
};

export const DEV_REPLAY_INSTANCE_ID = ProviderInstanceId.make("devReplay");

/**
 * Dev servers run from source keep a free ACP agent that replays recorded turns, so UI checks
 * need no paid model. Bundled servers, such as desktop dev, have no agent script and skip it.
 */
export const seedDevReplayInstance = Effect.fn(
  "ProviderInstanceRegistryHydration.seedDevReplayInstance",
)(function* () {
  const config = yield* ServerConfig.ServerConfig;
  if (config.devUrl === undefined) return;
  const path = yield* Path.Path;
  const agentPath = yield* path.fromFileUrl(
    new URL("../../scripts/dev-replay-agent.ts", import.meta.url),
  );
  if (!(yield* (yield* FileSystem.FileSystem).exists(agentPath))) return;
  const commandPath = yield* HostProcess.ExecutablePath;
  const serverSettings = yield* Settings.ServerSettingsService;
  const existing = (yield* serverSettings.getSettings).providerInstances[DEV_REPLAY_INSTANCE_ID];
  const existingConfig = existing?.config as Record<string, unknown> | undefined;
  // Rewritten only when stale: the node and checkout paths can move.
  if (
    existingConfig?.commandPath === commandPath &&
    (existingConfig.commandArgs as ReadonlyArray<unknown> | undefined)?.[0] === agentPath
  ) {
    return;
  }
  // Keeps user edits, such as turning the provider off.
  const instance: ProviderInstanceConfig = {
    displayName: "Replay (dev)",
    ...existing,
    driver: ProviderDriverKind.make("acpRegistry"),
    config: { ...existingConfig, source: "local", commandPath, commandArgs: [agentPath] },
  };
  yield* serverSettings.updateProviderInstance({
    operation: "upsert",
    instanceId: DEV_REPLAY_INSTANCE_ID,
    instance,
  });
});

// A label is display-only, so only kind and config can change what a vault returns.
const vaultConfigs = (settings: ServerSettings) =>
  Object.entries(settings.secretProviders).map(([id, { kind, config }]) => [id, kind, config]);

export const layerSettingsWatcher = (
  settingsChanges: Stream.Stream<ServerSettings>,
  // The settings the registry was built from: a change queued during startup differs from these.
  initialSettings: ServerSettings | undefined,
  hostEnvironment: NodeJS.ProcessEnv = {},
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
      const serverSettings = yield* Settings.ServerSettingsService;
      let secretProviders = initialSettings && vaultConfigs(initialSettings);
      yield* settingsChanges.pipe(
        Stream.runForEach(() =>
          // The subscription predates the seed read, so a queued change can be
          // older than the seed. A failed current read must leave the registry intact.
          serverSettings.getSettings.pipe(
            Effect.flatMap((current) =>
              Effect.gen(function* () {
                yield* mutator.reconcile(deriveProviderInstanceConfigMap(current, hostEnvironment));
                // Reconcile leaves instances parked on an unreadable secret alone,
                // and a corrected secret provider is what can make them readable.
                const next = vaultConfigs(current);
                if (!NodeUtil.isDeepStrictEqual(secretProviders, next)) {
                  secretProviders = next;
                  yield* mutator.reloadSecrets();
                }
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );

export const layer: Layer.Layer<
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  ProviderInstanceRegistryHydrationEnv
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    yield* seedDevReplayInstance().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Dev replay agent unavailable", cause)),
    );
    // Subscribe before the seed read so saves during registry construction are queued.
    const settingsChanges = yield* serverSettings.subscribeChanges;
    const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    // Drivers launch from the host environment, minus launch overrides a policy ignores.
    const hostEnvironment = ManagedProviders.providerHostEnvironment(
      serverSettings.managedPolicy,
      yield* HostProcess.Environment,
    );
    const traex = yield* TraexProviderRoutes.TraexProviderRoutes;
    const initialConfigMap =
      initialSettings === undefined
        ? ({} as ProviderInstanceConfigMap)
        : deriveProviderInstanceConfigMap(initialSettings, hostEnvironment);
    // Instances of drivers the policy leaves out stay listed, as unavailable, so their threads
    // explain why instead of losing their provider.
    const layerMutable = ProviderInstanceRegistry.layer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
      prepareConfigMap: (map) => traex.apply(map, serverSettings.managedPolicy),
      blockedReason: (driver) =>
        ManagedProviders.disallowedDriverReason(serverSettings.managedPolicy, driver),
    }).pipe(
      Layer.provide(ProviderOrchestrationAdapterInfrastructure.layer),
      Layer.provide(AcpRegistrySupport.layerFromHost),
      Layer.provide(ProviderHostLive.layer),
      Layer.provide(Layer.succeed(HostProcess.Environment, hostEnvironment)),
      Layer.provide(SecretResolver.layer),
    );

    return layerSettingsWatcher(settingsChanges, initialSettings, hostEnvironment).pipe(
      Layer.provideMerge(layerMutable),
    );
  }),
).pipe(Layer.provide(TraexProviderRoutes.layer)) as Layer.Layer<
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  ProviderInstanceRegistryHydrationEnv
>;
