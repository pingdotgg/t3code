/**
 * Node.js implementation of the Effect HTTP platform service.
 *
 * This module connects the portable `HttpPlatform` file response helpers to
 * Node runtime primitives. It serves local files through Node readable streams,
 * supports byte ranges, converts Web `File` values to readable streams, and
 * fills in content type and content length headers when needed.
 *
 * @since 4.0.0
 */
import * as NodeHttpCompression from "@effect/platform-node-shared/NodeHttpCompression"
import * as Effect from "effect/Effect"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as EtagImpl from "effect/unstable/http/Etag"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as Platform from "effect/unstable/http/HttpPlatform"
import * as ServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Fs from "node:fs"
import { Readable } from "node:stream"
import Mime from "./Mime.ts"
import * as NodeFileSystem from "./NodeFileSystem.ts"
import * as NodeStream from "./NodeStream.ts"

// replaces the response body while keeping every other field, dropping the
// now-stale Content-Length header
const compressedBody = (
  response: ServerResponse.HttpServerResponse,
  body: HttpBody.HttpBody
): ServerResponse.HttpServerResponse =>
  ServerResponse.removeHeader(ServerResponse.setBody(response, body), "content-length")

const compression = NodeHttpCompression.make({
  algorithms: NodeHttpCompression.algorithms,
  compressResponse(response, algorithm, options) {
    const body = response.body
    switch (body._tag) {
      case "Stream": {
        return Effect.succeed(compressedBody(
          response,
          HttpBody.stream(
            NodeStream.pipeThroughDuplex(body.stream, {
              evaluate: () => NodeHttpCompression.compressTransform(algorithm, options)
            }),
            body.contentType
          )
        ))
      }
      case "Raw": {
        const readable = body.body instanceof Readable
          ? body.body
          : Readable.fromWeb(new Response(body.body as BodyInit).body as any)
        const transform = NodeHttpCompression.compressTransform(algorithm, options)
        readable.on("error", (cause) => transform.destroy(cause))
        transform.on("error", (cause) => readable.destroy(cause))
        transform.on("close", () => readable.destroy())
        return Effect.succeed(
          compressedBody(response, HttpBody.raw(readable.pipe(transform), { contentType: body.contentType }))
        )
      }
      default: {
        return Effect.succeed(response)
      }
    }
  }
})

/**
 * Creates the Node `HttpPlatform`, serving file responses from Node readable
 * streams and adding MIME type and content-length headers when needed.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Platform.make({
  platform: "node",
  compression,
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
