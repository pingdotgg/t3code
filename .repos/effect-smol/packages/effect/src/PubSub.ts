/**
 * Broadcasts values from publishers to many subscribers.
 *
 * Publishers add messages with `publish` or `publishAll`, and each active
 * `Subscription` receives its own copy of every accepted message. Unlike a
 * queue, subscribers do not compete for messages. This module includes bounded,
 * dropping, sliding, and unbounded hubs, optional replay buffers for late
 * subscribers, message-taking helpers, capacity and shutdown operations, and
 * low-level types for custom hub strategies.
 *
 * @since 2.0.0
 */
import * as Arr from "./Array.ts"
import * as Context from "./Context.ts"
import * as Deferred from "./Deferred.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import type { LazyArg } from "./Function.ts"
import { dual, identity } from "./Function.ts"
import * as Latch from "./Latch.ts"
import * as MutableList from "./MutableList.ts"
import * as MutableRef from "./MutableRef.ts"
import { nextPow2 } from "./Number.ts"
import * as Option from "./Option.ts"
import { type Pipeable, pipeArguments } from "./Pipeable.ts"
import * as Scope from "./Scope.ts"
import type { Covariant, Invariant } from "./Types.ts"

const TypeId = "~effect/PubSub"

/**
 * A `PubSub<A>` is an asynchronous message hub into which publishers can publish
 * messages of type `A` and subscribers can subscribe to take messages of type
 * `A`.
 *
 * **Example** (Publishing and subscribing to messages)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a bounded PubSub with capacity 10
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   // Subscribe and consume messages
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Publish messages
 *     yield* PubSub.publish(pubsub, "Hello")
 *     yield* PubSub.publish(pubsub, "World")
 *
 *     const message1 = yield* PubSub.take(subscription)
 *     const message2 = yield* PubSub.take(subscription)
 *     console.log(message1, message2) // "Hello", "World"
 *   }))
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface PubSub<in out A> extends Pipeable {
  readonly [TypeId]: {
    readonly _A: Invariant<A>
  }
  readonly pubsub: PubSub.Atomic<A>
  readonly subscribers: PubSub.Subscribers<A>
  readonly scope: Scope.Closeable
  readonly shutdownHook: Latch.Latch
  readonly shutdownFlag: MutableRef.MutableRef<boolean>
  readonly strategy: PubSub.Strategy<A>
}

/**
 * Companion namespace containing the low-level building blocks used by
 * `PubSub`, including atomic implementations, backing subscriptions, replay
 * windows, and delivery strategies.
 *
 * @since 2.0.0
 */
export declare namespace PubSub {
  /**
   * Low-level atomic PubSub interface that handles the core message storage and retrieval.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Atomic<in out A> {
    readonly capacity: number
    isEmpty(): boolean
    isFull(): boolean
    size(): number
    publish(value: A): boolean
    publishAll(elements: Iterable<A>): Array<A>
    slide(): void
    subscribe(): BackingSubscription<A>
    replayWindow(): ReplayWindow<A>
  }

  /**
   * Low-level subscription interface that handles message polling for individual subscribers.
   *
   * @category models
   * @since 4.0.0
   */
  export interface BackingSubscription<out A> {
    isEmpty(): boolean
    size(): number
    poll(): A | MutableList.Empty
    pollUpTo(n: number): Array<A>
    unsubscribe(): void
  }

  /**
   * Tracks the pollers currently waiting on each backing subscription.
   *
   * **Details**
   *
   * This type is part of the low-level `PubSub.Strategy` contract. Most
   * application code should use `subscribe`, `take`, and the other `PubSub`
   * operations instead of manipulating subscriber maps directly.
   *
   * @category models
   * @since 4.0.0
   */
  export type Subscribers<A> = Map<
    BackingSubscription<A>,
    Set<MutableList.MutableList<Deferred.Deferred<A>>>
  >

  /**
   * Interface for accessing replay buffer contents for late subscribers.
   *
   * @category models
   * @since 4.0.0
   */
  export interface ReplayWindow<A> {
    take(): A | undefined
    takeN(n: number): Array<A>
    takeAll(): Array<A>
    readonly remaining: number
  }

  /**
   * Strategy interface defining how PubSub handles backpressure and message distribution.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Strategy<in out A> {
    /**
     * Describes any finalization logic associated with this strategy.
     */
    readonly shutdown: Effect.Effect<void>

    /**
     * Describes how publishers should signal to subscribers that they are
     * waiting for space to become available in the `PubSub`.
     */
    handleSurplus(
      pubsub: Atomic<A>,
      subscribers: Subscribers<A>,
      elements: Iterable<A>,
      isShutdown: MutableRef.MutableRef<boolean>
    ): Effect.Effect<boolean>

    /**
     * Describes how subscribers should signal to publishers waiting for space
     * to become available in the `PubSub` that space may be available.
     */
    onPubSubEmptySpaceUnsafe(
      pubsub: Atomic<A>,
      subscribers: Subscribers<A>
    ): void

    /**
     * Describes how subscribers waiting for additional values from the `PubSub`
     * should take those values and signal to publishers that they are no
     * longer waiting for additional values.
     */
    completePollersUnsafe(
      pubsub: Atomic<A>,
      subscribers: Subscribers<A>,
      subscription: BackingSubscription<A>,
      pollers: MutableList.MutableList<Deferred.Deferred<A>>
    ): void

    /**
     * Describes how publishers should signal to subscribers waiting for
     * additional values from the `PubSub` that new values are available.
     */
    completeSubscribersUnsafe(
      pubsub: Atomic<A>,
      subscribers: Subscribers<A>
    ): void
  }
}

const SubscriptionTypeId = "~effect/PubSub/Subscription"

/**
 * A subscription represents a consumer's connection to a PubSub, allowing them to take messages.
 *
 * **Example** (Taking messages from a subscription)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   // Subscribe within a scope for automatic cleanup
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription: PubSub.Subscription<string> = yield* PubSub.subscribe(
 *       pubsub
 *     )
 *
 *     yield* PubSub.publishAll(pubsub, ["msg1", "msg2", "msg3"])
 *
 *     // Take individual messages
 *     const message = yield* PubSub.take(subscription)
 *     console.log(message) // "msg1"
 *
 *     // Take multiple messages
 *     const messages = yield* PubSub.takeUpTo(subscription, 1)
 *     console.log(messages) // ["msg2"]
 *     const allMessages = yield* PubSub.takeAll(subscription)
 *     console.log(allMessages) // ["msg3"]
 *   }))
 * })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface Subscription<out A> extends Pipeable {
  readonly [SubscriptionTypeId]: {
    readonly _A: Covariant<A>
  }
  readonly pubsub: PubSub.Atomic<any>
  readonly subscribers: PubSub.Subscribers<any>
  readonly subscription: PubSub.BackingSubscription<A>
  readonly pollers: MutableList.MutableList<Deferred.Deferred<any>>
  readonly shutdownHook: Latch.Latch
  readonly shutdownFlag: MutableRef.MutableRef<boolean>
  readonly strategy: PubSub.Strategy<any>
  readonly replayWindow: PubSub.ReplayWindow<A>
}

/**
 * Creates a PubSub with a custom atomic implementation and strategy.
 *
 * **Example** (Creating a PubSub with a custom strategy)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create custom PubSub with specific atomic implementation and strategy
 *   const pubsub = yield* PubSub.make<string>({
 *     atomicPubSub: () => PubSub.makeAtomicBounded(100),
 *     strategy: () => new PubSub.BackPressureStrategy()
 *   })
 *
 *   // Use the created PubSub
 *   yield* PubSub.publish(pubsub, "Hello")
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <A>(
  options: {
    readonly atomicPubSub: LazyArg<PubSub.Atomic<A>>
    readonly strategy: LazyArg<PubSub.Strategy<A>>
  }
): Effect.Effect<PubSub<A>> =>
  Effect.sync(() =>
    makePubSubUnsafe(
      options.atomicPubSub(),
      new Map(),
      Scope.makeUnsafe(),
      Latch.makeUnsafe(false),
      MutableRef.make(false),
      options.strategy()
    )
  )

/**
 * Creates a bounded `PubSub` that applies backpressure when it reaches
 * capacity.
 *
 * **Details**
 *
 * Published messages are retained until all current subscribers have taken
 * them. When the capacity is full, publishers suspend until space is available.
 * Pass an options object to configure both `capacity` and an optional replay
 * buffer for late subscribers.
 *
 * **Example** (Creating a bounded PubSub)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create bounded PubSub with capacity 100
 *   const pubsub = yield* PubSub.bounded<string>(100)
 *
 *   // Create with replay buffer for late subscribers
 *   const pubsubWithReplay = yield* PubSub.bounded<string>({
 *     capacity: 100,
 *     replay: 10 // Last 10 messages replayed to new subscribers
 *   })
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const bounded = <A>(
  capacity: number | {
    readonly capacity: number
    readonly replay?: number | undefined
  }
): Effect.Effect<PubSub<A>> =>
  make({
    atomicPubSub: () => makeAtomicBounded(capacity),
    strategy: () => new BackPressureStrategy()
  })

/**
 * Creates a bounded `PubSub` with the dropping strategy. The `PubSub` will drop new
 * messages if the `PubSub` is at capacity.
 *
 * **Details**
 *
 * For best performance use capacities that are powers of two.
 *
 * **Example** (Dropping messages when full)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create dropping PubSub that drops new messages when full
 *   const pubsub = yield* PubSub.dropping<string>(3)
 *
 *   // With replay buffer for late subscribers
 *   const pubsubWithReplay = yield* PubSub.dropping<string>({
 *     capacity: 3,
 *     replay: 5
 *   })
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Fill the PubSub and see dropping behavior
 *     yield* PubSub.publish(pubsub, "msg1") // succeeds
 *     yield* PubSub.publish(pubsub, "msg2") // succeeds
 *     yield* PubSub.publish(pubsub, "msg3") // succeeds
 *     const dropped = yield* PubSub.publish(pubsub, "msg4") // returns false (dropped)
 *     console.log("Message dropped:", !dropped) // true
 *
 *     const messages = yield* PubSub.takeAll(subscription)
 *     console.log(messages) // ["msg1", "msg2", "msg3"]
 *   }))
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const dropping = <A>(
  capacity: number | {
    readonly capacity: number
    readonly replay?: number | undefined
  }
): Effect.Effect<PubSub<A>> =>
  make({
    atomicPubSub: () => makeAtomicBounded(capacity),
    strategy: () => new DroppingStrategy()
  })

/**
 * Creates a bounded `PubSub` with the sliding strategy. The `PubSub` will add new
 * messages and drop old messages if the `PubSub` is at capacity.
 *
 * **Details**
 *
 * For best performance use capacities that are powers of two.
 *
 * **Example** (Sliding old messages when full)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create sliding PubSub that evicts old messages when full
 *   const pubsub = yield* PubSub.sliding<string>(3)
 *
 *   // With replay buffer
 *   const pubsubWithReplay = yield* PubSub.sliding<string>({
 *     capacity: 3,
 *     replay: 2
 *   })
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Fill and overflow the PubSub
 *     yield* PubSub.publish(pubsub, "msg1")
 *     yield* PubSub.publish(pubsub, "msg2")
 *     yield* PubSub.publish(pubsub, "msg3")
 *     yield* PubSub.publish(pubsub, "msg4") // "msg1" is evicted
 *
 *     const messages = yield* PubSub.takeAll(subscription)
 *     console.log(messages) // ["msg2", "msg3", "msg4"]
 *   }))
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const sliding = <A>(
  capacity: number | {
    readonly capacity: number
    readonly replay?: number | undefined
  }
): Effect.Effect<PubSub<A>> =>
  make({
    atomicPubSub: () => makeAtomicBounded(capacity),
    strategy: () => new SlidingStrategy()
  })

/**
 * Creates an unbounded `PubSub`.
 *
 * **Example** (Creating an unbounded PubSub)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create unbounded PubSub
 *   const pubsub = yield* PubSub.unbounded<string>()
 *
 *   // With replay buffer for late subscribers
 *   const pubsubWithReplay = yield* PubSub.unbounded<string>({
 *     replay: 10
 *   })
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Can publish unlimited messages
 *     for (let i = 0; i < 3; i++) {
 *       yield* PubSub.publish(pubsub, `message-${i}`)
 *     }
 *
 *     const message = yield* PubSub.take(subscription)
 *     console.log("First message:", message) // "message-0"
 *   }))
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const unbounded = <A>(options?: {
  readonly replay?: number | undefined
}): Effect.Effect<PubSub<A>> =>
  make({
    atomicPubSub: () => makeAtomicUnbounded(options),
    strategy: () => new DroppingStrategy()
  })

/**
 * Creates a bounded atomic PubSub implementation with optional replay buffer.
 *
 * **When to use**
 *
 * Use to provide bounded message storage when building a custom `PubSub` with
 * `make` and an explicit delivery strategy.
 *
 * **Details**
 *
 * Pass either a capacity number or an options object with `capacity` and
 * optional `replay`. A positive `replay` value enables a replay buffer for late
 * subscribers, and fractional replay sizes are rounded up.
 *
 * **Gotchas**
 *
 * The capacity must be greater than zero; invalid capacities throw
 * synchronously before an atomic implementation is created.
 *
 * @see {@link make} for constructing a `PubSub` from an atomic implementation and delivery strategy
 * @see {@link makeAtomicUnbounded} for an atomic implementation without a bounded capacity
 * @see {@link bounded} for the higher-level backpressure constructor
 * @see {@link dropping} for the higher-level dropping constructor
 * @see {@link sliding} for the higher-level sliding constructor
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeAtomicBounded = <A>(
  capacity: number | {
    readonly capacity: number
    readonly replay?: number | undefined
  }
): PubSub.Atomic<A> => {
  const options = typeof capacity === "number" ? { capacity } : capacity
  ensureCapacity(options.capacity)
  const replayBuffer = options.replay && options.replay > 0 ? new ReplayBuffer<A>(Math.ceil(options.replay)) : undefined
  if (options.capacity === 1) {
    return new BoundedPubSubSingle(replayBuffer)
  } else if (nextPow2(options.capacity) === options.capacity) {
    return new BoundedPubSubPow2(options.capacity, replayBuffer)
  } else {
    return new BoundedPubSubArb(options.capacity, replayBuffer)
  }
}

/**
 * Creates an unbounded atomic PubSub implementation with optional replay buffer.
 *
 * **When to use**
 *
 * Use to create the low-level storage layer for a custom `PubSub` whose active
 * subscribers may retain an unbounded number of pending messages.
 *
 * **Gotchas**
 *
 * Messages published while subscribers are active can be retained without a
 * capacity limit until those subscribers take them or unsubscribe.
 *
 * @see {@link makeAtomicBounded} for a bounded atomic implementation that enforces capacity
 * @see {@link make} for wrapping an atomic implementation with a delivery strategy
 * @see {@link unbounded} for the high-level effectful constructor for unbounded `PubSub` values
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeAtomicUnbounded = <A>(options?: {
  readonly replay?: number | undefined
}): PubSub.Atomic<A> => new UnboundedPubSub(options?.replay ? new ReplayBuffer(options.replay) : undefined)

/**
 *  Returns the number of elements the queue can hold.
 *
 * **Example** (Getting PubSub capacity)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(100)
 *   const cap = PubSub.capacity(pubsub)
 *   console.log("PubSub capacity:", cap) // 100
 *
 *   const unboundedPubsub = yield* PubSub.unbounded<string>()
 *   const unboundedCap = PubSub.capacity(unboundedPubsub)
 *   console.log("Unbounded capacity:", unboundedCap) // Number.MAX_SAFE_INTEGER
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const capacity = <A>(self: PubSub<A>): number => self.pubsub.capacity

/**
 * Returns the current number of messages retained by the `PubSub` for active
 * subscribers.
 *
 * **Details**
 *
 * If the `PubSub` has been shut down, the returned effect succeeds with `0`.
 * The size is not a count of waiting subscribers or suspended publishers.
 *
 * **Example** (Getting PubSub size)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   // Initially empty
 *   const initialSize = yield* PubSub.size(pubsub)
 *   console.log("Initial size:", initialSize) // 0
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Publish some messages for the active subscription
 *     yield* PubSub.publish(pubsub, "msg1")
 *     yield* PubSub.publish(pubsub, "msg2")
 *
 *     const afterPublish = yield* PubSub.size(pubsub)
 *     console.log("After publishing:", afterPublish) // 2
 *
 *     yield* PubSub.takeAll(subscription)
 *   }))
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const size = <A>(self: PubSub<A>): Effect.Effect<number> => Effect.sync(() => sizeUnsafe(self))
/**
 * Returns the current number of messages retained by the `PubSub` for active
 * subscribers synchronously.
 *
 * **When to use**
 *
 * Use when an immediate `PubSub` size snapshot is needed outside effectful code
 * and concurrent changes between the check and later use are acceptable.
 *
 * **Details**
 *
 * Returns `0` after shutdown. Because this is an unsafe synchronous snapshot,
 * prefer `size` in effectful code.
 *
 * **Example** (Reading size synchronously)
 *
 * ```ts
 * import { PubSub } from "effect"
 *
 * // Unsafe synchronous size check
 * declare const pubsub: PubSub.PubSub<string>
 *
 * const size = PubSub.sizeUnsafe(pubsub)
 * console.log("Current size:", size)
 * ```
 *
 * @category getters
 * @since 4.0.0
 */
export const sizeUnsafe = <A>(self: PubSub<A>): number => {
  if (MutableRef.get(self.shutdownFlag)) {
    return 0
  }
  return self.pubsub.size()
}

/**
 * Returns `true` when the `PubSub` has reached its configured capacity.
 *
 * **Details**
 *
 * For unbounded PubSubs this is normally `false`.
 *
 * **Example** (Checking whether a PubSub is full)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(2)
 *
 *   // Initially not full
 *   const initiallyFull = yield* PubSub.isFull(pubsub)
 *   console.log("Initially full:", initiallyFull) // false
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Fill the PubSub for the active subscription
 *     yield* PubSub.publish(pubsub, "msg1")
 *     yield* PubSub.publish(pubsub, "msg2")
 *
 *     const nowFull = yield* PubSub.isFull(pubsub)
 *     console.log("Now full:", nowFull) // true
 *
 *     yield* PubSub.takeAll(subscription)
 *   }))
 * })
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const isFull = <A>(self: PubSub<A>): Effect.Effect<boolean> =>
  Effect.map(size(self), (size) => size === self.pubsub.capacity)

/**
 * Returns `true` if the `Pubsub` contains zero elements, `false` otherwise.
 *
 * **Example** (Checking whether a PubSub is empty)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   // Initially empty
 *   const initiallyEmpty = yield* PubSub.isEmpty(pubsub)
 *   console.log("Initially empty:", initiallyEmpty) // true
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Publish a message for the active subscription
 *     yield* PubSub.publish(pubsub, "Hello")
 *
 *     const nowEmpty = yield* PubSub.isEmpty(pubsub)
 *     console.log("Now empty:", nowEmpty) // false
 *
 *     yield* PubSub.take(subscription)
 *   }))
 * })
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const isEmpty = <A>(self: PubSub<A>): Effect.Effect<boolean> => Effect.map(size(self), (size) => size === 0)

/**
 * Shuts down the `PubSub`, interrupting suspended publishers and subscribers
 * and finalizing active subscriptions.
 *
 * **Details**
 *
 * After shutdown, `publish` and `publishAll` succeed with `false`,
 * `publishUnsafe` returns `false`, and subscription operations such as `take`
 * interrupt.
 *
 * **Example** (Shutting down a PubSub)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(1)
 *
 *   // Shutdown the PubSub
 *   yield* PubSub.shutdown(pubsub)
 *
 *   const isShutdown = yield* PubSub.isShutdown(pubsub)
 *   console.log("Is shutdown:", isShutdown) // true
 *
 *   // Publishing after shutdown returns false
 *   const published = yield* PubSub.publish(pubsub, "msg1")
 *   console.log("Published after shutdown:", published) // false
 * })
 * ```
 *
 * @category lifecycle
 * @since 2.0.0
 */
export const shutdown = <A>(self: PubSub<A>): Effect.Effect<void> =>
  Effect.uninterruptible(Effect.withFiber((fiber) => {
    MutableRef.set(self.shutdownFlag, true)
    return Scope.close(self.scope, Exit.interrupt(fiber.id)).pipe(
      Effect.andThen(self.strategy.shutdown),
      Effect.when(self.shutdownHook.open),
      Effect.asVoid
    )
  }))

/**
 * Checks effectfully whether `shutdown` has been called, returning `true`
 * after shutdown and `false` otherwise.
 *
 * **Example** (Checking whether a PubSub is shut down)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   // Initially not shutdown
 *   const initiallyShutdown = yield* PubSub.isShutdown(pubsub)
 *   console.log("Initially shutdown:", initiallyShutdown) // false
 *
 *   // Shutdown the PubSub
 *   yield* PubSub.shutdown(pubsub)
 *
 *   const nowShutdown = yield* PubSub.isShutdown(pubsub)
 *   console.log("Now shutdown:", nowShutdown) // true
 * })
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const isShutdown = <A>(self: PubSub<A>): Effect.Effect<boolean> => Effect.sync(() => isShutdownUnsafe(self))

/**
 * Checks synchronously whether `shutdown` has been called, returning `true`
 * after shutdown and `false` otherwise.
 *
 * **When to use**
 *
 * Use when an immediate `PubSub` shutdown-state snapshot is needed outside
 * effectful code and racing shutdown changes are acceptable.
 *
 * **Example** (Checking shutdown synchronously)
 *
 * ```ts
 * import { PubSub } from "effect"
 *
 * declare const pubsub: PubSub.PubSub<string>
 *
 * // Unsafe synchronous shutdown check
 * const isDown = PubSub.isShutdownUnsafe(pubsub)
 * if (isDown) {
 *   console.log("PubSub is shutdown, cannot publish")
 * } else {
 *   console.log("PubSub is active")
 * }
 * ```
 *
 * @category predicates
 * @since 4.0.0
 */
export const isShutdownUnsafe = <A>(self: PubSub<A>): boolean => self.shutdownFlag.current

/**
 * Waits until the queue is shutdown. The `Effect` returned by this method will
 * not resume until the queue has been shutdown. If the queue is already
 * shutdown, the `Effect` will resume right away.
 *
 * **Example** (Waiting for shutdown)
 *
 * ```ts
 * import { Effect, Fiber, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   // Start a fiber that waits for shutdown
 *   const waiterFiber = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* PubSub.awaitShutdown(pubsub)
 *       console.log("PubSub has been shutdown!")
 *     })
 *   )
 *
 *   // Do some work...
 *   yield* Effect.sleep("100 millis")
 *
 *   // Shutdown the PubSub
 *   yield* PubSub.shutdown(pubsub)
 *
 *   // The waiter will now complete
 *   yield* Fiber.join(waiterFiber)
 * })
 * ```
 *
 * @category lifecycle
 * @since 2.0.0
 */
export const awaitShutdown = <A>(self: PubSub<A>): Effect.Effect<void> => self.shutdownHook.await

/**
 * Publishes a message to the `PubSub` as an `Effect`, returning whether the
 * message was accepted.
 *
 * **When to use**
 *
 * Use when you need to publish from effectful code and let the configured
 * PubSub strategy handle surplus messages.
 *
 * **Details**
 *
 * The effect succeeds with `false` if the `PubSub` is shut down. If the message
 * cannot be accepted immediately, the configured strategy decides how surplus
 * messages are handled.
 *
 * **Example** (Publishing a message)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   // Publish a message
 *   const published = yield* PubSub.publish(pubsub, "Hello World")
 *   console.log("Message published:", published) // true
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     yield* PubSub.publish(pubsub, "Hello")
 *     const message = yield* PubSub.take(subscription)
 *     console.log("Received:", message) // "Hello"
 *   }))
 * })
 * ```
 *
 * @see {@link publishUnsafe} for a synchronous non-blocking attempt that does not run effectful surplus handling
 *
 * @category publishing
 * @since 2.0.0
 */
export const publish: {
  <A>(value: A): (self: PubSub<A>) => Effect.Effect<boolean>
  <A>(self: PubSub<A>, value: A): Effect.Effect<boolean>
} = dual(2, <A>(self: PubSub<A>, value: A): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    if (self.shutdownFlag.current) {
      return Effect.succeed(false)
    }

    if (self.pubsub.publish(value)) {
      self.strategy.completeSubscribersUnsafe(self.pubsub, self.subscribers)
      return Effect.succeed(true)
    }

    return self.strategy.handleSurplus(
      self.pubsub,
      self.subscribers,
      [value],
      self.shutdownFlag
    )
  }))

/**
 * Attempts to publish a message synchronously without applying the PubSub
 * strategy's effectful surplus handling.
 *
 * **When to use**
 *
 * Use when you need a non-blocking synchronous publish attempt where `false`
 * is an acceptable result when the message cannot be accepted immediately.
 *
 * **Details**
 *
 * Returns `false` if the `PubSub` is shut down or the message cannot be
 * accepted immediately, for example when a bounded PubSub is full. Prefer
 * `publish` when backpressure or sliding behavior should be honored.
 *
 * **Example** (Publishing without suspending)
 *
 * ```ts
 * import { PubSub } from "effect"
 *
 * declare const pubsub: PubSub.PubSub<string>
 *
 * // Unsafe synchronous publish (non-blocking)
 * const published = PubSub.publishUnsafe(pubsub, "Hello")
 * if (published) {
 *   console.log("Message published successfully")
 * } else {
 *   console.log("Message dropped (PubSub full or shutdown)")
 * }
 *
 * // Useful for scenarios where you don't want to suspend
 * const messages = ["msg1", "msg2", "msg3"]
 * const publishedCount =
 *   messages.filter((msg) => PubSub.publishUnsafe(pubsub, msg)).length
 * console.log(`Published ${publishedCount} out of ${messages.length} messages`)
 * ```
 *
 * @see {@link publish} for effectful publishing that honors the configured surplus strategy
 *
 * @category publishing
 * @since 4.0.0
 */
export const publishUnsafe: {
  <A>(value: A): (self: PubSub<A>) => boolean
  <A>(self: PubSub<A>, value: A): boolean
} = dual(2, <A>(self: PubSub<A>, value: A): boolean => {
  if (self.shutdownFlag.current) return false
  if (self.pubsub.publish(value)) {
    self.strategy.completeSubscribersUnsafe(self.pubsub, self.subscribers)
    return true
  }
  return false
})

/**
 * Publishes all of the specified messages to the `PubSub`, returning whether they
 * were published to the `PubSub`.
 *
 * **Example** (Publishing multiple messages)
 *
 * ```ts
 * import { Effect, Fiber, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   // Publish multiple messages at once
 *   const messages = ["Hello", "World", "from", "Effect"]
 *   const allPublished = yield* PubSub.publishAll(pubsub, messages)
 *   console.log("All messages published:", allPublished) // true
 *
 *   // With a smaller capacity and an active subscription
 *   const smallPubsub = yield* PubSub.bounded<string>(2)
 *   const manyMessages = ["msg1", "msg2", "msg3", "msg4"]
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(smallPubsub)
 *
 *     // Will suspend until space becomes available for all messages
 *     const fiber = yield* Effect.forkChild(PubSub.publishAll(smallPubsub, manyMessages))
 *
 *     const firstBatch = yield* PubSub.takeBetween(subscription, 2, 2)
 *     console.log("First batch:", firstBatch) // ["msg1", "msg2"]
 *
 *     const result = yield* Fiber.join(fiber)
 *     console.log("All messages eventually published:", result) // true
 *
 *     const secondBatch = yield* PubSub.takeAll(subscription)
 *     console.log("Second batch:", secondBatch) // ["msg3", "msg4"]
 *   }))
 * })
 * ```
 *
 * @category publishing
 * @since 2.0.0
 */
export const publishAll: {
  <A>(elements: Iterable<A>): (self: PubSub<A>) => Effect.Effect<boolean>
  <A>(self: PubSub<A>, elements: Iterable<A>): Effect.Effect<boolean>
} = dual(2, <A>(self: PubSub<A>, elements: Iterable<A>): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    if (self.shutdownFlag.current) {
      return Effect.succeed(false)
    }
    const surplus = self.pubsub.publishAll(elements)
    self.strategy.completeSubscribersUnsafe(self.pubsub, self.subscribers)
    if (surplus.length === 0) {
      return Effect.succeed(true)
    }
    return self.strategy.handleSurplus(
      self.pubsub,
      self.subscribers,
      surplus,
      self.shutdownFlag
    )
  }))

/**
 * Subscribes to receive messages from the `PubSub`. The resulting subscription can
 * be evaluated multiple times within the scope to take a message from the `PubSub`
 * each time.
 *
 * **Example** (Subscribing to messages)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   // Subscribe within a scope for automatic cleanup
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Publish some messages
 *     yield* PubSub.publish(pubsub, "Hello")
 *     yield* PubSub.publish(pubsub, "World")
 *
 *     // Take messages one by one
 *     const msg1 = yield* PubSub.take(subscription)
 *     const msg2 = yield* PubSub.take(subscription)
 *     console.log(msg1, msg2) // "Hello", "World"
 *
 *     // Subscription is automatically cleaned up when scope exits
 *   }))
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const sub1 = yield* PubSub.subscribe(pubsub)
 *     const sub2 = yield* PubSub.subscribe(pubsub)
 *
 *     // Multiple subscribers can receive the same messages
 *     yield* PubSub.publish(pubsub, "Broadcast")
 *
 *     const [msg1, msg2] = yield* Effect.all([
 *       PubSub.take(sub1),
 *       PubSub.take(sub2)
 *     ])
 *     console.log("Both received:", msg1, msg2) // "Broadcast", "Broadcast"
 *   }))
 * })
 * ```
 *
 * @category subscriptions
 * @since 2.0.0
 */
export const subscribe = <A>(self: PubSub<A>): Effect.Effect<Subscription<A>, never, Scope.Scope> =>
  Effect.uninterruptible(
    Effect.contextWith((services) => {
      const localScope = Context.get(services, Scope.Scope)
      const scope = Scope.forkUnsafe(self.scope)
      const subscription = makeSubscriptionUnsafe(self.pubsub, self.subscribers, self.strategy)
      return Scope.addFinalizer(scope, unsubscribe(subscription)).pipe(
        Effect.andThen(Scope.addFinalizerExit(localScope, (exit) => Scope.close(scope, exit))),
        Effect.as(subscription)
      )
    })
  )

const unsubscribe = <A>(self: Subscription<A>): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.withFiber<void>((state) => {
      MutableRef.set(self.shutdownFlag, true)
      return Effect.forEach(
        MutableList.takeAll(self.pollers),
        (d) => Deferred.interruptWith(d, state.id),
        { discard: true, concurrency: "unbounded" }
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            self.subscribers.delete(self.subscription)
            self.subscription.unsubscribe()
            self.strategy.onPubSubEmptySpaceUnsafe(self.pubsub, self.subscribers)
          })
        ),
        Effect.when(self.shutdownHook.open),
        Effect.asVoid
      )
    })
  )

/**
 * Takes a single message from the subscription. If no messages are available,
 * this will suspend until a message becomes available.
 *
 * **Example** (Taking a message)
 *
 * ```ts
 * import { Effect, Fiber, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Start a fiber to take a message (will suspend)
 *     const takeFiber = yield* Effect.forkChild(
 *       PubSub.take(subscription)
 *     )
 *
 *     // Publish a message
 *     yield* PubSub.publish(pubsub, "Hello")
 *
 *     // The take will now complete
 *     const message = yield* Fiber.join(takeFiber)
 *     console.log("Received:", message) // "Hello"
 *   }))
 * })
 * ```
 *
 * @category subscriptions
 * @since 4.0.0
 */
export const take = <A>(self: Subscription<A>): Effect.Effect<A> =>
  Effect.suspend(() => {
    if (self.shutdownFlag.current) {
      return Effect.interrupt
    }
    if (self.replayWindow.remaining > 0) {
      const message = self.replayWindow.take()!
      return Effect.succeed(message)
    }
    const message = self.pollers.length === 0
      ? self.subscription.poll()
      : MutableList.Empty
    if (message === MutableList.Empty) {
      return pollForItem(self)
    } else {
      self.strategy.onPubSubEmptySpaceUnsafe(self.pubsub, self.subscribers)
      return Effect.succeed(message)
    }
  })

/**
 * Takes all available messages from the subscription, suspending if no items
 * are available.
 *
 * **Example** (Taking all available messages)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Publish multiple messages
 *     yield* PubSub.publishAll(pubsub, ["msg1", "msg2", "msg3"])
 *
 *     // Take all available messages at once
 *     const allMessages = yield* PubSub.takeAll(subscription)
 *     console.log("All messages:", allMessages) // ["msg1", "msg2", "msg3"]
 *   }))
 * })
 * ```
 *
 * @category subscriptions
 * @since 4.0.0
 */
export const takeAll = <A>(self: Subscription<A>): Effect.Effect<Arr.NonEmptyArray<A>> =>
  Effect.suspend(function loop(value?: [A]): Effect.Effect<Arr.NonEmptyArray<A>> {
    if (self.shutdownFlag.current) {
      return Effect.interrupt
    }
    let as = self.pollers.length === 0
      ? self.subscription.pollUpTo(Number.POSITIVE_INFINITY)
      : []
    if (value) {
      as = value.concat(as)
    }
    self.strategy.onPubSubEmptySpaceUnsafe(self.pubsub, self.subscribers)
    if (self.replayWindow.remaining > 0) {
      return Effect.succeed(self.replayWindow.takeAll().concat(as) as Arr.NonEmptyArray<A>)
    } else if (!Arr.isArrayNonEmpty(as)) {
      return Effect.flatMap(pollForItem(self), (item) => loop([item]))
    }
    return Effect.succeed(as)
  })

const pollForItem = <A>(self: Subscription<A>) => {
  const deferred = Deferred.makeUnsafe<A>()
  let set = self.subscribers.get(self.subscription)
  if (!set) {
    set = new Set()
    self.subscribers.set(self.subscription, set)
  }
  set.add(self.pollers)
  MutableList.append(self.pollers, deferred)
  self.strategy.completePollersUnsafe(
    self.pubsub,
    self.subscribers,
    self.subscription,
    self.pollers
  )
  return Effect.onInterrupt(
    Deferred.await(deferred),
    () => {
      MutableList.remove(self.pollers, deferred)
      return Effect.void
    }
  )
}

/**
 * Takes up to the specified number of messages from the subscription without suspending.
 *
 * **Example** (Taking up to a maximum number of messages)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Publish multiple messages
 *     yield* PubSub.publishAll(pubsub, ["msg1", "msg2", "msg3", "msg4", "msg5"])
 *
 *     // Take up to 3 messages
 *     const upTo3 = yield* PubSub.takeUpTo(subscription, 3)
 *     console.log("Up to 3:", upTo3) // ["msg1", "msg2", "msg3"]
 *
 *     // Take up to 5 more (only 2 remaining)
 *     const upTo5 = yield* PubSub.takeUpTo(subscription, 5)
 *     console.log("Up to 5:", upTo5) // ["msg4", "msg5"]
 *
 *     // No more messages available
 *     const noMore = yield* PubSub.takeUpTo(subscription, 10)
 *     console.log("No more:", noMore) // []
 *   }))
 * })
 * ```
 *
 * @category subscriptions
 * @since 4.0.0
 */
export const takeUpTo: {
  (max: number): <A>(self: Subscription<A>) => Effect.Effect<Array<A>>
  <A>(self: Subscription<A>, max: number): Effect.Effect<Array<A>>
} = dual(2, <A>(self: Subscription<A>, max: number): Effect.Effect<Array<A>> =>
  Effect.suspend(() => {
    if (self.shutdownFlag.current) return Effect.interrupt
    let replay: Array<A> | undefined = undefined
    if (self.replayWindow.remaining >= max) {
      return Effect.succeed(self.replayWindow.takeN(max))
    } else if (self.replayWindow.remaining > 0) {
      replay = self.replayWindow.takeAll()
      max = max - replay.length
    }
    const as = self.pollers.length === 0
      ? self.subscription.pollUpTo(max)
      : []
    self.strategy.onPubSubEmptySpaceUnsafe(self.pubsub, self.subscribers)
    return replay ? Effect.succeed(replay.concat(as)) : Effect.succeed(as)
  }))

/**
 * Takes between the specified minimum and maximum number of messages from the subscription.
 * Will suspend if the minimum number is not immediately available.
 *
 * **Example** (Taking between a minimum and maximum)
 *
 * ```ts
 * import { Effect, Fiber, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Start taking between 2 and 5 messages (will suspend)
 *     const takeFiber = yield* Effect.forkChild(
 *       PubSub.takeBetween(subscription, 2, 5)
 *     )
 *
 *     // Publish 3 messages
 *     yield* PubSub.publishAll(pubsub, ["msg1", "msg2", "msg3"])
 *
 *     // Now the take will complete with 3 messages
 *     const messages = yield* Fiber.join(takeFiber)
 *     console.log("Between 2-5:", messages) // ["msg1", "msg2", "msg3"]
 *   }))
 * })
 * ```
 *
 * @category subscriptions
 * @since 4.0.0
 */
export const takeBetween: {
  (min: number, max: number): <A>(self: Subscription<A>) => Effect.Effect<Array<A>>
  <A>(self: Subscription<A>, min: number, max: number): Effect.Effect<Array<A>>
} = dual(
  3,
  <A>(self: Subscription<A>, min: number, max: number): Effect.Effect<Array<A>> =>
    Effect.suspend(() => takeRemainderLoop(self, min, max, []))
)

const takeRemainderLoop = <A>(
  self: Subscription<A>,
  min: number,
  max: number,
  acc: Array<A>
): Effect.Effect<Array<A>> => {
  if (max < min) {
    return Effect.succeed(acc)
  }
  return Effect.flatMap(takeUpTo(self, max), (bs) => {
    acc.push(...bs)
    const remaining = min - bs.length
    if (remaining === 1) {
      return Effect.map(take(self), (b) => {
        acc.push(b)
        return acc
      })
    }
    if (remaining > 1) {
      return Effect.flatMap(take(self), (b) => {
        acc.push(b)
        return takeRemainderLoop(
          self,
          remaining - 1,
          max - bs.length - 1,
          acc
        )
      })
    }
    return Effect.succeed(acc)
  })
}

/**
 * Returns the number of messages currently available in the subscription as an
 * `Effect`.
 *
 * **When to use**
 *
 * Use when checking a subscription from effectful code and shutdown should
 * interrupt the effect.
 *
 * **Details**
 *
 * The count includes replay-buffered messages. If the subscription has been
 * shut down, the effect interrupts.
 *
 * **Example** (Checking remaining messages)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.bounded<string>(10)
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Publish some messages
 *     yield* PubSub.publishAll(pubsub, ["msg1", "msg2", "msg3"])
 *
 *     // Check how many messages are available
 *     const count = yield* PubSub.remaining(subscription)
 *     console.log("Messages available:", count) // 3
 *
 *     // Take one message
 *     yield* PubSub.take(subscription)
 *
 *     const remaining = yield* PubSub.remaining(subscription)
 *     console.log("Messages remaining:", remaining) // 2
 *   }))
 * })
 * ```
 *
 * @see {@link remainingUnsafe} for a synchronous check that reports shutdown as `Option.none()`
 *
 * @category getters
 * @since 4.0.0
 */
export const remaining = <A>(self: Subscription<A>): Effect.Effect<number> =>
  Effect.suspend(() =>
    self.shutdownFlag.current
      ? Effect.interrupt
      : Effect.succeed(self.subscription.size() + self.replayWindow.remaining)
  )

/**
 * Synchronously returns the number of messages currently available in the
 * subscription, or `Option.none()` when it is shut down.
 *
 * **When to use**
 *
 * Use when you need synchronous polling outside a managed workflow and want
 * shutdown observed as data instead of interruption.
 *
 * **Example** (Checking remaining messages synchronously)
 *
 * ```ts
 * import { PubSub } from "effect"
 *
 * declare const subscription: PubSub.Subscription<string>
 *
 * // Unsafe synchronous check for remaining messages
 * const remainingOption = PubSub.remainingUnsafe(subscription)
 * if (remainingOption._tag === "Some") {
 *   console.log("Messages available:", remainingOption.value)
 * } else {
 *   console.log("Subscription is shutdown")
 * }
 *
 * // Useful for polling or batching scenarios
 * if (remainingOption._tag === "Some" && remainingOption.value > 10) {
 *   // Process messages in batch
 * }
 * ```
 *
 * @see {@link remaining} for the effectful variant that interrupts on shutdown
 *
 * @category getters
 * @since 4.0.0
 */
export const remainingUnsafe = <A>(self: Subscription<A>): Option.Option<number> => {
  if (self.shutdownFlag.current) {
    return Option.none()
  }
  return Option.some(self.subscription.size() + self.replayWindow.remaining)
}

// -----------------------------------------------------------------------------
// internal
// -----------------------------------------------------------------------------

const AbsentValue = Symbol.for("effect/PubSub/AbsentValue")
type AbsentValue = typeof AbsentValue

const addSubscribers = <A>(
  subscribers: PubSub.Subscribers<A>,
  subscription: PubSub.BackingSubscription<A>,
  pollers: MutableList.MutableList<Deferred.Deferred<A>>
) => {
  if (!subscribers.has(subscription)) {
    subscribers.set(subscription, new Set())
  }
  const set = subscribers.get(subscription)!
  set.add(pollers)
}

const removeSubscribers = <A>(
  subscribers: PubSub.Subscribers<A>,
  subscription: PubSub.BackingSubscription<A>,
  pollers: MutableList.MutableList<Deferred.Deferred<A>>
) => {
  if (!subscribers.has(subscription)) {
    return
  }
  const set = subscribers.get(subscription)!
  set.delete(pollers)
  if (set.size === 0) {
    subscribers.delete(subscription)
  }
}

const makeSubscriptionUnsafe = <A>(
  pubsub: PubSub.Atomic<A>,
  subscribers: PubSub.Subscribers<A>,
  strategy: PubSub.Strategy<A>
): Subscription<A> =>
  new SubscriptionImpl(
    pubsub,
    subscribers,
    pubsub.subscribe(),
    MutableList.make<Deferred.Deferred<A>>(),
    Latch.makeUnsafe(false),
    MutableRef.make(false),
    strategy,
    pubsub.replayWindow()
  )

class BoundedPubSubArb<in out A> implements PubSub.Atomic<A> {
  array: Array<A>
  publisherIndex = 0
  subscribers: Array<number>
  subscriberCount = 0
  subscribersIndex = 0

  readonly capacity: number
  readonly replayBuffer: ReplayBuffer<A> | undefined

  constructor(capacity: number, replayBuffer: ReplayBuffer<A> | undefined) {
    this.capacity = capacity
    this.replayBuffer = replayBuffer
    this.array = Array.from({ length: capacity })
    this.subscribers = Array.from({ length: capacity })
  }

  replayWindow(): PubSub.ReplayWindow<A> {
    return this.replayBuffer ? new ReplayWindowImpl(this.replayBuffer) : emptyReplayWindow
  }

  isEmpty(): boolean {
    return this.publisherIndex === this.subscribersIndex
  }

  isFull(): boolean {
    return this.publisherIndex === this.subscribersIndex + this.capacity
  }

  size(): number {
    return this.publisherIndex - this.subscribersIndex
  }

  publish(value: A): boolean {
    if (this.isFull()) {
      return false
    }
    if (this.subscriberCount !== 0) {
      const index = this.publisherIndex % this.capacity
      this.array[index] = value
      this.subscribers[index] = this.subscriberCount
      this.publisherIndex += 1
    }
    if (this.replayBuffer) {
      this.replayBuffer.offer(value)
    }
    return true
  }

  publishAll(elements: Iterable<A>): Array<A> {
    if (this.subscriberCount === 0) {
      if (this.replayBuffer) {
        this.replayBuffer.offerAll(elements)
      }
      return []
    }
    const chunk = Arr.fromIterable(elements)
    const n = chunk.length
    const size = this.publisherIndex - this.subscribersIndex
    const available = this.capacity - size
    const forPubSub = Math.min(n, available)
    if (forPubSub === 0) {
      return chunk
    }
    let iteratorIndex = 0
    const publishAllIndex = this.publisherIndex + forPubSub
    while (this.publisherIndex !== publishAllIndex) {
      const a = chunk[iteratorIndex++]
      const index = this.publisherIndex % this.capacity
      this.array[index] = a
      this.subscribers[index] = this.subscriberCount
      this.publisherIndex += 1
      if (this.replayBuffer) {
        this.replayBuffer.offer(a)
      }
    }
    return chunk.slice(iteratorIndex)
  }

  slide(): void {
    if (this.subscribersIndex !== this.publisherIndex) {
      const index = this.subscribersIndex % this.capacity
      this.array[index] = AbsentValue as unknown as A
      this.subscribers[index] = 0
      this.subscribersIndex += 1
    }
    if (this.replayBuffer) {
      this.replayBuffer.slide()
    }
  }

  subscribe(): PubSub.BackingSubscription<A> {
    this.subscriberCount += 1
    return new BoundedPubSubArbSubscription(this, this.publisherIndex, false)
  }
}

class BoundedPubSubArbSubscription<in out A> implements PubSub.BackingSubscription<A> {
  private self: BoundedPubSubArb<A>
  private subscriberIndex: number
  private unsubscribed: boolean

  constructor(
    self: BoundedPubSubArb<A>,
    subscriberIndex: number,
    unsubscribed: boolean
  ) {
    this.self = self
    this.subscriberIndex = subscriberIndex
    this.unsubscribed = unsubscribed
  }

  isEmpty(): boolean {
    return (
      this.unsubscribed ||
      this.self.publisherIndex === this.subscriberIndex ||
      this.self.publisherIndex === this.self.subscribersIndex
    )
  }

  size() {
    if (this.unsubscribed) {
      return 0
    }
    return this.self.publisherIndex - Math.max(this.subscriberIndex, this.self.subscribersIndex)
  }

  poll(): A | MutableList.Empty {
    if (this.unsubscribed) {
      return MutableList.Empty
    }
    this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
    if (this.subscriberIndex !== this.self.publisherIndex) {
      const index = this.subscriberIndex % this.self.capacity
      const elem = this.self.array[index]!
      this.self.subscribers[index] -= 1
      if (this.self.subscribers[index] === 0) {
        this.self.array[index] = AbsentValue as unknown as A
        this.self.subscribersIndex += 1
      }
      this.subscriberIndex += 1
      return elem
    }
    return MutableList.Empty
  }

  pollUpTo(n: number): Array<A> {
    if (this.unsubscribed) {
      return []
    }
    this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
    const size = this.self.publisherIndex - this.subscriberIndex
    const toPoll = Math.min(n, size)
    if (toPoll <= 0) {
      return []
    }
    const builder: Array<A> = []
    const pollUpToIndex = this.subscriberIndex + toPoll
    while (this.subscriberIndex !== pollUpToIndex) {
      const index = this.subscriberIndex % this.self.capacity
      const a = this.self.array[index] as A
      this.self.subscribers[index] -= 1
      if (this.self.subscribers[index] === 0) {
        this.self.array[index] = AbsentValue as unknown as A
        this.self.subscribersIndex += 1
      }
      builder.push(a)
      this.subscriberIndex += 1
    }

    return builder
  }

  unsubscribe(): void {
    if (!this.unsubscribed) {
      this.unsubscribed = true
      this.self.subscriberCount -= 1
      this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
      while (this.subscriberIndex !== this.self.publisherIndex) {
        const index = this.subscriberIndex % this.self.capacity
        this.self.subscribers[index] -= 1
        if (this.self.subscribers[index] === 0) {
          this.self.array[index] = AbsentValue as unknown as A
          this.self.subscribersIndex += 1
        }
        this.subscriberIndex += 1
      }
    }
  }
}

class BoundedPubSubPow2<in out A> implements PubSub.Atomic<A> {
  array: Array<A>
  mask: number
  publisherIndex = 0
  subscribers: Array<number>
  subscriberCount = 0
  subscribersIndex = 0

  readonly capacity: number
  readonly replayBuffer: ReplayBuffer<A> | undefined

  constructor(capacity: number, replayBuffer: ReplayBuffer<A> | undefined) {
    this.capacity = capacity
    this.replayBuffer = replayBuffer
    this.array = Array.from({ length: capacity })
    this.mask = capacity - 1
    this.subscribers = Array.from({ length: capacity })
  }

  replayWindow(): PubSub.ReplayWindow<A> {
    return this.replayBuffer ? new ReplayWindowImpl(this.replayBuffer) : emptyReplayWindow
  }

  isEmpty(): boolean {
    return this.publisherIndex === this.subscribersIndex
  }

  isFull(): boolean {
    return this.publisherIndex === this.subscribersIndex + this.capacity
  }

  size(): number {
    return this.publisherIndex - this.subscribersIndex
  }

  publish(value: A): boolean {
    if (this.isFull()) {
      return false
    }
    if (this.subscriberCount !== 0) {
      const index = this.publisherIndex & this.mask
      this.array[index] = value
      this.subscribers[index] = this.subscriberCount
      this.publisherIndex += 1
    }
    if (this.replayBuffer) {
      this.replayBuffer.offer(value)
    }
    return true
  }

  publishAll(elements: Iterable<A>): Array<A> {
    if (this.subscriberCount === 0) {
      if (this.replayBuffer) {
        this.replayBuffer.offerAll(elements)
      }
      return []
    }
    const chunk = Arr.fromIterable(elements)
    const n = chunk.length
    const size = this.publisherIndex - this.subscribersIndex
    const available = this.capacity - size
    const forPubSub = Math.min(n, available)
    if (forPubSub === 0) {
      return chunk
    }
    let iteratorIndex = 0
    const publishAllIndex = this.publisherIndex + forPubSub
    while (this.publisherIndex !== publishAllIndex) {
      const elem = chunk[iteratorIndex++]
      const index = this.publisherIndex & this.mask
      this.array[index] = elem
      this.subscribers[index] = this.subscriberCount
      this.publisherIndex += 1
      if (this.replayBuffer) {
        this.replayBuffer.offer(elem)
      }
    }
    return chunk.slice(iteratorIndex)
  }

  slide(): void {
    if (this.subscribersIndex !== this.publisherIndex) {
      const index = this.subscribersIndex & this.mask
      this.array[index] = AbsentValue as unknown as A
      this.subscribers[index] = 0
      this.subscribersIndex += 1
    }
    if (this.replayBuffer) {
      this.replayBuffer.slide()
    }
  }

  subscribe(): PubSub.BackingSubscription<A> {
    this.subscriberCount += 1
    return new BoundedPubSubPow2Subscription(this, this.publisherIndex, false)
  }
}

class BoundedPubSubPow2Subscription<in out A> implements PubSub.BackingSubscription<A> {
  private self: BoundedPubSubPow2<A>
  private subscriberIndex: number
  private unsubscribed: boolean

  constructor(
    self: BoundedPubSubPow2<A>,
    subscriberIndex: number,
    unsubscribed: boolean
  ) {
    this.self = self
    this.subscriberIndex = subscriberIndex
    this.unsubscribed = unsubscribed
  }

  isEmpty(): boolean {
    return (
      this.unsubscribed ||
      this.self.publisherIndex === this.subscriberIndex ||
      this.self.publisherIndex === this.self.subscribersIndex
    )
  }

  size() {
    if (this.unsubscribed) {
      return 0
    }
    return this.self.publisherIndex - Math.max(this.subscriberIndex, this.self.subscribersIndex)
  }

  poll(): A | MutableList.Empty {
    if (this.unsubscribed) {
      return MutableList.Empty
    }
    this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
    if (this.subscriberIndex !== this.self.publisherIndex) {
      const index = this.subscriberIndex & this.self.mask
      const elem = this.self.array[index]!
      this.self.subscribers[index] -= 1
      if (this.self.subscribers[index] === 0) {
        this.self.array[index] = AbsentValue as unknown as A
        this.self.subscribersIndex += 1
      }
      this.subscriberIndex += 1
      return elem
    }
    return MutableList.Empty
  }

  pollUpTo(n: number): Array<A> {
    if (this.unsubscribed) {
      return []
    }
    this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
    const size = this.self.publisherIndex - this.subscriberIndex
    const toPoll = Math.min(n, size)
    if (toPoll <= 0) {
      return []
    }
    const builder: Array<A> = []
    const pollUpToIndex = this.subscriberIndex + toPoll
    while (this.subscriberIndex !== pollUpToIndex) {
      const index = this.subscriberIndex & this.self.mask
      const elem = this.self.array[index] as A
      this.self.subscribers[index] -= 1
      if (this.self.subscribers[index] === 0) {
        this.self.array[index] = AbsentValue as unknown as A
        this.self.subscribersIndex += 1
      }
      builder.push(elem)
      this.subscriberIndex += 1
    }
    return builder
  }

  unsubscribe(): void {
    if (!this.unsubscribed) {
      this.unsubscribed = true
      this.self.subscriberCount -= 1
      this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
      while (this.subscriberIndex !== this.self.publisherIndex) {
        const index = this.subscriberIndex & this.self.mask
        this.self.subscribers[index] -= 1
        if (this.self.subscribers[index] === 0) {
          this.self.array[index] = AbsentValue as unknown as A
          this.self.subscribersIndex += 1
        }
        this.subscriberIndex += 1
      }
    }
  }
}

class BoundedPubSubSingle<in out A> implements PubSub.Atomic<A> {
  publisherIndex = 0
  subscriberCount = 0
  subscribers = 0
  value: A = AbsentValue as unknown as A

  readonly capacity = 1
  readonly replayBuffer: ReplayBuffer<A> | undefined

  constructor(replayBuffer: ReplayBuffer<A> | undefined) {
    this.replayBuffer = replayBuffer
  }

  replayWindow(): PubSub.ReplayWindow<A> {
    return this.replayBuffer ? new ReplayWindowImpl(this.replayBuffer) : emptyReplayWindow
  }

  pipe() {
    return pipeArguments(this, arguments)
  }

  isEmpty(): boolean {
    return this.subscribers === 0
  }

  isFull(): boolean {
    return !this.isEmpty()
  }

  size(): number {
    return this.isEmpty() ? 0 : 1
  }

  publish(value: A): boolean {
    if (this.isFull()) {
      return false
    }
    if (this.subscriberCount !== 0) {
      this.value = value
      this.subscribers = this.subscriberCount
      this.publisherIndex += 1
    }
    if (this.replayBuffer) {
      this.replayBuffer.offer(value)
    }
    return true
  }

  publishAll(elements: Iterable<A>): Array<A> {
    if (this.subscriberCount === 0) {
      if (this.replayBuffer) {
        this.replayBuffer.offerAll(elements)
      }
      return []
    }
    const chunk = Arr.fromIterable(elements)
    if (chunk.length === 0) {
      return chunk
    }
    if (this.publish(chunk[0])) {
      return chunk.slice(1)
    } else {
      return chunk
    }
  }

  slide(): void {
    if (this.isFull()) {
      this.subscribers = 0
      this.value = AbsentValue as unknown as A
    }
    if (this.replayBuffer) {
      this.replayBuffer.slide()
    }
  }

  subscribe(): PubSub.BackingSubscription<A> {
    this.subscriberCount += 1
    return new BoundedPubSubSingleSubscription(this, this.publisherIndex, false)
  }
}

class BoundedPubSubSingleSubscription<in out A> implements PubSub.BackingSubscription<A> {
  private self: BoundedPubSubSingle<A>
  private subscriberIndex: number
  private unsubscribed: boolean

  constructor(
    self: BoundedPubSubSingle<A>,
    subscriberIndex: number,
    unsubscribed: boolean
  ) {
    this.self = self
    this.subscriberIndex = subscriberIndex
    this.unsubscribed = unsubscribed
  }

  isEmpty(): boolean {
    return (
      this.unsubscribed ||
      this.self.subscribers === 0 ||
      this.subscriberIndex === this.self.publisherIndex
    )
  }

  size() {
    return this.isEmpty() ? 0 : 1
  }

  poll(): A | MutableList.Empty {
    if (this.isEmpty()) {
      return MutableList.Empty
    }
    const elem = this.self.value
    this.self.subscribers -= 1
    if (this.self.subscribers === 0) {
      this.self.value = AbsentValue as unknown as A
    }
    this.subscriberIndex += 1
    return elem
  }

  pollUpTo(n: number): Array<A> {
    if (this.isEmpty() || n < 1) {
      return []
    }
    const a = this.self.value
    this.self.subscribers -= 1
    if (this.self.subscribers === 0) {
      this.self.value = AbsentValue as unknown as A
    }
    this.subscriberIndex += 1
    return [a]
  }

  unsubscribe(): void {
    if (!this.unsubscribed) {
      this.unsubscribed = true
      this.self.subscriberCount -= 1
      if (this.subscriberIndex !== this.self.publisherIndex) {
        this.self.subscribers -= 1
        if (this.self.subscribers === 0) {
          this.self.value = AbsentValue as unknown as A
        }
      }
    }
  }
}

interface Node<out A> {
  value: A | AbsentValue
  subscribers: number
  next: Node<A> | null
}

class UnboundedPubSub<in out A> implements PubSub.Atomic<A> {
  publisherHead: Node<A> = {
    value: AbsentValue,
    subscribers: 0,
    next: null
  }
  publisherTail = this.publisherHead
  publisherIndex = 0
  subscribersIndex = 0

  readonly capacity = Number.MAX_SAFE_INTEGER
  readonly replayBuffer: ReplayBuffer<A> | undefined

  constructor(replayBuffer: ReplayBuffer<A> | undefined) {
    this.replayBuffer = replayBuffer
  }

  replayWindow(): PubSub.ReplayWindow<A> {
    return this.replayBuffer ? new ReplayWindowImpl(this.replayBuffer) : emptyReplayWindow
  }

  isEmpty(): boolean {
    return this.publisherHead === this.publisherTail
  }

  isFull(): boolean {
    return false
  }

  size(): number {
    return this.publisherIndex - this.subscribersIndex
  }

  publish(value: A): boolean {
    const subscribers = this.publisherTail.subscribers
    if (subscribers !== 0) {
      this.publisherTail.next = {
        value,
        subscribers,
        next: null
      }
      this.publisherTail = this.publisherTail.next
      this.publisherIndex += 1
    }
    if (this.replayBuffer) {
      this.replayBuffer.offer(value)
    }
    return true
  }

  publishAll(elements: Iterable<A>): Array<A> {
    if (this.publisherTail.subscribers !== 0) {
      for (const a of elements) {
        this.publish(a)
      }
    } else if (this.replayBuffer) {
      this.replayBuffer.offerAll(elements)
    }
    return []
  }

  slide(): void {
    if (this.publisherHead !== this.publisherTail) {
      this.publisherHead = this.publisherHead.next!
      this.publisherHead.value = AbsentValue
      this.subscribersIndex += 1
    }
    if (this.replayBuffer) {
      this.replayBuffer.slide()
    }
  }

  subscribe(): PubSub.BackingSubscription<A> {
    this.publisherTail.subscribers += 1
    return new UnboundedPubSubSubscription(
      this,
      this.publisherTail,
      this.publisherIndex,
      false
    )
  }
}

class UnboundedPubSubSubscription<in out A> implements PubSub.BackingSubscription<A> {
  private self: UnboundedPubSub<A>
  private subscriberHead: Node<A>
  private subscriberIndex: number
  private unsubscribed: boolean

  constructor(
    self: UnboundedPubSub<A>,
    subscriberHead: Node<A>,
    subscriberIndex: number,
    unsubscribed: boolean
  ) {
    this.self = self
    this.subscriberHead = subscriberHead
    this.subscriberIndex = subscriberIndex
    this.unsubscribed = unsubscribed
  }

  isEmpty(): boolean {
    if (this.unsubscribed) {
      return true
    }
    let empty = true
    let loop = true
    while (loop) {
      if (this.subscriberHead === this.self.publisherTail) {
        loop = false
      } else {
        if (this.subscriberHead.next!.value !== AbsentValue) {
          empty = false
          loop = false
        } else {
          this.subscriberHead = this.subscriberHead.next!
          this.subscriberIndex += 1
        }
      }
    }
    return empty
  }

  size() {
    if (this.unsubscribed) {
      return 0
    }
    return this.self.publisherIndex - Math.max(this.subscriberIndex, this.self.subscribersIndex)
  }

  poll(): A | MutableList.Empty {
    if (this.unsubscribed) {
      return MutableList.Empty
    }
    let loop = true
    let polled: A | MutableList.Empty = MutableList.Empty
    while (loop) {
      if (this.subscriberHead === this.self.publisherTail) {
        loop = false
      } else {
        const elem = this.subscriberHead.next!.value
        if (elem !== AbsentValue) {
          polled = elem
          this.subscriberHead.subscribers -= 1
          if (this.subscriberHead.subscribers === 0) {
            this.self.publisherHead = this.self.publisherHead.next!
            this.self.publisherHead.value = AbsentValue
            this.self.subscribersIndex += 1
          }
          loop = false
        }
        this.subscriberHead = this.subscriberHead.next!
        this.subscriberIndex += 1
      }
    }
    return polled
  }

  pollUpTo(n: number): Array<A> {
    const builder: Array<A> = []
    let i = 0
    while (i !== n) {
      const a = this.poll()
      if (a === MutableList.Empty) {
        i = n
      } else {
        builder.push(a)
        i += 1
      }
    }
    return builder
  }

  unsubscribe(): void {
    if (!this.unsubscribed) {
      this.unsubscribed = true
      this.self.publisherTail.subscribers -= 1
      while (this.subscriberHead !== this.self.publisherTail) {
        if (this.subscriberHead.next!.value !== AbsentValue) {
          this.subscriberHead.subscribers -= 1
          if (this.subscriberHead.subscribers === 0) {
            this.self.publisherHead = this.self.publisherHead.next!
            this.self.publisherHead.value = AbsentValue
            this.self.subscribersIndex += 1
          }
        }
        this.subscriberHead = this.subscriberHead.next!
      }
    }
  }
}

class SubscriptionImpl<in out A> implements Subscription<A> {
  readonly [SubscriptionTypeId] = {
    _A: identity
  }

  readonly pubsub: PubSub.Atomic<A>
  readonly subscribers: PubSub.Subscribers<A>
  readonly subscription: PubSub.BackingSubscription<A>
  readonly pollers: MutableList.MutableList<Deferred.Deferred<A>>
  readonly shutdownHook: Latch.Latch
  readonly shutdownFlag: MutableRef.MutableRef<boolean>
  readonly strategy: PubSub.Strategy<A>
  readonly replayWindow: PubSub.ReplayWindow<A>

  constructor(
    pubsub: PubSub.Atomic<A>,
    subscribers: PubSub.Subscribers<A>,
    subscription: PubSub.BackingSubscription<A>,
    pollers: MutableList.MutableList<Deferred.Deferred<A>>,
    shutdownHook: Latch.Latch,
    shutdownFlag: MutableRef.MutableRef<boolean>,
    strategy: PubSub.Strategy<A>,
    replayWindow: PubSub.ReplayWindow<A>
  ) {
    this.pubsub = pubsub
    this.subscribers = subscribers
    this.subscription = subscription
    this.pollers = pollers
    this.shutdownHook = shutdownHook
    this.shutdownFlag = shutdownFlag
    this.strategy = strategy
    this.replayWindow = replayWindow
  }

  pipe() {
    return pipeArguments(this, arguments)
  }
}

class PubSubImpl<in out A> implements PubSub<A> {
  readonly [TypeId] = {
    _A: identity
  }

  readonly pubsub: PubSub.Atomic<A>
  readonly subscribers: PubSub.Subscribers<A>
  readonly scope: Scope.Closeable
  readonly shutdownHook: Latch.Latch
  readonly shutdownFlag: MutableRef.MutableRef<boolean>
  readonly strategy: PubSub.Strategy<A>

  constructor(
    pubsub: PubSub.Atomic<A>,
    subscribers: PubSub.Subscribers<A>,
    scope: Scope.Closeable,
    shutdownHook: Latch.Latch,
    shutdownFlag: MutableRef.MutableRef<boolean>,
    strategy: PubSub.Strategy<A>
  ) {
    this.pubsub = pubsub
    this.subscribers = subscribers
    this.scope = scope
    this.shutdownHook = shutdownHook
    this.shutdownFlag = shutdownFlag
    this.strategy = strategy
  }

  pipe() {
    return pipeArguments(this, arguments)
  }
}

const makePubSubUnsafe = <A>(
  pubsub: PubSub.Atomic<A>,
  subscribers: PubSub.Subscribers<A>,
  scope: Scope.Closeable,
  shutdownHook: Latch.Latch,
  shutdownFlag: MutableRef.MutableRef<boolean>,
  strategy: PubSub.Strategy<A>
): PubSub<A> => new PubSubImpl(pubsub, subscribers, scope, shutdownHook, shutdownFlag, strategy)

const ensureCapacity = (capacity: number): void => {
  if (capacity <= 0) {
    throw new Error(`Cannot construct PubSub with capacity of ${capacity}`)
  }
}

// -----------------------------------------------------------------------------
// PubSub.Strategy
// -----------------------------------------------------------------------------

/**
 * Represents the back-pressure strategy for bounded `PubSub` values.
 *
 * **When to use**
 *
 * Use to preserve every message for current subscribers when a bounded custom
 * `PubSub` should make publishers wait for capacity instead of dropping or
 * evicting messages.
 *
 * **Details**
 *
 * Publishers wait when the `PubSub` is at capacity, so all current subscribers
 * can receive every published message.
 *
 * **Gotchas**
 *
 * A slow subscriber can slow down publishers and other subscribers.
 *
 * @see {@link bounded} for creating bounded PubSubs with back pressure by default
 * @see {@link DroppingStrategy} for dropping new messages when capacity is full
 * @see {@link SlidingStrategy} for evicting old messages when capacity is full
 *
 * @category models
 * @since 4.0.0
 */
export class BackPressureStrategy<in out A> implements PubSub.Strategy<A> {
  publishers: MutableList.MutableList<
    readonly [A, Deferred.Deferred<boolean>, boolean]
  > = MutableList.make()

  get shutdown(): Effect.Effect<void> {
    return Effect.withFiber((fiber) =>
      Effect.forEach(
        MutableList.takeAll(this.publishers),
        ([_, deferred, last]) => last ? Deferred.interruptWith(deferred, fiber.id) : Effect.void,
        { concurrency: "unbounded", discard: true }
      )
    )
  }

  handleSurplus(
    pubsub: PubSub.Atomic<A>,
    subscribers: PubSub.Subscribers<A>,
    elements: Iterable<A>,
    isShutdown: MutableRef.MutableRef<boolean>
  ): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      const deferred = Deferred.makeUnsafe<boolean>()
      this.offerUnsafe(elements, deferred)
      this.onPubSubEmptySpaceUnsafe(pubsub, subscribers)
      this.completeSubscribersUnsafe(pubsub, subscribers)
      return (MutableRef.get(isShutdown) ? Effect.interrupt : Deferred.await(deferred)).pipe(
        Effect.onInterrupt(() => {
          this.removeUnsafe(deferred)
          return Effect.void
        })
      )
    })
  }

  onPubSubEmptySpaceUnsafe(
    pubsub: PubSub.Atomic<A>,
    subscribers: PubSub.Subscribers<A>
  ): void {
    let keepPolling = true
    while (keepPolling && !pubsub.isFull()) {
      const publisher = MutableList.take(this.publishers)
      if (publisher === MutableList.Empty) {
        keepPolling = false
      } else {
        const [value, deferred] = publisher
        const published = pubsub.publish(value)
        if (published && publisher[2]) {
          Deferred.doneUnsafe(deferred, Exit.succeed(true))
        } else if (!published) {
          MutableList.prepend(this.publishers, publisher)
        }
        this.completeSubscribersUnsafe(pubsub, subscribers)
      }
    }
  }

  completePollersUnsafe(
    pubsub: PubSub.Atomic<A>,
    subscribers: PubSub.Subscribers<A>,
    subscription: PubSub.BackingSubscription<A>,
    pollers: MutableList.MutableList<Deferred.Deferred<A>>
  ): void {
    return strategyCompletePollersUnsafe(this, pubsub, subscribers, subscription, pollers)
  }

  completeSubscribersUnsafe(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>): void {
    return strategyCompleteSubscribersUnsafe(this, pubsub, subscribers)
  }

  private offerUnsafe(elements: Iterable<A>, deferred: Deferred.Deferred<boolean>): void {
    const iterator = elements[Symbol.iterator]()
    let next: IteratorResult<A> = iterator.next()
    if (!next.done) {
      // oxlint-disable-next-line no-constant-condition
      while (1) {
        const value = next.value
        next = iterator.next()
        if (next.done) {
          MutableList.append(this.publishers, [value, deferred, true])
          break
        }
        MutableList.append(this.publishers, [value, deferred, false])
      }
    }
  }

  removeUnsafe(deferred: Deferred.Deferred<boolean>): void {
    MutableList.filter(this.publishers, ([_, d]) => d !== deferred)
  }
}

/**
 * Represents the dropping strategy for bounded `PubSub` values.
 *
 * **When to use**
 *
 * Use to keep publishers fast by dropping new messages when the `PubSub` is at
 * capacity.
 *
 * **Details**
 *
 * A publish that arrives while the `PubSub` is full is dropped instead of
 * waiting for capacity.
 *
 * **Gotchas**
 *
 * Subscribers may miss messages published while they are subscribed.
 *
 * **Example** (Applying a dropping strategy)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create PubSub with dropping strategy
 *   const pubsub = yield* PubSub.dropping<string>(2)
 *
 *   // Or explicitly create with dropping strategy
 *   const customPubsub = yield* PubSub.make<string>({
 *     atomicPubSub: () => PubSub.makeAtomicBounded(2),
 *     strategy: () => new PubSub.DroppingStrategy()
 *   })
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Fill the PubSub
 *     const pub1 = yield* PubSub.publish(pubsub, "msg1") // true
 *     const pub2 = yield* PubSub.publish(pubsub, "msg2") // true
 *     const pub3 = yield* PubSub.publish(pubsub, "msg3") // false (dropped)
 *
 *     console.log("Publication results:", [pub1, pub2, pub3]) // [true, true, false]
 *
 *     // Subscribers will only see the first two messages
 *     const messages = yield* PubSub.takeAll(subscription)
 *     console.log("Received messages:", messages) // ["msg1", "msg2"]
 *   }))
 * })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export class DroppingStrategy<in out A> implements PubSub.Strategy<A> {
  get shutdown(): Effect.Effect<void> {
    return Effect.void
  }

  handleSurplus(
    _pubsub: PubSub.Atomic<A>,
    _subscribers: PubSub.Subscribers<A>,
    _elements: Iterable<A>,
    _isShutdown: MutableRef.MutableRef<boolean>
  ): Effect.Effect<boolean> {
    return Effect.succeed(false)
  }

  onPubSubEmptySpaceUnsafe(
    _pubsub: PubSub.Atomic<A>,
    _subscribers: PubSub.Subscribers<A>
  ): void {
    //
  }

  completePollersUnsafe(
    pubsub: PubSub.Atomic<A>,
    subscribers: PubSub.Subscribers<A>,
    subscription: PubSub.BackingSubscription<A>,
    pollers: MutableList.MutableList<Deferred.Deferred<A>>
  ): void {
    return strategyCompletePollersUnsafe(this, pubsub, subscribers, subscription, pollers)
  }

  completeSubscribersUnsafe(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>): void {
    return strategyCompleteSubscribersUnsafe(this, pubsub, subscribers)
  }
}

/**
 * Represents the sliding strategy for bounded `PubSub` values.
 *
 * **When to use**
 *
 * Use to keep the most recent messages when the `PubSub` is at capacity.
 *
 * **Details**
 *
 * New messages are accepted by evicting older messages from the bounded
 * `PubSub`.
 *
 * **Gotchas**
 *
 * Slow subscribers may miss older messages that are evicted before they are
 * consumed.
 *
 * **Example** (Applying a sliding strategy)
 *
 * ```ts
 * import { Effect, PubSub } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create PubSub with sliding strategy
 *   const pubsub = yield* PubSub.sliding<string>(2)
 *
 *   // Or explicitly create with sliding strategy
 *   const customPubsub = yield* PubSub.make<string>({
 *     atomicPubSub: () => PubSub.makeAtomicBounded(2),
 *     strategy: () => new PubSub.SlidingStrategy()
 *   })
 *
 *   yield* Effect.scoped(Effect.gen(function*() {
 *     const subscription = yield* PubSub.subscribe(pubsub)
 *
 *     // Publish messages that exceed capacity
 *     yield* PubSub.publish(pubsub, "msg1") // stored
 *     yield* PubSub.publish(pubsub, "msg2") // stored
 *     yield* PubSub.publish(pubsub, "msg3") // "msg1" evicted, "msg3" stored
 *     yield* PubSub.publish(pubsub, "msg4") // "msg2" evicted, "msg4" stored
 *
 *     // Subscribers will see the most recent messages
 *     const messages = yield* PubSub.takeAll(subscription)
 *     console.log("Recent messages:", messages) // ["msg3", "msg4"]
 *   }))
 * })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export class SlidingStrategy<in out A> implements PubSub.Strategy<A> {
  get shutdown(): Effect.Effect<void> {
    return Effect.void
  }

  handleSurplus(
    pubsub: PubSub.Atomic<A>,
    subscribers: PubSub.Subscribers<A>,
    elements: Iterable<A>,
    _isShutdown: MutableRef.MutableRef<boolean>
  ): Effect.Effect<boolean> {
    return Effect.sync(() => {
      this.slidingPublishUnsafe(pubsub, elements)
      this.completeSubscribersUnsafe(pubsub, subscribers)
      return true
    })
  }

  onPubSubEmptySpaceUnsafe(
    _pubsub: PubSub.Atomic<A>,
    _subscribers: PubSub.Subscribers<A>
  ): void {
    //
  }

  completePollersUnsafe(
    pubsub: PubSub.Atomic<A>,
    subscribers: PubSub.Subscribers<A>,
    subscription: PubSub.BackingSubscription<A>,
    pollers: MutableList.MutableList<Deferred.Deferred<A>>
  ): void {
    return strategyCompletePollersUnsafe(this, pubsub, subscribers, subscription, pollers)
  }

  completeSubscribersUnsafe(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>): void {
    return strategyCompleteSubscribersUnsafe(this, pubsub, subscribers)
  }

  slidingPublishUnsafe(pubsub: PubSub.Atomic<A>, elements: Iterable<A>): void {
    const it = elements[Symbol.iterator]()
    let next = it.next()
    if (!next.done && pubsub.capacity > 0) {
      let a = next.value
      let loop = true
      while (loop) {
        pubsub.slide()
        const pub = pubsub.publish(a)
        if (pub && (next = it.next()) && !next.done) {
          a = next.value
        } else if (pub) {
          loop = false
        }
      }
    }
  }
}

const strategyCompletePollersUnsafe = <A>(
  strategy: PubSub.Strategy<A>,
  pubsub: PubSub.Atomic<A>,
  subscribers: PubSub.Subscribers<A>,
  subscription: PubSub.BackingSubscription<A>,
  pollers: MutableList.MutableList<Deferred.Deferred<A>>
): void => {
  let keepPolling = true
  while (keepPolling && !subscription.isEmpty()) {
    const poller = MutableList.take(pollers)
    if (poller === MutableList.Empty) {
      removeSubscribers(subscribers, subscription, pollers)
      if (pollers.length === 0) {
        keepPolling = false
      } else {
        addSubscribers(subscribers, subscription, pollers)
      }
    } else {
      const pollResult = subscription.poll()
      if (pollResult === MutableList.Empty) {
        MutableList.prepend(pollers, poller)
      } else {
        Deferred.doneUnsafe(poller, Exit.succeed(pollResult))
        strategy.onPubSubEmptySpaceUnsafe(pubsub, subscribers)
      }
    }
  }
}

const strategyCompleteSubscribersUnsafe = <A>(
  strategy: PubSub.Strategy<A>,
  pubsub: PubSub.Atomic<A>,
  subscribers: PubSub.Subscribers<A>
): void => {
  for (
    const [subscription, pollersSet] of subscribers
  ) {
    for (const pollers of pollersSet) {
      strategy.completePollersUnsafe(pubsub, subscribers, subscription, pollers)
    }
  }
}

interface ReplayNode<A> {
  value: A | AbsentValue
  next: ReplayNode<A> | null
}

class ReplayBuffer<A> {
  readonly capacity: number
  head: ReplayNode<A> = { value: AbsentValue, next: null }
  tail: ReplayNode<A> = this.head
  size = 0
  index = 0

  constructor(capacity: number) {
    this.capacity = capacity
  }

  slide() {
    this.index++
  }
  offer(a: A): void {
    this.tail.value = a
    this.tail.next = {
      value: AbsentValue,
      next: null
    }
    this.tail = this.tail.next
    if (this.size === this.capacity) {
      this.head = this.head.next!
    } else {
      this.size += 1
    }
  }
  offerAll(as: Iterable<A>): void {
    for (const a of as) {
      this.offer(a)
    }
  }
}

class ReplayWindowImpl<A> implements PubSub.ReplayWindow<A> {
  head: ReplayNode<A>
  index: number
  remaining: number
  readonly buffer: ReplayBuffer<A>

  constructor(buffer: ReplayBuffer<A>) {
    this.buffer = buffer
    this.index = buffer.index
    this.remaining = buffer.size
    this.head = buffer.head
  }
  fastForward() {
    while (this.index < this.buffer.index) {
      this.head = this.head.next!
      this.index++
    }
  }
  take(): A | undefined {
    if (this.remaining === 0) {
      return undefined
    } else if (this.index < this.buffer.index) {
      this.fastForward()
    }
    this.remaining--
    const value = this.head.value
    this.head = this.head.next!
    return value as A
  }
  takeN(n: number): Array<A> {
    if (this.remaining === 0) {
      return []
    } else if (this.index < this.buffer.index) {
      this.fastForward()
    }
    const len = Math.min(n, this.remaining)
    const items = new Array(len)
    for (let i = 0; i < len; i++) {
      const value = this.head.value as A
      this.head = this.head.next!
      items[i] = value
    }
    this.remaining -= len
    return items
  }
  takeAll(): Array<A> {
    return this.takeN(this.remaining)
  }
}

const emptyReplayWindow: PubSub.ReplayWindow<never> = {
  remaining: 0,
  take: () => undefined,
  takeN: () => [],
  takeAll: () => []
}
