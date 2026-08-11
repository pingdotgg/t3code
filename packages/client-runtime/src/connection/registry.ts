import { EnvironmentId } from "@t3tools/contracts";
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

import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  type BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  type PlatformConnectionRegistration,
  type PrimaryConnectionRegistration,
  SshConnectionProfile,
  connectionRegistrationCatalogEntry,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as Connectivity from "./connectivity.ts";
import type {
  ConnectionAttemptError,
  ConnectionTarget,
  NetworkStatus,
  SupervisorConnectionState,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const isSshConnectionProfile = Schema.is(SshConnectionProfile);

function bearerRuntimeKey(entry: ConnectionCatalogEntry): string | null {
  const profile = Option.getOrNull(entry.profile);
  if (
    entry.target._tag !== "BearerConnectionTarget" ||
    profile?._tag !== "BearerConnectionProfile"
  ) {
    return null;
  }
  return JSON.stringify([
    entry.target.environmentId,
    entry.target.connectionId,
    profile.httpBaseUrl,
    profile.wsBaseUrl,
  ]);
}

function entriesHaveEquivalentRuntime(
  left: ConnectionCatalogEntry,
  right: ConnectionCatalogEntry,
): boolean {
  const leftKey = bearerRuntimeKey(left);
  return Equal.equals(left, right) || (leftKey !== null && leftKey === bearerRuntimeKey(right));
}

export class EnvironmentNotRegisteredError extends Schema.TaggedErrorClass<EnvironmentNotRegisteredError>()(
  "EnvironmentNotRegisteredError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is not registered.`;
  }
}

export class PlatformEnvironmentRemovalError extends Schema.TaggedErrorClass<PlatformEnvironmentRemovalError>()(
  "PlatformEnvironmentRemovalError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Platform-managed environment ${this.environmentId} cannot be removed.`;
  }
}

export class EnvironmentRegistry extends Context.Service<
  EnvironmentRegistry,
  {
    readonly entries: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
    >;
    readonly networkStatus: SubscriptionRef.SubscriptionRef<NetworkStatus>;
    readonly start: Effect.Effect<void>;
    readonly register: (
      registration: ConnectionRegistration,
      options?: { readonly enabled?: boolean },
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly updateRegistration: (
      environmentId: EnvironmentId,
      prepare: Effect.Effect<
        BearerConnectionRegistration,
        ConnectionAttemptError
      >,
    ) => Effect.Effect<
      void,
      | ConnectionAttemptError
      | Persistence.ConnectionPersistenceError
      | EnvironmentNotRegisteredError
    >;
    readonly registerPlatform: (
      registration: PrimaryConnectionRegistration,
    ) => Effect.Effect<void>;
    readonly reconcilePlatform: (
      registrations: ReadonlyArray<PlatformConnectionRegistration>,
    ) => Effect.Effect<void>;
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | ConnectionAttemptError
      | EnvironmentNotRegisteredError
      | PlatformEnvironmentRemovalError
    >;
    readonly removeRelayEnvironments: () => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | ConnectionAttemptError
      | PlatformEnvironmentRemovalError
    >;
    readonly retryNow: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly setEnabled: (
      environmentId: EnvironmentId,
      enabled: boolean,
    ) => Effect.Effect<
      void,
      Persistence.ConnectionPersistenceError | EnvironmentNotRegisteredError
    >;
    readonly state: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      SupervisorConnectionState,
      EnvironmentNotRegisteredError
    >;
    readonly stateChanges: (
      environmentId: EnvironmentId,
    ) => Stream.Stream<
      SupervisorConnectionState,
      EnvironmentNotRegisteredError
    >;
    readonly run: <A, E, R>(
      environmentId: EnvironmentId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly runStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly followStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<
      A,
      E,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
  }
>()("@t3tools/client-runtime/connection/registry/EnvironmentRegistry") {}

interface EnvironmentServiceScope {
  readonly entry: ConnectionCatalogEntry;
  readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  readonly scope: Scope.Closeable;
}

export const make = Effect.gen(function* () {
  const storage = yield* Persistence.ConnectionTargetStore;
  const registrations = yield* Persistence.ConnectionRegistrationStore;
  const activation = yield* Persistence.ConnectionActivationStore;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const ownedDataCleanup = yield* Persistence.EnvironmentOwnedDataCleanup;
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const credentials =
    yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const persistedTargets = yield* storage.list;
  const disabledEnvironmentIds = new Set(yield* activation.listDisabled);
  const initialEntries = new Map(
    yield* Effect.forEach(
      persistedTargets,
      Effect.fn("EnvironmentRegistry.loadCatalogEntry")(function* (target) {
        const profile =
          target._tag === "BearerConnectionTarget" ||
          target._tag === "SshConnectionTarget"
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
    yield* SubscriptionRef.make<
      ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
    >(initialEntries);
  const networkStatus = yield* SubscriptionRef.make(yield* connectivity.status);
  const serviceScopes = yield* SubscriptionRef.make<
    ReadonlyMap<EnvironmentId, EnvironmentServiceScope>
  >(new Map());
  const platformEnvironmentIds = yield* Ref.make<ReadonlySet<EnvironmentId>>(
    new Set(),
  );
  const persistedTargetsByEnvironment = yield* Ref.make<
    ReadonlyMap<EnvironmentId, ConnectionTarget>
  >(new Map(persistedTargets.map((target) => [target.environmentId, target])));
  interface LeaseLock {
    readonly semaphore: Semaphore.Semaphore;
    readonly users: number;
  }

  const leaseLocks = yield* Ref.make<ReadonlyMap<EnvironmentId, LeaseLock>>(
    new Map(),
  );
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
          yield* Ref.set(
            leaseLocks,
            new Map(current).set(environmentId, { semaphore, users: 1 }),
          );
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
      });
    }
    return entry;
  });

  const closeServiceScope = Effect.fn("EnvironmentRegistry.closeServiceScope")(
    function* (environmentId: EnvironmentId) {
      const current = yield* SubscriptionRef.get(serviceScopes);
      const lease = current.get(environmentId);
      if (lease === undefined) {
        return;
      }
      const next = new Map(current);
      next.delete(environmentId);
      yield* SubscriptionRef.set(serviceScopes, next);
      yield* Scope.close(lease.scope, Exit.void);
    },
  );

  const createServiceScope = Effect.fn(
    "EnvironmentRegistry.createServiceScope",
  )((entry: ConnectionCatalogEntry, initiallyDesired?: boolean) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const environmentId = entry.target.environmentId;
        const desired =
          initiallyDesired ?? !disabledEnvironmentIds.has(environmentId);
        const scope = yield* Scope.make();
        const supervisor = yield* EnvironmentSupervisor.make(entry, {
          initiallyDesired: desired,
        }).pipe(
          Effect.provideService(Connectivity.Connectivity, connectivity),
          Effect.provideService(ConnectionDriver.ConnectionDriver, driver),
          Effect.provideService(ConnectionWakeups.ConnectionWakeups, wakeups),
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        yield* SubscriptionRef.update(serviceScopes, (current) => {
          const next = new Map(current);
          next.set(environmentId, { entry, supervisor, scope });
          return next;
        });
        return supervisor;
      }),
    ),
  );

  const acquireSupervisorLocked = Effect.fn(
    "EnvironmentRegistry.acquireSupervisorLocked",
  )(function* (environmentId: EnvironmentId) {
    const entry = yield* getEntry(environmentId);
    const existing = (yield* SubscriptionRef.get(serviceScopes)).get(
      environmentId,
    );
    if (existing !== undefined) {
      if (Equal.equals(existing.entry, entry)) {
        return existing.supervisor;
      }
      yield* closeServiceScope(environmentId);
    }
    return yield* createServiceScope(entry);
  });

  const acquireSupervisor = Effect.fn("EnvironmentRegistry.acquireSupervisor")(
    (environmentId: EnvironmentId) =>
      withLeaseLock(environmentId, acquireSupervisorLocked(environmentId)),
  );

  const run: EnvironmentRegistry["Service"]["run"] = Effect.fn(
    "EnvironmentRegistry.run",
  )(function* <A, E, R>(
    environmentId: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ) {
    const supervisor = yield* acquireSupervisor(environmentId);
    return yield* Effect.provideService(
      effect,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisor,
    );
  });

  const runStream: EnvironmentRegistry["Service"]["runStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.unwrap(
      acquireSupervisor(environmentId).pipe(
        Effect.map((supervisor) =>
          Stream.provideService(
            stream,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisor,
          ),
        ),
      ),
    );

  const followStream: EnvironmentRegistry["Service"]["followStream"] = <
    A,
    E,
    R,
  >(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(entries)),
      SubscriptionRef.changes(entries),
    ).pipe(
      Stream.map((current) =>
        Option.fromUndefinedOr(current.get(environmentId)),
      ),
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
                    Stream.provideService(
                      stream,
                      EnvironmentSupervisor.EnvironmentSupervisor,
                      supervisor,
                    ),
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
      [...(yield* Ref.get(persistedTargetsByEnvironment)).values()],
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

  const installEntryLocked = Effect.fn(
    "EnvironmentRegistry.installEntryLocked",
  )(function* (
    entry: ConnectionCatalogEntry,
    options?: {
      readonly retainEquivalentRuntime?: boolean;
      readonly initiallyDesired?: boolean;
    },
  ) {
    const target = entry.target;
    const previous = (yield* SubscriptionRef.get(entries)).get(
      target.environmentId,
    );
    const existingScope = (yield* SubscriptionRef.get(serviceScopes)).get(
      target.environmentId,
    );
    if (
      options?.retainEquivalentRuntime === true &&
      previous !== undefined &&
      entriesHaveEquivalentRuntime(previous, entry) &&
      existingScope !== undefined &&
      entriesHaveEquivalentRuntime(existingScope.entry, entry)
    ) {
      yield* SubscriptionRef.update(entries, (current) => {
        const next = new Map(current);
        next.set(target.environmentId, entry);
        return next;
      });
      yield* SubscriptionRef.update(serviceScopes, (current) => {
        const next = new Map(current);
        next.set(target.environmentId, { ...existingScope, entry });
        return next;
      });
      if (options.initiallyDesired === true) {
        yield* existingScope.supervisor.connect;
      } else if (options.initiallyDesired === false) {
        yield* existingScope.supervisor.disconnect;
      }
      return;
    }

    yield* closeServiceScope(target.environmentId);
    yield* SubscriptionRef.update(entries, (current) => {
      const next = new Map(current);
      next.set(target.environmentId, entry);
      return next;
    });
    yield* createServiceScope(entry, options?.initiallyDesired);
  });

  const installRegistrationLocked = Effect.fn(
    "EnvironmentRegistry.installRegistrationLocked",
  )(function* (
    registration: ConnectionRegistration,
    enabled: boolean,
    options?: { readonly retainEquivalentRuntime?: boolean },
  ) {
    const entry = connectionRegistrationCatalogEntry(registration);
    const environmentId = entry.target.environmentId;
    yield* registrations.register(registration, { enabled });
    if (enabled) {
      disabledEnvironmentIds.delete(environmentId);
    } else {
      disabledEnvironmentIds.add(environmentId);
    }
    yield* Ref.update(persistedTargetsByEnvironment, (current) => {
      const next = new Map(current);
      next.set(environmentId, registration.target);
      return next;
    });
    yield* installEntryLocked(
      entry,
      options?.retainEquivalentRuntime === true
        ? { initiallyDesired: enabled, retainEquivalentRuntime: true }
        : { initiallyDesired: enabled },
    );
  });

  const register = Effect.fn("EnvironmentRegistry.register")(function* (
    registration: ConnectionRegistration,
    options?: { readonly enabled?: boolean },
  ) {
    const environmentId = registration.target.environmentId;
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return;
        }
        yield* installRegistrationLocked(registration, options?.enabled ?? true);
      }),
    );
  });

  const updateRegistration = Effect.fn("EnvironmentRegistry.updateRegistration")(function* (
    environmentId: EnvironmentId,
    prepare: Effect.Effect<BearerConnectionRegistration, ConnectionAttemptError>,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        yield* getEntry(environmentId);
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return;
        }
        const registration = yield* prepare;
        yield* installRegistrationLocked(
          registration,
          !disabledEnvironmentIds.has(environmentId),
          { retainEquivalentRuntime: true },
        );
      }),
    );
  });

  const installPlatformRegistration = Effect.fn(
    "EnvironmentRegistry.installPlatformRegistration",
  )(function* (registration: PlatformConnectionRegistration) {
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

        // Secondary desktop-local backends (e.g. a parallel WSL backend) live
        // on their own loopback origin, so they authenticate with a bearer
        // token instead of the primary's same-origin cookie. Stash it where
        // the resolver's bearer broker looks it up.
        if (registration._tag === "BearerConnectionRegistration") {
          yield* credentials
            .put(registration.target.connectionId, registration.credential)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "Could not store the platform bearer credential.",
                  {
                    environmentId: target.environmentId,
                    error,
                  },
                ),
              ),
            );
        }

        const persistedTarget = (yield* Ref.get(
          persistedTargetsByEnvironment,
        )).get(target.environmentId);
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
                "Could not remove a persisted registration shadowed by a platform environment.",
                {
                  environmentId: target.environmentId,
                  error,
                },
              ),
            ),
          );
        }
        yield* activation.setEnabled(target.environmentId, true).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "Could not clear disabled state for a platform environment.",
              { environmentId: target.environmentId, error },
            ),
          ),
        );
        disabledEnvironmentIds.delete(target.environmentId);

        yield* installEntryLocked(entry, {
          retainEquivalentRuntime: true,
          initiallyDesired: true,
        });
      }),
    );
  });

  // Tear down a platform-managed environment that the host no longer reports
  // (e.g. the user turned the parallel WSL backend off). Platform environments
  // bypass the user-facing `remove` guard since they are reconciled from the
  // bootstrap rather than removed by hand.
  const removePlatformEnvironment = Effect.fn(
    "EnvironmentRegistry.removePlatformEnvironment",
  )(function* (environmentId: EnvironmentId) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
        yield* Ref.update(platformEnvironmentIds, (current) => {
          const next = new Set(current);
          next.delete(environmentId);
          return next;
        });
        yield* closeServiceScope(environmentId);
        const persistedTarget = (yield* Ref.get(
          persistedTargetsByEnvironment,
        )).get(environmentId);
        if (
          entry !== undefined &&
          entry.target._tag === "BearerConnectionTarget" &&
          (persistedTarget?._tag !== "BearerConnectionTarget" ||
            persistedTarget.connectionId !== entry.target.connectionId)
        ) {
          yield* credentials.remove(entry.target.connectionId).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                "Could not clear the platform bearer credential.",
                {
                  environmentId,
                  error,
                },
              ),
            ),
          );
        }
        if (persistedTarget !== undefined) {
          const profile =
            persistedTarget._tag === "BearerConnectionTarget" ||
            persistedTarget._tag === "SshConnectionTarget"
              ? yield* profiles.get(persistedTarget.connectionId).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(
                      "Could not reload a persisted environment profile after its platform registration disappeared.",
                      { environmentId, error },
                    ).pipe(Effect.as(Option.none())),
                  ),
                )
              : Option.none();
          yield* installEntryLocked({ target: persistedTarget, profile });
          return;
        }
        yield* SubscriptionRef.update(entries, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
        yield* Effect.all(
          [
            cache.clear(environmentId).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "Could not clear cached environment data after removal.",
                  {
                    environmentId,
                    error,
                  },
                ),
              ),
            ),
            ownedDataCleanup.clear(environmentId),
          ],
          { concurrency: "unbounded", discard: true },
        );
      }),
    );
  });

  const registerPlatform = Effect.fn("EnvironmentRegistry.registerPlatform")(
    function* (registration: PrimaryConnectionRegistration) {
      yield* installPlatformRegistration(registration);
    },
  );

  // Reconcile the full set of platform-managed environments against what the
  // host currently reports: add/refresh the desired ones and tear down any
  // platform environment that disappeared (WSL toggled off, distro switched).
  const reconcilePlatform = Effect.fn("EnvironmentRegistry.reconcilePlatform")(
    function* (
      platformRegistrations: ReadonlyArray<PlatformConnectionRegistration>,
    ) {
      const desiredIds = new Set(
        platformRegistrations.map(
          (registration) => registration.target.environmentId,
        ),
      );
      const currentPlatformIds = yield* Ref.get(platformEnvironmentIds);
      yield* Effect.forEach(
        currentPlatformIds,
        (environmentId) =>
          desiredIds.has(environmentId)
            ? Effect.void
            : removePlatformEnvironment(environmentId),
        { discard: true },
      );
      yield* Effect.forEach(
        platformRegistrations,
        installPlatformRegistration,
        { discard: true },
      );
    },
  );

  const remove = Effect.fn("EnvironmentRegistry.remove")(function* (
    environmentId: EnvironmentId,
  ) {
    return yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return yield* new PlatformEnvironmentRemovalError({
            environmentId,
          });
        }
        const target = (yield* getEntry(environmentId)).target;
        const profile =
          target._tag === "BearerConnectionTarget" ||
          target._tag === "SshConnectionTarget"
            ? yield* profiles.get(target.connectionId)
            : Option.none();

        yield* registrations.remove(target).pipe(
          Effect.tap(() =>
            Effect.sync(() => disabledEnvironmentIds.delete(environmentId)),
          ),
        );
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
                Effect.logWarning(
                  "Could not clear cached environment data after removal.",
                  {
                    environmentId,
                    error,
                  },
                ),
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
              Effect.logWarning(
                "Could not disconnect the managed SSH environment.",
                {
                  environmentId,
                  error,
                },
              ),
            ),
            Effect.ignore,
          );
        }
      }),
    );
  });

  const removeRelayEnvironments = Effect.fn(
    "EnvironmentRegistry.removeRelayEnvironments",
  )(function* () {
    const relayEnvironmentIds = [
      ...(yield* SubscriptionRef.get(entries)).values(),
    ]
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
  });

  const retryNow = (environmentId: EnvironmentId) =>
    acquireSupervisor(environmentId).pipe(
      Effect.flatMap((supervisor) => supervisor.retryNow),
      Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
      Effect.withSpan("EnvironmentRegistry.retryNow"),
    );
  const setEnabled = Effect.fn("EnvironmentRegistry.setEnabled")(function* (
    environmentId: EnvironmentId,
    enabled: boolean,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        yield* getEntry(environmentId);
        yield* activation.setEnabled(environmentId, enabled).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (enabled) {
                disabledEnvironmentIds.delete(environmentId);
              } else {
                disabledEnvironmentIds.add(environmentId);
              }
            }),
          ),
        );
        const supervisor = yield* acquireSupervisorLocked(environmentId);
        yield* enabled ? supervisor.connect : supervisor.disconnect;
      }),
    );
  });
  const state = Effect.fn("EnvironmentRegistry.state")(function* (
    environmentId: EnvironmentId,
  ) {
    const supervisor = yield* acquireSupervisor(environmentId);
    return yield* SubscriptionRef.get(supervisor.state);
  });
  const stateChanges = (environmentId: EnvironmentId) =>
    followStream(
      environmentId,
      Stream.unwrap(
        EnvironmentSupervisor.EnvironmentSupervisor.pipe(
          Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
        ),
      ),
    );

  yield* Effect.addFinalizer(() =>
    SubscriptionRef.get(serviceScopes).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(
          current.values(),
          (lease) => Scope.close(lease.scope, Exit.void),
          {
            concurrency: "unbounded",
            discard: true,
          },
        ),
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
    updateRegistration,
    registerPlatform,
    reconcilePlatform,
    remove,
    removeRelayEnvironments,
    retryNow,
    setEnabled,
    state,
    stateChanges,
    run,
    runStream,
    followStream,
  });
});

export const layer = Layer.effect(EnvironmentRegistry, make);
