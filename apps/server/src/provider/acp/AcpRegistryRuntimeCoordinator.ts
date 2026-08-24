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

import type {
  AcpRegistryAvailableCommands,
  AcpRegistryLiveConfiguration,
} from "./AcpRegistryProbe.ts";

interface AvailableCommandsUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly commands: AcpRegistryAvailableCommands;
}

interface LiveConfigurationUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly configuration: AcpRegistryLiveConfiguration;
}

interface UrlAuthActionUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly action: AcpRegistryUrlAuthAction | null;
}

/** Pending URL logins auto-decline after this window so stale prompts cannot be accepted later. */
const URL_AUTH_ACTION_TTL = Duration.minutes(10);

interface PendingUrlAuthAction {
  readonly action: AcpRegistryUrlAuthAction;
  readonly consent: Deferred.Deferred<boolean>;
  readonly expiresAt: DateTime.Utc;
}

/** Gives a user-started ACP process priority over disposable discovery for the same agent. */
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
    /** Serializes native-session imports and deletes across all client connections. */
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
    readonly publishLiveConfiguration: (
      instanceId: ProviderInstanceId,
      configuration: AcpRegistryLiveConfiguration,
    ) => Effect.Effect<void>;
    readonly getLiveConfiguration: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<Option.Option<AcpRegistryLiveConfiguration>>;
    readonly watchLiveConfiguration: (
      instanceId: ProviderInstanceId,
      onUpdate: (configuration: AcpRegistryLiveConfiguration) => Effect.Effect<void>,
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
>()("t3/provider/acp/AcpRegistryRuntimeCoordinator") {
  static get layer() {
    return layer;
  }
}

export const make = Effect.gen(function* () {
  const foregroundStarts = yield* PubSub.unbounded<string>();
  const activeForegroundCounts = yield* Ref.make(new Map<string, number>());
  const availableCommandsUpdates = yield* PubSub.unbounded<AvailableCommandsUpdate>();
  const availableCommandsByInstance = yield* Ref.make(
    new Map<ProviderInstanceId, AcpRegistryAvailableCommands>(),
  );
  const liveConfigurationUpdates = yield* PubSub.unbounded<LiveConfigurationUpdate>();
  const liveConfigurationByInstance = yield* Ref.make(
    new Map<ProviderInstanceId, AcpRegistryLiveConfiguration>(),
  );
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
        // Subscribe before checking state so a foreground start cannot land
        // in the gap between the check and the interruptible probe.
        const subscription = yield* PubSub.subscribe(foregroundStarts);
        if ((yield* Ref.get(activeForegroundCounts)).has(agentId)) {
          return Option.none();
        }
        const foregroundStarted = Stream.fromSubscription(subscription).pipe(
          Stream.filter((candidate) => candidate === agentId),
          Stream.runHead,
          Effect.as(Option.none()),
        );
        return yield* Effect.raceFirst(effect.pipe(Effect.map(Option.some)), foregroundStarted);
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
          // Subscribe before reading the current value so a publication in
          // between is either observed from the snapshot, the queue, or both.
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
      Ref.update(liveConfigurationByInstance, (current) => {
        const next = new Map(current);
        next.delete(instanceId);
        return next;
      });

  const publishLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["publishLiveConfiguration"] =
    (instanceId, configuration) =>
      Ref.update(liveConfigurationByInstance, (current) =>
        new Map(current).set(instanceId, configuration),
      ).pipe(
        Effect.andThen(
          PubSub.publish(liveConfigurationUpdates, {
            instanceId,
            configuration,
          }),
        ),
        Effect.asVoid,
      );

  const getLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["getLiveConfiguration"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.getLiveConfiguration")(function* (instanceId) {
      return Option.fromNullishOr((yield* Ref.get(liveConfigurationByInstance)).get(instanceId));
    });

  const watchLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["watchLiveConfiguration"] =
    (instanceId, onUpdate) =>
      Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(liveConfigurationUpdates);
          const current = yield* getLiveConfiguration(instanceId);
          if (Option.isSome(current)) {
            yield* onUpdate(current.value);
          }
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((update) => update.instanceId === instanceId),
            Stream.runForEach((update) => onUpdate(update.configuration)),
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
    publishLiveConfiguration,
    getLiveConfiguration,
    watchLiveConfiguration,
    requestUrlAuthentication,
    acceptUrlAuthentication,
    getUrlAuthAction,
    watchUrlAuthAction,
  });
});

export const layer = Layer.effect(AcpRegistryRuntimeCoordinator, make);
