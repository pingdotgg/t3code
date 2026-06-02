/**
 * The `FiberHandle` module provides a scoped handle for managing the lifecycle
 * of at most one fiber at a time. A `FiberHandle<A, E>` can hold one
 * `Fiber<A, E>`; when a new fiber is installed, the previous fiber is
 * interrupted unless the operation is configured with `onlyIfMissing`.
 *
 * **Mental model**
 *
 * - A handle is either open with zero or one current fiber, or closed by its
 *   surrounding `Scope`
 * - Closing the scope interrupts the current fiber and prevents new work from
 *   being accepted
 * - Completed fibers remove themselves from the handle, so the handle can be
 *   reused for later work
 * - Replacing a fiber uses the handle's internal interruption id, allowing
 *   expected replacement interruptions to be distinguished from real failures
 *
 * **Common tasks**
 *
 * - Create a scoped handle: {@link make}
 * - Fork an effect into the handle: {@link run}
 * - Store an existing fiber: {@link set}
 * - Read or clear the current fiber: {@link get}, {@link clear}
 * - Capture runtime-specific runners: {@link makeRuntime}, {@link runtime}
 * - Run handled effects as Promises: {@link makeRuntimePromise},
 *   {@link runtimePromise}
 * - Wait for failure or closure: {@link join}
 * - Wait until the current fiber is gone: {@link awaitEmpty}
 *
 * **Gotchas**
 *
 * - The handle never contains more than one live fiber; starting or setting
 *   another fiber interrupts the previous one by default
 * - Use `onlyIfMissing` when a call should leave an already running fiber in
 *   place instead of replacing it
 * - `join` observes the handle's failure/close signal; successful fiber
 *   completion only empties the handle
 * - `awaitEmpty` waits for the fiber that is current when it starts; later
 *   calls to {@link run} or {@link set} can install new work
 *
 * @since 2.0.0
 */
import * as Cause from "./Cause.ts"
import type { Context } from "./Context.ts"
import * as Deferred from "./Deferred.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import * as Fiber from "./Fiber.ts"
import * as Filter from "./Filter.ts"
import { dual } from "./Function.ts"
import type * as Inspectable from "./Inspectable.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import type { Scheduler } from "./Scheduler.ts"
import type * as Scope from "./Scope.ts"

const TypeId = "~effect/FiberHandle"

/**
 * Scoped handle that manages at most one fiber, interrupts the current fiber
 * when the handle's scope closes, and removes managed fibers from the handle
 * when they complete.
 *
 * **Example** (Managing a single fiber)
 *
 * ```ts
 * import { Effect, Fiber, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   // Create a FiberHandle that can hold fibers producing strings
 *   const handle = yield* FiberHandle.make<string, never>()
 *
 *   // The handle can store and manage a single fiber
 *   const fiber = yield* FiberHandle.run(handle, Effect.succeed("hello"))
 *   const result = yield* Fiber.await(fiber)
 *   console.log(result) // "hello"
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface FiberHandle<out A = unknown, out E = unknown> extends Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId
  readonly deferred: Deferred.Deferred<void, unknown>
  state: {
    readonly _tag: "Open"
    fiber: Fiber.Fiber<A, E> | undefined
  } | {
    readonly _tag: "Closed"
  }
}

/**
 * Returns `true` if a value is a `FiberHandle` by checking for the
 * `FiberHandle` runtime marker.
 *
 * **Example** (Checking fiber handles)
 *
 * ```ts
 * import { Effect, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *
 *   console.log(FiberHandle.isFiberHandle(handle)) // true
 *   console.log(FiberHandle.isFiberHandle("not a handle")) // false
 * })
 * ```
 *
 * @category refinements
 * @since 2.0.0
 */
export const isFiberHandle = (u: unknown): u is FiberHandle => Predicate.hasProperty(u, TypeId)

const Proto = {
  [TypeId]: TypeId,
  ...PipeInspectableProto,
  toJSON(this: FiberHandle) {
    return {
      _id: "FiberHandle",
      state: this.state
    }
  }
}

const makeUnsafe = <A = unknown, E = unknown>(): FiberHandle<A, E> => {
  const self = Object.create(Proto)
  self.state = { _tag: "Open", fiber: undefined }
  self.deferred = Deferred.makeUnsafe()
  return self
}

/**
 * Creates a scoped `FiberHandle` that can store a single fiber.
 *
 * **Details**
 *
 * When the associated `Scope` is closed, the contained fiber will be
 * interrupted. You can add a fiber to the handle using `FiberHandle.run`, and
 * the fiber will be automatically removed from the `FiberHandle` when it
 * completes.
 *
 * **Example** (Creating a scoped fiber handle)
 *
 * ```ts
 * import { Effect, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *
 *   // run some effects
 *   yield* FiberHandle.run(handle, Effect.never)
 *   // this will interrupt the previous fiber
 *   yield* FiberHandle.run(handle, Effect.never)
 *
 *   yield* Effect.sleep(1000)
 * }).pipe(
 *   Effect.scoped // The fiber will be interrupted when the scope is closed
 * )
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const make = <A = unknown, E = unknown>(): Effect.Effect<FiberHandle<A, E>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => makeUnsafe<A, E>()),
    (handle) => {
      const state = handle.state
      if (state._tag === "Closed") return Effect.void
      handle.state = { _tag: "Closed" }
      return state.fiber ?
        Deferred.into(
          Effect.asVoid(Fiber.interruptAs(state.fiber, internalFiberId)),
          handle.deferred
        ) :
        Deferred.done(handle.deferred, Exit.void)
    }
  )

/**
 * Creates a scoped run function that forks effects into a new `FiberHandle`.
 *
 * **Details**
 *
 * Each call returns the forked fiber, stores it in the handle, and interrupts
 * the previous fiber unless `onlyIfMissing` is set. The managed fiber is
 * interrupted when the handle's scope closes.
 *
 * **Example** (Running effects with a fiber handle)
 *
 * ```ts
 * import { Effect, Fiber, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const run = yield* FiberHandle.makeRuntime<never>()
 *
 *   // Run effects and get fibers back
 *   const fiberA = run(Effect.succeed("first"))
 *   const fiberB = run(Effect.succeed("second"))
 *
 *   // The second fiber will interrupt the first
 *   const resultA = yield* Fiber.await(fiberA)
 *   const resultB = yield* Fiber.await(fiberB)
 * }).pipe(Effect.scoped)
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const makeRuntime = <R, E = unknown, A = unknown>(): Effect.Effect<
  <XE extends E, XA extends A>(
    effect: Effect.Effect<XA, XE, R>,
    options?:
      | {
        readonly signal?: AbortSignal | undefined
        readonly scheduler?: Scheduler | undefined
        readonly onlyIfMissing?: boolean | undefined
        readonly propagateInterruption?: boolean | undefined
      }
      | undefined
  ) => Fiber.Fiber<XA, XE>,
  never,
  Scope.Scope | R
> =>
  Effect.flatMap(
    make<A, E>(),
    (self) => runtime(self)<R>()
  )

/**
 * Creates a scoped run function that forks effects into a new `FiberHandle`
 * and returns a `Promise` for each effect result.
 *
 * **Details**
 *
 * Each call stores the fiber in the handle and interrupts the previous fiber
 * unless `onlyIfMissing` is set. The returned Promise resolves with the
 * effect's success value or rejects with the squashed failure cause.
 *
 * **Example** (Running effects as promises)
 *
 * ```ts
 * import { Effect, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const run = yield* FiberHandle.makeRuntimePromise()
 *
 *   // Run effects and get promises back
 *   const promise = run(Effect.succeed("hello"))
 *   const result = yield* Effect.promise(() => promise)
 *   console.log(result) // "hello"
 * }).pipe(Effect.scoped)
 * ```
 *
 * @category constructors
 * @since 3.13.0
 */
export const makeRuntimePromise = <R = never, A = unknown, E = unknown>(): Effect.Effect<
  <XE extends E, XA extends A>(
    effect: Effect.Effect<XA, XE, R>,
    options?: {
      readonly signal?: AbortSignal | undefined
      readonly scheduler?: Scheduler | undefined
      readonly onlyIfMissing?: boolean | undefined
      readonly propagateInterruption?: boolean | undefined
    } | undefined
  ) => Promise<XA>,
  never,
  Scope.Scope | R
> =>
  Effect.flatMap(
    make<A, E>(),
    (self) => runtimePromise(self)<R>()
  )

const internalFiberId = -1
const isInternalInterruption = Filter.toPredicate(Filter.compose(
  Cause.filterInterruptors,
  Filter.has(internalFiberId)
))

/**
 * Sets the fiber in a FiberHandle. When the fiber completes, it will be removed from the FiberHandle.
 * If a fiber is already running, it will be interrupted unless `options.onlyIfMissing` is set.
 *
 * **Example** (Setting a fiber unsafely)
 *
 * ```ts
 * import { Effect, Fiber, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *   const fiber = Effect.runFork(Effect.succeed("hello"))
 *
 *   // Set the fiber directly (unsafe)
 *   FiberHandle.setUnsafe(handle, fiber)
 *
 *   // The fiber is now managed by the handle
 *   const result = yield* Fiber.await(fiber)
 *   console.log(result) // "hello"
 * })
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const setUnsafe: {
  <A, E, XE extends E, XA extends A>(
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly onlyIfMissing?: boolean | undefined
      readonly propagateInterruption?: boolean | undefined
    }
  ): (self: FiberHandle<A, E>) => void
  <A, E, XE extends E, XA extends A>(
    self: FiberHandle<A, E>,
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly onlyIfMissing?: boolean | undefined
      readonly propagateInterruption?: boolean | undefined
    }
  ): void
} = dual((args) => isFiberHandle(args[0]), <A, E, XE extends E, XA extends A>(
  self: FiberHandle<A, E>,
  fiber: Fiber.Fiber<XA, XE>,
  options?: {
    readonly onlyIfMissing?: boolean | undefined
    readonly propagateInterruption?: boolean | undefined
  }
): void => {
  if (self.state._tag === "Closed") {
    fiber.interruptUnsafe(internalFiberId)
    return
  } else if (self.state.fiber !== undefined) {
    if (options?.onlyIfMissing === true) {
      fiber.interruptUnsafe(internalFiberId)
      return
    } else if (self.state.fiber === fiber) {
      return
    }
    self.state.fiber.interruptUnsafe(internalFiberId)
    self.state.fiber = undefined
  }

  self.state.fiber = fiber
  fiber.addObserver((exit) => {
    if (self.state._tag === "Open" && fiber === self.state.fiber) {
      self.state.fiber = undefined
    }
    if (
      Exit.isFailure(exit) &&
      (
        options?.propagateInterruption === true ?
          !isInternalInterruption(exit.cause) :
          !Cause.hasInterruptsOnly(exit.cause)
      )
    ) {
      Deferred.doneUnsafe(self.deferred, exit as any)
    }
  })
})

/**
 * Sets the fiber in the `FiberHandle`.
 *
 * **Details**
 *
 * When the fiber completes, it will be removed from the `FiberHandle`. If a
 * fiber already exists in the `FiberHandle`, it will be interrupted unless
 * `options.onlyIfMissing` is set.
 *
 * **Example** (Setting a fiber safely)
 *
 * ```ts
 * import { Effect, Fiber, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *   const fiber = Effect.runFork(Effect.succeed("hello"))
 *
 *   // Set the fiber safely
 *   yield* FiberHandle.set(handle, fiber)
 *
 *   // The fiber is now managed by the handle
 *   const result = yield* Fiber.await(fiber)
 *   console.log(result) // "hello"
 * })
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const set: {
  <A, E, XE extends E, XA extends A>(
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly onlyIfMissing?: boolean
      readonly propagateInterruption?: boolean | undefined
    }
  ): (self: FiberHandle<A, E>) => Effect.Effect<void>
  <A, E, XE extends E, XA extends A>(
    self: FiberHandle<A, E>,
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly onlyIfMissing?: boolean
      readonly propagateInterruption?: boolean | undefined
    }
  ): Effect.Effect<void>
} = dual((args) => isFiberHandle(args[0]), <A, E, XE extends E, XA extends A>(
  self: FiberHandle<A, E>,
  fiber: Fiber.Fiber<XA, XE>,
  options?: {
    readonly onlyIfMissing?: boolean
    readonly propagateInterruption?: boolean | undefined
  }
): Effect.Effect<void> =>
  Effect.sync(() =>
    setUnsafe(self, fiber, {
      onlyIfMissing: options?.onlyIfMissing,
      propagateInterruption: options?.propagateInterruption
    })
  ))

/**
 * Retrieves the fiber from the FiberHandle synchronously.
 *
 * **Example** (Reading the current fiber unsafely)
 *
 * ```ts
 * import { Effect, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *
 *   // No fiber initially
 *   const emptyFiber = FiberHandle.getUnsafe(handle)
 *   console.log(emptyFiber._tag === "None") // true
 *
 *   // Add a fiber
 *   yield* FiberHandle.run(handle, Effect.succeed("hello"))
 *   const fiber = FiberHandle.getUnsafe(handle)
 *   console.log(fiber._tag === "Some") // true
 * })
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export function getUnsafe<A, E>(self: FiberHandle<A, E>): Option.Option<Fiber.Fiber<A, E>> {
  return self.state._tag === "Closed" ? Option.none() : Option.fromUndefinedOr(self.state.fiber)
}

/**
 * Retrieves the fiber from the FiberHandle effectfully.
 *
 * **Example** (Reading the current fiber)
 *
 * ```ts
 * import { Effect, Fiber, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *
 *   // Add a fiber
 *   yield* FiberHandle.run(handle, Effect.succeed("hello"))
 *
 *   // Get the current fiber if present
 *   const fiber = yield* FiberHandle.get(handle)
 *   if (fiber._tag === "Some") {
 *     const result = yield* Fiber.await(fiber.value)
 *     console.log(result) // "hello"
 *   }
 * })
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export function get<A, E>(self: FiberHandle<A, E>): Effect.Effect<Option.Option<Fiber.Fiber<A, E>>> {
  return Effect.suspend(() => Effect.succeed(getUnsafe(self)))
}

/**
 * Interrupts the fiber currently stored in the `FiberHandle`, if any, and
 * leaves the handle empty.
 *
 * **Example** (Clearing a fiber handle)
 *
 * ```ts
 * import { Effect, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *
 *   // Add a fiber
 *   yield* FiberHandle.run(handle, Effect.never)
 *
 *   // Clear the handle, interrupting the fiber
 *   yield* FiberHandle.clear(handle)
 *
 *   // The handle is now empty
 *   const fiber = FiberHandle.getUnsafe(handle)
 *   console.log(fiber) // Option.none()
 * })
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const clear = <A, E>(self: FiberHandle<A, E>): Effect.Effect<void> =>
  Effect.uninterruptibleMask((restore) => {
    if (self.state._tag === "Closed" || self.state.fiber === undefined) {
      return Effect.void
    }
    return Effect.andThen(
      restore(Fiber.interruptAs(self.state.fiber, internalFiberId)),
      Effect.sync(() => {
        if (self.state._tag === "Open") {
          self.state.fiber = undefined
        }
      })
    )
  })

const constInterruptedFiber = (function() {
  let fiber: Fiber.Fiber<never, never> | undefined = undefined
  return () => {
    if (fiber === undefined) {
      fiber = Effect.runFork(Effect.interrupt)
    }
    return fiber
  }
})()

/**
 * Forks an Effect and stores the resulting fiber in the `FiberHandle`.
 *
 * **Details**
 *
 * The handle manages only one fiber: running a new effect interrupts the
 * previous fiber unless `onlyIfMissing` is set. When the managed fiber
 * completes, it is removed from the handle.
 *
 * **Example** (Running an effect in a fiber handle)
 *
 * ```ts
 * import { Effect, Fiber, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *
 *   // Run an effect and get the fiber
 *   const fiber = yield* FiberHandle.run(handle, Effect.succeed("hello"))
 *   const result = yield* Fiber.await(fiber)
 *   console.log(result) // "hello"
 *
 *   // Running another effect will interrupt the previous one
 *   const fiber2 = yield* FiberHandle.run(handle, Effect.succeed("world"))
 *   const result2 = yield* Fiber.await(fiber2)
 *   console.log(result2) // "world"
 * })
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const run: {
  <A, E>(
    self: FiberHandle<A, E>,
    options?: {
      readonly onlyIfMissing?: boolean
      readonly propagateInterruption?: boolean | undefined
      readonly startImmediately?: boolean | undefined
    }
  ): <R, XE extends E, XA extends A>(
    effect: Effect.Effect<XA, XE, R>
  ) => Effect.Effect<Fiber.Fiber<XA, XE>, never, R>
  <A, E, R, XE extends E, XA extends A>(
    self: FiberHandle<A, E>,
    effect: Effect.Effect<XA, XE, R>,
    options?: {
      readonly onlyIfMissing?: boolean
      readonly propagateInterruption?: boolean | undefined
      readonly startImmediately?: boolean | undefined
    }
  ): Effect.Effect<Fiber.Fiber<XA, XE>, never, R>
} = function() {
  const self = arguments[0] as FiberHandle
  if (Effect.isEffect(arguments[1])) {
    return runImpl(self, arguments[1], arguments[2]) as any
  }
  const options = arguments[1]
  return (effect: Effect.Effect<unknown, unknown, any>) => runImpl(self, effect, options)
}

const runImpl = <A, E, R, XE extends E, XA extends A>(
  self: FiberHandle<A, E>,
  effect: Effect.Effect<XA, XE, R>,
  options?: {
    readonly onlyIfMissing?: boolean | undefined
  }
): Effect.Effect<Fiber.Fiber<XA, XE>, never, R> =>
  Effect.withFiber((parent) => {
    if (self.state._tag === "Closed") {
      return Effect.interrupt
    } else if (self.state.fiber !== undefined && options?.onlyIfMissing === true) {
      return Effect.sync(constInterruptedFiber)
    }
    const fiber = Effect.runForkWith(parent.context as Context<R>)(effect)
    setUnsafe(self, fiber, options)
    return Effect.succeed(fiber)
  })

/**
 * Captures the current runtime and returns a function for forking effects into
 * an existing `FiberHandle`.
 *
 * **Details**
 *
 * Each call returns the forked fiber, stores it in the handle, and interrupts
 * the previous fiber unless `onlyIfMissing` is set.
 *
 * **Example** (Capturing a runtime for fiber handles)
 *
 * ```ts
 * import { Context, Effect, FiberHandle } from "effect"
 *
 * interface Users {
 *   readonly _: unique symbol
 * }
 * const Users = Context.Service<Users, {
 *   getAll: Effect.Effect<Array<unknown>>
 * }>("Users")
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *   const run = yield* FiberHandle.runtime(handle)<Users>()
 *
 *   // run an effect and set the fiber in the handle
 *   run(Effect.andThen(Users, (_) => _.getAll))
 *
 *   // this will interrupt the previous fiber
 *   run(Effect.andThen(Users, (_) => _.getAll))
 * }).pipe(
 *   Effect.scoped // The fiber will be interrupted when the scope is closed
 * )
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const runtime: <A, E>(
  self: FiberHandle<A, E>
) => <R = never>() => Effect.Effect<
  <XE extends E, XA extends A>(
    effect: Effect.Effect<XA, XE, R>,
    options?:
      | {
        readonly signal?: AbortSignal | undefined
        readonly scheduler?: Scheduler | undefined
        readonly onlyIfMissing?: boolean | undefined
        readonly propagateInterruption?: boolean | undefined
      }
      | undefined
  ) => Fiber.Fiber<XA, XE>,
  never,
  R
> = <A, E>(self: FiberHandle<A, E>) => <R>() =>
  Effect.map(
    Effect.context<R>(),
    (services) => {
      const runFork = Effect.runForkWith(services)
      return <XE extends E, XA extends A>(
        effect: Effect.Effect<XA, XE, R>,
        options?:
          | {
            readonly signal?: AbortSignal | undefined
            readonly scheduler?: Scheduler | undefined
            readonly onlyIfMissing?: boolean | undefined
            readonly propagateInterruption?: boolean | undefined
          }
          | undefined
      ) => {
        if (self.state._tag === "Closed") {
          return constInterruptedFiber()
        } else if (self.state.fiber !== undefined && options?.onlyIfMissing === true) {
          return constInterruptedFiber()
        }
        const fiber = runFork(effect, options)
        setUnsafe(self, fiber, options)
        return fiber
      }
    }
  )

/**
 * Captures the current runtime and returns a function for running effects in
 * an existing `FiberHandle` as Promises.
 *
 * **Details**
 *
 * Each call stores the forked fiber in the handle and interrupts the previous
 * fiber unless `onlyIfMissing` is set. The Promise resolves with the effect's
 * success value or rejects with the squashed failure cause.
 *
 * **Example** (Capturing a runtime for promises)
 *
 * ```ts
 * import { Effect, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *   const runPromise = yield* FiberHandle.runtimePromise(handle)<never>()
 *
 *   // Run an effect and get a promise
 *   const promise = runPromise(Effect.succeed("hello"))
 *   const result = yield* Effect.promise(() => promise)
 *   console.log(result) // "hello"
 * })
 * ```
 *
 * @category combinators
 * @since 3.13.0
 */
export const runtimePromise = <A, E>(self: FiberHandle<A, E>): <R = never>() => Effect.Effect<
  <XE extends E, XA extends A>(
    effect: Effect.Effect<XA, XE, R>,
    options?:
      | {
        readonly signal?: AbortSignal | undefined
        readonly scheduler?: Scheduler | undefined
        readonly onlyIfMissing?: boolean | undefined
        readonly propagateInterruption?: boolean | undefined
      }
      | undefined
  ) => Promise<XA>,
  never,
  R
> =>
<R>() =>
  Effect.map(
    runtime(self)<R>(),
    (runFork) =>
    <XE extends E, XA extends A>(
      effect: Effect.Effect<XA, XE, R>,
      options?:
        | {
          readonly signal?: AbortSignal | undefined
          readonly scheduler?: Scheduler | undefined
          readonly onlyIfMissing?: boolean | undefined
          readonly propagateInterruption?: boolean | undefined
        }
        | undefined
    ): Promise<XA> =>
      new Promise((resolve, reject) =>
        runFork(effect, options).addObserver((exit) => {
          if (Exit.isSuccess(exit)) {
            resolve(exit.value)
          } else {
            reject(Cause.squash(exit.cause))
          }
        })
      )
  )

/**
 * Waits for the `FiberHandle` to fail or close.
 *
 * **Details**
 *
 * The returned Effect fails with the first managed fiber failure that is not
 * ignored by the handle's interruption rules. Normal successful completion of
 * a managed fiber only removes it from the handle; use `awaitEmpty` to wait
 * for the current fiber to finish.
 *
 * **Example** (Propagating fiber failures)
 *
 * ```ts
 * import { Effect, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *   yield* FiberHandle.set(handle, Effect.runFork(Effect.fail("error")))
 *
 *   // parent fiber will fail with "error"
 *   yield* FiberHandle.join(handle)
 * })
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const join = <A, E>(self: FiberHandle<A, E>): Effect.Effect<void, E> =>
  Deferred.await(self.deferred as Deferred.Deferred<void, E>)

/**
 * Waits for the fiber in the FiberHandle to complete.
 *
 * **Example** (Waiting for a fiber to complete)
 *
 * ```ts
 * import { Effect, FiberHandle } from "effect"
 *
 * Effect.gen(function*() {
 *   const handle = yield* FiberHandle.make()
 *
 *   // Start a long-running effect
 *   yield* FiberHandle.run(handle, Effect.sleep(1000))
 *
 *   // Wait for the fiber to complete
 *   yield* FiberHandle.awaitEmpty(handle)
 *
 *   console.log("Fiber completed")
 * })
 * ```
 *
 * @category combinators
 * @since 3.13.0
 */
export const awaitEmpty = <A, E>(self: FiberHandle<A, E>): Effect.Effect<void, E> =>
  Effect.suspend(() => {
    if (self.state._tag === "Closed" || self.state.fiber === undefined) {
      return Effect.void
    }
    return Fiber.await(self.state.fiber)
  })
