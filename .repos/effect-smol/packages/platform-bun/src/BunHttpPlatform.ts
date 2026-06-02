/**
 * Bun implementation of the Effect HTTP platform service.
 *
 * This module connects the portable `HttpPlatform` file response helpers to
 * Bun's Web-compatible runtime. `BunHttpServer` provides this layer when
 * applications serve local files, public assets, downloads, byte ranges, or
 * Web `File` values from Effect `HttpServerResponse` constructors.
 *
 * Path-based responses are backed by `Bun.file`, and Web `File` responses are
 * returned directly as raw response bodies. The shared `HttpPlatform` service
 * still computes file metadata such as ETags and last-modified headers, while
 * this adapter lets Bun's `Response` implementation handle the platform body.
 *
 * Because the Bun server adapter sits on top of Web `Request` and `Response`,
 * request bodies follow the usual single-consumption rules: choose the
 * streamed, text, URL-encoded, or multipart view that matches the route. For
 * `FormData` responses, let the `Response` constructor create the multipart
 * content type and boundary unless you intentionally override it. File
 * responses take filesystem paths, not request URLs; Bun request URLs are
 * absolute at the runtime edge, and route paths are normalized by
 * `BunHttpServer`, so decode and validate URL pathnames before mapping them to
 * files.
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
