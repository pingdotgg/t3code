import { msg } from "gt-i18n";
import { translatableDetail } from "../errors/translatable.ts";
import * as Clock from "effect/Clock";
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
// A head start that ends this late means the client's own thread was busy (a
// React Native render can hold it for over a second), so check answers that
// arrived meanwhile have not been read yet. They get one more short wait
// instead of being judged silent by a timer that fired late.
const ROUTE_CHECK_LATE_TIMER_MS = 100;
const ROUTE_CHECK_LATE_GRACE_MS = 150;

export interface ConnectOptions {
  /**
   * A route that just passed its preflight. It is tried first without a fresh
   * check, so a busy client does not miss the head start, land on a worse
   * route and put the route it was switching to in cooldown.
   */
  readonly trustedRouteId?: string;
}

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
      options?: ConnectOptions,
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
  options: ConnectOptions = {},
) {
  const routes = usableRoutes(entry);
  const checks =
    routes.length === 1
      ? []
      : yield* Effect.forEach(routes, (route) => Effect.forkChild(checkRoute(route)));
  const headStart = yield* Effect.forkChild(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(ROUTE_CHECK_HEAD_START_MS);
      const lateBy = (yield* Clock.currentTimeMillis) - startedAt - ROUTE_CHECK_HEAD_START_MS;
      if (lateBy >= ROUTE_CHECK_LATE_TIMER_MS) yield* Effect.sleep(ROUTE_CHECK_LATE_GRACE_MS);
    }),
  );
  const attemptScope = yield* Scope.Scope;
  let transient: ConnectionAttemptError | undefined;
  let blocked: ConnectionAttemptError | undefined;
  const refusedRouteIds: Array<string> = [];
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
      if (isHostCredentialRefusal(result.failure))
        refusedRouteIds.push(connectionRouteId(route.target));
    }
    return result;
  });
  const silent: Array<{ readonly route: ConnectionRoute; readonly index: number }> = [];
  for (const [index, route] of routes.entries()) {
    const trusted =
      options.trustedRouteId !== undefined &&
      connectionRouteId(route.target) === options.trustedRouteId;
    const check =
      checks.length === 0 || trusted
        ? "unchecked"
        : yield* Effect.raceFirst(
            Fiber.join(checks[index]!),
            Fiber.join(headStart).pipe(Effect.as<RouteCheck>("silent")),
          );
    if (check === "silent") {
      silent.push({ route, index });
      continue;
    }
    const result = yield* attempt(route);
    if (result._tag === "Success") return { ...result.success, refusedRouteIds };
    // An incompatible server is the same server on every route.
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  // A route that missed the head start is tried as soon as its check answers,
  // instead of after every slower check finished: a LAN the device has left
  // would otherwise hold a route that answered long ago for the whole check
  // timeout. Checks that finished together go in route order.
  const settledChecks = (entries: ReadonlyArray<(typeof silent)[number]>) =>
    entries.flatMap((entry) => {
      const exit = checks[entry.index]!.pollUnsafe();
      if (exit === undefined) return [];
      return [{ entry, check: Exit.isSuccess(exit) ? exit.value : ("silent" as const) }];
    });
  let pending: ReadonlyArray<(typeof silent)[number]> = silent;
  const stillSilent: Array<(typeof silent)[number]> = [];
  while (pending.length > 0) {
    let settled = settledChecks(pending);
    if (settled.length === 0) {
      yield* Effect.raceAll(pending.map(({ index }) => Fiber.await(checks[index]!)));
      settled = settledChecks(pending);
    }
    pending = pending.filter((entry) => !settled.some((done) => done.entry === entry));
    for (const { entry, check } of settled) {
      if (check === "silent") {
        stillSilent.push(entry);
        continue;
      }
      const result = yield* attempt(entry.route);
      if (result._tag === "Success") return { ...result.success, refusedRouteIds };
      if (result.failure.reason === "unsupported") return yield* result.failure;
    }
  }
  stillSilent.sort((left, right) => left.index - right.index);
  for (const { route } of stillSilent) {
    // A route still silent after its whole check can hold the attempt open far
    // longer than the check did. Once another route failed in a way that
    // retries, the retry reaches it sooner than waiting here would.
    if (transient !== undefined) break;
    const result = yield* attempt(route);
    if (result._tag === "Success") return { ...result.success, refusedRouteIds };
    if (result.failure.reason === "unsupported") return yield* result.failure;
    // A route that never answered cannot explain why a host that answered refused.
    if (blocked !== undefined) transient = undefined;
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
    options?: ConnectOptions,
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
      options,
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
