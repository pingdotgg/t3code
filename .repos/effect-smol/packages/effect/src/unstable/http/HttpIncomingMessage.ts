/**
 * Shared utilities for reading and decoding incoming HTTP messages.
 *
 * `HttpIncomingMessage` is the common body-and-header surface used by HTTP
 * server requests and client responses. It keeps transport-specific metadata in
 * the surrounding request and response modules while this module focuses on
 * headers, optional remote address information, byte streams, buffered body
 * views, and schema decoders for JSON bodies, URL-encoded bodies, and headers.
 *
 * Use these helpers in middleware, route handlers, client response processing,
 * and adapters when code should work with any incoming message instead of a
 * concrete request or response type. Body access is effectful because reading,
 * parsing, and decoding can fail; use `stream` when bytes should stay
 * streaming, and use `text`, `json`, `urlParamsBody`, or `arrayBuffer` when a
 * buffered view is appropriate. Some runtimes expose bodies as one-shot Web
 * streams, so prefer one body representation per message and let each
 * implementation's cached accessors handle repeated reads where available.
 *
 * Headers use the HTTP `Headers` module's lowercase, single-value map, so
 * repeated values may already have been combined or normalized by the adapter.
 * Decode headers with `schemaHeaders` when their shape matters. For form
 * bodies, `urlParamsBody` handles URL-encoded payloads; multipart support lives
 * on `HttpServerRequest`, with `MaxBodySize` providing the shared limit
 * reference used by multipart parsing.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import type * as FileSystem from "../../FileSystem.ts"
import type * as Inspectable from "../../Inspectable.ts"
import type * as Option from "../../Option.ts"
import { hasProperty } from "../../Predicate.ts"
import { redact } from "../../Redactable.ts"
import * as Schema from "../../Schema.ts"
import type { ParseOptions } from "../../SchemaAST.ts"
import type * as Stream from "../../Stream.ts"
import type * as Headers from "./Headers.ts"
import * as UrlParams from "./UrlParams.ts"

/**
 * Type identifier for `HttpIncomingMessage` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId = "~effect/http/HttpIncomingMessage"

/**
 * Returns `true` when a value is an `HttpIncomingMessage`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isHttpIncomingMessage = (u: unknown): u is HttpIncomingMessage => hasProperty(u, TypeId)

/**
 * Common model for incoming HTTP messages, with headers, remote address, and effectful body accessors.
 *
 * @category models
 * @since 4.0.0
 */
export interface HttpIncomingMessage<E = unknown> extends Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId
  readonly headers: Headers.Headers
  readonly remoteAddress: Option.Option<string>
  readonly json: Effect.Effect<Schema.Json, E>
  readonly text: Effect.Effect<string, E>
  readonly urlParamsBody: Effect.Effect<UrlParams.UrlParams, E>
  readonly arrayBuffer: Effect.Effect<ArrayBuffer, E>
  readonly stream: Stream.Stream<Uint8Array, E>
}

/**
 * Creates a decoder that reads an incoming message's JSON body and decodes it with the supplied schema.
 *
 * @category schemas
 * @since 4.0.0
 */
export const schemaBodyJson = <S extends Schema.Top>(schema: S, options?: ParseOptions | undefined) => {
  const decode = Schema.decodeEffect(Schema.toCodecJson(schema))
  return <E>(
    self: HttpIncomingMessage<E>
  ): Effect.Effect<S["Type"], E | Schema.SchemaError, S["DecodingServices"]> =>
    Effect.flatMap(self.json, (u) => decode(u, options))
}

/**
 * Creates a decoder that reads an incoming message's URL-encoded body parameters and decodes them with the supplied schema.
 *
 * @category schemas
 * @since 4.0.0
 */
export const schemaBodyUrlParams = <
  A,
  I extends Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
  RD,
  RE
>(
  schema: Schema.Codec<A, I, RD, RE>,
  options?: ParseOptions | undefined
) => {
  const decode = UrlParams.schemaRecord.pipe(
    Schema.decodeTo(schema),
    Schema.decodeEffect
  )
  return <E>(self: HttpIncomingMessage<E>): Effect.Effect<A, E | Schema.SchemaError, RD> =>
    Effect.flatMap(self.urlParamsBody, (u) => decode(u, options))
}

/**
 * Creates a decoder that validates and decodes an incoming message's headers with the supplied schema.
 *
 * @category schemas
 * @since 4.0.0
 */
export const schemaHeaders = <A, I extends Readonly<Record<string, string | undefined>>, RD, RE>(
  schema: Schema.Codec<A, I, RD, RE>,
  options?: ParseOptions | undefined
) => {
  const decode = Schema.decodeUnknownEffect(schema)
  return <E>(self: HttpIncomingMessage<E>): Effect.Effect<A, Schema.SchemaError, RD> => decode(self.headers, options)
}

/**
 * Context reference for the optional maximum size allowed when reading an incoming message body.
 *
 * @category references
 * @since 4.0.0
 */
export const MaxBodySize = Context.Reference<FileSystem.Size | undefined>(
  "effect/http/HttpIncomingMessage/MaxBodySize",
  { defaultValue: () => undefined }
)

/**
 * Builds an inspectable object for an incoming message, redacting headers and including a synchronously readable JSON or text body when available.
 *
 * @category converting
 * @since 4.0.0
 */
export const inspect = <E>(self: HttpIncomingMessage<E>, that: object): object => {
  const contentType = self.headers["content-type"] ?? ""
  let body: unknown
  if (contentType.includes("application/json")) {
    try {
      body = Effect.runSync(self.json)
      // oxlint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_) {
      //
    }
  } else if (contentType.includes("text/") || contentType.includes("urlencoded")) {
    try {
      body = Effect.runSync(self.text)
      // oxlint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_) {
      //
    }
  }
  const obj: any = {
    ...that,
    headers: redact(self.headers),
    remoteAddress: self.remoteAddress
  }
  if (body !== undefined) {
    obj.body = body
  }
  return obj
}
