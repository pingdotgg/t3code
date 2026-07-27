/**
 * Stores string-keyed values in an immutable prefix tree.
 *
 * A `Trie<Value>` is similar to a map whose keys are strings, but it is built
 * for looking up keys by prefix. It is useful for autocomplete, route tables,
 * dictionaries, and command lookup. Updates return new tries, and the module
 * includes exact lookup, prefix lookup, longest-prefix lookup, iteration,
 * mapping, filtering, reducing, and traversal helpers.
 *
 * @since 2.0.0
 */
import type { Equal } from "./Equal.ts"
import type { Inspectable } from "./Inspectable.ts"
import * as TR from "./internal/trie.ts"
import type { Option } from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { Result } from "./Result.ts"
import type { Covariant, NoInfer } from "./Types.ts"

const TypeId = TR.TrieTypeId

/**
 * An immutable string-keyed map optimized for prefix lookup. Iteration yields
 * `[key, value]` pairs in key order, and update operations such as insert and
 * remove return new `Trie` values.
 *
 * **Example** (Using a trie for prefix search)
 *
 * ```ts
 * import { Trie } from "effect"
 *
 * // Create a trie with string-to-number mappings
 * const trie: Trie.Trie<number> = Trie.make(
 *   ["apple", 1],
 *   ["app", 2],
 *   ["application", 3],
 *   ["banana", 4]
 * )
 *
 * // Get values by exact key
 * console.log(Trie.get(trie, "apple")) // Some(1)
 * console.log(Trie.get(trie, "grape")) // None
 *
 * // Find all keys with a prefix
 * console.log(Array.from(Trie.keysWithPrefix(trie, "app")))
 * // ["app", "apple", "application"]
 *
 * // Iterate over all entries (sorted alphabetically)
 * for (const [key, value] of trie) {
 *   console.log(`${key}: ${value}`)
 * }
 * // Output: "app: 2", "apple: 1", "application: 3", "banana: 4"
 *
 * // Check if key exists
 * console.log(Trie.has(trie, "app")) // true
 *
 * // Get size
 * console.log(Trie.size(trie)) // 4
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Trie<in out Value> extends Iterable<[string, Value]>, Equal, Pipeable, Inspectable {
  readonly [TypeId]: {
    readonly _Value: Covariant<Value>
  }
}

/**
 * Creates an empty `Trie`.
 *
 * **Example** (Creating an empty trie)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<string>()
 *
 * assert.equal(Trie.size(trie), 0)
 * assert.deepStrictEqual(Array.from(trie), [])
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const empty: <V = never>() => Trie<V> = TR.empty

/**
 * Creates a new `Trie` from an iterable collection of key/value pairs (e.g. `Array<[string, V]>`).
 *
 * **Example** (Creating a trie from entries)
 *
 * ```ts
 * import { Equal, Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const iterable: Array<readonly [string, number]> = [["call", 0], ["me", 1], [
 *   "mind",
 *   2
 * ], ["mid", 3]]
 * const trie = Trie.fromIterable(iterable)
 *
 * // The entries in the `Trie` are extracted in alphabetical order, regardless of the insertion order
 * assert.deepStrictEqual(Array.from(trie), [["call", 0], ["me", 1], ["mid", 3], [
 *   "mind",
 *   2
 * ]])
 * assert.equal(
 *   Equal.equals(
 *     Trie.make(["call", 0], ["me", 1], ["mind", 2], ["mid", 3]),
 *     trie
 *   ),
 *   true
 * )
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const fromIterable: <V>(entries: Iterable<readonly [string, V]>) => Trie<V> = TR.fromIterable

/**
 * Constructs a new `Trie` from the specified entries (`[string, V]`).
 *
 * **Example** (Constructing a trie from entries)
 *
 * ```ts
 * import { Equal, Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.make(["ca", 0], ["me", 1])
 *
 * assert.deepStrictEqual(Array.from(trie), [["ca", 0], ["me", 1]])
 * assert.equal(
 *   Equal.equals(Trie.fromIterable([["ca", 0], ["me", 1]]), trie),
 *   true
 * )
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const make: <Entries extends Array<readonly [string, any]>>(
  ...entries: Entries
) => Trie<Entries[number] extends readonly [any, infer V] ? V : never> = TR.make

/**
 * Inserts a new entry in the `Trie`.
 *
 * **Example** (Inserting entries)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie1 = Trie.empty<number>().pipe(
 *   Trie.insert("call", 0)
 * )
 * const trie2 = trie1.pipe(Trie.insert("me", 1))
 * const trie3 = trie2.pipe(Trie.insert("mind", 2))
 * const trie4 = trie3.pipe(Trie.insert("mid", 3))
 *
 * assert.deepStrictEqual(Array.from(trie1), [["call", 0]])
 * assert.deepStrictEqual(Array.from(trie2), [["call", 0], ["me", 1]])
 * assert.deepStrictEqual(Array.from(trie3), [["call", 0], ["me", 1], ["mind", 2]])
 * assert.deepStrictEqual(Array.from(trie4), [["call", 0], ["me", 1], ["mid", 3], [
 *   "mind",
 *   2
 * ]])
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const insert: {
  <V>(key: string, value: V): (self: Trie<V>) => Trie<V>
  <V>(self: Trie<V>, key: string, value: V): Trie<V>
} = TR.insert

/**
 * Returns an `IterableIterator` of the keys within the `Trie`.
 *
 * **Details**
 *
 * The keys are returned in alphabetical order, regardless of insertion order.
 *
 * **Example** (Reading keys in alphabetical order)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("cab", 0),
 *   Trie.insert("abc", 1),
 *   Trie.insert("bca", 2)
 * )
 *
 * const result = Array.from(Trie.keys(trie))
 * assert.deepStrictEqual(result, ["abc", "bca", "cab"])
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const keys: <V>(self: Trie<V>) => IterableIterator<string> = TR.keys

/**
 * Returns an `IterableIterator` of the values within the `Trie`.
 *
 * **Details**
 *
 * Values are ordered based on their key in alphabetical order, regardless of insertion order.
 *
 * **Example** (Reading values by key order)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("call", 0),
 *   Trie.insert("me", 1),
 *   Trie.insert("and", 2)
 * )
 *
 * const result = Array.from(Trie.values(trie))
 * assert.deepStrictEqual(result, [2, 0, 1])
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const values: <V>(self: Trie<V>) => IterableIterator<V> = TR.values

/**
 * Returns an `IterableIterator` of the entries within the `Trie`.
 *
 * **Details**
 *
 * The entries are returned by keys in alphabetical order, regardless of insertion order.
 *
 * **Example** (Reading entries in alphabetical order)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("call", 0),
 *   Trie.insert("me", 1)
 * )
 *
 * const result = Array.from(Trie.entries(trie))
 * assert.deepStrictEqual(result, [["call", 0], ["me", 1]])
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const entries: <V>(self: Trie<V>) => IterableIterator<[string, V]> = TR.entries

/**
 * Returns an `Array<[string, V]>` of the entries within the `Trie`.
 *
 * **Details**
 *
 * Equivalent to `Array.from(Trie.entries(trie))`.
 *
 * **Example** (Converting entries to an array)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("call", 0),
 *   Trie.insert("me", 1)
 * )
 * const result = Trie.toEntries(trie)
 *
 * assert.deepStrictEqual(result, [["call", 0], ["me", 1]])
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const toEntries = <V>(self: Trie<V>): Array<[string, V]> => Array.from(entries(self))

/**
 * Returns an `IterableIterator` of the keys within the `Trie`
 * that have `prefix` as prefix (`prefix` included if it exists).
 *
 * **Example** (Finding keys with a prefix)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("she", 0),
 *   Trie.insert("shells", 1),
 *   Trie.insert("sea", 2),
 *   Trie.insert("shore", 3)
 * )
 *
 * const result = Array.from(Trie.keysWithPrefix(trie, "she"))
 * assert.deepStrictEqual(result, ["she", "shells"])
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const keysWithPrefix: {
  (prefix: string): <V>(self: Trie<V>) => IterableIterator<string>
  <V>(self: Trie<V>, prefix: string): IterableIterator<string>
} = TR.keysWithPrefix

/**
 * Returns an `IterableIterator` of the values within the `Trie`
 * that have `prefix` as prefix (`prefix` included if it exists).
 *
 * **Example** (Finding values with a prefix)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("she", 0),
 *   Trie.insert("shells", 1),
 *   Trie.insert("sea", 2),
 *   Trie.insert("shore", 3)
 * )
 *
 * const result = Array.from(Trie.valuesWithPrefix(trie, "she"))
 *
 * // 0: "she", 1: "shells"
 * assert.deepStrictEqual(result, [0, 1])
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const valuesWithPrefix: {
  (prefix: string): <V>(self: Trie<V>) => IterableIterator<V>
  <V>(self: Trie<V>, prefix: string): IterableIterator<V>
} = TR.valuesWithPrefix

/**
 * Returns an `IterableIterator` of the entries within the `Trie`
 * that have `prefix` as prefix (`prefix` included if it exists).
 *
 * **Example** (Finding entries with a prefix)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("she", 0),
 *   Trie.insert("shells", 1),
 *   Trie.insert("sea", 2),
 *   Trie.insert("shore", 3)
 * )
 *
 * const result = Array.from(Trie.entriesWithPrefix(trie, "she"))
 * assert.deepStrictEqual(result, [["she", 0], ["shells", 1]])
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const entriesWithPrefix: {
  (prefix: string): <V>(self: Trie<V>) => IterableIterator<[string, V]>
  <V>(self: Trie<V>, prefix: string): IterableIterator<[string, V]>
} = TR.entriesWithPrefix

/**
 * Returns an `Array<[string, V]>` of the entries within the `Trie` whose keys
 * start with `prefix`, including the entry for `prefix` itself when it exists.
 *
 * **Example** (Converting prefixed entries to an array)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1),
 *   Trie.insert("sea", 2),
 *   Trie.insert("she", 3)
 * )
 *
 * const result = Trie.toEntriesWithPrefix(trie, "she")
 * assert.deepStrictEqual(result, [["she", 3], ["shells", 0]])
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const toEntriesWithPrefix: {
  (prefix: string): <V>(self: Trie<V>) => Array<[string, V]>
  <V>(self: Trie<V>, prefix: string): Array<[string, V]>
} = TR.toEntriesWithPrefix

/**
 * Returns the longest key/value in the `Trie`
 * that is a prefix of that `key` if it exists, `None` otherwise.
 *
 * **Example** (Finding the longest prefix)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1),
 *   Trie.insert("she", 2)
 * )
 *
 * const none = Trie.longestPrefixOf(trie, "sell")
 * const some = Trie.longestPrefixOf(trie, "sells")
 *
 * assert.equal(none._tag, "None")
 * assert.equal(some._tag, "Some")
 * if (some._tag === "Some") {
 *   assert.deepStrictEqual(some.value, ["sells", 1])
 * }
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const longestPrefixOf: {
  (key: string): <V>(self: Trie<V>) => Option<[string, V]>
  <V>(self: Trie<V>, key: string): Option<[string, V]>
} = TR.longestPrefixOf

/**
 * Returns the size of the `Trie` (number of entries in the `Trie`).
 *
 * **Example** (Getting the size)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("a", 0),
 *   Trie.insert("b", 1)
 * )
 *
 * assert.equal(Trie.size(trie), 2)
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const size: <V>(self: Trie<V>) => number = TR.size

/**
 * Looks up the value for the specified key in the `Trie` safely.
 *
 * **Example** (Looking up values safely)
 *
 * ```ts
 * import { Option, Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("call", 0),
 *   Trie.insert("me", 1),
 *   Trie.insert("mind", 2),
 *   Trie.insert("mid", 3)
 * )
 *
 * assert.deepStrictEqual(Trie.get(trie, "call"), Option.some(0))
 * assert.deepStrictEqual(Trie.get(trie, "me"), Option.some(1))
 * assert.deepStrictEqual(Trie.get(trie, "mind"), Option.some(2))
 * assert.deepStrictEqual(Trie.get(trie, "mid"), Option.some(3))
 * assert.deepStrictEqual(Trie.get(trie, "cale"), Option.none())
 * assert.deepStrictEqual(Trie.get(trie, "ma"), Option.none())
 * assert.deepStrictEqual(Trie.get(trie, "midn"), Option.none())
 * assert.deepStrictEqual(Trie.get(trie, "mea"), Option.none())
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const get: {
  (key: string): <V>(self: Trie<V>) => Option<V>
  <V>(self: Trie<V>, key: string): Option<V>
} = TR.get

/**
 * Checks whether the given key exists in the `Trie`.
 *
 * **Example** (Checking key membership)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("call", 0),
 *   Trie.insert("me", 1),
 *   Trie.insert("mind", 2),
 *   Trie.insert("mid", 3)
 * )
 *
 * assert.equal(Trie.has(trie, "call"), true)
 * assert.equal(Trie.has(trie, "me"), true)
 * assert.equal(Trie.has(trie, "mind"), true)
 * assert.equal(Trie.has(trie, "mid"), true)
 * assert.equal(Trie.has(trie, "cale"), false)
 * assert.equal(Trie.has(trie, "ma"), false)
 * assert.equal(Trie.has(trie, "midn"), false)
 * assert.equal(Trie.has(trie, "mea"), false)
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const has: {
  (key: string): <V>(self: Trie<V>) => boolean
  <V>(self: Trie<V>, key: string): boolean
} = TR.has

/**
 * Returns `true` when the `Trie` contains no entries.
 *
 * **Example** (Checking whether a trie is empty)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>()
 * const trie1 = trie.pipe(Trie.insert("ma", 0))
 *
 * assert.equal(Trie.isEmpty(trie), true)
 * assert.equal(Trie.isEmpty(trie1), false)
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const isEmpty: <V>(self: Trie<V>) => boolean = TR.isEmpty

/**
 * Looks up the value for the specified key in the `Trie` unsafely.
 *
 * **When to use**
 *
 * Use when the trie key is known to exist and a missing key should be treated
 * as a programming error.
 *
 * **Gotchas**
 *
 * `getUnsafe` throws if the key is not found. Use `get` instead to safely get
 * a value from the `Trie`.
 *
 * **Example** (Looking up values unsafely)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("call", 0),
 *   Trie.insert("me", 1)
 * )
 *
 * assert.throws(() => Trie.getUnsafe(trie, "mae"))
 * ```
 *
 * @category unsafe
 * @since 4.0.0
 */
export const getUnsafe: {
  (key: string): <V>(self: Trie<V>) => V
  <V>(self: Trie<V>, key: string): V
} = TR.getUnsafe

/**
 * Removes the entry for the specified key in the `Trie`.
 *
 * **Example** (Removing entries)
 *
 * ```ts
 * import { Option, Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("call", 0),
 *   Trie.insert("me", 1),
 *   Trie.insert("mind", 2),
 *   Trie.insert("mid", 3)
 * )
 *
 * const trie1 = trie.pipe(Trie.remove("call"))
 * const trie2 = trie1.pipe(Trie.remove("mea"))
 *
 * assert.deepStrictEqual(Trie.get(trie, "call"), Option.some(0))
 * assert.deepStrictEqual(Trie.get(trie1, "call"), Option.none())
 * assert.deepStrictEqual(Trie.get(trie2, "call"), Option.none())
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const remove: {
  (key: string): <V>(self: Trie<V>) => Trie<V>
  <V>(self: Trie<V>, key: string): Trie<V>
} = TR.remove

/**
 * Reduces a state over the entries of the `Trie`.
 *
 * **Example** (Reducing entries)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1),
 *   Trie.insert("she", 2)
 * )
 *
 * assert.equal(
 *   trie.pipe(
 *     Trie.reduce(0, (acc, n) => acc + n)
 *   ),
 *   3
 * )
 * assert.equal(
 *   trie.pipe(
 *     Trie.reduce(10, (acc, n) => acc + n)
 *   ),
 *   13
 * )
 * assert.equal(
 *   trie.pipe(
 *     Trie.reduce("", (acc, _, key) => acc + key)
 *   ),
 *   "sellssheshells"
 * )
 * ```
 *
 * @category folding
 * @since 2.0.0
 */
export const reduce: {
  <Z, V>(zero: Z, f: (accumulator: Z, value: V, key: string) => Z): (self: Trie<V>) => Z
  <Z, V>(self: Trie<V>, zero: Z, f: (accumulator: Z, value: V, key: string) => Z): Z
} = TR.reduce

/**
 * Maps over the entries of the `Trie` using the specified function.
 *
 * **Example** (Mapping entries)
 *
 * ```ts
 * import { Equal, Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1),
 *   Trie.insert("she", 2)
 * )
 *
 * const trieMapV = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 1),
 *   Trie.insert("sells", 2),
 *   Trie.insert("she", 3)
 * )
 *
 * const trieMapK = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 6),
 *   Trie.insert("sells", 5),
 *   Trie.insert("she", 3)
 * )
 *
 * assert.equal(Equal.equals(Trie.map(trie, (v) => v + 1), trieMapV), true)
 * assert.equal(Equal.equals(Trie.map(trie, (_, k) => k.length), trieMapK), true)
 * ```
 *
 * @category folding
 * @since 2.0.0
 */
export const map: {
  <A, V>(f: (value: V, key: string) => A): (self: Trie<V>) => Trie<A>
  <V, A>(self: Trie<V>, f: (value: V, key: string) => A): Trie<A>
} = TR.map

/**
 * Filters entries out of a `Trie` using the specified predicate.
 *
 * **Example** (Filtering entries)
 *
 * ```ts
 * import { Equal, Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1),
 *   Trie.insert("she", 2)
 * )
 *
 * const trieMapV = Trie.empty<number>().pipe(
 *   Trie.insert("she", 2)
 * )
 *
 * const trieMapK = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1)
 * )
 *
 * assert.equal(Equal.equals(Trie.filter(trie, (v) => v > 1), trieMapV), true)
 * assert.equal(
 *   Equal.equals(Trie.filter(trie, (_, k) => k.length > 3), trieMapK),
 *   true
 * )
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const filter: {
  <A, B extends A>(f: (a: NoInfer<A>, k: string) => a is B): (self: Trie<A>) => Trie<B>
  <A>(f: (a: NoInfer<A>, k: string) => boolean): (self: Trie<A>) => Trie<A>
  <A, B extends A>(self: Trie<A>, f: (a: A, k: string) => a is B): Trie<B>
  <A>(self: Trie<A>, f: (a: A, k: string) => boolean): Trie<A>
} = TR.filter

/**
 * Maps over the entries of the `Trie` using the specified filter and keeps
 * only successful results.
 *
 * **Example** (Filtering and mapping entries)
 *
 * ```ts
 * import { Equal, Result, Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1),
 *   Trie.insert("she", 2)
 * )
 *
 * const trieMapV = Trie.empty<number>().pipe(
 *   Trie.insert("she", 2)
 * )
 *
 * const trieMapK = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1)
 * )
 *
 * assert.equal(
 *   Equal.equals(
 *     Trie.filterMap(trie, (v) => v > 1 ? Result.succeed(v) : Result.failVoid),
 *     trieMapV
 *   ),
 *   true
 * )
 * assert.equal(
 *   Equal.equals(
 *     Trie.filterMap(
 *       trie,
 *       (v, k) => k.length > 3 ? Result.succeed(v) : Result.failVoid
 *     ),
 *     trieMapK
 *   ),
 *   true
 * )
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const filterMap: {
  <A, B, X>(f: (input: A, key: string) => Result<B, X>): (self: Trie<A>) => Trie<B>
  <A, B, X>(self: Trie<A>, f: (input: A, key: string) => Result<B, X>): Trie<B>
} = TR.filterMap

/**
 * Filters out `None` values from a `Trie` of `Options`s.
 *
 * **Example** (Compacting optional values)
 *
 * ```ts
 * import { Equal, Option, Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<Option.Option<number>>().pipe(
 *   Trie.insert("shells", Option.some(0)),
 *   Trie.insert("sells", Option.none()),
 *   Trie.insert("she", Option.some(2))
 * )
 *
 * const trieMapV = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("she", 2)
 * )
 *
 * assert.equal(Equal.equals(Trie.compact(trie), trieMapV), true)
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const compact: <A>(self: Trie<Option<A>>) => Trie<A> = TR.compact

/**
 * Applies the specified function to the entries of the `Trie`.
 *
 * **Example** (Iterating over entries)
 *
 * ```ts
 * import { Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * let value = 0
 *
 * Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1),
 *   Trie.insert("she", 2),
 *   Trie.forEach((n, key) => {
 *     value += n + key.length
 *   })
 * )
 *
 * assert.equal(value, 17)
 * ```
 *
 * @category traversing
 * @since 2.0.0
 */
export const forEach: {
  <V>(f: (value: V, key: string) => void): (self: Trie<V>) => void
  <V>(self: Trie<V>, f: (value: V, key: string) => void): void
} = TR.forEach

/**
 * Updates the value of the specified key within the `Trie` if it exists.
 *
 * **Example** (Modifying an existing value)
 *
 * ```ts
 * import { Equal, Option, Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1),
 *   Trie.insert("she", 2)
 * )
 *
 * assert.deepStrictEqual(
 *   trie.pipe(Trie.modify("she", (v) => v + 10), Trie.get("she")),
 *   Option.some(12)
 * )
 *
 * assert.equal(Equal.equals(trie.pipe(Trie.modify("me", (v) => v)), trie), true)
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const modify: {
  <V>(key: string, f: (v: V) => V): (self: Trie<V>) => Trie<V>
  <V>(self: Trie<V>, key: string, f: (v: V) => V): Trie<V>
} = TR.modify

/**
 * Removes all entries in the `Trie` which have the specified keys.
 *
 * **Example** (Removing multiple entries)
 *
 * ```ts
 * import { Equal, Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1),
 *   Trie.insert("she", 2)
 * )
 *
 * assert.equal(
 *   Equal.equals(
 *     trie.pipe(Trie.removeMany(["she", "sells"])),
 *     Trie.empty<number>().pipe(Trie.insert("shells", 0))
 *   ),
 *   true
 * )
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const removeMany: {
  (keys: Iterable<string>): <V>(self: Trie<V>) => Trie<V>
  <V>(self: Trie<V>, keys: Iterable<string>): Trie<V>
} = TR.removeMany

/**
 * Inserts multiple entries in the `Trie` at once.
 *
 * **Example** (Inserting multiple entries)
 *
 * ```ts
 * import { Equal, Trie } from "effect"
 * import * as assert from "node:assert"
 *
 * const trie = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insert("sells", 1),
 *   Trie.insert("she", 2)
 * )
 *
 * const trieInsert = Trie.empty<number>().pipe(
 *   Trie.insert("shells", 0),
 *   Trie.insertMany(
 *     [["sells", 1], ["she", 2]]
 *   )
 * )
 *
 * assert.equal(
 *   Equal.equals(trie, trieInsert),
 *   true
 * )
 * ```
 *
 * @category mutations
 * @since 2.0.0
 */
export const insertMany: {
  <V>(iter: Iterable<[string, V]>): (self: Trie<V>) => Trie<V>
  <V>(self: Trie<V>, iter: Iterable<[string, V]>): Trie<V>
} = TR.insertMany
