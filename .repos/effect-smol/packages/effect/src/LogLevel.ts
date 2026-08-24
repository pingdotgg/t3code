/**
 * Log-level types and helpers used by Effect logging. The module defines all
 * accepted log levels, the concrete emitted severities, the ordered level list,
 * equality and ordering instances, threshold comparison helpers, and an effect
 * for checking whether a level is enabled by the current logging settings.
 *
 * @since 2.0.0
 */
import type * as Effect from "./Effect.ts"
import * as Equ from "./Equivalence.ts"
import * as core from "./internal/core.ts"
import * as effect from "./internal/effect.ts"
import * as Ord from "./Order.ts"
import * as References from "./References.ts"

/**
 * Represents every level used by Effect logging, including concrete message
 * severities and the `All` and `None` sentinel levels.
 *
 * **When to use**
 *
 * Use to type values that may be either concrete log message severities or
 * logging configuration sentinels.
 *
 * **Details**
 *
 * The levels are ordered from most severe to least severe:
 * - `All` - Special level that allows all messages
 * - `Fatal` - System is unusable, immediate attention required
 * - `Error` - Error conditions that should be investigated
 * - `Warn` - Warning conditions that may indicate problems
 * - `Info` - Informational messages about normal operation
 * - `Debug` - Debug information useful during development
 * - `Trace` - Very detailed trace information
 * - `None` - Special level that suppresses all messages
 *
 * **Example** (Using log levels)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // Using log levels with Effect logging
 * const program = Effect.gen(function*() {
 *   yield* Effect.logFatal("System failure")
 *   yield* Effect.logError("Database error")
 *   yield* Effect.logWarning("High memory usage")
 *   yield* Effect.logInfo("User logged in")
 *   yield* Effect.logDebug("Processing request")
 *   yield* Effect.logTrace("Variable state")
 * })
 *
 * // Type-safe log level variables
 * const errorLevel = "Error" // LogLevel
 * const debugLevel = "Debug" // LogLevel
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export type LogLevel = "All" | "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace" | "None"

/**
 * Log levels that represent actual message severities, excluding the `All` and
 * `None` sentinel levels.
 *
 * **When to use**
 *
 * Use when typing emitted log message severities, such as explicit log calls,
 * current log level references, or error-report severity annotations, where
 * `All` and `None` are not valid values.
 *
 * @see {@link LogLevel} for the wider log-level type that also accepts the
 * `All` and `None` sentinel levels
 * @see {@link values} for the runtime list of all accepted `LogLevel` values,
 * including sentinels
 *
 * @category models
 * @since 4.0.0
 */
export type Severity = "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace"

/**
 * Returns all `LogLevel` values in order from `All` through the concrete severities to
 * `None`.
 *
 * **When to use**
 *
 * Use to enumerate or validate all accepted `LogLevel` string values, including
 * the `All` and `None` sentinel levels.
 *
 * **Details**
 *
 * The array order matches the module severity order: `All`, concrete
 * severities from `Fatal` to `Trace`, then `None`.
 *
 * **Gotchas**
 *
 * This list includes `All` and `None`, so it is not limited to concrete emitted
 * severities.
 *
 * @see {@link Severity} for the concrete message severity type that excludes `All` and `None`
 * @see {@link Order} for comparing these levels by severity order
 *
 * @category models
 * @since 4.0.0
 */
export const values: ReadonlyArray<LogLevel> = ["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"]

/**
 * Order instance for `LogLevel` that defines the severity ordering.
 *
 * **When to use**
 *
 * Use to sort or compare log levels according to Effect's severity order.
 *
 * **Details**
 *
 * This order treats "All" as the least restrictive level and "None" as the most restrictive,
 * with Fatal being the most severe actual log level.
 *
 * **Example** (Ordering log levels)
 *
 * ```ts
 * import { LogLevel } from "effect"
 *
 * // Compare log levels using Order
 * console.log(LogLevel.Order("Error", "Info")) // 1 (Error > Info)
 * console.log(LogLevel.Order("Debug", "Error")) // -1 (Debug < Error)
 * console.log(LogLevel.Order("Info", "Info")) // 0 (Info == Info)
 * ```
 *
 * @category ordering
 * @since 2.0.0
 */
export const Order: Ord.Order<LogLevel> = effect.LogLevelOrder

/**
 * Equivalence instance for log levels using strict equality (`===`).
 *
 * **When to use**
 *
 * Use to compare two `LogLevel` values when only the exact same level should
 * match.
 *
 * **Details**
 *
 * Each log level string, including `All` and `None`, only matches itself.
 *
 * **Example** (Comparing log levels)
 *
 * ```ts
 * import { LogLevel } from "effect"
 *
 * console.log(LogLevel.Equivalence("Error", "Error")) // true
 * console.log(LogLevel.Equivalence("Error", "Info")) // false
 * ```
 *
 * @see {@link Order} for severity ordering rather than exact level equality
 * @see {@link isGreaterThanOrEqualTo} for minimum-threshold checks
 *
 * @category instances
 * @since 4.0.0
 */
export const Equivalence: Equ.Equivalence<LogLevel> = Equ.strictEqual<LogLevel>()

/**
 * Returns the ordinal value of the log level.
 *
 * **When to use**
 *
 * Use to project a `LogLevel` into the numeric sort key used by
 * `LogLevel.Order` when custom ordering code or an integration needs a number
 * instead of an `Order` comparison.
 *
 * **Details**
 *
 * The mapping is `All` to `Number.MIN_SAFE_INTEGER`, `Trace` to `0`, `Debug` to
 * `10000`, `Info` to `20000`, `Warn` to `30000`, `Error` to `40000`, `Fatal` to
 * `50000`, and `None` to `Number.MAX_SAFE_INTEGER`.
 *
 * **Gotchas**
 *
 * These ordinals are internal sort keys; do not treat them as external severity
 * numbers.
 *
 * @see {@link Order} for comparing log levels without exposing numeric keys
 * @see {@link isGreaterThanOrEqualTo} for minimum-threshold filtering
 *
 * @category ordering
 * @since 4.0.0
 */
export const getOrdinal = (self: LogLevel): number => effect.logLevelToOrder(self)

/**
 * Determines if the first log level is more severe than the second.
 *
 * **When to use**
 *
 * Use to check whether one log level is strictly more severe than another.
 *
 * **Details**
 *
 * Returns `true` if `self` represents a more severe level than `that`.
 *
 * **Example** (Checking higher severity)
 *
 * ```ts
 * import { LogLevel } from "effect"
 *
 * // Check if Error is more severe than Info
 * console.log(LogLevel.isGreaterThan("Error", "Info")) // true
 * console.log(LogLevel.isGreaterThan("Debug", "Error")) // false
 *
 * // Use with filtering
 * const isFatal = LogLevel.isGreaterThan("Fatal", "Warn")
 * const isError = LogLevel.isGreaterThan("Error", "Warn")
 * const isDebug = LogLevel.isGreaterThan("Debug", "Warn")
 * console.log(isFatal) // true
 * console.log(isError) // true
 * console.log(isDebug) // false
 *
 * // Curried usage
 * const isMoreSevereThanInfo = LogLevel.isGreaterThan("Info")
 * console.log(isMoreSevereThanInfo("Error")) // true
 * console.log(isMoreSevereThanInfo("Debug")) // false
 * ```
 *
 * @category ordering
 * @since 4.0.0
 */
export const isGreaterThan: {
  (that: LogLevel): (self: LogLevel) => boolean
  (self: LogLevel, that: LogLevel): boolean
} = effect.isLogLevelGreaterThan

/**
 * Determines if the first log level is more severe than or equal to the second.
 *
 * **When to use**
 *
 * Use to implement minimum log-level filtering by checking whether a message
 * level meets a threshold.
 *
 * **Details**
 *
 * Returns `true` if `self` represents a level that is more severe than or equal to `that`.
 *
 * **Example** (Filtering by minimum log level)
 *
 * ```ts
 * import { Logger, LogLevel } from "effect"
 *
 * // Check if level meets minimum threshold
 * console.log(LogLevel.isGreaterThanOrEqualTo("Error", "Error")) // true
 * console.log(LogLevel.isGreaterThanOrEqualTo("Error", "Info")) // true
 * console.log(LogLevel.isGreaterThanOrEqualTo("Debug", "Info")) // false
 *
 * // Create a logger that only logs Info and above
 * const infoLogger = Logger.make((options) => {
 *   if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Info")) {
 *     console.log(`[${options.logLevel}] ${options.message}`)
 *   }
 * })
 *
 * // Production logger - only Error and Fatal
 * const productionLogger = Logger.make((options) => {
 *   if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Error")) {
 *     console.error(
 *       `${options.date.toISOString()} [${options.logLevel}] ${options.message}`
 *     )
 *   }
 * })
 *
 * // Curried usage for filtering
 * const isInfoOrAbove = LogLevel.isGreaterThanOrEqualTo("Info")
 * const shouldLog = isInfoOrAbove("Error") // true
 * ```
 *
 * @category ordering
 * @since 4.0.0
 */
export const isGreaterThanOrEqualTo: {
  (that: LogLevel): (self: LogLevel) => boolean
  (self: LogLevel, that: LogLevel): boolean
} = Ord.isGreaterThanOrEqualTo(Order)

/**
 * Determines if the first log level is less severe than the second.
 *
 * **When to use**
 *
 * Use to check whether one log level is strictly less severe than another.
 *
 * **Details**
 *
 * Returns `true` if `self` represents a less severe level than `that`.
 *
 * **Example** (Checking lower severity)
 *
 * ```ts
 * import { LogLevel } from "effect"
 *
 * // Check if Debug is less severe than Info
 * console.log(LogLevel.isLessThan("Debug", "Info")) // true
 * console.log(LogLevel.isLessThan("Error", "Info")) // false
 *
 * // Filter out verbose logs
 * const isFatalVerbose = LogLevel.isLessThan("Fatal", "Info")
 * const isErrorVerbose = LogLevel.isLessThan("Error", "Info")
 * const isTraceVerbose = LogLevel.isLessThan("Trace", "Info")
 * console.log(isFatalVerbose) // false (Fatal is not verbose)
 * console.log(isErrorVerbose) // false (Error is not verbose)
 * console.log(isTraceVerbose) // true (Trace is verbose)
 *
 * // Curried usage
 * const isLessSevereThanError = LogLevel.isLessThan("Error")
 * console.log(isLessSevereThanError("Info")) // true
 * console.log(isLessSevereThanError("Fatal")) // false
 * ```
 *
 * @category ordering
 * @since 4.0.0
 */
export const isLessThan: {
  (that: LogLevel): (self: LogLevel) => boolean
  (self: LogLevel, that: LogLevel): boolean
} = Ord.isLessThan(Order)

/**
 * Determines if the first log level is less severe than or equal to the second.
 *
 * **When to use**
 *
 * Use to implement maximum log-level filtering by checking whether a level is
 * at or below a threshold.
 *
 * **Details**
 *
 * Returns `true` if `self` represents a level that is less severe than or equal to `that`.
 *
 * **Example** (Filtering by maximum log level)
 *
 * ```ts
 * import { Logger, LogLevel } from "effect"
 *
 * // Check if level is at or below threshold
 * console.log(LogLevel.isLessThanOrEqualTo("Info", "Info")) // true
 * console.log(LogLevel.isLessThanOrEqualTo("Debug", "Info")) // true
 * console.log(LogLevel.isLessThanOrEqualTo("Error", "Info")) // false
 *
 * // Create a logger that suppresses verbose logs
 * const quietLogger = Logger.make((options) => {
 *   if (LogLevel.isLessThanOrEqualTo(options.logLevel, "Info")) {
 *     console.log(`[${options.logLevel}] ${options.message}`)
 *   }
 * })
 *
 * // Development logger - suppress trace logs
 * const devLogger = Logger.make((options) => {
 *   if (LogLevel.isLessThanOrEqualTo(options.logLevel, "Debug")) {
 *     console.log(`[${options.logLevel}] ${options.message}`)
 *   }
 * })
 *
 * // Curried usage for filtering
 * const isInfoOrBelow = LogLevel.isLessThanOrEqualTo("Info")
 * const shouldLog = isInfoOrBelow("Debug") // true
 * ```
 *
 * @category ordering
 * @since 4.0.0
 */
export const isLessThanOrEqualTo: {
  (that: LogLevel): (self: LogLevel) => boolean
  (self: LogLevel, that: LogLevel): boolean
} = Ord.isLessThanOrEqualTo(Order)

/**
 * Checks whether a given log level is enabled for the current fiber.
 *
 * **When to use**
 *
 * Use to check whether a log level would be emitted under the current fiber's
 * minimum log level.
 *
 * **Details**
 *
 * A log level is enabled when it is greater than or equal to
 * `References.MinimumLogLevel`.
 *
 * **Example** (Checking current fiber log level)
 *
 * ```ts
 * import { Effect, LogLevel, References } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const debugEnabled = yield* LogLevel.isEnabled("Debug")
 *   const errorEnabled = yield* LogLevel.isEnabled("Error")
 *
 *   console.log({ debugEnabled, errorEnabled })
 * })
 *
 * const warnOnly = program.pipe(
 *   Effect.provideService(References.MinimumLogLevel, "Warn")
 * )
 * ```
 *
 * @category filtering
 * @since 4.0.0
 */
export const isEnabled = (self: LogLevel): Effect.Effect<boolean> =>
  core.withFiber((fiber) => effect.succeed(!isGreaterThan(fiber.getRef(References.MinimumLogLevel), self)))
