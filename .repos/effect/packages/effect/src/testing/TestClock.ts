/**
 * Controllable `Clock` service for tests.
 *
 * Instead of waiting for real time to pass, effects that use `Effect.sleep`,
 * timeouts, schedules, retries, and other time-based operators can be driven by
 * advancing the test clock. This makes time-based tests deterministic and fast.
 * The module also includes helpers for moving test time, temporarily using the
 * live clock, and warning when a test appears to be waiting on time without
 * advancing it.
 *
 * @stability stable
 * @since 2.0.0
 */
import * as Arr from "../Array.ts"
import * as Clock from "../Clock.ts"
import * as Console from "../Console.ts"
import * as Context from "../Context.ts"
import * as Data from "../Data.ts"
import * as Duration from "../Duration.ts"
import * as Effect from "../Effect.ts"
import * as Fiber from "../Fiber.ts"
import { NodeInspectSymbol } from "../Inspectable.ts"
import * as Latch from "../Latch.ts"
import * as Layer from "../Layer.ts"
import * as Scheduler from "../Scheduler.ts"
import type * as Scope from "../Scope.ts"
import * as Semaphore from "../Semaphore.ts"

/**
 * A `TestClock` simplifies deterministic and efficient testing of effects that
 * involve the passage of time.
 *
 * **Details**
 *
 * Instead of waiting for actual time to pass, `sleep` and methods implemented
 * in terms of it schedule effects to take place at a given clock time. Use
 * `adjust` and `setTime` to move clock time, and all effects scheduled to take
 * place on or before that time will automatically run in order.
 *
 * **Gotchas**
 *
 * Calls to `sleep` and methods derived from it will semantically block until
 * the time is set to on or after the time they are scheduled to run. Fork the
 * effect being tested, then adjust the clock time, and finally verify that the
 * expected effects have been performed.
 * The ordered execution of sleeps registered after multiple scheduler hops
 * requires fibers running under {@link layer}; providing a clock from
 * {@link make} by hand does not install the tracking scheduler.
 *
 * **Example** (Testing timeouts deterministically)
 *
 * Tests `Effect.timeout` using `TestClock`.
 *
 * ```ts import.meta.vitest
 * import { Effect, Exit, Fiber, pipe } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   const fiber = yield* pipe(
 *     Effect.sleep("5 minutes"),
 *     Effect.timeout("1 minute"),
 *     Effect.forkChild
 *   )
 *   yield* TestClock.adjust("1 minute")
 *   const exit = yield* Fiber.await(fiber)
 *   Exit.isFailure(exit) // => true
 * })
 *
 * await Effect.runPromise(Effect.provide(program, TestClock.layer()))
 * ```
 *
 * **Example** (Advancing time deterministically)
 *
 * ```ts import.meta.vitest
 * import { Effect, Fiber } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   let executed = false
 *
 *   // Fork an effect that sleeps for 1 hour
 *   const fiber = yield* Effect.gen(function*() {
 *     yield* Effect.sleep("1 hour")
 *     executed = true
 *   }).pipe(Effect.forkChild)
 *
 *   // Advance the test clock by 1 hour
 *   yield* TestClock.adjust("1 hour")
 *   yield* Fiber.join(fiber)
 *
 *   // The effect should now be executed
 *   executed // => true
 * })
 *
 * await Effect.runPromise(Effect.provide(program, TestClock.layer()))
 * ```
 *
 * @stability stable
 * @category models
 * @since 2.0.0
 */
export interface TestClock extends Clock.Clock {
  /**
   * Increments the current clock time by the specified duration. Any effects
   * that were scheduled to occur on or before the new time will be run in
   * order.
   */
  adjust(duration: Duration.Input): Effect.Effect<void>
  /**
   * Sets the current clock time to the specified `timestamp`. Any effects that
   * were scheduled to occur on or before the new time will be run in order.
   */
  setTime(timestamp: number): Effect.Effect<void>
  /**
   * Executes the specified effect with the live `Clock` instead of the
   * `TestClock`.
   */
  withLive<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}

/**
 * Namespace containing `TestClock` configuration and state types.
 *
 * **Example** (Configuring a test clock)
 *
 * ```ts import.meta.vitest
 * import { Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   // Create a TestClock with custom options
 *   const testClock = yield* TestClock.make({
 *     warningDelay: "5 seconds"
 *   })
 *
 *   // Access the current state
 *   const currentTime = testClock.currentTimeMillisUnsafe()
 *   currentTime // => 0
 * })
 *
 * await Effect.runPromise(Effect.scoped(program))
 * ```
 *
 * @stability stable
 * @since 2.0.0
 */
export declare namespace TestClock {
  /**
   * Options used when constructing a `TestClock`. `warningDelay` controls how
   * long the live clock waits before logging a warning when a test uses time
   * without advancing the test clock, or when a fiber woken by the test clock
   * keeps running without suspending.
   *
   * **Example** (Configuring the warning delay)
   *
   * ```ts import.meta.vitest
   * import { Effect } from "effect"
   * import { TestClock } from "effect/testing"
   *
   * const program = Effect.gen(function*() {
   *   // Create a TestClock with custom warning delay
   *   const testClock = yield* TestClock.make({
   *     warningDelay: "30 seconds"
   *   })
   *
   *   // Use the TestClock in your test
   *   yield* testClock.adjust("1 hour")
   *   testClock.currentTimeMillisUnsafe() // => 3_600_000
   * })
   *
   * await Effect.runPromise(Effect.scoped(program))
   * ```
   *
   * @category options
   * @since 4.0.0
   */
  export interface Options {
    /**
     * The amount of time to wait before displaying a warning message when a
     * test is using time but is not advancing the `TestClock`, or when a fiber
     * woken by `adjust` or `setTime` keeps running without suspending.
     */
    readonly warningDelay?: Duration.Input
  }

  /**
   * Represents the state tracked by a `TestClock`, including the current
   * millisecond timestamp and the sleeps scheduled to resume when the clock
   * reaches their target time.
   *
   * @category models
   * @since 4.0.0
   */
  export interface State {
    readonly timestamp: number
    readonly sleeps: ReadonlyArray<[number, Latch.Latch]>
  }
}

/**
 * The warning message that will be displayed if a test is using time but is
 * not advancing the `TestClock`.
 */
const warningMessage = "A test is using time, but is not advancing the test " +
  "clock, which may result in the test hanging. Use TestClock.adjust to " +
  "manually advance the time."

/**
 * The warning message that will be displayed if a fiber woken by the
 * `TestClock` does not suspend within the warning delay.
 */
const busyWarningMessage = "A fiber woken by the test clock is still running " +
  "without suspending, so the test clock stopped waiting for it. Sleeps it " +
  "starts later may be scheduled relative to a later time."

/**
 * The live clock of each `TestClock`, so a `TestClock` constructed while
 * another one is the current clock uses the outer clock's live clock instead
 * of the outer `TestClock`, which only advances when adjusted.
 */
const liveClocks = new WeakMap<Clock.Clock, Clock.Clock>()

interface WakeTracker {
  pending: number
  onIdle: (() => void) | undefined
}

const defaultOptions: Required<TestClock.Options> = {
  warningDelay: "1 second"
}

const nanosPerMilli = BigInt(1_000_000)

const millisToNanos = (millis: number): bigint => {
  const wholeMillis = Math.floor(millis)
  const fractionalNanos = Math.floor((millis - wholeMillis) * 1_000_000)
  return BigInt(wholeMillis) * nanosPerMilli + BigInt(fractionalNanos)
}

/**
 * Creates a `TestClock` with optional configuration.
 *
 * **Gotchas**
 *
 * The guarantee that sleeps registered after multiple scheduler hops run in
 * order applies only to fibers running under {@link layer}, which
 * `@effect/vitest`'s `it.effect` uses. Providing a clock from `make` by hand
 * waits only one scheduler turn after each woken sleep. Prefer `layer` when
 * forked fibers sleep.
 *
 * **Example** (Creating a test clock)
 *
 * ```ts import.meta.vitest
 * import { Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   // Create a TestClock with default settings
 *   const testClock = yield* TestClock.make()
 *
 *   // Create a TestClock with custom warning delay
 *   const customTestClock = yield* TestClock.make({
 *     warningDelay: "10 seconds"
 *   })
 *
 *   // Use the TestClock to control time in tests
 *   yield* testClock.adjust("1 hour")
 *   const currentTime = testClock.currentTimeMillisUnsafe()
 *   currentTime // => 3_600_000
 * })
 *
 * await Effect.runPromise(Effect.scoped(program))
 * ```
 *
 * @stability stable
 * @category constructors
 * @since 4.0.0
 */
export const make = (options?: TestClock.Options): Effect.Effect<TestClock, never, Scope.Scope> =>
  Effect.map(makeWithScheduler(options), ([testClock]) => testClock)

interface SleepEntry {
  readonly timestamp: number
  readonly latch: Latch.Latch
}

class TestClockImpl implements TestClock {
  readonly config: Required<TestClock.Options>
  readonly liveClock: Clock.Clock
  readonly liveConsole: Console.Console
  readonly scheduler: TrackingScheduler
  // Sorted by descending timestamp, so `pop` wakes the earliest sleep first
  readonly sleeps: Array<SleepEntry> = []
  readonly warningSemaphore = Semaphore.makeUnsafe(1)
  readonly runSemaphore = Semaphore.makeUnsafe(1)
  currentTimestamp = 0
  currentWallNanos = BigInt(0)
  currentMonotonicNanos = BigInt(0)
  warningState: WarningState = WarningState.Start()
  /**
   * Tasks scheduled while waking a sleeper, and tasks scheduled by those tasks,
   * are counted by that wake's tracker so `run` can wait for the woken fiber,
   * and any fibers it resumes or forks, to suspend before checking the next
   * sleep.
   */
  currentTracker: WakeTracker | undefined = undefined

  constructor(options: TestClock.Options | undefined, context: Context.Context<never>) {
    this.config = { ...defaultOptions, ...options }
    const currentClock = Context.get(context, Clock.Clock)
    this.liveClock = liveClocks.get(currentClock) ?? currentClock
    this.liveConsole = Context.get(context, Console.Console)
    this.scheduler = new TrackingScheduler(this, Context.get(context, Scheduler.Scheduler))
  }

  // The `TestClock` methods are own arrow functions, so they still work when
  // detached from the clock or copied with a spread.

  readonly currentTimeMillisUnsafe = (): number => this.currentTimestamp
  readonly currentTimeNanosUnsafe = (): bigint => this.currentWallNanos
  readonly monotonicTimeNanosUnsafe = (): bigint => this.currentMonotonicNanos
  readonly currentTimeMillis = Effect.sync(this.currentTimeMillisUnsafe)
  readonly currentTimeNanos = Effect.sync(this.currentTimeNanosUnsafe)
  readonly monotonicTimeNanos = Effect.sync(this.monotonicTimeNanosUnsafe)

  readonly withLive = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, Clock.Clock, this.liveClock)

  readonly sleep = (duration: Duration.Duration): Effect.Effect<void> =>
    Effect.suspend(() => {
      const end = this.currentTimestamp + Duration.toMillis(duration)
      if (end <= this.currentTimestamp) return Effect.void
      const sleeps = this.sleeps
      return Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = { timestamp: end, latch: Latch.makeUnsafe() }
          // Insert before entries with an equal timestamp, so they wake in
          // registration order
          let low = 0
          let high = sleeps.length
          while (low < high) {
            const mid = (low + high) >>> 1
            if (sleeps[mid].timestamp > end) low = mid + 1
            else high = mid
          }
          sleeps.splice(low, 0, entry)
          return entry
        }),
        (entry) => Effect.andThen(this.warningStart, entry.latch.await),
        (entry) =>
          Effect.sync(() => {
            // The entry is already gone if `run` popped it
            const index = sleeps.indexOf(entry)
            if (index !== -1) sleeps.splice(index, 1)
          })
      )
    })

  readonly adjust = (input: Duration.Input): Effect.Effect<void> => {
    const duration = Duration.fromInputUnsafe(input)
    const millis = Duration.toMillis(duration)
    const nanos = Number.isFinite(millis) ? Duration.toNanosUnsafe(duration) : undefined
    return Effect.andThen(this.warningDone, this.run((timestamp) => timestamp + millis, nanos))
  }

  readonly setTime = (timestamp: number): Effect.Effect<void> =>
    Effect.andThen(this.warningDone, this.run(() => timestamp))

  /**
   * Forks a fiber that will display a warning message if a test is using time
   * but is not advancing the `TestClock`.
   */
  readonly warningStart: Effect.Effect<void> = this.warningSemaphore.withPermits(1)(
    Effect.suspend(() => {
      if (this.warningState._tag !== "Start") return Effect.void
      return Effect.logWarning(warningMessage).pipe(
        Effect.provideService(Console.Console, this.liveConsole),
        Effect.delay(this.config.warningDelay),
        this.withLive,
        // Child fibers are interruptible by default; preserve the caller's mask.
        Effect.forkChild,
        Effect.flatMap((fiber) =>
          Effect.sync(() => {
            this.warningState = WarningState.Pending({ fiber })
          })
        )
      )
    })
  )

  /**
   * Cancels the warning message that is displayed if a test is using time but
   * is not advancing the `TestClock`.
   */
  readonly warningDone: Effect.Effect<void> = this.warningSemaphore.withPermits(1)(
    Effect.suspend(() => {
      const state = this.warningState
      if (state._tag === "Pending") {
        return Fiber.interrupt(state.fiber).pipe(
          Effect.andThen(Effect.sync(() => {
            this.warningState = WarningState.Done()
          }))
        )
      }
      this.warningState = WarningState.Done()
      return Effect.void
    })
  )

  runTracked(tracker: WakeTracker, f: () => void): void {
    const previous = this.currentTracker
    this.currentTracker = tracker
    try {
      f()
    } finally {
      this.currentTracker = previous
    }
  }

  wake(latch: Latch.Latch): Effect.Effect<void> {
    return Effect.suspend(() => {
      const tracker: WakeTracker = { pending: 0, onIdle: undefined }
      this.runTracked(tracker, () => latch.openUnsafe())
      if (tracker.pending === 0) return Effect.yieldNow
      return Effect.callback<void>((resume) => {
        if (tracker.pending === 0) return resume(Effect.void)
        tracker.onIdle = () => resume(Effect.void)
        return Effect.sync(() => {
          tracker.onIdle = undefined
        })
      }).pipe(
        Effect.timeoutOrElse({
          duration: this.config.warningDelay,
          orElse: () => Effect.provideService(Effect.logWarning(busyWarningMessage), Console.Console, this.liveConsole)
        }),
        this.withLive,
        Effect.andThen(Effect.yieldNow)
      )
    })
  }

  advanceTo(timestamp: number): void {
    const deltaMillis = timestamp - this.currentTimestamp
    if (deltaMillis > 0 && Number.isFinite(deltaMillis)) {
      this.currentMonotonicNanos += BigInt(Math.round(deltaMillis * 1_000_000))
    }
    if (Number.isFinite(timestamp)) {
      this.currentWallNanos = millisToNanos(timestamp)
    }
    this.currentTimestamp = timestamp
  }

  run(step: (currentTimestamp: number) => number, adjustmentNanos?: bigint): Effect.Effect<void> {
    return this.runSemaphore.withPermits(1)(runBody.call(this, step, adjustmentNanos))
  }

  // Hides the internal state, which is circular and holds bigints. Own fields,
  // so a spread copy keeps them too.
  readonly toJSON = testClockToJSON
  readonly [NodeInspectSymbol] = testClockToJSON
}

function testClockToJSON(this: TestClockImpl): unknown {
  return { _id: "TestClock", currentTimeMillis: this.currentTimeMillisUnsafe() }
}

const runBody = Effect.fnUntraced(function*(
  this: TestClockImpl,
  step: (currentTimestamp: number) => number,
  adjustmentNanos?: bigint
) {
  yield* Fiber.await(yield* Effect.forkChild(Effect.yieldNow))
  const initialWallNanos = this.currentWallNanos
  const initialMonotonicNanos = this.currentMonotonicNanos
  const endTimestamp = step(this.currentTimestamp)
  const sleeps = this.sleeps
  while (Arr.isArrayNonEmpty(sleeps)) {
    if (Arr.lastNonEmpty(sleeps).timestamp > endTimestamp) break
    const entry = sleeps.pop()!
    this.advanceTo(entry.timestamp)
    yield* this.wake(entry.latch)
  }
  this.advanceTo(endTimestamp)
  if (adjustmentNanos !== undefined && Number.isFinite(endTimestamp)) {
    this.currentWallNanos = initialWallNanos + adjustmentNanos
    if (adjustmentNanos > BigInt(0)) {
      this.currentMonotonicNanos = initialMonotonicNanos + adjustmentNanos
    }
  }
})

class TrackingScheduler implements Scheduler.Scheduler {
  readonly clock: TestClockImpl
  readonly parent: Scheduler.Scheduler
  readonly executionMode: Scheduler.Scheduler["executionMode"]
  constructor(clock: TestClockImpl, parent: Scheduler.Scheduler) {
    this.clock = clock
    this.parent = parent
    this.executionMode = parent.executionMode
  }
  shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
    return this.parent.shouldYield(fiber)
  }
  makeDispatcher(): Scheduler.SchedulerDispatcher {
    const clock = this.clock
    const dispatcher = this.parent.makeDispatcher()
    return {
      scheduleTask(task, priority) {
        const tracker = clock.currentTracker
        if (tracker === undefined) {
          return dispatcher.scheduleTask(task, priority)
        }
        tracker.pending++
        dispatcher.scheduleTask(() => {
          try {
            clock.runTracked(tracker, task)
          } finally {
            if (--tracker.pending === 0) tracker.onIdle?.()
          }
        }, priority)
      },
      flush() {
        dispatcher.flush()
      }
    }
  }
}

const makeWithScheduler = Effect.fnUntraced(function*(
  options?: TestClock.Options
) {
  const testClock = new TestClockImpl(options, yield* Effect.context<never>())
  yield* Effect.addFinalizer(() => testClock.warningDone)
  liveClocks.set(testClock, testClock.liveClock)
  return [testClock, testClock.scheduler] as const
})

/**
 * Creates a `Layer` which constructs a `TestClock`.
 *
 * **Example** (Providing a test clock layer)
 *
 * ```ts import.meta.vitest
 * import { Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * // Create a TestClock layer
 * const testClockLayer = TestClock.layer()
 *
 * // Create a TestClock layer with custom options
 * const customTestClockLayer = TestClock.layer({
 *   warningDelay: "5 seconds"
 * })
 *
 * const program = Effect.gen(function*() {
 *   // Use the layer in your program
 *   yield* TestClock.adjust("1 hour")
 *   return yield* TestClock.testClockWith((testClock) =>
 *     Effect.succeed(testClock.currentTimeMillisUnsafe())
 *   )
 * })
 *
 * await Effect.runPromise(Effect.provide(program, testClockLayer)) // => 3_600_000
 * await Effect.runPromise(Effect.provide(program, customTestClockLayer)) // => 3_600_000
 * ```
 *
 * @stability stable
 * @category layers
 * @since 4.0.0
 */
export const layer = (options?: TestClock.Options): Layer.Layer<TestClock> =>
  Layer.effectContext(
    Effect.map(makeWithScheduler(options), ([testClock, scheduler]) =>
      Context.make(Clock.Clock, testClock).pipe(
        Context.add(Scheduler.Scheduler, scheduler)
      ))
  ) as any

/**
 * Retrieves the `TestClock` service for this test and uses it to run the
 * specified workflow.
 *
 * **Example** (Accessing the test clock)
 *
 * ```ts import.meta.vitest
 * import { Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   // Use testClockWith to access the TestClock instance
 *   const currentTime = yield* TestClock.testClockWith((testClock) =>
 *     Effect.succeed(testClock.currentTimeMillisUnsafe())
 *   )
 *
 *   // Adjust time using the TestClock instance
 *   yield* TestClock.testClockWith((testClock) => testClock.adjust("2 hours"))
 *
 *   currentTime // => 0
 * })
 *
 * await Effect.runPromise(Effect.provide(program, TestClock.layer()))
 * ```
 *
 * @stability stable
 * @category testing
 * @since 2.0.0
 */
export const testClockWith = <A, E, R>(
  f: (testClock: TestClock) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => Effect.withFiber((fiber) => f(fiber.getRef(Clock.Clock) as TestClock))

/**
 * Accesses a `TestClock` instance in the context and increments the time
 * by the specified duration, running any actions scheduled for on or before
 * the new time in order.
 *
 * **Example** (Advancing the test clock)
 *
 * ```ts import.meta.vitest
 * import { Effect, Fiber } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   let executed = false
 *
 *   // Fork an effect that sleeps for 30 minutes
 *   const fiber = yield* Effect.gen(function*() {
 *     yield* Effect.sleep("30 minutes")
 *     executed = true
 *   }).pipe(Effect.forkChild)
 *
 *   // Advance the clock by 30 minutes
 *   yield* TestClock.adjust("30 minutes")
 *   yield* Fiber.join(fiber)
 *
 *   // The effect should now be executed
 *   executed // => true
 * })
 *
 * await Effect.runPromise(Effect.provide(program, TestClock.layer()))
 * ```
 *
 * @stability stable
 * @category testing
 * @since 2.0.0
 */
export const adjust = (duration: Duration.Input): Effect.Effect<void> =>
  testClockWith((testClock) => testClock.adjust(duration))

/**
 * Sets the current clock time to the specified `timestamp`. Any effects that
 * were scheduled to occur on or before the new time will be run in order.
 *
 * **Example** (Setting the test clock time)
 *
 * ```ts import.meta.vitest
 * import { Duration, Effect, Fiber } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   let executed = false
 *
 *   // Fork an effect that sleeps for 2 hours
 *   const fiber = yield* Effect.gen(function*() {
 *     yield* Effect.sleep("2 hours")
 *     executed = true
 *   }).pipe(Effect.forkChild)
 *
 *   // Set the clock to a specific timestamp (2 hours from epoch)
 *   const targetTime = Duration.toMillis(Duration.hours(2))
 *   yield* TestClock.setTime(targetTime)
 *   yield* Fiber.join(fiber)
 *
 *   // The effect should now be executed
 *   executed // => true
 * })
 *
 * await Effect.runPromise(Effect.provide(program, TestClock.layer()))
 * ```
 *
 * @stability stable
 * @category testing
 * @since 2.0.0
 */
export const setTime = (timestamp: number): Effect.Effect<void> =>
  testClockWith((testClock) => testClock.setTime(timestamp))

/**
 * Executes the specified effect with the live `Clock` instead of the
 * `TestClock`.
 *
 * **Example** (Running with the live clock)
 *
 * ```ts import.meta.vitest
 * import { Clock, Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   // Get the current test time (starts at epoch)
 *   const testTime = yield* Clock.currentTimeMillis
 *   testTime // => 0
 *
 *   // Get the actual system time using withLive
 *   const realTime = yield* TestClock.withLive(Clock.currentTimeMillis)
 *   Number.isFinite(realTime) // => true
 *
 *   // Advance test time
 *   yield* TestClock.adjust("1 hour")
 *
 *   // Test time is now 1 hour ahead
 *   const newTestTime = yield* Clock.currentTimeMillis
 *   newTestTime // => 3_600_000
 * })
 *
 * await Effect.runPromise(Effect.provide(program, TestClock.layer()))
 * ```
 *
 * @stability stable
 * @category testing
 * @since 4.0.0
 */
export const withLive = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  testClockWith((testClock) => testClock.withLive(effect))

/**
 * `WarningState` describes the state of the warning message that is displayed
 * if a test is using time but is not advancing the `TestClock`.
 *
 * The possible states are:
 *   - `Start` if a test has not used time yet
 *   - `Pending` if a test has used time but has not adjusted the `TestClock`
 *   - `Done` if a test has adjusted the `TestClock` or the warning message
 *     has already been displayed.
 */
type WarningState = Data.TaggedEnum<{
  /**
   * The `WarningState` which indicates that a test has not yet used time.
   */
  readonly Start: {}
  /**
   * The `WarningState` which indicates that a test has used time but has not
   * adjusted the `TestClock`.
   *
   * The `Pending` state also includes a reference to the fiber that will
   * display the warning message.
   */
  readonly Pending: {
    readonly fiber: Fiber.Fiber<void, unknown>
  }
  /**
   * The `WarningState` which indicates that a test has used time, or that the
   * warning message has already been displayed.
   */
  readonly Done: {}
}>
const WarningState = Data.taggedEnum<WarningState>()
