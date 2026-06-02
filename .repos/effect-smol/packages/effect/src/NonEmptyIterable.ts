/**
 * The `NonEmptyIterable` module provides a type-level representation of any
 * JavaScript `Iterable` that is known to contain at least one element. A
 * `NonEmptyIterable<A>` can be consumed anywhere an `Iterable<A>` is expected,
 * while also carrying the guarantee that reading the first element is safe.
 *
 * **Mental model**
 *
 * - `NonEmptyIterable<A>` is an `Iterable<A>` branded with a non-empty guarantee
 * - The guarantee is static: values should only be typed this way when construction or validation proves at least one element exists
 * - The iterable can be an array, string, set, map, generator, or any custom iterable
 * - `unprepend` safely separates the first element from an iterator for the remaining elements
 * - Operations that may remove elements, such as filtering, usually return ordinary collections because they can become empty
 *
 * **Common tasks**
 *
 * - Accept inputs that must contain at least one value
 * - Extract a head element and process the remaining iterator with {@link unprepend}
 * - Model APIs such as reductions, comparisons, or aggregation that are undefined for empty inputs
 * - Preserve compatibility with the JavaScript iteration protocol while documenting the stronger invariant
 *
 * **Gotchas**
 *
 * - A type assertion does not make an empty iterable non-empty; only assert after a trusted check or constructor
 * - Iterators are stateful, so calling {@link unprepend} consumes the first yielded value from that iterator
 * - The order of the first element follows the source iterable's iteration order, for example insertion order for `Map` and `Set`
 * - Some transformations preserve non-emptiness, but transformations that can discard elements must account for the empty case
 *
 * **Quickstart**
 *
 * **Example** (Requiring a non-empty iterable)
 *
 * ```ts
 * import { NonEmptyIterable } from "effect"
 *
 * // NonEmptyIterable is a type that represents any iterable with at least one element
 * function processNonEmpty<A>(data: NonEmptyIterable.NonEmptyIterable<A>): A {
 *   // Safe to get the first element - guaranteed to exist
 *   const [first] = NonEmptyIterable.unprepend(data)
 *   return first
 * }
 *
 * // Using Array.make to create non-empty arrays
 * const numbers = Array.make(
 *   1,
 *   2,
 *   3,
 *   4,
 *   5
 * ) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * const firstNumber = processNonEmpty(numbers) // number
 *
 * // Regular arrays can be asserted as NonEmptyIterable when known to be non-empty
 * const values = [1, 2, 3] as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * const firstValue = processNonEmpty(values) // number
 *
 * // Custom iterables that are guaranteed non-empty
 * function* generateNumbers(): NonEmptyIterable.NonEmptyIterable<number> {
 *   yield 1
 *   yield 2
 *   yield 3
 * }
 *
 * const firstGenerated = processNonEmpty(generateNumbers()) // number
 * ```
 *
 * ## Working with Different Iterable Types
 *
 * **Example** (Adapting iterable inputs)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * // Creating non-empty arrays
 * const nonEmptyArray = Array.make(
 *   1,
 *   2,
 *   3
 * ) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 *
 * // Working with strings (assert as NonEmptyIterable when known to be non-empty)
 * const nonEmptyString = "hello" as unknown as NonEmptyIterable.NonEmptyIterable<
 *   string
 * >
 * const [firstChar] = NonEmptyIterable.unprepend(nonEmptyString)
 * console.log(firstChar) // "h"
 *
 * // Working with Maps (assert when known to be non-empty)
 * const nonEmptyMap = new Map([
 *   ["key1", "value1"],
 *   ["key2", "value2"]
 * ]) as unknown as NonEmptyIterable.NonEmptyIterable<[string, string]>
 * const [firstEntry] = NonEmptyIterable.unprepend(nonEmptyMap)
 * console.log(firstEntry) // ["key1", "value1"]
 *
 * // Custom generator functions
 * function* fibonacci(): NonEmptyIterable.NonEmptyIterable<number> {
 *   let a = 1, b = 1
 *   yield a
 *   while (true) {
 *     yield b
 *     const next = a + b
 *     a = b
 *     b = next
 *   }
 * }
 *
 * const [firstFib, restFib] = NonEmptyIterable.unprepend(
 *   fibonacci() as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * )
 * console.log(firstFib) // 1
 * ```
 *
 * ## Integration with Effect Arrays
 *
 * **Example** (Processing non-empty iterables with Array)
 *
 * ```ts
 * import { Array, pipe } from "effect"
 * import type { NonEmptyIterable } from "effect"
 *
 * // Many Array functions work with NonEmptyIterable
 * declare const nonEmptyData: NonEmptyIterable.NonEmptyIterable<number>
 *
 * const processData = pipe(
 *   nonEmptyData,
 *   Array.fromIterable,
 *   Array.map((x) => x * 2),
 *   Array.filter((x) => x > 5)
 *   // Result is a regular array since filtering might make it empty
 * )
 *
 * // Safe operations that preserve non-emptiness
 * const doubledData = pipe(
 *   nonEmptyData,
 *   Array.fromIterable,
 *   Array.map((x) => x * 2)
 *   // This would still be non-empty if the source was non-empty
 * )
 * ```
 *
 * @since 2.0.0
 */

/**
 * Defines the type-level symbol used to brand the `NonEmptyIterable` type.
 *
 * **When to use**
 *
 * Use as the property key for the type-level brand that marks an `Iterable` as
 * non-empty.
 *
 * **Details**
 *
 * `NonEmptyIterable<A>` includes `readonly [nonEmpty]: A`, which makes it
 * distinct from a plain `Iterable<A>` at compile time while preserving the
 * normal iteration shape.
 *
 * @see {@link NonEmptyIterable} for the branded iterable type that uses this symbol
 *
 * @category symbols
 * @since 2.0.0
 */
export declare const nonEmpty: unique symbol

/**
 * Represents an iterable that is guaranteed to contain at least one element.
 *
 * **When to use**
 *
 * Use to require an iterable input that must provide at least one element.
 *
 * **Details**
 *
 * `NonEmptyIterable<A>` extends the standard `Iterable<A>` interface with a type-level
 * guarantee of non-emptiness. This allows for safe operations that would otherwise
 * require runtime checks or could throw exceptions.
 *
 * The type is branded with a unique symbol to ensure type safety while maintaining
 * full compatibility with JavaScript's iteration protocol.
 *
 * **Example** (Working with non-empty iterables)
 *
 * ```ts
 * import { Array, Chunk, NonEmptyIterable } from "effect"
 *
 * // Function that requires non-empty data
 * function getFirst<A>(data: NonEmptyIterable.NonEmptyIterable<A>): A {
 *   // Safe - guaranteed to have at least one element
 *   const [first] = NonEmptyIterable.unprepend(data)
 *   return first
 * }
 *
 * // Works with any non-empty iterable
 * const numbers = Array.make(
 *   1,
 *   2,
 *   3
 * ) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * const firstNumber = getFirst(numbers) // 1
 *
 * const chars = "hello" as unknown as NonEmptyIterable.NonEmptyIterable<string>
 * const firstChar = getFirst(chars) // "h"
 *
 * const entries = new Map([["a", 1], [
 *   "b",
 *   2
 * ]]) as unknown as NonEmptyIterable.NonEmptyIterable<[string, number]>
 * const firstEntry = getFirst(entries) // ["a", 1]
 *
 * // Custom generator
 * function* countdown(): Generator<number> {
 *   yield 3
 *   yield 2
 *   yield 1
 * }
 * const firstCount = getFirst(
 *   Chunk.fromIterable(
 *     countdown()
 *   ) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * ) // 3
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface NonEmptyIterable<out A> extends Iterable<A> {
  readonly [nonEmpty]: A
}

/**
 * Extracts the first element and remaining elements from a non-empty iterable safely.
 *
 * **When to use**
 *
 * Use to split a non-empty iterable into its first element and an iterator for
 * the remaining elements.
 *
 * **Details**
 *
 * This function provides a safe way to deconstruct a `NonEmptyIterable` into its
 * head (first element) and tail (remaining elements as an iterator). Since the
 * iterable is guaranteed to be non-empty, the first element is always available.
 *
 * **Example** (Extracting first and remaining elements)
 *
 * ```ts
 * import { Array, Chunk, NonEmptyIterable } from "effect"
 *
 * // Helper to make iterator iterable for Array.from
 * const iteratorToIterable = <T>(iterator: Iterator<T>): Iterable<T> => ({
 *   [Symbol.iterator]() {
 *     return iterator
 *   }
 * })
 *
 * // With NonEmptyArray from Array.make (cast to NonEmptyIterable)
 * const numbers = Array.make(
 *   1,
 *   2,
 *   3,
 *   4,
 *   5
 * ) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * const [first, rest] = NonEmptyIterable.unprepend(numbers)
 * console.log(first) // 1
 * console.log(globalThis.Array.from(iteratorToIterable(rest))) // [2, 3, 4, 5]
 *
 * // With strings (assert when known to be non-empty)
 * const text = "hello" as unknown as NonEmptyIterable.NonEmptyIterable<string>
 * const [firstChar, restChars] = NonEmptyIterable.unprepend(text)
 * console.log(firstChar) // "h"
 * console.log(globalThis.Array.from(iteratorToIterable(restChars)).join("")) // "ello"
 *
 * // With Sets (assert when known to be non-empty)
 * const uniqueNumbers = new Set([
 *   10,
 *   20,
 *   30
 * ]) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * const [firstUnique, restUnique] = NonEmptyIterable.unprepend(uniqueNumbers)
 * console.log(firstUnique) // 10 (or any element, Set order is not guaranteed)
 * console.log(globalThis.Array.from(iteratorToIterable(restUnique))) // [20, 30] (in some order)
 *
 * // With Maps (assert when known to be non-empty)
 * const keyValuePairs = new Map([["a", 1], ["b", 2], [
 *   "c",
 *   3
 * ]]) as unknown as NonEmptyIterable.NonEmptyIterable<[string, number]>
 * const [firstPair, restPairs] = NonEmptyIterable.unprepend(keyValuePairs)
 * console.log(firstPair) // ["a", 1]
 * console.log(globalThis.Array.from(iteratorToIterable(restPairs))) // [["b", 2], ["c", 3]]
 *
 * // With custom generators
 * function* fibonacci(): Generator<number> {
 *   let a = 1, b = 1
 *   yield a
 *   for (let i = 0; i < 10; i++) {
 *     yield b
 *     const next = a + b
 *     a = b
 *     b = next
 *   }
 * }
 *
 * const generator = Chunk.fromIterable(
 *   fibonacci()
 * ) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * const [firstFib, restFib] = NonEmptyIterable.unprepend(generator)
 * console.log(firstFib) // 1
 * console.log(globalThis.Array.from(iteratorToIterable(restFib))) // [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
 *
 * // Practical usage: implementing reduce for non-empty iterables
 * function reduceNonEmpty<A, B>(
 *   data: NonEmptyIterable.NonEmptyIterable<A>,
 *   f: (acc: B, current: A) => B,
 *   initial: B
 * ): B {
 *   const [first, rest] = NonEmptyIterable.unprepend(data)
 *   let result = f(initial, first)
 *
 *   // Convert iterator to iterable for iteration
 *   const iterable = {
 *     [Symbol.iterator]() {
 *       return rest
 *     }
 *   }
 *   for (const item of iterable) {
 *     result = f(result, item)
 *   }
 *
 *   return result
 * }
 *
 * const data = Array.make(
 *   1,
 *   2,
 *   3,
 *   4
 * ) as unknown as NonEmptyIterable.NonEmptyIterable<number>
 * const sum = reduceNonEmpty(data, (acc, x) => acc + x, 0) // 10
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const unprepend = <A>(self: NonEmptyIterable<A>): [firstElement: A, remainingElements: Iterator<A>] => {
  const iterator = self[Symbol.iterator]()
  const next = iterator.next()
  if (next.done) {
    throw new Error(
      "BUG: NonEmptyIterator should not be empty - please report an issue at https://github.com/Effect-TS/effect/issues"
    )
  }
  return [next.value, iterator]
}
