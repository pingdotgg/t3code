/**
 * The `Param` module defines the shared parser tree used by the unstable CLI
 * `Argument` and `Flag` modules. A `Param<Kind, A>` describes how to consume
 * either positional arguments or named flags from parsed command-line input and
 * return a typed value.
 *
 * **Common tasks**
 *
 * - Build primitive CLI inputs such as strings, booleans, numbers, choices,
 *   paths, files, and redacted values
 * - Attach help metadata with aliases and descriptions
 * - Transform parsed values with pure or effectful validation
 * - Model missing inputs with `Option`, defaults, config fallbacks, or prompts
 * - Accept repeated inputs with variadic, bounded, and non-empty parameters
 *
 * **Gotchas**
 *
 * - The `Kind` type parameter (`"argument"` or `"flag"`) keeps positional
 *   arguments and flags separate while allowing the implementation and
 *   combinators to be shared.
 * - Combinators preserve the parameter kind, so an argument parameter cannot be
 *   accidentally composed into a flag parameter or the reverse.
 * - Parsers return both the remaining positional arguments and the parsed
 *   value; this is important for argument ordering and variadic parameters.
 * - Some parsers require CLI services such as filesystem, path, terminal, or
 *   child-process support through the parsing environment.
 *
 * @since 4.0.0
 */
import * as Config from "../../Config.ts"
import * as Effect from "../../Effect.ts"
import type * as FileSystem from "../../FileSystem.ts"
import { dual, identity } from "../../Function.ts"
import * as Option from "../../Option.ts"
import type * as Path from "../../Path.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import type * as Redacted from "../../Redacted.ts"
import * as Result from "../../Result.ts"
import * as Schema from "../../Schema.ts"
import type * as Terminal from "../../Terminal.ts"
import type { Covariant } from "../../Types.ts"
import type { ChildProcessSpawner } from "../process/ChildProcessSpawner.ts"
import * as CliError from "./CliError.ts"
import * as Primitive from "./Primitive.ts"
import * as Prompt from "./Prompt.ts"

const TypeId = "~effect/cli/Param"

/**
 * Polymorphic CLI parameter shared by `Argument` and `Flag`.
 *
 * **Details**
 *
 * A parameter knows whether it consumes positional arguments or flags and
 * parses a `ParsedArgs` value into its typed result.
 *
 * @category models
 * @since 4.0.0
 */
export interface Param<Kind extends ParamKind, out A> extends Param.Variance<A> {
  readonly _tag: "Single" | "Map" | "Transform" | "Optional" | "Variadic"
  readonly kind: Kind
  readonly parse: Parse<A>
}

/**
 * Discriminator for whether a `Param` parses positional arguments or
 * command-line flags.
 *
 * @category models
 * @since 4.0.0
 */
export type ParamKind = "argument" | "flag"

/**
 * Services that parameter parsing can require, such as filesystem, path,
 * terminal, and child-process support.
 *
 * @category models
 * @since 4.0.0
 */
export type Environment = FileSystem.FileSystem | Path.Path | Terminal.Terminal | ChildProcessSpawner

/**
 * Defines the kind discriminator for positional argument parameters.
 *
 * **When to use**
 *
 * Use to build low-level `Param` constructors or type positions for positional
 * argument parameters.
 *
 * @see {@link flagKind} for the named flag parameter discriminator
 * @see {@link ParamKind} for the full parameter kind union
 *
 * @category constants
 * @since 4.0.0
 */
export const argumentKind: "argument" = "argument" as const

/**
 * Defines the kind discriminator for flag parameters.
 *
 * **When to use**
 *
 * Use to build low-level `Param` constructors or type positions for named flag
 * parameters.
 *
 * @see {@link argumentKind} for the positional argument parameter discriminator
 *
 * @category constants
 * @since 4.0.0
 */
export const flagKind: "flag" = "flag" as const

/**
 * Represents any parameter.
 *
 * @category models
 * @since 4.0.0
 */
export type Any = Param<ParamKind, unknown>

/**
 * Represents any positional argument parameter.
 *
 * @category models
 * @since 4.0.0
 */
export type AnyArgument = Param<typeof argumentKind, unknown>

/**
 * Represents any flag parameter.
 *
 * @category models
 * @since 4.0.0
 */
export type AnyFlag = Param<typeof flagKind, unknown>

/**
 * Function type used by parameters to parse currently available flags and
 * positional arguments.
 *
 * **Details**
 *
 * It returns the remaining positional arguments together with the parsed value,
 * or fails with a `CliError` while requiring the CLI parsing environment.
 *
 * @category models
 * @since 4.0.0
 */
export type Parse<A> = (args: ParsedArgs) => Effect.Effect<
  readonly [leftover: ReadonlyArray<string>, value: A],
  CliError.CliError,
  Environment
>

/**
 * Namespace containing type-level utilities attached to the `Param` interface.
 *
 * @since 4.0.0
 */
export declare namespace Param {
  /**
   * Variance and pipeability marker carried by every `Param` value.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Variance<out A> extends Pipeable {
    readonly [TypeId]: {
      readonly _A: Covariant<A>
    }
  }
}

/**
 * Map of flag names to their provided string values.
 * Multiple occurrences of a flag produce multiple values.
 *
 * @category models
 * @since 4.0.0
 */
export type Flags = Record<string, ReadonlyArray<string>>

/**
 * Input context passed to `Param.parse` implementations.
 * - `flags`: already-collected flag values by canonical flag name
 * - `arguments`: remaining positional arguments to be consumed
 *
 * @category models
 * @since 4.0.0
 */
export interface ParsedArgs {
  readonly flags: Flags
  readonly arguments: ReadonlyArray<string>
}

/**
 * Represents a fallback prompt that can either be provided directly or
 * computed effectfully when the parameter is missing.
 *
 * @category models
 * @since 4.0.0
 */
export type FallbackPrompt<A> =
  | Prompt.Prompt<A>
  | Effect.Effect<Prompt.Prompt<A>, CliError.CliError, Environment>

/**
 * Leaf parameter that reads one named argument or flag with a primitive parser.
 *
 * **Details**
 *
 * Single parameters carry the user-facing name, aliases, description, primitive
 * type, and optional metavar/type name used in help output.
 *
 * @category models
 * @since 4.0.0
 */
export interface Single<Kind extends ParamKind, out A> extends Param<Kind, A> {
  readonly _tag: "Single"
  readonly kind: Kind
  readonly name: string
  readonly description: Option.Option<string>
  readonly aliases: ReadonlyArray<string>
  readonly primitiveType: Primitive.Primitive<A>
  readonly typeName?: string | undefined
  readonly hidden: boolean
}

/**
 * Parameter node that maps the successfully parsed value of another parameter
 * with a pure function.
 *
 * @category models
 * @since 4.0.0
 */
export interface Map<Kind extends ParamKind, in out A, out B> extends Param<Kind, B> {
  readonly _tag: "Map"
  readonly kind: Kind
  readonly param: Param<Kind, A>
  readonly f: (value: A) => B
}

/**
 * Parameter node that rewrites another parameter's parser, allowing effectful
 * validation, fallback behavior, or error translation while preserving the same
 * parameter kind.
 *
 * @category models
 * @since 4.0.0
 */
export interface Transform<Kind extends ParamKind, in out A, out B> extends Param<Kind, B> {
  readonly _tag: "Transform"
  readonly kind: Kind
  readonly param: Param<Kind, A>
  readonly f: (parse: Parse<A>) => Parse<B>
}

/**
 * Parameter node that turns a missing argument or flag into `Option.none()` and
 * a present parsed value into `Option.some(value)`.
 *
 * @category models
 * @since 4.0.0
 */
export interface Optional<Kind extends ParamKind, A> extends Param<Kind, Option.Option<A>> {
  readonly _tag: "Optional"
  readonly kind: Kind
  readonly param: Param<Kind, A>
}

/**
 * Parameter node that parses another parameter zero or more times and returns
 * all parsed values as an array, respecting optional minimum and maximum
 * occurrence bounds.
 *
 * @category models
 * @since 4.0.0
 */
export interface Variadic<Kind extends ParamKind, A> extends Param<Kind, ReadonlyArray<A>> {
  readonly _tag: "Variadic"
  readonly kind: Kind
  readonly param: Param<Kind, A>
  readonly min: Option.Option<number>
  readonly max: Option.Option<number>
}

const Proto = {
  [TypeId]: {
    _A: identity
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * Type guard to check if a value is a Param.
 *
 * **Example** (Checking for params)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const maybeParam = Param.string(Param.flagKind, "name")
 *
 * if (Param.isParam(maybeParam)) {
 *   console.log("This is a Param")
 * }
 * ```
 *
 * @category refinements
 * @since 4.0.0
 */
export const isParam = (u: unknown): u is Param<any, ParamKind> => Predicate.hasProperty(u, TypeId)

/**
 * Type guard to check if a param is a Single param (not composed).
 *
 * **Example** (Checking for single params)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const nameParam = Param.string(Param.flagKind, "name")
 * const optionalParam = Param.optional(nameParam)
 *
 * console.log(Param.isSingle(nameParam)) // true
 * console.log(Param.isSingle(optionalParam)) // false
 * ```
 *
 * @category refinements
 * @since 4.0.0
 */
export const isSingle = <const Kind extends ParamKind, A>(
  param: Param<Kind, A>
): param is Single<Kind, A> => Predicate.isTagged(param, "Single")

/**
 * Type guard to check if a Single param is a flag (not an argument).
 *
 * @internal
 */
export const isFlagParam = <A>(
  single: Single<ParamKind, A>
): single is Single<typeof flagKind, A> => single.kind === "flag"

/**
 * Constructs a leaf `Single` parameter from its kind, name, primitive parser,
 * and optional help metadata.
 *
 * **Details**
 *
 * The returned parser reads either one positional argument or the named flag,
 * depending on `kind`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeSingle = <const Kind extends ParamKind, A>(params: {
  readonly kind: Kind
  readonly name: string
  readonly primitiveType: Primitive.Primitive<A>
  readonly typeName?: string | undefined
  readonly description?: Option.Option<string> | undefined
  readonly aliases?: ReadonlyArray<string> | undefined
  readonly hidden?: boolean | undefined
}): Single<Kind, A> => {
  const parse: Parse<A> = (args) =>
    params.kind === argumentKind
      ? parsePositional(params.name, params.primitiveType, args)
      : parseFlag(params.name, params.primitiveType, args)
  return Object.assign(Object.create(Proto), {
    _tag: "Single",
    ...params,
    description: params.description ?? Option.none(),
    aliases: params.aliases ?? [],
    hidden: params.hidden ?? false,
    parse
  })
}

/**
 * Creates a string parameter.
 *
 * **Example** (Creating string parameters)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Create a string flag
 * const nameFlag = Param.string(Param.flagKind, "name")
 *
 * // Create a string argument
 * const fileArg = Param.string(Param.argumentKind, "file")
 *
 * // Usage in CLI: --name "John Doe" or as positional argument
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const string = <const Kind extends ParamKind>(
  kind: Kind,
  name: string
): Param<Kind, string> =>
  makeSingle({
    name,
    primitiveType: Primitive.string,
    kind
  })

/**
 * Creates a boolean parameter.
 *
 * **Example** (Creating boolean parameters)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Create a boolean flag
 * const verboseFlag = Param.boolean(Param.flagKind, "verbose")
 *
 * // Create a boolean argument
 * const enableArg = Param.boolean(Param.argumentKind, "enable")
 *
 * // Usage in CLI: --verbose (defaults to true when present, false when absent)
 * // or as positional: true/false
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const boolean = <const Kind extends ParamKind>(
  kind: Kind,
  name: string
): Param<Kind, boolean> =>
  makeSingle({
    name,
    primitiveType: Primitive.boolean,
    kind
  })

/**
 * Creates an integer parameter.
 *
 * **Example** (Creating integer parameters)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Create an integer flag
 * const portFlag = Param.integer(Param.flagKind, "port")
 *
 * // Create an integer argument
 * const countArg = Param.integer(Param.argumentKind, "count")
 *
 * // Usage in CLI: --port 8080 or as positional argument: 42
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const integer = <const Kind extends ParamKind>(
  kind: Kind,
  name: string
): Param<Kind, number> =>
  makeSingle({
    name,
    primitiveType: Primitive.integer,
    kind
  })

/**
 * Creates a floating-point number parameter.
 *
 * **Example** (Creating float parameters)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Create a float flag
 * const rateFlag = Param.float(Param.flagKind, "rate")
 *
 * // Create a float argument
 * const thresholdArg = Param.float(Param.argumentKind, "threshold")
 *
 * // Usage in CLI: --rate 0.95 or as positional argument: 3.14159
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const float = <const Kind extends ParamKind>(
  kind: Kind,
  name: string
): Param<Kind, number> =>
  makeSingle({
    name,
    primitiveType: Primitive.float,
    kind
  })

/**
 * Creates a date parameter that parses ISO date strings.
 *
 * **Example** (Creating date parameters)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Create a date flag
 * const startFlag = Param.date(Param.flagKind, "start-date")
 *
 * // Create a date argument
 * const dueDateArg = Param.date(Param.argumentKind, "due-date")
 *
 * // Usage in CLI: --start-date "2023-12-25" or as positional: "2023-01-01"
 * // Parses to JavaScript Date object
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const date = <const Kind extends ParamKind>(
  kind: Kind,
  name: string
): Param<Kind, Date> =>
  makeSingle({
    name,
    primitiveType: Primitive.date,
    kind
  })

/**
 * Constructs command-line params that represent a choice between several
 * inputs. The input will be mapped to it's associated value during parsing.
 *
 * **Example** (Creating valued choices)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * type Animal = Dog | Cat
 *
 * interface Dog {
 *   readonly _tag: "Dog"
 * }
 *
 * interface Cat {
 *   readonly _tag: "Cat"
 * }
 *
 * const animal = Param.choiceWithValue(Param.flagKind, "animal", [
 *   ["dog", { _tag: "Dog" }],
 *   ["cat", { _tag: "Cat" }]
 * ])
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const choiceWithValue = <
  const Kind extends ParamKind,
  const Choices extends ReadonlyArray<readonly [string, any]>
>(kind: Kind, name: string, choices: Choices): Param<Kind, Choices[number][1]> =>
  makeSingle({
    name,
    primitiveType: Primitive.choice(choices),
    kind
  })

/**
 * Constructs command-line params that represent a choice between several
 * string inputs.
 *
 * **Example** (Creating string choices)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const logLevel = Param.choice(Param.flagKind, "log-level", [
 *   "debug",
 *   "info",
 *   "warn",
 *   "error"
 * ])
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const choice = <
  const Kind extends ParamKind,
  const Choices extends ReadonlyArray<string>
>(kind: Kind, name: string, choices: Choices): Param<Kind, Choices[number]> => {
  const mappedChoices = choices.map((value) => [value, value] as const)
  return choiceWithValue(kind, name, mappedChoices)
}

/**
 * Creates a path parameter that accepts file or directory paths.
 *
 * **Example** (Creating path parameters)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Basic path parameter
 * const outputPath = Param.path(Param.flagKind, "output")
 *
 * // Path that must exist
 * const inputPath = Param.path(Param.flagKind, "input", { mustExist: true })
 *
 * // File-only path
 * const configFile = Param.path(Param.flagKind, "config", {
 *   pathType: "file",
 *   mustExist: true,
 *   typeName: "config-file"
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const path = <Kind extends ParamKind>(
  kind: Kind,
  name: string,
  options?: {
    readonly pathType?: Primitive.PathType | undefined
    readonly mustExist?: boolean | undefined
    readonly typeName?: string | undefined
  }
): Param<Kind, string> =>
  makeSingle({
    name,
    kind,
    primitiveType: Primitive.path(options?.pathType ?? "either", options?.mustExist),
    typeName: options?.typeName
  })

/**
 * Creates a directory path parameter.
 *
 * **Details**
 *
 * This is a convenience function that creates a path parameter with the
 * `pathType` set to `"directory"` and a default type name of `"directory"`.
 *
 * **Example** (Creating directory parameters)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Basic directory parameter
 * const outputDir = Param.directory(Param.flagKind, "output-dir")
 *
 * // Directory that must exist
 * const sourceDir = Param.directory(Param.flagKind, "source", { mustExist: true })
 *
 * // Usage: --output-dir /path/to/dir --source /existing/dir
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const directory = <Kind extends ParamKind>(
  kind: Kind,
  name: string,
  options?: {
    readonly mustExist?: boolean | undefined
  }
): Param<Kind, string> =>
  path(kind, name, {
    pathType: "directory",
    typeName: "directory",
    mustExist: options?.mustExist
  })

/**
 * Creates a file path parameter.
 *
 * **Details**
 *
 * This is a convenience function that creates a path parameter with a
 * `pathType` set to `"file"` and a default type name of `"file"`.
 *
 * **Example** (Creating file parameters)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Basic file parameter
 * const outputFile = Param.file(Param.flagKind, "output")
 *
 * // File that must exist
 * const inputFile = Param.file(Param.flagKind, "input", { mustExist: true })
 *
 * // Usage: --output result.txt --input existing-file.txt
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const file = <Kind extends ParamKind>(
  kind: Kind,
  name: string,
  options?: {
    readonly mustExist?: boolean | undefined
  }
): Param<Kind, string> =>
  path(kind, name, {
    pathType: "file",
    typeName: "file",
    mustExist: options?.mustExist
  })

/**
 * Creates a redacted parameter for sensitive data like passwords.
 * The value is masked in help output and logging.
 *
 * **Example** (Creating redacted parameters)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Create a password parameter
 * const password = Param.redacted(Param.flagKind, "password")
 *
 * // Create an API key argument
 * const apiKey = Param.redacted(Param.argumentKind, "api-key")
 *
 * // Usage: --password (value will be hidden in help/logs)
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const redacted = <Kind extends ParamKind>(
  kind: Kind,
  name: string
): Param<Kind, Redacted.Redacted<string>> =>
  makeSingle({
    name,
    primitiveType: Primitive.redacted,
    kind
  })

/**
 * Creates a parameter that reads and returns file content as a string.
 *
 * **Example** (Reading file text)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Read a config file as string
 * const configContent = Param.fileText(Param.flagKind, "config")
 *
 * // Read a template file as argument
 * const templateContent = Param.fileText(Param.argumentKind, "template")
 *
 * // Usage: --config config.txt (reads file content into string)
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fileText = <Kind extends ParamKind>(kind: Kind, name: string): Param<Kind, string> =>
  makeSingle({
    name,
    primitiveType: Primitive.fileText,
    kind
  })

/**
 * Creates a param that reads and parses the content of the specified file.
 *
 * **Details**
 *
 * The parser that is utilized will depend on the specified `format`, or the
 * extension of the file passed on the command-line if no `format` is specified.
 *
 * **Example** (Parsing file contents)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Will use the extension of the file passed on the command line to determine
 * // the parser to use
 * const config = Param.fileParse(Param.flagKind, "config")
 *
 * // Will use the JSON parser
 * const jsonConfig = Param.fileParse(Param.flagKind, "json-config", {
 *   format: "json"
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fileParse = <Kind extends ParamKind>(
  kind: Kind,
  name: string,
  options?: Primitive.FileParseOptions | undefined
): Param<Kind, unknown> =>
  makeSingle({
    name,
    primitiveType: Primitive.fileParse(options),
    kind
  })

/**
 * Creates a parameter that reads and validates file content using a schema.
 *
 * **Example** (Validating file contents)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Param } from "effect/unstable/cli"
 * // @internal - this module is not exported publicly
 *
 * // Parse JSON config file
 * const configSchema = Schema.Struct({
 *   port: Schema.Number,
 *   host: Schema.String
 * })
 *
 * const config = Param.fileSchema(Param.flagKind, "config", configSchema, {
 *   format: "json"
 * })
 *
 * // Parse YAML file
 * const yamlConfig = Param.fileSchema(Param.flagKind, "config", configSchema, {
 *   format: "yaml"
 * })
 *
 * // Usage: --config config.json (reads and validates file content)
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fileSchema = <Kind extends ParamKind, A>(
  kind: Kind,
  name: string,
  schema: Schema.Decoder<A>,
  options?: Primitive.FileSchemaOptions | undefined
): Param<Kind, A> =>
  makeSingle({
    name,
    primitiveType: Primitive.fileSchema(schema, options),
    kind
  })

/**
 * Creates a param that parses key=value pairs.
 *
 * **When to use**
 *
 * Use when you use it for options that accept configuration values.
 *
 * **Details**
 *
 * Requires at least one key=value pair. The parsed pairs are merged into a
 * single record object.
 *
 * **Example** (Parsing key-value pairs)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const env = Param.keyValuePair(Param.flagKind, "env")
 * // --env FOO=bar --env BAZ=qux will parse to { FOO: "bar", BAZ: "qux" }
 *
 * const props = Param.keyValuePair(Param.flagKind, "property")
 * // --property name=value --property debug=true
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const keyValuePair = <Kind extends ParamKind>(
  kind: Kind,
  name: string
): Param<Kind, Record<string, string>> =>
  map(
    variadic(
      makeSingle({
        name,
        primitiveType: Primitive.keyValuePair,
        kind
      }),
      { min: 1 }
    ),
    (objects) => Object.assign({}, ...objects)
  )

/**
 * Creates an empty sentinel parameter that always fails to parse.
 *
 * **When to use**
 *
 * Use when this is useful for creating placeholder parameters or for combinators.
 *
 * **Example** (Creating sentinel parameters)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const disabledDebugParam = Param.none(Param.flagKind)
 *
 * const makeDebugParam = (enableDebug: boolean) =>
 *   enableDebug ? Param.string(Param.flagKind, "debug") : disabledDebugParam
 *
 * console.log(makeDebugParam(true) === disabledDebugParam) // false
 * console.log(makeDebugParam(false) === disabledDebugParam) // true
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const none = <Kind extends ParamKind>(kind: Kind): Param<Kind, never> =>
  makeSingle({
    name: "__none__",
    primitiveType: Primitive.none,
    kind
  })

const FLAG_DASH_REGEXP = /^-+/

/**
 * Adds an alias to an option.
 *
 * **When to use**
 *
 * Use when aliases allow params to be specified with alternative names,
 * typically single-character shortcuts like "-f" for "--force".
 *
 * **Details**
 *
 * This works on any param structure by recursively finding the underlying
 * `Single` node and applying the alias there.
 *
 * **Example** (Adding parameter aliases)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const force = Param.boolean(Param.flagKind, "force").pipe(
 *   Param.withAlias("-f"),
 *   Param.withAlias("-F")
 * )
 *
 * // Also works on composed params:
 * const count = Param.integer(Param.flagKind, "count").pipe(
 *   Param.optional,
 *   Param.withAlias("-c") // finds the underlying Single and adds alias
 * )
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const withAlias: {
  <Kind extends ParamKind, A>(alias: string): (self: Param<Kind, A>) => Param<Kind, A>
  <Kind extends ParamKind, A>(self: Param<Kind, A>, alias: string): Param<Kind, A>
} = dual(2, <Kind extends ParamKind, A>(self: Param<Kind, A>, alias: string) => {
  return transformSingle(self, <X>(single: Single<Kind, X>) =>
    makeSingle({
      ...single,
      aliases: [...single.aliases, alias.replace(FLAG_DASH_REGEXP, "")]
    }))
})

/**
 * Adds a description to an option for help text.
 *
 * **Details**
 *
 * Descriptions provide users with information about what the option does
 * when they view help documentation.
 *
 * **Example** (Adding help descriptions)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const verbose = Param.boolean(Param.flagKind, "verbose").pipe(
 *   Param.withAlias("-v"),
 *   Param.withDescription("Enable verbose output")
 * )
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const withDescription: {
  <Kind extends ParamKind, A>(description: string): (self: Param<Kind, A>) => Param<Kind, A>
  <Kind extends ParamKind, A>(self: Param<Kind, A>, description: string): Param<Kind, A>
} = dual(2, <Kind extends ParamKind, A>(self: Param<Kind, A>, description: string) => {
  return transformSingle(self, <X>(single: Single<Kind, X>) =>
    makeSingle({
      ...single,
      description: Option.some(description)
    }))
})

/**
 * Hides a parameter from generated help output and completions while keeping
 * it parseable on the command line.
 *
 * **When to use**
 *
 * Use when experimental, internal, or deprecated flags that should be
 * accepted but not advertised.
 *
 * **Example** (Hiding a flag from help)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const experimental = Param.boolean(Param.flagKind, "experimental-foo").pipe(
 *   Param.withHidden
 * )
 * ```
 *
 * @category metadata
 * @since 4.0.0
 */
export const withHidden = <Kind extends ParamKind, A>(self: Param<Kind, A>): Param<Kind, A> =>
  transformSingle(self, <X>(single: Single<Kind, X>) =>
    makeSingle({
      ...single,
      hidden: true
    }))

/**
 * Transforms the parsed value of an option using a mapping function.
 *
 * **Example** (Mapping parsed values)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const port = Param.integer(Param.flagKind, "port").pipe(
 *   Param.map((n) => ({ port: n, url: `http://localhost:${n}` }))
 * )
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const map: {
  <A, B>(f: (a: A) => B): <Kind extends ParamKind>(self: Param<Kind, A>) => Param<Kind, B>
  <Kind extends ParamKind, A, B>(self: Param<Kind, A>, f: (a: A) => B): Param<Kind, B>
} = dual(2, <Kind extends ParamKind, A, B>(self: Param<Kind, A>, f: (a: A) => B) => {
  const parse: Parse<B> = (args: ParsedArgs) =>
    Effect.map(
      self.parse(args),
      ([operands, value]) => [operands, f(value)] as const
    )
  return Object.assign(Object.create(Proto), {
    _tag: "Map",
    kind: self.kind,
    param: self,
    f,
    parse
  })
})

const transform = <Kind extends ParamKind, A, B>(
  self: Param<Kind, A>,
  f: (parse: Parse<A>) => Parse<B>
) =>
  Object.assign(Object.create(Proto), {
    _tag: "Transform",
    kind: self.kind,
    param: self,
    f,
    parse: f(self.parse)
  })

/**
 * Transforms the parsed value of an option using an effectful mapping function.
 *
 * **Example** (Mapping parsed values effectfully)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { CliError, Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const validatedEmail = Param.string(Param.flagKind, "email").pipe(
 *   Param.mapEffect((email) =>
 *     email.includes("@")
 *       ? Effect.succeed(email)
 *       : Effect.fail(
 *         new CliError.InvalidValue({
 *           option: "email",
 *           value: email,
 *           expected: "valid email format",
 *           kind: "flag"
 *         })
 *       )
 *   )
 * )
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const mapEffect: {
  <A, B>(
    f: (a: A) => Effect.Effect<B, CliError.CliError, Environment>
  ): <Kind extends ParamKind>(self: Param<Kind, A>) => Param<Kind, B>
  <Kind extends ParamKind, A, B>(
    self: Param<Kind, A>,
    f: (a: A) => Effect.Effect<B, CliError.CliError, Environment>
  ): Param<Kind, B>
} = dual(2, <Kind extends ParamKind, A, B>(
  self: Param<Kind, A>,
  f: (a: A) => Effect.Effect<B, CliError.CliError, Environment>
) =>
  transform(
    self,
    (parse: Parse<A>) => (args: ParsedArgs) =>
      Effect.flatMap(parse(args), ([leftover, a]) =>
        f(a).pipe(
          Effect.map((b) => [leftover, b] as const)
        ))
  ))

/**
 * Transforms the parsed value of an option using a function that may throw,
 * converting any thrown errors into failure messages.
 *
 * **Example** (Mapping thrown errors)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const parsedJson = Param.string(Param.flagKind, "config").pipe(
 *   Param.mapTryCatch(
 *     (str) => JSON.parse(str),
 *     (error) =>
 *       `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`
 *   )
 * )
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const mapTryCatch: {
  <A, B>(
    f: (a: A) => B,
    onError: (error: unknown) => string
  ): <Kind extends ParamKind>(self: Param<Kind, A>) => Param<Kind, B>
  <Kind extends ParamKind, A, B>(
    self: Param<Kind, A>,
    f: (a: A) => B,
    onError: (error: unknown) => string
  ): Param<Kind, B>
} = dual(3, <Kind extends ParamKind, A, B>(
  self: Param<Kind, A>,
  f: (a: A) => B,
  onError: (error: unknown) => string
) => {
  const single = getUnderlyingSingleOrThrow(self)

  return transform(
    self,
    (parse: Parse<A>) => (args: ParsedArgs) =>
      Effect.flatMap(parse(args), ([leftover, a]) =>
        Effect.try({
          try: () => f(a),
          catch: (error) => onError(error)
        }).pipe(
          Effect.mapError(
            (error) =>
              new CliError.InvalidValue({
                option: single.name,
                value: String(a),
                expected: error,
                kind: single.kind
              })
          ),
          Effect.map((b) => [leftover, b] as const)
        ))
  )
})

/**
 * Makes a flag or positional argument optional.
 *
 * **Details**
 *
 * When the parameter is absent, parsing succeeds with `Option.none()` instead
 * of failing with a missing option or missing argument error. When present, the
 * parsed value is wrapped in `Option.some()`.
 *
 * **Example** (Making parameters optional)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // Create an optional port option
 * // - When not provided: returns Option.none()
 * // - When provided: returns Option.some(parsedValue)
 * const port = Param.optional(Param.integer(Param.flagKind, "port"))
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const optional = <Kind extends ParamKind, A>(
  param: Param<Kind, A>
): Param<Kind, Option.Option<A>> => {
  const parse: Parse<Option.Option<A>> = Effect.fnUntraced(function*(args) {
    const single = getUnderlyingSingleOrThrow(param)

    // Handle boolean params that are explicitly marked as optional (i.e. the
    // end user wants to return `Option.none()` instead of `false` when the
    // flag (or its negated variant) are not present on the command line
    if (
      isFlagParam(single) &&
      Primitive.isBoolean(single.primitiveType) &&
      ![single.name, ...single.aliases].some((name) => (args.flags[name] ?? []).length > 0)
    ) {
      return [args.arguments, Option.none()] as const
    }

    return yield* param.parse(args).pipe(
      Effect.map(([leftover, value]) => [leftover, Option.some(value)] as const),
      // Catch both MissingOption (for flags) and MissingArgument (for positional arguments)
      Effect.catchTags({
        MissingOption: () => Effect.succeed([args.arguments, Option.none()] as const),
        MissingArgument: () => Effect.succeed([args.arguments, Option.none()] as const)
      })
    )
  })
  return Object.assign(Object.create(Proto), {
    _tag: "Optional",
    kind: param.kind,
    param,
    parse
  })
}

/**
 * Makes a flag or positional argument optional by supplying a fallback value.
 *
 * **Details**
 *
 * The fallback may be a pure value or an effect. It is used only when the
 * parameter is absent; provided values are parsed normally.
 *
 * **Example** (Providing default values)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Using the pipe operator to make an option optional
 * const port = Param.integer(Param.flagKind, "port").pipe(
 *   Param.withDefault(8080)
 * )
 *
 * // Can also be used with other combinators
 * const verbose = Param.boolean(Param.flagKind, "verbose").pipe(
 *   Param.withAlias("-v"),
 *   Param.withDescription("Enable verbose output"),
 *   Param.withDefault(false)
 * )
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const withDefault: {
  <const B>(
    defaultValue: B | Effect.Effect<B, CliError.CliError, Environment>
  ): <Kind extends ParamKind, A>(self: Param<Kind, A>) => Param<Kind, A | B>
  <Kind extends ParamKind, A, const B>(
    self: Param<Kind, A>,
    defaultValue: B | Effect.Effect<B, CliError.CliError, Environment>
  ): Param<Kind, A | B>
} = dual(2, <Kind extends ParamKind, A, const B>(
  self: Param<Kind, A>,
  defaultValue: B | Effect.Effect<B, CliError.CliError, Environment>
): Param<Kind, A | B> => {
  if (!Effect.isEffect(defaultValue)) {
    return map(optional(self), Option.getOrElse(() => defaultValue))
  }
  return mapEffect(
    optional(self as Param<Kind, A | B>),
    Option.match({
      onNone: () => defaultValue,
      onSome: Effect.succeed
    })
  )
})

/**
 * Adds a fallback config that is loaded when a required parameter is missing.
 *
 * **When to use**
 *
 * Use when config should provide a fallback source for required flags or
 * arguments that are absent from CLI input.
 *
 * **Details**
 *
 * Provided CLI values win. Config is loaded only after a missing option or
 * missing argument error.
 *
 * **Gotchas**
 *
 * Missing config preserves the original missing-parameter error. Config parse
 * failure becomes `CliError.InvalidValue`.
 *
 * @see {@link withDefault} for a pure default value
 * @see {@link withFallbackPrompt} for prompting interactively when input is missing
 *
 * @category combinators
 * @since 4.0.0
 */
export const withFallbackConfig: {
  <B>(config: Config.Config<B>): <Kind extends ParamKind, A>(self: Param<Kind, A>) => Param<Kind, A | B>
  <Kind extends ParamKind, A, B>(self: Param<Kind, A>, config: Config.Config<B>): Param<Kind, A | B>
} = dual(2, <Kind extends ParamKind, A, B>(
  self: Param<Kind, A>,
  config: Config.Config<B>
): Param<Kind, A | B> => {
  const toInvalidValue = (
    error: CliError.MissingOption | CliError.MissingArgument,
    configError: Config.ConfigError
  ): CliError.InvalidValue =>
    new CliError.InvalidValue({
      option: error._tag === "MissingOption" ? error.option : error.argument,
      value: "config",
      expected: configError.message,
      kind: error._tag === "MissingOption" ? "flag" : "argument"
    })
  const runConfig = (error: CliError.MissingOption | CliError.MissingArgument, args: ParsedArgs) =>
    Config.option(config).pipe(
      Effect.mapError((configError) => toInvalidValue(error, configError)),
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(error),
        onSome: (value) => Effect.succeed([args.arguments, value as A | B] as const)
      }))
    )
  return transform(
    self,
    (parse) => (args) =>
      parse(args).pipe(
        Effect.catchTag(["MissingOption", "MissingArgument"], (error) => runConfig(error, args))
      )
  )
})

/**
 * Adds a fallback prompt that is shown when a required parameter is missing.
 *
 * **When to use**
 *
 * Use when a CLI should ask interactively for a missing required flag or
 * argument.
 *
 * **Details**
 *
 * `FallbackPrompt` accepts either a `Prompt` or an effect that builds one.
 * Effectful prompt creation is lazy and runs only when the fallback is needed.
 *
 * **Gotchas**
 *
 * This only handles missing options and missing arguments. Invalid values do not
 * prompt, and prompt cancellation re-fails with the original missing error.
 *
 * @see {@link FallbackPrompt} for accepted fallback prompt forms
 * @see {@link withFallbackConfig} for loading a fallback from config
 * @see {@link withDefault} for a pure default value
 *
 * @category combinators
 * @since 4.0.0
 */
export const withFallbackPrompt: {
  <B>(prompt: FallbackPrompt<B>): <Kind extends ParamKind, A>(self: Param<Kind, A>) => Param<Kind, A | B>
  <Kind extends ParamKind, A, B>(self: Param<Kind, A>, prompt: FallbackPrompt<B>): Param<Kind, A | B>
} = dual(2, <Kind extends ParamKind, A, B>(
  self: Param<Kind, A>,
  prompt: FallbackPrompt<B>
): Param<Kind, A | B> => {
  const runPrompt = (error: CliError.MissingOption | CliError.MissingArgument, args: ParsedArgs) =>
    Effect.flatMap(Prompt.isPrompt(prompt) ? Effect.succeed(prompt) : prompt, Prompt.run).pipe(
      Effect.map((value) => [args.arguments, value as A | B] as const),
      Effect.catchTag("QuitError", () => Effect.fail(error))
    )
  return transform(
    self,
    (parse) => (args) =>
      parse(args).pipe(
        Effect.catchTag(["MissingOption", "MissingArgument"], (error) => runPrompt(error, args))
      )
  )
})

/**
 * Represent options which can be used to configure variadic parameters.
 *
 * @category models
 * @since 4.0.0
 */
export type VariadicParamOptions = {
  /**
   * The minimum number of times the parameter can be specified.
   */
  readonly min?: number | undefined
  /**
   * The maximum number of times the parameter can be specified.
   */
  readonly max?: number | undefined
}

/**
 * Creates a variadic parameter that can be specified multiple times.
 *
 * **Details**
 *
 * This is the base combinator for creating parameters that accept multiple values.
 * The min and max parameters are optional - if not provided, the parameter can be
 * specified any number of times (0 to infinity).
 *
 * **Example** (Accepting multiple values)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Basic variadic parameter (0 to infinity)
 * const tags = Param.variadic(Param.string(Param.flagKind, "tag"))
 *
 * // Variadic with minimum count
 * const inputs = Param.variadic(
 *   Param.string(Param.flagKind, "input"),
 *   { min: 1 } // at least 1 required
 * )
 *
 * // Variadic with both min and max
 * const limited = Param.variadic(Param.string(Param.flagKind, "item"), {
 *   min: 2, // at least 2 times
 *   max: 2 // at most 2 times
 * })
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const variadic = <Kind extends ParamKind, A>(
  self: Param<Kind, A>,
  options?: VariadicParamOptions | undefined
): Param<Kind, ReadonlyArray<A>> => {
  const single = getUnderlyingSingleOrThrow(self)
  const parse: Parse<ReadonlyArray<A>> = (args) => {
    if (single.kind === "argument") {
      return parsePositionalVariadic(self, single, args, options)
    } else {
      return parseOptionVariadic(self, single, args, options)
    }
  }
  return Object.assign(Object.create(Proto), {
    _tag: "Variadic",
    kind: self.kind,
    param: self,
    min: Option.fromUndefinedOr(options?.min),
    max: Option.fromUndefinedOr(options?.max),
    parse
  })
}

/**
 * Wraps an option to allow it to be specified multiple times within a range.
 *
 * **Details**
 *
 * This combinator transforms an option to accept between `min` and `max`
 * occurrences on the command line, returning an array of all provided values.
 *
 * **Example** (Bounding repeated values)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Allow 1-3 file inputs
 * const files = Param.string(Param.flagKind, "file").pipe(
 *   Param.between(1, 3),
 *   Param.withAlias("-f")
 * )
 *
 * // Parse: --file a.txt --file b.txt
 * // Result: ["a.txt", "b.txt"]
 *
 * // Allow 0 or more tags
 * const tags = Param.string(Param.flagKind, "tag").pipe(
 *   Param.between(0, Number.MAX_SAFE_INTEGER)
 * )
 *
 * // Parse: --tag dev --tag staging --tag v1.0
 * // Result: ["dev", "staging", "v1.0"]
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const between: {
  <A>(min: number, max: number): <Kind extends ParamKind>(self: Param<Kind, A>) => Param<Kind, ReadonlyArray<A>>
  <Kind extends ParamKind, A>(self: Param<Kind, A>, min: number, max: number): Param<Kind, ReadonlyArray<A>>
} = dual(3, <Kind extends ParamKind, A>(self: Param<Kind, A>, min: number, max: number) => {
  if (min < 0) {
    throw new Error("between: min must be non-negative")
  }
  if (max < min) {
    throw new Error("between: max must be greater than or equal to min")
  }

  return variadic(self, { min, max })
})

/**
 * Wraps an option to allow it to be specified at most `max` times.
 *
 * **Details**
 *
 * This combinator transforms an option to accept between 0 and `max`
 * occurrences on the command line, returning an array of all provided values.
 *
 * **Example** (Limiting repeated values)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Allow at most 3 warning suppressions
 * const suppressions = Param.string(Param.flagKind, "suppress").pipe(
 *   Param.atMost(3)
 * )
 *
 * // Parse: --suppress warning1 --suppress warning2
 * // Result: ["warning1", "warning2"]
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const atMost: {
  <A>(max: number): <Kind extends ParamKind>(self: Param<Kind, A>) => Param<Kind, ReadonlyArray<A>>
  <Kind extends ParamKind, A>(self: Param<Kind, A>, max: number): Param<Kind, ReadonlyArray<A>>
} = dual(2, <Kind extends ParamKind, A>(self: Param<Kind, A>, max: number) => {
  if (max < 0) {
    throw new Error("atMost: max must be non-negative")
  }
  return variadic(self, { max })
})

/**
 * Wraps an option to require it to be specified at least `min` times.
 *
 * **Details**
 *
 * This combinator transforms an option to accept at least `min`
 * occurrences on the command line, returning an array of all provided values.
 *
 * **Example** (Requiring repeated values)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * // Require at least 2 input files
 * const inputs = Param.string(Param.flagKind, "input").pipe(
 *   Param.atLeast(2),
 *   Param.withAlias("-i")
 * )
 *
 * // Parse: --input file1.txt --input file2.txt --input file3.txt
 * // Result: ["file1.txt", "file2.txt", "file3.txt"]
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const atLeast: {
  <A>(min: number): <Kind extends ParamKind>(self: Param<Kind, A>) => Param<Kind, ReadonlyArray<A>>
  <Kind extends ParamKind, A>(self: Param<Kind, A>, min: number): Param<Kind, ReadonlyArray<A>>
} = dual(2, <Kind extends ParamKind, A>(self: Param<Kind, A>, min: number) => {
  if (min < 0) {
    throw new Error("atLeast: min must be non-negative")
  }
  return variadic(self, { min })
})

/**
 * Filters and transforms parsed values, failing with a custom error message
 * if the filter function returns `Option.none()`.
 *
 * **When to use**
 *
 * Use when you use this combinator for validation and transformation in a single step.
 *
 * **Example** (Filtering and transforming values)
 *
 * ```ts
 * import { Option } from "effect"
 * import { Param } from "effect/unstable/cli"
 * // @internal - this module is not exported publicly
 *
 * const positiveInt = Param.integer(Param.flagKind, "count").pipe(
 *   Param.filterMap(
 *     (n) => n > 0 ? Option.some(n) : Option.none(),
 *     (n) => `Expected positive integer, got ${n}`
 *   )
 * )
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const filterMap: {
  <A, B>(
    filter: (a: A) => Option.Option<B>,
    onNone: (a: A) => string
  ): <Kind extends ParamKind>(self: Param<Kind, A>) => Param<Kind, B>
  <Kind extends ParamKind, A, B>(
    self: Param<Kind, A>,
    filter: (a: A) => Option.Option<B>,
    onNone: (a: A) => string
  ): Param<Kind, B>
} = dual(3, <Kind extends ParamKind, A, B>(
  self: Param<Kind, A>,
  filter: (a: A) => Option.Option<B>,
  onNone: (a: A) => string
) =>
  mapEffect(
    self,
    Effect.fnUntraced(function*(a) {
      const result = filter(a)
      if (Option.isSome(result)) {
        return result.value
      }
      const single = getUnderlyingSingleOrThrow(self)
      return yield* new CliError.InvalidValue({
        option: single.name,
        value: String(a),
        expected: onNone(a),
        kind: single.kind
      })
    })
  ))

/**
 * Filters parsed values, failing with a custom error message if the predicate returns false.
 *
 * **Example** (Filtering parsed values)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const evenNumber = Param.integer(Param.flagKind, "num").pipe(
 *   Param.filter(
 *     (n) => n % 2 === 0,
 *     (n) => `Expected even number, got ${n}`
 *   )
 * )
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const filter: {
  <A>(
    predicate: Predicate.Predicate<A>,
    onFalse: (a: A) => string
  ): <Kind extends ParamKind>(self: Param<Kind, A>) => Param<Kind, A>
  <Kind extends ParamKind, A>(
    self: Param<Kind, A>,
    predicate: Predicate.Predicate<A>,
    onFalse: (a: A) => string
  ): Param<Kind, A>
} = dual(3, <Kind extends ParamKind, A>(
  self: Param<Kind, A>,
  predicate: Predicate.Predicate<A>,
  onFalse: (a: A) => string
) => filterMap(self, Option.liftPredicate(predicate), onFalse))

/**
 * Sets a custom metavar (placeholder name) for the param in help documentation.
 *
 * **Details**
 *
 * The metavar is displayed in usage text to indicate what value the user should provide.
 * For example, `--output FILE` shows `FILE` as the metavar.
 *
 * **Example** (Setting metavars)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const port = Param.integer(Param.flagKind, "port").pipe(
 *   Param.withMetavar("PORT"),
 *   Param.filter(
 *     (p) => p >= 1 && p <= 65535,
 *     () => "Port must be between 1 and 65535"
 *   )
 * )
 * ```
 *
 * @category metadata
 * @since 4.0.0
 */
export const withMetavar: {
  <K extends ParamKind>(metavar: string): <A>(self: Param<K, A>) => Param<K, A>
  <K extends ParamKind, A>(self: Param<K, A>, metavar: string): Param<K, A>
} = dual(2, <K extends ParamKind, A>(
  self: Param<K, A>,
  metavar: string
) =>
  transformSingle(self, (single) =>
    makeSingle({
      ...single,
      typeName: metavar
    })))

/**
 * Validates parsed values against a Schema, providing detailed error messages.
 *
 * **Example** (Validating with schemas)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Param } from "effect/unstable/cli"
 * // @internal - this module is not exported publicly
 *
 * const isEmail = Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
 *
 * const Email = Schema.String.pipe(
 *   Schema.check(isEmail)
 * )
 *
 * const email = Param.string(Param.flagKind, "email").pipe(
 *   Param.withSchema(Email)
 * )
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const withSchema: {
  <A, B>(schema: Schema.Codec<B, A>): <Kind extends ParamKind>(self: Param<Kind, A>) => Param<Kind, B>
  <Kind extends ParamKind, A, B>(self: Param<Kind, A>, schema: Schema.Codec<B, A>): Param<Kind, B>
} = dual(2, <Kind extends ParamKind, A, B>(
  self: Param<Kind, A>,
  schema: Schema.Codec<B, A>
) => {
  const decodeParam = Schema.decodeUnknownEffect(schema)
  return mapEffect(self, (value) =>
    Effect.mapError(decodeParam(value), (error) => {
      const single = getUnderlyingSingleOrThrow(self)
      return new CliError.InvalidValue({
        option: single.name,
        value: String(value),
        expected: `Schema validation failed: ${error.message}`,
        kind: single.kind
      })
    }))
})

/**
 * Provides a fallback param to use if this param fails to parse.
 *
 * **Example** (Falling back to another parameter)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const config = Param.file(Param.flagKind, "config").pipe(
 *   Param.orElse(() => Param.string(Param.flagKind, "config-url"))
 * )
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const orElse: {
  <B, Kind extends ParamKind>(
    orElse: (error: CliError.CliError) => Param<Kind, B>
  ): <A>(self: Param<Kind, A>) => Param<Kind, A | B>
  <Kind extends ParamKind, A, B>(
    self: Param<Kind, A>,
    orElse: (error: CliError.CliError) => Param<Kind, B>
  ): Param<Kind, A | B>
} = dual(2, <Kind extends ParamKind, A, B>(
  self: Param<Kind, A>,
  orElse: (error: CliError.CliError) => Param<Kind, B>
) =>
  transform(
    self,
    (parse: Parse<A>): Parse<A | B> => (args: ParsedArgs) => Effect.catch(parse(args), (err) => orElse(err).parse(args))
  ))

/**
 * Provides a fallback param and returns a `Result` indicating which param
 * succeeded.
 *
 * **Details**
 *
 * The original param's value is returned as `Result.succeed`, while the
 * fallback param's value is returned as `Result.fail`.
 *
 * **Example** (Returning fallback results)
 *
 * ```ts
 * import { Param } from "effect/unstable/cli"
 *
 * // @internal - this module is not exported publicly
 *
 * const configSource = Param.file(Param.flagKind, "config").pipe(
 *   Param.orElseResult(() => Param.string(Param.flagKind, "config-url"))
 * )
 * // Returns Result<string, string>
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const orElseResult: {
  <Kind extends ParamKind, B>(
    orElse: (error: CliError.CliError) => Param<Kind, B>
  ): <A>(self: Param<Kind, A>) => Param<Kind, Result.Result<A, B>>
  <Kind extends ParamKind, A, B>(
    self: Param<Kind, A>,
    orElse: (error: CliError.CliError) => Param<Kind, B>
  ): Param<Kind, Result.Result<A, B>>
} = dual(2, <Kind extends ParamKind, A, B>(
  self: Param<Kind, A>,
  orElse: (error: CliError.CliError) => Param<Kind, B>
) => {
  return transform(
    self,
    (parse: Parse<A>): Parse<Result.Result<A, B>> => (args: ParsedArgs) =>
      Effect.catch(
        Effect.map(parse(args), ([leftover, value]) => [leftover, Result.succeed(value)] as const),
        (err) =>
          Effect.map(
            orElse(err).parse(args),
            ([leftover, value]) => [leftover, Result.fail(value)] as const
          )
      )
  )
})

// =============================================================================
// Parsing Utilities
// =============================================================================

const parsePositional: <A>(
  name: string,
  primitiveType: Primitive.Primitive<A>,
  args: ParsedArgs
) => Effect.Effect<
  readonly [leftover: ReadonlyArray<string>, value: A],
  CliError.CliError,
  Environment
> = Effect.fnUntraced(function*(name, primitiveType, args) {
  if (args.arguments.length === 0) {
    return yield* new CliError.MissingArgument({ argument: name })
  }

  const arg = args.arguments[0]
  const value = yield* Effect.mapError(
    primitiveType.parse(arg),
    (error) =>
      new CliError.InvalidValue({
        option: name,
        value: arg,
        expected: error,
        kind: "argument"
      })
  )

  return [args.arguments.slice(1), value] as const
})

const parseFlag: <A>(
  name: string,
  primitiveType: Primitive.Primitive<A>,
  args: ParsedArgs
) => Effect.Effect<
  readonly [remainingOperands: ReadonlyArray<string>, value: A],
  CliError.CliError,
  Environment
> = Effect.fnUntraced(function*(name, primitiveType, args) {
  const providedValues = args.flags[name]

  if (providedValues === undefined || providedValues.length === 0) {
    // Option not provided (empty array due to initialization)
    if (Primitive.isBoolean(primitiveType)) {
      // Boolean params default to false when not present
      return [args.arguments, false as any] as const
    } else {
      return yield* new CliError.MissingOption({ option: name })
    }
  }

  // Parse the first value (later we can handle multiple)
  const arg = providedValues[0]
  const value = yield* Effect.mapError(
    primitiveType.parse(arg),
    (error) =>
      new CliError.InvalidValue({
        option: name,
        value: arg,
        expected: error,
        kind: "flag"
      })
  )

  return [args.arguments, value] as const
})

const parsePositionalVariadic: <Kind extends ParamKind, A>(
  self: Param<Kind, A>,
  single: Single<Kind, A>,
  args: ParsedArgs,
  options?: VariadicParamOptions | undefined
) => Effect.Effect<
  readonly [remainingOperands: ReadonlyArray<string>, value: ReadonlyArray<A>],
  CliError.CliError,
  Environment
> = Effect.fnUntraced(function*<A, Kind extends ParamKind>(
  self: Param<Kind, A>,
  single: Single<Kind, A>,
  args: ParsedArgs,
  options?: VariadicParamOptions | undefined
) {
  const results: Array<A> = []
  const minValue = options?.min ?? 0
  const maxValue = options?.max ?? Number.POSITIVE_INFINITY

  let count = 0
  let currentArgs = args.arguments
  while (currentArgs.length > 0 && count < maxValue) {
    const [remainingArgs, value] = yield* self.parse({
      flags: args.flags,
      arguments: currentArgs
    })
    results.push(value)
    currentArgs = remainingArgs
    count++
  }

  if (count < minValue) {
    return yield* new CliError.InvalidValue({
      option: single.name,
      value: `${count} values`,
      expected: `at least ${minValue} value${minValue === 1 ? "" : "s"}`,
      kind: single.kind
    })
  }

  return [currentArgs, results] as const
})

const parseOptionVariadic: <Kind extends ParamKind, A>(
  self: Param<Kind, A>,
  single: Single<Kind, A>,
  args: ParsedArgs,
  options?: VariadicParamOptions | undefined
) => Effect.Effect<
  readonly [remainingOperands: ReadonlyArray<string>, value: ReadonlyArray<A>],
  CliError.CliError,
  Environment
> = Effect.fnUntraced(function*<A, Kind extends ParamKind>(
  self: Param<Kind, A>,
  single: Single<Kind, A>,
  args: ParsedArgs,
  options?: VariadicParamOptions | undefined
) {
  const results: Array<A> = []
  const names = [single.name, ...single.aliases]
  const values = names.flatMap((name) => args.flags[name] ?? [])
  const count = values.length

  // Validate count constraints
  if (Predicate.isNotUndefined(options?.min) && count < options.min) {
    return yield* count === 0
      ? new CliError.MissingOption({ option: single.name })
      : new CliError.InvalidValue({
        option: single.name,
        value: `${count} occurrences`,
        expected: `at least ${options.min} value${options.min === 1 ? "" : "s"}`,
        kind: single.kind
      })
  }

  if (Predicate.isNotUndefined(options?.max) && count > options.max) {
    return yield* new CliError.InvalidValue({
      option: single.name,
      value: `${count} occurrences`,
      expected: `at most ${options.max} value${options.max === 1 ? "" : "s"}`,
      kind: single.kind
    })
  }

  // Parse each value individually
  for (const value of values) {
    const [, parsedValue] = yield* self.parse({
      flags: { [single.name]: [value] },
      arguments: []
    })
    results.push(parsedValue)
  }

  return [args.arguments, results] as const
})

type AnyParam<Kind extends ParamKind, A> =
  | Single<Kind, A>
  | Map<Kind, any, A>
  | Transform<Kind, any, A>
  | Optional<Kind, A>
  | Variadic<Kind, A>

/**
 * Type-safe param matcher that handles the unsafe casting internally.
 * This provides a clean API for pattern matching on param types while
 * maintaining type safety at the call site.
 */
const matchParam = <Kind extends ParamKind, A, R>(
  param: Param<Kind, A>,
  patterns: {
    Single: (single: Single<Kind, A>) => R
    Map: <X>(mapped: Map<Kind, X, A>) => R
    Transform: <X>(mapped: Transform<Kind, X, A>) => R
    Optional: <X>(optional: Optional<Kind, X>) => R
    Variadic: <X>(variadic: Variadic<Kind, X>) => R
  }
): R => {
  const p = param as AnyParam<Kind, A>
  switch (p._tag) {
    case "Single":
      return patterns.Single(p)
    case "Map":
      return patterns.Map(p)
    case "Transform":
      return patterns.Transform(p)
    case "Optional":
      return patterns.Optional(p)
    case "Variadic":
      return patterns.Variadic(p)
  }
}

/**
 * Recursively transforms a param by applying a function to any `Single` nodes.
 * This is used internally by combinators like `withAlias` to traverse the param tree.
 */
const transformSingle = <Kind extends ParamKind, A>(
  param: Param<Kind, A>,
  f: <X>(single: Single<Kind, X>) => Single<Kind, X>
): Param<Kind, A> => {
  return matchParam(param, {
    Single: (single) => f(single),
    Map: (mapped) => map(transformSingle(mapped.param, f), mapped.f),
    Transform: (mapped) => transform(transformSingle(mapped.param, f), mapped.f),
    Optional: (p) => optional(transformSingle(p.param, f)) as Param<Kind, A>,
    Variadic: (p) =>
      variadic(transformSingle(p.param, f), {
        min: Option.getOrUndefined(p.min),
        max: Option.getOrUndefined(p.max)
      }) as Param<Kind, A>
  })
}

/**
 * Extracts all Single params from a potentially nested param structure.
 * This handles all param combinators including Map, Transform, Optional, and Variadic.
 *
 * @internal
 */
export const extractSingleParams = <Kind extends ParamKind, A>(
  param: Param<Kind, A>
): Array<Single<Kind, unknown>> => {
  return matchParam(param, {
    Single: (single) => [single as Single<Kind, unknown>],
    Map: (mapped) => extractSingleParams(mapped.param),
    Transform: (mapped) => extractSingleParams(mapped.param),
    Optional: (optional) => extractSingleParams(optional.param),
    Variadic: (variadic) => extractSingleParams(variadic.param)
  })
}

/**
 * Gets the underlying Single param from a potentially nested param structure.
 * Throws an error if there are no singles or multiple singles found.
 *
 * @internal
 */
export const getUnderlyingSingleOrThrow = <Kind extends ParamKind, A>(
  param: Param<Kind, A>
): Single<Kind, A> => {
  const singles = extractSingleParams(param)

  if (singles.length === 0) {
    throw new Error("No Single param found in param structure")
  }

  if (singles.length > 1) {
    throw new Error(
      `Multiple Single params found: ${singles.map((s) => s.name).join(", ")}`
    )
  }

  return singles[0] as Single<Kind, A>
}

/**
 * Gets param metadata by traversing the structure.
 *
 * @internal
 */
export const getParamMetadata = <Kind extends ParamKind, A>(
  param: Param<Kind, A>
): { isOptional: boolean; isVariadic: boolean } => {
  return matchParam(param, {
    Single: () => ({ isOptional: false, isVariadic: false }),
    Map: (mapped) => getParamMetadata(mapped.param),
    Transform: (mapped) => getParamMetadata(mapped.param),
    Optional: (optional) => ({
      ...getParamMetadata(optional.param),
      isOptional: true
    }),
    Variadic: (variadic) => ({
      ...getParamMetadata(variadic.param),
      isVariadic: true
    })
  })
}
