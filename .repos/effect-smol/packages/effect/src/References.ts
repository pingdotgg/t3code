/**
 * The `References` module exposes the built-in `Context.Reference` keys that
 * the Effect runtime consults for execution settings and diagnostic metadata.
 * These references cover concurrency, scheduling, logging, tracing, and
 * low-level diagnostic state.
 *
 * A `Context.Reference<A>` is a service key with a default value. Reading one
 * of these references returns the value from the current fiber context, and
 * providing a new value changes behavior for the provided effect and the fibers
 * it starts.
 *
 * **Mental model**
 *
 * - Each exported value is a context key with a runtime default, so it can be
 *   read even when application code has not provided an override.
 * - Runtime services such as logging, tracing, scheduling, and concurrency
 *   controls read these keys from the current context.
 * - `Effect.provideService` overrides a reference for a specific effect scope;
 *   it does not mutate a process-wide global.
 * - Child fibers inherit the context active at the point they are started.
 *
 * **Common tasks**
 *
 * - Limit default concurrency with {@link CurrentConcurrency}.
 * - Control log severity and filtering with {@link CurrentLogLevel},
 *   {@link MinimumLogLevel}, and {@link UnhandledLogLevel}.
 * - Attach log metadata with {@link CurrentLogAnnotations} and
 *   {@link CurrentLogSpans}, or replace the active loggers with
 *   {@link CurrentLoggers}.
 * - Configure tracing with {@link Tracer}, {@link TracerEnabled},
 *   {@link TracerTimingEnabled}, {@link TracerSpanAnnotations}, and
 *   {@link TracerSpanLinks}.
 * - Tune scheduler behavior with {@link Scheduler}, {@link MaxOpsBeforeYield},
 *   and {@link PreventSchedulerYield}.
 *
 * **Example** (Providing a runtime reference)
 *
 * ```ts
 * import { Effect, References } from "effect"
 *
 * const readConcurrency = Effect.gen(function*() {
 *   return yield* References.CurrentConcurrency
 * })
 *
 * const limited = Effect.provideService(
 *   readConcurrency,
 *   References.CurrentConcurrency,
 *   4
 * )
 * ```
 *
 * **Gotchas**
 *
 * - Prefer higher-level logging, tracing, and concurrency APIs when they fit;
 *   this module is for direct access to the runtime knobs they use.
 * - `CurrentLogLevel` chooses the severity assigned to ordinary log entries,
 *   while `MinimumLogLevel` decides which entries are filtered out.
 * - References are context values, so scoped overrides end when the provided
 *   effect completes.
 *
 * @since 4.0.0
 */
import type * as Context from "./Context.ts"
import * as internalEffect from "./internal/effect.ts"
import * as references from "./internal/references.ts"
import type { Logger } from "./Logger.ts"
import type { LogLevel, Severity } from "./LogLevel.ts"
import type { ReadonlyRecord } from "./Record.ts"
import { MaxOpsBeforeYield, PreventSchedulerYield } from "./Scheduler.ts"
import { CurrentTraceLevel, DisablePropagation, MinimumTraceLevel, type SpanLink, Tracer } from "./Tracer.ts"

export {
  /**
   * Context reference for the current trace level used for dynamic trace filtering.
   *
   * **When to use**
   *
   * Use to set the default trace level for spans created in a scope when span
   * options do not provide `level`.
   *
   * @see {@link MinimumTraceLevel} for configuring the threshold that decides whether spans at a given level are sampled or exported
   *
   * @category references
   * @since 4.0.0
   */
  CurrentTraceLevel,
  /**
   * Context reference for disabling trace propagation in the current context.
   *
   * **When to use**
   *
   * Use to mark tracing work as non-propagating while still allowing local span
   * tracking.
   *
   * **Details**
   *
   * Annotated spans become non-propagating no-op spans, and parent selection
   * skips spans marked with disabled propagation.
   *
   * @see {@link TracerEnabled} for disabling span registration instead of only propagation
   *
   * @category references
   * @since 4.0.0
   */
  DisablePropagation,
  /**
   * Context reference for the maximum operation budget before a fiber yields to the scheduler.
   *
   * **When to use**
   *
   * Use to tune scheduler fairness for CPU-bound fibers by changing the
   * operation budget that triggers a scheduler yield.
   *
   * **Details**
   *
   * The default value is `2048` operations.
   *
   * @see {@link PreventSchedulerYield} for bypassing scheduler yield checks instead of changing the operation budget
   *
   * @category references
   * @since 4.0.0
   */
  MaxOpsBeforeYield,
  /**
   * Context reference for the minimum trace level threshold for span sampling.
   *
   * **When to use**
   *
   * Use to set the trace-level threshold that decides whether newly created
   * spans are sampled and exported.
   *
   * @see {@link CurrentTraceLevel} for setting the level assigned to spans before this threshold is applied
   *
   * @category references
   * @since 4.0.0
   */
  MinimumTraceLevel,
  /**
   * Context reference for whether the runtime bypasses scheduler yield checks.
   *
   * **When to use**
   *
   * Use to bypass automatic scheduler yield checks in a controlled runtime scope
   * where throughput is preferred over scheduler fairness.
   *
   * **Details**
   *
   * When set to `true`, the fiber run loop skips `Scheduler.shouldYield`. The
   * default value is `false`.
   *
   * **Gotchas**
   *
   * Disabling automatic yield checks can let long-running fibers monopolize the
   * JavaScript thread.
   *
   * @see {@link MaxOpsBeforeYield} for tuning the operation budget while keeping scheduler yield checks enabled
   *
   * @category references
   * @since 4.0.0
   */
  PreventSchedulerYield,
  /**
   * Context reference for the active tracer service used to create spans.
   *
   * **When to use**
   *
   * Use to access or override the active tracer service through the references
   * module when working directly with Effect runtime references.
   *
   * @category references
   * @since 4.0.0
   */
  Tracer
}

/**
 * Context reference for controlling the current concurrency limit. Can be set to "unbounded"
 * for unlimited concurrency or a specific number to limit concurrent operations.
 *
 * **When to use**
 *
 * Use to configure the default concurrency limit for operations that read
 * concurrency from the current context.
 *
 * **Example** (Setting current concurrency)
 *
 * ```ts
 * import { Effect, References } from "effect"
 *
 * const limitConcurrency = Effect.gen(function*() {
 *   // Get current setting
 *   const current = yield* References.CurrentConcurrency
 *   console.log(current) // "unbounded" (default)
 *
 *   // Run with limited concurrency
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const limited = yield* References.CurrentConcurrency
 *       console.log(limited) // 10
 *     }),
 *     References.CurrentConcurrency,
 *     10
 *   )
 *
 *   // Run with unlimited concurrency
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const unlimited = yield* References.CurrentConcurrency
 *       console.log(unlimited) // "unbounded"
 *     }),
 *     References.CurrentConcurrency,
 *     "unbounded"
 *   )
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const CurrentConcurrency: Context.Reference<number | "unbounded"> = references.CurrentConcurrency

/**
 * Context reference for managing log annotations that are automatically added to all log entries.
 * These annotations provide contextual metadata that appears in every log message.
 *
 * **When to use**
 *
 * Use to attach shared contextual metadata to every log entry emitted in the
 * current context.
 *
 * **Example** (Managing log annotations)
 *
 * ```ts
 * import { Console, Effect, References } from "effect"
 *
 * const logAnnotationExample = Effect.gen(function*() {
 *   // Get current annotations (empty by default)
 *   const current = yield* References.CurrentLogAnnotations
 *   console.log(current) // {}
 *
 *   // Run with custom log annotations
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const annotations = yield* References.CurrentLogAnnotations
 *       console.log(annotations) // { requestId: "req-123", userId: "user-456", version: "1.0.0" }
 *
 *       // All log entries will include these annotations
 *       yield* Console.log("Starting operation")
 *       yield* Console.info("Processing data")
 *     }),
 *     References.CurrentLogAnnotations,
 *     {
 *       requestId: "req-123",
 *       userId: "user-456",
 *       version: "1.0.0"
 *     }
 *   )
 *
 *   // Run with extended annotations
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const extended = yield* References.CurrentLogAnnotations
 *       console.log(extended) // { requestId: "req-123", userId: "user-456", version: "1.0.0", operation: "data-sync", timestamp: 1234567890 }
 *
 *       yield* Console.log("Operation completed with extended context")
 *     }),
 *     References.CurrentLogAnnotations,
 *     {
 *       requestId: "req-123",
 *       userId: "user-456",
 *       version: "1.0.0",
 *       operation: "data-sync",
 *       timestamp: 1234567890
 *     }
 *   )
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const CurrentLogAnnotations: Context.Reference<ReadonlyRecord<string, unknown>> =
  references.CurrentLogAnnotations

/**
 * Context reference for the current log severity used by `Effect.log` when no explicit
 * level is provided.
 *
 * **When to use**
 *
 * Use to set the default severity for `Effect.log` entries that do not provide
 * an explicit level.
 *
 * **Details**
 *
 * Use `MinimumLogLevel` to control which log entries are filtered out.
 *
 * **Example** (Changing the current log level)
 *
 * ```ts
 * import { Console, Effect, References } from "effect"
 *
 * const dynamicLogging = Effect.gen(function*() {
 *   // Get current log level (default is "Info")
 *   const current = yield* References.CurrentLogLevel
 *   console.log(current) // "Info"
 *
 *   // Set log level to Debug for detailed logging
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const level = yield* References.CurrentLogLevel
 *       console.log(level) // "Debug"
 *       yield* Console.debug("This debug message will be shown")
 *     }),
 *     References.CurrentLogLevel,
 *     "Debug"
 *   )
 *
 *   // Change to Error level to reduce noise
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const level = yield* References.CurrentLogLevel
 *       console.log(level) // "Error"
 *       yield* Console.info("This info message will be filtered out")
 *       yield* Console.error("This error message will be shown")
 *     }),
 *     References.CurrentLogLevel,
 *     "Error"
 *   )
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const CurrentLogLevel: Context.Reference<Severity> = references.CurrentLogLevel

/**
 * Context reference for managing log spans that track the duration and hierarchy of operations.
 * Each span represents a labeled time period for performance analysis and debugging.
 *
 * **When to use**
 *
 * Use to carry the active log span stack that should be included with log
 * entries in the current context.
 *
 * **Example** (Tracking log spans)
 *
 * ```ts
 * import { Console, Effect, References } from "effect"
 *
 * const logSpanExample = Effect.gen(function*() {
 *   // Get current spans (empty by default)
 *   const current = yield* References.CurrentLogSpans
 *   console.log(current.length) // 0
 *
 *   // Add a log span manually
 *   const databaseConnectionStartedAt = 0
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       // Simulate some work
 *       yield* Effect.sleep("100 millis")
 *       yield* Console.log("Database operation in progress")
 *
 *       const spans = yield* References.CurrentLogSpans
 *       console.log("Active spans:", spans.map(([label]) => label)) // ["database-connection"]
 *     }),
 *     References.CurrentLogSpans,
 *     [["database-connection", databaseConnectionStartedAt]]
 *   )
 *
 *   // Add another span
 *   const dataProcessingStartedAt = 100
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const spans = yield* References.CurrentLogSpans
 *       console.log("Active spans:", spans.map(([label]) => label)) // ["database-connection", "data-processing"]
 *
 *       yield* Console.log("Multiple operations in progress")
 *     }),
 *     References.CurrentLogSpans,
 *     [
 *       ["database-connection", databaseConnectionStartedAt],
 *       ["data-processing", dataProcessingStartedAt]
 *     ]
 *   )
 *
 *   // Clear spans when operations complete
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const spans = yield* References.CurrentLogSpans
 *       console.log("Active spans:", spans.length) // 0
 *     }),
 *     References.CurrentLogSpans,
 *     []
 *   )
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const CurrentLogSpans: Context.Reference<ReadonlyArray<[label: string, timestamp: number]>> =
  references.CurrentLogSpans

/**
 * Context reference for the current captured stack-frame chain for the running
 * fiber.
 *
 * **When to use**
 *
 * Use when writing low-level tracing or diagnostic integrations that need direct
 * access to the stack-frame chain carried by the current fiber.
 *
 * **Details**
 *
 * Effect and Layer tracing use this reference to attach stack-frame information
 * to failures and interruption causes. It is normally managed by tracing APIs
 * rather than provided directly by application code.
 *
 * @see {@link StackFrame} for the frame node stored in this reference
 *
 * @category references
 * @since 4.0.0
 */
export const CurrentStackFrame: Context.Reference<StackFrame | undefined> = references.CurrentStackFrame

/**
 * Context reference for setting the minimum log level threshold. Log entries below this
 * level will be filtered out completely.
 *
 * **When to use**
 *
 * Use to filter out log entries below a severity threshold.
 *
 * **Example** (Setting the minimum log level)
 *
 * ```ts
 * import { Console, Effect, References } from "effect"
 *
 * const configureMinimumLogging = Effect.gen(function*() {
 *   // Get current minimum level (default is "Info")
 *   const current = yield* References.MinimumLogLevel
 *   console.log(current) // "Info"
 *
 *   // Set minimum level to Warn - Debug and Info will be filtered
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const minLevel = yield* References.MinimumLogLevel
 *       console.log(minLevel) // "Warn"
 *
 *       // These won't be processed at all
 *       yield* Console.debug("Debug message") // Filtered out
 *       yield* Console.info("Info message") // Filtered out
 *
 *       // These will be processed
 *       yield* Console.warn("Warning message") // Shown
 *       yield* Console.error("Error message") // Shown
 *     }),
 *     References.MinimumLogLevel,
 *     "Warn"
 *   )
 *
 *   // Reset to default Info level
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const minLevel = yield* References.MinimumLogLevel
 *       console.log(minLevel) // "Info"
 *
 *       // Now info messages will be processed
 *       yield* Console.info("Info message") // Shown
 *     }),
 *     References.MinimumLogLevel,
 *     "Info"
 *   )
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const MinimumLogLevel: Context.Reference<LogLevel> = references.MinimumLogLevel

/**
 * Context reference for controlling whether tracing is enabled globally. When set to false,
 * spans will not be registered with the tracer and tracing overhead is minimized.
 *
 * **When to use**
 *
 * Use to disable or re-enable span registration in the current context.
 *
 * **Example** (Toggling tracing)
 *
 * ```ts
 * import { Effect, References } from "effect"
 *
 * const tracingControl = Effect.gen(function*() {
 *   // Check if tracing is enabled (default is true)
 *   const current = yield* References.TracerEnabled
 *   console.log(current) // true
 *
 *   // Disable tracing globally
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const isEnabled = yield* References.TracerEnabled
 *       console.log(isEnabled) // false
 *
 *       // Spans will not be traced in this context
 *       yield* Effect.log("This will not be traced")
 *     }),
 *     References.TracerEnabled,
 *     false
 *   )
 *
 *   // Re-enable tracing
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const isEnabled = yield* References.TracerEnabled
 *       console.log(isEnabled) // true
 *
 *       // All subsequent spans will be traced
 *       yield* Effect.log("This will be traced")
 *     }),
 *     References.TracerEnabled,
 *     true
 *   )
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const TracerEnabled: Context.Reference<boolean> = references.TracerEnabled

/**
 * Context reference for managing span annotations that are automatically added to all new spans.
 * These annotations provide context and metadata that applies across multiple spans.
 *
 * **When to use**
 *
 * Use to attach shared metadata to every span created in the current context.
 *
 * **Example** (Managing span annotations)
 *
 * ```ts
 * import { Effect, References } from "effect"
 *
 * const spanAnnotationExample = Effect.gen(function*() {
 *   // Get current annotations (empty by default)
 *   const current = yield* References.TracerSpanAnnotations
 *   console.log(current) // {}
 *
 *   // Set global span annotations
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       // Get current annotations
 *       const annotations = yield* References.TracerSpanAnnotations
 *       console.log(annotations) // { service: "user-service", version: "1.2.3", environment: "production" }
 *
 *       // All spans created will include these annotations
 *       yield* Effect.gen(function*() {
 *         // Add more specific annotations for this span
 *         yield* Effect.annotateCurrentSpan("userId", "123")
 *         yield* Effect.log("Processing user")
 *       })
 *     }),
 *     References.TracerSpanAnnotations,
 *     {
 *       service: "user-service",
 *       version: "1.2.3",
 *       environment: "production"
 *     }
 *   )
 *
 *   // Clear annotations
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const annotations = yield* References.TracerSpanAnnotations
 *       console.log(annotations) // {}
 *     }),
 *     References.TracerSpanAnnotations,
 *     {}
 *   )
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const TracerSpanAnnotations: Context.Reference<ReadonlyRecord<string, unknown>> =
  references.TracerSpanAnnotations

/**
 * Context reference for managing span links that are automatically added to all new spans.
 * Span links connect related spans that are not in a parent-child relationship.
 *
 * **When to use**
 *
 * Use to attach shared links to every span created in the current context.
 *
 * **Example** (Managing span links)
 *
 * ```ts
 * import { Effect, References, Tracer } from "effect"
 *
 * const spanLinksExample = Effect.gen(function*() {
 *   // Get current links (empty by default)
 *   const current = yield* References.TracerSpanLinks
 *   console.log(current.length) // 0
 *
 *   // Create an external span for the example
 *   const externalSpan = Tracer.externalSpan({
 *     spanId: "external-span-123",
 *     traceId: "trace-456"
 *   })
 *
 *   // Create span links
 *   const spanLink: Tracer.SpanLink = {
 *     span: externalSpan,
 *     attributes: {
 *       relationship: "follows-from",
 *       priority: "high"
 *     }
 *   }
 *
 *   // Set global span links
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       // Get current links
 *       const links = yield* References.TracerSpanLinks
 *       console.log(links.length) // 1
 *
 *       // All new spans will include these links
 *       yield* Effect.gen(function*() {
 *         yield* Effect.log("This span will have linked spans")
 *         return "operation complete"
 *       })
 *     }),
 *     References.TracerSpanLinks,
 *     [spanLink]
 *   )
 *
 *   // Clear links
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const links = yield* References.TracerSpanLinks
 *       console.log(links.length) // 0
 *     }),
 *     References.TracerSpanLinks,
 *     []
 *   )
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const TracerSpanLinks: Context.Reference<ReadonlyArray<SpanLink>> = references.TracerSpanLinks

/**
 * Context reference for controlling whether trace timing is enabled globally. When set
 * to false, spans will not contain timing information (trace time will always
 * be set to zero).
 *
 * **When to use**
 *
 * Use to disable or re-enable timing capture for spans in the current context.
 *
 * **Example** (Toggling trace timing)
 *
 * ```ts
 * import { Effect, References } from "effect"
 *
 * const tracingControl = Effect.gen(function*() {
 *   // Check if trace timing is enabled (default is true)
 *   const current = yield* References.TracerTimingEnabled
 *   console.log(current) // true
 *
 *   // Disable trace timing globally
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       // Spans will not having timing information in this context
 *       const isEnabled = yield* References.TracerTimingEnabled
 *       console.log(isEnabled) // false
 *     }),
 *     References.TracerTimingEnabled,
 *     false
 *   )
 *
 *   // Re-enable trace timing
 *   yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       // Spans will have timing information in this context
 *       const isEnabled = yield* References.TracerTimingEnabled
 *       console.log(isEnabled) // true
 *     }),
 *     References.TracerTimingEnabled,
 *     true
 *   )
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const TracerTimingEnabled: Context.Reference<boolean> = references.TracerTimingEnabled

/**
 * Context reference for the log severity used when a pool finalizer reports an
 * unhandled error.
 *
 * **When to use**
 *
 * Use to choose whether and at which severity pool finalizer failures are
 * reported.
 *
 * **Details**
 *
 * The default level is `"Error"`.
 *
 * **Gotchas**
 *
 * Providing `undefined` suppresses this report; it does not fall back to
 * `CurrentLogLevel`.
 *
 * @see {@link CurrentLogLevel} for the default severity used by ordinary `Effect.log` calls
 * @see {@link MinimumLogLevel} for filtering emitted log entries by threshold
 *
 * @category references
 * @since 4.0.0
 */
export const UnhandledLogLevel: Context.Reference<Severity | undefined> = references.UnhandledLogLevel

/**
 * A captured stack-frame node used to describe the traced execution path.
 *
 * **When to use**
 *
 * Use when reading or supplying the stack-frame chain that Effect tracing uses
 * to attach diagnostic call-site information to failures and interruptions.
 *
 * **Details**
 *
 * Each frame has a span or operation `name`, a lazy `stack` supplier, and an
 * optional `parent` frame that links it to the previous captured frame.
 *
 * @see {@link CurrentStackFrame} for the fiber reference carrying the active stack-frame chain
 *
 * @category references
 * @since 4.0.0
 */
export interface StackFrame {
  readonly name: string
  readonly stack: () => string | undefined
  readonly parent: StackFrame | undefined
}

/**
 * Context reference for the set of loggers currently used by Effect logging
 * operations.
 *
 * **When to use**
 *
 * Use to inspect or provide the complete set of loggers used by Effect logging
 * in the current context.
 *
 * **Details**
 *
 * The default set contains the built-in default logger and tracer logger.
 * Providing this reference changes which `Logger` instances receive log entries
 * in the current context.
 *
 * @category references
 * @since 4.0.0
 */
export const CurrentLoggers: Context.Reference<ReadonlySet<Logger<unknown, any>>> = internalEffect.CurrentLoggers

/**
 * Context reference for controlling whether built-in console loggers write to stderr.
 *
 * **When to use**
 *
 * Use to keep stdout reserved for protocol messages or data output while still
 * allowing Effect runtime logs to be emitted.
 *
 * **Details**
 *
 * The default value is `false`. When set to `true`, the built-in default logger
 * and TTY pretty console logger call `console.error` instead of `console.log`.
 *
 * @category references
 * @since 4.0.0
 */
export const LogToStderr: Context.Reference<boolean> = internalEffect.LogToStderr

export {
  /**
   * Context reference for the current scheduler implementation used by the Effect runtime.
   * Controls how Effects are scheduled and executed.
   *
   * **When to use**
   *
   * Use to provide the scheduler implementation that fibers use in the current
   * context.
   *
   * **Example** (Providing a custom scheduler)
   *
   * ```ts
   * import { Effect, References, Scheduler } from "effect"
   *
   * const customScheduling = Effect.gen(function*() {
   *   // Get current scheduler (default is MixedScheduler)
   *   const current = yield* References.Scheduler
   *   console.log(current) // MixedScheduler instance
   *
   *   // Use a custom scheduler
   *   yield* Effect.provideService(
   *     Effect.gen(function*() {
   *       const scheduler = yield* References.Scheduler
   *       console.log(scheduler) // Custom scheduler instance
   *
   *       // Effects will use the custom scheduler in this context
   *       yield* Effect.log("Using custom scheduler")
   *     }),
   *     References.Scheduler,
   *     new Scheduler.MixedScheduler()
   *   )
   * })
   * ```
   *
   * @category references
   * @since 4.0.0
   */
  Scheduler
} from "./Scheduler.ts"
