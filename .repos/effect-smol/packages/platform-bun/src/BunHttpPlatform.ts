/**
 * Bun implementation of the Effect HTTP platform service.
 *
 * This module provides one `layer` for `HttpPlatform`. It implements file
 * responses with `Bun.file`, supports sliced file responses for byte ranges,
 * and returns Web `File` values as raw HTTP server responses. The layer also
 * provides the Bun file-system layer and ETag generator required by
 * `HttpPlatform`.
 *
 * @since 4.0.0
 */
import type { Effect } from "effect"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Etag from "effect/unstable/http/Etag"
import * as Platform from "effect/unstable/http/HttpPlatform"
import * as Response from "effect/unstable/http/HttpServerResponse"
import * as BunFileSystem from "./BunFileSystem.ts"

/**
 * @category constructors
 * @since 4.0.0
 */
const make: Effect.Effect<
  Platform.HttpPlatform["Service"],
  never,
  FileSystem | Etag.Generator
> = Platform.make({
  fileResponse(path, status, statusText, headers, start, end, _contentLength) {
    let file = Bun.file(path)
    if (start > 0 || end !== undefined) {
      file = file.slice(start, end)
    }
    return Response.raw(file, { headers, status, statusText })
  },
  fileWebResponse(file, status, statusText, headers, _options) {
    return Response.raw(file, { headers, status, statusText })
  }
})

/**
 * Layer that provides the Bun `HttpPlatform`, including file responses backed by `Bun.file`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = Layer.effect(Platform.HttpPlatform)(make).pipe(
  Layer.provide(BunFileSystem.layer),
  Layer.provide(Etag.layer)
)
