/**
 * Describes the body attached to outgoing HTTP requests and server responses.
 *
 * `HttpBody` is the transport-facing representation used by the HTTP modules
 * before a platform adapter turns a request or response into a concrete Web,
 * Node, or other runtime value. Each body variant carries the payload plus the
 * metadata an adapter can safely know ahead of time, such as `contentType` and
 * `contentLength`.
 *
 * **Mental model**
 *
 * - {@link empty} represents an absent body.
 * - {@link uint8Array}, {@link text}, {@link jsonUnsafe}, {@link json}, and
 *   {@link urlParams} build in-memory byte bodies with content metadata.
 * - {@link formData} and {@link formDataRecord} keep multipart data as
 *   `FormData` so the runtime can generate the boundary.
 * - {@link stream} represents a stream of `Uint8Array` chunks and may omit the
 *   content length when the final size is not known.
 * - {@link raw} is the escape hatch for platform-specific body values that an
 *   adapter already knows how to send.
 *
 * **Common tasks**
 *
 * - Send text, bytes, JSON, URL-encoded data, multipart forms, or files.
 * - Use {@link json} or {@link jsonSchema} when JSON encoding failures should
 *   be represented as `HttpBodyError` values.
 * - Use {@link file} or {@link fileFromInfo} when file metadata should become
 *   `contentType` / `contentLength` metadata for the adapter.
 * - Use {@link isHttpBody} when accepting unknown values at an integration
 *   boundary.
 *
 * **Gotchas**
 *
 * - {@link jsonUnsafe} calls `JSON.stringify` directly and can throw; prefer
 *   {@link json} in effectful code.
 * - `FormData` bodies intentionally leave `contentType` unset because setting a
 *   multipart header without the generated boundary produces invalid requests.
 * - Stream bodies may not have a `contentLength`; code that requires one must
 *   provide it explicitly when constructing the stream body.
 *
 * **Example** (Creating common body variants)
 *
 * ```ts
 * import { HttpBody, UrlParams } from "effect/unstable/http"
 * import * as assert from "node:assert"
 *
 * const textBody = HttpBody.text("hello")
 * const jsonBody = HttpBody.jsonUnsafe({ name: "Ada" })
 * const formBody = HttpBody.urlParams(UrlParams.fromInput({ q: "effect" }))
 *
 * assert.equal(textBody.contentType, "text/plain")
 * assert.equal(jsonBody.contentType, "application/json")
 * assert.equal(formBody.contentType, "application/x-www-form-urlencoded")
 * ```
 *
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as FileSystem from "../../FileSystem.ts"
import { format } from "../../Formatter.ts"
import * as Inspectable from "../../Inspectable.ts"
import type * as PlatformError from "../../PlatformError.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import type { ParseOptions } from "../../SchemaAST.ts"
import type { Issue } from "../../SchemaIssue.ts"
import * as Parser from "../../SchemaParser.ts"
import type * as Stream_ from "../../Stream.ts"
import * as UrlParams from "./UrlParams.ts"

const TypeId = "~effect/http/HttpBody"

/**
 * Returns `true` if the provided value is an `HttpBody`.
 *
 * @category refinements
 * @since 4.0.0
 */
export const isHttpBody = (u: unknown): u is HttpBody => Predicate.hasProperty(u, TypeId)

/**
 * Represents an HTTP request body.
 *
 * **Details**
 *
 * Supported variants include empty bodies, raw bodies, byte arrays, `FormData`, and streams of bytes.
 *
 * @category models
 * @since 4.0.0
 */
export type HttpBody = Empty | Raw | Uint8Array | FormData | Stream

/**
 * Namespace containing type-level members associated with `HttpBody`.
 *
 * @since 4.0.0
 */
export declare namespace HttpBody {
  /**
   * Common protocol implemented by all HTTP body variants.
   *
   * **Details**
   *
   * It carries the variant tag plus optional `contentType` and `contentLength` metadata.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Proto extends Inspectable.Inspectable {
    readonly [TypeId]: typeof TypeId
    readonly _tag: string
    readonly contentType?: string | undefined
    readonly contentLength?: number | undefined
  }

  /**
   * Minimal Web `File`-like shape used by HTTP helpers that need file metadata.
   *
   * @category models
   * @since 4.0.0
   */
  export interface FileLike {
    readonly name: string
    readonly lastModified: number
    readonly size: number
    readonly stream: () => unknown
    readonly type: string
  }
}

const HttpBodyErrorTypeId = "~effect/http/HttpBody/HttpBodyError"

/**
 * Error produced while constructing an HTTP body from JSON or schema-encoded input.
 *
 * @category errors
 * @since 4.0.0
 */
export class HttpBodyError extends Data.TaggedError("HttpBodyError")<{
  readonly reason: ErrorReason
  readonly cause?: unknown
}> {
  /**
   * Marks this value as an HTTP body error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [HttpBodyErrorTypeId] = HttpBodyErrorTypeId
}

/**
 * Reason for an `HttpBodyError`.
 *
 * **Details**
 *
 * `JsonError` represents a `JSON.stringify` failure; `SchemaError` represents a schema encoding issue.
 *
 * @category errors
 * @since 4.0.0
 */
export type ErrorReason = {
  readonly _tag: "JsonError"
} | {
  readonly _tag: "SchemaError"
  readonly issue: Issue
}

abstract class Proto implements HttpBody.Proto {
  readonly [TypeId]: typeof TypeId
  abstract readonly _tag: string
  constructor() {
    this[TypeId] = TypeId
  }
  abstract toJSON(): unknown
  [Inspectable.NodeInspectSymbol](): unknown {
    return this.toJSON()
  }
  toString(): string {
    return format(this, { ignoreToString: true })
  }
}

/**
 * HTTP body variant representing the absence of request content.
 *
 * @category models
 * @since 4.0.0
 */
export class Empty extends Proto {
  readonly _tag = "Empty"
  toJSON(): unknown {
    return {
      _id: "effect/HttpBody",
      _tag: "Empty"
    }
  }
}

/**
 * Provides the singleton empty HTTP body.
 *
 * **When to use**
 *
 * Use when you need an HTTP body value that represents no body content.
 *
 * @category constants
 * @since 4.0.0
 */
export const empty: Empty = new Empty()

/**
 * HTTP body variant containing an arbitrary runtime body value with optional content metadata.
 *
 * @category models
 * @since 4.0.0
 */
export class Raw extends Proto {
  readonly _tag = "Raw"
  readonly body: unknown
  readonly contentType: string | undefined
  readonly contentLength: number | undefined

  constructor(
    body: unknown,
    contentType: string | undefined,
    contentLength: number | undefined
  ) {
    super()
    this.body = body
    this.contentType = contentType
    this.contentLength = contentLength
  }
  toJSON(): unknown {
    return {
      _id: "effect/HttpBody",
      _tag: "Raw",
      body: this.body,
      contentType: this.contentType,
      contentLength: this.contentLength
    }
  }
}

/**
 * Creates a raw HTTP body from an arbitrary value and optional `contentType` and `contentLength` metadata.
 *
 * @category constructors
 * @since 4.0.0
 */
export const raw = (
  body: unknown,
  options?: {
    readonly contentType?: string | undefined
    readonly contentLength?: number | undefined
  } | undefined
): Raw => new Raw(body, options?.contentType, options?.contentLength)

/**
 * HTTP body variant backed by a `Uint8Array`.
 *
 * **Details**
 *
 * It stores the bytes, content type, and byte length.
 *
 * @category models
 * @since 4.0.0
 */
export class Uint8Array extends Proto {
  readonly _tag = "Uint8Array"
  readonly body: globalThis.Uint8Array
  readonly contentType: string
  readonly contentLength: number

  constructor(
    body: globalThis.Uint8Array,
    contentType: string,
    contentLength: number
  ) {
    super()
    this.body = body
    this.contentType = contentType
    this.contentLength = contentLength
  }
  toJSON(): unknown {
    const toString = this.contentType.startsWith("text/") || this.contentType.endsWith("json")
    return {
      _id: "effect/HttpBody",
      _tag: "Uint8Array",
      body: toString ? new TextDecoder().decode(this.body) : `Uint8Array(${this.body.length})`,
      contentType: this.contentType,
      contentLength: this.contentLength
    }
  }
}

/**
 * Creates a byte-array HTTP body.
 *
 * **Details**
 *
 * The content type defaults to `application/octet-stream`, and the content length is the byte array length.
 *
 * @category constructors
 * @since 4.0.0
 */
export const uint8Array = (body: globalThis.Uint8Array, contentType?: string): Uint8Array =>
  new Uint8Array(body, contentType ?? "application/octet-stream", body.length)

const encoder = new TextEncoder()

/**
 * Creates a UTF-8 encoded text HTTP body.
 *
 * **Details**
 *
 * The content type defaults to `text/plain`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const text = (body: string, contentType?: string): Uint8Array =>
  uint8Array(encoder.encode(body), contentType ?? "text/plain")

/**
 * Creates a JSON HTTP body using `JSON.stringify`, throwing if serialization fails.
 *
 * **Details**
 *
 * The content type defaults to `application/json`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const jsonUnsafe = (body: unknown, contentType?: string): Uint8Array =>
  text(JSON.stringify(body), contentType ?? "application/json")

/**
 * Creates a JSON HTTP body in an `Effect`.
 *
 * **Details**
 *
 * `JSON.stringify` failures are captured as `HttpBodyError` values, and the content type defaults to `application/json`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const json = (body: unknown, contentType?: string): Effect.Effect<Uint8Array, HttpBodyError> =>
  Effect.try({
    try: () => text(JSON.stringify(body), contentType ?? "application/json"),
    catch: (cause) => new HttpBodyError({ reason: { _tag: "JsonError" }, cause })
  })

/**
 * Creates a JSON body constructor that first encodes values with the schema's JSON codec.
 *
 * **Details**
 *
 * Schema encoding issues and JSON serialization failures are returned as `HttpBodyError` values.
 *
 * @category constructors
 * @since 4.0.0
 */
export const jsonSchema = <S extends Schema.Top>(
  schema: S,
  options?: ParseOptions | undefined
) => {
  const encode = Parser.encodeUnknownEffect(Schema.toCodecJson(schema))
  return (body: S["Type"], contentType?: string): Effect.Effect<Uint8Array, HttpBodyError, S["EncodingServices"]> =>
    encode(body, options).pipe(
      Effect.mapError((issue) => new HttpBodyError({ reason: { _tag: "SchemaError", issue }, cause: issue })),
      Effect.flatMap((body) => json(body, contentType))
    )
}

/**
 * Creates an `application/x-www-form-urlencoded` HTTP body from `UrlParams`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const urlParams = (urlParams: UrlParams.UrlParams, contentType?: string): Uint8Array =>
  text(UrlParams.toString(urlParams), contentType ?? "application/x-www-form-urlencoded")

/**
 * HTTP body variant backed by Web `FormData`.
 *
 * **Details**
 *
 * The content type and content length are left unset so the runtime can supply multipart boundaries.
 *
 * @category models
 * @since 4.0.0
 */
export class FormData extends Proto {
  readonly _tag = "FormData"
  readonly contentType = undefined
  readonly contentLength = undefined
  readonly formData: globalThis.FormData

  constructor(
    formData: globalThis.FormData
  ) {
    super()
    this.formData = formData
  }
  toJSON(): unknown {
    return {
      _id: "effect/HttpBody",
      _tag: "FormData",
      formData: this.formData
    }
  }
}

/**
 * Wraps a Web `FormData` value as an HTTP body.
 *
 * @category constructors
 * @since 4.0.0
 */
export const formData = (body: globalThis.FormData): FormData => new FormData(body)

/**
 * Record input accepted by `formDataRecord`.
 *
 * **Details**
 *
 * Each field may be a single coercible value or an array of coercible values.
 *
 * @category models
 * @since 4.0.0
 */
export type FormDataInput = Record<string, FormDataCoercible | ReadonlyArray<FormDataCoercible>>

/**
 * Value that can be appended by `formDataRecord`.
 *
 * **Details**
 *
 * `File` and `Blob` values are appended directly, primitive values are converted to strings, and `null` or `undefined` values are skipped.
 *
 * @category models
 * @since 4.0.0
 */
export type FormDataCoercible = string | number | boolean | globalThis.File | globalThis.Blob | null | undefined

const appendFormDataValue = (formData: globalThis.FormData, key: string, value: FormDataCoercible): void => {
  if (value == null) {
    return
  }
  if (typeof value === "object") {
    formData.append(key, value)
    return
  }
  formData.append(key, String(value))
}

/**
 * Creates a `FormData` HTTP body from a record.
 *
 * **Details**
 *
 * Array fields append each item under the same key; primitive values are stringified, `File` and `Blob` values are appended directly, and nullish values are skipped.
 *
 * @category constructors
 * @since 4.0.0
 */
export const formDataRecord = (entries: FormDataInput): FormData => {
  const data = new globalThis.FormData()
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        appendFormDataValue(data, key, item)
      }
    } else {
      appendFormDataValue(data, key, value as FormDataCoercible)
    }
  }
  return formData(data)
}

/**
 * HTTP body variant backed by a stream of `Uint8Array` chunks.
 *
 * @category models
 * @since 4.0.0
 */
export class Stream extends Proto {
  readonly _tag = "Stream"
  readonly stream: Stream_.Stream<globalThis.Uint8Array, unknown>
  readonly contentType: string
  readonly contentLength: number | undefined

  constructor(
    stream: Stream_.Stream<globalThis.Uint8Array, unknown>,
    contentType: string,
    contentLength: number | undefined
  ) {
    super()
    this.stream = stream
    this.contentType = contentType
    this.contentLength = contentLength
  }
  toJSON(): unknown {
    return {
      _id: "effect/HttpBody",
      _tag: "Stream",
      contentType: this.contentType,
      contentLength: this.contentLength
    }
  }
}

/**
 * Creates a streaming HTTP body from a stream of byte chunks.
 *
 * **Details**
 *
 * The content type defaults to `application/octet-stream`; content length is optional.
 *
 * @category constructors
 * @since 4.0.0
 */
export const stream = (
  body: Stream_.Stream<globalThis.Uint8Array, unknown>,
  contentType?: string,
  contentLength?: number
): Stream => new Stream(body, contentType ?? "application/octet-stream", contentLength)

/**
 * Creates a streaming HTTP body for a file path.
 *
 * **Details**
 *
 * The effect requires `FileSystem`, stats the file to set the content length, and can fail with `PlatformError`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const file = (
  path: string,
  options?: {
    readonly bytesToRead?: FileSystem.SizeInput | undefined
    readonly chunkSize?: FileSystem.SizeInput | undefined
    readonly offset?: FileSystem.SizeInput | undefined
    readonly contentType?: string | undefined
  }
): Effect.Effect<Stream, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.flatMap(
    FileSystem.FileSystem,
    (fs) =>
      Effect.map(fs.stat(path), (info) =>
        stream(
          fs.stream(path, options),
          options?.contentType,
          Number(info.size)
        ))
  )

/**
 * Creates a streaming HTTP body for a file path using already-known file information.
 *
 * **Details**
 *
 * The effect requires `FileSystem`, uses the provided file size as the content length, and can fail with `PlatformError`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fileFromInfo = (
  path: string,
  info: FileSystem.File.Info,
  options?: {
    readonly bytesToRead?: FileSystem.SizeInput | undefined
    readonly chunkSize?: FileSystem.SizeInput | undefined
    readonly offset?: FileSystem.SizeInput | undefined
    readonly contentType?: string | undefined
  }
): Effect.Effect<Stream, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.map(
    FileSystem.FileSystem,
    (fs) =>
      stream(
        fs.stream(path, options),
        options?.contentType,
        Number(info.size)
      )
  )
