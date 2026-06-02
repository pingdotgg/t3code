/**
 * Declarative policies for retrying, repeating, and pacing Effect programs.
 *
 * A `Schedule<Output, Input, Error, Env>` is a stateful policy that is stepped
 * with an input value. Each step either stops the recurrence or emits an output
 * together with the delay before the next step. Schedules are values: they can
 * be transformed, combined, and passed to retry, repeat, stream, and channel
 * APIs without running anything until the surrounding Effect program runs.
 *
 * **Mental model**
 *
 * - Constructors such as {@link recurs}, {@link spaced}, {@link fixed},
 *   {@link exponential}, and {@link fibonacci} define the base cadence or
 *   stopping rule.
 * - Combinators such as {@link both}, {@link either}, and {@link andThen}
 *   combine schedules and determine both stopping behavior and output shape.
 * - Delay helpers such as {@link addDelay}, {@link modifyDelay}, and
 *   {@link jittered} adjust pacing while preserving the schedule's control
 *   flow.
 * - Metadata-aware constructors and {@link CurrentMetadata} expose attempts,
 *   elapsed time, input, output, and duration for advanced policies.
 *
 * **Common tasks**
 *
 * - Retry a failing effect with exponential backoff and a maximum retry count.
 * - Repeat a successful effect on a fixed or spaced interval.
 * - Add jitter so concurrent clients do not retry at the same instant.
 * - Transform or retain schedule outputs with {@link map},
 *   {@link collectOutputs}, and {@link take}.
 *
 * **Example** (Retrying with bounded exponential backoff)
 *
 * ```ts
 * import { Effect, Schedule } from "effect"
 *
 * let attempts = 0
 *
 * const request = Effect.sync(() => {
 *   attempts += 1
 *   return attempts
 * }).pipe(
 *   Effect.flatMap((attempt) =>
 *     attempt < 3 ? Effect.fail("temporary failure") : Effect.succeed("ok")
 *   )
 * )
 *
 * const policy = Schedule.exponential("100 millis").pipe(
 *   Schedule.jittered,
 *   Schedule.both(Schedule.recurs(5))
 * )
 *
 * const program = Effect.retry(request, policy)
 * ```
 *
 * **Gotchas**
 *
 * - A schedule is a description; delays happen only when an operation such as
 *   `Effect.retry` or `Effect.repeat` runs it.
 * - `Schedule.recurs(3)` allows three recurrences in addition to the first run
 *   performed by retry or repeat.
 * - Combining schedules changes the output type as well as the stopping rule,
 *   so check the resulting type when using {@link both}, {@link either}, or
 *   {@link andThen}.
 *
 * @since 2.0.0
 */
import * as Cause from "./Cause.ts"
import * as Context from "./Context.ts"
import * as Cron from "./Cron.ts"
import type * as DateTime from "./DateTime.ts"
import * as Duration from "./Duration.ts"
import type { Effect } from "./Effect.ts"
import type { LazyArg } from "./Function.ts"
import { constant, dual, identity } from "./Function.ts"
import { isEffect } from "./internal/core.ts"
import * as effect from "./internal/effect.ts"
import * as random from "./internal/random.ts"
import { type Pipeable, pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import * as Pull from "./Pull.ts"
import * as Result from "./Result.ts"
import type { Contravariant, Covariant, Mutable } from "./Types.ts"

const TypeId = "~effect/Schedule"

const randomNext: Effect<number> = random.Random.useSync((random) => random.nextDoubleUnsafe())

/**
 * A Schedule defines a strategy for repeating or retrying effects based on some policy.
 *
 * **Example** (Defining retry and repeat schedules)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class NetworkError extends Data.TaggedError("NetworkError")<{
 *   readonly attempt: number
 * }> {}
 *
 * // Basic retry schedule - retry up to 3 times with exponential backoff
 * const retrySchedule = Schedule.exponential("100 millis").pipe(
 *   Schedule.both(Schedule.recurs(3))
 * )
 *
 * // Basic repeat schedule - repeat every 30 seconds forever
 * const repeatSchedule: Schedule.Schedule<number, unknown, never> = Schedule
 *   .spaced("30 seconds")
 *
 * const program = Effect.gen(function*() {
 *   let attempts = 0
 *
 *   const result1 = yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempts++
 *       if (attempts < 3) {
 *         return yield* Effect.fail(new NetworkError({ attempt: attempts }))
 *       }
 *       return "Success"
 *     }),
 *     retrySchedule
 *   )
 *   console.log(result1) // "Success"
 *
 *   yield* Console.log("heartbeat").pipe(
 *     Effect.repeat(repeatSchedule.pipe(Schedule.take(5)))
 *   )
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Schedule<out Output, in Input = unknown, out Error = never, out Env = never>
  extends Schedule.Variance<Output, Input, Error, Env>, Pipeable
{}

/**
 * Metadata provided to schedule functions containing timing and input information.
 *
 * **Example** (Reading schedule input metadata)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Custom schedule that uses input metadata
 * const metadataAwareSchedule = Schedule.spaced("1 second").pipe(
 *   Schedule.collectWhile((metadata) =>
 *     Effect.succeed(metadata.attempt <= 5 && metadata.elapsed < 10000)
 *   )
 * )
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Console.log("Task execution"),
 *     metadataAwareSchedule
 *   )
 * })
 * ```
 *
 * @category metadata
 * @since 4.0.0
 */
export interface InputMetadata<Input> {
  readonly input: Input
  readonly attempt: number
  readonly start: number
  readonly now: number
  readonly elapsed: number
  readonly elapsedSincePrevious: number
}

/**
 * Extended metadata that includes both input metadata and the output value from the schedule.
 *
 * **Example** (Logging schedule output metadata)
 *
 * ```ts
 * import { Console, Duration, Effect, Schedule } from "effect"
 *
 * // Custom schedule that logs metadata and output for each recurrence
 * const loggingSchedule = Schedule.unfold(0, (n) => Effect.succeed(n + 1)).pipe(
 *   Schedule.addDelay(() => Effect.succeed(Duration.millis(100))),
 *   Schedule.collectWhile((metadata) =>
 *     Console.log(
 *       `Output: ${metadata.output}, attempt: ${metadata.attempt}, elapsed: ${metadata.elapsed}ms`
 *     ).pipe(Effect.as(metadata.attempt <= 3))
 *   )
 * )
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.succeed("task completed"),
 *     loggingSchedule.pipe(Schedule.take(3))
 *   )
 * })
 *
 * // Output logs will show:
 * // Output: 0, attempt: 1, elapsed: 0ms
 * // Output: 1, attempt: 2, elapsed: 100ms
 * // Output: 2, attempt: 3, elapsed: 200ms
 * ```
 *
 * @category metadata
 * @since 4.0.0
 */
export interface Metadata<Output = unknown, Input = unknown> extends InputMetadata<Input> {
  readonly output: Output
  readonly duration: Duration.Duration
}

/**
 * Context reference containing metadata for the currently running schedule step.
 *
 * **Details**
 *
 * Repeat, retry, stream, and channel scheduling operations provide this service
 * to effects run between schedule steps. The default value contains undefined
 * input and output values, zero duration, and zeroed timing fields before any
 * schedule step has produced metadata.
 *
 * @category metadata
 * @since 4.0.0
 */
export const CurrentMetadata = Context.Reference<Metadata>("effect/Schedule/CurrentMetadata", {
  defaultValue: constant({
    input: undefined,
    output: undefined,
    duration: Duration.zero,
    attempt: 0,
    start: 0,
    now: 0,
    elapsed: 0,
    elapsedSincePrevious: 0
  })
})

/**
 * The Schedule namespace contains types and utilities for working with schedules.
 *
 * **Example** (Creating custom schedules with the namespace)
 *
 * ```ts
 * import { Duration, Effect, Schedule } from "effect"
 *
 * // Usage of the Schedule namespace for creating schedules
 *
 * // Create custom schedule with metadata
 * const customSchedule = Schedule.unfold(0, (n) => Effect.succeed(n + 1)).pipe(
 *   Schedule.addDelay((n) => Effect.succeed(Duration.millis(n * 100)))
 * )
 *
 * const program = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       if (attempt < 3) {
 *         return yield* Effect.fail(`Attempt ${attempt} failed`)
 *       }
 *       return `Success on attempt ${attempt}`
 *     }),
 *     customSchedule.pipe(Schedule.take(5))
 *   )
 * })
 * ```
 *
 * @since 2.0.0
 */
export declare namespace Schedule {
  /**
   * Variance interface that defines the type parameter relationships for Schedule.
   *
   * **Example** (Understanding schedule variance)
   *
   * ```ts
   * import { Effect, Schedule } from "effect"
   *
   * // Understanding Schedule variance:
   * // - Output: covariant (can be a subtype)
   * // - Input: contravariant (can accept supertypes)
   * // - Error: covariant (can be a subtype)
   * // - Env: covariant (can be a subtype)
   *
   * // Schedule that produces strings, accepts any input
   * const stringSchedule = Schedule.spaced("1 second").pipe(
   *   Schedule.map(() => Effect.succeed("tick"))
   * )
   *
   * // Schedule that only accepts Error inputs
   * const errorSchedule = Schedule.exponential("100 millis").pipe(
   *   Schedule.take(5)
   * )
   *
   * // Schedule requiring a service environment
   * const serviceSchedule = Schedule.spaced("5 seconds")
   * ```
   *
   * @category models
   * @since 2.0.0
   */
  export interface Variance<out Output, in Input, out Error, out Env> {
    readonly [TypeId]: VarianceStruct<Output, Input, Error, Env>
  }

  /**
   * Type-level marker used by `Schedule.Variance` to record the variance of
   * `Schedule` type parameters.
   *
   * **Details**
   *
   * This interface exists for TypeScript inference and assignability. Users
   * normally do not construct or inspect it directly.
   *
   * @category models
   * @since 4.0.0
   */
  export interface VarianceStruct<out Output, in Input, out Error, out Env> {
    readonly _Out: Covariant<Output>
    readonly _In: Contravariant<Input>
    readonly _Error: Covariant<Error>
    readonly _Env: Covariant<Env>
  }
}

const ScheduleProto = {
  [TypeId]: {
    _Out: identity,
    _In: identity,
    _Env: identity
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * Type guard that checks if a value is a Schedule.
 *
 * **Example** (Checking for schedules)
 *
 * ```ts
 * import { Schedule } from "effect"
 *
 * const schedule = Schedule.exponential("100 millis")
 * const notSchedule = { foo: "bar" }
 *
 * console.log(Schedule.isSchedule(schedule)) // true
 * console.log(Schedule.isSchedule(notSchedule)) // false
 * console.log(Schedule.isSchedule(null)) // false
 * console.log(Schedule.isSchedule(undefined)) // false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isSchedule = (u: unknown): u is Schedule<unknown, never, unknown, unknown> => hasProperty(u, TypeId)

/**
 * Creates a Schedule from a step function that returns a Pull.
 *
 * **Example** (Creating a custom schedule from a step function)
 *
 * ```ts
 * import { Cause, Duration, Effect, Schedule } from "effect"
 *
 * const schedule = Schedule.fromStep(Effect.sync(() => {
 *   let count = 0
 *
 *   return (_now: number, _input: string) => {
 *     if (count >= 3) {
 *       return Cause.done(count)
 *     }
 *     return Effect.succeed([count++, Duration.millis(100)] as [number, Duration.Duration])
 *   }
 * }))
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromStep = <Input, Output, EnvX, Error, ErrorX, Env>(
  step: Effect<
    (now: number, input: Input) => Pull.Pull<[Output, Duration.Duration], ErrorX, Output, EnvX>,
    Error,
    Env
  >
): Schedule<Output, Input, Error | Pull.ExcludeDone<ErrorX>, Env | EnvX> => {
  const self = Object.create(ScheduleProto)
  self.step = step
  return self
}

const metadataFn = () => {
  let n = 0
  let previous: number | undefined
  let start: number | undefined
  return <In>(now: number, input: In): InputMetadata<In> => {
    if (start === undefined) start = now
    const elapsed = now - start
    const elapsedSincePrevious = previous === undefined ? 0 : now - previous
    previous = now
    return { input, attempt: ++n, start, now, elapsed, elapsedSincePrevious }
  }
}

/**
 * Creates a Schedule from a step function that receives metadata about the schedule's execution.
 *
 * **Example** (Creating a metadata-aware schedule)
 *
 * ```ts
 * import { Cause, Duration, Effect, Schedule } from "effect"
 *
 * const firstThreeInputs = Schedule.fromStepWithMetadata(Effect.succeed((metadata: Schedule.InputMetadata<string>) => {
 *   if (metadata.attempt > 3) {
 *     return Cause.done("finished")
 *   }
 *
 *   return Effect.succeed([
 *     `attempt ${metadata.attempt}: ${metadata.input}`,
 *     Duration.millis(250)
 *   ] as [string, Duration.Duration])
 * }))
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromStepWithMetadata = <Input, Output, EnvX, ErrorX, Error, Env>(
  step: Effect<
    (options: InputMetadata<Input>) => Pull.Pull<[Output, Duration.Duration], ErrorX, Output, EnvX>,
    Error,
    Env
  >
): Schedule<Output, Input, Error | Pull.ExcludeDone<ErrorX>, Env | EnvX> =>
  fromStep(effect.map(step, (f) => {
    const meta = metadataFn()
    return (now, input) => f(meta(now, input))
  }))

/**
 * Extracts the step function from a Schedule.
 *
 * **Example** (Extracting a schedule step function)
 *
 * ```ts
 * import { Effect, Schedule } from "effect"
 *
 * // Extract step function from an existing schedule
 * const schedule = Schedule.exponential("100 millis").pipe(Schedule.take(3))
 *
 * const program = Effect.gen(function*() {
 *   const stepFn = yield* Schedule.toStep(schedule)
 *
 *   // Use the step function directly for custom logic. The timestamp is
 *   // supplied by the caller, so tests can pass a deterministic value.
 *   const now = 0
 *   const result = yield* stepFn(now, "input")
 *
 *   console.log(`Step result: ${result}`)
 * })
 * ```
 *
 * @category destructors
 * @since 4.0.0
 */
export const toStep = <Output, Input, Error, Env>(
  schedule: Schedule<Output, Input, Error, Env>
): Effect<
  (now: number, input: Input) => Pull.Pull<[Output, Duration.Duration], Error, Output, Env>,
  never,
  Env
> =>
  effect.catchCause(
    (schedule as any).step,
    (cause) => effect.succeed(() => effect.failCause(cause) as any)
  )

/**
 * Extracts a step function from a `Schedule` that sleeps for each computed
 * delay and returns metadata for the completed step.
 *
 * **When to use**
 *
 * Use to drive a schedule manually while preserving the computed output,
 * delay, input, attempt, and elapsed timing metadata for each step.
 *
 * **Details**
 *
 * The returned step reads the current time from `Clock` when invoked, calls the
 * schedule step with that timestamp and input, sleeps for the returned
 * duration, and then yields `Metadata`.
 *
 * @see {@link toStep} for manually supplying the timestamp and handling the returned delay yourself
 * @see {@link toStepWithSleep} for the same automatic sleeping behavior when only the schedule output is needed
 *
 * @category destructors
 * @since 4.0.0
 */
export const toStepWithMetadata = <Output, Input, Error, Env>(
  schedule: Schedule<Output, Input, Error, Env>
): Effect<
  (input: Input) => Pull.Pull<Metadata<Output, Input>, Error, Output, Env>,
  never,
  Env
> =>
  effect.clockWith((clock) =>
    effect.map(
      toStep(schedule),
      (step) => {
        const metaFn = metadataFn()
        return (input) =>
          effect.suspend(() => {
            const now = clock.currentTimeMillisUnsafe()
            return effect.flatMap(
              step(now, input),
              ([output, duration]) => {
                const meta = metaFn(now, input) as Mutable<Metadata<Output, Input>>
                meta.output = output
                meta.duration = duration
                return effect.as(effect.sleep(duration), meta)
              }
            )
          })
      }
    )
  )

/**
 * Extracts a step function from a Schedule that automatically handles sleep delays.
 *
 * **Example** (Extracting a sleeping step function)
 *
 * ```ts
 * import { Effect, Schedule } from "effect"
 *
 * // Convert schedule to step function with automatic sleeping
 * const schedule = Schedule.spaced("1 second").pipe(Schedule.take(3))
 *
 * const program = Effect.gen(function*() {
 *   const stepWithSleep = yield* Schedule.toStepWithSleep(schedule)
 *
 *   // Each call will automatically sleep for the scheduled delay
 *   console.log("Starting...")
 *   const result1 = yield* stepWithSleep("first")
 *   console.log(`First result: ${result1}`)
 *
 *   const result2 = yield* stepWithSleep("second")
 *   console.log(`Second result: ${result2}`)
 *
 *   const result3 = yield* stepWithSleep("third")
 *   console.log(`Third result: ${result3}`)
 * })
 * ```
 *
 * @category destructors
 * @since 4.0.0
 */
export const toStepWithSleep = <Output, Input, Error, Env>(
  schedule: Schedule<Output, Input, Error, Env>
): Effect<
  (input: Input) => Pull.Pull<Output, Error, Output, Env>,
  never,
  Env
> =>
  effect.map(
    toStepWithMetadata(schedule),
    (step) => (input) => effect.map(step(input), (meta) => meta.output)
  )

/**
 * Returns a new `Schedule` that adds the delay computed by the specified
 * effectful function to the next recurrence of the schedule.
 *
 * **Example** (Adding extra delay to a schedule)
 *
 * ```ts
 * import { Console, Data, Duration, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * // Add a deterministic extra delay based on the schedule output
 * const delayedSchedule = Schedule.addDelay(
 *   Schedule.exponential("100 millis").pipe(Schedule.take(5)),
 *   (output) =>
 *     Effect.succeed(Duration.millis(Duration.toMillis(output) * 0.25))
 * )
 *
 * const repeatProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.succeed("delayed task"),
 *     delayedSchedule.pipe(
 *       Schedule.tapOutput((delay) =>
 *         Console.log(`Base delay: ${delay}`)
 *       )
 *     )
 *   )
 * })
 *
 * // Add adaptive delay based on execution count
 * const adaptiveSchedule = Schedule.addDelay(
 *   Schedule.recurs(6),
 *   (executionCount) =>
 *     // Increase delay as execution count grows
 *     Effect.succeed(Duration.millis(executionCount * 200))
 * )
 *
 * const adaptiveProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Adaptive delay task")
 *       return "adaptive"
 *     }),
 *     adaptiveSchedule.pipe(
 *       Schedule.tapOutput((count) =>
 *         Console.log(`Execution ${count + 1} with adaptive delay`)
 *       )
 *     )
 *   )
 * })
 *
 * // Add effectful delay computation from deterministic service data
 * const loadByExecution = [1, 3, 2, 4] as const
 *
 * const dynamicSchedule = Schedule.addDelay(
 *   Schedule.spaced("1 second").pipe(Schedule.take(4)),
 *   (executionNumber) => {
 *     const load = loadByExecution[executionNumber] ?? 1
 *     return Effect.succeed(Duration.millis(load * 100))
 *   }
 * )
 *
 * const dynamicProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Dynamic delay task")
 *       return "dynamic"
 *     }),
 *     dynamicSchedule
 *   )
 * })
 *
 * // Combine with retry for progressive backoff
 * const progressiveRetrySchedule = Schedule.addDelay(
 *   Schedule.exponential("50 millis").pipe(Schedule.take(4)),
 *   () => Effect.succeed(Duration.millis(100)) // Fixed additional delay
 * )
 *
 * const retryProgram = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   const result = yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       if (attempt < 5) {
 *         return yield* Effect.fail(new RetryAttemptError({ message: `Attempt ${attempt} failed` }))
 *       }
 *       return `Success on attempt ${attempt}`
 *     }),
 *     progressiveRetrySchedule
 *   )
 *
 *   yield* Console.log(`Final result: ${result}`)
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const addDelay: {
  <Output, Error2 = never, Env2 = never>(
    f: (output: Output) => Effect<Duration.Input, Error2, Env2>
  ): <Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Error2 = never, Env2 = never>(
    self: Schedule<Output, Input, Error, Env>,
    f: (output: Output) => Effect<Duration.Input, Error2, Env2>
  ): Schedule<Output, Input, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Error2 = never, Env2 = never>(
  self: Schedule<Output, Input, Error, Env>,
  f: (output: Output) => Effect<Duration.Input, Error2, Env2>
): Schedule<Output, Input, Error | Error2, Env | Env2> =>
  modifyDelay(
    self,
    (output, delay) =>
      effect.map(f(output), (d) => Duration.sum(Duration.fromInputUnsafe(d), Duration.fromInputUnsafe(delay)))
  ))

/**
 * Returns a schedule that runs `self` to completion, then runs `other`, and
 * merges their outputs.
 *
 * **Example** (Sequencing quick and slow retries)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * // First retry 3 times quickly, then switch to slower retries
 * const quickRetries = Schedule.exponential("100 millis").pipe(
 *   Schedule.take(3)
 * )
 * const slowRetries = Schedule.exponential("1 second").pipe(
 *   Schedule.take(2)
 * )
 *
 * const combinedRetries = Schedule.andThen(quickRetries, slowRetries)
 *
 * const program = Effect.gen(function*() {
 *   let attempt = 0
 *   yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       yield* Console.log(`Attempt ${attempt}`)
 *       if (attempt < 6) {
 *         return yield* Effect.fail(new RetryAttemptError({ message: `Failure ${attempt}` }))
 *       }
 *       return `Success on attempt ${attempt}`
 *     }),
 *     combinedRetries
 *   )
 * })
 * ```
 *
 * @category sequencing
 * @since 2.0.0
 */
export const andThen: {
  <Output2, Input2, Error2, Env2>(
    other: Schedule<Output2, Input2, Error2, Env2>
  ): <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output | Output2, Input & Input2, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
    self: Schedule<Output, Input, Error, Env>,
    other: Schedule<Output2, Input2, Error2, Env2>
  ): Schedule<Output | Output2, Input & Input2, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
  self: Schedule<Output, Input, Error, Env>,
  other: Schedule<Output2, Input2, Error2, Env2>
): Schedule<Output | Output2, Input & Input2, Error | Error2, Env | Env2> =>
  map(andThenResult(self, other), (result) => effect.succeed(Result.merge(result))))

/**
 * Returns a schedule that runs `self` to completion, then runs `other`, and
 * preserves which schedule produced each output.
 *
 * **Details**
 *
 * The resulting schedule emits a `Result` to indicate which phase produced
 * each output: outputs from `self` are emitted as `Failure`, and outputs from
 * `other` are emitted as `Success`.
 *
 * **Example** (Tracking sequential schedule phases)
 *
 * ```ts
 * import { Console, Effect, Result, Schedule } from "effect"
 *
 * // Track which phase of the schedule we're in
 * const phaseTracker = Schedule.andThenResult(
 *   Schedule.exponential("100 millis").pipe(Schedule.take(2)),
 *   Schedule.spaced("500 millis").pipe(Schedule.take(2))
 * )
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task-result"
 *     }),
 *     phaseTracker.pipe(
 *       Schedule.tapOutput((result) =>
 *         Result.match(result, {
 *           onFailure: (phase1Output) => Console.log(`Phase 1: ${phase1Output}`),
 *           onSuccess: (phase2Output) => Console.log(`Phase 2: ${phase2Output}`)
 *         })
 *       )
 *     )
 *   )
 * })
 * ```
 *
 * @category sequencing
 * @since 4.0.0
 */
export const andThenResult: {
  <Output2, Input2, Error2, Env2>(
    other: Schedule<Output2, Input2, Error2, Env2>
  ): <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Result.Result<Output2, Output>, Input & Input2, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
    self: Schedule<Output, Input, Error, Env>,
    other: Schedule<Output2, Input2, Error2, Env2>
  ): Schedule<Result.Result<Output2, Output>, Input & Input2, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
  self: Schedule<Output, Input, Error, Env>,
  other: Schedule<Output2, Input2, Error2, Env2>
): Schedule<Result.Result<Output, Output2>, Input & Input2, Error | Error2, Env | Env2> =>
  fromStep(effect.sync(() => {
    let currentSide = 0
    let currentStep:
      | undefined
      | ((now: number, input: Input & Input2) => Pull.Pull<
        [Result.Result<Output, Output2>, Duration.Duration],
        Error | Error2,
        Result.Result<Output, Output2>,
        Env | Env2
      >)
    const left = map(self, Result.succeed)
    const right = map(other, Result.fail)
    return function recur(
      now,
      input
    ): Pull.Pull<
      [Result.Result<Output, Output2>, Duration.Duration],
      Error | Error2,
      Result.Result<Output, Output2>,
      Env | Env2
    > {
      if (currentStep) return currentStep(now, input)
      return toStep<
        Result.Result<Output, Output2>,
        Input & Input2,
        Error | Error2,
        Env | Env2
      >(currentSide === 0 ? left : right).pipe(
        effect.flatMap((step) => {
          currentSide++
          if (currentSide === 1) {
            currentStep = (now, input) =>
              Pull.catchDone(step(now, input), (_) => {
                currentStep = undefined
                return recur(now, input)
              })
            return currentStep(now, input)
          }
          currentStep = step
          return currentStep(now, input)
        })
      )
    }
  })))

/**
 * Combines two `Schedule`s by recurring if both of the two schedules want
 * to recur, using the maximum of the two durations between recurrences and
 * outputting a tuple of the outputs of both schedules.
 *
 * **When to use**
 *
 * Use when the combined schedule should continue only while both
 * schedules still recur. Use `either` when either schedule should be enough to
 * continue.
 *
 * **Example** (Combining time and attempt limits)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * // Both schedules must want to continue for the combined schedule to continue
 * const timeLimit = Schedule.spaced("1 second").pipe(Schedule.take(5)) // max 5 times
 * const attemptLimit = Schedule.recurs(3) // max 3 attempts
 *
 * // Continues only while BOTH schedules want to continue (intersection/AND logic)
 * const bothSchedule = Schedule.both(timeLimit, attemptLimit)
 * // Outputs: [time_result, attempt_count] tuple
 *
 * const program = Effect.gen(function*() {
 *   const results = yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task completed"
 *     }),
 *     bothSchedule.pipe(
 *       Schedule.tapOutput(([timeResult, attemptResult]) =>
 *         Console.log(`Time: ${timeResult}, Attempts: ${attemptResult}`)
 *       )
 *     )
 *   )
 *
 *   yield* Console.log("Completed all executions")
 * })
 *
 * // Both with different delay strategies - uses maximum delay
 * const fastSchedule = Schedule.fixed("500 millis").pipe(Schedule.take(4))
 * const slowSchedule = Schedule.spaced("2 seconds").pipe(Schedule.take(6))
 *
 * // Will use the slower (maximum) delay and stop when first schedule exhausts
 * const conservativeSchedule = Schedule.both(fastSchedule, slowSchedule)
 *
 * const retryProgram = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   const result = yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       yield* Console.log(`Retry attempt ${attempt}`)
 *
 *       if (attempt < 3) {
 *         return yield* Effect.fail(new RetryAttemptError({ message: `Attempt ${attempt} failed` }))
 *       }
 *
 *       return `Success on attempt ${attempt}`
 *     }),
 *     conservativeSchedule
 *   )
 *
 *   yield* Console.log(`Final result: ${result}`)
 * })
 *
 * // Both provides intersection semantics (AND logic)
 * // Compare with either which provides union semantics (OR logic)
 * ```
 *
 * @see {@link either} for continuing while either schedule still recurs
 *
 * @category utils
 * @since 2.0.0
 */
export const both: {
  <Output2, Input2, Error2, Env2, Output>(
    other: Schedule<Output2, Input2, Error2, Env2>
  ): <Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<[Output, Output2], Input & Input2, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
    self: Schedule<Output, Input, Error, Env>,
    other: Schedule<Output2, Input2, Error2, Env2>
  ): Schedule<[Output, Output2], Input & Input2, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
  self: Schedule<Output, Input, Error, Env>,
  other: Schedule<Output2, Input2, Error2, Env2>
): Schedule<[Output, Output2], Input & Input2, Error | Error2, Env | Env2> =>
  bothWith(self, other, (left, right) => [left, right]))

/**
 * Combines two `Schedule`s by recurring if both of the two schedules want
 * to recur, using the maximum of the two durations between recurrences and
 * outputting the result of the left schedule (i.e. `self`).
 *
 * **Example** (Combining schedules and keeping the left output)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Combine two schedules, keeping left output
 * const leftSchedule = Schedule.exponential("100 millis").pipe(
 *   Schedule.map(() => Effect.succeed("left-result"))
 * )
 * const rightSchedule = Schedule.spaced("50 millis")
 *
 * const combined = Schedule.bothLeft(leftSchedule, rightSchedule)
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task-done"
 *     }),
 *     combined.pipe(Schedule.take(3))
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const bothLeft: {
  <Output2, Input2, Error2, Env2>(
    other: Schedule<Output2, Input2, Error2, Env2>
  ): <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input & Input2, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
    self: Schedule<Output, Input, Error, Env>,
    other: Schedule<Output2, Input2, Error2, Env2>
  ): Schedule<Output, Input & Input2, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
  self: Schedule<Output, Input, Error, Env>,
  other: Schedule<Output2, Input2, Error2, Env2>
): Schedule<Output, Input & Input2, Error | Error2, Env | Env2> => bothWith(self, other, (output) => output))

/**
 * Combines two `Schedule`s by recurring if both of the two schedules want
 * to recur, using the maximum of the two durations between recurrences and
 * outputting the result of the right schedule (i.e. `other`).
 *
 * **Example** (Combining schedules and keeping the right output)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Combine two schedules, keeping right output
 * const leftSchedule = Schedule.exponential("100 millis").pipe(
 *   Schedule.map(() => Effect.succeed("left-result"))
 * )
 * const rightSchedule = Schedule.spaced("50 millis").pipe(
 *   Schedule.map(() => Effect.succeed("right-result"))
 * )
 *
 * const combined = Schedule.bothRight(leftSchedule, rightSchedule)
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task-done"
 *     }),
 *     combined.pipe(Schedule.take(3))
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const bothRight: {
  <Output2, Input2, Error2, Env2>(
    other: Schedule<Output2, Input2, Error2, Env2>
  ): <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input & Input2, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
    self: Schedule<Output, Input, Error, Env>,
    other: Schedule<Output2, Input2, Error2, Env2>
  ): Schedule<Output, Input & Input2, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
  self: Schedule<Output, Input, Error, Env>,
  other: Schedule<Output2, Input2, Error2, Env2>
): Schedule<Output2, Input & Input2, Error | Error2, Env | Env2> => bothWith(self, other, (_, output) => output))

/**
 * Combines two `Schedule`s by recurring if both of the two schedules want
 * to recur, using the maximum of the two durations between recurrences and
 * outputting the result of the combination of both schedule outputs using the
 * specified `combine` function.
 *
 * **Example** (Combining schedule outputs)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Combine two schedules with custom output combination
 * const leftSchedule = Schedule.exponential("100 millis").pipe(
 *   Schedule.map(() => Effect.succeed("left"))
 * )
 * const rightSchedule = Schedule.spaced("50 millis").pipe(
 *   Schedule.map(() => Effect.succeed("right"))
 * )
 *
 * const combined = Schedule.bothWith(
 *   leftSchedule,
 *   rightSchedule,
 *   (left, right) => `${left}-${right}`
 * )
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task-result"
 *     }),
 *     combined.pipe(Schedule.take(3))
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const bothWith: {
  <Output2, Input2, Error2, Env2, Output, Output3>(
    other: Schedule<Output2, Input2, Error2, Env2>,
    combine: (selfOutput: Output, otherOutput: Output2) => Output3
  ): <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output3, Input & Input2, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Input2, Error2, Env2, Output3>(
    self: Schedule<Output, Input, Error, Env>,
    other: Schedule<Output2, Input2, Error2, Env2>,
    combine: (selfOutput: Output, otherOutput: Output2) => Output3
  ): Schedule<Output3, Input & Input2, Error | Error2, Env | Env2>
} = dual(3, <Output, Input, Error, Env, Output2, Input2, Error2, Env2, Output3>(
  self: Schedule<Output, Input, Error, Env>,
  other: Schedule<Output2, Input2, Error2, Env2>,
  combine: (selfOutput: Output, otherOutput: Output2) => Output3
): Schedule<Output3, Input & Input2, Error | Error2, Env | Env2> =>
  fromStep(effect.map(
    effect.zip(toStep(self), toStep(other)),
    ([stepLeft, stepRight]) => (now, input) =>
      Pull.matchEffect(stepLeft(now, input as Input), {
        onSuccess: (leftResult) =>
          stepRight(now, input as Input2).pipe(
            effect.map((rightResult) =>
              [
                combine(leftResult[0], rightResult[0]),
                Duration.max(leftResult[1], rightResult[1])
              ] as [Output3, Duration.Duration]
            ),
            Pull.catchDone((rightDone) => Cause.done(combine(leftResult[0], rightDone as Output2)))
          ),
        onDone: (leftDone) =>
          stepRight(now, input as Input2).pipe(
            effect.flatMap((rightResult) => Cause.done(combine(leftDone, rightResult[0]))),
            Pull.catchDone((rightDone) => Cause.done(combine(leftDone, rightDone as Output2)))
          ),
        onFailure: effect.failCause
      })
  )))

/**
 * Returns a new `Schedule` that follows `self` and outputs the inputs seen so
 * far as an array.
 *
 * **Details**
 *
 * This does not make the schedule run forever. The collected schedule stops
 * when `self` stops and fails when `self` fails.
 *
 * **Example** (Collecting schedule inputs)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Collect all inputs passed to the schedule
 * const inputCollector = Schedule.collectInputs(
 *   Schedule.spaced("100 millis")
 * )
 *
 * const program = Effect.gen(function*() {
 *   let counter = 0
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       counter++
 *       yield* Console.log(`Iteration ${counter}`)
 *       return `result-${counter}`
 *     }),
 *     inputCollector.pipe(Schedule.take(4))
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 4.0.0
 */
export const collectInputs = <Output, Input, Error, Env>(
  self: Schedule<Output, Input, Error, Env>
): Schedule<Array<Input>, Input, Error, Env> => collectWhile(passthrough(self), () => effect.succeed(true))

/**
 * Returns a new `Schedule` that follows `self` and outputs the schedule outputs
 * seen so far as an array.
 *
 * **Details**
 *
 * This does not make the schedule run forever. The collected schedule stops
 * when `self` stops and fails when `self` fails.
 *
 * **Example** (Collecting schedule outputs)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Collect all outputs from the schedule
 * const outputCollector = Schedule.collectOutputs(
 *   Schedule.recurs(4)
 * )
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task-result"
 *     }),
 *     outputCollector.pipe(Schedule.take(4))
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 4.0.0
 */
export const collectOutputs = <Output, Input, Error, Env>(
  self: Schedule<Output, Input, Error, Env>
): Schedule<Array<Output>, Input, Error, Env> => collectWhile(self, () => effect.succeed(true))

/**
 * Returns a new `Schedule` that recurs as long as the specified `predicate`
 * returns `true`, collecting all outputs of the schedule into an array.
 *
 * **Example** (Collecting outputs while a condition holds)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Collect outputs while condition is met
 * const collectWhileSmall = Schedule.collectWhile(
 *   Schedule.exponential("100 millis"),
 *   (metadata) =>
 *     Effect.succeed(metadata.attempt <= 5 && metadata.elapsed < 2000)
 * )
 *
 * const conditionalProgram = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   const attempts = yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       attempt++
 *       yield* Console.log(`Retry attempt ${attempt}`)
 *       return `attempt-${attempt}`
 *     }),
 *     collectWhileSmall
 *   )
 *
 *   yield* Console.log(`Collected attempts: [${attempts.join(", ")}]`)
 * })
 *
 * // Collect with effectful predicate
 * const collectWithCheck = Schedule.collectWhile(
 *   Schedule.fixed("1 second"),
 *   (metadata) =>
 *     Effect.gen(function*() {
 *       const shouldContinue = metadata.attempt < 5
 *       yield* Console.log(
 *         `Check ${metadata.attempt}: continue = ${shouldContinue}`
 *       )
 *       return shouldContinue
 *     })
 * )
 *
 * const effectfulProgram = Effect.gen(function*() {
 *   const results = yield* Effect.repeat(
 *     Effect.succeed("checked"),
 *     collectWithCheck
 *   )
 *
 *   yield* Console.log(`Final collection: ${results.length} items`)
 * })
 *
 * // Collect samples with condition
 * const samples = [12, 18, 24, 30, 36]
 *
 * const collectSamples = Schedule.collectWhile(
 *   Schedule.spaced("200 millis"),
 *   (metadata) =>
 *     Effect.succeed(metadata.attempt <= 5 && metadata.elapsed < 2000)
 * )
 *
 * const samplingProgram = Effect.gen(function*() {
 *   let index = 0
 *   const collected = yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       const sample = samples[index++]
 *       yield* Console.log(`Sample: ${sample}`)
 *       return sample
 *     }),
 *     collectSamples
 *   )
 *
 *   const average = collected.reduce((sum, s) => sum + s, 0) / collected.length
 *   yield* Console.log(
 *     `Collected ${collected.length} samples, average: ${average.toFixed(1)}`
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const collectWhile: {
  <Input, Output, Error2 = never, Env2 = never>(
    predicate: (
      metadata: Metadata<Output, Input>
    ) => boolean | Effect<boolean, Error2, Env2>
  ): <Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Array<Output>, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Error2 = never, Env2 = never>(
    self: Schedule<Output, Input, Error, Env>,
    predicate: (
      metadata: Metadata<Output, Input>
    ) => boolean | Effect<boolean, Error2, Env2>
  ): Schedule<Array<Output>, Input, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Error2 = never, Env2 = never>(
  self: Schedule<Output, Input, Error, Env>,
  predicate: (
    metadata: Metadata<Output, Input>
  ) => boolean | Effect<boolean, Error2, Env2>
): Schedule<Array<Output>, Input, Error | Error2, Env | Env2> =>
  reduce(while_(self, predicate), () => [] as Array<Output>, (outputs, output) => {
    outputs.push(output)
    return outputs
  }))

/**
 * Returns a new `Schedule` that recurs on the specified `Cron` schedule and
 * outputs the duration between recurrences.
 *
 * **Example** (Scheduling work with cron expressions)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class ScheduledTaskError extends Data.TaggedError("ScheduledTaskError")<{ readonly message: string }> {}
 *
 * // Run every minute
 * const everyMinute = Schedule.cron("* * * * *")
 *
 * const minutelyProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Running minutely task")
 *       return "minute"
 *     }),
 *     everyMinute.pipe(
 *       Schedule.take(3), // Run only 3 times for demo
 *       Schedule.tapOutput((duration) =>
 *         Console.log(`Next execution in: ${duration}`)
 *       )
 *     )
 *   )
 * })
 *
 * // Run every day at 2:30 AM
 * const dailyBackup = Schedule.cron("30 2 * * *")
 *
 * const backupProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Running daily backup...")
 *       // Simulate backup process
 *       yield* Effect.sleep("2 seconds")
 *       yield* Console.log("Backup completed")
 *       return "backup-done"
 *     }),
 *     dailyBackup.pipe(
 *       Schedule.take(2) // Run 2 times for demo
 *     )
 *   )
 * })
 *
 * // Run every Monday at 9:00 AM with timezone
 * const weeklyReport = Schedule.cron("0 9 * * 1", "America/New_York")
 *
 * const reportProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Generating weekly report...")
 *       const report = {
 *         week: 42,
 *         status: "ready" as const
 *       }
 *       yield* Console.log(`Report generated: ${JSON.stringify(report)}`)
 *       return report
 *     }),
 *     weeklyReport.pipe(Schedule.take(1))
 *   )
 * })
 *
 * // Run every 15 minutes during business hours (9 AM - 5 PM)
 * const businessHoursCheck = Schedule.cron("0,15,30,45 9-17 * * 1-5")
 *
 * const businessProgram = Effect.gen(function*() {
 *   const statuses = ["healthy", "healthy", "degraded", "healthy"] as const
 *   let index = 0
 *
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Business hours health check...")
 *       const status = statuses[index++]
 *       yield* Console.log(`System status: ${status}`)
 *       return status
 *     }),
 *     businessHoursCheck.pipe(
 *       Schedule.take(4) // Demo with 4 checks
 *     )
 *   )
 * })
 *
 * // Run on specific days of the month
 * const monthlyInvoice = Schedule.cron("0 10 1,15 * *") // 1st and 15th at 10 AM
 *
 * const invoiceProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Processing monthly invoices...")
 *       const invoiceCount = 72
 *       yield* Console.log(`Processed ${invoiceCount} invoices`)
 *       return { count: invoiceCount, batch: "2024-01-a" }
 *     }),
 *     monthlyInvoice.pipe(Schedule.take(1))
 *   )
 * })
 *
 * // Complex cron with error handling
 * const complexCron = Schedule.cron("0 2,4,6 * * *").pipe(
 *   Schedule.tapOutput((duration) =>
 *     Console.log(`Scheduled to run again in ${duration}`)
 *   )
 * )
 *
 * const robustProgram = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       attempt++
 *       yield* Console.log("Complex scheduled task...")
 *       if (attempt === 1) {
 *         return yield* Effect.fail(new ScheduledTaskError({ message: "Scheduled task failed" }))
 *       }
 *       return "success"
 *     }),
 *     complexCron.pipe(Schedule.take(3))
 *   ).pipe(
 *     Effect.catch((error: unknown) =>
 *       Console.log(`Cron task error: ${String(error)}`)
 *     )
 *   )
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const cron: {
  (expression: Cron.Cron): Schedule<Duration.Duration, unknown, Cron.CronParseError>
  (expression: string, tz?: string | DateTime.TimeZone): Schedule<Duration.Duration, unknown, Cron.CronParseError>
} = (expression: string | Cron.Cron, tz?: string | DateTime.TimeZone) => {
  const parsed = Cron.isCron(expression) ? Result.succeed(expression) : Cron.parse(expression, tz)
  return fromStep(effect.map(effect.fromResult(parsed), (cron) => (now, _) =>
    effect.sync(() => {
      const next = Cron.next(cron, now).getTime()
      const duration = Duration.millis(next - now)
      return [duration, duration]
    })))
}

/**
 * Returns a new schedule that outputs the delay between each occurrence.
 *
 * **Example** (Extracting schedule delays)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Extract delays from an exponential backoff schedule
 * const exponentialDelays = Schedule.delays(
 *   Schedule.exponential("100 millis").pipe(Schedule.take(5))
 * )
 *
 * const delayProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task result"
 *     }),
 *     exponentialDelays.pipe(
 *       Schedule.tapOutput((delay) =>
 *         Console.log(`Waiting ${delay} before next execution`)
 *       )
 *     )
 *   )
 * })
 *
 * // Monitor delays from a Fibonacci schedule
 * const fibonacciDelays = Schedule.delays(
 *   Schedule.fibonacci("200 millis").pipe(Schedule.take(8))
 * )
 *
 * const fibDelayProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Console.log("Fibonacci task"),
 *     fibonacciDelays.pipe(
 *       Schedule.tapOutput((delay) => Console.log(`Fibonacci delay: ${delay}`))
 *     )
 *   )
 * })
 *
 * // Extract delays for analysis or logging
 * const analyzeDelays = Schedule.delays(
 *   Schedule.spaced("1 second").pipe(Schedule.take(3))
 * ).pipe(
 *   Schedule.tapOutput((delay) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`Recorded delay: ${delay}`)
 *       // In real applications, might send to metrics system
 *     })
 *   )
 * )
 *
 * // Combine delays with other schedules for complex timing
 * const adaptiveSchedule = Schedule.unfold(100, (delay) => Effect.succeed(delay * 1.5)).pipe(
 *   Schedule.take(6)
 * )
 *
 * const adaptiveDelays = Schedule.delays(adaptiveSchedule)
 *
 * const adaptiveProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Adaptive task execution")
 *       return "completed"
 *     }),
 *     adaptiveDelays.pipe(
 *       Schedule.tapOutput((delay) => Console.log(`Adaptive delay: ${delay}`))
 *     )
 *   )
 * })
 *
 * // Use delays to implement custom timing logic
 * const customTimingSchedule = Schedule.delays(
 *   Schedule.exponential("50 millis").pipe(Schedule.take(4))
 * ).pipe(
 *   Schedule.map((delay) => Effect.succeed(`Next execution in ${delay}`)),
 *   Schedule.tapOutput((message) => Console.log(message))
 * )
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const delays = <Out, In, E, R>(self: Schedule<Out, In, E, R>): Schedule<Duration.Duration, In, E, R> =>
  fromStep(
    effect.map(
      toStep(self),
      (step) => (now, input) =>
        Pull.catchDone(
          effect.map(step(now, input), ([_, duration]) => [duration, duration]),
          (_) => Cause.done(Duration.zero)
        )
    )
  )

/**
 * Returns a schedule that recurs once after the specified duration.
 *
 * **When to use**
 *
 * Use when you need one delayed recurrence. Use `during` to keep
 * recurring until a duration has elapsed.
 *
 * **Details**
 *
 * The schedule outputs the configured duration for its first recurrence and
 * then completes.
 *
 * **Example** (Recurring once after a duration)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * const program = Effect.repeat(
 *   Console.log("runs again after one second"),
 *   Schedule.duration("1 second")
 * )
 * ```
 *
 * @see {@link during} for recurring until a duration has elapsed
 *
 * @category constructors
 * @since 2.0.0
 */
export const duration = (durationInput: Duration.Input): Schedule<Duration.Duration> => {
  const duration = Duration.fromInputUnsafe(durationInput)
  return fromStepWithMetadata(effect.succeed((meta) =>
    meta.attempt === 1
      ? effect.succeed([duration, duration])
      : Cause.done(Duration.zero)
  ))
}

/**
 * Returns a new `Schedule` that will always recur, but only during the
 * specified `duration` of time.
 *
 * **When to use**
 *
 * Use to bound a repeating or retrying schedule by elapsed time. Use
 * `duration` when you need one delayed recurrence.
 *
 * **Example** (Repeating work during a duration)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * // Run a task for exactly 5 seconds, regardless of how many iterations
 * const fiveSecondSchedule = Schedule.during("5 seconds")
 *
 * const timedProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed inside the time window")
 *       yield* Effect.sleep("500 millis") // Each task takes 500ms
 *       return "task done"
 *     }),
 *     fiveSecondSchedule.pipe(
 *       Schedule.tapOutput((elapsedDuration) =>
 *         Console.log(`Total elapsed: ${elapsedDuration}`)
 *       )
 *     )
 *   )
 *
 *   yield* Console.log("Time limit reached!")
 * })
 *
 * // Combine with other schedules for time-bounded execution
 * const timeAndCountLimited = Schedule.spaced("1 second").pipe(
 *   Schedule.both(Schedule.during("10 seconds")), // Stop after 10 seconds OR
 *   Schedule.both(Schedule.recurs(15)) // 15 attempts, whichever comes first
 * )
 *
 * // Burst execution within time window
 * const burstWindow = Schedule.during("3 seconds")
 *
 * const burstProgram = Effect.gen(function*() {
 *   yield* Console.log("Starting burst execution...")
 *
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Burst task")
 *       return "burst"
 *     }),
 *     burstWindow
 *   )
 *
 *   yield* Console.log("Burst window completed")
 * })
 *
 * // Timed retry window - retry for up to 30 seconds
 * const timedRetry = Schedule.exponential("200 millis").pipe(
 *   Schedule.both(Schedule.during("30 seconds"))
 * )
 *
 * const retryProgram = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   const result = yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       yield* Console.log(`Retry attempt ${attempt}`)
 *
 *       if (attempt < 4) {
 *         return yield* Effect.fail(new RetryAttemptError({ message: `Attempt ${attempt} failed` }))
 *       }
 *
 *       return `Success on attempt ${attempt}`
 *     }),
 *     timedRetry
 *   )
 *
 *   yield* Console.log(`Result: ${result}`)
 * }).pipe(
 *   Effect.catch((error: unknown) => Console.log(`Timed out: ${String(error)}`))
 * )
 * ```
 *
 * @see {@link duration} for one delayed recurrence
 *
 * @category constructors
 * @since 4.0.0
 */
export const during = (duration: Duration.Input): Schedule<Duration.Duration> =>
  while_(
    elapsed,
    ({ output }) => effect.succeed(Duration.isLessThanOrEqualTo(output, Duration.fromInputUnsafe(duration)))
  )

/**
 * Combines two `Schedule`s by recurring if either of the two schedules wants
 * to recur, using the minimum of the two durations between recurrences and
 * outputting a tuple of the outputs of both schedules.
 *
 * **When to use**
 *
 * Use when the combined schedule should continue while at least one
 * schedule still recurs. Use `both` when both schedules must continue.
 *
 * **Example** (Combining schedules with either semantics)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * // Either continues as long as at least one schedule wants to continue
 * const timeBasedSchedule = Schedule.spaced("2 seconds").pipe(Schedule.take(3))
 * const countBasedSchedule = Schedule.recurs(5)
 *
 * // Continues until both schedules are exhausted (either still wants to recur)
 * const eitherSchedule = Schedule.either(timeBasedSchedule, countBasedSchedule)
 * // Outputs: [time_result, count_result] tuple
 *
 * const program = Effect.gen(function*() {
 *   const results = yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task completed"
 *     }),
 *     eitherSchedule.pipe(
 *       Schedule.tapOutput(([timeResult, countResult]) =>
 *         Console.log(`Time: ${timeResult}, Count: ${countResult}`)
 *       )
 *     )
 *   )
 *
 *   yield* Console.log(`Total executions: ${results.length}`)
 * })
 *
 * // Either with different delay strategies
 * const aggressiveRetry = Schedule.exponential("100 millis").pipe(
 *   Schedule.take(3)
 * )
 * const fallbackRetry = Schedule.fixed("5 seconds").pipe(Schedule.take(2))
 *
 * // Will use the more aggressive retry until it's exhausted, then fallback
 * const combinedRetry = Schedule.either(aggressiveRetry, fallbackRetry)
 *
 * const retryProgram = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   const result = yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       yield* Console.log(`Retry attempt ${attempt}`)
 *
 *       if (attempt < 6) {
 *         return yield* Effect.fail(new RetryAttemptError({ message: `Attempt ${attempt} failed` }))
 *       }
 *
 *       return `Success on attempt ${attempt}`
 *     }),
 *     combinedRetry
 *   )
 *
 *   yield* Console.log(`Final result: ${result}`)
 * })
 *
 * // Either provides union semantics (OR logic)
 * // Compare with both, which provides intersection semantics (AND logic)
 * ```
 *
 * @see {@link both} for continuing only while both schedules still recur
 *
 * @category utils
 * @since 2.0.0
 */
export const either: {
  <Output2, Input2, Error2, Env2>(
    other: Schedule<Output2, Input2, Error2, Env2>
  ): <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<[Output, Output2], Input & Input2, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
    self: Schedule<Output, Input, Error, Env>,
    other: Schedule<Output2, Input2, Error2, Env2>
  ): Schedule<[Output, Output2], Input & Input2, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
  self: Schedule<Output, Input, Error, Env>,
  other: Schedule<Output2, Input2, Error2, Env2>
): Schedule<[Output, Output2], Input & Input2, Error | Error2, Env | Env2> =>
  eitherWith(self, other, (left, right) => [left, right]))

/**
 * Combines two `Schedule`s by recurring if either of the two schedules wants
 * to recur, using the minimum of the two durations between recurrences and
 * outputting the result of the left schedule (i.e. `self`).
 *
 * **Example** (Combining either schedules and keeping the left output)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Combine two schedules with either semantics, keeping left output
 * const primarySchedule = Schedule.exponential("100 millis").pipe(
 *   Schedule.map(() => Effect.succeed("primary-result")),
 *   Schedule.take(2)
 * )
 * const backupSchedule = Schedule.spaced("500 millis").pipe(
 *   Schedule.map(() => Effect.succeed("backup-result"))
 * )
 *
 * const combined = Schedule.eitherLeft(primarySchedule, backupSchedule)
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task-done"
 *     }),
 *     combined.pipe(Schedule.take(5))
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 4.0.0
 */
export const eitherLeft: {
  <Output2, Input2, Error2, Env2>(
    other: Schedule<Output2, Input2, Error2, Env2>
  ): <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input & Input2, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
    self: Schedule<Output, Input, Error, Env>,
    other: Schedule<Output2, Input2, Error2, Env2>
  ): Schedule<Output, Input & Input2, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
  self: Schedule<Output, Input, Error, Env>,
  other: Schedule<Output2, Input2, Error2, Env2>
): Schedule<Output, Input & Input2, Error | Error2, Env | Env2> => eitherWith(self, other, (output) => output))

/**
 * Combines two `Schedule`s by recurring if either of the two schedules wants
 * to recur, using the minimum of the two durations between recurrences and
 * outputting the result of the right schedule (i.e. `other`).
 *
 * **Example** (Combining either schedules and keeping the right output)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Combine two schedules with either semantics, keeping right output
 * const primarySchedule = Schedule.exponential("100 millis").pipe(
 *   Schedule.map(() => Effect.succeed("primary-result")),
 *   Schedule.take(2)
 * )
 * const backupSchedule = Schedule.spaced("500 millis").pipe(
 *   Schedule.map(() => Effect.succeed("backup-result"))
 * )
 *
 * const combined = Schedule.eitherRight(primarySchedule, backupSchedule)
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task-done"
 *     }),
 *     combined.pipe(Schedule.take(5))
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 4.0.0
 */
export const eitherRight: {
  <Output2, Input2, Error2, Env2>(
    other: Schedule<Output2, Input2, Error2, Env2>
  ): <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output2, Input & Input2, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
    self: Schedule<Output, Input, Error, Env>,
    other: Schedule<Output2, Input2, Error2, Env2>
  ): Schedule<Output2, Input & Input2, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(
  self: Schedule<Output, Input, Error, Env>,
  other: Schedule<Output2, Input2, Error2, Env2>
): Schedule<Output2, Input & Input2, Error | Error2, Env | Env2> => eitherWith(self, other, (_, output) => output))

/**
 * Combines two `Schedule`s by recurring if either of the two schedules wants
 * to recur, using the minimum of the two durations between recurrences and
 * outputting the result of the combination of both schedule outputs using the
 * specified `combine` function.
 *
 * **Example** (Combining either schedule outputs)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Combine schedules with either semantics and custom combination
 * const primarySchedule = Schedule.exponential("100 millis").pipe(
 *   Schedule.map(() => Effect.succeed("primary")),
 *   Schedule.take(2)
 * )
 * const fallbackSchedule = Schedule.spaced("500 millis").pipe(
 *   Schedule.map(() => Effect.succeed("fallback"))
 * )
 *
 * const combined = Schedule.eitherWith(
 *   primarySchedule,
 *   fallbackSchedule,
 *   (primary, fallback) => `${primary}+${fallback}`
 * )
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task-result"
 *     }),
 *     combined.pipe(Schedule.take(5))
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const eitherWith: {
  <Output2, Input2, Error2, Env2, Output, Output3>(
    other: Schedule<Output2, Input2, Error2, Env2>,
    combine: (selfOutput: Output, otherOutput: Output2) => Output3
  ): <Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output3, Input & Input2, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Input2, Error2, Env2, Output3>(
    self: Schedule<Output, Input, Error, Env>,
    other: Schedule<Output2, Input2, Error2, Env2>,
    combine: (selfOutput: Output, otherOutput: Output2) => Output3
  ): Schedule<Output3, Input & Input2, Error | Error2, Env | Env2>
} = dual(3, <Output, Input, Error, Env, Output2, Input2, Error2, Env2, Output3>(
  self: Schedule<Output, Input, Error, Env>,
  other: Schedule<Output2, Input2, Error2, Env2>,
  combine: (selfOutput: Output, otherOutput: Output2) => Output3
): Schedule<Output3, Input & Input2, Error | Error2, Env | Env2> =>
  fromStep(effect.map(
    effect.zip(toStep(self), toStep(other)),
    ([stepLeft, stepRight]) => (now, input) =>
      Pull.matchEffect(stepLeft(now, input as Input), {
        onSuccess: (leftResult) =>
          stepRight(now, input as Input2).pipe(
            effect.map((rightResult) =>
              [combine(leftResult[0], rightResult[0]), Duration.min(leftResult[1], rightResult[1])] as [
                Output3,
                Duration.Duration
              ]
            ),
            Pull.catchDone((rightDone) =>
              effect.succeed<[Output3, Duration.Duration]>([
                combine(leftResult[0], rightDone as Output2),
                leftResult[1]
              ])
            )
          ),
        onFailure: effect.failCause,
        onDone: (leftDone) =>
          stepRight(now, input as Input2).pipe(
            effect.map((rightResult) =>
              [combine(leftDone, rightResult[0]), rightResult[1]] as [
                Output3,
                Duration.Duration
              ]
            ),
            Pull.catchDone((rightDone) => Cause.done(combine(leftDone, rightDone as Output2)))
          )
      })
  )))

/**
 * Schedule that always recurs and returns the total elapsed duration since the
 * first recurrence.
 *
 * **Details**
 *
 * This schedule never stops and outputs the cumulative time that has passed since the schedule
 * started executing. Useful for tracking execution time or implementing time-based logic.
 *
 * **Example** (Measuring elapsed schedule time)
 *
 * ```ts
 * import { Console, Duration, Effect, Schedule } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Console.log("Running task..."),
 *     Schedule.spaced("1 second").pipe(
 *       Schedule.both(Schedule.elapsed),
 *       Schedule.tapOutput(([count, duration]) =>
 *         Console.log(`Run ${count}, elapsed: ${Duration.toMillis(duration)}ms`)
 *       ),
 *       Schedule.take(5)
 *     )
 *   )
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const elapsed: Schedule<Duration.Duration> = fromStepWithMetadata(
  effect.succeed((meta) => effect.succeed([Duration.millis(meta.elapsed), Duration.zero] as const))
)

/**
 * Schedule that always recurs, but will wait a certain amount between
 * repetitions, given by `base * factor.pow(n)`, where `n` is the number of
 * repetitions so far. Returns the current duration between recurrences.
 *
 * **Example** (Retrying with exponential backoff)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryFailure extends Data.TaggedError("RetryFailure")<{ readonly message: string }> {}
 *
 * // Basic exponential backoff with default factor of 2
 * const basicExponential = Schedule.exponential("100 millis")
 * // Delays: 100ms, 200ms, 400ms, 800ms, 1600ms, ...
 *
 * // Custom exponential backoff with factor 1.5
 * const gentleExponential = Schedule.exponential("200 millis", 1.5)
 * // Delays: 200ms, 300ms, 450ms, 675ms, 1012ms, ...
 *
 * // Retry with exponential backoff (limited to 5 attempts)
 * const retryPolicy = Schedule.exponential("50 millis").pipe(
 *   Schedule.both(Schedule.recurs(5))
 * )
 *
 * const program = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   const result = yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       if (attempt < 4) {
 *         yield* Console.log(`Attempt ${attempt} failed, retrying...`)
 *         return yield* Effect.fail(new RetryFailure({ message: `Failure ${attempt}` }))
 *       }
 *       return `Success on attempt ${attempt}`
 *     }),
 *     retryPolicy
 *   )
 *
 *   yield* Console.log(`Final result: ${result}`)
 * })
 *
 * // Will retry with delays: 50ms, 100ms, 200ms before success
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const exponential = (
  base: Duration.Input,
  factor: number = 2
): Schedule<Duration.Duration> => {
  const baseMillis = Duration.toMillis(Duration.fromInputUnsafe(base))
  return fromStepWithMetadata(effect.succeed((meta) => {
    const duration = Duration.millis(baseMillis * Math.pow(factor, meta.attempt - 1))
    return effect.succeed([duration, duration])
  }))
}

/**
 * Schedule that always recurs, increasing delays by summing the preceding
 * two delays (similar to the Fibonacci sequence). Returns the current
 * duration between recurrences.
 *
 * **Example** (Retrying with Fibonacci backoff)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * // Basic Fibonacci schedule starting with 100ms
 * const fibSchedule = Schedule.fibonacci("100 millis")
 * // Delays: 100ms, 100ms, 200ms, 300ms, 500ms, 800ms, 1300ms, ...
 *
 * // Retry with Fibonacci backoff for gradual increase
 * const retryWithFib = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   const result = yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       yield* Console.log(`Attempt ${attempt}`)
 *
 *       if (attempt < 5) {
 *         return yield* Effect.fail(new RetryAttemptError({ message: `Attempt ${attempt} failed` }))
 *       }
 *
 *       return `Success on attempt ${attempt}`
 *     }),
 *     Schedule.fibonacci("50 millis").pipe(
 *       Schedule.both(Schedule.recurs(6)), // Maximum 6 retries
 *       Schedule.tapOutput((delay) => Console.log(`Next retry in ${delay}`))
 *     )
 *   )
 *
 *   yield* Console.log(`Final result: ${result}`)
 * })
 *
 * // Heartbeat with Fibonacci intervals (starts fast, gets slower)
 * const adaptiveHeartbeat = Effect.gen(function*() {
 *   yield* Console.log("Heartbeat")
 *   return "pulse"
 * }).pipe(
 *   Effect.repeat(
 *     Schedule.fibonacci("200 millis").pipe(
 *       Schedule.take(8) // First 8 heartbeats
 *     )
 *   )
 * )
 *
 * // Fibonacci vs exponential comparison
 * const compareSchedules = Effect.gen(function*() {
 *   yield* Console.log("=== Fibonacci Delays ===")
 *   // 100ms, 100ms, 200ms, 300ms, 500ms, 800ms
 *
 *   yield* Console.log("=== Exponential Delays ===")
 *   // 100ms, 200ms, 400ms, 800ms, 1600ms, 3200ms
 *
 *   // Fibonacci grows more slowly than exponential
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const fibonacci = (one: Duration.Input): Schedule<Duration.Duration> => {
  const oneMillis = Duration.toMillis(Duration.fromInputUnsafe(one))
  return fromStep(effect.sync(() => {
    let a = 0
    let b = oneMillis
    return constant(effect.sync(() => {
      const next = a + b
      a = b
      b = next
      const duration = Duration.millis(next)
      return [duration, duration]
    }))
  }))
}

/**
 * Returns a `Schedule` that recurs on the specified fixed `interval` and
 * outputs the number of repetitions of the schedule so far.
 *
 * **When to use**
 *
 * Use when recurrences should stay aligned to a regular cadence. Use
 * `spaced` when each delay should start after the previous action completes.
 *
 * **Gotchas**
 *
 * If the action run between recurrences takes longer than the interval, the
 * next recurrence happens immediately, but missed intervals are not replayed.
 *
 * ```text
 * |-----interval-----|-----interval-----|-----interval-----|
 * |---------action--------||action|-----|action|-----------|
 * ```
 *
 * **Example** (Repeating on fixed intervals)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Fixed interval schedule - recurs on a one-second cadence
 * const everySecond = Schedule.fixed("1 second")
 *
 * // Health check that runs at fixed intervals
 * const healthCheck = Effect.gen(function*() {
 *   yield* Console.log("Health check")
 *   yield* Effect.sleep("200 millis") // simulate health check work
 *   return "healthy"
 * }).pipe(
 *   Effect.repeat(Schedule.fixed("2 seconds").pipe(Schedule.take(5)))
 * )
 *
 * // Difference between fixed and spaced:
 * // - fixed: maintains constant rate regardless of action duration
 * // - spaced: waits for the duration AFTER each action completes
 *
 * const longRunningTask = Effect.gen(function*() {
 *   yield* Console.log("Task started")
 *   yield* Effect.sleep("1.5 seconds") // Longer than interval
 *   yield* Console.log("Task completed")
 *   return "done"
 * })
 *
 * // Fixed schedule: if task takes 1.5s but interval is 1s,
 * // next execution happens immediately (no pile-up)
 * const fixedSchedule = longRunningTask.pipe(
 *   Effect.repeat(Schedule.fixed("1 second").pipe(Schedule.take(3)))
 * )
 *
 * // Comparing with spaced (waits 1s AFTER each task)
 * const spacedSchedule = longRunningTask.pipe(
 *   Effect.repeat(Schedule.spaced("1 second").pipe(Schedule.take(3)))
 * )
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("=== Fixed Schedule Demo ===")
 *   yield* fixedSchedule
 *
 *   yield* Console.log("=== Spaced Schedule Demo ===")
 *   yield* spacedSchedule
 * })
 * ```
 *
 * @see {@link spaced} for delaying after each action completes
 *
 * @category constructors
 * @since 2.0.0
 */
export const fixed = (interval: Duration.Input): Schedule<number> => {
  const window = Duration.toMillis(Duration.fromInputUnsafe(interval))
  return fromStepWithMetadata(effect.sync(() => {
    let start = 0
    let lastRun = 0
    return (meta) =>
      effect.sync(() => {
        if (window === 0) {
          return [meta.attempt - 1, Duration.zero] as const
        }
        if (meta.attempt === 1) {
          start = meta.now
          lastRun = meta.now + window
          return [0, Duration.millis(window)] as const
        }
        const runningBehind = meta.now > (lastRun + window)
        const boundary = window - ((meta.now - start) % window)
        const delay = runningBehind ? 0 : boundary === 0 ? window : boundary
        lastRun = runningBehind ? meta.now : meta.now + delay
        return [meta.attempt - 1, Duration.millis(delay)] as const
      })
  }))
}

/**
 * Returns a new `Schedule` that maps the output of this schedule using the
 * specified function.
 *
 * **Example** (Mapping schedule outputs)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Transform schedule output from number to string
 * const countSchedule = Schedule.recurs(5).pipe(
 *   Schedule.map((count) => Effect.succeed(`Execution #${count + 1}`))
 * )
 *
 * // Map schedule delays to human-readable format
 * const readableDelays = Schedule.exponential("100 millis").pipe(
 *   Schedule.map((duration) => Effect.succeed(`Next retry in ${duration}`))
 * )
 *
 * // Transform numeric output to structured data
 * const structuredSchedule = Schedule.spaced("1 second").pipe(
 *   Schedule.map((recurrence) => Effect.succeed({
 *     iteration: recurrence + 1,
 *     phase: recurrence < 5 ? "warmup" as const : "steady" as const
 *   }))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const results = yield* Effect.repeat(
 *     Effect.succeed("task completed"),
 *     structuredSchedule.pipe(
 *       Schedule.take(8),
 *       Schedule.tapOutput((info) =>
 *         Console.log(
 *           `${info.phase} phase - iteration ${info.iteration}`
 *         )
 *       )
 *     )
 *   )
 *
 *   yield* Console.log(`Completed iterations`)
 * })
 *
 * // Map with effectful transformation
 * const effectfulMap = Schedule.fixed("2 seconds").pipe(
 *   Schedule.map((count) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`Processing count: ${count}`)
 *       return count * 10
 *     })
 *   )
 * )
 *
 * // Combine mapping with other schedule operations
 * const complexSchedule = Schedule.fibonacci("100 millis").pipe(
 *   Schedule.map((delay) => Effect.succeed(`Delay: ${delay}`))
 * )
 * ```
 *
 * @category mapping
 * @since 2.0.0
 */
export const map: {
  <Output, Output2, Error2 = never, Env2 = never>(
    f: (output: Output) => Output2 | Effect<Output2, Error2, Env2>
  ): <Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output2, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Error2 = never, Env2 = never>(
    self: Schedule<Output, Input, Error, Env>,
    f: (output: Output) => Output2 | Effect<Output2, Error2, Env2>
  ): Schedule<Output2, Input, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Output2, Error2 = never, Env2 = never>(
  self: Schedule<Output, Input, Error, Env>,
  f: (output: Output) => Output2 | Effect<Output2, Error2, Env2>
): Schedule<Output2, Input, Error | Error2, Env | Env2> => {
  const handle = Pull.matchEffect({
    onSuccess: ([output, duration]: [Output, Duration.Duration]) => {
      const result = f(output)
      if (!isEffect(result)) return effect.succeed([result, duration] as [Output2, Duration.Duration])
      return effect.map(result, (output) => [output, duration] as [Output2, Duration.Duration])
    },
    onFailure: effect.failCause<Error>,
    onDone: (output: Output) => {
      const result = f(output)
      if (!isEffect(result)) return Cause.done(result as Output2)
      return effect.flatMap(result, Cause.done)
    }
  })
  return fromStep(effect.map(toStep(self), (step) => (now, input) => handle(step(now, input))))
})

/**
 * Returns a new `Schedule` that modifies the delay of the next recurrence
 * of the schedule using the specified effectful function.
 *
 * **Example** (Modifying delays from schedule output)
 *
 * ```ts
 * import { Console, Duration, Effect, Schedule } from "effect"
 *
 * // Modify delays based on output - increase delay on high iteration counts
 * const adaptiveDelay = Schedule.recurs(10).pipe(
 *   Schedule.modifyDelay((output, delay) => {
 *     // Double the delay if we're seeing high iteration counts
 *     return Effect.succeed(output > 5 ? Duration.times(delay, 2) : delay)
 *   })
 * )
 *
 * const program = Effect.gen(function*() {
 *   let counter = 0
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       counter++
 *       yield* Console.log(`Attempt ${counter}`)
 *       return counter
 *     }),
 *     adaptiveDelay.pipe(Schedule.take(8))
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const modifyDelay: {
  <Output, Error2 = never, Env2 = never>(
    f: (
      output: Output,
      delay: Duration.Duration
    ) => Effect<Duration.Input, Error2, Env2>
  ): <Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Error2 = never, Env2 = never>(
    self: Schedule<Output, Input, Error, Env>,
    f: (
      output: Output,
      delay: Duration.Input
    ) => Effect<Duration.Input, Error2, Env2>
  ): Schedule<Output, Input, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Error2 = never, Env2 = never>(
  self: Schedule<Output, Input, Error, Env>,
  f: (
    output: Output,
    delay: Duration.Input
  ) => Effect<Duration.Input, Error2, Env2>
): Schedule<Output, Input, Error | Error2, Env | Env2> =>
  fromStep(effect.map(toStep(self), (step) => (now, input) =>
    effect.flatMap(
      step(now, input),
      ([output, delay]) => effect.map(f(output, delay), (delay) => [output, Duration.fromInputUnsafe(delay)])
    ))))

/**
 * Returns a new `Schedule` that randomly adjusts each recurrence delay.
 *
 * **When to use**
 *
 * Use to add random variation to an existing schedule's recurrence delays while
 * preserving its output and completion behavior.
 *
 * **Details**
 *
 * Each recurrence delay is scaled by a random factor between `0.8` and `1.2`.
 *
 * @see {@link modifyDelay} for replacing recurrence delays with a custom effectful transformation
 *
 * @category utils
 * @since 2.0.0
 */
export const jittered = <Output, Input, Error, Env>(
  self: Schedule<Output, Input, Error, Env>
): Schedule<Output, Input, Error, Env> =>
  modifyDelay(self, (_, delay) =>
    effect.map(randomNext, (random) => {
      const millis = Duration.toMillis(Duration.fromInputUnsafe(delay))
      return Duration.millis(millis * 0.8 * (1 - random) + millis * 1.2 * random)
    }))

/**
 * Returns a new `Schedule` that outputs the inputs of the specified schedule.
 *
 * **Example** (Passing inputs through as outputs)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Create a schedule that outputs the inputs instead of original outputs
 * const inputSchedule = Schedule.passthrough(
 *   Schedule.exponential("100 millis").pipe(Schedule.take(3))
 * )
 *
 * const program = Effect.gen(function*() {
 *   let counter = 0
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       counter++
 *       yield* Console.log(`Task ${counter} executed`)
 *       return `result-${counter}`
 *     }),
 *     inputSchedule
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const passthrough = <Output, Input, Error, Env>(
  self: Schedule<Output, Input, Error, Env>
): Schedule<Input, Input, Error, Env> =>
  fromStep(effect.map(toStep(self), (step) => (now, input) =>
    Pull.matchEffect(step(now, input), {
      onSuccess: (result) => effect.succeed([input, result[1]]),
      onFailure: effect.failCause,
      onDone: () => Cause.done(input)
    })))

/**
 * Returns a `Schedule` which can only be stepped the specified number of
 * `times` before it terminates.
 *
 * **When to use**
 *
 * Use when you need a counter schedule with no additional delay. Use `take`
 * to limit an existing schedule while preserving its output and delay
 * behavior.
 *
 * **Gotchas**
 *
 * `recurs(n)` counts schedule recurrences, not the first evaluation of the
 * effect being repeated or retried. For retrying, this means one initial
 * attempt plus at most `n` retries.
 *
 * **Example** (Limiting recurrences)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * // Basic recurs - retry at most 3 times
 * const maxThreeAttempts = Schedule.recurs(3)
 *
 * // Retry a failing operation at most 5 times
 * const program = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   const result = yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       yield* Console.log(`Attempt ${attempt}`)
 *
 *       if (attempt < 4) {
 *         return yield* Effect.fail(new RetryAttemptError({ message: `Attempt ${attempt} failed` }))
 *       }
 *
 *       return `Success on attempt ${attempt}`
 *     }),
 *     Schedule.recurs(5) // Will retry up to 5 times
 *   )
 *
 *   yield* Console.log(`Final result: ${result}`)
 * })
 *
 * // Combining recurs with other schedules for sophisticated retry logic
 * const complexRetry = Schedule.exponential("100 millis").pipe(
 *   Schedule.both(Schedule.recurs(3)) // At most 3 retries
 * )
 *
 * // Allow ten recurrences after the initial run
 * const tenRecurrences = Effect.gen(function*() {
 *   yield* Console.log("Executing task...")
 *   return "completed"
 * }).pipe(
 *   Effect.repeat(Schedule.recurs(10))
 * )
 *
 * // The schedule outputs the current recurrence count (0-based)
 * const countingSchedule = Schedule.recurs(3).pipe(
 *   Schedule.tapOutput((count) => Console.log(`Execution #${count + 1}`))
 * )
 * ```
 *
 * @see {@link take} for limiting an existing schedule
 *
 * @category constructors
 * @since 2.0.0
 */
export const recurs = (times: number): Schedule<number> =>
  while_(forever, ({ attempt }) => effect.succeed(attempt <= times))

/**
 * Returns a new `Schedule` that combines the outputs of the provided schedule
 * using the specified effectful `combine` function and starting from the
 * specified `initial` state.
 *
 * **Example** (Reducing schedule outputs)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Sum up execution counts from a counter schedule
 * const sumSchedule = Schedule.reduce(
 *   Schedule.recurs(5),
 *   () => 0, // Initial sum
 *   (sum, count) => Effect.succeed(sum + count) // Add each count to the sum
 * )
 *
 * const sumProgram = Effect.gen(function*() {
 *   const finalSum = yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task"
 *     }),
 *     sumSchedule.pipe(
 *       Schedule.tapOutput((sum) => Console.log(`Running sum: ${sum}`))
 *     )
 *   )
 *
 *   yield* Console.log(`Final sum: ${finalSum}`)
 * })
 *
 * // Build a history of execution counts
 * const historySchedule = Schedule.reduce(
 *   Schedule.spaced("1 second").pipe(Schedule.take(4)),
 *   () => [] as Array<number>, // Initial empty array
 *   (history, executionNumber) => Effect.succeed([...history, executionNumber])
 * )
 *
 * const historyProgram = Effect.gen(function*() {
 *   const timeline = yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Recording execution...")
 *       return "recorded"
 *     }),
 *     historySchedule
 *   )
 *
 *   yield* Console.log(
 *     `Execution timeline: ${timeline.join(", ")}`
 *   )
 * })
 *
 * // Accumulate metrics with effectful combination
 * const metricsAccumulator = Schedule.reduce(
 *   Schedule.recurs(6),
 *   () => ({ total: 0, count: 0, max: 0 }),
 *   (metrics, executionCount) => Effect.succeed({
 *     total: metrics.total + executionCount + 1,
 *     count: metrics.count + 1,
 *     max: Math.max(metrics.max, executionCount + 1)
 *   })
 * )
 *
 * const metricsProgram = Effect.gen(function*() {
 *   const finalMetrics = yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Processing...")
 *       return "processed"
 *     }),
 *     metricsAccumulator
 *   )
 *
 *   const average = finalMetrics.total / finalMetrics.count
 *   yield* Console.log(`Final metrics: ${finalMetrics.count} executions`)
 *   yield* Console.log(
 *     `Average delay: ${average.toFixed(1)}ms, Max delay: ${finalMetrics.max}ms`
 *   )
 * })
 *
 * // Build configuration state over time
 * const configBuilder = Schedule.reduce(
 *   Schedule.fixed("500 millis").pipe(Schedule.take(3)),
 *   () => ({ retries: 1, timeout: 1000, backoff: 100 }),
 *   (config, executionNumber) => Effect.succeed({
 *     retries: config.retries + 1,
 *     timeout: config.timeout * 1.5,
 *     backoff: Math.min(config.backoff * 2, 5000)
 *   })
 * )
 *
 * const configProgram = Effect.gen(function*() {
 *   const finalConfig = yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Updating configuration...")
 *       return "updated"
 *     }),
 *     configBuilder.pipe(
 *       Schedule.tapOutput((config) =>
 *         Console.log(
 *           `Config: retries=${config.retries}, timeout=${config.timeout}ms`
 *         )
 *       )
 *     )
 *   )
 *
 *   yield* Console.log(`Final config: ${JSON.stringify(finalConfig)}`)
 * })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const reduce: {
  <State, Output, Error2 = never, Env2 = never>(
    initial: LazyArg<State>,
    combine: (state: State, output: Output) => State | Effect<State, Error2, Env2>
  ): <Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<State, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, State, Error2 = never, Env2 = never>(
    self: Schedule<Output, Input, Error, Env>,
    initial: LazyArg<State>,
    combine: (state: State, output: Output) => State | Effect<State, Error2, Env2>
  ): Schedule<State, Input, Error | Error2, Env | Env2>
} = dual(3, <Output, Input, Error, Env, State, Error2 = never, Env2 = never>(
  self: Schedule<Output, Input, Error, Env>,
  initial: LazyArg<State>,
  combine: (state: State, output: Output) => State | Effect<State, Error2, Env2>
): Schedule<State, Input, Error | Error2, Env | Env2> =>
  fromStep(effect.map(toStep(self), (step) => {
    let state = initial()
    return (now, input) =>
      Pull.matchEffect(step(now, input), {
        onSuccess([output, delay]) {
          const next = combine(state, output)
          if (!isEffect(next)) {
            state = next
            return effect.succeed([next, delay] as [State, Duration.Duration])
          }
          return effect.map(next, (nextState) => {
            state = nextState
            return [nextState, delay]
          })
        },
        onFailure: effect.failCause,
        onDone(output) {
          const next = combine(state, output)
          return isEffect(next) ? effect.flatMap(next, Cause.done) : Cause.done(next)
        }
      })
  })))

/**
 * Returns a schedule that recurs continuously, each repetition spaced the
 * specified duration from the last run.
 *
 * **When to use**
 *
 * Use when each delay should start after the previous action
 * completes. Use `fixed` when recurrences should stay aligned to a regular
 * cadence.
 *
 * **Example** (Repeating with fixed spacing)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Basic spaced schedule - runs every 2 seconds
 * const everyTwoSeconds = Schedule.spaced("2 seconds")
 *
 * // Heartbeat that runs indefinitely with fixed spacing
 * const heartbeat = Effect.gen(function*() {
 *   yield* Console.log("Heartbeat")
 * }).pipe(
 *   Effect.repeat(everyTwoSeconds)
 * )
 *
 * // Limited repeat - run only 5 times with 1-second spacing
 * const limitedTask = Effect.gen(function*() {
 *   yield* Console.log("Executing scheduled task...")
 *   yield* Effect.sleep("500 millis") // simulate work
 *   return "Task completed"
 * }).pipe(
 *   Effect.repeat(
 *     Schedule.spaced("1 second").pipe(Schedule.take(5))
 *   )
 * )
 *
 * // Simple spaced schedule with limited repetitions
 * const limitedSpaced = Schedule.spaced("100 millis").pipe(
 *   Schedule.both(Schedule.recurs(5)) // at most 5 times
 * )
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("Starting spaced execution...")
 *
 *   yield* Effect.repeat(
 *     Effect.succeed("work item"),
 *     limitedSpaced
 *   )
 *
 *   yield* Console.log("Completed executions")
 * })
 * ```
 *
 * @see {@link fixed} for recurrence aligned to a regular cadence
 *
 * @category constructors
 * @since 2.0.0
 */
export const spaced = (duration: Duration.Input): Schedule<number> => {
  const decoded = Duration.fromInputUnsafe(duration)
  return fromStepWithMetadata(effect.succeed((meta) => effect.succeed([meta.attempt - 1, decoded])))
}

/**
 * Returns a new `Schedule` that allows execution of an effectful function for
 * every decision of the schedule, but does not alter the inputs and outputs of
 * the schedule.
 *
 * **Details**
 *
 * The callback receives the full schedule metadata, including the input, output,
 * computed delay duration, current attempt, and elapsed timing information.
 *
 * **Example** (Tapping schedule metadata)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * const monitoredSchedule = Schedule.exponential("100 millis").pipe(
 *   Schedule.take(5),
 *   Schedule.tap((metadata) =>
 *     Console.log(
 *       `Attempt ${metadata.attempt} produced ${metadata.output} ` +
 *         `after ${metadata.elapsed}ms; next delay is ${metadata.duration}`
 *     )
 *   )
 * )
 *
 * const program = Effect.retry(
 *   Effect.fail("transient error"),
 *   monitoredSchedule
 * )
 * ```
 *
 * @category sequencing
 * @since 4.0.0
 */
export const tap: {
  <Output, Input, X, Error2, Env2>(
    f: (metadata: Metadata<Output, Input>) => Effect<X, Error2, Env2>
  ): <Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, X, Error2, Env2>(
    self: Schedule<Output, Input, Error, Env>,
    f: (metadata: Metadata<Output, Input>) => Effect<X, Error2, Env2>
  ): Schedule<Output, Input, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, X, Error2, Env2>(
  self: Schedule<Output, Input, Error, Env>,
  f: (metadata: Metadata<Output, Input>) => Effect<X, Error2, Env2>
): Schedule<Output, Input, Error | Error2, Env | Env2> =>
  fromStep(effect.map(toStep(self), (step) => {
    const meta = metadataFn()
    return (now, input) =>
      effect.tap(step(now, input), ([output, duration]) => f({ ...meta(now, input), output, duration }))
  })))

/**
 * Returns a new `Schedule` that allows execution of an effectful function for
 * every input to the schedule, but does not alter the inputs and outputs of
 * the schedule.
 *
 * **Example** (Tapping retry inputs)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryError extends Data.TaggedError("RetryError")<{ readonly message: string }> {}
 *
 * // Log retry errors for debugging
 * const errorLoggingSchedule = Schedule.exponential("100 millis").pipe(
 *   Schedule.take(3),
 *   Schedule.tapInput((error: RetryError) =>
 *     Console.log(`Retry triggered by error: ${String(error)}`)
 *   )
 * )
 *
 * const retryProgram = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   const result = yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       if (attempt < 4) {
 *         return yield* Effect.fail(new RetryError({ message: `Network timeout on attempt ${attempt}` }))
 *       }
 *       return `Success on attempt ${attempt}`
 *     }),
 *     errorLoggingSchedule
 *   )
 *
 *   yield* Console.log(`Final result: ${result}`)
 * })
 *
 * // Monitor input frequency for metrics
 * const inputMonitoringSchedule = Schedule.spaced("1 second").pipe(
 *   Schedule.take(5),
 *   Schedule.tapInput((input: unknown) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`Input type: ${typeof input}`)
 *       // In real applications, might send metrics to monitoring system
 *     })
 *   )
 * )
 *
 * // Input validation with side effects
 * const validatingSchedule = Schedule.fixed("500 millis").pipe(
 *   Schedule.take(4),
 *   Schedule.tapInput((input: any) =>
 *     Effect.gen(function*() {
 *       if (typeof input === "object" && input !== null) {
 *         yield* Console.log(`Valid object input: ${JSON.stringify(input)}`)
 *       } else {
 *         yield* Console.log(`Warning: Non-object input received: ${input}`)
 *       }
 *     })
 *   )
 * )
 *
 * const validationProgram = Effect.gen(function*() {
 *   let count = 0
 *
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       count++
 *       yield* Console.log("Task with validation")
 *       return { data: `sample-${count}` }
 *     }),
 *     validatingSchedule
 *   )
 * })
 *
 * // Conditional alerting based on input
 * const alertingSchedule = Schedule.exponential("200 millis").pipe(
 *   Schedule.take(6),
 *   Schedule.tapInput((error: RetryError) =>
 *     Effect.gen(function*() {
 *       if (String(error).includes("critical")) {
 *         yield* Console.log(`Critical error: ${String(error)}`)
 *         // In real applications, might trigger alerts or notifications
 *       } else {
 *         yield* Console.log(`Regular error: ${String(error)}`)
 *       }
 *     })
 *   )
 * )
 *
 * const alertProgram = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       const isCritical = attempt === 3
 *       const errorType = isCritical
 *         ? "critical database failure"
 *         : "temporary network issue"
 *       return yield* Effect.fail(new RetryError({ message: errorType }))
 *     }),
 *     alertingSchedule
 *   ).pipe(
 *     Effect.catch((error: unknown) =>
 *       Console.log(`All retries exhausted: ${String(error)}`)
 *     )
 *   )
 * })
 *
 * // Chain multiple input taps for different purposes
 * const comprehensiveSchedule = Schedule.fibonacci("100 millis").pipe(
 *   Schedule.take(5),
 *   Schedule.tapInput((error: RetryError) =>
 *     Console.log(`Error occurred: ${error._tag}`)
 *   ),
 *   Schedule.tapInput((error: RetryError) =>
 *     String(error).length > 20
 *       ? Console.log("Long error message detected")
 *       : Effect.void
 *   )
 * )
 * ```
 *
 * @category sequencing
 * @since 2.0.0
 */
export const tapInput: {
  <Input, X, Error2, Env2>(
    f: (input: Input) => Effect<X, Error2, Env2>
  ): <Output, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, X, Error2, Env2>(
    self: Schedule<Output, Input, Error, Env>,
    f: (input: Input) => Effect<X, Error2, Env2>
  ): Schedule<Output, Input, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, X, Error2, Env2>(
  self: Schedule<Output, Input, Error, Env>,
  f: (input: Input) => Effect<X, Error2, Env2>
): Schedule<Output, Input, Error | Error2, Env | Env2> =>
  fromStep(effect.map(
    toStep(self),
    (step) => (now, input) => effect.andThen(f(input), step(now, input))
  )))

/**
 * Returns a new `Schedule` that allows execution of an effectful function for
 * every output of the schedule, but does not alter the inputs and outputs of
 * the schedule.
 *
 * **Example** (Tapping schedule outputs)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * // Log schedule outputs for debugging/monitoring
 * const monitoredSchedule = Schedule.exponential("100 millis").pipe(
 *   Schedule.take(5),
 *   Schedule.tapOutput((delay) => Console.log(`Next delay will be: ${delay}`))
 * )
 *
 * const retryProgram = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   const result = yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       if (attempt < 4) {
 *         return yield* Effect.fail(new RetryAttemptError({ message: `Attempt ${attempt} failed` }))
 *       }
 *       return `Success on attempt ${attempt}`
 *     }),
 *     monitoredSchedule
 *   )
 *
 *   yield* Console.log(`Final result: ${result}`)
 * })
 *
 * // Tap output for metrics collection
 * const metricsSchedule = Schedule.spaced("1 second").pipe(
 *   Schedule.take(10),
 *   Schedule.tapOutput((executionCount) =>
 *     Effect.gen(function*() {
 *       // Simulate metrics collection
 *       yield* Console.log(`Recording metric: execution_count=${executionCount}`)
 *       // In real code, this might send to monitoring system
 *     })
 *   )
 * )
 *
 * // Tap output with conditional side effects
 * const alertingSchedule = Schedule.fibonacci("200 millis").pipe(
 *   Schedule.take(8),
 *   Schedule.tapOutput((delay) =>
 *     Effect.gen(function*() {
 *       const delayMs = delay.toString()
 *       if (delayMs.includes("1000")) { // Alert on delays >= 1 second
 *         yield* Console.log(`High delay detected: ${delay}`)
 *       }
 *     })
 *   )
 * )
 *
 * const healthCheckProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Performing health check...")
 *       return "healthy"
 *     }),
 *     alertingSchedule
 *   )
 * })
 *
 * // Chain multiple taps for different purposes
 * const comprehensiveSchedule = Schedule.fixed("500 millis").pipe(
 *   Schedule.take(6),
 *   Schedule.tapOutput((count) => Console.log(`Execution ${count + 1}`)),
 *   Schedule.tapOutput((count) =>
 *     count % 3 === 0
 *       ? Console.log("Checkpoint reached")
 *       : Effect.void
 *   )
 * )
 * ```
 *
 * @category sequencing
 * @since 2.0.0
 */
export const tapOutput: {
  <Output, X, Error2, Env2>(
    f: (output: Output) => Effect<X, Error2, Env2>
  ): <Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, X, Error2, Env2>(
    self: Schedule<Output, Input, Error, Env>,
    f: (output: Output) => Effect<X, Error2, Env2>
  ): Schedule<Output, Input, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, X, Error2, Env2>(
  self: Schedule<Output, Input, Error, Env>,
  f: (output: Output) => Effect<X, Error2, Env2>
): Schedule<Output, Input, Error | Error2, Env | Env2> =>
  fromStep(effect.map(
    toStep(self),
    (step) => (now, input) => effect.tap(step(now, input), ([output]) => f(output))
  )))

/**
 * Returns a new `Schedule` that takes at most the specified number of outputs
 * from the schedule. Once the specified number of outputs is reached, the
 * schedule will stop.
 *
 * **When to use**
 *
 * Use to limit an existing schedule while preserving its output and
 * delay behavior. Use `recurs` when you only need an immediate counter
 * schedule.
 *
 * **Gotchas**
 *
 * `take(n)` limits schedule outputs. When used with repeat or retry, the
 * effect is evaluated once before the schedule is stepped, so the total number
 * of evaluations can be one greater than the number of outputs taken.
 *
 * **Example** (Taking a limited number of recurrences)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * // Limit an infinite schedule to five recurrences
 * const limitedHeartbeat = Schedule.spaced("1 second").pipe(
 *   Schedule.take(5) // Will stop after 5 schedule outputs
 * )
 *
 * const heartbeatProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Heartbeat")
 *       return "pulse"
 *     }),
 *     limitedHeartbeat
 *   )
 *
 *   yield* Console.log("Heartbeat sequence completed")
 * })
 *
 * // Limit retry attempts to a specific number
 * const limitedRetry = Schedule.exponential("100 millis").pipe(
 *   Schedule.take(3) // At most 3 retry attempts
 * )
 *
 * const retryProgram = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   const result = yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       yield* Console.log(`Attempt ${attempt}`)
 *
 *       if (attempt < 5) { // Will fail more than 3 times
 *         return yield* Effect.fail(new RetryAttemptError({ message: `Attempt ${attempt} failed` }))
 *       }
 *
 *       return `Success on attempt ${attempt}`
 *     }),
 *     limitedRetry
 *   )
 *
 *   yield* Console.log(`Result: ${result}`)
 * }).pipe(
 *   Effect.catch((error: unknown) =>
 *     Console.log(`Failed after limited retries: ${String(error)}`)
 *   )
 * )
 *
 * // Combine take with other schedule operations
 * const samplingSchedule = Schedule.fixed("500 millis").pipe(
 *   Schedule.take(10), // Take at most 10 schedule outputs
 *   Schedule.map((count) => Effect.succeed(`Sample #${count + 1}`))
 * )
 *
 * const samplingProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       const value = "sample"
 *       yield* Console.log(`Sampled value: ${value}`)
 *       return value
 *     }),
 *     samplingSchedule.pipe(
 *       Schedule.tapOutput((label) => Console.log(`Completed: ${label}`))
 *     )
 *   )
 * })
 * ```
 *
 * @see {@link recurs} for creating a count-limited schedule
 *
 * @category utils
 * @since 4.0.0
 */
export const take: {
  (n: number): <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input, Error, Env>
  <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>,
    n: number
  ): Schedule<Output, Input, Error, Env>
} = dual(2, <Output, Input, Error, Env>(
  self: Schedule<Output, Input, Error, Env>,
  n: number
): Schedule<Output, Input, Error, Env> => while_(self, ({ attempt }) => effect.succeed(attempt <= n)))

/**
 * Creates a schedule that unfolds a state by repeatedly applying a function,
 * outputting the current state and computing the next state.
 *
 * **Example** (Unfolding schedule state)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Counter schedule that increments by 1 each time
 * const counterSchedule = Schedule.unfold(0, (n) => Effect.succeed(n + 1))
 * // Outputs: 0, 1, 2, 3, 4, 5, ...
 *
 * const countingProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "done"
 *     }),
 *     counterSchedule.pipe(
 *       Schedule.take(5),
 *       Schedule.tapOutput((count) => Console.log(`Count: ${count}`))
 *     )
 *   )
 * })
 *
 * // Fibonacci sequence schedule
 * const fibonacciSchedule = Schedule.unfold(
 *   [0, 1] as [number, number],
 *   ([a, b]) => Effect.succeed([b, a + b] as [number, number])
 * )
 * // Outputs: [0,1], [1,1], [1,2], [2,3], [3,5], [5,8], ...
 *
 * const fibProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Console.log("Fibonacci step"),
 *     fibonacciSchedule.pipe(
 *       Schedule.take(8),
 *       Schedule.tapOutput(([a, b]) => Console.log(`Fib: ${a}, next: ${b}`))
 *     )
 *   )
 * })
 *
 * // Effectful unfold - exponential backoff with state
 * const exponentialState = Schedule.unfold(
 *   100,
 *   (delayMs) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`Current delay: ${delayMs}ms`)
 *       return Math.min(delayMs * 2, 5000) // Cap at 5 seconds
 *     })
 * )
 *
 * // Deterministic delay adjustment schedule
 * const adjustedDelaySchedule = Schedule.unfold(
 *   { delay: 1000, adjustment: 100 },
 *   ({ delay, adjustment }) =>
 *     Effect.gen(function*() {
 *       const nextDelay = Math.max(100, delay + adjustment)
 *       yield* Console.log(`Adjusted delay: ${nextDelay}ms`)
 *       return { delay: nextDelay, adjustment: adjustment * -1 }
 *     })
 * )
 *
 * // State machine schedule
 * type State = "init" | "warming" | "active" | "cooling"
 * const stateMachineSchedule = Schedule.unfold("init" as State, (state) => {
 *   switch (state) {
 *     case "init":
 *       return Effect.succeed("warming" as State)
 *     case "warming":
 *       return Effect.succeed("active" as State)
 *     case "active":
 *       return Effect.succeed("cooling" as State)
 *     case "cooling":
 *       return Effect.succeed("active" as State)
 *   }
 * })
 *
 * const stateMachineProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("State machine step")
 *       return "step"
 *     }),
 *     stateMachineSchedule.pipe(
 *       Schedule.take(10),
 *       Schedule.tapOutput((state) => Console.log(`State: ${state}`))
 *     )
 *   )
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const unfold = <State, Error = never, Env = never>(
  initial: State,
  next: (state: State) => Effect<State, Error, Env>
): Schedule<State, unknown, Error, Env> =>
  fromStep(effect.sync(() => {
    let state = initial
    return constant(effect.map(
      effect.suspend(() => next(state)),
      (nextState) => {
        const prev = state
        state = nextState
        return [prev, Duration.zero] as const
      }
    ))
  }))

const while_: {
  <Input, Output, Error2 = never, Env2 = never>(
    predicate: (
      metadata: Metadata<Output, Input>
    ) => boolean | Effect<boolean, Error2, Env2>
  ): <Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Error2 = never, Env2 = never>(
    self: Schedule<Output, Input, Error, Env>,
    predicate: (
      metadata: Metadata<Output, Input>
    ) => boolean | Effect<boolean, Error2, Env2>
  ): Schedule<Output, Input, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Error2 = never, Env2 = never>(
  self: Schedule<Output, Input, Error, Env>,
  predicate: (
    metadata: Metadata<Output, Input>
  ) => boolean | Effect<boolean, Error2, Env2>
): Schedule<Output, Input, Error | Error2, Env | Env2> =>
  fromStep(effect.map(toStep(self), (step) => {
    const meta = metadataFn()
    return (now, input) =>
      effect.flatMap(step(now, input), (result) => {
        const [output, duration] = result
        const eff = predicate({ ...meta(now, input), output, duration })
        return effect.flatMap(
          isEffect(eff) ? eff : effect.succeed(eff),
          (check) => (check ? effect.succeed(result) : Cause.done(output))
        )
      })
  })))

export {
  /**
   * Returns a new schedule that continues while the predicate returns `true`.
   *
   * **When to use**
   *
   * Use to stop an existing schedule based on its full metadata, such as the
   * current input, output, attempt, delay, or elapsed time.
   *
   * **Details**
   *
   * The predicate receives `Metadata`, may return `boolean` or an
   * `Effect<boolean, ...>`, preserves the output and delay when it returns
   * `true`, and stops the schedule when it returns `false`.
   *
   * @see {@link collectWhile} for collecting outputs while using the same predicate
   * @see {@link take} for stopping after a fixed number of schedule outputs
   *
   * @category utils
   * @since 4.0.0
   */
  while_ as while
}

/**
 * Schedule that divides the timeline to `interval`-long windows, and sleeps
 * until the nearest window boundary every time it recurs.
 *
 * **Details**
 *
 * For example, `Schedule.windowed("10 seconds")` would produce a schedule as
 * follows:
 *
 * ```text
 *      10s        10s        10s       10s
 * |----------|----------|----------|----------|
 * |action------|sleep---|act|-sleep|action----|
 * ```
 *
 * **Example** (Repeating on aligned windows)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Execute tasks at regular intervals aligned to window boundaries
 * const windowSchedule = Schedule.windowed("5 seconds")
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Window task executed")
 *       return "window-task"
 *     }),
 *     windowSchedule.pipe(Schedule.take(4))
 *   )
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const windowed = (interval: Duration.Input): Schedule<number> => {
  const window = Duration.toMillis(Duration.fromInputUnsafe(interval))
  return fromStepWithMetadata(effect.succeed((meta) =>
    effect.sync(() => [
      meta.attempt - 1,
      window === 0 ? Duration.zero : Duration.millis(window - (meta.elapsed % window))
    ])
  ))
}

/**
 * Returns a new `Schedule` that will recur forever.
 *
 * **Details**
 *
 * The output of the schedule is the current count of its repetitions thus far
 * (i.e. `0, 1, 2, ...`).
 *
 * **Example** (Repeating forever)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // A schedule that runs forever with no delay
 * const infiniteSchedule = Schedule.forever
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Running forever...")
 *       return "continuous-task"
 *     }),
 *     infiniteSchedule.pipe(Schedule.take(5)) // Limit for demo
 *   )
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const forever: Schedule<number> = spaced(Duration.zero)

const constIdentity = fromStep(
  effect.succeed((_now, input: unknown) => effect.succeed([input, Duration.zero] as [unknown, Duration.Duration]))
)

const identity_ = <A>(): Schedule<A, A> => constIdentity as Schedule<A, A>

export {
  /**
   * Creates a schedule that always recurs, passing inputs directly as outputs.
   *
   * **When to use**
   *
   * Use when you need an infinite schedule that preserves input values as
   * outputs.
   *
   * **Details**
   *
   * This schedule runs indefinitely, returning each input value as its output
   * without modification. It effectively acts as a pass-through that simply
   * echoes its input values at each step.
   *
   * @see {@link forever} for an infinite schedule that returns incrementing step counts
   * @category constructors
   * @since 2.0.0
   */
  identity_ as identity
}

/**
 * Ensures that a schedule's input type extends a given type `T`.
 *
 * **When to use**
 *
 * Use to check an existing schedule input type. Use
 * `setInputType` to adapt a schedule that does not depend on its input values.
 *
 * **Details**
 *
 * This helper is checked at compile time and does not change the schedule's
 * runtime behavior.
 *
 * **Example** (Constraining schedule input types)
 *
 * ```ts
 * import { Schedule } from "effect"
 *
 * declare const StringInputSchedule: Schedule.Schedule<number, string>
 * declare const NumberInputSchedule: Schedule.Schedule<number, number>
 *
 * const satisfiesStringInput = Schedule.satisfiesInputType<string>()
 *
 * // This works because the schedule input type is string.
 * const validSchedule = satisfiesStringInput(StringInputSchedule)
 *
 * // This would cause a TypeScript compilation error:
 * // const invalidSchedule = satisfiesStringInput(NumberInputSchedule)
 * ```
 *
 * @see {@link setInputType} for adapting an input-agnostic schedule
 *
 * @category utility types
 * @since 4.0.0
 */
export const satisfiesInputType = <T>() =>
<Input extends T, Output = never, Error = never, Env = never>(
  self: Schedule<Output, Input, Error, Env>
): Schedule<Output, Input, Error, Env> => self

/**
 * Sets the input type of the provided schedule without altering its behavior.
 *
 * **When to use**
 *
 * Use to adapt a schedule that does not depend on its input
 * values. Use `satisfiesInputType` to check an existing schedule input type.
 *
 * **Details**
 *
 * This helper is checked at compile time and does not change the schedule's
 * runtime behavior.
 *
 * **Example** (Setting a schedule input type)
 *
 * ```ts
 * import { Schedule } from "effect"
 *
 * const schedule = Schedule.recurs(3).pipe(
 *   Schedule.setInputType<string>()
 * )
 * ```
 *
 * @see {@link satisfiesInputType} for checking an existing input type
 *
 * @category utility types
 * @since 4.0.0
 */
export const setInputType =
  <T>() => <Output, Error, Env>(self: Schedule<Output, T, Error, Env>): Schedule<Output, T, Error, Env> => self

/**
 * Ensures that a schedule's output type extends a given type `T`.
 *
 * **Details**
 *
 * This helper is checked at compile time and does not change the schedule's
 * runtime behavior.
 *
 * **Example** (Constraining schedule output types)
 *
 * ```ts
 * import { Schedule } from "effect"
 *
 * declare const StringOutputSchedule: Schedule.Schedule<string>
 * declare const NumberOutputSchedule: Schedule.Schedule<number>
 *
 * const satisfiesStringOutput = Schedule.satisfiesOutputType<string>()
 *
 * // This works because the schedule output type is string.
 * const validSchedule = satisfiesStringOutput(StringOutputSchedule)
 *
 * // This would cause a TypeScript compilation error:
 * // const invalidSchedule = satisfiesStringOutput(NumberOutputSchedule)
 * ```
 *
 * @category utility types
 * @since 4.0.0
 */
export const satisfiesOutputType = <T>() =>
<Output extends T, Error = never, Input = unknown, Env = never>(
  self: Schedule<Output, Input, Error, Env>
): Schedule<Output, Input, Error, Env> => self

/**
 * Ensures that a schedule's error type extends a given type `T`.
 *
 * **Details**
 *
 * This helper is checked at compile time and does not change the schedule's
 * runtime behavior.
 *
 * **Example** (Constraining schedule error types)
 *
 * ```ts
 * import { Data, Schedule } from "effect"
 *
 * // Create a custom error using Data.TaggedError
 * class CustomError extends Data.TaggedError("CustomError")<{
 *   message: string
 * }> {}
 *
 * declare const CustomErrorSchedule: Schedule.Schedule<number, unknown, CustomError>
 * declare const StringErrorSchedule: Schedule.Schedule<number, unknown, string>
 *
 * const satisfiesCustomError = Schedule.satisfiesErrorType<CustomError>()
 *
 * // This works because the schedule error type is CustomError.
 * const validSchedule = satisfiesCustomError(CustomErrorSchedule)
 *
 * // This would cause a TypeScript compilation error:
 * // const invalidSchedule = satisfiesCustomError(StringErrorSchedule)
 * ```
 *
 * @category utility types
 * @since 4.0.0
 */
export const satisfiesErrorType = <T>() =>
<Error extends T, Output = never, Input = unknown, Env = never>(
  self: Schedule<Output, Input, Error, Env>
): Schedule<Output, Input, Error, Env> => self

/**
 * Ensures that a schedule's context type extends a given type `T`.
 *
 * **Details**
 *
 * This helper is checked at compile time and does not change the schedule's
 * runtime behavior.
 *
 * **Example** (Constraining schedule service types)
 *
 * ```ts
 * import { Schedule } from "effect"
 *
 * interface Logger {
 *   readonly log: (message: string) => void
 * }
 *
 * declare const LoggerSchedule: Schedule.Schedule<number, unknown, never, Logger>
 * declare const NumberSchedule: Schedule.Schedule<number, unknown, never, number>
 *
 * const satisfiesLogger = Schedule.satisfiesServicesType<Logger>()
 *
 * // This works because the schedule context type is Logger.
 * const validSchedule = satisfiesLogger(LoggerSchedule)
 *
 * // This would cause a TypeScript compilation error:
 * // const invalidSchedule = satisfiesLogger(NumberSchedule)
 * ```
 *
 * @category utility types
 * @since 4.0.0
 */
export const satisfiesServicesType = <T>() =>
<Env extends T, Output = never, Input = unknown, Error = never>(
  self: Schedule<Output, Input, Error, Env>
): Schedule<Output, Input, Error, Env> => self
