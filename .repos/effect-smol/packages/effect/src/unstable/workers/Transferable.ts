/**
 * Marks encoded worker message fields that should move through `postMessage` as
 * transfer-list entries.
 *
 * Worker messages still pass through schema encoding and structured clone, but
 * schemas wrapped with `schema` can also report backing resources such as
 * `ArrayBuffer`, `ImageData.data.buffer`, or `MessagePort` to a `Collector`.
 * Worker platforms then pass the collected values as the transfer list for the
 * same `postMessage` call, avoiding copies for large payloads and ports.
 *
 * **Mental model**
 *
 * A `Collector` is an optional context service. During encoding, `getterAddAll`
 * and `schema` add transferable values when a collector is present and leave the
 * encoded value unchanged. The built-in `Uint8Array`, `ImageData`, and
 * `MessagePort` schemas are convenience wrappers around the same behavior.
 *
 * **Common tasks**
 *
 * Wrap a worker message field with `schema` when the transferable is nested or
 * derived from the encoded value. Provide a fresh collector around each message
 * encode, read or clear it after encoding, and pass the resulting list to the
 * worker transport.
 *
 * **Gotchas**
 *
 * Transfer annotations do not make unsupported values structured-cloneable.
 * Ownership moves to the receiver after `postMessage`, so buffers are detached
 * from the sender. For typed array views, collecting `view.buffer` transfers the
 * whole backing buffer, including bytes used by other views.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import { dual } from "../../Function.ts"
import * as Schema from "../../Schema.ts"
import * as Getter from "../../SchemaGetter.ts"

/**
 * Service for collecting `Transferable` objects while encoding worker messages
 * so they can be passed to `postMessage` transfer lists.
 *
 * @category models
 * @since 4.0.0
 */
export class Collector extends Context.Service<Collector, {
  readonly addAll: (
    _: Iterable<globalThis.Transferable>
  ) => Effect.Effect<void>
  readonly addAllUnsafe: (_: Iterable<globalThis.Transferable>) => void
  readonly read: Effect.Effect<Array<globalThis.Transferable>>
  readonly readUnsafe: () => Array<globalThis.Transferable>
  readonly clearUnsafe: () => Array<globalThis.Transferable>
  readonly clear: Effect.Effect<Array<globalThis.Transferable>>
}>()("effect/workers/Transferable/Collector") {}

/**
 * Creates a mutable `Collector` service directly, exposing unsafe synchronous
 * methods for reading, adding, and clearing collected transferables.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeCollectorUnsafe = (): Collector["Service"] => {
  let tranferables: Array<globalThis.Transferable> = []
  const unsafeAddAll = (transfers: Iterable<globalThis.Transferable>): void => {
    tranferables.push(...transfers)
  }
  const unsafeRead = (): Array<globalThis.Transferable> => tranferables
  const unsafeClear = (): Array<globalThis.Transferable> => {
    const prev = tranferables
    tranferables = []
    return prev
  }
  return Collector.of({
    addAllUnsafe: unsafeAddAll,
    addAll: (transferables) => Effect.sync(() => unsafeAddAll(transferables)),
    readUnsafe: unsafeRead,
    read: Effect.sync(unsafeRead),
    clearUnsafe: unsafeClear,
    clear: Effect.sync(unsafeClear)
  })
}

/**
 * Effect that creates a fresh `Collector` service for accumulating
 * transferables.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeCollector: Effect.Effect<Collector["Service"]> = Effect.sync(makeCollectorUnsafe)

/**
 * Adds transferables to the current `Collector` when one is present in the
 * context, and does nothing otherwise.
 *
 * @category accessors
 * @since 4.0.0
 */
export const addAll = (
  tranferables: Iterable<globalThis.Transferable>
): Effect.Effect<void> =>
  Effect.contextWith((services) => {
    const collector = Context.getOrUndefined(services, Collector)
    if (!collector) return Effect.void
    collector.addAllUnsafe(tranferables)
    return Effect.void
  })

/**
 * Creates a schema getter that records transferables derived from a value in
 * the current `Collector` while passing the value through unchanged.
 *
 * @category Getter
 * @since 4.0.0
 */
export const getterAddAll = <A>(
  f: (_: A) => Iterable<globalThis.Transferable>
): Getter.Getter<A, A> =>
  Getter.transformOrFail((e: A) =>
    Effect.contextWith((services) => {
      const collector = Context.getOrUndefined(services, Collector)
      if (!collector) return Effect.succeed(e)
      collector.addAllUnsafe(f(e))
      return Effect.succeed(e)
    })
  )

/**
 * Schema wrapper whose encode path can record transferables with a `Collector`
 * while preserving the wrapped schema's decoded type.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface Transferable<S extends Schema.Top> extends
  Schema.decodeTo<
    Schema.toType<S["Rebuild"]>,
    S["Rebuild"]
  >
{}

/**
 * Wraps a schema so encoding records transferables selected from the encoded
 * value, enabling worker messages to populate a `postMessage` transfer list.
 *
 * @category schemas
 * @since 4.0.0
 */
export const schema: {
  <S extends Schema.Top>(
    f: (_: S["Encoded"]) => Iterable<globalThis.Transferable>
  ): (self: S) => Transferable<S>
  <S extends Schema.Top>(
    self: S,
    f: (_: S["Encoded"]) => Iterable<globalThis.Transferable>
  ): Transferable<S>
} = dual(
  2,
  <S extends Schema.Top>(
    self: S,
    f: (_: S["Encoded"]) => Iterable<globalThis.Transferable>
  ): Transferable<S> =>
    self.annotate({
      toCodecJson: () => passthroughLink
    }).pipe(
      Schema.decode({
        decode: Getter.passthrough(),
        encode: getterAddAll(f)
      })
    )
)

const passthroughLink = Schema.link()(Schema.Any, {
  decode: Getter.passthrough(),
  encode: Getter.passthrough()
})

/**
 * Schema for transferring `ImageData` values with their pixel data buffer.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ImageData: Transferable<Schema.declare<ImageData>> = schema(
  Schema.Any as any as Schema.declare<globalThis.ImageData>,
  (_) => [_.data.buffer]
)

/**
 * Schema for transferring `MessagePort` values as transferable objects.
 *
 * @category schemas
 * @since 4.0.0
 */
export const MessagePort: Transferable<Schema.declare<MessagePort>> = schema(
  Schema.Any as any as Schema.declare<MessagePort>,
  (_) => [_]
)

/**
 * Schema for transferring `Uint8Array` values with their backing buffer.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Uint8Array: Transferable<Schema.instanceOf<globalThis.Uint8Array<ArrayBuffer>>> = schema(
  Schema.Uint8Array as any,
  (_) => [_.buffer]
)
