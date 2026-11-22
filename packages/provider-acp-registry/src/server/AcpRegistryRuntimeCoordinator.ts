import {
  type AcpRegistryAcceptUrlAuthInput,
  type AcpRegistryUrlAuthAction,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  extractAcpRegistryAdvertisedReasoning,
  type AcpRegistryAvailableCommands,
  type AcpRegistryLiveConfiguration,
} from "./probe.ts";

function extractAdvertisedReasoning(
  configuration: AcpRegistryLiveConfiguration,
): AcpRegistryLiveConfiguration["advertisedReasoning"] {
  return (
    configuration.advertisedReasoning ??
    extractAcpRegistryAdvertisedReasoning(configuration.models, configuration.currentModelId)
  );
}

interface AvailableCommandsUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly commands: AcpRegistryAvailableCommands;
}

interface LiveConfigurationUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly configuration: AcpRegistryLiveConfiguration;
  readonly revision: number;
}

export interface AcpRegistryRevisionedLiveConfiguration {
  readonly configuration: AcpRegistryLiveConfiguration;
  readonly revision: number;
}

export interface AcpRegistryLiveConfigurationSnapshot {
  readonly catalog: Option.Option<AcpRegistryRevisionedLiveConfiguration>;
  readonly configuration: Option.Option<AcpRegistryLiveConfiguration>;
  readonly pendingOptions: ReadonlyArray<AcpRegistryRevisionedLiveConfiguration>;
  readonly revision: number;
  readonly catalogRevision: number;
  readonly clearedThroughRevision: number;
}

type AcpRegistryAdvertisedReasoningDescriptor = NonNullable<
  AcpRegistryLiveConfiguration["models"][number]["reasoningEffort"]
>;

interface StoredAdvertisedReasoning {
  readonly descriptor: AcpRegistryAdvertisedReasoningDescriptor;
  readonly revision: number;
  readonly partialOptions?: boolean;
}

interface StoredLiveConfiguration {
  readonly catalog: AcpRegistryRevisionedLiveConfiguration | null;
  readonly configuration: Option.Option<AcpRegistryLiveConfiguration>;
  readonly optionsByModel: ReadonlyMap<string | null, AcpRegistryRevisionedLiveConfiguration>;
  // Latest cross-model advertisedReasoning per model slug, independent of replaceable
  // optionsByModel entries keyed by currentModelId.
  readonly reasoningByModel: ReadonlyMap<string, StoredAdvertisedReasoning>;
  // Catalog-reasoning slugs superseded by a newer live observation.
  readonly catalogReasoningSupersededSlugs: ReadonlySet<string>;
  readonly revision: number;
  readonly catalogRevision: number;
  readonly clearedThroughRevision: number;
}

const MAX_TRACKED_MODEL_OPTIONS = 256;

const EMPTY_OPTIONS_BY_MODEL: ReadonlyMap<string | null, AcpRegistryRevisionedLiveConfiguration> =
  new Map();
const EMPTY_REASONING_BY_MODEL: ReadonlyMap<string, StoredAdvertisedReasoning> = new Map();
const EMPTY_SLUG_SET: ReadonlySet<string> = new Set();

export const EMPTY_LIVE_CONFIGURATION_SNAPSHOT: AcpRegistryLiveConfigurationSnapshot = {
  catalog: Option.none(),
  configuration: Option.none(),
  pendingOptions: [],
  revision: 0,
  catalogRevision: 0,
  clearedThroughRevision: 0,
};

const EMPTY_STORED_LIVE_CONFIGURATION: StoredLiveConfiguration = {
  catalog: null,
  configuration: Option.none(),
  optionsByModel: EMPTY_OPTIONS_BY_MODEL,
  reasoningByModel: EMPTY_REASONING_BY_MODEL,
  catalogReasoningSupersededSlugs: EMPTY_SLUG_SET,
  revision: 0,
  catalogRevision: 0,
  clearedThroughRevision: 0,
};

const sortedPendingOptions = (
  optionsByModel: ReadonlyMap<string | null, AcpRegistryRevisionedLiveConfiguration>,
): ReadonlyArray<AcpRegistryRevisionedLiveConfiguration> =>
  Array.from(optionsByModel.values()).sort((left, right) => left.revision - right.revision);

const stripAdvertisedReasoningSlugs = (
  entry: AcpRegistryRevisionedLiveConfiguration,
  supersededSlugs: ReadonlySet<string>,
): AcpRegistryRevisionedLiveConfiguration => {
  const reasoning = entry.configuration.advertisedReasoning;
  if (reasoning === undefined) return entry;
  let changed = false;
  const kept: Array<readonly [string, AcpRegistryAdvertisedReasoningDescriptor]> = [];
  for (const [slug, descriptor] of Object.entries(reasoning)) {
    if (supersededSlugs.has(slug)) {
      changed = true;
      continue;
    }
    kept.push([slug, descriptor]);
  }
  if (!changed) return entry;
  const { advertisedReasoning: _dropped, ...rest } = entry.configuration;
  return {
    revision: entry.revision,
    configuration:
      kept.length === 0 ? rest : { ...rest, advertisedReasoning: Object.fromEntries(kept) },
  };
};

const makeOrphanedReasoningConfiguration = (
  entries: ReadonlyArray<readonly [string, AcpRegistryAdvertisedReasoningDescriptor]>,
  partialOptions: boolean,
): AcpRegistryLiveConfiguration => ({
  models: [],
  modelsFromModelSelect: false,
  currentModelId: null,
  configOptions: [],
  advertisedReasoning: Object.fromEntries(entries),
  ...(partialOptions ? { partialOptions: true } : {}),
  preserveDefault: true,
});

const collectOrphanedReasoningSteps = (
  reasoningByModel: ReadonlyMap<string, StoredAdvertisedReasoning>,
  coveredReasoningSlugs: ReadonlySet<string>,
): ReadonlyArray<AcpRegistryRevisionedLiveConfiguration> => {
  if (reasoningByModel.size === 0) return [];
  const orphanedByRevision = new Map<
    number,
    {
      readonly entries: Array<readonly [string, AcpRegistryAdvertisedReasoningDescriptor]>;
      readonly partialOptions: boolean;
    }
  >();
  for (const [slug, tracked] of reasoningByModel) {
    if (coveredReasoningSlugs.has(slug)) continue;
    const existing = orphanedByRevision.get(tracked.revision);
    if (existing === undefined) {
      orphanedByRevision.set(tracked.revision, {
        entries: [[slug, tracked.descriptor]],
        partialOptions: tracked.partialOptions === true,
      });
    } else {
      existing.entries.push([slug, tracked.descriptor]);
    }
  }
  return Array.from(orphanedByRevision.entries())
    .sort(([leftRev], [rightRev]) => leftRev - rightRev)
    .map(([revision, bucket]) => ({
      revision,
      configuration: makeOrphanedReasoningConfiguration(bucket.entries, bucket.partialOptions),
    }));
};

const buildEffectivePendingOptions = (
  optionsByModel: ReadonlyMap<string | null, AcpRegistryRevisionedLiveConfiguration>,
  reasoningByModel: ReadonlyMap<string, StoredAdvertisedReasoning>,
): ReadonlyArray<AcpRegistryRevisionedLiveConfiguration> => {
  const pending = sortedPendingOptions(optionsByModel);
  if (reasoningByModel.size === 0) return pending;
  const coveredReasoningSlugs = new Set<string>();
  for (const entry of pending) {
    const reasoning = entry.configuration.advertisedReasoning;
    if (reasoning === undefined) continue;
    for (const slug of Object.keys(reasoning)) {
      coveredReasoningSlugs.add(slug);
    }
  }
  const orphaned = collectOrphanedReasoningSteps(reasoningByModel, coveredReasoningSlugs);
  if (orphaned.length === 0) return pending;
  return [...pending, ...orphaned].sort((left, right) => left.revision - right.revision);
};

const toPublicLiveConfigurationSnapshot = (
  entry: StoredLiveConfiguration,
): AcpRegistryLiveConfigurationSnapshot => ({
  catalog: entry.catalog === null ? Option.none() : Option.some(entry.catalog),
  configuration: entry.configuration,
  pendingOptions: buildEffectivePendingOptions(entry.optionsByModel, entry.reasoningByModel),
  revision: entry.revision,
  catalogRevision: entry.catalogRevision,
  clearedThroughRevision: entry.clearedThroughRevision,
});

interface UrlAuthActionUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly action: AcpRegistryUrlAuthAction | null;
}

const URL_AUTH_ACTION_TTL = Duration.minutes(10);

interface PendingUrlAuthAction {
  readonly action: AcpRegistryUrlAuthAction;
  readonly consent: Deferred.Deferred<boolean>;
  readonly expiresAt: DateTime.Utc;
}

export class AcpRegistryRuntimeCoordinator extends Context.Service<
  AcpRegistryRuntimeCoordinator,
  {
    readonly withForegroundStartup: <A, E, R>(
      agentId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly runBackgroundProbe: <A, E, R>(
      agentId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
    readonly withSessionMutation: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly clearAvailableCommands: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
    readonly publishAvailableCommands: (
      instanceId: ProviderInstanceId,
      commands: AcpRegistryAvailableCommands,
    ) => Effect.Effect<void>;
    readonly getAvailableCommands: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<Option.Option<AcpRegistryAvailableCommands>>;
    readonly watchAvailableCommands: (
      instanceId: ProviderInstanceId,
      onUpdate: (commands: AcpRegistryAvailableCommands) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly clearLiveConfiguration: (instanceId: ProviderInstanceId) => Effect.Effect<number>;
    readonly clearLiveConfigurationIfRevision: (
      instanceId: ProviderInstanceId,
      options: {
        readonly catalogRevision: number;
        readonly retain?: (
          configuration: AcpRegistryLiveConfiguration,
        ) => Option.Option<AcpRegistryLiveConfiguration>;
      },
    ) => Effect.Effect<Option.Option<number>>;
    readonly publishLiveConfiguration: (
      instanceId: ProviderInstanceId,
      configuration: AcpRegistryLiveConfiguration,
    ) => Effect.Effect<void>;
    readonly getLiveConfiguration: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<Option.Option<AcpRegistryLiveConfiguration>>;
    readonly getLiveConfigurationClearedThroughRevision: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<number>;
    readonly getLiveConfigurationWithRevision: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<AcpRegistryLiveConfigurationSnapshot>;
    readonly watchLiveConfiguration: (
      instanceId: ProviderInstanceId,
      onUpdate: (
        configuration: AcpRegistryLiveConfiguration,
        revision: number,
      ) => Effect.Effect<void>,
      options?: { readonly afterRevision?: number },
    ) => Effect.Effect<void>;
    readonly requestUrlAuthentication: (
      instanceId: ProviderInstanceId,
      action: AcpRegistryUrlAuthAction,
    ) => Effect.Effect<boolean>;
    readonly acceptUrlAuthentication: (
      input: AcpRegistryAcceptUrlAuthInput,
    ) => Effect.Effect<boolean>;
    readonly getUrlAuthAction: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<Option.Option<AcpRegistryUrlAuthAction>>;
    readonly watchUrlAuthAction: (
      instanceId: ProviderInstanceId,
      onUpdate: (action: AcpRegistryUrlAuthAction | null) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator") {}

const make = Effect.gen(function* () {
  const foregroundStarts = yield* PubSub.unbounded<string>();
  const activeForegroundCounts = yield* Ref.make(new Map<string, number>());
  const availableCommandsUpdates = yield* PubSub.unbounded<AvailableCommandsUpdate>();
  const availableCommandsByInstance = yield* Ref.make(
    new Map<ProviderInstanceId, AcpRegistryAvailableCommands>(),
  );
  const liveConfigurationUpdates = yield* PubSub.unbounded<LiveConfigurationUpdate>();
  const liveConfigurations = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, StoredLiveConfiguration>
  >(new Map());
  const urlAuthActionUpdates = yield* PubSub.unbounded<UrlAuthActionUpdate>();
  const pendingUrlAuthActions = yield* Ref.make(
    new Map<ProviderInstanceId, PendingUrlAuthAction>(),
  );
  const liveConfigurationPublishPermit = yield* Semaphore.make(1);
  const urlAuthActionPermit = yield* Semaphore.make(1);
  const sessionMutationPermit = yield* Semaphore.make(1);

  const withForegroundStartup: AcpRegistryRuntimeCoordinator["Service"]["withForegroundStartup"] = (
    agentId,
    effect,
  ) =>
    Effect.acquireUseRelease(
      Ref.update(activeForegroundCounts, (current) => {
        const next = new Map(current);
        next.set(agentId, (next.get(agentId) ?? 0) + 1);
        return next;
      }).pipe(Effect.andThen(PubSub.publish(foregroundStarts, agentId))),
      () => effect,
      () =>
        Ref.update(activeForegroundCounts, (current) => {
          const next = new Map(current);
          const remaining = (next.get(agentId) ?? 1) - 1;
          if (remaining <= 0) next.delete(agentId);
          else next.set(agentId, remaining);
          return next;
        }),
    );

  const runBackgroundProbe: AcpRegistryRuntimeCoordinator["Service"]["runBackgroundProbe"] = (
    agentId,
    effect,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Subscribe first so foreground starts cannot slip between the state check and probe.
        const subscription = yield* PubSub.subscribe(foregroundStarts);
        if ((yield* Ref.get(activeForegroundCounts)).has(agentId)) {
          return Option.none();
        }
        const foregroundStarted = Stream.fromSubscription(subscription).pipe(
          Stream.filter((candidate) => candidate === agentId),
          Stream.runHead,
          Effect.as(Option.none()),
        );
        return yield* Effect.raceFirst(effect.pipe(Effect.asSome), foregroundStarted);
      }),
    );

  const withSessionMutation: AcpRegistryRuntimeCoordinator["Service"]["withSessionMutation"] = (
    effect,
  ) => sessionMutationPermit.withPermit(effect);

  const clearAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["clearAvailableCommands"] =
    (instanceId) =>
      Ref.update(availableCommandsByInstance, (current) => {
        const next = new Map(current);
        next.delete(instanceId);
        return next;
      });

  const publishAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["publishAvailableCommands"] =
    (instanceId, commands) =>
      Ref.update(availableCommandsByInstance, (current) => {
        const next = new Map(current);
        next.set(instanceId, commands);
        return next;
      }).pipe(
        Effect.andThen(
          PubSub.publish(availableCommandsUpdates, {
            instanceId,
            commands,
          }),
        ),
        Effect.asVoid,
      );

  const getAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["getAvailableCommands"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.getAvailableCommands")(function* (instanceId) {
      return Option.fromNullishOr((yield* Ref.get(availableCommandsByInstance)).get(instanceId));
    });

  const watchAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["watchAvailableCommands"] =
    (instanceId, onUpdate) =>
      Effect.scoped(
        Effect.gen(function* () {
          // Subscribe before reading to avoid missing publications.
          const subscription = yield* PubSub.subscribe(availableCommandsUpdates);
          const current = yield* getAvailableCommands(instanceId);
          if (Option.isSome(current)) {
            yield* onUpdate(current.value);
          }
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((update) => update.instanceId === instanceId),
            Stream.runForEach((update) => onUpdate(update.commands)),
          );
        }),
      );

  const clearLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["clearLiveConfiguration"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.clearLiveConfiguration")(function* (instanceId) {
      return yield* Ref.modify(liveConfigurations, (state) => {
        const current = state.get(instanceId);
        if (current === undefined) return [0, state] as const;
        const nextCleared = Math.max(current.clearedThroughRevision, current.revision);
        if (
          current.catalog === null &&
          Option.isNone(current.configuration) &&
          current.optionsByModel.size === 0 &&
          current.reasoningByModel.size === 0 &&
          current.catalogReasoningSupersededSlugs.size === 0 &&
          nextCleared === current.clearedThroughRevision
        ) {
          return [nextCleared, state] as const;
        }
        const next = new Map(state);
        next.set(instanceId, {
          ...current,
          catalog: null,
          configuration: Option.none(),
          optionsByModel: EMPTY_OPTIONS_BY_MODEL,
          reasoningByModel: EMPTY_REASONING_BY_MODEL,
          catalogReasoningSupersededSlugs: EMPTY_SLUG_SET,
          clearedThroughRevision: nextCleared,
        });
        return [nextCleared, next] as const;
      });
    });

  const clearLiveConfigurationIfRevision: AcpRegistryRuntimeCoordinator["Service"]["clearLiveConfigurationIfRevision"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.clearLiveConfigurationIfRevision")(
      function* (instanceId, options) {
        return yield* Ref.modify(liveConfigurations, (state) => {
          const current = state.get(instanceId) ?? EMPTY_STORED_LIVE_CONFIGURATION;
          if (current.catalogRevision !== options.catalogRevision) {
            return [Option.none(), state] as const;
          }
          // Every revision through current.revision is either cleared or reconciled by retain.
          const nextCleared = Math.max(current.clearedThroughRevision, current.revision);
          const retain = options.retain;
          const { nextOptionsByModel, nextReasoningByModel } = (() => {
            if (retain === undefined) {
              return {
                nextOptionsByModel: EMPTY_OPTIONS_BY_MODEL,
                nextReasoningByModel: EMPTY_REASONING_BY_MODEL,
              };
            }
            const candidates = new Map<string | null, AcpRegistryRevisionedLiveConfiguration>();
            const catalogReasoning =
              current.catalog === null
                ? undefined
                : extractAdvertisedReasoning(current.catalog.configuration);
            const preservedCatalogReasoning = (() => {
              if (catalogReasoning === undefined) return undefined;
              const entries = Object.entries(catalogReasoning).filter(
                ([slug]) => !current.catalogReasoningSupersededSlugs.has(slug),
              );
              return entries.length > 0 ? Object.fromEntries(entries) : undefined;
            })();
            if (current.catalog !== null) {
              const { advertisedReasoning: _droppedCatalogReasoning, ...catalogRest } =
                current.catalog.configuration;
              candidates.set(current.catalog.configuration.currentModelId, {
                revision: current.catalog.revision,
                configuration: {
                  ...catalogRest,
                  models: [],
                  modelsFromModelSelect: false,
                  ...(preservedCatalogReasoning === undefined
                    ? {}
                    : { advertisedReasoning: preservedCatalogReasoning }),
                },
              });
            }
            for (const [key, entry] of current.optionsByModel) {
              if (
                preservedCatalogReasoning !== undefined &&
                current.catalog !== null &&
                key === current.catalog.configuration.currentModelId
              ) {
                candidates.set(key, {
                  revision: entry.revision,
                  configuration: {
                    ...entry.configuration,
                    advertisedReasoning: {
                      ...preservedCatalogReasoning,
                      ...entry.configuration.advertisedReasoning,
                    },
                  },
                });
                continue;
              }
              candidates.set(key, entry);
            }
            const coveredReasoningSlugs = new Set<string>();
            if (current.reasoningByModel.size > 0) {
              for (const entry of candidates.values()) {
                const reasoning = entry.configuration.advertisedReasoning;
                if (reasoning === undefined) continue;
                for (const slug of Object.keys(reasoning)) {
                  coveredReasoningSlugs.add(slug);
                }
              }
            }
            const steps: Array<{
              readonly entry: AcpRegistryRevisionedLiveConfiguration;
              readonly isOrphan: boolean;
            }> = [
              ...sortedPendingOptions(candidates).map((entry) => ({ entry, isOrphan: false })),
              ...collectOrphanedReasoningSteps(current.reasoningByModel, coveredReasoningSlugs).map(
                (entry) => ({ entry, isOrphan: true }),
              ),
            ].sort((left, right) => left.entry.revision - right.entry.revision);
            const retained = new Map<string | null, AcpRegistryRevisionedLiveConfiguration>();
            const retainedReasoning = new Map<string, StoredAdvertisedReasoning>();
            const recordRetainedReasoning = (
              advertisedReasoning: AcpRegistryLiveConfiguration["advertisedReasoning"],
              revision: number,
              excludeSlug: string | null,
              partialOptions: boolean,
            ) => {
              if (advertisedReasoning === undefined) return;
              for (const [slug, descriptor] of Object.entries(advertisedReasoning)) {
                if (slug === excludeSlug) continue;
                retainedReasoning.delete(slug);
                retainedReasoning.set(slug, {
                  descriptor,
                  revision,
                  ...(partialOptions ? { partialOptions: true } : {}),
                });
              }
            };
            for (const { entry, isOrphan } of steps) {
              const kept = retain({
                ...entry.configuration,
                models: [],
                modelsFromModelSelect: false,
              });
              if (Option.isNone(kept)) continue;
              if (isOrphan) {
                recordRetainedReasoning(
                  kept.value.advertisedReasoning,
                  entry.revision,
                  null,
                  kept.value.partialOptions === true,
                );
                continue;
              }
              if (entry.revision < current.revision) {
                // Earlier models keep only model-specific options, advertised reasoning,
                // replacement intent, and displaced-tail metadata without stealing default or shared options.
                const modelOptionIds = new Set(kept.value.modelOptionIds ?? []);
                const modelOnlyOptions = kept.value.configOptions.filter((descriptor) =>
                  modelOptionIds.has(descriptor.id),
                );
                const hasAdvertisedReasoning =
                  kept.value.advertisedReasoning !== undefined &&
                  Object.keys(kept.value.advertisedReasoning).length > 0;
                if (
                  modelOnlyOptions.length === 0 &&
                  !hasAdvertisedReasoning &&
                  kept.value.replaceModelOptions !== true
                ) {
                  continue;
                }
                const keepDisplacedTailModel =
                  kept.value.cappedLastModel !== undefined &&
                  kept.value.cappedPrefixKey !== undefined &&
                  kept.value.cappedLastModel.id === kept.value.currentModelId;
                const { cappedLastModel, cappedPrefixKey, cappedTailIsOverflow, ...rest } =
                  kept.value;
                const retainedConfig: AcpRegistryLiveConfiguration = {
                  ...rest,
                  configOptions: modelOnlyOptions,
                  modelOptionIds: modelOnlyOptions.map((descriptor) => descriptor.id),
                  preserveDefault: true,
                  ...(keepDisplacedTailModel
                    ? {
                        cappedPrefixKey,
                        cappedLastModel,
                        ...(cappedTailIsOverflow === true ? { cappedTailIsOverflow: true } : {}),
                      }
                    : {}),
                };
                retained.delete(kept.value.currentModelId);
                retained.set(kept.value.currentModelId, {
                  configuration: retainedConfig,
                  revision: entry.revision,
                });
                recordRetainedReasoning(
                  retainedConfig.advertisedReasoning,
                  entry.revision,
                  retainedConfig.currentModelId,
                  retainedConfig.partialOptions === true,
                );
                continue;
              }
              retained.delete(kept.value.currentModelId);
              retained.set(kept.value.currentModelId, {
                configuration: kept.value,
                revision: entry.revision,
              });
              recordRetainedReasoning(
                kept.value.advertisedReasoning,
                entry.revision,
                kept.value.currentModelId,
                kept.value.partialOptions === true,
              );
            }
            while (retained.size > MAX_TRACKED_MODEL_OPTIONS) {
              const oldestKey = retained.keys().next().value;
              if (oldestKey === undefined) break;
              retained.delete(oldestKey);
            }
            while (retainedReasoning.size > MAX_TRACKED_MODEL_OPTIONS) {
              const oldestKey = retainedReasoning.keys().next().value;
              if (oldestKey === undefined) break;
              retainedReasoning.delete(oldestKey);
            }
            return {
              nextOptionsByModel: retained.size === 0 ? EMPTY_OPTIONS_BY_MODEL : retained,
              nextReasoningByModel:
                retainedReasoning.size === 0 ? EMPTY_REASONING_BY_MODEL : retainedReasoning,
            };
          })();
          const nextPending = buildEffectivePendingOptions(
            nextOptionsByModel,
            nextReasoningByModel,
          );
          const lastRetained = nextPending.at(-1);
          const nextConfiguration: Option.Option<AcpRegistryLiveConfiguration> =
            lastRetained === undefined || lastRetained.configuration.preserveDefault === true
              ? Option.none()
              : Option.some(lastRetained.configuration);
          if (
            current.catalog === null &&
            current.catalogReasoningSupersededSlugs.size === 0 &&
            Equal.equals(current.configuration, nextConfiguration) &&
            Equal.equals(
              sortedPendingOptions(current.optionsByModel),
              sortedPendingOptions(nextOptionsByModel),
            ) &&
            Equal.equals(
              Array.from(current.reasoningByModel.entries()),
              Array.from(nextReasoningByModel.entries()),
            ) &&
            nextCleared === current.clearedThroughRevision
          ) {
            return [Option.some(nextCleared), state] as const;
          }
          const next = new Map(state);
          next.set(instanceId, {
            ...current,
            catalog: null,
            configuration: nextConfiguration,
            optionsByModel: nextOptionsByModel,
            reasoningByModel: nextReasoningByModel,
            catalogReasoningSupersededSlugs: EMPTY_SLUG_SET,
            clearedThroughRevision: nextCleared,
          });
          return [Option.some(nextCleared), next] as const;
        });
      },
    );

  const publishLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["publishLiveConfiguration"] =
    (instanceId, configuration) =>
      // Serialize store + PubSub publish uninterruptibly so concurrent sessions emit in revision order.
      liveConfigurationPublishPermit.withPermit(
        Effect.uninterruptible(
          Ref.modify(liveConfigurations, (state) => {
            const current = state.get(instanceId) ?? EMPTY_STORED_LIVE_CONFIGURATION;
            const revision = current.revision + 1;
            const hasCatalog = configuration.models.length > 0;
            const catalogRevision = hasCatalog
              ? current.catalogRevision + 1
              : current.catalogRevision;
            // Keep the active catalog and per-model options separate; a new catalog replaces
            // prior per-model options while options-only updates preserve earlier models' entries.
            const catalog = hasCatalog ? { configuration, revision } : current.catalog;
            const incoming = configuration.advertisedReasoning;
            const incomingEntries =
              incoming === undefined
                ? []
                : Object.entries(incoming).filter(
                    ([slug]) => slug !== configuration.currentModelId,
                  );
            const supersededSlugs = new Set<string>();
            if (configuration.currentModelId !== null) {
              supersededSlugs.add(configuration.currentModelId);
            }
            for (const [slug] of incomingEntries) {
              supersededSlugs.add(slug);
            }
            const optionsByModel = hasCatalog
              ? EMPTY_OPTIONS_BY_MODEL
              : (() => {
                  const updated = new Map<string | null, AcpRegistryRevisionedLiveConfiguration>();
                  for (const [key, entry] of current.optionsByModel) {
                    if (key === configuration.currentModelId) continue;
                    updated.set(
                      key,
                      supersededSlugs.size === 0
                        ? entry
                        : stripAdvertisedReasoningSlugs(entry, supersededSlugs),
                    );
                  }
                  updated.set(configuration.currentModelId, { configuration, revision });
                  while (updated.size > MAX_TRACKED_MODEL_OPTIONS) {
                    const oldestKey = updated.keys().next().value;
                    if (oldestKey === undefined) break;
                    updated.delete(oldestKey);
                  }
                  return updated;
                })();
            const reasoningByModel = hasCatalog
              ? EMPTY_REASONING_BY_MODEL
              : (() => {
                  const hasSelfToDelete =
                    configuration.currentModelId !== null &&
                    current.reasoningByModel.has(configuration.currentModelId);
                  if (!hasSelfToDelete && incomingEntries.length === 0) {
                    return current.reasoningByModel;
                  }
                  const updated = new Map(current.reasoningByModel);
                  if (configuration.currentModelId !== null) {
                    updated.delete(configuration.currentModelId);
                  }
                  for (const [slug, descriptor] of incomingEntries) {
                    updated.delete(slug);
                    updated.set(slug, { descriptor, revision });
                  }
                  while (updated.size > MAX_TRACKED_MODEL_OPTIONS) {
                    const oldestKey = updated.keys().next().value;
                    if (oldestKey === undefined) break;
                    updated.delete(oldestKey);
                  }
                  return updated.size === 0 ? EMPTY_REASONING_BY_MODEL : updated;
                })();
            const catalogReasoningSupersededSlugs = hasCatalog
              ? EMPTY_SLUG_SET
              : (() => {
                  const catalogReasoning =
                    current.catalog === null
                      ? undefined
                      : extractAdvertisedReasoning(current.catalog.configuration);
                  if (catalogReasoning === undefined) {
                    return current.catalogReasoningSupersededSlugs;
                  }
                  const added: Array<string> = [];
                  if (
                    configuration.currentModelId !== null &&
                    Object.hasOwn(catalogReasoning, configuration.currentModelId) &&
                    !current.catalogReasoningSupersededSlugs.has(configuration.currentModelId)
                  ) {
                    added.push(configuration.currentModelId);
                  }
                  if (configuration.advertisedReasoning !== undefined) {
                    for (const slug of Object.keys(configuration.advertisedReasoning)) {
                      if (
                        Object.hasOwn(catalogReasoning, slug) &&
                        !current.catalogReasoningSupersededSlugs.has(slug)
                      ) {
                        added.push(slug);
                      }
                    }
                  }
                  if (added.length === 0) return current.catalogReasoningSupersededSlugs;
                  const updated = new Set(current.catalogReasoningSupersededSlugs);
                  for (const slug of added) updated.add(slug);
                  return updated;
                })();
            const next = new Map(state);
            next.set(instanceId, {
              catalog,
              configuration: Option.some(configuration),
              optionsByModel,
              reasoningByModel,
              catalogReasoningSupersededSlugs,
              revision,
              catalogRevision,
              clearedThroughRevision: current.clearedThroughRevision,
            });
            return [revision, next] as const;
          }).pipe(
            Effect.flatMap((revision) =>
              PubSub.publish(liveConfigurationUpdates, {
                instanceId,
                configuration,
                revision,
              }),
            ),
            Effect.asVoid,
          ),
        ),
      );

  const getLiveConfigurationWithRevision: AcpRegistryRuntimeCoordinator["Service"]["getLiveConfigurationWithRevision"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.getLiveConfigurationWithRevision")(
      function* (instanceId) {
        const entry = (yield* Ref.get(liveConfigurations)).get(instanceId);
        return entry === undefined
          ? EMPTY_LIVE_CONFIGURATION_SNAPSHOT
          : toPublicLiveConfigurationSnapshot(entry);
      },
    );

  const getLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["getLiveConfiguration"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.getLiveConfiguration")(function* (instanceId) {
      return (yield* Ref.get(liveConfigurations)).get(instanceId)?.configuration ?? Option.none();
    });

  const getLiveConfigurationClearedThroughRevision: AcpRegistryRuntimeCoordinator["Service"]["getLiveConfigurationClearedThroughRevision"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.getLiveConfigurationClearedThroughRevision")(
      function* (instanceId) {
        return (yield* Ref.get(liveConfigurations)).get(instanceId)?.clearedThroughRevision ?? 0;
      },
    );

  const watchLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["watchLiveConfiguration"] =
    (instanceId, onUpdate, options) =>
      Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(liveConfigurationUpdates);
          const current = (yield* Ref.get(liveConfigurations)).get(instanceId);
          let deliveredRevision = options?.afterRevision ?? 0;
          if (current !== undefined) {
            if (current.catalog !== null && current.catalog.revision > deliveredRevision) {
              deliveredRevision = current.catalog.revision;
              yield* onUpdate(current.catalog.configuration, current.catalog.revision);
            }
            for (const entry of buildEffectivePendingOptions(
              current.optionsByModel,
              current.reasoningByModel,
            )) {
              if (entry.revision <= deliveredRevision) continue;
              deliveredRevision = entry.revision;
              yield* onUpdate(entry.configuration, entry.revision);
            }
          }
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((update) => update.instanceId === instanceId),
            Stream.runForEach((update) => {
              if (update.revision <= deliveredRevision) return Effect.void;
              deliveredRevision = update.revision;
              return onUpdate(update.configuration, update.revision);
            }),
          );
        }),
      );

  const publishUrlAuthAction = (
    instanceId: ProviderInstanceId,
    action: AcpRegistryUrlAuthAction | null,
  ) => PubSub.publish(urlAuthActionUpdates, { instanceId, action }).pipe(Effect.asVoid);

  const requestUrlAuthentication: AcpRegistryRuntimeCoordinator["Service"]["requestUrlAuthentication"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.requestUrlAuthentication")(
      function* (instanceId, action) {
        const consent = yield* Deferred.make<boolean>();
        const createdAt = yield* DateTime.now;
        const expiresAt = DateTime.addDuration(createdAt, URL_AUTH_ACTION_TTL);
        const publishedAction = {
          ...action,
          createdAt: DateTime.formatIso(createdAt),
          expiresAt: DateTime.formatIso(expiresAt),
        } satisfies AcpRegistryUrlAuthAction;
        const cleanup = Ref.modify(pendingUrlAuthActions, (current) => {
          if (current.get(instanceId)?.consent !== consent) {
            return [false, current] as const;
          }
          const next = new Map(current);
          next.delete(instanceId);
          return [true, next] as const;
        }).pipe(
          Effect.flatMap((removed) =>
            removed ? publishUrlAuthAction(instanceId, null) : Effect.void,
          ),
        );
        return yield* Effect.gen(function* () {
          yield* urlAuthActionPermit.withPermits(1)(
            Effect.gen(function* () {
              const previous = yield* Ref.modify(pendingUrlAuthActions, (current) => {
                const next = new Map(current);
                const existing = next.get(instanceId);
                next.set(instanceId, { action: publishedAction, consent, expiresAt });
                return [existing, next] as const;
              });
              if (previous !== undefined) {
                yield* Deferred.succeed(previous.consent, false).pipe(Effect.ignore);
              }
              yield* publishUrlAuthAction(instanceId, publishedAction);
            }),
          );
          return yield* Deferred.await(consent).pipe(
            Effect.timeoutOrElse({
              duration: URL_AUTH_ACTION_TTL,
              orElse: () => Effect.succeed(false),
            }),
          );
        }).pipe(Effect.ensuring(cleanup));
      },
    );

  const acceptUrlAuthentication: AcpRegistryRuntimeCoordinator["Service"]["acceptUrlAuthentication"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.acceptUrlAuthentication")(function* (input) {
      const pending = (yield* Ref.get(pendingUrlAuthActions)).get(input.instanceId);
      if (pending?.action.elicitationId !== input.elicitationId) return false;
      if (DateTime.isGreaterThanOrEqualTo(yield* DateTime.now, pending.expiresAt)) {
        yield* Deferred.succeed(pending.consent, false).pipe(Effect.ignore);
        return false;
      }
      return yield* Deferred.succeed(pending.consent, true);
    });

  const getUrlAuthAction: AcpRegistryRuntimeCoordinator["Service"]["getUrlAuthAction"] = Effect.fn(
    "AcpRegistryRuntimeCoordinator.getUrlAuthAction",
  )(function* (instanceId) {
    return Option.fromNullishOr((yield* Ref.get(pendingUrlAuthActions)).get(instanceId)?.action);
  });

  const watchUrlAuthAction: AcpRegistryRuntimeCoordinator["Service"]["watchUrlAuthAction"] = (
    instanceId,
    onUpdate,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(urlAuthActionUpdates);
        const current = yield* getUrlAuthAction(instanceId);
        if (Option.isSome(current)) {
          yield* onUpdate(current.value);
        }
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.filter((update) => update.instanceId === instanceId),
          Stream.runForEach((update) => onUpdate(update.action)),
        );
      }),
    );

  return AcpRegistryRuntimeCoordinator.of({
    withForegroundStartup,
    runBackgroundProbe,
    withSessionMutation,
    clearAvailableCommands,
    publishAvailableCommands,
    getAvailableCommands,
    watchAvailableCommands,
    clearLiveConfiguration,
    clearLiveConfigurationIfRevision,
    publishLiveConfiguration,
    getLiveConfiguration,
    getLiveConfigurationClearedThroughRevision,
    getLiveConfigurationWithRevision,
    watchLiveConfiguration,
    requestUrlAuthentication,
    acceptUrlAuthentication,
    getUrlAuthAction,
    watchUrlAuthAction,
  });
});

export const layer = Layer.effect(AcpRegistryRuntimeCoordinator, make);
