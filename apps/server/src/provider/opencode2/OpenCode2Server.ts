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

export interface OpenCode2Connection {
  readonly url: string;
  readonly client: OpenCodeClient;
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
 * it in memory as a `Redacted` (never logged, never serialized).
 */
export const generatePassword = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
  return Redacted.make(Encoding.encodeBase64Url(bytes), { label: "OPENCODE_PASSWORD" });
});

/**
 * The environment for a spawned 2.x server. `OPENCODE_PASSWORD` wins over
 * `OPENCODE_SERVER_PASSWORD` in OpenCode 2, so the inherited 1.x variable is
 * dropped to keep the T3 password the only one in play. The caller's
 * `OPENCODE_PASSWORD` is dropped too: a stale ambient value must never back
 * up — or shadow — the generated password.
 */
export const serverEnvironment = (
  environment: NodeJS.ProcessEnv,
  password: Redacted.Redacted,
): NodeJS.ProcessEnv => {
  const {
    OPENCODE_SERVER_PASSWORD: _inherited,
    OPENCODE_PASSWORD: _ambient,
    ...rest
  } = environment;
  return { ...rest, OPENCODE_PASSWORD: Redacted.value(password) };
};

const isUnreachable = (cause: unknown) =>
  HttpClientError.isHttpClientError(cause) ||
  (P.isTagged(cause, "ClientError") &&
    P.hasProperty(cause, "cause") &&
    HttpClientError.isHttpClientError(cause.cause));

/**
 * Confirms a server is an authenticated OpenCode 2 server through `/api/info`
 * and returns its version. `/health` and friends answer 200 with the web UI's
 * HTML on every version, so only this endpoint proves readiness.
 */
export const verifyServer = (client: OpenCodeClient, url: string) =>
  client.server.info().pipe(
    Effect.timeoutOrElse({
      duration: INFO_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new OpenCodeRuntimeError({
            operation: "server.info",
            detail: `Timed out waiting for the OpenCode server at ${url}.`,
          }),
        ),
    }),
    Effect.catchTags({
      UnauthorizedError: (cause) =>
        Effect.fail(
          new OpenCodeRuntimeError({
            operation: "server.info",
            detail: `The OpenCode server at ${url} rejected the server password.`,
            cause,
          }),
        ),
    }),
    // The client wraps transport failures in `ClientError` too. Anything else
    // that answered is not an OpenCode 2 server: 1.x returns the web UI's HTML here.
    Effect.mapError((cause) =>
      OpenCodeRuntimeError.is(cause)
        ? cause
        : new OpenCodeRuntimeError({
            operation: "server.info",
            detail: isUnreachable(cause)
              ? `Could not reach the OpenCode server at ${url}.`
              : `The server at ${url} is not an OpenCode 2 server.`,
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
 *
 * Lifecycle notes (orphan edge cases): the spawned path inherits the
 * runtime's process-group stop, idle stop, and scope-close stop through the
 * owner — the same guarantees as v1. The external path attaches no lifetime:
 * no process is spawned, so there is no ledger entry, no idle stop, and no
 * stop-on-shutdown (crash recovery and process-group cleanup are no-ops for
 * a server T3 never owned). Double-stop is safe at every layer: the
 * runtime's process-group kill tolerates an already-exited child and the
 * owner's scope close is idempotent. A stale PID (recycled after a crash)
 * must never be signalled — only a group whose recorded member still
 * matches on pid, start time, group, and command line may be stopped.
 */
export const make = Effect.fn("OpenCode2Server.make")(function* (input: {
  readonly binaryPath: string;
  readonly serverUrl: string;
  /** Configured password for an external server; always `Redacted` in memory. */
  readonly serverPassword: Redacted.Redacted;
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const opencode = yield* OpenCode2Client.OpenCode2Client;
  const connectTo = (url: string, password: Redacted.Redacted, external: boolean) =>
    Effect.gen(function* () {
      const client = yield* opencode.connect({ baseUrl: url, password });
      const version = yield* verifyServer(client, url);
      return { url, client, version, external } satisfies OpenCode2Connection;
    });
  let latest: OpenCode2Connection | undefined;
  const remember = (connection: OpenCode2Connection) =>
    Effect.sync(() => {
      latest = connection;
      return connection.version;
    });

  const serverUrl = input.serverUrl.trim();
  if (serverUrl.length > 0) {
    // External path: only the configured password is used. No ambient
    // `OPENCODE_*` variable is consulted here — the spawned path below
    // strips those from the child environment instead. No lifetime attaches
    // here: the external server outlives every borrower, so connect lazily
    // and hold no scope — there is nothing to stop on release or shutdown.
    const connect = connectTo(serverUrl, input.serverPassword, true).pipe(Effect.tap(remember));
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
          : Effect.die(new Error(`OpenCode 2 server ${server.url} was lent before verification.`)),
      ),
  });
});

/** Built once per provider instance from its settings; closing it stops a spawned server. */
export const layer = (input: Parameters<typeof make>[0]) =>
  Layer.effect(OpenCode2Server, make(input));
