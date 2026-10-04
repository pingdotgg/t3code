/**
 * T3's connection to the OpenCode 2 managed service. That process serves every
 * location and is shared with OpenCode CLI commands as well as provider threads.
 *
 * @module provider/opencode2/OpenCode2Server
 */
import type { OpenCodeClient } from "@opencode/client/effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import { OpenCodeRuntimeError } from "../opencodeRuntime.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";

const INFO_TIMEOUT = "5 seconds";

export interface OpenCode2Connection extends OpenCode2Client.OpenCode2Api {
  readonly url: string;
  readonly version: string;
  readonly external: boolean;
}

export class OpenCode2Server extends Context.Service<
  OpenCode2Server,
  {
    /** Runs `use` against the configured server or the user's managed local service. */
    readonly withConnection: <A, E, R>(
      use: (connection: OpenCode2Connection) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntimeError, R>;
  }
>()("t3/provider/opencode2/OpenCode2Server") {}

/** The client wraps HTTP failures in a `ClientError`; this unwraps either shape. */
const httpFailureOf = (cause: unknown): HttpClientError.HttpClientError | undefined => {
  if (HttpClientError.isHttpClientError(cause)) return cause;
  if (
    P.isTagged(cause, "ClientError") &&
    P.hasProperty(cause, "cause") &&
    HttpClientError.isHttpClientError(cause.cause)
  ) {
    return cause.cause;
  }
  return undefined;
};

/**
 * Describes a failed `/api/info` call. Only a transport failure means the
 * server is unreachable; a 401 without the 2.x error body is still a rejected
 * password (1.x sends it empty), and any other failed status is a server error.
 * A 2xx the client cannot decode is not OpenCode 2 (1.x answers with HTML).
 */
const describeInfoFailure = (cause: unknown) => {
  const failure = httpFailureOf(cause);
  if (failure?.reason._tag === "TransportError") {
    return "Could not reach the OpenCode server.";
  }
  const status = failure?.response?.status;
  if (status === 401) return "The OpenCode server rejected the server password.";
  if (status !== undefined && (status < 200 || status >= 300)) {
    return `The OpenCode server returned HTTP ${status}.`;
  }
  return "The server is not an OpenCode 2 server.";
};

/**
 * Confirms a server is an authenticated OpenCode 2 server through `/api/info`
 * and returns its version. `/health` and friends answer 200 with the web UI's
 * HTML on every version, so only this endpoint proves readiness. Details are
 * fixed text because they reach clients and a `serverUrl` can carry
 * credentials; the underlying failure stays in `cause`.
 */
export const verifyServer = (client: OpenCodeClient) =>
  client.server.info().pipe(
    Effect.timeoutOrElse({
      duration: INFO_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new OpenCodeRuntimeError({
            operation: "server.info",
            detail: "Timed out waiting for the OpenCode server.",
          }),
        ),
    }),
    Effect.catchTags({
      UnauthorizedError: (cause) =>
        Effect.fail(
          new OpenCodeRuntimeError({
            operation: "server.info",
            detail: "The OpenCode server rejected the server password.",
            cause,
          }),
        ),
    }),
    Effect.mapError((cause) =>
      OpenCodeRuntimeError.is(cause)
        ? cause
        : new OpenCodeRuntimeError({
            operation: "server.info",
            detail: describeInfoFailure(cause),
            cause,
          }),
    ),
    Effect.map((info) => info.version),
  );

/**
 * With a `serverUrl` it connects to that server with the configured password.
 * Otherwise, the OpenCode CLI ensures its channel-specific managed service is
 * running and supplies its persisted service password. That process is shared
 * with CLI commands and outlives this provider instance.
 */
export const make = Effect.fn("OpenCode2Server.make")(function* (input: {
  readonly binaryPath: string;
  readonly serverUrl: string;
  readonly serverPassword: string;
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const opencode = yield* OpenCode2Client.OpenCode2Client;
  const connectTo = (url: string, password: Redacted.Redacted, external: boolean) =>
    Effect.gen(function* () {
      const api = yield* opencode.connect({ baseUrl: url, password });
      const version = yield* verifyServer(api.client);
      return { ...api, url, version, external } satisfies OpenCode2Connection;
    });
  let latest: OpenCode2Connection | undefined;
  const remember = (connection: OpenCode2Connection) =>
    Effect.sync(() => {
      latest = connection;
      return connection.version;
    });

  const serverUrl = input.serverUrl.trim();
  if (serverUrl.length > 0) {
    const connect = connectTo(serverUrl, Redacted.make(input.serverPassword), true).pipe(
      Effect.tap(remember),
    );
    return OpenCode2Server.of({
      withConnection: (use) =>
        Effect.suspend(() => (latest === undefined ? connect : Effect.succeed(latest))).pipe(
          Effect.flatMap(use),
        ),
    });
  }

  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const serviceCommand = (args: ReadonlyArray<string>, operation: string) =>
    runtime
      .runOpenCodeCommand({
        binaryPath: input.binaryPath,
        args,
        cwd: input.directory,
        environment: input.environment,
      })
      .pipe(
        Effect.timeoutOption("30 seconds"),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new OpenCodeRuntimeError({
                  operation,
                  detail: "Timed out while connecting to the OpenCode service.",
                }),
              ),
            onSome: (result) =>
              result.code === 0
                ? Effect.succeed(result.stdout.replace(/\r?\n$/, ""))
                : Effect.fail(
                    new OpenCodeRuntimeError({
                      operation,
                      detail: "The OpenCode service command failed.",
                    }),
                  ),
          }),
        ),
        Effect.mapError((cause) =>
          OpenCodeRuntimeError.is(cause)
            ? cause
            : new OpenCodeRuntimeError({
                operation,
                detail: "The OpenCode service command failed.",
                cause,
              }),
        ),
      );

  const ensureManagedConnection = Effect.gen(function* () {
    const disabled = yield* serviceCommand(["service", "get", "disabled"], "service.disabled");
    if (disabled === "true") {
      return yield* new OpenCodeRuntimeError({
        operation: "service.disabled",
        detail:
          "OpenCode's background service is disabled. Enable it with opencode service set disabled false before connecting locally.",
      });
    }
    if (disabled !== "false") {
      return yield* new OpenCodeRuntimeError({
        operation: "service.disabled",
        detail: "OpenCode returned an invalid background service setting.",
      });
    }

    const urlOutput = yield* serviceCommand(["service", "start"], "service.start");
    const url = yield* Effect.try({
      try: () => {
        const parsed = new URL(urlOutput.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
        return parsed.origin;
      },
      catch: (cause) =>
        new OpenCodeRuntimeError({
          operation: "service.start",
          detail: "The OpenCode service returned an invalid URL.",
          cause,
        }),
    });
    const password = yield* serviceCommand(["service", "get", "password"], "service.password");
    if (password.length === 0) {
      return yield* new OpenCodeRuntimeError({
        operation: "service.password",
        detail: "The OpenCode service did not provide a password.",
      });
    }
    const connection = yield* connectTo(url, Redacted.make(password), false);
    yield* remember(connection);
    return connection;
  });
  const acquisitionLock = yield* Semaphore.make(1);
  const acquireManagedConnection = (observed: OpenCode2Connection | undefined) =>
    acquisitionLock.withPermits(1)(
      Effect.suspend(() => {
        const cached = latest;
        return cached !== observed && cached !== undefined
          ? Effect.succeed(cached)
          : ensureManagedConnection;
      }),
    );

  return OpenCode2Server.of({
    withConnection: (use) =>
      Effect.suspend(() => {
        const cached = latest;
        return cached === undefined
          ? acquireManagedConnection(undefined)
          : verifyServer(cached.client).pipe(
              Effect.as(cached),
              Effect.catch(() => acquireManagedConnection(cached)),
            );
      }).pipe(Effect.flatMap(use)),
  });
});

/** Built once per provider instance from its settings; local service lifetime belongs to OpenCode. */
export const layer = (input: Parameters<typeof make>[0]) =>
  Layer.effect(OpenCode2Server, make(input));
