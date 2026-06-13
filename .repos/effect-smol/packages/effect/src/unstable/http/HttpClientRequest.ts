/**
 * Immutable outgoing HTTP client requests.
 *
 * `HttpClientRequest` is the request model shared by Effect HTTP clients and
 * platform adapters. A request stores its method, URL, query parameters, hash,
 * headers, and body as structured data, and this module provides constructors,
 * pipeable update helpers, body encoders, and Web `Request` conversions.
 *
 * **Mental model**
 *
 * Request builders start from {@link empty} and return a new request for every
 * change. The base URL, query parameters, and hash stay separate until
 * conversion, so code can update them independently before calling
 * {@link toUrl}, {@link toWebResult}, or {@link toWeb}. Body helpers delegate to
 * `HttpBody` and update `Content-Type` and `Content-Length` when the selected
 * body carries that metadata.
 *
 * **Common tasks**
 *
 * - Start a request with {@link get}, {@link post}, {@link put},
 *   {@link patch}, or another method constructor.
 * - Add authentication or accepted media types with {@link basicAuth},
 *   {@link bearerToken}, {@link accept}, or {@link acceptJson}.
 * - Change URL parts with {@link setUrl}, {@link prependUrl},
 *   {@link appendUrl}, {@link setUrlParam}, {@link appendUrlParam}, and
 *   {@link setHash}.
 * - Attach payloads with {@link bodyJson}, {@link bodyUrlParams},
 *   {@link bodyFormData}, {@link bodyStream}, or {@link bodyFile}.
 * - Bridge Web platform values with {@link fromWeb}, {@link toWebResult}, and
 *   {@link toWeb}.
 *
 * **Gotchas**
 *
 * Passing a `URL` extracts its search parameters and fragment into structured
 * fields, while a string URL is kept as provided. Use the `setUrlParam` helpers
 * to replace query values, and the `appendUrlParam` helpers when repeated keys
 * should be preserved. `FormData` bodies intentionally leave multipart boundary
 * headers to the runtime, so `setBody` removes explicit content headers for
 * them.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import type * as FileSystem from "../../FileSystem.ts"
import { dual } from "../../Function.ts"
import * as Inspectable from "../../Inspectable.ts"
import { stringOrRedacted } from "../../internal/redacted.ts"
import * as Option from "../../Option.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import type * as PlatformError from "../../PlatformError.ts"
import { hasProperty } from "../../Predicate.ts"
import { redact } from "../../Redactable.ts"
import type * as Redacted from "../../Redacted.ts"
import * as Result from "../../Result.ts"
import type * as Schema from "../../Schema.ts"
import type { ParseOptions } from "../../SchemaAST.ts"
import * as Stream from "../../Stream.ts"
import * as Headers from "./Headers.ts"
import * as HttpBody from "./HttpBody.ts"
import { hasBody, type HttpMethod } from "./HttpMethod.ts"
import * as UrlParams from "./UrlParams.ts"

const TypeId = "~effect/http/HttpClientRequest"

/**
 * Returns `true` when a value is an `HttpClientRequest`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isHttpClientRequest = (u: unknown): u is HttpClientRequest => hasProperty(u, TypeId)

/**
 * Immutable model of an outgoing HTTP client request, including its method, URL components, headers, and body.
 *
 * @category models
 * @since 4.0.0
 */
export interface HttpClientRequest extends Inspectable.Inspectable, Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly method: HttpMethod
  readonly url: string
  readonly urlParams: UrlParams.UrlParams
  readonly hash: Option.Option<string>
  readonly headers: Headers.Headers
  readonly body: HttpBody.HttpBody
}

/**
 * Options for constructing or modifying an `HttpClientRequest`.
 *
 * @category models
 * @since 4.0.0
 */
export interface Options {
  readonly method?: HttpMethod | undefined
  readonly url?: string | URL | undefined
  readonly urlParams?: UrlParams.Input | undefined
  readonly hash?: string | undefined
  readonly headers?: Headers.Input | undefined
  readonly body?: HttpBody.HttpBody | undefined
  readonly accept?: string | undefined
  readonly acceptJson?: boolean | undefined
}

/**
 * Namespace containing option types associated with `HttpClientRequest` construction.
 *
 * @since 4.0.0
 */
export declare namespace Options {
  /**
   * Request options that omit the method and URL for helpers that already receive those values separately.
   *
   * @category models
   * @since 4.0.0
   */
  export interface NoUrl extends Omit<Options, "method" | "url"> {}
}

const Proto = {
  [TypeId]: TypeId,
  ...Inspectable.BaseProto,
  toJSON(this: HttpClientRequest): unknown {
    return {
      _id: "HttpClientRequest",
      method: this.method,
      url: this.url,
      urlParams: this.urlParams,
      hash: this.hash,
      headers: redact(this.headers),
      body: this.body.toJSON()
    }
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * Constructs an `HttpClientRequest` from fully normalized request components.
 *
 * @category constructors
 * @since 4.0.0
 */
export function makeWith(
  method: HttpMethod,
  url: string,
  urlParams: UrlParams.UrlParams,
  hash: Option.Option<string>,
  headers: Headers.Headers,
  body: HttpBody.HttpBody
): HttpClientRequest {
  const self = Object.create(Proto)
  self.method = method
  self.url = url
  self.urlParams = urlParams
  self.hash = hash
  self.headers = headers
  self.body = body
  return self
}

/**
 * An empty `GET` request with no URL, query parameters, hash, headers, or body.
 *
 * @category constructors
 * @since 4.0.0
 */
export const empty: HttpClientRequest = makeWith(
  "GET",
  "",
  UrlParams.empty,
  Option.none(),
  Headers.empty,
  HttpBody.empty
)

/**
 * Creates a request constructor for the specified HTTP method.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <M extends HttpMethod>(
  method: M
) =>
(
  url: string | URL,
  options?: Options.NoUrl | undefined
): HttpClientRequest =>
  modify(empty, {
    method,
    url,
    ...(options ?? undefined)
  })

/**
 * Creates a `GET` request for the specified URL.
 *
 * @category constructors
 * @since 4.0.0
 */
export const get: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("GET")

/**
 * Creates a `POST` request for the specified URL.
 *
 * @category constructors
 * @since 4.0.0
 */
export const post: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("POST")

/**
 * Creates a `PATCH` request for the specified URL.
 *
 * @category constructors
 * @since 4.0.0
 */
export const patch: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("PATCH")

/**
 * Creates a `PUT` request for the specified URL.
 *
 * @category constructors
 * @since 4.0.0
 */
export const put: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("PUT")

const del: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("DELETE")

export {
  /**
   * Creates a `DELETE` request for the specified URL.
   *
   * @category constructors
   * @since 4.0.0
   */
  del as delete
}

/**
 * Creates a `HEAD` request for the specified URL.
 *
 * @category constructors
 * @since 4.0.0
 */
export const head: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("HEAD")

/**
 * Creates an `OPTIONS` request for the specified URL.
 *
 * @category constructors
 * @since 4.0.0
 */
export const options: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("OPTIONS")

/**
 * Creates a `TRACE` request for the specified URL.
 *
 * @category constructors
 * @since 4.0.0
 */
export const trace: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest = make("TRACE")

/**
 * Applies request options to an `HttpClientRequest`, returning a new request.
 *
 * @category combinators
 * @since 4.0.0
 */
export const modify: {
  (options: Options): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, options: Options): HttpClientRequest
} = dual(2, (self: HttpClientRequest, options: Options): HttpClientRequest => {
  let result = self

  if (options.method) {
    result = setMethod(result, options.method)
  }
  if (options.url) {
    result = setUrl(result, options.url)
  }
  if (options.headers) {
    result = setHeaders(result, options.headers)
  }
  if (options.urlParams) {
    result = setUrlParams(result, options.urlParams)
  }
  if (options.hash) {
    result = setHash(result, options.hash)
  }
  if (options.body) {
    result = setBody(result, options.body)
  }
  if (options.accept) {
    result = accept(result, options.accept)
  }
  if (options.acceptJson) {
    result = acceptJson(result)
  }

  return result
})

/**
 * Sets the HTTP method on a request, returning a new request.
 *
 * @category combinators
 * @since 4.0.0
 */
export const setMethod: {
  (method: HttpMethod): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, method: HttpMethod): HttpClientRequest
} = dual(
  2,
  (self: HttpClientRequest, method: HttpMethod): HttpClientRequest =>
    makeWith(method, self.url, self.urlParams, self.hash, self.headers, self.body)
)

/**
 * Sets a single request header, replacing any existing value for that header.
 *
 * @category combinators
 * @since 4.0.0
 */
export const setHeader: {
  (key: string, value: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, key: string, value: string): HttpClientRequest
} = dual(3, (self: HttpClientRequest, key: string, value: string): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    self.urlParams,
    self.hash,
    Headers.set(self.headers, key, value),
    self.body
  ))

/**
 * Sets multiple request headers from an input collection, replacing existing values with matching names.
 *
 * @category combinators
 * @since 4.0.0
 */
export const setHeaders: {
  (input: Headers.Input): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, input: Headers.Input): HttpClientRequest
} = dual(2, (self: HttpClientRequest, input: Headers.Input): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    self.urlParams,
    self.hash,
    Headers.setAll(self.headers, input),
    self.body
  ))

/**
 * Sets the `Authorization` header using HTTP Basic authentication credentials.
 *
 * @category combinators
 * @since 4.0.0
 */
export const basicAuth: {
  (
    username: string | Redacted.Redacted,
    password: string | Redacted.Redacted
  ): (self: HttpClientRequest) => HttpClientRequest
  (
    self: HttpClientRequest,
    username: string | Redacted.Redacted,
    password: string | Redacted.Redacted
  ): HttpClientRequest
} = dual(
  3,
  (
    self: HttpClientRequest,
    username: string | Redacted.Redacted,
    password: string | Redacted.Redacted
  ): HttpClientRequest =>
    setHeader(self, "Authorization", `Basic ${btoa(`${stringOrRedacted(username)}:${stringOrRedacted(password)}`)}`)
)

/**
 * Sets the `Authorization` header using a bearer token.
 *
 * @category combinators
 * @since 4.0.0
 */
export const bearerToken: {
  (token: string | Redacted.Redacted): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, token: string | Redacted.Redacted): HttpClientRequest
} = dual(
  2,
  (self: HttpClientRequest, token: string | Redacted.Redacted): HttpClientRequest =>
    setHeader(self, "Authorization", `Bearer ${stringOrRedacted(token)}`)
)

/**
 * Sets the `Accept` header to the specified media type.
 *
 * @category combinators
 * @since 4.0.0
 */
export const accept: {
  (mediaType: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, mediaType: string): HttpClientRequest
} = dual(2, (self: HttpClientRequest, mediaType: string): HttpClientRequest => setHeader(self, "Accept", mediaType))

/**
 * Sets the `Accept` header to `application/json`.
 *
 * @category combinators
 * @since 4.0.0
 */
export const acceptJson: (self: HttpClientRequest) => HttpClientRequest = accept("application/json")

/**
 * Sets the request URL. When given a `URL`, its search parameters and hash are extracted into the request's structured fields.
 *
 * @category combinators
 * @since 4.0.0
 */
export const setUrl: {
  (url: string | URL): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, url: string | URL): HttpClientRequest
} = dual(2, (self: HttpClientRequest, url: string | URL): HttpClientRequest => {
  if (typeof url === "string") {
    return makeWith(
      self.method,
      url,
      self.urlParams,
      self.hash,
      self.headers,
      self.body
    )
  }
  const clone = new URL(url.toString())
  const urlParams = UrlParams.fromInput(clone.searchParams)
  const hash = Option.fromNullishOr(clone.hash === "" ? undefined : clone.hash.slice(1))
  clone.search = ""
  clone.hash = ""
  return makeWith(
    self.method,
    clone.toString(),
    urlParams,
    hash,
    self.headers,
    self.body
  )
})

/**
 * Prepends a URL segment to the request URL, inserting or trimming one slash as needed.
 *
 * @category combinators
 * @since 4.0.0
 */
export const prependUrl: {
  (path: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, path: string): HttpClientRequest
} = dual(2, (self: HttpClientRequest, path: string): HttpClientRequest => {
  if (path === "") return self
  return makeWith(
    self.method,
    joinSegments(path, self.url),
    self.urlParams,
    self.hash,
    self.headers,
    self.body
  )
})

/**
 * Appends a URL segment to the request URL, inserting or trimming one slash as needed.
 *
 * @category combinators
 * @since 4.0.0
 */
export const appendUrl: {
  (path: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, path: string): HttpClientRequest
} = dual(2, (self: HttpClientRequest, path: string): HttpClientRequest => {
  if (path === "") return self
  return makeWith(
    self.method,
    joinSegments(self.url, path),
    self.urlParams,
    self.hash,
    self.headers,
    self.body
  )
})

const joinSegments = (first: string, second: string): string => {
  const endsWithSlash = first.endsWith("/")
  const startsWithSlash = second.startsWith("/")
  const needsTrim = endsWithSlash && startsWithSlash
  const needsSlash = !endsWithSlash && !startsWithSlash
  return needsTrim ?
    first + second.slice(1) :
    needsSlash ?
    first + "/" + second :
    first + second
}

/**
 * Updates the request URL by applying a function to the current URL string.
 *
 * @category combinators
 * @since 4.0.0
 */
export const updateUrl: {
  (f: (url: string) => string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, f: (url: string) => string): HttpClientRequest
} = dual(2, (self: HttpClientRequest, f: (url: string) => string): HttpClientRequest =>
  makeWith(
    self.method,
    f(self.url),
    self.urlParams,
    self.hash,
    self.headers,
    self.body
  ))

/**
 * Sets one query parameter, replacing existing values for that parameter name.
 *
 * @category combinators
 * @since 4.0.0
 */
export const setUrlParam: {
  (key: string, value: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, key: string, value: string): HttpClientRequest
} = dual(3, (self: HttpClientRequest, key: string, value: string): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    UrlParams.set(self.urlParams, key, value),
    self.hash,
    self.headers,
    self.body
  ))

/**
 * Sets query parameters from an input collection, replacing existing values for matching names.
 *
 * @category combinators
 * @since 4.0.0
 */
export const setUrlParams: {
  (input: UrlParams.Input): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest
} = dual(2, (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    UrlParams.setAll(self.urlParams, input),
    self.hash,
    self.headers,
    self.body
  ))

/**
 * Appends one query parameter value without removing existing values for the same name.
 *
 * @category combinators
 * @since 4.0.0
 */
export const appendUrlParam: {
  (key: string, value: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, key: string, value: string): HttpClientRequest
} = dual(3, (self: HttpClientRequest, key: string, value: string): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    UrlParams.append(self.urlParams, key, value),
    self.hash,
    self.headers,
    self.body
  ))

/**
 * Appends query parameters from an input collection without removing existing values for matching names.
 *
 * @category combinators
 * @since 4.0.0
 */
export const appendUrlParams: {
  (input: UrlParams.Input): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest
} = dual(2, (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    UrlParams.appendAll(self.urlParams, input),
    self.hash,
    self.headers,
    self.body
  ))

/**
 * Sets the URL fragment on a request without the leading `#`.
 *
 * @category combinators
 * @since 4.0.0
 */
export const setHash: {
  (hash: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, hash: string): HttpClientRequest
} = dual(2, (self: HttpClientRequest, hash: string): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    self.urlParams,
    Option.some(hash),
    self.headers,
    self.body
  ))

/**
 * Removes the URL fragment from a request.
 *
 * @category combinators
 * @since 4.0.0
 */
export const removeHash = (self: HttpClientRequest): HttpClientRequest =>
  makeWith(
    self.method,
    self.url,
    self.urlParams,
    Option.none(),
    self.headers,
    self.body
  )

/**
 * Sets the request body and updates `Content-Type` and `Content-Length` headers from the body metadata when available.
 *
 * @category combinators
 * @since 4.0.0
 */
export const setBody: {
  (body: HttpBody.HttpBody): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, body: HttpBody.HttpBody): HttpClientRequest
} = dual(2, (self: HttpClientRequest, body: HttpBody.HttpBody): HttpClientRequest => {
  let headers = self.headers
  if (body._tag === "Empty" || body._tag === "FormData") {
    headers = Headers.remove(Headers.remove(headers, "Content-Type"), "Content-length")
  } else {
    if (body.contentType) {
      headers = Headers.set(headers, "content-type", body.contentType)
    }
    if (body.contentLength !== undefined) {
      headers = Headers.set(headers, "content-length", body.contentLength.toString())
    }
  }
  return makeWith(
    self.method,
    self.url,
    self.urlParams,
    self.hash,
    headers,
    body
  )
})

/**
 * Sets a `Uint8Array` request body with an optional content type.
 *
 * @category combinators
 * @since 4.0.0
 */
export const bodyUint8Array: {
  (body: Uint8Array, contentType?: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, body: Uint8Array, contentType?: string): HttpClientRequest
} = dual(
  (args) => isHttpClientRequest(args[0]),
  (self: HttpClientRequest, body: Uint8Array, contentType?: string): HttpClientRequest =>
    setBody(self, HttpBody.uint8Array(body, contentType))
)

/**
 * Sets a text request body with an optional content type.
 *
 * @category combinators
 * @since 4.0.0
 */
export const bodyText: {
  (body: string, contentType?: string): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, body: string, contentType?: string): HttpClientRequest
} = dual(
  (args) => isHttpClientRequest(args[0]),
  (self: HttpClientRequest, body: string, contentType?: string): HttpClientRequest =>
    setBody(self, HttpBody.text(body, contentType))
)

/**
 * Encodes a value as a JSON request body and sets it on the request, failing with `HttpBodyError` if encoding fails.
 *
 * @category combinators
 * @since 4.0.0
 */
export const bodyJson: {
  (body: unknown): (self: HttpClientRequest) => Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError>
  (self: HttpClientRequest, body: unknown): Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError>
} = dual(
  2,
  (self: HttpClientRequest, body: unknown): Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError> =>
    Effect.map(HttpBody.json(body), (body) => setBody(self, body))
)

/**
 * Sets a JSON request body using unsafe JSON encoding, which may throw instead of failing in the Effect error channel.
 *
 * @category combinators
 * @since 4.0.0
 */
export const bodyJsonUnsafe: {
  (body: unknown): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, body: unknown): HttpClientRequest
} = dual(2, (self: HttpClientRequest, body: unknown): HttpClientRequest => setBody(self, HttpBody.jsonUnsafe(body)))

/**
 * Creates a schema-based JSON body encoder that sets the encoded value on a request.
 *
 * @category combinators
 * @since 4.0.0
 */
export const schemaBodyJson = <S extends Schema.Top>(
  schema: S,
  options?: ParseOptions | undefined
): {
  (
    body: S["Type"]
  ): (
    self: HttpClientRequest
  ) => Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError, S["EncodingServices"]>
  (
    self: HttpClientRequest,
    body: S["Type"]
  ): Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError, S["EncodingServices"]>
} => {
  const encode = HttpBody.jsonSchema(schema, options)
  return dual(
    2,
    (
      self: HttpClientRequest,
      body: unknown
    ): Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError, S["EncodingServices"]> =>
      Effect.map(encode(body), (body) => setBody(self, body))
  )
}

/**
 * Sets an `application/x-www-form-urlencoded` request body from URL parameter input.
 *
 * @category combinators
 * @since 4.0.0
 */
export const bodyUrlParams: {
  (input: UrlParams.Input): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest
} = dual(
  2,
  (self: HttpClientRequest, input: UrlParams.Input): HttpClientRequest =>
    setBody(self, HttpBody.urlParams(UrlParams.fromInput(input)))
)

/**
 * Sets a `FormData` request body.
 *
 * @category combinators
 * @since 4.0.0
 */
export const bodyFormData: {
  (body: FormData): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, body: FormData): HttpClientRequest
} = dual(2, (self: HttpClientRequest, body: FormData): HttpClientRequest => setBody(self, HttpBody.formData(body)))

/**
 * Creates a `FormData` request body from record-style entries and sets it on the request.
 *
 * @category combinators
 * @since 4.0.0
 */
export const bodyFormDataRecord: {
  (entries: HttpBody.FormDataInput): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, entries: HttpBody.FormDataInput): HttpClientRequest
} = dual(
  2,
  (self: HttpClientRequest, entries: HttpBody.FormDataInput): HttpClientRequest =>
    setBody(self, HttpBody.formDataRecord(entries))
)

/**
 * Sets a streaming `Uint8Array` request body with optional content type and content length metadata.
 *
 * @category combinators
 * @since 4.0.0
 */
export const bodyStream: {
  (
    body: Stream.Stream<Uint8Array, unknown>,
    options?: { readonly contentType?: string | undefined; readonly contentLength?: number | undefined } | undefined
  ): (self: HttpClientRequest) => HttpClientRequest
  (
    self: HttpClientRequest,
    body: Stream.Stream<Uint8Array, unknown>,
    options?: { readonly contentType?: string | undefined; readonly contentLength?: number | undefined } | undefined
  ): HttpClientRequest
} = dual(
  (args) => isHttpClientRequest(args[0]),
  (
    self: HttpClientRequest,
    body: Stream.Stream<Uint8Array, unknown>,
    options?: { readonly contentType?: string | undefined; readonly contentLength?: number | undefined } | undefined
  ): HttpClientRequest =>
    setBody(
      self,
      HttpBody.stream(body, options?.contentType, options?.contentLength)
    )
)

/**
 * Creates a file-backed request body from a filesystem path and sets it on the request.
 *
 * @category combinators
 * @since 4.0.0
 */
export const bodyFile: {
  (
    path: string,
    options?: {
      readonly bytesToRead?: FileSystem.SizeInput | undefined
      readonly chunkSize?: FileSystem.SizeInput | undefined
      readonly offset?: FileSystem.SizeInput | undefined
      readonly contentType?: string
    }
  ): (self: HttpClientRequest) => Effect.Effect<HttpClientRequest, PlatformError.PlatformError, FileSystem.FileSystem>
  (
    self: HttpClientRequest,
    path: string,
    options?: {
      readonly bytesToRead?: FileSystem.SizeInput | undefined
      readonly chunkSize?: FileSystem.SizeInput | undefined
      readonly offset?: FileSystem.SizeInput | undefined
      readonly contentType?: string
    }
  ): Effect.Effect<HttpClientRequest, PlatformError.PlatformError, FileSystem.FileSystem>
} = dual(
  (args) => isHttpClientRequest(args[0]),
  (
    self: HttpClientRequest,
    path: string,
    options?: {
      readonly bytesToRead?: FileSystem.SizeInput | undefined
      readonly chunkSize?: FileSystem.SizeInput | undefined
      readonly offset?: FileSystem.SizeInput | undefined
      readonly contentType?: string
    }
  ): Effect.Effect<HttpClientRequest, PlatformError.PlatformError, FileSystem.FileSystem> =>
    Effect.map(
      HttpBody.file(path, options),
      (body) => setBody(self, body)
    )
)

/**
 * Builds a `URL` from the request URL, query parameters, and hash, returning `Option.none()` if the URL is invalid.
 *
 * @category combinators
 * @since 4.0.0
 */
export function toUrl(self: HttpClientRequest): Option.Option<URL> {
  const r = UrlParams.makeUrl(self.url, self.urlParams, Option.getOrUndefined(self.hash))
  if (Result.isSuccess(r)) {
    return Option.some(r.success)
  }
  return Option.none()
}

/**
 * Converts a Web `Request` into an `HttpClientRequest`, preserving method, URL, headers, and supported request bodies.
 *
 * @category converting
 * @since 4.0.0
 */
export const fromWeb = (request: globalThis.Request): HttpClientRequest => {
  const method = request.method.toUpperCase() as HttpMethod
  return modify(empty, {
    method,
    url: new URL(request.url),
    headers: request.headers,
    body: fromWebBody(request, method)
  })
}

const fromWebBody = (request: globalThis.Request, method: HttpMethod): HttpBody.HttpBody => {
  if (!hasBody(method) || request.body === null) {
    return HttpBody.empty
  }
  return HttpBody.raw(request.body, {
    contentType: request.headers.get("content-type") ?? undefined,
    contentLength: parseContentLength(request.headers.get("content-length"))
  })
}

const parseContentLength = (contentLength: string | null): number | undefined => {
  if (contentLength === null) {
    return undefined
  }
  const parsed = Number.parseInt(contentLength, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Converts an `HttpClientRequest` safely to a Web `Request` as a `Result`, failing when the request URL is invalid.
 *
 * @category converting
 * @since 4.0.0
 */
export const toWebResult = (self: HttpClientRequest, options?: {
  readonly signal?: AbortSignal | undefined
  readonly context?: Context.Context<never> | undefined
}): Result.Result<Request, UrlParams.UrlParamsError> => {
  const url = UrlParams.makeUrl(self.url, self.urlParams, Option.getOrUndefined(self.hash))
  if (Result.isFailure(url)) {
    return Result.fail(url.failure)
  }
  const requestInit: RequestInit = {
    method: self.method,
    headers: self.headers
  }
  if (options?.signal) {
    requestInit.signal = options.signal
  }
  if (hasBody(self.method)) {
    switch (self.body._tag) {
      case "Empty": {
        break
      }
      case "Raw": {
        requestInit.body = self.body.body as any
        if (isReadableStream(self.body.body)) {
          ;(requestInit as any).duplex = "half"
        }
        break
      }
      case "Uint8Array": {
        requestInit.body = self.body.body as any
        break
      }
      case "FormData": {
        requestInit.body = self.body.formData
        break
      }
      case "Stream": {
        requestInit.body = Stream.toReadableStreamWith(self.body.stream, options?.context ?? Context.empty())
        ;(requestInit as any).duplex = "half"
        break
      }
    }
  }
  return Result.try({
    try: () => new Request(url.success, requestInit),
    catch: (cause) => new UrlParams.UrlParamsError({ cause })
  })
}

const isReadableStream = (u: unknown): u is ReadableStream<Uint8Array> =>
  typeof ReadableStream !== "undefined" && u instanceof ReadableStream

/**
 * Converts an `HttpClientRequest` to a Web `Request`, failing with `UrlParamsError` when the request URL is invalid.
 *
 * @category converting
 * @since 4.0.0
 */
export const toWeb = (self: HttpClientRequest, options?: {
  readonly signal?: AbortSignal | undefined
}): Effect.Effect<Request, UrlParams.UrlParamsError> =>
  Effect.contextWith((context) =>
    Effect.fromResult(toWebResult(self, {
      context: context,
      signal: options?.signal
    }))
  )
