/**
 * The `Metric` module provides tools for defining, updating, tagging, and
 * reading application metrics from Effect programs. A `Metric<Input, State>`
 * accepts typed input values and aggregates them into a typed state that can be
 * read directly or exported from a snapshot.
 *
 * **Mental model**
 *
 * - A metric has an identifier, a type, an optional description, optional attributes, and mutable aggregate state
 * - Use counters for cumulative values such as requests, errors, retries, or bytes processed
 * - Use gauges for point-in-time values that can rise or fall, such as active connections or queue size
 * - Use frequencies to count occurrences of discrete string values, such as status codes or action names
 * - Use histograms to bucket numeric observations and inspect count, min, max, and sum
 * - Use summaries to calculate quantiles over a bounded, time-based observation window
 * - Metrics are updated from effects with {@link update} and {@link modify}, and read with {@link value}
 * - Attributes tag metrics with key-value dimensions so the same logical metric can be grouped by service, endpoint, method, or other labels
 * - Snapshots capture the currently registered metrics and their aggregate states for reporting or export
 *
 * **Common tasks**
 *
 * - Create counters: {@link counter}
 * - Create gauges: {@link gauge}
 * - Create frequencies: {@link frequency}
 * - Create histograms: {@link histogram}, {@link linearBoundaries}, {@link exponentialBoundaries}
 * - Create summaries: {@link summary}, {@link summaryWithTimestamp}
 * - Measure effect duration: {@link timer}
 * - Update a metric: {@link update}
 * - Apply relative updates where supported: {@link modify}
 * - Read one metric: {@link value}
 * - Tag a metric: {@link withAttributes}
 * - Transform accepted input values: {@link mapInput}
 * - Record a constant input for repeated events: {@link withConstantInput}
 * - Inspect all registered metrics: {@link snapshot}, {@link dump}
 * - Enable fiber runtime metrics: {@link enableRuntimeMetrics}
 *
 * **Gotchas**
 *
 * - Counter and gauge metrics can use `number` inputs by default or `bigint` inputs with the `bigint` option
 * - Incremental counters ignore negative updates; use non-incremental counters only when decreases are meaningful
 * - {@link update} sets a gauge to an absolute value, while {@link modify} changes it relative to its current value
 * - Histogram buckets are cumulative and depend on the boundaries supplied when the metric is created
 * - Summary quantiles are calculated from the configured sliding window, so old observations expire
 * - Prefer low-cardinality attributes; using unbounded values such as request IDs can create too many metric series
 *
 * **Quickstart**
 *
 * **Example** (Creating and updating metrics)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const requestCount = Metric.counter("http_requests_total", {
 *   description: "Total number of HTTP requests"
 * })
 *
 * const responseTime = Metric.histogram("http_response_time", {
 *   description: "HTTP response time in milliseconds",
 *   boundaries: Metric.linearBoundaries({ start: 0, width: 50, count: 20 })
 * })
 *
 * const handleRequest = Effect.gen(function*() {
 *   yield* Metric.update(
 *     Metric.withAttributes(requestCount, {
 *       endpoint: "/api/users",
 *       method: "GET"
 *     }),
 *     1
 *   )
 *
 *   yield* Metric.update(responseTime, 125)
 *
 *   return yield* Metric.value(requestCount)
 * })
 * ```
 *
 * **See also**
 *
 * - {@link counter} / {@link gauge} / {@link frequency} for common metric types
 * - {@link histogram} / {@link summary} for distribution metrics
 * - {@link update} / {@link modify} / {@link value} for working with metric state
 * - {@link withAttributes} for adding dimensions
 * - {@link snapshot} for exporting all registered metric values
 *
 * @since 2.0.0
 */

import * as Arr from "./Array.ts"
import * as Context from "./Context.ts"
import * as Duration from "./Duration.ts"
import type { Effect } from "./Effect.ts"
import type { Exit } from "./Exit.ts"
import { constUndefined, dual } from "./Function.ts"
import * as InternalEffect from "./internal/effect.ts"
import * as InternalMetric from "./internal/metric.ts"
import * as Layer from "./Layer.ts"
import * as Order from "./Order.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import * as _String from "./String.ts"
import type { Contravariant, Covariant } from "./Types.ts"

/**
 * A `Metric<Input, State>` represents a concurrent metric which accepts update
 * values of type `Input` and are aggregated to a value of type `State`.
 *
 * **Details**
 *
 * For example, a counter metric would have type `Metric<number, number>`,
 * representing the fact that the metric can be updated with numbers (the amount
 * to increment or decrement the counter by), and the state of the counter is a
 * number.
 *
 * There are five primitive metric types supported by Effect:
 *
 *   - Counters
 *   - Frequencies
 *   - Gauges
 *   - Histograms
 *   - Summaries
 *
 * **Example** (Using multiple metric types)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class MetricExample extends Data.TaggedError("MetricExample")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create different types of metrics
 *   const requestCounter: Metric.Counter<number> = Metric.counter("requests", {
 *     description: "Total requests processed"
 *   })
 *
 *   const memoryGauge: Metric.Gauge<number> = Metric.gauge("memory_usage", {
 *     description: "Current memory usage in MB"
 *   })
 *
 *   const statusFrequency: Metric.Frequency = Metric.frequency("status_codes", {
 *     description: "HTTP status code frequency"
 *   })
 *
 *   // All metrics share the same interface for updates and reads
 *   yield* Metric.update(requestCounter, 1)
 *   yield* Metric.update(memoryGauge, 128)
 *   yield* Metric.update(statusFrequency, "200")
 *
 *   // All metrics can be read with Metric.value
 *   const counterState = yield* Metric.value(requestCounter)
 *   const gaugeState = yield* Metric.value(memoryGauge)
 *   const frequencyState = yield* Metric.value(statusFrequency)
 *
 *   // Metrics have common properties accessible through the interface:
 *   // - id: unique identifier
 *   // - type: metric type ("Counter", "Gauge", "Frequency", etc.)
 *   // - description: optional human-readable description
 *   // - attributes: optional key-value attributes for tagging
 *
 *   return {
 *     counter: {
 *       id: requestCounter.id,
 *       type: requestCounter.type,
 *       state: counterState
 *     },
 *     gauge: { id: memoryGauge.id, type: memoryGauge.type, state: gaugeState },
 *     frequency: {
 *       id: statusFrequency.id,
 *       type: statusFrequency.type,
 *       state: frequencyState
 *     }
 *   }
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Metric<in Input, out State> extends Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly Input: Contravariant<Input>
  readonly State: Covariant<State>
  readonly id: string
  readonly type: Metric.Type
  readonly description: string | undefined
  readonly attributes: Metric.AttributeSet | undefined
  readonly valueUnsafe: (context: Context.Context<never>) => State
  readonly updateUnsafe: (input: Input, context: Context.Context<never>) => void
  readonly modifyUnsafe: (input: Input, context: Context.Context<never>) => void
}

/**
 * A Counter metric that tracks cumulative values that typically only increase.
 *
 * **When to use**
 *
 * Use when counters are useful for tracking monotonically increasing values like request counts,
 * bytes processed, errors encountered, or any value that accumulates over time.
 *
 * **Example** (Using counter metrics)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class CounterInterfaceError extends Data.TaggedError("CounterInterfaceError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create different types of counters
 *   const requestCounter: Metric.Counter<number> = Metric.counter(
 *     "http_requests",
 *     {
 *       description: "Total HTTP requests processed",
 *       incremental: true // Only allows increments
 *     }
 *   )
 *
 *   const bytesCounter: Metric.Counter<bigint> = Metric.counter(
 *     "bytes_processed",
 *     {
 *       description: "Total bytes processed",
 *       bigint: true,
 *       attributes: { service: "data-processor" }
 *     }
 *   )
 *
 *   // Update counters
 *   yield* Metric.update(requestCounter, 1) // Increment by 1
 *   yield* Metric.update(requestCounter, 5) // Increment by 5 (total: 6)
 *   yield* Metric.update(bytesCounter, 1024n) // Add 1024 bytes
 *
 *   // Read counter state
 *   const requestState: Metric.CounterState<number> = yield* Metric.value(
 *     requestCounter
 *   )
 *   const bytesState: Metric.CounterState<bigint> = yield* Metric.value(
 *     bytesCounter
 *   )
 *
 *   // Counter state contains:
 *   // - count: current accumulated value
 *   // - incremental: whether only increments are allowed
 *
 *   return {
 *     requests: {
 *       count: requestState.count,
 *       incremental: requestState.incremental
 *     },
 *     bytes: { count: bytesState.count, incremental: bytesState.incremental }
 *   }
 * })
 * ```
 *
 * @category Metrics
 * @since 2.0.0
 */
export interface Counter<in Input extends number | bigint> extends Metric<Input, CounterState<Input>> {}

/**
 * State interface for Counter metrics containing the current count and increment mode.
 *
 * **Example** (Reading counter state)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class CounterStateError extends Data.TaggedError("CounterStateError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create different types of counters
 *   const requestCounter = Metric.counter("http_requests_total")
 *   const errorCounter = Metric.counter("errors_total", { incremental: true })
 *   const byteCounter = Metric.counter("bytes_processed", { bigint: true })
 *
 *   // Update counters
 *   yield* Metric.update(requestCounter, 5) // Add 5 requests
 *   yield* Metric.update(requestCounter, -2) // Subtract 2 (allowed for non-incremental)
 *   yield* Metric.update(errorCounter, 3) // Add 3 errors
 *   yield* Metric.update(errorCounter, -1) // Attempt to subtract (ignored for incremental)
 *   yield* Metric.update(byteCounter, 1024000n) // Add bytes as bigint
 *
 *   // Read counter states
 *   const requestState: Metric.CounterState<number> = yield* Metric.value(
 *     requestCounter
 *   )
 *   const errorState: Metric.CounterState<number> = yield* Metric.value(
 *     errorCounter
 *   )
 *   const byteState: Metric.CounterState<bigint> = yield* Metric.value(
 *     byteCounter
 *   )
 *
 *   // CounterState contains:
 *   // - count: current count value (number or bigint based on counter type)
 *   // - incremental: whether counter only allows increases
 *
 *   return {
 *     requests: {
 *       total: requestState.count, // 3 (5 - 2, decrements allowed)
 *       canDecrease: !requestState.incremental // true
 *     },
 *     errors: {
 *       total: errorState.count, // 3 (subtract ignored)
 *       canDecrease: !errorState.incremental // false
 *     },
 *     bytes: {
 *       total: byteState.count, // 1024000n
 *       canDecrease: !byteState.incremental // true
 *     }
 *   }
 * })
 * ```
 *
 * @category Counter
 * @since 4.0.0
 */
export interface CounterState<in Input extends number | bigint> {
  readonly count: Input extends bigint ? bigint : number
  readonly incremental: boolean
}

/**
 * A Frequency metric interface that counts occurrences of discrete string values.
 *
 * **When to use**
 *
 * Use when frequency metrics are ideal for tracking categorical data where you want to count
 * how many times specific string values occur, such as HTTP status codes, user actions,
 * error types, or any discrete string-based events.
 *
 * **Example** (Using frequency metrics)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class FrequencyInterfaceError
 *   extends Data.TaggedError("FrequencyInterfaceError")<{
 *     readonly operation: string
 *   }>
 * {}
 *
 * // Function that accepts any Frequency metric
 * const logFrequencyMetric = (freq: Metric.Frequency) =>
 *   Effect.gen(function*() {
 *     const state = yield* Metric.value(freq)
 *
 *     yield* Effect.log(`Frequency Metric: ${freq.id}`)
 *     yield* Effect.log(`Description: ${freq.description ?? "No description"}`)
 *     yield* Effect.log(`Type: ${freq.type}`) // "Frequency"
 *
 *     // Access the frequency state
 *     const occurrences: ReadonlyMap<string, number> = state.occurrences
 *     yield* Effect.log(`Total unique values: ${occurrences.size}`)
 *
 *     // Iterate through all occurrences
 *     for (const [value, count] of occurrences) {
 *       yield* Effect.log(`  "${value}": ${count} occurrences`)
 *     }
 *
 *     // Find most frequent value
 *     let maxCount = 0
 *     let mostFrequent = ""
 *     for (const [value, count] of occurrences) {
 *       if (count > maxCount) {
 *         maxCount = count
 *         mostFrequent = value
 *       }
 *     }
 *
 *     return { mostFrequent, maxCount, totalUniqueValues: occurrences.size }
 *   })
 *
 * const program = Effect.gen(function*() {
 *   // Create frequency metrics
 *   const statusCodes: Metric.Frequency = Metric.frequency("http_status", {
 *     description: "HTTP status code frequency"
 *   })
 *
 *   const userActions: Metric.Frequency = Metric.frequency("user_actions", {
 *     description: "User action frequency"
 *   })
 *
 *   // Record some occurrences
 *   yield* Metric.update(statusCodes, "200")
 *   yield* Metric.update(statusCodes, "200")
 *   yield* Metric.update(statusCodes, "404")
 *   yield* Metric.update(statusCodes, "500")
 *   yield* Metric.update(statusCodes, "200")
 *
 *   yield* Metric.update(userActions, "login")
 *   yield* Metric.update(userActions, "view_dashboard")
 *   yield* Metric.update(userActions, "login")
 *
 *   // Use the function with different frequency metrics
 *   const statusAnalysis = yield* logFrequencyMetric(statusCodes)
 *   const actionAnalysis = yield* logFrequencyMetric(userActions)
 *
 *   return { statusAnalysis, actionAnalysis }
 * })
 * ```
 *
 * @category Metrics
 * @since 2.0.0
 */
export interface Frequency extends Metric<string, FrequencyState> {}

/**
 * State interface for Frequency metrics containing occurrence counts for discrete string values.
 *
 * **Example** (Reading frequency state)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class FrequencyStateError extends Data.TaggedError("FrequencyStateError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create frequency metrics for different categories
 *   const statusCodeFreq = Metric.frequency("http_status_codes", {
 *     description: "HTTP status code distribution"
 *   })
 *
 *   const userActionFreq = Metric.frequency("user_actions", {
 *     description: "User action frequency"
 *   })
 *
 *   // Record occurrences
 *   yield* Metric.update(statusCodeFreq, "200") // Success
 *   yield* Metric.update(statusCodeFreq, "200") // Another success
 *   yield* Metric.update(statusCodeFreq, "404") // Not found
 *   yield* Metric.update(statusCodeFreq, "500") // Server error
 *   yield* Metric.update(statusCodeFreq, "200") // Another success
 *
 *   yield* Metric.update(userActionFreq, "login")
 *   yield* Metric.update(userActionFreq, "click")
 *   yield* Metric.update(userActionFreq, "login")
 *   yield* Metric.update(userActionFreq, "scroll")
 *   yield* Metric.update(userActionFreq, "click")
 *   yield* Metric.update(userActionFreq, "click")
 *
 *   // Read frequency states
 *   const statusState: Metric.FrequencyState = yield* Metric.value(statusCodeFreq)
 *   const actionState: Metric.FrequencyState = yield* Metric.value(userActionFreq)
 *
 *   // FrequencyState contains:
 *   // - occurrences: ReadonlyMap<string, number> with string values and their counts
 *
 *   // Analyze frequency distributions
 *   const getMostFrequent = (occurrences: ReadonlyMap<string, number>) => {
 *     let maxKey = ""
 *     let maxCount = 0
 *     for (const [key, count] of occurrences) {
 *       if (count > maxCount) {
 *         maxKey = key
 *         maxCount = count
 *       }
 *     }
 *     return { key: maxKey, count: maxCount }
 *   }
 *
 *   const topStatus = getMostFrequent(statusState.occurrences)
 *   const topAction = getMostFrequent(actionState.occurrences)
 *
 *   return {
 *     statusCodes: {
 *       totalResponses: Array.from(statusState.occurrences.values()).reduce(
 *         (a, b) => a + b,
 *         0
 *       ), // 5
 *       mostCommon: topStatus, // { key: "200", count: 3 }
 *       uniqueCodes: statusState.occurrences.size // 3
 *     },
 *     userActions: {
 *       totalActions: Array.from(actionState.occurrences.values()).reduce(
 *         (a, b) => a + b,
 *         0
 *       ), // 6
 *       mostCommon: topAction, // { key: "click", count: 3 }
 *       uniqueActions: actionState.occurrences.size // 3
 *     }
 *   }
 * })
 * ```
 *
 * @category Metrics
 * @since 4.0.0
 */
export interface FrequencyState {
  readonly occurrences: ReadonlyMap<string, number>
}

/**
 * A Gauge metric that tracks instantaneous values that can go up or down.
 *
 * **When to use**
 *
 * Use when gauges are useful for tracking current state values like memory usage, CPU load,
 * active connections, queue sizes, or any value that represents a current level.
 *
 * **Example** (Using gauge metrics)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class GaugeInterfaceError extends Data.TaggedError("GaugeInterfaceError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create different types of gauges
 *   const memoryGauge: Metric.Gauge<number> = Metric.gauge("memory_usage_mb", {
 *     description: "Current memory usage in megabytes"
 *   })
 *
 *   const diskSpaceGauge: Metric.Gauge<bigint> = Metric.gauge("disk_free_bytes", {
 *     description: "Available disk space in bytes",
 *     bigint: true,
 *     attributes: { mount: "/var" }
 *   })
 *
 *   // Set gauge values (absolute values)
 *   yield* Metric.update(memoryGauge, 512) // Set to 512 MB
 *   yield* Metric.update(memoryGauge, 640) // Set to 640 MB (replaces 512)
 *   yield* Metric.update(diskSpaceGauge, 5000000000n) // Set to ~5GB free
 *
 *   // Modify gauge values (relative changes)
 *   yield* Metric.modify(memoryGauge, 128) // Add 128 MB (total: 768)
 *   yield* Metric.modify(memoryGauge, -64) // Subtract 64 MB (total: 704)
 *
 *   // Read gauge state
 *   const memoryState: Metric.GaugeState<number> = yield* Metric.value(
 *     memoryGauge
 *   )
 *   const diskState: Metric.GaugeState<bigint> = yield* Metric.value(
 *     diskSpaceGauge
 *   )
 *
 *   // Gauge state contains:
 *   // - value: current instantaneous value
 *
 *   return {
 *     memory: { currentValue: memoryState.value }, // 704
 *     disk: { currentValue: diskState.value } // 5000000000n
 *   }
 * })
 * ```
 *
 * @category Metrics
 * @since 2.0.0
 */
export interface Gauge<in Input extends number | bigint> extends Metric<Input, GaugeState<Input>> {}

/**
 * State interface for Gauge metrics containing the current instantaneous value.
 *
 * **Example** (Reading gauge state)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class GaugeStateError extends Data.TaggedError("GaugeStateError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create different types of gauges
 *   const temperatureGauge = Metric.gauge("room_temperature_celsius", {
 *     description: "Current room temperature"
 *   })
 *
 *   const diskSpaceGauge = Metric.gauge("disk_usage_bytes", {
 *     description: "Current disk usage",
 *     bigint: true
 *   })
 *
 *   const queueSizeGauge = Metric.gauge("queue_size", {
 *     description: "Current queue size"
 *   })
 *
 *   // Set gauge values (absolute values)
 *   yield* Metric.update(temperatureGauge, 22.5) // Set to 22.5°C
 *   yield* Metric.update(diskSpaceGauge, 5000000000n) // Set to 5GB usage
 *   yield* Metric.update(queueSizeGauge, 10) // Set to 10 items
 *
 *   // Update gauge values (new absolute values)
 *   yield* Metric.update(temperatureGauge, 23.1) // Temperature changed
 *   yield* Metric.update(queueSizeGauge, 15) // Queue grew
 *
 *   // Read gauge states
 *   const tempState: Metric.GaugeState<number> = yield* Metric.value(
 *     temperatureGauge
 *   )
 *   const diskState: Metric.GaugeState<bigint> = yield* Metric.value(
 *     diskSpaceGauge
 *   )
 *   const queueState: Metric.GaugeState<number> = yield* Metric.value(
 *     queueSizeGauge
 *   )
 *
 *   // GaugeState contains:
 *   // - value: current instantaneous value (number or bigint based on gauge type)
 *
 *   return {
 *     environment: {
 *       temperature: tempState.value, // 23.1
 *       temperatureUnit: "°C"
 *     },
 *     system: {
 *       diskUsage: diskState.value, // 5000000000n
 *       diskUsageGB: Number(diskState.value) / 1_000_000_000, // 5
 *       queueSize: queueState.value // 15
 *     }
 *   }
 * })
 * ```
 *
 * @category Metrics
 * @since 4.0.0
 */
export interface GaugeState<in Input extends number | bigint> {
  readonly value: Input extends bigint ? bigint : number
}

/**
 * A Histogram metric that records observations in configurable buckets to analyze value distributions.
 *
 * **When to use**
 *
 * Use when histograms are ideal for measuring request durations, response sizes, and other continuous values
 * where you need to understand the distribution of values rather than just aggregates.
 *
 * **Example** (Using histogram metrics)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class HistogramInterfaceError
 *   extends Data.TaggedError("HistogramInterfaceError")<{
 *     readonly operation: string
 *   }>
 * {}
 *
 * const program = Effect.gen(function*() {
 *   // Create histograms with different boundary strategies
 *   const responseTimeHistogram: Metric.Histogram<number> = Metric.histogram(
 *     "http_response_time_ms",
 *     {
 *       description: "HTTP response time distribution in milliseconds",
 *       boundaries: Metric.linearBoundaries({ start: 0, width: 50, count: 20 }) // 0, 50, 100, ..., 950
 *     }
 *   )
 *
 *   const fileSizeHistogram: Metric.Histogram<number> = Metric.histogram(
 *     "file_size_bytes",
 *     {
 *       description: "File size distribution in bytes",
 *       boundaries: Metric.exponentialBoundaries({
 *         start: 1,
 *         factor: 2,
 *         count: 10
 *       }) // 1, 2, 4, 8, ..., 512
 *     }
 *   )
 *
 *   // Record observations (values get placed into appropriate buckets)
 *   yield* Metric.update(responseTimeHistogram, 125) // Goes into 100-150ms bucket
 *   yield* Metric.update(responseTimeHistogram, 75) // Goes into 50-100ms bucket
 *   yield* Metric.update(responseTimeHistogram, 200) // Goes into 150-200ms bucket
 *   yield* Metric.update(responseTimeHistogram, 45) // Goes into 0-50ms bucket
 *
 *   yield* Metric.update(fileSizeHistogram, 3) // Goes into 2-4 bytes bucket
 *   yield* Metric.update(fileSizeHistogram, 15) // Goes into 8-16 bytes bucket
 *   yield* Metric.update(fileSizeHistogram, 100) // Goes into 64-128 bytes bucket
 *
 *   // Read histogram state
 *   const responseTimeState: Metric.HistogramState = yield* Metric.value(
 *     responseTimeHistogram
 *   )
 *   const fileSizeState: Metric.HistogramState = yield* Metric.value(
 *     fileSizeHistogram
 *   )
 *
 *   // Histogram state contains:
 *   // - buckets: Array of [boundary, cumulativeCount] pairs
 *   // - count: total number of observations
 *   // - min: smallest observed value
 *   // - max: largest observed value
 *   // - sum: sum of all observed values
 *
 *   return {
 *     responseTime: {
 *       totalRequests: responseTimeState.count, // 4
 *       fastestRequest: responseTimeState.min, // 45
 *       slowestRequest: responseTimeState.max, // 200
 *       totalTime: responseTimeState.sum, // 445
 *       averageTime: responseTimeState.sum / responseTimeState.count // 111.25
 *     },
 *     fileSize: {
 *       totalFiles: fileSizeState.count, // 3
 *       smallestFile: fileSizeState.min, // 3
 *       largestFile: fileSizeState.max, // 100
 *       totalBytes: fileSizeState.sum // 118
 *     }
 *   }
 * })
 * ```
 *
 * @category Metrics
 * @since 2.0.0
 */
export interface Histogram<Input> extends Metric<Input, HistogramState> {}

/**
 * State interface for Histogram metrics containing bucket distributions and aggregate statistics.
 *
 * **Example** (Reading histogram state)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class HistogramStateError extends Data.TaggedError("HistogramStateError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create histogram with linear boundaries
 *   const responseTimeHistogram = Metric.histogram("api_response_time_ms", {
 *     description: "API response time distribution",
 *     boundaries: Metric.linearBoundaries({ start: 0, width: 100, count: 10 }) // 0, 100, 200, ..., 900
 *   })
 *
 *   // Record observations
 *   yield* Metric.update(responseTimeHistogram, 50) // Fast response
 *   yield* Metric.update(responseTimeHistogram, 150) // Average response
 *   yield* Metric.update(responseTimeHistogram, 750) // Slow response
 *   yield* Metric.update(responseTimeHistogram, 250) // Average response
 *   yield* Metric.update(responseTimeHistogram, 95) // Fast response
 *
 *   // Read histogram state
 *   const state: Metric.HistogramState = yield* Metric.value(
 *     responseTimeHistogram
 *   )
 *
 *   // HistogramState contains:
 *   // - buckets: Array of [boundary, cumulativeCount] pairs showing distribution
 *   // - count: total number of observations
 *   // - min: smallest observed value
 *   // - max: largest observed value
 *   // - sum: sum of all observed values
 *
 *   // Analyze bucket distribution
 *   const analyzeBuckets = (buckets: ReadonlyArray<[number, number]>) => {
 *     const analysis: Array<
 *       { range: string; count: number; percentage: number }
 *     > = []
 *     let previousCount = 0
 *     const totalCount = buckets[buckets.length - 1]?.[1] ?? 0
 *
 *     for (let i = 0; i < buckets.length; i++) {
 *       const [boundary, cumulativeCount] = buckets[i]
 *       const bucketCount = cumulativeCount - previousCount
 *       const percentage = totalCount > 0 ? (bucketCount / totalCount) * 100 : 0
 *       const prevBoundary = i === 0 ? 0 : buckets[i - 1][0]
 *
 *       analysis.push({
 *         range: `${prevBoundary}-${boundary}ms`,
 *         count: bucketCount,
 *         percentage: Math.round(percentage * 10) / 10
 *       })
 *       previousCount = cumulativeCount
 *     }
 *     return analysis
 *   }
 *
 *   const bucketAnalysis = analyzeBuckets(state.buckets)
 *
 *   return {
 *     responseTime: {
 *       totalRequests: state.count, // 5
 *       fastestResponse: state.min, // 50
 *       slowestResponse: state.max, // 750
 *       averageResponse: state.sum / state.count, // 268
 *       totalTime: state.sum, // 1340
 *       distribution: bucketAnalysis
 *       // Example distribution:
 *       // [{ range: "0-100ms", count: 2, percentage: 40.0 },
 *       //  { range: "100-200ms", count: 1, percentage: 20.0 },
 *       //  { range: "200-300ms", count: 1, percentage: 20.0 },
 *       //  { range: "700-800ms", count: 1, percentage: 20.0 }]
 *     }
 *   }
 * })
 * ```
 *
 * @category Metrics
 * @since 4.0.0
 */
export interface HistogramState {
  readonly buckets: ReadonlyArray<[number, number]>
  readonly count: number
  readonly min: number
  readonly max: number
  readonly sum: number
}

/**
 * A Summary metric that calculates quantiles over a sliding time window of observations.
 *
 * **When to use**
 *
 * Use when summaries provide statistical insights into value distributions by tracking specific quantiles
 * (percentiles) such as median (50th), 95th percentile, 99th percentile, etc. They're ideal for
 * understanding performance characteristics like response time distributions.
 *
 * **Example** (Using summary metrics)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class SummaryInterfaceError extends Data.TaggedError("SummaryInterfaceError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create summaries with different quantile configurations
 *   const responseTimeSummary: Metric.Summary<number> = Metric.summary(
 *     "api_response_time_ms",
 *     {
 *       description: "API response time distribution in milliseconds",
 *       maxAge: "5 minutes", // Keep observations for 5 minutes
 *       maxSize: 1000, // Keep up to 1000 observations
 *       quantiles: [0.5, 0.95, 0.99] // Track median, 95th, and 99th percentiles
 *     }
 *   )
 *
 *   const requestSizeSummary: Metric.Summary<number> = Metric.summary(
 *     "request_size_bytes",
 *     {
 *       description: "Request payload size distribution",
 *       maxAge: "10 minutes",
 *       maxSize: 500,
 *       quantiles: [0.25, 0.5, 0.75, 0.9] // Track quartiles and 90th percentile
 *     }
 *   )
 *
 *   // Record observations (values are stored in time-based sliding window)
 *   yield* Metric.update(responseTimeSummary, 120) // Fast response
 *   yield* Metric.update(responseTimeSummary, 250) // Average response
 *   yield* Metric.update(responseTimeSummary, 45) // Very fast response
 *   yield* Metric.update(responseTimeSummary, 890) // Slow response
 *   yield* Metric.update(responseTimeSummary, 156) // Average response
 *
 *   yield* Metric.update(requestSizeSummary, 1024) // 1KB request
 *   yield* Metric.update(requestSizeSummary, 512) // 512B request
 *   yield* Metric.update(requestSizeSummary, 2048) // 2KB request
 *
 *   // Read summary state
 *   const responseTimeState: Metric.SummaryState = yield* Metric.value(
 *     responseTimeSummary
 *   )
 *   const requestSizeState: Metric.SummaryState = yield* Metric.value(
 *     requestSizeSummary
 *   )
 *
 *   // Summary state contains:
 *   // - quantiles: Array of [quantile, optionalValue] pairs
 *   // - count: total number of observations in window
 *   // - min: smallest observed value in window
 *   // - max: largest observed value in window
 *   // - sum: sum of all observed values in window
 *
 *   // Extract quantile values safely
 *   const getQuantileValue = (
 *     quantiles: ReadonlyArray<readonly [number, number | undefined]>,
 *     q: number
 *   ) => quantiles.find(([quantile]) => quantile === q)?.[1]
 *
 *   const median = getQuantileValue(responseTimeState.quantiles, 0.5)
 *   const p95 = getQuantileValue(responseTimeState.quantiles, 0.95)
 *   const p99 = getQuantileValue(responseTimeState.quantiles, 0.99)
 *
 *   return {
 *     responseTime: {
 *       totalRequests: responseTimeState.count, // 5
 *       fastestResponse: responseTimeState.min, // 45
 *       slowestResponse: responseTimeState.max, // 890
 *       totalTime: responseTimeState.sum, // 1461
 *       averageTime: responseTimeState.sum / responseTimeState.count, // 292.2
 *       medianTime: median ?? null, // ~156
 *       p95Time: p95 ?? null, // ~890
 *       p99Time: p99 ?? null // ~890
 *     },
 *     requestSize: {
 *       totalRequests: requestSizeState.count, // 3
 *       averageSize: requestSizeState.sum / requestSizeState.count // ~1194.7
 *     }
 *   }
 * })
 * ```
 *
 * @category Metrics
 * @since 2.0.0
 */
export interface Summary<Input> extends Metric<Input, SummaryState> {}

/**
 * State interface for Summary metrics containing quantile calculations and aggregate statistics.
 *
 * **Example** (Reading summary state)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class SummaryStateError extends Data.TaggedError("SummaryStateError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create summary with specific quantiles
 *   const responseTimeSummary = Metric.summary("api_response_latency", {
 *     description: "API response time distribution with quantiles",
 *     maxAge: "5 minutes",
 *     maxSize: 1000,
 *     quantiles: [0.5, 0.95, 0.99] // Track median, 95th, and 99th percentiles
 *   })
 *
 *   // Record observations over time
 *   yield* Metric.update(responseTimeSummary, 120) // Fast response
 *   yield* Metric.update(responseTimeSummary, 250) // Average response
 *   yield* Metric.update(responseTimeSummary, 45) // Very fast response
 *   yield* Metric.update(responseTimeSummary, 890) // Slow response
 *   yield* Metric.update(responseTimeSummary, 156) // Average response
 *   yield* Metric.update(responseTimeSummary, 78) // Fast response
 *   yield* Metric.update(responseTimeSummary, 340) // Slower response
 *
 *   // Read summary state
 *   const state: Metric.SummaryState = yield* Metric.value(responseTimeSummary)
 *
 *   // SummaryState contains:
 *   // - quantiles: Array of [quantile, optionalValue] pairs showing percentile values
 *   // - count: total number of observations in current window
 *   // - min: smallest observed value in window
 *   // - max: largest observed value in window
 *   // - sum: sum of all observed values in window
 *
 *   // Extract quantile information safely
 *   const extractQuantiles = (
 *     quantiles: ReadonlyArray<readonly [number, number | undefined]>
 *   ) => {
 *     const result: Record<string, number | null> = {}
 *     for (const [quantile, valueOption] of quantiles) {
 *       const percentile = Math.round(quantile * 100)
 *       result[`p${percentile}`] = valueOption ?? null
 *     }
 *     return result
 *   }
 *
 *   const quantileValues = extractQuantiles(state.quantiles)
 *
 *   return {
 *     latencyAnalysis: {
 *       totalRequests: state.count, // 7
 *       fastestResponse: state.min, // 45
 *       slowestResponse: state.max, // 890
 *       averageResponse: state.sum / state.count, // ~268.4
 *       totalLatency: state.sum, // 1879
 *       percentiles: quantileValues,
 *       // Example percentiles:
 *       // { p50: 156, p95: 890, p99: 890 }
 *       performance: {
 *         fast: quantileValues.p50 !== null && quantileValues.p50 < 200
 *           ? "Good"
 *           : "Needs improvement",
 *         reliability: quantileValues.p95 !== null && quantileValues.p95 < 500
 *           ? "Reliable"
 *           : "Concerning"
 *       }
 *     }
 *   }
 * })
 * ```
 *
 * @category Metrics
 * @since 4.0.0
 */
export interface SummaryState {
  readonly quantiles: ReadonlyArray<readonly [number, number | undefined]>
  readonly count: number
  readonly min: number
  readonly max: number
  readonly sum: number
}

/**
 * The `Metric` namespace provides a comprehensive system for collecting, aggregating, and observing
 * application metrics in Effect applications.
 *
 * **Example** (Collecting application metrics)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class MetricsError extends Data.TaggedError("MetricsError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create different types of metrics
 *   const requestCounter = Metric.counter("http_requests_total")
 *   const responseTimeHistogram = Metric.histogram("http_response_time", {
 *     boundaries: Metric.linearBoundaries({ start: 0, width: 10, count: 10 })
 *   })
 *   const activeConnectionsGauge = Metric.gauge("active_connections")
 *   const statusFrequency = Metric.frequency("http_status_codes")
 *
 *   // Update metrics
 *   yield* Metric.update(requestCounter, 1)
 *   yield* Metric.update(responseTimeHistogram, 45.2)
 *   yield* Metric.update(activeConnectionsGauge, 12)
 *   yield* Metric.update(statusFrequency, "200")
 *
 *   // Get metric values
 *   const counterValue = yield* Metric.value(requestCounter)
 *   const histogramValue = yield* Metric.value(responseTimeHistogram)
 *   const gaugeValue = yield* Metric.value(activeConnectionsGauge)
 *   const frequencyValue = yield* Metric.value(statusFrequency)
 *
 *   return {
 *     counter: counterValue,
 *     histogram: histogramValue,
 *     gauge: gaugeValue,
 *     frequency: frequencyValue
 *   }
 * })
 * ```
 *
 * @since 2.0.0
 */
export declare namespace Metric {
  /**
   * Union type representing all available metric types in the Effect metrics system.
   *
   * **Example** (Inspecting metric types)
   *
   * ```ts
   * import { Data, Effect, Metric } from "effect"
   *
   * class MetricTypeError extends Data.TaggedError("MetricTypeError")<{
   *   readonly operation: string
   * }> {}
   *
   * const program = Effect.gen(function*() {
   *   // Create different metric types
   *   const counter = Metric.counter("requests_total")
   *   const gauge = Metric.gauge("cpu_usage")
   *   const frequency = Metric.frequency("status_codes")
   *   const histogram = Metric.histogram("response_time", {
   *     boundaries: Metric.linearBoundaries({ start: 0, width: 50, count: 10 })
   *   })
   *   const summary = Metric.summary("latency", {
   *     maxAge: "5 minutes",
   *     maxSize: 1000,
   *     quantiles: [0.5, 0.95, 0.99]
   *   })
   *
   *   // Function that checks metric type
   *   const getMetricInfo = (metric: Metric.Metric<any, any>) => ({
   *     name: metric.id,
   *     type: metric.type
   *   })
   *
   *   // Get type information for each metric
   *   const counterInfo = getMetricInfo(counter) // { name: "requests_total", type: "Counter" }
   *   const gaugeInfo = getMetricInfo(gauge) // { name: "cpu_usage", type: "Gauge" }
   *   const frequencyInfo = getMetricInfo(frequency) // { name: "status_codes", type: "Frequency" }
   *   const histogramInfo = getMetricInfo(histogram) // { name: "response_time", type: "Histogram" }
   *   const summaryInfo = getMetricInfo(summary) // { name: "latency", type: "Summary" }
   *
   *   // Pattern match on metric type
   *   const describeMetric = (type: string): string => {
   *     switch (type) {
   *       case "Counter":
   *         return "Cumulative values that increase over time"
   *       case "Gauge":
   *         return "Instantaneous values that can go up or down"
   *       case "Frequency":
   *         return "Counts of discrete string occurrences"
   *       case "Histogram":
   *         return "Distribution of values across buckets"
   *       case "Summary":
   *         return "Quantile calculations over time windows"
   *       default:
   *         return "Unknown metric type"
   *     }
   *   }
   *
   *   return {
   *     metrics: [
   *       counterInfo,
   *       gaugeInfo,
   *       frequencyInfo,
   *       histogramInfo,
   *       summaryInfo
   *     ],
   *     descriptions: {
   *       Counter: describeMetric("Counter"),
   *       Gauge: describeMetric("Gauge"),
   *       Frequency: describeMetric("Frequency"),
   *       Histogram: describeMetric("Histogram"),
   *       Summary: describeMetric("Summary")
   *     }
   *   }
   * })
   * ```
   *
   * @category types
   * @since 4.0.0
   */
  export type Type = "Counter" | "Frequency" | "Gauge" | "Histogram" | "Summary"

  /**
   * Union type for metric attributes that can be provided as either an object or array of tuples.
   *
   * **Example** (Providing attributes in different formats)
   *
   * ```ts
   * import { Data, Effect, Metric } from "effect"
   *
   * class AttributesError extends Data.TaggedError("AttributesError")<{
   *   readonly operation: string
   * }> {}
   *
   * const program = Effect.gen(function*() {
   *   // Different ways to specify attributes
   *   const attributesAsObject = {
   *     service: "api",
   *     environment: "production",
   *     version: "1.2.3"
   *   }
   *
   *   const attributesAsArray: ReadonlyArray<[string, string]> = [
   *     ["service", "api"],
   *     ["environment", "production"],
   *     ["version", "1.2.3"]
   *   ]
   *
   *   // Create metrics with different attribute formats
   *   const requestCounter1 = Metric.counter("requests", {
   *     description: "Total requests",
   *     attributes: attributesAsObject // Using object format
   *   })
   *
   *   const requestCounter2 = Metric.counter("requests", {
   *     description: "Total requests",
   *     attributes: attributesAsArray // Using array format
   *   })
   *
   *   // Function to normalize attributes to object format
   *   const normalizeAttributes = (
   *     attrs: typeof attributesAsObject | ReadonlyArray<[string, string]>
   *   ) => {
   *     if (Array.isArray(attrs)) {
   *       return Object.fromEntries(attrs)
   *     }
   *     return attrs
   *   }
   *
   *   // Add runtime attributes using withAttributes
   *   const contextualCounter = Metric.withAttributes(requestCounter1, {
   *     method: "GET",
   *     endpoint: "/api/users"
   *   })
   *
   *   // Update metrics with different attribute combinations
   *   yield* Metric.update(contextualCounter, 1)
   *
   *   // Both formats result in the same internal representation
   *   const normalizedObject = normalizeAttributes(attributesAsObject)
   *   const normalizedArray = normalizeAttributes(attributesAsArray)
   *
   *   return {
   *     attributeFormats: {
   *       object: normalizedObject, // { service: "api", environment: "production", version: "1.2.3" }
   *       array: normalizedArray, // { service: "api", environment: "production", version: "1.2.3" }
   *       areEqual:
   *         JSON.stringify(normalizedObject) === JSON.stringify(normalizedArray) // true
   *     }
   *   }
   * })
   * ```
   *
   * @category types
   * @since 4.0.0
   */
  export type Attributes = AttributeSet | ReadonlyArray<[string, string]>

  /**
   * Type for metric attributes as a readonly record of string key-value pairs.
   *
   * **Example** (Combining metric attribute sets)
   *
   * ```ts
   * import { Data, Effect, Metric } from "effect"
   *
   * class AttributeSetError extends Data.TaggedError("AttributeSetError")<{
   *   readonly operation: string
   * }> {}
   *
   * const program = Effect.gen(function*() {
   *   // Define attribute sets for different contexts
   *   const serviceAttributes = {
   *     service: "user-api",
   *     version: "2.1.0",
   *     environment: "production"
   *   }
   *
   *   const operationAttributes = {
   *     operation: "create_user",
   *     method: "POST",
   *     endpoint: "/api/users"
   *   }
   *
   *   const infrastructureAttributes = {
   *     region: "us-east-1",
   *     datacenter: "dc1",
   *     host: "api-server-01"
   *   }
   *
   *   // Create metrics with predefined attribute sets
   *   const requestCounter = Metric.counter("http_requests_total", {
   *     description: "Total HTTP requests",
   *     attributes: serviceAttributes
   *   })
   *
   *   // Combine attribute sets
   *   const combineAttributes = (...attributeSets: Array<Record<string, string>>) =>
   *     Object.assign({}, ...attributeSets)
   *
   *   const fullAttributes = combineAttributes(
   *     serviceAttributes,
   *     operationAttributes,
   *     infrastructureAttributes
   *   )
   *
   *   // Create metric with combined attributes
   *   const detailedCounter = Metric.withAttributes(requestCounter, fullAttributes)
   *
   *   // Helper to validate attribute keys (all must be strings)
   *   const validateAttributeSet = (attrs: Record<string, string>): boolean => {
   *     return Object.entries(attrs).every(([key, value]) =>
   *       typeof key === "string" && typeof value === "string"
   *     )
   *   }
   *
   *   yield* Metric.update(detailedCounter, 1)
   *
   *   return {
   *     attributes: {
   *       service: serviceAttributes,
   *       operation: operationAttributes,
   *       infrastructure: infrastructureAttributes,
   *       combined: fullAttributes,
   *       isValid: validateAttributeSet(fullAttributes), // true
   *       totalKeys: Object.keys(fullAttributes).length // 9
   *     }
   *   }
   * })
   * ```
   *
   * @category types
   * @since 4.0.0
   */
  export type AttributeSet = Readonly<Record<string, string>>

  /**
   * Utility type to extract the Input type from a Metric type.
   *
   * **Example** (Extracting metric input types)
   *
   * ```ts
   * import { Metric } from "effect"
   *
   * // Create various metric types
   * const numberCounter = Metric.counter("requests")
   * const bigintCounter = Metric.counter("bytes", { bigint: true })
   * const stringFrequency = Metric.frequency("status_codes")
   * const numberGauge = Metric.gauge("cpu_usage")
   * const numberHistogram = Metric.histogram("response_time", {
   *   boundaries: Metric.linearBoundaries({ start: 0, width: 50, count: 10 })
   * })
   *
   * // The Input utility type extracts the input type from metric types:
   * // - Counter<number>: number
   * // - Counter<bigint>: bigint
   * // - Frequency: string
   * // - Gauge<number>: number
   * // - Histogram<number>: number
   *
   * // Helper function that works with any metric
   * const createMetricInfo = (metric: Metric.Metric<any, any>) => ({
   *   id: metric.id,
   *   type: metric.type
   * })
   *
   * const metrics = [
   *   createMetricInfo(numberCounter), // { id: "requests", type: "Counter" }
   *   createMetricInfo(bigintCounter), // { id: "bytes", type: "Counter" }
   *   createMetricInfo(stringFrequency), // { id: "status_codes", type: "Frequency" }
   *   createMetricInfo(numberGauge), // { id: "cpu_usage", type: "Gauge" }
   *   createMetricInfo(numberHistogram) // { id: "response_time", type: "Histogram" }
   * ]
   *
   * // Type safety is enforced at compile time:
   * // Metric.update(numberCounter, 123)     // ✓ Valid (number)
   * // Metric.update(numberCounter, "abc")   // ✗ Type error
   * // Metric.update(stringFrequency, "ok")  // ✓ Valid (string)
   * // Metric.update(stringFrequency, 404)   // ✗ Type error
   * ```
   *
   * @category types
   * @since 4.0.0
   */
  export type Input<A> = A extends Metric<infer _Input, infer _State> ? _Input
    : never

  /**
   * Utility type to extract the State type from a Metric type.
   *
   * **Example** (Extracting metric state types)
   *
   * ```ts
   * import { Effect, Metric } from "effect"
   *
   * // Create various metric types
   * const requestCounter = Metric.counter("requests")
   * const cpuGauge = Metric.gauge("cpu_usage")
   * const statusFrequency = Metric.frequency("status_codes")
   * const responseHistogram = Metric.histogram("response_time", {
   *   boundaries: Metric.linearBoundaries({ start: 0, width: 50, count: 10 })
   * })
   * const latencySummary = Metric.summary("latency", {
   *   maxAge: "5 minutes",
   *   maxSize: 1000,
   *   quantiles: [0.5, 0.95, 0.99]
   * })
   *
   * // The State utility type extracts the state type from metric types:
   * // - Counter<number>: CounterState<number>
   * // - Gauge<number>: GaugeState<number>
   * // - Frequency: FrequencyState
   * // - Histogram<number>: HistogramState
   * // - Summary<number>: SummaryState
   *
   * // Type-safe state analysis functions
   * const program = Effect.gen(function*() {
   *   // Update metrics first
   *   yield* Metric.update(requestCounter, 10)
   *   yield* Metric.update(cpuGauge, 85.5)
   *   yield* Metric.update(statusFrequency, "200")
   *   yield* Metric.update(responseHistogram, 150)
   *   yield* Metric.update(latencySummary, 120)
   *
   *   // Extract states with proper typing
   *   const counterState = yield* Metric.value(requestCounter)
   *   const gaugeState = yield* Metric.value(cpuGauge)
   *   const frequencyState = yield* Metric.value(statusFrequency)
   *   const histogramState = yield* Metric.value(responseHistogram)
   *   const summaryState = yield* Metric.value(latencySummary)
   *
   *   return {
   *     counter: { count: counterState.count }, // { count: 10 }
   *     gauge: { value: gaugeState.value }, // { value: 85.5 }
   *     frequency: { uniqueValues: frequencyState.occurrences.size }, // { uniqueValues: 1 }
   *     histogram: { totalObservations: histogramState.count }, // { totalObservations: 1 }
   *     summary: { observations: summaryState.count } // { observations: 1 }
   *   }
   * })
   * ```
   *
   * @category types
   * @since 4.0.0
   */
  export type State<A> = A extends Metric<infer _Input, infer _State> ? _State
    : never

  /**
   * Interface defining the core hooks for metric operations: get, update, and modify.
   *
   * **Example** (Using metric hooks)
   *
   * ```ts
   * import { Data, Effect, Metric } from "effect"
   *
   * class HooksError extends Data.TaggedError("HooksError")<{
   *   readonly operation: string
   * }> {}
   *
   * const program = Effect.gen(function*() {
   *   // Create a counter metric
   *   const requestCounter = Metric.counter("requests_total", {
   *     description: "Total number of requests"
   *   })
   *
   *   // The Hooks interface provides three core operations for metrics:
   *   // 1. get: retrieve current state
   *   // 2. update: add/set a value
   *   // 3. modify: transform the current state
   *
   *   // These are low-level APIs. Most users should use high-level APIs:
   *   // - Metric.value() for getting state
   *   // - Metric.update() for updating values
   *   // - Metric.modify() for modifying values
   *
   *   // Example using high-level APIs (recommended)
   *   yield* Metric.update(requestCounter, 1)
   *   yield* Metric.update(requestCounter, 5)
   *   const state = yield* Metric.value(requestCounter)
   *
   *   return {
   *     currentCount: state.count, // 6
   *     isIncremental: state.incremental // false
   *   }
   * })
   * ```
   *
   * @category interfaces
   * @since 4.0.0
   */
  export interface Hooks<in Input, out State> {
    readonly get: (context: Context.Context<never>) => State
    readonly update: (input: Input, context: Context.Context<never>) => void
    readonly modify: (input: Input, context: Context.Context<never>) => void
  }

  /**
   * Interface containing complete metadata information about a metric.
   *
   * **Example** (Inspecting metric metadata)
   *
   * ```ts
   * import { Data, Effect, Metric } from "effect"
   *
   * class MetadataError extends Data.TaggedError("MetadataError")<{
   *   readonly operation: string
   * }> {}
   *
   * const program = Effect.gen(function*() {
   *   // Create metrics with different configurations
   *   const requestCounter = Metric.counter("http_requests_total", {
   *     description: "Total number of HTTP requests",
   *     attributes: { service: "api", version: "1.0" }
   *   })
   *
   *   const memoryGauge = Metric.gauge("memory_usage_bytes", {
   *     description: "Current memory usage in bytes"
   *   })
   *
   *   const statusFrequency = Metric.frequency("http_status_codes")
   *
   *   // The Metadata interface contains complete information about a metric:
   *   // - id: metric identifier
   *   // - type: metric type ("Counter", "Gauge", etc.)
   *   // - description: optional description
   *   // - attributes: optional key-value attributes
   *   // - hooks: low-level operations interface
   *
   *   // Each metric has associated metadata that can be inspected
   *   yield* Metric.update(requestCounter, 10)
   *   yield* Metric.update(memoryGauge, 256000000)
   *   yield* Metric.update(statusFrequency, "200")
   *
   *   return {
   *     counter: {
   *       id: requestCounter.id, // "http_requests_total"
   *       type: requestCounter.type, // "Counter"
   *       description: requestCounter.description // "Total number of HTTP requests"
   *     },
   *     gauge: {
   *       id: memoryGauge.id, // "memory_usage_bytes"
   *       type: memoryGauge.type, // "Gauge"
   *       description: memoryGauge.description // "Current memory usage in bytes"
   *     },
   *     frequency: {
   *       id: statusFrequency.id, // "http_status_codes"
   *       type: statusFrequency.type, // "Frequency"
   *       description: statusFrequency.description // undefined
   *     }
   *   }
   * })
   * ```
   *
   * @category interfaces
   * @since 4.0.0
   */
  export interface Metadata<in Input, out State> {
    readonly id: string
    readonly type: Type
    readonly description: string | undefined
    readonly attributes: Metric.AttributeSet | undefined
    readonly hooks: Hooks<Input, State>
  }

  /**
   * Protocol interface for metric snapshots containing metadata and current state.
   *
   * **Example** (Inspecting metric snapshot protocols)
   *
   * ```ts
   * import { Data, Effect, Metric } from "effect"
   *
   * class SnapshotProtoError extends Data.TaggedError("SnapshotProtoError")<{
   *   readonly operation: string
   * }> {}
   *
   * const program = Effect.gen(function*() {
   *   // Create and update metrics
   *   const requestCounter = Metric.counter("requests", {
   *     description: "Request count",
   *     attributes: { service: "api" }
   *   })
   *
   *   const responseTimeHistogram = Metric.histogram("response_time", {
   *     description: "Response time distribution",
   *     boundaries: Metric.linearBoundaries({ start: 0, width: 50, count: 10 })
   *   })
   *
   *   yield* Metric.update(requestCounter, 25)
   *   yield* Metric.update(responseTimeHistogram, 150)
   *   yield* Metric.update(responseTimeHistogram, 75)
   *
   *   // Take snapshot of all metrics
   *   const snapshots = yield* Metric.snapshot
   *
   *   // Each snapshot follows the SnapshotProto interface:
   *   // - id: metric identifier
   *   // - type: specific metric type
   *   // - description: optional description
   *   // - attributes: optional attributes
   *   // - state: current metric state
   *
   *   const counterSnapshot = snapshots.find((s) => s.id === "requests")
   *   const histogramSnapshot = snapshots.find((s) => s.id === "response_time")
   *
   *   return {
   *     counter: counterSnapshot ?
   *       {
   *         id: counterSnapshot.id, // "requests"
   *         type: counterSnapshot.type, // "Counter"
   *         description: counterSnapshot.description, // "Request count"
   *         hasAttributes: counterSnapshot.attributes !== undefined, // true
   *         count: (counterSnapshot.state as any).count // 25
   *       } :
   *       null,
   *     histogram: histogramSnapshot ?
   *       {
   *         id: histogramSnapshot.id, // "response_time"
   *         type: histogramSnapshot.type, // "Histogram"
   *         observations: (histogramSnapshot.state as any).count // 2
   *       } :
   *       null
   *   }
   * })
   * ```
   *
   * @category interfaces
   * @since 4.0.0
   */
  export interface SnapshotProto<T extends Type, State> {
    readonly id: string
    readonly type: T
    readonly description: string | undefined
    readonly attributes: Metric.AttributeSet | undefined
    readonly state: State
  }

  /**
   * Union type representing all possible metric snapshot types with their corresponding states.
   *
   * **Example** (Analyzing metric snapshots)
   *
   * ```ts
   * import { Data, Effect, Metric } from "effect"
   *
   * class SnapshotError extends Data.TaggedError("SnapshotError")<{
   *   readonly operation: string
   * }> {}
   *
   * const program = Effect.gen(function*() {
   *   // Create different types of metrics
   *   const requestCounter = Metric.counter("requests_total")
   *   const cpuGauge = Metric.gauge("cpu_usage_percent")
   *   const statusFrequency = Metric.frequency("http_status")
   *   const responseHistogram = Metric.histogram("response_time_ms", {
   *     boundaries: Metric.linearBoundaries({ start: 0, width: 100, count: 10 })
   *   })
   *   const latencySummary = Metric.summary("request_latency", {
   *     maxAge: "1 minute",
   *     maxSize: 100,
   *     quantiles: [0.5, 0.95, 0.99]
   *   })
   *
   *   // Update all metrics
   *   yield* Metric.update(requestCounter, 150)
   *   yield* Metric.update(cpuGauge, 45.7)
   *   yield* Metric.update(statusFrequency, "200")
   *   yield* Metric.update(statusFrequency, "404")
   *   yield* Metric.update(responseHistogram, 250)
   *   yield* Metric.update(latencySummary, 120)
   *
   *   // Take snapshot of all metrics
   *   const allSnapshots = yield* Metric.snapshot
   *
   *   // Type-safe snapshot analysis using discriminated union
   *   const analyzeSnapshot = (snapshot: any) => {
   *     switch (snapshot.type) {
   *       case "Counter":
   *         return { type: "Counter", count: snapshot.state.count }
   *       case "Gauge":
   *         return { type: "Gauge", value: snapshot.state.value }
   *       case "Frequency":
   *         return {
   *           type: "Frequency",
   *           uniqueValues: snapshot.state.occurrences.size
   *         }
   *       case "Histogram":
   *         return { type: "Histogram", observations: snapshot.state.count }
   *       case "Summary":
   *         return { type: "Summary", observations: snapshot.state.count }
   *     }
   *   }
   *
   *   const analysis = allSnapshots.map(analyzeSnapshot)
   *
   *   return {
   *     totalMetrics: allSnapshots.length, // 5
   *     metricTypes: allSnapshots.map((s) => s.type), // ["Counter", "Gauge", "Frequency", "Histogram", "Summary"]
   *     analysis
   *   }
   * })
   * ```
   *
   * @category types
   * @since 4.0.0
   */
  export type Snapshot =
    | SnapshotProto<"Counter", CounterState<number | bigint>>
    | SnapshotProto<"Gauge", GaugeState<number | bigint>>
    | SnapshotProto<"Frequency", FrequencyState>
    | SnapshotProto<"Histogram", HistogramState>
    | SnapshotProto<"Summary", SummaryState>
}

/**
 * Service key for the current metric attributes context.
 *
 * **Example** (Using the current attributes key)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class AttributesKeyError extends Data.TaggedError("AttributesKeyError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // The key is used internally by the Effect runtime to manage metric attributes
 *   const key = Metric.CurrentMetricAttributesKey
 *
 *   // Create metrics with base attributes
 *   const requestCounter = Metric.counter("requests_total", {
 *     description: "Total HTTP requests"
 *   })
 *
 *   // The CurrentMetricAttributes service provides default attributes
 *   // that get applied to all metrics in the current context
 *   const baseAttributes = { service: "api", version: "1.0" }
 *
 *   // Use withAttributes to apply attributes to metrics
 *   const taggedCounter1 = Metric.withAttributes(requestCounter, baseAttributes)
 *   const program1 = Metric.update(taggedCounter1, 1)
 *
 *   const taggedCounter2 = Metric.withAttributes(requestCounter, {
 *     ...baseAttributes,
 *     endpoint: "/users"
 *   })
 *   const program2 = Metric.update(taggedCounter2, 5)
 *
 *   yield* program1
 *   yield* program2
 *
 *   return {
 *     keyValue: key, // "effect/Metric/CurrentMetricAttributes"
 *     keyType: typeof key, // "string"
 *     isConstant: key === "effect/Metric/CurrentMetricAttributes" // true
 *   }
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const CurrentMetricAttributesKey = "effect/Metric/CurrentMetricAttributes" as const

/**
 * Context reference for metric attributes applied from the current Effect
 * context.
 *
 * **When to use**
 *
 * Use to provide default attributes that should be merged into metric updates
 * and reads in a scoped part of a program.
 *
 * **Details**
 *
 * The default value is an empty attribute set. Metric reads and updates merge
 * these contextual attributes with the metric's own attributes to select the
 * metric series being accessed.
 *
 * **Example** (Providing current metric attributes)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class AttributesError extends Data.TaggedError("AttributesError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Access current metric attributes
 *   const attributes = yield* Metric.CurrentMetricAttributes
 *   console.log("Current attributes:", attributes)
 *
 *   // Set new attributes context
 *   const newAttributes = { service: "api", version: "1.0" }
 *   const result = yield* Effect.provideService(
 *     Effect.gen(function*() {
 *       const updatedAttributes = yield* Metric.CurrentMetricAttributes
 *       return updatedAttributes
 *     }),
 *     Metric.CurrentMetricAttributes,
 *     newAttributes
 *   )
 *
 *   return result
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const CurrentMetricAttributes = Context.Reference<Metric.AttributeSet>(CurrentMetricAttributesKey, {
  defaultValue: () => ({})
})

const MetricRegistryKey = "~effect/observability/Metric/MetricRegistryKey"

/**
 * Context reference for the metric registry in the current context.
 *
 * **When to use**
 *
 * Use to provide a custom metric registry when a program or test needs metrics
 * isolated from the default registry.
 *
 * **Details**
 *
 * By default, the reference creates an empty `Map` the first time it is
 * resolved. Metrics register their metadata and hooks lazily in this map when
 * they are read or updated.
 *
 * **Gotchas**
 *
 * Because `Context.Reference` caches default values, the default `Map` is
 * shared by contexts that do not provide an override. Provide `MetricRegistry`
 * with a fresh `Map` when isolation matters.
 *
 * @see {@link snapshot} for reading all registered metrics from the current `Effect` context
 * @see {@link snapshotUnsafe} for reading all registered metrics from an explicit `Context`
 *
 * @category references
 * @since 4.0.0
 */
export const MetricRegistry = Context.Reference<Map<string, Metric.Metadata<any, any>>>(
  MetricRegistryKey,
  { defaultValue: () => new Map() }
)

const TypeId = "~effect/observability/Metric"

abstract class Metric$<in Input, out State> implements Metric<Input, State> {
  readonly [TypeId] = TypeId

  abstract readonly type: Metric.Type

  declare readonly Input: Contravariant<Input>
  declare readonly State: Covariant<State>

  readonly #metadataCache = new WeakMap<Metric.Attributes, Metric.Metadata<Input, State>>()
  #metadata: Metric.Metadata<Input, State> | undefined

  readonly id: string
  readonly description: string | undefined
  readonly attributes: Metric.AttributeSet | undefined

  constructor(
    id: string,
    description: string | undefined,
    attributes: Metric.AttributeSet | undefined
  ) {
    this.id = id
    this.description = description
    this.attributes = attributes
  }

  valueUnsafe(context: Context.Context<never>): State {
    return this.hook(context).get(context)
  }

  modifyUnsafe(input: Input, context: Context.Context<never>): void {
    return this.hook(context).modify(input, context)
  }

  updateUnsafe(input: Input, context: Context.Context<never>): void {
    return this.hook(context).update(input, context)
  }

  abstract createHooks(): Metric.Hooks<Input, State>

  hook(context: Context.Context<never>): Metric.Hooks<Input, State> {
    const extraAttributes = Context.get(context, CurrentMetricAttributes)
    if (Object.keys(extraAttributes).length === 0) {
      if (Predicate.isNotUndefined(this.#metadata)) {
        return this.#metadata.hooks
      }
      this.#metadata = this.getOrCreate(context, this.attributes)
      return this.#metadata.hooks
    }
    const mergedAttributes = mergeAttributes(this.attributes, extraAttributes)
    let metadata = this.#metadataCache.get(mergedAttributes)
    if (Predicate.isNotUndefined(metadata)) {
      return metadata.hooks
    }
    metadata = this.getOrCreate(context, mergedAttributes)
    this.#metadataCache.set(mergedAttributes, metadata)
    return metadata.hooks
  }

  getOrCreate(
    context: Context.Context<never>,
    attributes: Metric.Attributes | undefined
  ): Metric.Metadata<Input, State> {
    const key = makeKey(this, attributes)
    const registry = Context.get(context, MetricRegistry)
    if (registry.has(key)) {
      return registry.get(key)!
    }
    const hooks = this.createHooks()
    const meta: Metric.Metadata<Input, State> = {
      id: this.id,
      type: this.type,
      description: this.description,
      attributes: attributesToRecord(attributes),
      hooks
    }
    registry.set(key, meta)
    return meta
  }

  pipe() {
    return pipeArguments(this, arguments)
  }
}

const bigint0 = BigInt(0)

class CounterMetric<Input extends number | bigint> extends Metric$<Input, CounterState<Input>> {
  readonly type = "Counter"
  readonly #bigint: boolean
  readonly #incremental: boolean

  constructor(id: string, options?: {
    readonly description?: string | undefined
    readonly attributes?: Metric.Attributes | undefined
    readonly bigint?: boolean | undefined
    readonly incremental?: boolean | undefined
  }) {
    super(id, options?.description, attributesToRecord(options?.attributes))
    this.#bigint = options?.bigint ?? false
    this.#incremental = options?.incremental ?? false
  }

  createHooks(): Metric.Hooks<Input, CounterState<Input>> {
    let count = (this.#bigint ? bigint0 : 0) as any
    const canUpdate = this.#incremental
      ? this.#bigint
        ? (value: bigint | number) => value >= bigint0
        : (value: bigint | number) => value >= 0
      : (_value: bigint | number) => true
    const update = (value: Input) => {
      if (canUpdate(value)) {
        count = (count as any) + value
      }
    }
    return makeHooks(() => ({ count, incremental: this.#incremental }), update)
  }
}

class GaugeMetric<Input extends number | bigint> extends Metric$<Input, GaugeState<Input>> {
  readonly type = "Gauge"
  readonly #bigint: boolean

  constructor(id: string, options?: {
    readonly description?: string | undefined
    readonly attributes?: Metric.Attributes | undefined
    readonly bigint?: boolean | undefined
  }) {
    super(id, options?.description, attributesToRecord(options?.attributes))
    this.#bigint = options?.bigint ?? false
  }

  createHooks(): Metric.Hooks<Input, GaugeState<Input>> {
    let value = this.#bigint ? BigInt(0) as any : 0
    const update = (input: number | bigint) => {
      value = input
    }
    const modify = (input: number | bigint) => {
      value = value + input
    }
    return makeHooks(() => ({ value }), update, modify)
  }
}

class FrequencyMetric extends Metric$<string, FrequencyState> {
  readonly type = "Frequency"
  readonly #preregisteredWords: ReadonlyArray<string> | undefined

  constructor(id: string, options?: {
    readonly description?: string | undefined
    readonly attributes?: Metric.Attributes | undefined
    readonly preregisteredWords?: ReadonlyArray<string> | undefined
  }) {
    super(id, options?.description, attributesToRecord(options?.attributes))
    this.#preregisteredWords = options?.preregisteredWords
  }

  createHooks(): Metric.Hooks<string, FrequencyState> {
    const occurrences = new Map<string, number>()
    if (Predicate.isNotUndefined(this.#preregisteredWords)) {
      for (const word of this.#preregisteredWords) {
        occurrences.set(word, 0)
      }
    }
    const update = (word: string) => {
      const count = occurrences.get(word) ?? 0
      occurrences.set(word, count + 1)
    }
    return makeHooks(() => ({ occurrences }), update)
  }
}

class HistogramMetric extends Metric$<number, HistogramState> {
  readonly type = "Histogram"
  readonly #boundaries: ReadonlyArray<number>

  constructor(id: string, options: {
    readonly description?: string | undefined
    readonly attributes?: Metric.Attributes | undefined
    readonly boundaries: ReadonlyArray<number>
  }) {
    super(id, options?.description, attributesToRecord(options?.attributes))
    this.#boundaries = options.boundaries
  }

  createHooks(): Metric.Hooks<number, HistogramState> {
    const bounds = this.#boundaries
    const size = bounds.length
    const values = new Uint32Array(size + 1)
    const boundaries = new Float64Array(size)
    let count = 0
    let sum = 0
    let min = Number.MAX_VALUE
    let max = Number.MIN_VALUE

    Arr.map(Arr.sort(bounds, Order.Number), (n, i) => {
      boundaries[i] = n
    })

    // Insert the value into the right bucket with a binary search
    const update = (value: number) => {
      let from = 0
      let to = size
      while (from !== to) {
        const mid = Math.floor(from + (to - from) / 2)
        const boundary = boundaries[mid]
        if (value <= boundary) {
          to = mid
        } else {
          from = mid
        }
        // The special case when to / from have a distance of one
        if (to === from + 1) {
          if (value <= boundaries[from]) {
            to = from
          } else {
            from = to
          }
        }
      }
      values[from] = values[from] + 1
      count = count + 1
      sum = sum + value
      if (value < min) {
        min = value
      }
      if (value > max) {
        max = value
      }
    }

    const getBuckets = (): ReadonlyArray<[number, number]> => {
      const builder: Array<[number, number]> = Arr.allocate(size) as any
      let cumulated = 0
      for (let i = 0; i < size; i++) {
        const boundary = boundaries[i]
        const value = values[i]
        cumulated = cumulated + value
        builder[i] = [boundary, cumulated]
      }
      return builder
    }

    return makeHooks(() => ({ buckets: getBuckets(), count, min, max, sum }), update)
  }
}

class SummaryMetric extends Metric$<readonly [value: number, timestamp: number], SummaryState> {
  readonly type = "Summary"
  readonly #maxAge: number
  readonly #maxSize: number
  readonly #quantiles: ReadonlyArray<number>

  constructor(id: string, options: {
    readonly description?: string | undefined
    readonly attributes?: Metric.Attributes | undefined
    readonly maxAge: Duration.Input
    readonly maxSize: number
    readonly quantiles: ReadonlyArray<number>
  }) {
    super(id, options?.description, attributesToRecord(options?.attributes))
    this.#maxAge = Math.max(Duration.toMillis(Duration.fromInputUnsafe(options.maxAge)), 0)
    this.#maxSize = options.maxSize
    this.#quantiles = options.quantiles
  }

  createHooks(): Metric.Hooks<readonly [value: number, timestamp: number], SummaryState> {
    const sortedQuantiles = Arr.sort(this.#quantiles, Order.Number)
    const observations = Arr.allocate<[number, number]>(this.#maxSize)

    for (const quantile of this.#quantiles) {
      if (quantile < 0 || quantile > 1) {
        throw new Error(`Quantile must be between 0 and 1, found: ${quantile}`)
      }
    }

    let head = 0
    let count = 0
    let sum = 0
    let min = Number.MAX_VALUE
    let max = Number.MIN_VALUE

    const snapshot = (now: number): ReadonlyArray<[number, number | undefined]> => {
      const builder: Array<number> = []
      let i = 0
      while (i < this.#maxSize) {
        const observation = observations[i]
        if (Predicate.isNotUndefined(observation)) {
          const [timestamp, value] = observation
          const age = now - timestamp
          if (age >= 0 && age <= this.#maxAge) {
            builder.push(value)
          }
        }
        i = i + 1
      }
      const samples = Arr.sort(builder, Order.Number)
      const sampleSize = samples.length
      if (sampleSize === 0) {
        return sortedQuantiles.map((q) => [q, undefined])
      }
      // Compute the value of the quantile in terms of rank:
      // > For a given quantile `q`, return the maximum value `v` such that at
      // > most `q * n` values are less than or equal to `v`.
      return sortedQuantiles.map((q) => {
        if (q <= 0) return [q, samples[0]]
        if (q >= 1) return [q, samples[sampleSize - 1]]
        const index = Math.ceil(q * sampleSize) - 1
        return [q, samples[index]]
      })
    }

    const observe = (value: number, timestamp: number) => {
      if (this.#maxSize > 0) {
        const target = head % this.#maxSize
        observations[target] = [timestamp, value] as const
        head = head + 1
      }
      count = count + 1
      sum = sum + value
      if (value < min) {
        min = value
      }
      if (value > max) {
        max = value
      }
    }

    const get = (context: Context.Context<never>) => {
      const clock = Context.get(context, InternalEffect.ClockRef)
      const quantiles = snapshot(clock.currentTimeMillisUnsafe())
      return { quantiles, count, min, max, sum }
    }

    const update = ([value, timestamp]: readonly [value: number, timestamp: number]) => observe(value, timestamp)

    return makeHooks(get, update)
  }
}

class MetricTransform<in Input, out State, in Input2> extends Metric$<Input2, State> {
  type: Metric.Type
  readonly metric: Metric<Input, State>
  override readonly valueUnsafe: (context: Context.Context<never>) => State
  override readonly updateUnsafe: (input: Input2, context: Context.Context<never>) => void
  override readonly modifyUnsafe: (input: Input2, context: Context.Context<never>) => void

  constructor(
    metric: Metric<Input, State>,
    valueUnsafe: (context: Context.Context<never>) => State,
    updateUnsafe: (input: Input2, context: Context.Context<never>) => void,
    modifyUnsafe: (input: Input2, context: Context.Context<never>) => void
  ) {
    super(metric.id, metric.description, metric.attributes)
    this.metric = metric
    this.valueUnsafe = valueUnsafe
    this.updateUnsafe = updateUnsafe
    this.modifyUnsafe = modifyUnsafe
    this.type = metric.type
  }
  createHooks(): Metric.Hooks<Input2, State> {
    return (this.metric as any).createHooks()
  }
}

/**
 * Returns `true` if the specified value is a `Metric`, otherwise returns `false`.
 *
 * **When to use**
 *
 * Use when you need runtime type checking and ensuring that a value
 * conforms to the Metric interface before performing metric operations.
 *
 * **Example** (Checking metric values)
 *
 * ```ts
 * import { Metric } from "effect"
 *
 * const counter = Metric.counter("requests")
 * const gauge = Metric.gauge("temperature")
 * const notAMetric = { name: "fake-metric" }
 *
 * console.log(Metric.isMetric(counter)) // true
 * console.log(Metric.isMetric(gauge)) // true
 * console.log(Metric.isMetric(notAMetric)) // false
 * console.log(Metric.isMetric(null)) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isMetric = (u: unknown): u is Metric<unknown, never> =>
  Predicate.hasProperty(u, "~effect/Metric") && u["~effect/Metric"] === "~effect/Metric"

/**
 * Represents a Counter metric that tracks cumulative numerical values over
 * time. Counters can be incremented and decremented and provide a running total
 * of changes.
 *
 * **Details**
 *
 * - `description` - A description of the `Counter`.
 * - `attributes`  - The attributes to associate with the `Counter`.
 * - `bigint`      - Indicates if the `Counter` should use the `bigint` type.
 * - `incremental` - Set to `true` to create a `Counter` that can only ever be
 *                   incremented.
 *
 * **Example** (Creating counter metrics)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class CounterError extends Data.TaggedError("CounterError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create a basic counter for tracking requests
 *   const requestCounter = Metric.counter("http_requests_total", {
 *     description: "Total number of HTTP requests processed"
 *   })
 *
 *   // Create an incremental-only counter for events
 *   const eventCounter = Metric.counter("events_processed", {
 *     description: "Events processed (increment only)",
 *     incremental: true
 *   })
 *
 *   // Create a bigint counter for large values
 *   const bytesCounter = Metric.counter("bytes_transferred", {
 *     description: "Total bytes transferred",
 *     bigint: true,
 *     attributes: { service: "file-transfer" }
 *   })
 *
 *   // Update counters with values
 *   yield* Metric.update(requestCounter, 1) // Increment by 1
 *   yield* Metric.update(requestCounter, 5) // Increment by 5 (total: 6)
 *   yield* Metric.update(eventCounter, 1) // Increment by 1
 *   yield* Metric.update(bytesCounter, 1024n) // Add 1024 bytes
 *
 *   // Get current counter values
 *   const requestValue = yield* Metric.value(requestCounter)
 *   const eventValue = yield* Metric.value(eventCounter)
 *   const bytesValue = yield* Metric.value(bytesCounter)
 *
 *   return { requestValue, eventValue, bytesValue }
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const counter: {
  (
    name: string,
    options?: {
      readonly description?: string | undefined
      readonly attributes?: Metric.Attributes | undefined
      readonly bigint?: false | undefined
      readonly incremental?: boolean | undefined
    }
  ): Counter<number>
  (
    name: string,
    options: {
      readonly description?: string | undefined
      readonly attributes?: Metric.Attributes | undefined
      readonly bigint: true
      readonly incremental?: boolean | undefined
    }
  ): Counter<bigint>
} = (name, options) => new CounterMetric(name, options) as any

/**
 * Represents a `Gauge` metric that tracks and reports a single numerical value
 * at a specific moment.
 *
 * **When to use**
 *
 * Use when gauges are most suitable for metrics that represent instantaneous values,
 * such as memory usage or CPU load.
 *
 * **Details**
 *
 * - `description` - A description of the `Gauge`.
 * - `attributes`  - The attributes to associate with the `Gauge`.
 * - `bigint`      - Indicates if the `Gauge` should use the `bigint` type.
 *
 * **Example** (Creating gauge metrics)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class GaugeError extends Data.TaggedError("GaugeError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create a gauge for tracking memory usage
 *   const memoryGauge = Metric.gauge("memory_usage_mb", {
 *     description: "Current memory usage in megabytes"
 *   })
 *
 *   // Create a gauge for CPU utilization
 *   const cpuGauge = Metric.gauge("cpu_utilization", {
 *     description: "Current CPU utilization percentage",
 *     attributes: { host: "server-01" }
 *   })
 *
 *   // Create a bigint gauge for large values
 *   const diskSpaceGauge = Metric.gauge("disk_free_bytes", {
 *     description: "Free disk space in bytes",
 *     bigint: true
 *   })
 *
 *   // Set gauge values (replaces current value)
 *   yield* Metric.update(memoryGauge, 512) // Set to 512 MB
 *   yield* Metric.update(cpuGauge, 85.5) // Set to 85.5%
 *   yield* Metric.update(diskSpaceGauge, 1024000000n) // Set to ~1GB
 *
 *   // Modify gauge values (adds to current value)
 *   yield* Metric.modify(memoryGauge, 128) // Increase by 128 MB (total: 640)
 *   yield* Metric.modify(cpuGauge, -10.5) // Decrease by 10.5% (total: 75%)
 *
 *   // Update with new absolute values
 *   yield* Metric.update(memoryGauge, 800) // Set to 800 MB (replaces 640)
 *
 *   // Get current gauge values
 *   const memoryValue = yield* Metric.value(memoryGauge)
 *   const cpuValue = yield* Metric.value(cpuGauge)
 *   const diskValue = yield* Metric.value(diskSpaceGauge)
 *
 *   return { memoryValue, cpuValue, diskValue }
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const gauge: {
  (name: string, options?: {
    readonly description?: string | undefined
    readonly attributes?: Metric.Attributes | undefined
    readonly bigint?: false | undefined
  }): Gauge<number>
  (name: string, options: {
    readonly description?: string | undefined
    readonly attributes?: Metric.Attributes | undefined
    readonly bigint: true
  }): Gauge<bigint>
} = (name, options) => new GaugeMetric(name, options) as any

/**
 * Creates a `Frequency` metric which can be used to count the number of
 * occurrences of a string.
 *
 * **When to use**
 *
 * Use when frequency metrics are most suitable for counting the number of times a
 * specific event or incident occurs.
 *
 * **Details**
 *
 * - `description` - A description of the `Frequency`.
 * - `attributes`  - The attributes to associate with the `Frequency`.
 * - `preregisteredWords` - Occurrences which are pre-registered with the
 *                          `Frequency` metric occurrences.
 *
 * **Example** (Creating frequency metrics)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class FrequencyError extends Data.TaggedError("FrequencyError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create a frequency metric for HTTP status codes
 *   const statusFrequency = Metric.frequency("http_status_codes", {
 *     description: "Frequency of HTTP response status codes",
 *     preregisteredWords: ["200", "404", "500"] // Pre-register common codes
 *   })
 *
 *   // Create a frequency metric for user actions
 *   const userActionFrequency = Metric.frequency("user_actions", {
 *     description: "Frequency of user actions performed",
 *     attributes: { application: "web-app" }
 *   })
 *
 *   // Create a frequency metric for error types
 *   const errorTypeFrequency = Metric.frequency("error_types", {
 *     description: "Frequency of different error types"
 *   })
 *
 *   // Record different occurrences
 *   yield* Metric.update(statusFrequency, "200") // Success response
 *   yield* Metric.update(statusFrequency, "200") // Another success
 *   yield* Metric.update(statusFrequency, "404") // Not found error
 *   yield* Metric.update(statusFrequency, "500") // Server error
 *   yield* Metric.update(statusFrequency, "200") // Another success
 *
 *   yield* Metric.update(userActionFrequency, "login")
 *   yield* Metric.update(userActionFrequency, "view_dashboard")
 *   yield* Metric.update(userActionFrequency, "login")
 *   yield* Metric.update(userActionFrequency, "logout")
 *
 *   yield* Metric.update(errorTypeFrequency, "ValidationError")
 *   yield* Metric.update(errorTypeFrequency, "NetworkError")
 *   yield* Metric.update(errorTypeFrequency, "ValidationError")
 *
 *   // Get frequency counts
 *   const statusCounts = yield* Metric.value(statusFrequency)
 *   const actionCounts = yield* Metric.value(userActionFrequency)
 *   const errorCounts = yield* Metric.value(errorTypeFrequency)
 *
 *   // statusCounts.occurrences will be:
 *   // Map { "200" => 3, "404" => 1, "500" => 1 }
 *   // actionCounts.occurrences will be:
 *   // Map { "login" => 2, "view_dashboard" => 1, "logout" => 1 }
 *   // errorCounts.occurrences will be:
 *   // Map { "ValidationError" => 2, "NetworkError" => 1 }
 *
 *   return { statusCounts, actionCounts, errorCounts }
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const frequency = (name: string, options?: {
  readonly description?: string | undefined
  readonly attributes?: Metric.Attributes | undefined
  readonly preregisteredWords?: ReadonlyArray<string> | undefined
}): Frequency => new FrequencyMetric(name, options)

/**
 * Represents a `Histogram` metric that records observations into buckets.
 *
 * **When to use**
 *
 * Use when histogram metrics are most suitable for measuring the distribution of values
 * within a range.
 *
 * **Details**
 *
 * - `description` - A description of the `Histogram`.
 * - `attributes`  - The attributes to associate with the `Histogram`.
 * - `boundaries`  - The bucket boundaries of the `Histogram`
 *
 * **Example** (Creating histogram metrics)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class HistogramError extends Data.TaggedError("HistogramError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create a histogram for API response times
 *   const responseTimeHistogram = Metric.histogram("api_response_time", {
 *     description: "Distribution of API response times in milliseconds",
 *     boundaries: Metric.linearBoundaries({ start: 0, width: 50, count: 10 })
 *     // Creates buckets: 0-50ms, 50-100ms, 100-150ms, ..., 400-450ms, 450ms+
 *   })
 *
 *   // Create a histogram for request payload sizes
 *   const payloadSizeHistogram = Metric.histogram("payload_size", {
 *     description: "Distribution of request payload sizes in KB",
 *     boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 8 }),
 *     // Creates exponential buckets: 1KB, 2KB, 4KB, 8KB, 16KB, 32KB, 64KB, 128KB+
 *     attributes: { service: "api-gateway" }
 *   })
 *
 *   // Create a histogram with custom boundaries
 *   const customHistogram = Metric.histogram("custom_metric", {
 *     description: "Custom distribution metric",
 *     boundaries: [0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100]
 *   })
 *
 *   // Record various response times
 *   yield* Metric.update(responseTimeHistogram, 25) // Goes in 0-50ms bucket
 *   yield* Metric.update(responseTimeHistogram, 75) // Goes in 50-100ms bucket
 *   yield* Metric.update(responseTimeHistogram, 125) // Goes in 100-150ms bucket
 *   yield* Metric.update(responseTimeHistogram, 200) // Goes in 150-200ms bucket
 *   yield* Metric.update(responseTimeHistogram, 75) // Another 50-100ms
 *
 *   // Record payload sizes
 *   yield* Metric.update(payloadSizeHistogram, 3) // Goes in 2-4KB bucket
 *   yield* Metric.update(payloadSizeHistogram, 15) // Goes in 8-16KB bucket
 *   yield* Metric.update(payloadSizeHistogram, 0.5) // Goes in 0-1KB bucket
 *
 *   // Get histogram state with distribution data
 *   const responseTimeState = yield* Metric.value(responseTimeHistogram)
 *   const payloadSizeState = yield* Metric.value(payloadSizeHistogram)
 *
 *   // responseTimeState will contain:
 *   // - buckets: [[50, 1], [100, 3], [150, 4], [200, 5], ...]
 *   // - count: 5, min: 25, max: 200, sum: 500
 *   // - Useful for calculating percentiles, averages, etc.
 *
 *   return { responseTimeState, payloadSizeState }
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const histogram = (name: string, options: {
  readonly description?: string | undefined
  readonly attributes?: Metric.Attributes | undefined
  readonly boundaries: ReadonlyArray<number>
}): Histogram<number> => new HistogramMetric(name, options)

/**
 * Creates a `Summary` metric that records observations and calculates quantiles
 * which takes a value as input and uses the current time.
 *
 * **When to use**
 *
 * Use when summary metrics are most suitable for providing statistical information about
 * a set of values, including quantiles.
 *
 * **Details**
 *
 * - `description` - An description of the `Summary`.
 * - `attributes`  - The attributes to associate with the `Summary`.
 * - `maxAge`      - The maximum age of observations to retain.
 * - `maxSize`     - The maximum number of observations to keep.
 * - `quantiles`   - An array of quantiles to calculate (e.g., [0.5, 0.9]).
 *
 * **Example** (Creating summary metrics)
 *
 * ```ts
 * import { Data, Duration, Effect, Metric } from "effect"
 *
 * class SummaryError extends Data.TaggedError("SummaryError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create a summary for API response times
 *   const responseTimeSummary = Metric.summary("api_response_time", {
 *     description: "API response time quantiles over 5-minute windows",
 *     maxAge: Duration.minutes(5), // Keep observations for 5 minutes
 *     maxSize: 1000, // Maximum 1000 observations in memory
 *     quantiles: [0.5, 0.9, 0.95, 0.99] // 50th, 90th, 95th, 99th percentiles
 *   })
 *
 *   // Create a summary for request payload sizes
 *   const payloadSizeSummary = Metric.summary("request_payload_size", {
 *     description: "Request payload size distribution over 2-minute windows",
 *     maxAge: Duration.minutes(2), // Shorter window for recent trends
 *     maxSize: 500, // Smaller buffer for memory efficiency
 *     quantiles: [0.5, 0.75, 0.9], // Median, 75th, 90th percentiles
 *     attributes: { service: "upload-service" }
 *   })
 *
 *   // Record deterministic response times
 *   const responseTimes = [82, 96, 104, 118, 135, 170, 210, 240]
 *   for (const responseTime of responseTimes) {
 *     yield* Metric.update(responseTimeSummary, responseTime)
 *   }
 *
 *   // Record some payload sizes
 *   yield* Metric.update(payloadSizeSummary, 1.2) // 1.2KB
 *   yield* Metric.update(payloadSizeSummary, 5.8) // 5.8KB
 *   yield* Metric.update(payloadSizeSummary, 15.6) // 15.6KB
 *   yield* Metric.update(payloadSizeSummary, 3.4) // 3.4KB
 *
 *   // Get summary statistics with quantiles
 *   const responseStats = yield* Metric.value(responseTimeSummary)
 *   const payloadStats = yield* Metric.value(payloadSizeSummary)
 *
 *   console.log({
 *     count: responseStats.count,
 *     min: responseStats.min,
 *     max: responseStats.max,
 *     sum: responseStats.sum
 *   }) // { count: 8, min: 82, max: 240, sum: 1155 }
 *
 *   console.log({
 *     count: payloadStats.count,
 *     min: payloadStats.min,
 *     max: payloadStats.max,
 *     sum: payloadStats.sum
 *   }) // { count: 4, min: 1.2, max: 15.6, sum: 26 }
 *
 *   // Both summaries include quantile information for their configured windows.
 *
 *   return { responseStats, payloadStats }
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const summary = (name: string, options: {
  readonly description?: string | undefined
  readonly attributes?: Metric.Attributes | undefined
  readonly maxAge: Duration.Input
  readonly maxSize: number
  readonly quantiles: ReadonlyArray<number>
}): Summary<number> =>
  mapInput(summaryWithTimestamp(name, options), (input, context) =>
    [
      input,
      Context.get(context, InternalEffect.ClockRef).currentTimeMillisUnsafe()
    ] as [number, number])

/**
 * Creates a `Summary` metric that records observations with explicit
 * timestamps and calculates quantiles.
 *
 * **When to use**
 *
 * Use when summary metrics are most suitable for statistical information about a set of
 * values.
 *
 * **Details**
 *
 * Inputs to this metric are `[value, timestamp]` pairs; the current clock is
 * used when reading quantiles against the configured `maxAge`.
 *
 * - `description` - An description of the `Summary`.
 * - `attributes`  - The attributes to associate with the `Summary`.
 * - `maxAge`      - The maximum age of observations to retain.
 * - `maxSize`     - The maximum number of observations to keep.
 * - `quantiles`   - An array of quantiles to calculate (e.g., [0.5, 0.9]).
 *
 * **Example** (Creating summaries with explicit timestamps)
 *
 * ```ts
 * import { Metric } from "effect"
 *
 * const responseTimesSummary = Metric.summaryWithTimestamp(
 *   "response_times_summary",
 *   {
 *     description: "Measures the distribution of response times",
 *     maxAge: "60 seconds", // Retain observations for 60 seconds.
 *     maxSize: 1000, // Keep a maximum of 1000 observations.
 *     quantiles: [0.5, 0.9, 0.99] // Calculate 50th, 90th, and 99th quantiles.
 *   }
 * )
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const summaryWithTimestamp = (name: string, options: {
  readonly description?: string | undefined
  readonly attributes?: Metric.Attributes | undefined
  readonly maxAge: Duration.Input
  readonly maxSize: number
  readonly quantiles: ReadonlyArray<number>
}): Summary<[value: number, timestamp: number]> => new SummaryMetric(name, options)

/**
 * Creates a timer metric, based on a `Histogram`, which keeps track of
 * durations in milliseconds.
 *
 * **Details**
 *
 * The unit of time will automatically be added to the metric as a tag (i.e.
 * `"time_unit: milliseconds"`).
 *
 * If `options.boundaries` is not provided, the boundaries will be computed
 * using `Metric.exponentialBoundaries({ start: 0.5, factor: 2, count: 35 })`.
 *
 * **Example** (Recording durations with a timer)
 *
 * ```ts
 * import { Data, Duration, Effect, Metric } from "effect"
 *
 * class TimerError extends Data.TaggedError("TimerError")<{
 *   readonly operation: string
 * }> {}
 *
 * // Create a timer metric to track API request durations
 * const apiRequestTimer = Metric.timer("api_request_duration", {
 *   description: "Duration of API requests",
 *   attributes: { service: "user-api" }
 * })
 *
 * // Record a measured API operation duration
 * const apiOperation = Effect.gen(function*() {
 *   const duration = Duration.millis(120)
 *   yield* Metric.update(apiRequestTimer, duration)
 *
 *   const state = yield* Metric.value(apiRequestTimer)
 *   console.log({
 *     count: state.count,
 *     min: state.min,
 *     max: state.max,
 *     sum: state.sum
 *   }) // { count: 1, min: 120, max: 120, sum: 120 }
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const timer = (name: string, options?: {
  readonly description?: string | undefined
  readonly attributes?: Metric.Attributes | undefined
  readonly boundaries?: ReadonlyArray<number>
}): Histogram<Duration.Duration> => {
  const boundaries = Predicate.isNotUndefined(options?.boundaries)
    ? options.boundaries
    : exponentialBoundaries({ start: 0.5, factor: 2, count: 35 })
  const attributes = mergeAttributes(options?.attributes, { time_unit: "milliseconds" })
  const metric = new HistogramMetric(name, { ...options, boundaries, attributes })
  return mapInput(metric, Duration.toMillis)
}

/**
 * Retrieves the current state of the specified `Metric`.
 *
 * **Details**
 *
 * The returned state depends on the metric type:
 *
 * - Counter: `CounterState<number | bigint>` with `count` and `incremental`
 * - Gauge: `GaugeState<number | bigint>` with `value`
 * - Frequency: `FrequencyState` with `occurrences`
 * - Histogram: `HistogramState` with buckets, count, min, max, and sum
 * - Summary: `SummaryState` with quantiles, count, min, max, and sum
 *
 * **Example** (Reading metric state)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const requestCounter = Metric.counter("requests")
 * const responseTime = Metric.histogram("response_time", {
 *   boundaries: [100, 500, 1000, 2000]
 * })
 *
 * const program = Effect.gen(function*() {
 *   // Update metrics
 *   yield* Metric.update(requestCounter, 1)
 *   yield* Metric.update(responseTime, 750)
 *
 *   // Get current values
 *   const counterState = yield* Metric.value(requestCounter)
 *   console.log(`Request count: ${counterState.count}`)
 *
 *   const histogramState = yield* Metric.value(responseTime)
 *   console.log(`Response time stats:`, {
 *     count: histogramState.count,
 *     min: histogramState.min,
 *     max: histogramState.max,
 *     average: histogramState.sum / histogramState.count
 *   })
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const value = <Input, State>(
  self: Metric<Input, State>
): Effect<State> =>
  InternalEffect.flatMap(
    InternalEffect.context(),
    (context) => InternalEffect.sync(() => self.valueUnsafe(context))
  )

/**
 * Modifies the metric with the specified input.
 *
 * **Details**
 *
 * The behavior of `modify` depends on the metric type:
 *
 * - **Counter**: Adds the input value to the current count
 * - **Gauge**: Adds the input value to the current gauge value
 * - **Frequency**: Same as `update` - increments the occurrence count for the input string
 * - **Histogram**: Same as `update` - records the input value in the appropriate bucket
 * - **Summary**: Same as `update` - records the input observation
 *
 * **Example** (Modifying metric values)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const temperatureGauge = Metric.gauge("temperature")
 * const requestCounter = Metric.counter("requests")
 *
 * const program = Effect.gen(function*() {
 *   // Set initial temperature
 *   yield* Metric.update(temperatureGauge, 20)
 *
 *   // Modify by adding/subtracting values
 *   yield* Metric.modify(temperatureGauge, 5) // Now 25
 *   yield* Metric.modify(temperatureGauge, -3) // Now 22
 *
 *   // For counters, modify increments by the specified amount
 *   yield* Metric.modify(requestCounter, 10) // Add 10 to counter
 *   yield* Metric.modify(requestCounter, 5) // Add 5 more (total: 15)
 *
 *   const temp = yield* Metric.value(temperatureGauge)
 *   const requests = yield* Metric.value(requestCounter)
 *
 *   console.log(`Temperature: ${temp.value}°C`) // 22°C
 *   console.log(`Requests: ${requests.count}`) // 15
 * })
 * ```
 *
 * @category utils
 * @since 3.6.5
 */
export const modify: {
  <Input>(input: Input): <State>(self: Metric<Input, State>) => Effect<void>
  <Input, State>(self: Metric<Input, State>, input: Input): Effect<void>
} = dual<
  <Input>(input: Input) => <State>(self: Metric<Input, State>) => Effect<void>,
  <Input, State>(self: Metric<Input, State>, input: Input) => Effect<void>
>(2, (self, input) =>
  InternalEffect.flatMap(
    InternalEffect.context(),
    (context) => InternalEffect.sync(() => self.modifyUnsafe(input, context))
  ))

/**
 * Updates the metric with the specified input.
 *
 * **Details**
 *
 * The behavior of `update` depends on the metric type:
 *
 * - **Counter**: Adds the input value to the current count (same as `modify`)
 * - **Gauge**: Sets the gauge to the specified value (replaces current value)
 * - **Frequency**: Increments the occurrence count for the input string by 1
 * - **Histogram**: Records the input value in the appropriate bucket
 * - **Summary**: Records the input value as a new observation
 *
 * **Example** (Updating metric values)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const cpuUsage = Metric.gauge("cpu_usage_percent")
 * const httpStatus = Metric.frequency("http_status_codes")
 * const responseTime = Metric.histogram("response_time_ms", {
 *   boundaries: [100, 500, 1000, 2000]
 * })
 *
 * const program = Effect.gen(function*() {
 *   // Update gauge to specific values
 *   yield* Metric.update(cpuUsage, 45.2)
 *   yield* Metric.update(cpuUsage, 67.8) // Replaces previous value
 *
 *   // Track HTTP status code occurrences
 *   yield* Metric.update(httpStatus, "200")
 *   yield* Metric.update(httpStatus, "404")
 *   yield* Metric.update(httpStatus, "200") // Increments 200 count
 *
 *   // Record response times
 *   yield* Metric.update(responseTime, 250)
 *   yield* Metric.update(responseTime, 750)
 *   yield* Metric.update(responseTime, 1500)
 *
 *   // Check current states
 *   const cpu = yield* Metric.value(cpuUsage)
 *   const statuses = yield* Metric.value(httpStatus)
 *   const times = yield* Metric.value(responseTime)
 *
 *   console.log(`CPU Usage: ${cpu.value}%`)
 *   console.log(`Status 200 count: ${statuses.occurrences.get("200")}`) // 2
 *   console.log(`Response time samples: ${times.count}`) // 3
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const update: {
  <Input>(input: Input): <State>(self: Metric<Input, State>) => Effect<void>
  <Input, State>(self: Metric<Input, State>, input: Input): Effect<void>
} = dual<
  <Input>(input: Input) => <State>(self: Metric<Input, State>) => Effect<void>,
  <Input, State>(self: Metric<Input, State>, input: Input) => Effect<void>
>(
  2,
  (self, input) =>
    InternalEffect.contextWith((services) => InternalEffect.sync(() => self.updateUnsafe(input, services)))
)

/**
 * Returns a new metric that is powered by this one, but which accepts updates
 * of the specified new type, which must be transformable to the input type of
 * this metric.
 *
 * **Example** (Mapping metric inputs)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class MetricError extends Data.TaggedError("MetricError")<{
 *   readonly operation: string
 * }> {}
 *
 * // Create a histogram that expects Duration values
 * const durationHistogram = Metric.histogram("request_duration_ms", {
 *   description: "Request duration in milliseconds",
 *   boundaries: Metric.linearBoundaries({ start: 0, width: 100, count: 10 })
 * })
 *
 * // Transform to accept number values representing milliseconds
 * const numberHistogram = Metric.mapInput(
 *   durationHistogram,
 *   (ms: number) => ms // Direct mapping from number to expected input
 * )
 *
 * const program = Effect.gen(function*() {
 *   // Now we can update with a plain number
 *   yield* Metric.update(numberHistogram, 250)
 *
 *   // Get metric value to see the recorded state
 *   const value = yield* Metric.value(numberHistogram)
 *   return value
 * })
 * ```
 *
 * @category mapping
 * @since 2.0.0
 */
export const mapInput: {
  <Input, Input2 extends Input>(
    f: (input: Input2, context: Context.Context<never>) => Input
  ): <State>(self: Metric<Input, State>) => Metric<Input2, State>
  <Input, State, Input2>(
    self: Metric<Input, State>,
    f: (input: Input2, context: Context.Context<never>) => Input
  ): Metric<Input2, State>
} = dual<
  <Input, Input2 extends Input>(
    f: (input: Input2, context: Context.Context<never>) => Input
  ) => <State>(self: Metric<Input, State>) => Metric<Input2, State>,
  <Input, State, Input2>(
    self: Metric<Input, State>,
    f: (input: Input2, context: Context.Context<never>) => Input
  ) => Metric<Input2, State>
>(2, <Input, State, Input2>(
  self: Metric<Input, State>,
  f: (input: Input2, context: Context.Context<never>) => Input
): Metric<Input2, State> =>
  new MetricTransform(
    self,
    (context) => self.valueUnsafe(context),
    (input, context) => self.updateUnsafe(f(input, context), context),
    (input, context) => self.modifyUnsafe(f(input, context), context)
  ))

/**
 * Returns a new metric that is powered by this one, but which accepts updates
 * of any type, and translates them to updates with the specified constant
 * update value.
 *
 * **Example** (Ignoring inputs with a constant value)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class MetricError extends Data.TaggedError("MetricError")<{
 *   readonly operation: string
 * }> {}
 *
 * // Create a counter that normally expects a number increment
 * const requestCounter = Metric.counter("total_requests", {
 *   description: "Total number of requests processed"
 * })
 *
 * // Create a version that always increments by 1, regardless of input
 * const simpleRequestCounter = Metric.withConstantInput(requestCounter, 1)
 *
 * const program = Effect.gen(function*() {
 *   // These all increment the counter by 1, ignoring the input value
 *   yield* Metric.update(simpleRequestCounter, "any string")
 *   yield* Metric.update(simpleRequestCounter, { complex: "object" })
 *   yield* Metric.update(simpleRequestCounter, 999) // Still increments by 1
 *
 *   const value = yield* Metric.value(simpleRequestCounter)
 *   return value // Counter state will show count: 3
 * })
 * ```
 *
 * @category Input
 * @since 2.0.0
 */
export const withConstantInput: {
  <Input>(input: Input): <State>(self: Metric<Input, State>) => Metric<unknown, State>
  <Input, State>(self: Metric<Input, State>, input: Input): Metric<unknown, State>
} = dual<
  <Input>(input: Input) => <State>(self: Metric<Input, State>) => Metric<unknown, State>,
  <Input, State>(self: Metric<Input, State>, input: Input) => Metric<unknown, State>
>(2, (self, input) => mapInput(self, () => input))

/**
 * Returns a new metric that applies the specified attributes to all operations.
 *
 * **Details**
 *
 * Attributes are key-value pairs that provide additional context for metrics,
 * enabling filtering, grouping, and more detailed analysis. Each combination
 * of attribute values creates a separate metric series.
 *
 * **Example** (Applying metric attributes)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const requestCounter = Metric.counter("http_requests_total", {
 *   description: "Total HTTP requests"
 * })
 *
 * // Create tagged versions of the metric
 * const getRequests = Metric.withAttributes(requestCounter, {
 *   method: "GET",
 *   endpoint: "/api/users"
 * })
 *
 * const postRequests = Metric.withAttributes(requestCounter, {
 *   method: "POST",
 *   endpoint: "/api/users"
 * })
 *
 * const program = Effect.gen(function*() {
 *   // These will be tracked as separate metric series
 *   yield* Metric.update(getRequests, 1) // http_requests_total{method="GET", endpoint="/api/users"}
 *   yield* Metric.update(postRequests, 1) // http_requests_total{method="POST", endpoint="/api/users"}
 *   yield* Metric.update(getRequests, 1) // Increments the GET counter
 *
 *   // You can also chain attributes
 *   const taggedMetric = requestCounter.pipe(
 *     Metric.withAttributes({ service: "user-api" }),
 *     Metric.withAttributes({ version: "v1" })
 *   )
 *
 *   yield* Metric.update(taggedMetric, 1) // http_requests_total{service="user-api", version="v1"}
 * })
 *
 * // When taking snapshots, each attribute combination appears as a separate metric
 * const viewMetrics = Effect.gen(function*() {
 *   const snapshots = yield* Metric.snapshot
 *   for (const metric of snapshots) {
 *     if (metric.id === "http_requests_total") {
 *       console.log(`${metric.id}`, metric.attributes, metric.state)
 *     }
 *   }
 * })
 * ```
 *
 * @category Attributes
 * @since 4.0.0
 */
export const withAttributes: {
  (attributes: Metric.Attributes): <Input, State>(self: Metric<Input, State>) => Metric<Input, State>
  <Input, State>(self: Metric<Input, State>, attributes: Metric.Attributes): Metric<Input, State>
} = dual<
  (attributes: Metric.Attributes) => <Input, State>(self: Metric<Input, State>) => Metric<Input, State>,
  <Input, State>(self: Metric<Input, State>, attributes: Metric.Attributes) => Metric<Input, State>
>(2, <Input, State>(
  self: Metric<Input, State>,
  attributes: Metric.Attributes
): Metric<Input, State> =>
  new MetricTransform(
    self,
    (context) => self.valueUnsafe(addAttributesToContext(context, attributes)),
    (input, context) => self.updateUnsafe(input, addAttributesToContext(context, attributes)),
    (input, context) => self.modifyUnsafe(input, addAttributesToContext(context, attributes))
  ))

// Metric Snapshots

/**
 * Captures a snapshot of all registered metrics in the current context.
 *
 * **Details**
 *
 * Returns an array of metric snapshots, each containing the metric's metadata
 * (name, description, type) and current state (values, counts, etc.).
 *
 * **Example** (Capturing metric snapshots)
 *
 * ```ts
 * import { Console, Data, Effect, Metric } from "effect"
 *
 * class SnapshotError extends Data.TaggedError("SnapshotError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create and update some metrics
 *   const requestCounter = Metric.counter("http_requests", {
 *     description: "Total HTTP requests"
 *   })
 *   const responseTime = Metric.histogram("response_time_ms", {
 *     description: "Response time in milliseconds",
 *     boundaries: Metric.linearBoundaries({ start: 0, width: 100, count: 5 })
 *   })
 *
 *   // Update the metrics with some values
 *   yield* Metric.update(requestCounter, 1)
 *   yield* Metric.update(requestCounter, 1)
 *   yield* Metric.update(responseTime, 150)
 *   yield* Metric.update(responseTime, 75)
 *
 *   // Take a snapshot of all metrics
 *   const snapshots = yield* Metric.snapshot
 *
 *   // Examine the snapshots
 *   for (const snapshot of snapshots) {
 *     yield* Console.log(`Metric: ${snapshot.id}`)
 *     yield* Console.log(`Description: ${snapshot.description}`)
 *     yield* Console.log(`Type: ${snapshot.type}`)
 *     yield* Console.log(`State:`, snapshot.state)
 *   }
 *
 *   return snapshots
 * })
 * ```
 *
 * @category Snapshotting
 * @since 2.0.0
 */
export const snapshot: Effect<ReadonlyArray<Metric.Snapshot>> = InternalEffect.map(
  InternalEffect.context(),
  (context) => snapshotUnsafe(context)
)

/**
 * Returns a human-readable string representation of all currently registered
 * metrics in a tabular format.
 *
 * **Details**
 *
 * This debugging utility captures a snapshot of all metrics and formats them
 * in an easy-to-read table showing names, descriptions, types, attributes,
 * and current state values.
 *
 * **Example** (Dumping metrics as text)
 *
 * ```ts
 * import { Console, Data, Effect, Metric } from "effect"
 *
 * class DumpError extends Data.TaggedError("DumpError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create and update some metrics for demonstration
 *   const requestCounter = Metric.counter("http_requests_total", {
 *     description: "Total HTTP requests"
 *   })
 *   const responseTime = Metric.gauge("response_time_ms", {
 *     description: "Current response time in milliseconds"
 *   })
 *   const statusFreq = Metric.frequency("http_status_codes", {
 *     description: "Frequency of HTTP status codes"
 *   })
 *
 *   // Update metrics with some values
 *   yield* Metric.update(requestCounter, 1)
 *   yield* Metric.update(requestCounter, 1)
 *   yield* Metric.update(responseTime, 125)
 *   yield* Metric.update(statusFreq, "200")
 *   yield* Metric.update(statusFreq, "404")
 *   yield* Metric.update(statusFreq, "200")
 *
 *   // Get formatted dump of all metrics
 *   const metricsReport = yield* Metric.dump
 *   yield* Console.log("Current Metrics:")
 *   yield* Console.log(metricsReport)
 *
 *   // Output will look like a formatted table:
 *   // Name                  Description                           Type       State
 *   // http_requests_total   Total HTTP requests                   Counter    [count: 2]
 *   // response_time_ms      Current response time in milliseconds Gauge      [value: 125]
 *   // http_status_codes     Frequency of HTTP status codes       Frequency  [occurrences: 200 -> 2, 404 -> 1]
 *
 *   return metricsReport
 * })
 * ```
 *
 * @category Debugging
 * @since 4.0.0
 */
export const dump: Effect<string> = InternalEffect.flatMap(InternalEffect.context(), (context) => {
  const metrics = snapshotUnsafe(context)
  if (metrics.length > 0) {
    const maxNameLength = metrics.reduce((max, metric) => {
      const length = metric.id.length
      return length > max ? length : max
    }, 0) + 2
    const maxDescriptionLength = metrics.reduce((max, metric) => {
      const length = Predicate.isNotUndefined(metric.description) ? metric.description.length : 0
      return length > max ? length : max
    }, 0) + 2
    const maxTypeLength = metrics.reduce((max, metric) => {
      const length = metric.type.length
      return length > max ? length : max
    }, 0) + 2
    const maxAttributesLength = metrics.reduce((max, metric) => {
      const length = Predicate.isNotUndefined(metric.attributes) ? attributesToString(metric.attributes).length : 0
      return length > max ? length : max
    }, 0) + 2
    const grouped = Object.entries(Arr.groupBy(metrics, (metric) => metric.id))
    const sorted = Arr.sortWith(grouped, (entry) => entry[0], _String.Order)
    const rendered = sorted.map(([, group]) =>
      group.map((metric) =>
        renderName(metric, maxNameLength) +
        renderDescription(metric, maxDescriptionLength) +
        renderType(metric, maxTypeLength) +
        renderAttributes(metric, maxAttributesLength) +
        renderState(metric)
      ).join("\n")
    ).join("\n")
    return InternalEffect.succeed(rendered)
  }
  return InternalEffect.succeed("")
})

/**
 * Captures a snapshot of all registered metrics synchronously using the provided
 * service context.
 *
 * **When to use**
 *
 * Use to read metric snapshots from an explicit `Context` in low-level
 * integrations, exporters, or debugging tools that already have the context.
 *
 * **Details**
 *
 * This is the "unsafe" version that bypasses Effect's safety guarantees and requires
 * manual handling of the services context. Use the safe `snapshot` function for normal
 * application code.
 *
 * **Example** (Capturing snapshots from a context)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class UnsafeSnapshotError extends Data.TaggedError("UnsafeSnapshotError")<{
 *   readonly operation: string
 * }> {}
 *
 * // Use unsafeSnapshot in performance-critical scenarios or internal implementations
 * const performanceMetricsExporter = Effect.gen(function*() {
 *   // Create some metrics first
 *   const requestCounter = Metric.counter("http_requests", {
 *     description: "Total HTTP requests"
 *   })
 *   const responseTime = Metric.gauge("response_time_ms", {
 *     description: "Current response time"
 *   })
 *
 *   // Update metrics
 *   yield* Metric.update(requestCounter, 1)
 *   yield* Metric.update(responseTime, 150)
 *
 *   // Get services context for unsafe operations
 *   const services = yield* Effect.context()
 *
 *   // Use snapshotUnsafe for direct, synchronous access
 *   const snapshots = Metric.snapshotUnsafe(services)
 *   const exportBatchCreatedAt = 1_700_000_000_000
 *
 *   // Process snapshots immediately (useful for exporters, debugging tools)
 *   const exportData = snapshots.map((snapshot) => ({
 *     name: snapshot.id,
 *     type: snapshot.type,
 *     value: snapshot.state,
 *     timestamp: exportBatchCreatedAt
 *   }))
 *
 *   // This is synchronous and doesn't involve Effect overhead
 *   // Useful for performance-critical metric export operations
 *   return exportData
 * })
 *
 * // For normal application use, prefer the safe snapshot function:
 * const safeSnapshotExample = Effect.gen(function*() {
 *   // This automatically handles the services context
 *   const snapshots = yield* Metric.snapshot
 *   return snapshots
 * })
 * ```
 *
 * @category Snapshotting
 * @since 4.0.0
 */
export const snapshotUnsafe = (context: Context.Context<never>): ReadonlyArray<Metric.Snapshot> => {
  const registry = Context.get(context, MetricRegistry)
  return Array.from(registry.values()).map(({ hooks, ...meta }) => ({
    ...meta,
    state: hooks.get(context)
  }))
}

const renderName = (metric: Metric.Snapshot, padTo: number): string => `name=${metric.id.padEnd(padTo, " ")}`

const renderDescription = (metric: Metric.Snapshot, padTo: number): string =>
  `description=${(metric.description ?? "").padEnd(padTo, " ")}`

const renderType = (metric: Metric.Snapshot, padTo: number): string => `type=${metric.type.padEnd(padTo, " ")}`

const renderAttributes = (metric: Metric.Snapshot, padTo: number): string => {
  const attrs = attributesToString(metric.attributes ?? {})
  const padding = " ".repeat(Math.max(0, padTo - attrs.length))
  return `${attrs}${padding}`
}

const renderState = (metric: Metric.Snapshot): string => {
  const prefix: string = "state="
  switch (metric.type) {
    case "Counter": {
      const state = metric.state as CounterState<number | bigint>
      return `${prefix}[count: [${state.count}]]`
    }
    case "Frequency": {
      const state = metric.state as FrequencyState
      return `${prefix}[occurrences: ${renderKeyValues(state.occurrences)}]`
    }
    case "Gauge": {
      const state = metric.state as GaugeState<number | bigint>
      return `${prefix}[value: [${state.value}]]`
    }
    case "Histogram": {
      const state = metric.state as HistogramState
      const buckets = `buckets: [${renderKeyValues(state.buckets)}]`
      const count = `count: [${state.count}]`
      const min = `min: [${state.min}]`
      const max = `max: [${state.max}]`
      const sum = `sum: [${state.sum}]`
      return `${prefix}[${buckets}, ${count}, ${min}, ${max}, ${sum}]`
    }
    case "Summary": {
      const state = metric.state as SummaryState
      const printableQuantiles = state.quantiles.map(([key, value]) => [key, value ?? 0] as [number, number])
      const quantiles = `quantiles: [${renderKeyValues(printableQuantiles)}]`
      const count = `count: [${state.count}]`
      const min = `min: [${state.min}]`
      const max = `max: [${state.max}]`
      const sum = `sum: [${state.sum}]`
      return `${prefix}[${quantiles}, ${count}, ${min}, ${max}, ${sum}]`
    }
  }
}

const renderKeyValues = (keyValues: Iterable<[number | string, string | number]>): string =>
  Array.from(keyValues).map(([key, value]) => `(${key} -> ${value})`).join(", ")

const attributesToString = (attributes: Metric.AttributeSet): string => {
  const attrs = Object.entries(attributes)
  const sorted = Arr.sortWith(attrs, (attr) => attr[0], _String.Order)
  return `attributes=[${sorted.map(([key, value]) => `${key}: ${value}`).join(", ")}]`
}

// Metric Boundaries

/**
 * Creates histogram bucket boundaries from an iterable set of values.
 *
 * **Details**
 *
 * Processes any iterable of numbers by removing duplicates, filtering out
 * non-positive values, and automatically appending positive infinity as the
 * final boundary.
 *
 * **Example** (Creating boundaries from values)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class BoundaryError extends Data.TaggedError("BoundaryError")<{
 *   readonly operation: string
 * }> {}
 *
 * // Create boundaries from an array of custom values
 * const customBoundaries = Metric.boundariesFromIterable([
 *   10,
 *   25,
 *   50,
 *   100,
 *   250,
 *   500,
 *   1000
 * ])
 * console.log(customBoundaries) // [10, 25, 50, 100, 250, 500, 1000, Infinity]
 *
 * // Automatically removes duplicates and negative values
 * const messyBoundaries = Metric.boundariesFromIterable([
 *   -5,
 *   0,
 *   10,
 *   10,
 *   25,
 *   25,
 *   50,
 *   -1
 * ])
 * console.log(messyBoundaries) // [10, 25, 50, Infinity]
 *
 * // Works with any iterable (Set, generator functions, etc.)
 * const setBoundaries = Metric.boundariesFromIterable(
 *   new Set([100, 200, 300, 200, 100])
 * )
 * console.log(setBoundaries) // [100, 200, 300, Infinity]
 *
 * // Use with histogram metric
 * const responseTimeHistogram = Metric.histogram("response_times", {
 *   description: "API response time distribution",
 *   boundaries: customBoundaries
 * })
 *
 * const program = Effect.gen(function*() {
 *   yield* Metric.update(responseTimeHistogram, 75) // Goes in 50-100ms bucket
 *   yield* Metric.update(responseTimeHistogram, 150) // Goes in 100-250ms bucket
 *
 *   const value = yield* Metric.value(responseTimeHistogram)
 *   return value
 * })
 * ```
 *
 * @category boundaries
 * @since 4.0.0
 */
export const boundariesFromIterable = (iterable: Iterable<number>): ReadonlyArray<number> =>
  Arr.append(Arr.filter(new Set(iterable), (n) => n > 0), Number.POSITIVE_INFINITY)

/**
 * Creates histogram bucket boundaries from a linear sequence and appends
 * positive infinity.
 *
 * **Details**
 *
 * Generates `count - 1` finite boundaries using `start + width + index` for
 * each zero-based index, then applies the same normalization as
 * `boundariesFromIterable`: non-positive values are removed, duplicates are
 * collapsed, and `Infinity` is appended.
 *
 * **Example** (Creating linear boundaries)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class BoundaryError extends Data.TaggedError("BoundaryError")<{
 *   readonly operation: string
 * }> {}
 *
 * // Create boundaries for response time histogram
 * const responseBoundaries = Metric.linearBoundaries({
 *   start: 0, // Starting point
 *   width: 100, // Offset used for the first boundary
 *   count: 5 // Creates 4 boundaries + infinity
 * })
 * console.log(responseBoundaries) // [100, 101, 102, 103, Infinity]
 *
 * // Create a histogram using these boundaries
 * const responseTimeHistogram = Metric.histogram("api_response_time", {
 *   description: "API response time distribution",
 *   boundaries: responseBoundaries
 * })
 *
 * const program = Effect.gen(function*() {
 *   // Record some response times
 *   yield* Metric.update(responseTimeHistogram, 85)
 *   yield* Metric.update(responseTimeHistogram, 101)
 *   yield* Metric.update(responseTimeHistogram, 450)
 *
 *   const value = yield* Metric.value(responseTimeHistogram)
 *   return value
 * })
 * ```
 *
 * @category boundaries
 * @since 4.0.0
 */
export const linearBoundaries = (options: {
  readonly start: number
  readonly width: number
  readonly count: number
}): ReadonlyArray<number> =>
  boundariesFromIterable(Arr.makeBy(options.count - 1, (n) => options.start + n + options.width))

/**
 * Creates histogram bucket boundaries with exponentially increasing values.
 *
 * **Details**
 *
 * Creates boundaries that grow exponentially, useful for metrics that span
 * multiple orders of magnitude. Each boundary is calculated as start * factor^i.
 *
 * **Example** (Creating exponential boundaries)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class BoundaryError extends Data.TaggedError("BoundaryError")<{
 *   readonly operation: string
 * }> {}
 *
 * // Create exponential boundaries for request size histogram
 * // Buckets: 0-1KB, 1-2KB, 2-4KB, 4-8KB, 8KB+
 * const sizeBoundaries = Metric.exponentialBoundaries({
 *   start: 1, // Starting at 1KB
 *   factor: 2, // Each boundary doubles the previous
 *   count: 5 // Creates 4 boundaries + infinity
 * })
 * console.log(sizeBoundaries) // [1, 2, 4, 8, Infinity]
 *
 * // Create a histogram for tracking request payload sizes
 * const requestSizeHistogram = Metric.histogram("request_size_kb", {
 *   description: "Request payload size distribution in KB",
 *   boundaries: sizeBoundaries
 * })
 *
 * // For very wide ranges, use larger factors
 * const latencyBoundaries = Metric.exponentialBoundaries({
 *   start: 0.1, // Start at 0.1ms
 *   factor: 10, // Each boundary is 10x larger
 *   count: 6 // Creates ranges: 0.1ms, 1ms, 10ms, 100ms, 1000ms+
 * })
 *
 * const program = Effect.gen(function*() {
 *   // Record different request sizes
 *   yield* Metric.update(requestSizeHistogram, 1.5) // Goes in 1-2KB bucket
 *   yield* Metric.update(requestSizeHistogram, 3.2) // Goes in 2-4KB bucket
 *   yield* Metric.update(requestSizeHistogram, 12) // Goes in 8KB+ bucket
 *
 *   const value = yield* Metric.value(requestSizeHistogram)
 *   return value
 * })
 * ```
 *
 * @category boundaries
 * @since 4.0.0
 */
export const exponentialBoundaries = (options: {
  readonly start: number
  readonly factor: number
  readonly count: number
}): ReadonlyArray<number> =>
  boundariesFromIterable(Arr.makeBy(options.count - 1, (i) => options.start * Math.pow(options.factor, i)))

// Fiber Runtime Metrics

const fibersActive = gauge("child_fibers_active", {
  description: "The current count of active child fibers"
})
const fibersStarted = counter("child_fibers_started", {
  description: "The total number of child fibers that have been started",
  incremental: true
})
const fiberSuccesses = counter("child_fiber_successes", {
  description: "The total number of child fibers that have succeeded",
  incremental: true
})
const fiberFailures = counter("child_fiber_failures", {
  description: "The total number of child fibers that have failed",
  incremental: true
})

/**
 * Service key for the fiber runtime metrics service.
 *
 * **Example** (Using the fiber runtime metrics key)
 *
 * ```ts
 * import { Data, Effect, Layer, Metric } from "effect"
 *
 * class MetricsError extends Data.TaggedError("MetricsError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // The key is used internally by the Effect runtime to manage fiber metrics
 *   const key = Metric.FiberRuntimeMetricsKey
 *   console.log("Fiber metrics key:", key)
 *
 *   // Enable runtime metrics using the key
 *   const layer = Layer.succeed(Metric.FiberRuntimeMetrics)(
 *     Metric.FiberRuntimeMetricsImpl
 *   )
 *
 *   return yield* Effect.gen(function*() {
 *     // This Effect will have fiber metrics automatically collected
 *     yield* Effect.sleep("100 millis")
 *
 *     // Create a test counter to demonstrate the key usage
 *     const testCounter = Metric.counter("test_counter")
 *     yield* Metric.update(testCounter, 1)
 *     return yield* Metric.value(testCounter)
 *   }).pipe(Effect.provide(layer))
 * })
 * ```
 *
 * @category metrics
 * @since 4.0.0
 */
export const FiberRuntimeMetricsKey: "effect/observability/Metric/FiberRuntimeMetricsKey" =
  InternalMetric.FiberRuntimeMetricsKey

/**
 * Interface for the fiber runtime metrics service that tracks fiber lifecycle events.
 *
 * **Example** (Providing a custom fiber metrics service)
 *
 * ```ts
 * import { Data, Effect, Layer, Metric } from "effect"
 * import type { Context, Exit } from "effect"
 *
 * class MetricsError extends Data.TaggedError("MetricsError")<{
 *   readonly operation: string
 * }> {}
 *
 * // Custom implementation of the metrics service
 * const customMetricsService: Metric.FiberRuntimeMetricsService = {
 *   recordFiberStart: (context: Context.Context<never>) => {
 *     console.log("Fiber started")
 *     // Custom logic for tracking fiber starts
 *   },
 *   recordFiberEnd: (
 *     context: Context.Context<never>,
 *     exit: Exit.Exit<unknown, unknown>
 *   ) => {
 *     console.log("Fiber completed with exit:", exit)
 *     // Custom logic for tracking fiber completion based on exit status
 *   }
 * }
 *
 * const program = Effect.gen(function*() {
 *   // Use the custom metrics service
 *   const layer = Layer.succeed(Metric.FiberRuntimeMetrics)(customMetricsService)
 *
 *   return yield* Effect.sleep("100 millis").pipe(Effect.provide(layer))
 * })
 * ```
 *
 * @category metrics
 * @since 4.0.0
 */
export interface FiberRuntimeMetricsService {
  readonly recordFiberStart: (context: Context.Context<never>) => void
  readonly recordFiberEnd: (context: Context.Context<never>, exit: Exit<unknown, unknown>) => void
}

/**
 * Context reference for the optional service that records fiber runtime
 * metrics.
 *
 * **When to use**
 *
 * Use to provide or inspect the service that receives fiber start and end
 * notifications for automatic runtime metrics.
 *
 * **Details**
 *
 * When provided, the runtime can notify the service about child-fiber start and
 * end events. When the reference is `undefined`, automatic fiber runtime metric
 * collection is disabled.
 *
 * **Example** (Accessing the fiber runtime metrics service)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class MetricsError extends Data.TaggedError("MetricsError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Access the fiber runtime metrics service
 *   const metricsService = yield* Metric.FiberRuntimeMetrics
 *
 *   if (metricsService) {
 *     console.log("Runtime metrics are enabled")
 *   } else {
 *     console.log("Runtime metrics are disabled")
 *   }
 *
 *   // Enable runtime metrics for the application
 *   const enabledLayer = Metric.enableRuntimeMetricsLayer
 *
 *   return yield* Effect.gen(function*() {
 *     // Create some concurrent fibers to see metrics in action
 *     yield* Effect.all([
 *       Effect.sleep("100 millis"),
 *       Effect.sleep("200 millis"),
 *       Effect.sleep("300 millis")
 *     ], { concurrency: "unbounded" })
 *
 *     // Create test metrics to demonstrate the service
 *     const testCounter = Metric.counter("test_counter")
 *     yield* Metric.update(testCounter, 5)
 *     const counterValue = yield* Metric.value(testCounter)
 *
 *     return { counterValue, metricsEnabled: true }
 *   }).pipe(Effect.provide(enabledLayer))
 * })
 * ```
 *
 * @category runtime metrics
 * @since 4.0.0
 */
export const FiberRuntimeMetrics = Context.Reference<FiberRuntimeMetricsService | undefined>(
  InternalMetric.FiberRuntimeMetricsKey,
  { defaultValue: constUndefined }
)

/**
 * Default implementation of the fiber runtime metrics service.
 *
 * **Example** (Using the default fiber metrics implementation)
 *
 * ```ts
 * import { Data, Effect, Layer, Metric } from "effect"
 *
 * class MetricsError extends Data.TaggedError("MetricsError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Use the default metrics implementation
 *   const metrics = Metric.FiberRuntimeMetricsImpl
 *   console.log("Metrics implementation:", metrics)
 *
 *   // Enable runtime metrics using the default implementation
 *   const layer = Layer.succeed(Metric.FiberRuntimeMetrics)(metrics)
 *
 *   return yield* Effect.gen(function*() {
 *     // Run some Effects to trigger metric collection
 *     yield* Effect.forkChild(Effect.sleep("50 millis"))
 *     yield* Effect.forkChild(Effect.sleep("100 millis"))
 *
 *     // Wait a bit and check the metrics
 *     yield* Effect.sleep("200 millis")
 *
 *     // Create test metrics to demonstrate the implementation
 *     const testCounter = Metric.counter("test_counter")
 *     const testGauge = Metric.gauge("test_gauge")
 *     yield* Metric.update(testCounter, 3)
 *     yield* Metric.update(testGauge, 42)
 *
 *     const counterValue = yield* Metric.value(testCounter)
 *     const gaugeValue = yield* Metric.value(testGauge)
 *
 *     return { counter: counterValue, gauge: gaugeValue }
 *   }).pipe(Effect.provide(layer))
 * })
 * ```
 *
 * @category metrics
 * @since 4.0.0
 */
export const FiberRuntimeMetricsImpl: FiberRuntimeMetricsService = {
  recordFiberStart(context: Context.Context<never>) {
    fibersStarted.updateUnsafe(1, context)
    fibersActive.modifyUnsafe(1, context)
  },
  recordFiberEnd(context: Context.Context<never>, exit: Exit<unknown, unknown>) {
    fibersActive.modifyUnsafe(-1, context)
    if (InternalEffect.exitIsSuccess(exit)) {
      fiberSuccesses.updateUnsafe(1, context)
    } else {
      fiberFailures.updateUnsafe(1, context)
    }
  }
}

/**
 * Layer that enables automatic collection of fiber runtime metrics across
 * an entire Effect application.
 *
 * **When to use**
 *
 * Use when you need runtime metrics collection for all Effects in the
 * application context rather than wrapping individual Effects.
 *
 * **Example** (Enabling runtime metrics with a layer)
 *
 * ```ts
 * import { Console, Data, Effect, Layer, Metric } from "effect"
 *
 * class AppError extends Data.TaggedError("AppError")<{
 *   readonly operation: string
 * }> {}
 *
 * // Define your application logic
 * const userService = Effect.gen(function*() {
 *   // Simulate user operations with concurrent processing
 *   const fetchUser = (id: number) =>
 *     Effect.gen(function*() {
 *       yield* Effect.sleep(`${50 + id * 10} millis`)
 *       if (id % 7 === 0) {
 *         return yield* new AppError({ operation: `fetch-user-${id}` })
 *       }
 *       return { id, name: `User ${id}`, email: `user${id}@example.com` }
 *     })
 *
 *   // Process multiple users concurrently (ignoring failures for demo)
 *   const userIds = Array.from({ length: 10 }, (_, i) => i + 1)
 *   const userTasks = userIds.map((id) =>
 *     fetchUser(id).pipe(Effect.catchTag("AppError", () => Effect.succeed(null)))
 *   )
 *   const allUsers = yield* Effect.all(userTasks, { concurrency: 4 })
 *   const successfulUsers = allUsers.filter((user) => user !== null)
 *   return successfulUsers
 * })
 *
 * const analyticsService = Effect.gen(function*() {
 *   // Simulate analytics processing
 *   const tasks = Array.from({ length: 8 }, (_, i) =>
 *     Effect.gen(function*() {
 *       yield* Effect.sleep(`${100 + i * 25} millis`)
 *       return `Analytics task ${i} completed`
 *     }))
 *   return yield* Effect.all(tasks, { concurrency: 3 })
 * })
 *
 * // Main application that uses multiple services
 * const application = Effect.gen(function*() {
 *   yield* Console.log("Starting application with runtime metrics...")
 *
 *   // Run services concurrently
 *   const [users, analytics] = yield* Effect.all([
 *     userService,
 *     analyticsService
 *   ], { concurrency: 2 })
 *
 *   yield* Console.log(
 *     `Processed ${users.length} users and ${analytics.length} analytics tasks`
 *   )
 *
 *   // Inspect the automatically collected runtime metrics
 *   const metrics = yield* Metric.snapshot
 *   const runtimeMetrics = metrics.filter((m) => m.id.startsWith("child_fiber"))
 *
 *   yield* Console.log("Runtime Metrics Collected:")
 *   for (const metric of runtimeMetrics) {
 *     yield* Console.log(`  ${metric.id}: ${JSON.stringify(metric.state)}`)
 *   }
 *
 *   return { users, analytics, metricsCount: runtimeMetrics.length }
 * })
 *
 * // Create the base application layer
 * const AppLayer = Layer.empty // Add your application layers here (database, HTTP, etc.)
 *
 * // Add runtime metrics layer at the end
 * const AppLayerWithMetrics = AppLayer.pipe(
 *   Layer.provide(Metric.enableRuntimeMetricsLayer)
 * )
 *
 * // Run the application with runtime metrics enabled
 * const program = application.pipe(
 *   Effect.provide(AppLayerWithMetrics)
 * )
 *
 * // Alternative: Provide runtime metrics directly to the application
 * const programWithDirectMetrics = application.pipe(
 *   Effect.provide(Metric.enableRuntimeMetricsLayer)
 * )
 * ```
 *
 * @category metrics
 * @since 4.0.0
 */
export const enableRuntimeMetricsLayer = Layer.succeed(FiberRuntimeMetrics)(FiberRuntimeMetricsImpl)

/**
 * Layer that disables automatic collection of fiber runtime metrics.
 *
 * **Example** (Disabling runtime metrics with a layer)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class MetricsError extends Data.TaggedError("MetricsError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Disable runtime metrics collection
 *   const disabledLayer = Metric.disableRuntimeMetricsLayer
 *
 *   return yield* Effect.gen(function*() {
 *     // Check that metrics service is disabled
 *     const metricsService = yield* Metric.FiberRuntimeMetrics
 *     console.log("Metrics enabled:", metricsService !== undefined) // false
 *
 *     // Run some Effects - no metrics will be collected
 *     yield* Effect.forkChild(Effect.sleep("50 millis"))
 *     yield* Effect.forkChild(Effect.sleep("100 millis"))
 *     yield* Effect.sleep("200 millis")
 *
 *     // Create test metrics to show they still work
 *     const testCounter = Metric.counter("test_counter")
 *     yield* Metric.update(testCounter, 1)
 *     const counterValue = yield* Metric.value(testCounter)
 *
 *     return { counterValue, metricsEnabled: metricsService !== undefined }
 *   }).pipe(Effect.provide(disabledLayer))
 * })
 * ```
 *
 * @category metrics
 * @since 4.0.0
 */
export const disableRuntimeMetricsLayer = Layer.succeed(FiberRuntimeMetrics)(undefined)

/**
 * Enables automatic collection of fiber runtime metrics for the provided Effect.
 *
 * **Details**
 *
 * When enabled, automatically tracks fiber lifecycle metrics including active fibers,
 * started fibers, successful completions, and failures. These metrics provide valuable
 * insights into the concurrency patterns and health of your Effect application.
 *
 * **Example** (Enabling runtime metrics for an effect)
 *
 * ```ts
 * import { Console, Data, Effect, Layer, Metric } from "effect"
 *
 * class RuntimeMetricsError extends Data.TaggedError("RuntimeMetricsError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // Create a concurrent workload to demonstrate fiber metrics
 *   const heavyWorkload = Effect.gen(function*() {
 *     // Simulate concurrent operations
 *     const tasks = Array.from({ length: 10 }, (_, i) =>
 *       Effect.gen(function*() {
 *         yield* Effect.sleep(`${100 + i * 50} millis`)
 *         if (i % 4 === 0) {
 *           // Simulate some failures
 *           return yield* new RuntimeMetricsError({ operation: `task-${i}` })
 *         }
 *         return `Task ${i} completed`
 *       }).pipe(
 *         Effect.catchTag("RuntimeMetricsError", () =>
 *           Effect.succeed(`Task ${i} failed`))
 *       ))
 *
 *     // Run tasks concurrently
 *     const results = yield* Effect.all(tasks, { concurrency: 5 })
 *     return results
 *   })
 *
 *   // Enable runtime metrics collection for our workload
 *   const workloadWithMetrics = Metric.enableRuntimeMetrics(heavyWorkload)
 *
 *   // Execute the workload
 *   const results = yield* workloadWithMetrics
 *
 *   // After execution, we can inspect the runtime metrics
 *   // The following metrics are automatically collected:
 *   // - child_fibers_active: Current number of active child fibers (Gauge)
 *   // - child_fibers_started: Total child fibers started (Counter, incremental)
 *   // - child_fiber_successes: Total successful child fibers (Counter, incremental)
 *   // - child_fiber_failures: Total failed child fibers (Counter, incremental)
 *
 *   yield* Console.log(`Workload completed with ${results.length} results`)
 *
 *   // Get all metrics including the runtime metrics
 *   const allMetrics = yield* Metric.snapshot
 *   const runtimeMetrics = allMetrics.filter((m) =>
 *     m.id.startsWith("child_fiber") || m.id.includes("fiber")
 *   )
 *
 *   yield* Console.log("Runtime Metrics:")
 *   for (const metric of runtimeMetrics) {
 *     yield* Console.log(`  ${metric.id}: ${JSON.stringify(metric.state)}`)
 *   }
 *
 *   return results
 * })
 *
 * // Alternative: Use the layer version for broader application coverage
 * const BaseAppLayer = Layer.empty // Your base application layers
 * const AppLayerWithMetrics = BaseAppLayer.pipe(
 *   Layer.provide(Metric.enableRuntimeMetricsLayer)
 * )
 * const programWithLayer = program.pipe(
 *   Effect.provide(AppLayerWithMetrics)
 * )
 * ```
 *
 * @category metrics
 * @since 4.0.0
 */
export const enableRuntimeMetrics: <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R> = InternalEffect.provideService(
  FiberRuntimeMetrics,
  FiberRuntimeMetricsImpl
)

/**
 * Disables automatic collection of fiber runtime metrics for the provided Effect.
 *
 * **When to use**
 *
 * Use when this is useful when you want to selectively disable runtime metrics for specific
 * parts of your application while keeping them enabled elsewhere, or when you need
 * to avoid the overhead of metrics collection in performance-critical sections.
 *
 * **Example** (Disabling runtime metrics for an effect)
 *
 * ```ts
 * import { Console, Data, Effect, Layer, Metric } from "effect"
 *
 * class DisableMetricsError extends Data.TaggedError("DisableMetricsError")<{
 *   readonly operation: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   // This section will have runtime metrics enabled
 *   const normalOperation = Effect.gen(function*() {
 *     const tasks = Array.from({ length: 5 }, (_, i) =>
 *       Effect.gen(function*() {
 *         yield* Effect.sleep(`${100 + i * 20} millis`)
 *         return `Normal task ${i} completed`
 *       }))
 *     return yield* Effect.all(tasks, { concurrency: 3 })
 *   })
 *
 *   // This section will have runtime metrics disabled for performance
 *   const highPerformanceOperation = Metric.disableRuntimeMetrics(
 *     Effect.gen(function*() {
 *       // Performance-critical code where metrics overhead should be avoided
 *       const hotPath = Array.from(
 *         { length: 1000 },
 *         (_, i) =>
 *           Effect.gen(function*() {
 *             // Simulate intensive computation
 *             const result = i * i + (i % 10) / 10
 *             return result
 *           })
 *       )
 *       return yield* Effect.all(hotPath, { concurrency: 100 })
 *     })
 *   )
 *
 *   yield* Console.log("Running operations with selective metrics...")
 *
 *   // Run both operations
 *   const [normalResults, performanceResults] = yield* Effect.all([
 *     normalOperation, // Will generate fiber metrics
 *     highPerformanceOperation // Will NOT generate fiber metrics
 *   ])
 *
 *   // Check collected metrics - should only see metrics from normalOperation
 *   const metrics = yield* Metric.snapshot
 *   const runtimeMetrics = metrics.filter((m) => m.id.startsWith("child_fiber"))
 *
 *   yield* Console.log(`Normal operation results: ${normalResults.length}`)
 *   yield* Console.log(
 *     `Performance operation results: ${performanceResults.length}`
 *   )
 *   yield* Console.log(`Runtime metrics collected: ${runtimeMetrics.length}`)
 *
 *   // The runtime metrics will only reflect the fibers from normalOperation
 *   // The highPerformanceOperation fibers were not tracked due to disableRuntimeMetrics
 *
 *   return { normalResults, performanceResults, runtimeMetrics }
 * })
 *
 * // Enable runtime metrics globally, then selectively disable where needed
 * const BaseAppLayer = Layer.empty // Your base application layers
 * const AppLayerWithMetrics = BaseAppLayer.pipe(
 *   Layer.provide(Metric.enableRuntimeMetricsLayer)
 * )
 * const finalProgram = program.pipe(
 *   Effect.provide(AppLayerWithMetrics)
 * )
 * ```
 *
 * @category metrics
 * @since 4.0.0
 */
export const disableRuntimeMetrics: <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R> = InternalEffect.provideService(
  FiberRuntimeMetrics,
  undefined
)

// Utilities

function makeKey<Input, State>(
  metric: Metric<Input, State>,
  attributes: Metric.Attributes | undefined
) {
  let key = `${metric.type}:${metric.id}`
  if (Predicate.isNotUndefined(metric.description)) {
    key += `:${metric.description}`
  }
  if (Predicate.isNotUndefined(attributes)) {
    key += `:${serializeAttributes(attributes)}`
  }
  return key
}

function makeHooks<Input, State>(
  get: (context: Context.Context<never>) => State,
  update: (input: Input, context: Context.Context<never>) => void,
  modify?: (input: Input, context: Context.Context<never>) => void
): Metric.Hooks<Input, State> {
  return { get, update, modify: modify ?? update }
}

function serializeAttributes(attributes: Metric.Attributes): string {
  return serializeEntries(Array.isArray(attributes) ? attributes : Object.entries(attributes))
}

function serializeEntries(entries: ReadonlyArray<[string, string]>): string {
  return entries.map(([key, value]) => `${key}=${value}`).join(",")
}

function mergeAttributes(
  self: Metric.Attributes | undefined,
  other: Metric.Attributes | undefined
): Metric.AttributeSet {
  return { ...attributesToRecord(self), ...attributesToRecord(other) }
}

function attributesToRecord(attributes?: Metric.Attributes): Metric.AttributeSet | undefined {
  if (Predicate.isNotUndefined(attributes) && Array.isArray(attributes)) {
    return attributes.reduce((acc, [key, value]) => {
      acc[key] = value
      return acc
    }, {} as Metric.AttributeSet)
  }
  return attributes as Metric.AttributeSet | undefined
}

function addAttributesToContext(
  context: Context.Context<never>,
  attributes: Metric.Attributes
): Context.Context<never> {
  const current = Context.get(context, CurrentMetricAttributes)
  const updated = mergeAttributes(current, attributes)
  return Context.add(context, CurrentMetricAttributes, updated)
}
