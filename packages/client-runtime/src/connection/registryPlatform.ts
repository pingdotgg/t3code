import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  type PlatformConnectionRegistration,
  SshConnectionProfile,
  connectionRegistrationCatalogEntry,
} from "./catalog.ts";
import { ConnectionBlockedError } from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { pullRequestRoutingConnectionKey } from "./pullRequestRoutingPermissions.ts";
import {
  RELAY_ROUTE_ID,
  connectionRouteId,
  connectionRoutes,
  credentialConnectionId,
  hasSavedBearerRoute,
  routesAfterRemoving,
} from "./routes.ts";

import type { makeRegistryCatalog } from "./registryCatalog.ts";
import {
  isSshConnectionProfile,
  PlatformEnvironmentRemovalError,
  unsupportedState,
} from "./registryModel.ts";
import { EnvironmentRegistry } from "./registry.ts";

type RegistryCatalog = ReturnType<typeof makeRegistryCatalog>;

// Stage three of the environment registry: platform-owned environments, route
// learning, removal, and the service surface itself.
export const makeRegistryPlatform = Effect.fn("EnvironmentRegistry.makePlatform")(function* (
  catalog: RegistryCatalog,
) {
  const setCompatibility = catalog.setCompatibility;

  const registrations = catalog.registrations;
  const cache = catalog.cache;
  const ownedDataCleanup = catalog.ownedDataCleanup;
  const credentials = catalog.credentials;
  const pullRequestRoutingPermissions = catalog.pullRequestRoutingPermissions;
  const connectivity = catalog.connectivity;
  const ssh = catalog.ssh;
  const entries = catalog.entries;
  const networkStatus = catalog.networkStatus;
  const serviceScopes = catalog.serviceScopes;
  const platformEnvironmentIds = catalog.platformEnvironmentIds;
  const persistedEnvironmentIds = catalog.persistedEnvironmentIds;
  const withLeaseLock = catalog.withLeaseLock;
  const getEntry = catalog.getEntry;
  const closeServiceScope = catalog.closeServiceScope;
  const createServiceScope = catalog.createServiceScope;
  const acquireSupervisor = catalog.acquireSupervisor;
  const run = catalog.run;
  const runStream = catalog.runStream;
  const followStream = catalog.followStream;
  const start = catalog.start;
  const installEntryLocked = catalog.installEntryLocked;
  const assertKnownAddress = catalog.assertKnownAddress;
  const register = catalog.register;
  const replaceRoutesLocked = catalog.replaceRoutesLocked;
  const userEntry = catalog.userEntry;

  const installPlatformRegistration = Effect.fn("EnvironmentRegistry.installPlatformRegistration")(
    function* (registration: PlatformConnectionRegistration) {
      const registered = connectionRegistrationCatalogEntry(registration);
      const target = registered.target;
      return yield* withLeaseLock(
        target.environmentId,
        Effect.gen(function* () {
          let applied = true;
          const previous = (yield* SubscriptionRef.get(entries)).get(target.environmentId);
          const entry: ConnectionCatalogEntry =
            previous?.unsupportedReason !== undefined &&
            pullRequestRoutingConnectionKey(previous) ===
              pullRequestRoutingConnectionKey(registered)
              ? { ...registered, ...unsupportedState(previous) }
              : registered;
          const persisted = (yield* Ref.get(persistedEnvironmentIds)).has(target.environmentId);
          if (
            persisted ||
            (previous !== undefined &&
              pullRequestRoutingConnectionKey(previous) !== pullRequestRoutingConnectionKey(entry))
          ) {
            const revoked = yield* pullRequestRoutingPermissions.forget(target.environmentId).pipe(
              Effect.tapError((error) =>
                Effect.logWarning(
                  "Could not clear pull request routing permission for a platform environment.",
                  {
                    environmentId: target.environmentId,
                    error,
                  },
                ),
              ),
              Effect.exit,
            );
            if (Exit.isFailure(revoked)) return false;
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
          let bearerChanged = false;
          if (registration._tag === "BearerConnectionRegistration") {
            const stored = yield* credentials
              .get(registration.target.connectionId)
              .pipe(Effect.orElseSucceed(() => Option.none<ConnectionCredential>()));
            bearerChanged =
              Option.isSome(stored) && !Equal.equals(stored.value, registration.credential);
          }

          if (persisted) {
            const removed = yield* registrations.remove(target.environmentId).pipe(
              Effect.tap(() =>
                Ref.update(persistedEnvironmentIds, (current) => {
                  const next = new Set(current);
                  next.delete(target.environmentId);
                  return next;
                }),
              ),
              Effect.as(true),
              Effect.catch((error) =>
                Effect.logWarning(
                  "Could not remove a persisted registration shadowed by a platform environment.",
                  {
                    environmentId: target.environmentId,
                    error,
                  },
                ).pipe(Effect.as(false)),
              ),
            );
            applied &&= removed;
          }

          let bearerReplaced = false;
          if (registration._tag === "BearerConnectionRegistration") {
            const written = yield* credentials
              .put(registration.target.connectionId, registration.credential)
              .pipe(
                Effect.as(true),
                Effect.catch((error) =>
                  Effect.logWarning("Could not store the platform bearer credential.", {
                    environmentId: target.environmentId,
                    error,
                  }).pipe(Effect.as(false)),
                ),
              );
            // Only a bearer that was actually stored can be retried with; a
            // failed write leaves the rejected one in place.
            bearerReplaced = written && bearerChanged;
            applied &&= written;
          }

          yield* installEntryLocked(entry, { retainEquivalentRuntime: true });

          if (bearerReplaced && registration._tag === "BearerConnectionRegistration") {
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
              } else if (state.phase === "connected") {
                const token = registration.credential.token;
                yield* SubscriptionRef.updateSome(scope.supervisor.prepared, (current) =>
                  Option.isSome(current) &&
                  current.value.target._tag === "BearerConnectionTarget" &&
                  credentialConnectionId(current.value.target.connectionId) ===
                    registration.target.connectionId &&
                  current.value.httpAuthorization?._tag === "Bearer" &&
                  current.value.httpAuthorization.token !== token
                    ? Option.some(
                        Option.some({
                          ...current.value,
                          httpAuthorization: { _tag: "Bearer", token },
                        }),
                      )
                    : Option.none(),
                );
              }
            }
          }
          return applied;
        }),
      );
    },
  );

  const removePlatformEnvironment = Effect.fn("EnvironmentRegistry.removePlatformEnvironment")(
    function* (environmentId: EnvironmentId) {
      return yield* withLeaseLock(
        environmentId,
        Effect.gen(function* () {
          const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
          const revoked = yield* pullRequestRoutingPermissions.forget(environmentId).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                "Could not clear pull request routing permission after platform removal.",
                {
                  environmentId,
                  error,
                },
              ),
            ),
            Effect.exit,
          );
          if (Exit.isFailure(revoked)) return false;
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
          return true;
        }),
      );
    },
  );

  /** Succeeds with `false` when a best-effort write failed, so an identical repeat retries it. */
  const applyPlatformRegistrations = Effect.fn("EnvironmentRegistry.reconcilePlatform")(function* (
    platformRegistrations: ReadonlyArray<PlatformConnectionRegistration>,
  ) {
    const desiredIds = new Set(
      platformRegistrations.map((registration) => registration.target.environmentId),
    );
    const currentPlatformIds = yield* Ref.get(platformEnvironmentIds);
    const removed = yield* Effect.forEach(currentPlatformIds, (environmentId) =>
      desiredIds.has(environmentId)
        ? Effect.succeed(true)
        : removePlatformEnvironment(environmentId),
    );
    const installed = yield* Effect.forEach(platformRegistrations, installPlatformRegistration);
    return [...removed, ...installed].every(Boolean);
  });

  const reconcileLock = yield* Semaphore.make(1);
  let appliedPlatformRegistrations: ReadonlyArray<PlatformConnectionRegistration> | undefined;
  // Untraced: platforms repeat unchanged registrations every few seconds, and a
  // span per poll would make idle clients export traces continuously.
  const reconcilePlatform = Effect.fnUntraced(function* (
    platformRegistrations: ReadonlyArray<PlatformConnectionRegistration>,
  ) {
    if (Equal.equals(appliedPlatformRegistrations, platformRegistrations)) return;
    appliedPlatformRegistrations = undefined;
    if (yield* applyPlatformRegistrations(platformRegistrations)) {
      appliedPlatformRegistrations = platformRegistrations;
    }
  }, reconcileLock.withPermits(1));

  /** Callers hold its lease lock. */
  const removeLocked = Effect.fn("EnvironmentRegistry.removeLocked")(function* (
    environmentId: EnvironmentId,
  ) {
    if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
      return yield* new PlatformEnvironmentRemovalError({
        environmentId,
      });
    }
    const entry = yield* getEntry(environmentId);

    yield* pullRequestRoutingPermissions.forget(environmentId);
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

  /**
   * Learned routes reuse the active route's credential, so they do not revoke pull request routing
   * trust the way a newly paired address does.
   */

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
            Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }),
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
      Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }),
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
        const retryUnsupported = enabled && entry.unsupportedReason !== undefined;
        if (retryUnsupported && !hasSavedBearerRoute(entry)) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: entry.unsupportedReason,
          });
        }
        if (entry.enabled === enabled && !retryUnsupported) {
          return;
        }
        if (!(yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          yield* registrations.setEnabled(environmentId, enabled);
        }
        // A cached rejection can outlive a server update.
        const { unsupportedReason: _reason, serverUpdateRequired: _update, ...rest } = entry;
        const next: ConnectionCatalogEntry = { ...(retryUnsupported ? rest : entry), enabled };
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

  return EnvironmentRegistry.of({
    entries,
    networkStatus,
    start,
    register,
    assertKnownAddress,
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
