import {
  officialAcpRegistryIconUrlForAgentId,
  ProviderDriverKind,
  resolveOfficialAcpRegistryIconUrl,
  TextGenerationError,
  type AcpRegistryOperationError,
  type AcpRegistryProbeModel,
  type CustomModelSetting,
  type ProviderOptionDescriptor,
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

function acpRegistryProbeTtlMs(provider: ServerProvider): number {
  const discoveredModels = provider.models.filter((model) => !model.isCustom);
  return discoveredModels.length <= 1 ? PROBE_PROVISIONAL_TTL_MS : PROBE_SUCCESS_TTL_MS;
}

interface AcpRegistryEnrichmentCache {
  readonly generation: number;
  readonly entry: {
    readonly provider: ServerProvider;
    readonly expiresAt: number;
  } | null;
}

interface AcceptedAcpRegistryCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly builtInModelCount: number;
  readonly modelsFromModelSelect: boolean;
  readonly reasoningDisabledModelSlugs: ReadonlySet<string>;
}

const EMPTY_SLUG_SET: ReadonlySet<string> = new Set();

const EMPTY_ACCEPTED_CATALOG: AcceptedAcpRegistryCatalog = {
  models: [],
  builtInModelCount: 0,
  modelsFromModelSelect: false,
  reasoningDisabledModelSlugs: EMPTY_SLUG_SET,
};

function isExplicitSingletonCatalog(catalog: {
  readonly builtInModelCount: number;
  readonly modelsFromModelSelect: boolean;
}): boolean {
  return catalog.builtInModelCount === 1 && catalog.modelsFromModelSelect;
}

function liveConfigurationReplacesAcceptedCatalog(
  configuration: AcpRegistryLiveConfiguration,
  accepted: AcceptedAcpRegistryCatalog,
): boolean {
  return (
    configuration.models.length > 1 ||
    (configuration.models.length === 1 &&
      (configuration.modelsFromModelSelect === true ||
        (accepted.builtInModelCount <= 1 && !accepted.modelsFromModelSelect)))
  );
}

export function acpRegistryProbeSupersedesLiveCatalog(input: {
  readonly probedModelCount: number;
  readonly probedModelsFromModelSelect: boolean;
  readonly liveModelCount: number;
  readonly liveModelsFromModelSelect: boolean;
}): boolean {
  if (input.liveModelCount === 0) return true;
  if (input.probedModelCount > 1) return true;
  if (input.probedModelCount === 1) {
    if (input.probedModelsFromModelSelect) return true;
    return input.liveModelCount === 1 && !input.liveModelsFromModelSelect;
  }
  // Empty disposable probes (e.g. cold-start or pre-catalog agents) keep the
  // accepted catalog and retry on the 30s provisional TTL instead of clearing it.
  return false;
}

export function isAcpRegistryCacheValid(
  entry: NonNullable<AcpRegistryEnrichmentCache["entry"]>,
  inspectedVersion: string | null,
  local: boolean,
  now: number,
): boolean {
  return (
    entry.expiresAt > now &&
    ((local && inspectedVersion === null) || entry.provider.version === inspectedVersion)
  );
}

export function updateAcpRegistryEnrichmentCache(input: {
  readonly cache: AcpRegistryEnrichmentCache;
  readonly configuration: AcpRegistryLiveConfiguration;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
  readonly now: number;
  readonly preserveSingleModelCatalog?: boolean | undefined;
  readonly reasoningDisabledModelSlugs?: ReadonlySet<string> | undefined;
}): AcpRegistryEnrichmentCache {
  const {
    cache,
    configuration,
    customModels,
    now,
    preserveSingleModelCatalog,
    reasoningDisabledModelSlugs,
  } = input;
  if (cache.entry === null) {
    // Only advance the cache epoch when the live session discovered a catalog
    // so an options-only update cannot discard an in-flight initial probe.
    return configuration.models.length > 0 ? { ...cache, generation: cache.generation + 1 } : cache;
  }
  const provider = applyAcpRegistryLiveConfiguration(
    cache.entry.provider,
    configuration,
    customModels,
    undefined,
    { preserveSingleModelCatalog, reasoningDisabledModelSlugs },
  );
  if (Equal.equals(provider, cache.entry.provider)) return cache;
  const previousBuiltIn = cache.entry.provider.models.filter((model) => !model.isCustom);
  const nextBuiltIn = provider.models.filter((model) => !model.isCustom);
  const catalogChanged =
    configuration.models.length > 0 &&
    (previousBuiltIn.length !== nextBuiltIn.length ||
      nextBuiltIn.some((model, index) => model.slug !== previousBuiltIn[index]?.slug));
  return {
    ...cache,
    // Only bump the epoch and extend TTL when the live session changed the
    // catalog; mid-session option tweaks must neither cancel an in-flight
    // post-TTL probe nor starve the periodic refresh deadline.
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

function isModelSpecificDescriptor(
  descriptor: ProviderOptionDescriptor,
  modelOptionIds: ReadonlySet<string>,
): boolean {
  return (
    modelOptionIds.has(descriptor.id) ||
    (descriptor.type === "select" && descriptor.role === "reasoning")
  );
}

function modelWithSpecificOptions(
  model: ServerProviderModel,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ServerProviderModel {
  return {
    ...model,
    capabilities:
      descriptors.length === 0
        ? EMPTY_CAPABILITIES
        : createModelCapabilities({ optionDescriptors: descriptors }),
  };
}

function updateLearnedModelsFromLive(
  learned: ReadonlyArray<ServerProviderModel>,
  nextModels: ReadonlyArray<ServerProviderModel>,
  configuration: AcpRegistryLiveConfiguration,
  disabledReasoningSlugs: ReadonlySet<string> = EMPTY_SLUG_SET,
): ReadonlyArray<ServerProviderModel> {
  const modelOptionIds = new Set(configuration.modelOptionIds ?? []);
  const learnedBySlug = new Map(
    learned.filter((model) => !model.isCustom).map((model) => [model.slug, model] as const),
  );
  const configuredById = new Map(configuration.models.map((model) => [model.id, model] as const));
  let changed = false;
  for (const model of nextModels) {
    if (model.isCustom) continue;
    const isCurrentModel =
      configuration.currentModelId !== null && model.slug === configuration.currentModelId;
    const hasAdvertisedReasoning = configuredById.get(model.slug)?.reasoningEffort !== undefined;
    const isReasoningDisabled = disabledReasoningSlugs.has(model.slug);
    if (!isCurrentModel && !hasAdvertisedReasoning && !isReasoningDisabled) continue;
    const specific = (model.capabilities?.optionDescriptors ?? []).filter((descriptor) =>
      isModelSpecificDescriptor(descriptor, modelOptionIds),
    );
    const previous = learnedBySlug.get(model.slug);
    if (specific.length === 0) {
      if (previous !== undefined) {
        learnedBySlug.delete(model.slug);
        changed = true;
      }
      continue;
    }
    const updated = modelWithSpecificOptions(model, specific);
    if (previous === undefined || !Equal.equals(previous.capabilities, updated.capabilities)) {
      learnedBySlug.set(model.slug, updated);
      changed = true;
    }
  }
  return changed ? Array.from(learnedBySlug.values()) : learned;
}

function overlayLiveOptionValue(
  probed: ProviderOptionDescriptor,
  live: ProviderOptionDescriptor | undefined,
): ProviderOptionDescriptor {
  if (live === undefined || live.type !== probed.type || live.currentValue === undefined) {
    return probed;
  }
  if (probed.type === "boolean") {
    return { ...probed, currentValue: live.currentValue as boolean };
  }
  return probed.options.some((option) => option.id === live.currentValue)
    ? { ...probed, currentValue: live.currentValue as string }
    : probed;
}

/**
 * Keeps live session option values that still apply after a superseding probe replaces
 * the catalog, while dropping removed shared options and dropped/disabled model options.
 */
export function retainAcpRegistryLiveOptionsAfterProbe(
  live: AcpRegistryLiveConfiguration,
  probe: {
    readonly models: ReadonlyArray<AcpRegistryProbeModel>;
    readonly currentModelId: string | null;
    readonly configOptions: ReadonlyArray<ProviderOptionDescriptor>;
    readonly modelOptionIds: ReadonlySet<string>;
  },
): Option.Option<AcpRegistryLiveConfiguration> {
  if (live.configOptions.length === 0) return Option.none();
  const liveById = new Map(live.configOptions.map((descriptor) => [descriptor.id, descriptor]));
  const liveModelOptionIds = new Set(live.modelOptionIds ?? []);
  const probedModelById = new Map(probe.models.map((model) => [model.id, model]));
  const nextCurrentModelId =
    live.currentModelId !== null && probedModelById.has(live.currentModelId)
      ? live.currentModelId
      : null;
  const currentProbedModel =
    nextCurrentModelId === null ? undefined : probedModelById.get(nextCurrentModelId);

  let preservedAnyLiveOption = false;
  const sharedDescriptors: Array<ProviderOptionDescriptor> = [];
  for (const descriptor of probe.configOptions) {
    if (isModelSpecificDescriptor(descriptor, probe.modelOptionIds)) continue;
    const liveMatch = liveById.get(descriptor.id);
    if (liveMatch !== undefined) preservedAnyLiveOption = true;
    sharedDescriptors.push(overlayLiveOptionValue(descriptor, liveMatch));
  }
  const sharedIds = new Set(sharedDescriptors.map((descriptor) => descriptor.id));

  const modelDescriptors: Array<ProviderOptionDescriptor> = [];
  if (nextCurrentModelId !== null) {
    const reasoningDisabled = currentProbedModel?.reasoningEffort === null;
    if (nextCurrentModelId === probe.currentModelId) {
      for (const descriptor of probe.configOptions) {
        if (sharedIds.has(descriptor.id)) continue;
        if (reasoningDisabled && descriptor.type === "select" && descriptor.role === "reasoning") {
          continue;
        }
        const liveMatch = liveById.get(descriptor.id);
        if (liveMatch !== undefined) preservedAnyLiveOption = true;
        modelDescriptors.push(overlayLiveOptionValue(descriptor, liveMatch));
      }
    } else {
      const advertisedReasoning = currentProbedModel?.reasoningEffort;
      let addedAdvertisedReasoning = false;
      for (const descriptor of live.configOptions) {
        if (sharedIds.has(descriptor.id)) continue;
        if (!isModelSpecificDescriptor(descriptor, liveModelOptionIds)) continue;
        if (descriptor.type === "select" && descriptor.role === "reasoning") {
          if (reasoningDisabled) continue;
          if (advertisedReasoning != null) {
            if (!addedAdvertisedReasoning) {
              modelDescriptors.push(overlayLiveOptionValue(advertisedReasoning, descriptor));
              addedAdvertisedReasoning = true;
              preservedAnyLiveOption = true;
            }
            continue;
          }
        }
        modelDescriptors.push(descriptor);
        preservedAnyLiveOption = true;
      }
      if (advertisedReasoning != null && !addedAdvertisedReasoning) {
        modelDescriptors.push(advertisedReasoning);
      }
    }
  }

  const configOptions = [...sharedDescriptors, ...modelDescriptors];
  if (!preservedAnyLiveOption || configOptions.length === 0) return Option.none();
  return Option.some({
    models: [],
    currentModelId: nextCurrentModelId,
    configOptions,
    modelOptionIds: modelDescriptors.map((descriptor) => descriptor.id),
    modelsFromModelSelect: false,
  });
}

function mergeLearnedModelOptions(
  models: ReadonlyArray<ServerProviderModel>,
  learned: ReadonlyArray<ServerProviderModel>,
  options?: {
    readonly currentModelId?: string | null;
    readonly reasoningDisabledModelSlugs?: ReadonlySet<string>;
  },
): ReadonlyArray<ServerProviderModel> {
  if (learned.length === 0) return models;
  const currentModelId = options?.currentModelId ?? null;
  const reasoningDisabledModelSlugs = options?.reasoningDisabledModelSlugs ?? EMPTY_SLUG_SET;
  const learnedBySlug = new Map(
    learned.filter((model) => !model.isCustom).map((model) => [model.slug, model] as const),
  );
  let changed = false;
  const merged = models.map((model) => {
    // The probe already observed its currentModelId in full; do not restore dropped options onto it.
    if (model.isCustom || (currentModelId !== null && model.slug === currentModelId)) return model;
    const previousDescriptors =
      learnedBySlug.get(model.slug)?.capabilities?.optionDescriptors ?? [];
    if (previousDescriptors.length === 0) return model;
    const currentDescriptors = model.capabilities?.optionDescriptors ?? [];
    const currentIds = new Set(currentDescriptors.map((descriptor) => descriptor.id));
    const hasExplicitReasoningState =
      reasoningDisabledModelSlugs.has(model.slug) ||
      currentDescriptors.some(
        (descriptor) => descriptor.type === "select" && descriptor.role === "reasoning",
      );
    const extra = previousDescriptors.filter(
      (descriptor) =>
        !currentIds.has(descriptor.id) &&
        (!hasExplicitReasoningState ||
          descriptor.type !== "select" ||
          descriptor.role !== "reasoning"),
    );
    if (extra.length === 0) return model;
    changed = true;
    return {
      ...model,
      capabilities: createModelCapabilities({
        optionDescriptors: [...currentDescriptors, ...extra],
      }),
    };
  });
  return changed ? merged : models;
}

function updateLearnedModelsFromProbe(
  learned: ReadonlyArray<ServerProviderModel>,
  probedModels: ReadonlyArray<ServerProviderModel>,
  options: {
    readonly currentModelId: string | null;
    readonly modelOptionIds: ReadonlySet<string>;
    readonly reasoningDisabledModelSlugs: ReadonlySet<string>;
  },
): ReadonlyArray<ServerProviderModel> {
  const learnedBySlug = new Map(
    learned.filter((model) => !model.isCustom).map((model) => [model.slug, model] as const),
  );
  const next: Array<ServerProviderModel> = [];
  for (const model of probedModels) {
    if (model.isCustom) continue;
    if (options.currentModelId !== null && model.slug === options.currentModelId) {
      const specific = (model.capabilities?.optionDescriptors ?? []).filter((descriptor) =>
        isModelSpecificDescriptor(descriptor, options.modelOptionIds),
      );
      if (specific.length > 0) next.push(modelWithSpecificOptions(model, specific));
      continue;
    }
    const previousDescriptors =
      learnedBySlug.get(model.slug)?.capabilities?.optionDescriptors ?? [];
    const probedReasoning = (model.capabilities?.optionDescriptors ?? []).filter(
      (descriptor) => descriptor.type === "select" && descriptor.role === "reasoning",
    );
    const hasExplicitReasoningState =
      options.reasoningDisabledModelSlugs.has(model.slug) || probedReasoning.length > 0;
    const kept = previousDescriptors.filter(
      (descriptor) =>
        !hasExplicitReasoningState ||
        descriptor.type !== "select" ||
        descriptor.role !== "reasoning",
    );
    const combined = [...probedReasoning, ...kept];
    if (combined.length > 0) next.push(modelWithSpecificOptions(model, combined));
  }
  return next;
}

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
    if (slug === discovery?.currentModelId) {
      if (reasoningEffort !== null) return capabilities;
      const filtered = (discovery?.configOptions ?? []).filter(
        (descriptor) => descriptor.type !== "select" || descriptor.role !== "reasoning",
      );
      return filtered.length === 0
        ? EMPTY_CAPABILITIES
        : createModelCapabilities({ optionDescriptors: filtered });
    }
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

function stripReasoningForDisabledModels(
  models: ReadonlyArray<ServerProviderModel>,
  disabledReasoningSlugs: ReadonlySet<string>,
): ReadonlyArray<ServerProviderModel> {
  if (disabledReasoningSlugs.size === 0) return models;
  let changed = false;
  const next = models.map((model) => {
    if (model.isCustom || !disabledReasoningSlugs.has(model.slug)) return model;
    const descriptors = model.capabilities?.optionDescriptors ?? [];
    const filtered = descriptors.filter(
      (descriptor) => descriptor.type !== "select" || descriptor.role !== "reasoning",
    );
    if (filtered.length === descriptors.length) return model;
    changed = true;
    return {
      ...model,
      capabilities:
        filtered.length === 0
          ? EMPTY_CAPABILITIES
          : createModelCapabilities({ optionDescriptors: filtered }),
    };
  });
  return changed ? next : models;
}

export function applyAcpRegistryLiveConfiguration(
  provider: ServerProvider,
  configuration: AcpRegistryLiveConfiguration,
  customModels: ReadonlyArray<CustomModelSetting>,
  previousModels: ReadonlyArray<ServerProviderModel> = provider.models,
  options?: {
    readonly preserveSingleModelCatalog?: boolean | undefined;
    readonly reasoningDisabledModelSlugs?: ReadonlySet<string> | undefined;
  },
): ServerProvider {
  const { message: _staleProbeMessage, ...snapshot } = provider;
  // session/load may omit models (Kimi returns `{}`); keep the probed list
  // and apply any live option descriptors to it.
  const probedModels = provider.models.filter((model) => !model.isCustom);
  // A cold-start session can report one placeholder model before its catalog
  // settles, whereas an explicit single-model select is deliberate and wins.
  const liveCatalogIsProvisional =
    configuration.models.length === 1 &&
    !configuration.modelsFromModelSelect &&
    (probedModels.length > 1 ||
      (options?.preserveSingleModelCatalog === true && probedModels.length === 1));
  const useLiveCatalog =
    configuration.models.length > 1 ||
    (configuration.models.length === 1 && !liveCatalogIsProvisional);
  const disabledReasoningSlugs: ReadonlySet<string> = useLiveCatalog
    ? EMPTY_SLUG_SET
    : (configuration.reasoningDisabledModelIds?.length ?? 0) === 0
      ? (options?.reasoningDisabledModelSlugs ?? EMPTY_SLUG_SET)
      : new Set([
          ...(options?.reasoningDisabledModelSlugs ?? []),
          ...(configuration.reasoningDisabledModelIds ?? []),
        ]);
  const liveCurrentModelInProbed =
    configuration.currentModelId !== null &&
    probedModels.some((model) => model.slug === configuration.currentModelId);
  const selectedProbedModelId = liveCurrentModelInProbed
    ? configuration.currentModelId
    : (probedModels.find((model) => model.isDefault)?.slug ?? null);
  // When retaining the probed catalog for a live session running an absent
  // model (e.g. a cold-start placeholder), keep only shared options and leave
  // each retained model's own learned options untouched.
  const dropUnmatchedModelOptions =
    !useLiveCatalog && configuration.currentModelId !== null && !liveCurrentModelInProbed;
  const unmatchedModelOptionIds = dropUnmatchedModelOptions
    ? new Set(configuration.modelOptionIds ?? [])
    : EMPTY_SLUG_SET;
  const effectiveConfigOptions =
    unmatchedModelOptionIds.size === 0
      ? configuration.configOptions
      : configuration.configOptions.filter(
          (descriptor) => !unmatchedModelOptionIds.has(descriptor.id),
        );
  const discovery = useLiveCatalog
    ? configuration
    : {
        ...configuration,
        models: probedModels.map((model) => ({
          id: model.slug,
          name: model.name,
          description: null,
          ...(disabledReasoningSlugs.has(model.slug) ? { reasoningEffort: null } : {}),
        })),
        currentModelId: dropUnmatchedModelOptions
          ? configuration.currentModelId
          : selectedProbedModelId,
        configOptions: effectiveConfigOptions,
      };
  const nextModels =
    !useLiveCatalog && effectiveConfigOptions.length === 0
      ? stripReasoningForDisabledModels(
          withAcpRegistryDefaultModel(provider.models, selectedProbedModelId),
          disabledReasoningSlugs,
        )
      : modelsFromDiscovery(
          discovery,
          customModels,
          previousModels.filter((model) => !model.isCustom),
        );
  return {
    ...snapshot,
    status: provider.enabled ? "ready" : provider.status,
    models:
      dropUnmatchedModelOptions && effectiveConfigOptions.length > 0
        ? withAcpRegistryDefaultModel(nextModels, selectedProbedModelId)
        : nextModels,
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

interface DetailedAcpRegistryProviderStatus {
  readonly provider: ServerProvider;
  readonly probedModels: ReadonlyArray<AcpRegistryProbeModel>;
  readonly probedConfigOptions: ReadonlyArray<ProviderOptionDescriptor>;
  readonly probedModelCount: number;
  readonly probedModelsFromModelSelect: boolean;
  readonly probedCurrentModelId: string | null;
  readonly probedModelOptionIds: ReadonlySet<string>;
  readonly reasoningDisabledModelSlugs: ReadonlySet<string>;
}

const checkAcpRegistryProviderStatusDetailed = Effect.fn(
  "AcpRegistryDriver.checkProviderStatusDetailed",
)(function* <Requirements>(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  },
  probeConfiguration: AcpRegistryConfigurationProbe<Requirements>,
): Effect.fn.Return<
  DetailedAcpRegistryProviderStatus,
  never,
  AcpRegistrySupport.AcpRegistryCatalog | Requirements
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const withoutProbe = (provider: ServerProvider): DetailedAcpRegistryProviderStatus => ({
    provider,
    probedModels: [],
    probedConfigOptions: [],
    probedModelCount: 0,
    probedModelsFromModelSelect: false,
    probedCurrentModelId: null,
    probedModelOptionIds: EMPTY_SLUG_SET,
    reasoningDisabledModelSlugs: EMPTY_SLUG_SET,
  });
  if (!input.settings.enabled) {
    return withoutProbe(yield* buildInitialAcpRegistrySnapshot(input));
  }
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
  if (Result.isFailure(inspected)) {
    return withoutProbe(
      buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: {
          status: "failed",
          message: `Could not inspect ACP Registry agent: ${inspected.failure.message}`,
        },
      }),
    );
  }
  if (inspected.success.status !== "ready") {
    return withoutProbe(
      buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: inspected.success,
      }),
    );
  }
  const probed = yield* Effect.result(
    probeConfiguration({
      instanceId: input.instanceId,
      settings: input.settings,
      cwd: input.cwd,
      environment: providerProbeEnvironment(input.environment),
    }),
  );
  return Result.isFailure(probed)
    ? withoutProbe(
        buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probeError: probed.failure,
        }),
      )
    : {
        provider: buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probe: probed.success,
        }),
        probedModels: probed.success.probe.models,
        probedConfigOptions: probed.success.probe.configOptions,
        probedModelCount: probed.success.probe.models.length,
        probedModelsFromModelSelect: probed.success.modelsFromModelSelect === true,
        probedCurrentModelId: probed.success.probe.currentModelId,
        probedModelOptionIds: new Set(probed.success.probe.modelOptionIds ?? []),
        reasoningDisabledModelSlugs: new Set(
          probed.success.probe.models
            .filter((model) => model.reasoningEffort === null)
            .map((model) => model.id),
        ),
      };
});

export const checkAcpRegistryProviderStatus = Effect.fn("AcpRegistryDriver.checkProviderStatus")(
  function* <Requirements>(
    input: SnapshotIdentity & {
      readonly settings: AcpRegistrySettings;
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    },
    probeConfiguration: AcpRegistryConfigurationProbe<Requirements>,
  ): Effect.fn.Return<ServerProvider, never, AcpRegistrySupport.AcpRegistryCatalog | Requirements> {
    return (yield* checkAcpRegistryProviderStatusDetailed(input, probeConfiguration)).provider;
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
    // learned from earlier sessions are kept here.
    const learnedModels = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);
    const clearLearnedModels = Ref.set(learnedModels, []);
    // Readiness checks do not read enrichmentCache, and post-TTL probes may see no live entry
    // once an earlier probe cleared it; keep the last accepted catalog separately so skipped
    // enrichment or provisional probes do not regress the snapshot.
    const acceptedCatalog = yield* Ref.make<AcceptedAcpRegistryCatalog>(EMPTY_ACCEPTED_CATALOG);
    const clearAcceptedCatalog = Ref.set(acceptedCatalog, EMPTY_ACCEPTED_CATALOG);
    const applyLiveConfiguration = (
      provider: ServerProvider,
      configuration: AcpRegistryLiveConfiguration,
      options?: {
        readonly preserveSingleModelCatalog?: boolean | undefined;
        readonly reasoningDisabledModelSlugs?: ReadonlySet<string> | undefined;
      },
    ) =>
      Ref.get(acceptedCatalog).pipe(
        Effect.flatMap((accepted) => {
          const preserveSingleModelCatalog =
            options?.preserveSingleModelCatalog ?? isExplicitSingletonCatalog(accepted);
          const reasoningDisabledModelSlugs =
            options?.reasoningDisabledModelSlugs ?? accepted.reasoningDisabledModelSlugs;
          const disabledForLearning =
            configuration.models.length > 0
              ? EMPTY_SLUG_SET
              : (configuration.reasoningDisabledModelIds?.length ?? 0) === 0
                ? reasoningDisabledModelSlugs
                : new Set([
                    ...reasoningDisabledModelSlugs,
                    ...(configuration.reasoningDisabledModelIds ?? []),
                  ]);
          return Ref.modify(learnedModels, (learned) => {
            const next = applyAcpRegistryLiveConfiguration(
              provider,
              configuration,
              effectiveConfig.customModels,
              learned.length > 0 ? learned : provider.models,
              { preserveSingleModelCatalog, reasoningDisabledModelSlugs },
            );
            return [
              next,
              updateLearnedModelsFromLive(learned, next.models, configuration, disabledForLearning),
            ];
          });
        }),
      );
    const lastObservedLiveRevision = yield* Ref.make(0);
    const liveSnapshotSemaphore = yield* Semaphore.make(1);
    const withLiveRuntimeState = Effect.fn("AcpRegistryDriver.withLiveRuntimeState")(function* (
      input: ServerProvider,
      options?: {
        readonly applyLiveModels?: boolean;
        readonly recordLiveRevision?: boolean;
        readonly fallbackToAcceptedModels?: boolean;
        readonly preserveSingleModelCatalog?: boolean | undefined;
        readonly reasoningDisabledModelSlugs?: ReadonlySet<string> | undefined;
        readonly preserveStatus?: boolean;
      },
    ) {
      if (input.auth.status === "unauthenticated") yield* confirmedAuthentication.set(false);
      const provider =
        input.enabled &&
        input.installed &&
        input.auth.status === "unknown" &&
        (yield* confirmedAuthentication.get)
          ? { ...input, auth: { ...input.auth, status: "authenticated" as const } }
          : input;
      const applyAcceptedModelsFallback = (target: ServerProvider) =>
        options?.fallbackToAcceptedModels === true && target.enabled && target.installed
          ? Ref.get(acceptedCatalog).pipe(
              Effect.map((accepted) =>
                accepted.models.length > 0 ? { ...target, models: accepted.models } : target,
              ),
            )
          : Effect.succeed(target);
      return yield* Option.isNone(runtimeCoordinator)
        ? applyAcceptedModelsFallback(provider)
        : Effect.all({
            commands: runtimeCoordinator.value.getAvailableCommands(instanceId),
            liveConfiguration:
              runtimeCoordinator.value.getLiveConfigurationWithRevision(instanceId),
            authAction: runtimeCoordinator.value.getUrlAuthAction(instanceId),
          }).pipe(
            Effect.tap(({ liveConfiguration }) =>
              options?.recordLiveRevision === true
                ? Ref.set(lastObservedLiveRevision, liveConfiguration.revision)
                : Effect.void,
            ),
            Effect.flatMap(({ commands, liveConfiguration, authAction }) =>
              applyAcceptedModelsFallback(
                applyAcpRegistryAvailableCommands(provider, commands),
              ).pipe(
                Effect.flatMap((withBaseModels) =>
                  Option.match(
                    options?.applyLiveModels === false ||
                      !withBaseModels.enabled ||
                      !withBaseModels.installed
                      ? Option.none()
                      : liveConfiguration.configuration,
                    {
                      onNone: () => Effect.succeed(withBaseModels),
                      onSome: (configuration) =>
                        applyLiveConfiguration(withBaseModels, configuration, {
                          preserveSingleModelCatalog: options?.preserveSingleModelCatalog,
                          reasoningDisabledModelSlugs: options?.reasoningDisabledModelSlugs,
                        }).pipe(
                          Effect.map((applied) =>
                            options?.preserveStatus === true
                              ? {
                                  ...applied,
                                  status: withBaseModels.status,
                                  ...(withBaseModels.message === undefined
                                    ? {}
                                    : { message: withBaseModels.message }),
                                }
                              : applied,
                          ),
                        ),
                    },
                  ),
                ),
                Effect.map((withConfiguration) =>
                  applyAcpRegistryUrlAuthAction(withConfiguration, authAction),
                ),
              ),
            ),
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
      Effect.flatMap((provider) =>
        liveSnapshotSemaphore.withPermit(
          withLiveRuntimeState(provider, {
            recordLiveRevision: true,
            fallbackToAcceptedModels: true,
          }),
        ),
      ),
    );
    const enrichProvider = checkAcpRegistryProviderStatusDetailed(
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
    const enrichmentCache = yield* Ref.make<AcpRegistryEnrichmentCache>({
      generation: 0,
      entry: null,
    });
    const invalidateEnrichmentCache = Ref.update(enrichmentCache, (current) => ({
      generation: current.generation + 1,
      entry: null,
    }));
    const enrichProviderCached = Effect.fn("AcpRegistryDriver.enrichProviderCached")(function* (
      baseSnapshot: ServerProvider,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const cacheState = yield* Ref.get(enrichmentCache);
      const cached = cacheState.entry;
      if (
        cached !== null &&
        isAcpRegistryCacheValid(
          cached,
          baseSnapshot.version,
          effectiveConfig.source === "local",
          now,
        )
      ) {
        return {
          provider: { ...cached.provider, checkedAt: baseSnapshot.checkedAt },
          generation: cacheState.generation,
          fresh: false,
          probeStartLiveRevision: 0,
          probeStartCatalogRevision: 0,
          probedModels: [],
          probedConfigOptions: [],
          probedModelCount: 0,
          probedModelsFromModelSelect: false,
          probedCurrentModelId: null,
          probedModelOptionIds: EMPTY_SLUG_SET,
          reasoningDisabledModelSlugs: EMPTY_SLUG_SET,
        };
      }
      const probeStartLive = Option.isSome(runtimeCoordinator)
        ? yield* runtimeCoordinator.value.getLiveConfigurationWithRevision(instanceId)
        : AcpRegistryRuntimeCoordinator.EMPTY_LIVE_CONFIGURATION_SNAPSHOT;
      const enriched = yield* enrichProvider;
      if (effectiveConfig.source === "local" && enriched.provider.status === "ready") {
        yield* Ref.set(reportedLocalVersion, enriched.provider.version);
      }
      return {
        provider: enriched.provider,
        generation: cacheState.generation,
        fresh: true,
        probeStartLiveRevision: probeStartLive.revision,
        probeStartCatalogRevision: probeStartLive.catalogRevision,
        probedModels: enriched.probedModels,
        probedConfigOptions: enriched.probedConfigOptions,
        probedModelCount: enriched.probedModelCount,
        probedModelsFromModelSelect: enriched.probedModelsFromModelSelect,
        probedCurrentModelId: enriched.probedCurrentModelId,
        probedModelOptionIds: enriched.probedModelOptionIds,
        reasoningDisabledModelSlugs: enriched.reasoningDisabledModelSlugs,
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
      enrichSnapshot: Effect.fn("enrichSnapshot")(function ({
        snapshot,
        getSnapshot,
        publishSnapshot,
      }) {
        if (!snapshot.installed) return Effect.void;
        const commitEnrichment = ({
          provider,
          generation,
          fresh,
          probeStartLiveRevision,
          probeStartCatalogRevision,
          probedModels,
          probedConfigOptions,
          probedModelCount,
          probedModelsFromModelSelect,
          probedCurrentModelId,
          probedModelOptionIds,
          reasoningDisabledModelSlugs,
        }: Effect.Success<ReturnType<typeof enrichProviderCached>>) =>
          Effect.uninterruptible(
            liveSnapshotSemaphore.withPermit(
              Effect.gen(function* () {
                const current = yield* Ref.get(enrichmentCache);
                const liveSnapshot = Option.isSome(runtimeCoordinator)
                  ? yield* runtimeCoordinator.value.getLiveConfigurationWithRevision(instanceId)
                  : AcpRegistryRuntimeCoordinator.EMPTY_LIVE_CONFIGURATION_SNAPSHOT;
                if (
                  current.generation !== generation ||
                  (fresh && liveSnapshot.catalogRevision !== probeStartCatalogRevision)
                ) {
                  return;
                }
                let resolved = provider;
                if (fresh && provider.status === "ready") {
                  const accepted = yield* Ref.get(acceptedCatalog);
                  const liveCatalog = Option.filter(liveSnapshot.configuration, (configuration) =>
                    liveConfigurationReplacesAcceptedCatalog(configuration, accepted),
                  );
                  const incumbent = Option.match(liveCatalog, {
                    onSome: (configuration) => ({
                      modelCount: configuration.models.length,
                      modelsFromModelSelect: configuration.modelsFromModelSelect === true,
                    }),
                    onNone: () => ({
                      modelCount: accepted.builtInModelCount,
                      modelsFromModelSelect: accepted.modelsFromModelSelect,
                    }),
                  });
                  const probeSupersedesLiveCatalog = acpRegistryProbeSupersedesLiveCatalog({
                    probedModelCount,
                    probedModelsFromModelSelect,
                    liveModelCount: incumbent.modelCount,
                    liveModelsFromModelSelect: incumbent.modelsFromModelSelect,
                  });
                  // A fresh non-provisional probe supersedes any live session catalog observed before it started.
                  const cleared = probeSupersedesLiveCatalog
                    ? Option.isSome(runtimeCoordinator)
                      ? yield* runtimeCoordinator.value.clearLiveConfigurationIfRevision(
                          instanceId,
                          probeStartLiveRevision,
                          {
                            catalogRevision: probeStartCatalogRevision,
                            retainPreProbeConfiguration: (live) =>
                              retainAcpRegistryLiveOptionsAfterProbe(live, {
                                models: probedModels,
                                currentModelId: probedCurrentModelId,
                                configOptions: probedConfigOptions,
                                modelOptionIds: probedModelOptionIds,
                              }),
                          },
                        )
                      : true
                    : false;
                  if (
                    !probeSupersedesLiveCatalog &&
                    Option.isNone(liveCatalog) &&
                    accepted.models.length > 0
                  ) {
                    resolved = { ...provider, models: accepted.models };
                  } else {
                    const models = yield* Ref.modify(learnedModels, (learned) => {
                      const merged = mergeLearnedModelOptions(provider.models, learned, {
                        currentModelId: probedCurrentModelId,
                        reasoningDisabledModelSlugs,
                      });
                      const nextLearned = cleared
                        ? updateLearnedModelsFromProbe(learned, provider.models, {
                            currentModelId: probedCurrentModelId,
                            modelOptionIds: probedModelOptionIds,
                            reasoningDisabledModelSlugs,
                          })
                        : learned;
                      return [merged, nextLearned] as const;
                    });
                    resolved = models === provider.models ? provider : { ...provider, models };
                  }
                  const published = yield* withLiveRuntimeState(resolved, {
                    preserveSingleModelCatalog:
                      probeSupersedesLiveCatalog &&
                      isExplicitSingletonCatalog({
                        builtInModelCount: probedModelCount,
                        modelsFromModelSelect: probedModelsFromModelSelect,
                      })
                        ? true
                        : undefined,
                    reasoningDisabledModelSlugs: cleared ? reasoningDisabledModelSlugs : undefined,
                  });
                  if (cleared || !probeSupersedesLiveCatalog) {
                    const completedAt = yield* Clock.currentTimeMillis;
                    yield* Ref.set(enrichmentCache, {
                      ...current,
                      entry: {
                        // Cache the winning catalog while keeping the retry TTL from the fresh probe.
                        provider: !probeSupersedesLiveCatalog
                          ? { ...resolved, models: published.models }
                          : resolved,
                        expiresAt: completedAt + acpRegistryProbeTtlMs(provider),
                      },
                    });
                  }
                  if (cleared) {
                    yield* Ref.set(acceptedCatalog, {
                      models: resolved.models,
                      builtInModelCount: probedModelCount,
                      modelsFromModelSelect: probedModelsFromModelSelect,
                      reasoningDisabledModelSlugs,
                    });
                  }
                  yield* publishSnapshot(published);
                  return;
                }
                const isUnauthenticated = fresh && resolved.auth.status === "unauthenticated";
                if (isUnauthenticated) {
                  yield* Ref.set(enrichmentCache, { ...current, entry: null });
                  yield* clearLearnedModels;
                  yield* clearAcceptedCatalog;
                  if (Option.isSome(runtimeCoordinator)) {
                    yield* runtimeCoordinator.value.clearLiveConfigurationIfRevision(
                      instanceId,
                      probeStartLiveRevision,
                      { catalogRevision: probeStartCatalogRevision, clearOptions: true },
                    );
                  }
                }
                const preserveTransientFailure =
                  fresh && resolved.status !== "ready" && !isUnauthenticated;
                yield* withLiveRuntimeState(resolved, {
                  applyLiveModels: !isUnauthenticated,
                  fallbackToAcceptedModels: preserveTransientFailure,
                  preserveStatus: preserveTransientFailure,
                }).pipe(Effect.flatMap(publishSnapshot));
              }),
            ),
          );
        const publishEnrichment = (
          Option.isSome(runtimeCoordinator)
            ? runtimeCoordinator.value.runBackgroundProbe(
                effectiveConfig.source === "local"
                  ? `local:${instanceId}`
                  : effectiveConfig.agentId,
                enrichProviderCached(snapshot),
              )
            : enrichProviderCached(snapshot).pipe(Effect.asSome)
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: commitEnrichment,
            }),
          ),
        );
        if (Option.isNone(runtimeCoordinator)) return publishEnrichment;

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
                  Effect.uninterruptible(
                    Effect.gen(function* () {
                      const currentLive =
                        yield* runtimeCoordinator.value.getLiveConfigurationWithRevision(
                          instanceId,
                        );
                      if (
                        Option.isNone(currentLive.configuration) ||
                        revision <= currentLive.clearedThroughRevision
                      ) {
                        return;
                      }
                      const current = yield* getSnapshot;
                      if (
                        !current.installed ||
                        (current.auth.status === "unauthenticated" &&
                          configuration.models.length === 0)
                      ) {
                        return;
                      }
                      const acceptedBefore = yield* Ref.get(acceptedCatalog);
                      const preserveSingleModelCatalog = isExplicitSingletonCatalog(acceptedBefore);
                      const applied = yield* applyLiveConfiguration(current, configuration, {
                        preserveSingleModelCatalog,
                      });
                      // Keep non-ready warning status and message intact across live updates.
                      const next =
                        current.status !== "ready"
                          ? {
                              ...applied,
                              status: current.status,
                              ...(current.message === undefined
                                ? {}
                                : { message: current.message }),
                            }
                          : applied;
                      const replacesCatalog = liveConfigurationReplacesAcceptedCatalog(
                        configuration,
                        acceptedBefore,
                      );
                      const nextReasoningDisabled = replacesCatalog
                        ? new Set(
                            configuration.models
                              .filter((model) => model.reasoningEffort === null)
                              .map((model) => model.id),
                          )
                        : (configuration.reasoningDisabledModelIds?.length ?? 0) > 0
                          ? new Set([
                              ...acceptedBefore.reasoningDisabledModelSlugs,
                              ...(configuration.reasoningDisabledModelIds ?? []),
                            ])
                          : acceptedBefore.reasoningDisabledModelSlugs;
                      if (current.auth.status !== "unauthenticated" || replacesCatalog) {
                        yield* Ref.update(acceptedCatalog, (previous) =>
                          replacesCatalog
                            ? {
                                models: next.models,
                                builtInModelCount: configuration.models.length,
                                modelsFromModelSelect: configuration.modelsFromModelSelect === true,
                                reasoningDisabledModelSlugs: nextReasoningDisabled,
                              }
                            : current.status === "ready" && previous.models.length > 0
                              ? {
                                  ...previous,
                                  models: next.models,
                                  reasoningDisabledModelSlugs: nextReasoningDisabled,
                                }
                              : previous,
                        );
                      }
                      const now = yield* Clock.currentTimeMillis;
                      yield* Ref.update(enrichmentCache, (cache) =>
                        updateAcpRegistryEnrichmentCache({
                          cache,
                          configuration,
                          customModels: effectiveConfig.customModels,
                          now,
                          preserveSingleModelCatalog,
                          reasoningDisabledModelSlugs: acceptedBefore.reasoningDisabledModelSlugs,
                        }),
                      );
                      yield* publishSnapshot(next);
                    }),
                  ),
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
        return Effect.all(
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

    const clearCachedState = (options?: { readonly clearCommands?: boolean }) =>
      liveSnapshotSemaphore.withPermit(
        Effect.uninterruptible(
          invalidateEnrichmentCache.pipe(
            Effect.andThen(clearLearnedModels),
            Effect.andThen(clearAcceptedCatalog),
            Effect.andThen(
              Option.isSome(runtimeCoordinator)
                ? runtimeCoordinator.value
                    .clearLiveConfiguration(instanceId)
                    .pipe(
                      Effect.andThen(
                        options?.clearCommands === true
                          ? runtimeCoordinator.value.clearAvailableCommands(instanceId)
                          : Effect.void,
                      ),
                    )
                : Effect.void,
            ),
          ),
        ),
      );
    const clearLiveState = clearCachedState({ clearCommands: true });
    const controller = yield* AcpRegistryAuth.makeAcpRegistryAuth({
      instanceId,
      settings: effectiveConfig,
      cwd: host.paths.cwd,
      environment: processEnvironment,
      onChanged: (authenticated) =>
        confirmedAuthentication
          .set(authenticated)
          .pipe(
            Effect.andThen(
              authenticated
                ? liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)
                : clearLiveState,
            ),
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
      invalidateCaches: clearCachedState(),
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
          ).pipe(Effect.tap(() => clearCachedState())),
        disableProvider: ({ cwd, providerId }) =>
          provideAcpManagementServices(
            disableAcpRegistryProvider({
              instanceId,
              settings: effectiveConfig,
              cwd,
              environment: processEnvironment,
              providerId,
            }),
          ).pipe(Effect.tap(() => clearCachedState())),
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
            Effect.tap(() => clearLiveState),
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
