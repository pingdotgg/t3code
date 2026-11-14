import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
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
  connectionRoutes,
  routeEntry,
  type RouteGrant,
  routeGrantFromSession,
  routeHttpBaseUrl,
  routeKeepsItsHost,
  sendsTokenInClear,
  usableRoutes,
} from "./routes.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcSession from "../rpc/session.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
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
const GRANT_CHECK_TIMEOUT_MS = 6_000;
// The T3 Connect sign-in loads after launch, often after the first route check.
const SESSION_PENDING_RETRY = Schedule.spaced("1 second");
const SESSION_PENDING_RETRIES = 30;
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
    /** What the host says a prepared connection's credential grants; none when it cannot tell. */
    readonly sessionGrant: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<RouteGrant>>;
    /** Prepares a bearer or T3 Connect route without opening a socket and asks for its grant. */
    readonly routeGrant: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<Option.Option<RouteGrant>>;
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
  const silent: Array<{ readonly route: ConnectionRoute; readonly index: number }> = [];
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
    const result = yield* attempt(route);
    if (result._tag === "Success") return result.success;
    // An incompatible server is the same server on every route.
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

/** @public */
export const make = Effect.gen(function* () {
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const httpClient = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);

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

  // Callers first confirm the host answers as this environment.
  const askGrant = (prepared: PreparedConnection) =>
    prepared.httpAuthorization === null
      ? Effect.succeedNone
      : executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization: Option.some(remote),
          group: "auth",
          method: "GET",
          url: (urls) => urls.session(),
          timeoutMs: GRANT_CHECK_TIMEOUT_MS,
          request: ({ client, headers }) => client.session({ headers }),
          // This endpoint returns 200 with authenticated:false for expired credentials.
          isUnauthorizedResponse: (response) => !response.authenticated,
        }).pipe(
          Effect.map(routeGrantFromSession),
          Effect.orElseSucceed(() => Option.none<RouteGrant>()),
          Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" }),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );

  // After a network change the session's address may belong to another
  // machine, so it must answer as this environment before it gets the credential.
  const sessionGrant = Effect.fn("ConnectionDriver.sessionGrant")(function* (
    prepared: PreparedConnection,
  ) {
    yield* Effect.annotateCurrentSpan("connection.target.kind", prepared.target._tag);
    if ((yield* checkHost(prepared)) === "silent") return Option.none<RouteGrant>();
    return yield* askGrant(prepared);
  });

  // Like preflight, a saved address must answer as this environment before it
  // receives the route's credential.
  const routeGrant = Effect.fn("ConnectionDriver.routeGrant")(function* (
    entry: ConnectionCatalogEntry,
    route: ConnectionRoute,
  ) {
    if (
      (route.target._tag !== "BearerConnectionTarget" &&
        route.target._tag !== "RelayConnectionTarget") ||
      sendsTokenInClear(connectionRoutes(entry), route) ||
      (yield* checkRoute(entry, route)) === "silent"
    ) {
      return Option.none<RouteGrant>();
    }
    return yield* resolver.prepare(routeEntry(entry, route)).pipe(
      // Reporting the route silent here would back it off for minutes.
      Effect.retry({
        schedule: SESSION_PENDING_RETRY,
        times: SESSION_PENDING_RETRIES,
        while: (error) =>
          error._tag === "ConnectionTransientError" && error.reason === "session-pending",
      }),
      Effect.flatMap(askGrant),
      Effect.orElseSucceed(() => Option.none<RouteGrant>()),
    );
  });

  return ConnectionDriver.of({ connect, preflight, checkHost, sessionGrant, routeGrant });
});

export const layer = Layer.effect(ConnectionDriver, make);
