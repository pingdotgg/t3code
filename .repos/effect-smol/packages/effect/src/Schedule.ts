/**
 * Describes policies for retrying, repeating, and pacing Effect programs.
 *
 * A `Schedule<Output, Input, Error, Env>` is stepped with an input value. Each
 * step either stops or produces an output together with the delay before the
 * next step. Schedules are used by retry, repeat, stream, and channel APIs to
 * decide when work should continue, how long to wait, and when to stop.
 *
 * @since 2.0.0
 */
import type { NonEmptyReadonlyArray } from "./Array.ts"
import * as Cause from "./Cause.ts"
import * as Context from "./Context.ts"
import * as Cron from "./Cron.ts"
import type * as DateTime from "./DateTime.ts"
import * as Duration from "./Duration.ts"
import type { Effect } from "./Effect.ts"
import { constant, dual, identity } from "./Function.ts"
import { isEffect } from "./internal/core.ts"
import * as effect from "./internal/effect.ts"
import * as random from "./internal/random.ts"
import { type Pipeable, pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import * as Pull from "./Pull.ts"
import * as Result from "./Result.ts"
import type { Contravariant, Covariant, Mutable, UnionToIntersection } from "./Types.ts"

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
 * const retrySchedule = Schedule.max([
 *   Schedule.exponential("100 millis"),
 *   Schedule.recurs(3)
 * ])
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
 *     Effect.repeat(repeatSchedule.pipe(Schedule.upTo({ times: 5 })))
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
   *   Schedule.upTo({ times: 5 })
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

/**
 * Extracts the output type from a `Schedule`.
 *
 * @category type extractors
 * @since 4.0.0
 */
export type Output<S> = S extends Schedule<infer Output, any, any, any> ? Output : never

/**
 * Extracts the input type from a `Schedule`.
 *
 * @category type extractors
 * @since 4.0.0
 */
export type Input<S> = S extends Schedule<any, infer Input, any, any> ? Input : never

/**
 * Extracts the error type from a `Schedule`.
 *
 * @category type extractors
 * @since 4.0.0
 */
export type Error<S> = S extends Schedule<any, any, infer Error, any> ? Error : never

/**
 * Extracts the service requirements from a `Schedule`.
 *
 * @category type extractors
 * @since 4.0.0
 */
export type Env<S> = S extends Schedule<any, any, any, infer Env> ? Env : never

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
 * const schedule = Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 3 }))
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
 * const schedule = Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 3 }))
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
 * // Add a deterministic extra delay based on the schedule metadata
 * const delayedSchedule = Schedule.addDelay(
 *   Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 5 })),
 *   ({ output }) =>
 *     Effect.succeed(Duration.millis(Duration.toMillis(output) * 0.25))
 * )
 *
 * const repeatProgram = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.succeed("delayed task"),
 *     delayedSchedule.pipe(
 *       Schedule.tap(({ output: delay }) =>
 *         Console.log(`Base delay: ${delay}`)
 *       )
 *     )
 *   )
 * })
 *
 * // Add adaptive delay based on execution count
 * const adaptiveSchedule = Schedule.addDelay(
 *   Schedule.recurs(6),
 *   ({ output: executionCount }) =>
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
 *       Schedule.tap(({ output: count }) =>
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
 *   Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 4 })),
 *   ({ output: executionNumber }) => {
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
 *   Schedule.exponential("50 millis").pipe(Schedule.upTo({ times: 4 })),
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
 * @category delays & timeouts
 * @since 2.0.0
 */
export const addDelay: {
  <Output, Input, Error2 = never, Env2 = never>(
    f: (metadata: Metadata<Output, Input>) => Effect<Duration.Input, Error2, Env2>
  ): <Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Error2 = never, Env2 = never>(
    self: Schedule<Output, Input, Error, Env>,
    f: (metadata: Metadata<Output, Input>) => Effect<Duration.Input, Error2, Env2>
  ): Schedule<Output, Input, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Error2 = never, Env2 = never>(
  self: Schedule<Output, Input, Error, Env>,
  f: (metadata: Metadata<Output, Input>) => Effect<Duration.Input, Error2, Env2>
): Schedule<Output, Input, Error | Error2, Env | Env2> =>
  modifyDelay(
    self,
    (metadata) => effect.map(f(metadata), (d) => Duration.sum(Duration.fromInputUnsafe(d), metadata.duration))
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
 *   Schedule.upTo({ times: 3 })
 * )
 * const slowRetries = Schedule.exponential("1 second").pipe(
 *   Schedule.upTo({ times: 2 })
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
  map(andThenResult(self, other), ({ output }) => effect.succeed(Result.merge(output))))

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
 *   Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 2 })),
 *   Schedule.spaced("500 millis").pipe(Schedule.upTo({ times: 2 }))
 * )
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.repeat(
 *     Effect.gen(function*() {
 *       yield* Console.log("Task executed")
 *       return "task-result"
 *     }),
 *     phaseTracker.pipe(
 *       Schedule.tap(({ output: result }) =>
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
): Schedule<Result.Result<Output2, Output>, Input & Input2, Error | Error2, Env | Env2> =>
  fromStep(effect.sync(() => {
    let currentSide = 0
    let currentStep:
      | undefined
      | ((now: number, input: Input & Input2) => Pull.Pull<
        [Result.Result<Output2, Output>, Duration.Duration],
        Error | Error2,
        Result.Result<Output2, Output>,
        Env | Env2
      >)
    const left = map(self, ({ output }) => Result.fail(output))
    const right = map(other, ({ output }) => Result.succeed(output))
    return function recur(
      now,
      input
    ): Pull.Pull<
      [Result.Result<Output2, Output>, Duration.Duration],
      Error | Error2,
      Result.Result<Output2, Output>,
      Env | Env2
    > {
      if (currentStep) return currentStep(now, input)
      return toStep<
        Result.Result<Output2, Output>,
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
 * Combines schedules by recurring while all schedules want to recur, using the
 * maximum delay between recurrences and outputting that maximum delay.
 *
 * **When to use**
 *
 * Use when a combined policy should continue only while every schedule still
 * recurs, and should wait for the slowest schedule between recurrences.
 *
 * **Example** (Combining retry schedules by their maximum delay)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * const retrySchedule = Schedule.max([
 *   Schedule.fixed("5 seconds"),
 *   Schedule.exponential("5 seconds"),
 *   Schedule.spaced("10 seconds")
 * ])
 *
 * const program = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       yield* Console.log(`Retry attempt ${attempt}`)
 *       if (attempt < 3) {
 *         return yield* Effect.fail(new RetryAttemptError({ message: `Attempt ${attempt} failed` }))
 *       }
 *       return "success"
 *     }),
 *     retrySchedule.pipe(
 *       Schedule.tap(({ output: duration }) =>
 *         Console.log(`Waiting for the slowest schedule: ${duration}`)
 *       )
 *     )
 *   )
 * })
 * ```
 *
 * @category combining
 * @since 4.0.0
 */
export const max = <
  const Schedules extends NonEmptyReadonlyArray<
    Schedule<any, any, any, any>
  >
>(
  schedules: Schedules
): Schedule<
  Duration.Duration,
  UnionToIntersection<
    Input<Schedules[number]>
  >,
  Error<Schedules[number]>,
  Env<Schedules[number]>
> =>
  fromStep(effect.map(
    effect.all(schedules.map(toStep)),
    (steps) => (now, input) =>
      effect.flatMap(
        effect.forEach(steps, (step) =>
          Pull.matchEffect(step(now, input as never), {
            onSuccess: (result) => effect.succeed(result[1]),
            onDone: () => effect.undefined,
            onFailure: effect.failCause
          })),
        (results) => {
          const duration = maxDuration(results)
          if (duration === undefined) {
            return Cause.done(Duration.zero)
          }
          return effect.succeed([duration, duration] as [Duration.Duration, Duration.Duration])
        }
      )
  ))

const maxDuration = (results: ReadonlyArray<Duration.Duration | undefined>): Duration.Duration | undefined => {
  let max = results[0]
  for (let i = 1; i < results.length; i++) {
    max = results[i] && max && Duration.max(max, results[i]!)
    if (max === undefined) break
  }

  return max
}

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
 *       Schedule.upTo({ times: 3 }), // Run only 3 times for demo
 *       Schedule.tap(({ output: duration }) =>
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
 *       Schedule.upTo({ times: 2 }) // Run 2 times for demo
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
 *     weeklyReport.pipe(Schedule.upTo({ times: 1 }))
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
 *       Schedule.upTo({ times: 4 }) // Demo with 4 checks
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
 *     monthlyInvoice.pipe(Schedule.upTo({ times: 1 }))
 *   )
 * })
 *
 * // Complex cron with error handling
 * const complexCron = Schedule.cron("0 2,4,6 * * *").pipe(
 *   Schedule.tap(({ output: duration }) =>
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
 *     complexCron.pipe(Schedule.upTo({ times: 3 }))
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
  return fromStep(effect.map(effect.fromResult(parsed), (cron) => (now, _) => {
    if (now === Number.POSITIVE_INFINITY) {
      return Cause.done(Duration.zero)
    }
    return effect.sync(() => {
      const next = Cron.next(cron, now).getTime()
      const duration = Duration.millis(next - now)
      return [duration, duration]
    })
  }))
}

/**
 * Returns a schedule that recurs once after the specified duration.
 *
 * **When to use**
 *
 * Use when you need a schedule that recurs once after a fixed delay.
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
 * Use to bound a repeating or retrying schedule by elapsed time.
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
 *       Schedule.tap(({ output: elapsedDuration }) =>
 *         Console.log(`Total elapsed: ${elapsedDuration}`)
 *       )
 *     )
 *   )
 *
 *   yield* Console.log("Time limit reached!")
 * })
 *
 * // Combine with other schedules for time-bounded execution
 * const timeAndCountLimited = Schedule.max([
 *   Schedule.spaced("1 second"),
 *   Schedule.during("10 seconds"), // Stop after 10 seconds OR
 *   Schedule.recurs(15) // 15 attempts, whichever comes first
 * ])
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
 * const timedRetry = Schedule.max([
 *   Schedule.exponential("200 millis"),
 *   Schedule.during("30 seconds")
 * ])
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
export const during = (duration: Duration.Input): Schedule<Duration.Duration> => {
  const durationMillis = Duration.toMillis(duration)
  return fromStepWithMetadata(
    effect.succeed((meta) => {
      const elapsed = Duration.millis(meta.elapsed)
      return meta.elapsed > durationMillis
        ? effect.succeed([elapsed, Duration.zero])
        : Cause.done(elapsed)
    })
  )
}

/**
 * Combines schedules by recurring while at least one schedule wants to recur,
 * using the minimum delay between recurrences and outputting that minimum delay.
 *
 * **When to use**
 *
 * Use when a combined policy should continue while any schedule still recurs,
 * and should wait for the fastest schedule between recurrences.
 *
 * **Example** (Combining retry schedules by their minimum delay)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * const retrySchedule = Schedule.min([
 *   Schedule.fixed("5 seconds"),
 *   Schedule.exponential("5 seconds"),
 *   Schedule.spaced("10 seconds")
 * ])
 *
 * const program = Effect.gen(function*() {
 *   let attempt = 0
 *
 *   yield* Effect.retry(
 *     Effect.gen(function*() {
 *       attempt++
 *       yield* Console.log(`Retry attempt ${attempt}`)
 *       if (attempt < 3) {
 *         return yield* Effect.fail(new RetryAttemptError({ message: `Attempt ${attempt} failed` }))
 *       }
 *       return "success"
 *     }),
 *     retrySchedule.pipe(
 *       Schedule.tap(({ output: duration }) =>
 *         Console.log(`Waiting for the fastest schedule: ${duration}`)
 *       )
 *     )
 *   )
 * })
 * ```
 *
 * @category combining
 * @since 4.0.0
 */
export const min = <
  const Schedules extends NonEmptyReadonlyArray<
    Schedule<any, any, any, any>
  >
>(
  schedules: Schedules
): Schedule<
  Duration.Duration,
  UnionToIntersection<
    Input<Schedules[number]>
  >,
  Error<Schedules[number]>,
  Env<Schedules[number]>
> =>
  fromStep(effect.map(
    effect.all(schedules.map(toStep)),
    (steps) => (now, input) =>
      effect.flatMap(
        effect.forEach(steps, (step) =>
          Pull.matchEffect(step(now, input as never), {
            onSuccess: (result) => effect.succeed(result[1]),
            onDone: () => effect.undefined,
            onFailure: effect.failCause
          })),
        (results) => {
          const duration = minDuration(results)
          if (duration === undefined) {
            return Cause.done(Duration.zero)
          }
          return effect.succeed([duration, duration] as [Duration.Duration, Duration.Duration])
        }
      )
  ))

const minDuration = (results: ReadonlyArray<Duration.Duration | undefined>): Duration.Duration | undefined => {
  let min: Duration.Duration | undefined = undefined
  for (let i = 0; i < results.length; i++) {
    const duration = results[i]
    if (duration !== undefined) {
      min = min === undefined ? duration : Duration.min(min, duration)
    }
  }

  return min
}

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
 * const retryPolicy = Schedule.max([
 *   Schedule.exponential("50 millis"),
 *   Schedule.recurs(5)
 * ])
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
 *     Schedule.max([
 *       Schedule.fibonacci("50 millis"),
 *       Schedule.recurs(6) // Maximum 6 retries
 *     ]).pipe(
 *       Schedule.tap(({ output: delay }) => Console.log(`Next retry in ${delay}`))
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
 *       Schedule.upTo({ times: 8 }) // First 8 heartbeats
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
 * Use when recurrences should stay aligned to a regular cadence.
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
 *   Effect.repeat(Schedule.fixed("2 seconds").pipe(Schedule.upTo({ times: 5 })))
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
 *   Effect.repeat(Schedule.fixed("1 second").pipe(Schedule.upTo({ times: 3 })))
 * )
 *
 * // Comparing with spaced (waits 1s AFTER each task)
 * const spacedSchedule = longRunningTask.pipe(
 *   Effect.repeat(Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 3 })))
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
 * Returns a new `Schedule` that maps each schedule decision to a new output
 * using the full schedule metadata.
 *
 * **Details**
 *
 * The callback receives the schedule input, output, selected delay duration,
 * current attempt, and elapsed timing information. Return either a plain value
 * or an `Effect` that produces the new output.
 *
 * **Example** (Mapping schedule outputs)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * // Transform schedule output from number to string
 * const countSchedule = Schedule.recurs(5).pipe(
 *   Schedule.map(({ output: count }) => Effect.succeed(`Execution #${count + 1}`))
 * )
 *
 * // Map schedule delays to human-readable format
 * const readableDelays = Schedule.exponential("100 millis").pipe(
 *   Schedule.map(({ output: delay }) => Effect.succeed(`Next retry in ${delay}`))
 * )
 *
 * // Transform numeric output to structured data
 * const structuredSchedule = Schedule.spaced("1 second").pipe(
 *   Schedule.map(({ output: recurrence }) => Effect.succeed({
 *     iteration: recurrence + 1,
 *     phase: recurrence < 5 ? "warmup" as const : "steady" as const
 *   }))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const results = yield* Effect.repeat(
 *     Effect.succeed("task completed"),
 *     structuredSchedule.pipe(
 *       Schedule.upTo({ times: 8 }),
 *       Schedule.tap(({ output: info }) =>
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
 *   Schedule.map(({ output: count }) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`Processing count: ${count}`)
 *       return count * 10
 *     })
 *   )
 * )
 *
 * // Use timing metadata in the mapped output
 * const complexSchedule = Schedule.fibonacci("100 millis").pipe(
 *   Schedule.map(({ output: delay, attempt }) =>
 *     Effect.succeed(`Attempt ${attempt} delay: ${delay}`)
 *   )
 * )
 * ```
 *
 * @category mapping
 * @since 2.0.0
 */
export const map: {
  <Input, Output, Output2, Error2 = never, Env2 = never>(
    f: (metadata: Metadata<Output, Input>) => Output2 | Effect<Output2, Error2, Env2>
  ): <Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output2, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Output2, Error2 = never, Env2 = never>(
    self: Schedule<Output, Input, Error, Env>,
    f: (metadata: Metadata<Output, Input>) => Output2 | Effect<Output2, Error2, Env2>
  ): Schedule<Output2, Input, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Output2, Error2 = never, Env2 = never>(
  self: Schedule<Output, Input, Error, Env>,
  f: (metadata: Metadata<Output, Input>) => Output2 | Effect<Output2, Error2, Env2>
): Schedule<Output2, Input, Error | Error2, Env | Env2> =>
  fromStep(effect.map(toStep(self), (step) => {
    const meta = metadataFn()
    return (now, input) =>
      Pull.matchEffect(step(now, input), {
        onSuccess: ([output, duration]) => {
          const result = f({ ...meta(now, input), output, duration })
          if (!isEffect(result)) return effect.succeed([result, duration] as [Output2, Duration.Duration])
          return effect.map(result, (output) => [output, duration] as [Output2, Duration.Duration])
        },
        onFailure: effect.failCause<Error>,
        onDone: (output) => {
          const result = f({ ...meta(now, input), output, duration: Duration.zero })
          if (!isEffect(result)) return Cause.done(result as Output2)
          return effect.flatMap(result, Cause.done)
        }
      })
  })))

/**
 * Returns a new `Schedule` that modifies the delay of the next recurrence
 * of the schedule using the specified effectful function.
 *
 * **Example** (Modifying delays from schedule metadata)
 *
 * ```ts
 * import { Console, Duration, Effect, Schedule } from "effect"
 *
 * // Modify delays based on output - increase delay on high iteration counts
 * const adaptiveDelay = Schedule.recurs(10).pipe(
 *   Schedule.modifyDelay(({ output, duration }) => {
 *     // Double the delay if we're seeing high iteration counts
 *     return Effect.succeed(output > 5 ? Duration.times(duration, 2) : duration)
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
 *     adaptiveDelay.pipe(Schedule.upTo({ times: 8 }))
 *   )
 * })
 * ```
 *
 * @category delays & timeouts
 * @since 2.0.0
 */
export const modifyDelay: {
  <Output, Input, Error2 = never, Env2 = never>(
    f: (
      metadata: Metadata<Output, Input>
    ) => Effect<Duration.Input, Error2, Env2>
  ): <Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input, Error | Error2, Env | Env2>
  <Output, Input, Error, Env, Error2 = never, Env2 = never>(
    self: Schedule<Output, Input, Error, Env>,
    f: (
      metadata: Metadata<Output, Input>
    ) => Effect<Duration.Input, Error2, Env2>
  ): Schedule<Output, Input, Error | Error2, Env | Env2>
} = dual(2, <Output, Input, Error, Env, Error2 = never, Env2 = never>(
  self: Schedule<Output, Input, Error, Env>,
  f: (
    metadata: Metadata<Output, Input>
  ) => Effect<Duration.Input, Error2, Env2>
): Schedule<Output, Input, Error | Error2, Env | Env2> =>
  fromStep(effect.map(toStep(self), (step) => {
    const meta = metadataFn()
    return (now, input) =>
      effect.flatMap(
        step(now, input),
        ([output, duration]) =>
          effect.map(f({ ...meta(now, input), output, duration }), (replacement) => [
            output,
            Duration.fromInputUnsafe(replacement)
          ])
      )
  })))

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
 * @category delays & timeouts
 * @since 2.0.0
 */
export const jittered = <Output, Input, Error, Env>(
  self: Schedule<Output, Input, Error, Env>
): Schedule<Output, Input, Error, Env> =>
  modifyDelay(self, ({ duration }) =>
    effect.map(randomNext, (random) => {
      const millis = Duration.toMillis(duration)
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
 *   Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 3 }))
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
 * @category mapping
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
 * Use when you need a counter schedule with no additional delay.
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
 * const complexRetry = Schedule.max([
 *   Schedule.exponential("100 millis"),
 *   Schedule.recurs(3) // At most 3 retries
 * ])
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
 *   Schedule.tap(({ output: count }) => Console.log(`Execution #${count + 1}`))
 * )
 * ```
 *
 * @see {@link upTo} for limiting an existing schedule
 *
 * @category constructors
 * @since 2.0.0
 */
export const recurs = (times: number): Schedule<number> =>
  while_(forever, ({ attempt }) => effect.succeed(attempt <= times))

/**
 * Returns a schedule that recurs continuously, each repetition spaced the
 * specified duration from the last run.
 *
 * **When to use**
 *
 * Use when each delay should start after the previous action completes.
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
 *     Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 5 }))
 *   )
 * )
 *
 * // Simple spaced schedule with limited repetitions
 * const limitedSpaced = Schedule.max([
 *   Schedule.spaced("100 millis"),
 *   Schedule.recurs(5) // at most 5 times
 * ])
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
 *   Schedule.upTo({ times: 5 }),
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
 * Returns a new `Schedule` that limits an existing schedule by elapsed
 * duration, number of outputs, or both.
 *
 * **When to use**
 *
 * Use to bound an existing schedule while preserving its output and delay
 * behavior. When both `duration` and `times` are specified, the schedule
 * stops as soon as either limit is reached.
 *
 * **Gotchas**
 *
 * The `times` option limits schedule outputs. When used with repeat or retry,
 * the effect is evaluated once before the schedule is stepped, so the total
 * number of evaluations can be one greater than the configured number of
 * outputs.
 *
 * The `duration` option is based on the elapsed time observed by the schedule
 * step. Long-running effects can cause the duration limit to be detected on the
 * following schedule step.
 *
 * **Example** (Limiting by duration and recurrence count)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class RetryAttemptError extends Data.TaggedError("RetryAttemptError")<{ readonly message: string }> {}
 *
 * // Limit an infinite schedule to five recurrences
 * const limitedHeartbeat = Schedule.spaced("1 second").pipe(
 *   Schedule.upTo({ times: 5 })
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
 * // Limit retry attempts by both count and elapsed time
 * const limitedRetry = Schedule.exponential("100 millis").pipe(
 *   Schedule.upTo({
 *     duration: "5 seconds",
 *     times: 3
 *   })
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
 * // Empty options leave the schedule unchanged
 * const unchanged = Schedule.fixed("500 millis").pipe(
 *   Schedule.upTo({})
 * )
 * ```
 *
 * @category filtering
 * @since 4.0.0
 */
export const upTo: {
  (options: {
    readonly duration?: Duration.Input | undefined
    readonly times?: number | undefined
  }): <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>
  ) => Schedule<Output, Input, Error, Env>
  <Output, Input, Error, Env>(
    self: Schedule<Output, Input, Error, Env>,
    options: {
      readonly duration?: Duration.Input | undefined
      readonly times?: number | undefined
    }
  ): Schedule<Output, Input, Error, Env>
} = dual(2, <Output, Input, Error, Env>(
  self: Schedule<Output, Input, Error, Env>,
  options: {
    readonly duration?: Duration.Input | undefined
    readonly times?: number | undefined
  }
): Schedule<Output, Input, Error, Env> => {
  const duration = options.duration === undefined ? undefined : Duration.fromInputUnsafe(options.duration)
  return while_(self, ({ attempt, elapsed }) =>
    effect.succeed(
      (options.times === undefined || attempt <= options.times) &&
        (duration === undefined || Duration.isLessThanOrEqualTo(Duration.millis(elapsed), duration))
    ))
})

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
   * @see {@link upTo} for stopping after a fixed number of schedule outputs
   *
   * @category filtering
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
 *     windowSchedule.pipe(Schedule.upTo({ times: 4 }))
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
 *     infiniteSchedule.pipe(Schedule.upTo({ times: 5 })) // Limit for demo
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
 * Sets the input type of the provided schedule without altering its behavior.
 *
 * **When to use**
 *
 * Use to adapt a schedule that does not depend on its input values.
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
 * @category utility types
 * @since 4.0.0
 */
export const setInputType =
  <T>() => <Output, Error, Env>(self: Schedule<Output, T, Error, Env>): Schedule<Output, T, Error, Env> => self
