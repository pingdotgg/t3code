/**
 * The `CliError` module defines the structured error model used by the
 * unstable CLI parser and runner. It distinguishes command-line parse failures,
 * CLI definition problems, explicit help requests, and user handler failures so
 * applications can report errors consistently while still pattern matching on
 * the exact cause.
 *
 * **Common tasks**
 *
 * - Detect CLI errors at runtime with {@link isCliError}
 * - Represent parse failures such as unknown flags, missing required inputs, or
 *   invalid argument values
 * - Attach parse or validation errors to {@link ShowHelp} when the runner should
 *   render help text together with the failure
 * - Preserve command handler failures with {@link UserError}
 *
 * **Gotchas**
 *
 * - {@link ShowHelp} is a control-flow error, not a parse failure; it exits with
 *   code `0` for explicit help and `1` when it carries errors
 * - Duplicate option names between parent and child commands are rejected
 *   because the parent command claims the flag before the child can see it
 * - Suggestion-bearing errors keep suggestions separate from the primary cause
 *   so help renderers can decide how much guidance to display
 *
 * @since 4.0.0
 */
import * as Predicate from "../../Predicate.ts"
import * as Runtime from "../../Runtime.ts"
import * as Schema from "../../Schema.ts"

/**
 * @category type IDs
 * @since 4.0.0
 */
const TypeId = "~effect/cli/CliError"

/**
 * Type guard to check if a value is a CLI error.
 *
 * **Example** (Checking CLI errors)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { CliError } from "effect/unstable/cli"
 *
 * const handleError = (error: unknown) => {
 *   if (CliError.isCliError(error)) {
 *     console.log("CLI Error:", error.message)
 *     return Effect.succeed("Handled CLI error")
 *   }
 *   return Effect.fail("Unknown error")
 * }
 *
 * // Example usage in error handling
 * const program = Effect.gen(function*() {
 *   const result = yield* Effect.try({
 *     try: () => ({ success: true }),
 *     catch: (error) => error
 *   })
 *   handleError(result)
 * })
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isCliError = (u: unknown): u is CliError => Predicate.hasProperty(u, TypeId)

/**
 * Union type representing all possible CLI error conditions.
 *
 * **Example** (Handling CLI errors)
 *
 * ```ts
 * import type { CliError } from "effect/unstable/cli"
 *
 * const handleCliError = (error: CliError.CliError): void => {
 *   switch (error._tag) {
 *     case "UnrecognizedOption":
 *       console.log(`Unknown flag: ${error.option}`)
 *       break
 *     case "MissingOption":
 *       console.log(`Required flag missing: ${error.option}`)
 *       break
 *     case "InvalidValue":
 *       console.log(`Invalid value: ${error.value} for ${error.option}`)
 *       break
 *     case "ShowHelp":
 *       // Display help for the command path
 *       console.log(`Help requested for: ${error.commandPath.join(" ")}`)
 *       break
 *     default:
 *       console.log(error.message)
 *   }
 * }
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export type CliError =
  | UnrecognizedOption
  | DuplicateOption
  | MissingOption
  | MissingArgument
  | InvalidValue
  | UnknownSubcommand
  | ShowHelp
  | UserError

/**
 * Error thrown when an unrecognized option is encountered.
 *
 * **Example** (Creating unrecognized option errors)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { CliError } from "effect/unstable/cli"
 *
 * // Creating an unrecognized option error
 * const unrecognizedError = new CliError.UnrecognizedOption({
 *   option: "--unknown-flag",
 *   command: ["deploy", "production"],
 *   suggestions: ["--verbose", "--force"]
 * })
 *
 * console.log(unrecognizedError.message)
 * // "Unrecognized flag: --unknown-flag in command deploy production
 * //
 * //  Did you mean this?
 * //    --verbose
 * //    --force"
 *
 * // In CLI parsing context
 * const parseCommand = Effect.gen(function*() {
 *   // If parsing encounters unknown flag
 *   return yield* unrecognizedError
 * })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export class UnrecognizedOption extends Schema.ErrorClass<UnrecognizedOption>(`${TypeId}/UnrecognizedOption`)({
  _tag: Schema.tag("UnrecognizedOption"),
  option: Schema.String,
  command: Schema.optional(Schema.Array(Schema.String)),
  suggestions: Schema.Array(Schema.String)
}) {
  /**
   * Marks this value as a CLI parsing error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * Formats the unrecognized option with command context and suggestions.
   *
   * @since 4.0.0
   */
  override get message() {
    const suggestionText = this.suggestions.length > 0
      ? `\n\n  Did you mean this?\n    ${this.suggestions.join("\n    ")}`
      : ""
    const baseMessage = this.command
      ? `Unrecognized flag: ${this.option} in command ${this.command.join(" ")}`
      : `Unrecognized flag: ${this.option}`
    return baseMessage + suggestionText
  }
}

/**
 * Error thrown when duplicate option names are detected between parent and child commands.
 *
 * **Example** (Creating duplicate option errors)
 *
 * ```ts
 * import { CliError } from "effect/unstable/cli"
 *
 * const duplicateError = new CliError.DuplicateOption({
 *   option: "--verbose",
 *   parentCommand: "myapp",
 *   childCommand: "deploy"
 * })
 *
 * console.log(duplicateError.message)
 * // "Duplicate flag name "--verbose" in parent command "myapp" and subcommand "deploy".
 * // Parent will always claim this flag (Mode A semantics). Consider renaming one of them to avoid confusion."
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export class DuplicateOption extends Schema.ErrorClass<DuplicateOption>(`${TypeId}/DuplicateOption`)({
  _tag: Schema.tag("DuplicateOption"),
  option: Schema.String,
  parentCommand: Schema.String,
  childCommand: Schema.String
}) {
  /**
   * Marks this value as a CLI configuration error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * Explains which parent and child commands define the duplicate option.
   *
   * @since 4.0.0
   */
  override get message() {
    return `Duplicate flag name "${this.option}" in parent command "${this.parentCommand}" and subcommand "${this.childCommand}". ` +
      `Parent will always claim this flag (Mode A semantics). Consider renaming one of them to avoid confusion.`
  }
}

/**
 * Error thrown when a required option is missing.
 *
 * **Example** (Creating missing option errors)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { CliError } from "effect/unstable/cli"
 *
 * const missingOptionError = new CliError.MissingOption({
 *   option: "api-key"
 * })
 *
 * console.log(missingOptionError.message)
 * // "Missing required flag: --api-key"
 *
 * // In validation context
 * const validateRequiredOptions = (options: Record<string, string | undefined>) =>
 *   Effect.gen(function*() {
 *     const apiKey = options["api-key"]
 *     if (!apiKey) {
 *       return yield* missingOptionError
 *     }
 *     return apiKey
 *   })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export class MissingOption extends Schema.ErrorClass<MissingOption>(`${TypeId}/MissingOption`)({
  _tag: Schema.tag("MissingOption"),
  option: Schema.String
}) {
  /**
   * Marks this value as a missing CLI option error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * Formats the missing required flag for display.
   *
   * @since 4.0.0
   */
  override get message() {
    return `Missing required flag: --${this.option}`
  }
}

/**
 * Error thrown when a required positional argument is missing.
 *
 * **Example** (Creating missing argument errors)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { CliError } from "effect/unstable/cli"
 *
 * const missingArgError = new CliError.MissingArgument({
 *   argument: "target"
 * })
 *
 * console.log(missingArgError.message)
 * // "Missing required argument: target"
 *
 * // In argument parsing
 * const parseArguments = (args: Array<string>) =>
 *   Effect.gen(function*() {
 *     if (args.length === 0) {
 *       return yield* missingArgError
 *     }
 *     return args[0]
 *   })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export class MissingArgument extends Schema.ErrorClass<MissingArgument>(`${TypeId}/MissingArgument`)({
  _tag: Schema.tag("MissingArgument"),
  argument: Schema.String
}) {
  /**
   * Marks this value as a missing CLI argument error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * Formats the missing required positional argument for display.
   *
   * @since 4.0.0
   */
  override get message() {
    return `Missing required argument: ${this.argument}`
  }
}

/**
 * Error thrown when an option or argument value is invalid.
 *
 * **Example** (Creating invalid value errors)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { CliError } from "effect/unstable/cli"
 *
 * const invalidValueError = new CliError.InvalidValue({
 *   option: "port",
 *   value: "abc123",
 *   expected: "integer between 1 and 65535",
 *   kind: "flag"
 * })
 *
 * console.log(invalidValueError.message)
 * // "Invalid value for flag --port: "abc123". Expected: integer between 1 and 65535"
 *
 * // For positional arguments
 * const invalidArgError = new CliError.InvalidValue({
 *   option: "count",
 *   value: "abc",
 *   expected: "integer",
 *   kind: "argument"
 * })
 *
 * console.log(invalidArgError.message)
 * // "Invalid value for argument <count>: "abc". Expected: integer"
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export class InvalidValue extends Schema.ErrorClass<InvalidValue>(`${TypeId}/InvalidValue`)({
  _tag: Schema.tag("InvalidValue"),
  option: Schema.String,
  value: Schema.String,
  expected: Schema.String,
  kind: Schema.Union([Schema.Literal("flag"), Schema.Literal("argument")])
}) {
  /**
   * Marks this value as an invalid CLI value error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * Formats the invalid flag or argument value with the expected input.
   *
   * @since 4.0.0
   */
  override get message() {
    if (this.kind === "argument") {
      return `Invalid value for argument <${this.option}>: "${this.value}". Expected: ${this.expected}`
    }
    return `Invalid value for flag --${this.option}: "${this.value}". Expected: ${this.expected}`
  }
}

/**
 * Error thrown when an unknown subcommand is encountered.
 *
 * **Example** (Creating unknown subcommand errors)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { CliError } from "effect/unstable/cli"
 *
 * const unknownSubcommandError = new CliError.UnknownSubcommand({
 *   subcommand: "deplyo", // typo
 *   parent: ["myapp"],
 *   suggestions: ["deploy", "destroy"]
 * })
 *
 * console.log(unknownSubcommandError.message)
 * // "Unknown subcommand "deplyo" for "myapp"
 * //
 * //  Did you mean this?
 * //    deploy
 * //    destroy"
 *
 * // In subcommand parsing
 * const parseSubcommand = (subcommand: string) =>
 *   Effect.gen(function*() {
 *     const validCommands = ["deploy", "destroy", "status"]
 *     if (!validCommands.includes(subcommand)) {
 *       return yield* unknownSubcommandError
 *     }
 *     return subcommand
 *   })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export class UnknownSubcommand extends Schema.ErrorClass<UnknownSubcommand>(`${TypeId}/UnknownSubcommand`)({
  _tag: Schema.tag("UnknownSubcommand"),
  subcommand: Schema.String,
  parent: Schema.optional(Schema.Array(Schema.String)),
  suggestions: Schema.Array(Schema.String)
}) {
  /**
   * Marks this value as an unknown CLI subcommand error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * Formats the unknown subcommand with parent command context and suggestions.
   *
   * @since 4.0.0
   */
  override get message() {
    const suggestionText = this.suggestions.length > 0
      ? `\n\n  Did you mean this?\n    ${this.suggestions.join("\n    ")}`
      : ""
    return this.parent
      ? `Unknown subcommand "${this.subcommand}" for "${this.parent.join(" ")}"${suggestionText}`
      : `Unknown subcommand "${this.subcommand}"${suggestionText}`
  }
}

/**
 * Error wrapper for user handler failures in the CLI error channel.
 *
 * **Example** (Wrapping user errors)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { CliError } from "effect/unstable/cli"
 *
 * // Wrapping user errors
 * const userError = new CliError.UserError({
 *   cause: new Error("Database connection failed")
 * })
 *
 * // In command handler
 * const deployCommand = Effect.gen(function*() {
 *   const result = yield* Effect.try({
 *     try: () => ({ deployed: true }),
 *     catch: (error) => new CliError.UserError({ cause: error })
 *   })
 *   return result
 * })
 *
 * // In error handling
 * const handleError = (error: CliError.CliError): Effect.Effect<number> => {
 *   if (error._tag === "UserError") {
 *     console.log("Command failed:", error.cause)
 *     return Effect.succeed(1) // Exit code 1
 *   }
 *   return Effect.succeed(0)
 * }
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export class UserError extends Schema.ErrorClass<UserError>(`${TypeId}/UserError`)({
  _tag: Schema.tag("UserError"),
  cause: Schema.Defect
}) {
  /**
   * Marks this value as a user handler error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId
}

/**
 * Schema for concrete CLI errors that can be reported together with help output.
 *
 * **Details**
 *
 * This excludes `ShowHelp` itself, allowing parse and validation errors to be
 * stored in `ShowHelp.errors` without nesting another help-control value.
 *
 * @category models
 * @since 4.0.0
 */
export const NonShowHelpErrors: Schema.Union<
  readonly [
    typeof UnrecognizedOption,
    typeof DuplicateOption,
    typeof MissingOption,
    typeof MissingArgument,
    typeof InvalidValue,
    typeof UnknownSubcommand,
    typeof UserError
  ]
> = Schema.Union([
  UnrecognizedOption,
  DuplicateOption,
  MissingOption,
  MissingArgument,
  InvalidValue,
  UnknownSubcommand,
  UserError
])

/**
 * Type of CLI errors that are not `ShowHelp`.
 *
 * **Details**
 *
 * These errors can be accumulated and attached to `ShowHelp.errors` when the
 * runner should display help along with the underlying parse or validation
 * failures.
 *
 * @category models
 * @since 4.0.0
 */
export type NonShowHelpErrors = typeof NonShowHelpErrors.Type

/**
 * Error data requesting CLI help rendering for a command path.
 *
 * **Details**
 *
 * It is used for explicit help requests and for parse or validation failures
 * that should be shown with help text. When `errors` is non-empty, the runtime
 * exit code is `1`; otherwise it is `0`.
 *
 * @category models
 * @since 4.0.0
 */
export class ShowHelp extends Schema.ErrorClass<ShowHelp>(`${TypeId}/ShowHelp`)({
  _tag: Schema.tag("ShowHelp"),
  commandPath: Schema.Array(Schema.String),
  errors: Schema.Array(NonShowHelpErrors)
}) {
  readonly [TypeId] = TypeId

  override readonly [Runtime.errorExitCode] = this.errors.length ? 1 : 0
  override readonly [Runtime.errorReported] = false

  override get message() {
    return "Help requested"
  }
}
