/**
 * The `Primitive` module defines the lowest-level value parsers used by the
 * unstable CLI package. A `Primitive<A>` takes one raw command-line string and
 * returns an `Effect` that either produces an `A` or fails with a parser
 * message.
 *
 * `Argument` and `Flag` build on primitives to add names, aliases, defaults,
 * prompts, config fallbacks, repetition, and help metadata. Use this module
 * directly when defining a custom CLI input shape or when composing parser
 * behavior before it becomes an argument or flag.
 *
 * **Mental model**
 *
 * - A primitive parses one value token; it does not know whether the token came
 *   from a positional argument or a named flag.
 * - Parsing may be pure, such as {@link string}, {@link integer},
 *   {@link boolean}, or {@link choice}, or effectful, such as {@link path},
 *   {@link fileText}, {@link fileParse}, and {@link fileSchema}.
 * - Failure is represented as a string message so higher-level CLI parsers can
 *   attach it to generated usage and help output.
 * - File and path primitives require filesystem and path services through the
 *   parsing effect environment.
 *
 * **Common tasks**
 *
 * - Parse scalar values with {@link string}, {@link integer}, {@link float},
 *   {@link boolean}, and {@link date}.
 * - Restrict input to named alternatives with {@link choice}.
 * - Resolve and validate filesystem paths with {@link path}.
 * - Read raw file content with {@link fileText}, parse structured files with
 *   {@link fileParse}, or decode parsed content with {@link fileSchema}.
 * - Hide sensitive input with {@link redacted}.
 * - Parse `key=value` entries with {@link keyValuePair}.
 *
 * **Example** (Parsing raw CLI values)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const parseValues = Effect.gen(function*() {
 *   const port = yield* Primitive.integer.parse("8080")
 *   const mode = yield* Primitive.choice([
 *     ["dev", "development"],
 *     ["prod", "production"]
 *   ] as const).parse("prod")
 *
 *   return { port, mode }
 * })
 * ```
 *
 * **Gotchas**
 *
 * - `choice` matches input strings exactly; it does not normalize casing or
 *   trim whitespace.
 * - `fileParse` selects a parser from `options.format` or the file extension;
 *   unsupported formats fail before schema decoding.
 * - {@link none} is a sentinel parser that always fails. It is used by higher
 *   layers for parameters that must reject attached values.
 *
 * @since 4.0.0
 */
import * as Ini from "ini"
import * as Toml from "toml"
import * as Yaml from "yaml"
import * as Config from "../../Config.ts"
import * as Effect from "../../Effect.ts"
import * as FileSystem from "../../FileSystem.ts"
import { format } from "../../Formatter.ts"
import { identity } from "../../Function.ts"
import * as Path from "../../Path.ts"
import * as Redacted from "../../Redacted.ts"
import * as Schema from "../../Schema.ts"
import type { Formatter } from "../../SchemaIssue.ts"
import type * as Struct from "../../Struct.ts"
import type { Covariant } from "../../Types.ts"

const TypeId = "~effect/cli/Primitive"

/**
 * Represents a primitive type that can parse string input into a typed value.
 *
 * **Example** (Parsing values with primitives)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * // Using built-in primitives
 * const parseString = Effect.gen(function*() {
 *   const stringResult = yield* Primitive.string.parse("hello")
 *   const numberResult = yield* Primitive.integer.parse("42")
 *   const boolResult = yield* Primitive.boolean.parse("true")
 *
 *   return { stringResult, numberResult, boolResult }
 * })
 *
 * // All primitives provide parsing functionality
 * const parseDate = Effect.gen(function*() {
 *   const dateResult = yield* Primitive.date.parse("2023-12-25")
 *   const pathResult = yield* Primitive.path("file", true).parse("./package.json")
 *   return { dateResult, pathResult }
 * })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface Primitive<out A> extends Primitive.Variance<A> {
  readonly _tag: string
  readonly parse: (value: string) => Effect.Effect<A, string, FileSystem.FileSystem | Path.Path>
}

/**
 * Namespace containing type-level helpers for `Primitive`.
 *
 * @since 4.0.0
 */
export declare namespace Primitive {
  /**
   * Type-level variance marker for the value parsed by a `Primitive`.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Variance<out A> {
    readonly [TypeId]: {
      readonly _A: Covariant<A>
    }
  }
}

const Proto = {
  [TypeId]: {
    _A: identity
  }
}

/** @internal */
export const isTrueValue = Schema.is(Config.TrueValues)

/** @internal */
export const isFalseValue = Schema.is(Config.FalseValues)

/** @internal */
export const isBoolean = (p: Primitive<unknown>): p is Primitive<boolean> => p._tag === "Boolean"

const makePrimitive = <A>(
  tag: string,
  parse: (
    value: string
  ) => Effect.Effect<A, string, FileSystem.FileSystem | Path.Path>
): Primitive<A> =>
  Object.assign(Object.create(Proto), {
    _tag: tag,
    parse
  })

const makeSchemaPrimitive = <T, E>(
  tag: string,
  schema: Schema.Codec<T, E>
): Primitive<T> => {
  const toCodecStringTree = Schema.toCodecStringTree(schema)
  const decode = Schema.decodeUnknownEffect(toCodecStringTree)
  return makePrimitive(tag, (value) => Effect.mapError(decode(value), (error) => error.message))
}

/**
 * Creates a primitive that parses boolean values from string input.
 *
 * **Details**
 *
 * Recognizes various forms of true/false values:
 * - True values: "true", "1", "y", "yes", "on"
 * - False values: "false", "0", "n", "no", "off"
 *
 * **Example** (Parsing boolean values)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const parseBoolean = Effect.gen(function*() {
 *   const result1 = yield* Primitive.boolean.parse("true")
 *   console.log(result1) // true
 *
 *   const result2 = yield* Primitive.boolean.parse("yes")
 *   console.log(result2) // true
 *
 *   const result3 = yield* Primitive.boolean.parse("false")
 *   console.log(result3) // false
 *
 *   const result4 = yield* Primitive.boolean.parse("0")
 *   console.log(result4) // false
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const boolean: Primitive<boolean> = makeSchemaPrimitive(
  "Boolean",
  Config.Boolean
)

/**
 * Creates a primitive that parses floating-point numbers from string input.
 *
 * **Example** (Parsing floating-point numbers)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const parseFloat = Effect.gen(function*() {
 *   const result1 = yield* Primitive.float.parse("3.14")
 *   console.log(result1) // 3.14
 *
 *   const result2 = yield* Primitive.float.parse("-42.5")
 *   console.log(result2) // -42.5
 *
 *   const result3 = yield* Primitive.float.parse("0")
 *   console.log(result3) // 0
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const float: Primitive<number> = makeSchemaPrimitive(
  "Float",
  Schema.Finite
)

/**
 * Creates a primitive that parses integer numbers from string input.
 *
 * **Example** (Parsing integer values)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const parseInteger = Effect.gen(function*() {
 *   const result1 = yield* Primitive.integer.parse("42")
 *   console.log(result1) // 42
 *
 *   const result2 = yield* Primitive.integer.parse("-123")
 *   console.log(result2) // -123
 *
 *   const result3 = yield* Primitive.integer.parse("0")
 *   console.log(result3) // 0
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const integer: Primitive<number> = makeSchemaPrimitive(
  "Integer",
  Schema.Int
)

/**
 * Creates a primitive that parses Date objects from string input.
 *
 * **Example** (Parsing date values)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const parseDate = Effect.gen(function*() {
 *   const result1 = yield* Primitive.date.parse("2023-12-25")
 *   console.log(result1) // Date object for December 25, 2023
 *
 *   const result2 = yield* Primitive.date.parse("2023-12-25T10:30:00Z")
 *   console.log(result2) // Date object with time
 *
 *   const result3 = yield* Primitive.date.parse("Dec 25, 2023")
 *   console.log(result3) // Date object parsed from natural format
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const date: Primitive<Date> = makeSchemaPrimitive(
  "Date",
  Schema.DateValid
)

/**
 * Creates a primitive that accepts any string value without validation.
 *
 * **Example** (Parsing string values)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const parseString = Effect.gen(function*() {
 *   const result1 = yield* Primitive.string.parse("hello world")
 *   console.log(result1) // "hello world"
 *
 *   const result2 = yield* Primitive.string.parse("")
 *   console.log(result2) // ""
 *
 *   const result3 = yield* Primitive.string.parse("123")
 *   console.log(result3) // "123"
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const string: Primitive<string> = makePrimitive("String", (value) => Effect.succeed(value))

/**
 * Creates a primitive that accepts only specific choice values mapped to custom types.
 *
 * **Example** (Parsing choices)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * type LogLevel = "debug" | "info" | "warn" | "error"
 *
 * const logLevelPrimitive = Primitive.choice<LogLevel>([
 *   ["debug", "debug"],
 *   ["info", "info"],
 *   ["warn", "warn"],
 *   ["error", "error"]
 * ])
 *
 * const parseLogLevel = Effect.gen(function*() {
 *   const result1 = yield* logLevelPrimitive.parse("info")
 *   console.log(result1) // "info"
 *
 *   const result2 = yield* logLevelPrimitive.parse("debug")
 *   console.log(result2) // "debug"
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const choice = <A>(
  choices: ReadonlyArray<readonly [string, A]>
): Primitive<A> => {
  const choiceMap = new Map(choices)
  const validChoices = choices.map(([key]) => format(key)).join(" | ")
  const primitive = makePrimitive("Choice", (value) => {
    if (choiceMap.has(value)) {
      return Effect.succeed(choiceMap.get(value)!)
    }
    return Effect.fail(`Expected ${validChoices}, got ${format(value)}`)
  })
  return Object.assign(primitive, { choiceKeys: choices.map(([key]) => key) })
}

/**
 * Specifies the type of path validation to perform.
 *
 * **Example** (Choosing path validation)
 *
 * ```ts
 * import { Primitive } from "effect/unstable/cli"
 *
 * // Only accept files
 * const filePath = Primitive.path("file", true)
 *
 * // Only accept directories
 * const dirPath = Primitive.path("directory", true)
 *
 * // Accept either files or directories
 * const anyPath = Primitive.path("either", false)
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export type PathType = "file" | "directory" | "either"

/**
 * Creates a primitive that validates and resolves file system paths.
 *
 * **Example** (Parsing file system paths)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const program = Effect.gen(function*() {
 *   // Parse a file path that must exist
 *   const filePrimitive = Primitive.path("file", true)
 *   const filePath = yield* filePrimitive.parse("./package.json")
 *   console.log(filePath) // Absolute path to package.json
 *
 *   // Parse a directory path
 *   const dirPrimitive = Primitive.path("directory", false)
 *   const dirPath = yield* dirPrimitive.parse("./src")
 *   console.log(dirPath) // Absolute path to src directory
 *
 *   // Parse any path type
 *   const anyPrimitive = Primitive.path("either", false)
 *   const anyPath = yield* anyPrimitive.parse("./some/path")
 *   console.log(anyPath) // Absolute path
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const path = (
  pathType: PathType,
  mustExist?: boolean
): Primitive<string> =>
  makePrimitive(
    "Path",
    Effect.fnUntraced(function*(value) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      // Resolve the path to absolute
      const absolutePath = path.isAbsolute(value) ? value : path.resolve(value)

      // Check if path exists
      const exists = yield* Effect.mapError(
        fs.exists(absolutePath),
        (error) => `Failed to check path existence: ${error.message}`
      )

      // Validate existence requirements
      if (mustExist === true && !exists) {
        return yield* Effect.fail(`Path does not exist: ${absolutePath}`)
      }

      // Validate path type if it exists
      if (exists && pathType !== "either") {
        const stat = yield* Effect.mapError(
          fs.stat(absolutePath),
          (error) => `Failed to stat path: ${error.message}`
        )

        if (pathType === "file" && stat.type !== "File") {
          return yield* Effect.fail(`Path is not a file: ${absolutePath}`)
        }
        if (pathType === "directory" && stat.type !== "Directory") {
          return yield* Effect.fail(`Path is not a directory: ${absolutePath}`)
        }
      }

      return absolutePath
    })
  )

/**
 * Creates a primitive that wraps string input in `Redacted`.
 *
 * **Details**
 *
 * The wrapped value is hidden when formatted or inspected, while the original
 * string remains available through the `Redacted` API when explicitly needed.
 *
 * **Example** (Parsing redacted values)
 *
 * ```ts
 * import { Effect, Redacted } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const parseRedacted = Effect.gen(function*() {
 *   const result = yield* Primitive.redacted.parse("secret-password")
 *   console.log(Redacted.value(result)) // "secret-password"
 *   console.log(String(result)) // "<redacted>"
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const redacted: Primitive<Redacted.Redacted<string>> = makePrimitive(
  "Redacted",
  (value) => Effect.succeed(Redacted.make(value))
)

/**
 * Creates a primitive that reads and returns the contents of a file as a string.
 *
 * **Example** (Reading file text)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const ConfigSchema = Schema.Struct({
 *   name: Schema.String,
 *   version: Schema.String,
 *   port: Schema.Number
 * })
 * const decodeConfig = Schema.decodeUnknownEffect(
 *   Schema.fromJsonString(ConfigSchema)
 * )
 *
 * const readConfigFile = Effect.gen(function*() {
 *   const content = yield* Primitive.fileText.parse("./config.json")
 *   console.log(content) // {"name":"my-app","version":"1.0.0","port":3000}
 *
 *   const config = yield* decodeConfig(content)
 *   console.log(config) // { name: "my-app", version: "1.0.0", port: 3000 }
 *   return config
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fileText: Primitive<string> = makePrimitive(
  "FileText",
  Effect.fnUntraced(function*(filePath) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    // Resolve to absolute path
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(filePath)

    // Check if file exists
    const exists = yield* Effect.mapError(
      fs.exists(absolutePath),
      (error) => `Failed to check file existence: ${error.message}`
    )

    if (!exists) {
      return yield* Effect.fail(`File does not exist: ${absolutePath}`)
    }

    // Check if it's actually a file
    const stat = yield* Effect.mapError(
      fs.stat(absolutePath),
      (error) => `Failed to stat file: ${error.message}`
    )

    if (stat.type !== "File") {
      return yield* Effect.fail(`Path is not a file: ${absolutePath}`)
    }

    // Read file content
    const content = yield* Effect.mapError(
      fs.readFileString(absolutePath),
      (error) => `Failed to read file: ${error.message}`
    )

    return content
  })
)

/**
 * Represents options which can be provided to methods that deal with parsing
 * file content.
 *
 * @category models
 * @since 4.0.0
 */
export type FileParseOptions = {
  readonly format?: "ini" | "json" | "toml" | "yaml"
}

const fileParsers: Record<string, (content: string) => unknown> = {
  ini: (content: string) => Ini.parse(content),
  json: (content: string) => JSON.parse(content),
  toml: (content: string) => Toml.parse(content),
  yml: (content: string) => Yaml.parse(content),
  yaml: (content: string) => Yaml.parse(content)
}

/**
 * Creates a primitive that reads a file and parses its content as structured
 * data.
 *
 * **Details**
 *
 * The parser is selected from `options.format` when provided, otherwise from
 * the file extension. Supported formats include INI, JSON, TOML, YAML, and YML.
 *
 * **Example** (Parsing file content)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const tomlFilePrimitive = Primitive.fileParse({ format: "toml" })
 *
 * const loadConfig = Effect.gen(function*() {
 *   const config = yield* tomlFilePrimitive.parse("./config.toml")
 *   console.log(config) // { name: "my-app", version: "1.0.0", port: 3000 }
 *   return config
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fileParse = (options?: FileParseOptions): Primitive<unknown> => {
  return makePrimitive(
    "FileParse",
    Effect.fnUntraced(function*(filePath) {
      const fileFormat = options?.format ?? filePath.split(".").pop() as string
      const parser = fileParsers[fileFormat]
      if (parser === undefined) {
        return yield* Effect.fail(`Unsupported file format: ${fileFormat}`)
      }
      const content = yield* fileText.parse(filePath)
      return yield* Effect.try({
        try: () => parser(content),
        catch: (error) => `Failed to parse '.${fileFormat}' file content: ${error}`
      })
    })
  )
}

/**
 * Represents options which can be provided to methods that deal with parsing
 * file content and decoding the file content with a `Schema`.
 *
 * @category models
 * @since 4.0.0
 */
export type FileSchemaOptions = Struct.Simplify<
  FileParseOptions & {
    readonly errorFormatter?: Formatter<string> | undefined
  }
>

/**
 * Reads and parses file content using the specified schema.
 *
 * **Example** (Parsing file content with a schema)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const ConfigSchema = Schema.Struct({
 *   name: Schema.String,
 *   version: Schema.String,
 *   port: Schema.Number
 * })
 *
 * const jsonConfigPrimitive = Primitive.fileSchema(ConfigSchema, {
 *   format: "json"
 * })
 *
 * const loadConfig = Effect.gen(function*() {
 *   const config = yield* jsonConfigPrimitive.parse("./config.json")
 *   console.log(config) // { name: "my-app", version: "1.0.0", port: 3000 }
 *   return config
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fileSchema = <A>(
  schema: Schema.Decoder<A>,
  options?: FileSchemaOptions | undefined
): Primitive<A> => {
  const decode = Schema.decodeUnknownEffect(schema)
  return makePrimitive(
    "FileSchema",
    Effect.fnUntraced(function*(filePath) {
      const content = yield* fileParse(options).parse(filePath)
      return yield* Effect.mapError(
        decode(content),
        (error) => options?.errorFormatter?.(error.issue) ?? error.toString()
      )
    })
  )
}

/**
 * Parses a single `key=value` pair into a record object.
 *
 * **Example** (Parsing key-value pairs)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const parseKeyValue = Effect.gen(function*() {
 *   const result1 = yield* Primitive.keyValuePair.parse("name=john")
 *   console.log(result1) // { name: "john" }
 *
 *   const result2 = yield* Primitive.keyValuePair.parse("port=3000")
 *   console.log(result2) // { port: "3000" }
 *
 *   const result3 = yield* Primitive.keyValuePair.parse("debug=true")
 *   console.log(result3) // { debug: "true" }
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const keyValuePair: Primitive<Record<string, string>> = makePrimitive(
  "KeyValuePair",
  Effect.fnUntraced(function*(value) {
    const parts = value.split("=")
    if (parts.length !== 2) {
      return yield* Effect.fail(
        `Invalid key=value format. Expected format: key=value, got: ${value}`
      )
    }
    const [key, val] = parts
    if (!key || !val) {
      return yield* Effect.fail(
        `Invalid key=value format. Both key and value must be non-empty. Got: ${value}`
      )
    }
    return { [key]: val }
  })
)

/**
 * Creates a sentinel primitive that always fails to parse a value.
 *
 * **When to use**
 *
 * Use when you need flags that don't accept values.
 *
 * **Example** (Rejecting option values)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Primitive } from "effect/unstable/cli"
 *
 * const program = Effect.gen(function*() {
 *   // This will always fail - useful for boolean flags
 *   return yield* Primitive.none.parse("any-value")
 * })
 *
 * // The above effect will fail with "This option does not accept values"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const none: Primitive<never> = makePrimitive("None", () => Effect.fail("This option does not accept values"))

/**
 * Gets a human-readable type name for a primitive.
 *
 * **When to use**
 *
 * Use when you need generating help documentation.
 *
 * **Example** (Getting primitive type names)
 *
 * ```ts
 * import { Primitive } from "effect/unstable/cli"
 *
 * console.log(Primitive.getTypeName(Primitive.string)) // "string"
 * console.log(Primitive.getTypeName(Primitive.integer)) // "integer"
 * console.log(Primitive.getTypeName(Primitive.boolean)) // "boolean"
 * console.log(Primitive.getTypeName(Primitive.date)) // "date"
 * console.log(Primitive.getTypeName(Primitive.keyValuePair)) // "key=value"
 *
 * const logLevelChoice = Primitive.choice([
 *   ["debug", "debug"],
 *   ["info", "info"]
 * ])
 * console.log(Primitive.getTypeName(logLevelChoice)) // "choice"
 * ```
 *
 * @category utils
 * @since 4.0.0
 */
export const getTypeName = <A>(primitive: Primitive<A>): string => {
  switch (primitive._tag) {
    case "Boolean":
      return "boolean"
    case "String":
      return "string"
    case "Integer":
      return "integer"
    case "Float":
      return "number"
    case "Date":
      return "date"
    case "Path":
      return "path"
    case "Choice":
      return "choice"
    case "Redacted":
      return "string"
    case "FileText":
      return "file"
    case "FileParse":
      return "file"
    case "FileSchema":
      return "file"
    case "KeyValuePair":
      return "key=value"
    case "None":
      return "none"
    default:
      return "value"
  }
}

/** @internal */
export const getChoiceKeys = (primitive: Primitive<unknown>): ReadonlyArray<string> | undefined =>
  primitive._tag === "Choice" ? (primitive as any).choiceKeys : undefined
