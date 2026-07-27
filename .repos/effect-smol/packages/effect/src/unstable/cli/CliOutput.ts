/**
 * Formats CLI help and errors as text.
 *
 * This module turns help documents, CLI errors, grouped errors, and version
 * information into strings. It does not write those strings to the terminal
 * itself. It includes the `Formatter` interface, the formatter service, a layer
 * for custom formatters, and the default formatter with configurable color
 * support.
 *
 * @since 4.0.0
 */

import * as Context from "../../Context.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import type * as CliError from "./CliError.ts"
import type { HelpDoc } from "./HelpDoc.ts"

/**
 * Defines the service interface for formatting CLI output including help, errors, and version info.
 * This allows customization of output formatting, including color support.
 *
 * **Example** (Customizing CLI output formatting)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { CliOutput } from "effect/unstable/cli"
 *
 * // Create a custom formatter implementation
 * const customFormatter: CliOutput.Formatter = {
 *   formatHelpDoc: (doc) => `Custom Help: ${doc.usage}`,
 *   formatCliError: (error) => `Error: ${error.message}`,
 *   formatError: (error) => `[ERROR] ${error.message}`,
 *   formatVersion: (name, version) => `${name} (${version})`,
 *   formatErrors: (errors) => errors.map((error) => error.message).join("\\n")
 * }
 *
 * // Use the custom formatter in a program
 * const program = Effect.gen(function*() {
 *   const formatter = yield* CliOutput.Formatter
 *   const helpText = formatter.formatVersion("myapp", "1.0.0")
 *   console.log(helpText)
 * }).pipe(
 *   Effect.provide(CliOutput.layer(customFormatter))
 * )
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface Formatter {
  /**
   * Formats a HelpDoc structure into a readable string format.
   *
   * **Example** (Formatting help documents)
   *
   * ```ts
   * import { Option as O } from "effect"
   * import { CliOutput } from "effect/unstable/cli"
   * import type { HelpDoc } from "effect/unstable/cli"
   *
   * const helpDoc: HelpDoc = {
   *   usage: "myapp [options] <file>",
   *   description: "Process files with various options",
   *   flags: [
   *     {
   *       name: "verbose",
   *       aliases: ["-v"],
   *       type: "boolean",
   *       description: O.some("Enable verbose output"),
   *       required: false
   *     }
   *   ],
   *   args: [
   *     {
   *       name: "file",
   *       type: "string",
   *       description: O.some("Input file to process"),
   *       required: true,
   *       variadic: false
   *     }
   *   ]
   * }
   *
   * const formatter = CliOutput.defaultFormatter()
   * const helpText = formatter.formatHelpDoc(helpDoc)
   * console.log(helpText)
   * // Outputs formatted help with sections: DESCRIPTION, USAGE, ARGUMENTS, FLAGS
   * ```
   *
   * @since 4.0.0
   */
  readonly formatHelpDoc: (doc: HelpDoc) => string

  /**
   * Formats a CLI error for display. Default implementation mirrors the error message.
   *
   * **Example** (Formatting CLI errors)
   *
   * ```ts
   * import { Data } from "effect"
   * import { CliOutput } from "effect/unstable/cli"
   *
   * class InvalidOption extends Data.TaggedError("InvalidOption")<{
   *   readonly message: string
   * }> {}
   *
   * const formatter = CliOutput.defaultFormatter()
   * const error = new InvalidOption({ message: "Unknown flag '--invalid'" })
   * const errorMessage = formatter.formatCliError(error)
   * console.log(errorMessage) // "Unknown flag '--invalid'"
   * ```
   *
   * @since 4.0.0
   */
  readonly formatCliError: (error: CliError.CliError) => string

  /**
   * Formats an error section with proper styling and color reset.
   *
   * **Example** (Formatting error sections)
   *
   * ```ts
   * import { Data } from "effect"
   * import { CliOutput } from "effect/unstable/cli"
   *
   * class ValidationError extends Data.TaggedError("ValidationError")<{
   *   readonly message: string
   * }> {}
   *
   * const colorFormatter = CliOutput.defaultFormatter({ colors: true })
   * const noColorFormatter = CliOutput.defaultFormatter({ colors: false })
   *
   * const error = new ValidationError({ message: "Value must be positive" })
   *
   * const coloredError = colorFormatter.formatError(error)
   * console.log(coloredError) // "\n\x1b[1m\x1b[31mERROR\x1b[0m\n  Value must be positive\x1b[0m"
   *
   * const plainError = noColorFormatter.formatError(error)
   * console.log(plainError) // "\nERROR\n  Value must be positive"
   * ```
   *
   * @since 4.0.0
   */
  readonly formatError: (error: CliError.CliError) => string

  /**
   * Formats version output for display.
   *
   * **Example** (Formatting version output)
   *
   * ```ts
   * import { CliOutput } from "effect/unstable/cli"
   *
   * const colorFormatter = CliOutput.defaultFormatter({ colors: true })
   * const noColorFormatter = CliOutput.defaultFormatter({ colors: false })
   *
   * const appName = "my-awesome-tool"
   * const version = "1.2.3"
   *
   * const coloredVersion = colorFormatter.formatVersion(appName, version)
   * console.log(coloredVersion) // "\x1b[1mmy-awesome-tool\x1b[0m \x1b[2mv\x1b[0m\x1b[1m1.2.3\x1b[0m"
   *
   * const plainVersion = noColorFormatter.formatVersion(appName, version)
   * console.log(plainVersion) // "my-awesome-tool v1.2.3"
   * ```
   *
   * @since 4.0.0
   */
  readonly formatVersion: (name: string, version: string) => string

  /**
   * Formats multiple CLI errors for display, grouping by error type.
   *
   * **Example** (Formatting grouped errors)
   *
   * ```ts
   * import { CliError, CliOutput } from "effect/unstable/cli"
   *
   * const formatter = CliOutput.defaultFormatter({ colors: false })
   *
   * const errors = [
   *   new CliError.UnrecognizedOption({
   *     option: "--foo",
   *     suggestions: ["--force"]
   *   }),
   *   new CliError.UnrecognizedOption({ option: "--bar", suggestions: [] }),
   *   new CliError.MissingOption({ option: "--required" })
   * ]
   *
   * const output = formatter.formatErrors(errors)
   * // Groups errors by type and displays all at once
   * ```
   *
   * @since 4.0.0
   */
  readonly formatErrors: (errors: ReadonlyArray<CliError.CliError>) => string
}

/**
 * Service reference for the CLI output formatter. Provides a default implementation
 * that can be overridden for custom formatting or testing.
 *
 * **Example** (Accessing the output formatter)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { CliOutput } from "effect/unstable/cli"
 *
 * // Access the formatter service
 * const program = Effect.gen(function*() {
 *   const formatter = yield* CliOutput.Formatter
 *
 *   // Format version information
 *   const versionText = formatter.formatVersion("my-cli", "2.1.0")
 *   console.log(versionText) // "my-cli v2.1.0" (with colors if supported)
 *
 *   return versionText
 * })
 *
 * // Run with default formatter
 * const result = Effect.runSync(program)
 * ```
 *
 * @category services
 * @since 4.0.0
 */
export const Formatter: Context.Reference<Formatter> = Context.Reference(
  "effect/cli/CliOutput",
  { defaultValue: () => defaultFormatter() }
)

/**
 * Creates a Layer that provides a custom Formatter implementation.
 *
 * **Example** (Providing a custom formatter)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 * import { CliOutput } from "effect/unstable/cli"
 *
 * // Create a custom formatter without colors
 * const noColorFormatter = CliOutput.defaultFormatter({ colors: false })
 * const NoColorLayer = CliOutput.layer(noColorFormatter)
 *
 * // Create a program that uses the custom formatter
 * const program = Effect.gen(function*() {
 *   const formatter = yield* CliOutput.Formatter
 *   const versionText = formatter.formatVersion("my-cli", "1.0.0")
 *   yield* Console.log(`Using custom formatter: ${versionText}`)
 * }).pipe(
 *   Effect.provide(NoColorLayer)
 * )
 *
 * // You can also create completely custom formatters
 * const jsonFormatter: CliOutput.Formatter = {
 *   formatHelpDoc: (doc) => JSON.stringify(doc, null, 2),
 *   formatCliError: (error) => JSON.stringify({ error: error.message }),
 *   formatError: (error) =>
 *     JSON.stringify({ type: "error", message: error.message }),
 *   formatVersion: (name, version) => JSON.stringify({ name, version }),
 *   formatErrors: (errors) => JSON.stringify(errors.map((error) => error.message))
 * }
 * const JsonLayer = CliOutput.layer(jsonFormatter)
 * ```
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (formatter: Formatter): Layer.Layer<never> => Layer.succeed(Formatter)(formatter)

/**
 * Creates a default formatter with configurable options.
 *
 * **Example** (Creating default formatters)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { CliError, CliOutput } from "effect/unstable/cli"
 *
 * // Create a formatter without colors for tests or CI environments
 * const noColorFormatter = CliOutput.defaultFormatter({ colors: false })
 *
 * // Create a formatter with colors forced on
 * const colorFormatter = CliOutput.defaultFormatter({ colors: true })
 *
 * // Auto-detect colors based on terminal support (default behavior)
 * const autoFormatter = CliOutput.defaultFormatter()
 *
 * const program = Effect.gen(function*() {
 *   const formatter = colorFormatter
 *
 *   // Format an error with proper styling
 *   const error = new CliError.InvalidValue({
 *     option: "foo",
 *     value: "bar",
 *     expected: "baz",
 *     kind: "flag"
 *   })
 *   const errorText = formatter.formatError(error)
 *   console.log(errorText)
 *
 *   // Format version information
 *   const versionText = formatter.formatVersion("my-tool", "1.2.3")
 *   console.log(versionText)
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const defaultFormatter = (options?: { colors?: boolean }): Formatter => {
  const globalProcess = (globalThis as any).process
  const hasProcess = typeof globalProcess === "object" && globalProcess !== null

  const useColor = options?.colors !== undefined
    ? options.colors
    // Auto-detect based on environment
    : (hasProcess &&
      typeof globalProcess.stdout === "object" &&
      globalProcess.stdout !== null &&
      globalProcess.stdout.isTTY === true &&
      globalProcess.env?.NO_COLOR !== "1")

  // Color palette using ANSI escape codes
  const colors = useColor
    ? {
      bold: (text: string): string => `\x1b[1m${text}\x1b[0m`,
      dim: (text: string): string => `\x1b[2m${text}\x1b[0m`,
      cyan: (text: string): string => `\x1b[36m${text}\x1b[0m`,
      green: (text: string): string => `\x1b[32m${text}\x1b[0m`,
      blue: (text: string): string => `\x1b[34m${text}\x1b[0m`,
      yellow: (text: string): string => `\x1b[33m${text}\x1b[0m`,
      magenta: (text: string): string => `\x1b[35m${text}\x1b[0m`
    }
    : {
      bold: (text: string): string => text,
      dim: (text: string): string => text,
      cyan: (text: string): string => text,
      green: (text: string): string => text,
      blue: (text: string): string => text,
      yellow: (text: string): string => text,
      magenta: (text: string): string => text
    }

  const reset = useColor ? "\x1b[0m" : ""
  const red = useColor ? "\x1b[31m" : ""
  const bold = useColor ? "\x1b[1m" : ""

  return {
    formatHelpDoc: (doc: HelpDoc): string => formatHelpDocImpl(doc, colors),
    formatCliError: (error): string => error.message,
    formatError: (error): string => {
      return `\n${bold}${red}ERROR${reset}\n  ${error.message}${reset}`
    },
    formatErrors: (errors): string => {
      if (errors.length === 0) return ""
      if (errors.length === 1) {
        return `\n${bold}${red}ERROR${reset}\n  ${errors[0].message}${reset}`
      }

      // Group errors by _tag
      const grouped = new Map<string, Array<CliError.CliError>>()
      for (const error of errors) {
        const tag = (error as any)._tag ?? "Error"
        const group = grouped.get(tag) ?? []
        group.push(error)
        grouped.set(tag, group)
      }

      const sections: Array<string> = []
      sections.push(`\n${bold}${red}ERRORS${reset}`)

      for (const [, group] of grouped) {
        for (const error of group) {
          sections.push(`  ${error.message}${reset}`)
        }
      }

      return sections.join("\n")
    },
    formatVersion: (name: string, version: string): string =>
      `${colors.bold(name)} ${colors.dim("v")}${colors.bold(version)}`
  }
}

/**
 * Strips ANSI escape codes from a string to calculate visual width.
 * @internal
 */
const stripAnsi = (text: string): string => {
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, "")
}

/**
 * Gets the visual length of a string (excluding ANSI codes).
 * @internal
 */
const visualLength = (text: string): number => stripAnsi(text).length

/**
 * Helper function to pad strings to a specified width.
 * @internal
 */
const pad = (s: string, width: number) => {
  const actualLength = visualLength(s)
  const padding = Math.max(0, width - actualLength)
  return s + " ".repeat(padding)
}

/**
 * Interface for table rows with left and right columns.
 * @internal
 */
interface Row {
  left: string
  right: string
}

/**
 * Renders a table with aligned columns.
 * @internal
 */
const renderTable = (rows: ReadonlyArray<Row>, widthCap?: number) => {
  const maxColumn = Math.max(...rows.map((r) => visualLength(r.left))) + 4
  const col = widthCap === undefined ? maxColumn : Math.min(maxColumn, widthCap)
  return rows.map(({ left, right }) => `  ${pad(left, col)}${right}`).join("\n")
}

const formatSubcommandName = (name: string, alias: string | undefined): string => alias ? `${name}, ${alias}` : name

/**
 * Color functions interface for help formatting.
 * @internal
 */
interface ColorFunctions {
  readonly bold: (text: string) => string
  readonly dim: (text: string) => string
  readonly cyan: (text: string) => string
  readonly green: (text: string) => string
  readonly blue: (text: string) => string
  readonly yellow: (text: string) => string
  readonly magenta: (text: string) => string
}

/**
 * Internal implementation of help formatting that accepts configurable color functions.
 * @internal
 */
const formatHelpDocImpl = (doc: HelpDoc, colors: ColorFunctions): string => {
  const sections: Array<string> = []

  // Description section
  if (doc.description) {
    sections.push(colors.bold("DESCRIPTION"))
    sections.push(`  ${doc.description}`)
    sections.push("")
  }

  // Usage section
  sections.push(colors.bold("USAGE"))
  sections.push(`  ${colors.cyan(doc.usage)}`)
  sections.push("")

  // Arguments section
  if (doc.args && doc.args.length > 0) {
    sections.push(colors.bold("ARGUMENTS"))

    const argRows: Array<Row> = doc.args.map((arg) => {
      let name = arg.name
      if (arg.variadic) {
        name += "..."
      }

      const coloredName = colors.green(name)
      const coloredType = colors.dim(arg.type)
      const nameType = `${coloredName} ${coloredType}`

      const optionalSuffix = arg.required ? "" : colors.dim(" (optional)")
      const description = Option.getOrElse(arg.description, () => "") + optionalSuffix

      return {
        left: nameType,
        right: description
      }
    })

    sections.push(renderTable(argRows, 25))
    sections.push("")
  }

  // Flags section
  if (doc.flags.length > 0) {
    sections.push(colors.bold("FLAGS"))

    const flagRows: Array<Row> = doc.flags.map((flag) => {
      const names: Array<string> = []

      // Add main name with -- prefix first
      names.push(colors.green(`--${flag.name}`))

      // Add aliases after (like -f) to match expected ordering
      for (const alias of flag.aliases) {
        names.push(colors.green(alias))
      }

      const namesPart = names.join(", ")
      const typePart = flag.type !== "boolean" ? ` ${colors.dim(flag.type)}` : ""

      return {
        left: namesPart + typePart,
        right: Option.getOrElse(flag.description, () => "")
      }
    })

    sections.push(renderTable(flagRows))
    sections.push("")
  }

  // Global Flags section
  if (doc.globalFlags && doc.globalFlags.length > 0) {
    sections.push(colors.bold("GLOBAL FLAGS"))

    const globalFlagRows: Array<Row> = doc.globalFlags.map((flag) => {
      const names: Array<string> = []

      // Add main name with -- prefix first
      names.push(colors.green(`--${flag.name}`))

      // Add aliases after (like -f) to match expected ordering
      for (const alias of flag.aliases) {
        names.push(colors.green(alias))
      }

      const namesPart = names.join(", ")
      const typePart = flag.type !== "boolean" ? ` ${colors.dim(flag.type)}` : ""

      return {
        left: namesPart + typePart,
        right: Option.getOrElse(flag.description, () => "")
      }
    })

    sections.push(renderTable(globalFlagRows))
    sections.push("")
  }

  // Subcommands section
  if (doc.subcommands && doc.subcommands.length > 0) {
    const ungrouped = doc.subcommands.find((group) => group.group === undefined)

    if (ungrouped) {
      sections.push(colors.bold("SUBCOMMANDS"))
      sections.push(renderTable(
        ungrouped.commands.map((sub) => ({
          left: colors.cyan(formatSubcommandName(sub.name, sub.alias)),
          right: sub.shortDescription ?? sub.description
        })),
        20
      ))
      if (doc.subcommands.length > 1) {
        sections.push("")
      }
    }

    for (const group of doc.subcommands) {
      if (group.group === undefined) continue
      sections.push(colors.bold(`${group.group}:`))
      sections.push(renderTable(
        group.commands.map((sub) => ({
          left: colors.cyan(formatSubcommandName(sub.name, sub.alias)),
          right: sub.shortDescription ?? sub.description
        })),
        20
      ))
      sections.push("")
    }
  }

  // Examples section
  if (doc.examples && doc.examples.length > 0) {
    sections.push(colors.bold("EXAMPLES"))

    let first = true
    let previousHadDescription = false
    for (const example of doc.examples) {
      if (example.description) {
        if (!first) sections.push("")
        sections.push(`  ${colors.dim(`# ${example.description}`)}`)
      } else if (previousHadDescription) {
        sections.push("")
      }
      sections.push(`  ${colors.cyan(example.command)}`)
      first = false
      previousHadDescription = !!example.description
    }
    sections.push("")
  }

  // Remove trailing empty line if present
  if (sections[sections.length - 1] === "") {
    sections.pop()
  }

  return sections.join("\n")
}
