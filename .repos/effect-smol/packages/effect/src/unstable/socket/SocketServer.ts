/**
 * Effect service model for servers that accept socket connections and hand each
 * accepted connection to an Effect handler as a `Socket.Socket`.
 *
 * This module contains the shared, platform-independent contract for socket
 * servers: a bound `address`, a long-running `run` accept loop, the TCP and
 * Unix socket address models, and the server-level errors reported while
 * opening or running a server. Concrete transports, such as Node TCP servers or
 * WebSocket servers, provide this service through platform-specific layers.
 *
 * `SocketServer` is commonly used as the server transport for RPC protocols,
 * cluster runners, developer tools, and tests that need an ephemeral TCP port or
 * Unix-domain socket. A server address may differ from the requested listen
 * options after binding, for example when listening on port `0`, so consumers
 * should read the provided `address` from the service.
 *
 * The `run` effect represents the server accept loop and is expected to remain
 * alive until interrupted or until the providing scope is closed. Protocol
 * framing is intentionally outside this module: handlers receive a generic
 * `Socket.Socket`, so callers are responsible for choosing byte, string, raw
 * frame, or higher-level protocol adapters and for treating connection-level
 * failures separately from `SocketServerError` values.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Data from "../../Data.ts"
import type * as Effect from "../../Effect.ts"
import type * as Socket from "./Socket.ts"

/**
 * Context service for a socket server, exposing its bound address and a run
 * loop that handles each accepted `Socket`.
 *
 * @category tags
 * @since 4.0.0
 */
export class SocketServer extends Context.Service<SocketServer, {
  readonly address: Address
  readonly run: <R, E, _>(
    handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>
  ) => Effect.Effect<never, SocketServerError, R>
}>()("@effect/platform/SocketServer") {}

/**
 * Runtime type identifier attached to `SocketServerError` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const ErrorTypeId: ErrorTypeId = "@effect/platform/SocketServer/SocketServerError"

/**
 * Type-level identifier used to mark `SocketServerError` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type ErrorTypeId = "@effect/platform/SocketServer/SocketServerError"

/**
 * Error reason for failures that occur while opening a socket server.
 *
 * @category errors
 * @since 4.0.0
 */
export class SocketServerOpenError extends Data.TaggedError("SocketServerOpenError")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return "Open"
  }
}

/**
 * Error reason for uncategorized socket server failures.
 *
 * @category errors
 * @since 4.0.0
 */
export class SocketServerUnknownError extends Data.TaggedError("SocketServerUnknownError")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return "Unknown"
  }
}

/**
 * Union of socket server error reasons.
 *
 * @category errors
 * @since 4.0.0
 */
export type SocketServerErrorReason = SocketServerOpenError | SocketServerUnknownError

/**
 * Tagged socket server error that wraps a server error reason and exposes its
 * cause.
 *
 * @category errors
 * @since 4.0.0
 */
export class SocketServerError extends Data.TaggedError("SocketServerError")<{
  readonly reason: SocketServerErrorReason
}> {
  constructor(props: {
    readonly reason: SocketServerErrorReason
  }) {
    super({
      ...props,
      cause: props.reason.cause
    } as any)
  }
  /**
   * Marks this value as a socket server error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ErrorTypeId]: ErrorTypeId = ErrorTypeId

  /**
   * Delegates the public message to the underlying socket server error reason.
   *
   * @since 4.0.0
   */
  override get message(): string {
    return this.reason.message
  }
}

/**
 * Socket server address, either a TCP host and port or a Unix socket path.
 *
 * @category models
 * @since 4.0.0
 */
export type Address = UnixAddress | TcpAddress

/**
 * TCP socket server address with hostname and port.
 *
 * @category models
 * @since 4.0.0
 */
export interface TcpAddress {
  readonly _tag: "TcpAddress"
  readonly hostname: string
  readonly port: number
}

/**
 * Unix socket server address identified by a filesystem path.
 *
 * @category models
 * @since 4.0.0
 */
export interface UnixAddress {
  readonly _tag: "UnixAddress"
  readonly path: string
}
