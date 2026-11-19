import { type AuthEnvironmentScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
    return `The T3 Code server at ${this.origin} is running but did not answer, so the change may or may not have been made. Check the current state before you retry, or restart the server.`;
  }
}

export type ServerClient = HttpApiClient.ForApi<typeof EnvironmentHttpApi>;

// The scope revokes the session; the TTL bounds it if that never runs.
const SESSION_TTL = Duration.minutes(2);
const REQUEST_TIMEOUT = Duration.seconds(30);

/** A client of the server at `origin`, signed in as a short-lived session for the scope. */
const serverClient = Effect.fn("RunningServer.serverClient")(function* (
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
    // An error answer is final; no answer means the server is gone or stuck, and the lock tells.
    Effect.catchIf(isUnanswered, (cause) =>
      changeLocally(() => Effect.fail(new RunningServerUnreachableError({ origin, cause }))),
    ),
  );
});
