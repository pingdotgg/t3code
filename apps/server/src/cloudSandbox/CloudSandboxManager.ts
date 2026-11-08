import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import type {
  EnvironmentId,
  ManagedCloudSandboxConnection,
  ManagedCloudSandboxContext,
  ManagedCloudSandboxControlOperation,
  ManagedCloudSandboxControlResult,
  ManagedCloudSandboxForkInput,
  ManagedCloudSandboxProvisionInput,
  ManagedCloudSandboxResource,
  ManagedCloudSandboxResourceId,
  ManagedCloudSandboxSourceOperation,
  ManagedCloudSandboxSourceResult,
} from "@t3tools/contracts";
import * as Profiles from "./CloudSandboxProfiles.ts";
import * as Store from "./CloudSandboxStore.ts";
import * as Transport from "./CloudSandboxTransport.ts";
import { makeAllocation } from "./ManagerAllocation.ts";
import { makeConnections } from "./ManagerConnections.ts";
import { makeControl } from "./ManagerControl.ts";
import { makeManagerRuntime } from "./ManagerRuntime.ts";
import { makeReconciler } from "./ManagerReconciler.ts";

export { CloudSandboxManagerError } from "./CloudSandboxStore.ts";

export class CloudSandboxRenewalsEnabled extends Context.Reference<boolean>(
  "t3/cloudSandbox/CloudSandboxRenewalsEnabled",
  { defaultValue: () => true },
) {}

export interface ManagedCloudSandboxRoute {
  readonly connection: ManagedCloudSandboxConnection;
  readonly httpBaseUrl: string;
  readonly pairingToken: string;
}

export class CloudSandboxManager extends Context.Service<
  CloudSandboxManager,
  {
    readonly withConnection: <A, E, R>(
      resourceId: ManagedCloudSandboxResourceId,
      effect: (
        target: import("@t3tools/contracts").DesktopSshEnvironmentTarget,
        connection: ManagedCloudSandboxRoute,
      ) => Effect.Effect<A, E, R | Scope.Scope>,
    ) => Effect.Effect<A, E | Store.CloudSandboxManagerError, Exclude<R, Scope.Scope>>;
    readonly reconcile: Effect.Effect<void, Store.CloudSandboxManagerError>;
    readonly provision: (
      input: ManagedCloudSandboxProvisionInput,
    ) => Effect.Effect<ManagedCloudSandboxRoute, Store.CloudSandboxManagerError>;
    readonly connect: (
      resourceId: ManagedCloudSandboxResourceId,
    ) => Effect.Effect<ManagedCloudSandboxRoute, Store.CloudSandboxManagerError>;
    readonly route: (
      resourceId: ManagedCloudSandboxResourceId,
    ) => Effect.Effect<ManagedCloudSandboxRoute, Store.CloudSandboxManagerError>;
    readonly get: (
      resourceId: ManagedCloudSandboxResourceId,
    ) => Effect.Effect<ManagedCloudSandboxResource, Store.CloudSandboxManagerError>;
    readonly list: Effect.Effect<
      readonly ManagedCloudSandboxResource[],
      Store.CloudSandboxManagerError
    >;
    readonly resolve: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<ManagedCloudSandboxResource>, Store.CloudSandboxManagerError>;
    readonly fork: (
      input: ManagedCloudSandboxForkInput,
    ) => Effect.Effect<ManagedCloudSandboxRoute, Store.CloudSandboxManagerError>;
    readonly release: (
      resourceId: ManagedCloudSandboxResourceId,
    ) => Effect.Effect<void, Store.CloudSandboxManagerError>;
    readonly disconnect: (
      resourceId: ManagedCloudSandboxResourceId,
    ) => Effect.Effect<void, Store.CloudSandboxManagerError>;
    readonly execute: (
      resourceId: ManagedCloudSandboxResourceId,
      operation: ManagedCloudSandboxControlOperation,
    ) => Effect.Effect<ManagedCloudSandboxControlResult, Store.CloudSandboxManagerError>;
    readonly artifact: (
      resourceId: ManagedCloudSandboxResourceId,
      recordingId: string,
    ) => Effect.Effect<Uint8Array, Store.CloudSandboxManagerError>;
    readonly executeSource: (
      resourceId: ManagedCloudSandboxResourceId,
      token: string,
      operation: ManagedCloudSandboxSourceOperation,
    ) => Effect.Effect<ManagedCloudSandboxSourceResult, Store.CloudSandboxManagerError>;
    readonly sourceContext: (
      resourceId: ManagedCloudSandboxResourceId,
      token: string,
    ) => Effect.Effect<ManagedCloudSandboxContext, Store.CloudSandboxManagerError>;
  }
>()("t3/cloudSandbox/CloudSandboxManager") {}

export const make = Effect.gen(function* () {
  const renewalsEnabled = yield* CloudSandboxRenewalsEnabled;
  const rt = yield* makeManagerRuntime(renewalsEnabled);
  const { locks, transport, store, scope, requireRecord, publicResource } = rt;
  const connections = makeConnections(rt);
  const { route, connect, disconnect, sourceContext } = connections;
  const allocation = makeAllocation(rt, connections);
  const { provision, fork, release } = allocation;
  const control = makeControl(rt, connections, allocation);
  const { execute, artifact, executeSource } = control;
  const { reconcile } = makeReconciler(rt, connections, allocation);
  yield* reconcile.pipe(
    Effect.catchCause(() => Effect.logWarning("Managed cloud reconciliation will retry.")),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkIn(scope),
  );

  return CloudSandboxManager.of({
    withConnection: Effect.fn("CloudSandboxManager.withConnection")((id, effect) =>
      locks.withLock(
        id,
        Effect.gen(function* () {
          const connection = yield* route(id);
          return yield* transport.withConnection(id, (target) => effect(target, connection));
        }),
      ),
    ),
    reconcile,
    provision,
    connect,
    route,
    fork,
    release,
    disconnect,
    execute,
    artifact,
    sourceContext,
    executeSource,
    get: Effect.fn("CloudSandboxManager.get")((id) =>
      requireRecord(id).pipe(Effect.map(publicResource)),
    ),
    list: store.list.pipe(Effect.map((records) => records.map(publicResource))),
    resolve: Effect.fn("CloudSandboxManager.resolve")((id) =>
      store.list.pipe(
        Effect.map((records) =>
          Option.fromNullishOr(
            records.find((record) => record.environmentId === id && record.lifecycle !== "deleted"),
          ).pipe(Option.map(publicResource)),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(CloudSandboxManager, make).pipe(
  Layer.provide(Store.layer),
  Layer.provide(Transport.layer),
  Layer.provide(Profiles.layer),
);
