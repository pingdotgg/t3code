import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { SshEnvironmentGateway } from "../platform/capabilities.ts";
import {
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  ConnectionProfileStore,
  type PrimaryConnectionRegistration,
  SshConnectionProfile,
  connectionRegistrationCatalogEntry,
} from "./catalog.ts";
import { Connectivity } from "./connectivity.ts";
import type {
  ConnectionAttemptError,
  ConnectionTarget,
  NetworkStatus,
  SupervisorConnectionState,
} from "./model.ts";
import {
  type ConnectionPersistenceError,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EnvironmentCacheStore,
  EnvironmentOwnedDataCleanup,
} from "../platform/persistence.ts";
import {
  EnvironmentSupervisor,
  type EnvironmentSupervisorService,
  makeEnvironmentSupervisor,
} from "./supervisor.ts";
import { ConnectionDriver } from "./driver.ts";
import { ConnectionWakeups } from "./wakeups.ts";

const isSshConnectionProfile = Schema.is(SshConnectionProfile);

export class EnvironmentNotRegisteredError extends Schema.TaggedErrorClass<EnvironmentNotRegisteredError>()(
  "EnvironmentNotRegisteredError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export class PlatformEnvironmentRemovalError extends Schema.TaggedErrorClass<PlatformEnvironmentRemovalError>()(
  "PlatformEnvironmentRemovalError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export interface EnvironmentRegistryService {
  readonly entries: SubscriptionRef.SubscriptionRef<
    ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
  >;
  readonly networkStatus: SubscriptionRef.SubscriptionRef<NetworkStatus>;
  readonly start: Effect.Effect<void>;
  readonly register: (
    registration: ConnectionRegistration,
  ) => Effect.Effect<void, ConnectionPersistenceError>;
  readonly registerPlatform: (registration: PrimaryConnectionRegistration) => Effect.Effect<void>;
  readonly remove: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<
    void,
    | ConnectionPersistenceError
    | ConnectionAttemptError
    | EnvironmentNotRegisteredError
    | PlatformEnvironmentRemovalError
  >;
  readonly removeRelayEnvironments: () => Effect.Effect<
    void,
    ConnectionPersistenceError | ConnectionAttemptError | PlatformEnvironmentRemovalError
  >;
  readonly retryNow: (environmentId: EnvironmentId) => Effect.Effect<void>;
  readonly state: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<SupervisorConnectionState, EnvironmentNotRegisteredError>;
  readonly stateChanges: (
    environmentId: EnvironmentId,
  ) => Stream.Stream<SupervisorConnectionState, EnvironmentNotRegisteredError>;
  readonly run: <A, E, R>(
    environmentId: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | EnvironmentNotRegisteredError, Exclude<R, EnvironmentSupervisor>>;
  readonly runStream: <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) => Stream.Stream<A, E | EnvironmentNotRegisteredError, Exclude<R, EnvironmentSupervisor>>;
  readonly followStream: <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) => Stream.Stream<A, E, Exclude<R, EnvironmentSupervisor>>;
}

export class EnvironmentRegistry extends Context.Service<
  EnvironmentRegistry,
  EnvironmentRegistryService
>()("@t3tools/client-runtime/connection/registry/EnvironmentRegistry") {}

interface EnvironmentServiceScope {
  readonly entry: ConnectionCatalogEntry;
  readonly supervisor: EnvironmentSupervisorService;
  readonly scope: Scope.Closeable;
}

const makeEnvironmentRegistry = Effect.fn("EnvironmentRegistry.make")(function* () {
  const storage = yield* ConnectionTargetStore;
  const registrations = yield* ConnectionRegistrationStore;
  const cache = yield* EnvironmentCacheStore;
  const ownedDataCleanup = yield* EnvironmentOwnedDataCleanup;
  const profiles = yield* ConnectionProfileStore;
  const connectivity = yield* Connectivity;
  const driver = yield* ConnectionDriver;
  const wakeups = yield* ConnectionWakeups;
  const ssh = yield* SshEnvironmentGateway;
  const persistedTargets = yield* storage.list;
  const initialEntries = new Map(
    yield* Effect.forEach(
      persistedTargets,
      Effect.fn("EnvironmentRegistry.loadCatalogEntry")(function* (target) {
        const profile =
          target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget"
            ? yield* profiles.get(target.connectionId)
            : Option.none();
        return [
          target.environmentId,
          { target, profile } satisfies ConnectionCatalogEntry,
        ] as const;
      }),
      { concurrency: "unbounded" },
    ),
  );
  const entries =
    yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(initialEntries);
  const networkStatus = yield* SubscriptionRef.make(yield* connectivity.status);
  const serviceScopes = yield* SubscriptionRef.make<
    ReadonlyMap<EnvironmentId, EnvironmentServiceScope>
  >(new Map());
  const platformEnvironmentIds = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());
  const persistedTargetsByEnvironment = yield* Ref.make<
    ReadonlyMap<EnvironmentId, ConnectionTarget>
  >(new Map(persistedTargets.map((target) => [target.environmentId, target])));
  interface LeaseLock {
    readonly semaphore: Semaphore.Semaphore;
    readonly users: number;
  }

  const leaseLocks = yield* Ref.make<ReadonlyMap<EnvironmentId, LeaseLock>>(new Map());
  const leaseLocksGuard = yield* Semaphore.make(1);
  const started = yield* Ref.make(false);

  const withLeaseLock = <A, E, R>(
    environmentId: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      leaseLocksGuard.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(leaseLocks);
          const existing = current.get(environmentId);
          if (existing !== undefined) {
            yield* Ref.set(
              leaseLocks,
              new Map(current).set(environmentId, {
                semaphore: existing.semaphore,
                users: existing.users + 1,
              }),
            );
            return existing.semaphore;
          }
          const semaphore = yield* Semaphore.make(1);
          yield* Ref.set(leaseLocks, new Map(current).set(environmentId, { semaphore, users: 1 }));
          return semaphore;
        }),
      ),
      (semaphore) => semaphore.withPermits(1)(effect),
      (semaphore) =>
        leaseLocksGuard.withPermits(1)(
          Ref.update(leaseLocks, (current) => {
            const existing = current.get(environmentId);
            if (existing === undefined || existing.semaphore !== semaphore) {
              return current;
            }
            const next = new Map(current);
            if (existing.users === 1) {
              next.delete(environmentId);
            } else {
              next.set(environmentId, {
                semaphore,
                users: existing.users - 1,
              });
            }
            return next;
          }),
        ),
    ).pipe(Effect.withSpan("EnvironmentRegistry.withLeaseLock"));

  const getEntry = Effect.fn("EnvironmentRegistry.getEntry")(function* (
    environmentId: EnvironmentId,
  ) {
    const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
    if (entry === undefined) {
      return yield* new EnvironmentNotRegisteredError({
        environmentId,
        message: `Environment ${environmentId} is not registered.`,
      });
    }
    return entry;
  });

  const closeServiceScope = Effect.fn("EnvironmentRegistry.closeServiceScope")(function* (
    environmentId: EnvironmentId,
  ) {
    const current = yield* SubscriptionRef.get(serviceScopes);
    const lease = current.get(environmentId);
    if (lease === undefined) {
      return;
    }
    const next = new Map(current);
    next.delete(environmentId);
    yield* SubscriptionRef.set(serviceScopes, next);
    yield* Scope.close(lease.scope, Exit.void);
  });

  const createServiceScope = Effect.fn("EnvironmentRegistry.createServiceScope")(
    (entry: ConnectionCatalogEntry) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const environmentId = entry.target.environmentId;
          const scope = yield* Scope.make();
          const supervisor = yield* makeEnvironmentSupervisor(entry, {
            initiallyDesired: false,
          }).pipe(
            Effect.provideService(Connectivity, connectivity),
            Effect.provideService(ConnectionDriver, driver),
            Effect.provideService(ConnectionWakeups, wakeups),
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          yield* supervisor.connect;
          yield* SubscriptionRef.update(serviceScopes, (current) => {
            const next = new Map(current);
            next.set(environmentId, { entry, supervisor, scope });
            return next;
          });
          return supervisor;
        }),
      ),
  );

  const acquireSupervisor = Effect.fn("EnvironmentRegistry.acquireSupervisor")(function* (
    environmentId: EnvironmentId,
  ) {
    return yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = yield* getEntry(environmentId);
        const existing = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
        if (existing !== undefined) {
          if (Equal.equals(existing.entry, entry)) {
            return existing.supervisor;
          }
          yield* closeServiceScope(environmentId);
        }
        return yield* createServiceScope(entry);
      }),
    );
  });

  const run: EnvironmentRegistryService["run"] = Effect.fn("EnvironmentRegistry.run")(function* <
    A,
    E,
    R,
  >(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) {
    const supervisor = yield* acquireSupervisor(environmentId);
    return yield* Effect.provideService(effect, EnvironmentSupervisor, supervisor);
  });

  const runStream: EnvironmentRegistryService["runStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.unwrap(
      acquireSupervisor(environmentId).pipe(
        Effect.map((supervisor) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        ),
      ),
    );

  const followStream: EnvironmentRegistryService["followStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(entries)),
      SubscriptionRef.changes(entries),
    ).pipe(
      Stream.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.empty,
          onSome: () =>
            Stream.unwrap(
              acquireSupervisor(environmentId).pipe(
                Effect.match({
                  onFailure: () => Stream.empty,
                  onSuccess: (supervisor) =>
                    Stream.provideService(stream, EnvironmentSupervisor, supervisor),
                }),
              ),
            ),
        }),
      ),
    );

  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) {
      return;
    }
    yield* Effect.forEach(
      persistedTargets,
      (target) =>
        acquireSupervisor(target.environmentId).pipe(
          Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
        ),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
  }).pipe(Effect.withSpan("EnvironmentRegistry.start"));

  const installEntryLocked = Effect.fn("EnvironmentRegistry.installEntryLocked")(function* (
    entry: ConnectionCatalogEntry,
    options?: { readonly retainEquivalentRuntime?: boolean },
  ) {
    const target = entry.target;
    const previous = (yield* SubscriptionRef.get(entries)).get(target.environmentId);
    const existingScope = (yield* SubscriptionRef.get(serviceScopes)).get(target.environmentId);
    if (
      options?.retainEquivalentRuntime === true &&
      previous !== undefined &&
      Equal.equals(previous, entry) &&
      existingScope !== undefined &&
      Equal.equals(existingScope.entry, entry)
    ) {
      return;
    }

    yield* closeServiceScope(target.environmentId);
    yield* SubscriptionRef.update(entries, (current) => {
      const next = new Map(current);
      next.set(target.environmentId, entry);
      return next;
    });
    yield* createServiceScope(entry);
  });

  const register = Effect.fn("EnvironmentRegistry.register")(function* (
    registration: ConnectionRegistration,
  ) {
    const entry = connectionRegistrationCatalogEntry(registration);
    const environmentId = entry.target.environmentId;
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return;
        }
        yield* registrations.register(registration);
        yield* Ref.update(persistedTargetsByEnvironment, (current) => {
          const next = new Map(current);
          next.set(environmentId, registration.target);
          return next;
        });
        yield* installEntryLocked(entry);
      }),
    );
  });

  const registerPlatform = Effect.fn("EnvironmentRegistry.registerPlatform")(function* (
    registration: PrimaryConnectionRegistration,
  ) {
    const entry = connectionRegistrationCatalogEntry(registration);
    const target = entry.target;
    yield* withLeaseLock(
      target.environmentId,
      Effect.gen(function* () {
        yield* Ref.update(platformEnvironmentIds, (current) => {
          const next = new Set(current);
          next.add(target.environmentId);
          return next;
        });

        const persistedTarget = (yield* Ref.get(persistedTargetsByEnvironment)).get(
          target.environmentId,
        );
        if (persistedTarget !== undefined) {
          yield* registrations.remove(persistedTarget).pipe(
            Effect.tap(() =>
              Ref.update(persistedTargetsByEnvironment, (current) => {
                const next = new Map(current);
                next.delete(target.environmentId);
                return next;
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning(
                "Could not remove a persisted registration shadowed by the primary environment.",
                {
                  environmentId: target.environmentId,
                  error,
                },
              ),
            ),
          );
        }

        yield* installEntryLocked(entry, { retainEquivalentRuntime: true });
      }),
    );
  });

  const remove = Effect.fn("EnvironmentRegistry.remove")(function* (environmentId: EnvironmentId) {
    return yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return yield* new PlatformEnvironmentRemovalError({
            environmentId,
            message: "Platform-managed environments cannot be removed.",
          });
        }
        const target = (yield* getEntry(environmentId)).target;
        const profile =
          target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget"
            ? yield* profiles.get(target.connectionId)
            : Option.none();

        yield* registrations.remove(target);
        yield* Ref.update(persistedTargetsByEnvironment, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
        yield* closeServiceScope(environmentId);
        yield* SubscriptionRef.update(entries, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
        yield* Effect.all(
          [
            cache.clear(environmentId).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not clear cached environment data after removal.", {
                  environmentId,
                  error,
                }),
              ),
            ),
            ownedDataCleanup.clear(environmentId),
          ],
          { concurrency: "unbounded", discard: true },
        );

        if (
          target._tag === "SshConnectionTarget" &&
          Option.isSome(profile) &&
          isSshConnectionProfile(profile.value)
        ) {
          yield* ssh.disconnect(profile.value.target).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not disconnect the managed SSH environment.", {
                environmentId,
                error,
              }),
            ),
            Effect.ignore,
          );
        }
      }),
    );
  });

  const removeRelayEnvironments = Effect.fn("EnvironmentRegistry.removeRelayEnvironments")(
    function* () {
      const relayEnvironmentIds = [...(yield* SubscriptionRef.get(entries)).values()]
        .filter((entry) => entry.target._tag === "RelayConnectionTarget")
        .map((entry) => entry.target.environmentId);

      yield* Effect.forEach(
        relayEnvironmentIds,
        (environmentId) =>
          remove(environmentId).pipe(
            Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
          ),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    },
  );

  const retryNow = (environmentId: EnvironmentId) =>
    acquireSupervisor(environmentId).pipe(
      Effect.flatMap((supervisor) => supervisor.retryNow),
      Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
      Effect.withSpan("EnvironmentRegistry.retryNow"),
    );
  const state = Effect.fn("EnvironmentRegistry.state")(function* (environmentId: EnvironmentId) {
    const supervisor = yield* acquireSupervisor(environmentId);
    return yield* SubscriptionRef.get(supervisor.state);
  });
  const stateChanges = (environmentId: EnvironmentId) =>
    followStream(
      environmentId,
      Stream.unwrap(
        EnvironmentSupervisor.pipe(
          Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
        ),
      ),
    );

  yield* Effect.addFinalizer(() =>
    SubscriptionRef.get(serviceScopes).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(current.values(), (lease) => Scope.close(lease.scope, Exit.void), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  );
  yield* connectivity.changes.pipe(
    Stream.runForEach((status) => SubscriptionRef.set(networkStatus, status)),
    Effect.forkScoped,
  );

  return EnvironmentRegistry.of({
    entries,
    networkStatus,
    start,
    register,
    registerPlatform,
    remove,
    removeRelayEnvironments,
    retryNow,
    state,
    stateChanges,
    run,
    runStream,
    followStream,
  });
});

export const environmentRegistryLayer = Layer.effect(
  EnvironmentRegistry,
  makeEnvironmentRegistry(),
);
