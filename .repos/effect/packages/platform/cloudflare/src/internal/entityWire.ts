/** @internal */
import * as EntityAddress from "effect/cluster/EntityAddress"
import * as EntityId from "effect/cluster/EntityId"
import * as EntityType from "effect/cluster/EntityType"
import * as Envelope from "effect/cluster/Envelope"
import * as Reply from "effect/cluster/Reply"
import * as ShardId from "effect/cluster/ShardId"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Headers from "effect/http/Headers"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcSchema from "effect/rpc/RpcSchema"
import * as Schema from "effect/Schema"
import type { EntityInvokeResult } from "../CloudflareDurableObjectPrograms.ts"
import type { EntityRegistration } from "./entityRegistry.ts"

type EncodedRequest = Extract<Envelope.Encoded, { readonly _tag: "Request" }>

/**
 * The result of a `ClusterEntity.invoke` RPC. Constructed in the Durable
 * Object as this schema's `Type` (its JSON encoding is the identity) and
 * decoded once on the Worker side.
 *
 * @internal
 */
export const InvokeResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Success"),
    requestId: Schema.String,
    replies: Schema.Array(Schema.String)
  }),
  Schema.Struct({ _tag: Schema.Literal("MailboxFull") }),
  Schema.Struct({ _tag: Schema.Literal("EncodedMessageTooLarge") }),
  Schema.Struct({ _tag: Schema.Literal("AskDeduplicatedToTell") })
]) satisfies Schema.Codec<EntityInvokeResult>

/** @internal */
export const decodeInvokeResult = (value: unknown): Effect.Effect<EntityInvokeResult> =>
  Effect.orDie(Schema.decodeUnknownEffect(InvokeResult)(value))

const EnvelopePeek = Schema.Struct({ tag: Schema.optional(Schema.String) })

/**
 * Reads the RPC tag out of a stored envelope without decoding the payload,
 * for rows whose full decode already failed.
 *
 * @internal
 */
export const peekEnvelopeTag = (envelopeText: string): Effect.Effect<string | undefined> =>
  Schema.decodeUnknownEffect(EnvelopePeek)(JSON.parse(envelopeText)).pipe(
    Effect.match({ onFailure: () => undefined, onSuccess: ({ tag }) => tag })
  )

/** @internal */
export const runWith = <A>(
  effect: Effect.Effect<A, any, any>,
  context: Context.Context<never>
): Effect.Effect<A> => effect.pipe(Effect.provideContext(context as any), Effect.orDie) as Effect.Effect<A>

// Cached per rpc so the derived AST stays stable and the memoized parser
// compiler can hit on repeated chunks.
const chunkValuesCache = new WeakMap<Rpc.AnyWithProps, Schema.Top | undefined>()

const chunkValuesCodec = (rpc: Rpc.AnyWithProps): Schema.Top | undefined => {
  if (chunkValuesCache.has(rpc)) return chunkValuesCache.get(rpc)
  const codec = RpcSchema.isStreamSchema(rpc.successSchema)
    ? Schema.toCodecJson(Schema.NonEmptyArray(rpc.successSchema.success))
    : undefined
  chunkValuesCache.set(rpc, codec)
  return codec
}

/** @internal */
export const encodeRequest = (options: {
  readonly requestId: string
  readonly address: EntityAddress.EntityAddress
  readonly tag: string
  readonly payload: unknown
  readonly headers: unknown
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly sampled?: boolean | undefined
}): string =>
  JSON.stringify({
    _tag: "Request",
    requestId: options.requestId,
    address: {
      shardId: options.address.shardId,
      entityType: options.address.entityType,
      entityId: options.address.entityId
    },
    tag: options.tag,
    payload: options.payload,
    headers: options.headers,
    ...(options.traceId === undefined ? undefined : {
      traceId: options.traceId,
      spanId: options.spanId,
      sampled: options.sampled
    })
  })

/** @internal */
export const decodeRequest = (
  registration: EntityRegistration,
  envelopeText: string
): Effect.Effect<Envelope.Request.Any> =>
  runWith(
    Effect.gen(function*() {
      const encoded = JSON.parse(envelopeText) as EncodedRequest
      if (encoded._tag !== "Request" || typeof encoded.requestId !== "string") {
        return yield* Effect.die("Expected an encoded Request envelope")
      }
      const rpc = registration.entity.protocol.requests.get(encoded.tag) as Rpc.AnyWithProps | undefined
      if (rpc === undefined) return yield* Effect.die(`Unknown entity RPC tag: ${encoded.tag}`)
      const payload = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(rpc.payloadSchema))(encoded.payload)
      return Envelope.makeRequest({
        requestId: encoded.requestId as any,
        address: EntityAddress.make({
          shardId: ShardId.make(encoded.address.shardId.group, encoded.address.shardId.id),
          entityType: EntityType.make(encoded.address.entityType),
          entityId: EntityId.make(encoded.address.entityId)
        }),
        tag: encoded.tag,
        payload,
        headers: Headers.fromInput(encoded.headers),
        ...(encoded.traceId === undefined ? undefined : {
          traceId: encoded.traceId,
          spanId: encoded.spanId!,
          sampled: encoded.sampled!
        })
      }) as Envelope.Request.Any
    }),
    registration.context
  )

/** @internal */
export const encodeReplyFor = (
  registration: EntityRegistration,
  rpc: Rpc.AnyWithProps,
  reply: Reply.Reply<any>
): Effect.Effect<string> => {
  if (reply._tag === "WithExit") {
    return runWith(
      Effect.map(
        Schema.encodeUnknownEffect(Schema.toCodecJson(Rpc.exitSchema(rpc)))(reply.exit),
        (exit) => JSON.stringify({ _tag: "WithExit", requestId: String(reply.requestId), id: String(reply.id), exit })
      ),
      registration.context
    )
  }
  const codec = chunkValuesCodec(rpc)
  if (codec === undefined) {
    return Effect.die(`Expected a stream RPC: ${rpc._tag}`)
  }
  return runWith(
    Effect.map(
      Schema.encodeUnknownEffect(codec)(reply.values),
      (values) =>
        JSON.stringify({
          _tag: "Chunk" as const,
          requestId: String(reply.requestId),
          id: String(reply.id),
          sequence: reply.sequence,
          values
        })
    ),
    registration.context
  )
}

/** @internal */
export const decodeReplyFor = (
  rpc: Rpc.AnyWithProps,
  context: Context.Context<never>,
  replyText: string
): Effect.Effect<Reply.Reply<any>> => {
  const encoded = JSON.parse(replyText) as Reply.Encoded
  if (encoded._tag === "WithExit") {
    return runWith(
      Effect.map(
        Schema.decodeUnknownEffect(Schema.toCodecJson(Rpc.exitSchema(rpc)))(encoded.exit),
        (exit) => new Reply.WithExit({ requestId: encoded.requestId as any, id: encoded.id as any, exit: exit as any })
      ),
      context
    )
  }
  const codec = chunkValuesCodec(rpc)
  if (codec === undefined) {
    return Effect.die(`Expected a stream RPC: ${rpc._tag}`)
  }
  return runWith(
    Effect.map(
      Schema.decodeUnknownEffect(codec)(encoded.values),
      (values) =>
        new Reply.Chunk({
          requestId: encoded.requestId as any,
          id: encoded.id as any,
          sequence: encoded.sequence,
          values: values as any
        })
    ),
    context
  )
}
