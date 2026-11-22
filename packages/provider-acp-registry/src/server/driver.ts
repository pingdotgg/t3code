import {
  officialAcpRegistryIconUrlForAgentId,
  ProviderDriverKind,
  resolveOfficialAcpRegistryIconUrl,
  TextGenerationError,
  type AcpRegistryOperationError,
  type AcpRegistryProbeModel,
  type CustomModelSetting,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
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
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
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
  type AcpRegistryConfigurationProbeResolved,
  type AcpRegistryConfigurationProbeResult,
  type AcpRegistryLiveConfiguration,
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

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
// Cache only successful authenticated probes so sign-in changes remain visible.
const PROBE_SUCCESS_TTL_MS = 15 * 60 * 1_000;
const PROBE_PROVISIONAL_TTL_MS = 30 * 1_000;
const REGISTRY_INDEX_MAX_AGE_MS = 15 * 60 * 1_000;
const REGISTRY_FAILURE_BACKOFF_MS = 60 * 1_000;
const FALLBACK_RETRY_BACKOFF_MS = 60 * 1_000;

function acpRegistryProbeTtlMs(provider: ServerProvider): number {
  const discoveredModels = provider.models.filter((model) => !model.isCustom);
  return discoveredModels.length <= 1 ? PROBE_PROVISIONAL_TTL_MS : PROBE_SUCCESS_TTL_MS;
}

interface AcpRegistryEnrichmentCache {
  readonly invalidationGeneration: number;
  readonly liveGenerationByRuntime: ReadonlyMap<string | null, number>;
  readonly entry: {
    readonly provider: ServerProvider;
    readonly expiresAt: number;
    readonly launchIdentity?: string | null;
  } | null;
}

function nextLiveGenerationByRuntime(
  current: ReadonlyMap<string | null, number>,
  runtimeIdentity: string | null,
): ReadonlyMap<string | null, number> {
  const next = new Map(current);
  next.set(runtimeIdentity, (next.get(runtimeIdentity) ?? 0) + 1);
  return next;
}

export function isAcpRegistryCacheValid(
  entry: NonNullable<AcpRegistryEnrichmentCache["entry"]>,
  inspectedVersion: string | null,
  local: boolean,
  now: number,
  inspectedLaunchIdentity?: string | null,
): boolean {
  if (entry.expiresAt <= now) return false;
  if (local && inspectedVersion === null) return true;
  if (
    entry.launchIdentity !== undefined &&
    inspectedLaunchIdentity !== undefined &&
    entry.launchIdentity !== inspectedLaunchIdentity
  ) {
    return false;
  }
  return entry.provider.version === inspectedVersion;
}

export function updateAcpRegistryEnrichmentCache(input: {
  readonly cache: AcpRegistryEnrichmentCache;
  readonly configuration: AcpRegistryLiveConfiguration;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
  readonly now: number;
  readonly runtimeIdentity?: string | null;
}): AcpRegistryEnrichmentCache {
  const { cache, configuration, customModels, now, runtimeIdentity } = input;
  const runtimeKey = runtimeIdentity ?? null;
  if (cache.entry === null) {
    // No probe has landed yet, but the live session published its
    // configuration to the snapshot. Advance the epoch for this runtime so an
    // in-flight probe for the same runtime cannot overwrite newer live state,
    // without discarding an upgrade probe targeting a different runtime.
    return {
      ...cache,
      liveGenerationByRuntime: nextLiveGenerationByRuntime(
        cache.liveGenerationByRuntime,
        runtimeKey,
      ),
    };
  }
  const entryRuntimeIdentity = runtimeIdentityFor(
    cache.entry.provider,
    cache.entry.launchIdentity ?? null,
  );
  if (
    runtimeIdentity !== undefined &&
    runtimeIdentity !== null &&
    entryRuntimeIdentity !== null &&
    entryRuntimeIdentity !== runtimeIdentity
  ) {
    // Keep the cached entry for the older runtime intact, while advancing the
    // incoming runtime's live epoch so an older in-flight probe for that
    // incoming runtime cannot overwrite this newer live configuration.
    return {
      ...cache,
      liveGenerationByRuntime: nextLiveGenerationByRuntime(
        cache.liveGenerationByRuntime,
        runtimeKey,
      ),
    };
  }
  const provider = applyAcpRegistryLiveConfiguration(
    cache.entry.provider,
    configuration,
    customModels,
  );
  if (Equal.equals(provider, cache.entry.provider)) return cache;
  return {
    ...cache,
    // Advance only this runtime's live epoch so an in-flight probe for the same
    // runtime discards stale results without invalidating an upgrade probe for
    // a newer runtime.
    liveGenerationByRuntime: nextLiveGenerationByRuntime(cache.liveGenerationByRuntime, runtimeKey),
    entry: {
      ...cache.entry,
      provider,
      expiresAt: now + acpRegistryProbeTtlMs(provider),
    },
  };
}
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const makeUnsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "ACP Registry instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
  };
};

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
    readonly icon?: string;
    readonly documentationUrl?: string;
    readonly message?: string;
    readonly probe?: AcpRegistryConfigurationProbeResult;
    readonly probeError?: AcpRegistryOperationError;
  },
): ServerProvider {
  const iconUrl =
    input.settings.source === "local"
      ? null
      : (resolveOfficialAcpRegistryIconUrl(input.probe?.probe.icon ?? input.icon) ??
        officialAcpRegistryIconUrlForAgentId(input.settings.agentId));
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    continuation: { groupKey: input.continuationKey },
    supportsTextGeneration: false,
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

function applyRegistryReadinessMetadata(
  provider: ServerProvider,
  baseSnapshot: ServerProvider,
): ServerProvider {
  let next = provider;
  const documentationUrl = baseSnapshot.setup?.documentationUrl;
  if (next.setup !== undefined && next.setup.documentationUrl !== documentationUrl) {
    const { documentationUrl: _previous, ...setup } = next.setup;
    next = {
      ...next,
      setup: documentationUrl === undefined ? setup : { ...setup, documentationUrl },
    };
  }
  if (next.iconUrl !== baseSnapshot.iconUrl) {
    const { iconUrl: _previousIcon, ...rest } = next;
    next = baseSnapshot.iconUrl === undefined ? rest : { ...rest, iconUrl: baseSnapshot.iconUrl };
  }
  return next;
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
    ...(input.inspection.status === "ready" && input.inspection.icon
      ? { icon: input.inspection.icon }
      : {}),
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

interface CheckedAcpRegistryReadiness {
  readonly snapshot: ServerProvider;
  readonly launchIdentity: string | null;
  readonly indexRevision: number | null;
  readonly fallback?: boolean;
  readonly fallbackTargetIndexRevision?: number | null;
  readonly retryFailedUpgrade?: boolean;
  readonly probeFailed?: boolean;
}

interface ActiveFallbackState {
  readonly targetLaunchIdentity: string | null;
  readonly targetVersion: string | null;
  readonly targetIndexRevision: number | null;
  readonly fallbackVersion: string | null;
  readonly fallbackLaunchIdentity: string | null;
  readonly failedAtMs: number;
  readonly message: string;
}

interface FailedUpgradeTargetState {
  readonly targetLaunchIdentity: string | null;
  readonly status: ServerProvider["status"];
  readonly message: string | undefined;
}

function runtimeIdentityFor(
  provider: Pick<ServerProvider, "version">,
  launchIdentity: string | null,
): string | null {
  return launchIdentity ?? provider.version;
}

function readinessSignature(readiness: CheckedAcpRegistryReadiness) {
  return {
    installed: readiness.snapshot.installed,
    version: readiness.snapshot.version,
    status: readiness.snapshot.status,
    message: readiness.snapshot.message,
    documentationUrl: readiness.snapshot.setup?.documentationUrl,
    iconUrl: readiness.snapshot.iconUrl,
    launchIdentity: readiness.launchIdentity,
  };
}

function installedRegistrySignature(readiness: CheckedAcpRegistryReadiness) {
  return {
    installed: readiness.snapshot.installed,
    version: readiness.snapshot.version,
    documentationUrl: readiness.snapshot.setup?.documentationUrl,
    iconUrl: readiness.snapshot.iconUrl,
    launchIdentity: readiness.launchIdentity,
  };
}

const checkAcpRegistryProviderStatusWithIdentity = Effect.fn(
  "AcpRegistryDriver.checkProviderStatus",
)(function* <Requirements>(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  },
  probeConfiguration: AcpRegistryConfigurationProbe<Requirements>,
): Effect.fn.Return<
  {
    readonly provider: ServerProvider;
    readonly launchIdentity: string | null;
    readonly indexRevision: number | null;
    readonly cacheable: boolean;
    readonly fallback?: boolean;
    readonly fallbackTargetLaunchIdentity?: string | null;
    readonly fallbackTargetVersion?: string | null;
    readonly fallbackTargetIndexRevision?: number | null;
    readonly probedLaunchIdentity?: string | null;
    readonly failedTargetLaunchIdentity?: string | null;
    readonly probeFailed?: boolean;
  },
  never,
  AcpRegistrySupport.AcpRegistryCatalog | Requirements
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!input.settings.enabled) {
    return {
      provider: yield* buildInitialAcpRegistrySnapshot(input),
      launchIdentity: null,
      indexRevision: null,
      cacheable: false,
    };
  }
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
  if (Result.isFailure(inspected)) {
    return {
      provider: buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: {
          status: "failed",
          message: `Could not inspect ACP Registry agent: ${inspected.failure.message}`,
        },
      }),
      launchIdentity: null,
      indexRevision: null,
      cacheable: false,
    };
  }
  const inspectedIndexRevision =
    "indexRevision" in inspected.success ? (inspected.success.indexRevision ?? null) : null;
  if (inspected.success.status !== "ready") {
    return {
      provider: buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: inspected.success,
      }),
      launchIdentity: null,
      indexRevision: inspectedIndexRevision,
      cacheable: false,
    };
  }
  const resolvedDuringProbeRef = yield* Ref.make<AcpRegistryConfigurationProbeResolved | undefined>(
    undefined,
  );
  const probed = yield* Effect.result(
    probeConfiguration({
      instanceId: input.instanceId,
      settings: input.settings,
      cwd: input.cwd,
      environment: providerProbeEnvironment(input.environment),
      onResolved: (resolved) => Ref.set(resolvedDuringProbeRef, resolved),
    }),
  );
  if (Result.isFailure(probed)) {
    const resolvedDuringProbe = yield* Ref.get(resolvedDuringProbeRef);
    const failedInspection: AcpRegistrySupport.AcpRegistryInspection =
      resolvedDuringProbe === undefined || input.settings.source === "local"
        ? inspected.success
        : {
            ...inspected.success,
            version:
              input.settings.commandPath.trim().length > 0
                ? null
                : (resolvedDuringProbe.agent?.version ?? inspected.success.version),
            ...(resolvedDuringProbe.launchIdentity === undefined
              ? {}
              : { launchIdentity: resolvedDuringProbe.launchIdentity }),
          };
    const probedLaunchIdentity =
      resolvedDuringProbe?.launchIdentity ?? inspected.success.launchIdentity ?? null;
    const failedTargetLaunchIdentity =
      (resolvedDuringProbe?.fallback
        ? resolvedDuringProbe.failedTarget?.launchIdentity
        : undefined) ?? probedLaunchIdentity;
    const failedIndexRevision =
      (resolvedDuringProbe?.fallback
        ? resolvedDuringProbe.failedTarget?.indexRevision
        : undefined) ??
      resolvedDuringProbe?.indexRevision ??
      inspectedIndexRevision;
    return {
      provider: buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: failedInspection,
        probeError: probed.failure,
      }),
      launchIdentity: null,
      indexRevision: failedIndexRevision,
      cacheable: false,
      probedLaunchIdentity,
      failedTargetLaunchIdentity,
      probeFailed: true,
    };
  }
  if (input.settings.source === "local") {
    return {
      provider: buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: inspected.success,
        probe: probed.success,
      }),
      launchIdentity: null,
      indexRevision: null,
      cacheable: true,
    };
  }
  const resolved = probed.success.resolved;
  if (resolved === undefined) {
    return {
      provider: buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: inspected.success,
        probe: probed.success,
      }),
      launchIdentity: null,
      indexRevision: null,
      cacheable: inspected.success.launchIdentity === undefined,
    };
  }
  const resolvedVersion =
    input.settings.commandPath.trim().length > 0
      ? null
      : (resolved.agent?.version ?? inspected.success.version);
  const resolvedDocumentationUrl =
    resolved.agent === undefined
      ? inspected.success.documentationUrl
      : (resolved.agent.website ?? resolved.agent.repository);
  const resolvedIcon = resolved.agent === undefined ? inspected.success.icon : resolved.agent.icon;
  const resolvedInspection: AcpRegistrySupport.AcpRegistryInspection = {
    status: "ready",
    agentId: inspected.success.agentId,
    version: resolvedVersion,
    distribution: resolved.distribution,
    ...(resolved.launchIdentity === undefined ? {} : { launchIdentity: resolved.launchIdentity }),
    ...(resolved.indexRevision === undefined ? {} : { indexRevision: resolved.indexRevision }),
    ...(resolvedIcon ? { icon: resolvedIcon } : {}),
    ...(resolvedDocumentationUrl ? { documentationUrl: resolvedDocumentationUrl } : {}),
  };
  return {
    provider: buildCheckedAcpRegistrySnapshot({
      ...input,
      checkedAt,
      inspection: resolvedInspection,
      probe: probed.success,
    }),
    launchIdentity: resolved.launchIdentity ?? null,
    indexRevision: resolved.indexRevision ?? null,
    cacheable:
      resolved.launchIdentity !== undefined || inspected.success.launchIdentity === undefined,
    ...(resolved.fallback
      ? {
          fallback: true,
          fallbackTargetLaunchIdentity:
            resolved.failedTarget?.launchIdentity ?? inspected.success.launchIdentity ?? null,
          fallbackTargetVersion: resolved.failedTarget?.version ?? inspected.success.version,
          fallbackTargetIndexRevision:
            resolved.failedTarget?.indexRevision ?? inspectedIndexRevision,
        }
      : {}),
  };
});

export const checkAcpRegistryProviderStatus = <Requirements>(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  },
  probeConfiguration: AcpRegistryConfigurationProbe<Requirements>,
): Effect.Effect<ServerProvider, never, AcpRegistrySupport.AcpRegistryCatalog | Requirements> =>
  checkAcpRegistryProviderStatusWithIdentity(input, probeConfiguration).pipe(
    Effect.map(({ provider }) => provider),
  );

const checkAcpRegistryProviderReadinessWithIdentity = Effect.fn(
  "AcpRegistryDriver.checkProviderReadiness",
)(function* (
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly environment: NodeJS.ProcessEnv;
  },
): Effect.fn.Return<CheckedAcpRegistryReadiness, never, AcpRegistrySupport.AcpRegistryCatalog> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!input.settings.enabled) {
    return {
      snapshot: yield* buildInitialAcpRegistrySnapshot(input),
      launchIdentity: null,
      indexRevision: null,
    };
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
  const indexRevision =
    inspected._tag === "Success" && "indexRevision" in inspected.success
      ? (inspected.success.indexRevision ?? null)
      : null;
  return inspected._tag === "Success" && inspected.success.status === "ready"
    ? {
        snapshot: {
          ...snapshot,
          message: "Checking ACP authentication, models, and commands in the background...",
        },
        launchIdentity: inspected.success.launchIdentity ?? null,
        indexRevision,
      }
    : { snapshot, launchIdentity: null, indexRevision };
});

export const checkAcpRegistryProviderReadiness = (
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly environment: NodeJS.ProcessEnv;
  },
): Effect.Effect<ServerProvider, never, AcpRegistrySupport.AcpRegistryCatalog> =>
  checkAcpRegistryProviderReadinessWithIdentity(input).pipe(Effect.map(({ snapshot }) => snapshot));

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
    const driverScope = yield* Effect.scope;
    const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const runtimeCoordinator = yield* Effect.serviceOption(
      AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
    );
    if (Option.isSome(runtimeCoordinator)) {
      yield* runtimeCoordinator.value.clearAvailableCommands(instanceId);
      yield* runtimeCoordinator.value.clearLiveConfiguration(instanceId);
      yield* Effect.addFinalizer(() =>
        runtimeCoordinator.value
          .clearAvailableCommands(instanceId, { dispose: true })
          .pipe(
            Effect.andThen(
              runtimeCoordinator.value.clearLiveConfiguration(instanceId, { dispose: true }),
            ),
          ),
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
    // learned from earlier sessions are kept here.
    const learnedModels = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);
    const applyLiveConfiguration = (
      provider: ServerProvider,
      configuration: AcpRegistryLiveConfiguration,
    ) =>
      Ref.modify(learnedModels, (learned) => {
        const next = applyAcpRegistryLiveConfiguration(
          provider,
          configuration,
          effectiveConfig.customModels,
          learned.length > 0 ? learned : provider.models,
        );
        return [next, next.models === provider.models ? learned : next.models];
      });
    const clearLearnedModels = Ref.set(learnedModels, []);
    const activeRuntimeIdentity = yield* Ref.make<string | null>(null);
    // Probes never produce "authenticated" directly; saved confirmation re-promotes "unknown"
    // in withLiveRuntimeState, so stripping it prevents historical auth surviving logout.
    const stripConfirmedAuth = (auth: ServerProvider["auth"]): ServerProvider["auth"] =>
      auth.status === "authenticated" ? { ...auth, status: "unknown" } : auth;
    const lastSuccessfulRuntime = yield* Ref.make<{
      readonly identity: string;
      readonly provider: ServerProvider;
    } | null>(null);
    // Tracks the latest accepted auth result per runtime separately from lastSuccessfulRuntime
    // capabilities so an un-adopted failure on B neither clears retained A's confirmation nor
    // restores lost confirmation.
    const latestAcceptedAuth = yield* Ref.make<{
      readonly identity: string;
      readonly auth: ServerProvider["auth"];
    } | null>(null);
    const failedUpgradeTarget = yield* Ref.make<FailedUpgradeTargetState | null>(null);
    const clearLiveState = (
      options?: AcpRegistryRuntimeCoordinator.AcpRegistryClearLiveStateOptions,
    ) =>
      (Option.isSome(runtimeCoordinator)
        ? runtimeCoordinator.value
            .clearLiveConfiguration(instanceId, options)
            .pipe(
              Effect.andThen(runtimeCoordinator.value.clearAvailableCommands(instanceId, options)),
            )
        : Effect.void
      ).pipe(
        Effect.andThen(clearLearnedModels),
        Effect.andThen(Ref.set(activeRuntimeIdentity, options?.preserveRuntimeIdentity ?? null)),
        Effect.andThen(
          options?.preserveRuntimeIdentity === undefined
            ? Ref.set(lastSuccessfulRuntime, null).pipe(
                Effect.andThen(Ref.set(latestAcceptedAuth, null)),
                Effect.andThen(Ref.set(failedUpgradeTarget, null)),
              )
            : Ref.update(latestAcceptedAuth, (current) =>
                current !== null && current.identity === options.preserveRuntimeIdentity
                  ? current
                  : null,
              ),
        ),
      );
    const withLiveRuntimeState = Effect.fn("AcpRegistryDriver.withLiveRuntimeState")(function* (
      input: ServerProvider,
      options?: {
        readonly applySessionLiveState?: boolean;
        readonly sessionRuntimeIdentity?: string | null;
        readonly requireMatchingRuntimeIdentity?: boolean;
        readonly useLearnedModels?: boolean;
        readonly persistLearnedModels?: boolean;
      },
    ) {
      if (!input.installed) return { provider: input, appliedLiveConfiguration: false };
      const provider =
        input.enabled &&
        input.installed &&
        input.auth.status === "unknown" &&
        (yield* confirmedAuthentication.get)
          ? { ...input, auth: { ...input.auth, status: "authenticated" as const } }
          : input;
      if (Option.isNone(runtimeCoordinator)) {
        return { provider, appliedLiveConfiguration: false };
      }
      const applySessionLiveState = options?.applySessionLiveState ?? true;
      const readOptions: AcpRegistryRuntimeCoordinator.AcpRegistryReadLiveStateOptions | undefined =
        options?.sessionRuntimeIdentity
          ? {
              runtimeIdentity: options.sessionRuntimeIdentity,
              ...(options.requireMatchingRuntimeIdentity
                ? { requireMatchingRuntimeIdentity: true }
                : {}),
            }
          : undefined;
      const { commands, configuration, authAction } = yield* Effect.all({
        commands: applySessionLiveState
          ? runtimeCoordinator.value.getAvailableCommands(instanceId, readOptions)
          : Effect.succeedNone,
        configuration: applySessionLiveState
          ? runtimeCoordinator.value.getLiveConfiguration(instanceId, readOptions)
          : Effect.succeedNone,
        authAction: runtimeCoordinator.value.getUrlAuthAction(instanceId),
      });
      const withCommands = applyAcpRegistryAvailableCommands(provider, commands);
      const withConfiguration = yield* Option.match(configuration, {
        onNone: () => Effect.succeed(withCommands),
        onSome: (liveConfiguration) => {
          if (options?.persistLearnedModels === false) {
            return (
              options.useLearnedModels === false
                ? Effect.succeed<ReadonlyArray<ServerProviderModel>>([])
                : Ref.get(learnedModels)
            ).pipe(
              Effect.map((learned) =>
                applyAcpRegistryLiveConfiguration(
                  withCommands,
                  liveConfiguration,
                  effectiveConfig.customModels,
                  learned.length > 0 ? learned : withCommands.models,
                ),
              ),
            );
          }
          return options?.useLearnedModels === false
            ? Effect.succeed(
                applyAcpRegistryLiveConfiguration(
                  withCommands,
                  liveConfiguration,
                  effectiveConfig.customModels,
                  withCommands.models,
                ),
              )
            : applyLiveConfiguration(withCommands, liveConfiguration);
        },
      });
      return {
        provider: applyAcpRegistryUrlAuthAction(withConfiguration, authAction),
        appliedLiveConfiguration: Option.isSome(configuration),
      };
    });
    // A local executable's version comes only from probing it, so readiness checks reuse the last report.
    const reportedLocalVersion = yield* Ref.make<string | null>(null);
    const latestCheckedReadiness = yield* Ref.make<CheckedAcpRegistryReadiness | null>(null);
    const activeFallback = yield* Ref.make<ActiveFallbackState | null>(null);
    const retiredRuntimeIdentities = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const inspectReadiness = (options?: {
      readonly applySessionLiveState?: boolean;
      readonly seedActiveRuntimeIdentity?: boolean;
      readonly preserveActiveFallback?: boolean;
    }) =>
      checkAcpRegistryProviderReadinessWithIdentity(readinessInput).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.flatMap(({ snapshot, launchIdentity, indexRevision }) =>
          Effect.all({
            version: Ref.get(reportedLocalVersion),
            fallbackState: Ref.get(activeFallback),
            failedUpgrade: Ref.get(failedUpgradeTarget),
            lastRuntime: Ref.get(lastSuccessfulRuntime),
            acceptedAuth: Ref.get(latestAcceptedAuth),
            activeIdentity: Ref.get(activeRuntimeIdentity),
          }).pipe(
            Effect.map(
              ({
                version,
                fallbackState,
                failedUpgrade,
                lastRuntime,
                acceptedAuth,
                activeIdentity,
              }) => {
                const withLocalVersion =
                  snapshot.installed && snapshot.version === null && version !== null
                    ? { ...snapshot, version }
                    : snapshot;
                if (
                  options?.preserveActiveFallback === true &&
                  fallbackState !== null &&
                  withLocalVersion.installed &&
                  launchIdentity !== null &&
                  launchIdentity === fallbackState.targetLaunchIdentity
                ) {
                  const preservedBase =
                    lastRuntime !== null &&
                    fallbackState.fallbackLaunchIdentity !== null &&
                    lastRuntime.identity === fallbackState.fallbackLaunchIdentity
                      ? applyRegistryReadinessMetadata(lastRuntime.provider, withLocalVersion)
                      : withLocalVersion;
                  return {
                    snapshot: {
                      ...preservedBase,
                      checkedAt: withLocalVersion.checkedAt,
                      installed: true,
                      version: fallbackState.fallbackVersion,
                      status: withLocalVersion.enabled ? ("ready" as const) : ("disabled" as const),
                    },
                    launchIdentity: fallbackState.fallbackLaunchIdentity,
                    indexRevision,
                    fallback: true as const,
                    fallbackTargetIndexRevision: fallbackState.targetIndexRevision,
                    retryFailedUpgrade: false as const,
                    preserveStatus: undefined as ServerProvider["status"] | undefined,
                    preserveMessage: fallbackState.message as string | undefined,
                  };
                }
                if (
                  options?.preserveActiveFallback === true &&
                  failedUpgrade !== null &&
                  lastRuntime !== null &&
                  activeIdentity !== null &&
                  lastRuntime.identity === activeIdentity &&
                  withLocalVersion.installed &&
                  launchIdentity !== null &&
                  launchIdentity === failedUpgrade.targetLaunchIdentity
                ) {
                  const { message: _previousMessage, ...lastProviderWithoutMessage } =
                    lastRuntime.provider;
                  const preservedAuth =
                    acceptedAuth !== null && acceptedAuth.identity === lastRuntime.identity
                      ? acceptedAuth.auth
                      : lastProviderWithoutMessage.auth;
                  return {
                    snapshot: {
                      ...lastProviderWithoutMessage,
                      auth: preservedAuth,
                      checkedAt: withLocalVersion.checkedAt,
                      installed: true,
                      status: withLocalVersion.enabled
                        ? failedUpgrade.status
                        : ("disabled" as const),
                      ...(failedUpgrade.message !== undefined
                        ? { message: failedUpgrade.message }
                        : {}),
                    },
                    launchIdentity: lastRuntime.identity,
                    indexRevision,
                    fallback: false as const,
                    fallbackTargetIndexRevision: null as number | null,
                    retryFailedUpgrade: true as const,
                    preserveStatus: (withLocalVersion.enabled
                      ? failedUpgrade.status
                      : "disabled") as ServerProvider["status"] | undefined,
                    preserveMessage: failedUpgrade.message,
                  };
                }
                return {
                  snapshot: withLocalVersion,
                  launchIdentity,
                  indexRevision,
                  fallback: false as const,
                  fallbackTargetIndexRevision: null as number | null,
                  retryFailedUpgrade: false as const,
                  preserveStatus: undefined as ServerProvider["status"] | undefined,
                  preserveMessage: undefined as string | undefined,
                };
              },
            ),
          ),
        ),
        Effect.flatMap(
          ({
            snapshot,
            launchIdentity,
            indexRevision,
            fallback,
            fallbackTargetIndexRevision,
            retryFailedUpgrade,
            preserveStatus,
            preserveMessage,
          }) => {
            const nextIdentity = snapshot.installed
              ? runtimeIdentityFor(snapshot, launchIdentity)
              : null;
            return Ref.modify(activeRuntimeIdentity, (previousIdentity) => {
              if (
                options?.seedActiveRuntimeIdentity === true &&
                snapshot.installed &&
                previousIdentity === null &&
                nextIdentity !== null
              ) {
                return [nextIdentity, nextIdentity] as const;
              }
              return [previousIdentity, previousIdentity] as const;
            }).pipe(
              Effect.flatMap((previousIdentity) => {
                const runtimeChanged =
                  previousIdentity !== null &&
                  nextIdentity !== null &&
                  previousIdentity !== nextIdentity;
                return withLiveRuntimeState(snapshot, {
                  applySessionLiveState: options?.applySessionLiveState ?? true,
                  sessionRuntimeIdentity: nextIdentity,
                  requireMatchingRuntimeIdentity: runtimeChanged,
                  useLearnedModels: !runtimeChanged,
                  persistLearnedModels: !runtimeChanged,
                }).pipe(
                  Effect.map(({ provider }) => ({
                    snapshot:
                      preserveMessage !== undefined || preserveStatus !== undefined
                        ? {
                            ...provider,
                            ...(preserveStatus !== undefined ? { status: preserveStatus } : {}),
                            ...(preserveMessage !== undefined ? { message: preserveMessage } : {}),
                          }
                        : provider,
                    launchIdentity,
                    indexRevision,
                    ...(fallback ? { fallback: true, fallbackTargetIndexRevision } : {}),
                    ...(retryFailedUpgrade ? { retryFailedUpgrade: true } : {}),
                  })),
                );
              }),
            );
          },
        ),
      );
    const checkProvider = inspectReadiness({
      seedActiveRuntimeIdentity: true,
      preserveActiveFallback: true,
    }).pipe(
      Effect.tap((readiness) => Ref.set(latestCheckedReadiness, readiness)),
      Effect.map(({ snapshot }) => snapshot),
    );
    const enrichProvider = checkAcpRegistryProviderStatusWithIdentity(
      {
        ...readinessInput,
        cwd: host.paths.cwd,
      },
      probeAcpRegistryConfiguration,
    ).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SecureRandom.SecureRandom, random),
    );
    const tracksRegistryIndex =
      effectiveConfig.enabled &&
      effectiveConfig.source !== "local" &&
      effectiveConfig.agentId.length > 0;
    const currentCatalogIndexRevision = catalog.currentIndexRevision();
    const lastSeenIndexRevision = yield* Ref.make(0);
    const acknowledgeRevision = (revision: number) =>
      Ref.update(lastSeenIndexRevision, (seen) => Math.max(seen, revision));
    const refreshRegistryIndex = Effect.fn("AcpRegistryDriver.refreshRegistryIndex")(function* () {
      return yield* catalog
        .refreshIndex({
          maxAgeMs: REGISTRY_INDEX_MAX_AGE_MS,
          failureBackoffMs: REGISTRY_FAILURE_BACKOFF_MS,
        })
        .pipe(Effect.catch(() => Ref.get(lastSeenIndexRevision)));
    });
    const enrichmentCache = yield* Ref.make<AcpRegistryEnrichmentCache>({
      invalidationGeneration: 0,
      liveGenerationByRuntime: new Map(),
      entry: null,
    });
    const liveSnapshotSemaphore = yield* Semaphore.make(1);
    const invalidateEnrichmentCache = Ref.set(activeFallback, null).pipe(
      Effect.andThen(Ref.set(failedUpgradeTarget, null)),
      Effect.andThen(
        Ref.update(enrichmentCache, (current) => ({
          invalidationGeneration: current.invalidationGeneration + 1,
          liveGenerationByRuntime: new Map(),
          entry: null,
        })),
      ),
    );
    const clearCachedProbeForRuntime = (runtimeIdentity: string | null) =>
      Ref.update(enrichmentCache, (cache) => {
        if (cache.entry === null) return cache;
        const entryIdentity = runtimeIdentityFor(
          cache.entry.provider,
          cache.entry.launchIdentity ?? null,
        );
        return effectiveConfig.source === "local" ||
          (runtimeIdentity !== null && entryIdentity === runtimeIdentity)
          ? { ...cache, entry: null }
          : cache;
      });
    let latestAuthConfirmed = yield* confirmedAuthentication.get;
    const setConfirmedAuth = (authenticated: boolean) =>
      Effect.uninterruptible(
        Effect.sync(() => {
          latestAuthConfirmed = authenticated;
        }).pipe(Effect.andThen(confirmedAuthentication.set(authenticated))),
      );
    const markAuthConfirmationCleared = () => {
      latestAuthConfirmed = false;
    };
    const recordAcceptedAuthRejection = (identity: string | null, auth: ServerProvider["auth"]) =>
      clearCachedProbeForRuntime(identity).pipe(
        Effect.andThen(
          identity === null ? Effect.void : Ref.set(latestAcceptedAuth, { identity, auth }),
        ),
        Effect.andThen(setConfirmedAuth(false)),
      );
    const isProbeStillCurrent = (
      current: AcpRegistryEnrichmentCache,
      captured: {
        readonly invalidationGeneration: number;
        readonly liveGenerationByRuntime: ReadonlyMap<string | null, number>;
      },
      probeIdentity: string | null,
    ) =>
      current.invalidationGeneration === captured.invalidationGeneration &&
      (current.liveGenerationByRuntime.get(probeIdentity) ?? 0) ===
        (captured.liveGenerationByRuntime.get(probeIdentity) ?? 0);
    const enrichProviderCached = Effect.fn("AcpRegistryDriver.enrichProviderCached")(function* (
      target: CheckedAcpRegistryReadiness,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const cacheState = yield* Ref.get(enrichmentCache);
      const captured = {
        invalidationGeneration: cacheState.invalidationGeneration,
        liveGenerationByRuntime: cacheState.liveGenerationByRuntime,
      };
      const cached = cacheState.entry;
      if (target.fallback === true) {
        const fallbackState = yield* Ref.get(activeFallback);
        // Enforce fallback retry backoff before probing so 30s provisional cache expiry on
        // 1-model agents cannot re-trigger downloads or reset failedAtMs inside the 60s window.
        if (
          fallbackState !== null &&
          now >= fallbackState.failedAtMs &&
          now - fallbackState.failedAtMs < FALLBACK_RETRY_BACKOFF_MS
        ) {
          const targetIdentity = runtimeIdentityFor(target.snapshot, target.launchIdentity);
          const cachedMatchesTarget =
            cached !== null &&
            cached.provider.version === target.snapshot.version &&
            (cached.launchIdentity === undefined ||
              target.launchIdentity === null ||
              cached.launchIdentity === target.launchIdentity);
          const lastRuntime = cachedMatchesTarget ? null : yield* Ref.get(lastSuccessfulRuntime);
          const baseFallbackProvider = cachedMatchesTarget
            ? cached.provider
            : lastRuntime !== null && lastRuntime.identity === targetIdentity
              ? lastRuntime.provider
              : target.snapshot;
          return {
            provider: {
              ...applyRegistryReadinessMetadata(baseFallbackProvider, target.snapshot),
              checkedAt: target.snapshot.checkedAt,
              status: target.snapshot.enabled ? ("ready" as const) : ("disabled" as const),
              message: fallbackState.message,
            },
            launchIdentity: target.launchIdentity,
            indexRevision: target.indexRevision,
            fallback: true,
            fallbackTargetLaunchIdentity: fallbackState.targetLaunchIdentity,
            fallbackTargetVersion: fallbackState.targetVersion,
            fallbackTargetIndexRevision: fallbackState.targetIndexRevision,
            probedLaunchIdentity: null,
            failedTargetLaunchIdentity: null,
            probeFailed: false,
            fromCache: true,
            captured,
          };
        }
      } else if (
        target.retryFailedUpgrade !== true &&
        cached !== null &&
        isAcpRegistryCacheValid(
          cached,
          target.snapshot.version,
          effectiveConfig.source === "local",
          now,
          target.launchIdentity,
        )
      ) {
        return {
          provider: {
            ...applyRegistryReadinessMetadata(cached.provider, target.snapshot),
            checkedAt: target.snapshot.checkedAt,
          },
          launchIdentity: target.launchIdentity,
          indexRevision: target.indexRevision,
          fallback: false,
          fallbackTargetLaunchIdentity: null,
          fallbackTargetVersion: null,
          fallbackTargetIndexRevision: null,
          probedLaunchIdentity: null,
          failedTargetLaunchIdentity: null,
          probeFailed: false,
          fromCache: true,
          captured,
        };
      }
      const {
        provider: enriched,
        launchIdentity,
        indexRevision,
        cacheable,
        fallback,
        fallbackTargetLaunchIdentity,
        fallbackTargetVersion,
        fallbackTargetIndexRevision,
        probedLaunchIdentity,
        failedTargetLaunchIdentity,
        probeFailed,
      } = yield* enrichProvider;
      if (effectiveConfig.source === "local" && enriched.status === "ready") {
        yield* Ref.set(reportedLocalVersion, enriched.version);
      }
      const probeIdentity = enriched.installed
        ? runtimeIdentityFor(enriched, launchIdentity)
        : null;
      if (cacheable && enriched.status === "ready") {
        const completedAt = yield* Clock.currentTimeMillis;
        yield* Ref.update(enrichmentCache, (current) =>
          isProbeStillCurrent(current, captured, probeIdentity)
            ? {
                ...current,
                entry: {
                  provider: enriched,
                  expiresAt: completedAt + acpRegistryProbeTtlMs(enriched),
                  launchIdentity,
                },
              }
            : current,
        );
      }
      return {
        provider: enriched,
        launchIdentity,
        indexRevision,
        fallback: fallback === true,
        fallbackTargetLaunchIdentity: fallbackTargetLaunchIdentity ?? target.launchIdentity,
        fallbackTargetVersion: fallbackTargetVersion ?? target.snapshot.version,
        fallbackTargetIndexRevision: fallbackTargetIndexRevision ?? target.indexRevision,
        probedLaunchIdentity: probedLaunchIdentity ?? null,
        failedTargetLaunchIdentity: failedTargetLaunchIdentity ?? null,
        probeFailed: probeFailed === true,
        fromCache: false,
        captured,
      };
    });
    const reconcilingState = yield* Ref.make<ReadonlyMap<string, boolean>>(new Map());
    const refreshTarget = yield* Deferred.make<Effect.Effect<void>>();
    const triggerSnapshotRefresh = Deferred.await(refreshTarget).pipe(Effect.flatten);
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
      reconcileCheckedSnapshot: (probed) =>
        !latestAuthConfirmed && probed.auth.status === "authenticated"
          ? { ...probed, auth: stripConfirmedAuth(probed.auth) }
          : probed,
      enrichSnapshot: Effect.fn("enrichSnapshot")(function* ({
        snapshot,
        getSnapshot,
        tryPublishSnapshot,
      }) {
        const initialReadiness: CheckedAcpRegistryReadiness = yield* Ref.get(
          latestCheckedReadiness,
        ).pipe(
          Effect.map((latest) =>
            latest !== null &&
            latest.snapshot.checkedAt === snapshot.checkedAt &&
            latest.snapshot.installed === snapshot.installed &&
            latest.snapshot.version === snapshot.version
              ? {
                  snapshot,
                  launchIdentity: latest.launchIdentity,
                  indexRevision: latest.indexRevision,
                  ...(latest.fallback
                    ? {
                        fallback: true,
                        fallbackTargetIndexRevision: latest.fallbackTargetIndexRevision ?? null,
                      }
                    : {}),
                  ...(latest.retryFailedUpgrade ? { retryFailedUpgrade: true } : {}),
                }
              : { snapshot, launchIdentity: null, indexRevision: null },
          ),
        );
        const expectedRuntimeIdentity = yield* Ref.make<string | null>(
          snapshot.installed
            ? runtimeIdentityFor(initialReadiness.snapshot, initialReadiness.launchIdentity)
            : null,
        );
        const probeReconcileState = yield* Ref.make<{
          readonly inFlight: string | null;
          readonly pending: string | null;
        }>({ inFlight: null, pending: null });
        const maybeReconcileUnmatchedRuntime = (
          incomingIdentity: string | undefined,
        ): Effect.Effect<void> => {
          if (incomingIdentity === undefined || !tracksRegistryIndex) return Effect.void;
          return Effect.gen(function* () {
            const retiredAtRevision = (yield* Ref.get(retiredRuntimeIdentities)).get(
              incomingIdentity,
            );
            const currentRevision =
              retiredAtRevision === undefined ? undefined : yield* currentCatalogIndexRevision;
            if (
              retiredAtRevision !== undefined &&
              currentRevision !== undefined &&
              currentRevision <= retiredAtRevision
            ) {
              return;
            }
            const parkedOnProbe = yield* Ref.modify(probeReconcileState, (state) =>
              state.inFlight === incomingIdentity
                ? ([true, { ...state, pending: incomingIdentity }] as const)
                : ([false, state] as const),
            );
            if (parkedOnProbe) return;
            const claimed = yield* Ref.modify(reconcilingState, (state) => {
              const next = new Map(state);
              if (state.has(incomingIdentity)) {
                next.set(incomingIdentity, true);
                return [false, next] as const;
              }
              next.set(incomingIdentity, false);
              return [true, next] as const;
            });
            if (!claimed) return;
            yield* Effect.gen(function* () {
              const inspected = yield* Effect.result(
                catalog.inspect(readinessInput.settings, readinessInput.environment),
              );
              let matched = false;
              if (
                Result.isSuccess(inspected) &&
                inspected.success.status === "ready" &&
                inspected.success.launchIdentity === incomingIdentity
              ) {
                matched = true;
                yield* Ref.update(activeFallback, (current) =>
                  current?.targetLaunchIdentity === incomingIdentity ? null : current,
                );
                yield* Ref.update(failedUpgradeTarget, (current) =>
                  current?.targetLaunchIdentity === incomingIdentity ? null : current,
                );
                yield* triggerSnapshotRefresh;
              } else if (
                retiredAtRevision !== undefined &&
                currentRevision !== undefined &&
                Result.isSuccess(inspected)
              ) {
                const stampRevision =
                  "indexRevision" in inspected.success &&
                  typeof inspected.success.indexRevision === "number"
                    ? inspected.success.indexRevision
                    : currentRevision;
                yield* Ref.update(retiredRuntimeIdentities, (retired) => {
                  if (!retired.has(incomingIdentity)) return retired;
                  const next = new Map(retired);
                  next.set(
                    incomingIdentity,
                    Math.max(retired.get(incomingIdentity) ?? 0, stampRevision),
                  );
                  return next;
                });
              }
              const replayPending = yield* Ref.modify(reconcilingState, (state) => {
                if (!state.has(incomingIdentity)) return [false, state] as const;
                const next = new Map(state);
                const pending = next.get(incomingIdentity) === true;
                next.delete(incomingIdentity);
                return [pending, next] as const;
              });
              if (!matched && replayPending) {
                yield* maybeReconcileUnmatchedRuntime(incomingIdentity);
              }
            }).pipe(
              Effect.onError((cause) =>
                Ref.modify(reconcilingState, (state) => {
                  if (!state.has(incomingIdentity)) return [false, state] as const;
                  const next = new Map(state);
                  const pending = next.get(incomingIdentity) === true;
                  next.delete(incomingIdentity);
                  return [pending, next] as const;
                }).pipe(
                  Effect.flatMap((replayPending) =>
                    // Replay a parked update after an unexpected defect (never on interruption).
                    replayPending && !Cause.hasInterruptsOnly(cause)
                      ? maybeReconcileUnmatchedRuntime(incomingIdentity)
                      : Effect.void,
                  ),
                ),
              ),
              Effect.withSpan("AcpRegistryDriver.reconcileUnmatchedRuntime"),
              Effect.forkIn(driverScope),
            );
          });
        };
        const checkLiveUpdate = (meta: AcpRegistryRuntimeCoordinator.AcpRegistryLiveUpdateMeta) =>
          Effect.all({
            isCurrent: meta.isCurrent,
            expected: Ref.get(expectedRuntimeIdentity),
            active: Ref.get(activeRuntimeIdentity),
          }).pipe(
            Effect.map(({ isCurrent, expected, active }) => {
              const runtimeTransitioning =
                active !== null && expected !== null && active !== expected;
              if (!isCurrent) {
                return {
                  accepted: false,
                  reconcileIdentity: undefined,
                  expected,
                  runtimeTransitioning,
                } as const;
              }
              if (meta.runtimeIdentity !== undefined) {
                const accepted = expected === null || meta.runtimeIdentity === expected;
                return {
                  accepted,
                  reconcileIdentity: accepted ? undefined : meta.runtimeIdentity,
                  expected,
                  runtimeTransitioning,
                } as const;
              }
              return {
                accepted: !runtimeTransitioning,
                reconcileIdentity: undefined,
                expected,
                runtimeTransitioning,
              } as const;
            }),
          );
        const runProbeAndPublish = (target: CheckedAcpRegistryReadiness) => {
          const targetIdentity = target.snapshot.installed
            ? runtimeIdentityFor(target.snapshot, target.launchIdentity)
            : null;
          const probeEffect = Option.isSome(runtimeCoordinator)
            ? runtimeCoordinator.value.runBackgroundProbe(
                effectiveConfig.source === "local"
                  ? `local:${instanceId}`
                  : effectiveConfig.agentId,
                enrichProviderCached(target),
              )
            : enrichProviderCached(target).pipe(Effect.asSome);
          let drainedPending: string | null = null;
          return Ref.update(probeReconcileState, (state) => ({
            ...state,
            inFlight: targetIdentity,
          })).pipe(
            Effect.andThen(probeEffect),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.succeed<{
                    readonly published: boolean;
                    readonly readiness: CheckedAcpRegistryReadiness | null;
                    readonly publishedIdentity: string | null;
                  }>({ published: false, readiness: null, publishedIdentity: null }),
                onSome: ({
                  provider,
                  launchIdentity,
                  indexRevision,
                  fallback,
                  fallbackTargetLaunchIdentity,
                  fallbackTargetVersion,
                  fallbackTargetIndexRevision,
                  probedLaunchIdentity,
                  failedTargetLaunchIdentity,
                  probeFailed,
                  fromCache,
                  captured,
                }) =>
                  liveSnapshotSemaphore.withPermit(
                    Effect.gen(function* () {
                      const previousIdentity = yield* Ref.get(activeRuntimeIdentity);
                      const resolvedIdentity =
                        provider.installed && !probeFailed
                          ? runtimeIdentityFor(provider, launchIdentity)
                          : null;
                      const current = yield* Ref.get(enrichmentCache);
                      if (!isProbeStillCurrent(current, captured, resolvedIdentity)) {
                        return {
                          published: false,
                          readiness: null,
                          publishedIdentity: null,
                        };
                      }
                      if (probeFailed && provider.installed && previousIdentity !== null) {
                        // The new runtime failed before resolving/starting; preserve the last
                        // accepted snapshot only when one exists for previousIdentity so we never
                        // overlay A's live models/commands onto B's failure snapshot.
                        const lastRuntime = yield* Ref.get(lastSuccessfulRuntime);
                        const isProbedDifferentRuntime =
                          probedLaunchIdentity !== null &&
                          probedLaunchIdentity !== previousIdentity;
                        const isUpgradeFailure =
                          failedTargetLaunchIdentity !== null &&
                          failedTargetLaunchIdentity !== previousIdentity;
                        if (lastRuntime !== null && lastRuntime.identity === previousIdentity) {
                          const { message: _previousMessage, ...base } = lastRuntime.provider;
                          const acceptedAuth = yield* Ref.get(latestAcceptedAuth);
                          const retainedAuth =
                            acceptedAuth !== null && acceptedAuth.identity === previousIdentity
                              ? acceptedAuth.auth
                              : base.auth;
                          const activeRuntimeUnauthenticated =
                            !isProbedDifferentRuntime && provider.auth.status === "unauthenticated";
                          const preservedBase: ServerProvider = {
                            ...base,
                            checkedAt: provider.checkedAt,
                            status: provider.status,
                            auth: activeRuntimeUnauthenticated ? provider.auth : retainedAuth,
                            ...(provider.message !== undefined
                              ? { message: provider.message }
                              : {}),
                          };
                          const { provider: nextSnapshotRaw } = yield* withLiveRuntimeState(
                            preservedBase,
                            {
                              sessionRuntimeIdentity: previousIdentity,
                              requireMatchingRuntimeIdentity: false,
                              useLearnedModels: true,
                              persistLearnedModels: false,
                            },
                          );
                          const preserveProbeFailure =
                            isUpgradeFailure || provider.auth.status === "unauthenticated";
                          const nextSnapshot = preserveProbeFailure
                            ? {
                                ...nextSnapshotRaw,
                                status: provider.status,
                                ...(provider.message !== undefined
                                  ? { message: provider.message }
                                  : {}),
                              }
                            : nextSnapshotRaw;
                          const published = yield* Effect.uninterruptible(
                            tryPublishSnapshot(
                              nextSnapshot,
                              activeRuntimeUnauthenticated
                                ? markAuthConfirmationCleared
                                : undefined,
                            ).pipe(
                              Effect.tap((didPublish) =>
                                didPublish
                                  ? Effect.gen(function* () {
                                      if (activeRuntimeUnauthenticated) {
                                        // Clear fallback backoff so a user's sign-in retry probes immediately.
                                        yield* Ref.set(activeFallback, null);
                                        yield* recordAcceptedAuthRejection(
                                          previousIdentity,
                                          provider.auth,
                                        );
                                      }
                                      yield* Ref.set(expectedRuntimeIdentity, previousIdentity);
                                      yield* Ref.set(
                                        failedUpgradeTarget,
                                        isUpgradeFailure
                                          ? {
                                              targetLaunchIdentity: failedTargetLaunchIdentity,
                                              status: provider.status,
                                              message: provider.message,
                                            }
                                          : null,
                                      );
                                    })
                                  : Effect.void,
                              ),
                            ),
                          );
                          return {
                            published,
                            readiness: published
                              ? {
                                  snapshot: nextSnapshot,
                                  launchIdentity: previousIdentity,
                                  indexRevision,
                                  probeFailed: true,
                                }
                              : null,
                            publishedIdentity: published ? previousIdentity : null,
                          };
                        }
                        // No accepted snapshot exists for previousIdentity; publish the failure
                        // snapshot directly without attaching previousIdentity's live state and
                        // align watcher identities so previousIdentity updates cannot land on it.
                        const failedIdentity = runtimeIdentityFor(
                          provider,
                          probedLaunchIdentity ?? failedTargetLaunchIdentity,
                        );
                        const published = yield* Effect.uninterruptible(
                          tryPublishSnapshot(
                            provider,
                            provider.auth.status === "unauthenticated"
                              ? markAuthConfirmationCleared
                              : undefined,
                          ).pipe(
                            Effect.tap((didPublish) =>
                              didPublish
                                ? Effect.gen(function* () {
                                    if (provider.auth.status === "unauthenticated") {
                                      // Adopting failedIdentity with no retained runtime clears
                                      // saved confirmation so refreshes do not flash authenticated.
                                      yield* recordAcceptedAuthRejection(
                                        failedIdentity,
                                        provider.auth,
                                      );
                                    }
                                    if (
                                      failedIdentity !== null &&
                                      failedIdentity !== previousIdentity
                                    ) {
                                      yield* clearLiveState({
                                        preserveRuntimeIdentity: failedIdentity,
                                      });
                                    }
                                    yield* Ref.set(expectedRuntimeIdentity, failedIdentity);
                                  })
                                : Effect.void,
                            ),
                          ),
                        );
                        return {
                          published,
                          readiness: published
                            ? {
                                snapshot: provider,
                                launchIdentity: failedIdentity,
                                indexRevision,
                                probeFailed: true,
                              }
                            : null,
                          publishedIdentity: null,
                        };
                      }
                      const existingFallback = fallback ? yield* Ref.get(activeFallback) : null;
                      const fallbackMessage =
                        fallback && !fromCache
                          ? fallbackTargetVersion !== null &&
                            provider.version !== null &&
                            fallbackTargetVersion !== provider.version
                            ? `Could not install ${effectiveConfig.agentId} ${fallbackTargetVersion}; using installed ${provider.version}. Will retry on the next refresh.`
                            : "Could not install the latest agent update; using the previously installed version. Will retry on the next refresh."
                          : existingFallback?.message;
                      const effectiveMessage = fallback
                        ? (fallbackMessage ?? provider.message)
                        : provider.message;
                      const providerToPublish =
                        fallback && effectiveMessage !== undefined
                          ? { ...provider, message: effectiveMessage }
                          : provider;
                      const runtimeChanged =
                        previousIdentity !== null &&
                        resolvedIdentity !== null &&
                        previousIdentity !== resolvedIdentity;
                      const { provider: nextSnapshotRaw, appliedLiveConfiguration } =
                        yield* withLiveRuntimeState(providerToPublish, {
                          sessionRuntimeIdentity: resolvedIdentity,
                          requireMatchingRuntimeIdentity: runtimeChanged,
                          useLearnedModels: !runtimeChanged,
                          persistLearnedModels: false,
                        });
                      const preserveUnauthenticated =
                        providerToPublish.auth.status === "unauthenticated";
                      const nextSnapshot = preserveUnauthenticated
                        ? {
                            ...nextSnapshotRaw,
                            status: providerToPublish.status,
                            ...(providerToPublish.message !== undefined
                              ? { message: providerToPublish.message }
                              : {}),
                          }
                        : fallback && effectiveMessage !== undefined
                          ? { ...nextSnapshotRaw, message: effectiveMessage }
                          : nextSnapshotRaw;
                      const published = yield* Effect.uninterruptible(
                        tryPublishSnapshot(
                          nextSnapshot,
                          providerToPublish.installed &&
                            nextSnapshot.auth.status === "unauthenticated"
                            ? markAuthConfirmationCleared
                            : undefined,
                        ).pipe(
                          Effect.tap((didPublish) =>
                            didPublish
                              ? Effect.gen(function* () {
                                  if (!providerToPublish.installed) {
                                    yield* Ref.set(activeFallback, null);
                                    yield* Ref.set(failedUpgradeTarget, null);
                                    yield* Ref.set(lastSuccessfulRuntime, null);
                                    yield* Ref.set(latestAcceptedAuth, null);
                                    if (previousIdentity !== null || current.entry !== null) {
                                      yield* clearLiveState();
                                      yield* invalidateEnrichmentCache;
                                    }
                                    yield* Ref.set(expectedRuntimeIdentity, null);
                                  } else {
                                    const previousLastSuccessful =
                                      yield* Ref.get(lastSuccessfulRuntime);
                                    if (nextSnapshot.auth.status === "unauthenticated") {
                                      yield* recordAcceptedAuthRejection(
                                        resolvedIdentity ??
                                          runtimeIdentityFor(
                                            providerToPublish,
                                            probedLaunchIdentity,
                                          ),
                                        nextSnapshot.auth,
                                      );
                                    }
                                    if (!probeFailed) {
                                      yield* Ref.set(failedUpgradeTarget, null);
                                    }
                                    if (fallback && !fromCache) {
                                      const now = yield* Clock.currentTimeMillis;
                                      const keepFailedAt =
                                        existingFallback !== null &&
                                        existingFallback.targetLaunchIdentity ===
                                          fallbackTargetLaunchIdentity &&
                                        now >= existingFallback.failedAtMs &&
                                        now - existingFallback.failedAtMs <
                                          FALLBACK_RETRY_BACKOFF_MS;
                                      yield* Ref.set(activeFallback, {
                                        targetLaunchIdentity: fallbackTargetLaunchIdentity,
                                        targetVersion: fallbackTargetVersion,
                                        targetIndexRevision: fallbackTargetIndexRevision,
                                        fallbackVersion: providerToPublish.version,
                                        fallbackLaunchIdentity: launchIdentity,
                                        failedAtMs: keepFailedAt
                                          ? existingFallback.failedAtMs
                                          : now,
                                        message:
                                          fallbackMessage ??
                                          existingFallback?.message ??
                                          "Using the previously installed version.",
                                      });
                                    } else if (!fallback && !probeFailed) {
                                      yield* Ref.set(activeFallback, null);
                                    }
                                    if (runtimeChanged) {
                                      yield* clearLiveState({
                                        preserveRuntimeIdentity: resolvedIdentity,
                                      });
                                      const retiredAtRevision =
                                        (fallback ? fallbackTargetIndexRevision : indexRevision) ??
                                        (yield* currentCatalogIndexRevision);
                                      yield* Ref.update(retiredRuntimeIdentities, (retired) => {
                                        const next = new Map(retired);
                                        // Retire only a runtime that actually succeeded; a
                                        // never-installed target replaced during cold fallback
                                        // stays eligible to reconcile.
                                        if (previousLastSuccessful?.identity === previousIdentity) {
                                          next.set(previousIdentity, retiredAtRevision);
                                        }
                                        next.delete(resolvedIdentity);
                                        return next;
                                      });
                                      if (appliedLiveConfiguration) {
                                        yield* Ref.set(learnedModels, nextSnapshot.models);
                                      }
                                      yield* Ref.set(expectedRuntimeIdentity, resolvedIdentity);
                                    } else {
                                      if (
                                        appliedLiveConfiguration &&
                                        nextSnapshot.models !== providerToPublish.models
                                      ) {
                                        yield* Ref.set(learnedModels, nextSnapshot.models);
                                      }
                                      if (resolvedIdentity !== null) {
                                        yield* Ref.set(activeRuntimeIdentity, resolvedIdentity);
                                        yield* Ref.update(retiredRuntimeIdentities, (retired) => {
                                          if (!retired.has(resolvedIdentity)) return retired;
                                          const next = new Map(retired);
                                          next.delete(resolvedIdentity);
                                          return next;
                                        });
                                      }
                                      yield* Ref.set(expectedRuntimeIdentity, resolvedIdentity);
                                    }
                                    if (!probeFailed && resolvedIdentity !== null) {
                                      const { message: _fallbackMsg, ...cleanProvider } =
                                        nextSnapshotRaw;
                                      const storedProvider = fallback
                                        ? cleanProvider
                                        : nextSnapshotRaw;
                                      yield* Ref.set(lastSuccessfulRuntime, {
                                        identity: resolvedIdentity,
                                        provider: {
                                          ...storedProvider,
                                          auth: stripConfirmedAuth(storedProvider.auth),
                                        },
                                      });
                                      yield* Ref.set(latestAcceptedAuth, {
                                        identity: resolvedIdentity,
                                        auth: stripConfirmedAuth(nextSnapshot.auth),
                                      });
                                    }
                                  }
                                })
                              : Effect.void,
                          ),
                        ),
                      );
                      return {
                        published,
                        readiness: published
                          ? {
                              snapshot: providerToPublish,
                              launchIdentity,
                              indexRevision,
                              ...(fallback
                                ? {
                                    fallback: true,
                                    fallbackTargetIndexRevision,
                                  }
                                : {}),
                              ...(probeFailed ? { probeFailed: true } : {}),
                            }
                          : null,
                        publishedIdentity: published ? resolvedIdentity : null,
                      };
                    }),
                  ),
              }),
            ),
            Effect.ensuring(
              Ref.modify(probeReconcileState, (state) =>
                state.inFlight === targetIdentity
                  ? ([state.pending, { inFlight: null, pending: null }] as const)
                  : ([null, state] as const),
              ).pipe(
                Effect.tap((pending) =>
                  Effect.sync(() => {
                    drainedPending = pending;
                  }),
                ),
                Effect.asVoid,
              ),
            ),
            Effect.tap(({ publishedIdentity }) =>
              drainedPending !== null && drainedPending !== publishedIdentity
                ? maybeReconcileUnmatchedRuntime(drainedPending)
                : Effect.void,
            ),
            Effect.map(({ published, readiness }) => ({ published, readiness })),
          );
        };
        const runWithLiveWatchers = (enrichment: Effect.Effect<void>) => {
          if (Option.isNone(runtimeCoordinator)) return enrichment;

          const publishLiveCommands = runtimeCoordinator.value.watchAvailableCommands(
            instanceId,
            ({ slashCommands, skills }, meta) =>
              liveSnapshotSemaphore
                .withPermit(
                  Effect.gen(function* () {
                    const gate = yield* checkLiveUpdate(meta);
                    if (!gate.accepted) return gate.reconcileIdentity;
                    const current = yield* getSnapshot;
                    if (!current.installed) return undefined;
                    const published = yield* tryPublishSnapshot({
                      ...current,
                      slashCommands,
                      skills,
                    });
                    if (published && !gate.runtimeTransitioning) {
                      const activeId = yield* Ref.get(activeRuntimeIdentity);
                      if (activeId !== null) {
                        const { message: _transientMsg, ...currentClean } = current;
                        yield* Ref.update(lastSuccessfulRuntime, (prev) =>
                          prev !== null && prev.identity === activeId
                            ? {
                                identity: prev.identity,
                                provider: { ...prev.provider, slashCommands, skills },
                              }
                            : prev === null && current.auth.status !== "unauthenticated"
                              ? {
                                  identity: activeId,
                                  provider: {
                                    ...currentClean,
                                    auth: stripConfirmedAuth(currentClean.auth),
                                    status: current.enabled
                                      ? ("ready" as const)
                                      : ("disabled" as const),
                                    slashCommands,
                                    skills,
                                  },
                                }
                              : prev,
                        );
                      }
                    }
                    return undefined;
                  }),
                )
                .pipe(Effect.flatMap(maybeReconcileUnmatchedRuntime)),
          );
          const publishLiveConfiguration = runtimeCoordinator.value.watchLiveConfiguration(
            instanceId,
            (configuration, meta) =>
              liveSnapshotSemaphore
                .withPermit(
                  Effect.gen(function* () {
                    const gate = yield* checkLiveUpdate(meta);
                    if (!gate.accepted) return gate.reconcileIdentity;
                    const current = yield* getSnapshot;
                    if (!current.installed) return undefined;
                    const learned = gate.runtimeTransitioning ? [] : yield* Ref.get(learnedModels);
                    const applied = applyAcpRegistryLiveConfiguration(
                      current,
                      configuration,
                      effectiveConfig.customModels,
                      learned.length > 0 ? learned : current.models,
                    );
                    const activeId = yield* Ref.get(activeRuntimeIdentity);
                    const fallbackState = yield* Ref.get(activeFallback);
                    const failedUpgrade = yield* Ref.get(failedUpgradeTarget);
                    const effectiveIdentity = meta.runtimeIdentity ?? activeId ?? gate.expected;
                    const preserveUnauthenticated = current.auth.status === "unauthenticated";
                    const preserveFallbackMessage =
                      !preserveUnauthenticated &&
                      fallbackState !== null &&
                      fallbackState.fallbackLaunchIdentity !== null &&
                      effectiveIdentity === fallbackState.fallbackLaunchIdentity;
                    const preserveUpgradeFailure =
                      !preserveUnauthenticated &&
                      !preserveFallbackMessage &&
                      failedUpgrade !== null &&
                      activeId !== null &&
                      failedUpgrade.targetLaunchIdentity !== activeId;
                    const next = preserveUnauthenticated
                      ? {
                          ...applied,
                          status: applied.enabled ? current.status : applied.status,
                          ...(current.message !== undefined ? { message: current.message } : {}),
                        }
                      : preserveFallbackMessage
                        ? { ...applied, message: fallbackState.message }
                        : preserveUpgradeFailure
                          ? {
                              ...applied,
                              status: applied.enabled ? failedUpgrade.status : applied.status,
                              ...(failedUpgrade.message !== undefined
                                ? { message: failedUpgrade.message }
                                : {}),
                            }
                          : applied;
                    const published = yield* tryPublishSnapshot(next);
                    if (!published) return undefined;
                    if (!gate.runtimeTransitioning && next.models !== current.models) {
                      yield* Ref.set(learnedModels, next.models);
                    }
                    if (!gate.runtimeTransitioning && activeId !== null) {
                      const { message: _transientMsg, ...appliedClean } = applied;
                      const isUnauthenticated = current.auth.status === "unauthenticated";
                      yield* Ref.update(lastSuccessfulRuntime, (prev) =>
                        prev !== null && prev.identity === activeId
                          ? {
                              identity: prev.identity,
                              provider: isUnauthenticated
                                ? { ...appliedClean, auth: prev.provider.auth }
                                : { ...appliedClean, auth: stripConfirmedAuth(appliedClean.auth) },
                            }
                          : prev === null && !isUnauthenticated
                            ? {
                                identity: activeId,
                                provider: {
                                  ...appliedClean,
                                  auth: stripConfirmedAuth(appliedClean.auth),
                                  status: current.enabled
                                    ? ("ready" as const)
                                    : ("disabled" as const),
                                },
                              }
                            : prev,
                      );
                    }
                    const snapshotChanged = !Equal.equals(next, current);
                    const now = yield* Clock.currentTimeMillis;
                    yield* Ref.update(enrichmentCache, (cache) =>
                      cache.entry === null && !snapshotChanged
                        ? cache
                        : updateAcpRegistryEnrichmentCache({
                            cache,
                            configuration,
                            customModels: effectiveConfig.customModels,
                            now,
                            runtimeIdentity: meta.runtimeIdentity ?? gate.expected,
                          }),
                    );
                    return undefined;
                  }),
                )
                .pipe(Effect.flatMap(maybeReconcileUnmatchedRuntime)),
          );
          const publishUrlAuthAction = runtimeCoordinator.value.watchUrlAuthAction(
            instanceId,
            (action) =>
              liveSnapshotSemaphore.withPermit(
                getSnapshot.pipe(
                  Effect.flatMap((current) =>
                    current.installed
                      ? tryPublishSnapshot(
                          applyAcpRegistryUrlAuthAction(current, Option.fromNullishOr(action)),
                        ).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
              ),
          );
          return Effect.all(
            [enrichment, publishLiveCommands, publishLiveConfiguration, publishUrlAuthAction],
            {
              concurrency: "unbounded",
              discard: true,
            },
          );
        };
        const retireActiveRuntimeIfNeeded = () =>
          liveSnapshotSemaphore.withPermit(
            Effect.all({
              active: Ref.get(activeRuntimeIdentity),
              cache: Ref.get(enrichmentCache),
            }).pipe(
              Effect.flatMap(({ active, cache }) =>
                active === null && cache.entry === null
                  ? Effect.void
                  : tryPublishSnapshot(snapshot).pipe(
                      Effect.tap((published) =>
                        published
                          ? clearLiveState().pipe(
                              Effect.andThen(invalidateEnrichmentCache),
                              Effect.andThen(Ref.set(expectedRuntimeIdentity, null)),
                            )
                          : Effect.void,
                      ),
                      Effect.asVoid,
                    ),
              ),
            ),
          );
        const publishUninstalled = (
          rechecked: CheckedAcpRegistryReadiness,
          shouldClearLiveState: boolean,
        ) =>
          liveSnapshotSemaphore.withPermit(
            tryPublishSnapshot(
              Equal.equals(readinessSignature(rechecked), readinessSignature(initialReadiness))
                ? snapshot
                : rechecked.snapshot,
            ).pipe(
              Effect.tap((published) =>
                published && shouldClearLiveState
                  ? clearLiveState().pipe(
                      Effect.andThen(invalidateEnrichmentCache),
                      Effect.andThen(Ref.set(expectedRuntimeIdentity, null)),
                    )
                  : Effect.void,
              ),
            ),
          );
        if (!snapshot.installed) {
          yield* retireActiveRuntimeIfNeeded();
          if (!tracksRegistryIndex) return;
          const revision = yield* refreshRegistryIndex();
          if (revision <= (yield* Ref.get(lastSeenIndexRevision))) return;
          if (
            initialReadiness.indexRevision !== null &&
            revision <= initialReadiness.indexRevision
          ) {
            yield* acknowledgeRevision(revision);
            return;
          }
          const rechecked = yield* inspectReadiness({ applySessionLiveState: false });
          if (!rechecked.snapshot.installed) {
            const published = yield* publishUninstalled(rechecked, false);
            if (
              published &&
              (rechecked.indexRevision === null || rechecked.indexRevision >= revision)
            ) {
              yield* acknowledgeRevision(rechecked.indexRevision ?? revision);
            }
            return;
          }
          const nextIdentity = runtimeIdentityFor(rechecked.snapshot, rechecked.launchIdentity);
          const publishedRechecked = yield* liveSnapshotSemaphore.withPermit(
            tryPublishSnapshot(rechecked.snapshot).pipe(
              Effect.tap((published) =>
                published
                  ? clearLiveState(
                      nextIdentity === null ? undefined : { preserveRuntimeIdentity: nextIdentity },
                    ).pipe(Effect.andThen(Ref.set(expectedRuntimeIdentity, nextIdentity)))
                  : Effect.void,
              ),
            ),
          );
          if (!publishedRechecked) return;
          yield* runWithLiveWatchers(
            runProbeAndPublish(rechecked).pipe(
              Effect.tap(({ published, readiness }) =>
                published &&
                readiness !== null &&
                !readiness.fallback &&
                !readiness.probeFailed &&
                (readiness.indexRevision === null || readiness.indexRevision >= revision)
                  ? acknowledgeRevision(readiness.indexRevision ?? revision)
                  : Effect.void,
              ),
              Effect.asVoid,
            ),
          );
          return;
        }
        const publishEnrichment = Effect.gen(function* () {
          // Probe or restore cached models before awaiting the network so startup and refreshes stay fast.
          const initialProbe = yield* runProbeAndPublish(initialReadiness);
          if (!tracksRegistryIndex) return;
          const revision = yield* refreshRegistryIndex();
          if (revision <= (yield* Ref.get(lastSeenIndexRevision))) return;
          const publishedReadiness =
            initialProbe.published && initialProbe.readiness !== null
              ? initialProbe.readiness
              : initialReadiness;
          const fallbackTargetRevision =
            publishedReadiness.fallbackTargetIndexRevision ?? initialReadiness.indexRevision;
          if (
            initialProbe.published &&
            publishedReadiness.fallback &&
            fallbackTargetRevision !== null &&
            fallbackTargetRevision >= revision
          ) {
            const fallbackState = yield* Ref.get(activeFallback);
            const now = yield* Clock.currentTimeMillis;
            if (
              fallbackState === null ||
              (now >= fallbackState.failedAtMs &&
                now - fallbackState.failedAtMs < FALLBACK_RETRY_BACKOFF_MS)
            ) {
              return;
            }
          }
          if (
            initialProbe.published &&
            publishedReadiness.probeFailed &&
            publishedReadiness.indexRevision !== null &&
            publishedReadiness.indexRevision >= revision
          ) {
            return;
          }
          if (
            initialProbe.published &&
            !publishedReadiness.fallback &&
            !publishedReadiness.probeFailed &&
            publishedReadiness.indexRevision !== null &&
            publishedReadiness.indexRevision >= revision
          ) {
            yield* acknowledgeRevision(publishedReadiness.indexRevision);
            return;
          }
          const rechecked = yield* inspectReadiness();
          if (!rechecked.snapshot.installed) {
            const published = yield* publishUninstalled(rechecked, true);
            if (
              published &&
              (rechecked.indexRevision === null || rechecked.indexRevision >= revision)
            ) {
              yield* acknowledgeRevision(rechecked.indexRevision ?? revision);
            }
            return;
          }
          const activeFallbackState = yield* Ref.get(activeFallback);
          const now = yield* Clock.currentTimeMillis;
          if (
            activeFallbackState !== null &&
            now >= activeFallbackState.failedAtMs &&
            now - activeFallbackState.failedAtMs < FALLBACK_RETRY_BACKOFF_MS &&
            rechecked.launchIdentity !== null &&
            rechecked.launchIdentity === activeFallbackState.targetLaunchIdentity
          ) {
            // Unrelated agents or non-launch metadata changed while the failed target itself is
            // unchanged; stay in backoff without re-probing while keeping displayed metadata fresh.
            yield* liveSnapshotSemaphore.withPermit(
              Effect.gen(function* () {
                const liveFallback = yield* Ref.get(activeFallback);
                if (
                  liveFallback === null ||
                  liveFallback.targetLaunchIdentity !== activeFallbackState.targetLaunchIdentity
                ) {
                  return;
                }
                yield* Ref.set(activeFallback, {
                  ...liveFallback,
                  targetIndexRevision: rechecked.indexRevision ?? revision,
                });
                const currentSnapshot = yield* getSnapshot;
                if (!currentSnapshot.installed) return;
                const withMetadata = applyRegistryReadinessMetadata(
                  currentSnapshot,
                  rechecked.snapshot,
                );
                if (!Equal.equals(withMetadata, currentSnapshot)) {
                  yield* tryPublishSnapshot(withMetadata);
                }
              }),
            );
            return;
          }
          if (
            !Equal.equals(
              installedRegistrySignature(rechecked),
              installedRegistrySignature(publishedReadiness),
            )
          ) {
            const recheckedProbe = yield* runProbeAndPublish(rechecked);
            if (
              recheckedProbe.published &&
              recheckedProbe.readiness !== null &&
              !recheckedProbe.readiness.fallback &&
              !recheckedProbe.readiness.probeFailed &&
              (recheckedProbe.readiness.indexRevision === null ||
                recheckedProbe.readiness.indexRevision >= revision)
            ) {
              yield* acknowledgeRevision(recheckedProbe.readiness.indexRevision ?? revision);
            }
            return;
          }
          if (
            initialProbe.published &&
            !publishedReadiness.fallback &&
            !publishedReadiness.probeFailed &&
            (rechecked.indexRevision === null || rechecked.indexRevision >= revision)
          ) {
            yield* acknowledgeRevision(rechecked.indexRevision ?? revision);
          }
        }).pipe(Effect.withSpan("AcpRegistryDriver.publishEnrichment"));
        yield* runWithLiveWatchers(publishEnrichment);
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
    yield* Deferred.succeed(refreshTarget, snapshot.refresh.pipe(Effect.asVoid));

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
        liveSnapshotSemaphore
          .withPermit(
            setConfirmedAuth(authenticated).pipe(
              Effect.andThen(authenticated ? Ref.set(latestAcceptedAuth, null) : clearLiveState()),
              Effect.andThen(invalidateEnrichmentCache),
            ),
          )
          .pipe(Effect.andThen(snapshot.refresh), Effect.asVoid),
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(SecureRandom.SecureRandom, random),
    );
    const auth = {
      ...controller,
      invalidate: (controller.invalidate ?? Effect.void).pipe(
        Effect.andThen(
          liveSnapshotSemaphore.withPermit(
            setConfirmedAuth(false).pipe(
              Effect.andThen(clearLiveState()),
              Effect.andThen(invalidateEnrichmentCache),
            ),
          ),
        ),
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
      invalidateCaches: (Option.isSome(runtimeCoordinator)
        ? runtimeCoordinator.value.clearLiveConfiguration(instanceId)
        : Effect.void
      ).pipe(
        Effect.andThen(clearLearnedModels),
        Effect.andThen(liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
        Effect.andThen(tracksRegistryIndex ? catalog.invalidateIndex() : Effect.void),
      ),
      orchestrationAdapter,
      textGeneration: makeUnsupportedTextGeneration(),
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
          ).pipe(Effect.tap(() => liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache))),
        disableProvider: ({ cwd, providerId }) =>
          provideAcpManagementServices(
            disableAcpRegistryProvider({
              instanceId,
              settings: effectiveConfig,
              cwd,
              environment: processEnvironment,
              providerId,
            }),
          ).pipe(Effect.tap(() => liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache))),
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
            Effect.tap(() =>
              liveSnapshotSemaphore.withPermit(
                setConfirmedAuth(false).pipe(
                  Effect.andThen(Ref.set(latestAcceptedAuth, null)),
                  Effect.andThen(invalidateEnrichmentCache),
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
