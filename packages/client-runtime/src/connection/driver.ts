import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  PreparedConnection,
} from "./model.ts";
import { ConnectionTransientError } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRoutes,
  routeEntry,
  routeHttpBaseUrl,
  routeUsesDpop,
  routesForNetwork,
  routesIncludeLan,
  sendsTokenInClear,
} from "./routes.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";
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

export type RouteCheck = "answered" | "silent" | "unchecked";
/** "unprepared" means the route answered its check but could not be prepared. */
export type RoutePreflight = "ready" | "unprepared" | "silent" | "unchecked";

const ROUTE_CHECK_TIMEOUT_MS = 2_500;
// Preferred direct routes share one head start, so a relay connection does not
// wait the full probe timeout for a LAN the device has already left. A route
// that misses it connects over relay, then upgrades over a second connection.
const ROUTE_CHECK_HEAD_START_MS = 500;
// Give the preferred ready route a short solo window before parallel backups
// start, so a fast LAN does not also open a relay session.
const ROUTE_CONNECT_HEDGE_MS = 250;

export interface ConnectOverRoutesOptions {
  readonly privateNetworkLikely?: boolean;
  /**
   * When false, routes are tried one at a time. Better-route upgrades need this
   * so a hanging preferred path is not "won" by a parallel backup of the live route.
   */
  readonly hedge?: boolean;
}

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
      options?: ConnectOverRoutesOptions,
    ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
    readonly preflight: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<RoutePreflight>;
    /** Asks the host behind a live session to answer a fresh request on the session's own origin. */
    readonly checkHost: (prepared: PreparedConnection) => Effect.Effect<RouteCheck>;
  }
>()("@t3tools/client-runtime/connection/driver/ConnectionDriver") {}

export const connectOverRoutes = Effect.fn("ConnectionDriver.connectOverRoutes")(function* <R>(
  entry: ConnectionCatalogEntry,
  checkRoute: (route: ConnectionRoute) => Effect.Effect<RouteCheck>,
  connectRoute: (
    route: ConnectionRoute,
  ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, R | Scope.Scope>,
  options: ConnectOverRoutesOptions = {},
) {
  const privateNetworkLikely = options.privateNetworkLikely ?? true;
  const hedge = options.hedge ?? true;
  const routes = routesForNetwork(entry, privateNetworkLikely);
  // Reachability checks exist to avoid opening a dead LAN before relay. With no
  // LAN in the race, start connecting immediately and let the hedge pick a winner.
  const classifyFirst = routes.length > 1 && routesIncludeLan(routes);
  const checks = classifyFirst
    ? yield* Effect.forEach(routes, (route) => Effect.forkChild(checkRoute(route)))
    : [];
  const headStart = classifyFirst
    ? yield* Effect.forkChild(Effect.sleep(ROUTE_CHECK_HEAD_START_MS))
    : undefined;
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
      return { result, routeScope } as const;
    }
    return { result, routeScope } as const;
  });

  // First success wins. Later successes close their scopes so a hedged backup
  // cannot leave a second live session behind. A finished failure starts the
  // next route immediately; only a still-running preferred attempt waits out
  // the hedge before opening a parallel backup.
  const raceAttempts = Effect.fnUntraced(function* (candidates: ReadonlyArray<ConnectionRoute>) {
    if (candidates.length === 0) {
      return undefined as
        | Result.Result<EnvironmentConnectionLease, ConnectionAttemptError>
        | undefined;
    }
    if (candidates.length === 1) {
      const { result } = yield* attempt(candidates[0]!);
      return result;
    }
    const decided =
      yield* Deferred.make<Result.Result<EnvironmentConnectionLease, ConnectionAttemptError>>();
    const remaining = yield* Ref.make(candidates.length);
    const fibers: Array<Fiber.Fiber<unknown, never>> = [];
    let previous = Option.none<Fiber.Fiber<unknown, never>>();

    for (const [index, route] of candidates.entries()) {
      if (index > 0 && Option.isSome(previous)) {
        const gate = hedge
          ? yield* Effect.raceFirst(
              Deferred.await(decided).pipe(Effect.as("decided" as const)),
              Fiber.join(previous.value).pipe(Effect.as("finished" as const)),
            ).pipe(
              Effect.timeoutOrElse({
                duration: ROUTE_CONNECT_HEDGE_MS,
                orElse: () => Effect.succeed("hedge" as const),
              }),
            )
          : yield* Effect.raceFirst(
              Deferred.await(decided).pipe(Effect.as("decided" as const)),
              Fiber.join(previous.value).pipe(Effect.as("finished" as const)),
            );
        if (gate === "decided") break;
      }
      // Only connectRoute is interruptible. Forking the scope, claiming the
      // winner, and closing a loser must stay masked — restore(attempt) would
      // leave a gap after onExit sees success and before the claim runs.
      const fiber = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const routeScope = yield* Scope.fork(attemptScope);
          // Only the connect attempt is interruptible. onExit/result/claim stay
          // masked so a success cannot be interrupted before the winner is chosen.
          const result = yield* restore(connectRoute(route).pipe(Scope.provide(routeScope))).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Scope.close(routeScope, exit),
            ),
            Effect.result,
          );
          if (result._tag === "Failure") {
            if (result.failure._tag === "ConnectionTransientError") transient ??= result.failure;
            else blocked ??= result.failure;
          }
          if (result._tag === "Success" || result.failure.reason === "unsupported") {
            // Deferred.succeed's boolean is the claim; discarding it leaves a
            // losing hedged session open for the life of the winner.
            const claimed = yield* Deferred.succeed(decided, result).pipe(
              Effect.orElseSucceed(() => false),
            );
            if (!claimed) yield* Scope.close(routeScope, Exit.void);
            return;
          }
          const count = yield* Ref.updateAndGet(remaining, (n) => n - 1);
          if (count === 0) yield* Deferred.succeed(decided, result).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);
      fibers.push(fiber);
      previous = Option.some(fiber);
    }

    const result = yield* Deferred.await(decided);
    yield* Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber), {
      concurrency: "unbounded",
      discard: true,
    });
    return result;
  });

  const settle = (
    result: Result.Result<EnvironmentConnectionLease, ConnectionAttemptError> | undefined,
  ) => {
    if (result === undefined) return Effect.undefined;
    if (result._tag === "Success") return Effect.succeed(result.success);
    if (result.failure.reason === "unsupported") return Effect.fail(result.failure);
    return Effect.undefined;
  };

  const silent: Array<{ readonly route: ConnectionRoute; readonly index: number }> = [];
  const ready: Array<ConnectionRoute> = [];
  for (const [index, route] of routes.entries()) {
    const check =
      headStart === undefined || checks.length === 0
        ? "unchecked"
        : yield* Effect.raceFirst(
            Fiber.join(checks[index]!),
            Fiber.join(headStart).pipe(Effect.as<RouteCheck>("silent")),
          );
    if (check === "silent") {
      silent.push({ route, index });
      continue;
    }
    ready.push(route);
  }

  const first = yield* settle(yield* raceAttempts(ready));
  if (first !== undefined) return first;

  // A slow route that answered after the head start goes before one that is
  // still dead, which can hold an attempt open far longer than its probe.
  const late = yield* Effect.forEach(silent, ({ index }) => Fiber.join(checks[index]!), {
    concurrency: "unbounded",
  });
  const retry = [
    ...silent.filter((_, position) => late[position] !== "silent").map(({ route }) => route),
    ...silent.filter((_, position) => late[position] === "silent").map(({ route }) => route),
  ];
  const second = yield* settle(yield* raceAttempts(retry));
  if (second !== undefined) return second;

  return yield* (
    transient ??
      blocked ??
      new ConnectionTransientError({
        reason: "endpoint-unavailable",
        detail: `${entry.target.label} did not answer on any saved route.`,
      })
  );
});

/** @public */
export const make = Effect.gen(function* () {
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const httpClient = yield* HttpClient.HttpClient;
  const connectivity = yield* Connectivity.Connectivity;

  // The descriptor is public, so this sends no credential to whatever
  // answers at a saved LAN address on a different network.
  const checkDescriptor = (httpBaseUrl: string, environmentId: string) =>
    fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
      timeoutMs: ROUTE_CHECK_TIMEOUT_MS,
    }).pipe(
      Effect.option,
      // The connect this check leads to skips its own read. Every answer, even a
      // failure, replaces what an older check remembered.
      Effect.tap((descriptor) => remote.rememberCheckedDescriptor(httpBaseUrl, descriptor)),
      Effect.map((descriptor): RouteCheck =>
        Option.exists(descriptor, (value) => value.environmentId === environmentId)
          ? "answered"
          : "silent",
      ),
      // A cached descriptor would answer for a host that cannot be reached.
      Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" }),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const checkRoute = (entry: ConnectionCatalogEntry, route: ConnectionRoute) => {
    const httpBaseUrl = routeHttpBaseUrl(route);
    if (httpBaseUrl === null) return Effect.succeed<RouteCheck>("unchecked");
    return checkDescriptor(httpBaseUrl, entry.target.environmentId).pipe(
      Effect.withSpan("ConnectionDriver.checkRoute", {
        attributes: { "connection.target.kind": route.target._tag },
      }),
    );
  };

  const checkHost = (prepared: PreparedConnection) =>
    checkDescriptor(prepared.httpBaseUrl, prepared.environmentId).pipe(
      Effect.withSpan("ConnectionDriver.checkHost", {
        attributes: { "connection.target.kind": prepared.target._tag },
      }),
    );

  const connect = Effect.fn("ConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    options: ConnectOverRoutesOptions = {},
  ) {
    const target = entry.target;
    const startedAt = yield* Clock.currentTimeMillis;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
      "connection.route.count": connectionRoutes(entry).length,
      "connection.stage": "preparing",
    });
    yield* reportProgress({ stage: "preparing" });
    const privateNetworkLikely =
      options.privateNetworkLikely ?? (yield* connectivity.privateNetworkLikely);
    const hedge = options.hedge ?? true;
    const routes = routesForNetwork(entry, privateNetworkLikely);
    const preferred = routes[0];
    // Mint the DPoP ticket while route checks run so T3 Connect is not strictly
    // serialized behind the LAN head-start window.
    const preferredPrepare =
      preferred !== undefined && routeUsesDpop(preferred)
        ? yield* Effect.forkChild(
            resolver.prepare(routeEntry(entry, preferred)).pipe(Effect.result),
          )
        : undefined;
    const preferredRouteId =
      preferred === undefined ? undefined : connectionRouteId(preferred.target);
    return yield* connectOverRoutes(
      entry,
      (route) => checkRoute(entry, route),
      Effect.fnUntraced(function* (route) {
        const prepared =
          preferredPrepare !== undefined &&
          preferredRouteId !== undefined &&
          connectionRouteId(route.target) === preferredRouteId
            ? yield* Fiber.join(preferredPrepare).pipe(
                Effect.flatMap((result) =>
                  result._tag === "Success"
                    ? Effect.succeed(result.success)
                    : Effect.fail(result.failure),
                ),
              )
            : yield* resolver.prepare(routeEntry(entry, route));
        const preparedAt = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "connection.stage": "opening",
          "connection.prepare_ms": preparedAt - startedAt,
          "connection.route.kind": connectionRouteKind(route),
        });
        yield* reportProgress({ stage: "opening", prepared });
        const session = yield* sessions.connect(prepared);
        const openingAt = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "connection.stage": "synchronizing",
          "connection.open_ms": openingAt - preparedAt,
        });
        yield* reportProgress({ stage: "synchronizing", prepared });
        yield* session.ready;
        const readyAt = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "connection.stage": "ready",
          "connection.ready_ms": readyAt - openingAt,
          "connection.total_ms": readyAt - startedAt,
        });
        // The server closes a socket when its session expires, unless the same key renewed it.
        if (prepared.httpAuthorization?._tag === "Dpop") {
          yield* remote
            .renewDpopBeforeExpiry({
              expectedEnvironmentId: prepared.environmentId,
              expiresAtEpochMs: prepared.httpAuthorization.expiresAtEpochMs,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not renew the connection's credential.", { error }),
              ),
              Effect.forkScoped,
            );
        }
        return { prepared, session } satisfies EnvironmentConnectionLease;
      }),
      { privateNetworkLikely, hedge },
    );
  });

  const preflight = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    (sendsTokenInClear(connectionRoutes(entry), route)
      ? Effect.succeed("silent" as const)
      : checkRoute(entry, route)
    ).pipe(
      Effect.filterOrElse(
        (check): check is Exclude<RouteCheck, "answered"> => check !== "answered",
        () =>
          resolver.prepare(routeEntry(entry, route)).pipe(
            Effect.as<RoutePreflight>("ready"),
            Effect.orElseSucceed((): RoutePreflight => "unprepared"),
          ),
      ),
      Effect.withSpan("ConnectionDriver.preflight"),
    );

  return ConnectionDriver.of({ connect, preflight, checkHost });
});

export const layer = Layer.effect(ConnectionDriver, make);
