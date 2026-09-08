/**
 * Platform-specific support for serving files as HTTP server responses.
 *
 * `HttpPlatform` is the boundary between the portable HTTP response model and
 * the runtime that knows how to stream bytes from the host platform. Server
 * code uses this service when it needs to return local files, static assets,
 * downloads, byte ranges, or Web `File`-like values without constructing the
 * response body by hand.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as FileSystem from "../../FileSystem.ts"
import { identity } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import type { PlatformError } from "../../PlatformError.ts"
import * as Stream from "../../Stream.ts"
import * as Etag from "./Etag.ts"
import * as Headers from "./Headers.ts"
import type * as Body from "./HttpBody.ts"
import * as Response from "./HttpServerResponse.ts"
import * as internal from "./internal/compression.ts"

/**
 * Service for platform-specific HTTP response helpers, including file-backed server responses.
 *
 * @category services
 * @since 4.0.0
 */
export class HttpPlatform extends Context.Service<HttpPlatform, {
  readonly platform: "deno" | "node" | "bun" | "web"
  readonly compression: Compression
  readonly fileResponse: (
    path: string,
    options?: Response.Options.WithContent & {
      readonly bytesToRead?: FileSystem.SizeInput | undefined
      readonly chunkSize?: FileSystem.SizeInput | undefined
      readonly offset?: FileSystem.SizeInput | undefined
    }
  ) => Effect.Effect<Response.HttpServerResponse, PlatformError>
  readonly fileWebResponse: (
    file: Body.HttpBody.FileLike,
    options?: Response.Options.WithContent & {
      readonly bytesToRead?: FileSystem.SizeInput | undefined
      readonly chunkSize?: FileSystem.SizeInput | undefined
      readonly offset?: FileSystem.SizeInput | undefined
    }
  ) => Effect.Effect<Response.HttpServerResponse>
}>()("effect/http/HttpPlatform") {}

/**
 * Creates an `HttpPlatform` service from platform-specific file response constructors, using `FileSystem` and `Etag.Generator`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: (impl: {
  readonly platform: "deno" | "node" | "bun" | "web"
  readonly compression: Compression
  readonly fileResponse: (
    path: string,
    status: number,
    statusText: string | undefined,
    headers: Headers.Headers,
    start: number,
    end: number | undefined,
    contentLength: number
  ) => Response.HttpServerResponse
  readonly fileWebResponse: (
    file: Body.HttpBody.FileLike,
    status: number,
    statusText: string | undefined,
    headers: Headers.Headers,
    options?: {
      readonly bytesToRead?: FileSystem.SizeInput | undefined
      readonly chunkSize?: FileSystem.SizeInput | undefined
      readonly offset?: FileSystem.SizeInput | undefined
    }
  ) => Response.HttpServerResponse
}) => Effect.Effect<
  HttpPlatform["Service"],
  never,
  Etag.Generator | FileSystem.FileSystem
> = Effect.fnUntraced(function*(impl) {
  const fs = yield* FileSystem.FileSystem
  const etagGen = yield* Etag.Generator

  return HttpPlatform.of({
    platform: impl.platform,
    compression: internal.wrapCompression(impl.compression),
    fileResponse: Effect.fnUntraced(function*(path, options) {
      const info = yield* fs.stat(path)
      const etag = yield* etagGen.fromFileInfo(info)
      const start = Number(options?.offset ?? 0)
      const end = options?.bytesToRead !== undefined ? start + Number(options.bytesToRead) : undefined
      const headers = Headers.set(
        options?.headers ? Headers.fromInput(options.headers) : Headers.empty,
        "etag",
        Etag.toString(etag)
      )
      if (Option.isSome(info.mtime)) {
        ;(headers as any)["last-modified"] = info.mtime.value.toUTCString()
      }
      const contentLength = end !== undefined ? end - start : Number(info.size) - start
      return impl.fileResponse(
        path,
        options?.status ?? 200,
        options?.statusText,
        headers,
        start,
        end,
        contentLength
      )
    }),
    fileWebResponse(file, options) {
      return Effect.map(etagGen.fromFileWeb(file), (etag) => {
        const headers = Headers.merge(
          options?.headers ? Headers.fromInput(options.headers) : Headers.empty,
          Headers.fromRecordUnsafe({
            etag: Etag.toString(etag),
            "last-modified": new Date(file.lastModified).toUTCString()
          })
        )
        return impl.fileWebResponse(
          file,
          options?.status ?? 200,
          options?.statusText,
          headers,
          options
        )
      })
    }
  })
})

/**
 * Provides the default `HttpPlatform` implementation for serving file paths and
 * `File`-like values as streamed HTTP responses.
 *
 * **Details**
 *
 * The layer uses the `FileSystem` and weak ETag services to add file metadata
 * headers such as `etag` and `last-modified`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = Layer.effect(HttpPlatform)(
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    make({
      platform: "web",
      compression: internal.compressionWeb,
      fileResponse(path, status, statusText, headers, start, end, contentLength) {
        return Response.stream(
          fs.stream(path, {
            offset: start,
            bytesToRead: end !== undefined ? end - start : undefined
          }),
          { contentLength, headers, status, statusText }
        )
      },
      fileWebResponse(file, status, statusText, headers, options) {
        const offset = Number(options?.offset ?? 0)
        const bytesToRead = options?.bytesToRead !== undefined ? Number(options.bytesToRead) : undefined
        const chunkSize = options?.chunkSize !== undefined ? Math.max(1, Number(options.chunkSize)) : Infinity
        const end = offset + (bytesToRead ?? Infinity)
        const stream = end <= offset
          ? Stream.empty
          : Stream.fromReadableStream({
            evaluate: () => file.stream() as ReadableStream<Uint8Array>,
            onError: identity
          }).pipe(
            Stream.mapAccum(
              () => 0,
              (position, bytes) => {
                const next = position + bytes.length
                const start = Math.min(Math.max(offset - position, 0), bytes.length)
                const stop = Math.min(Math.max(end - position, 0), bytes.length)
                const chunks: Array<{ readonly bytes: Uint8Array; readonly done: boolean }> = []
                for (let index = start; index < stop; index += chunkSize) {
                  chunks.push({
                    bytes: bytes.subarray(index, Math.min(index + chunkSize, stop)),
                    done: next >= end && index + chunkSize >= stop
                  })
                }
                return [next, chunks]
              }
            ),
            Stream.takeUntil((chunk) => chunk.done),
            Stream.map((chunk) => chunk.bytes)
          )
        return Response.stream(stream, {
          contentLength: bytesToRead ?? file.size - offset,
          headers,
          status,
          statusText
        })
      }
    }))
).pipe(Layer.provide(Etag.layerWeak))

/**
 * Content codings that HTTP response compression can apply.
 *
 * @category compression
 * @since 4.0.0
 */
export type CompressionAlgorithm = "gzip" | "deflate" | "br" | "zstd"

/**
 * Options passed to a platform when compressing a response body.
 *
 * **Details**
 *
 * The `level` scale depends on the algorithm. Platforms without a level knob,
 * such as the Web `CompressionStream` implementation, ignore it.
 *
 * @category compression
 * @since 4.0.0
 */
export interface CompressionOptions {
  readonly level?: number | undefined
}

/**
 * Platform primitive for HTTP response compression.
 *
 * **Details**
 *
 * `algorithms` advertises what the platform can encode; content negotiation
 * happens in the shared `HttpMiddleware.compression` middleware.
 *
 * `compressResponse` is only called when compression is definitely happening —
 * all skip logic runs in the shared middleware first. The platform owns the
 * body transform and removes `Content-Length` when the compressed size is not
 * known in advance. The `make` wrapper owns the `Content-Encoding` and `Vary`
 * headers.
 *
 * @category compression
 * @since 4.0.0
 */
export interface Compression {
  readonly algorithms: ReadonlySet<CompressionAlgorithm>
  readonly compressResponse: (
    response: Response.HttpServerResponse,
    algorithm: CompressionAlgorithm,
    options?: CompressionOptions | undefined
  ) => Effect.Effect<Response.HttpServerResponse>
}

/**
 * Creates a compression body transform backed by the Web `CompressionStream`
 * API, for use with `makeCompressionWeb`.
 *
 * **Details**
 *
 * The format string is passed through to the runtime, so runtime-specific
 * formats such as Bun's `"brotli"` and `"zstd"` are usable. `CompressionStream`
 * has no compression level knob, so `CompressionOptions.level` does not apply.
 *
 * @category compression
 * @since 4.0.0
 */
export const compressionTransformWeb: (
  format: string
) => (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array> = internal.compressionTransformWeb

/**
 * Creates a `Compression` implementation from Web `ReadableStream`
 * transforms.
 *
 * **Details**
 *
 * All supported bodies are transformed as streams. The `Content-Length`
 * header is dropped in every case.
 *
 * @category compression
 * @since 4.0.0
 */
export const makeCompressionWeb: (options: {
  readonly algorithms: Iterable<CompressionAlgorithm>
  readonly transform: (
    algorithm: CompressionAlgorithm,
    options?: CompressionOptions | undefined
  ) => (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>
}) => Compression = internal.makeCompressionWeb
