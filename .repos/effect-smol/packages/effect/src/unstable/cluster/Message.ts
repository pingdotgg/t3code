/**
 * Defines the message shapes moved through Effect Cluster.
 *
 * Messages carry entity requests and control envelopes between callers, durable
 * storage, transports, and runner handlers. This module includes incoming and
 * outgoing variants for encoded stored requests, decoded local requests,
 * acknowledgements, and interrupts. It also provides helpers for local delivery
 * and for encoding or decoding request payloads with matching RPC schemas.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Option from "../../Option.ts"
import * as Schema from "../../Schema.ts"
import * as Rpc from "../rpc/Rpc.ts"
import type { PersistenceError } from "./ClusterError.ts"
import { MalformedMessage } from "./ClusterError.ts"
import * as ClusterSchema from "./ClusterSchema.ts"
import type { EntityAddress } from "./EntityAddress.ts"
import * as Envelope from "./Envelope.ts"
import type * as Reply from "./Reply.ts"
import type { Snowflake } from "./Snowflake.ts"

/**
 * Message read by a runner from storage or transport.
 *
 * **Details**
 *
 * An incoming message is either a persisted request with an encoded payload or an
 * incoming control envelope.
 *
 * @category incoming
 * @since 4.0.0
 */
export type Incoming<R extends Rpc.Any> = IncomingRequest<R> | IncomingEnvelope

/**
 * Locally decoded incoming message for in-process delivery.
 *
 * **Details**
 *
 * It is either a request with a decoded payload or an incoming control envelope.
 *
 * @category incoming
 * @since 4.0.0
 */
export type IncomingLocal<R extends Rpc.Any> = IncomingRequestLocal<R> | IncomingEnvelope

/**
 * Converts an outgoing message into a locally deliverable incoming message.
 *
 * **Details**
 *
 * Request messages keep their decoded payload and response callback, while
 * control envelopes are wrapped as incoming envelopes.
 *
 * @category incoming
 * @since 4.0.0
 */
export const incomingLocalFromOutgoing = <R extends Rpc.Any>(self: Outgoing<R>): IncomingLocal<R> => {
  if (self._tag === "OutgoingEnvelope") {
    return new IncomingEnvelope({ envelope: self.envelope })
  }
  return new IncomingRequestLocal({
    annotations: Context.get(self.rpc.annotations, ClusterSchema.Dynamic)(
      self.rpc.annotations,
      self.envelope as any
    ),
    envelope: self.envelope,
    respond: self.respond,
    lastSentReply: Option.none()
  })
}

/**
 * Represents an incoming persisted request whose payload has not yet been decoded with the RPC
 * schema.
 *
 * **Details**
 *
 * It carries the last reply that was sent and a callback for persisting encoded
 * replies.
 *
 * @category incoming
 * @since 4.0.0
 */
export class IncomingRequest<R extends Rpc.Any> extends Data.TaggedClass("IncomingRequest")<{
  readonly envelope: Envelope.PartialRequest
  readonly lastSentReply: Option.Option<Reply.Encoded>
  readonly respond: (reply: Reply.ReplyWithContext<R>) => Effect.Effect<void, MalformedMessage | PersistenceError>
}> {}

/**
 * Represents an incoming request for local delivery with a decoded payload.
 *
 * **Details**
 *
 * It includes dynamic annotations, the last sent reply, and a callback for
 * replying with decoded replies.
 *
 * @category incoming
 * @since 4.0.0
 */
export class IncomingRequestLocal<R extends Rpc.Any> extends Data.TaggedClass("IncomingRequestLocal")<{
  readonly envelope: Envelope.Request<R>
  readonly lastSentReply: Option.Option<Reply.Reply<R>>
  readonly respond: (reply: Reply.Reply<R>) => Effect.Effect<void, MalformedMessage | PersistenceError>
  readonly annotations: Context.Context<never>
}> {}

/**
 * Represents an incoming control envelope carrying an `AckChunk` or `Interrupt`.
 *
 * @category incoming
 * @since 4.0.0
 */
export class IncomingEnvelope extends Data.TaggedClass("IncomingEnvelope")<{
  readonly _tag: "IncomingEnvelope"
  readonly envelope: Envelope.AckChunk | Envelope.Interrupt
}> {}

/**
 * Message produced for storage or transport.
 *
 * **Details**
 *
 * An outgoing message is either an entity request or a control envelope.
 *
 * @category outgoing
 * @since 4.0.0
 */
export type Outgoing<R extends Rpc.Any> = OutgoingRequest<R> | OutgoingEnvelope

/**
 * Represents an outgoing entity request with decoded payload and RPC metadata.
 *
 * **Details**
 *
 * It carries the service context used for serialization, the last received reply,
 * the reply callback, dynamic annotations, and an optional encoded request cache.
 *
 * @category outgoing
 * @since 4.0.0
 */
export class OutgoingRequest<R extends Rpc.Any> extends Data.TaggedClass("OutgoingRequest")<{
  readonly envelope: Envelope.Request<R>
  readonly context: Context.Context<Rpc.Services<R>>
  readonly lastReceivedReply: Option.Option<Reply.Reply<R>>
  readonly rpc: R
  readonly respond: (reply: Reply.Reply<R>) => Effect.Effect<void>
  readonly annotations: Context.Context<never>
}> {
  /**
   * Cached encoded envelope payload reused when sending the request.
   *
   * @since 4.0.0
   */
  public encodedCache?: Envelope.PartialRequest
}

/**
 * Represents an outgoing control envelope paired with RPC metadata.
 *
 * **When to use**
 *
 * Use to construct an interrupt envelope for an
 * in-flight request.
 *
 * @category outgoing
 * @since 4.0.0
 */
export class OutgoingEnvelope extends Data.TaggedClass("OutgoingEnvelope")<{
  readonly envelope: Envelope.AckChunk | Envelope.Interrupt
  readonly rpc: Rpc.AnyWithProps
}> {
  /**
   * Creates an outgoing interrupt envelope for the supplied request.
   *
   * @since 4.0.0
   */
  static interrupt(options: {
    readonly address: EntityAddress
    readonly id: Snowflake
    readonly requestId: Snowflake
  }): OutgoingEnvelope {
    return new OutgoingEnvelope({
      envelope: new Envelope.Interrupt(options),
      rpc: neverRpc
    })
  }
}

const neverRpc = Rpc.make("Never", {
  success: Schema.Never as any,
  error: Schema.Never,
  payload: {}
})

/**
 * Serializes an outgoing message into a partial envelope.
 *
 * **Details**
 *
 * Control envelopes pass through unchanged. Requests are encoded with their RPC
 * payload schema, reusing the cached encoded request when available.
 *
 * @category serialization
 * @since 4.0.0
 */
export const serialize = <Rpc extends Rpc.Any>(
  message: Outgoing<Rpc>
): Effect.Effect<Envelope.Partial, MalformedMessage> => {
  if (message._tag !== "OutgoingRequest") {
    return Effect.succeed(message.envelope)
  }
  return Effect.suspend(() =>
    message.encodedCache
      ? Effect.succeed(message.encodedCache)
      : serializeRequest(message)
  )
}

/**
 * Serializes an outgoing message into its JSON envelope representation.
 *
 * **Details**
 *
 * Schema encoding failures are converted to `MalformedMessage`.
 *
 * @category serialization
 * @since 4.0.0
 */
export const serializeEnvelope = <Rpc extends Rpc.Any>(
  message: Outgoing<Rpc>
): Effect.Effect<Envelope.Encoded, MalformedMessage, never> =>
  Effect.flatMap(
    serialize(message),
    (envelope) => MalformedMessage.refail(Schema.encodeEffect(Envelope.PartialJson)(envelope))
  )

/**
 * Encodes the payload of an `OutgoingRequest` with the request's RPC payload
 * schema and service context.
 *
 * **Details**
 *
 * The result is a `PartialRequest` suitable for storage or transport.
 *
 * @category serialization
 * @since 4.0.0
 */
export const serializeRequest = <Rpc extends Rpc.Any>(
  self: OutgoingRequest<Rpc>
): Effect.Effect<Envelope.PartialRequest, MalformedMessage> => {
  const rpc = self.rpc as any as Rpc.AnyWithProps
  return Schema.encodeEffect(Schema.toCodecJson(rpc.payloadSchema))(self.envelope.payload).pipe(
    Effect.provideContext(self.context),
    MalformedMessage.refail,
    Effect.map((payload) => ({
      ...self.envelope,
      payload
    }))
  ) as any as Effect.Effect<Envelope.PartialRequest, MalformedMessage>
}

/**
 * Decodes a partial envelope back into a locally deliverable incoming message.
 *
 * **Details**
 *
 * Control envelopes pass through directly. Request envelopes require the original
 * `OutgoingRequest` so the payload can be decoded with the correct RPC schema and
 * context.
 *
 * @category serialization
 * @since 4.0.0
 */
export const deserializeLocal = <Rpc extends Rpc.Any>(
  self: Outgoing<Rpc>,
  encoded: Envelope.Partial
): Effect.Effect<
  IncomingLocal<Rpc>,
  MalformedMessage
> => {
  if (encoded._tag !== "Request") {
    return Effect.succeed(new IncomingEnvelope({ envelope: encoded }))
  } else if (self._tag !== "OutgoingRequest") {
    return Effect.fail(
      new MalformedMessage({ cause: new Error("Can only deserialize a Request with an OutgoingRequest message") })
    )
  }
  const rpc = self.rpc as any as Rpc.AnyWithProps
  return Schema.decodeEffect(Schema.toCodecJson(rpc.payloadSchema))(encoded.payload).pipe(
    Effect.provideContext(self.context),
    MalformedMessage.refail,
    Effect.map((payload) => {
      const envelope = Envelope.makeRequest({
        ...encoded,
        payload
      } as any) as Envelope.Request<Rpc>
      return new IncomingRequestLocal({
        envelope,
        lastSentReply: Option.none(),
        respond: self.respond,
        annotations: Context.get(rpc.annotations, ClusterSchema.Dynamic)(
          rpc.annotations,
          envelope as any
        )
      })
    })
  ) as Effect.Effect<IncomingRequestLocal<Rpc>, MalformedMessage>
}
