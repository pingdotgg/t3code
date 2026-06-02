/**
 * Attaches HTTP API metadata to Effect Schema values.
 *
 * This module is the schema-side bridge for HttpApi endpoint builders,
 * generated clients, and OpenAPI support. It does not define routes or perform
 * IO. Instead, the helpers annotate schemas so the surrounding HTTP API tooling
 * can choose response status codes, content types, body codecs, multipart
 * handling, and no-body response behavior.
 *
 * **Mental model**
 *
 * Keep the `Schema` as the source of validation and transformation, then add
 * HTTP-specific annotations with helpers such as {@link status}, {@link asJson},
 * {@link asMultipart}, and {@link asNoContent}. The same annotated schema can be
 * read later by server builders, clients, and OpenAPI generation.
 *
 * **Common tasks**
 *
 * Use {@link status}, {@link NoContent}, {@link Created}, {@link Accepted}, or
 * {@link Empty} to describe response statuses. Use {@link asFormUrlEncoded},
 * {@link asText}, {@link asUint8Array}, or {@link asJson} to override the
 * default JSON encoding. Use {@link asMultipart} or
 * {@link asMultipartStream} for multipart request payloads. Use
 * {@link asNoContent} when the wire response has no body but the client should
 * decode a useful value.
 *
 * **Gotchas**
 *
 * {@link status} only stores an annotation: unannotated success responses
 * default to `200`, and unannotated error responses default to `500` when the
 * surrounding HttpApi context interprets them. Missing body and response
 * encodings default to JSON, while payload schemas for methods without request
 * bodies fall back to form-url-encoded metadata. Multipart encodings are
 * payload-only, and response multipart is rejected when response encoding is
 * resolved.
 *
 * **See also**
 *
 * `HttpApiEndpoint` for route contracts that consume these annotations and
 * `HttpApi` for reflection over status and encoding metadata.
 *
 * @since 4.0.0
 */
import { constVoid, type LazyArg } from "../../Function.ts"
import * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import * as Transformation from "../../SchemaTransformation.ts"
import { hasBody, type HttpMethod } from "../http/HttpMethod.ts"
import type * as Multipart_ from "../http/Multipart.ts"

declare module "../../Schema.ts" {
  namespace Annotations {
    interface Augment {
      readonly httpApiStatus?: number | undefined
      /**
       * The encoding of the payload or response.
       * This is kept internal because encodings are only exposed through the `as*` functions.
       * @internal
       */
      readonly "~httpApiEncoding"?: Encoding | undefined
    }
  }
}

/**
 * @internal
 */
export type Encoding = PayloadEncoding | ResponseEncoding

/**
 * Encodings for payloads
 * @internal
 */
export type PayloadEncoding =
  | {
    readonly _tag: "Multipart"
    readonly mode: "buffered" | "stream"
    readonly contentType: string
    readonly limits?: Multipart_.withLimits.Options | undefined
  }
  | {
    readonly _tag: "Json" | "FormUrlEncoded" | "Uint8Array" | "Text"
    readonly contentType: string
  }

/**
 * Encodings for responses
 * @internal
 */
export type ResponseEncoding = {
  readonly _tag: "Json" | "FormUrlEncoded" | "Uint8Array" | "Text"
  readonly contentType: string
}

const statusCodeByLiteral = {
  Continue: 100,
  SwitchingProtocols: 101,
  Processing: 102,
  EarlyHints: 103,
  OK: 200,
  Ok: 200,
  Created: 201,
  Accepted: 202,
  NonAuthoritativeInformation: 203,
  NoContent: 204,
  ResetContent: 205,
  PartialContent: 206,
  MultiStatus: 207,
  AlreadyReported: 208,
  ImUsed: 226,
  MultipleChoices: 300,
  MovedPermanently: 301,
  Found: 302,
  SeeOther: 303,
  NotModified: 304,
  TemporaryRedirect: 307,
  PermanentRedirect: 308,
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  NotAcceptable: 406,
  ProxyAuthenticationRequired: 407,
  RequestTimeout: 408,
  Conflict: 409,
  Gone: 410,
  LengthRequired: 411,
  PreconditionFailed: 412,
  PayloadTooLarge: 413,
  UriTooLong: 414,
  UnsupportedMediaType: 415,
  RangeNotSatisfiable: 416,
  ExpectationFailed: 417,
  ImATeapot: 418,
  MisdirectedRequest: 421,
  UnprocessableEntity: 422,
  Locked: 423,
  FailedDependency: 424,
  TooEarly: 425,
  UpgradeRequired: 426,
  PreconditionRequired: 428,
  TooManyRequests: 429,
  RequestHeaderFieldsTooLarge: 431,
  UnavailableForLegalReasons: 451,
  InternalServerError: 500,
  NotImplemented: 501,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
  HttpVersionNotSupported: 505,
  VariantAlsoNegotiates: 506,
  InsufficientStorage: 507,
  LoopDetected: 508,
  NotExtended: 510,
  NetworkAuthenticationRequired: 511
} as const

/**
 * Common HTTP status code literals accepted by {@link status}.
 *
 * @category status
 * @since 4.0.0
 */
export type StatusLiteral = keyof typeof statusCodeByLiteral

/**
 * Sets the HTTP status code of a schema.
 *
 * **Details**
 *
 * This is equivalent to calling `.annotate({ httpApiStatus: code })` on the
 * schema. You can pass either a numeric status code (for example, `201`) or a
 * common literal name (for example, `"Created"`).
 *
 * @category status
 * @since 4.0.0
 */
export function status(code: number): <S extends Schema.Top>(self: S) => S["Rebuild"]
export function status(code: StatusLiteral): <S extends Schema.Top>(self: S) => S["Rebuild"]
export function status(code: number | StatusLiteral) {
  const statusCode = typeof code === "string" ? statusCodeByLiteral[code] : code
  return <S extends Schema.Top>(self: S): S["Rebuild"] => {
    return self.annotate({ httpApiStatus: statusCode })
  }
}

/**
 * Creates a void schema with the given HTTP status code.
 * This is used to represent empty responses with a specific status code.
 *
 * @see {@link NoContent} for the predefined 204 no content schema.
 *
 * @category Empty
 * @since 4.0.0
 */
export const Empty = (code: number): Schema.Void => Schema.Void.pipe(status(code))

/**
 * Type of the `NoContent` schema, a void schema annotated with HTTP status code 204.
 *
 * @category models
 * @since 4.0.0
 */
export interface NoContent extends Schema.Void {}

/**
 * Schema for empty HTTP responses with status code 204.
 *
 * @category Empty
 * @since 4.0.0
 */
export const NoContent: NoContent = Empty(204)

/**
 * Type of the `Created` schema, a void schema annotated with HTTP status code 201.
 *
 * @category models
 * @since 4.0.0
 */
export interface Created extends Schema.Void {}

/**
 * Schema for empty HTTP responses with status code 201.
 *
 * @category Empty
 * @since 4.0.0
 */
export const Created: Created = Empty(201)

/**
 * Type of the `Accepted` schema, a void schema annotated with HTTP status code 202.
 *
 * @category models
 * @since 4.0.0
 */
export interface Accepted extends Schema.Void {}

/**
 * Schema for empty HTTP responses with status code 202.
 *
 * @category Empty
 * @since 4.0.0
 */
export const Accepted: Accepted = Empty(202)

/**
 * Schema type returned by `asNoContent`, encoding as `void` while decoding to the original schema type.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface asNoContent<S extends Schema.Top> extends Schema.decodeTo<Schema.toType<S>, Schema.Void> {}

/**
 * Marks a schema as a no-content response while preserving a decoded client value.
 *
 * **Details**
 *
 * The server encodes the response as `void`; generated clients call `decode` to
 * produce the schema's decoded value when the response has no body.
 *
 * @see {@link NoContent} for a void schema with the status code 204.
 * @see {@link Empty} for creating a void schema with a specific status code.
 *
 * @category encoding
 * @since 4.0.0
 */
export function asNoContent<S extends Schema.Top>(options: {
  readonly decode: LazyArg<S["Type"]>
}) {
  return (self: S): asNoContent<S> => {
    return Schema.Void.pipe(
      Schema.decodeTo(
        Schema.toType(self),
        Transformation.transform({
          decode: options.decode,
          encode: constVoid
        })
      )
    )
  }
}

/**
 * Runtime brand key used to mark schemas as buffered multipart payloads.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const MultipartTypeId = "~effect/httpapi/HttpApiSchema/Multipart"

/**
 * Type-level brand identifier used by `asMultipart`.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type MultipartTypeId = typeof MultipartTypeId

/**
 * Schema type returned by `asMultipart` for buffered multipart payloads.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface asMultipart<S extends Schema.Top> extends Schema.brand<S["Rebuild"], MultipartTypeId> {}

/**
 * Marks a schema as a multipart payload.
 *
 * @see {@link asMultipartStream} for a multipart stream payload.
 *
 * @category encoding
 * @since 4.0.0
 */
export function asMultipart(options?: Multipart_.withLimits.Options) {
  return <S extends Schema.Top>(self: S): asMultipart<S> =>
    self.pipe(Schema.brand(MultipartTypeId)).annotate({
      "~httpApiEncoding": {
        _tag: "Multipart",
        mode: "buffered",
        contentType: defaultContentType("Multipart"),
        limits: options
      }
    })
}

/**
 * Runtime brand key used to mark schemas as streaming multipart payloads.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const MultipartStreamTypeId = "~effect/httpapi/HttpApiSchema/MultipartStream"

/**
 * Type-level brand identifier used by `asMultipartStream`.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type MultipartStreamTypeId = typeof MultipartStreamTypeId

/**
 * Schema type returned by `asMultipartStream` for streaming multipart payloads.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface asMultipartStream<S extends Schema.Top> extends Schema.brand<S["Rebuild"], MultipartStreamTypeId> {}

/**
 * Marks a schema as a multipart stream payload.
 *
 * @see {@link asMultipart} for a buffered multipart payload.
 *
 * @category encoding
 * @since 4.0.0
 */
export function asMultipartStream(options?: Multipart_.withLimits.Options) {
  return <S extends Schema.Top>(self: S): asMultipartStream<S> =>
    self.pipe(Schema.brand(MultipartStreamTypeId)).annotate({
      "~httpApiEncoding": {
        _tag: "Multipart",
        mode: "stream",
        contentType: defaultContentType("Multipart"),
        limits: options
      }
    })
}

function asNonMultipartEncoding<S extends Schema.Top>(self: S, options: {
  readonly _tag: "Json" | "FormUrlEncoded" | "Uint8Array" | "Text"
  readonly contentType?: string | undefined
}): S["Rebuild"] {
  return self.annotate({
    "~httpApiEncoding": {
      _tag: options._tag,
      contentType: options.contentType ?? defaultContentType(options._tag)
    }
  })
}

function defaultContentType(_tag: Encoding["_tag"]): string {
  switch (_tag) {
    case "Multipart":
      return "multipart/form-data"
    case "Json":
      return "application/json"
    case "FormUrlEncoded":
      return "application/x-www-form-urlencoded"
    case "Uint8Array":
      return "application/octet-stream"
    case "Text":
      return "text/plain"
  }
}

/**
 * Marks a schema as a JSON payload / response.
 *
 * @category encoding
 * @since 4.0.0
 */
export function asJson(options?: {
  readonly contentType?: string
}) {
  return <S extends Schema.Top>(self: S) => asNonMultipartEncoding(self, { _tag: "Json", ...options })
}

/**
 * Marks a schema as an `application/x-www-form-urlencoded` payload or response.
 *
 * **Details**
 *
 * The schema's encoded side must be a record of strings.
 *
 * @category encoding
 * @since 4.0.0
 */
export function asFormUrlEncoded(options?: {
  readonly contentType?: string
}) {
  return <S extends Schema.Top>(
    self: S
  ) => asNonMultipartEncoding(self, { _tag: "FormUrlEncoded", ...options })
}

/**
 * Marks a schema as a text payload / response.
 *
 * **Details**
 *
 * The schema encoded side must be a string.
 *
 * @category encoding
 * @since 4.0.0
 */
export function asText(options?: {
  readonly contentType?: string
}) {
  return <S extends Schema.Top & { readonly Encoded: string }>(self: S) =>
    asNonMultipartEncoding(self, { _tag: "Text", ...options })
}

/**
 * Marks a schema as a binary payload / response.
 *
 * **Details**
 *
 * The schema encoded side must be a `Uint8Array`.
 *
 * @category encoding
 * @since 4.0.0
 */
export function asUint8Array(options?: {
  readonly contentType?: string
}) {
  return <S extends Schema.Top & { readonly Encoded: Uint8Array }>(self: S) =>
    asNonMultipartEncoding(self, { _tag: "Uint8Array", ...options })
}
/**
 * Returns `true` when a schema AST represents a no-content response.
 *
 * **Details**
 *
 * The check succeeds for direct `void` schemas and schemas whose encoded or
 * transformation target is `void`.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isNoContent = (ast: AST.AST): boolean => {
  if (AST.isVoid(ast)) return true
  const encoded = AST.toEncoded(ast)
  if (AST.isVoid(encoded)) return true
  const target = ast.encoding?.[0].to
  if (target === undefined) return false
  return AST.isVoid(target)
}

const resolveHttpApiEncoding = AST.resolveAt<Encoding>("~httpApiEncoding")

const resolveHttpApiStatus = AST.resolveAt<number>("httpApiStatus")

const defaultJsonEncoding: Encoding = {
  _tag: "Json",
  contentType: "application/json"
}
const defaultUrlEncodedEncoding: Encoding = {
  _tag: "FormUrlEncoded",
  contentType: "application/x-www-form-urlencoded"
}

function getEncoding(ast: AST.AST): Encoding {
  return resolveHttpApiEncoding(ast) ?? defaultJsonEncoding
}

/** @internal */
export function getPayloadEncoding(ast: AST.AST, method: HttpMethod): PayloadEncoding {
  const encoding = resolveHttpApiEncoding(ast)
  if (encoding) return encoding
  return hasBody(method) ? defaultJsonEncoding : defaultUrlEncodedEncoding
}

/** @internal */
export function getResponseEncoding(ast: AST.AST): ResponseEncoding {
  const out = getEncoding(ast)
  if (out._tag === "Multipart") {
    throw new Error("Multipart is not supported in response")
  }
  return out
}

/** @internal */
export function getStatusSuccess(self: AST.AST): number {
  return resolveHttpApiStatus(self) ?? 200
}

/** @internal */
export function getStatusError(self: AST.AST): number {
  return resolveHttpApiStatus(self) ?? 500
}
