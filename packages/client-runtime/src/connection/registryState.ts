import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  type ConnectionCatalogEntry,
  type ConnectionProfile,
  type ConnectionRoute,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as Connectivity from "./connectivity.ts";
import type { ConnectionTarget } from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { PullRequestRoutingPermissions } from "./pullRequestRoutingPermissions.ts";
import { connectionRouteId, entryWithRoutes } from "./routes.ts";

export interface EnvironmentServiceScope {
  readonly entry: ConnectionCatalogEntry;
  readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  readonly scope: Scope.Closeable;
}

export interface LeaseLock {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

// Stage one of the environment registry: stores, the catalog snapshot and the
// per-environment lease locks. Everything later stages mutate is created here so
// one object identity is shared across the whole service.
export const makeRegistryState = Effect.fn("EnvironmentRegistry.makeState")(function* () {
  const registryScope = yield* Scope.Scope;
  const storage = yield* Persistence.ConnectionTargetStore;
  const registrations = yield* Persistence.ConnectionRegistrationStore;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const ownedDataCleanup = yield* Persistence.EnvironmentOwnedDataCleanup;
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const pullRequestRoutingPermissions = yield* PullRequestRoutingPermissions;
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
  return {
    registryScope,
    storage,
    registrations,
    cache,
    ownedDataCleanup,
    profiles,
    credentials,
    pullRequestRoutingPermissions,
    connectivity,
    driver,
    wakeups,
    ssh,
    persistedTargets,
    disabledEnvironmentIds,
    loadRoute,
    persistedRoutesByEnvironment,
    initialEntries,
    entries,
    networkStatus,
    serviceScopes,
    platformEnvironmentIds,
    persistedEnvironmentIds,
    leaseLocks,
    leaseLocksGuard,
    started,
    withLeaseLock,
  };
});
