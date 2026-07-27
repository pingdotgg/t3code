/**
 * Message envelopes shared by unstable RPC clients, servers, serializers, and
 * transports.
 *
 * `RpcMessage` is the protocol vocabulary below `RpcClient` and `RpcServer`.
 * It defines decoded messages for in-process channels and encoded messages for
 * transport boundaries, so custom protocols can move the same request,
 * streaming, acknowledgement, interrupt, keepalive, and defect signals as the
 * built-in HTTP, socket, worker, and test transports.
 *
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import type { Branded } from "../../Brand.ts"
import * as Schema from "../../Schema.ts"
import type { Headers } from "../http/Headers.ts"
import type * as Rpc from "./Rpc.ts"
import type { RpcClientError } from "./RpcClientError.ts"

/**
 * Decoded messages that can be sent from an RPC client to a server.
 *
 * @category request
 * @since 4.0.0
 */
export type FromClient<A extends Rpc.Any> = Request<A> | Ack | Interrupt | Eof

/**
 * Transport-encoded messages that can be sent from an RPC client to a server.
 *
 * @category request
 * @since 4.0.0
 */
export type FromClientEncoded = RequestEncoded | AckEncoded | InterruptEncoded | Ping | Eof

/**
 * A branded request identifier used to correlate RPC requests, responses,
 * chunks, acknowledgements, and interrupts.
 *
 * @category request
 * @since 4.0.0
 */
export type RequestId = Branded<string | number, "~effect/rpc/RpcMessage/RequestId">

/**
 * Converts a bigint or string request id into the branded `RequestId` type.
 *
 * @category request
 * @since 4.0.0
 */
export const RequestId = (id: string | number): RequestId => id as RequestId

/**
 * The transport-encoded RPC request envelope, including the string request id,
 * RPC tag, encoded payload, headers, and optional trace context.
 *
 * @category request
 * @since 4.0.0
 */
export interface RequestEncoded {
  readonly _tag: "Request"
  readonly id: string | number
  readonly tag: string
  readonly payload: unknown
  readonly headers: ReadonlyArray<[string, string]>
  readonly traceId?: string
  readonly spanId?: string
  readonly sampled?: boolean
}

/**
 * The decoded RPC request envelope for an RPC union, carrying a branded request
 * id, typed RPC tag, decoded payload, headers, and optional trace context.
 *
 * @category request
 * @since 4.0.0
 */
export interface Request<A extends Rpc.Any> {
  readonly _tag: "Request"
  readonly id: RequestId
  readonly tag: Rpc.Tag<A>
  readonly payload: Rpc.Payload<A>
  readonly headers: Headers
  readonly traceId?: string
  readonly spanId?: string
  readonly sampled?: boolean
}

/**
 * A decoded acknowledgement for a streamed RPC response chunk.
 *
 * @category request
 * @since 4.0.0
 */
export interface Ack {
  readonly _tag: "Ack"
  readonly requestId: RequestId
}

/**
 * A decoded request to interrupt an in-flight RPC, carrying the request id and
 * interrupting fiber ids.
 *
 * @category request
 * @since 4.0.0
 */
export interface Interrupt {
  readonly _tag: "Interrupt"
  readonly requestId: RequestId
  readonly interruptors: ReadonlyArray<number>
}

/**
 * The transport-encoded acknowledgement for a streamed RPC response chunk.
 *
 * @category request
 * @since 4.0.0
 */
export interface AckEncoded {
  readonly _tag: "Ack"
  readonly requestId: string | number
}

/**
 * The transport-encoded request to interrupt an in-flight RPC.
 *
 * @category request
 * @since 4.0.0
 */
export interface InterruptEncoded {
  readonly _tag: "Interrupt"
  readonly requestId: string | number
}

/**
 * A client-to-server message indicating that the client has finished sending
 * input for the current connection or request batch.
 *
 * @category request
 * @since 4.0.0
 */
export interface Eof {
  readonly _tag: "Eof"
}

/**
 * A client-to-server keepalive message used by protocols that monitor
 * connection liveness.
 *
 * @category request
 * @since 4.0.0
 */
export interface Ping {
  readonly _tag: "Ping"
}

/**
 * Represents the reusable `Eof` message value.
 *
 * @category request
 * @since 4.0.0
 */
export const constEof: Eof = { _tag: "Eof" }

/**
 * Represents the reusable `Ping` message value.
 *
 * @category request
 * @since 4.0.0
 */
export const constPing: Ping = { _tag: "Ping" }

/**
 * Decoded messages that can be sent from an RPC server to a client.
 *
 * @category response
 * @since 4.0.0
 */
export type FromServer<A extends Rpc.Any> =
  | ResponseChunk<A>
  | ResponseExit<A>
  | ResponseDefect
  | ClientEnd

/**
 * Transport-encoded messages that can be sent from an RPC server to a client.
 *
 * @category response
 * @since 4.0.0
 */
export type FromServerEncoded =
  | ResponseChunkEncoded
  | ResponseExitEncoded
  | ResponseDefectEncoded
  | Pong
  | ClientProtocolError

/**
 * The brand identifier used by the `ResponseId` type.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const ResponseIdTypeId = "~effect//rpc/RpcServer/ResponseId"

/**
 * The literal type of the `ResponseId` brand identifier.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type ResponseIdTypeId = typeof ResponseIdTypeId

/**
 * A branded numeric identifier for server responses.
 *
 * @category response
 * @since 4.0.0
 */
export type ResponseId = Branded<number, ResponseIdTypeId>

/**
 * The transport-encoded response message containing a non-empty batch of stream
 * chunk values for a request.
 *
 * @category response
 * @since 4.0.0
 */
export interface ResponseChunkEncoded {
  readonly _tag: "Chunk"
  readonly requestId: string | number
  readonly values: NonEmptyReadonlyArray<unknown>
}

/**
 * The decoded response message containing a non-empty batch of stream chunk
 * values for a specific client and request.
 *
 * @category response
 * @since 4.0.0
 */
export interface ResponseChunk<A extends Rpc.Any> {
  readonly _tag: "Chunk"
  readonly clientId: number
  readonly requestId: RequestId
  readonly values: NonEmptyReadonlyArray<Rpc.SuccessChunk<A>>
}

/**
 * The transport representation of an RPC `Exit`, encoding success values or a
 * failure cause made of failures, defects, and interrupts.
 *
 * @category response
 * @since 4.0.0
 */
export type ExitEncoded<A, E> = {
  readonly _tag: "Success"
  readonly value: A
} | {
  readonly _tag: "Failure"
  readonly cause: ReadonlyArray<
    {
      readonly _tag: "Fail"
      readonly error: E
    } | {
      readonly _tag: "Die"
      readonly defect: unknown
    } | {
      readonly _tag: "Interrupt"
      readonly fiberId: number | undefined
    }
  >
}

/**
 * The transport-encoded terminal response for a request, carrying the encoded
 * `Exit`.
 *
 * @category response
 * @since 4.0.0
 */
export interface ResponseExitEncoded {
  readonly _tag: "Exit"
  readonly requestId: string | number
  readonly exit: ExitEncoded<unknown, unknown>
}

/**
 * A server-to-client protocol message reporting a client protocol error to all
 * affected in-flight requests.
 *
 * @category response
 * @since 4.0.0
 */
export interface ClientProtocolError {
  readonly _tag: "ClientProtocolError"
  readonly error: RpcClientError
}

/**
 * The decoded terminal response for a request, carrying the typed `Rpc.Exit`
 * for the RPC.
 *
 * @category response
 * @since 4.0.0
 */
export interface ResponseExit<A extends Rpc.Any> {
  readonly _tag: "Exit"
  readonly clientId: number
  readonly requestId: RequestId
  readonly exit: Rpc.Exit<A>
}

/**
 * The transport-encoded server defect message used for protocol-level defects
 * that affect the client connection.
 *
 * @category response
 * @since 4.0.0
 */
export interface ResponseDefectEncoded {
  readonly _tag: "Defect"
  readonly defect: unknown
}

const encodeDefect = Schema.encodeSync(Schema.Defect())

/**
 * Creates an encoded terminal response for a request whose exit is a defect
 * encoded with `Schema.Defect()`.
 *
 * @category response
 * @since 4.0.0
 */
export const ResponseExitDieEncoded = (options: {
  readonly requestId: RequestId
  readonly defect: unknown
}): ResponseExitEncoded => ({
  _tag: "Exit",
  requestId: options.requestId,
  exit: {
    _tag: "Failure",
    cause: [{
      _tag: "Die",
      defect: encodeDefect(options.defect)
    }]
  }
})

/**
 * Creates a transport-encoded defect response by encoding the input with
 * `Schema.Defect()`.
 *
 * @category response
 * @since 4.0.0
 */
export const ResponseDefectEncoded = (input: unknown): ResponseDefectEncoded => ({
  _tag: "Defect",
  defect: encodeDefect(input)
})

/**
 * The decoded server defect message for a client connection.
 *
 * @category response
 * @since 4.0.0
 */
export interface ResponseDefect {
  readonly _tag: "Defect"
  readonly clientId: number
  readonly defect: unknown
}

/**
 * A server message indicating that the client connection has ended.
 *
 * @category response
 * @since 4.0.0
 */
export interface ClientEnd {
  readonly _tag: "ClientEnd"
  readonly clientId: number
}

/**
 * A server-to-client keepalive response to a `Ping` message.
 *
 * @category response
 * @since 4.0.0
 */
export interface Pong {
  readonly _tag: "Pong"
}

/**
 * Represents the reusable `Pong` message value.
 *
 * @category response
 * @since 4.0.0
 */
export const constPong: Pong = { _tag: "Pong" }

/**
 * Checks if the response type is terminal.
 *
 * @category guards
 * @since 4.0.0
 */
export const isTerminalResponse = (response: FromServerEncoded): boolean => {
  switch (response._tag) {
    case "Exit":
    case "Defect":
    case "ClientProtocolError": {
      return true
    }
    default: {
      return false
    }
  }
}
