/**
 * RPC schema markers and interruption annotations.
 *
 * This module contains the small pieces of schema metadata that the RPC
 * declaration, client, server, cluster, and reactivity layers share. It marks
 * streamed responses and annotates interruptions that came from a remote client
 * closing or cancelling a request.
 *
 * **Mental model**
 *
 * A streaming RPC still has a normal RPC exit, but its success schema is marked
 * with {@link Stream}. The marker stores the stream element schema and the
 * stream error schema so transports can encode and decode each chunk while
 * keeping stream failures on the chunk stream.
 *
 * **Common tasks**
 *
 * - Use {@link Stream} when constructing RPC metadata directly
 * - Use {@link isStreamSchema} to branch between one-shot and streaming
 *   responses in protocol implementations
 * - Read the stored `success` and `error` schemas when encoding or decoding
 *   stream chunks
 * - Use {@link ClientAbort} to tag interruptions caused by client disconnects
 *
 * **Gotchas**
 *
 * - `Rpc.make(..., { stream: true })` installs this marker for you
 * - For streaming RPCs, the immediate RPC exit succeeds with `void`; stream
 *   elements and stream errors are encoded separately
 * - Request payload schemas live on the `Rpc` definition, not in this module
 * - `Stream` is RPC metadata, not a general-purpose codec for arbitrary
 *   `Stream` values
 *
 * @since 4.0.0
 */
import * as Cause from "../../Cause.ts"
import * as Context from "../../Context.ts"
import { constUndefined } from "../../Function.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import type * as AST from "../../SchemaAST.ts"
import * as Stream_ from "../../Stream.ts"

const StreamSchemaTypeId = "~effect/rpc/RpcSchema/StreamSchema"

/**
 * Returns `true` when a schema is an RPC stream schema created by
 * `RpcSchema.Stream`.
 *
 * @category Stream
 * @since 4.0.0
 */
export function isStreamSchema(schema: Schema.Top): schema is Stream<Schema.Top, Schema.Top> {
  return Predicate.hasProperty(schema, StreamSchemaTypeId)
}

/** @internal */
export function getStreamSchemas(schema: Schema.Top): Option.Option<{
  readonly success: Schema.Top
  readonly error: Schema.Top
}> {
  return isStreamSchema(schema) ?
    Option.some({
      success: schema.success,
      error: schema.error
    }) :
    Option.none()
}

/**
 * A schema marker for RPC streaming responses, storing the success element
 * schema and stream error schema used for encoding and decoding stream chunks.
 *
 * @category Stream
 * @since 4.0.0
 */
export interface Stream<A extends Schema.Top, E extends Schema.Top> extends
  Schema.Bottom<
    Stream_.Stream<A["Type"], E["Type"]>,
    Stream_.Stream<A["Encoded"], E["Encoded"]>,
    A["DecodingServices"] | E["DecodingServices"],
    A["EncodingServices"] | E["EncodingServices"],
    AST.Declaration,
    Stream<A, E>
  >
{
  readonly "Rebuild": Stream<A, E>
  readonly [StreamSchemaTypeId]: typeof StreamSchemaTypeId
  readonly success: A
  readonly error: E
}

const schema = Schema.declare(Stream_.isStream)

/**
 * Creates an RPC stream schema from a stream element success schema and stream
 * error schema.
 *
 * @category Stream
 * @since 4.0.0
 */
export function Stream<A extends Schema.Top, E extends Schema.Top>(success: A, error: E): Stream<A, E> {
  return Schema.make(schema.ast, { [StreamSchemaTypeId]: StreamSchemaTypeId, success, error })
}

/**
 * Annotation that marks interruptions that originate from an RPC client
 * abort.
 *
 * @category Cause annotations
 * @since 4.0.0
 */
export class ClientAbort extends Context.Service<ClientAbort, true>()("effect/rpc/RpcSchema/ClientAbort") {
  static annotation = this.context(true).pipe(
    Context.add(Cause.StackTrace, {
      name: "ClientAbort",
      stack: constUndefined,
      parent: undefined
    })
  )
}
