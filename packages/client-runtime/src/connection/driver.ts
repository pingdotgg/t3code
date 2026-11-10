import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  PreparedConnection,
} from "./model.ts";
import { ConnectionTransientError } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import {
  authorizesThroughConnect,
  connectionRoutes,
  routeEntry,
  routeHttpBaseUrl,
  sendsTokenInClear,
  usableRoutes,
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
// that misses it connects over relay, then upgrades with a second reconnect.
const ROUTE_CHECK_HEAD_START_MS = 500;
// How long a route authorized through T3 Connect keeps its turn over a later route that answered.
const CONNECT_AUTHORIZATION_GRACE_MS = 5_000;

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
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
) {
  const routes = usableRoutes(entry);
  const checks =
    routes.length === 1
      ? []
      : yield* Effect.forEach(routes, (route) => Effect.forkChild(checkRoute(route)));
  const headStart = yield* Effect.forkChild(Effect.sleep(ROUTE_CHECK_HEAD_START_MS));
  const attemptScope = yield* Scope.Scope;
  let transient: ConnectionAttemptError | undefined;
  let silentTransient: ConnectionAttemptError | undefined;
  let answeredBlocked: ConnectionAttemptError | undefined;
  let blocked: ConnectionAttemptError | undefined;
  // Each route gets its own scope so a half-open session closes before the next try.
  const attempt = Effect.fnUntraced(function* (route: ConnectionRoute, check: RouteCheck) {
    const routeScope = yield* Scope.fork(attemptScope);
    const result = yield* connectRoute(route).pipe(
      Scope.provide(routeScope),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(routeScope, exit))),
      Effect.result,
    );
    if (result._tag === "Failure") {
      if (result.failure._tag === "ConnectionBlockedError") {
        // The environment refusing the request is an answer, even from a route too slow for its check.
        if (check === "answered" || result.failure.hop === "server") {
          answeredBlocked ??= result.failure;
        } else blocked ??= result.failure;
      } else if (check === "silent") silentTransient ??= result.failure;
      else transient ??= result.failure;
    }
    return result;
  });
  const silent: Array<{ readonly route: ConnectionRoute; readonly index: number }> = [];
  const preempted: Array<{ readonly route: ConnectionRoute; readonly check: RouteCheck }> = [];
  const answers = (position: number) =>
    Fiber.join(checks[position]!).pipe(
      Effect.filterOrElse(
        (check) => check === "answered",
        () => Effect.never,
      ),
    );
  // A route needing a T3 Connect credential can stall on Connect for longer than the setup
  // budget. A route the head start skipped takes its turn as soon as it answers; a later route
  // that needs no Connect credential waits out a grace, so a healthy Connect route keeps its place.
  const overtaken = (index: number) => {
    const later = routes.flatMap((route, position) =>
      position > index && !authorizesThroughConnect(route) ? [answers(position)] : [],
    );
    const waits = [
      ...silent.map(({ index: position }) => answers(position)),
      ...(later.length === 0
        ? []
        : [
            Effect.sleep(CONNECT_AUTHORIZATION_GRACE_MS).pipe(
              Effect.andThen(Effect.raceAll(later)),
            ),
          ]),
    ];
    return waits.length === 0 ? undefined : Effect.raceAll(waits);
  };
  const attemptUnlessOvertaken = Effect.fnUntraced(function* (
    route: ConnectionRoute,
    check: RouteCheck,
    overtakenBy: Effect.Effect<unknown>,
  ) {
    const running = yield* Effect.forkChild(attempt(route, check));
    const finished = yield* Effect.raceFirst(
      Fiber.await(running).pipe(Effect.as(true)),
      overtakenBy.pipe(Effect.as(false)),
    );
    if (!finished) yield* Fiber.interrupt(running);
    // An attempt that finished just as it was overtaken still counts, so its session is kept.
    const exit = yield* Fiber.await(running);
    if (Exit.isSuccess(exit)) return Option.some(exit.value);
    if (Cause.hasInterruptsOnly(exit.cause)) return Option.none();
    return yield* Effect.failCause(exit.cause);
  });
  for (const [index, route] of routes.entries()) {
    const check =
      checks.length === 0
        ? "unchecked"
        : yield* Effect.raceFirst(
            Fiber.join(checks[index]!),
            Fiber.join(headStart).pipe(Effect.as<RouteCheck>("silent")),
          );
    if (check === "silent") {
      silent.push({ route, index });
      continue;
    }
    const overtakenBy = authorizesThroughConnect(route) ? overtaken(index) : undefined;
    const result =
      overtakenBy === undefined
        ? Option.some(yield* attempt(route, check))
        : yield* attemptUnlessOvertaken(route, check, overtakenBy);
    if (Option.isNone(result)) {
      preempted.push({ route, check });
      continue;
    }
    if (result.value._tag === "Success") return result.value.success;
    // An incompatible server is the same server on every route.
    if (result.value.failure.reason === "unsupported") return yield* result.value.failure;
  }
  // A slow route that answered after the head start goes before one that is
  // still dead, which can hold an attempt open far longer than its probe.
  const late = yield* Effect.forEach(silent, ({ index }) => Fiber.join(checks[index]!), {
    concurrency: "unbounded",
  });
  const retry = [
    ...silent.flatMap((entry, position) =>
      late[position] === "silent" ? [] : [{ ...entry, check: late[position]! }],
    ),
    ...preempted,
    ...silent.flatMap((entry, position) =>
      late[position] === "silent" ? [{ ...entry, check: "silent" as const }] : [],
    ),
  ];
  for (const { route, check } of retry) {
    const result = yield* attempt(route, check);
    if (result._tag === "Success") return result.success;
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  // A route that already missed its reachability check timing out again says nothing new, while
  // a route that answered and refused names what the user must fix. A refusal from an unchecked
  // route, such as T3 Connect asking for sign-in, must not stop retries of a direct route that
  // needs no sign-in and only lost packets.
  return yield* (
    transient ??
      answeredBlocked ??
      silentTransient ??
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

  // The descriptor is public, so it sends no credential to a stranger at a saved LAN address.
  // Nothing here forces a new connection on iOS: NSURLSession ignores `Connection: close` and
  // pools per origin. The WebSocket opens its own TCP connection every attempt, so a route whose
  // check went silent is still dialled.
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
