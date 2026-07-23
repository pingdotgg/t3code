/**
 * The `TxReentrantLock` module provides a transactional read/write lock whose
 * ownership is tracked per fiber. Multiple fibers may hold read locks at the
 * same time, while a write lock gives one fiber exclusive access.
 *
 * **Mental model**
 *
 * The lock stores reader counts and an optional writer count in transactional
 * state. A fiber can reacquire locks it already owns, so nested read or write
 * sections are safe as long as each acquisition is matched by a release. A
 * write acquisition waits when another fiber owns a read or write lock, and a
 * read acquisition waits when another fiber owns the write lock.
 *
 * **Common tasks**
 *
 * - Use `withReadLock` to run an effect that may share access with other
 *   readers.
 * - Use `withWriteLock` or `withLock` to run an effect with exclusive access.
 * - Use `readLock` or `writeLock` when lock ownership should be tied to an
 *   existing scope.
 *
 * **Example** (Protecting a read/write workflow)
 *
 * ```ts
 * import { Effect, Ref, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const state = yield* Ref.make(0)
 *
 *   yield* TxReentrantLock.withWriteLock(lock, Ref.update(state, (n) => n + 1))
 *   return yield* TxReentrantLock.withReadLock(lock, Ref.get(state))
 * })
 * ```
 *
 * **Gotchas**
 *
 * - Manual acquisitions are counted; release the same number of times or use
 *   the scoped and `with*` helpers.
 * - Releasing a lock from a fiber that does not own it leaves the lock
 *   unchanged and returns `0`.
 *
 * @since 4.0.0
 */
import * as Effect from "./Effect.ts"
import * as HashMap from "./HashMap.ts"
import type { Inspectable } from "./Inspectable.ts"
import { NodeInspectSymbol, toJson } from "./Inspectable.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type * as Scope from "./Scope.ts"
import * as TxRef from "./TxRef.ts"

const TypeId = "~effect/transactions/TxReentrantLock"

/**
 * @category models
 * @since 4.0.0
 */
interface LockState {
  readonly readers: HashMap.HashMap<number, number>
  readonly writer: Option.Option<readonly [fiberId: number, count: number]>
}

const emptyState: LockState = {
  readers: HashMap.empty<number, number>(),
  writer: Option.none()
}

/**
 * A TxReentrantLock provides a transactional read/write lock with reentrant semantics.
 * Multiple readers can hold the lock concurrently, or a single writer can hold exclusive
 * access. A fiber holding the write lock may acquire additional read/write locks (reentrancy).
 *
 * **Example** (Using read and write locks)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *
 *   // Multiple readers can proceed concurrently
 *   yield* TxReentrantLock.withReadLock(lock, Effect.succeed("reading"))
 *
 *   // Writer gets exclusive access
 *   yield* TxReentrantLock.withWriteLock(lock, Effect.succeed("writing"))
 * })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface TxReentrantLock extends Inspectable, Pipeable {
  readonly [TypeId]: typeof TypeId
  /** @internal */
  readonly stateRef: TxRef.TxRef<LockState>
}

const TxReentrantLockProto: Omit<TxReentrantLock, typeof TypeId | "stateRef"> = {
  [NodeInspectSymbol](this: TxReentrantLock) {
    return toJson(this)
  },
  toJSON(this: TxReentrantLock) {
    return { _id: "TxReentrantLock" }
  },
  toString() {
    return "TxReentrantLock"
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

// =============================================================================
// Constructors
// =============================================================================

/**
 * Creates a new TxReentrantLock.
 *
 * **Example** (Creating a reentrant lock)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const isLocked = yield* TxReentrantLock.locked(lock)
 *   console.log(isLocked) // false
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const make = (): Effect.Effect<TxReentrantLock> =>
  Effect.gen(function*() {
    const stateRef = yield* TxRef.make<LockState>(emptyState)
    const self = Object.create(TxReentrantLockProto)
    self[TypeId] = TypeId
    self.stateRef = stateRef
    return self
  }).pipe(Effect.tx)

// =============================================================================
// Mutations
// =============================================================================

/**
 * Acquires a read lock. Blocks if another fiber holds the write lock.
 * If the current fiber already holds the write lock, the read lock is granted (reentrancy).
 * Returns the current number of read locks held by this fiber.
 *
 * **Example** (Acquiring a read lock)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const count = yield* TxReentrantLock.acquireRead(lock)
 *   console.log(count) // 1
 *   yield* TxReentrantLock.releaseRead(lock)
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const acquireRead = (self: TxReentrantLock): Effect.Effect<number> =>
  Effect.withFiber((fiber) =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)
      const fiberId = fiber.id

      // If another fiber holds the write lock, retry
      if (Option.isSome(state.writer) && state.writer.value[0] !== fiberId) {
        return yield* Effect.txRetry
      }

      // Grant read lock
      const currentCount = Option.getOrElse(HashMap.get(state.readers, fiberId), () => 0)
      const newCount = currentCount + 1
      yield* TxRef.set(self.stateRef, {
        ...state,
        readers: HashMap.set(state.readers, fiberId, newCount)
      })
      return newCount
    }).pipe(Effect.tx)
  )

/**
 * Acquires the write lock for the current fiber.
 *
 * **When to use**
 *
 * Use to enter an exclusive section manually when `withWriteLock` is not the
 * right shape.
 *
 * **Details**
 *
 * Blocks if any other fiber holds a read or write lock. If the current fiber
 * already holds the write lock, the count is incremented. If the current fiber
 * holds a read lock, the write lock is granted as an upgrade.
 *
 * Returns the current number of write locks held by this fiber.
 *
 * **Example** (Acquiring a write lock)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const count = yield* TxReentrantLock.acquireWrite(lock)
 *   console.log(count) // 1
 *   yield* TxReentrantLock.releaseWrite(lock)
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const acquireWrite = (self: TxReentrantLock): Effect.Effect<number> =>
  Effect.withFiber((fiber) =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)
      const fiberId = fiber.id

      // If another fiber holds the write lock, retry
      if (Option.isSome(state.writer) && state.writer.value[0] !== fiberId) {
        return yield* Effect.txRetry
      }

      // If other fibers hold read locks, retry
      for (const [readerId] of state.readers) {
        if (readerId !== fiberId && Option.getOrElse(HashMap.get(state.readers, readerId), () => 0) > 0) {
          return yield* Effect.txRetry
        }
      }

      // Grant write lock
      if (Option.isSome(state.writer)) {
        // Reentrant: increment write count
        const newCount = state.writer.value[1] + 1
        yield* TxRef.set(self.stateRef, {
          ...state,
          writer: Option.some([fiberId, newCount] as const)
        })
        return newCount
      }

      // First write lock acquisition
      yield* TxRef.set(self.stateRef, {
        ...state,
        writer: Option.some([fiberId, 1] as const)
      })
      return 1
    }).pipe(Effect.tx)
  )

/**
 * Releases one read lock held by the current fiber.
 *
 * **When to use**
 *
 * Use to leave a manually acquired read lock.
 *
 * **Details**
 *
 * Returns the remaining number of read locks held by this fiber.
 *
 * **Example** (Releasing a read lock)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   yield* TxReentrantLock.acquireRead(lock)
 *   const remaining = yield* TxReentrantLock.releaseRead(lock)
 *   console.log(remaining) // 0
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const releaseRead = (self: TxReentrantLock): Effect.Effect<number> =>
  Effect.withFiber((fiber) =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)
      const fiberId = fiber.id
      const currentCount = Option.getOrElse(HashMap.get(state.readers, fiberId), () => 0)

      if (currentCount <= 0) return 0

      const newCount = currentCount - 1
      const newReaders = newCount === 0
        ? HashMap.remove(state.readers, fiberId)
        : HashMap.set(state.readers, fiberId, newCount)

      yield* TxRef.set(self.stateRef, { ...state, readers: newReaders })
      return newCount
    }).pipe(Effect.tx)
  )

/**
 * Releases one write lock held by the current fiber.
 *
 * **When to use**
 *
 * Use to leave a manually acquired write lock.
 *
 * **Details**
 *
 * Returns the remaining number of write locks held by this fiber.
 *
 * **Example** (Releasing a write lock)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   yield* TxReentrantLock.acquireWrite(lock)
 *   const remaining = yield* TxReentrantLock.releaseWrite(lock)
 *   console.log(remaining) // 0
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const releaseWrite = (self: TxReentrantLock): Effect.Effect<number> =>
  Effect.withFiber((fiber) =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)
      const fiberId = fiber.id

      if (Option.isNone(state.writer) || state.writer.value[0] !== fiberId) return 0

      const newCount = state.writer.value[1] - 1
      const newWriter = newCount <= 0
        ? Option.none<readonly [number, number]>()
        : Option.some([fiberId, newCount] as const)

      yield* TxRef.set(self.stateRef, { ...state, writer: newWriter })
      return newCount
    }).pipe(Effect.tx)
  )

/**
 * Acquires a read lock for the duration of the scope.
 * The lock is automatically released when the scope closes.
 *
 * **Example** (Holding a scoped read lock)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       yield* TxReentrantLock.readLock(lock)
 *       // read lock is held for the duration of the scope
 *     })
 *   )
 *   // read lock is released
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const readLock = (self: TxReentrantLock): Effect.Effect<number, never, Scope.Scope> =>
  Effect.acquireRelease(
    acquireRead(self),
    () => releaseRead(self)
  )

/**
 * Acquires a write lock for the duration of the scope.
 * The lock is automatically released when the scope closes.
 *
 * **Example** (Holding a scoped write lock)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       yield* TxReentrantLock.writeLock(lock)
 *       // write lock is held for the duration of the scope
 *     })
 *   )
 *   // write lock is released
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const writeLock = (self: TxReentrantLock): Effect.Effect<number, never, Scope.Scope> =>
  Effect.acquireRelease(
    acquireWrite(self),
    () => releaseWrite(self)
  )

/**
 * Runs the provided effect while holding a read lock. The lock is automatically
 * released after the effect completes, fails, or is interrupted.
 *
 * **Example** (Running an effect with a read lock)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const result = yield* TxReentrantLock.withReadLock(
 *     lock,
 *     Effect.succeed("read data")
 *   )
 *   console.log(result) // "read data"
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const withReadLock: {
  <A, E, R>(effect: Effect.Effect<A, E, R>): (self: TxReentrantLock) => Effect.Effect<A, E, R>
  <A, E, R>(self: TxReentrantLock, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 1) {
    const [effect] = args
    return (self: TxReentrantLock) =>
      Effect.acquireUseRelease(
        acquireRead(self),
        () => effect,
        () => releaseRead(self)
      )
  }
  const [self, effect] = args
  return Effect.acquireUseRelease(
    acquireRead(self),
    () => effect,
    () => releaseRead(self)
  )
}) as any

/**
 * Runs the provided effect while holding a write lock. The lock is automatically
 * released after the effect completes, fails, or is interrupted.
 *
 * **Example** (Running an effect with a write lock)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const result = yield* TxReentrantLock.withWriteLock(
 *     lock,
 *     Effect.succeed("wrote data")
 *   )
 *   console.log(result) // "wrote data"
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const withWriteLock: {
  <A, E, R>(effect: Effect.Effect<A, E, R>): (self: TxReentrantLock) => Effect.Effect<A, E, R>
  <A, E, R>(self: TxReentrantLock, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 1) {
    const [effect] = args
    return (self: TxReentrantLock) =>
      Effect.acquireUseRelease(
        acquireWrite(self),
        () => effect,
        () => releaseWrite(self)
      )
  }
  const [self, effect] = args
  return Effect.acquireUseRelease(
    acquireWrite(self),
    () => effect,
    () => releaseWrite(self)
  )
}) as any

/**
 * Runs an effect while holding a write lock.
 *
 * **When to use**
 *
 * Use as the short alias for {@link withWriteLock}.
 *
 * **Example** (Running an effect with exclusive access)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const result = yield* TxReentrantLock.withLock(
 *     lock,
 *     Effect.succeed("exclusive operation")
 *   )
 *   console.log(result) // "exclusive operation"
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const withLock: {
  <A, E, R>(effect: Effect.Effect<A, E, R>): (self: TxReentrantLock) => Effect.Effect<A, E, R>
  <A, E, R>(self: TxReentrantLock, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = withWriteLock

// =============================================================================
// Getters
// =============================================================================

/**
 * Returns the total number of read locks held across all fibers.
 *
 * **Example** (Counting read locks)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   yield* TxReentrantLock.acquireRead(lock)
 *   const count = yield* TxReentrantLock.readLocks(lock)
 *   console.log(count) // 1
 *   yield* TxReentrantLock.releaseRead(lock)
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const readLocks = (self: TxReentrantLock): Effect.Effect<number> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    let total = 0
    for (const [, count] of state.readers) {
      total += count
    }
    return total
  })

/**
 * Returns the number of write locks held (0 or the reentrant count).
 *
 * **Example** (Counting write locks)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const count = yield* TxReentrantLock.writeLocks(lock)
 *   console.log(count) // 0
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const writeLocks = (self: TxReentrantLock): Effect.Effect<number> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    return Option.isSome(state.writer) ? state.writer.value[1] : 0
  })

/**
 * Checks whether the lock is held by any fiber (read or write).
 *
 * **Example** (Checking whether a lock is held)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const isLocked = yield* TxReentrantLock.locked(lock)
 *   console.log(isLocked) // false
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const locked = (self: TxReentrantLock): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    return HashMap.size(state.readers) > 0 || Option.isSome(state.writer)
  })

/**
 * Checks whether any fiber holds a read lock.
 *
 * **Example** (Checking whether a read lock is held)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const isReadLocked = yield* TxReentrantLock.readLocked(lock)
 *   console.log(isReadLocked) // false
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const readLocked = (self: TxReentrantLock): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    return HashMap.size(state.readers) > 0
  })

/**
 * Checks whether any fiber holds a write lock.
 *
 * **Example** (Checking whether a write lock is held)
 *
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const isWriteLocked = yield* TxReentrantLock.writeLocked(lock)
 *   console.log(isWriteLocked) // false
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const writeLocked = (self: TxReentrantLock): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    return Option.isSome(state.writer)
  })

// =============================================================================
// Guards
// =============================================================================

/**
 * Checks whether the given value is a TxReentrantLock.
 *
 * **Example** (Checking for TxReentrantLock values)
 *
 * ```ts
 * import { TxReentrantLock } from "effect"
 *
 * declare const someValue: unknown
 *
 * if (TxReentrantLock.isTxReentrantLock(someValue)) {
 *   console.log("This is a TxReentrantLock")
 * }
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isTxReentrantLock = (u: unknown): u is TxReentrantLock => hasProperty(u, TypeId)
