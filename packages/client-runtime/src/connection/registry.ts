import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  type ConnectionRoute,
  type PlatformConnectionRegistration,
} from "./catalog.ts";
import type { ConnectionAttemptError, NetworkStatus, SupervisorConnectionState } from "./model.ts";
import { ConnectionBlockedError } from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";

import { makeRegistryState } from "./registryState.ts";
import { makeRegistryCatalog } from "./registryCatalog.ts";
import { makeRegistryPlatform } from "./registryPlatform.ts";
import { EnvironmentNotRegisteredError, PlatformEnvironmentRemovalError } from "./registryModel.ts";

export { EnvironmentNotRegisteredError, PlatformEnvironmentRemovalError } from "./registryModel.ts";

export class EnvironmentRegistry extends Context.Service<
  EnvironmentRegistry,
  {
    readonly entries: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
    >;
    readonly networkStatus: SubscriptionRef.SubscriptionRef<NetworkStatus>;
    readonly start: Effect.Effect<void>;
    /**
     * Succeeds with `false` and changes nothing when the environment is
     * platform-managed, since the host owns that entry. With `knownAddressOnly`, it fails like
     * `assertKnownAddress`, checked under the environment's lease.
     */
    readonly register: (
      registration: ConnectionRegistration,
      options?: { readonly knownAddressOnly?: boolean },
    ) => Effect.Effect<boolean, Persistence.ConnectionPersistenceError | ConnectionBlockedError>;
    /**
     * Fails when the route would add a new address to a saved user environment. Pairing that does
     * not target an environment checks this, because the server reports its own environment id.
     */
    readonly assertKnownAddress: (
      route: ConnectionRoute,
    ) => Effect.Effect<void, ConnectionBlockedError>;
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
     * Removing an environment's last route removes the environment, the same as
     * `remove`.
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

export const make = Effect.gen(function* () {
  const state = yield* makeRegistryState();
  const catalog = makeRegistryCatalog(state);
  return yield* makeRegistryPlatform(catalog);
});

export const layer = Layer.effect(EnvironmentRegistry, make);
