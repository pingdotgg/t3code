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
  ACP_REGISTRY_MAX_MODELS,
  type AcpRegistryAvailableCommands,
  type AcpRegistryConfigurationProbe,
  type AcpRegistryConfigurationProbeResult,
  type AcpRegistryLiveConfiguration,
  cappedAcpRegistryModelPrefixKey,
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
export const MAX_DISPLACED_LEARNED_MODELS = 64;

const cappedOverflowTailByModels = new WeakMap<ReadonlyArray<ServerProviderModel>, string>();

function markCappedOverflowTail(
  models: ReadonlyArray<ServerProviderModel>,
  slug: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (slug !== undefined) {
    cappedOverflowTailByModels.set(models, slug);
  }
  return models;
}

function preserveCappedOverflowTail(
  source: ReadonlyArray<ServerProviderModel>,
  target: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const slug = cappedOverflowTailByModels.get(source);
  if (slug !== undefined && target !== source) {
    const builtInTail = target.filter((model) => !model.isCustom)[ACP_REGISTRY_MAX_MODELS - 1];
    if (builtInTail?.slug === slug) {
      cappedOverflowTailByModels.set(target, slug);
    }
  }
  return target;
}

function hasCappedOverflowTail(
  models: ReadonlyArray<ServerProviderModel>,
  tailSlug: string | undefined,
): boolean {
  return tailSlug !== undefined && cappedOverflowTailByModels.get(models) === tailSlug;
}

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

interface AcpRegistryProbeOptionSchema {
  readonly models: ReadonlyArray<AcpRegistryProbeModel>;
  readonly currentModelId: string | null;
  readonly configOptions: ReadonlyArray<ProviderOptionDescriptor>;
  readonly modelOptionIds: ReadonlySet<string>;
  readonly cappedTailIsOverflow?: boolean;
}

interface AcceptedAcpRegistryCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly builtInModelCount: number;
  readonly modelsFromModelSelect: boolean;
  readonly reasoningDisabledModelSlugs: ReadonlySet<string>;
  readonly probeOptions: AcpRegistryProbeOptionSchema | null;
  readonly probeBaselineModels: ReadonlyArray<ServerProviderModel> | null;
}

const EMPTY_SLUG_SET: ReadonlySet<string> = new Set();

const EMPTY_ACCEPTED_CATALOG: AcceptedAcpRegistryCatalog = {
  models: [],
  builtInModelCount: 0,
  modelsFromModelSelect: false,
  reasoningDisabledModelSlugs: EMPTY_SLUG_SET,
  probeOptions: null,
  probeBaselineModels: null,
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
  // Empty disposable probes (e.g. cold-start or pre-catalog agents) keep the
  // accepted catalog or live options and retry on the 30s provisional TTL.
  if (input.probedModelCount === 0) return false;
  if (input.liveModelCount === 0) return true;
  if (input.probedModelCount > 1) return true;
  if (input.probedModelsFromModelSelect) return true;
  return input.liveModelCount === 1 && !input.liveModelsFromModelSelect;
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
  readonly hasDiscoveredCatalog?: boolean | undefined;
}): AcpRegistryEnrichmentCache {
  const {
    cache,
    configuration,
    customModels,
    now,
    preserveSingleModelCatalog,
    reasoningDisabledModelSlugs,
    hasDiscoveredCatalog,
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
    {
      preserveSingleModelCatalog,
      reasoningDisabledModelSlugs,
      hasDiscoveredCatalog,
    },
  );
  const overflowTailChanged =
    cappedOverflowTailByModels.get(cache.entry.provider.models) !==
    cappedOverflowTailByModels.get(provider.models);
  if (!overflowTailChanged && Equal.equals(provider, cache.entry.provider)) return cache;
  const previousBuiltIn = cache.entry.provider.models.filter((model) => !model.isCustom);
  const nextBuiltIn = provider.models.filter((model) => !model.isCustom);
  const catalogChanged =
    configuration.models.length > 0 &&
    (overflowTailChanged ||
      previousBuiltIn.length !== nextBuiltIn.length ||
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

function isReasoningDescriptor(descriptor: ProviderOptionDescriptor): boolean {
  return descriptor.type === "select" && descriptor.role === "reasoning";
}

function isModelSpecificDescriptor(
  descriptor: ProviderOptionDescriptor,
  modelOptionIds: ReadonlySet<string>,
): boolean {
  return modelOptionIds.has(descriptor.id) || isReasoningDescriptor(descriptor);
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

function readAdvertisedReasoning(
  advertisedReasoning: AcpRegistryLiveConfiguration["advertisedReasoning"],
  slug: string,
): NonNullable<AcpRegistryProbeModel["reasoningEffort"]> | undefined {
  return advertisedReasoning !== undefined && Object.hasOwn(advertisedReasoning, slug)
    ? advertisedReasoning[slug]
    : undefined;
}

export function updateAcpRegistryLearnedModelsFromLive(
  learned: ReadonlyArray<ServerProviderModel>,
  nextModels: ReadonlyArray<ServerProviderModel>,
  configuration: AcpRegistryLiveConfiguration,
  disabledReasoningSlugs: ReadonlySet<string> = EMPTY_SLUG_SET,
  options?: { readonly replaceCurrentLearnedOptions?: boolean },
): ReadonlyArray<ServerProviderModel> {
  const modelOptionIds = new Set(configuration.modelOptionIds ?? []);
  const learnedBySlug = new Map(
    learned.filter((model) => !model.isCustom).map((model) => [model.slug, model] as const),
  );
  const configuredById = new Map(configuration.models.map((model) => [model.id, model] as const));
  let lastLearnedSlug = learned.findLast((model) => !model.isCustom)?.slug;
  let dataChanged = false;
  let orderTouched = false;
  for (const model of nextModels) {
    if (model.isCustom) continue;
    const isCurrentModel =
      configuration.currentModelId !== null && model.slug === configuration.currentModelId;
    const hasAdvertisedReasoning =
      configuredById.get(model.slug)?.reasoningEffort !== undefined ||
      readAdvertisedReasoning(configuration.advertisedReasoning, model.slug) !== undefined;
    const isReasoningDisabled = disabledReasoningSlugs.has(model.slug);
    if (!isCurrentModel && !hasAdvertisedReasoning && !isReasoningDisabled) continue;
    const descriptors = model.capabilities?.optionDescriptors ?? [];
    const previous = learnedBySlug.get(model.slug);
    const previousDescriptors = previous?.capabilities?.optionDescriptors ?? [];
    const previousIds = new Set(previousDescriptors.map((descriptor) => descriptor.id));
    const specific = isCurrentModel
      ? configuration.partialOptions === true && options?.replaceCurrentLearnedOptions !== true
        ? descriptors.filter(
            (descriptor) =>
              (isModelSpecificDescriptor(descriptor, modelOptionIds) ||
                previousIds.has(descriptor.id)) &&
              (!isReasoningDisabled || !isReasoningDescriptor(descriptor)),
          )
        : descriptors.filter((descriptor) => isModelSpecificDescriptor(descriptor, modelOptionIds))
      : [
          ...descriptors.filter(isReasoningDescriptor),
          ...previousDescriptors.filter((descriptor) => !isReasoningDescriptor(descriptor)),
        ];
    if (specific.length === 0) {
      if (previous !== undefined) {
        learnedBySlug.delete(model.slug);
        if (model.slug === lastLearnedSlug) lastLearnedSlug = undefined;
        dataChanged = true;
      }
      continue;
    }
    const updated = modelWithSpecificOptions(model, specific);
    if (previous === undefined || !Equal.equals(previous.capabilities, updated.capabilities)) {
      learnedBySlug.delete(model.slug);
      learnedBySlug.set(model.slug, updated);
      lastLearnedSlug = model.slug;
      dataChanged = true;
    } else if (model.slug !== lastLearnedSlug) {
      learnedBySlug.delete(model.slug);
      learnedBySlug.set(model.slug, previous);
      lastLearnedSlug = model.slug;
      orderTouched = true;
    }
  }
  // Earlier-model retained updates for a displaced capped tail do not swap the visible tail,
  // but still record their retained model-specific options into learnedModels.
  if (
    configuration.preserveDefault === true &&
    configuration.cappedLastModel !== undefined &&
    configuration.cappedPrefixKey !== undefined &&
    configuration.currentModelId === configuration.cappedLastModel.id &&
    cappedAcpRegistryModelPrefixKey(
      nextModels.filter((model) => !model.isCustom).map((model) => model.slug),
    ) === configuration.cappedPrefixKey &&
    !nextModels.some((model) => !model.isCustom && model.slug === configuration.currentModelId)
  ) {
    const slug = configuration.cappedLastModel.id;
    const isReasoningDisabled =
      disabledReasoningSlugs.has(slug) || configuration.cappedLastModel.reasoningEffort === null;
    const incoming = configuration.configOptions.filter(
      (descriptor) =>
        isModelSpecificDescriptor(descriptor, modelOptionIds) &&
        (!isReasoningDisabled || !isReasoningDescriptor(descriptor)),
    );
    const previous = learnedBySlug.get(slug);
    const replace = options?.replaceCurrentLearnedOptions === true;
    const incomingIds = new Set(incoming.map((descriptor) => descriptor.id));
    const preservedPrevious = replace
      ? []
      : (previous?.capabilities?.optionDescriptors ?? []).filter(
          (descriptor) =>
            !incomingIds.has(descriptor.id) &&
            (!isReasoningDisabled || !isReasoningDescriptor(descriptor)),
        );
    const combined = [...preservedPrevious, ...incoming];
    if (combined.length === 0) {
      if (previous !== undefined) {
        learnedBySlug.delete(slug);
        dataChanged = true;
      }
    } else {
      const updated: ServerProviderModel = {
        slug,
        name: configuration.cappedLastModel.name,
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: combined,
        }),
      };
      if (previous === undefined || !Equal.equals(previous.capabilities, updated.capabilities)) {
        learnedBySlug.delete(slug);
        learnedBySlug.set(slug, updated);
        dataChanged = true;
      } else if (slug !== lastLearnedSlug) {
        learnedBySlug.delete(slug);
        learnedBySlug.set(slug, previous);
        orderTouched = true;
      }
    }
  }
  const maxLearnedModels = ACP_REGISTRY_MAX_MODELS + MAX_DISPLACED_LEARNED_MODELS;
  while (learnedBySlug.size > maxLearnedModels) {
    const oldestKey = learnedBySlug.keys().next().value;
    if (oldestKey === undefined) break;
    learnedBySlug.delete(oldestKey);
    dataChanged = true;
  }
  if (!dataChanged) {
    if (!orderTouched) return learned;
    if (learnedBySlug.size === learned.length) {
      let index = 0;
      let sameOrder = true;
      for (const slug of learnedBySlug.keys()) {
        if (learned[index]?.slug !== slug) {
          sameOrder = false;
          break;
        }
        index += 1;
      }
      if (sameOrder) return learned;
    }
  }
  return Array.from(learnedBySlug.values());
}

function compatibleLiveOptionValue(
  probed: ProviderOptionDescriptor,
  live: ProviderOptionDescriptor | undefined,
): Option.Option<ProviderOptionDescriptor> {
  if (
    live === undefined ||
    live.id !== probed.id ||
    live.type !== probed.type ||
    live.currentValue === undefined
  ) {
    return Option.none();
  }
  if (probed.type === "boolean") {
    return Option.some({ ...probed, currentValue: live.currentValue as boolean });
  }
  return probed.options.some((option) => option.id === live.currentValue)
    ? Option.some({ ...probed, currentValue: live.currentValue as string })
    : Option.none();
}

/**
 * Keeps only compatible live session option overrides after a superseding probe replaces
 * the catalog, leaving probe-only defaults out of coordinator state.
 */
export function retainAcpRegistryLiveOptionsAfterProbe(
  live: AcpRegistryLiveConfiguration,
  probe: AcpRegistryProbeOptionSchema,
): Option.Option<AcpRegistryLiveConfiguration> {
  const probedModelById = new Map(probe.models.map((model) => [model.id, model]));
  const matchingCappedTail =
    live.cappedLastModel !== undefined &&
    live.cappedPrefixKey !== undefined &&
    cappedAcpRegistryModelPrefixKey(probe.models.map((model) => model.id)) ===
      live.cappedPrefixKey &&
    probe.models[ACP_REGISTRY_MAX_MODELS - 1]?.id !== live.cappedLastModel.id &&
    (live.cappedTailIsOverflow === true
      ? live.currentModelId === live.cappedLastModel.id
      : probe.cappedTailIsOverflow === true)
      ? {
          cappedPrefixKey: live.cappedPrefixKey,
          cappedLastModel: live.cappedLastModel,
          ...(live.cappedTailIsOverflow === true ? { cappedTailIsOverflow: true } : {}),
        }
      : undefined;
  const currentProbedModel =
    live.currentModelId === null
      ? undefined
      : (probedModelById.get(live.currentModelId) ??
        (matchingCappedTail?.cappedLastModel.id === live.currentModelId
          ? matchingCappedTail.cappedLastModel
          : undefined));
  const liveById = new Map(live.configOptions.map((descriptor) => [descriptor.id, descriptor]));
  const liveModelOptionIds = new Set(live.modelOptionIds ?? []);

  const probeSharedIds = new Set<string>();
  const sharedDescriptors: Array<ProviderOptionDescriptor> = [];
  for (const descriptor of probe.configOptions) {
    if (isModelSpecificDescriptor(descriptor, probe.modelOptionIds)) continue;
    probeSharedIds.add(descriptor.id);
    const liveMatch = liveById.get(descriptor.id);
    if (liveMatch === undefined || isModelSpecificDescriptor(liveMatch, liveModelOptionIds)) {
      continue;
    }
    const retained = compatibleLiveOptionValue(descriptor, liveMatch);
    if (Option.isSome(retained)) sharedDescriptors.push(retained.value);
  }

  const retainedAdvertisedReasoningEntries: Array<
    readonly [string, NonNullable<AcpRegistryProbeModel["reasoningEffort"]>]
  > = [];
  if (live.advertisedReasoning !== undefined) {
    for (const [slug, descriptor] of Object.entries(live.advertisedReasoning)) {
      const probedModel = probedModelById.get(slug);
      if (probedModel === undefined || probedModel.reasoningEffort === null) continue;
      if (probedModel.reasoningEffort !== undefined) {
        const retained = compatibleLiveOptionValue(probedModel.reasoningEffort, descriptor);
        if (Option.isSome(retained) && retained.value.type === "select") {
          retainedAdvertisedReasoningEntries.push([slug, retained.value]);
        }
        continue;
      }
      retainedAdvertisedReasoningEntries.push([slug, descriptor]);
    }
  }
  const retainedAdvertisedReasoning =
    retainedAdvertisedReasoningEntries.length > 0
      ? Object.fromEntries(retainedAdvertisedReasoningEntries)
      : undefined;
  const advertisedReasoningIds = new Set(
    retainedAdvertisedReasoningEntries.map(([, descriptor]) => descriptor.id),
  );

  const modelDescriptors: Array<ProviderOptionDescriptor> = [];
  if (currentProbedModel !== undefined) {
    const reasoningDisabled = currentProbedModel.reasoningEffort === null;
    if (currentProbedModel.id === probe.currentModelId) {
      let probeHasReasoning = false;
      for (const descriptor of probe.configOptions) {
        if (!isModelSpecificDescriptor(descriptor, probe.modelOptionIds)) continue;
        if (isReasoningDescriptor(descriptor)) {
          probeHasReasoning = true;
          if (reasoningDisabled) continue;
        }
        const liveMatch = liveById.get(descriptor.id);
        if (liveMatch === undefined || !isModelSpecificDescriptor(liveMatch, liveModelOptionIds)) {
          continue;
        }
        const retained = compatibleLiveOptionValue(descriptor, liveMatch);
        if (Option.isSome(retained)) modelDescriptors.push(retained.value);
      }
      if (!probeHasReasoning && !reasoningDisabled && advertisedReasoningIds.size > 0) {
        for (const descriptor of live.configOptions) {
          if (
            !probeSharedIds.has(descriptor.id) &&
            isReasoningDescriptor(descriptor) &&
            advertisedReasoningIds.has(descriptor.id)
          ) {
            modelDescriptors.push(descriptor);
          }
        }
      }
    } else {
      const advertisedReasoning = currentProbedModel.reasoningEffort;
      let addedAdvertisedReasoning = false;
      for (const descriptor of live.configOptions) {
        if (probeSharedIds.has(descriptor.id)) continue;
        if (!isModelSpecificDescriptor(descriptor, liveModelOptionIds)) continue;
        if (isReasoningDescriptor(descriptor)) {
          if (reasoningDisabled) continue;
          if (advertisedReasoning != null) {
            if (!addedAdvertisedReasoning) {
              const retained = compatibleLiveOptionValue(advertisedReasoning, descriptor);
              if (Option.isSome(retained)) {
                modelDescriptors.push(retained.value);
                addedAdvertisedReasoning = true;
              }
            }
            continue;
          }
        }
        modelDescriptors.push(descriptor);
      }
    }
  }

  const overflowFields = matchingCappedTail ?? {};
  const advertisedReasoningFields =
    retainedAdvertisedReasoning === undefined
      ? {}
      : { advertisedReasoning: retainedAdvertisedReasoning };
  const replaceModelOptions =
    currentProbedModel !== undefined &&
    currentProbedModel.id !== probe.currentModelId &&
    (live.partialOptions !== true || live.replaceModelOptions === true);
  const replaceModelOptionsFields = replaceModelOptions ? { replaceModelOptions: true } : {};
  const configOptions = [...sharedDescriptors, ...modelDescriptors];
  if (configOptions.length === 0) {
    // Keep the running session's model selection, capped tail update, or advertised reasoning
    // even when no active config options survive, unless nothing differs from probe default.
    if (
      matchingCappedTail === undefined &&
      retainedAdvertisedReasoning === undefined &&
      (currentProbedModel === undefined || currentProbedModel.id === probe.currentModelId)
    ) {
      return Option.none();
    }
    return Option.some({
      models: [],
      currentModelId: live.currentModelId,
      configOptions: [],
      modelOptionIds: [],
      modelsFromModelSelect: false,
      partialOptions: true,
      ...replaceModelOptionsFields,
      ...overflowFields,
      ...advertisedReasoningFields,
    });
  }
  return Option.some({
    models: [],
    // Keep live.currentModelId even when removed upstream so overlay does not
    // apply session options onto the probe's default model.
    currentModelId: live.currentModelId,
    configOptions,
    modelOptionIds: modelDescriptors.map((descriptor) => descriptor.id),
    modelsFromModelSelect: false,
    partialOptions: true,
    ...replaceModelOptionsFields,
    ...overflowFields,
    ...advertisedReasoningFields,
  });
}

function mergeLearnedModelOptions(
  models: ReadonlyArray<ServerProviderModel>,
  learned: ReadonlyArray<ServerProviderModel>,
  options?: {
    readonly currentModelId?: string | null;
    readonly skipModelSlugs?: ReadonlySet<string>;
    readonly skipOptionIdsByModel?: ReadonlyMap<string, ReadonlySet<string>>;
    readonly reasoningDisabledModelSlugs?: ReadonlySet<string>;
    readonly overlayLearnedValues?: boolean;
  },
): ReadonlyArray<ServerProviderModel> {
  if (learned.length === 0) return models;
  const currentModelId = options?.currentModelId ?? null;
  const skipModelSlugs = options?.skipModelSlugs ?? EMPTY_SLUG_SET;
  const skipOptionIdsByModel = options?.skipOptionIdsByModel;
  const reasoningDisabledModelSlugs = options?.reasoningDisabledModelSlugs ?? EMPTY_SLUG_SET;
  const overlayLearnedValues = options?.overlayLearnedValues === true;
  const learnedBySlug = new Map(
    learned.filter((model) => !model.isCustom).map((model) => [model.slug, model] as const),
  );
  let changed = false;
  const merged = models.map((model) => {
    // The probe already observed its currentModelId in full; do not restore dropped options onto it.
    if (
      model.isCustom ||
      (currentModelId !== null && model.slug === currentModelId) ||
      skipModelSlugs.has(model.slug)
    ) {
      return model;
    }
    const rawPreviousDescriptors =
      learnedBySlug.get(model.slug)?.capabilities?.optionDescriptors ?? [];
    const skippedOptionIds = skipOptionIdsByModel?.get(model.slug);
    const previousDescriptors =
      skippedOptionIds !== undefined
        ? rawPreviousDescriptors.filter((descriptor) => !skippedOptionIds.has(descriptor.id))
        : rawPreviousDescriptors;
    if (previousDescriptors.length === 0) return model;
    const currentDescriptors = model.capabilities?.optionDescriptors ?? [];
    const previousById = overlayLearnedValues
      ? new Map(previousDescriptors.map((descriptor) => [descriptor.id, descriptor] as const))
      : undefined;
    const nextCurrentDescriptors =
      previousById === undefined
        ? currentDescriptors
        : currentDescriptors.map((descriptor) => {
            if (reasoningDisabledModelSlugs.has(model.slug) && isReasoningDescriptor(descriptor)) {
              return descriptor;
            }
            const learnedDescriptor = previousById.get(descriptor.id);
            return learnedDescriptor === undefined
              ? descriptor
              : Option.getOrElse(
                  compatibleLiveOptionValue(descriptor, learnedDescriptor),
                  () => descriptor,
                );
          });
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
    const combined =
      extra.length === 0 ? nextCurrentDescriptors : [...nextCurrentDescriptors, ...extra];
    if (Equal.equals(currentDescriptors, combined)) return model;
    changed = true;
    return {
      ...model,
      capabilities: createModelCapabilities({
        optionDescriptors: combined,
      }),
    };
  });
  return changed ? preserveCappedOverflowTail(models, merged) : models;
}

export function updateAcpRegistryLearnedModelsFromProbe(
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
  const probedSlugs = new Set<string>();
  let probedBuiltInCount = 0;
  for (const model of probedModels) {
    if (model.isCustom) continue;
    probedBuiltInCount += 1;
    probedSlugs.add(model.slug);
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
  // When the probe hits the 256-model cap, keep a bounded window of displaced learned models
  // (oldest first so models seen in this probe stay newest on subsequent rotations).
  if (probedBuiltInCount >= ACP_REGISTRY_MAX_MODELS) {
    const displaced: Array<ServerProviderModel> = [];
    for (const [slug, previous] of learnedBySlug) {
      if (!probedSlugs.has(slug)) {
        displaced.push(previous);
      }
    }
    const retainedDisplaced =
      displaced.length > MAX_DISPLACED_LEARNED_MODELS
        ? displaced.slice(displaced.length - MAX_DISPLACED_LEARNED_MODELS)
        : displaced;
    if (retainedDisplaced.length > 0) {
      return [...retainedDisplaced, ...next];
    }
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
    models: markCappedOverflowTail(
      modelsFromDiscovery(input.probe?.probe, input.settings.customModels),
      input.probe?.cappedTailIsOverflow === true
        ? (input.probe.probe.currentModelId ?? undefined)
        : undefined,
    ),
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
  return changed ? preserveCappedOverflowTail(models, next) : models;
}

function overlayPartialLiveOptions(
  models: ReadonlyArray<ServerProviderModel>,
  configuration: AcpRegistryLiveConfiguration,
  selectedProbedModelId: string | null,
  disabledReasoningSlugs: ReadonlySet<string>,
): ReadonlyArray<ServerProviderModel> {
  const modelOptionIds = new Set(configuration.modelOptionIds ?? []);
  const sharedOverrides = new Map<string, ProviderOptionDescriptor>();
  const modelOverrides: Array<ProviderOptionDescriptor> = [];
  for (const descriptor of configuration.configOptions) {
    if (isModelSpecificDescriptor(descriptor, modelOptionIds)) {
      modelOverrides.push(descriptor);
    } else {
      sharedOverrides.set(descriptor.id, descriptor);
    }
  }
  const updated = models.map((model) => {
    const existing = model.capabilities?.optionDescriptors ?? [];
    const isCurrentModel =
      !model.isCustom &&
      configuration.currentModelId !== null &&
      model.slug === configuration.currentModelId;
    const reasoningDisabled = !model.isCustom && disabledReasoningSlugs.has(model.slug);
    const nextDescriptors: Array<ProviderOptionDescriptor> = [];
    for (const descriptor of existing) {
      if (reasoningDisabled && descriptor.type === "select" && descriptor.role === "reasoning") {
        continue;
      }
      const sharedOverride = sharedOverrides.get(descriptor.id);
      if (sharedOverride !== undefined) {
        const overlaid = compatibleLiveOptionValue(descriptor, sharedOverride);
        nextDescriptors.push(Option.getOrElse(overlaid, () => descriptor));
      } else {
        nextDescriptors.push(descriptor);
      }
    }
    if (isCurrentModel) {
      for (const override of modelOverrides) {
        if (reasoningDisabled && override.type === "select" && override.role === "reasoning") {
          continue;
        }
        const existingIndex = nextDescriptors.findIndex((item) => item.id === override.id);
        if (existingIndex >= 0) {
          const currentDescriptor = nextDescriptors[existingIndex]!;
          const overlaid = compatibleLiveOptionValue(currentDescriptor, override);
          nextDescriptors[existingIndex] = Option.getOrElse(overlaid, () => currentDescriptor);
        } else {
          nextDescriptors.push(override);
        }
      }
    } else if (!model.isCustom && !reasoningDisabled) {
      const advertised = readAdvertisedReasoning(configuration.advertisedReasoning, model.slug);
      if (advertised !== undefined) {
        if (configuration.partialOptions !== true) {
          // Live reasoning-only replay (no superseding probe schema constraining it):
          // replace any earlier reasoning selector just like modelsFromDiscovery does.
          for (let index = nextDescriptors.length - 1; index >= 0; index -= 1) {
            if (isReasoningDescriptor(nextDescriptors[index]!)) {
              nextDescriptors.splice(index, 1);
            }
          }
          nextDescriptors.push(advertised);
        } else {
          const existingIndex = nextDescriptors.findIndex((item) => item.id === advertised.id);
          if (existingIndex >= 0) {
            const currentDescriptor = nextDescriptors[existingIndex]!;
            const overlaid = compatibleLiveOptionValue(currentDescriptor, advertised);
            nextDescriptors[existingIndex] = Option.getOrElse(overlaid, () => currentDescriptor);
          } else if (!nextDescriptors.some(isReasoningDescriptor)) {
            nextDescriptors.push(advertised);
          }
        }
      }
    }
    if (Equal.equals(existing, nextDescriptors)) return model;
    return {
      ...model,
      capabilities:
        nextDescriptors.length === 0
          ? EMPTY_CAPABILITIES
          : createModelCapabilities({ optionDescriptors: nextDescriptors }),
    };
  });
  const overlaid = preserveCappedOverflowTail(models, updated);
  return configuration.preserveDefault === true
    ? overlaid
    : withAcpRegistryDefaultModel(overlaid, selectedProbedModelId);
}

export function applyAcpRegistryLiveConfiguration(
  provider: ServerProvider,
  configuration: AcpRegistryLiveConfiguration,
  customModels: ReadonlyArray<CustomModelSetting>,
  previousModels: ReadonlyArray<ServerProviderModel> = provider.models,
  options?: {
    readonly preserveSingleModelCatalog?: boolean | undefined;
    readonly reasoningDisabledModelSlugs?: ReadonlySet<string> | undefined;
    readonly hasDiscoveredCatalog?: boolean | undefined;
    readonly probeSharedDescriptors?: ReadonlyArray<ProviderOptionDescriptor> | undefined;
    readonly probeConfigOptions?: ReadonlyArray<ProviderOptionDescriptor> | undefined;
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
    : (options?.reasoningDisabledModelSlugs ?? EMPTY_SLUG_SET);
  const cappedLastModel =
    !useLiveCatalog &&
    configuration.preserveDefault !== true &&
    configuration.currentModelId !== null &&
    configuration.cappedLastModel !== undefined &&
    configuration.cappedPrefixKey !== undefined &&
    cappedAcpRegistryModelPrefixKey(probedModels.map((model) => model.slug)) ===
      configuration.cappedPrefixKey
      ? configuration.cappedLastModel
      : undefined;
  const currentTailSlug = probedModels[ACP_REGISTRY_MAX_MODELS - 1]?.slug;
  const providerHasOverflowTail = hasCappedOverflowTail(provider.models, currentTailSlug);
  const tailSlotReplacement =
    cappedLastModel !== undefined &&
    currentTailSlug !== cappedLastModel.id &&
    (configuration.cappedTailIsOverflow === true
      ? configuration.currentModelId === cappedLastModel.id
      : providerHasOverflowTail)
      ? cappedLastModel
      : undefined;
  const nextOverflowTailSlug = useLiveCatalog
    ? configuration.cappedTailIsOverflow === true
      ? (configuration.currentModelId ?? undefined)
      : undefined
    : tailSlotReplacement !== undefined
      ? configuration.cappedTailIsOverflow === true
        ? tailSlotReplacement.id
        : undefined
      : providerHasOverflowTail
        ? currentTailSlug
        : undefined;
  const liveCurrentModelInProbed =
    (tailSlotReplacement !== undefined &&
      configuration.currentModelId === tailSlotReplacement.id) ||
    (configuration.currentModelId !== null &&
      probedModels.some((model) => model.slug === configuration.currentModelId));
  const selectedProbedModelId = liveCurrentModelInProbed
    ? configuration.currentModelId
    : (probedModels.find((model) => model.isDefault)?.slug ?? null);
  const isReasoningOnlyLiveOverlay =
    !useLiveCatalog &&
    configuration.partialOptions !== true &&
    configuration.preserveDefault === true &&
    configuration.currentModelId === null &&
    configuration.configOptions.length === 0;
  if (!useLiveCatalog && (configuration.partialOptions === true || isReasoningOnlyLiveOverlay)) {
    const modelsForOverlay = (() => {
      if (tailSlotReplacement === undefined) return provider.models;
      const partialOverrideIds = new Set<string>();
      if (configuration.currentModelId === tailSlotReplacement.id) {
        const partialModelOptionIds = new Set(configuration.modelOptionIds ?? []);
        for (const descriptor of configuration.configOptions) {
          if (isModelSpecificDescriptor(descriptor, partialModelOptionIds)) {
            partialOverrideIds.add(descriptor.id);
          }
        }
      }
      const learnedPreviousModels = previousModels
        .filter((model) => !model.isCustom)
        .map((model) => {
          if (
            model.slug !== tailSlotReplacement.id ||
            partialOverrideIds.size === 0 ||
            !model.capabilities?.optionDescriptors?.length
          ) {
            return model;
          }
          const kept = model.capabilities.optionDescriptors.filter(
            (descriptor) => !partialOverrideIds.has(descriptor.id),
          );
          return kept.length === model.capabilities.optionDescriptors.length
            ? model
            : modelWithSpecificOptions(model, kept);
        });
      const replacementBuiltIn = modelsFromDiscovery(
        {
          models: [tailSlotReplacement],
          currentModelId: null,
          configOptions: options?.probeSharedDescriptors ?? [],
        },
        [],
        learnedPreviousModels,
      )[0]!;
      const nextBuiltInModels = probedModels.map((model, index) =>
        index === ACP_REGISTRY_MAX_MODELS - 1 ? replacementBuiltIn : model,
      );
      const fallbackCustomDescriptors =
        options?.probeConfigOptions ?? options?.probeSharedDescriptors ?? [];
      const customModelCapabilities =
        fallbackCustomDescriptors.length === 0
          ? EMPTY_CAPABILITIES
          : createModelCapabilities({ optionDescriptors: fallbackCustomDescriptors });
      return providerModelsFromSettings(nextBuiltInModels, customModels, customModelCapabilities);
    })();
    const partialDisabledReasoning =
      tailSlotReplacement?.reasoningEffort === null
        ? new Set([...disabledReasoningSlugs, tailSlotReplacement.id])
        : disabledReasoningSlugs;
    return {
      ...snapshot,
      status: provider.enabled ? "ready" : provider.status,
      models: markCappedOverflowTail(
        overlayPartialLiveOptions(
          modelsForOverlay,
          configuration,
          selectedProbedModelId,
          partialDisabledReasoning,
        ),
        nextOverflowTailSlug,
      ),
    };
  }
  // When retaining a discovered catalog for a live session with an absent or
  // unknown current model, keep only shared options and leave each model's own
  // options untouched. Only the synthetic "default" placeholder accepts them.
  const hasDiscoveredCatalog =
    options?.hasDiscoveredCatalog === true || options?.preserveSingleModelCatalog === true;
  const hasSyntheticDefaultOnly =
    !hasDiscoveredCatalog && probedModels.length === 1 && probedModels[0]?.slug === "default";
  const dropUnmatchedModelOptions =
    !useLiveCatalog &&
    !liveCurrentModelInProbed &&
    !(configuration.currentModelId === null && hasSyntheticDefaultOnly);
  const unmatchedModelOptionIds = dropUnmatchedModelOptions
    ? new Set(configuration.modelOptionIds ?? [])
    : EMPTY_SLUG_SET;
  const effectiveConfigOptions = dropUnmatchedModelOptions
    ? configuration.configOptions.filter(
        (descriptor) => !isModelSpecificDescriptor(descriptor, unmatchedModelOptionIds),
      )
    : configuration.configOptions;
  const hasAdvertisedReasoning =
    !useLiveCatalog &&
    configuration.advertisedReasoning !== undefined &&
    Object.keys(configuration.advertisedReasoning).length > 0;
  const retainedDiscoveryModels: Array<AcpRegistryProbeModel> = probedModels.map((model) => {
    if (disabledReasoningSlugs.has(model.slug)) {
      return {
        id: model.slug,
        name: model.name,
        description: null,
        reasoningEffort: null,
      };
    }
    const advertised = readAdvertisedReasoning(configuration.advertisedReasoning, model.slug);
    return {
      id: model.slug,
      name: model.name,
      description: null,
      ...(advertised === undefined ? {} : { reasoningEffort: advertised }),
    };
  });
  if (tailSlotReplacement !== undefined) {
    retainedDiscoveryModels[ACP_REGISTRY_MAX_MODELS - 1] = tailSlotReplacement;
  }
  const discovery = useLiveCatalog
    ? configuration
    : {
        ...configuration,
        models: retainedDiscoveryModels,
        currentModelId: dropUnmatchedModelOptions
          ? configuration.currentModelId
          : selectedProbedModelId,
        configOptions: effectiveConfigOptions,
      };
  const nextModels =
    !useLiveCatalog &&
    effectiveConfigOptions.length === 0 &&
    !hasAdvertisedReasoning &&
    tailSlotReplacement === undefined &&
    !liveCurrentModelInProbed
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
    models: markCappedOverflowTail(
      dropUnmatchedModelOptions && (effectiveConfigOptions.length > 0 || hasAdvertisedReasoning)
        ? withAcpRegistryDefaultModel(nextModels, selectedProbedModelId)
        : nextModels,
      nextOverflowTailSlug,
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
  return changed ? preserveCappedOverflowTail(models, next) : models;
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
  readonly probedCappedTailIsOverflow: boolean;
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
    probedCappedTailIsOverflow: false,
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
        probedCappedTailIsOverflow: probed.success.cappedTailIsOverflow === true,
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
    let initialLiveSessionResetRevision = 0;
    if (Option.isSome(runtimeCoordinator)) {
      yield* runtimeCoordinator.value.clearAvailableCommands(instanceId);
      initialLiveSessionResetRevision =
        yield* runtimeCoordinator.value.clearLiveConfiguration(instanceId);
      yield* Effect.addFinalizer(() =>
        runtimeCoordinator.value
          .clearAvailableCommands(instanceId)
          .pipe(
            Effect.andThen(runtimeCoordinator.value.clearLiveConfiguration(instanceId)),
            Effect.asVoid,
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
    const clearLearnedModels = Ref.set(learnedModels, []);
    // Readiness checks do not read enrichmentCache, and post-TTL probes may see no live entry
    // once an earlier probe cleared it; keep the last accepted catalog separately so skipped
    // enrichment or provisional probes do not regress the snapshot.
    const acceptedCatalog = yield* Ref.make<AcceptedAcpRegistryCatalog>(EMPTY_ACCEPTED_CATALOG);
    const clearAcceptedCatalog = Ref.set(acceptedCatalog, EMPTY_ACCEPTED_CATALOG);
    // Tracks the coordinator revision through which live state was explicitly reset (instance
    // creation, sign-out, or full cache clear), excluding invalidateCaches which preserves
    // coordinator state.
    const liveSessionResetRevision = yield* Ref.make(initialLiveSessionResetRevision);
    // Tracks signed-out state so readiness and the watcher reject options-only updates until a
    // ready probe or sign-in succeeds. `epoch` advances on sign-out/cache resets so a ready probe
    // losing a live-catalog race still reopens replay of pending options unless superseded.
    const signedOutState = yield* Ref.make({ signedOut: false, epoch: 0 });
    const markSignedOut = Ref.update(signedOutState, (state) => ({
      signedOut: true,
      epoch: state.epoch + 1,
    }));
    const advanceSignedOutEpoch = Ref.update(signedOutState, (state) => ({
      ...state,
      epoch: state.epoch + 1,
    }));
    const clearSignedOut = Ref.update(signedOutState, (state) =>
      state.signedOut ? { ...state, signedOut: false } : state,
    );
    const lastObservedLiveRevision = yield* Ref.make(0);
    const lastAppliedLiveCatalogRevision = yield* Ref.make(0);
    const lastAppliedLiveRevision = yield* Ref.make(0);
    const resetAppliedLiveRevisions = Ref.set(lastAppliedLiveCatalogRevision, 0).pipe(
      Effect.andThen(Ref.set(lastAppliedLiveRevision, 0)),
    );
    const applyLiveConfiguration = (
      provider: ServerProvider,
      configuration: AcpRegistryLiveConfiguration,
      options?: {
        readonly preserveSingleModelCatalog?: boolean | undefined;
        readonly reasoningDisabledModelSlugs?: ReadonlySet<string> | undefined;
        readonly hasDiscoveredCatalog?: boolean | undefined;
        readonly replaceCurrentLearnedOptions?: boolean | undefined;
        readonly probeSharedDescriptors?: ReadonlyArray<ProviderOptionDescriptor> | undefined;
        readonly probeConfigOptions?: ReadonlyArray<ProviderOptionDescriptor> | undefined;
      },
    ) =>
      Ref.get(acceptedCatalog).pipe(
        Effect.flatMap((accepted) => {
          const preserveSingleModelCatalog =
            options?.preserveSingleModelCatalog ?? isExplicitSingletonCatalog(accepted);
          const reasoningDisabledModelSlugs =
            options?.reasoningDisabledModelSlugs ?? accepted.reasoningDisabledModelSlugs;
          const hasDiscoveredCatalog =
            options?.hasDiscoveredCatalog ?? accepted.builtInModelCount > 0;
          const disabledForLearning =
            configuration.models.length > 0 ? EMPTY_SLUG_SET : reasoningDisabledModelSlugs;
          return Ref.modify(learnedModels, (learned) => {
            const basePrevious = learned.length > 0 ? learned : provider.models;
            const previousModels =
              options?.replaceCurrentLearnedOptions === true &&
              configuration.currentModelId !== null
                ? basePrevious.filter((model) => model.slug !== configuration.currentModelId)
                : basePrevious;
            const next = applyAcpRegistryLiveConfiguration(
              provider,
              configuration,
              effectiveConfig.customModels,
              previousModels,
              {
                preserveSingleModelCatalog,
                reasoningDisabledModelSlugs,
                hasDiscoveredCatalog,
                probeSharedDescriptors: options?.probeSharedDescriptors,
                probeConfigOptions: options?.probeConfigOptions,
              },
            );
            return [
              next,
              updateAcpRegistryLearnedModelsFromLive(
                learned,
                next.models,
                configuration,
                disabledForLearning,
                {
                  replaceCurrentLearnedOptions: options?.replaceCurrentLearnedOptions === true,
                },
              ),
            ];
          });
        }),
      );
    const applyLiveConfigurationStep = Effect.fn("AcpRegistryDriver.applyLiveConfigurationStep")(
      function* (
        current: ServerProvider,
        configuration: AcpRegistryLiveConfiguration,
        options: {
          readonly preserveStatus?: boolean | undefined;
          readonly revision: number;
        },
      ) {
        const acceptedBefore = yield* Ref.get(acceptedCatalog);
        const replacesCatalog = liveConfigurationReplacesAcceptedCatalog(
          configuration,
          acceptedBefore,
        );
        const preserveSingleModelCatalog = isExplicitSingletonCatalog(acceptedBefore);
        const reasoningDisabledModelSlugs = acceptedBefore.reasoningDisabledModelSlugs;
        const hasDiscoveredCatalog = acceptedBefore.builtInModelCount > 0;
        const withPreservedStatus = (applied: ServerProvider) =>
          options.preserveStatus === true
            ? {
                ...applied,
                status: current.status,
                ...(current.message === undefined ? {} : { message: current.message }),
              }
            : applied;

        const probeOptions = acceptedBefore.probeOptions;
        if (!replacesCatalog && probeOptions !== null) {
          const effectiveConfiguration =
            configuration.partialOptions === true
              ? Option.some(configuration)
              : retainAcpRegistryLiveOptionsAfterProbe(configuration, probeOptions);
          const replacedLiveModelId =
            (configuration.partialOptions !== true || configuration.replaceModelOptions === true) &&
            configuration.currentModelId !== null &&
            (probeOptions.models.some((model) => model.id === configuration.currentModelId) ||
              (configuration.cappedLastModel !== undefined &&
                configuration.cappedPrefixKey !== undefined &&
                cappedAcpRegistryModelPrefixKey(probeOptions.models.map((model) => model.id)) ===
                  configuration.cappedPrefixKey &&
                configuration.currentModelId === configuration.cappedLastModel.id &&
                (configuration.cappedTailIsOverflow === true ||
                  probeOptions.cappedTailIsOverflow === true)))
              ? configuration.currentModelId
              : null;
          const skipModelSlugs =
            replacedLiveModelId === null ? EMPTY_SLUG_SET : new Set([replacedLiveModelId]);
          const skipOptionIdsByModel = (() => {
            if (Option.isNone(effectiveConfiguration)) return undefined;
            const partial = effectiveConfiguration.value;
            const byModel = new Map<string, Set<string>>();
            const add = (slug: string, optionId: string) => {
              let ids = byModel.get(slug);
              if (ids === undefined) {
                ids = new Set();
                byModel.set(slug, ids);
              }
              ids.add(optionId);
            };
            if (partial.currentModelId !== null) {
              const partialModelOptionIds = new Set(partial.modelOptionIds ?? []);
              for (const descriptor of partial.configOptions) {
                if (isModelSpecificDescriptor(descriptor, partialModelOptionIds)) {
                  add(partial.currentModelId, descriptor.id);
                }
              }
            }
            if (partial.advertisedReasoning !== undefined) {
              for (const [slug, descriptor] of Object.entries(partial.advertisedReasoning)) {
                add(slug, descriptor.id);
              }
            }
            return byModel.size > 0 ? byModel : undefined;
          })();
          // Rebuild from the pure probe baseline so rejected values restore probe defaults,
          // other models preserve learned values, and dropped options on the reporting model clear.
          const pureBaseline = acceptedBefore.probeBaselineModels ?? acceptedBefore.models;
          const baselineModels = yield* Ref.get(learnedModels).pipe(
            Effect.map((learned) =>
              mergeLearnedModelOptions(pureBaseline, learned, {
                skipModelSlugs,
                ...(skipOptionIdsByModel === undefined ? {} : { skipOptionIdsByModel }),
                reasoningDisabledModelSlugs,
                overlayLearnedValues: true,
              }),
            ),
          );
          const baselineProvider =
            pureBaseline.length > 0 ? { ...current, models: baselineModels } : current;
          const probeSharedDescriptors = probeOptions.configOptions.filter(
            (descriptor) => !isModelSpecificDescriptor(descriptor, probeOptions.modelOptionIds),
          );
          const applied = yield* Option.match(effectiveConfiguration, {
            onNone: () =>
              replacedLiveModelId === null
                ? Effect.succeed(baselineProvider)
                : Ref.update(learnedModels, (learned) =>
                    updateAcpRegistryLearnedModelsFromLive(
                      learned,
                      baselineProvider.models,
                      {
                        models: [],
                        currentModelId: replacedLiveModelId,
                        configOptions: [],
                        modelOptionIds: Array.from(probeOptions.modelOptionIds),
                        modelsFromModelSelect: false,
                      },
                      reasoningDisabledModelSlugs,
                    ),
                  ).pipe(Effect.as(baselineProvider)),
            onSome: (partial) =>
              applyLiveConfiguration(baselineProvider, partial, {
                preserveSingleModelCatalog,
                reasoningDisabledModelSlugs,
                hasDiscoveredCatalog,
                replaceCurrentLearnedOptions: replacedLiveModelId !== null,
                probeSharedDescriptors,
                probeConfigOptions: probeOptions.configOptions,
              }),
          });
          yield* Ref.update(lastAppliedLiveRevision, (prev) => Math.max(prev, options.revision));
          return withPreservedStatus(applied);
        }

        const applied = yield* applyLiveConfiguration(current, configuration, {
          preserveSingleModelCatalog,
          reasoningDisabledModelSlugs,
          hasDiscoveredCatalog,
        });
        const next = withPreservedStatus(applied);
        const nextReasoningDisabled = replacesCatalog
          ? new Set(
              configuration.models
                .filter((model) => model.reasoningEffort === null)
                .map((model) => model.id),
            )
          : acceptedBefore.reasoningDisabledModelSlugs;
        const savedToAccepted =
          current.installed && (replacesCatalog || acceptedBefore.models.length > 0);
        if (savedToAccepted) {
          yield* Ref.update(acceptedCatalog, (previous) =>
            replacesCatalog
              ? {
                  models: next.models,
                  builtInModelCount: configuration.models.length,
                  modelsFromModelSelect: configuration.modelsFromModelSelect === true,
                  reasoningDisabledModelSlugs: nextReasoningDisabled,
                  probeOptions: null,
                  probeBaselineModels: null,
                }
              : {
                  ...previous,
                  models: next.models,
                },
          );
          yield* Ref.update(lastAppliedLiveRevision, (prev) => Math.max(prev, options.revision));
          if (configuration.models.length > 0) {
            yield* Ref.update(lastAppliedLiveCatalogRevision, (prev) =>
              Math.max(prev, options.revision),
            );
          }
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
            hasDiscoveredCatalog,
          }),
        );
        return next;
      },
    );
    const liveSnapshotSemaphore = yield* Semaphore.make(1);
    const withLiveRuntimeState = Effect.fn("AcpRegistryDriver.withLiveRuntimeState")(function* (
      input: ServerProvider,
      options?: {
        readonly applyLiveModels?: boolean;
        readonly recordLiveRevision?: boolean;
        readonly fallbackToAcceptedModels?: boolean;
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
      if (Option.isNone(runtimeCoordinator)) {
        return yield* applyAcceptedModelsFallback(provider);
      }
      const { commands, liveConfiguration, authAction } = yield* Effect.all({
        commands: runtimeCoordinator.value.getAvailableCommands(instanceId),
        liveConfiguration: runtimeCoordinator.value.getLiveConfigurationWithRevision(instanceId),
        authAction: runtimeCoordinator.value.getUrlAuthAction(instanceId),
      });
      const withBaseModels = yield* applyAcceptedModelsFallback(
        applyAcpRegistryAvailableCommands(provider, commands),
      );
      let withConfiguration = withBaseModels;
      if (
        options?.applyLiveModels !== false &&
        withBaseModels.enabled &&
        withBaseModels.installed
      ) {
        const accepted = yield* Ref.get(acceptedCatalog);
        const appliedCatalogRev = yield* Ref.get(lastAppliedLiveCatalogRevision);
        const appliedRev = yield* Ref.get(lastAppliedLiveRevision);
        const steps: Array<AcpRegistryRuntimeCoordinator.AcpRegistryRevisionedLiveConfiguration> =
          [];
        if (
          Option.isSome(liveConfiguration.catalog) &&
          liveConfiguration.catalog.value.revision > liveConfiguration.clearedThroughRevision &&
          liveConfiguration.catalog.value.revision > appliedCatalogRev
        ) {
          steps.push(liveConfiguration.catalog.value);
        }
        const hasNewCatalogStep = steps.length > 0;
        if (!(yield* Ref.get(signedOutState)).signedOut) {
          if (accepted.probeOptions !== null && !hasNewCatalogStep) {
            for (const entry of liveConfiguration.pendingOptions) {
              if (entry.revision > appliedRev) {
                steps.push(entry);
              }
            }
            const latestPending = liveConfiguration.pendingOptions.at(-1);
            if (latestPending !== undefined && steps.at(-1) !== latestPending) {
              steps.push(latestPending);
            }
          } else {
            for (const entry of liveConfiguration.pendingOptions) {
              if (entry.revision <= liveConfiguration.clearedThroughRevision) continue;
              if (!hasNewCatalogStep && entry.revision <= appliedRev) continue;
              steps.push(entry);
            }
          }
        }
        for (const step of steps) {
          withConfiguration = yield* applyLiveConfigurationStep(
            withConfiguration,
            step.configuration,
            {
              preserveStatus: options?.preserveStatus,
              revision: step.revision,
            },
          );
        }
        if (options?.recordLiveRevision === true) {
          yield* Ref.set(lastObservedLiveRevision, liveConfiguration.revision);
        }
      }
      return applyAcpRegistryUrlAuthAction(withConfiguration, authAction);
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
      const startState = yield* liveSnapshotSemaphore.withPermit(
        Effect.gen(function* () {
          const cacheState = yield* Ref.get(enrichmentCache);
          const cached = cacheState.entry;
          if (
            cached !== null &&
            isAcpRegistryCacheValid(
              cached,
              baseSnapshot.version,
              effectiveConfig.source === "local",
              yield* Clock.currentTimeMillis,
            )
          ) {
            return {
              kind: "cached" as const,
              cacheState,
              cached,
            };
          }
          const probeStartSignedOutEpoch = (yield* Ref.get(signedOutState)).epoch;
          const probeStartLive = Option.isSome(runtimeCoordinator)
            ? yield* runtimeCoordinator.value.getLiveConfigurationWithRevision(instanceId)
            : AcpRegistryRuntimeCoordinator.EMPTY_LIVE_CONFIGURATION_SNAPSHOT;
          return {
            kind: "fresh" as const,
            cacheState,
            probeStartSignedOutEpoch,
            probeStartLive,
          };
        }),
      );
      if (startState.kind === "cached") {
        return {
          provider: { ...startState.cached.provider, checkedAt: baseSnapshot.checkedAt },
          generation: startState.cacheState.generation,
          fresh: false,
          probeStartCatalogRevision: 0,
          probeStartSignedOutEpoch: 0,
          probedModels: [],
          probedConfigOptions: [],
          probedModelCount: 0,
          probedModelsFromModelSelect: false,
          probedCappedTailIsOverflow: false,
          probedCurrentModelId: null,
          probedModelOptionIds: EMPTY_SLUG_SET,
          reasoningDisabledModelSlugs: EMPTY_SLUG_SET,
        };
      }
      const enriched = yield* enrichProvider;
      return {
        provider: enriched.provider,
        generation: startState.cacheState.generation,
        fresh: true,
        probeStartCatalogRevision: startState.probeStartLive.catalogRevision,
        probeStartSignedOutEpoch: startState.probeStartSignedOutEpoch,
        probedModels: enriched.probedModels,
        probedConfigOptions: enriched.probedConfigOptions,
        probedModelCount: enriched.probedModelCount,
        probedModelsFromModelSelect: enriched.probedModelsFromModelSelect,
        probedCappedTailIsOverflow: enriched.probedCappedTailIsOverflow,
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
          probeStartCatalogRevision,
          probeStartSignedOutEpoch,
          probedModels,
          probedConfigOptions,
          probedModelCount,
          probedModelsFromModelSelect,
          probedCappedTailIsOverflow,
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
                const reopenedSignedOut =
                  fresh &&
                  provider.status === "ready" &&
                  (yield* Ref.modify(signedOutState, (state) =>
                    state.signedOut && state.epoch === probeStartSignedOutEpoch
                      ? ([true, { ...state, signedOut: false }] as const)
                      : ([false, state] as const),
                  ));
                if (
                  current.generation !== generation ||
                  (fresh && liveSnapshot.catalogRevision !== probeStartCatalogRevision)
                ) {
                  if (reopenedSignedOut) {
                    yield* getSnapshot.pipe(
                      Effect.flatMap((currentSnapshot) => withLiveRuntimeState(currentSnapshot)),
                      Effect.flatMap(publishSnapshot),
                    );
                  }
                  return;
                }
                let resolved = provider;
                if (!fresh) {
                  if (current.entry === null) return;
                  const accepted = yield* Ref.get(acceptedCatalog);
                  resolved = {
                    ...current.entry.provider,
                    checkedAt: provider.checkedAt,
                    ...(accepted.probeOptions === null &&
                    accepted.models.length > 0 &&
                    current.entry.provider.enabled &&
                    current.entry.provider.installed
                      ? { models: accepted.models }
                      : {}),
                  };
                }
                if (fresh && provider.status === "ready") {
                  const accepted = yield* Ref.get(acceptedCatalog);
                  const liveCatalog = Option.filter(
                    Option.map(liveSnapshot.catalog, (entry) => entry.configuration),
                    (configuration) =>
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
                  const probeOptionSchema: AcpRegistryProbeOptionSchema = {
                    models: probedModels,
                    currentModelId: probedCurrentModelId,
                    configOptions: probedConfigOptions,
                    modelOptionIds: probedModelOptionIds,
                    cappedTailIsOverflow: probedCappedTailIsOverflow,
                  };
                  // A fresh non-provisional probe supersedes any live session catalog observed before it started.
                  const clearedThrough = probeSupersedesLiveCatalog
                    ? Option.isSome(runtimeCoordinator)
                      ? yield* runtimeCoordinator.value.clearLiveConfigurationIfRevision(
                          instanceId,
                          {
                            catalogRevision: probeStartCatalogRevision,
                            retain: (live) =>
                              retainAcpRegistryLiveOptionsAfterProbe(live, probeOptionSchema),
                          },
                        )
                      : Option.some(0)
                    : Option.none<number>();
                  if (probeSupersedesLiveCatalog && Option.isNone(clearedThrough)) return;
                  if (effectiveConfig.source === "local") {
                    yield* Ref.set(reportedLocalVersion, provider.version);
                  }
                  if (!probeSupersedesLiveCatalog && accepted.models.length > 0) {
                    resolved = { ...provider, models: accepted.models };
                  } else {
                    const models = yield* Ref.modify(learnedModels, (learned) => {
                      const merged = mergeLearnedModelOptions(provider.models, learned, {
                        currentModelId: probedCurrentModelId,
                        reasoningDisabledModelSlugs,
                      });
                      const nextLearned = Option.isSome(clearedThrough)
                        ? updateAcpRegistryLearnedModelsFromProbe(learned, provider.models, {
                            currentModelId: probedCurrentModelId,
                            modelOptionIds: probedModelOptionIds,
                            reasoningDisabledModelSlugs,
                          })
                        : learned;
                      return [merged, nextLearned] as const;
                    });
                    resolved = models === provider.models ? provider : { ...provider, models };
                  }
                  if (Option.isSome(clearedThrough)) {
                    const supersededLiveSession =
                      clearedThrough.value > (yield* Ref.get(liveSessionResetRevision));
                    yield* resetAppliedLiveRevisions;
                    yield* Ref.set(acceptedCatalog, {
                      models: resolved.models,
                      builtInModelCount: probedModelCount,
                      modelsFromModelSelect: probedModelsFromModelSelect,
                      reasoningDisabledModelSlugs,
                      probeOptions: supersededLiveSession ? probeOptionSchema : null,
                      probeBaselineModels: supersededLiveSession ? provider.models : null,
                    });
                  }
                  const published = yield* withLiveRuntimeState(resolved);
                  const completedAt = yield* Clock.currentTimeMillis;
                  yield* Ref.update(enrichmentCache, (latestCache) => ({
                    ...latestCache,
                    entry: {
                      // Cache the winning catalog while keeping the retry TTL from the fresh probe.
                      provider: !probeSupersedesLiveCatalog
                        ? { ...resolved, models: published.models }
                        : resolved,
                      expiresAt: completedAt + acpRegistryProbeTtlMs(provider),
                    },
                  }));
                  yield* publishSnapshot(published);
                  return;
                }
                const isUnauthenticated = fresh && resolved.auth.status === "unauthenticated";
                if (isUnauthenticated) {
                  const clearedForSignOut = Option.isSome(runtimeCoordinator)
                    ? yield* runtimeCoordinator.value.clearLiveConfigurationIfRevision(instanceId, {
                        catalogRevision: probeStartCatalogRevision,
                      })
                    : Option.some(0);
                  if (Option.isNone(clearedForSignOut)) return;
                  yield* Ref.set(enrichmentCache, {
                    generation: current.generation + 1,
                    entry: null,
                  });
                  yield* clearLearnedModels;
                  yield* clearAcceptedCatalog;
                  yield* Ref.set(liveSessionResetRevision, clearedForSignOut.value);
                  yield* markSignedOut;
                  yield* resetAppliedLiveRevisions;
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
                      const clearedThroughRevision =
                        yield* runtimeCoordinator.value.getLiveConfigurationClearedThroughRevision(
                          instanceId,
                        );
                      const appliedRevision = yield* Ref.get(lastAppliedLiveRevision);
                      if (revision <= clearedThroughRevision || revision < appliedRevision) {
                        return;
                      }
                      const rawCurrent = yield* getSnapshot;
                      if (
                        !rawCurrent.installed ||
                        ((yield* Ref.get(signedOutState)).signedOut &&
                          configuration.models.length === 0)
                      ) {
                        return;
                      }
                      const accepted = yield* Ref.get(acceptedCatalog);
                      // Always base live updates on acceptedCatalog.models when no probe baseline is
                      // active, preserving both WeakMap overflow-tail identity and any newer catalog
                      // whose publish was dropped during a readiness generation handoff.
                      const current =
                        accepted.probeOptions === null && accepted.models.length > 0
                          ? { ...rawCurrent, models: accepted.models }
                          : rawCurrent;
                      const next = yield* applyLiveConfigurationStep(current, configuration, {
                        preserveStatus: current.status !== "ready",
                        revision,
                      });
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

    const clearCachedState = (options?: {
      readonly clearCommands?: boolean;
      readonly clearLiveConfiguration?: boolean;
      readonly clearConfirmedAuthentication?: boolean;
      readonly markSignedOut?: boolean;
    }) =>
      liveSnapshotSemaphore.withPermit(
        Effect.uninterruptible(
          (options?.clearConfirmedAuthentication === true
            ? confirmedAuthentication.set(false)
            : Effect.void
          ).pipe(
            Effect.andThen(invalidateEnrichmentCache),
            Effect.andThen(clearLearnedModels),
            Effect.andThen(clearAcceptedCatalog),
            Effect.andThen(options?.markSignedOut === true ? markSignedOut : advanceSignedOutEpoch),
            Effect.andThen(resetAppliedLiveRevisions),
            Effect.andThen(
              Option.isSome(runtimeCoordinator)
                ? (options?.clearLiveConfiguration === false
                    ? Effect.void
                    : runtimeCoordinator.value
                        .clearLiveConfiguration(instanceId)
                        .pipe(
                          Effect.flatMap((clearedThrough) =>
                            Ref.set(liveSessionResetRevision, clearedThrough),
                          ),
                        )
                  ).pipe(
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
    const clearLiveState = clearCachedState({
      clearCommands: true,
      clearConfirmedAuthentication: true,
    });
    const clearSignedOutState = clearCachedState({
      clearCommands: true,
      clearConfirmedAuthentication: true,
      markSignedOut: true,
    });
    const controller = yield* AcpRegistryAuth.makeAcpRegistryAuth({
      instanceId,
      settings: effectiveConfig,
      cwd: host.paths.cwd,
      environment: processEnvironment,
      onChanged: (authenticated) =>
        (authenticated
          ? liveSnapshotSemaphore.withPermit(
              Effect.uninterruptible(
                confirmedAuthentication
                  .set(true)
                  .pipe(Effect.andThen(invalidateEnrichmentCache), Effect.andThen(clearSignedOut)),
              ),
            )
          : clearSignedOutState
        ).pipe(Effect.andThen(snapshot.refresh), Effect.asVoid),
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(SecureRandom.SecureRandom, random),
    );
    const auth = {
      ...controller,
      invalidate: (controller.invalidate ?? Effect.void).pipe(
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
      // Keep coordinator live state on cache invalidation so probe-empty agents
      // preserve running session catalogs and probes that find models supersede them.
      invalidateCaches: clearCachedState({ clearLiveConfiguration: false }),
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
            Effect.tap(() => clearSignedOutState),
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
