// One OpenCode 2 process serves all directories; share it across instance threads.
import type { OpenCodeClient } from "@opencode/client/effect";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as P from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as HttpClientError from "effect/http/HttpClientError";

import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";
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
    readonly withConnection: <A, E, R>(
      use: (connection: OpenCode2Connection) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
  }
>()("@t3tools/provider-opencode/server/v2/OpenCode2Server") {}

/**
 * OpenCode 2 always requires one and prints a generated one to stdout
 * otherwise, so T3 supplies its own and keeps it in memory.
 */
const generatePassword = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
  return Redacted.make(Base64Url.encode(bytes), { label: "OPENCODE_PASSWORD" });
});

/** OPENCODE_PASSWORD overrides OPENCODE_SERVER_PASSWORD; drop the inherited 1.x variable. */
export const serverEnvironment = (
  environment: NodeJS.ProcessEnv,
  password: Redacted.Redacted,
): NodeJS.ProcessEnv => {
  const { OPENCODE_SERVER_PASSWORD: _inherited, ...rest } = environment;
  return { ...rest, OPENCODE_PASSWORD: Redacted.value(password) };
};

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

// Empty 401s still reject passwords; undecodable 2xx may be 1.x HTML, not OpenCode 2.
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

/** Only server info proves readiness; keep credential-bearing failure details out of client text. */
export const verifyServer = (client: OpenCodeClient) =>
  client.server.info().pipe(
    Effect.timeoutOrElse({
      duration: INFO_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: "Timed out waiting for the OpenCode server.",
          }),
        ),
    }),
    Effect.catchTags({
      UnauthorizedError: (cause) =>
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: "The OpenCode server rejected the server password.",
            cause,
          }),
        ),
    }),
    Effect.mapError((cause) =>
      OpenCodeRuntime.isOpenCodeRuntimeError(cause)
        ? cause
        : new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: describeInfoFailure(cause),
            cause,
          }),
    ),
    Effect.map((info) => info.version),
  );

export const make = Effect.fn("OpenCode2Server.make")(function* (input: {
  readonly binaryPath: string;
  readonly serverUrl: string;
  readonly serverPassword: string;
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const opencode = yield* OpenCode2Client.OpenCode2Client;
  const connectTo = Effect.fn("OpenCode2Server.connectTo")(function* (
    url: string,
    password: Redacted.Redacted,
    external: boolean,
  ) {
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
      withConnection: Effect.fn("OpenCode2Server.withConnection")(function (use) {
        return Effect.suspend(() => (latest === undefined ? connect : Effect.succeed(latest))).pipe(
          Effect.flatMap(use),
        );
      }),
    });
  }

  const password = yield* generatePassword;
  const owner = yield* OpenCodeServerOwner.make({
    binaryPath: input.binaryPath,
    directory: input.directory,
    environment: serverEnvironment(input.environment, password),
    verify: (url) => connectTo(url, password, false).pipe(Effect.flatMap(remember)),
  });
  return OpenCode2Server.of({
    withConnection: Effect.fn("OpenCode2Server.withConnection")(function (use) {
      return owner.withServer((server) =>
        latest?.url === server.url
          ? use(latest)
          : Effect.die(new Error("OpenCode 2 server was lent before verification.")),
      );
    }),
  });
});
