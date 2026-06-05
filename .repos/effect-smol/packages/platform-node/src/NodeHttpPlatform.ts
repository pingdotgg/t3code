/**
 * Node.js implementation of the Effect HTTP platform service.
 *
 * This module connects the portable `HttpPlatform` file response helpers to
 * Node runtime primitives. It is used by Node HTTP servers and static file
 * handlers when returning local files, public assets, downloads, byte ranges,
 * or Web `File` values as `HttpServerResponse` bodies.
 *
 * Path-based responses are served with `node:fs.createReadStream`; Web `File`
 * responses are bridged with `Readable.fromWeb`. The implementation fills in
 * `content-type` from `Mime`, falls back to `application/octet-stream`, and
 * writes the `content-length` for the selected range or whole file. Node's
 * stream `end` option is inclusive, so the platform converts Effect's half-open
 * range before reading. Empty bodies use an empty readable stream.
 *
 * Provide `layer` at the Node runtime edge when file responses, static serving,
 * or response bodies created from files need real filesystem and ETag support.
 * These responses are raw Node streams, so they are intended for the Node HTTP
 * server adapter; keep files available until the response body has been
 * consumed and prefer the portable `HttpServerResponse` constructors when a
 * response does not depend on Node file or stream behavior.
 *
 * @since 4.0.0
 */
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as EtagImpl from "effect/unstable/http/Etag"
import * as Headers from "effect/unstable/http/Headers"
import * as Platform from "effect/unstable/http/HttpPlatform"
import * as ServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Fs from "node:fs"
import { Readable } from "node:stream"
import Mime from "./Mime.ts"
import * as NodeFileSystem from "./NodeFileSystem.ts"

/**
 * Creates the Node `HttpPlatform`, serving file responses from Node readable
 * streams and adding MIME type and content-length headers when needed.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Platform.make({
  fileResponse(path, status, statusText, headers, start, end, contentLength) {
    const stream = contentLength === 0
      ? Readable.from([])
      : Fs.createReadStream(path, { start, end: end === undefined ? undefined : end - 1 })
    return ServerResponse.raw(stream, {
      headers: {
        ...headers,
        "content-type": headers["content-type"] ?? Mime.getType(path) ?? "application/octet-stream",
        "content-length": contentLength.toString()
      },
      status,
      statusText
    })
  },
  fileWebResponse(file, status, statusText, headers, _options) {
    return ServerResponse.raw(Readable.fromWeb(file.stream() as any), {
      headers: Headers.merge(
        headers,
        Headers.fromRecordUnsafe({
          "content-type": headers["content-type"] ?? Mime.getType(file.name) ?? "application/octet-stream",
          "content-length": file.size.toString()
        })
      ),
      status,
      statusText
    })
  }
})

/**
 * Provides the Node `HttpPlatform` together with the filesystem and ETag
 * services it needs for file responses.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Platform.HttpPlatform> = pipe(
  Layer.effect(Platform.HttpPlatform)(make),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(EtagImpl.layer)
)
