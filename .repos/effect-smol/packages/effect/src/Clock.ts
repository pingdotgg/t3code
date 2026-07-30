/**
 * Service and helpers for reading time and sleeping inside Effect programs.
 * The active `Clock` provides current time in milliseconds or nanoseconds and a
 * `sleep` operation for delaying work. Because time is accessed through a
 * service, tests can replace the clock with a controlled implementation.
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
 * Context reference for the active time service in the environment.
 *
 * **When to use**
 *
 * Use when you need to access or provide the full time service, including sleep
 * operations, rather than a single timestamp accessor.
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
 * **Example** (Accessing the current Clock service)
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
