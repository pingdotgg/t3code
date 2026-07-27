/**
 * Client-side protocol failures reported by unstable RPC transports.
 *
 * `RpcClientError` is the error type generated clients use when a call fails
 * before a remote handler can return its declared typed error. Its `reason`
 * covers built-in transport failures from HTTP, sockets, and workers, plus
 * `RpcClientDefect` values for malformed or incompatible protocol data.
 *
 * @since 4.0.0
 */
import * as Schema from "../../Schema.ts"
import { HttpClientErrorSchema } from "../http/HttpClientError.ts"
import { SocketErrorReason } from "../socket/Socket.ts"
import { WorkerErrorReason } from "../workers/WorkerError.ts"

const TypeId = "~effect/rpc/RpcClientError"

/**
 * Represents a client-side RPC defect, such as a protocol violation or
 * decoding failure, with a message and original cause.
 *
 * @category errors
 * @since 4.0.0
 */
export class RpcClientDefect extends Schema.ErrorClass<RpcClientDefect>("effect/rpc/RpcClientError/RpcClientDefect")({
  _tag: Schema.tag("RpcClientDefect"),
  message: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * Error wrapper for RPC client failures, including worker, socket, HTTP client,
 * and client protocol defect failures.
 *
 * @category errors
 * @since 4.0.0
 */
export class RpcClientError extends Schema.ErrorClass<RpcClientError>(TypeId)({
  _tag: Schema.tag("RpcClientError"),
  reason: Schema.Union([
    WorkerErrorReason,
    SocketErrorReason,
    HttpClientErrorSchema,
    RpcClientDefect
  ])
}) {
  /**
   * Marks this value as an RPC client error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  override get message(): string {
    return `${this.reason._tag}: ${this.reason.message}`
  }
}
