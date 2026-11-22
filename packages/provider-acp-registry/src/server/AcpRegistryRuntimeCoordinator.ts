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

import type { AcpRegistryAvailableCommands, AcpRegistryLiveConfiguration } from "./probe.ts";

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

interface StoredLiveConfiguration {
  readonly catalog: AcpRegistryRevisionedLiveConfiguration | null;
  readonly configuration: Option.Option<AcpRegistryLiveConfiguration>;
  readonly optionsByModel: ReadonlyMap<string | null, AcpRegistryRevisionedLiveConfiguration>;
  readonly revision: number;
  readonly catalogRevision: number;
  readonly clearedThroughRevision: number;
}

const MAX_TRACKED_MODEL_OPTIONS = 256;

const EMPTY_OPTIONS_BY_MODEL: ReadonlyMap<string | null, AcpRegistryRevisionedLiveConfiguration> =
  new Map();

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
  revision: 0,
  catalogRevision: 0,
  clearedThroughRevision: 0,
};

const sortedPendingOptions = (
  optionsByModel: ReadonlyMap<string | null, AcpRegistryRevisionedLiveConfiguration>,
): ReadonlyArray<AcpRegistryRevisionedLiveConfiguration> =>
  Array.from(optionsByModel.values()).sort((left, right) => left.revision - right.revision);

const toPublicLiveConfigurationSnapshot = (
  entry: StoredLiveConfiguration,
): AcpRegistryLiveConfigurationSnapshot => ({
  catalog: entry.catalog === null ? Option.none() : Option.some(entry.catalog),
  configuration: entry.configuration,
  pendingOptions: sortedPendingOptions(entry.optionsByModel),
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
    readonly clearLiveConfiguration: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
    readonly clearLiveConfigurationIfRevision: (
      instanceId: ProviderInstanceId,
      options: {
        readonly catalogRevision: number;
        readonly retain?: (
          configuration: AcpRegistryLiveConfiguration,
        ) => Option.Option<AcpRegistryLiveConfiguration>;
      },
    ) => Effect.Effect<boolean>;
    readonly publishLiveConfiguration: (
      instanceId: ProviderInstanceId,
      configuration: AcpRegistryLiveConfiguration,
    ) => Effect.Effect<void>;
    readonly getLiveConfiguration: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<Option.Option<AcpRegistryLiveConfiguration>>;
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
    (instanceId) =>
      Ref.update(liveConfigurations, (state) => {
        const current = state.get(instanceId);
        if (current === undefined) return state;
        const nextCleared = Math.max(current.clearedThroughRevision, current.revision);
        if (
          current.catalog === null &&
          Option.isNone(current.configuration) &&
          current.optionsByModel.size === 0 &&
          nextCleared === current.clearedThroughRevision
        ) {
          return state;
        }
        const next = new Map(state);
        next.set(instanceId, {
          ...current,
          catalog: null,
          configuration: Option.none(),
          optionsByModel: EMPTY_OPTIONS_BY_MODEL,
          clearedThroughRevision: nextCleared,
        });
        return next;
      });

  const clearLiveConfigurationIfRevision: AcpRegistryRuntimeCoordinator["Service"]["clearLiveConfigurationIfRevision"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.clearLiveConfigurationIfRevision")(
      function* (instanceId, options) {
        return yield* Ref.modify(liveConfigurations, (state) => {
          const current = state.get(instanceId) ?? EMPTY_STORED_LIVE_CONFIGURATION;
          if (current.catalogRevision !== options.catalogRevision) {
            return [false, state] as const;
          }
          // Every revision through current.revision is either cleared or reconciled by retain.
          const nextCleared = Math.max(current.clearedThroughRevision, current.revision);
          const retain = options.retain;
          const nextOptionsByModel: ReadonlyMap<
            string | null,
            AcpRegistryRevisionedLiveConfiguration
          > = (() => {
            if (retain === undefined) return EMPTY_OPTIONS_BY_MODEL;
            const candidates = new Map<string | null, AcpRegistryRevisionedLiveConfiguration>();
            if (current.catalog !== null) {
              candidates.set(current.catalog.configuration.currentModelId, {
                configuration: {
                  ...current.catalog.configuration,
                  models: [],
                  modelsFromModelSelect: false,
                },
                revision: current.catalog.revision,
              });
            }
            for (const [key, entry] of current.optionsByModel) {
              candidates.set(key, entry);
            }
            const retained = new Map<string | null, AcpRegistryRevisionedLiveConfiguration>();
            for (const entry of sortedPendingOptions(candidates)) {
              const kept = retain({
                ...entry.configuration,
                models: [],
                modelsFromModelSelect: false,
              });
              if (Option.isNone(kept)) continue;
              if (entry.revision < current.revision) {
                // Earlier models keep only model-specific options without stealing default selection or shared options.
                const modelOptionIds = new Set(kept.value.modelOptionIds ?? []);
                const modelOnlyOptions = kept.value.configOptions.filter((descriptor) =>
                  modelOptionIds.has(descriptor.id),
                );
                if (modelOnlyOptions.length === 0) continue;
                const {
                  cappedLastModel: _droppedOverflow,
                  cappedPrefixKey: _droppedPrefix,
                  ...rest
                } = kept.value;
                retained.delete(kept.value.currentModelId);
                retained.set(kept.value.currentModelId, {
                  configuration: {
                    ...rest,
                    configOptions: modelOnlyOptions,
                    modelOptionIds: modelOnlyOptions.map((descriptor) => descriptor.id),
                    preserveDefault: true,
                  },
                  revision: entry.revision,
                });
                continue;
              }
              retained.delete(kept.value.currentModelId);
              retained.set(kept.value.currentModelId, {
                configuration: kept.value,
                revision: entry.revision,
              });
            }
            return retained.size === 0 ? EMPTY_OPTIONS_BY_MODEL : retained;
          })();
          const lastRetained = sortedPendingOptions(nextOptionsByModel).at(-1);
          const nextConfiguration: Option.Option<AcpRegistryLiveConfiguration> =
            lastRetained === undefined ? Option.none() : Option.some(lastRetained.configuration);
          if (
            current.catalog === null &&
            Equal.equals(current.configuration, nextConfiguration) &&
            Equal.equals(
              sortedPendingOptions(current.optionsByModel),
              sortedPendingOptions(nextOptionsByModel),
            ) &&
            nextCleared === current.clearedThroughRevision
          ) {
            return [true, state] as const;
          }
          const next = new Map(state);
          next.set(instanceId, {
            ...current,
            catalog: null,
            configuration: nextConfiguration,
            optionsByModel: nextOptionsByModel,
            clearedThroughRevision: nextCleared,
          });
          return [true, next] as const;
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
            const optionsByModel = hasCatalog
              ? EMPTY_OPTIONS_BY_MODEL
              : (() => {
                  const updated = new Map(current.optionsByModel);
                  updated.delete(configuration.currentModelId);
                  updated.set(configuration.currentModelId, { configuration, revision });
                  if (updated.size > MAX_TRACKED_MODEL_OPTIONS) {
                    const oldestKey = updated.keys().next().value;
                    if (oldestKey !== undefined) updated.delete(oldestKey);
                  }
                  return updated;
                })();
            const next = new Map(state);
            next.set(instanceId, {
              catalog,
              configuration: Option.some(configuration),
              optionsByModel,
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
      return (yield* getLiveConfigurationWithRevision(instanceId)).configuration;
    });

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
            for (const entry of sortedPendingOptions(current.optionsByModel)) {
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
    getLiveConfigurationWithRevision,
    watchLiveConfiguration,
    requestUrlAuthentication,
    acceptUrlAuthentication,
    getUrlAuthAction,
    watchUrlAuthAction,
  });
});

export const layer = Layer.effect(AcpRegistryRuntimeCoordinator, make);
