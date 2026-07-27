/**
 * Attaches HTTP API metadata to Effect Schema values.
 *
 * This module is the schema-side bridge for HttpApi endpoint builders,
 * generated clients, and OpenAPI support. It does not define routes or perform
 * IO. Instead, the helpers annotate schemas so the surrounding HTTP API tooling
 * can choose response status codes, content types, body codecs, multipart
 * handling, and no-body response behavior.
 *
 * @since 4.0.0
 */
import { constVoid, type LazyArg } from "../../Function.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import * as SchemaTransformation from "../../SchemaTransformation.ts"
import * as Stream from "../../Stream.ts"
import type * as Sse from "../encoding/Sse.ts"
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
 * HTTP API body encoding metadata used by payloads and responses.
 *
 * @category models
 * @since 4.0.0
 */
export type Encoding = PayloadEncoding | ResponseEncoding

/**
 * HTTP API request payload encoding metadata.
 *
 * @category models
 * @since 4.0.0
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
 * HTTP API response body encoding metadata.
 *
 * @category models
 * @since 4.0.0
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

const StreamSchemaTypeId = "~effect/httpapi/HttpApiSchema/Stream"

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
export function status(code: number): {
  <S extends Schema.Top>(self: S): S["Rebuild"]
}
export function status(code: StatusLiteral): {
  <S extends Schema.Top>(self: S): S["Rebuild"]
}
export function status(code: number | StatusLiteral) {
  const statusCode = typeof code === "string" ? statusCodeByLiteral[code] : code
  return <S extends Schema.Top>(self: S): S["Rebuild"] => self.annotate({ httpApiStatus: statusCode })
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
export interface asNoContent<S extends Schema.Constraint> extends Schema.decodeTo<Schema.toType<S>, Schema.Void> {}

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
export function asNoContent<S extends Schema.Constraint>(options: {
  readonly decode: LazyArg<S["Type"]>
}) {
  return (self: S): asNoContent<S> => {
    return Schema.Void.pipe(
      Schema.decodeTo(
        Schema.toType(self),
        SchemaTransformation.transform({
          decode: options.decode,
          encode: constVoid
        })
      )
    )
  }
}

type StreamMode = "sse" | "uint8array"

/**
 * Mode describing whether an SSE stream emits full events or raw data values.
 *
 * @category models
 * @since 4.0.0
 */
export type StreamSseMode = "events" | "data"

/**
 * Schema for a Server-Sent Events success response.
 *
 * **Details**
 *
 * `events` describes successful application events emitted by the stream, and
 * `error` describes typed stream failures that will be encoded by later
 * endpoint/server/client integrations using the reserved failure event. If
 * `error` is omitted, it defaults to `Schema.Never`. When `StreamSse` is
 * constructed from `data`, handlers and clients expose raw data values while
 * the server and client still use an SSE event schema internally.
 *
 * **Gotchas**
 *
 * The client treats `effect/httpapi/stream/failure` as a stream failure only
 * when its decoded `data` is a `Cause`. If an event schema accepts that name
 * dynamically but decodes `data` to another value, the client emits it as an
 * application event. Endpoint construction rejects event schemas that declare
 * the reserved name statically.
 *
 * @category models
 * @since 4.0.0
 */
export interface StreamSse<
  Events extends Sse.EventCodec,
  Error extends Schema.Constraint,
  Value = Events["Type"]
> extends
  Schema.BottomLazy<
    SchemaAST.Declaration,
    StreamSse<Events, Error, Value>
  >
{
  readonly "Type": Stream.Stream<Value, Error["Type"], never>
  readonly "Encoded": Stream.Stream<Value, Error["Type"], never>
  readonly "DecodingServices": Events["DecodingServices"] | Error["DecodingServices"]
  readonly "EncodingServices": Events["EncodingServices"] | Error["EncodingServices"]
  readonly "Rebuild": StreamSse<Events, Error, Value>
  readonly "~type.make.in": Stream.Stream<Value, Error["Type"], never>
  readonly "~type.make": Stream.Stream<Value, Error["Type"], never>
  readonly "Iso": Stream.Stream<Value, Error["Type"], never>
  readonly [StreamSchemaTypeId]: typeof StreamSchemaTypeId
  readonly _tag: "StreamSse"
  readonly mode: "sse"
  readonly sseMode: StreamSseMode
  readonly contentType: string
  readonly events: Events
  readonly error: Error
  readonly "~Value"?: Value | undefined
}

/**
 * Event schema produced when {@link StreamSse} is constructed from a JSON data schema.
 *
 * @category models
 * @since 4.0.0
 */
export interface SseEventFromData<Data extends Schema.Constraint> extends
  Schema.ConstraintCodec<
    {
      readonly id: string | undefined
      readonly event: string
      readonly data: Data["Type"]
    },
    {
      readonly id?: string | undefined
      readonly event?: string | undefined
      readonly data: string
    },
    Data["DecodingServices"],
    Data["EncodingServices"]
  >
{}

/**
 * Schema for a streaming `Uint8Array` success response.
 *
 * **Details**
 *
 * This declaration stores the response content type for later endpoint,
 * server, client, and OpenAPI integrations. It is intentionally separate from
 * the buffered `asUint8Array` response encoding.
 *
 * @category models
 * @since 4.0.0
 */
export interface StreamUint8Array extends
  Schema.Bottom<
    Stream.Stream<Uint8Array, unknown, never>,
    Stream.Stream<Uint8Array, unknown, never>,
    never,
    never,
    SchemaAST.Declaration,
    StreamUint8Array
  >
{
  readonly "Rebuild": StreamUint8Array
  readonly [StreamSchemaTypeId]: typeof StreamSchemaTypeId
  readonly _tag: "StreamUint8Array"
  readonly mode: "uint8array"
  readonly contentType: string
}

/**
 * Schema for a streaming HTTP API success response.
 *
 * @category models
 * @since 4.0.0
 */
export type StreamSchema = StreamSse<Sse.EventCodec, Schema.Top, unknown> | StreamUint8Array

const streamSchema = Schema.declare(Stream.isStream)

/**
 * Creates a Server-Sent Events streaming success response schema.
 *
 * @category constructors
 * @since 4.0.0
 */
export const StreamSse: {
  <Events extends Sse.EventCodec, Error extends Schema.Constraint = Schema.Never>(options: {
    readonly contentType?: string | undefined
    readonly events: Events
    readonly error?: Error | undefined
  }): StreamSse<Events, Error, Events["Type"]>
  <Data extends Schema.Constraint, Error extends Schema.Constraint = Schema.Never>(options: {
    readonly contentType?: string | undefined
    readonly data: Data
    readonly error?: Error | undefined
  }): StreamSse<SseEventFromData<Data>, Error, Data["Type"]>
} = (options: {
  readonly contentType?: string | undefined
  readonly events?: Sse.EventCodec | undefined
  readonly data?: Schema.Constraint | undefined
  readonly error?: Schema.Constraint | undefined
}): StreamSse<Sse.EventCodec, Schema.Top, unknown> => {
  const events = options.events ?? (options.data === undefined ? undefined : Schema.Struct({
    id: Schema.UndefinedOr(Schema.String),
    event: Schema.String,
    data: Schema.fromJsonString(options.data)
  }))
  if (events === undefined) {
    throw new Error("StreamSse requires either an events schema or a data schema")
  }
  return Schema.make<StreamSse<Sse.EventCodec, Schema.Top, unknown>>(streamSchema.ast, {
    [StreamSchemaTypeId]: StreamSchemaTypeId,
    _tag: "StreamSse",
    mode: "sse",
    sseMode: options.events === undefined ? "data" : "events",
    contentType: options.contentType ?? defaultStreamContentType("sse"),
    events,
    error: options.error ?? Schema.Never
  })
}

/**
 * Creates a streaming `Uint8Array` success response schema.
 *
 * @category constructors
 * @since 4.0.0
 */
export const StreamUint8Array = (options?: {
  readonly contentType?: string | undefined
}): StreamUint8Array =>
  Schema.make<StreamUint8Array>(streamSchema.ast, {
    [StreamSchemaTypeId]: StreamSchemaTypeId,
    _tag: "StreamUint8Array",
    mode: "uint8array",
    contentType: options?.contentType ?? defaultStreamContentType("uint8array")
  })

/** @internal */
export const isStreamSchema = (u: unknown): u is StreamSchema =>
  Schema.isSchema(u) && Predicate.hasProperty(u, StreamSchemaTypeId)

/** @internal */
export const isStreamSse = (u: unknown): u is StreamSse<Sse.EventCodec, Schema.Top, unknown> =>
  isStreamSchema(u) && u._tag === "StreamSse"

/** @internal */
export const isStreamUint8Array = (u: unknown): u is StreamUint8Array =>
  isStreamSchema(u) && u._tag === "StreamUint8Array"

function defaultStreamContentType(mode: StreamMode): string {
  switch (mode) {
    case "sse":
      return "text/event-stream"
    case "uint8array":
      return "application/octet-stream"
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
export const isNoContent = (ast: SchemaAST.AST): boolean => {
  if (SchemaAST.isVoid(ast)) return true
  const encoded = SchemaAST.toEncoded(ast)
  if (SchemaAST.isVoid(encoded)) return true
  const target = ast.encoding?.[0].to
  if (target === undefined) return false
  return SchemaAST.isVoid(target)
}

const resolveHttpApiEncoding = SchemaAST.resolveAt<Encoding>("~httpApiEncoding")

const resolveHttpApiStatus = SchemaAST.resolveAt<number>("httpApiStatus")

const defaultJsonEncoding: Encoding = {
  _tag: "Json",
  contentType: "application/json"
}
const defaultUrlEncodedEncoding: Encoding = {
  _tag: "FormUrlEncoded",
  contentType: "application/x-www-form-urlencoded"
}

function getEncoding(ast: SchemaAST.AST): Encoding {
  return resolveHttpApiEncoding(ast) ?? defaultJsonEncoding
}

/** @internal */
export function getPayloadEncoding(ast: SchemaAST.AST, method: HttpMethod): PayloadEncoding {
  const encoding = resolveHttpApiEncoding(ast)
  if (encoding) return encoding
  return hasBody(method) ? defaultJsonEncoding : defaultUrlEncodedEncoding
}

/** @internal */
export function getResponseEncoding(ast: SchemaAST.AST): ResponseEncoding {
  const out = getEncoding(ast)
  if (out._tag === "Multipart") {
    throw new Error("Multipart is not supported in response")
  }
  return out
}

/** @internal */
export function getStatusSuccess(self: SchemaAST.AST): number {
  return resolveHttpApiStatus(self) ?? 200
}

/** @internal */
export function getStatusStream(self: StreamSchema): number {
  return getStatusSuccess(self.ast)
}

/** @internal */
export function getStatusError(self: SchemaAST.AST): number {
  return resolveHttpApiStatus(self) ?? 500
}
