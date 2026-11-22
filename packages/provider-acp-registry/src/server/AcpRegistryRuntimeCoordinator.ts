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

export interface AcpRegistryLiveConfigurationSnapshot {
  readonly configuration: Option.Option<AcpRegistryLiveConfiguration>;
  readonly revision: number;
  readonly catalogRevision: number;
  readonly clearedThroughRevision: number;
}

const EMPTY_LIVE_CONFIGURATION_SNAPSHOT: AcpRegistryLiveConfigurationSnapshot = {
  configuration: Option.none(),
  revision: 0,
  catalogRevision: 0,
  clearedThroughRevision: 0,
};

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
      revision: number,
      options?: { readonly catalogRevision?: number },
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
    ReadonlyMap<ProviderInstanceId, AcpRegistryLiveConfigurationSnapshot>
  >(new Map());
  const urlAuthActionUpdates = yield* PubSub.unbounded<UrlAuthActionUpdate>();
  const pendingUrlAuthActions = yield* Ref.make(
    new Map<ProviderInstanceId, PendingUrlAuthAction>(),
  );
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
          Option.isNone(current.configuration) &&
          nextCleared === current.clearedThroughRevision
        ) {
          return state;
        }
        const next = new Map(state);
        next.set(instanceId, {
          configuration: Option.none(),
          revision: current.revision,
          catalogRevision: current.catalogRevision,
          clearedThroughRevision: nextCleared,
        });
        return next;
      });

  const clearLiveConfigurationIfRevision: AcpRegistryRuntimeCoordinator["Service"]["clearLiveConfigurationIfRevision"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.clearLiveConfigurationIfRevision")(
      function* (instanceId, revision, options) {
        return yield* Ref.modify(liveConfigurations, (state) => {
          const current = state.get(instanceId) ?? EMPTY_LIVE_CONFIGURATION_SNAPSHOT;
          if (Option.isSome(current.configuration) && current.revision !== revision) {
            // If only an options-only live update arrived after revision, keep those newer
            // options while advancing clearedThroughRevision so the probe catalog can commit.
            if (
              options?.catalogRevision !== undefined &&
              current.catalogRevision === options.catalogRevision &&
              current.configuration.value.models.length === 0
            ) {
              const nextCleared = Math.max(current.clearedThroughRevision, revision);
              if (nextCleared === current.clearedThroughRevision) {
                return [true, state] as const;
              }
              const next = new Map(state);
              next.set(instanceId, {
                ...current,
                clearedThroughRevision: nextCleared,
              });
              return [true, next] as const;
            }
            return [false, state] as const;
          }
          const nextCleared = Math.max(current.clearedThroughRevision, revision);
          if (
            Option.isNone(current.configuration) &&
            nextCleared === current.clearedThroughRevision
          ) {
            return [true, state] as const;
          }
          const next = new Map(state);
          next.set(instanceId, {
            configuration: Option.none(),
            revision: Math.max(current.revision, revision),
            catalogRevision: Math.max(current.catalogRevision, options?.catalogRevision ?? 0),
            clearedThroughRevision: nextCleared,
          });
          return [true, next] as const;
        });
      },
    );

  const publishLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["publishLiveConfiguration"] =
    (instanceId, configuration) =>
      Ref.modify(liveConfigurations, (state) => {
        const current = state.get(instanceId) ?? EMPTY_LIVE_CONFIGURATION_SNAPSHOT;
        const revision = current.revision + 1;
        const catalogRevision =
          configuration.models.length > 0 ? current.catalogRevision + 1 : current.catalogRevision;
        const next = new Map(state);
        next.set(instanceId, {
          configuration: Option.some(configuration),
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
      );

  const getLiveConfigurationWithRevision: AcpRegistryRuntimeCoordinator["Service"]["getLiveConfigurationWithRevision"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.getLiveConfigurationWithRevision")(
      function* (instanceId) {
        return (
          (yield* Ref.get(liveConfigurations)).get(instanceId) ?? EMPTY_LIVE_CONFIGURATION_SNAPSHOT
        );
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
          const afterRevision = options?.afterRevision;
          const subscription = yield* PubSub.subscribe(liveConfigurationUpdates);
          const current = (yield* Ref.get(liveConfigurations)).get(instanceId);
          let deliveredRevision = afterRevision ?? 0;
          if (
            current !== undefined &&
            Option.isSome(current.configuration) &&
            (afterRevision === undefined || current.revision > afterRevision)
          ) {
            deliveredRevision = current.revision;
            yield* onUpdate(current.configuration.value, current.revision);
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
