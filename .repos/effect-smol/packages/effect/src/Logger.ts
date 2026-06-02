/**
 * The `Logger` module defines the logging model used by the Effect runtime and
 * provides constructors for formatting, routing, batching, and installing
 * loggers. A `Logger<Message, Output>` receives each runtime log event as an
 * {@link Options} value and transforms it into an output such as a string,
 * structured object, JSON line, console write, file write, or trace span event.
 *
 * **Mental model**
 *
 * - Effect programs emit log events with APIs such as `Effect.log`,
 *   `Effect.logInfo`, `Effect.logWarning`, and `Effect.logError`
 * - Each event contains a message, log level, cause, fiber, and timestamp
 * - Loggers are ordinary values created with {@link make} and installed with
 *   {@link layer}
 * - Multiple loggers can be active at once by providing a layer with several
 *   logger values
 * - Formatter loggers such as {@link formatLogFmt}, {@link formatStructured},
 *   and {@link formatJson} return formatted data without writing it anywhere
 * - Console loggers such as {@link consolePretty}, {@link consoleLogFmt},
 *   {@link consoleStructured}, and {@link consoleJson} write formatted output
 *   to the active Effect console
 *
 * **Log output structure**
 *
 * Built-in formatters include the log level, timestamp, fiber identifier, and
 * logged message. When present, they also include the pretty-printed cause,
 * active log annotations, and active log spans. Structured and JSON loggers keep
 * these fields as machine-readable data, while logfmt and pretty loggers render
 * them as human-readable text.
 *
 * **Common tasks**
 *
 * - Create a custom logger: {@link make}
 * - Transform logger output: {@link map}
 * - Write formatter output to the console: {@link withConsoleLog},
 *   {@link withConsoleError}, {@link withLeveledConsole}
 * - Use built-in console loggers: {@link consolePretty}, {@link consoleLogFmt},
 *   {@link consoleStructured}, {@link consoleJson}
 * - Use built-in formatter loggers: {@link formatSimple}, {@link formatLogFmt},
 *   {@link formatStructured}, {@link formatJson}
 * - Batch logger output before flushing to a sink: {@link batched}
 * - Write string logger output to a file: {@link toFile}
 * - Preserve trace correlation by including {@link tracerLogger}
 * - Install or replace loggers for an effect: {@link layer}
 *
 * **Gotchas**
 *
 * - {@link layer} replaces the current logger set by default; pass
 *   `mergeWithExisting: true` when adding loggers to the existing runtime
 *   loggers
 * - Formatter loggers only produce values; wrap them with console, file, batch,
 *   or custom sink loggers when output should be written somewhere
 * - {@link batched} and {@link toFile} are scoped; keep their scope open while
 *   logs are being emitted so buffered entries can flush reliably
 * - {@link toFile} accepts only loggers that output strings, so pair it with
 *   string formatters such as {@link formatJson} or {@link formatLogFmt}
 * - The default runtime logger set includes {@link tracerLogger}; replacing
 *   loggers without merging may remove automatic log-to-trace-span recording
 *
 * **Quickstart**
 *
 * **Example** (Installing a JSON console logger)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.logInfo("request started", { method: "GET", path: "/users" })
 *   yield* Effect.logError("request failed", { status: 500 })
 * }).pipe(
 *   Effect.annotateLogs("service", "users-api"),
 *   Effect.withLogSpan("http.request"),
 *   Effect.provide(Logger.layer([Logger.consoleJson]))
 * )
 * ```
 *
 * **See also**
 *
 * - {@link make} for defining custom loggers
 * - {@link layer} for installing loggers
 * - {@link formatJson} and {@link consoleJson} for structured production logs
 * - {@link consolePretty} for readable local logs
 *
 * @since 2.0.0
 */
import * as Array from "./Array.ts"
import type * as Cause from "./Cause.ts"
import type * as Context from "./Context.ts"
import type * as Duration from "./Duration.ts"
import type * as Effect from "./Effect.ts"
import type * as Fiber from "./Fiber.ts"
import * as FileSystem from "./FileSystem.ts"
import * as Formatter from "./Formatter.ts"
import { dual } from "./Function.ts"
import { isEffect, withFiber } from "./internal/core.ts"
import * as effect from "./internal/effect.ts"
import * as Layer from "./Layer.ts"
import type * as LogLevel from "./LogLevel.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { PlatformError } from "./PlatformError.ts"
import * as Predicate from "./Predicate.ts"
import { CurrentLogAnnotations, CurrentLogSpans } from "./References.ts"
import type * as Scope from "./Scope.ts"

const TypeId = "~effect/Logger"

/**
 * A logger that transforms a runtime log event into an output value.
 *
 * **Details**
 *
 * The runtime calls `log` with the message, level, cause, fiber, and timestamp
 * for each log event. Use `Logger.layer` to install one or more loggers for an
 * effect.
 *
 * **Example** (Creating custom loggers)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Create a custom logger that accepts unknown messages and returns void
 * const stringLogger = Logger.make<unknown, void>((options) => {
 *   console.log(`[${options.logLevel}] ${options.message}`)
 * })
 *
 * // Create a logger that accepts any message type and returns a formatted string
 * const formattedLogger = Logger.make<unknown, string>((options) =>
 *   `${options.date.toISOString()} [${options.logLevel}] ${options.message}`
 * )
 *
 * // Use the logger in an Effect program
 * const program = Effect.log("Hello World").pipe(
 *   Effect.provide(Logger.layer([stringLogger]))
 * )
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Logger<in Message, out Output> extends Pipeable {
  readonly [TypeId]: typeof TypeId
  log(options: Options<Message>): Output
}

/**
 * Information supplied to a `Logger` for a single log event.
 *
 * **Details**
 *
 * Includes the logged message, log level, cause, current fiber, and timestamp.
 *
 * **Example** (Accessing logger options)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Options interface provides all logging context
 * const detailedLogger = Logger.make((options) => {
 *   const output = {
 *     message: options.message,
 *     level: options.logLevel,
 *     timestamp: options.date.toISOString(),
 *     fiberId: options.fiber.id,
 *     hasCause: options.cause !== undefined
 *   }
 *   console.log(JSON.stringify(output))
 * })
 *
 * const program = Effect.log("Processing request").pipe(
 *   Effect.provide(Logger.layer([detailedLogger]))
 * )
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Options<out Message> {
  readonly message: Message
  readonly logLevel: LogLevel.LogLevel
  readonly cause: Cause.Cause<unknown>
  readonly fiber: Fiber.Fiber<unknown, unknown>
  readonly date: Date
}

/**
 * Returns `true` if the specified value is a `Logger`, otherwise returns `false`.
 *
 * **Example** (Checking logger values)
 *
 * ```ts
 * import { Logger } from "effect"
 *
 * const myLogger = Logger.make((options) => {
 *   console.log(options.message)
 * })
 *
 * console.log(Logger.isLogger(myLogger)) // true
 * console.log(Logger.isLogger("not a logger")) // false
 * console.log(Logger.isLogger({ log: () => {} })) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isLogger = (u: unknown): u is Logger<unknown, unknown> => Predicate.hasProperty(u, TypeId)

/**
 * Context reference containing the active loggers for the current fiber.
 *
 * **Details**
 *
 * By default this set includes the default logger and the tracer logger.
 * Providing `Logger.layer` replaces or merges with this set depending on its
 * options.
 *
 * **Example** (Accessing current loggers)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Access current loggers from fiber context
 * const program = Effect.gen(function*() {
 *   const currentLoggers = yield* Effect.service(Logger.CurrentLoggers)
 *   console.log(`Number of active loggers: ${currentLoggers.size}`)
 *
 *   // Add a custom logger to the set
 *   const customLogger = Logger.make((options) => {
 *     console.log(`Custom: ${options.message}`)
 *   })
 *
 *   yield* Effect.log("Hello from custom logger").pipe(
 *     Effect.provide(Logger.layer([customLogger]))
 *   )
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const CurrentLoggers: Context.Reference<ReadonlySet<Logger<unknown, any>>> = effect.CurrentLoggers

/**
 * Context reference that routes the built-in default logger and TTY pretty
 * console logger to stderr.
 *
 * **When to use**
 *
 * Use to keep stdout reserved for protocol messages or data output while still
 * allowing Effect runtime logs to be emitted.
 *
 * **Details**
 *
 * The reference defaults to `false`. Providing `true` makes the affected
 * loggers call `console.error` instead of `console.log`.
 *
 * @see {@link defaultLogger} for the runtime logger affected by this reference
 * @see {@link consolePretty} for the TTY-mode pretty console logger affected by this reference
 * @see {@link withConsoleError} for routing a specific formatter logger to `console.error`
 *
 * @category references
 * @since 4.0.0
 */
export const LogToStderr: Context.Reference<boolean> = effect.LogToStderr

/**
 * Transforms the output of a `Logger` using the provided function.
 *
 * **When to use**
 *
 * Use when this allows you to modify, enhance, or completely change the output format
 * of an existing logger without recreating the entire logging logic.
 *
 * **Example** (Transforming logger output)
 *
 * ```ts
 * import { Logger } from "effect"
 *
 * // Create a logger that outputs objects
 * const structuredLogger = Logger.make((options) => ({
 *   level: options.logLevel,
 *   message: options.message,
 *   timestamp: options.date.toISOString()
 * }))
 *
 * // Transform the output to JSON strings
 * const jsonStringLogger = Logger.map(
 *   structuredLogger,
 *   (output) => JSON.stringify(output)
 * )
 *
 * // Transform to uppercase messages
 * const uppercaseLogger = Logger.map(
 *   structuredLogger,
 *   (output) => ({ ...output, message: String(output.message).toUpperCase() })
 * )
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const map = dual<
  <Output, Output2>(
    f: (output: Output) => Output2
  ) => <Message>(
    self: Logger<Message, Output>
  ) => Logger<Message, Output2>,
  <Message, Output, Output2>(
    self: Logger<Message, Output>,
    f: (output: Output) => Output2
  ) => Logger<Message, Output2>
>(2, (self, f) => effect.loggerMake((options) => f(self.log(options))))

/**
 * Returns a new `Logger` that writes all output of the specified `Logger` to
 * the console using `console.log`.
 *
 * **When to use**
 *
 * Use when this is useful for taking any logger that produces string or object output
 * and routing it to the console for development or debugging purposes.
 *
 * **Example** (Writing logger output with console.log)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Create a custom formatter
 * const customFormatter = Logger.make((options) =>
 *   `[${options.date.toISOString()}] ${options.logLevel}: ${options.message}`
 * )
 *
 * // Route to console
 * const consoleLogger = Logger.withConsoleLog(customFormatter)
 *
 * const program = Effect.log("Hello World").pipe(
 *   Effect.provide(Logger.layer([consoleLogger]))
 * )
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const withConsoleLog = <Message, Output>(
  self: Logger<Message, Output>
): Logger<Message, void> =>
  effect.loggerMake((options) => {
    const console = options.fiber.getRef(effect.ConsoleRef)
    return console.log(self.log(options))
  })
/**
 * Returns a new `Logger` that writes all output of the specified `Logger` to
 * the console using `console.error`.
 *
 * **When to use**
 *
 * Use when this is particularly useful for error logging where you want to ensure
 * log messages appear in the error stream (stderr) rather than standard output.
 *
 * **Example** (Writing logger output with console.error)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Create an error-specific formatter
 * const errorFormatter = Logger.make((options) =>
 *   `ERROR [${options.date.toISOString()}]: ${options.message}`
 * )
 *
 * // Route to console.error
 * const errorLogger = Logger.withConsoleError(errorFormatter)
 *
 * const program = Effect.logError("Database connection failed").pipe(
 *   Effect.provide(Logger.layer([errorLogger]))
 * )
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const withConsoleError = <Message, Output>(
  self: Logger<Message, Output>
): Logger<Message, void> =>
  effect.loggerMake((options) => {
    const console = options.fiber.getRef(effect.ConsoleRef)
    return console.error(self.log(options))
  })
/**
 * Returns a new `Logger` that writes all output of the specified `Logger` to
 * the console.
 *
 * **Details**
 *
 * Will use the appropriate console method (i.e. `console.log`, `console.error`,
 * etc.) based upon the current `LogLevel`.
 *
 * - `Debug` -> `console.debug`
 * - `Info` -> `console.info`
 * - `Trace` -> `console.trace`
 * - `Warn` -> `console.warn`
 * - `Error` and `Fatal` -> `console.error`
 * - Others -> `console.log`
 *
 * **Example** (Writing logs with level-based console methods)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * const formatter = Logger.make((options) =>
 *   `[${options.logLevel}] ${options.message}`
 * )
 *
 * const leveledLogger = Logger.withLeveledConsole(formatter)
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.logInfo("Info message") // -> console.info
 *   yield* Effect.logWarning("Warning") // -> console.warn
 *   yield* Effect.logError("Error occurred") // -> console.error
 *   yield* Effect.logDebug("Debug info") // -> console.debug
 * }).pipe(
 *   Effect.provide(Logger.layer([leveledLogger]))
 * )
 * ```
 *
 * @category utils
 * @since 3.8.0
 */
export const withLeveledConsole = <Message, Output>(
  self: Logger<Message, Output>
): Logger<Message, void> =>
  effect.loggerMake((options) => {
    const console = options.fiber.getRef(effect.ConsoleRef)
    const output = self.log(options)
    switch (options.logLevel) {
      case "Debug":
        return console.debug(output)
      case "Info":
        return console.info(output)
      case "Trace":
        return console.trace(output)
      case "Warn":
        return console.warn(output)
      case "Error":
      case "Fatal":
        return console.error(output)
      default:
        return console.log(output)
    }
  })

/**
 * Match strings that do not contain any whitespace characters, double quotes,
 * or equal signs.
 */
const textOnly = /^[^\s"=]*$/

/**
 * Escapes double quotes in a string.
 */
const escapeDoubleQuotes = (s: string) => `"${s.replace(/\\([\s\S])|(")/g, "\\$1$2")}"`

/**
 * Formats the identifier of a `Fiber` by prefixing it with a hash tag.
 */
const formatFiberId = (fiberId: number) => `#${fiberId}`

/**
 * Used by both {@link formatSimple} and {@link formatLogFmt} to render a log
 * message.
 *
 * @internal
 */
const format = (
  quoteValue: (s: string) => string,
  space?: number | string | undefined
) =>
({ cause, date, fiber, logLevel, message }: Options<unknown>): string => {
  const formatUnknown = (value: unknown): string =>
    typeof value === "string" ? value : Formatter.format(value, { space })
  const formatValue = (value: string): string => value.match(textOnly) ? value : quoteValue(value)
  const format = (label: string, value: string): string => `${effect.formatLabel(label)}=${formatValue(value)}`
  const append = (label: string, value: string): string => " " + format(label, value)

  let out = format("timestamp", date.toISOString())
  out += append("level", logLevel)
  out += append("fiber", formatFiberId(fiber.id))

  const messages = Array.ensure(message)
  for (let i = 0; i < messages.length; i++) {
    out += append("message", formatUnknown(messages[i]))
  }

  if (cause.reasons.length > 0) {
    out += append("cause", effect.causePretty(cause))
  }

  const now = date.getTime()
  const spans = fiber.getRef(CurrentLogSpans)
  for (const span of spans) {
    out += " " + effect.formatLogSpan(span, now)
  }

  const annotations = fiber.getRef(CurrentLogAnnotations)
  for (const [label, value] of Object.entries(annotations)) {
    out += append(label, formatUnknown(value))
  }

  return out
}

/**
 * Creates a new `Logger` from a log function.
 *
 * **Details**
 *
 * The log function receives an options object containing the message, log level,
 * cause, fiber information, and timestamp, and should return the desired output.
 *
 * **Example** (Creating loggers from functions)
 *
 * ```ts
 * import { Effect, Logger, References } from "effect"
 *
 * // Simple text logger
 * const textLogger = Logger.make((options) =>
 *   `${options.date.toISOString()} [${options.logLevel}] ${options.message}`
 * )
 *
 * // Structured object logger
 * const objectLogger = Logger.make((options) => ({
 *   timestamp: options.date.toISOString(),
 *   level: options.logLevel,
 *   message: options.message,
 *   fiberId: options.fiber.id,
 *   annotations: options.fiber.getRef(References.CurrentLogAnnotations)
 * }))
 *
 * // Custom filtering logger
 * const filteredLogger = Logger.make((options) => {
 *   if (options.logLevel === "Debug") {
 *     return // Skip debug messages
 *   }
 *   return `${options.logLevel}: ${options.message}`
 * })
 *
 * const program = Effect.log("Hello World").pipe(
 *   Effect.provide(Logger.layer([textLogger]))
 * )
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const make: <Message, Output>(
  log: (options: Options<Message>) => Output
) => Logger<Message, Output> = effect.loggerMake

/**
 * The default logging implementation used by the Effect runtime.
 *
 * **Example** (Using the default logger)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Use the default logger (automatically used by Effect runtime)
 * const program = Effect.gen(function*() {
 *   yield* Effect.log("This uses the default logger")
 *   yield* Effect.logInfo("Info message")
 *   yield* Effect.logError("Error message")
 * })
 *
 * // Explicitly use the default logger
 * const withDefaultLogger = Effect.log("Explicit default").pipe(
 *   Effect.provide(Logger.layer([Logger.defaultLogger]))
 * )
 *
 * // Compare with custom logger
 * const customLogger = Logger.make((options) => {
 *   console.log(`CUSTOM: ${options.message}`)
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const defaultLogger: Logger<unknown, void> = effect.defaultLogger

/**
 * A `Logger` which outputs logs as a string.
 *
 * **Details**
 *
 * For example, a simple log entry is rendered as
 * `timestamp=2025-01-03T14:22:47.570Z level=INFO fiber=#1 message=hello`.
 *
 * **Example** (Formatting logs as simple strings)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Use the simple format logger
 * const simpleLoggerProgram = Effect.log("Hello Simple Format").pipe(
 *   Effect.provide(Logger.layer([Logger.formatSimple]))
 * )
 *
 * // Combine with console output
 * const consoleSimpleLogger = Logger.withConsoleLog(Logger.formatSimple)
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.log("Application started")
 *   yield* Effect.logInfo("Processing data")
 *   yield* Effect.logWarning("Memory usage high")
 * }).pipe(
 *   Effect.provide(Logger.layer([consoleSimpleLogger]))
 * )
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const formatSimple = effect.loggerMake(format(escapeDoubleQuotes))

/**
 * A `Logger` which outputs logs using the [logfmt](https://brandur.org/logfmt)
 * style.
 *
 * **Details**
 *
 * For example, a logfmt entry is rendered as
 * `timestamp=2025-01-03T14:22:47.570Z level=INFO fiber=#1 message=hello`.
 *
 * **Example** (Formatting logs as logfmt)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Use the logfmt format logger
 * const logfmtLoggerProgram = Effect.log("Hello LogFmt Format").pipe(
 *   Effect.provide(Logger.layer([Logger.formatLogFmt]))
 * )
 *
 * // Perfect for structured logging systems
 * const structuredProgram = Effect.gen(function*() {
 *   yield* Effect.log("User login", { userId: 123, method: "OAuth" })
 *   yield* Effect.logInfo("Request processed", {
 *     duration: 45,
 *     status: "success"
 *   })
 * }).pipe(
 *   Effect.provide(Logger.layer([Logger.withConsoleLog(Logger.formatLogFmt)]))
 * )
 *
 * // Good for log aggregation systems like Splunk, ELK
 * const productionLogger = Logger.formatLogFmt
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const formatLogFmt = effect.loggerMake(format(JSON.stringify, 0))

/**
 * A `Logger` which outputs logs using a structured format.
 *
 * **Details**
 *
 * For example, a structured entry can contain `message: [ "hello" ]`,
 * `level: "INFO"`, `timestamp: "2025-01-03T14:25:39.666Z"`,
 * `annotations: { key: "value" }`, `spans: { label: 0 }`, and
 * `fiberId: "#1"`.
 *
 * **Example** (Formatting logs as structured objects)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Use the structured format logger
 * const structuredLoggerProgram = Effect.log("Hello Structured Format").pipe(
 *   Effect.provide(Logger.layer([Logger.formatStructured]))
 * )
 *
 * // Perfect for JSON processing and analytics
 * const analyticsProgram = Effect.gen(function*() {
 *   yield* Effect.log("User action", { action: "click", element: "button" })
 *   yield* Effect.logInfo("API call", { endpoint: "/users", duration: 150 })
 * }).pipe(
 *   Effect.annotateLogs("sessionId", "abc123"),
 *   Effect.withLogSpan("request"),
 *   Effect.provide(Logger.layer([Logger.formatStructured]))
 * )
 *
 * // Process structured output
 * const processingLogger = Logger.map(Logger.formatStructured, (output) => {
 *   // Process the structured object
 *   const enhanced = { ...output, processed: true }
 *   return enhanced
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const formatStructured: Logger<unknown, {
  readonly level: string
  readonly fiberId: string
  readonly timestamp: string
  readonly message: unknown
  readonly cause: string | undefined
  readonly annotations: Record<string, unknown>
  readonly spans: Record<string, number>
}> = effect.loggerMake(({ cause, date, fiber, logLevel, message }) => {
  const annotationsObj: Record<string, unknown> = {}
  const spansObj: Record<string, number> = {}

  const annotations = fiber.getRef(CurrentLogAnnotations)
  for (const [key, value] of Object.entries(annotations)) {
    annotationsObj[key] = effect.structuredMessage(value)
  }

  const now = date.getTime()
  const spans = fiber.getRef(CurrentLogSpans)
  for (const [label, timestamp] of spans) {
    spansObj[label] = now - timestamp
  }

  const messageArr = Array.ensure(message)
  return {
    message: messageArr.length === 1
      ? effect.structuredMessage(messageArr[0])
      : messageArr.map(effect.structuredMessage),
    level: logLevel.toUpperCase(),
    timestamp: date.toISOString(),
    cause: cause.reasons.length > 0 ? effect.causePretty(cause) : undefined,
    annotations: annotationsObj,
    spans: spansObj,
    fiberId: formatFiberId(fiber.id)
  }
})

/**
 * A `Logger` which outputs logs using a structured format serialized as JSON
 * on a single line.
 *
 * **Details**
 *
 * For example, a JSON entry can render as `{"message":["hello"],"level":"INFO",
 * "timestamp":"2025-01-03T14:28:57.508Z","annotations":{"key":"value"},
 * "spans":{"label":0},"fiberId":"#1"}`.
 *
 * **Example** (Formatting logs as JSON)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Use the JSON format logger
 * const jsonLoggerProgram = Effect.log("Hello JSON Format").pipe(
 *   Effect.provide(Logger.layer([Logger.formatJson]))
 * )
 *
 * // Perfect for log aggregation and processing systems
 * const productionProgram = Effect.gen(function*() {
 *   yield* Effect.log("Server started", { port: 3000, env: "production" })
 *   yield* Effect.logInfo("Request received", {
 *     method: "GET",
 *     path: "/api/users"
 *   })
 *   yield* Effect.logError("Database error", { error: "Connection timeout" })
 * }).pipe(
 *   Effect.annotateLogs("service", "api-server"),
 *   Effect.withLogSpan("request-processing"),
 *   Effect.provide(Logger.layer([Logger.formatJson]))
 * )
 *
 * // Adapt the JSON string before giving it to an output sink
 * const envelopedJsonLogger = Logger.map(
 *   Logger.formatJson,
 *   (jsonString) => `{"service":"api-server","entry":${jsonString}}`
 * )
 *
 * const envelopedConsoleLogger = Logger.withConsoleLog(envelopedJsonLogger)
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const formatJson = map(formatStructured, Formatter.formatJson)

/**
 * Creates a scoped logger that batches the output of another logger.
 *
 * **Details**
 *
 * The returned effect starts a scoped background process that periodically
 * passes buffered outputs to `flush`. When the scope closes, the background
 * process is interrupted and any remaining buffered entries are flushed.
 *
 * **Example** (Batching logger output)
 *
 * ```ts
 * import { Duration, Effect, Logger } from "effect"
 *
 * // Create a batched logger that flushes every 5 seconds
 * const batchedLogger = Logger.batched(Logger.formatJson, {
 *   window: Duration.seconds(5),
 *   flush: (messages) =>
 *     Effect.sync(() => {
 *       console.log(`Flushing ${messages.length} log entries:`)
 *       messages.forEach((msg, i) => console.log(`${i + 1}. ${msg}`))
 *     })
 * })
 *
 * const program = Effect.gen(function*() {
 *   const logger = yield* batchedLogger
 *
 *   yield* Effect.provide(
 *     Effect.all([
 *       Effect.log("Event 1"),
 *       Effect.log("Event 2"),
 *       Effect.log("Event 3"),
 *       Effect.sleep(Duration.seconds(6)), // Trigger flush
 *       Effect.log("Event 4")
 *     ]),
 *     Logger.layer([logger])
 *   )
 * })
 *
 * // Remote batch logging example
 * const remoteBatchLogger = Logger.batched(Logger.formatStructured, {
 *   window: Duration.seconds(10),
 *   flush: (entries) =>
 *     Effect.sync(() => {
 *       // Send batch to remote logging service
 *       console.log(`Sending ${entries.length} log entries to remote service`)
 *     })
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const batched = dual<
  <Output>(options: {
    readonly window: Duration.Input
    readonly flush: (messages: Array<NoInfer<Output>>) => Effect.Effect<void>
  }) => <Message>(
    self: Logger<Message, Output>
  ) => Effect.Effect<Logger<Message, void>, never, Scope.Scope>,
  <Message, Output>(
    self: Logger<Message, Output>,
    options: {
      readonly window: Duration.Input
      readonly flush: (messages: Array<NoInfer<Output>>) => Effect.Effect<void>
    }
  ) => Effect.Effect<Logger<Message, void>, never, Scope.Scope>
>(2, <Message, Output>(
  self: Logger<Message, Output>,
  options: {
    readonly window: Duration.Input
    readonly flush: (messages: Array<NoInfer<Output>>) => Effect.Effect<void>
  }
): Effect.Effect<Logger<Message, void>, never, Scope.Scope> =>
  effect.flatMap(effect.scope, (scope) => {
    let buffer: Array<Output> = []
    const flush = effect.suspend(() => {
      if (buffer.length === 0) {
        return effect.void
      }
      const arr = buffer
      buffer = []
      return options.flush(arr)
    })

    return effect.uninterruptibleMask((restore) =>
      restore(
        effect.sleep(options.window).pipe(
          effect.andThen(flush),
          effect.forever
        )
      ).pipe(
        effect.forkDetach,
        effect.flatMap((fiber) => effect.scopeAddFinalizerExit(scope, () => effect.fiberInterrupt(fiber))),
        effect.andThen(effect.addFinalizer(() => flush)),
        effect.as(
          effect.loggerMake((options) => {
            buffer.push(self.log(options))
          })
        )
      )
    )
  }))

/**
 * A `Logger` which outputs logs in a "pretty" format and writes them to the
 * console.
 *
 * **Details**
 *
 * For example, pretty output can render as
 * `[09:37:17.579] INFO (#1) label=0ms: hello` followed by an annotation line
 * such as `key: value`.
 *
 * **Example** (Logging with pretty console output)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Use the pretty console logger with default settings
 * const basicPretty = Effect.log("Hello Pretty Format").pipe(
 *   Effect.provide(Logger.layer([Logger.consolePretty()]))
 * )
 *
 * // Configure pretty logger options
 * const customPretty = Logger.consolePretty({
 *   colors: true,
 *   stderr: false,
 *   mode: "tty",
 *   formatDate: (date) => date.toLocaleTimeString()
 * })
 *
 * // Perfect for development environment
 * const developmentProgram = Effect.gen(function*() {
 *   yield* Effect.log("Application starting")
 *   yield* Effect.logInfo("Database connected")
 *   yield* Effect.logWarning("High memory usage detected")
 * }).pipe(
 *   Effect.annotateLogs("environment", "development"),
 *   Effect.withLogSpan("startup"),
 *   Effect.provide(Logger.layer([customPretty]))
 * )
 *
 * // Disable colors for CI/CD environments
 * const ciLogger = Logger.consolePretty({ colors: false })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const consolePretty: (
  options?: {
    readonly colors?: "auto" | boolean | undefined
    readonly stderr?: boolean | undefined
    readonly formatDate?: ((date: Date) => string) | undefined
    readonly mode?: "browser" | "tty" | "auto" | undefined
  }
) => Logger<unknown, void> = effect.consolePretty

/**
 * A `Logger` which outputs logs using the [logfmt](https://brandur.org/logfmt)
 * style and writes them to the console.
 *
 * **Details**
 *
 * For example, a console logfmt entry is rendered as
 * `timestamp=2025-01-03T14:22:47.570Z level=INFO fiber=#1 message=info`.
 *
 * **Example** (Logging logfmt output to the console)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Use the console logfmt logger
 * const logfmtProgram = Effect.log("Hello LogFmt Console").pipe(
 *   Effect.provide(Logger.layer([Logger.consoleLogFmt]))
 * )
 *
 * // Great for production environments
 * const productionProgram = Effect.gen(function*() {
 *   yield* Effect.log("Server started", { port: 8080, version: "1.0.0" })
 *   yield* Effect.logInfo("Request processed", { userId: 123, duration: 45 })
 *   yield* Effect.logError("Validation failed", {
 *     field: "email",
 *     value: "invalid"
 *   })
 * }).pipe(
 *   Effect.annotateLogs("service", "api"),
 *   Effect.withLogSpan("request-handler"),
 *   Effect.provide(Logger.layer([Logger.consoleLogFmt]))
 * )
 *
 * // Combine with other loggers
 * const multiLoggerLive = Logger.layer([
 *   Logger.consoleLogFmt,
 *   Logger.consolePretty()
 * ])
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const consoleLogFmt: Logger<unknown, void> = withConsoleLog(formatLogFmt)

/**
 * A `Logger` which outputs logs using a structured format and writes them to
 * the console.
 *
 * **Details**
 *
 * For example, console structured output can contain
 * `message: [ "info", "message" ]`, `level: "INFO"`,
 * `timestamp: "2025-01-03T14:25:39.666Z"`,
 * `annotations: { key: "value" }`, `spans: { label: 0 }`, and
 * `fiberId: "#1"`.
 *
 * **Example** (Logging structured output to the console)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Use the console structured logger
 * const structuredProgram = Effect.log("Hello Structured Console").pipe(
 *   Effect.provide(Logger.layer([Logger.consoleStructured]))
 * )
 *
 * // Perfect for development debugging
 * const debugProgram = Effect.gen(function*() {
 *   yield* Effect.log("User event", {
 *     userId: 123,
 *     action: "login",
 *     ip: "192.168.1.1"
 *   })
 *   yield* Effect.logInfo("API call", {
 *     endpoint: "/users",
 *     method: "GET",
 *     duration: 120
 *   })
 * }).pipe(
 *   Effect.annotateLogs("requestId", "req-123"),
 *   Effect.withLogSpan("authentication"),
 *   Effect.provide(Logger.layer([Logger.consoleStructured]))
 * )
 *
 * // Easy to parse and inspect object structure
 * const inspectionProgram = Effect.gen(function*() {
 *   yield* Effect.log("Complex data", {
 *     user: { id: 1, name: "John" },
 *     metadata: { source: "api", version: 2 }
 *   })
 * }).pipe(
 *   Effect.provide(Logger.layer([Logger.consoleStructured]))
 * )
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const consoleStructured: Logger<unknown, void> = withConsoleLog(formatStructured)

/**
 * A `Logger` which outputs logs using a structured format serialized as JSON
 * on a single line and writes them to the console.
 *
 * **Details**
 *
 * For example, console JSON output can render as
 * `{"message":["hello"],"level":"INFO","timestamp":"2025-01-03T14:28:57.508Z",
 * "annotations":{"key":"value"},"spans":{"label":0},"fiberId":"#1"}`.
 *
 * **Example** (Logging JSON output to the console)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Use the console JSON logger
 * const jsonProgram = Effect.log("Hello JSON Console").pipe(
 *   Effect.provide(Logger.layer([Logger.consoleJson]))
 * )
 *
 * // Perfect for production logging and log aggregation
 * const productionProgram = Effect.gen(function*() {
 *   yield* Effect.log("Server started", { port: 3000, env: "production" })
 *   yield* Effect.logInfo("Request", {
 *     method: "POST",
 *     url: "/api/users",
 *     body: { name: "Alice" }
 *   })
 *   yield* Effect.logError("Database error", {
 *     error: "Connection timeout",
 *     retryCount: 3
 *   })
 * }).pipe(
 *   Effect.annotateLogs("service", "user-api"),
 *   Effect.annotateLogs("version", "1.2.3"),
 *   Effect.withLogSpan("request-processing"),
 *   Effect.provide(Logger.layer([Logger.consoleJson]))
 * )
 *
 * // Easy to pipe to log aggregation services
 * const productionSetup = Logger.layer([
 *   Logger.consoleJson, // For stdout JSON logs
 *   Logger.consolePretty() // For local debugging
 * ])
 *
 * // Ideal for containerized environments (Docker, Kubernetes)
 * const containerProgram = Effect.log("Container ready", {
 *   containerId: "abc123",
 *   image: "myapp:latest"
 * }).pipe(
 *   Effect.provide(Logger.layer([Logger.consoleJson]))
 * )
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const consoleJson: Logger<unknown, void> = withConsoleLog(formatJson)

/**
 * A `Logger` which includes log messages as tracer span events.
 *
 * **Details**
 *
 * This logger integrates logging with distributed tracing by recording
 * all log messages as events on the current trace span, making them visible
 * in tracing tools like OpenTelemetry, Jaeger, or Zipkin.
 *
 * This logger is included in the default set of loggers for all Effect programs,
 * so log messages automatically appear as span events unless you override the
 * default loggers.
 *
 * **Example** (Recording logs as trace span events)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Tracer logger is included by default - logs automatically become span events
 * const defaultProgram = Effect.gen(function*() {
 *   yield* Effect.log("This automatically becomes a span event")
 *   yield* Effect.logInfo("Processing data")
 * })
 *
 * // Explicitly combine tracer logger with other loggers
 * const observabilityProgram = Effect.gen(function*() {
 *   yield* Effect.log("Operation started")
 *   yield* Effect.logInfo("Processing data")
 *   yield* Effect.logError("Error occurred")
 * }).pipe(
 *   Effect.withLogSpan("data-processing"),
 *   Effect.provide(Logger.layer([
 *     Logger.tracerLogger,
 *     Logger.consoleJson
 *   ]))
 * )
 *
 * // Perfect for correlating logs with traces in distributed systems
 * const distributedProgram = Effect.gen(function*() {
 *   yield* Effect.log("Step 1: Fetching user data")
 *   yield* Effect.sleep("100 millis")
 *   yield* Effect.log("Step 2: Processing payment")
 *   yield* Effect.sleep("200 millis")
 *   yield* Effect.log("Step 3: Sending confirmation")
 * }).pipe(
 *   Effect.withLogSpan("payment-workflow"),
 *   Effect.annotateLogs("userId", "user-123"),
 *   Effect.provide(Logger.layer([Logger.tracerLogger]))
 * )
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const tracerLogger: Logger<unknown, void> = effect.tracerLogger

/**
 * Creates a `Layer` which will overwrite the current set of loggers with the
 * specified array of `loggers`.
 *
 * **Details**
 *
 * If the specified array of `loggers` should be _merged_ with the current set
 * of loggers (instead of overwriting them), set `mergeWithExisting` to `true`.
 *
 * **Example** (Providing logger layers)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Single logger layer
 * const JsonLoggerLive = Logger.layer([Logger.consoleJson])
 *
 * // Multiple loggers layer
 * const MultiLoggerLive = Logger.layer([
 *   Logger.consoleJson,
 *   Logger.consolePretty(),
 *   Logger.formatStructured
 * ])
 *
 * // Merge with existing loggers
 * const AdditionalLoggerLive = Logger.layer(
 *   [Logger.consoleJson],
 *   { mergeWithExisting: true }
 * )
 *
 * // Using multiple logger formats
 * const jsonLogger = Logger.consoleJson
 * const prettyLogger = Logger.consolePretty()
 *
 * const CustomLoggerLive = Logger.layer([jsonLogger, prettyLogger])
 *
 * const program = Effect.log("Application started").pipe(
 *   Effect.provide(CustomLoggerLive)
 * )
 * ```
 *
 * @category context
 * @since 4.0.0
 */
export const layer = <
  const Loggers extends ReadonlyArray<Logger<unknown, unknown> | Effect.Effect<Logger<unknown, unknown>, any, any>>
>(
  loggers: Loggers,
  options?: { readonly mergeWithExisting?: boolean | undefined } | undefined
): Layer.Layer<
  never,
  Loggers extends readonly [] ? never : Effect.Error<Loggers[number]>,
  Exclude<
    Loggers extends readonly [] ? never : Effect.Services<Loggers[number]>,
    Scope.Scope
  >
> =>
  Layer.effect(
    CurrentLoggers,
    withFiber(effect.fnUntraced(function*(fiber) {
      const currentLoggers = new Set(options?.mergeWithExisting === true ? fiber.getRef(effect.CurrentLoggers) : [])
      for (const logger of loggers) {
        currentLoggers.add(isEffect(logger) ? yield* logger : logger)
      }
      return currentLoggers
    }))
  )

/**
 * Creates a scoped logger that writes string logger output to a file.
 *
 * **Details**
 *
 * The returned effect requires `FileSystem` and `Scope`. The file logger batches
 * string output, writes each batch to the specified path, and flushes remaining
 * entries when the scope closes.
 *
 * **Example** (Writing JSON logs to a file)
 *
 * ```ts
 * import { Effect, Layer, Logger } from "effect"
 * import { NodeFileSystem, NodeRuntime } from "@effect/platform-node"
 *
 * const fileLogger = Logger.formatJson.pipe(
 *   Logger.toFile("/tmp/log.txt")
 * )
 * const LoggerLive = Logger.layer([fileLogger]).pipe(
 *   Layer.provide(NodeFileSystem.layer)
 * )
 *
 * Effect.log("a").pipe(
 *   Effect.andThen(Effect.log("b")),
 *   Effect.andThen(Effect.log("c")),
 *   Effect.provide(LoggerLive),
 *   NodeRuntime.runMain
 * )
 * ```
 *
 * **Example** (Writing logs to files)
 *
 * ```ts
 * import { Duration, Effect, Logger } from "effect"
 * import { NodeFileSystem } from "@effect/platform-node"
 *
 * // Basic file logging. The scope keeps the file open while logs are emitted
 * // and flushes pending entries when it closes.
 * const basicFileLogger = Effect.scoped(
 *   Effect.gen(function*() {
 *     const fileLogger = yield* Logger.formatJson.pipe(
 *       Logger.toFile("/tmp/app.log")
 *     )
 *
 *     yield* Effect.log("Application started").pipe(
 *       Effect.provide(Logger.layer([fileLogger]))
 *     )
 *   })
 * ).pipe(
 *   Effect.provide(NodeFileSystem.layer)
 * )
 *
 * // File logger with custom batch window
 * const batchedFileLogger = Effect.scoped(
 *   Effect.gen(function*() {
 *     const fileLogger = yield* Logger.formatLogFmt.pipe(
 *       Logger.toFile("/var/log/myapp.log", {
 *         flag: "a",
 *         batchWindow: Duration.seconds(5)
 *       })
 *     )
 *
 *     yield* Effect.all([
 *       Effect.log("Event 1"),
 *       Effect.log("Event 2"),
 *       Effect.log("Event 3")
 *     ]).pipe(
 *       Effect.provide(Logger.layer([fileLogger]))
 *     )
 *   })
 * ).pipe(
 *   Effect.provide(NodeFileSystem.layer)
 * )
 *
 * // Multiple loggers: console + file
 * const multiLogger = Effect.scoped(
 *   Effect.gen(function*() {
 *     const fileLogger = yield* Logger.formatJson.pipe(
 *       Logger.toFile("/tmp/production.log")
 *     )
 *
 *     const loggerLive = Logger.layer([
 *       Logger.consolePretty(),
 *       fileLogger
 *     ])
 *
 *     yield* Effect.log("Production event").pipe(
 *       Effect.provide(loggerLive)
 *     )
 *   })
 * ).pipe(
 *   Effect.provide(NodeFileSystem.layer)
 * )
 * ```
 *
 * @category file
 * @since 4.0.0
 */
export const toFile = dual<
  (
    path: string,
    options?: {
      readonly flag?: FileSystem.OpenFlag | undefined
      readonly mode?: number | undefined
      readonly batchWindow?: Duration.Input | undefined
    } | undefined
  ) => <Message>(
    self: Logger<Message, string>
  ) => Effect.Effect<Logger<Message, void>, PlatformError, Scope.Scope | FileSystem.FileSystem>,
  <Message>(
    self: Logger<Message, string>,
    path: string,
    options?: {
      readonly flag?: FileSystem.OpenFlag | undefined
      readonly mode?: number | undefined
      readonly batchWindow?: Duration.Input | undefined
    } | undefined
  ) => Effect.Effect<Logger<Message, void>, PlatformError, Scope.Scope | FileSystem.FileSystem>
>(
  (args) => isLogger(args[0]),
  (self, path, options) =>
    effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const logFile = yield* fs.open(path, { flag: "a+", ...options })
      const encoder = new TextEncoder()
      return yield* batched(self, {
        window: options?.batchWindow ?? 1000,
        flush: (output) => effect.ignore(logFile.write(encoder.encode(output.join("\n") + "\n")))
      })
    })
)
