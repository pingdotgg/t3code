/**
 * Stores unique values in an immutable hash set.
 *
 * A `HashSet<A>` contains at most one value for each equality class according
 * to Effect's `Equal` and `Hash` rules. Membership checks, additions, removals,
 * and set operations return new sets. This module also includes constructors,
 * union, intersection, difference, subset checks, mapping, filtering, and
 * reducing helpers.
 *
 * @since 2.0.0
 */

import type { Equal } from "./Equal.ts"
import * as Dual from "./Function.ts"
import type { Inspectable } from "./Inspectable.ts"
import * as internal from "./internal/hashSet.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { Predicate, Refinement } from "./Predicate.ts"
import type { NoInfer } from "./Types.ts"

const TypeId = internal.HashSetTypeId

/**
 * A HashSet is an immutable set data structure that provides efficient storage
 * and retrieval of unique values. It uses a HashMap internally for optimal performance.
 *
 * **Example** (Creating and updating a HashSet)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * // Create a HashSet
 * const set = HashSet.make("apple", "banana", "cherry")
 *
 * // Check membership
 * console.log(HashSet.has(set, "apple")) // true
 * console.log(HashSet.has(set, "grape")) // false
 *
 * // Add values (returns new HashSet)
 * const updated = HashSet.add(set, "grape")
 * console.log(HashSet.size(updated)) // 4
 *
 * // Remove values (returns new HashSet)
 * const smaller = HashSet.remove(set, "banana")
 * console.log(HashSet.size(smaller)) // 2
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface HashSet<out Value> extends Iterable<Value>, Equal, Pipeable, Inspectable {
  readonly [TypeId]: typeof TypeId
}

/**
 * The HashSet namespace contains type-level utilities and helper types
 * for working with HashSet instances.
 *
 * **Example** (Extracting value types from a HashSet)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * // Create a concrete HashSet for type extraction
 * const fruits = HashSet.make("apple", "banana", "cherry")
 *
 * // Extract the value type for reuse
 * type Fruit = HashSet.HashSet.Value<typeof fruits> // string
 *
 * // Use extracted type in functions
 * const processFruit = (fruit: Fruit) => {
 *   return `Processing ${fruit}`
 * }
 * ```
 *
 * @since 2.0.0
 */
export declare namespace HashSet {
  /**
   * Extracts the element type from a `HashSet`.
   *
   * **Details**
   *
   * For `HashSet.HashSet<A>`, `HashSet.Value<...>` resolves to `A`.
   *
   * **Example** (Extracting a HashSet value type)
   *
   * ```ts
   * import { HashSet } from "effect"
   *
   * const numbers = HashSet.make(1, 2, 3, 4, 5)
   *
   * // Extract the value type
   * type NumberType = HashSet.HashSet.Value<typeof numbers> // number
   *
   * const processNumber = (n: NumberType) => n * 2
   * ```
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Value<T> = T extends HashSet<infer V> ? V : never
}

/**
 * Creates an empty HashSet.
 *
 * **Example** (Creating an empty HashSet)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const set = HashSet.empty<string>()
 *
 * console.log(HashSet.size(set)) // 0
 * console.log(HashSet.isEmpty(set)) // true
 *
 * // Add some values
 * const withValues = HashSet.add(HashSet.add(set, "hello"), "world")
 * console.log(HashSet.size(withValues)) // 2
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const empty: <V = never>() => HashSet<V> = internal.empty

/**
 * Creates a HashSet from a variable number of values.
 *
 * **Example** (Creating a HashSet from values)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const fruits = HashSet.make("apple", "banana", "cherry")
 * console.log(HashSet.size(fruits)) // 3
 *
 * const numbers = HashSet.make(1, 2, 3, 2, 1) // Duplicates ignored
 * console.log(HashSet.size(numbers)) // 3
 *
 * const mixed = HashSet.make("hello", 42, true)
 * console.log(HashSet.size(mixed)) // 3
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const make: <Values extends ReadonlyArray<any>>(
  ...values: Values
) => HashSet<Values[number]> = internal.make

/**
 * Creates a HashSet from an iterable collection of values.
 *
 * **Example** (Creating a HashSet from an iterable)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const fromArray = HashSet.fromIterable(["a", "b", "c", "b", "a"])
 * console.log(HashSet.size(fromArray)) // 3
 *
 * const fromSet = HashSet.fromIterable(new Set([1, 2, 3]))
 * console.log(HashSet.size(fromSet)) // 3
 *
 * const fromString = HashSet.fromIterable("hello")
 * console.log(Array.from(fromString)) // ["h", "e", "l", "o"]
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const fromIterable: <V>(values: Iterable<V>) => HashSet<V> = internal.fromIterable

/**
 * Checks whether a value is a HashSet.
 *
 * **Example** (Checking for a HashSet)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const set = HashSet.make(1, 2, 3)
 * const array = [1, 2, 3]
 *
 * console.log(HashSet.isHashSet(set)) // true
 * console.log(HashSet.isHashSet(array)) // false
 * console.log(HashSet.isHashSet(null)) // false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isHashSet: {
  <V>(u: Iterable<V>): u is HashSet<V>
  (u: unknown): u is HashSet<unknown>
} = internal.isHashSet

/**
 * Adds a value to the HashSet, returning a new HashSet.
 *
 * **Example** (Adding values to a HashSet)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const set = HashSet.make("a", "b")
 * const withC = HashSet.add(set, "c")
 *
 * console.log(HashSet.size(set)) // 2 (original unchanged)
 * console.log(HashSet.size(withC)) // 3
 * console.log(HashSet.has(withC, "c")) // true
 *
 * // Adding existing value has no effect
 * const same = HashSet.add(set, "a")
 * console.log(HashSet.size(same)) // 2
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const add: {
  <V>(value: V): (self: HashSet<V>) => HashSet<V>
  <V>(self: HashSet<V>, value: V): HashSet<V>
} = Dual.dual<
  <V>(value: V) => (self: HashSet<V>) => HashSet<V>,
  <V>(self: HashSet<V>, value: V) => HashSet<V>
>(2, internal.add)

/**
 * Checks whether the HashSet contains the specified value.
 *
 * **Example** (Checking HashSet membership)
 *
 * ```ts
 * import { Equal, Hash, HashSet } from "effect"
 *
 * // Works with any type that implements Equal
 *
 * const set = HashSet.make("apple", "banana", "cherry")
 *
 * console.log(HashSet.has(set, "apple")) // true
 * console.log(HashSet.has(set, "grape")) // false
 *
 * class Person implements Equal.Equal {
 *   constructor(readonly name: string) {}
 *
 *   [Equal.symbol](other: unknown) {
 *     return other instanceof Person && this.name === other.name
 *   }
 *
 *   [Hash.symbol](): number {
 *     return Hash.string(this.name)
 *   }
 * }
 *
 * const people = HashSet.make(new Person("Alice"), new Person("Bob"))
 * console.log(HashSet.has(people, new Person("Alice"))) // true
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const has: {
  <V>(value: V): (self: HashSet<V>) => boolean
  <V>(self: HashSet<V>, value: V): boolean
} = Dual.dual<
  <V>(value: V) => (self: HashSet<V>) => boolean,
  <V>(self: HashSet<V>, value: V) => boolean
>(2, internal.has)

/**
 * Removes a value from the HashSet, returning a new HashSet.
 *
 * **Example** (Removing values from a HashSet)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const set = HashSet.make("a", "b", "c")
 * const withoutB = HashSet.remove(set, "b")
 *
 * console.log(HashSet.size(set)) // 3 (original unchanged)
 * console.log(HashSet.size(withoutB)) // 2
 * console.log(HashSet.has(withoutB, "b")) // false
 *
 * // Removing non-existent value has no effect
 * const same = HashSet.remove(set, "d")
 * console.log(HashSet.size(same)) // 3
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const remove: {
  <V>(value: V): (self: HashSet<V>) => HashSet<V>
  <V>(self: HashSet<V>, value: V): HashSet<V>
} = Dual.dual<
  <V>(value: V) => (self: HashSet<V>) => HashSet<V>,
  <V>(self: HashSet<V>, value: V) => HashSet<V>
>(2, internal.remove)

/**
 * Returns the number of values in the HashSet.
 *
 * **Example** (Getting the HashSet size)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const empty = HashSet.empty<string>()
 * console.log(HashSet.size(empty)) // 0
 *
 * const small = HashSet.make("a", "b")
 * console.log(HashSet.size(small)) // 2
 *
 * const withDuplicates = HashSet.fromIterable(["x", "y", "z", "x", "y"])
 * console.log(HashSet.size(withDuplicates)) // 3
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const size: <V>(self: HashSet<V>) => number = internal.size

/**
 * Checks whether the HashSet is empty.
 *
 * **Example** (Checking whether a HashSet is empty)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const empty = HashSet.empty<string>()
 * console.log(HashSet.isEmpty(empty)) // true
 *
 * const nonEmpty = HashSet.make("a")
 * console.log(HashSet.isEmpty(nonEmpty)) // false
 * ```
 *
 * @category getters
 * @since 4.0.0
 */
export const isEmpty: <V>(self: HashSet<V>) => boolean = internal.isEmpty

/**
 * Creates the union of two HashSets.
 *
 * **Example** (Combining HashSets)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const set1 = HashSet.make("a", "b")
 * const set2 = HashSet.make("b", "c")
 * const combined = HashSet.union(set1, set2)
 *
 * console.log(Array.from(combined).sort()) // ["a", "b", "c"]
 * console.log(HashSet.size(combined)) // 3
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const union: {
  <V1>(that: HashSet<V1>): <V0>(self: HashSet<V0>) => HashSet<V1 | V0>
  <V0, V1>(self: HashSet<V0>, that: HashSet<V1>): HashSet<V0 | V1>
} = Dual.dual<
  <V1>(that: HashSet<V1>) => <V0>(self: HashSet<V0>) => HashSet<V1 | V0>,
  <V0, V1>(self: HashSet<V0>, that: HashSet<V1>) => HashSet<V0 | V1>
>(2, internal.union)

/**
 * Creates the intersection of two HashSets.
 *
 * **Example** (Finding common HashSet values)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const set1 = HashSet.make("a", "b", "c")
 * const set2 = HashSet.make("b", "c", "d")
 * const common = HashSet.intersection(set1, set2)
 *
 * console.log(Array.from(common).sort()) // ["b", "c"]
 * console.log(HashSet.size(common)) // 2
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const intersection: {
  <V1>(that: HashSet<V1>): <V0>(self: HashSet<V0>) => HashSet<V1 & V0>
  <V0, V1>(self: HashSet<V0>, that: HashSet<V1>): HashSet<V0 & V1>
} = Dual.dual<
  <V1>(that: HashSet<V1>) => <V0>(self: HashSet<V0>) => HashSet<V1 & V0>,
  <V0, V1>(self: HashSet<V0>, that: HashSet<V1>) => HashSet<V0 & V1>
>(2, internal.intersection)

/**
 * Creates the difference of two HashSets (elements in the first set that are not in the second).
 *
 * **Example** (Finding HashSet differences)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const set1 = HashSet.make("a", "b", "c")
 * const set2 = HashSet.make("b", "d")
 * const diff = HashSet.difference(set1, set2)
 *
 * console.log(Array.from(diff).sort()) // ["a", "c"]
 * console.log(HashSet.size(diff)) // 2
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const difference: {
  <V1>(that: HashSet<V1>): <V0>(self: HashSet<V0>) => HashSet<V0>
  <V0, V1>(self: HashSet<V0>, that: HashSet<V1>): HashSet<V0>
} = Dual.dual<
  <V1>(that: HashSet<V1>) => <V0>(self: HashSet<V0>) => HashSet<V0>,
  <V0, V1>(self: HashSet<V0>, that: HashSet<V1>) => HashSet<V0>
>(2, internal.difference)

/**
 * Checks whether a HashSet is a subset of another HashSet.
 *
 * **Example** (Checking subset relationships)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const small = HashSet.make("a", "b")
 * const large = HashSet.make("a", "b", "c", "d")
 * const other = HashSet.make("x", "y")
 *
 * console.log(HashSet.isSubset(small, large)) // true
 * console.log(HashSet.isSubset(large, small)) // false
 * console.log(HashSet.isSubset(small, other)) // false
 * console.log(HashSet.isSubset(small, small)) // true
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const isSubset: {
  <V1>(that: HashSet<V1>): <V0>(self: HashSet<V0>) => boolean
  <V0, V1>(self: HashSet<V0>, that: HashSet<V1>): boolean
} = Dual.dual<
  <V1>(that: HashSet<V1>) => <V0>(self: HashSet<V0>) => boolean,
  <V0, V1>(self: HashSet<V0>, that: HashSet<V1>) => boolean
>(2, internal.isSubset)

/**
 * Maps each value in the HashSet using the provided function.
 *
 * **Example** (Mapping HashSet values)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const numbers = HashSet.make(1, 2, 3)
 * const doubled = HashSet.map(numbers, (n) => n * 2)
 *
 * console.log(Array.from(doubled).sort()) // [2, 4, 6]
 * console.log(HashSet.size(doubled)) // 3
 *
 * // Mapping can reduce size if function produces duplicates
 * const strings = HashSet.make("apple", "banana", "cherry")
 * const lengths = HashSet.map(strings, (s) => s.length)
 * console.log(Array.from(lengths).sort()) // [5, 6] (apple=5, banana=6, cherry=6)
 * ```
 *
 * @category mapping
 * @since 2.0.0
 */
export const map: {
  <V, U>(f: (value: V) => U): (self: HashSet<V>) => HashSet<U>
  <V, U>(self: HashSet<V>, f: (value: V) => U): HashSet<U>
} = Dual.dual<
  <V, U>(f: (value: V) => U) => (self: HashSet<V>) => HashSet<U>,
  <V, U>(self: HashSet<V>, f: (value: V) => U) => HashSet<U>
>(2, internal.map)

/**
 * Filters the HashSet keeping only values that satisfy the predicate.
 *
 * **Example** (Filtering HashSet values)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const numbers = HashSet.make(1, 2, 3, 4, 5, 6)
 * const evens = HashSet.filter(numbers, (n) => n % 2 === 0)
 *
 * console.log(Array.from(evens).sort()) // [2, 4, 6]
 * console.log(HashSet.size(evens)) // 3
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const filter: {
  <V, U extends V>(refinement: Refinement<NoInfer<V>, U>): (self: HashSet<V>) => HashSet<U>
  <V>(predicate: Predicate<NoInfer<V>>): (self: HashSet<V>) => HashSet<V>
  <V, U extends V>(self: HashSet<V>, refinement: Refinement<V, U>): HashSet<U>
  <V>(self: HashSet<V>, predicate: Predicate<V>): HashSet<V>
} = Dual.dual<
  {
    <V, U extends V>(refinement: Refinement<NoInfer<V>, U>): (self: HashSet<V>) => HashSet<U>
    <V>(predicate: Predicate<NoInfer<V>>): (self: HashSet<V>) => HashSet<V>
  },
  {
    <V, U extends V>(self: HashSet<V>, refinement: Refinement<V, U>): HashSet<U>
    <V>(self: HashSet<V>, predicate: Predicate<V>): HashSet<V>
  }
>(2, internal.filter)

/**
 * Checks whether at least one value in the HashSet satisfies the predicate.
 *
 * **Example** (Testing whether some values match)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const numbers = HashSet.make(1, 2, 3, 4, 5)
 *
 * console.log(HashSet.some(numbers, (n) => n > 3)) // true
 * console.log(HashSet.some(numbers, (n) => n > 10)) // false
 *
 * const empty = HashSet.empty<number>()
 * console.log(HashSet.some(empty, (n) => n > 0)) // false
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const some: {
  <V>(predicate: Predicate<V>): (self: HashSet<V>) => boolean
  <V>(self: HashSet<V>, predicate: Predicate<V>): boolean
} = Dual.dual<
  <V>(predicate: Predicate<V>) => (self: HashSet<V>) => boolean,
  <V>(self: HashSet<V>, predicate: Predicate<V>) => boolean
>(2, internal.some)

/**
 * Checks whether all values in the HashSet satisfy the predicate.
 *
 * **Example** (Testing whether every value matches)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const numbers = HashSet.make(2, 4, 6, 8)
 *
 * console.log(HashSet.every(numbers, (n) => n % 2 === 0)) // true
 * console.log(HashSet.every(numbers, (n) => n > 5)) // false
 *
 * const empty = HashSet.empty<number>()
 * console.log(HashSet.every(empty, (n) => n > 0)) // true (vacuously true)
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const every: {
  <V>(predicate: Predicate<V>): (self: HashSet<V>) => boolean
  <V>(self: HashSet<V>, predicate: Predicate<V>): boolean
} = Dual.dual<
  <V>(predicate: Predicate<V>) => (self: HashSet<V>) => boolean,
  <V>(self: HashSet<V>, predicate: Predicate<V>) => boolean
>(2, internal.every)

/**
 * Reduces the HashSet to a single value by iterating through the values and applying an accumulator function.
 *
 * **Example** (Reducing HashSet values)
 *
 * ```ts
 * import { HashSet } from "effect"
 *
 * const numbers = HashSet.make(1, 2, 3, 4, 5)
 * const sum = HashSet.reduce(numbers, 0, (acc, n) => acc + n)
 *
 * console.log(sum) // 15
 *
 * const strings = HashSet.make("a", "b", "c")
 * const concatenated = HashSet.reduce(strings, "", (acc, s) => acc + s)
 * console.log(concatenated) // Order may vary: "abc", "bac", etc.
 * ```
 *
 * @category folding
 * @since 2.0.0
 */
export const reduce: {
  <V, U>(zero: U, f: (accumulator: U, value: V) => U): (self: HashSet<V>) => U
  <V, U>(self: HashSet<V>, zero: U, f: (accumulator: U, value: V) => U): U
} = Dual.dual<
  <V, U>(zero: U, f: (accumulator: U, value: V) => U) => (self: HashSet<V>) => U,
  <V, U>(self: HashSet<V>, zero: U, f: (accumulator: U, value: V) => U) => U
>(3, internal.reduce)
