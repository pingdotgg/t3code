import {
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type SubscriptionAllowance,
  type SubscriptionAllowanceSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  CLAUDE_SUBSCRIPTION_ALLOWANCE_UNAVAILABLE_MESSAGE,
  type ProviderAllowanceReader,
} from "../provider/Services/ProviderAllowanceReader.ts";
import {
  PROVIDER_RUNTIME_EVENT_SOURCE,
  ProviderService,
} from "../provider/Services/ProviderService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";

export const SUBSCRIPTION_ALLOWANCE_REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface SubscriptionAllowanceProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly allowanceReader?: ProviderAllowanceReader;
}

type ReadableSubscriptionAllowanceProviderInstance = SubscriptionAllowanceProviderInstance & {
  readonly allowanceReader: ProviderAllowanceReader;
};

interface AllowanceServiceState {
  readonly snapshot: SubscriptionAllowanceSnapshot;
  readonly hasCompletedRefresh: boolean;
  readonly instances: ReadonlyMap<ProviderInstanceId, ProviderInstance>;
  readonly demandCount: number;
  readonly liveScope: Option.Option<Scope.Closeable>;
}

type RefreshFlightOutcome =
  | {
      readonly _tag: "completed";
      readonly exit: Exit.Exit<SubscriptionAllowanceSnapshot, never>;
    }
  | { readonly _tag: "ownerInterrupted" };

type RefreshFlight = Deferred.Deferred<RefreshFlightOutcome>;

interface SubscriptionAllowanceSnapshotDelivery {
  readonly snapshot: SubscriptionAllowanceSnapshot;
  readonly hasCompletedRefresh: boolean;
}

const unavailableAllowance = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly provider: SubscriptionAllowance["provider"];
  readonly message: string;
}): SubscriptionAllowance => ({
  provider: input.provider,
  instanceId: input.instanceId,
  status: "unavailable",
  windows: [],
  message: input.message,
});

const unavailableMessage = (provider: ProviderAllowanceReader["provider"]): string =>
  provider === "claude"
    ? CLAUDE_SUBSCRIPTION_ALLOWANCE_UNAVAILABLE_MESSAGE
    : "Codex subscription usage is unavailable.";

const isUsableAllowance = (allowance: SubscriptionAllowance | undefined): boolean =>
  allowance?.status === "available";

const isLiveObservationAtLeastAsRecent = (
  current: SubscriptionAllowance | undefined,
  candidate: SubscriptionAllowance,
): boolean => {
  if (current?.observationSource !== "liveUpdate") return false;
  const currentUpdatedAt = Date.parse(current.updatedAt ?? "");
  const candidateUpdatedAt = Date.parse(candidate.updatedAt ?? "");
  return (
    Number.isFinite(currentUpdatedAt) &&
    Number.isFinite(candidateUpdatedAt) &&
    currentUpdatedAt >= candidateUpdatedAt
  );
};

const markFreshSnapshot = (
  allowance: SubscriptionAllowance,
  updatedAt: string,
): SubscriptionAllowance => ({
  ...allowance,
  freshness: "fresh",
  completeness: "complete",
  observationSource: "snapshot",
  deliverySource: "live",
  updatedAt,
});

const markStale = (allowance: SubscriptionAllowance): SubscriptionAllowance => ({
  ...allowance,
  freshness: "stale",
});

const markSnapshotDeliveredFromCache = (
  snapshot: SubscriptionAllowanceSnapshot,
): SubscriptionAllowanceSnapshot => ({
  ...snapshot,
  allowances: snapshot.allowances.map((allowance) => ({
    ...allowance,
    deliverySource: "cache",
  })),
});

const hasPassedReset = (
  allowance: SubscriptionAllowance,
  snapshotReadAt: string,
  nowMs: number,
): boolean =>
  allowance.status === "available" &&
  allowance.windows.some((window) => {
    if (window.resetsAt === undefined || window.resetsAt === null) return false;
    const resetMs = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetMs) || resetMs > nowMs) return false;

    const observedMs = Date.parse(allowance.updatedAt ?? snapshotReadAt);
    return !Number.isFinite(observedMs) || observedMs <= resetMs;
  });

export function markSubscriptionAllowanceSnapshotStale(
  snapshot: SubscriptionAllowanceSnapshot,
  nowMs: number,
): SubscriptionAllowanceSnapshot {
  const allowances = snapshot.allowances.map((allowance) =>
    hasPassedReset(allowance, snapshot.readAt, nowMs) ? markStale(allowance) : allowance,
  );
  return allowances.every((allowance, index) => allowance === snapshot.allowances[index])
    ? snapshot
    : { ...snapshot, allowances };
}

const nextPendingResetAt = (
  snapshot: SubscriptionAllowanceSnapshot,
  nowMs: number,
): number | undefined => {
  let nextResetAt: number | undefined;
  for (const allowance of snapshot.allowances) {
    if (allowance.status !== "available" || allowance.freshness === "stale") continue;
    const observedMs = Date.parse(allowance.updatedAt ?? snapshot.readAt);
    for (const window of allowance.windows) {
      const resetMs = Date.parse(window.resetsAt ?? "");
      if (
        Number.isFinite(resetMs) &&
        resetMs > nowMs &&
        (!Number.isFinite(observedMs) || observedMs <= resetMs) &&
        (nextResetAt === undefined || resetMs < nextResetAt)
      ) {
        nextResetAt = resetMs;
      }
    }
  }
  return nextResetAt;
};

/**
 * Fold one provider-native sparse observation into the last complete record.
 * Provider fields omitted from the sparse update remain untouched; explicit
 * nulls still clear the previous provider value.
 */
export function foldSubscriptionAllowance(
  previous: SubscriptionAllowance | undefined,
  update: SubscriptionAllowance,
): SubscriptionAllowance {
  if (!isUsableAllowance(update) || previous === undefined || !isUsableAllowance(previous)) {
    return update;
  }

  const windowsByScope = new Map(previous.windows.map((window) => [window.scope, window] as const));
  for (const window of update.windows) {
    windowsByScope.set(window.scope, {
      ...windowsByScope.get(window.scope),
      ...window,
    });
  }
  const windows = Array.from(windowsByScope.values());

  const foldNested = <Value extends object>(
    previousValue: Value | null | undefined,
    updateValue: Value | null,
  ): Value | null =>
    updateValue === null || previousValue === null || previousValue === undefined
      ? updateValue
      : { ...previousValue, ...updateValue };

  return {
    ...previous,
    ...update,
    windows,
    ...(update.credits === undefined
      ? {}
      : { credits: foldNested(previous.credits, update.credits) }),
    ...(update.spendingControl === undefined
      ? {}
      : {
          spendingControl: foldNested(previous.spendingControl, update.spendingControl),
        }),
    ...(update.extraUsage === undefined
      ? {}
      : { extraUsage: foldNested(previous.extraUsage, update.extraUsage) }),
  };
}

export class SubscriptionAllowanceService extends Context.Service<
  SubscriptionAllowanceService,
  {
    readonly subscribe: Effect.Effect<
      {
        readonly latest: SubscriptionAllowanceSnapshot;
        readonly changes: Stream.Stream<SubscriptionAllowanceSnapshot>;
        readonly hasCompletedRefresh: boolean;
      },
      never,
      Scope.Scope
    >;
    /** Manual refresh bypasses freshness but shares any active acquisition. */
    readonly refresh: Effect.Effect<SubscriptionAllowanceSnapshot>;
  }
>()("t3/usage/SubscriptionAllowanceService") {}

export function streamSubscriptionAllowanceSnapshots(input: {
  readonly latest: SubscriptionAllowanceSnapshot;
  readonly changes: Stream.Stream<SubscriptionAllowanceSnapshot>;
  readonly hasCompletedRefresh: boolean;
}): Stream.Stream<SubscriptionAllowanceSnapshot> {
  return input.hasCompletedRefresh || input.latest.allowances.length > 0
    ? Stream.concat(Stream.make(input.latest), input.changes)
    : input.changes;
}

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const providerService = yield* ProviderService;
  const stateMutex = yield* Semaphore.make(1);
  const liveMutex = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<SubscriptionAllowanceSnapshotDelivery>(8);
  const initialReadAt = DateTime.formatIso(yield* DateTime.now);
  const initialInstances = yield* registry.listInstances;
  const state = yield* Ref.make<AllowanceServiceState>({
    snapshot: { readAt: initialReadAt, allowances: [] },
    hasCompletedRefresh: false,
    instances: new Map(
      initialInstances.map((instance) => [instance.instanceId, instance] as const),
    ),
    demandCount: 0,
    liveScope: Option.none(),
  });
  const refreshFlight = yield* Ref.make<Option.Option<RefreshFlight>>(Option.none());

  const publishUnlocked = (snapshot: SubscriptionAllowanceSnapshot, completesRefresh = false) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const nextSnapshot = markSubscriptionAllowanceSnapshotStale(
        snapshot,
        yield* Clock.currentTimeMillis,
      );
      const hasCompletedRefresh = current.hasCompletedRefresh || completesRefresh;
      yield* Ref.set(state, {
        ...current,
        snapshot: nextSnapshot,
        hasCompletedRefresh,
      });
      if (current.demandCount > 0) {
        yield* PubSub.publish(changes, {
          snapshot: nextSnapshot,
          hasCompletedRefresh,
        });
      }
      return nextSnapshot;
    });
  const readCurrentSnapshot = Effect.fn("SubscriptionAllowanceService.readCurrentSnapshot")(
    function* (
      instances: ReadonlyArray<SubscriptionAllowanceProviderInstance>,
      previous: SubscriptionAllowanceSnapshot,
      readAt: string,
    ) {
      const previousByInstance = new Map(
        previous.allowances.map((allowance) => [allowance.instanceId, allowance] as const),
      );
      const readableInstances = instances.filter(
        (instance): instance is ReadableSubscriptionAllowanceProviderInstance =>
          instance.enabled && instance.allowanceReader !== undefined,
      );

      const allowances = yield* Effect.forEach(readableInstances, (instance) =>
        instance.allowanceReader.read.pipe(
          Effect.result,
          Effect.map((result) => {
            if (Result.isSuccess(result)) {
              return markFreshSnapshot(result.success, readAt);
            }

            const previousAllowance = previousByInstance.get(instance.instanceId);
            return previousAllowance !== undefined && isUsableAllowance(previousAllowance)
              ? markStale(previousAllowance)
              : markFreshSnapshot(
                  unavailableAllowance({
                    provider: instance.allowanceReader.provider,
                    instanceId: instance.instanceId,
                    message: unavailableMessage(instance.allowanceReader.provider),
                  }),
                  readAt,
                );
          }),
          Effect.tap((allowance) =>
            allowance.freshness === "stale"
              ? Effect.logWarning("Provider allowance refresh failed; retaining stale snapshot", {
                  provider: allowance.provider,
                  instanceId: allowance.instanceId,
                })
              : Effect.void,
          ),
        ),
      );

      return { readAt, allowances } satisfies SubscriptionAllowanceSnapshot;
    },
  );

  const refreshUnshared = Effect.gen(function* () {
    const instances = yield* registry.listInstances;
    const previous = yield* Ref.get(state);
    const readAt = DateTime.formatIso(yield* DateTime.now);
    const candidate = yield* readCurrentSnapshot(instances, previous.snapshot, readAt);
    const currentInstances = yield* registry.listInstances;
    const capturedById = new Map(
      instances.map((instance) => [instance.instanceId, instance] as const),
    );
    const allowancesById = new Map(
      candidate.allowances.map((allowance) => [allowance.instanceId, allowance]),
    );
    return yield* stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const currentState = yield* Ref.get(state);
        const acceptedAllowances = currentInstances.flatMap((instance) => {
          const candidateInstance = capturedById.get(instance.instanceId);
          if (
            candidateInstance === instance &&
            currentState.instances.get(instance.instanceId) === instance
          ) {
            const allowance = allowancesById.get(instance.instanceId);
            if (allowance === undefined) return [];
            const currentAllowance = currentState.snapshot.allowances.find(
              (candidateAllowance) => candidateAllowance.instanceId === instance.instanceId,
            );
            return [
              currentAllowance !== undefined &&
              isLiveObservationAtLeastAsRecent(currentAllowance, allowance)
                ? currentAllowance
                : allowance,
            ];
          }

          // A provider instance was replaced while the read was in flight. Do not
          // let the old generation publish into the new one; its registry change
          // will trigger a new demand-scoped refresh.
          const previousInstance = currentState.instances.get(instance.instanceId);
          if (previousInstance === instance) {
            const allowance = currentState.snapshot.allowances.find(
              (candidateAllowance) => candidateAllowance.instanceId === instance.instanceId,
            );
            return allowance === undefined ? [] : [allowance];
          }
          return [];
        });
        return yield* publishUnlocked({ readAt, allowances: acceptedAllowances }, true);
      }),
    );
  });

  const refresh: Effect.Effect<SubscriptionAllowanceSnapshot> = Effect.suspend(() =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const flight = yield* Deferred.make<RefreshFlightOutcome>();
        const existing = yield* Ref.modify(refreshFlight, (current) =>
          Option.match(current, {
            onNone: () => [Option.none<RefreshFlight>(), Option.some(flight)] as const,
            onSome: (active) => [Option.some(active), current] as const,
          }),
        );
        if (Option.isSome(existing)) {
          return yield* restore(
            existing.value.pipe(
              Deferred.await,
              Effect.flatMap((outcome) =>
                outcome._tag === "ownerInterrupted"
                  ? refresh
                  : Exit.match(outcome.exit, {
                      onFailure: (cause) => Effect.failCause(cause),
                      onSuccess: Effect.succeed,
                    }),
              ),
            ),
          );
        }

        const result = yield* Effect.exit(restore(refreshUnshared));
        if (Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)) {
          // The caller that installed the shared flight still owns its own
          // interruption. Waiters retry the acquisition instead of inheriting
          // an unrelated fiber's interrupt cause.
          yield* Ref.set(refreshFlight, Option.none());
          yield* Deferred.succeed(flight, { _tag: "ownerInterrupted" });
        } else {
          yield* Deferred.succeed(flight, { _tag: "completed", exit: result });
          yield* Ref.set(refreshFlight, Option.none());
        }
        return yield* Exit.match(result, {
          onFailure: (cause) => Effect.failCause(cause),
          onSuccess: Effect.succeed,
        });
      }),
    ),
  );

  const refreshAfterRegistryChange = Effect.gen(function* () {
    yield* refresh;
    const needsReplacementRead = yield* stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const publishedInstanceIds = new Set(
          current.snapshot.allowances.map((allowance) => allowance.instanceId),
        );
        return Array.from(current.instances.values()).some(
          (instance) =>
            instance.enabled &&
            instance.allowanceReader !== undefined &&
            !publishedInstanceIds.has(instance.instanceId),
        );
      }),
    );
    if (needsReplacementRead) yield* refresh;
  });

  const handleProviderUpdate = (event: ProviderRuntimeEvent) =>
    stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const instanceId = event.providerInstanceId;
        if (instanceId === undefined) return;
        const instance = current.instances.get(instanceId);
        const eventSource = (
          event as ProviderRuntimeEvent & {
            readonly [PROVIDER_RUNTIME_EVENT_SOURCE]?: unknown;
          }
        )[PROVIDER_RUNTIME_EVENT_SOURCE];
        if (eventSource !== undefined && eventSource !== instance?.adapter) return;
        const update = instance?.allowanceReader?.update?.(event);
        if (update === undefined) return;
        const previous = current.snapshot.allowances.find(
          (allowance) => allowance.instanceId === instanceId,
        );
        if (!isUsableAllowance(previous) && update.status === "available") {
          // A sparse event needs a usable snapshot to fold into. The next
          // complete acquisition remains the source of truth after failure.
          return;
        }
        const updatedAt = event.createdAt;
        const folded = {
          ...foldSubscriptionAllowance(previous, update),
          freshness: "fresh" as const,
          completeness: "complete" as const,
          observationSource: "liveUpdate" as const,
          deliverySource: "live" as const,
          updatedAt,
        };
        const allowances = current.snapshot.allowances.some(
          (allowance) => allowance.instanceId === instanceId,
        )
          ? current.snapshot.allowances.map((allowance) =>
              allowance.instanceId === instanceId ? folded : allowance,
            )
          : [...current.snapshot.allowances, folded];
        yield* publishUnlocked({ readAt: updatedAt, allowances });
      }),
    );

  const syncInstances = Effect.gen(function* () {
    const refreshScope = yield* stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const instances = yield* registry.listInstances;
        const nextById = new Map(
          instances.map((instance) => [instance.instanceId, instance] as const),
        );
        const current = yield* Ref.get(state);
        const changed = Array.from(nextById).some(
          ([instanceId, instance]) => current.instances.get(instanceId) !== instance,
        );
        if (!changed && nextById.size === current.instances.size)
          return Option.none<Scope.Closeable>();

        const allowances = current.snapshot.allowances.filter(
          (allowance) =>
            current.instances.get(allowance.instanceId) === nextById.get(allowance.instanceId),
        );
        yield* Ref.set(state, { ...current, instances: nextById });
        yield* publishUnlocked({ ...current.snapshot, allowances });
        return current.demandCount > 0 ? current.liveScope : Option.none();
      }),
    );
    if (Option.isSome(refreshScope)) {
      yield* refreshAfterRegistryChange.pipe(Effect.ignore, Effect.forkIn(refreshScope.value));
    }
  });

  const acquireDemand = liveMutex.withPermits(1)(
    Effect.gen(function* () {
      const liveScope = yield* stateMutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.demandCount > 0) {
            yield* Ref.set(state, { ...current, demandCount: current.demandCount + 1 });
            return Option.none<Scope.Closeable>();
          }

          const liveScope = yield* Scope.make();
          yield* Ref.set(state, {
            ...current,
            demandCount: 1,
            liveScope: Option.some(liveScope),
          });
          return Option.some(liveScope);
        }),
      );
      if (Option.isNone(liveScope)) return;

      const resetChanges = yield* PubSub.subscribe(changes).pipe(
        Effect.provideService(Scope.Scope, liveScope.value),
      );
      yield* providerService.streamEvents.pipe(
        Stream.filter((event) => event.type === "account.rate-limits.updated"),
        Stream.runForEach(handleProviderUpdate),
        Effect.catchCause((cause) =>
          Effect.logWarning("Subscription allowance provider update stream stopped", { cause }),
        ),
        Effect.forkIn(liveScope.value),
      );
      const registryChanges = yield* registry.subscribeChanges.pipe(
        Effect.provideService(Scope.Scope, liveScope.value),
      );
      yield* Stream.runForEach(Stream.fromSubscription(registryChanges), () => syncInstances).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Subscription allowance registry stream stopped", { cause }),
        ),
        Effect.forkIn(liveScope.value),
      );
      yield* syncInstances;
      yield* Effect.forever(
        Effect.sleep(`${SUBSCRIPTION_ALLOWANCE_REFRESH_INTERVAL_MS} millis`).pipe(
          Effect.andThen(refresh.pipe(Effect.ignore)),
        ),
      ).pipe(Effect.forkIn(liveScope.value));
      yield* refresh.pipe(
        Effect.ignore,
        Effect.forkIn(liveScope.value, { startImmediately: true }),
      );
      yield* Effect.forever(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const resetAt = yield* stateMutex.withPermits(1)(
            Ref.get(state).pipe(
              Effect.map((current) => nextPendingResetAt(current.snapshot, nowMs)),
            ),
          );
          if (resetAt === undefined) {
            yield* PubSub.take(resetChanges);
            return;
          }

          const signal = yield* Effect.raceFirst(
            PubSub.take(resetChanges).pipe(Effect.as("changed" as const)),
            Effect.sleep(
              `${Math.min(Math.max(0, resetAt - nowMs), MAX_TIMER_DELAY_MS)} millis`,
            ).pipe(Effect.as("reset" as const)),
          );
          if (signal === "changed") return;

          yield* stateMutex.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* Ref.get(state);
              yield* publishUnlocked(current.snapshot);
            }),
          );
        }),
      ).pipe(Effect.forkIn(liveScope.value, { startImmediately: true }));
    }),
  );

  const releaseDemand = liveMutex.withPermits(1)(
    Effect.gen(function* () {
      const scopeToClose = yield* stateMutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.demandCount > 1) {
            yield* Ref.set(state, { ...current, demandCount: current.demandCount - 1 });
            return Option.none<Scope.Closeable>();
          }
          yield* Ref.set(state, { ...current, demandCount: 0, liveScope: Option.none() });
          return current.liveScope;
        }),
      );
      if (Option.isSome(scopeToClose)) {
        yield* Scope.close(scopeToClose.value, Exit.void).pipe(Effect.ignore);
      }
    }),
  );

  const latest = stateMutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const nextSnapshot = markSubscriptionAllowanceSnapshotStale(
        current.snapshot,
        yield* Clock.currentTimeMillis,
      );
      if (nextSnapshot !== current.snapshot) {
        yield* Ref.set(state, { ...current, snapshot: nextSnapshot });
      }
      return {
        snapshot: nextSnapshot,
        hasCompletedRefresh: current.hasCompletedRefresh,
      };
    }),
  );
  const subscribe = subscribeBeforeSnapshotWithoutMutex(
    changes,
    Effect.gen(function* () {
      yield* Effect.acquireRelease(acquireDemand, () => releaseDemand);
      const delivery = yield* latest;
      return {
        ...delivery,
        snapshot: markSnapshotDeliveredFromCache(delivery.snapshot),
      };
    }),
  ).pipe(
    Effect.map(({ latest, changes }) => ({
      latest: latest.snapshot,
      hasCompletedRefresh: latest.hasCompletedRefresh,
      changes: changes.pipe(
        Stream.filter(
          (delivery) => delivery.hasCompletedRefresh || delivery.snapshot.allowances.length > 0,
        ),
        Stream.map((delivery) => delivery.snapshot),
      ),
    })),
  );

  return SubscriptionAllowanceService.of({
    subscribe,
    refresh,
  });
});

export const layer = Layer.effect(SubscriptionAllowanceService, make);

const emptySnapshot: SubscriptionAllowanceSnapshot = {
  readAt: "1970-01-01T00:00:00.000Z",
  allowances: [],
};

export const layerTest = Layer.succeed(
  SubscriptionAllowanceService,
  SubscriptionAllowanceService.of({
    subscribe: Effect.succeed({
      latest: emptySnapshot,
      hasCompletedRefresh: true,
      changes: Stream.empty,
    }),
    refresh: Effect.succeed(emptySnapshot),
  }),
);
