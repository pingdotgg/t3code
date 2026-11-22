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

export interface AcpRegistryLiveUpdateMeta {
  readonly runtimeIdentity: string | undefined;
  readonly isCurrent: Effect.Effect<boolean>;
}

export interface AcpRegistryClearLiveStateOptions {
  readonly preserveRuntimeIdentity?: string;
}

export interface AcpRegistryReadLiveStateOptions {
  readonly runtimeIdentity?: string;
  readonly requireMatchingRuntimeIdentity?: boolean;
}

interface AvailableCommandsEntry {
  readonly commands: AcpRegistryAvailableCommands;
  readonly runtimeIdentity: string | undefined;
  readonly revision: number;
}

interface LiveConfigurationEntry {
  readonly configuration: AcpRegistryLiveConfiguration;
  readonly runtimeIdentity: string | undefined;
  readonly revision: number;
}

interface AvailableCommandsUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly commands: AcpRegistryAvailableCommands;
  readonly runtimeIdentity: string | undefined;
  readonly revision: number;
}

interface LiveConfigurationUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly configuration: AcpRegistryLiveConfiguration;
  readonly runtimeIdentity: string | undefined;
  readonly revision: number;
}

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
    readonly clearAvailableCommands: (
      instanceId: ProviderInstanceId,
      options?: AcpRegistryClearLiveStateOptions,
    ) => Effect.Effect<void>;
    readonly publishAvailableCommands: (
      instanceId: ProviderInstanceId,
      commands: AcpRegistryAvailableCommands,
      runtimeIdentity?: string,
    ) => Effect.Effect<void>;
    readonly getAvailableCommands: (
      instanceId: ProviderInstanceId,
      options?: AcpRegistryReadLiveStateOptions,
    ) => Effect.Effect<Option.Option<AcpRegistryAvailableCommands>>;
    readonly watchAvailableCommands: (
      instanceId: ProviderInstanceId,
      onUpdate: (
        commands: AcpRegistryAvailableCommands,
        meta: AcpRegistryLiveUpdateMeta,
      ) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly clearLiveConfiguration: (
      instanceId: ProviderInstanceId,
      options?: AcpRegistryClearLiveStateOptions,
    ) => Effect.Effect<void>;
    readonly publishLiveConfiguration: (
      instanceId: ProviderInstanceId,
      configuration: AcpRegistryLiveConfiguration,
      runtimeIdentity?: string,
    ) => Effect.Effect<void>;
    readonly getLiveConfiguration: (
      instanceId: ProviderInstanceId,
      options?: AcpRegistryReadLiveStateOptions,
    ) => Effect.Effect<Option.Option<AcpRegistryLiveConfiguration>>;
    readonly watchLiveConfiguration: (
      instanceId: ProviderInstanceId,
      onUpdate: (
        configuration: AcpRegistryLiveConfiguration,
        meta: AcpRegistryLiveUpdateMeta,
      ) => Effect.Effect<void>,
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

interface LiveStateClearState {
  readonly allBeforeRevision: number;
  readonly nonMatchingBeforeRevision: number;
  readonly preservedRuntimeIdentity: string | undefined;
}

function recordLiveStateClear(
  current: LiveStateClearState | undefined,
  clearRevision: number,
  options?: AcpRegistryClearLiveStateOptions,
): LiveStateClearState {
  const preserveRuntimeIdentity = options?.preserveRuntimeIdentity;
  if (preserveRuntimeIdentity === undefined) {
    return {
      allBeforeRevision: clearRevision,
      nonMatchingBeforeRevision: clearRevision,
      preservedRuntimeIdentity: undefined,
    };
  }
  const previousAllBefore = current?.allBeforeRevision ?? 0;
  const previousPreservedExpired =
    current !== undefined && current.preservedRuntimeIdentity !== preserveRuntimeIdentity
      ? current.nonMatchingBeforeRevision
      : 0;
  return {
    allBeforeRevision: Math.max(previousAllBefore, previousPreservedExpired),
    nonMatchingBeforeRevision: clearRevision,
    preservedRuntimeIdentity: preserveRuntimeIdentity,
  };
}

function isLiveUpdateCurrent(
  clearState: LiveStateClearState | undefined,
  updateRevision: number,
  runtimeIdentity: string | undefined,
): boolean {
  if (clearState === undefined) return true;
  if (updateRevision < clearState.allBeforeRevision) return false;
  if (
    updateRevision < clearState.nonMatchingBeforeRevision &&
    (clearState.preservedRuntimeIdentity === undefined ||
      runtimeIdentity !== clearState.preservedRuntimeIdentity)
  ) {
    return false;
  }
  return true;
}

const make = Effect.gen(function* () {
  const foregroundStarts = yield* PubSub.unbounded<string>();
  const activeForegroundCounts = yield* Ref.make(new Map<string, number>());
  const availableCommandsUpdates = yield* PubSub.unbounded<AvailableCommandsUpdate>();
  const availableCommandsByInstance = yield* Ref.make(
    new Map<ProviderInstanceId, AvailableCommandsEntry>(),
  );
  const availableCommandsClearsByInstance = yield* Ref.make(
    new Map<ProviderInstanceId, LiveStateClearState>(),
  );
  const availableCommandsRevision = yield* Ref.make(0);
  const liveConfigurationUpdates = yield* PubSub.unbounded<LiveConfigurationUpdate>();
  const liveConfigurationByInstance = yield* Ref.make(
    new Map<ProviderInstanceId, LiveConfigurationEntry>(),
  );
  const liveConfigurationClearsByInstance = yield* Ref.make(
    new Map<ProviderInstanceId, LiveStateClearState>(),
  );
  const liveConfigurationRevision = yield* Ref.make(0);
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

  const matchesReadRuntime = (
    entryRuntimeIdentity: string | undefined,
    options?: AcpRegistryReadLiveStateOptions,
  ): boolean => {
    if (options?.runtimeIdentity === undefined) return true;
    if (entryRuntimeIdentity === undefined) {
      return options.requireMatchingRuntimeIdentity !== true;
    }
    return entryRuntimeIdentity === options.runtimeIdentity;
  };

  const clearAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["clearAvailableCommands"] =
    (instanceId, options) =>
      Ref.updateAndGet(availableCommandsRevision, (revision) => revision + 1).pipe(
        Effect.flatMap((clearRevision) =>
          Ref.update(availableCommandsClearsByInstance, (current) => {
            const next = new Map(current);
            next.set(
              instanceId,
              recordLiveStateClear(current.get(instanceId), clearRevision, options),
            );
            return next;
          }),
        ),
        Effect.andThen(
          Ref.update(availableCommandsByInstance, (current) => {
            const existing = current.get(instanceId);
            if (
              existing === undefined ||
              (options?.preserveRuntimeIdentity !== undefined &&
                existing.runtimeIdentity === options.preserveRuntimeIdentity)
            ) {
              return current;
            }
            const next = new Map(current);
            next.delete(instanceId);
            return next;
          }),
        ),
      );

  const publishAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["publishAvailableCommands"] =
    (instanceId, commands, runtimeIdentity) =>
      Ref.updateAndGet(availableCommandsRevision, (revision) => revision + 1).pipe(
        Effect.flatMap((revision) =>
          Ref.update(availableCommandsByInstance, (current) => {
            const next = new Map(current);
            next.set(instanceId, { commands, runtimeIdentity, revision });
            return next;
          }).pipe(
            Effect.andThen(
              PubSub.publish(availableCommandsUpdates, {
                instanceId,
                commands,
                runtimeIdentity,
                revision,
              }),
            ),
            Effect.asVoid,
          ),
        ),
      );

  const getAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["getAvailableCommands"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.getAvailableCommands")(
      function* (instanceId, options) {
        const entry = (yield* Ref.get(availableCommandsByInstance)).get(instanceId);
        if (entry === undefined || !matchesReadRuntime(entry.runtimeIdentity, options)) {
          return Option.none();
        }
        return Option.some(entry.commands);
      },
    );

  const watchAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["watchAvailableCommands"] =
    (instanceId, onUpdate) =>
      Effect.scoped(
        Effect.gen(function* () {
          // Subscribe before reading to avoid missing publications.
          const subscription = yield* PubSub.subscribe(availableCommandsUpdates);
          const current = (yield* Ref.get(availableCommandsByInstance)).get(instanceId);
          const metaFor = (
            runtimeIdentity: string | undefined,
            revision: number,
          ): AcpRegistryLiveUpdateMeta => ({
            runtimeIdentity,
            isCurrent: Ref.get(availableCommandsClearsByInstance).pipe(
              Effect.map((clears) =>
                isLiveUpdateCurrent(clears.get(instanceId), revision, runtimeIdentity),
              ),
            ),
          });
          if (current !== undefined) {
            yield* onUpdate(current.commands, metaFor(current.runtimeIdentity, current.revision));
          }
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((update) => update.instanceId === instanceId),
            Stream.runForEach((update) =>
              onUpdate(update.commands, metaFor(update.runtimeIdentity, update.revision)),
            ),
          );
        }),
      );

  const clearLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["clearLiveConfiguration"] =
    (instanceId, options) =>
      Ref.updateAndGet(liveConfigurationRevision, (revision) => revision + 1).pipe(
        Effect.flatMap((clearRevision) =>
          Ref.update(liveConfigurationClearsByInstance, (current) => {
            const next = new Map(current);
            next.set(
              instanceId,
              recordLiveStateClear(current.get(instanceId), clearRevision, options),
            );
            return next;
          }),
        ),
        Effect.andThen(
          Ref.update(liveConfigurationByInstance, (current) => {
            const existing = current.get(instanceId);
            if (
              existing === undefined ||
              (options?.preserveRuntimeIdentity !== undefined &&
                existing.runtimeIdentity === options.preserveRuntimeIdentity)
            ) {
              return current;
            }
            const next = new Map(current);
            next.delete(instanceId);
            return next;
          }),
        ),
      );

  const publishLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["publishLiveConfiguration"] =
    (instanceId, configuration, runtimeIdentity) =>
      Ref.updateAndGet(liveConfigurationRevision, (revision) => revision + 1).pipe(
        Effect.flatMap((revision) =>
          Ref.update(liveConfigurationByInstance, (current) =>
            new Map(current).set(instanceId, { configuration, runtimeIdentity, revision }),
          ).pipe(
            Effect.andThen(
              PubSub.publish(liveConfigurationUpdates, {
                instanceId,
                configuration,
                runtimeIdentity,
                revision,
              }),
            ),
            Effect.asVoid,
          ),
        ),
      );

  const getLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["getLiveConfiguration"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.getLiveConfiguration")(
      function* (instanceId, options) {
        const entry = (yield* Ref.get(liveConfigurationByInstance)).get(instanceId);
        if (entry === undefined || !matchesReadRuntime(entry.runtimeIdentity, options)) {
          return Option.none();
        }
        return Option.some(entry.configuration);
      },
    );

  const watchLiveConfiguration: AcpRegistryRuntimeCoordinator["Service"]["watchLiveConfiguration"] =
    (instanceId, onUpdate) =>
      Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(liveConfigurationUpdates);
          const current = (yield* Ref.get(liveConfigurationByInstance)).get(instanceId);
          const metaFor = (
            runtimeIdentity: string | undefined,
            revision: number,
          ): AcpRegistryLiveUpdateMeta => ({
            runtimeIdentity,
            isCurrent: Ref.get(liveConfigurationClearsByInstance).pipe(
              Effect.map((clears) =>
                isLiveUpdateCurrent(clears.get(instanceId), revision, runtimeIdentity),
              ),
            ),
          });
          if (current !== undefined) {
            yield* onUpdate(
              current.configuration,
              metaFor(current.runtimeIdentity, current.revision),
            );
          }
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((update) => update.instanceId === instanceId),
            Stream.runForEach((update) =>
              onUpdate(update.configuration, metaFor(update.runtimeIdentity, update.revision)),
            ),
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
