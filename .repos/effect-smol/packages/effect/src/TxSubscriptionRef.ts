/**
 * The `TxSubscriptionRef` module provides a transactional reference that can
 * also be observed as a stream of committed values. It combines the read and
 * update behavior of a `TxRef.TxRef` with a subscription channel, so each
 * subscriber first receives the current value and then receives every value
 * published by later updates.
 *
 * **Mental model**
 *
 * - The current value is stored transactionally and can be read with
 *   {@link get}
 * - Mutations such as {@link set}, {@link update}, and {@link modify} commit a
 *   new value and publish that value to active subscribers
 * - {@link changes} creates a scoped transactional queue for one subscriber
 * - {@link changesStream} exposes the same change feed as a `Stream.Stream`
 * - Subscriptions are per subscriber; each subscriber gets its own queue of
 *   committed values
 *
 * **Common tasks**
 *
 * - Create observable transactional state with {@link make}
 * - Read or replace the current value with {@link get} and {@link set}
 * - Derive new values atomically with {@link update} or {@link modify}
 * - Consume changes from transactional code with {@link changes}
 * - Consume changes from stream pipelines with {@link changesStream}
 *
 * **Gotchas**
 *
 * - A subscription starts with the value current at subscription time, not just
 *   future updates
 * - The queue returned by {@link changes} is scoped; leaving the scope removes
 *   the subscriber
 * - Updates are published even when the new value is equal to the previous
 *   value
 * - Subscriber queues are unbounded, so long-lived slow subscribers can retain
 *   pending values until they catch up or their scope closes
 *
 * @since 4.0.0
 */
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import type { Inspectable } from "./Inspectable.ts"
import { NodeInspectSymbol, toJson } from "./Inspectable.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type * as Scope from "./Scope.ts"
import * as Stream from "./Stream.ts"
import * as TxPubSub from "./TxPubSub.ts"
import * as TxQueue from "./TxQueue.ts"
import * as TxRef from "./TxRef.ts"

const TypeId = "~effect/transactions/TxSubscriptionRef"

/**
 * A TxSubscriptionRef is a transactional reference that allows subscribing to all
 * committed changes. Subscribers receive the current value followed by every subsequent
 * update via a transactional dequeue.
 *
 * **When to use**
 *
 * Use to store transactional state whose committed changes must be observable by
 * subscribers.
 *
 * **Example** (Subscribing to transactional changes)
 *
 * ```ts
 * import { Effect, TxQueue, TxSubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* TxSubscriptionRef.make(0)
 *
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       const sub = yield* TxSubscriptionRef.changes(ref)
 *       const initial = yield* TxQueue.take(sub)
 *       console.log(initial) // 0
 *
 *       yield* TxSubscriptionRef.set(ref, 1)
 *       const next = yield* TxQueue.take(sub)
 *       console.log(next) // 1
 *     })
 *   )
 * })
 * ```
 *
 * @see {@link make} for creating a transactional subscription reference
 * @see {@link changes} for subscribing through a transactional queue
 * @see {@link changesStream} for subscribing through a `Stream`
 *
 * @category models
 * @since 4.0.0
 */
export interface TxSubscriptionRef<in out A> extends Inspectable, Pipeable {
  readonly [TypeId]: typeof TypeId
  /** @internal */
  readonly ref: TxRef.TxRef<A>
  /** @internal */
  readonly pubsub: TxPubSub.TxPubSub<A>
}

const TxSubscriptionRefProto: Omit<TxSubscriptionRef<any>, typeof TypeId | "ref" | "pubsub"> = {
  [NodeInspectSymbol](this: TxSubscriptionRef<unknown>) {
    return toJson(this)
  },
  toJSON(this: TxSubscriptionRef<unknown>) {
    return { _id: "TxSubscriptionRef" }
  },
  toString() {
    return "TxSubscriptionRef"
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

// =============================================================================
// Constructors
// =============================================================================

/**
 * Creates a new TxSubscriptionRef with the specified initial value.
 *
 * **When to use**
 *
 * Use to create transactional state that also publishes every committed update
 * to subscribers.
 *
 * **Example** (Creating a transactional subscription reference)
 *
 * ```ts
 * import { Effect, TxSubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* TxSubscriptionRef.make(42)
 *   const value = yield* TxSubscriptionRef.get(ref)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @see {@link changes} for subscribing to the created reference
 *
 * @category constructors
 * @since 3.10.0
 */
export const make = <A>(value: A): Effect.Effect<TxSubscriptionRef<A>> =>
  Effect.gen(function*() {
    const ref = yield* TxRef.make(value)
    const pubsub = yield* TxPubSub.unbounded<A>()
    const self = Object.create(TxSubscriptionRefProto)
    self[TypeId] = TypeId
    self.ref = ref
    self.pubsub = pubsub
    return self
  }).pipe(Effect.tx)

// =============================================================================
// Getters
// =============================================================================

/**
 * Reads the current value of the TxSubscriptionRef.
 *
 * **When to use**
 *
 * Use to read the current transactional value without subscribing to future
 * changes.
 *
 * **Example** (Reading the current value)
 *
 * ```ts
 * import { Effect, TxSubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* TxSubscriptionRef.make("hello")
 *   const value = yield* TxSubscriptionRef.get(ref)
 *   console.log(value) // "hello"
 * })
 * ```
 *
 * @see {@link changes} for reading the current value and subsequent updates
 *
 * @category getters
 * @since 3.10.0
 */
export const get = <A>(self: TxSubscriptionRef<A>): Effect.Effect<A> => TxRef.get(self.ref)

// =============================================================================
// Mutations
// =============================================================================

/**
 * Modifies the value of the TxSubscriptionRef using a function that returns both a
 * result and the new value. The new value is published to all subscribers atomically.
 *
 * **When to use**
 *
 * Use to compute a separate return value and next state in one transactional
 * update.
 *
 * **Example** (Modifying and returning a value)
 *
 * ```ts
 * import { Effect, TxSubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* TxSubscriptionRef.make(10)
 *   const result = yield* TxSubscriptionRef.modify(ref, (n) => [`was ${n}`, n + 1])
 *   console.log(result) // "was 10"
 *   console.log(yield* TxSubscriptionRef.get(ref)) // 11
 * })
 * ```
 *
 * @see {@link update} for deriving the next value without a separate return value
 * @see {@link set} for replacing the value directly
 *
 * @category mutations
 * @since 3.10.0
 */
export const modify: {
  <A, B>(
    f: (current: A) => [returnValue: B, newValue: A]
  ): (self: TxSubscriptionRef<A>) => Effect.Effect<B>
  <A, B>(
    self: TxSubscriptionRef<A>,
    f: (current: A) => [returnValue: B, newValue: A]
  ): Effect.Effect<B>
} = dual(
  2,
  <A, B>(
    self: TxSubscriptionRef<A>,
    f: (current: A) => [returnValue: B, newValue: A]
  ): Effect.Effect<B> =>
    Effect.gen(function*() {
      const current = yield* TxRef.get(self.ref)
      const [returnValue, newValue] = f(current)
      yield* TxRef.set(self.ref, newValue)
      yield* TxPubSub.publish(self.pubsub, newValue)
      return returnValue
    }).pipe(Effect.tx)
)

/**
 * Sets the value of the TxSubscriptionRef and publishes the new value to all subscribers.
 *
 * **When to use**
 *
 * Use to replace the current value with a known value and publish it.
 *
 * **Example** (Setting a new value)
 *
 * ```ts
 * import { Effect, TxSubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* TxSubscriptionRef.make(0)
 *   yield* TxSubscriptionRef.set(ref, 42)
 *   console.log(yield* TxSubscriptionRef.get(ref)) // 42
 * })
 * ```
 *
 * @see {@link update} for deriving the new value from the current value
 * @see {@link getAndSet} for setting while returning the previous value
 *
 * @category mutations
 * @since 3.10.0
 */
export const set: {
  <A>(value: A): (self: TxSubscriptionRef<A>) => Effect.Effect<void>
  <A>(self: TxSubscriptionRef<A>, value: A): Effect.Effect<void>
} = dual(
  2,
  <A>(self: TxSubscriptionRef<A>, value: A): Effect.Effect<void> => modify(self, () => [void 0, value])
)

/**
 * Updates the value of the TxSubscriptionRef using a function and publishes the new
 * value to all subscribers.
 *
 * **When to use**
 *
 * Use to derive the next value from the current value and publish it.
 *
 * **Example** (Updating a value)
 *
 * ```ts
 * import { Effect, TxSubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* TxSubscriptionRef.make(5)
 *   yield* TxSubscriptionRef.update(ref, (n) => n * 2)
 *   console.log(yield* TxSubscriptionRef.get(ref)) // 10
 * })
 * ```
 *
 * @see {@link set} for replacing the value directly
 * @see {@link updateAndGet} for returning the new value after the update
 *
 * @category mutations
 * @since 3.10.0
 */
export const update: {
  <A>(f: (current: A) => A): (self: TxSubscriptionRef<A>) => Effect.Effect<void>
  <A>(self: TxSubscriptionRef<A>, f: (current: A) => A): Effect.Effect<void>
} = dual(
  2,
  <A>(self: TxSubscriptionRef<A>, f: (current: A) => A): Effect.Effect<void> =>
    modify(self, (current) => [void 0, f(current)])
)

/**
 * Gets the current value and sets a new value atomically. Publishes the new value
 * to all subscribers.
 *
 * **When to use**
 *
 * Use to replace the value while returning the previous value.
 *
 * **Example** (Getting and setting atomically)
 *
 * ```ts
 * import { Effect, TxSubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* TxSubscriptionRef.make("a")
 *   const old = yield* TxSubscriptionRef.getAndSet(ref, "b")
 *   console.log(old) // "a"
 *   console.log(yield* TxSubscriptionRef.get(ref)) // "b"
 * })
 * ```
 *
 * @see {@link set} for setting without returning the previous value
 * @see {@link getAndUpdate} for deriving the new value from the previous value
 *
 * @category mutations
 * @since 3.10.0
 */
export const getAndSet: {
  <A>(value: A): (self: TxSubscriptionRef<A>) => Effect.Effect<A>
  <A>(self: TxSubscriptionRef<A>, value: A): Effect.Effect<A>
} = dual(
  2,
  <A>(self: TxSubscriptionRef<A>, value: A): Effect.Effect<A> => modify(self, (current) => [current, value])
)

/**
 * Gets the current value and updates it using a function atomically. Publishes
 * the new value to all subscribers.
 *
 * **When to use**
 *
 * Use to derive and publish a new value while returning the previous value.
 *
 * **Example** (Getting and updating atomically)
 *
 * ```ts
 * import { Effect, TxSubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* TxSubscriptionRef.make(1)
 *   const old = yield* TxSubscriptionRef.getAndUpdate(ref, (n) => n + 10)
 *   console.log(old) // 1
 *   console.log(yield* TxSubscriptionRef.get(ref)) // 11
 * })
 * ```
 *
 * @see {@link update} for updating without returning the previous value
 * @see {@link updateAndGet} for returning the new value instead
 *
 * @category mutations
 * @since 3.10.0
 */
export const getAndUpdate: {
  <A>(f: (current: A) => A): (self: TxSubscriptionRef<A>) => Effect.Effect<A>
  <A>(self: TxSubscriptionRef<A>, f: (current: A) => A): Effect.Effect<A>
} = dual(
  2,
  <A>(self: TxSubscriptionRef<A>, f: (current: A) => A): Effect.Effect<A> =>
    modify(self, (current) => [current, f(current)])
)

/**
 * Updates the value using a function and returns the new value. Publishes the
 * new value to all subscribers.
 *
 * **When to use**
 *
 * Use to derive and publish a new value while returning that new value.
 *
 * **Example** (Updating and reading atomically)
 *
 * ```ts
 * import { Effect, TxSubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* TxSubscriptionRef.make(3)
 *   const result = yield* TxSubscriptionRef.updateAndGet(ref, (n) => n * 3)
 *   console.log(result) // 9
 * })
 * ```
 *
 * @see {@link update} for updating without returning the new value
 * @see {@link getAndUpdate} for returning the previous value instead
 *
 * @category mutations
 * @since 3.10.0
 */
export const updateAndGet: {
  <A>(f: (current: A) => A): (self: TxSubscriptionRef<A>) => Effect.Effect<A>
  <A>(self: TxSubscriptionRef<A>, f: (current: A) => A): Effect.Effect<A>
} = dual(
  2,
  <A>(self: TxSubscriptionRef<A>, f: (current: A) => A): Effect.Effect<A> =>
    modify(self, (current) => {
      const newValue = f(current)
      return [newValue, newValue]
    })
)

// =============================================================================
// Subscriptions
// =============================================================================

/**
 * Subscribes to all changes of the TxSubscriptionRef. Returns a scoped TxDequeue
 * that first yields the current value, then every subsequent update.
 *
 * **When to use**
 *
 * Use to subscribe to committed changes through a scoped transactional queue.
 *
 * **Example** (Subscribing to changes)
 *
 * ```ts
 * import { Effect, TxQueue, TxSubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* TxSubscriptionRef.make(0)
 *
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       const sub = yield* TxSubscriptionRef.changes(ref)
 *       const initial = yield* TxQueue.take(sub)
 *       console.log(initial) // 0
 *
 *       yield* TxSubscriptionRef.set(ref, 1)
 *       const next = yield* TxQueue.take(sub)
 *       console.log(next) // 1
 *     })
 *   )
 * })
 * ```
 *
 * @see {@link changesStream} for subscribing through a `Stream`
 *
 * @category subscriptions
 * @since 3.10.0
 */
export const changes = <A>(
  self: TxSubscriptionRef<A>
): Effect.Effect<TxQueue.TxQueue<A>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tx(
      Effect.gen(function*() {
        const sub = yield* TxPubSub.acquireSubscriber(self.pubsub)
        const current = yield* TxRef.get(self.ref)
        yield* TxQueue.offer(sub, current)
        return sub
      })
    ),
    (queue) => Effect.tx(TxPubSub.releaseSubscriber(self.pubsub, queue))
  )

/**
 * Returns a Stream of all changes to the TxSubscriptionRef, starting with the
 * current value followed by every subsequent update.
 *
 * **When to use**
 *
 * Use to consume committed changes as a `Stream`.
 *
 * **Example** (Streaming changes)
 *
 * ```ts
 * import { Effect, Stream, TxSubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* TxSubscriptionRef.make(0)
 *   yield* TxSubscriptionRef.set(ref, 1)
 *   yield* TxSubscriptionRef.set(ref, 2)
 *
 *   const values = yield* Stream.runCollect(
 *     TxSubscriptionRef.changesStream(ref).pipe(Stream.take(1))
 *   )
 *   console.log(values) // [2]
 * })
 * ```
 *
 * @see {@link changes} for subscribing through a transactional queue
 *
 * @category subscriptions
 * @since 3.10.0
 */
export const changesStream = <A>(self: TxSubscriptionRef<A>): Stream.Stream<A, never, never> =>
  Stream.unwrap(
    Effect.map(
      changes(self),
      (sub) => Stream.fromEffectRepeat(Effect.tx(TxQueue.take(sub)))
    )
  )

// =============================================================================
// Guards
// =============================================================================

/**
 * Checks whether the given value is a TxSubscriptionRef.
 *
 * **When to use**
 *
 * Use to narrow an unknown value before treating it as a `TxSubscriptionRef`.
 *
 * **Example** (Checking transactional subscription references)
 *
 * ```ts
 * import { TxSubscriptionRef } from "effect"
 *
 * declare const someValue: unknown
 *
 * if (TxSubscriptionRef.isTxSubscriptionRef(someValue)) {
 *   console.log("This is a TxSubscriptionRef")
 * }
 * ```
 *
 * @see {@link make} for creating a `TxSubscriptionRef`
 *
 * @category guards
 * @since 4.0.0
 */
export const isTxSubscriptionRef = (u: unknown): u is TxSubscriptionRef<unknown> => hasProperty(u, TypeId)
