/**
 * The `Queue` module provides asynchronous queues for communicating between
 * fibers. A `Queue<A, E>` accepts values of type `A`, hands each value to one
 * consumer in offer order, and can later complete, fail, interrupt, or shut
 * down through the queue lifecycle.
 *
 * **Mental model**
 *
 * - A queue is a fiber-aware channel with a write side ({@link Enqueue}) and a
 *   read side ({@link Dequeue}).
 * - Producers add values with {@link offer} or {@link offerAll}; consumers
 *   remove values with {@link take}, {@link takeN}, {@link takeBetween}, or
 *   {@link takeAll}.
 * - Unlike publish-subscribe hubs, consumers compete for values; a successful
 *   take removes the value from the queue.
 * - Bounded queues use an overflow strategy: {@link bounded} suspends
 *   producers, {@link dropping} rejects new values, and {@link sliding} drops
 *   old values.
 * - Operations are `Effect` values, so waiting producers and consumers compose
 *   with interruption, scheduling, and structured concurrency.
 *
 * **Common tasks**
 *
 * - Create queues: {@link make}, {@link bounded}, {@link dropping},
 *   {@link sliding}, {@link unbounded}.
 * - Restrict capabilities: {@link asEnqueue}, {@link asDequeue}.
 * - Produce values: {@link offer}, {@link offerAll}.
 * - Consume values: {@link take}, {@link takeN}, {@link takeBetween},
 *   {@link takeAll}, {@link poll}, {@link peek}.
 * - Drain or reset buffered values: {@link collect}, {@link clear}.
 * - Signal lifecycle: {@link end}, {@link fail}, {@link failCause},
 *   {@link interrupt}, {@link shutdown}.
 * - Inspect state: {@link size}, {@link isFull}.
 *
 * **Example** (One producer and one consumer)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<string>(16)
 *
 *   yield* Queue.offer(queue, "work")
 *
 *   return yield* Queue.take(queue)
 * })
 * ```
 *
 * **Gotchas**
 *
 * - {@link take} waits when the queue is empty; use {@link poll} when absence
 *   should be represented as an empty `Option`.
 * - {@link dropping} and {@link sliding} queues can lose values by design; use
 *   {@link bounded} when every offered value must be preserved.
 * - Completion and failure are observed by consumers through the queue's error
 *   channel, so include `Cause.Done` in the error type when using {@link end}.
 * - The `Unsafe` variants are synchronous, low-level operations; prefer the
 *   effectful APIs in application code.
 *
 * **See also**
 *
 * - {@link Enqueue} for write-only queue handles.
 * - {@link Dequeue} for read-only queue handles.
 * - {@link Pull} for stream-style completion errors.
 *
 * @since 3.8.0
 */
import * as Arr from "./Array.ts"
import type { Cause, Done } from "./Cause.ts"
import type { Effect } from "./Effect.ts"
import type { Exit, Failure } from "./Exit.ts"
import { constant, constTrue, dual, identity } from "./Function.ts"
import type { Inspectable } from "./Inspectable.ts"
import * as core from "./internal/core.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import * as internalEffect from "./internal/effect.ts"
import * as MutableList from "./MutableList.ts"
import * as Option from "./Option.ts"
import { hasProperty } from "./Predicate.ts"
import * as Pull from "./Pull.ts"
import type { SchedulerDispatcher } from "./Scheduler.ts"
import type * as Types from "./Types.ts"

const TypeId = "~effect/Queue"
const EnqueueTypeId = "~effect/Queue/Enqueue"
const DequeueTypeId = "~effect/Queue/Dequeue"

/**
 * Type guard to check if a value is a Queue.
 *
 * **When to use**
 *
 * Use to narrow an unknown value to a full `Queue` before passing it to APIs
 * that need both offering and taking capabilities.
 *
 * @see {@link isEnqueue} for checking values that only need write access
 * @see {@link isDequeue} for checking values that only need read access
 *
 * @category guards
 * @since 2.0.0
 */
export const isQueue = <A = unknown, E = unknown>(
  u: unknown
): u is Queue<A, E> => hasProperty(u, TypeId)

/**
 * Type guard to check if a value is an Enqueue.
 *
 * **When to use**
 *
 * Use to narrow an unknown value before calling queue operations that require
 * write-side access.
 *
 * **Gotchas**
 *
 * A full `Queue` also satisfies this guard because every queue includes the
 * enqueue side.
 *
 * @see {@link isQueue} for checking for a full read-write queue handle
 * @see {@link isDequeue} for checking for the read side of a queue
 * @see {@link asEnqueue} for narrowing an existing `Queue` to its write-only interface
 *
 * @category guards
 * @since 2.0.0
 */
export const isEnqueue = <A = unknown, E = unknown>(
  u: unknown
): u is Enqueue<A, E> => hasProperty(u, EnqueueTypeId)

/**
 * Type guard to check if a value is a Dequeue.
 *
 * **When to use**
 *
 * Use to narrow an unknown value before passing it to read-side queue
 * operations.
 *
 * @see {@link Dequeue} for the read-side queue handle checked by this guard
 * @see {@link isQueue} for checking for a full read-write queue handle
 * @see {@link isEnqueue} for checking for the write side of a queue
 * @see {@link asDequeue} for narrowing an existing `Queue` to its read-only interface
 *
 * @category guards
 * @since 2.0.0
 */
export const isDequeue = <A = unknown, E = unknown>(
  u: unknown
): u is Dequeue<A, E> => hasProperty(u, DequeueTypeId)

/**
 * Converts a `Queue` to its write-only `Enqueue` interface.
 *
 * **When to use**
 *
 * Use to expose only the producer side of a `Queue` to code that should offer
 * values or signal queue lifecycle.
 *
 * **Gotchas**
 *
 * This is a type-level capability restriction. It returns the same queue
 * object, so it does not hide read operations at runtime.
 *
 * @see {@link asDequeue} for exposing only the read side of a `Queue`
 * @see {@link Enqueue} for the write-only queue handle returned by this conversion
 *
 * @category converting
 * @since 4.0.0
 */
export const asEnqueue = <A, E>(self: Queue<A, E>): Enqueue<A, E> => self

/**
 * Narrows a `Queue` to a `Dequeue`, exposing the consumer side of the queue.
 *
 * **When to use**
 *
 * Use to pass a queue to code that should consume values while keeping
 * producer-side operations out of that code's TypeScript type.
 *
 * **Gotchas**
 *
 * This is a type-level narrowing operation. It returns the same queue object
 * and does not create a runtime wrapper.
 *
 * @see {@link asEnqueue} for narrowing a queue to its producer side
 * @see {@link Dequeue} for the consumer-side queue handle returned by this function
 *
 * @category converting
 * @since 4.0.0
 */
export const asDequeue: <A, E>(self: Queue<A, E>) => Dequeue<A, E> = identity

/**
 * An `Enqueue` is a queue that can be offered to.
 *
 * **Details**
 *
 * This interface represents the write-only part of a Queue, allowing you to offer
 * elements to the queue but not take elements from it.
 *
 * **Example** (Offering through enqueue handles)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * // Function that only needs write access to a queue
 * const producer = (enqueue: Queue.Enqueue<string>) =>
 *   Effect.gen(function*() {
 *     yield* Queue.offer(enqueue, "hello")
 *     yield* Queue.offerAll(enqueue, ["world", "!"])
 *   })
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<string>(10)
 *   yield* producer(queue)
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Enqueue<in A, in E = never> extends Inspectable {
  readonly [EnqueueTypeId]: Enqueue.Variance<A, E>
  readonly strategy: "suspend" | "dropping" | "sliding"
  readonly dispatcher: SchedulerDispatcher
  capacity: number
  messages: MutableList.MutableList<any>
  state: Queue.State<any, any>
  scheduleRunning: boolean
}

/**
 * Companion namespace containing type-level metadata for the `Enqueue`
 * write-only queue interface.
 *
 * @since 2.0.0
 */
export declare namespace Enqueue {
  /**
   * Type-level variance marker for `Enqueue`.
   *
   * **Details**
   *
   * `Enqueue` is contravariant in both its offered value type `A` and failure
   * type `E`, because values and failures flow into the queue through this
   * handle.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Variance<A, E> {
    _A: Types.Contravariant<A>
    _E: Types.Contravariant<E>
  }
}

/**
 * A `Dequeue` is a queue that can be taken from.
 *
 * **Details**
 *
 * This interface represents the read-only part of a Queue, allowing you to take
 * elements from the queue but not offer elements to it.
 *
 * **Example** (Taking through dequeue handles)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<string, never>(10)
 *
 *   // A Dequeue can only take elements
 *   const dequeue: Queue.Dequeue<string> = queue
 *
 *   // Pre-populate the queue
 *   yield* Queue.offerAll(queue, ["a", "b", "c"])
 *
 *   // Take elements using dequeue interface
 *   const item = yield* Queue.take(dequeue)
 *   console.log(item) // "a"
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Dequeue<out A, out E = never> extends Inspectable {
  readonly [DequeueTypeId]: Dequeue.Variance<A, E>
  readonly strategy: "suspend" | "dropping" | "sliding"
  readonly dispatcher: SchedulerDispatcher
  capacity: number
  messages: MutableList.MutableList<any>
  state: Queue.State<any, any>
  scheduleRunning: boolean
}

/**
 * Companion namespace containing type-level metadata for the `Dequeue`
 * read-only queue interface.
 *
 * @since 2.0.0
 */
export declare namespace Dequeue {
  /**
   * Type-level variance marker for `Dequeue`.
   *
   * **Details**
   *
   * `Dequeue` is covariant in both the taken value type `A` and failure type
   * `E`, because values and failures are observed through this handle.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Variance<A, E> {
    _A: Types.Covariant<A>
    _E: Types.Covariant<E>
  }
}

/**
 * A `Queue` is an asynchronous queue that can be offered to and taken from.
 *
 * **Details**
 *
 * It also supports signaling that it is done or failed.
 *
 * **Example** (Offering and taking queue values)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a bounded queue
 *   const queue = yield* Queue.bounded<string>(10)
 *
 *   // Producer: offer items to the queue
 *   yield* Queue.offer(queue, "hello")
 *   yield* Queue.offerAll(queue, ["world", "!"])
 *
 *   // Consumer: take items from the queue
 *   const item1 = yield* Queue.take(queue)
 *   const item2 = yield* Queue.take(queue)
 *   const item3 = yield* Queue.take(queue)
 *
 *   console.log([item1, item2, item3]) // ["hello", "world", "!"]
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Queue<in out A, in out E = never> extends Enqueue<A, E>, Dequeue<A, E> {
  readonly [TypeId]: Queue.Variance<A, E>
}

/**
 * Companion namespace containing type-level metadata and low-level state types
 * for `Queue`.
 *
 * @since 2.0.0
 */
export declare namespace Queue {
  /**
   * Type-level variance marker for `Queue`.
   *
   * **Details**
   *
   * A full `Queue` is invariant in both `A` and `E` because the same handle can
   * both produce and consume values and failures.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Variance<A, E> {
    _A: Types.Invariant<A>
    _E: Types.Invariant<E>
  }

  /**
   * Tagged state of a `Queue`.
   *
   * **Details**
   *
   * `Open` queues can accept offers and takers, `Closing` queues are
   * completing with a stored failure exit, and `Done` queues have finished.
   * This is low-level metadata exposed by the queue model; most users should
   * inspect queues through the public operations.
   *
   * @category models
   * @since 4.0.0
   */
  export type State<A, E> =
    | {
      readonly _tag: "Open"
      readonly takers: Set<(_: Effect<void, E>) => void>
      readonly offers: Set<OfferEntry<A>>
      readonly awaiters: Set<(_: Effect<void, E>) => void>
    }
    | {
      readonly _tag: "Closing"
      readonly takers: Set<(_: Effect<void, E>) => void>
      readonly offers: Set<OfferEntry<A>>
      readonly awaiters: Set<(_: Effect<void, E>) => void>
      readonly exit: Failure<never, E>
    }
    | {
      readonly _tag: "Done"
      readonly exit: Failure<never, E>
    }

  /**
   * Represents a suspended offer waiting to be admitted to a bounded queue.
   *
   * **Details**
   *
   * An entry is either a single message or a batch with an offset into its
   * remaining messages, plus a resume callback that completes the suspended
   * offer when the queue can accept more input.
   *
   * @category models
   * @since 4.0.0
   */
  export type OfferEntry<A> =
    | {
      readonly _tag: "Array"
      readonly remaining: Array<A>
      offset: number
      readonly resume: (_: Effect<Array<A>>) => void
    }
    | {
      readonly _tag: "Single"
      readonly message: A
      readonly resume: (_: Effect<boolean>) => void
    }
}

const variance = {
  _A: identity,
  _E: identity
}
const QueueProto = {
  [TypeId]: variance,
  [EnqueueTypeId]: variance,
  [DequeueTypeId]: variance,
  ...PipeInspectableProto,
  toJSON(this: Queue<unknown, unknown>) {
    return {
      _id: "effect/Queue",
      state: this.state._tag,
      size: sizeUnsafe(this)
    }
  }
}

/**
 * Creates a `Queue` with optional capacity and overflow strategy.
 *
 * **Details**
 *
 * By default the queue is unbounded and uses the `"suspend"` strategy. Provide
 * `capacity` for a bounded queue and choose `"suspend"`, `"dropping"`, or
 * `"sliding"` to control what happens when the queue is full. The returned
 * queue can be offered to, taken from, failed, ended, interrupted, or shut down.
 *
 * **Example** (Creating queues)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * Effect.gen(function*() {
 *   const queue = yield* Queue.make<number, string | Cause.Done>()
 *
 *   // add messages to the queue
 *   yield* Queue.offer(queue, 1)
 *   yield* Queue.offer(queue, 2)
 *   yield* Queue.offerAll(queue, [3, 4, 5])
 *
 *   // take messages from the queue
 *   const messages = yield* Queue.takeAll(queue)
 *   console.log(messages) // [1, 2, 3, 4, 5]
 *
 *   // signal that the queue is done
 *   yield* Queue.end(queue)
 *   const done = yield* Effect.flip(Queue.take(queue))
 *   console.log(Cause.isDone(done)) // true
 *
 *   // signal that another queue has failed
 *   const failedQueue = yield* Queue.make<number, string>()
 *   const failed = yield* Queue.fail(failedQueue, "boom")
 *   console.log(failed) // true
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <A, E = never>(
  options?: {
    readonly capacity?: number | undefined
    readonly strategy?: "suspend" | "dropping" | "sliding" | undefined
  } | undefined
): Effect<Queue<A, E>> =>
  core.withFiber((fiber) => {
    const self = Object.create(QueueProto)
    self.dispatcher = fiber.currentDispatcher
    self.capacity = options?.capacity ?? Number.POSITIVE_INFINITY
    self.strategy = options?.strategy ?? "suspend"
    self.messages = MutableList.make()
    self.scheduleRunning = false
    self.state = {
      _tag: "Open",
      takers: new Set(),
      offers: new Set(),
      awaiters: new Set()
    }
    return internalEffect.succeed(self)
  })

/**
 * Creates a bounded queue with the specified capacity that uses backpressure strategy.
 *
 * **Details**
 *
 * When the queue reaches capacity, producers will be suspended until space becomes available.
 * This ensures all messages are processed but may slow down producers.
 *
 * **Example** (Creating bounded queues)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<string>(5)
 *
 *   // This will succeed as queue has capacity
 *   yield* Queue.offer(queue, "first")
 *   yield* Queue.offer(queue, "second")
 *
 *   const size = yield* Queue.size(queue)
 *   console.log(size) // 2
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const bounded = <A, E = never>(capacity: number): Effect<Queue<A, E>> => make({ capacity })

/**
 * Creates a bounded queue with sliding strategy. When the queue reaches capacity,
 * new elements are added and the oldest elements are dropped.
 *
 * **When to use**
 *
 * Use when producers should not block and message loss is acceptable.
 * Useful when you want to maintain a rolling window of the most recent messages.
 *
 * **Example** (Creating sliding queues)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.sliding<number>(3)
 *
 *   // Fill the queue to capacity
 *   yield* Queue.offer(queue, 1)
 *   yield* Queue.offer(queue, 2)
 *   yield* Queue.offer(queue, 3)
 *
 *   // This will succeed, dropping the oldest element (1)
 *   yield* Queue.offer(queue, 4)
 *
 *   const all = yield* Queue.takeAll(queue)
 *   console.log(all) // [2, 3, 4] - oldest element (1) was dropped
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const sliding = <A, E = never>(capacity: number): Effect<Queue<A, E>> => make({ capacity, strategy: "sliding" })

/**
 * Creates a bounded queue with dropping strategy. When the queue reaches capacity,
 * new elements are dropped and the offer operation returns false.
 *
 * **When to use**
 *
 * Use when producers should not block and existing messages should be preserved,
 * but new messages may be lost when the queue is full.
 *
 * **Example** (Creating dropping queues)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.dropping<number>(2)
 *
 *   // Fill the queue to capacity
 *   const success1 = yield* Queue.offer(queue, 1)
 *   const success2 = yield* Queue.offer(queue, 2)
 *   console.log(success1, success2) // true, true
 *
 *   // This will be dropped
 *   const success3 = yield* Queue.offer(queue, 3)
 *   console.log(success3) // false
 *
 *   const all = yield* Queue.takeAll(queue)
 *   console.log(all) // [1, 2] - element 3 was dropped
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const dropping = <A, E = never>(capacity: number): Effect<Queue<A, E>> =>
  make({ capacity, strategy: "dropping" })

/**
 * Creates an unbounded queue that can grow to any size without blocking producers.
 *
 * **When to use**
 *
 * Use when producers should never be blocked; unbounded queues never apply backpressure, so producers
 * can always add messages successfully. This is useful when you want to prioritize
 * producer throughput over memory usage control.
 *
 * **Example** (Creating unbounded queues)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.unbounded<string>()
 *
 *   // Producers can always add messages without blocking
 *   yield* Queue.offer(queue, "message1")
 *   yield* Queue.offer(queue, "message2")
 *   yield* Queue.offerAll(queue, ["message3", "message4", "message5"])
 *
 *   // Check current size
 *   const size = yield* Queue.size(queue)
 *   console.log(size) // 5
 *
 *   // Take all messages
 *   const messages = yield* Queue.takeAll(queue)
 *   console.log(messages) // ["message1", "message2", "message3", "message4", "message5"]
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const unbounded = <A, E = never>(): Effect<Queue<A, E>> => make()

/**
 * Adds a message to the queue. Returns `false` if the queue is done.
 *
 * **Details**
 *
 * For bounded queues, this operation may suspend if the queue is at capacity,
 * depending on the backpressure strategy. For dropping/sliding queues, it may
 * return false or succeed immediately by dropping/sliding existing messages.
 *
 * **Example** (Offering a value)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number>(3)
 *
 *   // Successfully add messages to queue
 *   const success1 = yield* Queue.offer(queue, 1)
 *   const success2 = yield* Queue.offer(queue, 2)
 *   console.log(success1, success2) // true, true
 *
 *   // Queue state
 *   const size = yield* Queue.size(queue)
 *   console.log(size) // 2
 * })
 * ```
 *
 * @category Offering
 * @since 2.0.0
 */
export const offer = <A, E>(self: Enqueue<A, E>, message: Types.NoInfer<A>): Effect<boolean> =>
  internalEffect.suspend(() => {
    if (self.state._tag !== "Open") {
      return exitFalse
    } else if (self.messages.length >= self.capacity) {
      switch (self.strategy) {
        case "dropping":
          return exitFalse
        case "suspend":
          if (self.capacity <= 0 && self.state.takers.size > 0) {
            MutableList.append(self.messages, message)
            releaseTakers(self as Queue<A, E>)
            return exitTrue
          }
          return offerRemainingSingle(self as Queue<A, E>, message)
        case "sliding":
          MutableList.take(self.messages)
          MutableList.append(self.messages, message)
          return exitTrue
      }
    }
    MutableList.append(self.messages, message)
    scheduleReleaseTaker(self as Queue<A, E>)
    return exitTrue
  })

/**
 * Adds a message to the queue synchronously. Returns `false` if the queue is done.
 *
 * **Gotchas**
 *
 * This is an unsafe operation that directly modifies the queue without Effect wrapping.
 * Use this only when you're certain about the synchronous nature of the operation.
 *
 * **Example** (Offering a value synchronously)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * // Create a queue effect and extract the queue for unsafe operations
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number>(3)
 *
 *   // Add messages synchronously using unsafe API
 *   const success1 = Queue.offerUnsafe(queue, 1)
 *   const success2 = Queue.offerUnsafe(queue, 2)
 *   console.log(success1, success2) // true, true
 *
 *   // Check current size
 *   const size = Queue.sizeUnsafe(queue)
 *   console.log(size) // 2
 * })
 * ```
 *
 * @category Offering
 * @since 4.0.0
 */
export const offerUnsafe = <A, E>(self: Enqueue<A, E>, message: Types.NoInfer<A>): boolean => {
  if (self.state._tag !== "Open") {
    return false
  } else if (self.messages.length >= self.capacity) {
    if (self.strategy === "sliding") {
      MutableList.take(self.messages)
      MutableList.append(self.messages, message)
      return true
    } else if (self.capacity <= 0 && self.state.takers.size > 0) {
      MutableList.append(self.messages, message)
      releaseTakers(self as Queue<A, E>)
      return true
    }
    return false
  }
  MutableList.append(self.messages, message)
  scheduleReleaseTaker(self as Queue<A, E>)
  return true
}

/**
 * Adds multiple messages to the queue. Returns the remaining messages that
 * were not added.
 *
 * **Details**
 *
 * For bounded queues, this operation may suspend if the queue doesn't have
 * enough capacity. The operation returns an array of messages that couldn't
 * be added (empty array means all messages were successfully added).
 *
 * **Example** (Offering multiple values)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.dropping<number>(3)
 *
 *   // Try to add more messages than capacity without suspending
 *   const remaining1 = yield* Queue.offerAll(queue, [1, 2, 3, 4, 5])
 *   console.log(remaining1) // [4, 5] - couldn't fit the last 2
 * })
 * ```
 *
 * @category Offering
 * @since 2.0.0
 */
export const offerAll = <A, E>(self: Enqueue<A, E>, messages: Iterable<A>): Effect<Array<A>> =>
  internalEffect.suspend(() => {
    if (self.state._tag !== "Open") {
      return internalEffect.succeed(Arr.fromIterable(messages))
    }
    const remaining = offerAllUnsafe(self as Queue<A, E>, messages)
    if (remaining.length === 0) {
      return core.exitSucceed([])
    } else if (self.strategy === "dropping") {
      return internalEffect.succeed(remaining)
    }
    return offerRemainingArray(self as Queue<A, E>, remaining)
  })

/**
 * Adds multiple messages to the queue synchronously. Returns the remaining messages that
 * were not added.
 *
 * **Gotchas**
 *
 * This is an unsafe operation that directly modifies the queue without Effect wrapping.
 *
 * **Example** (Offering multiple values synchronously)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * // Create a bounded queue and use unsafe API
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number>(3)
 *
 *   // Try to add 5 messages to capacity-3 queue using unsafe API
 *   const remaining = Queue.offerAllUnsafe(queue, [1, 2, 3, 4, 5])
 *   console.log(remaining) // [4, 5] - couldn't fit the last 2
 *
 *   // Check what's in the queue
 *   const size = Queue.sizeUnsafe(queue)
 *   console.log(size) // 3
 * })
 * ```
 *
 * @category Offering
 * @since 4.0.0
 */
export const offerAllUnsafe = <A, E>(self: Enqueue<A, E>, messages: Iterable<A>): Array<A> => {
  if (self.state._tag !== "Open") {
    return Arr.fromIterable(messages)
  } else if (
    self.capacity === Number.POSITIVE_INFINITY ||
    self.strategy === "sliding"
  ) {
    MutableList.appendAll(self.messages, messages)
    if (self.strategy === "sliding") {
      MutableList.takeN(self.messages, self.messages.length - self.capacity)
    }
    scheduleReleaseTaker(self as Queue<A, E>)
    return []
  }
  const free = self.capacity <= 0
    ? self.state.takers.size
    : self.capacity - self.messages.length
  if (free === 0) {
    return Arr.fromIterable(messages)
  }
  const remaining: Array<A> = []
  let i = 0
  for (const message of messages) {
    if (i < free) {
      MutableList.append(self.messages, message)
    } else {
      remaining.push(message)
    }
    i++
  }
  scheduleReleaseTaker(self as Queue<A, E>)
  return remaining
}

/**
 * Fails the queue with an error. If the queue is already done, `false` is
 * returned.
 *
 * **Example** (Failing queues with an error)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, string>(10)
 *
 *   // Fail the queue with an error
 *   const failed = yield* Queue.fail(queue, "Something went wrong")
 *   console.log(failed) // true
 *
 *   // Taking from the failed queue fails with the error
 *   const error = yield* Effect.flip(Queue.take(queue))
 *   console.log(error) // "Something went wrong"
 * })
 * ```
 *
 * @category Completion
 * @since 4.0.0
 */
export const fail = <A, E>(self: Enqueue<A, E>, error: E) => failCause(self, core.causeFail(error))

/**
 * Fails the queue with a cause. If the queue is already done, `false` is
 * returned.
 *
 * **Example** (Failing queues with a cause)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, string>(10)
 *
 *   // Create a cause and fail the queue
 *   const cause = Cause.fail("Queue processing failed")
 *   const failed = yield* Queue.failCause(queue, cause)
 *   console.log(failed) // true
 *
 *   // The queue is now done with the specified failure cause
 *   console.log(queue.state._tag) // "Done"
 * })
 * ```
 *
 * @category Completion
 * @since 4.0.0
 */
export const failCause: {
  <E>(cause: Cause<E>): <A>(self: Enqueue<A, E>) => Effect<boolean>
  <A, E>(self: Enqueue<A, E>, cause: Cause<E>): Effect<boolean>
} = dual(
  2,
  <A, E>(self: Enqueue<A, E>, cause: Cause<E>): Effect<boolean> =>
    internalEffect.sync(() => failCauseUnsafe(self, cause))
)

/**
 * Fails the queue with a cause synchronously. If the queue is already done, `false` is
 * returned.
 *
 * **Gotchas**
 *
 * This is an unsafe operation that directly modifies the queue without Effect wrapping.
 *
 * **Example** (Failing queues with a cause synchronously)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, string>(10)
 *
 *   // Create a cause and fail the queue synchronously
 *   const cause = Cause.fail("Processing error")
 *   const failed = Queue.failCauseUnsafe(queue, cause)
 *   console.log(failed) // true
 *
 *   // The queue is now done with the specified failure cause
 *   console.log(queue.state._tag) // "Done"
 * })
 * ```
 *
 * @category Completion
 * @since 4.0.0
 */
export const failCauseUnsafe = <A, E>(self: Enqueue<A, E>, cause: Cause<E>): boolean => {
  if (self.state._tag !== "Open") {
    return false
  }
  const exit = core.exitFailCause(cause)
  const fail = internalEffect.exitZipRight(exit, exitFailDone) as Failure<never, E>
  if (
    self.state.offers.size === 0 &&
    self.messages.length === 0
  ) {
    finalize(self, fail)
    return true
  }
  self.state = { ...self.state, _tag: "Closing", exit: fail }
  return true
}

/**
 * Signals queue completion.
 *
 * **When to use**
 *
 * Use to stop accepting new offers while allowing already queued messages to be
 * consumed.
 *
 * **Details**
 *
 * Returns `false` if the queue is already done.
 *
 * **Example** (Ending queues)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(10)
 *
 *   // Add some messages
 *   yield* Queue.offer(queue, 1)
 *   yield* Queue.offer(queue, 2)
 *
 *   // Signal completion - no more messages will be accepted
 *   const ended = yield* Queue.end(queue)
 *   console.log(ended) // true
 *
 *   // Trying to offer more messages will return false
 *   const offerResult = yield* Queue.offer(queue, 3)
 *   console.log(offerResult) // false
 *
 *   // But we can still take existing messages
 *   const message = yield* Queue.take(queue)
 *   console.log(message) // 1
 * })
 * ```
 *
 * @category Completion
 * @since 4.0.0
 */
export const end = <A, E>(self: Enqueue<A, E | Done>): Effect<boolean> => failCause(self, core.causeFail(core.Done()))

/**
 * Signals queue completion synchronously.
 *
 * **When to use**
 *
 * Use when implementing low-level queue integrations that must complete a queue
 * without wrapping the operation in `Effect`.
 *
 * **Details**
 *
 * Returns `false` if the queue is already done.
 *
 * **Gotchas**
 *
 * This is an unsafe operation that directly modifies the queue without Effect wrapping.
 *
 * **Example** (Ending queues synchronously)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * // Create a queue and use unsafe operations
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(10)
 *
 *   // Add some messages
 *   Queue.offerUnsafe(queue, 1)
 *   Queue.offerUnsafe(queue, 2)
 *
 *   // End the queue synchronously
 *   const ended = Queue.endUnsafe(queue)
 *   console.log(ended) // true
 *
 *   // Existing messages can still be consumed while the queue is closing
 *   console.log(queue.state._tag) // "Closing"
 *
 *   Queue.takeUnsafe(queue)
 *   Queue.takeUnsafe(queue)
 *
 *   // After buffered messages are consumed, the queue is done
 *   console.log(queue.state._tag) // "Done"
 * })
 * ```
 *
 * @category Completion
 * @since 4.0.0
 */
export const endUnsafe = <A, E>(self: Enqueue<A, E | Done>) => failCauseUnsafe(self, core.causeFail(core.Done()))

/**
 * Interrupts the queue gracefully, transitioning it to a closing state.
 *
 * **Details**
 *
 * This operation stops accepting new offers but allows existing messages to be consumed.
 * Once all messages are drained, the queue transitions to the Done state with an interrupt cause.
 *
 * **Example** (Interrupting queues gracefully)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number>(10)
 *
 *   // Add some messages
 *   yield* Queue.offer(queue, 1)
 *   yield* Queue.offer(queue, 2)
 *
 *   // Interrupt gracefully - no more offers accepted, but messages can be consumed
 *   const interrupted = yield* Queue.interrupt(queue)
 *   console.log(interrupted) // true
 *
 *   // Trying to offer more messages will return false
 *   const offerResult = yield* Queue.offer(queue, 3)
 *   console.log(offerResult) // false
 *
 *   // But we can still take existing messages
 *   const message1 = yield* Queue.take(queue)
 *   console.log(message1) // 1
 *
 *   const message2 = yield* Queue.take(queue)
 *   console.log(message2) // 2
 *
 *   // After all messages are consumed, queue is done
 *   const isDone = queue.state._tag === "Done"
 *   console.log(isDone) // true
 * })
 * ```
 *
 * @category Completion
 * @since 4.0.0
 */
export const interrupt = <A, E>(self: Enqueue<A, E>): Effect<boolean> =>
  core.withFiber((fiber) => failCause(self, internalEffect.causeInterrupt(fiber.id)))

/**
 * Shuts down the queue immediately, discarding buffered messages and resuming
 * pending operations.
 *
 * **Details**
 *
 * The operation is idempotent and returns `true`, including when the queue has
 * already been shut down or completed.
 *
 * **Example** (Shutting down queues)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number>(2)
 *
 *   // Add messages
 *   yield* Queue.offer(queue, 1)
 *   yield* Queue.offer(queue, 2)
 *
 *   // Shutdown clears buffered messages and prevents further offers
 *   const wasShutdown = yield* Queue.shutdown(queue)
 *   console.log(wasShutdown) // true
 *
 *   // Queue is now done and cleared
 *   const size = yield* Queue.size(queue)
 *   console.log(size) // 0
 * })
 * ```
 *
 * @category Completion
 * @since 2.0.0
 */
export const shutdown = <A, E>(self: Enqueue<A, E>): Effect<boolean> =>
  internalEffect.sync(() => {
    if (self.state._tag === "Done") {
      return true
    }
    MutableList.clear(self.messages)
    const offers = self.state.offers
    finalize(self, self.state._tag === "Open" ? exitInterrupt : self.state.exit)
    if (offers.size > 0) {
      for (const entry of offers) {
        if (entry._tag === "Single") {
          entry.resume(exitFalse)
        } else {
          entry.resume(core.exitSucceed(entry.remaining.slice(entry.offset)))
        }
      }
      offers.clear()
    }
    return true
  })

/**
 * Takes and returns all currently buffered messages without waiting for more.
 *
 * **Details**
 *
 * Returns an empty array when the queue is empty or has completed normally. If
 * the queue has failed, the effect fails with the queue's error.
 *
 * **Example** (Clearing queued values)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number>(10)
 *
 *   // Add several messages
 *   yield* Queue.offerAll(queue, [1, 2, 3, 4, 5])
 *
 *   // Clear all messages from the queue
 *   const messages = yield* Queue.clear(queue)
 *   console.log(messages) // [1, 2, 3, 4, 5]
 *
 *   // Queue is now empty
 *   const size = yield* Queue.size(queue)
 *   console.log(size) // 0
 *
 *   // Clearing empty queue returns empty array
 *   const empty = yield* Queue.clear(queue)
 *   console.log(empty) // []
 * })
 * ```
 *
 * @category taking
 * @since 4.0.0
 */
export const clear = <A, E>(self: Dequeue<A, E>): Effect<Array<A>, Pull.ExcludeDone<E>> =>
  internalEffect.suspend(() => {
    if (self.state._tag === "Done") {
      if (Pull.isDoneCause(self.state.exit.cause)) {
        return internalEffect.succeed([])
      }
      return self.state.exit
    }
    const messages = takeAllUnsafe(self)
    releaseCapacity(self)
    return internalEffect.succeed(messages)
  })

/**
 * Takes all currently available messages, waiting until at least one message
 * is available when the queue is empty.
 *
 * **Details**
 *
 * Returns a non-empty array. If the queue completes or fails before a message
 * can be taken, the effect fails with the queue's terminal error.
 *
 * **Example** (Taking all available values)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(5)
 *
 *   // Add several messages
 *   yield* Queue.offerAll(queue, [1, 2, 3, 4, 5])
 *
 *   // Take all available messages
 *   const messages1 = yield* Queue.takeAll(queue)
 *   console.log(messages1) // [1, 2, 3, 4, 5]
 * })
 * ```
 *
 * @category Taking
 * @since 2.0.0
 */
export const takeAll = <A, E>(self: Dequeue<A, E>): Effect<Arr.NonEmptyArray<A>, E> =>
  takeBetween(self, 1, Number.POSITIVE_INFINITY) as any

/**
 * Takes all messages from the queue, until the queue has errored or is done.
 *
 * **Example** (Collecting values until completion)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(5)
 *
 *   // Add several messages
 *   yield* Queue.offerAll(queue, [1, 2, 3, 4, 5])
 *   // Some time later, end the queue
 *   yield* Effect.forkChild(Queue.end(queue))
 *
 *   // Collect all available messages
 *   const messages = yield* Queue.collect(queue)
 *   console.log(messages) // [1, 2, 3, 4, 5]
 * })
 * ```
 *
 * @category Taking
 * @since 4.0.0
 */
export const collect = <A, E>(self: Dequeue<A, E | Done>): Effect<Array<A>, Pull.ExcludeDone<E>> =>
  internalEffect.suspend(() => {
    const out = Arr.empty<A>()
    return internalEffect.as(
      Pull.catchDone(
        internalEffect.whileLoop({
          while: constTrue,
          body: constant(takeAll(self)),
          step(items: Arr.NonEmptyArray<A>) {
            for (let i = 0; i < items.length; i++) {
              out.push(items[i])
            }
          }
        }),
        () => internalEffect.void
      ),
      out
    )
  }) as any

/**
 * Takes up to `n` messages from the queue.
 *
 * **Details**
 *
 * The operation may wait until enough messages are available to satisfy the
 * queue's batching rules. If `n` is less than or equal to zero, it succeeds
 * with an empty array. If the queue completes or fails before messages can be
 * taken, the effect fails with the queue's terminal error.
 *
 * **Example** (Taking a fixed number of values)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(10)
 *
 *   // Add several messages
 *   yield* Queue.offerAll(queue, [1, 2, 3, 4, 5, 6, 7])
 *
 *   // Take exactly 3 messages
 *   const first3 = yield* Queue.takeN(queue, 3)
 *   console.log(first3) // [1, 2, 3]
 *
 *   // Take exactly 2 more messages
 *   const next2 = yield* Queue.takeN(queue, 2)
 *   console.log(next2) // [4, 5]
 *
 *   // Take remaining messages
 *   const remaining = yield* Queue.takeN(queue, 2)
 *   console.log(remaining) // [6, 7]
 * })
 * ```
 *
 * @category Taking
 * @since 2.0.0
 */
export const takeN = <A, E>(
  self: Dequeue<A, E>,
  n: number
): Effect<Array<A>, E> => takeBetween(self, n, n)

/**
 * Takes between `min` and `max` messages from the queue.
 *
 * **Details**
 *
 * The operation waits when fewer than the required minimum messages are
 * available. It returns at most `max` messages. If the queue completes or fails
 * before the minimum can be satisfied, the effect fails with the queue's
 * terminal error.
 *
 * **Example** (Taking a bounded batch of values)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number>(10)
 *
 *   // Add several messages
 *   yield* Queue.offerAll(queue, [1, 2, 3, 4, 5, 6, 7, 8])
 *
 *   // Take between 2 and 5 messages
 *   const batch1 = yield* Queue.takeBetween(queue, 2, 5)
 *   console.log(batch1) // [1, 2, 3, 4, 5] - took 5 (up to max)
 *
 *   // Take between 1 and 10 messages (but only 3 remain)
 *   const batch2 = yield* Queue.takeBetween(queue, 1, 10)
 *   console.log(batch2) // [6, 7, 8] - took 3 (all remaining)
 *
 *   // No more messages available, will wait or return done
 *   // const batch3 = yield* Queue.takeBetween(queue, 1, 3)
 * })
 * ```
 *
 * @category Taking
 * @since 2.0.0
 */
export const takeBetween = <A, E>(
  self: Dequeue<A, E>,
  min: number,
  max: number
): Effect<Array<A>, E> =>
  internalEffect.suspend(() =>
    takeBetweenUnsafe(self, min, max) ?? internalEffect.andThen(awaitTake(self), takeBetween(self, 1, max))
  )

/**
 * Takes a single message from the queue, or wait for a message to be
 * available.
 *
 * **Details**
 *
 * If the queue is done, it will fail with `Done`. If the
 * queue fails, the Effect will fail with the error.
 *
 * **Example** (Taking one value)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<string, Cause.Done>(3)
 *
 *   // Add some messages
 *   yield* Queue.offer(queue, "first")
 *   yield* Queue.offer(queue, "second")
 *
 *   // Take messages one by one
 *   const msg1 = yield* Queue.take(queue)
 *   const msg2 = yield* Queue.take(queue)
 *   console.log(msg1, msg2) // "first", "second"
 *
 *   // End the queue
 *   yield* Queue.end(queue)
 *
 *   // Taking from an ended queue fails with Done
 *   const result = yield* Effect.match(Queue.take(queue), {
 *     onFailure: (error: Cause.Done) => true,
 *     onSuccess: (value: string) => false
 *   })
 *   console.log("Queue ended:", result) // true
 * })
 * ```
 *
 * @category Taking
 * @since 2.0.0
 */
export const take = <A, E>(self: Dequeue<A, E>): Effect<A, E> =>
  internalEffect.suspend(
    () => takeUnsafe(self) ?? internalEffect.andThen(awaitTake(self), take(self))
  )

/**
 * Attempts to take one item from the queue without waiting.
 *
 * **Details**
 *
 * Returns `Option.some` when an item is immediately available. Returns
 * `Option.none` when no item is available, when the queue is done, or when the
 * immediate take observes a queue failure.
 *
 * **Example** (Polling without blocking)
 *
 * ```ts
 * import { Effect, Option, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number>(10)
 *
 *   // Poll returns Option.none if empty
 *   const maybe1 = yield* Queue.poll(queue)
 *   console.log(Option.isNone(maybe1)) // true
 *
 *   // Add an item
 *   yield* Queue.offer(queue, 42)
 *
 *   // Poll returns Option.some with the item
 *   const maybe2 = yield* Queue.poll(queue)
 *   console.log(Option.getOrNull(maybe2)) // 42
 * })
 * ```
 *
 * @category Taking
 * @since 2.0.0
 */
export const poll = <A, E>(self: Dequeue<A, E>): Effect<Option.Option<A>> =>
  internalEffect.suspend(() => {
    const result = takeUnsafe(self)
    if (result === undefined) {
      return internalEffect.succeed(Option.none())
    }
    if (result._tag === "Success") {
      return internalEffect.succeed(Option.some(result.value))
    }
    return internalEffect.succeed(Option.none())
  })

/**
 * Peeks at the next item without removing it.
 *
 * **Details**
 *
 * Blocks until an item is available. If the queue is done or fails, the error is propagated.
 *
 * **Example** (Peeking at the next value)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number>(10)
 *   yield* Queue.offer(queue, 42)
 *
 *   // Peek at the next item without removing it
 *   const item = yield* Queue.peek(queue)
 *   console.log(item) // 42
 * })
 * ```
 *
 * @category taking
 * @since 4.0.0
 */
export const peek = <A, E>(self: Dequeue<A, E>): Effect<A, E> =>
  internalEffect.suspend(() => {
    if (self.state._tag === "Done") {
      return self.state.exit
    }
    if (self.messages.length > 0 && self.messages.head) {
      return internalEffect.succeed(self.messages.head.array[self.messages.head.offset])
    }
    return internalEffect.andThen(awaitTake(self), peek(self))
  })

/**
 * Attempts to take one message from the queue synchronously.
 *
 * **Details**
 *
 * Returns an `Exit` for an immediately available message or for the queue's
 * terminal state. Returns `undefined` when no message is immediately available.
 * This operation does not wait or register a taker.
 *
 * **Example** (Taking one value synchronously)
 *
 * ```ts
 * import { Effect, Queue } from "effect"
 *
 * // Create a queue and use unsafe operations
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number>(10)
 *
 *   // Add some messages
 *   Queue.offerUnsafe(queue, 1)
 *   Queue.offerUnsafe(queue, 2)
 *
 *   // Take a message synchronously
 *   const result1 = Queue.takeUnsafe(queue)
 *   console.log(result1) // Success(1) or Exit containing value 1
 *
 *   const result2 = Queue.takeUnsafe(queue)
 *   console.log(result2) // Success(2)
 *
 *   // No more messages - returns undefined
 *   const result3 = Queue.takeUnsafe(queue)
 *   console.log(result3) // undefined
 * })
 * ```
 *
 * @category Taking
 * @since 4.0.0
 */
export const takeUnsafe = <A, E>(self: Dequeue<A, E>): Exit<A, E> | undefined => {
  if (self.state._tag === "Done") {
    return self.state.exit
  }
  if (self.messages.length > 0) {
    const message = MutableList.take(self.messages)!
    releaseCapacity(self)
    return core.exitSucceed(message)
  } else if (self.capacity <= 0 && self.state.offers.size > 0) {
    self.capacity = 1
    releaseCapacity(self)
    self.capacity = 0
    const message = MutableList.take(self.messages)!
    releaseCapacity(self)
    return core.exitSucceed(message)
  }
  return undefined
}

const await_ = <A, E>(self: Dequeue<A, E>): Effect<void, Exclude<E, Done>> =>
  internalEffect.callback<void, Exclude<E, Done>>((resume) => {
    if (self.state._tag === "Done") {
      if (Pull.isDoneCause(self.state.exit.cause)) {
        return resume(internalEffect.exitVoid)
      }
      return resume(self.state.exit)
    }
    self.state.awaiters.add(resume)
    return internalEffect.sync(() => {
      if (self.state._tag !== "Done") {
        self.state.awaiters.delete(resume)
      }
    })
  })

export {
  /**
   * Waits until a queue reaches the `Done` state.
   *
   * **When to use**
   *
   * Use to suspend a fiber until no further values can be taken from the queue
   * and its terminal outcome is known.
   *
   * **Details**
   *
   * The effect succeeds with `void` for normal `Done` completion. Other
   * terminal causes are preserved, so failures and interruptions complete this
   * effect with the same terminal outcome.
   *
   * **Gotchas**
   *
   * A queue can be closing before it is done. `await` resumes at `Done`, not at
   * the first completion signal, so buffered messages may need to be drained
   * first.
   *
   * @see {@link end} for signaling normal completion while preserving buffered messages for consumers
   * @see {@link fail} for signaling an error while preserving buffered messages for consumers
   * @see {@link interrupt} for graceful interruption after buffered messages are drained
   * @see {@link shutdown} for immediately discarding buffered messages and resuming pending operations
   *
   * @category Completion
   * @since 4.0.0
   */
  await_ as await
}

/**
 * Returns the current number of buffered messages in the queue.
 *
 * **Details**
 *
 * Completed queues report a size of `0`.
 *
 * **Example** (Checking queue size)
 *
 * ```ts
 * import { Cause, Effect, Option, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(10)
 *
 *   // Check size of empty queue
 *   const size1 = yield* Queue.size(queue)
 *   console.log(size1) // 0
 *
 *   // Add some messages
 *   yield* Queue.offerAll(queue, [1, 2, 3, 4, 5])
 *
 *   // Check size after adding messages
 *   const size2 = yield* Queue.size(queue)
 *   console.log(size2) // 5
 *
 *   // End the queue
 *   yield* Queue.end(queue)
 *
 *   // Size of ended queue is 0
 *   const size3 = yield* Queue.size(queue)
 *   console.log(size3) // 0
 * })
 * ```
 *
 * @category Size
 * @since 2.0.0
 */
export const size = <A, E>(self: Dequeue<A, E>): Effect<number> => internalEffect.sync(() => sizeUnsafe(self))

/**
 * Checks whether the queue is full.
 *
 * **Example** (Checking if queues are full)
 *
 * ```ts
 * import { Cause, Effect, Option, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(3)
 *
 *   console.log(yield* Queue.isFull(queue)) // false
 *
 *   // Add some messages
 *   yield* Queue.offerAll(queue, [1, 2, 3])
 *
 *   console.log(yield* Queue.isFull(queue)) // true
 * })
 * ```
 *
 * @category Size
 * @since 2.0.0
 */
export const isFull = <A, E>(self: Dequeue<A, E>): Effect<boolean> => internalEffect.sync(() => isFullUnsafe(self))

/**
 * Returns the current number of buffered messages in the queue synchronously.
 *
 * **Details**
 *
 * Completed queues report a size of `0`. This unsafe operation reads the queue
 * state directly without Effect wrapping.
 *
 * **Example** (Checking queue size synchronously)
 *
 * ```ts
 * import { Cause, Effect, Option, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(10)
 *
 *   // Check size of empty queue
 *   const size1 = Queue.sizeUnsafe(queue)
 *   console.log(size1) // 0
 *
 *   // Add some messages
 *   Queue.offerUnsafe(queue, 1)
 *   Queue.offerUnsafe(queue, 2)
 *   Queue.offerUnsafe(queue, 3)
 *
 *   // Check size after adding messages
 *   const size2 = Queue.sizeUnsafe(queue)
 *   console.log(size2) // 3
 *
 *   // End the queue
 *   Queue.endUnsafe(queue)
 *
 *   // Size of ended queue is 0
 *   const size3 = Queue.sizeUnsafe(queue)
 *   console.log(size3) // 0
 * })
 * ```
 *
 * @category Size
 * @since 4.0.0
 */
export const sizeUnsafe = <A, E>(self: Dequeue<A, E>): number => self.state._tag === "Done" ? 0 : self.messages.length

/**
 * Checks whether the queue is full synchronously.
 *
 * **Example** (Checking fullness synchronously)
 *
 * ```ts
 * import { Cause, Effect, Option, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(3)
 *
 *   console.log(Queue.isFullUnsafe(queue)) // false
 *
 *   // Add some messages
 *   yield* Queue.offerAll(queue, [1, 2, 3])
 *
 *   console.log(Queue.isFullUnsafe(queue)) // true
 * })
 * ```
 *
 * @category Size
 * @since 4.0.0
 */
export const isFullUnsafe = <A, E>(self: Dequeue<A, E>): boolean => sizeUnsafe(self) === self.capacity

/**
 * Runs an `Effect` into a `Queue`, where success ends the queue and failure
 * fails the queue.
 *
 * **Example** (Running effects into queues)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(10)
 *
 *   // Create an effect that succeeds
 *   const dataProcessing = Effect.gen(function*() {
 *     yield* Effect.sleep("100 millis")
 *     return "Processing completed successfully"
 *   })
 *
 *   // Pipe the effect into the queue
 *   // If dataProcessing succeeds, queue ends successfully
 *   // If dataProcessing fails, queue fails with the error
 *   const effectIntoQueue = Queue.into(queue)(dataProcessing)
 *
 *   const wasCompleted = yield* effectIntoQueue
 *   console.log("Queue operation completed:", wasCompleted) // true
 *
 *   // Queue state now reflects the effect's outcome
 *   console.log("Queue state:", queue.state._tag) // "Done"
 * })
 * ```
 *
 * @category Completion
 * @since 4.0.0
 */
export const into: {
  <A, E>(
    self: Enqueue<A, E | Done>
  ): <AX, EX extends E, RX>(
    effect: Effect<AX, EX, RX>
  ) => Effect<boolean, never, RX>
  <AX, E, EX extends E, RX, A>(
    effect: Effect<AX, EX, RX>,
    self: Enqueue<A, E | Done>
  ): Effect<boolean, never, RX>
} = dual(
  2,
  <AX, E, EX extends E, RX, A>(
    effect: Effect<AX, EX, RX>,
    self: Enqueue<A, E | Done>
  ): Effect<boolean, never, RX> =>
    internalEffect.uninterruptibleMask((restore) =>
      internalEffect.matchCauseEffect(restore(effect), {
        onFailure: (cause) => failCause(self, cause),
        onSuccess: (_) => end(self)
      })
    )
)

// -----------------------------------------------------------------------------
// internals
// -----------------------------------------------------------------------------
//

const exitFalse = core.exitSucceed(false)
const exitTrue = core.exitSucceed(true)
const exitFailDone = core.exitFail(core.Done()) as Failure<never, Done>
const exitInterrupt = internalEffect.exitInterrupt() as Failure<never, never>

const releaseTakers = <A, E>(self: Enqueue<A, E>) => {
  self.scheduleRunning = false
  if (self.state._tag === "Done" || self.state.takers.size === 0) {
    return
  }
  for (const taker of self.state.takers) {
    self.state.takers.delete(taker)
    taker(internalEffect.exitVoid)
    if (self.messages.length === 0) {
      break
    }
  }
}

const scheduleReleaseTaker = <A, E>(self: Enqueue<A, E>) => {
  if (self.scheduleRunning || self.state._tag === "Done" || self.state.takers.size === 0) {
    return
  }
  self.scheduleRunning = true
  self.dispatcher.scheduleTask(() => releaseTakers(self), 0)
}

const takeBetweenUnsafe = <A, E>(
  self: Dequeue<A, E>,
  min: number,
  max: number
): Exit<Array<A>, E> | undefined => {
  if (self.state._tag === "Done") {
    return self.state.exit
  } else if (max <= 0 || min <= 0) {
    return core.exitSucceed([])
  } else if (self.capacity <= 0 && self.state.offers.size > 0) {
    self.capacity = 1
    releaseCapacity(self)
    self.capacity = 0
    const messages = [MutableList.take(self.messages)!]
    releaseCapacity(self)
    return core.exitSucceed(messages)
  }
  min = Math.min(min, self.capacity || 1)
  if (min <= self.messages.length) {
    const messages = MutableList.takeN(self.messages, max)
    releaseCapacity(self)
    return core.exitSucceed(messages)
  }
}

const offerRemainingSingle = <A, E>(self: Enqueue<A, E>, message: A) => {
  return internalEffect.callback<boolean>((resume) => {
    if (self.state._tag !== "Open") {
      return resume(exitFalse)
    }
    const entry: Queue.OfferEntry<A> = { _tag: "Single", message, resume }
    self.state.offers.add(entry)
    return internalEffect.sync(() => {
      if (self.state._tag === "Open") {
        self.state.offers.delete(entry)
      }
    })
  })
}

const offerRemainingArray = <A, E>(self: Enqueue<A, E>, remaining: Array<A>) => {
  return internalEffect.callback<Array<A>>((resume) => {
    if (self.state._tag !== "Open") {
      return resume(core.exitSucceed(remaining))
    }
    const entry: Queue.OfferEntry<A> = {
      _tag: "Array",
      remaining,
      offset: 0,
      resume
    }
    self.state.offers.add(entry)
    return internalEffect.sync(() => {
      if (self.state._tag === "Open") {
        self.state.offers.delete(entry)
      }
    })
  })
}

const releaseCapacity = <A, E>(self: Dequeue<A, E>): boolean => {
  if (self.state._tag === "Done") {
    return Pull.isDoneCause(self.state.exit.cause)
  } else if (self.state.offers.size === 0) {
    if (
      self.state._tag === "Closing" &&
      self.messages.length === 0
    ) {
      finalize(self, self.state.exit)
      return Pull.isDoneCause(self.state.exit.cause)
    }
    return false
  }
  let n = self.capacity - self.messages.length
  for (const entry of self.state.offers) {
    if (n === 0) break
    else if (entry._tag === "Single") {
      MutableList.append(self.messages, entry.message)
      n--
      entry.resume(exitTrue)
      self.state.offers.delete(entry)
    } else {
      for (; entry.offset < entry.remaining.length; entry.offset++) {
        if (n === 0) return false
        MutableList.append(self.messages, entry.remaining[entry.offset])
        n--
      }
      entry.resume(core.exitSucceed([]))
      self.state.offers.delete(entry)
    }
  }
  return false
}

const awaitTake = <A, E>(self: Dequeue<A, E>) =>
  internalEffect.callback<void, E>((resume) => {
    if (self.state._tag === "Done") {
      return resume(self.state.exit)
    }
    self.state.takers.add(resume)
    return internalEffect.sync(() => {
      if (self.state._tag !== "Done") {
        self.state.takers.delete(resume)
      }
    })
  })

const takeAllUnsafe = <A, E>(self: Dequeue<A, E>) => {
  if (self.messages.length > 0) {
    const messages = MutableList.takeAll(self.messages)
    releaseCapacity(self)
    return messages
  } else if (self.state._tag !== "Done" && self.state.offers.size > 0) {
    self.capacity = 1
    releaseCapacity(self)
    self.capacity = 0
    const messages = [MutableList.take(self.messages)!]
    releaseCapacity(self)
    return messages
  }
  return []
}

const finalize = <A, E>(self: Enqueue<A, E> | Dequeue<A, E>, exit: Failure<never, E>) => {
  if (self.state._tag === "Done") {
    return
  }
  const openState = self.state
  self.state = { _tag: "Done", exit }
  for (const taker of openState.takers) {
    taker(exit)
  }
  openState.takers.clear()
  for (const awaiter of openState.awaiters) {
    awaiter(exit)
  }
  openState.awaiters.clear()
}
