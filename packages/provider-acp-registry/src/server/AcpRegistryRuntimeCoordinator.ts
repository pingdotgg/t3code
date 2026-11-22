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
  readonly dispose?: boolean;
}

export interface AcpRegistryReadLiveStateOptions {
  readonly runtimeIdentity?: string;
  readonly requireMatchingRuntimeIdentity?: boolean;
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

interface ChannelEntry<T> {
  readonly value: T;
  readonly runtimeIdentity: string | undefined;
  readonly revision: number;
  readonly lifetime: number;
}

interface InstanceChannelState<T> {
  readonly lifetime: number;
  readonly entries: ReadonlyMap<string | undefined, ChannelEntry<T>>;
  readonly latestKey: string | undefined;
  readonly hasLatest: boolean;
  readonly clear: LiveStateClearState | undefined;
}

interface ChannelState<T> {
  readonly revision: number;
  readonly instances: ReadonlyMap<ProviderInstanceId, InstanceChannelState<T>>;
}

interface ChannelUpdate<T> {
  readonly instanceId: ProviderInstanceId;
  readonly value: T;
  readonly runtimeIdentity: string | undefined;
  readonly revision: number;
  readonly lifetime: number;
}

interface LiveStateChannelNames {
  readonly clear: string;
  readonly publish: string;
  readonly get: string;
  readonly watch: string;
}

const makeLiveStateChannel = Effect.fn("AcpRegistryRuntimeCoordinator.makeLiveStateChannel")(
  function* <T>(names: LiveStateChannelNames) {
    const updates = yield* PubSub.unbounded<ChannelUpdate<T>>();
    const publishPermit = yield* Semaphore.make(1);
    const stateRef = yield* Ref.make<ChannelState<T>>({
      revision: 0,
      instances: new Map(),
    });

    const clear = Effect.fn(`AcpRegistryRuntimeCoordinator.${names.clear}`)(function* (
      instanceId: ProviderInstanceId,
      options?: AcpRegistryClearLiveStateOptions,
    ) {
      yield* Ref.update(stateRef, (state) => {
        const revision = state.revision + 1;
        const nextInstances = new Map(state.instances);
        if (options?.dispose === true) {
          nextInstances.delete(instanceId);
          return { revision, instances: nextInstances };
        }
        const existing = state.instances.get(instanceId);
        const lifetime = existing?.lifetime ?? revision;
        const nextClear = recordLiveStateClear(existing?.clear, revision, options);
        const nextEntries = new Map<string | undefined, ChannelEntry<T>>();
        if (existing !== undefined) {
          for (const [key, entry] of existing.entries) {
            if (isLiveUpdateCurrent(nextClear, entry.revision, entry.runtimeIdentity)) {
              nextEntries.set(key, entry);
            }
          }
        }
        const latestEntry =
          existing !== undefined && existing.hasLatest
            ? nextEntries.get(existing.latestKey)
            : undefined;
        const fallbackLatest =
          latestEntry ??
          Array.from(nextEntries.values()).reduce<ChannelEntry<T> | undefined>(
            (best, entry) => (best === undefined || entry.revision > best.revision ? entry : best),
            undefined,
          );
        nextInstances.set(instanceId, {
          lifetime,
          entries: nextEntries,
          latestKey: fallbackLatest?.runtimeIdentity,
          hasLatest: fallbackLatest !== undefined,
          clear: nextClear,
        });
        return { revision, instances: nextInstances };
      });
    });

    const publish = Effect.fn(`AcpRegistryRuntimeCoordinator.${names.publish}`)(function* (
      instanceId: ProviderInstanceId,
      value: T,
      runtimeIdentity?: string,
    ) {
      // Serialize state commit and PubSub publication so watchers always observe monotonic revisions.
      yield* publishPermit.withPermits(1)(
        Effect.uninterruptible(
          Ref.modify(stateRef, (state) => {
            const revision = state.revision + 1;
            const existing = state.instances.get(instanceId);
            const lifetime = existing?.lifetime ?? revision;
            const nextEntries = new Map(existing?.entries);
            nextEntries.set(runtimeIdentity, { value, runtimeIdentity, revision, lifetime });
            const nextInstances = new Map(state.instances);
            nextInstances.set(instanceId, {
              lifetime,
              entries: nextEntries,
              latestKey: runtimeIdentity,
              hasLatest: true,
              clear: existing?.clear,
            });
            const update: ChannelUpdate<T> = {
              instanceId,
              value,
              runtimeIdentity,
              revision,
              lifetime,
            };
            return [update, { revision, instances: nextInstances }] as const;
          }).pipe(
            Effect.flatMap((event) => PubSub.publish(updates, event)),
            Effect.asVoid,
          ),
        ),
      );
    });

    const get = Effect.fn(`AcpRegistryRuntimeCoordinator.${names.get}`)(function* (
      instanceId: ProviderInstanceId,
      options?: AcpRegistryReadLiveStateOptions,
    ) {
      const inst = (yield* Ref.get(stateRef)).instances.get(instanceId);
      if (inst === undefined) return Option.none<T>();
      const validEntry = (entry: ChannelEntry<T> | undefined): Option.Option<T> =>
        entry !== undefined &&
        isLiveUpdateCurrent(inst.clear, entry.revision, entry.runtimeIdentity)
          ? Option.some(entry.value)
          : Option.none();
      if (options?.runtimeIdentity !== undefined) {
        const exact = validEntry(inst.entries.get(options.runtimeIdentity));
        if (Option.isSome(exact)) return exact;
        if (options.requireMatchingRuntimeIdentity === true) return Option.none<T>();
        return validEntry(inst.entries.get(undefined));
      }
      if (inst.clear?.preservedRuntimeIdentity !== undefined) {
        const preserved = validEntry(inst.entries.get(inst.clear.preservedRuntimeIdentity));
        if (Option.isSome(preserved)) return preserved;
      }
      return inst.hasLatest ? validEntry(inst.entries.get(inst.latestKey)) : Option.none<T>();
    });

    const watch = (
      instanceId: ProviderInstanceId,
      onUpdate: (value: T, meta: AcpRegistryLiveUpdateMeta) => Effect.Effect<void>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          // Trace subscription setup once without keeping a long-lived parent span around callbacks.
          const { subscription, snapshot } = yield* Effect.gen(function* () {
            // Subscribe before reading to avoid missing publications.
            const sub = yield* PubSub.subscribe(updates);
            const snap = yield* Ref.get(stateRef);
            return { subscription: sub, snapshot: snap };
          }).pipe(Effect.withSpan(`AcpRegistryRuntimeCoordinator.${names.watch}.subscribe`));
          const snapshotRevision = snapshot.revision;
          const inst = snapshot.instances.get(instanceId);
          const metaFor = (
            runtimeIdentity: string | undefined,
            revision: number,
            lifetime: number,
          ): AcpRegistryLiveUpdateMeta => ({
            runtimeIdentity,
            isCurrent: Ref.get(stateRef).pipe(
              Effect.map((state) => {
                const current = state.instances.get(instanceId);
                return (
                  current !== undefined &&
                  current.lifetime === lifetime &&
                  isLiveUpdateCurrent(current.clear, revision, runtimeIdentity)
                );
              }),
            ),
          });
          const replayed =
            inst === undefined
              ? []
              : Array.from(inst.entries.values())
                  .filter((entry) =>
                    isLiveUpdateCurrent(inst.clear, entry.revision, entry.runtimeIdentity),
                  )
                  .toSorted((left, right) => left.revision - right.revision);
          for (const entry of replayed) {
            yield* onUpdate(
              entry.value,
              metaFor(entry.runtimeIdentity, entry.revision, entry.lifetime),
            );
          }
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (update) => update.instanceId === instanceId && update.revision > snapshotRevision,
            ),
            Stream.runForEach((update) =>
              onUpdate(
                update.value,
                metaFor(update.runtimeIdentity, update.revision, update.lifetime),
              ),
            ),
          );
        }),
      );

    return { clear, publish, get, watch } as const;
  },
);

const make = Effect.gen(function* () {
  const foregroundStarts = yield* PubSub.unbounded<string>();
  const activeForegroundCounts = yield* Ref.make(new Map<string, number>());
  const availableCommandsChannel = yield* makeLiveStateChannel<AcpRegistryAvailableCommands>({
    clear: "clearAvailableCommands",
    publish: "publishAvailableCommands",
    get: "getAvailableCommands",
    watch: "watchAvailableCommands",
  });
  const liveConfigurationChannel = yield* makeLiveStateChannel<AcpRegistryLiveConfiguration>({
    clear: "clearLiveConfiguration",
    publish: "publishLiveConfiguration",
    get: "getLiveConfiguration",
    watch: "watchLiveConfiguration",
  });
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
              yield* publishUrlAuthAction(instanceId, publishedAction);
              if (previous !== undefined) {
                yield* Deferred.succeed(previous.consent, false);
              }
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
      const now = yield* DateTime.now;
      const pending = yield* Ref.modify(pendingUrlAuthActions, (current) => {
        const existing = current.get(input.instanceId);
        if (existing === undefined || existing.action.elicitationId !== input.elicitationId) {
          return [undefined, current] as const;
        }
        const next = new Map(current);
        next.delete(input.instanceId);
        return [existing, next] as const;
      });
      if (pending === undefined) return false;
      yield* publishUrlAuthAction(input.instanceId, null);
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(pending.expiresAt)) {
        yield* Deferred.succeed(pending.consent, false);
        return false;
      }
      return yield* Deferred.succeed(pending.consent, true);
    });

  const getUrlAuthAction: AcpRegistryRuntimeCoordinator["Service"]["getUrlAuthAction"] = Effect.fn(
    "AcpRegistryRuntimeCoordinator.getUrlAuthAction",
  )(function* (instanceId) {
    const now = yield* DateTime.now;
    const pending = (yield* Ref.get(pendingUrlAuthActions)).get(instanceId);
    if (
      pending === undefined ||
      DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(pending.expiresAt)
    ) {
      return Option.none();
    }
    return Option.some(pending.action);
  });

  const watchUrlAuthAction: AcpRegistryRuntimeCoordinator["Service"]["watchUrlAuthAction"] = (
    instanceId,
    onUpdate,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { subscription, current } = yield* Effect.gen(function* () {
          const sub = yield* PubSub.subscribe(urlAuthActionUpdates);
          const cur = yield* getUrlAuthAction(instanceId);
          return { subscription: sub, current: cur };
        }).pipe(Effect.withSpan("AcpRegistryRuntimeCoordinator.watchUrlAuthAction.subscribe"));
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
    clearAvailableCommands: availableCommandsChannel.clear,
    publishAvailableCommands: availableCommandsChannel.publish,
    getAvailableCommands: availableCommandsChannel.get,
    watchAvailableCommands: availableCommandsChannel.watch,
    clearLiveConfiguration: liveConfigurationChannel.clear,
    publishLiveConfiguration: liveConfigurationChannel.publish,
    getLiveConfiguration: liveConfigurationChannel.get,
    watchLiveConfiguration: liveConfigurationChannel.watch,
    requestUrlAuthentication,
    acceptUrlAuthentication,
    getUrlAuthAction,
    watchUrlAuthAction,
  });
});

export const layer = Layer.effect(AcpRegistryRuntimeCoordinator, make);
