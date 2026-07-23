/**
 * Parses and persists HTTP `multipart/form-data` request bodies.
 *
 * `Multipart` turns incoming byte streams into typed {@link Part} values. Text
 * parts become decoded {@link Field} values, while upload parts remain streamed
 * {@link File} values until they are collected or written to scoped temporary
 * files. The persisted representation can then be decoded with schemas for
 * request handlers that receive fields and uploaded files together.
 *
 * **Mental model**
 *
 * Multipart parsing is incremental. {@link makeChannel} consumes request body
 * chunks and emits fields or files as soon as the parser reaches each part. A
 * `File` owns a one-shot byte stream for that upload; {@link toPersisted}
 * drains those file streams into scoped paths and collects text fields into a
 * {@link Persisted} record.
 *
 * **Common tasks**
 *
 * - Parse a request body stream into {@link Part} values with {@link makeChannel}.
 * - Persist parsed parts with {@link toPersisted} before schema decoding.
 * - Decode persisted forms with {@link schemaPersisted}, {@link schemaJson},
 *   {@link PersistedFileSchema}, or {@link SingleFileSchema}.
 * - Configure parser limits with {@link limitsServices} or the `Max*` context
 *   references.
 *
 * **Gotchas**
 *
 * Multipart request bodies are usually one-shot streams. Read each file stream
 * once, and use `contentEffect` only when the file is small enough to hold in
 * memory. Paths produced by {@link toPersisted} are scoped resources and stop
 * being valid when the scope closes. Client-provided file names are metadata,
 * not trusted filesystem paths.
 *
 * **See also**
 *
 * {@link Part}, {@link Field}, {@link File}, {@link Persisted},
 * {@link makeChannel}, {@link toPersisted}.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Channel from "../../Channel.ts"
import * as Context from "../../Context.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as FileSystem from "../../FileSystem.ts"
import { constant, dual } from "../../Function.ts"
import * as Inspectable from "../../Inspectable.ts"
import * as Option from "../../Option.ts"
import * as Path from "../../Path.ts"
import * as Predicate from "../../Predicate.ts"
import * as Pull from "../../Pull.ts"
import * as Schema from "../../Schema.ts"
import type { ParseOptions } from "../../SchemaAST.ts"
import * as Transformation from "../../SchemaTransformation.ts"
import type * as Scope from "../../Scope.ts"
import * as Stream from "../../Stream.ts"
import * as UndefinedOr from "../../UndefinedOr.ts"
import * as IncomingMessage from "./HttpIncomingMessage.ts"
import * as MP from "./Multipasta.ts"

/**
 * Type identifier used to brand multipart part values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId = "~effect/http/Multipart"

/**
 * A parsed multipart part.
 *
 * **Details**
 *
 * A part is either a text `Field` or a streamed `File`.
 *
 * @category models
 * @since 4.0.0
 */
export type Part = Field | File

/**
 * Namespace containing shared multipart part model types.
 *
 * @since 4.0.0
 */
export declare namespace Part {
  /**
   * Common protocol implemented by multipart part values.
   *
   * **Details**
   *
   * It provides the multipart type identifier, tag, and inspectable behavior shared
   * by fields, files, and persisted files.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Proto extends Inspectable.Inspectable {
    readonly [TypeId]: typeof TypeId
    readonly _tag: string
  }
}

/**
 * Multipart form field containing a decoded text value.
 *
 * **Details**
 *
 * The `key` is the field name, `contentType` is the part media type, and `value`
 * is the decoded field content.
 *
 * @category models
 * @since 4.0.0
 */
export interface Field extends Part.Proto {
  readonly _tag: "Field"
  readonly key: string
  readonly contentType: string
  readonly value: string
}

/**
 * Returns `true` when a value is a multipart `Part`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPart = (u: unknown): u is Part => Predicate.hasProperty(u, TypeId)

/**
 * Returns `true` when a value is a multipart text `Field`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isField = (u: unknown): u is Field => isPart(u) && u._tag === "Field"

/**
 * Multipart file part.
 *
 * **Gotchas**
 *
 * The file content is exposed as a byte stream. `contentEffect` collects the full
 * file into memory and should be used only when the file size is acceptable.
 *
 * @category models
 * @since 4.0.0
 */
export interface File extends Part.Proto {
  readonly _tag: "File"
  readonly key: string
  readonly name: string
  readonly contentType: string
  readonly content: Stream.Stream<Uint8Array, MultipartError>
  readonly contentEffect: Effect.Effect<Uint8Array, MultipartError>
}

/**
 * Returns `true` when a value is a multipart `File`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isFile = (u: unknown): u is File => isPart(u) && u._tag === "File"

/**
 * Multipart file part that has been written to the filesystem.
 *
 * **Details**
 *
 * The `path` points to the persisted file while the scope used to persist the
 * multipart data remains open.
 *
 * @category models
 * @since 4.0.0
 */
export interface PersistedFile extends Part.Proto {
  readonly _tag: "PersistedFile"
  readonly key: string
  readonly name: string
  readonly contentType: string
  readonly path: string
}

/**
 * Returns `true` when a value is a persisted multipart file.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPersistedFile = (u: unknown): u is PersistedFile =>
  Predicate.hasProperty(u, TypeId) && Predicate.isTagged(u, "PersistedFile")

/**
 * Record representation of persisted multipart data.
 *
 * **Details**
 *
 * Field names map to text values, arrays of text values, or arrays of
 * `PersistedFile` values.
 *
 * @category models
 * @since 4.0.0
 */
export interface Persisted {
  readonly [key: string]: ReadonlyArray<PersistedFile> | ReadonlyArray<string> | string
}

const MultipartErrorTypeId = "~effect/http/Multipart/MultipartError"

/**
 * Error reason carried by a `MultipartError`.
 *
 * **Details**
 *
 * It identifies parser and limit failures such as oversized files or fields, too
 * many parts, total body size limits, parse errors, and internal errors.
 *
 * @category errors
 * @since 4.0.0
 */
export class MultipartErrorReason extends Data.Error<{
  readonly _tag: "FileTooLarge" | "FieldTooLarge" | "BodyTooLarge" | "TooManyParts" | "InternalError" | "Parse"
  readonly cause?: unknown
}> {}

/**
 * Error raised while parsing, streaming, or persisting multipart form data.
 *
 * **Details**
 *
 * The `reason` field contains the concrete `MultipartErrorReason`.
 *
 * @category errors
 * @since 4.0.0
 */
export class MultipartError extends Data.TaggedError("MultipartError")<{
  readonly reason: MultipartErrorReason
}> {
  /**
   * Creates a multipart error from a reason tag and optional cause.
   *
   * @since 4.0.0
   */
  static fromReason(reason: MultipartErrorReason["_tag"], cause?: unknown): MultipartError {
    return new MultipartError({ reason: new MultipartErrorReason({ _tag: reason, cause }) })
  }

  /**
   * Marks this value as a multipart error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [MultipartErrorTypeId] = MultipartErrorTypeId

  /**
   * Uses the concrete multipart error reason as the public message.
   *
   * @since 4.0.0
   */
  override get message(): string {
    return this.reason._tag
  }
}

/**
 * Schema type for persisted multipart files.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface PersistedFileSchema extends Schema.declare<PersistedFile> {}

/**
 * Schema for persisted multipart files.
 *
 * **Details**
 *
 * The encoded form contains the field key, original file name, content type, and
 * filesystem path.
 *
 * @category schemas
 * @since 4.0.0
 */
export const PersistedFileSchema: PersistedFileSchema = Schema.declare(
  isPersistedFile,
  {
    typeConstructor: {
      _tag: "effect/http/PersistedFile"
    },
    generation: {
      runtime: `Multipart.PersistedFileSchema`,
      Type: `Multipart.PersistedFile`,
      importDeclaration: `import * as Multipart from "effect/unstable/http/Multipart"`
    },
    expected: "PersistedFile",
    toCodecJson: () =>
      Schema.link<PersistedFile>()(
        Schema.Struct({
          key: Schema.String,
          name: Schema.String,
          contentType: Schema.String.annotate({ contentEncoding: "binary" }),
          path: Schema.String
        }),
        Transformation.transform({
          decode: ({ contentType, key, name, path }) => new PersistedFileImpl(key, name, contentType, path),
          encode: (file) => ({
            key: file.key,
            name: file.name,
            contentType: file.contentType,
            path: file.path
          })
        })
      )
  }
)

/**
 * Schema for an array of persisted multipart files.
 *
 * @category schemas
 * @since 4.0.0
 */
export const FilesSchema: Schema.$Array<PersistedFileSchema> = Schema.Array(PersistedFileSchema)

/**
 * Schema for exactly one persisted multipart file.
 *
 * **Details**
 *
 * The encoded form is a one-element file array, while the decoded value is the
 * single `PersistedFile`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SingleFileSchema: Schema.decodeTo<PersistedFileSchema, Schema.$Array<PersistedFileSchema>> = FilesSchema
  .check(
    Schema.isLengthBetween(1, 1)
  ).pipe(
    Schema.decodeTo(
      PersistedFileSchema,
      Transformation.transform({
        decode: ([file]) => file,
        encode: (file) => [file]
      })
    )
  )

/**
 * Creates a decoder for persisted multipart data using the supplied schema.
 *
 * **Details**
 *
 * The returned function decodes an unknown input into the schema output and fails
 * with `SchemaError` when validation fails.
 *
 * @category schemas
 * @since 4.0.0
 */
export const schemaPersisted = <A, I extends Partial<Persisted>, RD, RE>(
  schema: Schema.Codec<A, I, RD, RE>
): (input: unknown, options?: ParseOptions) => Effect.Effect<A, Schema.SchemaError, RD> =>
  Schema.decodeUnknownEffect(schema)

/**
 * Creates a decoder for a JSON-encoded field in persisted multipart data.
 *
 * **Details**
 *
 * The selected field is parsed from a JSON string and decoded with the supplied
 * schema.
 *
 * @category schemas
 * @since 4.0.0
 */
export const schemaJson = <A, I, RD, RE>(schema: Schema.Codec<A, I, RD, RE>, options?: ParseOptions | undefined): {
  (
    field: string
  ): (persisted: Persisted) => Effect.Effect<A, Schema.SchemaError, RD>
  (
    persisted: Persisted,
    field: string
  ): Effect.Effect<A, Schema.SchemaError, RD>
} => {
  const fromJson = Schema.fromJsonString(schema)
  return dual(2, (persisted: Persisted, field: string): Effect.Effect<A, Schema.SchemaError, RD> =>
    Effect.map(
      Schema.decodeUnknownEffect(Schema.Struct({ [field]: fromJson }))(persisted, options),
      (_) => _[field]
    ))
}

/**
 * Builds the low-level multipart parser configuration from request headers and
 * the current fiber context.
 *
 * **Details**
 *
 * Parser limits are read from the multipart references, including maximum parts,
 * field size, file size, total body size, and field MIME type overrides.
 *
 * @category configuration
 * @since 4.0.0
 */
export const makeConfig = (
  headers: Record<string, string>
): Effect.Effect<MP.BaseConfig> =>
  Effect.withFiber((fiber) => {
    const mimeTypes = Context.get(fiber.context, FieldMimeTypes)
    return Effect.succeed<MP.BaseConfig>({
      headers,
      maxParts: fiber.getRef(MaxParts),
      maxFieldSize: Number(fiber.getRef(MaxFieldSize)),
      maxPartSize: UndefinedOr.map(fiber.getRef(MaxFileSize), Number),
      maxTotalSize: UndefinedOr.map(fiber.getRef(IncomingMessage.MaxBodySize), Number),
      isFile: mimeTypes.length === 0 ? undefined : (info: MP.PartInfo): boolean =>
        !mimeTypes.some(
          (_) => info.contentType.includes(_)
        ) && MP.defaultIsFile(info)
    })
  })

/**
 * Creates a channel that parses multipart byte chunks into multipart parts.
 *
 * **Details**
 *
 * The channel consumes non-empty batches of `Uint8Array` chunks and emits
 * non-empty batches of parsed `Part` values, failing with `MultipartError` for
 * parser and limit failures.
 *
 * @category Parsers
 * @since 4.0.0
 */
export const makeChannel = <IE>(headers: Record<string, string>): Channel.Channel<
  Arr.NonEmptyReadonlyArray<Part>,
  MultipartError | IE,
  void,
  Arr.NonEmptyReadonlyArray<Uint8Array>,
  IE,
  unknown
> =>
  Channel.fromTransform((upstream) =>
    Effect.map(makeConfig(headers), (config) => {
      let partsBuffer: Array<Part> = []
      let exit = Option.none<Exit.Exit<never, IE | MultipartError | Cause.Done>>()

      const parser = MP.make({
        ...config,
        onField(info, value) {
          partsBuffer.push(new FieldImpl(info.name, info.contentType, MP.decodeField(info, value)))
        },
        onFile(info) {
          let chunks: Array<Uint8Array> = []
          let finished = false
          const pullChunks = Channel.fromPull(
            Effect.succeed(Effect.suspend(function loop(): Pull.Pull<Arr.NonEmptyReadonlyArray<Uint8Array>> {
              if (!Arr.isReadonlyArrayNonEmpty(chunks)) {
                return finished ? Cause.done() : Effect.flatMap(pump, loop)
              }
              const chunk = chunks
              chunks = []
              return Effect.succeed(chunk)
            }))
          )
          partsBuffer.push(new FileImpl(info, pullChunks))
          return function(chunk) {
            if (chunk === null) {
              finished = true
            } else {
              chunks.push(chunk)
            }
          }
        },
        onError(error_) {
          exit = Option.some(Exit.fail(convertError(error_)))
        },
        onDone() {
          exit = Option.some(Exit.fail(Cause.Done()))
        }
      })

      const pump = upstream.pipe(
        Effect.flatMap((chunk) => {
          for (let i = 0; i < chunk.length; i++) {
            parser.write(chunk[i])
          }
          return Effect.void
        }),
        Effect.catchCause((cause) => {
          if (Pull.isDoneCause(cause)) {
            parser.end()
          } else {
            exit = Option.some(Exit.failCause(cause)) as any
          }
          return Effect.void
        })
      )

      return pump.pipe(
        Effect.flatMap(function loop(): Pull.Pull<Arr.NonEmptyReadonlyArray<Part>, IE | MultipartError> {
          if (!Arr.isReadonlyArrayNonEmpty(partsBuffer)) {
            if (Option.isSome(exit)) {
              return exit.value
            }
            return Effect.flatMap(pump, loop)
          }
          const parts = partsBuffer
          partsBuffer = []
          return Effect.succeed(parts)
        })
      )
    })
  )

function convertError(cause: MP.MultipartError): MultipartError {
  switch (cause._tag) {
    case "ReachedLimit": {
      switch (cause.limit) {
        case "MaxParts": {
          return MultipartError.fromReason("TooManyParts", cause)
        }
        case "MaxFieldSize": {
          return MultipartError.fromReason("FieldTooLarge", cause)
        }
        case "MaxPartSize": {
          return MultipartError.fromReason("FileTooLarge", cause)
        }
        case "MaxTotalSize": {
          return MultipartError.fromReason("BodyTooLarge", cause)
        }
      }
    }
    default: {
      return MultipartError.fromReason("Parse", cause)
    }
  }
}

abstract class PartBase extends Inspectable.Class {
  readonly [TypeId]: typeof TypeId
  constructor() {
    super()
    this[TypeId] = TypeId
  }
}

class FieldImpl extends PartBase implements Field {
  readonly _tag = "Field"
  readonly key: string
  readonly contentType: string
  readonly value: string

  constructor(
    key: string,
    contentType: string,
    value: string
  ) {
    super()
    this.key = key
    this.contentType = contentType
    this.value = value
  }

  toJSON(): unknown {
    return {
      _id: "@effect/platform/Multipart/Part",
      _tag: "Field",
      key: this.key,
      contentType: this.contentType,
      value: this.value
    }
  }
}

class FileImpl extends PartBase implements File {
  readonly _tag = "File"
  readonly key: string
  readonly name: string
  readonly contentType: string
  readonly content: Stream.Stream<Uint8Array, MultipartError>
  readonly contentEffect: Effect.Effect<Uint8Array, MultipartError>

  constructor(
    info: MP.PartInfo,
    channel: Channel.Channel<Arr.NonEmptyReadonlyArray<Uint8Array>>
  ) {
    super()
    this.key = info.name
    this.name = info.filename ?? info.name
    this.contentType = info.contentType
    this.content = Stream.fromChannel(channel)
    this.contentEffect = channel.pipe(
      collectUint8Array,
      Effect.mapError((cause) => MultipartError.fromReason("InternalError", cause))
    )
  }

  toJSON(): unknown {
    return {
      _id: "@effect/platform/Multipart/Part",
      _tag: "File",
      key: this.key,
      name: this.name,
      contentType: this.contentType
    }
  }
}

const defaultWriteFile = (path: string, file: File) =>
  Effect.flatMap(
    FileSystem.FileSystem,
    (fs) =>
      Effect.mapError(
        Stream.run(file.content, fs.sink(path)),
        (cause) => MultipartError.fromReason("InternalError", cause)
      )
  )

/**
 * Runs a channel of byte chunks and collects all output into a single
 * `Uint8Array`.
 *
 * **Gotchas**
 *
 * This materializes the full content in memory.
 *
 * @category converting
 * @since 4.0.0
 */
export const collectUint8Array = <OE, OD, R>(
  self: Channel.Channel<Arr.NonEmptyReadonlyArray<Uint8Array>, OE, OD, unknown, unknown, unknown, R>
): Effect.Effect<Uint8Array<ArrayBuffer>, OE, R> =>
  Channel.runFold(self, constant(new Uint8Array(0)), (accumulator, chunk) => {
    const totalLength = chunk.reduce((sum, element) => sum + element.length, accumulator.length)
    const newAccumulator = new Uint8Array(totalLength)
    newAccumulator.set(accumulator, 0)
    let offset = accumulator.length
    for (const element of chunk) {
      newAccumulator.set(element, offset)
      offset += element.length
    }
    return newAccumulator
  })

/**
 * Persists a stream of multipart parts into a record.
 *
 * **Details**
 *
 * Text fields are collected as strings, and file parts are written to files in a
 * scoped temporary directory.
 *
 * **Gotchas**
 *
 * Persisted file paths remain valid for the lifetime of the scope.
 *
 * @category converting
 * @since 4.0.0
 */
export const toPersisted = (
  stream: Stream.Stream<Part, MultipartError>,
  writeFile = defaultWriteFile
): Effect.Effect<Persisted, MultipartError, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path_ = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped()
    const persisted: Record<string, Array<PersistedFile> | Array<string> | string> = Object.create(null)
    yield* Stream.runForEach(stream, (part) => {
      if (part._tag === "Field") {
        if (!(part.key in persisted)) {
          persisted[part.key] = part.value
        } else if (typeof persisted[part.key] === "string") {
          persisted[part.key] = [persisted[part.key] as string, part.value]
        } else {
          ;(persisted[part.key] as Array<string>).push(part.value)
        }
        return Effect.void
      } else if (part.name === "") {
        return Effect.void
      }
      const file = part
      const path = path_.join(dir, path_.basename(file.name).slice(-128))
      const filePart = new PersistedFileImpl(
        file.key,
        file.name,
        file.contentType,
        path
      )
      if (Array.isArray(persisted[part.key])) {
        ;(persisted[part.key] as Array<PersistedFile>).push(filePart)
      } else {
        persisted[part.key] = [filePart]
      }
      return writeFile(path, file)
    })
    return persisted
  }).pipe(
    Effect.catchTag("PlatformError", (cause) => Effect.fail(MultipartError.fromReason("InternalError", cause)))
  )

class PersistedFileImpl extends PartBase implements PersistedFile {
  readonly _tag = "PersistedFile"
  readonly key: string
  readonly name: string
  readonly contentType: string
  readonly path: string

  constructor(
    key: string,
    name: string,
    contentType: string,
    path: string
  ) {
    super()
    this.key = key
    this.name = name
    this.contentType = contentType
    this.path = path
  }

  toJSON(): unknown {
    return {
      _id: "@effect/platform/Multipart/Part",
      _tag: "PersistedFile",
      key: this.key,
      name: this.name,
      contentType: this.contentType,
      path: this.path
    }
  }
}

/**
 * Creates a context containing multipart parser limit settings.
 *
 * **Details**
 *
 * The context can provide maximum part count, field size, file size, total body
 * size, and MIME types that should be parsed as fields.
 *
 * @category references
 * @since 4.0.0
 */
export const limitsServices = (options: {
  readonly maxParts?: number | undefined
  readonly maxFieldSize?: FileSystem.SizeInput | undefined
  readonly maxFileSize?: FileSystem.SizeInput | undefined
  readonly maxTotalSize?: FileSystem.SizeInput | undefined
  readonly fieldMimeTypes?: ReadonlyArray<string> | undefined
}): Context.Context<never> => {
  const map = new Map<string, unknown>()
  if (options.maxParts !== undefined) {
    map.set(MaxParts.key, options.maxParts)
  }
  if (options.maxFieldSize !== undefined) {
    map.set(MaxFieldSize.key, FileSystem.Size(options.maxFieldSize))
  }
  if (options.maxFileSize !== undefined) {
    map.set(MaxFileSize.key, UndefinedOr.map(options.maxFileSize, FileSystem.Size))
  }
  if (options.maxTotalSize !== undefined) {
    map.set(IncomingMessage.MaxBodySize.key, UndefinedOr.map(options.maxTotalSize, FileSystem.Size))
  }
  if (options.fieldMimeTypes !== undefined) {
    map.set(FieldMimeTypes.key, options.fieldMimeTypes)
  }
  return Context.makeUnsafe(map)
}

/**
 * Namespace containing multipart parser limit option types.
 *
 * @since 4.0.0
 */
export declare namespace withLimits {
  /**
   * Options for overriding multipart parser limits.
   *
   * **Details**
   *
   * These settings control maximum part count, field size, file size, total body
   * size, and MIME types that should be treated as fields instead of files.
   *
   * @category fiber refs
   * @since 4.0.0
   */
  export type Options = {
    readonly maxParts?: number | undefined
    readonly maxFieldSize?: FileSystem.SizeInput | undefined
    readonly maxFileSize?: FileSystem.SizeInput | undefined
    readonly maxTotalSize?: FileSystem.SizeInput | undefined
    readonly fieldMimeTypes?: ReadonlyArray<string> | undefined
  }
}

/**
 * Context reference for the maximum number of multipart parts allowed.
 *
 * **Details**
 *
 * The default is `undefined`, meaning no explicit part-count limit.
 *
 * @category references
 * @since 4.0.0
 */
export const MaxParts = Context.Reference<number | undefined>("effect/http/Multipart/MaxParts", {
  defaultValue: () => undefined
})

/**
 * Context reference for the maximum size of a multipart field value.
 *
 * **Details**
 *
 * The default limit is 10 MiB.
 *
 * @category references
 * @since 4.0.0
 */
export const MaxFieldSize = Context.Reference<FileSystem.SizeInput>("effect/http/Multipart/MaxFieldSize", {
  defaultValue: constant(FileSystem.Size(10 * 1024 * 1024))
})

/**
 * Context reference for the maximum size of a multipart file part.
 *
 * **Details**
 *
 * The default is `undefined`, meaning no explicit per-file limit.
 *
 * @category references
 * @since 4.0.0
 */
export const MaxFileSize = Context.Reference<FileSystem.SizeInput | undefined>(
  "effect/http/Multipart/MaxFileSize",
  { defaultValue: () => undefined }
)

/**
 * Context reference for MIME type fragments that should be parsed as multipart
 * fields instead of files.
 *
 * **Details**
 *
 * The default treats `application/json` parts as fields.
 *
 * @category references
 * @since 4.0.0
 */
export const FieldMimeTypes = Context.Reference<ReadonlyArray<string>>("effect/http/Multipart/FieldMimeTypes", {
  defaultValue: constant(["application/json"])
})
