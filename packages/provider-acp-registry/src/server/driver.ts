import {
  officialAcpRegistryIconUrlForAgentId,
  ProviderDriverKind,
  resolveOfficialAcpRegistryIconUrl,
  type AcpRegistryOperationError,
  type AcpRegistryProbeModel,
  type CustomModelSetting,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { AcpRegistryAdapterV2Driver, type AcpRegistryAdapterV2DriverEnv } from "./adapter.ts";
import { makeAcpRegistryTextGeneration } from "./textGeneration.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import {
  providerModelsFromSettings,
  providerProbeEnvironment,
} from "@t3tools/provider-core/server/snapshotProbe";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  type AcpRegistryAvailableCommands,
  type AcpRegistryConfigurationProbe,
  type AcpRegistryConfigurationProbeResult,
  type AcpRegistryLiveConfiguration,
  type AcpRegistryModelDiscovery,
  deleteAcpRegistrySession,
  disableAcpRegistryProvider,
  listAcpRegistrySessions,
  listAcpRegistryProviders,
  logoutAcpRegistry,
  probeAcpRegistryConfiguration,
  setAcpRegistryProvider,
} from "./probe.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistryAuth from "./auth.ts";
import * as AcpRegistryAuthenticationState from "./authenticationState.ts";
import {
  acpRegistryCurrentModelOptions,
  acpRegistryModelsToDiscover,
  makeAcpRegistryLearnedModelOptionsStore,
  withAcpRegistryLearnedModelOptions,
} from "./learnedModelOptions.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
// Cache only successful authenticated probes so sign-in changes remain visible.
const PROBE_SUCCESS_TTL_MS = 15 * 60 * 1_000;
const PROBE_PROVISIONAL_TTL_MS = 30 * 1_000;
const REGISTRY_REFRESH_FAILURE_BACKOFF_MS = 60 * 1_000;

function acpRegistryProbeTtlMs(provider: ServerProvider): number {
  const discoveredModels = provider.models.filter((model) => !model.isCustom);
  return discoveredModels.length <= 1 ? PROBE_PROVISIONAL_TTL_MS : PROBE_SUCCESS_TTL_MS;
}

interface AcpRegistryEnrichmentCache {
  readonly generation: number;
  readonly entry: {
    readonly provider: ServerProvider;
    readonly launchIdentity?: string;
    readonly expiresAt: number;
  } | null;
}

export function isAcpRegistryCacheValid(
  entry: NonNullable<AcpRegistryEnrichmentCache["entry"]>,
  inspectedVersion: string | null,
  local: boolean,
  now: number,
  inspectedLaunchIdentity?: string,
): boolean {
  return (
    entry.expiresAt > now &&
    ((local && inspectedVersion === null) || entry.provider.version === inspectedVersion) &&
    (inspectedLaunchIdentity === undefined || entry.launchIdentity === inspectedLaunchIdentity)
  );
}

export function updateAcpRegistryEnrichmentCache(input: {
  readonly cache: AcpRegistryEnrichmentCache;
  readonly configuration: AcpRegistryLiveConfiguration;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
  readonly now: number;
}): AcpRegistryEnrichmentCache {
  const { cache, configuration, customModels, now } = input;
  if (cache.entry === null) {
    // Only a live catalog update advances the epoch; options-only updates must not discard an in-flight probe.
    return configuration.models.length > 0 ? { ...cache, generation: cache.generation + 1 } : cache;
  }
  const provider = applyAcpRegistryLiveConfiguration(
    cache.entry.provider,
    configuration,
    customModels,
  );
  if (Equal.equals(provider, cache.entry.provider)) return cache;
  const catalogChanged = !Equal.equals(
    cache.entry.provider.models.filter((model) => !model.isCustom).map((model) => model.slug),
    provider.models.filter((model) => !model.isCustom).map((model) => model.slug),
  );
  return {
    ...cache,
    // Advance the epoch and renew TTL only when the live session actually changed the model catalog.
    generation: catalogChanged ? cache.generation + 1 : cache.generation,
    entry: {
      ...cache.entry,
      provider,
      expiresAt: catalogChanged ? now + acpRegistryProbeTtlMs(provider) : cache.entry.expiresAt,
    },
  };
}
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

function modelsFromDiscovery(
  discovery:
    | Pick<
        AcpRegistryLiveConfiguration,
        "models" | "currentModelId" | "configOptions" | "modelOptionIds"
      >
    | undefined,
  customModels: ReadonlyArray<CustomModelSetting>,
  previousModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  const discovered = discovery?.models ?? [];
  const capabilities =
    discovery === undefined || discovery.configOptions.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors: discovery.configOptions });
  // Model-specific options describe only the session's current model; other
  // models keep the shared ones plus what an earlier session reported for them.
  const modelOptionIds = new Set(discovery?.modelOptionIds ?? []);
  const shared = (discovery?.configOptions ?? []).filter(
    (descriptor) => !modelOptionIds.has(descriptor.id),
  );
  const sharedIds = new Set(shared.map((descriptor) => descriptor.id));
  const capabilitiesFor = ({ id: slug, reasoningEffort }: AcpRegistryProbeModel) => {
    if (slug === discovery?.currentModelId) return capabilities;
    // The levels a model advertises replace the ones an earlier session reported.
    const own = (
      previousModels.find((model) => model.slug === slug)?.capabilities?.optionDescriptors ?? []
    ).filter(
      (descriptor) =>
        !sharedIds.has(descriptor.id) &&
        (reasoningEffort === undefined ||
          descriptor.type !== "select" ||
          descriptor.role !== "reasoning"),
    );
    const optionDescriptors = [...shared, ...own, ...(reasoningEffort ? [reasoningEffort] : [])];
    return optionDescriptors.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors });
  };
  const builtInModels: ReadonlyArray<ServerProviderModel> =
    discovered.length === 0
      ? [
          {
            slug: "default",
            name: "Default",
            isCustom: false,
            isDefault: true,
            capabilities,
          },
        ]
      : discovered.map((model) => ({
          slug: model.id,
          name: model.name,
          isCustom: false,
          ...(model.id === discovery?.currentModelId ? { isDefault: true } : {}),
          capabilities: capabilitiesFor(model),
        }));
  return providerModelsFromSettings(builtInModels, customModels, capabilities);
}

function acpRegistrySnapshotReadiness(
  inspection:
    | AcpRegistrySupport.AcpRegistryInspection
    | { readonly status: "failed"; readonly message: string },
): Pick<ServerProvider, "installed" | "version" | "status" | "message"> {
  switch (inspection.status) {
    case "ready":
      return { installed: true, version: inspection.version, status: "ready" };
    case "unconfigured":
      return {
        installed: false,
        version: null,
        status: "warning",
        message:
          "Select an ACP Registry agent or configure a local ACP executable before starting a thread.",
      };
    case "not_found":
      return {
        installed: false,
        version: null,
        status: "error",
        message: `ACP Registry does not contain agent '${inspection.agentId}'.`,
      };
    case "unsupported":
      return {
        installed: false,
        version: inspection.version,
        status: "error",
        message: `ACP Registry agent '${inspection.agentId}' has no compatible distribution for this environment.`,
      };
    case "missing_runner":
      return {
        installed: false,
        version: inspection.version,
        status: "error",
        message:
          inspection.distribution === "local"
            ? "Local ACP executable is not available on this environment's PATH."
            : `ACP executable '${inspection.runner}' is not available on this environment's PATH.`,
      };
    case "unprepared":
      return {
        installed: false,
        version: inspection.version,
        status: "warning",
        message: `ACP Registry agent '${inspection.agentId}' has not been prepared on this environment.`,
      };
    case "failed":
      return {
        installed: false,
        version: null,
        status: "error",
        message: inspection.message,
      };
  }
}

interface SnapshotIdentity {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationKey: string;
}

function baseSnapshot(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly checkedAt: string;
    readonly installed: boolean;
    readonly version: string | null;
    readonly status: ServerProvider["status"];
    readonly auth: ServerProvider["auth"];
    readonly documentationUrl?: string;
    readonly message?: string;
    readonly probe?: AcpRegistryConfigurationProbeResult;
    readonly probeError?: AcpRegistryOperationError;
  },
): ServerProvider {
  const iconUrl =
    input.settings.source === "local"
      ? null
      : (resolveOfficialAcpRegistryIconUrl(input.probe?.probe.icon) ??
        officialAcpRegistryIconUrlForAgentId(input.settings.agentId));
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    continuation: { groupKey: input.continuationKey },
    enabled: input.settings.enabled,
    installed: input.installed,
    version: input.version,
    status: input.settings.enabled ? input.status : "disabled",
    auth: { ...input.auth, canLogout: input.auth.canLogout ?? false },
    checkedAt: input.checkedAt,
    setup: {
      canInstall: false,
      ...(input.documentationUrl ? { documentationUrl: input.documentationUrl } : {}),
      canAuthenticate:
        input.installed &&
        (input.probe
          ? input.probe.probe.authMethods.length > 0
          : input.settings.source === "local"
            ? (input.probeError?.authMethods?.length ?? 0) > 0
            : input.settings.agentId.length > 0),
    },
    ...(input.message ? { message: input.message } : {}),
    models: modelsFromDiscovery(input.probe?.probe, input.settings.customModels),
    ...(input.probe === undefined
      ? {}
      : {
          nativeSessions: {
            canList: input.probe.probe.sessionManagement.canList,
            canLoad: input.probe.probe.sessionManagement.canLoad,
            canResume: input.probe.probe.sessionManagement.canResume,
            canDelete: input.probe.probe.sessionManagement.canDelete,
          },
          configurableProviders: input.probe.probe.sessionManagement.canConfigureProviders,
        }),
    slashCommands: input.probe?.slashCommands ?? [],
    skills: input.probe?.skills ?? [],
  };
}

export function applyAcpRegistryAvailableCommands(
  provider: ServerProvider,
  commands: Option.Option<AcpRegistryAvailableCommands>,
): ServerProvider {
  return Option.match(commands, {
    onNone: () => provider,
    onSome: ({ slashCommands, skills }) => ({ ...provider, slashCommands, skills }),
  });
}

export function applyAcpRegistryLiveConfiguration(
  provider: ServerProvider,
  configuration: AcpRegistryLiveConfiguration,
  customModels: ReadonlyArray<CustomModelSetting>,
  previousModels: ReadonlyArray<ServerProviderModel> = provider.models,
): ServerProvider {
  const { message: _staleProbeMessage, ...snapshot } = provider;
  // session/load may omit models (Kimi returns `{}`); keep the probed list
  // and apply any live option descriptors to it.
  const probedModels = provider.models.filter((model) => !model.isCustom);
  // A cold-start session can report one placeholder model before its catalog
  // settles, while the probe may already have observed the full catalog. A
  // single model enumerated by an explicit select is not that fallback but
  // the agent's deliberate statement, so it wins over the probe catalog.
  const liveCatalogIsProvisional =
    configuration.models.length === 1 &&
    !configuration.modelsFromModelSelect &&
    probedModels.length > 1;
  const useLiveCatalog =
    configuration.models.length > 1 ||
    (configuration.models.length === 1 && !liveCatalogIsProvisional);
  const selectedProbedModelId =
    configuration.currentModelId !== null &&
    probedModels.some((model) => model.slug === configuration.currentModelId)
      ? configuration.currentModelId
      : (probedModels.find((model) => model.isDefault)?.slug ?? null);
  const discovery = useLiveCatalog
    ? configuration
    : {
        ...configuration,
        models: probedModels.map((model) => ({
          id: model.slug,
          name: model.name,
          description: null,
        })),
        currentModelId: selectedProbedModelId,
      };
  return {
    ...snapshot,
    status: provider.enabled ? "ready" : provider.status,
    models:
      !useLiveCatalog && configuration.configOptions.length === 0
        ? withAcpRegistryDefaultModel(provider.models, selectedProbedModelId)
        : modelsFromDiscovery(
            discovery,
            customModels,
            previousModels.filter((model) => !model.isCustom),
          ),
  };
}

function withAcpRegistryDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
  currentModelId: string | null,
): ReadonlyArray<ServerProviderModel> {
  if (currentModelId === null) return models;
  let changed = false;
  const next = models.map((model) => {
    if (model.isCustom) return model;
    const isDefault = model.slug === currentModelId;
    if ((model.isDefault ?? false) === isDefault) return model;
    changed = true;
    const { isDefault: _previous, ...rest } = model;
    return isDefault ? { ...rest, isDefault: true } : rest;
  });
  return changed ? next : models;
}

function applyAcpRegistryUrlAuthAction(
  provider: ServerProvider,
  action: Option.Option<NonNullable<ServerProvider["auth"]["action"]>>,
): ServerProvider {
  const { action: _previousAction, ...auth } = provider.auth;
  return {
    ...provider,
    auth: Option.match(action, {
      onNone: () => auth,
      onSome: (nextAction) => ({ ...auth, action: nextAction }),
    }),
  };
}

const buildInitialAcpRegistrySnapshot = Effect.fn("AcpRegistryDriver.buildInitialSnapshot")(
  function* (input: SnapshotIdentity & { readonly settings: AcpRegistrySettings }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return baseSnapshot({
      ...input,
      checkedAt,
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: input.settings.enabled
        ? "Checking ACP Registry agent readiness..."
        : "ACP Registry is disabled in T3 Code settings.",
    });
  },
);

export function buildCheckedAcpRegistrySnapshot(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly checkedAt: string;
    readonly inspection:
      | AcpRegistrySupport.AcpRegistryInspection
      | { readonly status: "failed"; readonly message: string };
    readonly probe?: AcpRegistryConfigurationProbeResult;
    readonly probeError?: AcpRegistryOperationError;
  },
): ServerProvider {
  const readiness = acpRegistrySnapshotReadiness(input.inspection);
  const probeFailed = input.probeError !== undefined;
  const advertisedAuthMethod =
    input.probeError?.reason === "authentication_failed"
      ? (input.probeError.authMethods?.find(
          (method) => method.id === input.settings.authMethodId,
        ) ?? input.probeError.authMethods?.[0])
      : undefined;
  const authenticationMessage = advertisedAuthMethod
    ? advertisedAuthMethod.type === "terminal" && advertisedAuthMethod.command
      ? `Sign in in provider settings using "${advertisedAuthMethod.name}". The login terminal runs on this environment.`
      : advertisedAuthMethod.type === "env_var" &&
          (advertisedAuthMethod.envVarNames?.length ?? 0) > 0
        ? `Set ${advertisedAuthMethod.envVarNames!.join(", ")} under this instance's environment variables in provider settings. T3 Code will detect it on the next provider refresh.`
        : `Sign in in provider settings using "${advertisedAuthMethod.name}".`
    : undefined;
  return baseSnapshot({
    ...input,
    ...(input.inspection.status === "ready" && input.inspection.documentationUrl
      ? { documentationUrl: input.inspection.documentationUrl }
      : {}),
    installed: readiness.installed,
    version:
      input.settings.source === "local"
        ? (input.probe?.probe.agentVersion ?? readiness.version)
        : readiness.version,
    // Failed discovery is a warning: an installed agent may still run real turns.
    status: probeFailed ? "warning" : readiness.status,
    auth: input.probe
      ? {
          // Discovery sessions and an empty auth-method list do not prove sign-in.
          status: "unknown",
          canLogout: input.probe.probe.sessionManagement.canLogout,
        }
      : input.probeError?.reason === "authentication_failed"
        ? {
            status: "unauthenticated",
            ...(advertisedAuthMethod
              ? { type: advertisedAuthMethod.type, label: advertisedAuthMethod.name }
              : {}),
            ...(input.probeError.authAction === undefined
              ? {}
              : { action: input.probeError.authAction }),
          }
        : { status: "unknown" },
    ...(input.probeError
      ? { message: authenticationMessage ?? input.probeError.message }
      : readiness.message
        ? { message: readiness.message }
        : {}),
  });
}

export const checkAcpRegistryProviderStatus = Effect.fn("AcpRegistryDriver.checkProviderStatus")(
  function* <Requirements>(
    input: SnapshotIdentity & {
      readonly settings: AcpRegistrySettings;
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
      readonly modelDiscovery?: Omit<AcpRegistryModelDiscovery, "onProbed"> & {
        readonly onProbed: (provider: ServerProvider) => Effect.Effect<ReadonlyArray<string>>;
      };
    },
    probeConfiguration: AcpRegistryConfigurationProbe<Requirements>,
  ): Effect.fn.Return<ServerProvider, never, AcpRegistrySupport.AcpRegistryCatalog | Requirements> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!input.settings.enabled) {
      return yield* buildInitialAcpRegistrySnapshot(input);
    }
    const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
    if (Result.isFailure(inspected)) {
      return buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: {
          status: "failed",
          message: `Could not inspect ACP Registry agent: ${inspected.failure.message}`,
        },
      });
    }
    if (inspected.success.status !== "ready") {
      return buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: inspected.success,
      });
    }
    const inspection = inspected.success;
    const modelDiscovery = input.modelDiscovery;
    const probed = yield* Effect.result(
      probeConfiguration({
        instanceId: input.instanceId,
        settings: input.settings,
        cwd: input.cwd,
        environment: providerProbeEnvironment(input.environment),
        ...(modelDiscovery === undefined
          ? {}
          : {
              modelDiscovery: {
                onProbed: (probe) =>
                  modelDiscovery.onProbed(
                    buildCheckedAcpRegistrySnapshot({ ...input, checkedAt, inspection, probe }),
                  ),
                onDiscovered: modelDiscovery.onDiscovered,
              },
            }),
      }),
    );
    return Result.isFailure(probed)
      ? buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probeError: probed.failure,
        })
      : buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probe: probed.success,
        });
  },
);

export const checkAcpRegistryProviderReadiness = Effect.fn(
  "AcpRegistryDriver.checkProviderReadiness",
)(function* (
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly environment: NodeJS.ProcessEnv;
  },
): Effect.fn.Return<ServerProvider, never, AcpRegistrySupport.AcpRegistryCatalog> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!input.settings.enabled) {
    return yield* buildInitialAcpRegistrySnapshot(input);
  }
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
  const snapshot = buildCheckedAcpRegistrySnapshot({
    ...input,
    checkedAt,
    inspection: Result.isFailure(inspected)
      ? {
          status: "failed",
          message: `Could not inspect ACP Registry agent: ${inspected.failure.message}`,
        }
      : inspected.success,
  });
  return inspected._tag === "Success" && inspected.success.status === "ready"
    ? {
        ...snapshot,
        message: "Checking ACP authentication, models, and commands in the background...",
      }
    : snapshot;
});

export type AcpRegistryDriverEnv =
  | AcpRegistryAdapterV2DriverEnv
  | Digest.Digest
  | ProviderHost.ProviderHost;

export const AcpRegistryDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ACP Registry",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: AcpRegistrySettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("AcpRegistryDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const runtimeCoordinator = yield* Effect.serviceOption(
      AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
    );
    if (Option.isSome(runtimeCoordinator)) {
      yield* runtimeCoordinator.value.clearAvailableCommands(instanceId);
      yield* runtimeCoordinator.value.clearLiveConfiguration(instanceId);
      yield* Effect.addFinalizer(() =>
        runtimeCoordinator.value
          .clearAvailableCommands(instanceId)
          .pipe(Effect.andThen(runtimeCoordinator.value.clearLiveConfiguration(instanceId))),
      );
    }
    const random = yield* SecureRandom.SecureRandom;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostEnvironment = yield* HostProcess.Environment;
    const host = yield* ProviderHost.ProviderHost;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const identity = {
      instanceId,
      displayName,
      accentColor,
      continuationKey: continuationIdentity.continuationKey,
    };
    const effectiveConfig = { ...config, enabled } satisfies AcpRegistrySettings;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      environment,
      hostEnvironment,
    );
    const orchestrationAdapter = yield* AcpRegistryAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build ACP Registry orchestration adapter.",
            cause,
          }),
      ),
    );
    const readinessInput = {
      ...identity,
      settings: effectiveConfig,
      environment: processEnvironment,
    };
    const confirmedAuthentication =
      yield* AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
        cacheDir: host.paths.providerStatusCacheDir,
        instanceId,
        settings: effectiveConfig,
        environment,
        processEnvironment,
      });
    // Refreshes rebuild the snapshot from the probe, so per-model options
    // reported by sessions and probe discovery are kept here and on disk.
    const learnedModelOptions = yield* makeAcpRegistryLearnedModelOptionsStore({
      cacheDir: host.paths.providerStatusCacheDir,
      instanceId,
      settings: effectiveConfig,
    });
    const applyLiveConfiguration = Effect.fn("AcpRegistryDriver.applyLiveConfiguration")(function* (
      provider: ServerProvider,
      configuration: AcpRegistryLiveConfiguration,
    ) {
      const reported = acpRegistryCurrentModelOptions(configuration);
      if (reported !== undefined) {
        yield* learnedModelOptions.learn(reported.modelId, reported.options, "live");
      }
      return withAcpRegistryLearnedModelOptions(
        applyAcpRegistryLiveConfiguration(provider, configuration, effectiveConfig.customModels),
        yield* learnedModelOptions.get,
      );
    });
    // Tracks the latest live revision already applied so restarting enrichSnapshot skips replaying it.
    const lastObservedLiveRevision = yield* Ref.make(0);
    // Retains the last settled catalog so readiness stays populated after a probe clears live state.
    const lastAcceptedCatalog = yield* Ref.make<ReadonlyArray<ServerProviderModel> | null>(null);
    const observeLiveRevision = (revision: number) =>
      Ref.update(lastObservedLiveRevision, (current) => Math.max(current, revision));
    const isSyntheticDefaultOnly = (models: ReadonlyArray<ServerProviderModel>) => {
      const builtIn = models.filter((model) => !model.isCustom);
      return builtIn.length === 0 || (builtIn.length === 1 && builtIn[0]?.slug === "default");
    };
    const clearLearnedModels = learnedModelOptions.clear;
    const withLiveRuntimeState = Effect.fn("AcpRegistryDriver.withLiveRuntimeState")(function* (
      input: ServerProvider,
    ) {
      if (input.auth.status === "unauthenticated") {
        yield* confirmedAuthentication.set(false);
        yield* Ref.set(lastAcceptedCatalog, null);
      }
      if (input.installed) yield* learnedModelOptions.setVersion(input.version);
      const provider =
        input.enabled &&
        input.installed &&
        input.auth.status === "unknown" &&
        (yield* confirmedAuthentication.get)
          ? { ...input, auth: { ...input.auth, status: "authenticated" as const } }
          : input;
      const withAcceptedFallback = Effect.fnUntraced(function* (candidate: ServerProvider) {
        const learned = yield* learnedModelOptions.get;
        const accepted = yield* Ref.get(lastAcceptedCatalog);
        if (
          accepted !== null &&
          candidate.enabled &&
          candidate.installed &&
          candidate.auth.status !== "unauthenticated" &&
          isSyntheticDefaultOnly(candidate.models)
        ) {
          const custom = candidate.models.filter((model) => model.isCustom);
          return withAcpRegistryLearnedModelOptions(
            { ...candidate, models: [...accepted, ...custom] },
            learned,
          );
        }
        return withAcpRegistryLearnedModelOptions(candidate, learned);
      });
      if (Option.isNone(runtimeCoordinator)) {
        return yield* withAcceptedFallback(provider);
      }
      const coordinator = runtimeCoordinator.value;
      const withCommands = applyAcpRegistryAvailableCommands(
        provider,
        yield* coordinator.getAvailableCommands(instanceId),
      );
      const liveSnapshot = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
      yield* observeLiveRevision(liveSnapshot.revision);
      const base = yield* withAcceptedFallback(withCommands);
      const withConfiguration = Option.isSome(liveSnapshot.configuration)
        ? yield* applyLiveConfiguration(base, liveSnapshot.configuration.value)
        : base;
      return applyAcpRegistryUrlAuthAction(
        withConfiguration,
        yield* coordinator.getUrlAuthAction(instanceId),
      );
    });
    // A local executable's version comes only from probing it, so readiness checks reuse the last report.
    const reportedLocalVersion = yield* Ref.make<string | null>(null);
    const checkProvider = checkAcpRegistryProviderReadiness(readinessInput).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.flatMap((provider) =>
        Ref.get(reportedLocalVersion).pipe(
          Effect.map((version) =>
            provider.installed && provider.version === null && version !== null
              ? { ...provider, version }
              : provider,
          ),
        ),
      ),
      Effect.flatMap(withLiveRuntimeState),
    );
    const modelsToDiscover = Effect.fn("AcpRegistryDriver.modelsToDiscover")(function* (
      provider: ServerProvider,
    ) {
      yield* learnedModelOptions.setVersion(provider.version);
      const settings = yield* host.settings.get.pipe(Effect.option);
      // Without settings the hidden models are unknown, so nothing is opened.
      if (Option.isNone(settings)) return [];
      return acpRegistryModelsToDiscover({
        provider,
        settings: settings.value,
        learned: yield* learnedModelOptions.get,
      });
    });
    const enrichProvider = Effect.fn("AcpRegistryDriver.enrichProvider")(function* (
      publishProbed: (
        provider: ServerProvider,
        modelsFromModelSelect: boolean,
      ) => Effect.Effect<void>,
    ) {
      const modelsFromSelectRef = yield* Ref.make(false);
      const provider = yield* checkAcpRegistryProviderStatus(
        {
          ...readinessInput,
          cwd: host.paths.cwd,
          modelDiscovery: {
            // Publish what the probe found first; discovery only adds options to it.
            onProbed: (provider) =>
              modelsToDiscover(provider).pipe(
                Effect.tap((modelIds) =>
                  modelIds.length === 0
                    ? Effect.void
                    : Ref.get(modelsFromSelectRef).pipe(
                        Effect.flatMap((fromSelect) => publishProbed(provider, fromSelect)),
                      ),
                ),
              ),
            onDiscovered: (configuration) => {
              const discovered = acpRegistryCurrentModelOptions(configuration);
              return discovered === undefined
                ? Effect.void
                : learnedModelOptions.learn(discovered.modelId, discovered.options, "discovered");
            },
          },
        },
        (input) =>
          probeAcpRegistryConfiguration(input).pipe(
            Effect.tap((result) =>
              Ref.set(modelsFromSelectRef, result.modelsFromModelSelect === true),
            ),
          ),
      ).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(SecureRandom.SecureRandom, random),
      );
      return { provider, modelsFromModelSelect: yield* Ref.get(modelsFromSelectRef) };
    });
    const hasRegistryAgent =
      effectiveConfig.enabled &&
      effectiveConfig.source !== "local" &&
      effectiveConfig.agentId.trim().length > 0;
    const clearLiveState = (
      Option.isSome(runtimeCoordinator)
        ? runtimeCoordinator.value
            .clearLiveConfiguration(instanceId)
            .pipe(Effect.andThen(runtimeCoordinator.value.clearAvailableCommands(instanceId)))
        : Effect.void
    ).pipe(Effect.andThen(clearLearnedModels), Effect.andThen(Ref.set(lastAcceptedCatalog, null)));
    const enrichmentCache = yield* Ref.make<AcpRegistryEnrichmentCache>({
      generation: 0,
      entry: null,
    });
    const liveSnapshotSemaphore = yield* Semaphore.make(1);
    const invalidateEnrichmentCache = Ref.update(enrichmentCache, (current) => ({
      generation: current.generation + 1,
      entry: null,
    }));
    const enrichProviderCached = Effect.fn("AcpRegistryDriver.enrichProviderCached")(function* (
      baseSnapshot: ServerProvider,
      publish: (enriched: {
        readonly provider: ServerProvider;
        readonly generation: number;
        readonly fresh: boolean;
        readonly probeStartLiveRevision: number;
        readonly modelsFromModelSelect: boolean;
        readonly runtimeChanged: boolean;
      }) => Effect.Effect<void>,
    ) {
      if (hasRegistryAgent) {
        yield* catalog
          .refreshIndex({
            maxAgeMs: PROBE_SUCCESS_TTL_MS,
            failureBackoffMs: REGISTRY_REFRESH_FAILURE_BACKOFF_MS,
          })
          .pipe(Effect.ignore);
      }
      const currentInspection = hasRegistryAgent
        ? yield* catalog.inspect(effectiveConfig, processEnvironment).pipe(Effect.option)
        : Option.none();
      const inspectedVersion =
        Option.isSome(currentInspection) && currentInspection.value.status === "ready"
          ? currentInspection.value.version
          : baseSnapshot.version;
      const inspectedLaunchIdentity =
        Option.isSome(currentInspection) && currentInspection.value.status === "ready"
          ? currentInspection.value.launchIdentity
          : undefined;
      const now = yield* Clock.currentTimeMillis;
      const cacheState = yield* Ref.get(enrichmentCache);
      const cached = cacheState.entry;
      if (
        cached !== null &&
        isAcpRegistryCacheValid(
          cached,
          inspectedVersion,
          effectiveConfig.source === "local",
          now,
          inspectedLaunchIdentity,
        )
      ) {
        return {
          provider: { ...cached.provider, checkedAt: baseSnapshot.checkedAt },
          generation: cacheState.generation,
          fresh: false,
          probeStartLiveRevision: 0,
          modelsFromModelSelect: false,
          runtimeChanged: false,
        };
      }
      const probeStartLiveRevision = Option.isSome(runtimeCoordinator)
        ? (yield* runtimeCoordinator.value.getLiveConfigurationWithRevision(instanceId)).revision
        : 0;
      const runtimeChanged =
        (cached !== null &&
          (cached.provider.version !== inspectedVersion ||
            (inspectedLaunchIdentity !== undefined &&
              cached.launchIdentity !== inspectedLaunchIdentity))) ||
        (inspectedVersion !== null &&
          baseSnapshot.version !== null &&
          inspectedVersion !== baseSnapshot.version);
      const remember = Effect.fn("AcpRegistryDriver.rememberEnrichment")(function* (
        enriched: ServerProvider,
      ) {
        if (effectiveConfig.source === "local" && enriched.status === "ready") {
          yield* Ref.set(reportedLocalVersion, enriched.version);
        }
        if (enriched.status === "ready") {
          const completedAt = yield* Clock.currentTimeMillis;
          yield* Ref.update(enrichmentCache, (current) =>
            current.generation === cacheState.generation
              ? {
                  ...current,
                  entry: {
                    provider: enriched,
                    ...(inspectedLaunchIdentity === undefined
                      ? {}
                      : { launchIdentity: inspectedLaunchIdentity }),
                    expiresAt: completedAt + acpRegistryProbeTtlMs(enriched),
                  },
                }
              : current,
          );
        }
      });
      const { provider: enriched, modelsFromModelSelect } = yield* enrichProvider(
        (provider, fromSelect) =>
          remember(provider).pipe(
            Effect.andThen(
              publish({
                provider,
                generation: cacheState.generation,
                fresh: true,
                probeStartLiveRevision,
                modelsFromModelSelect: fromSelect,
                runtimeChanged,
              }),
            ),
          ),
      );
      yield* remember(enriched);
      return {
        provider: enriched,
        generation: cacheState.generation,
        fresh: true,
        probeStartLiveRevision,
        modelsFromModelSelect,
        runtimeChanged,
      };
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<
      ProviderSnapshotSettings<AcpRegistrySettings>
    >({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      // Inspection may fetch the registry when its disk cache is missing; creation must not wait on that.
      initialSnapshot: () => buildInitialAcpRegistrySnapshot(readinessInput),
      checkProvider,
      enrichSnapshot: Effect.fn("enrichSnapshot")(function* ({
        snapshot,
        getSnapshot,
        publishSnapshot,
      }) {
        let targetSnapshot = snapshot;
        if (!targetSnapshot.installed) {
          if (!hasRegistryAgent) return;
          const refresh = catalog
            .refreshIndex({
              maxAgeMs: PROBE_SUCCESS_TTL_MS,
              failureBackoffMs: REGISTRY_REFRESH_FAILURE_BACKOFF_MS,
            })
            .pipe(Effect.orElseSucceed(() => false));
          const refreshed = yield* Option.isSome(runtimeCoordinator)
            ? runtimeCoordinator.value.runBackgroundProbe(effectiveConfig.agentId, refresh)
            : refresh.pipe(Effect.asSome);
          if (Option.isNone(refreshed)) return;
          targetSnapshot = yield* checkProvider;
          if (!targetSnapshot.installed) {
            if (refreshed.value) {
              yield* liveSnapshotSemaphore.withPermit(publishSnapshot(targetSnapshot));
            }
            return;
          }
          yield* liveSnapshotSemaphore.withPermit(publishSnapshot(targetSnapshot));
        }
        const publishEnriched = ({
          provider,
          generation,
          fresh,
          probeStartLiveRevision,
          modelsFromModelSelect,
          runtimeChanged,
        }: {
          readonly provider: ServerProvider;
          readonly generation: number;
          readonly fresh: boolean;
          readonly probeStartLiveRevision: number;
          readonly modelsFromModelSelect: boolean;
          readonly runtimeChanged: boolean;
        }) =>
          liveSnapshotSemaphore.withPermit(
            Effect.gen(function* () {
              const current = yield* Ref.get(enrichmentCache);
              if (current.generation !== generation) return;
              if (fresh && provider.status === "ready") {
                const probedBuiltIn = provider.models.filter((model) => !model.isCustom);
                const authoritativeProbe =
                  probedBuiltIn.length > 1 || (probedBuiltIn.length === 1 && modelsFromModelSelect);
                if (runtimeChanged || authoritativeProbe) {
                  const cleared = Option.isSome(runtimeCoordinator)
                    ? yield* runtimeCoordinator.value.clearLiveConfigurationIfRevision(
                        instanceId,
                        probeStartLiveRevision,
                      )
                    : true;
                  if (cleared) {
                    if (runtimeChanged) {
                      yield* clearLiveState;
                    }
                    if (authoritativeProbe) {
                      yield* Ref.set(lastAcceptedCatalog, probedBuiltIn);
                    }
                  }
                }
              }
              yield* publishSnapshot(yield* withLiveRuntimeState(provider));
            }),
          );
        const enrichment = enrichProviderCached(targetSnapshot, publishEnriched);
        const publishEnrichment = (
          Option.isSome(runtimeCoordinator)
            ? runtimeCoordinator.value.runBackgroundProbe(
                effectiveConfig.source === "local"
                  ? `local:${instanceId}`
                  : effectiveConfig.agentId,
                enrichment,
              )
            : enrichment.pipe(Effect.asSome)
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: publishEnriched,
            }),
          ),
        );
        if (Option.isNone(runtimeCoordinator)) return yield* publishEnrichment;

        const publishLiveCommands = runtimeCoordinator.value.watchAvailableCommands(
          instanceId,
          ({ slashCommands, skills }) =>
            liveSnapshotSemaphore.withPermit(
              getSnapshot.pipe(
                Effect.flatMap((current) =>
                  publishSnapshot({
                    ...current,
                    slashCommands,
                    skills,
                  }),
                ),
              ),
            ),
        );
        const publishLiveConfiguration = Ref.get(lastObservedLiveRevision).pipe(
          Effect.flatMap((afterRevision) =>
            runtimeCoordinator.value.watchLiveConfiguration(
              instanceId,
              (configuration, revision) =>
                liveSnapshotSemaphore.withPermit(
                  Effect.gen(function* () {
                    const live =
                      yield* runtimeCoordinator.value.getLiveConfigurationWithRevision(instanceId);
                    // A fresh probe cleared this revision; replaying it would restore a stale catalog.
                    if (live.revision !== revision && Option.isNone(live.configuration)) return;
                    yield* observeLiveRevision(revision);
                    const current = yield* getSnapshot;
                    const updated = yield* applyLiveConfiguration(current, configuration);
                    if (configuration.models.length > 0) {
                      const builtIn = updated.models.filter((model) => !model.isCustom);
                      if (
                        builtIn.length > 1 ||
                        (builtIn.length === 1 && configuration.modelsFromModelSelect === true)
                      ) {
                        yield* Ref.set(lastAcceptedCatalog, builtIn);
                      }
                    }
                    const now = yield* Clock.currentTimeMillis;
                    yield* Ref.update(enrichmentCache, (cache) =>
                      updateAcpRegistryEnrichmentCache({
                        cache,
                        configuration,
                        customModels: effectiveConfig.customModels,
                        now,
                      }),
                    );
                    yield* publishSnapshot(updated);
                  }),
                ),
              { afterRevision },
            ),
          ),
        );
        const publishUrlAuthAction = runtimeCoordinator.value.watchUrlAuthAction(
          instanceId,
          (action) =>
            liveSnapshotSemaphore.withPermit(
              getSnapshot.pipe(
                Effect.flatMap((current) =>
                  publishSnapshot(
                    applyAcpRegistryUrlAuthAction(current, Option.fromNullishOr(action)),
                  ),
                ),
              ),
            ),
        );
        yield* Effect.all(
          [publishEnrichment, publishLiveCommands, publishLiveConfiguration, publishUrlAuthAction],
          {
            concurrency: "unbounded",
            discard: true,
          },
        );
      }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build the ACP Registry provider snapshot.",
            cause,
          }),
      ),
    );

    const provideAcpManagementServices = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | AcpRegistrySupport.AcpRegistryCatalog
        | ChildProcessSpawner.ChildProcessSpawner
        | SecureRandom.SecureRandom
      >,
    ): Effect.Effect<A, E> => {
      const provided = effect.pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, random),
      );
      return Option.isSome(runtimeCoordinator)
        ? provided.pipe(
            Effect.provideService(
              AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
              runtimeCoordinator.value,
            ),
          )
        : provided;
    };

    const controller = yield* AcpRegistryAuth.makeAcpRegistryAuth({
      instanceId,
      settings: effectiveConfig,
      cwd: host.paths.cwd,
      environment: processEnvironment,
      onChanged: (authenticated) =>
        confirmedAuthentication
          .set(authenticated)
          .pipe(
            Effect.andThen(authenticated ? Effect.void : clearLiveState),
            Effect.andThen(liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
            Effect.andThen(snapshot.refresh),
            Effect.asVoid,
          ),
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(SecureRandom.SecureRandom, random),
    );
    const auth = {
      ...controller,
      invalidate: (controller.invalidate ?? Effect.void).pipe(
        Effect.andThen(confirmedAuthentication.set(false)),
        Effect.andThen(clearLiveState),
        Effect.andThen(liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
        Effect.andThen(snapshot.refresh),
        Effect.asVoid,
      ),
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      auth,
      snapshot: {
        ...snapshot,
        refresh: snapshot.refresh.pipe(Effect.tap(() => controller.refreshMethods ?? Effect.void)),
      },
      invalidateCaches: liveSnapshotSemaphore
        .withPermit(
          (Option.isSome(runtimeCoordinator)
            ? runtimeCoordinator.value.clearLiveConfiguration(instanceId)
            : Effect.void
          ).pipe(
            Effect.andThen(clearLearnedModels),
            Effect.andThen(Ref.set(lastAcceptedCatalog, null)),
            Effect.andThen(invalidateEnrichmentCache),
          ),
        )
        .pipe(Effect.andThen(hasRegistryAgent ? catalog.invalidateIndex() : Effect.void)),
      orchestrationAdapter,
      textGeneration: yield* makeAcpRegistryTextGeneration({
        instanceId,
        settings: effectiveConfig,
        environment: processEnvironment,
      }),
      acpSessionManagement: {
        listSessions: ({ cwd, cursor }) =>
          provideAcpManagementServices(
            listAcpRegistrySessions({
              instanceId,
              settings: effectiveConfig,
              cwd,
              environment: processEnvironment,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          ),
        deleteSession: ({ cwd, sessionId }) =>
          provideAcpManagementServices(
            deleteAcpRegistrySession({
              instanceId,
              settings: effectiveConfig,
              cwd,
              environment: processEnvironment,
              sessionId,
            }),
          ),
        listProviders: (cwd) =>
          provideAcpManagementServices(
            listAcpRegistryProviders({
              instanceId,
              settings: effectiveConfig,
              cwd,
              environment: processEnvironment,
            }),
          ),
        setProvider: ({ cwd, providerId, apiType, baseUrl, headers }) =>
          provideAcpManagementServices(
            setAcpRegistryProvider({
              instanceId,
              settings: effectiveConfig,
              cwd,
              environment: processEnvironment,
              providerId,
              apiType,
              baseUrl,
              ...(headers === undefined ? {} : { headers }),
            }),
          ).pipe(
            Effect.tap(() =>
              liveSnapshotSemaphore.withPermit(
                (Option.isSome(runtimeCoordinator)
                  ? runtimeCoordinator.value.clearLiveConfiguration(instanceId)
                  : Effect.void
                ).pipe(
                  Effect.andThen(Ref.set(lastAcceptedCatalog, null)),
                  Effect.andThen(invalidateEnrichmentCache),
                ),
              ),
            ),
          ),
        disableProvider: ({ cwd, providerId }) =>
          provideAcpManagementServices(
            disableAcpRegistryProvider({
              instanceId,
              settings: effectiveConfig,
              cwd,
              environment: processEnvironment,
              providerId,
            }),
          ).pipe(
            Effect.tap(() =>
              liveSnapshotSemaphore.withPermit(
                (Option.isSome(runtimeCoordinator)
                  ? runtimeCoordinator.value.clearLiveConfiguration(instanceId)
                  : Effect.void
                ).pipe(
                  Effect.andThen(Ref.set(lastAcceptedCatalog, null)),
                  Effect.andThen(invalidateEnrichmentCache),
                ),
              ),
            ),
          ),
        logout: (cwd) => {
          const logout = logoutAcpRegistry({
            instanceId,
            settings: effectiveConfig,
            cwd,
            environment: processEnvironment,
          }).pipe(
            Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(SecureRandom.SecureRandom, random),
            Effect.tap(() => confirmedAuthentication.set(false)),
            Effect.tap(() =>
              liveSnapshotSemaphore.withPermit(
                invalidateEnrichmentCache.pipe(
                  Effect.andThen(Ref.set(lastAcceptedCatalog, null)),
                  Effect.andThen(clearLearnedModels),
                  Effect.andThen(
                    Option.isSome(runtimeCoordinator)
                      ? Effect.all(
                          [
                            runtimeCoordinator.value.clearAvailableCommands(instanceId),
                            runtimeCoordinator.value.clearLiveConfiguration(instanceId),
                          ],
                          { concurrency: "unbounded", discard: true },
                        )
                      : Effect.void,
                  ),
                ),
              ),
            ),
          );
          return Option.isSome(runtimeCoordinator)
            ? logout.pipe(
                Effect.provideService(
                  AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
                  runtimeCoordinator.value,
                ),
              )
            : logout;
        },
      },
    } satisfies ProviderInstance;
  }),
};
