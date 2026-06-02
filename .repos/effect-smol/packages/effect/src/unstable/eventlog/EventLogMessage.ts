/**
 * Defines the remote event-log protocol messages and RPC group.
 *
 * This module is the shared boundary between `EventLogRemote` clients and
 * event-log servers. It provides branded store ids, structured protocol errors,
 * the hello/authenticate session handshake, authenticated write and changes
 * RPCs, and msgpack payloads for encrypted or plaintext journal entries.
 *
 * **Mental model**
 *
 * A remote session starts with `HelloRpc`, then proves control of the client's
 * signing key with `AuthenticateRpc`. After authentication, writes flow from the
 * client to the server as encoded entry batches, and `ChangesRpc` streams
 * encoded remote entries back to replicas from a requested sequence number. The
 * `EventLogAuthentication` middleware marks the RPCs that require an
 * authenticated event-log identity.
 *
 * **Gotchas**
 *
 * Entry batches are binary payloads. Small payloads travel as `SingleMessage`,
 * while larger payloads are split into `ChunkedMessage` parts and reassembled by
 * message id after every part arrives. Transports must preserve `Uint8Array`
 * bytes exactly; do not treat msgpack payloads as text or JSON.
 *
 * @since 4.0.0
 */
import type { NonEmptyArray, NonEmptyReadonlyArray } from "../../Array.ts"
import type { Brand } from "../../Brand.ts"
import * as Schema from "../../Schema.ts"
import * as Msgpack from "../encoding/Msgpack.ts"
import * as Rpc from "../rpc/Rpc.ts"
import * as RpcGroup from "../rpc/RpcGroup.ts"
import * as RpcMiddleware from "../rpc/RpcMiddleware.ts"
import * as Transferable from "../workers/Transferable.ts"
import { Entry, RemoteEntry, RemoteId } from "./EventJournal.ts"
import type { Identity } from "./EventLog.ts"
import { EncryptedEntry, EncryptedRemoteEntry } from "./EventLogEncryption.ts"

/**
 * Type-level identifier used to brand event-log store ids.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type StoreIdTypeId = "effect/eventlog/EventLog/StoreId"

/**
 * Runtime brand identifier for event-log store ids.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const StoreIdTypeId: StoreIdTypeId = "effect/eventlog/EventLog/StoreId"

/**
 * Branded string identifying a logical event-log store.
 *
 * @category StoreId
 * @since 4.0.0
 */
export type StoreId = string & Brand<StoreIdTypeId>

/**
 * Schema for branded event-log store ids.
 *
 * @category StoreId
 * @since 4.0.0
 */
export const StoreId = Schema.String.pipe(Schema.brand(StoreIdTypeId))

/**
 * Error returned by event-log remote RPCs.
 *
 * **Details**
 *
 * It records the request tag, optional identity and store information, a protocol
 * error code, and a human-readable message.
 *
 * @category protocols
 * @since 4.0.0
 */
export class EventLogProtocolError extends Schema.TaggedErrorClass<EventLogProtocolError>(
  "effect/eventlog/EventLogRemote/ProtocolError"
)("EventLogProtocolError", {
  requestTag: Schema.String,
  publicKey: Schema.optional(Schema.String),
  storeId: Schema.optional(StoreId),
  code: Schema.Literals(["Unauthorized", "Forbidden", "NotFound", "InvalidRequest", "InternalServerError"]),
  message: Schema.String
}) {}

/**
 * RPC middleware that authenticates event-log requests and provides the client
 * `Identity` to authenticated handlers.
 *
 * @category middleware
 * @since 4.0.0
 */
export class EventLogAuthentication extends RpcMiddleware.Service<EventLogAuthentication, {
  provides: Identity
}>()("effect/eventlog/EventLogMessage/EventLogAuthentication", {
  error: EventLogProtocolError
}) {}

/**
 * Response sent by the remote server during the authentication handshake.
 *
 * **Details**
 *
 * It contains the server remote id and a challenge that must be signed by the
 * client.
 *
 * @category protocols
 * @since 4.0.0
 */
export class HelloResponse extends Schema.Class<HelloResponse>("effect/eventlog/EventLogRemote/HelloResponse")({
  remoteId: RemoteId,
  challenge: Transferable.Uint8Array
}) {}

/**
 * RPC used to start an event-log remote session and receive a `HelloResponse`.
 *
 * @category protocols
 * @since 4.0.0
 */
export class HelloRpc extends Rpc.make("EventLog.Hello", {
  success: HelloResponse
}) {}

/**
 * Schema for an authentication request containing the client public key,
 * Ed25519 signing public key, signature over the session challenge payload, and
 * algorithm name.
 *
 * @category protocols
 * @since 4.0.0
 */
export class Authenticate extends Schema.Class<Authenticate>("effect/eventlog/EventLogRemote/Authenticate")({
  publicKey: Schema.String,
  signingPublicKey: Transferable.Uint8Array,
  signature: Transferable.Uint8Array,
  algorithm: Schema.Literal("Ed25519")
}) {}

/**
 * RPC used to authenticate a remote event-log session after `HelloRpc`.
 *
 * @category protocols
 * @since 4.0.0
 */
export class AuthenticateRpc extends Rpc.make("EventLog.Authenticate", {
  payload: Authenticate,
  error: EventLogProtocolError
}) {}

/**
 * Represents an entire encoded event-log payload in one transport frame.
 *
 * @category protocols
 * @since 4.0.0
 */
export class SingleMessage
  extends Schema.TaggedClass<SingleMessage>("effect/eventlog/EventLogRemote/SingleMessage")("Single", {
    data: Transferable.Uint8Array
  })
{}

/**
 * Represents one part of a large encoded event-log payload.
 *
 * **When to use**
 *
 * Use to divide data into chunks and `join` to reassemble all chunks with
 * the same id once every part has arrived.
 *
 * @category protocols
 * @since 4.0.0
 */
export class ChunkedMessage
  extends Schema.TaggedClass<ChunkedMessage>("effect/eventlog/EventLogRemote/ChunkedMessage")("Chunked", {
    id: Schema.Number,
    part: Schema.Tuple([Schema.Number, Schema.Number]),
    data: Transferable.Uint8Array
  })
{
  static chunkSize = 512_000

  static initialJoinState() {
    return new Map<number, {
      readonly parts: Array<Uint8Array>
      count: number
      bytes: number
    }>()
  }

  /**
   * Splits binary event-log message data into numbered chunks.
   *
   * @since 4.0.0
   */
  static split(id: number, data: Uint8Array): NonEmptyReadonlyArray<ChunkedMessage> {
    const parts = Math.ceil(data.byteLength / ChunkedMessage.chunkSize)
    const result: NonEmptyArray<ChunkedMessage> = new Array(parts) as any
    for (let i = 0; i < parts; i++) {
      const start = i * ChunkedMessage.chunkSize
      const end = Math.min((i + 1) * ChunkedMessage.chunkSize, data.byteLength)
      result[i] = new ChunkedMessage({
        id,
        part: [i, parts],
        data: data.subarray(start, end) as any
      })
    }
    return result
  }

  /**
   * Reassembles all chunks for a message id into the original binary payload.
   *
   * @since 4.0.0
   */
  static join(
    map: Map<number, {
      readonly parts: Array<Uint8Array>
      count: number
      bytes: number
    }>,
    part: ChunkedMessage
  ): Uint8Array<ArrayBuffer> | undefined {
    const [index, total] = part.part
    let entry = map.get(part.id)
    if (!entry) {
      entry = {
        parts: new Array(total),
        count: 0,
        bytes: 0
      }
      map.set(part.id, entry)
    }
    entry.parts[index] = part.data
    entry.count++
    entry.bytes += part.data.byteLength
    if (entry.count !== total) {
      return
    }
    const data = new Uint8Array(entry.bytes)
    let offset = 0
    for (const part of entry.parts) {
      data.set(part, offset)
      offset += part.byteLength
    }
    map.delete(part.id)
    return data
  }
}

/**
 * RPC used to send one chunk of a large encoded write payload.
 *
 * @category protocols
 * @since 4.0.0
 */
export class WriteChunkedRpc extends Rpc.make("EventLog.WriteChunked", {
  payload: ChunkedMessage,
  error: EventLogProtocolError
}).middleware(EventLogAuthentication) {}

/**
 * Schema for encrypted event-log write payloads sent to a remote store.
 *
 * **Details**
 *
 * It includes the client public key, target store id, AES-GCM initialization
 * vector, and encrypted entries.
 *
 * @category protocols
 * @since 4.0.0
 */
export class WriteEntries extends Schema.Class<WriteEntries>("effect/eventlog/EventLogRemote/WriteEntries")({
  publicKey: Schema.String,
  storeId: StoreId,
  iv: Transferable.Uint8Array,
  encryptedEntries: Schema.Array(EncryptedEntry)
}) {
  static FromMsgpack = Msgpack.schema(WriteEntries)
  static encode = Schema.encodeEffect(this.FromMsgpack)
  static decode = Schema.decodeEffect(this.FromMsgpack)
  get encoded() {
    return WriteEntries.encode(this)
  }
}

/**
 * Schema for plaintext event-log write payloads sent to a remote store.
 *
 * @category protocols
 * @since 4.0.0
 */
export class WriteEntriesUnencrypted
  extends Schema.Class<WriteEntriesUnencrypted>("effect/eventlog/EventLogRemote/WriteEntriesUnencrypted")({
    publicKey: Schema.String,
    storeId: StoreId,
    entries: Schema.Array(Entry)
  })
{
  static FromMsgpack = Msgpack.schema(WriteEntriesUnencrypted)
  static encode = Schema.encodeEffect(this.FromMsgpack)
  static decode = Schema.decodeEffect(this.FromMsgpack)
  get encoded() {
    return WriteEntriesUnencrypted.encode(this)
  }
}

/**
 * RPC used to send an encoded write payload that fits in one message.
 *
 * @category protocols
 * @since 4.0.0
 */
export class WriteSingleRpc extends Rpc.make("EventLog.WriteSingle", {
  payload: {
    data: Transferable.Uint8Array
  },
  error: EventLogProtocolError
}).middleware(EventLogAuthentication) {}

/**
 * RPC used to stream remote event-log changes for a public key and store id
 * starting at a sequence number.
 *
 * **Details**
 *
 * Responses are encoded as either `SingleMessage` values or `ChunkedMessage`
 * parts.
 *
 * @category protocols
 * @since 4.0.0
 */
export class ChangesRpc extends Rpc.make("EventLog.Changes", {
  payload: {
    publicKey: Schema.String,
    storeId: StoreId,
    startSequence: Schema.Number
  },
  success: Schema.Union([SingleMessage, ChunkedMessage]),
  error: EventLogProtocolError,
  stream: true
}).middleware(EventLogAuthentication) {
  static EncryptedFromMsgpack = Msgpack.schema(Schema.NonEmptyArray(EncryptedRemoteEntry))
  static UnencryptedFromMsgpack = Msgpack.schema(Schema.NonEmptyArray(RemoteEntry))
  static encodeEncrypted = Schema.encodeEffect(ChangesRpc.EncryptedFromMsgpack)
  static decodeEncrypted = Schema.decodeEffect(ChangesRpc.EncryptedFromMsgpack)
  static encodeUnencrypted = Schema.encodeEffect(ChangesRpc.UnencryptedFromMsgpack)
  static decodeUnencrypted = Schema.decodeEffect(ChangesRpc.UnencryptedFromMsgpack)
}

/**
 * RPC group containing the event-log remote handshake, authentication, write, and
 * changes endpoints.
 *
 * @category protocols
 * @since 4.0.0
 */
export class EventLogRemoteRpcs extends RpcGroup.make(
  HelloRpc,
  AuthenticateRpc,
  WriteChunkedRpc,
  WriteSingleRpc,
  ChangesRpc
) {}
