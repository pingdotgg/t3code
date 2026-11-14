import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  type ConnectionRoute,
  connectionRegistrationCatalogEntry,
} from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import type { PersistedConnectionTarget } from "./model.ts";
import { ConnectionBlockedError } from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { pullRequestRoutingConnectionKey } from "./pullRequestRoutingPermissions.ts";
import {
  connectionRouteId,
  connectionRoutes,
  entryWithRoutes,
  findRouteToSameAddress,
  mergeLearnedRoutes,
  upsertRoute,
  type ReportedEndpoint,
} from "./routes.ts";

import type { makeRegistryState } from "./registryState.ts";
import { EnvironmentNotRegisteredError, PlatformEnvironmentRemovalError } from "./registryModel.ts";
import { EnvironmentRegistry } from "./registry.ts";

type RegistryState = Effect.Success<ReturnType<typeof makeRegistryState>>;

// Stage two of the environment registry: reading the catalog, opening a
// supervisor for an environment, and the registration/route mutations that
// keep the catalog consistent.
export const makeRegistryCatalog = (state: RegistryState) => {
  const registryScope = state.registryScope;
  const registrations = state.registrations;
  const pullRequestRoutingPermissions = state.pullRequestRoutingPermissions;
  const connectivity = state.connectivity;
  const driver = state.driver;
  const wakeups = state.wakeups;
  const persistedRoutesByEnvironment = state.persistedRoutesByEnvironment;
  const entries = state.entries;
  const profiles = state.profiles;
  const serviceScopes = state.serviceScopes;
  const platformEnvironmentIds = state.platformEnvironmentIds;
  const persistedEnvironmentIds = state.persistedEnvironmentIds;
  const started = state.started;
  const withLeaseLock = state.withLeaseLock;

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
            // Seed the intent to avoid publishing a false switched-off state
            // before an enabled, compatible environment starts connecting.
            initiallyDesired: entry.enabled && entry.unsupportedReason === undefined,
            learnRoutes: (input) => learnRoutes({ environmentId, ...input }),
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
          yield* SubscriptionRef.changes(supervisor.state).pipe(
            Stream.runForEach((state) =>
              state.phase === "blocked" && state.lastFailure?.reason === "unsupported"
                ? setCompatibility(environmentId, state.lastFailure)
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
      Stream.changesWith(
        (previous, current) => Option.getOrNull(previous) === Option.getOrNull(current),
      ),
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
          Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }),
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
    pullRequestRoutingPermissions.forget(environmentId).pipe(
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
   * Pull request routing trust and an unsupported verdict both belong to the saved addresses: a changed set may
   * reach a different server, so both are dropped and the next connection decides.
   */
  const withRoutes = (previous: ConnectionCatalogEntry, routes: ReadonlyArray<ConnectionRoute>) => {
    const next = entryWithRoutes(previous, routes);
    if (pullRequestRoutingConnectionKey(previous) === pullRequestRoutingConnectionKey(next)) {
      return { entry: next, addressesChanged: false };
    }
    const { unsupportedReason: _reason, serverUpdateRequired: _update, ...rest } = next;
    return { entry: rest, addressesChanged: true };
  };

  const assertKnownAddress = Effect.fn("EnvironmentRegistry.assertKnownAddress")(function* (
    route: ConnectionRoute,
  ) {
    const environmentId = route.target.environmentId;
    if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) return;
    const saved = (yield* SubscriptionRef.get(entries)).get(environmentId);
    if (
      saved !== undefined &&
      findRouteToSameAddress(connectionRoutes(saved), route) === undefined
    ) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `That address claims to be ${saved.target.label}, which is already saved. Add it as a route from that environment's settings instead.`,
      });
    }
  });

  const register = Effect.fn("EnvironmentRegistry.register")(function* (
    registration: ConnectionRegistration,
    options?: { readonly knownAddressOnly?: boolean },
  ) {
    const registered = connectionRegistrationCatalogEntry(registration);
    const environmentId = registered.target.environmentId;
    const route: ConnectionRoute = { target: registered.target, profile: registered.profile };
    return yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return false;
        }
        if (options?.knownAddressOnly === true) {
          yield* assertKnownAddress(route);
        }
        const previous = (yield* SubscriptionRef.get(entries)).get(environmentId);
        let entry = registered;
        if (previous !== undefined) {
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
        return true;
      }),
    );
  });

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

  // Plain HTTP routes are unusable from an HTTPS page, which blocks mixed content.
  const allowInsecureRoutes =
    typeof globalThis.location === "undefined" || globalThis.location.protocol !== "https:";

  const learnRoutes = Effect.fn("EnvironmentRegistry.learnRoutes")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly activeRoute: ConnectionRoute;
    readonly reported: ReadonlyArray<ReportedEndpoint>;
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
        const previousProfiles = new Map(
          connectionRoutes(entry).map((route) => [
            connectionRouteId(route.target),
            Option.getOrNull(route.profile),
          ]),
        );
        for (const route of routes) {
          const profile = Option.getOrNull(route.profile);
          if (
            profile === null ||
            previousProfiles.get(connectionRouteId(route.target)) === profile
          ) {
            continue;
          }
          yield* profiles.put(profile);
        }
        yield* registrations.setRoutes(input.environmentId, persistedRoutes(next));
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
        // Compatibility pauses connections without changing the user's saved on/off choice.
        const next: ConnectionCatalogEntry =
          error === null
            ? rest
            : {
                ...rest,
                unsupportedReason: error.message,
                ...(error.serverUpdateRequired === true ? { serverUpdateRequired: true } : {}),
              };
        const lease = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
        if (lease !== undefined) {
          yield* SubscriptionRef.update(serviceScopes, (current) =>
            new Map(current).set(environmentId, { ...lease, entry: next }),
          );
          if (error !== null) yield* lease.supervisor.disconnect;
          else if (next.enabled) yield* lease.supervisor.connect;
        }
        yield* SubscriptionRef.update(entries, (current) =>
          new Map(current).set(environmentId, next),
        );
      }),
    );
  });

  return {
    ...state,
    learnRoutes,
    setCompatibility,
    getEntry,
    closeServiceScope,
    createServiceScope,
    acquireSupervisor,
    run,
    runStream,
    followStream,
    start,
    installEntryLocked,
    forgetRoutingTrust,
    persistedRoutes,
    withRoutes,
    assertKnownAddress,
    register,
    replaceRoutesLocked,
    userEntry,
  };
};
