/**
 * The `MutableList` module provides a mutable linked list for accumulating,
 * ordering, inspecting, and draining values with efficient operations at both
 * ends of the list.
 *
 * A `MutableList<A>` stores values in linked buckets of arrays. Appending adds
 * values to the tail, prepending adds values to the head, and taking removes
 * values from the head. Unlike persistent collections, every mutation updates
 * the list object in place: operations such as {@link append}, {@link prepend},
 * {@link take}, {@link takeN}, {@link clear}, {@link filter}, and {@link remove}
 * change the same `MutableList` instance and update its `length`.
 *
 * **Mental model**
 *
 * - `MutableList<A>` is a stateful container with `head`, `tail`, and `length`
 * - Values are consumed from the head with {@link take}, {@link takeN}, or
 *   {@link takeAll}
 * - {@link append} and {@link appendAll} preserve FIFO queue order for normal
 *   producer-consumer use cases
 * - {@link prepend} and {@link prependAll} place values before the current
 *   contents, which is useful for priority work or restoring items to the front
 * - {@link toArray} and {@link toArrayN} copy values without modifying the list
 * - The `head` and `tail` bucket fields are exposed for advanced use, but most
 *   code should treat them as implementation details
 *
 * **Common tasks**
 *
 * - Create an empty list: {@link make}
 * - Add one value: {@link append}, {@link prepend}
 * - Add many values: {@link appendAll}, {@link prependAll}
 * - Drain one value: {@link take}
 * - Drain many values: {@link takeN}, {@link takeAll}
 * - Inspect without draining: {@link toArrayN}, {@link toArray}
 * - Reset the list: {@link clear}
 * - Mutate contents in place: {@link filter}, {@link remove}
 *
 * **Gotchas**
 *
 * - `MutableList` is intentionally mutable; sharing a list means sharing its
 *   changing state
 * - {@link take} returns the {@link Empty} symbol when the list has no value, so
 *   compare with `MutableList.Empty` instead of relying on falsy checks
 * - {@link appendAllUnsafe} and {@link prependAllUnsafe} may reuse the provided
 *   array when `mutable` is `true`; only enable that optimization when callers
 *   will not keep using the array independently
 * - {@link remove} uses JavaScript strict equality semantics, not structural
 *   equality
 *
 * @since 4.0.0
 */
import * as Arr from "./Array.ts"

/**
 * A mutable linked list data structure optimized for high-throughput operations.
 * MutableList provides efficient append/prepend operations and is ideal for
 * producer-consumer patterns, queues, and streaming scenarios.
 *
 * **Example** (Creating and consuming a mutable list)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * // Create a mutable list
 * const list: MutableList.MutableList<number> = MutableList.make()
 *
 * // Add elements
 * MutableList.append(list, 1)
 * MutableList.append(list, 2)
 * MutableList.prepend(list, 0)
 *
 * // Access properties
 * console.log(list.length) // 3
 * console.log(list.head?.array) // Contains elements from head bucket
 * console.log(list.tail?.array) // Contains elements from tail bucket
 *
 * // Take elements
 * console.log(MutableList.take(list)) // 0
 * console.log(MutableList.take(list)) // 1
 * console.log(MutableList.take(list)) // 2
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface MutableList<in out A> {
  head: MutableList.Bucket<A> | undefined
  tail: MutableList.Bucket<A> | undefined
  length: number
}

/**
 * The MutableList namespace contains type definitions and utilities for working
 * with mutable linked lists.
 *
 * **Example** (Typing queue processors)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * // Type annotation using the namespace
 * const processQueue = (queue: MutableList.MutableList<string>) => {
 *   while (queue.length > 0) {
 *     const item = MutableList.take(queue)
 *     if (item !== MutableList.Empty) {
 *       console.log("Processing:", item)
 *     }
 *   }
 * }
 *
 * // Using the namespace for type definitions
 * const createProcessor = <T>(): {
 *   queue: MutableList.MutableList<T>
 *   add: (item: T) => void
 *   process: () => Array<T>
 * } => {
 *   const queue = MutableList.make<T>()
 *   return {
 *     queue,
 *     add: (item) => MutableList.append(queue, item),
 *     process: () => MutableList.takeAll(queue)
 *   }
 * }
 * ```
 *
 * @since 2.0.0
 */
export declare namespace MutableList {
  /**
   * Storage node used by the exposed `head` and `tail` fields of a
   * `MutableList`.
   *
   * **Details**
   *
   * Most code should treat buckets as an implementation detail and use
   * `MutableList` operations such as `append`, `prepend`, and `take` instead
   * of constructing or mutating buckets directly.
   *
   * **Example** (Inspecting buckets)
   *
   * ```ts
   * import { MutableList } from "effect"
   *
   * const list = MutableList.make<number>()
   * MutableList.append(list, 1)
   * MutableList.append(list, 2)
   *
   * // Access bucket information (for debugging or advanced usage)
   * const inspectBucket = (
   *   bucket: MutableList.MutableList.Bucket<number> | undefined
   * ) => {
   *   if (bucket) {
   *     console.log("Bucket array:", bucket.array)
   *     console.log("Bucket offset:", bucket.offset)
   *     console.log("Bucket mutable:", bucket.mutable)
   *     console.log("Has next bucket:", bucket.next !== undefined)
   *   }
   * }
   *
   * inspectBucket(list.head)
   * inspectBucket(list.tail)
   * ```
   *
   * @category models
   * @since 4.0.0
   */
  export interface Bucket<A> {
    readonly array: Array<A>
    mutable: boolean
    offset: number
    next: Bucket<A> | undefined
  }
}

/**
 * Defines the unique symbol used to represent an empty result when taking elements from a MutableList.
 * This symbol is returned by `take` when the list is empty, allowing for safe type checking.
 *
 * **When to use**
 *
 * Use to detect that `take` returned no element before handling the result as a
 * list item.
 *
 * **Example** (Checking for empty results)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<string>()
 *
 * // Take from empty list returns Empty symbol
 * const result = MutableList.take(list)
 * console.log(result === MutableList.Empty) // true
 *
 * // Safe pattern for checking emptiness
 * const processNext = (queue: MutableList.MutableList<string>) => {
 *   const item = MutableList.take(queue)
 *   if (item === MutableList.Empty) {
 *     console.log("Queue is empty")
 *     return null
 *   }
 *   return item.toUpperCase()
 * }
 *
 * // Compare with other empty results
 * MutableList.append(list, "hello")
 * const next = MutableList.take(list)
 * console.log(next !== MutableList.Empty) // true, got "hello"
 *
 * const empty = MutableList.take(list)
 * console.log(empty === MutableList.Empty) // true, list is empty
 * ```
 *
 * @category symbols
 * @since 4.0.0
 */
export const Empty: unique symbol = Symbol.for("effect/MutableList/Empty")

/**
 * The type of the Empty symbol, used for type checking when taking elements from a MutableList.
 * This provides compile-time safety when checking for empty results.
 *
 * **Example** (Handling empty results type-safely)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<number>()
 *
 * // Type-safe handling of empty results
 * const takeAndDouble = (
 *   queue: MutableList.MutableList<number>
 * ): number | null => {
 *   const item: number | MutableList.Empty = MutableList.take(queue)
 *
 *   if (item === MutableList.Empty) {
 *     return null
 *   }
 *
 *   // TypeScript knows item is number here
 *   return item * 2
 * }
 *
 * console.log(takeAndDouble(list)) // null (empty list)
 *
 * MutableList.append(list, 5)
 * console.log(takeAndDouble(list)) // 10
 *
 * // Type guard function
 * const isEmpty = (
 *   result: number | MutableList.Empty
 * ): result is MutableList.Empty => {
 *   return result === MutableList.Empty
 * }
 *
 * const value = MutableList.take(list)
 * if (isEmpty(value)) {
 *   console.log("List is empty")
 * } else {
 *   console.log("Got value:", value)
 * }
 * ```
 *
 * @category symbols
 * @since 4.0.0
 */
export type Empty = typeof Empty

/**
 * Creates an empty MutableList.
 *
 * **Example** (Creating an empty mutable list)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<string>()
 *
 * // Add elements
 * MutableList.append(list, "first")
 * MutableList.append(list, "second")
 * MutableList.prepend(list, "beginning")
 *
 * console.log(list.length) // 3
 *
 * // Take elements in FIFO order (from head)
 * console.log(MutableList.take(list)) // "beginning"
 * console.log(MutableList.take(list)) // "first"
 * console.log(MutableList.take(list)) // "second"
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const make = <A>(): MutableList<A> => ({
  head: undefined,
  tail: undefined,
  length: 0
})

const emptyBucket = <A = never>(): MutableList.Bucket<A> => ({
  array: [],
  mutable: true,
  offset: 0,
  next: undefined
})

/**
 * Appends an element to the end of the MutableList.
 * This operation is optimized for high-frequency usage.
 *
 * **Example** (Appending elements)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<number>()
 *
 * // Append elements one by one
 * MutableList.append(list, 1)
 * MutableList.append(list, 2)
 * MutableList.append(list, 3)
 *
 * console.log(list.length) // 3
 *
 * // Elements are taken from head (FIFO)
 * console.log(MutableList.take(list)) // 1
 * console.log(MutableList.take(list)) // 2
 * console.log(MutableList.take(list)) // 3
 *
 * // High-throughput usage
 * for (let i = 0; i < 10000; i++) {
 *   MutableList.append(list, i)
 * }
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const append = <A>(self: MutableList<A>, message: A): void => {
  if (!self.tail) {
    self.head = self.tail = emptyBucket()
  } else if (!self.tail.mutable) {
    self.tail.next = emptyBucket()
    self.tail = self.tail.next
  }
  self.tail!.array.push(message)
  self.length++
}

/**
 * Prepends an element to the beginning of the MutableList.
 * This operation is optimized for high-frequency usage.
 *
 * **Example** (Prepending elements)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<string>()
 *
 * // Prepend elements (they'll be at the front)
 * MutableList.prepend(list, "third")
 * MutableList.prepend(list, "second")
 * MutableList.prepend(list, "first")
 *
 * console.log(list.length) // 3
 *
 * // Elements taken from head (most recently prepended first)
 * console.log(MutableList.take(list)) // "first"
 * console.log(MutableList.take(list)) // "second"
 * console.log(MutableList.take(list)) // "third"
 *
 * // Use case: priority items or stack-like behavior
 * MutableList.append(list, "normal")
 * MutableList.prepend(list, "priority") // This will be taken first
 * console.log(MutableList.take(list)) // "priority"
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const prepend = <A>(self: MutableList<A>, message: A): void => {
  self.head = {
    array: [message],
    mutable: true,
    offset: 0,
    next: self.head
  }
  self.length++
}

/**
 * Prepends all elements from an iterable to the beginning of the MutableList.
 * The elements are added in order, so the first element in the iterable becomes
 * the new head of the list.
 *
 * **Example** (Prepending multiple elements)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<number>()
 * MutableList.append(list, 4)
 * MutableList.append(list, 5)
 *
 * // Prepend multiple elements
 * MutableList.prependAll(list, [1, 2, 3])
 *
 * console.log(list.length) // 5
 *
 * // Elements are taken in order: [1, 2, 3, 4, 5]
 * console.log(MutableList.takeAll(list)) // [1, 2, 3, 4, 5]
 *
 * // Works with any iterable
 * const newList = MutableList.make<string>()
 * MutableList.prependAll(newList, "hello") // Prepends each character
 * console.log(MutableList.takeAll(newList)) // ["h", "e", "l", "l", "o"]
 * ```
 *
 * @category mutations
 * @since 4.0.0
 */
export const prependAll = <A>(self: MutableList<A>, messages: Iterable<A>): void =>
  prependAllUnsafe(self, Arr.fromIterable(messages), !Array.isArray(messages))

/**
 * Prepends all elements from a ReadonlyArray to the beginning of the MutableList.
 * This is an optimized version that can reuse the array when mutable=true.
 *
 * **Gotchas**
 *
 * When mutable=true, the input array may be modified internally. Only use
 * mutable=true when you control the array lifecycle.
 *
 * **Example** (Prepending arrays with optional mutation)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<number>()
 * MutableList.append(list, 4)
 *
 * // Safe usage (default mutable=false)
 * const items = [1, 2, 3]
 * MutableList.prependAllUnsafe(list, items)
 * console.log(items) // [1, 2, 3] - unchanged
 *
 * // Unsafe but efficient usage (mutable=true)
 * const mutableItems = [10, 20, 30]
 * MutableList.prependAllUnsafe(list, mutableItems, true)
 * // mutableItems may be modified internally for efficiency
 *
 * console.log(MutableList.takeAll(list)) // [10, 20, 30, 1, 2, 3, 4]
 * ```
 *
 * @category mutations
 * @since 4.0.0
 */
export const prependAllUnsafe = <A>(self: MutableList<A>, messages: ReadonlyArray<A>, mutable = false): void => {
  self.head = {
    array: messages as Array<A>,
    mutable,
    offset: 0,
    next: self.head
  }
  self.length += self.head.array.length
}

/**
 * Appends all elements from an iterable to the end of the MutableList.
 * Returns the number of elements added.
 *
 * **Example** (Appending multiple elements)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<number>()
 * MutableList.append(list, 1)
 * MutableList.append(list, 2)
 *
 * // Append multiple elements
 * const added = MutableList.appendAll(list, [3, 4, 5])
 * console.log(added) // 3
 * console.log(list.length) // 5
 *
 * // Elements maintain order: [1, 2, 3, 4, 5]
 * console.log(MutableList.takeAll(list)) // [1, 2, 3, 4, 5]
 *
 * // Works with any iterable
 * const newList = MutableList.make<string>()
 * MutableList.appendAll(newList, new Set(["a", "b", "c"]))
 * console.log(MutableList.takeAll(newList)) // ["a", "b", "c"]
 *
 * // Useful for bulk loading
 * const bulkList = MutableList.make<number>()
 * const count = MutableList.appendAll(
 *   bulkList,
 *   Array.from({ length: 1000 }, (_, i) => i)
 * )
 * console.log(count) // 1000
 * ```
 *
 * @category mutations
 * @since 4.0.0
 */
export const appendAll = <A>(self: MutableList<A>, messages: Iterable<A>): number =>
  appendAllUnsafe(self, Arr.fromIterable(messages), !Array.isArray(messages))

/**
 * Appends all elements from a ReadonlyArray to the end of the MutableList.
 * This is an optimized version that can reuse the array when mutable=true.
 * Returns the number of elements added.
 *
 * **Gotchas**
 *
 * When mutable=true, the input array may be modified internally. Only use
 * mutable=true when you control the array lifecycle.
 *
 * **Example** (Appending arrays with optional mutation)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<number>()
 * MutableList.append(list, 1)
 *
 * // Safe usage (default mutable=false)
 * const items = [2, 3, 4]
 * const added = MutableList.appendAllUnsafe(list, items)
 * console.log(added) // 3
 * console.log(items) // [2, 3, 4] - unchanged
 *
 * // Unsafe but efficient usage (mutable=true)
 * const mutableItems = [5, 6, 7]
 * MutableList.appendAllUnsafe(list, mutableItems, true)
 * // mutableItems may be modified internally for efficiency
 *
 * console.log(MutableList.takeAll(list)) // [1, 2, 3, 4, 5, 6, 7]
 *
 * // High-performance bulk operations
 * const bigArray = new Array(10000).fill(0).map((_, i) => i)
 * MutableList.appendAllUnsafe(list, bigArray, true) // Very efficient
 * ```
 *
 * @category mutations
 * @since 4.0.0
 */
export const appendAllUnsafe = <A>(self: MutableList<A>, messages: ReadonlyArray<A>, mutable = false): number => {
  if (messages.length === 0) {
    return 0
  }
  const chunk: MutableList.Bucket<A> = {
    array: messages as Array<A>,
    mutable,
    offset: 0,
    next: undefined
  }
  if (self.head) {
    self.tail = self.tail!.next = chunk
  } else {
    self.head = self.tail = chunk
  }
  self.length += messages.length
  return messages.length
}

/**
 * Removes all elements from the MutableList, resetting it to an empty state.
 * This operation is highly optimized and releases all internal memory.
 *
 * **Example** (Clearing a mutable list)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<number>()
 * MutableList.appendAll(list, [1, 2, 3, 4, 5])
 *
 * console.log(list.length) // 5
 *
 * // Clear all elements
 * MutableList.clear(list)
 *
 * console.log(list.length) // 0
 * console.log(MutableList.take(list)) // Empty
 *
 * // Can still use the list after clearing
 * MutableList.append(list, 42)
 * console.log(list.length) // 1
 *
 * // Useful for resetting queues or buffers
 * function resetBuffer<T>(buffer: MutableList.MutableList<T>) {
 *   MutableList.clear(buffer)
 *   console.log("Buffer cleared and ready for reuse")
 * }
 * ```
 *
 * @category mutations
 * @since 4.0.0
 */
export const clear = <A>(self: MutableList<A>): void => {
  self.head = self.tail = undefined
  self.length = 0
}

/**
 * Takes up to N elements from the beginning of the MutableList and returns them as an array.
 * The taken elements are removed from the list. This operation is optimized for performance
 * and includes zero-copy optimizations when possible.
 *
 * **Example** (Taking batches)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<number>()
 * MutableList.appendAll(list, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
 *
 * console.log(list.length) // 10
 *
 * // Take first 3 elements
 * const first3 = MutableList.takeN(list, 3)
 * console.log(first3) // [1, 2, 3]
 * console.log(list.length) // 7
 *
 * // Take more than available
 * const remaining = MutableList.takeN(list, 20)
 * console.log(remaining) // [4, 5, 6, 7, 8, 9, 10]
 * console.log(list.length) // 0
 *
 * // Take from empty list
 * const empty = MutableList.takeN(list, 5)
 * console.log(empty) // []
 *
 * // Batch processing pattern
 * const queue = MutableList.make<string>()
 * MutableList.appendAll(queue, ["task1", "task2", "task3", "task4", "task5"])
 *
 * while (queue.length > 0) {
 *   const batch = MutableList.takeN(queue, 2) // Process 2 at a time
 *   console.log("Processing batch:", batch)
 * }
 * ```
 *
 * @category elements
 * @since 4.0.0
 */
export const takeN = <A>(self: MutableList<A>, n: number): Array<A> => {
  if (n <= 0 || !self.head) return []
  n = Math.min(n, self.length)
  if (n === self.length && self.head?.offset === 0 && !self.head.next) {
    const array = self.head.array
    clear(self)
    return array
  }
  const array = new Array<A>(n)
  let index = 0
  let chunk: MutableList.Bucket<A> | undefined = self.head
  while (chunk) {
    while (chunk.offset < chunk.array.length) {
      array[index++] = chunk.array[chunk.offset]
      if (chunk.mutable) chunk.array[chunk.offset] = undefined as any
      chunk.offset++
      if (index === n) {
        self.head = chunk
        self.length -= n
        if (self.length === 0) clear(self)
        return array
      }
    }
    chunk = chunk.next
  }
  clear(self)
  return array
}

/**
 * Removes up to `n` elements from the beginning of the `MutableList` without
 * returning them.
 *
 * **When to use**
 *
 * Use to discard a bounded number of values from the head of a `MutableList`
 * when the removed values are not needed.
 *
 * **Details**
 *
 * If `n` is less than or equal to zero, or the list is empty, the list is left
 * unchanged. If `n` is greater than or equal to the current length, the list is
 * cleared.
 *
 * @see {@link takeN} for removing up to `n` values and returning them as an array
 * @see {@link clear} for removing every value from the list
 *
 * @category elements
 * @since 4.0.0
 */
export const takeNVoid = <A>(self: MutableList<A>, n: number): void => {
  if (n <= 0 || !self.head) return
  n = Math.min(n, self.length)
  if (n === self.length && self.head?.offset === 0 && !self.head.next) {
    clear(self)
    return
  }
  let count = 0
  let chunk: MutableList.Bucket<A> | undefined = self.head
  while (chunk) {
    const size = chunk.array.length - chunk.offset
    if (count + size > n) {
      chunk.offset += n - count
      self.head = chunk
      self.length -= n
      return
    }
    count += size
    chunk = chunk.next
  }
  clear(self)
  return
}

/**
 * Takes all elements from the MutableList and returns them as an array.
 * The list becomes empty after this operation. This is equivalent to takeN(list, list.length).
 *
 * **Example** (Draining all elements)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<string>()
 * MutableList.appendAll(list, ["apple", "banana", "cherry"])
 *
 * console.log(list.length) // 3
 *
 * // Take all elements
 * const allItems = MutableList.takeAll(list)
 * console.log(allItems) // ["apple", "banana", "cherry"]
 * console.log(list.length) // 0
 *
 * // Useful for converting to array and clearing
 * const queue = MutableList.make<number>()
 * MutableList.appendAll(queue, [1, 2, 3, 4, 5])
 *
 * const snapshot = MutableList.takeAll(queue)
 * console.log("Queue contents:", snapshot)
 * console.log("Queue is now empty:", queue.length === 0)
 *
 * // Drain pattern for processing
 * function drainAndProcess<T>(
 *   list: MutableList.MutableList<T>,
 *   processor: (items: Array<T>) => void
 * ) {
 *   if (list.length > 0) {
 *     const items = MutableList.takeAll(list)
 *     processor(items)
 *   }
 * }
 * ```
 *
 * @category elements
 * @since 4.0.0
 */
export const takeAll = <A>(self: MutableList<A>): Array<A> => takeN(self, self.length)

/**
 * Takes a single element from the beginning of the MutableList.
 * Returns the element if available, or the Empty symbol if the list is empty.
 * The taken element is removed from the list.
 *
 * **Example** (Taking one element)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<string>()
 * MutableList.appendAll(list, ["first", "second", "third"])
 *
 * // Take elements one by one
 * console.log(MutableList.take(list)) // "first"
 * console.log(list.length) // 2
 *
 * console.log(MutableList.take(list)) // "second"
 * console.log(MutableList.take(list)) // "third"
 * console.log(list.length) // 0
 *
 * // Take from empty list
 * console.log(MutableList.take(list)) // Empty symbol
 *
 * // Check for empty using the Empty symbol
 * const result = MutableList.take(list)
 * if (result === MutableList.Empty) {
 *   console.log("List is empty")
 * } else {
 *   console.log("Got element:", result)
 * }
 *
 * // Consumer pattern
 * function processNext<T>(
 *   queue: MutableList.MutableList<T>,
 *   processor: (item: T) => void
 * ): boolean {
 *   const item = MutableList.take(queue)
 *   if (item !== MutableList.Empty) {
 *     processor(item)
 *     return true
 *   }
 *   return false
 * }
 * ```
 *
 * @category elements
 * @since 4.0.0
 */
export const take = <A>(self: MutableList<A>): Empty | A => {
  if (!self.head) return Empty
  const message = self.head.array[self.head.offset]
  if (self.head.mutable) self.head.array[self.head.offset] = undefined as any
  self.head.offset++
  self.length--
  if (self.head.offset === self.head.array.length) {
    if (self.head.next) {
      self.head = self.head.next
    } else {
      clear(self)
    }
  }
  return message
}

/**
 * Copies up to `n` elements from the beginning of the `MutableList` into a new
 * array without modifying the list.
 *
 * **When to use**
 *
 * Use when you need to inspect or snapshot a bounded prefix of the list without
 * consuming it.
 *
 * @see {@link takeN} for removing up to `n` values and returning them as an array
 *
 * @category elements
 * @since 4.0.0
 */
export const toArrayN = <A>(self: MutableList<A>, n: number): Array<A> => {
  const length = Math.min(n, self.length)
  const out = new Array<A>(length)
  let index = 0
  let bucket = self.head
  while (bucket) {
    for (let i = bucket.offset; i < bucket.array.length; i++) {
      out[index++] = bucket.array[i]
      if (index === length) return out
    }
    bucket = bucket.next
  }
  return out
}

/**
 * Copies all current elements of the `MutableList` into a new array without
 * modifying the list.
 *
 * **When to use**
 *
 * Use when you need a snapshot of all current elements while keeping the list
 * unchanged.
 *
 * @see {@link takeAll} for converting all elements to an array and clearing the list
 *
 * @category elements
 * @since 4.0.0
 */
export const toArray = <A>(self: MutableList<A>): Array<A> => toArrayN(self, self.length)

/**
 * Filters the MutableList in place, keeping only elements that satisfy the predicate.
 * This operation modifies the list and rebuilds its internal structure for efficiency.
 *
 * **Example** (Filtering in place)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<number>()
 * MutableList.appendAll(list, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
 *
 * console.log(list.length) // 10
 *
 * // Keep only even numbers
 * MutableList.filter(list, (n) => n % 2 === 0)
 *
 * console.log(MutableList.takeAll(list)) // [2, 4, 6, 8, 10]
 *
 * // Filter with index
 * const indexed = MutableList.make<string>()
 * MutableList.appendAll(indexed, ["a", "b", "c", "d", "e"])
 *
 * // Keep elements at even indices
 * MutableList.filter(indexed, (value, index) => index % 2 === 0)
 * console.log(MutableList.takeAll(indexed)) // ["a", "c", "e"]
 *
 * // Real-world example: filtering a log queue
 * const logs = MutableList.make<{ level: string; message: string }>()
 * MutableList.appendAll(logs, [
 *   { level: "INFO", message: "App started" },
 *   { level: "ERROR", message: "Connection failed" },
 *   { level: "DEBUG", message: "Cache hit" },
 *   { level: "ERROR", message: "Timeout" }
 * ])
 *
 * // Keep only errors
 * MutableList.filter(logs, (log) => log.level === "ERROR")
 * console.log(MutableList.takeAll(logs).map((log) => log.message)) // ["Connection failed", "Timeout"]
 * ```
 *
 * @category mutations
 * @since 4.0.0
 */
export const filter = <A>(self: MutableList<A>, f: (value: A, i: number) => boolean): void => {
  const array: Array<A> = []
  let chunk: MutableList.Bucket<A> | undefined = self.head
  while (chunk) {
    for (let i = chunk.offset; i < chunk.array.length; i++) {
      if (f(chunk.array[i], i)) {
        array.push(chunk.array[i])
      }
    }
    chunk = chunk.next
  }
  self.head = self.tail = {
    array,
    mutable: true,
    offset: 0,
    next: undefined
  }
  self.length = array.length
}

/**
 * Removes all occurrences of a value from the `MutableList` using JavaScript
 * strict equality semantics.
 *
 * **Details**
 *
 * The list is modified in place.
 *
 * **Gotchas**
 *
 * Values are compared with `!==`, so this does not use Effect structural
 * equality.
 *
 * **Example** (Removing matching values)
 *
 * ```ts
 * import { MutableList } from "effect"
 *
 * const list = MutableList.make<string>()
 * MutableList.appendAll(list, ["apple", "banana", "apple", "cherry", "apple"])
 *
 * console.log(list.length) // 5
 *
 * // Remove all occurrences of "apple"
 * MutableList.remove(list, "apple")
 *
 * console.log(MutableList.takeAll(list)) // ["banana", "cherry"]
 *
 * // Remove non-existent value (no effect)
 * const colors = MutableList.make<string>()
 * MutableList.appendAll(colors, ["red", "blue"])
 * MutableList.remove(colors, "green")
 * console.log(MutableList.takeAll(colors)) // ["red", "blue"]
 *
 * // Real-world example: removing completed tasks
 * const tasks = MutableList.make<{ id: number; status: string }>()
 * MutableList.appendAll(tasks, [
 *   { id: 1, status: "pending" },
 *   { id: 2, status: "completed" },
 *   { id: 3, status: "pending" },
 *   { id: 4, status: "completed" }
 * ])
 *
 * // Remove completed tasks by filtering status
 * MutableList.filter(tasks, (task) => task.status !== "completed")
 * console.log(MutableList.takeAll(tasks).map((task) => task.id)) // [1, 3]
 * ```
 *
 * @category mutations
 * @since 4.0.0
 */
export const remove = <A>(self: MutableList<A>, value: A): void => filter(self, (v) => v !== value)
