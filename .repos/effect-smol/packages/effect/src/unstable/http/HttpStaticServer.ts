/**
 * Serves static files for Effect HTTP applications.
 *
 * `HttpStaticServer` turns request paths into file responses under a configured
 * root directory. It can be used as an application value or mounted onto an
 * `HttpRouter`, and it handles index files, optional single-page application
 * fallback, MIME type headers, cache-control headers, byte ranges, and
 * conditional `304 Not Modified` responses.
 *
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as FileSystem from "../../FileSystem.ts"
import * as Layer from "../../Layer.ts"
import * as Path from "../../Path.ts"
import type { PlatformError } from "../../PlatformError.ts"
import * as HttpPlatform from "./HttpPlatform.ts"
import * as HttpRouter from "./HttpRouter.ts"
import * as HttpServerError from "./HttpServerError.ts"
import * as HttpServerRequest from "./HttpServerRequest.ts"
import * as HttpServerRespondable from "./HttpServerRespondable.ts"
import * as HttpServerResponse from "./HttpServerResponse.ts"

/**
 * Creates an `HttpApp` that serves files from a directory.
 *
 * **Example** (Serving files from a directory)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { HttpStaticServer } from "effect/unstable/http"
 *
 * const program = Effect.gen(function*() {
 *   const app = yield* HttpStaticServer.make({ root: "./public" })
 *   return app
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: (options: {
  readonly root: string
  readonly index?: string | undefined
  readonly spa?: boolean | undefined
  readonly cacheControl?: string | undefined
  readonly mimeTypes?: Record<string, string> | undefined
}) => Effect.Effect<
  Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError.HttpServerError,
    HttpServerRequest.HttpServerRequest
  >,
  PlatformError,
  FileSystem.FileSystem | Path.Path | HttpPlatform.HttpPlatform
> = Effect.fnUntraced(function*(options) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* HttpPlatform.HttpPlatform

  const resolvedRoot = path.resolve(options.root)
  const index = "index" in options ? options.index : "index.html"
  const spa = options.spa === true
  const cacheControl = options.cacheControl
  const mimeTypes = {
    ...defaultMimeTypes,
    ...options.mimeTypes
  }

  const setFileHeaders = (
    response: HttpServerResponse.HttpServerResponse,
    filePath: string
  ): HttpServerResponse.HttpServerResponse => {
    let currentResponse = HttpServerResponse.setHeaders(response, {
      "Content-Type": resolveMimeType(path, filePath, mimeTypes),
      "Accept-Ranges": "bytes"
    })
    if (cacheControl !== undefined) {
      currentResponse = HttpServerResponse.setHeader(currentResponse, "Cache-Control", cacheControl)
    }
    return currentResponse
  }

  const serveFile: (
    request: HttpServerRequest.HttpServerRequest,
    filePath: string,
    fileSize?: number
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError.HttpServerError> = Effect.fnUntraced(
    function*(request, filePath, fileSize) {
      const rangeHeader = request.headers["range"]
      const shouldEvaluateConditionals = request.headers["if-none-match"] !== undefined ||
        request.headers["if-modified-since"] !== undefined

      let fullResponse: HttpServerResponse.HttpServerResponse | undefined
      if (shouldEvaluateConditionals) {
        fullResponse = setFileHeaders(yield* handlePlatformError(request, platform.fileResponse(filePath)), filePath)
        const conditionalResponse = evaluateConditionalRequest(request, fullResponse)
        if (conditionalResponse !== undefined) {
          return conditionalResponse
        }
        if (rangeHeader === undefined) {
          return fullResponse
        }
      }

      const resolvedFileSize = rangeHeader === undefined
        ? undefined
        : fileSize ?? Number((yield* handlePlatformError(request, fileSystem.stat(filePath))).size)
      const parsedRange = rangeHeader === undefined || resolvedFileSize === undefined
        ? undefined
        : parseRange(rangeHeader, resolvedFileSize)

      if (parsedRange === undefined) {
        return fullResponse ??
          setFileHeaders(yield* handlePlatformError(request, platform.fileResponse(filePath)), filePath)
      }

      if (parsedRange === "unsatisfiable") {
        return HttpServerResponse.empty({
          status: 416,
          headers: {
            "Content-Range": `bytes */${resolvedFileSize}`
          }
        })
      }

      let response = setFileHeaders(
        yield* handlePlatformError(
          request,
          platform.fileResponse(filePath, {
            status: 206,
            offset: parsedRange.start,
            bytesToRead: parsedRange.end - parsedRange.start + 1
          })
        ),
        filePath
      )

      response = HttpServerResponse.setHeader(
        response,
        "Content-Range",
        `bytes ${parsedRange.start}-${parsedRange.end}/${resolvedFileSize}`
      )

      return response
    }
  )

  // @effect-diagnostics-next-line returnEffectInGen:off
  return HttpServerRequest.HttpServerRequest.use((request) => {
    const resolvedPath = resolveFilePath(path, resolvedRoot, request.url)
    if (resolvedPath === undefined) {
      return Effect.fail(toRouteNotFoundError(request))
    }

    return Effect.matchEffect(fileSystem.stat(resolvedPath), {
      onFailure: (error) =>
        error.reason._tag === "NotFound" &&
          spa && index !== undefined && path.extname(resolvedPath) === "" && acceptsHtml(request.headers["accept"])
          ? serveFile(request, path.join(resolvedRoot, index))
          : error.reason._tag === "NotFound"
          ? Effect.fail(toRouteNotFoundError(request))
          : Effect.fail(toInternalServerError(request, error)),
      onSuccess(info) {
        if (info.type === "File") {
          return serveFile(request, resolvedPath, Number(info.size))
        }
        if (info.type === "Directory" && index !== undefined) {
          return serveFile(request, path.join(resolvedPath, index))
        }
        return Effect.fail(toRouteNotFoundError(request))
      }
    })
  })
})

/**
 * Creates a layer that mounts static files on an `HttpRouter`.
 *
 * **Example** (Mounting static files on a router)
 *
 * ```ts
 * import { Layer } from "effect"
 * import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/unstable/http"
 *
 * const ApiLayer = HttpRouter.add("GET", "/health", HttpServerResponse.text("ok"))
 *
 * const StaticFilesLayer = HttpStaticServer.layer({
 *   root: "./public",
 *   prefix: "/static"
 * })
 *
 * const AppLayer = Layer.mergeAll(ApiLayer, StaticFilesLayer)
 * ```
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (options: {
  readonly root: string
  readonly index?: string | undefined
  readonly spa?: boolean | undefined
  readonly cacheControl?: string | undefined
  readonly mimeTypes?: Record<string, string> | undefined
  readonly prefix?: string | undefined
}): Layer.Layer<
  never,
  PlatformError,
  HttpRouter.HttpRouter | FileSystem.FileSystem | Path.Path | HttpPlatform.HttpPlatform
> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter
    const handler = (yield* make(options)).pipe(
      Effect.catch(HttpServerRespondable.toResponse)
    )
    if (options.prefix !== undefined) {
      yield* router.prefixed(options.prefix).add("GET", "/*", handler)
      return
    }
    yield* router.add("GET", "/*", handler)
  }))

const defaultMimeTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml; charset=utf-8",
  ico: "image/x-icon",
  webp: "image/webp",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  wasm: "application/wasm",
  map: "application/json",
  webmanifest: "application/manifest+json"
}

const stripQueryString = (url: string): string => {
  const queryIndex = url.indexOf("?")
  return queryIndex === -1 ? url : url.slice(0, queryIndex)
}

const resolveMimeType = (path: Path.Path, filePath: string, mimeTypes: Record<string, string>): string => {
  const extension = path.extname(filePath).toLowerCase()
  if (extension.length <= 1) {
    return "application/octet-stream"
  }
  return mimeTypes[extension.slice(1)] ?? "application/octet-stream"
}

const parseInteger = (value: string): number | undefined => {
  if (!/^\d+$/.test(value)) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const parseRange = (
  header: string,
  fileSize: number
):
  | { readonly start: number; readonly end: number }
  | "unsatisfiable"
  | undefined =>
{
  const value = header.trim()
  if (!value.toLowerCase().startsWith("bytes=")) {
    return undefined
  }
  const rangeValue = value.slice(6).trim()
  if (rangeValue.length === 0 || rangeValue.includes(",")) {
    return undefined
  }
  const separatorIndex = rangeValue.indexOf("-")
  if (separatorIndex === -1) {
    return undefined
  }
  const startPart = rangeValue.slice(0, separatorIndex).trim()
  const endPart = rangeValue.slice(separatorIndex + 1).trim()
  if (startPart === "" && endPart === "") {
    return undefined
  }
  if (startPart === "") {
    const suffixLength = parseInteger(endPart)
    if (suffixLength === undefined) {
      return undefined
    }
    if (suffixLength === 0 || fileSize === 0) {
      return "unsatisfiable"
    }
    return {
      start: Math.max(fileSize - suffixLength, 0),
      end: fileSize - 1
    }
  }
  const start = parseInteger(startPart)
  if (start === undefined) {
    return undefined
  }
  if (endPart === "") {
    if (start >= fileSize) {
      return "unsatisfiable"
    }
    return {
      start,
      end: fileSize - 1
    }
  }
  const end = parseInteger(endPart)
  if (end === undefined) {
    return undefined
  }
  if (start > end || start >= fileSize) {
    return "unsatisfiable"
  }
  return {
    start,
    end: Math.min(end, fileSize - 1)
  }
}

const resolveFilePath = (path: Path.Path, root: string, url: string): string | undefined => {
  const urlPath = stripQueryString(url)
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(urlPath)
  } catch {
    return undefined
  }
  if (decodedPath.includes("\u0000")) {
    return undefined
  }
  const normalizedPath = path.normalize(decodedPath.startsWith("/") ? decodedPath.slice(1) : decodedPath)
  if (normalizedPath === ".." || normalizedPath.startsWith(`..${path.sep}`)) {
    return undefined
  }
  const resolvedPath = path.join(root, normalizedPath)
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  if (resolvedPath !== root && !resolvedPath.startsWith(rootPrefix)) {
    return undefined
  }
  return resolvedPath
}

const toRouteNotFoundError = (request: HttpServerRequest.HttpServerRequest) =>
  new HttpServerError.HttpServerError({ reason: new HttpServerError.RouteNotFound({ request }) })

const toInternalServerError = (request: HttpServerRequest.HttpServerRequest, cause: unknown) =>
  new HttpServerError.HttpServerError({ reason: new HttpServerError.InternalError({ request, cause }) })

const handlePlatformError = <A>(
  request: HttpServerRequest.HttpServerRequest,
  self: Effect.Effect<A, PlatformError>
): Effect.Effect<A, HttpServerError.HttpServerError> =>
  Effect.catchIf(
    self,
    (error): error is PlatformError => error.reason._tag === "NotFound",
    () => Effect.fail(toRouteNotFoundError(request)),
    (error) => Effect.fail(toInternalServerError(request, error))
  )

const acceptsHtml = (accept: string | undefined): boolean =>
  accept !== undefined && accept.toLowerCase().includes("text/html")

const stripWeakEtagPrefix = (value: string): string => {
  const trimmed = value.trim()
  return /^w\//i.test(trimmed) ? trimmed.slice(2) : trimmed
}

const matchesIfNoneMatch = (ifNoneMatch: string, etag: string | undefined): boolean => {
  const normalizedEtag = etag === undefined ? undefined : stripWeakEtagPrefix(etag)
  for (const candidate of ifNoneMatch.split(",")) {
    const value = candidate.trim()
    if (value === "") {
      continue
    }
    if (value === "*") {
      return true
    }
    if (normalizedEtag !== undefined && stripWeakEtagPrefix(value) === normalizedEtag) {
      return true
    }
  }
  return false
}

const isNotModifiedSince = (ifModifiedSince: string, lastModified: string | undefined): boolean => {
  if (lastModified === undefined) {
    return false
  }
  const ifModifiedSinceMs = Date.parse(ifModifiedSince)
  if (Number.isNaN(ifModifiedSinceMs)) {
    return false
  }
  const lastModifiedMs = Date.parse(lastModified)
  if (Number.isNaN(lastModifiedMs)) {
    return false
  }
  return lastModifiedMs <= ifModifiedSinceMs
}

const notModifiedResponse = (
  response: HttpServerResponse.HttpServerResponse
): HttpServerResponse.HttpServerResponse => {
  const headers: Record<string, string> = {}
  const etag = response.headers["etag"]
  if (etag !== undefined) {
    headers["ETag"] = etag
  }
  const cacheControl = response.headers["cache-control"]
  if (cacheControl !== undefined) {
    headers["Cache-Control"] = cacheControl
  }
  const lastModified = response.headers["last-modified"]
  if (lastModified !== undefined) {
    headers["Last-Modified"] = lastModified
  }
  return HttpServerResponse.empty({
    status: 304,
    headers
  })
}

const evaluateConditionalRequest = (
  request: HttpServerRequest.HttpServerRequest,
  response: HttpServerResponse.HttpServerResponse
): HttpServerResponse.HttpServerResponse | undefined => {
  const ifNoneMatch = request.headers["if-none-match"]
  if (ifNoneMatch !== undefined) {
    return matchesIfNoneMatch(ifNoneMatch, response.headers["etag"]) ? notModifiedResponse(response) : undefined
  }
  const ifModifiedSince = request.headers["if-modified-since"]
  if (ifModifiedSince !== undefined && isNotModifiedSince(ifModifiedSince, response.headers["last-modified"])) {
    return notModifiedResponse(response)
  }
  return undefined
}
