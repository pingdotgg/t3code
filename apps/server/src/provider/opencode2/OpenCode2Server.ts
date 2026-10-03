/**
 * The OpenCode 2 server behind one provider instance. A 2.x server serves every
 * location from one process, so an instance shares one server across all of its
 * threads and directories.
 *
 * @module provider/opencode2/OpenCode2Server
 */
import type { OpenCodeClient } from "@opencode/client/effect";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { OpenCodeRuntimeError } from "../opencodeRuntime.ts";
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
    /** Runs `use` against the instance's server, spawning it first when T3 owns it. */
    readonly withConnection: <A, E, R>(
      use: (connection: OpenCode2Connection) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntimeError, R>;
  }
>()("t3/provider/opencode2/OpenCode2Server") {}

/**
 * A fresh password for a spawned server. OpenCode 2 always requires one and
 * prints a generated one to stdout otherwise, so T3 supplies its own and keeps
 * it in memory.
 */
export const generatePassword = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
  return Redacted.make(Encoding.encodeBase64Url(bytes), { label: "OPENCODE_PASSWORD" });
});

/**
 * The environment for a spawned 2.x server. `OPENCODE_PASSWORD` wins over
 * `OPENCODE_SERVER_PASSWORD` in OpenCode 2, so the inherited 1.x variable is
 * dropped to keep the T3 password the only one in play.
 */
export const serverEnvironment = (
  environment: NodeJS.ProcessEnv,
  password: Redacted.Redacted,
): NodeJS.ProcessEnv => {
  const { OPENCODE_SERVER_PASSWORD: _inherited, ...rest } = environment;
  return { ...rest, OPENCODE_PASSWORD: Redacted.value(password) };
};

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
 * One server per provider instance. With a `serverUrl` it connects to that
 * server with the configured password; otherwise it spawns `binaryPath serve`
 * with a generated password through {@link OpenCodeServerOwner}, which shares
 * the process between borrowers and stops it after an idle period. Clients are
 * built once per server; a failed check is not remembered.
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

  const password = yield* generatePassword;
  const owner = yield* OpenCodeServerOwner.make({
    binaryPath: input.binaryPath,
    directory: input.directory,
    environment: serverEnvironment(input.environment, password),
    verify: (url) => connectTo(url, password, false).pipe(Effect.flatMap(remember)),
  });
  return OpenCode2Server.of({
    withConnection: (use) =>
      owner.withServer((server) =>
        // The owner verifies every server it starts before lending it out.
        latest?.url === server.url
          ? use(latest)
          : Effect.die(new Error("OpenCode 2 server was lent before verification.")),
      ),
  });
});

/** Built once per provider instance from its settings; closing it stops a spawned server. */
export const layer = (input: Parameters<typeof make>[0]) =>
  Layer.effect(OpenCode2Server, make(input));
