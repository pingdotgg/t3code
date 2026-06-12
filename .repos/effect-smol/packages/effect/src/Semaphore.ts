/**
 * The `Semaphore` module provides counting semaphores for limiting concurrent
 * access to shared resources. A semaphore owns a pool of permits; effects take
 * permits before running protected work and return them when the work exits.
 *
 * **Mental model**
 *
 * - The permit count is the maximum amount of guarded work that can run at once
 * - {@link withPermit} and {@link withPermits} acquire permits around one
 *   effect and release them on success, failure, or interruption
 * - {@link take} and {@link release} expose the lower-level protocol when
 *   acquisition and release cannot be scoped to one effect
 * - {@link resize} changes future availability while preserving permits that
 *   are already taken
 *
 * **Common tasks**
 *
 * - Create a semaphore: {@link make}, {@link makeUnsafe}
 * - Guard one effect: {@link withPermit}, {@link withPermits}
 * - Run only when permits are immediately available:
 *   {@link withPermitsIfAvailable}
 * - Manage permits manually: {@link take}, {@link release}, {@link releaseAll}
 * - Change capacity: {@link resize}
 *
 * **Gotchas**
 *
 * - Pending acquisitions wait until enough permits are available
 * - {@link withPermitsIfAvailable} never waits; it returns `Option.none` when
 *   the requested permits are not available immediately
 * - Manual {@link take} / {@link release} usage must keep permit counts
 *   balanced; prefer scoped helpers when possible
 *
 * @since 4.0.0
 */
import type * as Effect from "./Effect.ts"
import type { Fiber } from "./Fiber.ts"
import { dual } from "./Function.ts"
import * as core from "./internal/core.ts"
import * as internal from "./internal/effect.ts"
import type * as Option from "./Option.ts"

/**
 * A counting semaphore that coordinates concurrent access with permits.
 *
 * **When to use**
 *
 * Use to coordinate concurrent effects that need bounded access to a shared
 * resource.
 *
 * **Details**
 *
 * Effects can acquire permits, wait until enough permits are available,
 * release permits, or run with permits that are automatically released when
 * the effect exits.
 *
 * **Example** (Controlling concurrent access)
 *
 * ```ts
 * import { Effect, Semaphore } from "effect"
 *
 * // Create and use a semaphore for controlling concurrent access
 * const program = Effect.gen(function*() {
 *   const semaphore = yield* Semaphore.make(2)
 *
 *   return yield* semaphore.withPermits(1)(
 *     Effect.succeed("Resource accessed")
 *   )
 * })
 * ```
 *
 * @see {@link make} for creating a semaphore inside Effect code
 * @see {@link makeUnsafe} for creating a semaphore synchronously
 *
 * @category models
 * @since 4.0.0
 */
export interface Semaphore {
  /**
   * Adjusts the number of permits available in the semaphore.
   *
   * **When to use**
   *
   * Use to change the total permit count of an existing semaphore.
   */
  resize(this: Semaphore, permits: number): Effect.Effect<void>

  /**
   * Runs an effect with the given number of permits and releases the permits
   * when the effect completes.
   *
   * **When to use**
   *
   * Use to run an effect while holding a specified number of semaphore permits.
   *
   * **Details**
   *
   * This function acquires the specified number of permits before executing
   * the provided effect. Once the effect finishes, the permits are released.
   * If insufficient permits are available, the function will wait until they
   * are released by other tasks.
   */
  withPermits(this: Semaphore, permits: number): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

  /**
   * Runs an effect with the given number of permits and releases the permits
   * when the effect completes.
   *
   * **When to use**
   *
   * Use to run an effect while holding exactly one semaphore permit.
   *
   * **Details**
   *
   * This function acquires the specified number of permits before executing
   * the provided effect. Once the effect finishes, the permits are released.
   * If insufficient permits are available, the function will wait until they
   * are released by other tasks.
   */
  withPermit<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>

  /**
   * Runs an effect only if the specified number of permits are immediately
   * available.
   *
   * **When to use**
   *
   * Use when guarded work should run only if the requested permits are
   * immediately available.
   *
   * **Details**
   *
   * This function attempts to acquire the specified number of permits. If they
   * are available, it runs the effect and releases the permits after the effect
   * completes. If permits are not available, the effect does not execute, and
   * the result is `Option.none`.
   */
  withPermitsIfAvailable(
    this: Semaphore,
    permits: number
  ): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>

  /**
   * Acquires the specified number of permits and returns the resulting
   * available permits, suspending the task if they are not yet available.
   * Concurrent pending `take` calls are processed in a first-in, first-out manner.
   *
   * **When to use**
   *
   * Use to manually acquire permits for lower-level coordination protocols.
   */
  take(this: Semaphore, permits: number): Effect.Effect<number>

  /**
   * Releases the specified number of permits and returns the resulting
   * available permits.
   *
   * **When to use**
   *
   * Use to manually return permits acquired by a lower-level coordination
   * protocol.
   */
  release(this: Semaphore, permits: number): Effect.Effect<number>

  /**
   * Releases all permits held by this semaphore and returns the resulting available permits.
   *
   * **When to use**
   *
   * Use to return every currently taken permit to the semaphore at once.
   */
  readonly releaseAll: Effect.Effect<number>
}

/**
 * Creates a `Semaphore` synchronously with the specified total
 * number of permits.
 *
 * **When to use**
 *
 * Use to construct a semaphore synchronously when an immediate value is
 * required outside an Effect workflow.
 *
 * **Example** (Creating an unsafe semaphore)
 *
 * ```ts
 * import { Effect, Semaphore } from "effect"
 *
 * const semaphore = Semaphore.makeUnsafe(3)
 *
 * const task = (id: number) =>
 *   semaphore.withPermits(1)(
 *     Effect.gen(function*() {
 *       yield* Effect.log(`Task ${id} started`)
 *       yield* Effect.sleep("1 second")
 *       yield* Effect.log(`Task ${id} completed`)
 *     })
 *   )
 *
 * // Only 3 tasks can run concurrently
 * const program = Effect.all([
 *   task(1),
 *   task(2),
 *   task(3),
 *   task(4),
 *   task(5)
 * ], { concurrency: "unbounded" })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeUnsafe = (permits: number): Semaphore => new SemaphoreImpl(permits)

class SemaphoreImpl implements Semaphore {
  public waiters = new Set<() => void>()
  public taken = 0
  public permits: number

  constructor(permits: number) {
    this.permits = permits
  }

  get free() {
    return this.permits - this.taken
  }

  take(n: number): Effect.Effect<number> {
    const take: Effect.Effect<number> = internal.suspend(() => {
      if (this.free < n) {
        return internal.callback((resume) => {
          if (this.free >= n) return resume(take)
          const observer = () => {
            if (this.free < n) return
            this.waiters.delete(observer)
            resume(take)
          }
          this.waiters.add(observer)
          return internal.sync(() => {
            this.waiters.delete(observer)
          })
        })
      }
      this.taken += n
      return internal.succeed(n)
    })
    return take
  }

  updateTakenUnsafe(fiber: Fiber<any, any>, f: (n: number) => number): number {
    this.taken = f(this.taken)
    if (this.waiters.size > 0) {
      fiber.currentDispatcher.scheduleTask(() => {
        const iter = this.waiters.values()
        let item = iter.next()
        while (item.done === false && this.free > 0) {
          item.value()
          item = iter.next()
        }
      }, 0)
    }
    return this.free
  }

  updateTaken(f: (n: number) => number): Effect.Effect<number> {
    return core.withFiber((fiber) => internal.succeed(this.updateTakenUnsafe(fiber, f)))
  }

  resize(permits: number) {
    return core.withFiber((fiber) => {
      this.permits = permits
      if (this.free < 0) return internal.void
      this.updateTakenUnsafe(fiber, (taken) => taken)
      return internal.void
    })
  }

  release(n: number): Effect.Effect<number> {
    return this.updateTaken((taken) => taken - n)
  }

  get releaseAll(): Effect.Effect<number> {
    return this.updateTaken((_) => 0)
  }

  withPermits(n: number) {
    return <A, E, R>(self: Effect.Effect<A, E, R>) =>
      internal.uninterruptibleMask((restore) =>
        internal.flatMap(
          restore(this.take(n)),
          (permits) =>
            internal.onExitPrimitive(
              restore(self),
              () => {
                this.updateTakenUnsafe(internal.getCurrentFiber()!, (taken) => taken - permits)
                return undefined
              },
              true
            )
        )
      )
  }

  readonly withPermit = this.withPermits(1)

  withPermitsIfAvailable(n: number) {
    return <A, E, R>(self: Effect.Effect<A, E, R>) =>
      internal.uninterruptibleMask((restore) => {
        if (this.free < n) return internal.succeedNone
        this.taken += n
        return internal.onExitPrimitive(restore(internal.asSome(self)), () => {
          this.updateTakenUnsafe(internal.getCurrentFiber()!, (taken) => taken - n)
          return undefined
        }, true)
      })
  }
}

/**
 * Creates a `Semaphore` initialized with the specified total number of permits.
 *
 * **When to use**
 *
 * Use to create a semaphore inside Effect code for bounding concurrency with
 * automatic or manual permit management.
 *
 * **Example** (Creating a semaphore)
 *
 * ```ts
 * import { Effect, Semaphore } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const semaphore = yield* Semaphore.make(2)
 *
 *   const task = (id: number) =>
 *     semaphore.withPermits(1)(
 *       Effect.gen(function*() {
 *         yield* Effect.log(`Task ${id} acquired permit`)
 *         yield* Effect.sleep("1 second")
 *         yield* Effect.log(`Task ${id} releasing permit`)
 *       })
 *     )
 *
 *   // Run 4 tasks, but only 2 can run concurrently
 *   yield* Effect.all([task(1), task(2), task(3), task(4)])
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (permits: number): Effect.Effect<Semaphore> => internal.sync(() => new SemaphoreImpl(permits))

/**
 * Sets the total number of permits managed by the semaphore.
 *
 * **When to use**
 *
 * Use to change the concurrency limit of an existing semaphore while keeping
 * current acquisitions in place.
 *
 * **Details**
 *
 * Existing acquisitions remain taken after resizing. If the new total is less
 * than the currently taken permit count, new acquisitions wait until enough
 * permits are released.
 *
 * @see {@link make} for creating a semaphore with an initial permit count
 * @see {@link release} for returning permits without changing semaphore capacity
 *
 * @category combinators
 * @since 4.0.0
 */
export const resize: {
  (permits: number): (self: Semaphore) => Effect.Effect<void>
  (self: Semaphore, permits: number): Effect.Effect<void>
} = dual(2, (self: Semaphore, permits: number) => self.resize(permits))

/**
 * Runs an effect with the given number of permits and releases the permits when
 * the effect completes.
 *
 * **When to use**
 *
 * Use to run an effect while holding a specified number of semaphore permits
 * for the duration of that effect.
 *
 * **Details**
 *
 * The effect waits until enough permits are available. Acquired permits are
 * released when the wrapped effect exits.
 *
 * @see {@link withPermit} for acquiring exactly one permit
 * @see {@link withPermitsIfAvailable} for running only when permits are immediately available
 * @see {@link take} for manually acquiring permits
 * @see {@link release} for manually returning permits
 *
 * @category combinators
 * @since 4.0.0
 */
export const withPermits: {
  (self: Semaphore, permits: number): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Semaphore, permits: number, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = ((self: Semaphore, permits: number, effect?: Effect.Effect<any, any, any>) => {
  const withPermits = self.withPermits(permits)
  return effect ? withPermits(effect) : withPermits
}) as any

/**
 * Runs an effect with a single permit and releases the permit when the effect
 * completes.
 *
 * **When to use**
 *
 * Use to guard an effect with exactly one semaphore permit while automatically
 * releasing that permit when the effect exits.
 *
 * @see {@link withPermits} for acquiring more than one permit
 * @see {@link withPermitsIfAvailable} for running only when permits are immediately available
 * @see {@link take} for manually acquiring permits
 * @see {@link release} for manually returning permits
 *
 * @category combinators
 * @since 4.0.0
 */
export const withPermit: {
  (self: Semaphore): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Semaphore, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = ((self: Semaphore, effect?: Effect.Effect<any, any, any>) => {
  if (!effect) return self.withPermit
  return self.withPermit(effect)
}) as any

/**
 * Runs an effect only if the specified number of permits are immediately
 * available.
 *
 * **When to use**
 *
 * Use when guarded work should run only if the requested permits are
 * immediately available.
 *
 * **Details**
 *
 * When the permits are unavailable, the effect is not run and the result is
 * `Option.none`. When permits are available, the effect is run, its result is
 * wrapped in `Option.some`, and the acquired permits are released when the
 * effect exits.
 *
 * @see {@link withPermits} for the variant that waits until permits are available
 *
 * @category combinators
 * @since 4.0.0
 */
export const withPermitsIfAvailable: {
  (self: Semaphore, permits: number): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>
  <A, E, R>(
    self: Semaphore,
    permits: number,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<Option.Option<A>, E, R>
} = ((self: Semaphore, permits: number, effect?: Effect.Effect<any, any, any>) => {
  const withPermits = self.withPermitsIfAvailable(permits)
  return effect ? withPermits(effect) : withPermits
}) as any

/**
 * Acquires the specified number of permits and returns the acquired permit
 * count.
 *
 * **When to use**
 *
 * Use to manually acquire permits when a lower-level permit protocol needs
 * explicit acquisition and release control.
 *
 * **Details**
 *
 * The effect waits until enough permits are available.
 *
 * @see {@link withPermit} for automatically acquiring and releasing one permit around an effect
 * @see {@link withPermits} for automatically acquiring and releasing multiple permits around an effect
 * @see {@link release} for returning manually acquired permits
 *
 * @category combinators
 * @since 4.0.0
 */
export const take: {
  (permits: number): (self: Semaphore) => Effect.Effect<number>
  (self: Semaphore, permits: number): Effect.Effect<number>
} = dual(2, (self: Semaphore, permits: number) => self.take(permits))

/**
 * Releases the specified number of permits and returns the resulting available
 * permits.
 *
 * **When to use**
 *
 * Use to manually return permits acquired with `take` when a lower-level
 * permit protocol needs explicit release control.
 *
 * **Details**
 *
 * Running the effect releases the requested permits, wakes waiting acquirers
 * when permits become available, and returns the current available permit
 * count.
 *
 * **Gotchas**
 *
 * Manual `take` / `release` usage must keep permit counts balanced. Prefer
 * `withPermit` or `withPermits` when the acquisition can be scoped to one
 * effect.
 *
 * @see {@link take} for manually acquiring permits
 * @see {@link releaseAll} for returning every currently taken permit
 * @see {@link withPermits} for automatic acquire and release around an effect
 *
 * @category combinators
 * @since 4.0.0
 */
export const release: {
  (permits: number): (self: Semaphore) => Effect.Effect<number>
  (self: Semaphore, permits: number): Effect.Effect<number>
} = dual(2, (self: Semaphore, permits: number) => self.release(permits))

/**
 * Releases all permits held by this semaphore and returns the resulting
 * available permits.
 *
 * **When to use**
 *
 * Use to return every currently taken permit to a semaphore at once, typically
 * during cleanup of manual `take` / `release` protocols.
 *
 * @see {@link release} for releasing a known permit count
 * @see {@link withPermits} for automatic acquire and release around an effect
 *
 * @category combinators
 * @since 4.0.0
 */
export const releaseAll = (self: Semaphore): Effect.Effect<number> => self.releaseAll
