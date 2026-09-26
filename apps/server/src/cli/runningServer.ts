/**
 * Plumbing for CLI commands that manage the running T3 Code server
 * (`t3 remote`).
 *
 * Discovery and credentials mirror `t3 pair`: the running server is found
 * through the runtime state it persists next to its database, and every
 * invocation mints a short-lived administrative session in that database,
 * revoked when the command finishes. Commands then drive the server over the
 * same WebSocket RPC surface the UIs use, carrying the session as a bearer
 * header on the upgrade request.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAdministrativeScopes,
  EnvironmentAuthorizationError,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { DurationFromString } from "./config.ts";
import { type DiscoveredPairTarget, discoverPairTarget, makePairServerConfig } from "./pair.ts";

/**
 * Bound for one unary call against the running server: generous for a busy
 * disk, short enough that a wedged server does not hang the terminal.
 */
const RUNNING_SERVER_REQUEST_TIMEOUT = Duration.seconds(10);
const RPC_OPEN_TIMEOUT = Duration.seconds(10);

const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

/** The running server plus the administrative session minted for one CLI invocation. */
interface RunningServerSession {
  readonly target: DiscoveredPairTarget;
  /** Origin the server listens on; HTTP and the RPC WebSocket both live here. */
  readonly origin: string;
  readonly token: string;
}

/**
 * Anything the running server answered with that is not a typed Tailcat
 * failure: rejected credentials, an internal error, a transport failure, or
 * no answer at all. The cause stays attached for logs.
 */
export class RunningServerRequestError extends Schema.TaggedError<RunningServerRequestError>()(
  "RunningServerRequestError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cause = this.cause;
    if (isEnvironmentAuthorizationError(cause)) {
      return `The running server rejected ${this.operation}: ${cause.message}`;
    }
    if (Cause.isTimeoutError(cause)) {
      return `The running server did not answer ${this.operation} within ${Duration.format(RUNNING_SERVER_REQUEST_TIMEOUT)}.`;
    }
    if (isRpcClientError(cause)) {
      return `Lost the connection to the running server during ${this.operation}.`;
    }
    return `Failed to call the running server (${this.operation}).`;
  }
}

/**
 * Discover the running server, mint an administrative session in its database
 * and run `run` with it. The session is revoked on the way out, including on
 * interruption, so a Ctrl-C leaves nothing behind.
 */
const withRunningServerSession = Effect.fn("runningServer.withSession")(function* <A, E, R>(input: {
  readonly baseDir: Option.Option<string>;
  readonly label: string;
  /** Machine-readable output must stay parseable, so `--json` raises the log floor to Error. */
  readonly quietLogs: boolean;
  readonly run: (session: RunningServerSession) => Effect.Effect<A, E, R>;
}) {
  const cliLogLevel = yield* GlobalFlag.LogLevel;
  // Default to Warn so storage/migration chatter cannot bury the output; an
  // explicit --log-level still wins unless the output has to be JSON.
  const logLevel = input.quietLogs
    ? ("Error" as const)
    : Option.getOrElse(cliLogLevel, () => "Warn" as const);
  const target = yield* discoverPairTarget(Option.getOrUndefined(input.baseDir));
  const config = yield* makePairServerConfig({ target, logLevel });

  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* Effect.acquireUseRelease(
      environmentAuth.issueSession({ scopes: AuthAdministrativeScopes, label: input.label }),
      (issued) => input.run({ target, origin: target.state.origin, token: issued.token }),
      (issued) =>
        environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
  }).pipe(
    Effect.provide(
      EnvironmentAuth.runtimeLayer.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, logLevel)),
      ),
    ),
  );
});

/** The server's `/ws` route on the origin it recorded; the dev proxy is not involved on loopback. */
export const runningServerWsUrl = (origin: string): string => {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

// Node's `ws` client rather than the global WebSocket: the administrative
// bearer token has to ride on the upgrade request, and only `ws` takes headers.
// Socket.makeWebSocket only ever passes its `protocols` option here.
const bearerWebSocketConstructorLayer = (token: string) =>
  Layer.succeed(
    Socket.WebSocketConstructor,
    (url, protocols) =>
      new NodeSocket.NodeWS.WebSocket(url, protocols as string | string[] | undefined, {
        headers: { authorization: `Bearer ${token}` },
      }) as unknown as globalThis.WebSocket,
  );

const rpcProtocolLayer = (session: RunningServerSession) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(runningServerWsUrl(session.origin), {
        openTimeout: RPC_OPEN_TIMEOUT,
      }).pipe(Layer.provide(bearerWebSocketConstructorLayer(session.token))),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeRpcClient = RpcClient.make(WsRpcGroup);
export type WsRpcClient = Effect.Success<typeof makeRpcClient>;

/** Runs `run` with an RPC client to the running server, authenticated for this invocation only. */
export const withRunningServerRpcClient = <A, E, R>(input: {
  readonly baseDir: Option.Option<string>;
  readonly label: string;
  readonly quietLogs: boolean;
  readonly run: (client: WsRpcClient) => Effect.Effect<A, E, R>;
}) =>
  withRunningServerSession({
    baseDir: input.baseDir,
    label: input.label,
    quietLogs: input.quietLogs,
    run: (session) =>
      Effect.scoped(
        makeRpcClient.pipe(Effect.flatMap(input.run), Effect.provide(rpcProtocolLayer(session))),
      ),
  }).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * Bounds a request to the running server and wraps anything that is not a
 * typed server error (authorization, transport, no answer) so the user sees
 * one consistent failure shape.
 */
export const callRunningServer = <A, E, T extends E>(
  operation: string,
  request: Effect.Effect<A, E>,
  isTyped: (cause: E) => cause is T,
): Effect.Effect<A, T | RunningServerRequestError> =>
  request.pipe(
    Effect.timeout(RUNNING_SERVER_REQUEST_TIMEOUT),
    Effect.mapError((cause) =>
      isTyped(cause as E) ? (cause as T) : new RunningServerRequestError({ operation, cause }),
    ),
  );

/** `--ttl` for one-time codes (`t3 remote tailcat code`). */
export const codeTtlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription(
    "How long the code stays redeemable, for example `5m` or `1h`. Defaults to 5 minutes.",
  ),
  Flag.optional,
);

export const codeTtlInput = (ttl: Option.Option<Duration.Duration>) =>
  Option.isSome(ttl) ? { ttlSeconds: Math.max(1, Math.round(Duration.toSeconds(ttl.value))) } : {};
