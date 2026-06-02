/**
 * The `TxPriorityQueue` module provides a mutable priority queue whose state is
 * stored in a transactional reference. Elements are kept in the order defined by
 * the `Order` supplied at construction time, and dequeue operations return the
 * first element according to that ordering.
 *
 * A `TxPriorityQueue<A>` is useful when multiple fibers coordinate through a
 * shared queue and the queue operation needs to compose with other
 * transactional state changes. Every operation returns an `Effect`; group
 * several queue operations with `Effect.tx` when the whole sequence must commit
 * or retry as one transaction.
 *
 * **Common tasks**
 *
 * - Create queues with {@link empty}, {@link fromIterable}, or {@link make}
 * - Insert values with {@link offer} and {@link offerAll}
 * - Read priority order with {@link peek}, {@link peekOption}, and
 *   {@link toArray}
 * - Remove values with {@link take}, {@link takeOption}, {@link takeAll}, and
 *   {@link takeUpTo}
 * - Keep or remove subsets with {@link retainIf} and {@link removeIf}
 *
 * **Gotchas**
 *
 * - `take` and `peek` retry when the queue is empty; use `takeOption` or
 *   `peekOption` when empty queues should be represented as `Option.none`.
 * - `Order.Number` is ascending, so lower numbers are dequeued first. Provide a
 *   reversed order when larger values should have higher priority.
 * - The queue preserves all values with equal priority; equal values are not
 *   merged or deduplicated.
 *
 * @since 4.0.0
 */

import type { Chunk } from "./Chunk.ts"
import * as C from "./Chunk.ts"
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import type { Inspectable } from "./Inspectable.ts"
import { NodeInspectSymbol, toJson } from "./Inspectable.ts"
import type { Option } from "./Option.ts"
import * as O from "./Option.ts"
import type { Order } from "./Order.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty, type Predicate } from "./Predicate.ts"
import * as TxRef from "./TxRef.ts"

const TypeId = "~effect/transactions/TxPriorityQueue"

/**
 * A transactional priority queue backed by a sorted `Chunk`.
 *
 * **Details**
 *
 * Elements are stored in ascending order according to the `Order` provided at
 * construction time. `take` returns the smallest element, `peek` observes it
 * without removing.
 *
 * **Example** (Dequeuing values by priority)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   yield* TxPriorityQueue.offer(pq, 3)
 *   yield* TxPriorityQueue.offer(pq, 1)
 *   yield* TxPriorityQueue.offer(pq, 2)
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface TxPriorityQueue<in out A> extends Inspectable, Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly ref: TxRef.TxRef<Chunk<A>>
  readonly ord: Order<A>
}

const TxPriorityQueueProto: Omit<TxPriorityQueue<unknown>, typeof TypeId | "ref" | "ord"> = {
  [NodeInspectSymbol](this: TxPriorityQueue<unknown>) {
    return toJson(this)
  },
  toJSON(this: TxPriorityQueue<unknown>) {
    return {
      _id: "TxPriorityQueue"
    }
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const makeTxPriorityQueue = <A>(ref: TxRef.TxRef<Chunk<A>>, ord: Order<A>): TxPriorityQueue<A> => {
  const self = Object.create(TxPriorityQueueProto)
  self[TypeId] = TypeId
  self.ref = ref
  self.ord = ord
  return self
}

const insertSorted = <A>(chunk: Chunk<A>, value: A, ord: Order<A>): Chunk<A> => {
  const arr = C.toArray(chunk) as Array<A>
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ord(arr[mid], value) <= 0) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  const out = Array(arr.length + 1) as Array<A>
  for (let i = 0; i < lo; i++) out[i] = arr[i]
  out[lo] = value
  for (let i = lo; i < arr.length; i++) out[i + 1] = arr[i]
  return C.fromIterable(out)
}

/**
 * Creates an empty `TxPriorityQueue` with the given ordering.
 *
 * **Example** (Creating an empty priority queue)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   const empty = yield* TxPriorityQueue.isEmpty(pq)
 *   console.log(empty) // true
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const empty = <A>(order: Order<A>): Effect.Effect<TxPriorityQueue<A>> =>
  Effect.map(TxRef.make<Chunk<A>>(C.empty()), (ref) => makeTxPriorityQueue(ref, order))

/**
 * Creates a `TxPriorityQueue` from an iterable of elements.
 *
 * **Example** (Creating a priority queue from an iterable)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [3, 1, 2])
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const fromIterable: {
  <A>(order: Order<A>): (iterable: Iterable<A>) => Effect.Effect<TxPriorityQueue<A>>
  <A>(order: Order<A>, iterable: Iterable<A>): Effect.Effect<TxPriorityQueue<A>>
} = dual(
  2,
  <A>(order: Order<A>, iterable: Iterable<A>): Effect.Effect<TxPriorityQueue<A>> => {
    const arr = Array.from(iterable).sort((a, b) => order(a, b))
    return Effect.map(
      TxRef.make<Chunk<A>>(C.fromIterable(arr)),
      (ref) => makeTxPriorityQueue(ref, order)
    )
  }
)

/**
 * Creates a `TxPriorityQueue` from variadic elements.
 *
 * **Example** (Creating a priority queue from variadic values)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.make(Order.Number)(3, 1, 2)
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const make = <A>(order: Order<A>) => (...elements: Array<A>): Effect.Effect<TxPriorityQueue<A>> =>
  fromIterable(order, elements)

/**
 * Returns the number of elements in the queue.
 *
 * **Example** (Getting the queue size)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [1, 2, 3])
 *   const s = yield* TxPriorityQueue.size(pq)
 *   console.log(s) // 3
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const size = <A>(self: TxPriorityQueue<A>): Effect.Effect<number> => Effect.map(TxRef.get(self.ref), C.size)

/**
 * Returns `true` if the queue is empty.
 *
 * **Example** (Checking whether a queue is empty)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   const empty = yield* TxPriorityQueue.isEmpty(pq)
 *   console.log(empty) // true
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const isEmpty = <A>(self: TxPriorityQueue<A>): Effect.Effect<boolean> => Effect.map(size(self), (n) => n === 0)

/**
 * Returns `true` if the queue has at least one element.
 *
 * **Example** (Checking whether a queue has elements)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [1])
 *   const nonEmpty = yield* TxPriorityQueue.isNonEmpty(pq)
 *   console.log(nonEmpty) // true
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const isNonEmpty = <A>(self: TxPriorityQueue<A>): Effect.Effect<boolean> => Effect.map(size(self), (n) => n > 0)

/**
 * Observes the smallest element without removing it.
 *
 * **When to use**
 *
 * Use to inspect the next prioritized value and retry transactionally while
 * the queue is empty.
 *
 * **Example** (Peeking at the next value)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [3, 1, 2])
 *   const top = yield* TxPriorityQueue.peek(pq)
 *   console.log(top) // 1
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const peek = <A>(self: TxPriorityQueue<A>): Effect.Effect<A> =>
  Effect.gen(function*() {
    const chunk = yield* TxRef.get(self.ref)
    const head = C.head(chunk)
    if (O.isNone(head)) {
      return yield* Effect.txRetry
    }
    return head.value
  }).pipe(Effect.tx)

/**
 * Observes the smallest element without removing it, returning `None` when the
 * queue is empty.
 *
 * **When to use**
 *
 * Use to inspect the next prioritized value without retrying on an empty queue.
 *
 * **Example** (Peeking without retrying)
 *
 * ```ts
 * import { Effect, Option, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   const result = yield* TxPriorityQueue.peekOption(pq)
 *   console.log(Option.isNone(result)) // true
 * })
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const peekOption = <A>(self: TxPriorityQueue<A>): Effect.Effect<Option<A>> =>
  Effect.map(TxRef.get(self.ref), C.head)

/**
 * Inserts an element into the queue in sorted position.
 *
 * **Example** (Offering a value)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   yield* TxPriorityQueue.offer(pq, 2)
 *   yield* TxPriorityQueue.offer(pq, 1)
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const offer: {
  <A>(value: A): (self: TxPriorityQueue<A>) => Effect.Effect<void>
  <A>(self: TxPriorityQueue<A>, value: A): Effect.Effect<void>
} = dual(
  2,
  <A>(self: TxPriorityQueue<A>, value: A): Effect.Effect<void> =>
    TxRef.update(self.ref, (chunk) => insertSorted(chunk, value, self.ord))
)

/**
 * Inserts all elements from an iterable into the queue.
 *
 * **Example** (Offering multiple values)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   yield* TxPriorityQueue.offerAll(pq, [3, 1, 2])
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const offerAll: {
  <A>(values: Iterable<A>): (self: TxPriorityQueue<A>) => Effect.Effect<void>
  <A>(self: TxPriorityQueue<A>, values: Iterable<A>): Effect.Effect<void>
} = dual(
  2,
  <A>(self: TxPriorityQueue<A>, values: Iterable<A>): Effect.Effect<void> =>
    TxRef.update(self.ref, (chunk) => {
      const arr = [...C.toArray(chunk), ...values].sort((a, b) => self.ord(a, b))
      return C.fromIterable(arr)
    })
)

/**
 * Takes the smallest element from the queue. Retries if the queue is empty.
 *
 * **Example** (Taking the next value)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [3, 1, 2])
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const take = <A>(self: TxPriorityQueue<A>): Effect.Effect<A> =>
  Effect.gen(function*() {
    const chunk = yield* TxRef.get(self.ref)
    const head = C.head(chunk)
    if (O.isNone(head)) {
      return yield* Effect.txRetry
    }
    yield* TxRef.set(self.ref, C.drop(chunk, 1))
    return head.value
  }).pipe(Effect.tx)

/**
 * Takes all elements from the queue, returning them in priority order.
 *
 * **Example** (Taking all values in priority order)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [3, 1, 2])
 *   const all = yield* TxPriorityQueue.takeAll(pq)
 *   console.log(all) // [1, 2, 3]
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const takeAll = <A>(self: TxPriorityQueue<A>): Effect.Effect<Array<A>> =>
  Effect.map(
    TxRef.modify(self.ref, (chunk) => [chunk, C.empty()]),
    C.toArray
  )

/**
 * Tries to take the smallest element. Returns `None` if the queue is empty.
 *
 * **Example** (Taking without retrying)
 *
 * ```ts
 * import { Effect, Option, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   const result = yield* TxPriorityQueue.takeOption(pq)
 *   console.log(Option.isNone(result)) // true
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const takeOption = <A>(self: TxPriorityQueue<A>): Effect.Effect<Option<A>> =>
  TxRef.modify(self.ref, (chunk) => {
    const head = C.head(chunk)
    if (O.isNone(head)) {
      return [O.none<A>(), chunk]
    }
    return [O.some(head.value), C.drop(chunk, 1)]
  })

/**
 * Takes up to `n` elements from the queue in priority order.
 *
 * **Example** (Taking up to a limit)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [5, 3, 1, 4, 2])
 *   const top2 = yield* TxPriorityQueue.takeUpTo(pq, 2)
 *   console.log(top2) // [1, 2]
 * })
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const takeUpTo: {
  (n: number): <A>(self: TxPriorityQueue<A>) => Effect.Effect<Array<A>>
  <A>(self: TxPriorityQueue<A>, n: number): Effect.Effect<Array<A>>
} = dual(
  2,
  <A>(self: TxPriorityQueue<A>, n: number): Effect.Effect<Array<A>> =>
    Effect.map(
      TxRef.modify(self.ref, (chunk) => {
        const taken = C.take(chunk, n)
        const rest = C.drop(chunk, n)
        return [taken, rest]
      }),
      C.toArray
    )
)

/**
 * Removes elements matching the predicate.
 *
 * **Example** (Removing matching values)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [1, 2, 3, 4, 5])
 *   yield* TxPriorityQueue.removeIf(pq, (n) => n % 2 === 0)
 *   const all = yield* TxPriorityQueue.takeAll(pq)
 *   console.log(all) // [1, 3, 5]
 * })
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const removeIf: {
  <A>(predicate: Predicate<A>): (self: TxPriorityQueue<A>) => Effect.Effect<void>
  <A>(self: TxPriorityQueue<A>, predicate: Predicate<A>): Effect.Effect<void>
} = dual(
  2,
  <A>(self: TxPriorityQueue<A>, predicate: Predicate<A>): Effect.Effect<void> =>
    TxRef.update(self.ref, (chunk) => C.filter(chunk, (a) => !predicate(a)))
)

/**
 * Keeps only elements matching the predicate.
 *
 * **Example** (Retaining matching values)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [1, 2, 3, 4, 5])
 *   yield* TxPriorityQueue.retainIf(pq, (n) => n % 2 === 0)
 *   const all = yield* TxPriorityQueue.takeAll(pq)
 *   console.log(all) // [2, 4]
 * })
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const retainIf: {
  <A>(predicate: Predicate<A>): (self: TxPriorityQueue<A>) => Effect.Effect<void>
  <A>(self: TxPriorityQueue<A>, predicate: Predicate<A>): Effect.Effect<void>
} = dual(
  2,
  <A>(self: TxPriorityQueue<A>, predicate: Predicate<A>): Effect.Effect<void> =>
    TxRef.update(self.ref, (chunk) => C.filter(chunk, predicate))
)

/**
 * Returns all elements in priority order without removing them.
 *
 * **Example** (Reading values in priority order)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [3, 1, 2])
 *   const all = yield* TxPriorityQueue.toArray(pq)
 *   console.log(all) // [1, 2, 3]
 * })
 * ```
 *
 * @category converting
 * @since 2.0.0
 */
export const toArray = <A>(self: TxPriorityQueue<A>): Effect.Effect<Array<A>> =>
  Effect.map(TxRef.get(self.ref), C.toArray)

/**
 * Determines if the provided value is a `TxPriorityQueue`.
 *
 * **Example** (Checking for a TxPriorityQueue)
 *
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   console.log(TxPriorityQueue.isTxPriorityQueue(pq)) // true
 *   console.log(TxPriorityQueue.isTxPriorityQueue("nope")) // false
 * })
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isTxPriorityQueue = (u: unknown): u is TxPriorityQueue<unknown> => hasProperty(u, TypeId)
