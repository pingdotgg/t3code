/**
 * The `Clock` module provides functionality for time-based operations in Effect applications.
 * It offers precise time measurements, scheduling capabilities, and controlled time management
 * for testing scenarios.
 *
 * The Clock service is a core component of the Effect runtime, providing:
 * - Current time access in milliseconds and nanoseconds
 * - Sleep operations for delaying execution
 * - Time-based scheduling primitives
 * - Testable time control through `TestClock`
 *
 * ## Key Features
 *
 * - **Precise timing**: Access to both millisecond and nanosecond precision
 * - **Sleep operations**: Non-blocking sleep with proper interruption handling
 * - **Service integration**: Seamless integration with Effect's dependency injection
 * - **Testable**: Mock time control for deterministic testing
 * - **Resource-safe**: Automatic cleanup of time-based resources
 *
 * **Example** (Measuring elapsed time)
 *
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * // Get current time in milliseconds
 * const getCurrentTime = Clock.currentTimeMillis
 *
 * // Sleep for 1 second
 * const sleep1Second = Effect.sleep("1 seconds")
 *
 * // Measure execution time
 * const measureTime = Effect.gen(function*() {
 *   const start = yield* Clock.currentTimeMillis
 *   yield* Effect.sleep("100 millis")
 *   const end = yield* Clock.currentTimeMillis
 *   return end - start
 * })
 * ```
 *
 * **Example** (Using the Clock service)
 *
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * // Using Clock service directly
 * const program = Effect.gen(function*() {
 *   const clock = yield* Clock.Clock
 *   const currentTime = yield* clock.currentTimeMillis
 *   console.log(`Current time: ${currentTime}`)
 *
 *   // Sleep for 500ms
 *   yield* Effect.sleep("500 millis")
 *
 *   const afterSleep = yield* clock.currentTimeMillis
 *   console.log(`After sleep: ${afterSleep}`)
 * })
 * ```
 *
 * @since 2.0.0
 */
import type * as Context from "./Context.ts"
import type * as Duration from "./Duration.ts"
import type { Effect } from "./Effect.ts"
import * as effect from "./internal/effect.ts"

/**
 * Represents a time-based clock which provides functionality related to time
 * and scheduling.
 *
 * **When to use**
 *
 * Use to define or provide a clock service for current-time and sleep
 * operations.
 *
 * **Example** (Reading current time)
 *
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * const clockOperations = Effect.gen(function*() {
 *   const currentTime = yield* Clock.currentTimeMillis
 *   const currentTimeNanos = yield* Clock.currentTimeNanos
 *
 *   console.log(`Current time (ms): ${currentTime}`)
 *   console.log(`Current time (ns): ${currentTimeNanos}`)
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Clock {
  /**
   * Returns the current time in milliseconds unsafely.
   *
   * **When to use**
   *
   * Use to read millisecond time synchronously when you already have a `Clock`
   * service and can accept non-effectful access.
   */
  currentTimeMillisUnsafe(): number
  /**
   * Returns the current time in milliseconds.
   *
   * **When to use**
   *
   * Use to read millisecond time through this `Clock` service in `Effect`.
   */
  readonly currentTimeMillis: Effect<number>
  /**
   * Returns the current time in nanoseconds unsafely.
   *
   * **When to use**
   *
   * Use to read nanosecond time synchronously when you already have a `Clock`
   * service and can accept non-effectful access.
   */
  currentTimeNanosUnsafe(): bigint
  /**
   * Returns the current time in nanoseconds.
   *
   * **When to use**
   *
   * Use to read nanosecond time through this `Clock` service in `Effect`.
   */
  readonly currentTimeNanos: Effect<bigint>
  /**
   * Asynchronously sleeps for the specified duration.
   *
   * **When to use**
   *
   * Use to delay an `Effect` workflow by a duration through this `Clock` service.
   */
  sleep(duration: Duration.Duration): Effect<void>
}

/**
 * Context reference for the current Clock service in the environment.
 *
 * **When to use**
 *
 * Use when you need to access or provide the full Clock service rather than a
 * single timestamp accessor.
 *
 * **Example** (Accessing the Clock service)
 *
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const clock = yield* Clock.Clock
 *   return clock.currentTimeMillisUnsafe()
 * })
 * ```
 *
 * @see {@link clockWith} for using the current Clock service inside an effect
 * @see {@link currentTimeMillis} for reading the current time in milliseconds
 * @see {@link currentTimeNanos} for reading the current time in nanoseconds
 *
 * @category references
 * @since 2.0.0
 */
export const Clock: Context.Reference<Clock> = effect.ClockRef

/**
 * Accesses the current Clock service and uses it to run the provided function.
 *
 * **When to use**
 *
 * Use when you need the full Clock service interface to perform multiple time
 * operations or call unsafe variants within a single effect.
 *
 * **Example** (Using the current Clock service)
 *
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * const program = Clock.clockWith((clock) =>
 *   Effect.sync(() => {
 *     const currentTime = clock.currentTimeMillisUnsafe()
 *     console.log(`Current time: ${currentTime}`)
 *     return currentTime
 *   })
 * )
 * ```
 *
 * @see {@link Clock} for the service reference
 * @see {@link currentTimeMillis} for convenience accessor that returns milliseconds
 * @see {@link currentTimeNanos} for convenience accessor that returns nanoseconds
 * @category constructors
 * @since 2.0.0
 */
export const clockWith: <A, E, R>(f: (clock: Clock) => Effect<A, E, R>) => Effect<A, E, R> = effect.clockWith

/**
 * Returns an Effect that succeeds with the current time in milliseconds.
 *
 * **When to use**
 *
 * Use to read wall-clock time from the active Clock service with millisecond
 * precision.
 *
 * **Example** (Reading milliseconds)
 *
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const currentTime = yield* Clock.currentTimeMillis
 *   console.log(`Current time: ${currentTime}ms`)
 *   return currentTime
 * })
 * ```
 *
 * @see {@link currentTimeNanos} for nanosecond precision
 * @see {@link clockWith} for accessing the full Clock service
 *
 * @category constructors
 * @since 2.0.0
 */
export const currentTimeMillis: Effect<number> = effect.currentTimeMillis

/**
 * Returns an Effect that succeeds with the current time in nanoseconds.
 *
 * **When to use**
 *
 * Use to read wall-clock time from the active `Clock` service with nanosecond
 * precision.
 *
 * **Example** (Reading nanoseconds)
 *
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const currentTime = yield* Clock.currentTimeNanos
 *   console.log(`Current time: ${currentTime}ns`)
 *   return currentTime
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const currentTimeNanos: Effect<bigint> = effect.currentTimeNanos
