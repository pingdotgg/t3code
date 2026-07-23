/**
 * Encode and decode MessagePack frames in Effect channels.
 *
 * MessagePack is a compact binary serialization format for protocols and
 * storage layers that expect bytes rather than JSON text, such as RPC
 * transports, socket streams, caches, or database columns. This module provides
 * raw channel helpers for already-agreed value shapes and schema helpers for
 * validating, transforming, or decoding domain values at the boundary.
 *
 * **Mental model**
 *
 * - Each input value passed to {@link encode} becomes one MessagePack byte array
 * - {@link decode} can receive arbitrary byte chunks; incomplete frames are
 *   buffered until enough bytes arrive
 * - Schema helpers run Effect schema encoding before packing and schema decoding
 *   after unpacking
 *
 * **Common tasks**
 *
 * - Pack values into bytes: {@link encode}
 * - Unpack byte chunks into values: {@link decode}
 * - Encode or decode domain values with schemas: {@link encodeSchema}, {@link decodeSchema}
 *
 * **Gotchas**
 *
 * - MessagePack preserves binary data better than JSON, but it is not a schema;
 *   use schema helpers when runtime validation matters
 * - Packing failures surface as {@link MsgPackError}; schema failures surface as
 *   `SchemaError` before or after the binary boundary
 * - Decoding expects complete MessagePack documents over time, not arbitrary
 *   byte payloads with out-of-band framing
 *
 * @since 4.0.0
 */
import { Packr, Unpackr } from "msgpackr"
import * as Msgpackr from "msgpackr"
import * as Arr from "../../Array.ts"
import * as Channel from "../../Channel.ts"
import * as ChannelSchema from "../../ChannelSchema.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import { dual } from "../../Function.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import type * as Pull from "../../Pull.ts"
import * as Schema from "../../Schema.ts"
import * as Issue from "../../SchemaIssue.ts"
import * as Transformation from "../../SchemaTransformation.ts"

const MsgPackErrorTypeId = "~effect/encoding/MsgPack/MsgPackError"

/**
 * Error raised when MessagePack encoding or decoding fails.
 *
 * **Details**
 *
 * The `kind` field identifies whether the failure happened while packing or
 * unpacking, and `cause` preserves the original error.
 *
 * @category errors
 * @since 4.0.0
 */
export class MsgPackError extends Data.TaggedError("MsgPackError")<{
  readonly kind: "Pack" | "Unpack"
  readonly cause: unknown
}> {
  /**
   * Marks this value as a MessagePack encoding or decoding error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [MsgPackErrorTypeId] = MsgPackErrorTypeId

  /**
   * Uses the failed MessagePack operation as the public message.
   *
   * @since 4.0.0
   */
  override get message() {
    return this.kind
  }
}

/**
 * Creates a channel that encodes non-empty chunks of values as MessagePack byte
 * arrays.
 *
 * **Details**
 *
 * The channel fails with `MsgPackError` when any value cannot be packed.
 *
 * @category constructors
 * @since 4.0.0
 */
export const encode = <IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
  IE | MsgPackError,
  Done,
  Arr.NonEmptyReadonlyArray<unknown>,
  IE,
  Done
> =>
  Channel.fromTransform((upstream, _scope) =>
    Effect.sync(() => {
      const packr = new Packr()
      return Effect.flatMap(upstream, (chunk) => {
        try {
          return Effect.succeed(Arr.map(chunk, (item) => packr.pack(item) as Uint8Array<ArrayBuffer>))
        } catch (cause) {
          return Effect.fail(new MsgPackError({ kind: "Pack", cause }))
        }
      })
    })
  )

/**
 * Creates a MessagePack encoder channel for values of a schema.
 *
 * **Details**
 *
 * Values are first encoded with the schema and then packed as MessagePack bytes,
 * so the channel can fail with either schema errors or `MsgPackError`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const encodeSchema = <S extends Schema.Top>(
  schema: S
) =>
<IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
  MsgPackError | Schema.SchemaError | IE,
  Done,
  Arr.NonEmptyReadonlyArray<S["Type"]>,
  IE,
  Done,
  S["EncodingServices"]
> => Channel.pipeTo(ChannelSchema.encode(schema)(), encode())

/**
 * Creates a channel that decodes MessagePack byte chunks into values.
 *
 * **Details**
 *
 * Incomplete frames are buffered across chunks, and invalid MessagePack data
 * fails with `MsgPackError`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const decode = <IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<unknown>,
  IE | MsgPackError,
  Done,
  Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
  IE,
  Done
> =>
  Channel.fromTransform((upstream, _scope) =>
    Effect.sync(() => {
      const unpackr = new Unpackr()
      let incomplete: Uint8Array<ArrayBuffer> | undefined = undefined
      return Effect.flatMap(
        upstream,
        function loop(chunk): Pull.Pull<Arr.NonEmptyReadonlyArray<unknown>, IE | MsgPackError, Done> {
          const out = Arr.empty<unknown>()
          for (let i = 0; i < chunk.length; i++) {
            let buf = chunk[i]
            if (incomplete !== undefined) {
              const prev = buf
              buf = new Uint8Array(incomplete.length + buf.length)
              buf.set(incomplete)
              buf.set(prev, incomplete.length)
              incomplete = undefined
            }
            try {
              out.push(...unpackr.unpackMultiple(buf))
            } catch (cause) {
              const error: any = cause
              if (error.incomplete) {
                incomplete = buf.subarray(error.lastPosition)
                if (error.values) {
                  out.push(...error.values)
                }
              } else {
                return Effect.fail(new MsgPackError({ kind: "Unpack", cause }))
              }
            }
          }
          return Arr.isReadonlyArrayNonEmpty(out) ? Effect.succeed(out) : Effect.flatMap(upstream, loop)
        }
      )
    })
  )

/**
 * Creates a MessagePack decoder channel for values of a schema.
 *
 * **Details**
 *
 * The channel unpacks bytes into unknown values and then decodes each value with
 * the schema.
 *
 * @category constructors
 * @since 4.0.0
 */
export const decodeSchema = <S extends Schema.Top>(
  schema: S
) =>
<IE = never, Done = unknown>(): Channel.Channel<
  Arr.NonEmptyReadonlyArray<S["Type"]>,
  Schema.SchemaError | MsgPackError | IE,
  Done,
  Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
  IE,
  Done,
  S["DecodingServices"]
> => Channel.pipeTo(decode<IE, Done>(), ChannelSchema.decodeUnknown(schema)())

/**
 * Wraps a bidirectional byte channel with MessagePack encoding and decoding.
 *
 * **Details**
 *
 * Outgoing values are packed as MessagePack bytes before reaching the wrapped
 * channel, and incoming bytes are unpacked into values.
 *
 * @category combinators
 * @since 4.0.0
 */
export const duplex = <R, IE, OE, OutDone, InDone>(
  self: Channel.Channel<
    Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
    OE,
    OutDone,
    Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
    IE | MsgPackError,
    InDone,
    R
  >
): Channel.Channel<
  Arr.NonEmptyReadonlyArray<unknown>,
  MsgPackError | OE,
  OutDone,
  Arr.NonEmptyReadonlyArray<unknown>,
  IE,
  InDone,
  R
> =>
  encode<IE, InDone>().pipe(
    Channel.pipeTo(self),
    Channel.pipeTo(decode())
  )

/**
 * Wraps a bidirectional byte channel with schema-aware MessagePack encoding and
 * decoding.
 *
 * **Details**
 *
 * Values sent to the wrapped channel are encoded with `inputSchema` and packed
 * as MessagePack bytes; bytes received from it are unpacked and decoded with
 * `outputSchema`.
 *
 * @category combinators
 * @since 4.0.0
 */
export const duplexSchema: {
  <In extends Schema.Top, Out extends Schema.Top>(
    options: {
      readonly inputSchema: In
      readonly outputSchema: Out
    }
  ): <OutErr, OutDone, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
      MsgPackError | Schema.SchemaError | InErr,
      InDone,
      R
    >
  ) => Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    MsgPackError | Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
  <Out extends Schema.Top, In extends Schema.Top, OutErr, OutDone, InErr, InDone, R>(
    self: Channel.Channel<
      Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
      OutErr,
      OutDone,
      Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
      MsgPackError | Schema.SchemaError | InErr,
      InDone,
      R
    >,
    options: {
      readonly inputSchema: In
      readonly outputSchema: Out
    }
  ): Channel.Channel<
    Arr.NonEmptyReadonlyArray<Out["Type"]>,
    MsgPackError | Schema.SchemaError | OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<In["Type"]>,
    InErr,
    InDone,
    R | In["EncodingServices"] | Out["DecodingServices"]
  >
} = dual(2, <Out extends Schema.Top, In extends Schema.Top, OutErr, OutDone, InErr, InDone, R>(
  self: Channel.Channel<
    Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
    OutErr,
    OutDone,
    Arr.NonEmptyReadonlyArray<Uint8Array<ArrayBuffer>>,
    MsgPackError | Schema.SchemaError | InErr,
    InDone,
    R
  >,
  options: {
    readonly inputSchema: In
    readonly outputSchema: Out
  }
): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Out["Type"]>,
  MsgPackError | Schema.SchemaError | OutErr,
  OutDone,
  Arr.NonEmptyReadonlyArray<In["Type"]>,
  InErr,
  InDone,
  R | In["EncodingServices"] | Out["DecodingServices"]
> => ChannelSchema.duplexUnknown(duplex(self), options))

/**
 * Schema type for values encoded as MessagePack bytes.
 *
 * **Details**
 *
 * It decodes a `Uint8Array` MessagePack payload to the target schema type and
 * encodes the target type back to bytes.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface schema<S extends Schema.Top> extends Schema.decodeTo<S, Schema.instanceOf<Uint8Array<ArrayBuffer>>> {}

/**
 * Schema for decoding MessagePack bytes into values and encoding values back to
 * MessagePack bytes.
 *
 * **Details**
 *
 * MessagePack codec failures are converted to `InvalidValue` schema issues.
 *
 * @category schemas
 * @since 4.0.0
 */
export const transformation: Transformation.Transformation<
  unknown,
  Uint8Array<ArrayBuffer>
> = Transformation.transformOrFail({
  decode(e, _options) {
    try {
      return Effect.succeed(Msgpackr.decode(e))
    } catch (cause) {
      return Effect.fail(
        new Issue.InvalidValue(Option.some(e), {
          message: Predicate.hasProperty(cause, "message") ? String(cause.message) : String(cause)
        })
      )
    }
  },
  encode(t, _options) {
    try {
      return Effect.succeed(Msgpackr.encode(t) as Uint8Array<ArrayBuffer>)
    } catch (cause) {
      return Effect.fail(
        new Issue.InvalidValue(Option.some(t), {
          message: Predicate.hasProperty(cause, "message") ? String(cause.message) : String(cause)
        })
      )
    }
  }
})

/**
 * Builds a schema that stores values as MessagePack bytes.
 *
 * **Details**
 *
 * The resulting schema decodes `Uint8Array` payloads with MessagePack and the
 * provided schema, and encodes values back to MessagePack bytes.
 *
 * @category schemas
 * @since 4.0.0
 */
export const schema = <S extends Schema.Top>(schema: S): schema<S> =>
  (Schema.Uint8Array as Schema.instanceOf<Uint8Array<ArrayBuffer>>).pipe(
    Schema.decodeTo(schema, transformation)
  )
