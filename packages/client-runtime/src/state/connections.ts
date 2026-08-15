import type { EnvironmentId as EnvironmentIdType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  followStreamInEnvironment,
} from "./runtime.ts";

export interface EnvironmentCatalogState {
  readonly isReady: boolean;
  readonly entries: ReadonlyMap<EnvironmentIdType, ConnectionCatalogEntry>;
}

export const EMPTY_ENVIRONMENT_CATALOG_STATE: EnvironmentCatalogState = Object.freeze({
  isReady: false,
  entries: new Map(),
});

export function createEnvironmentCatalogAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serial = { mode: "serial" as const, key: () => "environment-catalog" };
  const catalogAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) =>
          SubscriptionRef.changes(registry.entries).pipe(
            Stream.map((entries) => ({
              isReady: true,
              entries,
            })),
          ),
        ),
      ),
    ),
    { initialValue: EMPTY_ENVIRONMENT_CATALOG_STATE },
  );

  const catalogValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(catalogAtom)), () => EMPTY_ENVIRONMENT_CATALOG_STATE),
  ).pipe(Atom.withLabel("environment-catalog-value"));

  const connectionsAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) => SubscriptionRef.changes(registry.connections)),
      ),
    ),
    {
      initialValue: new Map<string, ConnectionCatalogEntry>() as ReadonlyMap<
        string,
        ConnectionCatalogEntry
      >,
    },
  );

  const connectionsValueAtom = Atom.make((get) =>
    Option.getOrElse(
      AsyncResult.value(get(connectionsAtom)),
      () => new Map<string, ConnectionCatalogEntry>(),
    ),
  ).pipe(Atom.withLabel("environment-connections-value"));

  const networkStatusAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) => SubscriptionRef.changes(registry.networkStatus)),
      ),
    ),
    { initialValue: "unknown" as const },
  );

  const networkStatusValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(networkStatusAtom)), () => "unknown" as const),
  ).pipe(Atom.withLabel("environment-network-status-value"));

  const stateAtom = Atom.family((environmentId: EnvironmentIdType) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
          ),
        ),
      ),
      { initialValue: AVAILABLE_CONNECTION_STATE },
    ),
  );

  const register = createRuntimeCommand(runtime, {
    label: "environment-catalog:register",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (
      target: Parameters<EnvironmentRegistry.EnvironmentRegistry["Service"]["register"]>[0],
    ) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.register(target)),
      ),
  });
  const remove = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.remove(environmentId)),
      ),
  });
  const activate = createRuntimeCommand(runtime, {
    label: "environment-catalog:activate",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (connectionId: string) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.activate(connectionId)),
      ),
  });
  const removeConnection = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove-connection",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (connectionId: string) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.removeConnection(connectionId)),
      ),
  });
  const removeRelayEnvironments = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove-relay-environments",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (_input: void) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.removeRelayEnvironments()),
      ),
  });
  const retryNow = createRuntimeCommand(runtime, {
    label: "environment-catalog:retry-now",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.retryNow(environmentId)),
      ),
  });
  const retryConnection = createRuntimeCommand(runtime, {
    label: "environment-catalog:retry-connection",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (connectionId: string) =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.activate(connectionId);
        const entry = (yield* SubscriptionRef.get(registry.connections)).get(connectionId);
        if (entry !== undefined) yield* registry.retryNow(entry.target.environmentId);
      }),
  });

  return {
    catalogAtom,
    catalogValueAtom,
    connectionsAtom,
    connectionsValueAtom,
    networkStatusAtom,
    networkStatusValueAtom,
    stateAtom,
    register,
    remove,
    activate,
    removeConnection,
    removeRelayEnvironments,
    retryNow,
    retryConnection,
  };
}
