import { type AuthEnvironmentScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import {
  clearPersistedServerRuntimeState,
  readLiveServerRuntimeState,
} from "../serverRuntimeState.ts";

export class RunningServerUnreachableError extends Schema.TaggedError<RunningServerUnreachableError>()(
  "RunningServerUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The T3 Code server at ${this.origin} is running but refused the connection, so nothing was changed. Retry, or restart the server and retry.`;
  }
}

export class RunningServerNoReplyError extends Schema.TaggedError<RunningServerNoReplyError>()(
  "RunningServerNoReplyError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The T3 Code server at ${this.origin} did not reply, so the change may or may not have been made. Check the current state before you retry.`;
  }
}

export type ServerClient = HttpApiClient.ForApi<typeof EnvironmentHttpApi>;

// The scope revokes the session; the TTL bounds it if that never runs.
const SESSION_TTL = Duration.minutes(2);
const REQUEST_TIMEOUT = Duration.seconds(30);

/** A client of the server at `origin`, signed in as a short-lived session for the scope. */
export const serverClient = Effect.fn("RunningServer.serverClient")(function* (
  origin: string,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* Effect.acquireRelease(
    environmentAuth.issueSession({ scopes, subject: "cli", label: "t3 cli", ttl: SESSION_TTL }),
    ({ sessionId }) => environmentAuth.revokeSession(sessionId).pipe(Effect.ignore({ log: true })),
  );
  return yield* HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(session.token)),
  }).pipe(Effect.provide(FetchHttpClient.layer));
});

// The request never reached a server, so it changed nothing there.
const NOT_CONNECTED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const systemErrorCode = (error: unknown) =>
  [error, Predicate.hasProperty(error, "cause") ? error.cause : undefined]
    .map((candidate) => (Predicate.hasProperty(candidate, "code") ? candidate.code : undefined))
    .find(Predicate.isString);
const neverConnected = (cause: unknown) => {
  if (!HttpClientError.isHttpClientError(cause) || cause.reason._tag !== "TransportError") {
    return false;
  }
  const code = systemErrorCode(cause.reason.cause);
  return code !== undefined && NOT_CONNECTED_CODES.has(code);
};
const isUnanswered = (cause: unknown) =>
  Cause.isTimeoutError(cause) ||
  (HttpClientError.isHttpClientError(cause) && cause.response === undefined);

/**
 * Makes a change through the running server, so the server applies it and its clients see it.
 * With no server, makes it locally while holding the ownership lock, so none starts midway.
 */
export const changeState = Effect.fn("RunningServer.changeState")(function* <A, E, R, E2, R2>({
  scopes,
  viaServer,
  locally,
}: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly viaServer: (client: ServerClient) => Effect.Effect<A, E, R>;
  readonly locally: Effect.Effect<A, E2, R2>;
}) {
  const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  const changeLocally = <E3>(
    ifServerRuns: (error: ServerOwnership.ServerAlreadyRunningError) => Effect.Effect<never, E3>,
  ) =>
    ServerOwnership.acquireServerOwnership(serverRuntimeStatePath).pipe(
      Effect.provide(ProcessRunner.layer),
      Effect.catchTags({ ServerAlreadyRunningError: ifServerRuns }),
      Effect.andThen(locally),
      // The lock proves the recorded server is gone; drop its record once the change lands.
      Effect.tap(() => clearPersistedServerRuntimeState(serverRuntimeStatePath)),
      Effect.scoped,
    );

  const running = yield* readLiveServerRuntimeState(serverRuntimeStatePath);
  if (Option.isNone(running)) return yield* changeLocally(Effect.fail);
  const { origin } = running.value;
  return yield* serverClient(origin, scopes).pipe(
    Effect.flatMap(viaServer),
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.scoped,
    // A refused connection reached no server, so the lock decides whether one still runs.
    Effect.catchIf(neverConnected, (cause) =>
      changeLocally(() => Effect.fail(new RunningServerUnreachableError({ origin, cause }))),
    ),
    // Once connected, the server may have made the change; writing it again could repeat it.
    Effect.catchIf(isUnanswered, (cause) =>
      Effect.fail(new RunningServerNoReplyError({ origin, cause })),
    ),
  );
});
