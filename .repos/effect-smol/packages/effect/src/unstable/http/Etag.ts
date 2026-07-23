/**
 * HTTP entity tag values and metadata-based generator layers.
 *
 * ETags are validators for a specific representation of a resource. Servers put
 * them in `ETag` response headers so clients and intermediaries can revalidate
 * cached content with `If-None-Match`, or protect writes with preconditions such
 * as `If-Match`.
 *
 * **Mental model**
 *
 * A strong ETag represents byte-for-byte identity for the selected
 * representation. A weak ETag represents a validator that is useful for cache
 * revalidation but not for operations that require exact byte identity. The
 * `Weak` and `Strong` models store the raw tag value; `toString` adds the
 * required quotes and the `W/` prefix for weak tags.
 *
 * **Common tasks**
 *
 * - Format an `Etag` value for an HTTP header with `toString`.
 * - Provide a `Generator` service with `layer` for strong metadata-derived tags.
 * - Use `layerWeak` when size and modification time are good cache validators
 *   but not a byte-for-byte guarantee.
 *
 * **Gotchas**
 *
 * The built-in generator derives tags only from file size and modification time.
 * Choose the strong layer only when that metadata changes for every byte-level
 * content change. This module formats ETags but does not parse incoming ETag
 * headers or implement conditional request logic.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import type * as FileSystem from "../../FileSystem.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import type * as Body from "./HttpBody.ts"

/**
 * Represents an HTTP entity tag, either weak or strong.
 *
 * @category models
 * @since 4.0.0
 */
export type Etag = Weak | Strong

/**
 * Weak HTTP entity tag.
 *
 * **Details**
 *
 * The `value` is the raw tag value without the surrounding quotes or `W/` prefix.
 *
 * @category models
 * @since 4.0.0
 */
export interface Weak {
  readonly _tag: "Weak"
  readonly value: string
}

/**
 * Strong HTTP entity tag.
 *
 * **Details**
 *
 * The `value` is the raw tag value without the surrounding quotes.
 *
 * @category models
 * @since 4.0.0
 */
export interface Strong {
  readonly _tag: "Strong"
  readonly value: string
}

/**
 * Formats an `Etag` as an HTTP header value, including quotes and the `W/` prefix for weak tags.
 *
 * @category convertions
 * @since 4.0.0
 */
export const toString = (self: Etag): string => {
  switch (self._tag) {
    case "Weak":
      return `W/"${self.value}"`
    case "Strong":
      return `"${self.value}"`
  }
}

/**
 * Service for generating ETags from filesystem file information or Web `File`-like metadata.
 *
 * @category models
 * @since 4.0.0
 */
export class Generator extends Context.Service<Generator, {
  readonly fromFileInfo: (info: FileSystem.File.Info) => Effect.Effect<Etag>
  readonly fromFileWeb: (file: Body.HttpBody.FileLike) => Effect.Effect<Etag>
}>()("effect/http/Etag/Generator") {}

const fromFileInfo = (info: FileSystem.File.Info) => {
  const mtime = Option.match(info.mtime, {
    onNone: () => "0",
    onSome: (mtime) => mtime.getTime().toString(16)
  })
  return `${info.size.toString(16)}-${mtime}`
}

const fromFileWeb = (file: Body.HttpBody.FileLike) => {
  return `${file.size.toString(16)}-${file.lastModified.toString(16)}`
}

/**
 * Layer that provides a `Generator` which produces strong ETags from file size
 * and modification time metadata.
 *
 * **When to use**
 *
 * Use when file size and modification time reliably change for every byte-level
 * change and the consuming HTTP code needs strong ETags from the `Generator`
 * service.
 *
 * **Gotchas**
 *
 * This layer marks metadata-derived tags as strong. If the underlying storage
 * can update file contents without changing the recorded size or modification
 * time, those tags can stop representing byte-for-byte identity.
 *
 * @see {@link layerWeak} for weak metadata-derived ETags when byte-for-byte identity is not required
 * @see {@link Generator} for the service provided by this layer
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Generator> = Layer.succeed(
  Generator
)({
  fromFileInfo(info) {
    return Effect.sync(() => ({ _tag: "Strong", value: fromFileInfo(info) }))
  },
  fromFileWeb(file) {
    return Effect.sync(() => ({ _tag: "Strong", value: fromFileWeb(file) }))
  }
})

/**
 * Layer that provides a `Generator` which produces weak ETags from file size and modification time metadata.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWeak: Layer.Layer<Generator> = Layer.succeed(
  Generator
)({
  fromFileInfo(info) {
    return Effect.sync(() => ({ _tag: "Weak", value: fromFileInfo(info) }))
  },
  fromFileWeb(file) {
    return Effect.sync(() => ({ _tag: "Weak", value: fromFileWeb(file) }))
  }
})
