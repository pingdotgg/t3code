import { msg } from "gt-i18n";
import { translatableDetail } from "../errors/translatable.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Result from "effect/Result";
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
import { isHostCredentialRefusal } from "./errors.ts";
import * as ConnectionResolver from "./resolver.ts";
import {
  connectionRouteId,
  connectionRoutes,
  routeEntry,
  routeHttpBaseUrl,
  routeKeepsItsHost,
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

export interface RouteConnection {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
}

export interface EnvironmentConnectionLease extends RouteConnection {
  /** Saved routes whose host refused this device's credential before another route connected. */
  readonly refusedRouteIds: ReadonlyArray<string>;
}

export type RouteCheck = "answered" | "silent" | "unchecked";
/**
 * "unprepared" means the route answered its check but could not be prepared;
 * "refused" means its host refused this device's credential.
 */
export type RoutePreflight = "ready" | "refused" | "unprepared" | "silent" | "unchecked";

const ROUTE_CHECK_TIMEOUT_MS = 2_500;
// Preferred direct routes share one head start, so a relay connection does not
// wait the full probe timeout for a LAN the device has already left. A route
// that misses it connects over relay, then upgrades with a second reconnect.
const ROUTE_CHECK_HEAD_START_MS = 500;

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
  ) => Effect.Effect<RouteConnection, ConnectionAttemptError, R | Scope.Scope>,
) {
  const routes = usableRoutes(entry);
  const checks =
    routes.length === 1
      ? []
      : yield* Effect.forEach(routes, (route) => Effect.forkChild(checkRoute(route)));
  const headStart = yield* Effect.forkChild(Effect.sleep(ROUTE_CHECK_HEAD_START_MS));
  const attemptScope = yield* Scope.Scope;
  let transient: ConnectionAttemptError | undefined;
  let blocked: ConnectionAttemptError | undefined;
  const refusedRouteIds: Array<string> = [];
  // Each route gets its own scope so a half-open session closes before the next try.
  const attempt = Effect.fnUntraced(function* (
    route: ConnectionRoute,
    routeScope: Scope.Closeable,
  ) {
    const result = yield* connectRoute(route).pipe(
      Scope.provide(routeScope),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(routeScope, exit))),
      Effect.result,
    );
    if (result._tag === "Failure") {
      if (result.failure._tag === "ConnectionTransientError") transient ??= result.failure;
      else blocked ??= result.failure;
      if (isHostCredentialRefusal(result.failure))
        refusedRouteIds.push(connectionRouteId(route.target));
    }
    return result;
  });
  const relayIndex = routes.findIndex((route) => route.target._tag === "RelayConnectionTarget");
  const relayRoute = routes[relayIndex];
  type Settled = {
    readonly result: Result.Result<RouteConnection, ConnectionAttemptError>;
    readonly scope: Scope.Closeable;
  };
  let relay:
    | {
        readonly fiber: Fiber.Fiber<
          Settled,
          Result.Result<RouteConnection, ConnectionAttemptError>
        >;
        readonly scope: Scope.Closeable;
      }
    | undefined;
  // A direct route still connecting when the head start ends starts relay, which
  // then races every direct attempt after it. The first to connect wins. A failed
  // direct route moves on to the next one while relay keeps connecting.
  const attemptRacingRelay = Effect.fnUntraced(function* (route: ConnectionRoute) {
    const directScope = yield* Scope.fork(attemptScope);
    const direct = yield* Effect.forkChild(attempt(route, directScope));
    if (relay === undefined) {
      const early = yield* Fiber.join(direct).pipe(Effect.timeoutOption(ROUTE_CHECK_HEAD_START_MS));
      if (Option.isSome(early)) return early.value;
      const relayScope = yield* Scope.fork(attemptScope);
      const fiber = yield* Effect.forkChild(
        attempt(relayRoute!, relayScope).pipe(
          Effect.flatMap((result) =>
            // Relay can reach a different server than the direct routes, so an
            // incompatible relay is a failed backup, not the end of the walk.
            result._tag === "Success"
              ? Effect.succeed<Settled>({ result, scope: relayScope })
              : Effect.fail(result),
          ),
        ),
      );
      relay = { fiber, scope: relayScope };
    }
    const racing = relay;
    const raced = yield* Effect.race(
      Fiber.join(direct).pipe(Effect.map((result): Settled => ({ result, scope: directScope }))),
      // A failed relay leaves the direct attempt to finish on its own.
      Fiber.join(racing.fiber).pipe(Effect.catch(() => Effect.never)),
    );
    if (raced.scope === directScope) {
      if (raced.result._tag === "Success" || raced.result.failure.reason === "unsupported") {
        yield* Fiber.interrupt(racing.fiber);
        yield* Scope.close(racing.scope, Exit.void);
      }
    } else {
      yield* Fiber.interrupt(direct);
      yield* Scope.close(directScope, Exit.void);
    }
    return raced.result;
  });
  const silent: Array<{ readonly route: ConnectionRoute; readonly index: number }> = [];
  for (const [index, route] of routes.entries()) {
    if (index === relayIndex && relay !== undefined) continue;
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
    const result =
      relay !== undefined ||
      (check === "answered" && relayRoute !== undefined && index < relayIndex)
        ? yield* attemptRacingRelay(route)
        : yield* attempt(route, yield* Scope.fork(attemptScope));
    if (result._tag === "Success") return { ...result.success, refusedRouteIds };
    // An incompatible server is the same server on every route.
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  if (relay !== undefined) {
    const settled = yield* Fiber.join(relay.fiber).pipe(Effect.result);
    const result = settled._tag === "Success" ? settled.success.result : settled.failure;
    if (result._tag === "Success") return { ...result.success, refusedRouteIds };
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  const late = yield* Effect.forEach(silent, ({ index }) => Fiber.join(checks[index]!), {
    concurrency: "unbounded",
  });
  const answeredLate = silent.filter((_, position) => late[position] !== "silent");
  const stillSilent = silent.filter((_, position) => late[position] === "silent");
  for (const { route } of [...answeredLate, ...stillSilent]) {
    // A route still silent after its whole check can hold the attempt open far
    // longer than the check did. Once another route failed in a way that
    // retries, the retry reaches it sooner than waiting here would.
    if (transient !== undefined && stillSilent.some((entry) => entry.route === route)) break;
    const result = yield* attempt(route, yield* Scope.fork(attemptScope));
    if (result._tag === "Success") return { ...result.success, refusedRouteIds };
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  return yield* (
    transient ??
      blocked ??
      new ConnectionTransientError({
        reason: "endpoint-unavailable",
        ...translatableDetail(
          msg("{host} did not answer on any saved route.", { host: entry.target.label }),
        ),
      })
  );
});

export const preflightRoute = (
  check: Effect.Effect<RouteCheck>,
  prepare: Effect.Effect<unknown, ConnectionAttemptError>,
): Effect.Effect<RoutePreflight> =>
  check.pipe(
    Effect.filterOrElse(
      (check): check is Exclude<RouteCheck, "answered"> => check !== "answered",
      () =>
        prepare.pipe(
          Effect.as<RoutePreflight>("ready"),
          Effect.catch((error) =>
            Effect.succeed<RoutePreflight>(
              isHostCredentialRefusal(error) ? "refused" : "unprepared",
            ),
          ),
        ),
    ),
  );

/** @public */
export const make = Effect.gen(function* () {
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const httpClient = yield* HttpClient.HttpClient;

  // The descriptor is public, so this sends no credential to whatever
  // answers at a saved LAN address on a different network.
  const checkDescriptor = (httpBaseUrl: string, environmentId: string, keepsItsHost: boolean) =>
    fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
      timeoutMs: ROUTE_CHECK_TIMEOUT_MS,
    }).pipe(
      Effect.option,
      // The connect this check leads to skips its own read. Every answer, even a
      // failure, replaces what an older check remembered.
      Effect.tap((descriptor) =>
        remote.rememberCheckedDescriptor(httpBaseUrl, descriptor, keepsItsHost),
      ),
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
    return checkDescriptor(httpBaseUrl, entry.target.environmentId, routeKeepsItsHost(route)).pipe(
      Effect.withSpan("ConnectionDriver.checkRoute", {
        attributes: { "connection.target.kind": route.target._tag },
      }),
    );
  };

  const checkHost = (prepared: PreparedConnection) =>
    checkDescriptor(
      prepared.httpBaseUrl,
      prepared.environmentId,
      prepared.httpBaseUrl.startsWith("https:"),
    ).pipe(
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
        yield* reportProgress({ stage: "preparing" });
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
              ...(prepared.httpAuthorization.directConnection
                ? { directConnection: prepared.httpAuthorization.directConnection }
                : {}),
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not renew the connection's credential.", { error }),
              ),
              Effect.forkScoped,
            );
        }
        return { prepared, session } satisfies RouteConnection;
      }),
    );
  });

  const preflight = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    preflightRoute(
      sendsTokenInClear(connectionRoutes(entry), route)
        ? Effect.succeed("silent" as const)
        : checkRoute(entry, route),
      resolver.prepare(routeEntry(entry, route)),
    ).pipe(Effect.withSpan("ConnectionDriver.preflight"));

  return ConnectionDriver.of({ connect, preflight, checkHost });
});

export const layer = Layer.effect(ConnectionDriver, make);
