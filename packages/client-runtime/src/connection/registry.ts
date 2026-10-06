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
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  type ConnectionProfile,
  type ConnectionRegistration,
  type ConnectionRoute,
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
  PersistedConnectionTarget,
  SupervisorConnectionState,
} from "./model.ts";
import { ConnectionBlockedError } from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import {
  GitHubRoutingPermissions,
  gitHubRoutingConnectionKey,
} from "./githubRoutingPermissions.ts";
import {
  RELAY_ROUTE_ID,
  connectionRouteId,
  connectionRoutes,
  entryWithRoutes,
  findRouteToSameAddress,
  isLearned,
  mergeLearnedRoutes,
  routesAfterRemoving,
  upsertRoute,
} from "./routes.ts";

const isSshConnectionProfile = Schema.is(SshConnectionProfile);

function unsupportedState(
  entry: ConnectionCatalogEntry,
): Pick<ConnectionCatalogEntry, "unsupportedReason" | "serverUpdateRequired"> {
  return {
    ...(entry.unsupportedReason === undefined
      ? {}
      : { unsupportedReason: entry.unsupportedReason }),
    ...(entry.serverUpdateRequired === true ? { serverUpdateRequired: true } : {}),
  };
}

export class EnvironmentNotRegisteredError extends Schema.TaggedError<EnvironmentNotRegisteredError>()(
  "EnvironmentNotRegisteredError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is not registered.`;
  }
}

export class PlatformEnvironmentRemovalError extends Schema.TaggedError<PlatformEnvironmentRemovalError>()(
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
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly registerPlatform: (registration: PrimaryConnectionRegistration) => Effect.Effect<void>;
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
    /**
     * Drops one route. Removing an environment's last route removes the
     * environment, the same as `remove`.
     */
    readonly removeRoute: (
      environmentId: EnvironmentId,
      routeId: string,
    ) => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | ConnectionAttemptError
      | EnvironmentNotRegisteredError
      | PlatformEnvironmentRemovalError
    >;
    /** Reorders an environment's routes; `routeIds` lists every route, preferred first. */
    readonly reorderRoutes: (
      environmentId: EnvironmentId,
      routeIds: ReadonlyArray<string>,
    ) => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | EnvironmentNotRegisteredError
      | PlatformEnvironmentRemovalError
      | ConnectionBlockedError
    >;
    /**
     * Drops the T3 Connect route of every environment, after a cloud sign-out
     * or account change. Environments with no other route are removed.
     */
    readonly removeRelayEnvironments: () => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | ConnectionAttemptError
      | PlatformEnvironmentRemovalError
    >;
    readonly retryNow: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /**
     * Switches a saved environment on or off. Off drops the socket, stops the
     * retry ladder, and persists so the next launch stays off. Registration,
     * credentials, and cache are untouched.
     */
    readonly setEnabled: (
      environmentId: EnvironmentId,
      enabled: boolean,
    ) => Effect.Effect<
      void,
      | EnvironmentNotRegisteredError
      | Persistence.ConnectionPersistenceError
      | ConnectionBlockedError
    >;
    readonly setCompatibility: (
      environmentId: EnvironmentId,
      error: ConnectionBlockedError | null,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly state: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<SupervisorConnectionState, EnvironmentNotRegisteredError>;
    readonly stateChanges: (
      environmentId: EnvironmentId,
    ) => Stream.Stream<SupervisorConnectionState, EnvironmentNotRegisteredError>;
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
    ) => Stream.Stream<A, E, Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>>;
  }
>()("@t3tools/client-runtime/connection/registry/EnvironmentRegistry") {}

interface EnvironmentServiceScope {
  readonly entry: ConnectionCatalogEntry;
  readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  readonly scope: Scope.Closeable;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registryScope = yield* Scope.Scope;
  const storage = yield* Persistence.ConnectionTargetStore;
  const registrations = yield* Persistence.ConnectionRegistrationStore;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const ownedDataCleanup = yield* Persistence.EnvironmentOwnedDataCleanup;
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const githubRoutingPermissions = yield* GitHubRoutingPermissions;
  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const persistedTargets = yield* storage.list;
  const disabledEnvironmentIds = new Set(yield* storage.listDisabled);
  const loadRoute = Effect.fn("EnvironmentRegistry.loadRoute")(function* (
    target: ConnectionTarget,
  ) {
    const profile: Option.Option<ConnectionProfile> =
      target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget"
        ? yield* profiles.get(target.connectionId)
        : Option.none();
    return { target, profile } satisfies ConnectionRoute;
  });
  const persistedRoutesByEnvironment = new Map<EnvironmentId, Array<ConnectionTarget>>();
  for (const target of persistedTargets) {
    const routes = persistedRoutesByEnvironment.get(target.environmentId) ?? [];
    routes.push(target);
    persistedRoutesByEnvironment.set(target.environmentId, routes);
  }
  const initialEntries = new Map(
    yield* Effect.forEach(
      persistedRoutesByEnvironment,
      Effect.fn("EnvironmentRegistry.loadCatalogEntry")(function* ([environmentId, targets]) {
        const loaded = yield* Effect.forEach(targets, loadRoute, { concurrency: "unbounded" });
        // A learned route without its profile has no address to reach; it is
        // learned again on the next connection. A paired route keeps its slot
        // so its missing profile still surfaces as a connection error.
        const seen = new Set<string>();
        const usable = loaded.filter((route) => {
          const id = connectionRouteId(route.target);
          if (seen.has(id)) return false;
          seen.add(id);
          return !(id.startsWith("learned:") && Option.isNone(route.profile));
        });
        const routes = usable.length > 0 ? usable : loaded.slice(0, 1);
        const first = routes[0]!;
        return [
          environmentId,
          entryWithRoutes(
            {
              target: first.target,
              profile: first.profile,
              enabled: !disabledEnvironmentIds.has(environmentId),
            },
            routes,
          ),
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
  const persistedEnvironmentIds = yield* Ref.make<ReadonlySet<EnvironmentId>>(
    new Set(persistedRoutesByEnvironment.keys()),
  );
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
          const scope = yield* Scope.fork(registryScope);
          const supervisor = yield* EnvironmentSupervisor.make(entry, {
            initiallyDesired: false,
            learnRoutes: (input) => learnRoutes({ environmentId, ...input }),
          }).pipe(
            Effect.provideService(Connectivity.Connectivity, connectivity),
            Effect.provideService(ConnectionDriver.ConnectionDriver, driver),
            Effect.provideService(ConnectionWakeups.ConnectionWakeups, wakeups),
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          if (entry.enabled) {
            yield* supervisor.connect;
          }
          yield* SubscriptionRef.update(serviceScopes, (current) => {
            const next = new Map(current);
            next.set(environmentId, { entry, supervisor, scope });
            return next;
          });
          yield* SubscriptionRef.changes(supervisor.state).pipe(
            Stream.runForEach((state) =>
              state.phase === "blocked" && state.lastFailure?.reason === "unsupported"
                ? setCompatibility(environmentId, state.lastFailure).pipe(
                    Effect.catch((error) =>
                      Effect.logWarning("Could not disable an unsupported environment.", {
                        environmentId,
                        error,
                      }),
                    ),
                  )
                : Effect.void,
            ),
            Effect.forkIn(scope),
          );
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

  const run: EnvironmentRegistry["Service"]["run"] = Effect.fn("EnvironmentRegistry.run")(
    function* <A, E, R>(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) {
      const supervisor = yield* acquireSupervisor(environmentId);
      return yield* Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );
    },
  );

  const runStream: EnvironmentRegistry["Service"]["runStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.unwrap(
      acquireSupervisor(environmentId).pipe(
        Effect.map((supervisor) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        ),
      ),
    );

  const followStream: EnvironmentRegistry["Service"]["followStream"] = <A, E, R>(
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
      persistedRoutesByEnvironment.keys(),
      (environmentId) =>
        acquireSupervisor(environmentId).pipe(
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

  const forgetRoutingTrust = (
    environmentId: EnvironmentId,
    operation: "register-connection" | "set-connection-routes",
  ) =>
    githubRoutingPermissions.forget(environmentId).pipe(
      Effect.mapError(
        (error) =>
          new Persistence.ConnectionPersistenceError({
            operation,
            message: error.message,
          }),
      ),
    );

  const persistedRoutes = (entry: ConnectionCatalogEntry) =>
    connectionRoutes(entry).map((route) => route.target as PersistedConnectionTarget);

  /**
   * The entry after its routes change. GitHub trust and an unsupported
   * verdict both belong to the saved addresses: a changed set may reach a
   * different server, so both are dropped and the next connection decides.
   * Reordering keeps the same addresses, so both stay.
   */
  const withRoutes = (previous: ConnectionCatalogEntry, routes: ReadonlyArray<ConnectionRoute>) => {
    const next = entryWithRoutes(previous, routes);
    if (gitHubRoutingConnectionKey(previous) === gitHubRoutingConnectionKey(next)) {
      return { entry: next, addressesChanged: false };
    }
    const { unsupportedReason: _reason, serverUpdateRequired: _update, ...rest } = next;
    return { entry: rest, addressesChanged: true };
  };

  const register = Effect.fn("EnvironmentRegistry.register")(function* (
    registration: ConnectionRegistration,
  ) {
    const registered = connectionRegistrationCatalogEntry(registration);
    const environmentId = registered.target.environmentId;
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return;
        }
        // A new route joins the environment's saved routes. Registering one it
        // already has (the same id, or a pairing to the same address) replaces
        // it in place. Editing keeps the disabled state.
        const previous = (yield* SubscriptionRef.get(entries)).get(environmentId);
        let entry = registered;
        if (previous !== undefined) {
          const route: ConnectionRoute = { target: registered.target, profile: registered.profile };
          const existing = connectionRoutes(previous);
          const sameAddress = findRouteToSameAddress(existing, route);
          const routes = existing.filter(
            (existing) =>
              existing !== sameAddress ||
              connectionRouteId(existing.target) === connectionRouteId(route.target),
          );
          const next = withRoutes(previous, upsertRoute(routes, route));
          if (next.addressesChanged) {
            yield* forgetRoutingTrust(environmentId, "register-connection");
          }
          entry = next.entry;
        }
        yield* registrations.register(registration, persistedRoutes(entry));
        yield* Ref.update(persistedEnvironmentIds, (current) =>
          new Set(current).add(environmentId),
        );
        yield* installEntryLocked(entry);
      }),
    );
  });

  /** Writes a new route list for a user-saved environment and restarts its connection. */
  const replaceRoutesLocked = Effect.fn("EnvironmentRegistry.replaceRoutesLocked")(function* (
    previous: ConnectionCatalogEntry,
    routes: ReadonlyArray<ConnectionRoute>,
  ) {
    const environmentId = previous.target.environmentId;
    const next = withRoutes(previous, routes);
    if (next.addressesChanged) {
      yield* forgetRoutingTrust(environmentId, "set-connection-routes");
    }
    yield* registrations.setRoutes(environmentId, persistedRoutes(next.entry));
    yield* installEntryLocked(next.entry);
  });

  const userEntry = Effect.fn("EnvironmentRegistry.userEntry")(function* (
    environmentId: EnvironmentId,
  ) {
    if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
      return yield* new PlatformEnvironmentRemovalError({ environmentId });
    }
    return yield* getEntry(environmentId);
  });

  const installPlatformRegistration = Effect.fn("EnvironmentRegistry.installPlatformRegistration")(
    function* (registration: PlatformConnectionRegistration) {
      const registered = connectionRegistrationCatalogEntry(registration);
      const target = registered.target;
      yield* withLeaseLock(
        target.environmentId,
        Effect.gen(function* () {
          const previous = (yield* SubscriptionRef.get(entries)).get(target.environmentId);
          const entry: ConnectionCatalogEntry =
            previous?.unsupportedReason !== undefined &&
            gitHubRoutingConnectionKey(previous) === gitHubRoutingConnectionKey(registered)
              ? { ...registered, enabled: false, ...unsupportedState(previous) }
              : registered;
          const persisted = (yield* Ref.get(persistedEnvironmentIds)).has(target.environmentId);
          if (
            persisted ||
            (previous !== undefined &&
              gitHubRoutingConnectionKey(previous) !== gitHubRoutingConnectionKey(entry))
          ) {
            const revoked = yield* githubRoutingPermissions.forget(target.environmentId).pipe(
              Effect.tapError((error) =>
                Effect.logWarning(
                  "Could not clear GitHub routing permission for a platform environment.",
                  {
                    environmentId: target.environmentId,
                    error,
                  },
                ),
              ),
              Effect.exit,
            );
            if (Exit.isFailure(revoked)) return;
          }
          yield* Ref.update(platformEnvironmentIds, (current) => {
            const next = new Set(current);
            next.add(target.environmentId);
            return next;
          });

          // Secondary desktop-local backends (e.g. a parallel WSL backend) live
          // on their own loopback origin, so they authenticate with a bearer
          // token instead of the primary's same-origin cookie. Stash it where
          // the resolver's bearer broker looks it up.
          let bearerReplaced = false;
          if (registration._tag === "BearerConnectionRegistration") {
            const stored = yield* credentials
              .get(registration.target.connectionId)
              .pipe(Effect.orElseSucceed(() => Option.none<ConnectionCredential>()));
            const changed =
              Option.isSome(stored) && !Equal.equals(stored.value, registration.credential);
            // Only a bearer that was actually stored can be retried with; a
            // failed write leaves the rejected one in place.
            bearerReplaced = yield* credentials
              .put(registration.target.connectionId, registration.credential)
              .pipe(
                Effect.as(changed),
                Effect.catch((error) =>
                  Effect.logWarning("Could not store the platform bearer credential.", {
                    environmentId: target.environmentId,
                    error,
                  }).pipe(Effect.as(false)),
                ),
              );
          }

          if (persisted) {
            yield* registrations.remove(target.environmentId).pipe(
              Effect.tap(() =>
                Ref.update(persistedEnvironmentIds, (current) => {
                  const next = new Set(current);
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

          yield* installEntryLocked(entry, { retainEquivalentRuntime: true });

          // The catalog entry carries no credential, so a fresh bearer keeps
          // the equivalent runtime. Anything not yet connected may be using the
          // old bearer: an attempt in flight would fail with it and then wait
          // blocked for a manual retry. Retry with the new one instead. A
          // connected session keeps its socket.
          if (bearerReplaced) {
            const scope = (yield* SubscriptionRef.get(serviceScopes)).get(target.environmentId);
            if (scope !== undefined) {
              const state = yield* SubscriptionRef.get(scope.supervisor.state);
              if (
                state.phase === "connecting" ||
                state.phase === "backoff" ||
                (state.phase === "blocked" &&
                  state.lastFailure?._tag === "ConnectionBlockedError" &&
                  state.lastFailure.reason === "authentication")
              ) {
                yield* scope.supervisor.retryNow;
              }
            }
          }
        }),
      );
    },
  );

  // Tear down a platform-managed environment that the host no longer reports
  // (e.g. the user turned the parallel WSL backend off). Platform environments
  // bypass the user-facing `remove` guard since they are reconciled from the
  // bootstrap rather than removed by hand.
  const removePlatformEnvironment = Effect.fn("EnvironmentRegistry.removePlatformEnvironment")(
    function* (environmentId: EnvironmentId) {
      yield* withLeaseLock(
        environmentId,
        Effect.gen(function* () {
          const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
          const revoked = yield* githubRoutingPermissions.forget(environmentId).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                "Could not clear GitHub routing permission after platform removal.",
                {
                  environmentId,
                  error,
                },
              ),
            ),
            Effect.exit,
          );
          if (Exit.isFailure(revoked)) return;
          yield* Ref.update(platformEnvironmentIds, (current) => {
            const next = new Set(current);
            next.delete(environmentId);
            return next;
          });
          yield* closeServiceScope(environmentId);
          yield* SubscriptionRef.update(entries, (current) => {
            const next = new Map(current);
            next.delete(environmentId);
            return next;
          });
          if (entry !== undefined && entry.target._tag === "BearerConnectionTarget") {
            yield* credentials.remove(entry.target.connectionId).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not clear the platform bearer credential.", {
                  environmentId,
                  error,
                }),
              ),
            );
          }
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
        }),
      );
    },
  );

  const registerPlatform = Effect.fn("EnvironmentRegistry.registerPlatform")(function* (
    registration: PrimaryConnectionRegistration,
  ) {
    yield* installPlatformRegistration(registration);
  });

  // Reconcile the full set of platform-managed environments against what the
  // host currently reports: add/refresh the desired ones and tear down any
  // platform environment that disappeared (WSL toggled off, distro switched).
  const reconcilePlatform = Effect.fn("EnvironmentRegistry.reconcilePlatform")(function* (
    platformRegistrations: ReadonlyArray<PlatformConnectionRegistration>,
  ) {
    const desiredIds = new Set(
      platformRegistrations.map((registration) => registration.target.environmentId),
    );
    const currentPlatformIds = yield* Ref.get(platformEnvironmentIds);
    yield* Effect.forEach(
      currentPlatformIds,
      (environmentId) =>
        desiredIds.has(environmentId) ? Effect.void : removePlatformEnvironment(environmentId),
      { discard: true },
    );
    yield* Effect.forEach(platformRegistrations, installPlatformRegistration, { discard: true });
  });

  /** Forgets a user-saved environment. Callers hold its lease lock. */
  const removeLocked = Effect.fn("EnvironmentRegistry.removeLocked")(function* (
    environmentId: EnvironmentId,
  ) {
    if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
      return yield* new PlatformEnvironmentRemovalError({
        environmentId,
      });
    }
    const entry = yield* getEntry(environmentId);

    yield* githubRoutingPermissions.forget(environmentId);
    yield* registrations.remove(environmentId);
    yield* Ref.update(persistedEnvironmentIds, (current) => {
      const next = new Set(current);
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

    for (const route of connectionRoutes(entry)) {
      const profile = Option.getOrNull(route.profile);
      if (profile !== null && isSshConnectionProfile(profile)) {
        yield* disconnectSsh(environmentId, profile);
      }
    }
  });

  const remove = Effect.fn("EnvironmentRegistry.remove")(function* (environmentId: EnvironmentId) {
    return yield* withLeaseLock(environmentId, removeLocked(environmentId));
  });

  const disconnectSsh = (environmentId: EnvironmentId, profile: SshConnectionProfile) =>
    ssh.disconnect(profile.target).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Could not disconnect the managed SSH environment.", {
          environmentId,
          error,
        }),
      ),
      Effect.ignore,
    );

  // Plain HTTP routes are unusable from an HTTPS page, which blocks mixed content.
  const allowInsecureRoutes =
    typeof globalThis.location === "undefined" || globalThis.location.protocol !== "https:";

  /**
   * Saves the direct addresses a connected server reports as learned routes,
   * replacing learned routes it no longer reports. Routes the user saved are
   * never changed. Learned routes reuse the active route's credential, so they
   * do not revoke GitHub routing trust the way a newly paired address does.
   */
  const learnRoutes = Effect.fn("EnvironmentRegistry.learnRoutes")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly activeRoute: ConnectionRoute;
    readonly reported: ReadonlyArray<{ readonly httpBaseUrl: string }>;
  }) {
    return yield* withLeaseLock(
      input.environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(input.environmentId)) {
          return Option.none<ConnectionCatalogEntry>();
        }
        const entry = (yield* SubscriptionRef.get(entries)).get(input.environmentId);
        if (entry === undefined) return Option.none<ConnectionCatalogEntry>();
        const routes = mergeLearnedRoutes({
          entry,
          activeRoute: input.activeRoute,
          reported: input.reported,
          allowInsecure: allowInsecureRoutes,
        });
        if (routes === null) return Option.none<ConnectionCatalogEntry>();
        const next = entryWithRoutes(entry, routes);
        // A learned route owns its profile (address and authorization); the
        // credential stays with the route it borrows from.
        const previousIds = new Set(
          connectionRoutes(entry).map((route) => connectionRouteId(route.target)),
        );
        for (const route of routes) {
          if (!isLearned(route) || previousIds.has(connectionRouteId(route.target))) continue;
          const profile = Option.getOrNull(route.profile);
          if (profile !== null) yield* profiles.put(profile);
        }
        yield* registrations.setRoutes(input.environmentId, persistedRoutes(next));
        // Update the lease in place: the live session already works, and
        // `installEntryLocked` would replace it for a route list change.
        const lease = (yield* SubscriptionRef.get(serviceScopes)).get(input.environmentId);
        if (lease !== undefined) {
          yield* SubscriptionRef.update(serviceScopes, (current) =>
            new Map(current).set(input.environmentId, { ...lease, entry: next }),
          );
        }
        yield* SubscriptionRef.update(entries, (current) =>
          new Map(current).set(input.environmentId, next),
        );
        return Option.some(next);
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not save routes learned from the environment.", {
          environmentId: input.environmentId,
          error,
        }).pipe(Effect.as(Option.none<ConnectionCatalogEntry>())),
      ),
    );
  });

  const removeRoute = Effect.fn("EnvironmentRegistry.removeRoute")(function* (
    environmentId: EnvironmentId,
    routeId: string,
  ) {
    // One lock for the whole decision: a route registered between "this was
    // the last route" and the removal must not be deleted with it.
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = yield* userEntry(environmentId);
        const routes = connectionRoutes(entry);
        const route = routes.find((candidate) => connectionRouteId(candidate.target) === routeId);
        if (route === undefined) return;
        const remaining = routesAfterRemoving(routes, routeId);
        if (remaining.length === 0) return yield* removeLocked(environmentId);
        yield* replaceRoutesLocked(entry, remaining);
        const profile = Option.getOrNull(route.profile);
        if (profile !== null && isSshConnectionProfile(profile)) {
          yield* disconnectSsh(environmentId, profile);
        }
      }),
    );
  });

  const reorderRoutes = Effect.fn("EnvironmentRegistry.reorderRoutes")(function* (
    environmentId: EnvironmentId,
    routeIds: ReadonlyArray<string>,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = yield* userEntry(environmentId);
        const routes = connectionRoutes(entry);
        const byId = new Map(routes.map((route) => [connectionRouteId(route.target), route]));
        const reordered = routeIds.flatMap((id) => byId.get(id) ?? []);
        if (reordered.length !== routes.length || new Set(routeIds).size !== routes.length) {
          return yield* new ConnectionBlockedError({
            reason: "configuration",
            detail: "The route order must list every saved route once.",
          });
        }
        if (reordered.every((route, index) => route === routes[index])) return;
        yield* replaceRoutesLocked(entry, reordered);
      }),
    );
  });

  const removeRelayEnvironments = Effect.fn("EnvironmentRegistry.removeRelayEnvironments")(
    function* () {
      const relayEnvironmentIds = [...(yield* SubscriptionRef.get(entries)).values()]
        .filter((entry) =>
          connectionRoutes(entry).some((route) => route.target._tag === "RelayConnectionTarget"),
        )
        .map((entry) => entry.target.environmentId);

      yield* Effect.forEach(
        relayEnvironmentIds,
        (environmentId) =>
          removeRoute(environmentId, RELAY_ROUTE_ID).pipe(
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
  const setEnabled = Effect.fn("EnvironmentRegistry.setEnabled")(function* (
    environmentId: EnvironmentId,
    enabled: boolean,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = yield* getEntry(environmentId);
        if (enabled && entry.unsupportedReason !== undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: entry.unsupportedReason,
          });
        }
        if (entry.enabled === enabled) {
          return;
        }
        // Platform-managed environments are reconciled from the host and are
        // never persisted, so only user-saved ones write the flag.
        if (!(yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          yield* registrations.setEnabled(environmentId, enabled);
        }
        const next: ConnectionCatalogEntry = { ...entry, enabled };
        // Update the lease in place so the supervisor keeps its generation and
        // durable streams; `installEntryLocked` would tear it down instead.
        const lease = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
        if (lease !== undefined) {
          yield* SubscriptionRef.update(serviceScopes, (current) => {
            const nextScopes = new Map(current);
            nextScopes.set(environmentId, { ...lease, entry: next });
            return nextScopes;
          });
        }
        yield* SubscriptionRef.update(entries, (current) => {
          const nextEntries = new Map(current);
          nextEntries.set(environmentId, next);
          return nextEntries;
        });
        if (lease !== undefined) {
          yield* enabled ? lease.supervisor.connect : lease.supervisor.disconnect;
        } else if (enabled) {
          yield* createServiceScope(next);
        }
        // The supervisor only owns the RPC session. A managed SSH backend and
        // its tunnel outlive it, so switching off tears those down as well.
        if (!enabled) {
          for (const route of connectionRoutes(entry)) {
            const profile = Option.getOrNull(route.profile);
            if (profile !== null && isSshConnectionProfile(profile)) {
              yield* disconnectSsh(environmentId, profile);
            }
          }
        }
      }),
    );
  });

  const state = Effect.fn("EnvironmentRegistry.state")(function* (environmentId: EnvironmentId) {
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

  const setCompatibility = Effect.fn("EnvironmentRegistry.setCompatibility")(function* (
    environmentId: EnvironmentId,
    error: ConnectionBlockedError | null,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
        if (
          entry === undefined ||
          (entry.unsupportedReason === (error?.message ?? undefined) &&
            entry.serverUpdateRequired === (error?.serverUpdateRequired ?? undefined))
        )
          return;
        const {
          unsupportedReason: _previousReason,
          serverUpdateRequired: _previousUpdateRequired,
          ...rest
        } = entry;
        const next: ConnectionCatalogEntry =
          error === null
            ? rest
            : {
                ...rest,
                enabled: false,
                unsupportedReason: error.message,
                ...(error.serverUpdateRequired === true ? { serverUpdateRequired: true } : {}),
              };
        if (
          error !== null &&
          entry.enabled &&
          !(yield* Ref.get(platformEnvironmentIds)).has(environmentId)
        ) {
          yield* registrations.setEnabled(environmentId, false);
        }
        const lease = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
        if (lease !== undefined) {
          yield* SubscriptionRef.update(serviceScopes, (current) =>
            new Map(current).set(environmentId, { ...lease, entry: next }),
          );
          if (error !== null) yield* lease.supervisor.disconnect;
        }
        yield* SubscriptionRef.update(entries, (current) =>
          new Map(current).set(environmentId, next),
        );
      }),
    );
  });

  return EnvironmentRegistry.of({
    entries,
    networkStatus,
    start,
    register,
    registerPlatform,
    reconcilePlatform,
    remove,
    removeRoute,
    reorderRoutes,
    removeRelayEnvironments,
    retryNow,
    setEnabled,
    setCompatibility,
    state,
    stateChanges,
    run,
    runStream,
    followStream,
  });
});

export const layer = Layer.effect(EnvironmentRegistry, make);
