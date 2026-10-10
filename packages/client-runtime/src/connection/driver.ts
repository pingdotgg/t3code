import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  PreparedConnection,
} from "./model.ts";
import { ConnectionTransientError } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import { connectionRoutes, routeEntry, routeHttpBaseUrl } from "./routes.ts";
import * as RpcSession from "../rpc/session.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";

export type ConnectionDriverProgress =
  | {
      readonly stage: "preparing";
    }
  | {
      readonly stage: Exclude<ConnectionAttemptStage, "preparing">;
      readonly prepared: PreparedConnection;
    };

export interface EnvironmentConnectionLease {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
}

/**
 * The result of an unauthenticated reachability check. T3 Connect and SSH
 * routes have no cheap check, so they are "unchecked".
 */
export type RouteCheck = "answered" | "silent" | "unchecked";

/** How long a direct route has to answer before it counts as unreachable from here. */
const ROUTE_CHECK_TIMEOUT_MS = 2_500;

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
    /** Whether a direct route answers as the entry's environment, without credentials. */
    readonly checkRoute: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<RouteCheck>;
    /**
     * Whether a direct route answers and accepts this client's credential,
     * without opening a socket. Switching to a route that fails this would
     * drop a working connection for nothing.
     */
    readonly preflight: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<boolean>;
    /** Whether this device can reach T3 Connect at all, regardless of any environment. */
    readonly checkRelay: Effect.Effect<boolean>;
  }
>()("@t3tools/client-runtime/connection/driver/ConnectionDriver") {}

/**
 * Connects over the first route, in preference order, that is worth trying.
 * Every route is checked at once, but a route only waits for its own check,
 * so a reachable LAN address connects without waiting on a silent tailnet
 * one. A silent route is skipped on the first pass so a LAN address from
 * another network costs one short check, not a connection timeout. A route
 * that fails to connect moves on to the next: a signed-out T3 Connect must
 * not hide a working LAN. Silent routes are tried last, since a check is not
 * proof.
 *
 * The reported error is a transient one when any route failed transiently,
 * so the supervisor keeps retrying a route that may come back; a blocked
 * error is reported only when every attempted route was blocked.
 */
export const connectOverRoutes = Effect.fn("ConnectionDriver.connectOverRoutes")(function* <R>(
  entry: ConnectionCatalogEntry,
  checkRoute: (route: ConnectionRoute) => Effect.Effect<RouteCheck>,
  connectRoute: (
    route: ConnectionRoute,
  ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, R | Scope.Scope>,
) {
  const routes = connectionRoutes(entry);
  const checks =
    routes.length === 1
      ? []
      : yield* Effect.forEach(routes, (route) => Effect.forkChild(checkRoute(route)));
  const attemptScope = yield* Scope.Scope;
  let transient: ConnectionAttemptError | undefined;
  let blocked: ConnectionAttemptError | undefined;
  // Each route gets its own scope so a half-open session closes before the next try.
  const attempt = Effect.fnUntraced(function* (route: ConnectionRoute) {
    const routeScope = yield* Scope.fork(attemptScope);
    const result = yield* connectRoute(route).pipe(
      Scope.provide(routeScope),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(routeScope, exit))),
      Effect.result,
    );
    if (result._tag === "Failure") {
      if (result.failure._tag === "ConnectionTransientError") transient ??= result.failure;
      else blocked ??= result.failure;
    }
    return result;
  });
  const silent: Array<ConnectionRoute> = [];
  for (const [index, route] of routes.entries()) {
    const check = checks.length === 0 ? "unchecked" : yield* Fiber.join(checks[index]!);
    if (check === "silent") {
      silent.push(route);
      continue;
    }
    const result = yield* attempt(route);
    if (result._tag === "Success") return result.success;
    // An incompatible server is the same server on every route.
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  for (const route of silent) {
    const result = yield* attempt(route);
    if (result._tag === "Success") return result.success;
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  return yield* (
    transient ??
      blocked ??
      new ConnectionTransientError({
        reason: "endpoint-unavailable",
        detail: `${entry.target.label} did not answer on any saved route.`,
      })
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;
  const httpClient = yield* HttpClient.HttpClient;
  const relay = yield* ManagedRelay.ManagedRelayClient;

  const checkRoute = (entry: ConnectionCatalogEntry, route: ConnectionRoute) => {
    const httpBaseUrl = routeHttpBaseUrl(route);
    if (httpBaseUrl === null) return Effect.succeed<RouteCheck>("unchecked");
    // The descriptor is public, so this sends no credential to whatever
    // answers at a saved LAN address on a different network.
    return fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
      timeoutMs: ROUTE_CHECK_TIMEOUT_MS,
    }).pipe(
      Effect.map((descriptor): RouteCheck =>
        descriptor.environmentId === entry.target.environmentId ? "answered" : "silent",
      ),
      Effect.orElseSucceed((): RouteCheck => "silent"),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.withSpan("ConnectionDriver.checkRoute", {
        attributes: { "connection.target.kind": route.target._tag },
      }),
    );
  };

  const connect = Effect.fn("ConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const target = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
      "connection.route.count": connectionRoutes(entry).length,
    });
    yield* reportProgress({ stage: "preparing" });
    return yield* connectOverRoutes(
      entry,
      (route) => checkRoute(entry, route),
      Effect.fnUntraced(function* (route) {
        const prepared = yield* resolver.prepare(routeEntry(entry, route));
        yield* reportProgress({ stage: "opening", prepared });
        const session = yield* sessions.connect(prepared);
        yield* reportProgress({ stage: "synchronizing", prepared });
        yield* session.ready;
        return { prepared, session } satisfies EnvironmentConnectionLease;
      }),
    );
  });

  const preflight = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    checkRoute(entry, route).pipe(
      Effect.flatMap((check) =>
        check === "answered"
          ? resolver.prepare(routeEntry(entry, route)).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false),
      ),
      Effect.withSpan("ConnectionDriver.preflight"),
    );

  return ConnectionDriver.of({
    connect,
    checkRoute,
    preflight,
    checkRelay: relay.checkReachable,
  });
});

export const layer = Layer.effect(ConnectionDriver, make);
