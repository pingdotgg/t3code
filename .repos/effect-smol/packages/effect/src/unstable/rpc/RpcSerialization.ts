/**
 * Serializes RPC protocol messages for transports.
 *
 * `RpcSerialization` is the boundary between `RpcMessage` envelopes and the
 * bytes or strings carried by a transport. This module provides built-in
 * serializers for JSON, newline-delimited JSON, JSON-RPC 2.0, and MessagePack,
 * including framed formats that can decode multiple messages from streaming
 * chunks.
 *
 * @since 4.0.0
 */
import * as Msgpackr from "msgpackr"
import * as Context from "../../Context.ts"
import * as Layer from "../../Layer.ts"
import * as Predicate from "../../Predicate.ts"
import { hasProperty } from "../../Predicate.ts"
import type * as RpcMessage from "./RpcMessage.ts"

/**
 * Service that describes how RPC protocol messages are encoded and decoded,
 * including the content type and whether the serialization format provides
 * message framing.
 *
 * **When to use**
 *
 * Use to provide the serialization boundary shared by RPC clients and servers
 * for a chosen wire format.
 *
 * @category serialization
 * @since 4.0.0
 */
export class RpcSerialization extends Context.Service<RpcSerialization, {
  makeUnsafe(): Parser
  readonly contentType: string
  readonly includesFraming: boolean
}>()("effect/rpc/RpcSerialization") {}

/**
 * A stateful parser for an RPC serialization format, able to decode input
 * chunks into protocol messages and encode messages for transport.
 *
 * @category serialization
 * @since 4.0.0
 */
export interface Parser {
  readonly decode: (data: Uint8Array | string) => ReadonlyArray<unknown>
  readonly encode: (response: unknown) => Uint8Array | string | undefined
}

/**
 * JSON RPC serialization for whole message payloads. It does not include
 * message framing, so it is intended for transports that frame responses
 * themselves.
 *
 * @category serialization
 * @since 4.0.0
 */
export const json: RpcSerialization["Service"] = RpcSerialization.of({
  contentType: "application/json",
  includesFraming: false,
  makeUnsafe: () => {
    const decoder = new TextDecoder()
    return {
      decode: (bytes) => {
        const decoded = JSON.parse(typeof bytes === "string" ? bytes : decoder.decode(bytes))
        return Array.isArray(decoded) ? decoded : [decoded]
      },
      encode: (response) => JSON.stringify(response)
    }
  }
})

/**
 * Serializes RPC protocol messages as newline-delimited JSON, framing each message
 * with a trailing newline.
 *
 * @category serialization
 * @since 4.0.0
 */
export const ndjson: RpcSerialization["Service"] = RpcSerialization.of({
  contentType: "application/ndjson",
  includesFraming: true,
  makeUnsafe: () => {
    const decoder = new TextDecoder()
    let buffer = ""
    return ({
      decode: (bytes) => {
        buffer += typeof bytes === "string" ? bytes : decoder.decode(bytes)
        let position = 0
        let nlIndex = buffer.indexOf("\n", position)
        const items: Array<unknown> = []
        while (nlIndex !== -1) {
          const item = JSON.parse(buffer.slice(position, nlIndex))
          items.push(item)
          position = nlIndex + 1
          nlIndex = buffer.indexOf("\n", position)
        }
        buffer = buffer.slice(position)
        return items
      },
      encode: (response) => {
        if (Array.isArray(response)) {
          if (response.length === 0) return undefined
          let data = ""
          for (let i = 0; i < response.length; i++) {
            data += JSON.stringify(response[i]) + "\n"
          }
          return data
        }
        return JSON.stringify(response) + "\n"
      }
    })
  }
})

/**
 * Creates a JSON-RPC 2.0 serialization for RPC protocol messages without
 * additional message framing.
 *
 * @category serialization
 * @since 4.0.0
 */
export const jsonRpc = (options?: {
  readonly contentType?: string | undefined
}): RpcSerialization["Service"] =>
  RpcSerialization.of({
    contentType: options?.contentType ?? "application/json",
    includesFraming: false,
    makeUnsafe: () => {
      const decoder = new TextDecoder()
      const batches = new Map<string | number, {
        readonly size: number
        readonly responses: Map<string | number, RpcMessage.FromServerEncoded>
      }>()
      return {
        decode: (bytes) => {
          const decoded: JsonRpcMessage | Array<JsonRpcMessage> = JSON.parse(
            typeof bytes === "string" ? bytes : decoder.decode(bytes)
          )
          return decodeJsonRpcRaw(decoded, batches)
        },
        encode: (response) => {
          const encoded = encodeJsonRpcResponse(response as any, batches)
          return encoded && JSON.stringify(encoded)
        }
      }
    }
  })

/**
 * Creates a newline-delimited JSON-RPC 2.0 serialization for RPC protocol
 * messages.
 *
 * @category serialization
 * @since 4.0.0
 */
export const ndJsonRpc = (options?: {
  readonly contentType?: string | undefined
}): RpcSerialization["Service"] =>
  RpcSerialization.of({
    contentType: options?.contentType ?? "application/json-rpc",
    includesFraming: true,
    makeUnsafe: () => {
      const parser = ndjson.makeUnsafe()
      const batches = new Map<string, {
        readonly size: number
        readonly responses: Map<string, RpcMessage.FromServerEncoded>
      }>()
      return ({
        decode: (bytes) => {
          const frames = parser.decode(bytes)
          if (frames.length === 0) return []
          const messages: Array<RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded> = []
          for (let i = 0; i < frames.length; i++) {
            const frame = frames[i]
            messages.push(...decodeJsonRpcRaw(frame as any, batches) as any)
          }
          return messages
        },
        encode: (response) => {
          const encoded = encodeJsonRpcResponse(response as any, batches)
          return encoded && parser.encode(encoded)
        }
      })
    }
  })

function decodeJsonRpcRaw(
  decoded: JsonRpcMessage | Array<JsonRpcMessage>,
  batches: Map<string | number, {
    readonly size: number
    readonly responses: Map<string | number, RpcMessage.FromServerEncoded>
  }>
) {
  if (Array.isArray(decoded)) {
    const batch = {
      size: 0,
      responses: new Map<string, RpcMessage.FromServerEncoded>()
    }
    const messages: Array<RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded> = []
    for (let i = 0; i < decoded.length; i++) {
      const message = decodeJsonRpcMessage(decoded[i])
      messages.push(message)
      if (message._tag === "Request") {
        batch.size++
        batches.set(message.id, batch)
      }
    }
    return messages
  }
  return [decodeJsonRpcMessage(decoded)]
}

function decodeJsonRpcMessage(decoded: JsonRpcMessage): RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded {
  if ("method" in decoded) {
    if (Predicate.isNullish(decoded.id) && decoded.method.startsWith("@effect/rpc/")) {
      const tag = decoded.method.slice("@effect/rpc/".length) as
        | RpcMessage.FromServerEncoded["_tag"]
        | Exclude<RpcMessage.FromClientEncoded["_tag"], "Request">
      const requestId = (decoded as any).params?.requestId
      return requestId ?
        {
          _tag: tag,
          requestId
        } as any :
        { _tag: tag } as any
    }
    return {
      _tag: "Request",
      id: decoded.id ?? "",
      tag: decoded.method,
      payload: decoded.params ?? null,
      headers: decoded.headers ?? [],
      ...(decoded.spanId ?
        {
          traceId: decoded.traceId,
          spanId: decoded.spanId!,
          sampled: decoded.sampled!
        } :
        {})
    }
  } else if (decoded.error && decoded.error._tag === "Defect") {
    return {
      _tag: "Defect",
      defect: decoded.error.data
    }
  } else if (decoded.chunk === true) {
    return {
      _tag: "Chunk",
      requestId: decoded.id ?? "",
      values: decoded.result as any
    }
  }
  return {
    _tag: "Exit",
    requestId: decoded.id ?? "",
    exit: decoded.error != null ?
      {
        _tag: "Failure",
        cause: decoded.error._tag === "Cause" ?
          decoded.error.data as any :
          [{
            _tag: "Die",
            defect: decoded.error
          }]
      } :
      {
        _tag: "Success",
        value: decoded.result
      }
  }
}

function encodeJsonRpcRaw(
  response: RpcMessage.FromServerEncoded | RpcMessage.FromClientEncoded,
  batches: Map<string | number, {
    readonly size: number
    readonly responses: Map<string | number, RpcMessage.FromServerEncoded>
  }>
) {
  if (!("requestId" in response)) {
    return encodeJsonRpcMessage(response)
  }
  const batch = batches.get(response.requestId)
  if (batch) {
    batches.delete(response.requestId)
    batch.responses.set(response.requestId, response as any)
    if (batch.size === batch.responses.size) {
      return Array.from(batch.responses.values(), encodeJsonRpcMessage)
    }
    return undefined
  }
  return encodeJsonRpcMessage(response)
}

function encodeJsonRpcResponse(
  response:
    | RpcMessage.FromServerEncoded
    | RpcMessage.FromClientEncoded
    | Array<RpcMessage.FromServerEncoded | RpcMessage.FromClientEncoded>,
  batches: Map<string | number, {
    readonly size: number
    readonly responses: Map<string | number, RpcMessage.FromServerEncoded>
  }>
) {
  if (Array.isArray(response) === false) {
    return encodeJsonRpcRaw(response, batches)
  }
  if (response.length === 0) {
    return undefined
  }
  const encoded: Array<JsonRpcMessage | Array<JsonRpcMessage>> = []
  for (let i = 0; i < response.length; i++) {
    const current = encodeJsonRpcRaw(response[i], batches)
    if (current !== undefined) {
      encoded.push(current)
    }
  }
  if (encoded.length === 0) {
    return undefined
  }
  if (encoded.length === 1) {
    return encoded[0]
  }
  const messages: Array<JsonRpcMessage> = []
  for (let i = 0; i < encoded.length; i++) {
    const current = encoded[i]
    if (Array.isArray(current)) {
      messages.push(...current)
    } else {
      messages.push(current)
    }
  }
  return messages
}

function encodeJsonRpcMessage(response: RpcMessage.FromServerEncoded | RpcMessage.FromClientEncoded): JsonRpcMessage {
  switch (response._tag) {
    case "Request":
      return {
        jsonrpc: "2.0",
        method: response.tag,
        params: response.payload,
        id: response.id,
        headers: response.headers,
        traceId: response.traceId,
        spanId: response.spanId,
        sampled: response.sampled
      }
    case "Ping":
    case "Pong":
    case "Interrupt":
    case "Ack":
    case "Eof":
      return {
        jsonrpc: "2.0",
        method: `@effect/rpc/${response._tag}`,
        params: "requestId" in response ? { requestId: response.requestId } : undefined
      }
    case "Chunk":
      return {
        jsonrpc: "2.0",
        chunk: true,
        id: response.requestId,
        result: response.values
      }
    case "Exit": {
      if (response.exit._tag === "Success") {
        return {
          jsonrpc: "2.0",
          id: response.requestId ?? undefined,
          result: response.exit.value
        } as any
      }
      const error = response.exit.cause.find((failure) => failure._tag === "Fail")
      return {
        jsonrpc: "2.0",
        id: response.requestId ?? undefined,
        error: response.exit._tag === "Failure" ?
          {
            _tag: "Cause",
            code: error && Predicate.hasProperty(error, "code") ? Number(error.code) : 0,
            message: error && hasProperty(error, "message")
              ? error.message
              : JSON.stringify(response.exit.cause),
            data: response.exit.cause
          } :
          undefined
      } as any
    }
    case "Defect":
      return {
        jsonrpc: "2.0",
        id: jsonRpcInternalError,
        error: {
          _tag: "Defect",
          code: 1,
          message: "A defect occurred",
          data: response.defect
        }
      }
    case "ClientProtocolError":
      return {} as never
  }
}

const jsonRpcInternalError = -32603

interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id?: number | string | null
  readonly method: string
  readonly params?: unknown
  readonly headers?: ReadonlyArray<[string, string]>
  readonly traceId?: string
  readonly spanId?: string
  readonly sampled?: boolean
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0"
  readonly id?: number | string | null
  readonly result?: unknown
  readonly chunk?: boolean
  readonly error?: {
    readonly code: number
    readonly message: string
    readonly data?: unknown
    readonly _tag?: "Cause" | "Defect"
  }
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse

/**
 * Create a MessagePack serialization with custom msgpackr options.
 *
 * @category serialization
 * @since 4.0.0
 */
export const makeMsgPack = (options?: Msgpackr.Options | undefined): RpcSerialization["Service"] =>
  RpcSerialization.of({
    contentType: "application/msgpack",
    includesFraming: true,
    makeUnsafe: () => {
      const unpackr = new Msgpackr.Unpackr(options)
      const packr = new Msgpackr.Packr(options)
      const encoder = new TextEncoder()
      let incomplete: Uint8Array | undefined = undefined
      return {
        decode(bytes) {
          let buf = typeof bytes === "string" ? encoder.encode(bytes) : bytes
          if (incomplete !== undefined) {
            const prev = buf
            bytes = new Uint8Array(incomplete.length + buf.length)
            bytes.set(incomplete)
            bytes.set(prev, incomplete.length)
            buf = bytes
            incomplete = undefined
          }
          try {
            return unpackr.unpackMultiple(buf)
          } catch (error_) {
            const error = error_ as any
            if (error.incomplete) {
              incomplete = buf.subarray(error.lastPosition)
              return error.values ?? []
            }
            throw error_
          }
        },
        encode: (response) => packr.pack(response)
      }
    }
  })

/**
 * Default MessagePack RPC serialization using record support and built-in
 * message framing.
 *
 * @category serialization
 * @since 4.0.0
 */
export const msgPack: RpcSerialization["Service"] = makeMsgPack({ useRecords: true })

/**
 * RPC serialization layer that uses JSON for serialization.
 *
 * **When to use**
 *
 * Use when you have a transport protocol that already provides message framing.
 *
 * @see {@link layerNdjson} for transports that need newline-delimited framing
 *
 * @category serialization
 * @since 4.0.0
 */
export const layerJson: Layer.Layer<RpcSerialization> = Layer.succeed(RpcSerialization)(json)

/**
 * RPC serialization layer that uses NDJSON for serialization.
 *
 * **When to use**
 *
 * Use when you have a transport protocol that does not provide message framing.
 *
 * @see {@link layerJson} for transports that already provide message framing
 *
 * @category serialization
 * @since 4.0.0
 */
export const layerNdjson: Layer.Layer<RpcSerialization> = Layer.succeed(RpcSerialization)(ndjson)

/**
 * RPC serialization layer that uses JSON-RPC for serialization.
 *
 * @category serialization
 * @since 4.0.0
 */
export const layerJsonRpc = (options?: {
  readonly contentType?: string | undefined
}): Layer.Layer<RpcSerialization> => Layer.succeed(RpcSerialization)(jsonRpc(options))

/**
 * RPC serialization layer that uses newline-delimited JSON-RPC for
 * serialization.
 *
 * @category serialization
 * @since 4.0.0
 */
export const layerNdJsonRpc = (options?: {
  readonly contentType?: string | undefined
}): Layer.Layer<RpcSerialization> => Layer.succeed(RpcSerialization)(ndJsonRpc(options))

/**
 * RPC serialization layer that uses MessagePack for serialization.
 *
 * **Details**
 *
 * MessagePack has a more compact binary format compared to JSON and NDJSON. It
 * also has better support for binary data.
 *
 * @category serialization
 * @since 4.0.0
 */
export const layerMsgPack: Layer.Layer<RpcSerialization> = Layer.succeed(RpcSerialization)(msgPack)
