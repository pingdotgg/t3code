/**
 * The `Array` module provides functional operations for JavaScript arrays,
 * readonly arrays, and arrays that are known to contain at least one element.
 * Operations that transform, reorder, or update collections allocate new arrays
 * instead of mutating their inputs, while preserving useful type information
 * such as non-emptiness when the operation can prove it.
 *
 * **Mental model**
 *
 * - A regular `Array<A>` is still the built-in JavaScript array type; this
 *   module supplies functional constructors, combinators, searches, folds,
 *   grouping, sorting, and set-like operations around it.
 * - {@link NonEmptyReadonlyArray} and {@link NonEmptyArray} encode
 *   non-emptiness at the type level. APIs with `NonEmpty` in the name can avoid
 *   `Option` because an element is guaranteed to exist.
 * - Most functions are dual. You can call them data-first, such as
 *   `Array.map(values, f)`, or data-last in a pipeline, such as
 *   `pipe(values, Array.map(f))`.
 * - Safe element access returns {@link Option}; unsafe or `NonEmpty` variants
 *   are for code that already has a proof an index or element exists.
 * - Set-like operations such as {@link union}, {@link intersection}, and
 *   {@link difference} use the {@link Equal} protocol by default. Use the
 *   `*With` variants when equality is domain-specific.
 *
 * **Common tasks**
 *
 * - Create arrays with {@link make}, {@link of}, {@link empty},
 *   {@link fromIterable}, {@link range}, {@link makeBy}, {@link replicate}, and
 *   {@link unfold}.
 * - Access edges or indexes with {@link head}, {@link last}, {@link get},
 *   {@link tail}, and {@link init}.
 * - Transform and flatten with {@link map}, {@link flatMap}, and
 *   {@link flatten}.
 * - Keep, split, or deduplicate values with {@link filter}, {@link partition},
 *   {@link dedupe}, and {@link dedupeAdjacent}.
 * - Combine collections with {@link append}, {@link prepend}, {@link appendAll},
 *   {@link prependAll}, {@link zip}, and {@link cartesian}.
 * - Chunk, window, and slice with {@link splitAt}, {@link chunksOf},
 *   {@link span}, and {@link window}.
 * - Sort with {@link sort}, {@link sortWith}, and {@link sortBy}.
 * - Fold or aggregate with {@link reduce}, {@link scan}, {@link join}, and
 *   {@link countBy}.
 * - Match empty and non-empty cases with {@link match}, {@link matchLeft}, and
 *   {@link matchRight}.
 *
 * **Gotchas**
 *
 * - {@link fromIterable} returns the original array reference when the input is
 *   already an array. Use {@link copy} when you need a fresh shallow copy.
 * - {@link makeBy}, {@link range}, and {@link replicate} always return
 *   non-empty arrays. `range(start, end)` is inclusive and returns `[start]`
 *   when `start > end`.
 * - Functions returning {@link Option}, such as {@link head} and
 *   {@link findFirst}, return `Option.none()` for empty inputs instead of
 *   throwing.
 * - `NonEmpty` return types describe what the function can prove, not what may
 *   happen for a particular runtime value after filtering.
 *
 * **Example** (Filtering and transforming)
 *
 * ```ts
 * import { Array, Option, pipe } from "effect"
 *
 * const numbers = [1, 2, 3, 4, 5]
 *
 * const doubledEvens = pipe(
 *   numbers,
 *   Array.filter((n) => n % 2 === 0),
 *   Array.map((n) => n * 2)
 * )
 *
 * console.log(doubledEvens)
 * // [4, 8]
 *
 * const first = Array.head(doubledEvens)
 * console.log(Option.getOrElse(first, () => 0))
 * // 4
 * ```
 *
 * @see {@link make} — create a non-empty array from elements
 * @see {@link map} — transform each element
 * @see {@link filter} — keep elements matching a predicate
 * @see {@link reduce} — fold an array to a single value
 *
 * @since 2.0.0
 */
import * as Equal from "./Equal.ts"
import * as Equivalence from "./Equivalence.ts"
import type { LazyArg } from "./Function.ts"
import { dual, identity } from "./Function.ts"
import type { TypeLambda } from "./HKT.ts"
import * as internalArray from "./internal/array.ts"
import * as internalDoNotation from "./internal/doNotation.ts"
import * as moduleIterable from "./Iterable.ts"
import * as Option from "./Option.ts"
import * as Order from "./Order.ts"
import type * as Predicate from "./Predicate.ts"
import * as Record from "./Record.ts"
import * as Reducer from "./Reducer.ts"
import * as Result from "./Result.ts"
import * as Tuple from "./Tuple.ts"
import type { NoInfer, TupleOf } from "./Types.ts"

/**
 * Exposes the global array constructor.
 *
 * **When to use**
 *
 * Use to access native JavaScript array constructor methods such as `isArray`
 * or `from` from the Effect module namespace.
 *
 * **Example** (Using the Array constructor)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const arr = new Array.Array(3)
 * console.log(arr) // [undefined, undefined, undefined]
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const Array = globalThis.Array

/**
 * Type lambda for `ReadonlyArray`, used for higher-kinded type operations.
 *
 * @category type lambdas
 * @since 2.0.0
 */
export interface ReadonlyArrayTypeLambda extends TypeLambda {
  readonly type: ReadonlyArray<this["Target"]>
}

/**
 * A readonly array guaranteed to have at least one element.
 *
 * **When to use**
 *
 * Use when you use this type when you need to ensure non-emptiness at the type level while
 * preventing mutation. Many Array module functions accept or return this type.
 *
 * **Example** (Typing a non-empty array)
 *
 * ```ts
 * import type { Array } from "effect"
 *
 * const nonEmpty: Array.NonEmptyReadonlyArray<number> = [1, 2, 3]
 * const head: number = nonEmpty[0] // guaranteed to exist
 * ```
 *
 * @see {@link NonEmptyArray} — mutable counterpart
 * @see {@link isReadonlyArrayNonEmpty} — narrow a `ReadonlyArray` to this type
 *
 * @category models
 * @since 2.0.0
 */
export type NonEmptyReadonlyArray<A> = readonly [A, ...Array<A>]

/**
 * A mutable array guaranteed to have at least one element.
 *
 * **When to use**
 *
 * Use when mutation is acceptable and non-emptiness must be tracked at the type
 * level.
 *
 * **Details**
 *
 * This is the mutable counterpart of {@link NonEmptyReadonlyArray}. Most Array
 * module functions return `NonEmptyArray` when the result is guaranteed
 * non-empty.
 *
 * **Example** (Typing a mutable non-empty array)
 *
 * ```ts
 * import type { Array } from "effect"
 *
 * const nonEmpty: Array.NonEmptyArray<number> = [1, 2, 3]
 * nonEmpty.push(4)
 * ```
 *
 * @see {@link NonEmptyReadonlyArray} — readonly counterpart
 * @see {@link isArrayNonEmpty} — narrow an `Array` to this type
 *
 * @category models
 * @since 2.0.0
 */
export type NonEmptyArray<A> = [A, ...Array<A>]

/**
 * Creates a `NonEmptyArray` from one or more elements.
 *
 * **When to use**
 *
 * Use when you have literal values and want a typed non-empty array.
 * - The element type is inferred as the union of all arguments.
 * - Always returns a `NonEmptyArray` since at least one argument is required.
 *
 * **Example** (Creating an array from values)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.make(1, 2, 3)
 * console.log(result) // [1, 2, 3]
 * ```
 *
 * @see {@link of} — create a single-element array
 * @see {@link fromIterable} — create from any iterable
 *
 * @category constructors
 * @since 2.0.0
 */
export const make = <Elements extends NonEmptyArray<unknown>>(
  ...elements: Elements
): NonEmptyArray<Elements[number]> => elements

/**
 * Creates a new `Array` of the specified length with all slots uninitialized.
 *
 * **When to use**
 *
 * Use when you need a pre-sized array and will fill it imperatively.
 * - Elements are typed as `A | undefined` since slots are empty.
 * - Prefer {@link makeBy} when you can compute each element from its index.
 *
 * **Example** (Allocating a fixed-size array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.allocate<number>(3)
 * console.log(result.length) // 3
 * ```
 *
 * @see {@link makeBy} — create an array by computing each element
 *
 * @category constructors
 * @since 2.0.0
 */
export const allocate = <A = never>(n: number): Array<A | undefined> => new Array(n)

/**
 * Creates a `NonEmptyArray` of length `n` where element `i` is computed by `f(i)`.
 *
 * **When to use**
 *
 * Use when you need an array whose values depend on the index.
 * - `n` is normalized to an integer >= 1 — always returns at least one element.
 * - Dual: `Array.makeBy(5, f)` or `pipe(5, Array.makeBy(f))`.
 *
 * **Example** (Generating values from indices)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.makeBy(5, (n) => n * 2)
 * console.log(result) // [0, 2, 4, 6, 8]
 * ```
 *
 * @see {@link range} — create a range of integers
 * @see {@link replicate} — repeat a single value
 *
 * @category constructors
 * @since 2.0.0
 */
export const makeBy: {
  <A>(f: (i: number) => A): (n: number) => NonEmptyArray<A>
  <A>(n: number, f: (i: number) => A): NonEmptyArray<A>
} = dual(2, <A>(n: number, f: (i: number) => A) => {
  const max = Math.max(1, Math.floor(n))
  const out = new Array(max)
  for (let i = 0; i < max; i++) {
    out[i] = f(i)
  }
  return out as NonEmptyArray<A>
})

/**
 * Creates a `NonEmptyArray` containing a range of integers, inclusive on both
 * ends.
 *
 * **When to use**
 *
 * Use when you need a sequence of consecutive integers.
 * - If `start > end`, returns `[start]`.
 * - Always returns a `NonEmptyArray`.
 *
 * **Example** (Creating a range)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.range(1, 3)
 * console.log(result) // [1, 2, 3]
 * ```
 *
 * @see {@link makeBy} — generate values from a function
 *
 * @category constructors
 * @since 2.0.0
 */
export const range = (start: number, end: number): NonEmptyArray<number> =>
  start <= end ? makeBy(end - start + 1, (i) => start + i) : [start]

/**
 * Creates a `NonEmptyArray` containing a value repeated `n` times.
 *
 * **When to use**
 *
 * Use when you need multiple copies of the same value.
 * - `n` is normalized to an integer >= 1 — always returns at least one element.
 * - Dual: `Array.replicate("a", 3)` or `pipe("a", Array.replicate(3))`.
 *
 * **Example** (Repeating a value)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.replicate("a", 3)
 * console.log(result) // ["a", "a", "a"]
 * ```
 *
 * @see {@link makeBy} — vary values based on index
 *
 * @category constructors
 * @since 2.0.0
 */
export const replicate: {
  (n: number): <A>(a: A) => NonEmptyArray<A>
  <A>(a: A, n: number): NonEmptyArray<A>
} = dual(2, <A>(a: A, n: number): NonEmptyArray<A> => makeBy(n, () => a))

/**
 * Converts an `Iterable` to an `Array`.
 *
 * **When to use**
 *
 * Use to convert any `Iterable` (Set, Generator, etc.) into an array.
 *
 * **Details**
 *
 * - If the input is already an array, returns it **by reference** (no copy).
 * - Otherwise, creates a new array from the iterable.
 * - Use {@link copy} if you need a fresh array even when the input is already
 *   an array.
 *
 * **Example** (Converting a Set to an array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.fromIterable(new Set([1, 2, 3]))
 * console.log(result) // [1, 2, 3]
 * ```
 *
 * @see {@link ensure} — wrap a single value or return an existing array
 * @see {@link copy} — create a shallow copy of an array
 *
 * @category constructors
 * @since 2.0.0
 */
export const fromIterable = <A>(collection: Iterable<A>): Array<A> =>
  Array.isArray(collection) ? collection : Array.from(collection)

/**
 * Normalizes a value that is either a single element or an array into an array.
 *
 * **When to use**
 *
 * Use to normalize input that may be a single value or an array into a consistent
 * array.
 *
 * **Details**
 *
 * - If the input is already an array, returns it by reference.
 * - If the input is a single value, wraps it in a one-element array.
 * - Useful for APIs that accept `A | Array<A>`.
 *
 * **Example** (Normalizing input)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.ensure("a")) // ["a"]
 * console.log(Array.ensure(["a", "b", "c"])) // ["a", "b", "c"]
 * ```
 *
 * @see {@link of} — always wrap in a single-element array
 * @see {@link fromIterable} — convert any iterable
 *
 * @category constructors
 * @since 3.3.0
 */
export const ensure = <A>(self: ReadonlyArray<A> | A): Array<A> => Array.isArray(self) ? self : [self as A]

/**
 * Converts a record into an array of `[key, value]` tuples.
 *
 * **When to use**
 *
 * Use to convert a record into an array of key-value tuples for iteration or
 * transformation.
 *
 * **Details**
 *
 * - Key order follows `Object.entries` semantics.
 * - Returns an empty array for an empty record.
 *
 * **Example** (Record to entries)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.fromRecord({ a: 1, b: 2, c: 3 })
 * console.log(result) // [["a", 1], ["b", 2], ["c", 3]]
 * ```
 *
 * @see {@link Record.toEntries} the equivalent function from the Record module
 * @see {@link Record.fromEntries} to build a record from an array of tuples
 *
 * @category converting
 * @since 2.0.0
 */
export const fromRecord: <K extends string, A>(self: Readonly<Record<K, A>>) => Array<[K, A]> = Record.toEntries

/**
 * Converts an `Option` to an array: `Some(a)` becomes `[a]`, `None` becomes `[]`.
 *
 * **When to use**
 *
 * Use to convert a single `Option` into an array for downstream array operations.
 *
 * **Example** (Option to array)
 *
 * ```ts
 * import { Array, Option } from "effect"
 *
 * console.log(Array.fromOption(Option.some(1))) // [1]
 * console.log(Array.fromOption(Option.none())) // []
 * ```
 *
 * @see {@link getSomes} — extract `Some` values from an array of Options
 *
 * @category converting
 * @since 2.0.0
 */
export const fromOption: <A>(self: Option.Option<A>) => Array<A> = Option.toArray

/**
 * Pattern-matches on an array, handling empty and non-empty cases separately.
 *
 * **When to use**
 *
 * Use when you need to branch on whether an array has elements.
 * - `onNonEmpty` receives a `NonEmptyReadonlyArray`.
 * - Dual: data-first or data-last.
 *
 * **Example** (Branching on emptiness)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const describe = Array.match({
 *   onEmpty: () => "empty",
 *   onNonEmpty: ([head, ...tail]) => `head: ${head}, tail: ${tail.length}`
 * })
 * console.log(describe([])) // "empty"
 * console.log(describe([1, 2, 3])) // "head: 1, tail: 2"
 * ```
 *
 * @see {@link matchLeft} — destructures into head + tail
 * @see {@link matchRight} — destructures into init + last
 *
 * @category pattern matching
 * @since 2.0.0
 */
export const match: {
  <B, A, C = B>(
    options: {
      readonly onEmpty: LazyArg<B>
      readonly onNonEmpty: (self: NonEmptyReadonlyArray<A>) => C
    }
  ): (self: ReadonlyArray<A>) => B | C
  <A, B, C = B>(
    self: ReadonlyArray<A>,
    options: {
      readonly onEmpty: LazyArg<B>
      readonly onNonEmpty: (self: NonEmptyReadonlyArray<A>) => C
    }
  ): B | C
} = dual(2, <A, B, C = B>(
  self: ReadonlyArray<A>,
  { onEmpty, onNonEmpty }: {
    readonly onEmpty: LazyArg<B>
    readonly onNonEmpty: (self: NonEmptyReadonlyArray<A>) => C
  }
): B | C => isReadonlyArrayNonEmpty(self) ? onNonEmpty(self) : onEmpty())

/**
 * Pattern-matches on an array from the left, providing the first element and
 * the remaining elements separately.
 *
 * **When to use**
 *
 * Use to pattern-match when you need the first element and remaining elements as
 * separate values.
 *
 * **Details**
 *
 * `onNonEmpty` receives `(head, tail)` where `tail` is the rest of the array.
 *
 * **Example** (Head and tail destructuring)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const matchLeft = Array.matchLeft({
 *   onEmpty: () => "empty",
 *   onNonEmpty: (head, tail) => `head: ${head}, tail: ${tail.length}`
 * })
 * console.log(matchLeft([])) // "empty"
 * console.log(matchLeft([1, 2, 3])) // "head: 1, tail: 2"
 * ```
 *
 * @see {@link match} — receives the full non-empty array
 * @see {@link matchRight} — destructures into init + last
 *
 * @category pattern matching
 * @since 2.0.0
 */
export const matchLeft: {
  <B, A, C = B>(
    options: {
      readonly onEmpty: LazyArg<B>
      readonly onNonEmpty: (head: A, tail: Array<A>) => C
    }
  ): (self: ReadonlyArray<A>) => B | C
  <A, B, C = B>(
    self: ReadonlyArray<A>,
    options: {
      readonly onEmpty: LazyArg<B>
      readonly onNonEmpty: (head: A, tail: Array<A>) => C
    }
  ): B | C
} = dual(2, <A, B, C = B>(
  self: ReadonlyArray<A>,
  { onEmpty, onNonEmpty }: {
    readonly onEmpty: LazyArg<B>
    readonly onNonEmpty: (head: A, tail: Array<A>) => C
  }
): B | C => isReadonlyArrayNonEmpty(self) ? onNonEmpty(headNonEmpty(self), tailNonEmpty(self)) : onEmpty())

/**
 * Pattern-matches on an array from the right, providing all elements except the
 * last and the last element separately.
 *
 * **When to use**
 *
 * Use to pattern-match when you need all but the last element and the last element
 * as separate values.
 *
 * **Details**
 *
 * `onNonEmpty` receives `(init, last)` where `init` is everything but the last element.
 *
 * **Example** (Init and last destructuring)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const matchRight = Array.matchRight({
 *   onEmpty: () => "empty",
 *   onNonEmpty: (init, last) => `init: ${init.length}, last: ${last}`
 * })
 * console.log(matchRight([])) // "empty"
 * console.log(matchRight([1, 2, 3])) // "init: 2, last: 3"
 * ```
 *
 * @see {@link match} — receives the full non-empty array
 * @see {@link matchLeft} — destructures into head + tail
 *
 * @category pattern matching
 * @since 2.0.0
 */
export const matchRight: {
  <B, A, C = B>(
    options: {
      readonly onEmpty: LazyArg<B>
      readonly onNonEmpty: (init: Array<A>, last: A) => C
    }
  ): (self: ReadonlyArray<A>) => B | C
  <A, B, C = B>(
    self: ReadonlyArray<A>,
    options: {
      readonly onEmpty: LazyArg<B>
      readonly onNonEmpty: (init: Array<A>, last: A) => C
    }
  ): B | C
} = dual(2, <A, B, C = B>(
  self: ReadonlyArray<A>,
  { onEmpty, onNonEmpty }: {
    readonly onEmpty: LazyArg<B>
    readonly onNonEmpty: (init: Array<A>, last: A) => C
  }
): B | C =>
  isReadonlyArrayNonEmpty(self) ?
    onNonEmpty(initNonEmpty(self), lastNonEmpty(self)) :
    onEmpty())

/**
 * Adds a single element to the front of an iterable, returning a `NonEmptyArray`.
 *
 * **When to use**
 *
 * Use to add a single element at the start of an iterable and get a `NonEmptyArray`.
 *
 * **Details**
 *
 * - Always returns a non-empty array.
 *
 * **Example** (Prepending an element)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.prepend([2, 3, 4], 1)
 * console.log(result) // [1, 2, 3, 4]
 * ```
 *
 * @see {@link append} — add to the end
 * @see {@link prependAll} — prepend multiple elements
 *
 * @category concatenating
 * @since 2.0.0
 */
export const prepend: {
  <B>(head: B): <A>(self: Iterable<A>) => NonEmptyArray<A | B>
  <A, B>(self: Iterable<A>, head: B): NonEmptyArray<A | B>
} = dual(2, <A, B>(self: Iterable<A>, head: B): NonEmptyArray<A | B> => [head, ...self])

/**
 * Prepends all elements from a prefix iterable to the front of an array.
 *
 * **When to use**
 *
 * Use to prepend multiple elements from an iterable to the front of an array.
 *
 * **Details**
 *
 * - If either input is non-empty, the result is a `NonEmptyArray`.
 *
 * **Example** (Prepending multiple elements)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.prependAll([2, 3], [0, 1])
 * console.log(result) // [0, 1, 2, 3]
 * ```
 *
 * @see {@link prepend} — add a single element to the front
 * @see {@link appendAll} — add elements to the end
 *
 * @category concatenating
 * @since 2.0.0
 */
export const prependAll: {
  <S extends Iterable<any>, T extends Iterable<any>>(
    that: T
  ): (self: S) => ReadonlyArray.OrNonEmpty<S, T, ReadonlyArray.Infer<S> | ReadonlyArray.Infer<T>>
  <A, B>(self: Iterable<A>, that: NonEmptyReadonlyArray<B>): NonEmptyArray<A | B>
  <A, B>(self: NonEmptyReadonlyArray<A>, that: Iterable<B>): NonEmptyArray<A | B>
  <A, B>(self: Iterable<A>, that: Iterable<B>): Array<A | B>
} = dual(
  2,
  <A>(self: Iterable<A>, that: Iterable<A>): Array<A> => fromIterable(that).concat(fromIterable(self))
)

/**
 * Adds a single element to the end of an iterable, returning a `NonEmptyArray`.
 *
 * **When to use**
 *
 * Use to add one element to the end of an iterable and get a new
 * `NonEmptyArray`.
 *
 * **Details**
 *
 * - Always returns a non-empty array.
 *
 * **Example** (Appending an element)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.append([1, 2, 3], 4)
 * console.log(result) // [1, 2, 3, 4]
 * ```
 *
 * @see {@link prepend} — add to the front
 * @see {@link appendAll} — append multiple elements
 *
 * @category concatenating
 * @since 2.0.0
 */
export const append: {
  <B>(last: B): <A>(self: Iterable<A>) => NonEmptyArray<A | B>
  <A, B>(self: Iterable<A>, last: B): NonEmptyArray<A | B>
} = dual(2, <A, B>(self: Iterable<A>, last: B): Array<A | B> => [...self, last])

/**
 * Concatenates two iterables into a single array.
 *
 * **When to use**
 *
 * Use to combine two iterable inputs into a new array with the second input's
 * elements after the first.
 *
 * **Details**
 *
 * - If either input is non-empty, the result is a `NonEmptyArray`.
 *
 * **Example** (Concatenating arrays)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.appendAll([1, 2], [3, 4])
 * console.log(result) // [1, 2, 3, 4]
 * ```
 *
 * @see {@link append} — add a single element to the end
 * @see {@link prependAll} — add elements to the front
 *
 * @category concatenating
 * @since 2.0.0
 */
export const appendAll: {
  <S extends Iterable<any>, T extends Iterable<any>>(
    that: T
  ): (self: S) => ReadonlyArray.OrNonEmpty<S, T, ReadonlyArray.Infer<S> | ReadonlyArray.Infer<T>>
  <A, B>(self: Iterable<A>, that: NonEmptyReadonlyArray<B>): NonEmptyArray<A | B>
  <A, B>(self: NonEmptyReadonlyArray<A>, that: Iterable<B>): NonEmptyArray<A | B>
  <A, B>(self: Iterable<A>, that: Iterable<B>): Array<A | B>
} = dual(
  2,
  <A>(self: Iterable<A>, that: Iterable<A>): Array<A> => fromIterable(self).concat(fromIterable(that))
)

/**
 * Folds left-to-right while keeping every intermediate accumulator value.
 *
 * **When to use**
 *
 * Use to compute a running accumulator where each intermediate value is needed.
 *
 * **Details**
 *
 * - The output length is `input.length + 1` (starts with the initial value).
 * - Always returns a `NonEmptyArray` because the initial value is included.
 * - Use {@link reduce} if you only need the final accumulated value.
 *
 * **Example** (Running totals)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.scan([1, 2, 3, 4], 0, (acc, value) => acc + value)
 * console.log(result) // [0, 1, 3, 6, 10]
 * ```
 *
 * @see {@link scanRight} — right-to-left scan
 * @see {@link reduce} — fold without intermediate values
 *
 * @category folding
 * @since 2.0.0
 */
export const scan: {
  <B, A>(b: B, f: (b: B, a: A) => B): (self: Iterable<A>) => NonEmptyArray<B>
  <A, B>(self: Iterable<A>, b: B, f: (b: B, a: A) => B): NonEmptyArray<B>
} = dual(3, <A, B>(self: Iterable<A>, b: B, f: (b: B, a: A) => B): NonEmptyArray<B> => {
  const out: NonEmptyArray<B> = [b]
  let i = 0
  for (const a of self) {
    out[i + 1] = f(out[i], a)
    i++
  }
  return out
})

/**
 * Folds right-to-left while keeping every intermediate accumulator value.
 *
 * **When to use**
 *
 * Use to compute a running accumulator from right to left where each intermediate
 * value is needed.
 *
 * **Details**
 *
 * - The output length is `input.length + 1` (ends with the initial value).
 * - Always returns a `NonEmptyArray`.
 *
 * **Example** (Reverse running totals)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.scanRight([1, 2, 3, 4], 0, (acc, value) => acc + value)
 * console.log(result) // [10, 9, 7, 4, 0]
 * ```
 *
 * @see {@link scan} — left-to-right scan
 * @see {@link reduceRight} — fold without intermediate values
 *
 * @category folding
 * @since 2.0.0
 */
export const scanRight: {
  <B, A>(b: B, f: (b: B, a: A) => B): (self: Iterable<A>) => NonEmptyArray<B>
  <A, B>(self: Iterable<A>, b: B, f: (b: B, a: A) => B): NonEmptyArray<B>
} = dual(3, <A, B>(self: Iterable<A>, b: B, f: (b: B, a: A) => B): NonEmptyArray<B> => {
  const input = fromIterable(self)
  const out: NonEmptyArray<B> = new Array(input.length + 1) as any
  out[input.length] = b
  for (let i = input.length - 1; i >= 0; i--) {
    out[i] = f(out[i + 1], input[i])
  }
  return out
})

/**
 * Checks whether a value is an `Array`.
 *
 * **When to use**
 *
 * Use to verify a value is a mutable array, narrowing its type to `Array<unknown>`.
 *
 * **Details**
 *
 * - Acts as a type guard narrowing the input to `Array<unknown>`.
 * - Delegates to `globalThis.Array.isArray`.
 *
 * **Example** (Type-guarding an unknown value)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.isArray(null)) // false
 * console.log(Array.isArray([1, 2, 3])) // true
 * ```
 *
 * @see {@link isArrayEmpty} — check for an empty array
 * @see {@link isArrayNonEmpty} — check for a non-empty array
 *
 * @category guards
 * @since 2.0.0
 */
export const isArray: {
  (self: unknown): self is Array<unknown>
  <T>(self: T): self is Extract<T, ReadonlyArray<any>>
} = Array.isArray

/**
 * Checks whether a mutable `Array` is empty, narrowing the type to `[]`.
 *
 * **Example** (Checking for an empty array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.isArrayEmpty([])) // true
 * console.log(Array.isArrayEmpty([1, 2, 3])) // false
 * ```
 *
 * @see {@link isReadonlyArrayEmpty} — readonly variant
 * @see {@link isArrayNonEmpty} — opposite check
 *
 * @category guards
 * @since 4.0.0
 */
export const isArrayEmpty = <A>(self: Array<A>): self is [] => self.length === 0

/**
 * Checks whether a `ReadonlyArray` is empty, narrowing the type to `readonly []`.
 *
 * **Example** (Checking for an empty readonly array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.isReadonlyArrayEmpty([])) // true
 * console.log(Array.isReadonlyArrayEmpty([1, 2, 3])) // false
 * ```
 *
 * @see {@link isArrayEmpty} — mutable variant
 * @see {@link isReadonlyArrayNonEmpty} — opposite check
 *
 * @category guards
 * @since 4.0.0
 */
export const isReadonlyArrayEmpty: <A>(self: ReadonlyArray<A>) => self is readonly [] = isArrayEmpty as any

/**
 * Checks whether a mutable `Array` is non-empty, narrowing the type to
 * `NonEmptyArray`.
 *
 * **Example** (Checking for a non-empty array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.isArrayNonEmpty([])) // false
 * console.log(Array.isArrayNonEmpty([1, 2, 3])) // true
 * ```
 *
 * @see {@link isReadonlyArrayNonEmpty} — readonly variant
 * @see {@link isArrayEmpty} — opposite check
 *
 * @category guards
 * @since 4.0.0
 */
export const isArrayNonEmpty: <A>(self: Array<A>) => self is NonEmptyArray<A> = internalArray.isArrayNonEmpty

/**
 * Checks whether a `ReadonlyArray` is non-empty, narrowing the type to
 * `NonEmptyReadonlyArray`.
 *
 * **Example** (Checking for a non-empty readonly array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.isReadonlyArrayNonEmpty([])) // false
 * console.log(Array.isReadonlyArrayNonEmpty([1, 2, 3])) // true
 * ```
 *
 * @see {@link isArrayNonEmpty} — mutable variant
 * @see {@link isReadonlyArrayEmpty} — opposite check
 *
 * @category guards
 * @since 4.0.0
 */
export const isReadonlyArrayNonEmpty: <A>(self: ReadonlyArray<A>) => self is NonEmptyReadonlyArray<A> =
  internalArray.isArrayNonEmpty

/**
 * Returns the number of elements in a `ReadonlyArray`.
 *
 * **When to use**
 *
 * Use when you need length as a composable function rather than a property access.
 *
 * **Example** (Getting the length)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.length([1, 2, 3])) // 3
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const length = <A>(self: ReadonlyArray<A>): number => self.length

/** @internal */
export function isOutOfBounds<A>(i: number, as: ReadonlyArray<A>): boolean {
  return i < 0 || i >= as.length
}

const clamp = <A>(i: number, as: ReadonlyArray<A>): number => Math.floor(Math.min(Math.max(0, i), as.length))

/**
 * Reads an element at the given index safely, returning `Option.some` or
 * `Option.none` if the index is out of bounds.
 *
 * **When to use**
 *
 * Use when you need to read an array element by index and handle an
 * out-of-bounds index as `Option.none`.
 *
 * **Details**
 *
 * - The index is floored to an integer.
 * - Never throws.
 *
 * **Example** (Safe index access)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.get([1, 2, 3], 1)) // Some(2)
 * console.log(Array.get([1, 2, 3], 10)) // None
 * ```
 *
 * @see {@link getUnsafe} for indexed access that throws when the index is out of bounds
 * @see {@link head} for reading the first element as an `Option`
 * @see {@link last} for reading the last element as an `Option`
 *
 * @category getters
 * @since 2.0.0
 */
export const get: {
  (index: number): <A>(self: ReadonlyArray<A>) => Option.Option<A>
  <A>(self: ReadonlyArray<A>, index: number): Option.Option<A>
} = dual(2, <A>(self: ReadonlyArray<A>, index: number): Option.Option<A> => {
  const i = Math.floor(index)
  return isOutOfBounds(i, self) ? Option.none() : Option.some(self[i])
})

/**
 * Reads an element at the given index, throwing if the index is out of bounds.
 *
 * **When to use**
 *
 * Use to read an element at a known valid index when out-of-bounds would be a
 * programming error.
 *
 * **Details**
 *
 * - Throws an `Error` with the message `"Index out of bounds: <i>"`.
 * - Prefer {@link get} for safe access.
 *
 * **Example** (Unsafe index access)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.getUnsafe([1, 2, 3], 1)) // 2
 * // Array.getUnsafe([1, 2, 3], 10) // throws Error
 * ```
 *
 * @see {@link get} — safe version returning `Option`
 *
 * @category unsafe
 * @since 4.0.0
 */
export const getUnsafe: {
  (index: number): <A>(self: ReadonlyArray<A>) => A
  <A>(self: ReadonlyArray<A>, index: number): A
} = dual(2, <A>(self: ReadonlyArray<A>, index: number): A => {
  const i = Math.floor(index)
  if (isOutOfBounds(i, self)) {
    throw new Error(`Index out of bounds: ${i}`)
  }
  return self[i]
})

/**
 * Splits a non-empty array into its first element and the remaining elements.
 *
 * **When to use**
 *
 * Use when you have a `NonEmptyReadonlyArray` and need both its first element
 * and the remaining elements as separate values.
 *
 * **Details**
 *
 * - Returns a tuple `[head, tail]`.
 * - Requires a `NonEmptyReadonlyArray`.
 *
 * **Example** (Destructuring head and tail)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.unprepend([1, 2, 3, 4])
 * console.log(result) // [1, [2, 3, 4]]
 * ```
 *
 * @see {@link unappend} for splitting a non-empty array into init and last
 * @see {@link headNonEmpty} for getting only the first element
 * @see {@link tailNonEmpty} for getting only the elements after the first
 *
 * @category splitting
 * @since 2.0.0
 */
export const unprepend = <A>(
  self: NonEmptyReadonlyArray<A>
): [firstElement: A, remainingElements: Array<A>] => [headNonEmpty(self), tailNonEmpty(self)]

/**
 * Splits a non-empty array into all elements except the last, and the last
 * element.
 *
 * **When to use**
 *
 * Use to split a non-empty array from the end when you need both the elements
 * before the last element and the last element.
 *
 * **Details**
 *
 * - Returns a tuple `[init, last]`.
 * - Requires a `NonEmptyReadonlyArray`.
 *
 * **Example** (Destructuring init and last)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.unappend([1, 2, 3, 4])
 * console.log(result) // [[1, 2, 3], 4]
 * ```
 *
 * @see {@link unprepend} for splitting a non-empty array into head and tail
 * @see {@link initNonEmpty} for getting only the elements before the last
 * @see {@link lastNonEmpty} for getting only the last element
 *
 * @category splitting
 * @since 2.0.0
 */
export const unappend = <A>(
  self: NonEmptyReadonlyArray<A>
): [arrayWithoutLastElement: Array<A>, lastElement: A] => [initNonEmpty(self), lastNonEmpty(self)]

/**
 * Returns the first element of an array safely wrapped in `Option.some`, or
 * `Option.none` if the array is empty.
 *
 * **When to use**
 *
 * Use to safely get the first element of an array that may be empty.
 *
 * **Example** (Getting the first element)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.head([1, 2, 3])) // Some(1)
 * console.log(Array.head([])) // None
 * ```
 *
 * @see {@link headNonEmpty} — direct access when array is known non-empty
 * @see {@link last} — get the last element
 *
 * @category getters
 * @since 2.0.0
 */
export const head: <A>(self: ReadonlyArray<A>) => Option.Option<A> = get(0)

/**
 * Returns the first element of a `NonEmptyReadonlyArray` directly (no `Option`
 * wrapper).
 *
 * **When to use**
 *
 * Use to get the first element without `Option` wrapping when the array is known
 * to be non-empty.
 *
 * **Example** (Getting the head of a non-empty array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.headNonEmpty([1, 2, 3, 4])) // 1
 * ```
 *
 * @see {@link head} — safe version for possibly-empty arrays
 *
 * @category getters
 * @since 2.0.0
 */
export const headNonEmpty: <A>(self: NonEmptyReadonlyArray<A>) => A = getUnsafe(0)

/**
 * Returns the last element of an array safely wrapped in `Option.some`, or
 * `Option.none` if the array is empty.
 *
 * **When to use**
 *
 * Use to safely get the last element of an array that may be empty.
 *
 * **Example** (Getting the last element)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.last([1, 2, 3])) // Some(3)
 * console.log(Array.last([])) // None
 * ```
 *
 * @see {@link lastNonEmpty} — direct access when array is known non-empty
 * @see {@link head} — get the first element
 *
 * @category getters
 * @since 2.0.0
 */
export const last = <A>(self: ReadonlyArray<A>): Option.Option<A> =>
  isReadonlyArrayNonEmpty(self) ? Option.some(lastNonEmpty(self)) : Option.none()

/**
 * Returns the last element of a `NonEmptyReadonlyArray` directly (no `Option`
 * wrapper).
 *
 * **When to use**
 *
 * Use to get the last element without `Option` wrapping when the array is known
 * to be non-empty.
 *
 * **Example** (Getting the last of a non-empty array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.lastNonEmpty([1, 2, 3, 4])) // 4
 * ```
 *
 * @see {@link last} — safe version for possibly-empty arrays
 *
 * @category getters
 * @since 2.0.0
 */
export const lastNonEmpty = <A>(self: NonEmptyReadonlyArray<A>): A => self[self.length - 1]

/**
 * Returns all elements except the first safely, wrapped in an `Option`.
 *
 * **When to use**
 *
 * Use to safely get all elements after the first when the iterable may be empty.
 *
 * **Details**
 *
 * - Allocates a new array via `slice(1)`.
 * - Returns `Option.none()` for empty inputs.
 *
 * **Example** (Getting the tail)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.tail([1, 2, 3, 4])) // Option.some([2, 3, 4])
 * console.log(Array.tail([])) // Option.none()
 * ```
 *
 * @see {@link tailNonEmpty} — when the array is known non-empty
 * @see {@link init} — all elements except the last
 *
 * @category getters
 * @since 2.0.0
 */
export function tail<A>(self: Iterable<A>): Option.Option<Array<A>> {
  const as = fromIterable(self)
  return isReadonlyArrayNonEmpty(as) ? Option.some(tailNonEmpty(as)) : Option.none()
}

/**
 * Returns all elements except the first of a `NonEmptyReadonlyArray`.
 *
 * **When to use**
 *
 * Use to get all elements after the first when the array is known to be non-empty.
 *
 * **Example** (Getting the tail of a non-empty array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.tailNonEmpty([1, 2, 3, 4])) // [2, 3, 4]
 * ```
 *
 * @see {@link tail} — safe version for possibly-empty arrays
 * @see {@link initNonEmpty} — all elements except the last
 *
 * @category getters
 * @since 2.0.0
 */
export const tailNonEmpty = <A>(self: NonEmptyReadonlyArray<A>): Array<A> => self.slice(1)

/**
 * Returns all elements except the last safely, wrapped in an `Option`.
 *
 * **When to use**
 *
 * Use to safely get all elements before the last when the iterable may be empty.
 *
 * **Details**
 *
 * - Allocates a new array via `slice(0, -1)`.
 * - Returns `Option.none()` for empty inputs.
 *
 * **Example** (Getting init)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.init([1, 2, 3, 4])) // Option.some([1, 2, 3])
 * console.log(Array.init([])) // Option.none()
 * ```
 *
 * @see {@link initNonEmpty} — when the array is known non-empty
 * @see {@link tail} — all elements except the first
 *
 * @category getters
 * @since 2.0.0
 */
export function init<A>(self: Iterable<A>): Option.Option<Array<A>> {
  const as = fromIterable(self)
  return isReadonlyArrayNonEmpty(as) ? Option.some(initNonEmpty(as)) : Option.none()
}

/**
 * Returns all elements except the last of a `NonEmptyReadonlyArray`.
 *
 * **When to use**
 *
 * Use to get all elements before the last when the array is known to be non-empty.
 *
 * **Example** (Getting init of a non-empty array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.initNonEmpty([1, 2, 3, 4])) // [1, 2, 3]
 * ```
 *
 * @see {@link init} — safe version for possibly-empty arrays
 * @see {@link tailNonEmpty} — all elements except the first
 *
 * @category getters
 * @since 2.0.0
 */
export const initNonEmpty = <A>(self: NonEmptyReadonlyArray<A>): Array<A> => self.slice(0, -1)

/**
 * Keeps the first `n` elements, creating a new array.
 *
 * **When to use**
 *
 * Use to keep up to the first `n` elements from an iterable as a new array.
 *
 * **Details**
 *
 * - `n` is clamped to `[0, length]`.
 * - Returns an empty array when `n <= 0`.
 *
 * **Example** (Taking from the start)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.take([1, 2, 3, 4, 5], 3)) // [1, 2, 3]
 * ```
 *
 * @see {@link takeRight} for keeping elements from the end
 * @see {@link takeWhile} for keeping an initial prefix while a predicate holds
 * @see {@link drop} for removing elements from the start
 *
 * @category getters
 * @since 2.0.0
 */
export const take: {
  (n: number): <A>(self: Iterable<A>) => Array<A>
  <A>(self: Iterable<A>, n: number): Array<A>
} = dual(2, <A>(self: Iterable<A>, n: number): Array<A> => {
  const input = fromIterable(self)
  return input.slice(0, clamp(n, input))
})

/**
 * Keeps the last `n` elements, creating a new array.
 *
 * **When to use**
 *
 * Use to keep the last `n` elements of an iterable.
 *
 * **Details**
 *
 * - `n` is clamped to `[0, length]`.
 * - Returns an empty array when `n <= 0`.
 *
 * **Example** (Taking from the end)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.takeRight([1, 2, 3, 4, 5], 3)) // [3, 4, 5]
 * ```
 *
 * @see {@link take} — keep from the start
 * @see {@link dropRight} — remove from the end
 *
 * @category getters
 * @since 2.0.0
 */
export const takeRight: {
  (n: number): <A>(self: Iterable<A>) => Array<A>
  <A>(self: Iterable<A>, n: number): Array<A>
} = dual(2, <A>(self: Iterable<A>, n: number): Array<A> => {
  const input = fromIterable(self)
  const i = clamp(n, input)
  return i === 0 ? [] : input.slice(-i)
})

/**
 * Takes elements from the start while the predicate holds, stopping at the
 * first element that fails.
 *
 * **When to use**
 *
 * Use to keep the leading elements of an iterable while each element satisfies
 * a predicate, returning the retained prefix as an array.
 *
 * **Details**
 *
 * - Supports refinements for type narrowing.
 * - The predicate receives `(element, index)`.
 *
 * **Example** (Taking while condition holds)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.takeWhile([1, 3, 2, 4, 1, 2], (x) => x < 4)) // [1, 3, 2]
 * ```
 *
 * @see {@link take} for keeping a fixed number of leading elements
 * @see {@link dropWhile} for removing the matching prefix and keeping the rest
 * @see {@link span} for splitting the matching prefix from the remaining elements
 *
 * @category getters
 * @since 2.0.0
 */
export const takeWhile: {
  <A, B extends A>(refinement: (a: NoInfer<A>, i: number) => a is B): (self: Iterable<A>) => Array<B>
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => Array<A>
  <A, B extends A>(self: Iterable<A>, refinement: (a: A, i: number) => a is B): Array<B>
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Array<A>
} = dual(2, <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Array<A> => {
  let i = 0
  const out: Array<A> = []
  for (const a of self) {
    if (!predicate(a, i)) {
      break
    }
    out.push(a)
    i++
  }
  return out
})

/**
 * Takes elements from the start while a `Filter` succeeds, collecting transformed values.
 *
 * **When to use**
 *
 * Use when you need to take a prefix of elements while a function can
 * successfully extract or transform them, stopping at the first element
 * that produces a failure result.
 *
 * **Details**
 *
 * - The filter receives `(element, index)`.
 * - Stops at the first filter failure.
 *
 * @see {@link takeWhile} for taking a prefix based on a boolean predicate
 *
 * @category getters
 * @since 4.0.0
 */
export const takeWhileFilter: {
  <A, B, X>(f: (input: NoInfer<A>, i: number) => Result.Result<B, X>): (self: Iterable<A>) => Array<B>
  <A, B, X>(self: Iterable<A>, f: (input: NoInfer<A>, i: number) => Result.Result<B, X>): Array<B>
} = dual(2, <A, B, X>(self: Iterable<A>, f: (input: NoInfer<A>, i: number) => Result.Result<B, X>): Array<B> => {
  let i = 0
  const out: Array<B> = []
  for (const a of self) {
    const result = f(a, i)
    if (Result.isFailure(result)) {
      break
    }
    out.push(result.success)
    i++
  }
  return out
})

const spanIndex = <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): number => {
  let i = 0
  for (const a of self) {
    if (!predicate(a, i)) {
      break
    }
    i++
  }
  return i
}

/**
 * Splits an iterable into two arrays: the longest prefix where the predicate
 * holds, and the remaining elements.
 *
 * **When to use**
 *
 * Use to split an iterable into the longest prefix that satisfies a predicate
 * and the elements after that prefix when you need both parts.
 *
 * **Details**
 *
 * - Equivalent to `[takeWhile(pred), dropWhile(pred)]` but more efficient
 *   (single pass).
 * - Supports refinements for type narrowing of the prefix.
 *
 * **Example** (Splitting at predicate boundary)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.span([1, 3, 2, 4, 5], (x) => x % 2 === 1)) // [[1, 3], [2, 4, 5]]
 * ```
 *
 * @see {@link takeWhile} for keeping only the matching prefix
 * @see {@link dropWhile} for keeping only the elements after the matching prefix
 * @see {@link splitWhere} for splitting at the first element that satisfies a predicate
 *
 * @category splitting
 * @since 2.0.0
 */
export const span: {
  <A, B extends A>(
    refinement: (a: NoInfer<A>, i: number) => a is B
  ): (self: Iterable<A>) => [init: Array<B>, rest: Array<Exclude<A, B>>]
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => [init: Array<A>, rest: Array<A>]
  <A, B extends A>(
    self: Iterable<A>,
    refinement: (a: A, i: number) => a is B
  ): [init: Array<B>, rest: Array<Exclude<A, B>>]
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): [init: Array<A>, rest: Array<A>]
} = dual(
  2,
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): [init: Array<A>, rest: Array<A>] => {
    const input = fromIterable(self)
    return splitAt(input, spanIndex(input, predicate))
  }
)

/**
 * Removes the first `n` elements, creating a new array.
 *
 * **When to use**
 *
 * Use to keep the suffix of an iterable after skipping a fixed number of
 * leading elements.
 *
 * **Details**
 *
 * - `n` is clamped to `[0, length]`.
 * - Returns a copy of the full array when `n <= 0`.
 *
 * **Example** (Dropping from the start)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.drop([1, 2, 3, 4, 5], 2)) // [3, 4, 5]
 * ```
 *
 * @see {@link dropRight} for removing a fixed number of elements from the end
 * @see {@link dropWhile} for removing a prefix based on a predicate instead of a fixed count
 * @see {@link take} for keeping a fixed number of elements from the start
 *
 * @category getters
 * @since 2.0.0
 */
export const drop: {
  (n: number): <A>(self: Iterable<A>) => Array<A>
  <A>(self: Iterable<A>, n: number): Array<A>
} = dual(2, <A>(self: Iterable<A>, n: number): Array<A> => {
  const input = fromIterable(self)
  return input.slice(clamp(n, input), input.length)
})

/**
 * Removes the last `n` elements, creating a new array.
 *
 * **When to use**
 *
 * Use to remove the last `n` elements from an iterable.
 *
 * **Details**
 *
 * `n` is clamped to `[0, length]`.
 *
 * **Example** (Dropping from the end)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.dropRight([1, 2, 3, 4, 5], 2)) // [1, 2, 3]
 * ```
 *
 * @see {@link drop} — remove from the start
 * @see {@link takeRight} — keep from the end
 *
 * @category getters
 * @since 2.0.0
 */
export const dropRight: {
  (n: number): <A>(self: Iterable<A>) => Array<A>
  <A>(self: Iterable<A>, n: number): Array<A>
} = dual(2, <A>(self: Iterable<A>, n: number): Array<A> => {
  const input = fromIterable(self)
  return input.slice(0, input.length - clamp(n, input))
})

/**
 * Drops elements from the start while the predicate holds, returning the rest.
 *
 * **When to use**
 *
 * Use to remove a leading prefix of elements that satisfy a predicate.
 *
 * **Details**
 *
 * The predicate receives `(element, index)`.
 *
 * **Example** (Dropping while condition holds)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.dropWhile([1, 2, 3, 4, 5], (x) => x < 4)) // [4, 5]
 * ```
 *
 * @see {@link takeWhile} — keep the matching prefix instead
 * @see {@link drop} — drop a fixed count
 *
 * @category getters
 * @since 2.0.0
 */
export const dropWhile: {
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => Array<A>
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Array<A>
} = dual(2, <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Array<A> => {
  const input = fromIterable(self)
  let i = 0
  while (i < input.length) {
    if (!predicate(input[i], i)) {
      break
    }
    i++
  }
  return input.slice(i)
})

/**
 * Drops elements from the start while a `Filter` succeeds.
 *
 * **When to use**
 *
 * Use when dropping a prefix requires computing a `Result` per element instead
 * of a simple boolean predicate.
 *
 * **Details**
 *
 * - The filter receives `(element, index)`.
 * - Returns the remaining original elements after the first filter failure.
 *
 * @see {@link dropWhile} for dropping a prefix with a simple boolean predicate
 * @see {@link takeWhileFilter} for keeping only the matching prefix
 *
 * @category getters
 * @since 4.0.0
 */
export const dropWhileFilter: {
  <A, B, X>(f: (input: NoInfer<A>, i: number) => Result.Result<B, X>): (self: Iterable<A>) => Array<A>
  <A, B, X>(self: Iterable<A>, f: (input: A, i: number) => Result.Result<B, X>): Array<A>
} = dual(
  2,
  <A, B, X>(self: Iterable<A>, f: (input: A, i: number) => Result.Result<B, X>): Array<A> => {
    const input = fromIterable(self)
    let i = 0
    while (i < input.length) {
      if (Result.isFailure(f(input[i], i))) {
        break
      }
      i++
    }
    return input.slice(i)
  }
)

/**
 * Returns the index of the first element matching the predicate, wrapped in an
 * `Option`.
 *
 * **When to use**
 *
 * Use to find the index of the first matching element from the start of an
 * iterable.
 *
 * **Example** (Finding an index)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.findFirstIndex([5, 3, 8, 9], (x) => x > 5)) // Option.some(2)
 * ```
 *
 * @see {@link findLastIndex} — search from the end
 * @see {@link findFirst} — get the element itself
 *
 * @category elements
 * @since 2.0.0
 */
export const findFirstIndex: {
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => Option.Option<number>
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Option.Option<number>
} = dual(2, <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Option.Option<number> => {
  let i = 0
  for (const a of self) {
    if (predicate(a, i)) {
      return Option.some(i)
    }
    i++
  }
  return Option.none()
})

/**
 * Returns the index of the last element matching the predicate, wrapped in an
 * `Option`.
 *
 * **When to use**
 *
 * Use to find the index of the last matching element from the end of an array.
 *
 * **Example** (Finding the last matching index)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.findLastIndex([1, 3, 8, 9], (x) => x < 5)) // Option.some(1)
 * ```
 *
 * @see {@link findFirstIndex} — search from the start
 * @see {@link findLast} — get the element itself
 *
 * @category elements
 * @since 2.0.0
 */
export const findLastIndex: {
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => Option.Option<number>
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Option.Option<number>
} = dual(2, <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Option.Option<number> => {
  const input = fromIterable(self)
  for (let i = input.length - 1; i >= 0; i--) {
    if (predicate(input[i], i)) {
      return Option.some(i)
    }
  }
  return Option.none()
})

/**
 * Returns the first element matching a predicate, refinement, or mapping
 * function, wrapped in `Option`.
 *
 * **When to use**
 *
 * Use to scan an iterable in iteration order and return the first selected
 * element or mapped value as an `Option`.
 *
 * **Details**
 *
 * - Accepts a predicate `(a, i) => boolean`, a refinement, or a function
 *   `(a, i) => Option<B>` for simultaneous find-and-transform.
 * - Returns `Option.none()` if no element matches.
 *
 * **Example** (Finding the first match)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.findFirst([1, 2, 3, 4, 5], (x) => x > 3)) // Option.some(4)
 * ```
 *
 * @see {@link findLast} — search from the end
 * @see {@link findFirstIndex} — get the index instead
 * @see {@link findFirstWithIndex} — get both element and index
 *
 * @category elements
 * @since 2.0.0
 */
export const findFirst: {
  <A, B>(f: (a: NoInfer<A>, i: number) => Option.Option<B>): (self: Iterable<A>) => Option.Option<B>
  <A, B extends A>(refinement: (a: NoInfer<A>, i: number) => a is B): (self: Iterable<A>) => Option.Option<B>
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => Option.Option<A>
  <A, B>(self: Iterable<A>, f: (a: A, i: number) => Option.Option<B>): Option.Option<B>
  <A, B extends A>(self: Iterable<A>, refinement: (a: A, i: number) => a is B): Option.Option<B>
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Option.Option<A>
} = moduleIterable.findFirst

/**
 * Returns the first selected value together with its index, wrapped in an
 * `Option`.
 *
 * **When to use**
 *
 * Use to find both the first matching element and its index in one pass.
 *
 * **Details**
 *
 * Accepts a predicate, a refinement, or a function returning `Option`. For an
 * `Option`-returning function, returns `[mappedValue, index]` for the first
 * `Some`, or `Option.none()` if no element is selected.
 *
 * **Example** (Finding element with its index)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.findFirstWithIndex([1, 2, 3, 4, 5], (x) => x > 3)) // Option.some([4, 3])
 * ```
 *
 * @see {@link findFirst} — get only the element
 * @see {@link findFirstIndex} — get only the index
 *
 * @category elements
 * @since 3.17.0
 */
export const findFirstWithIndex: {
  <A, B>(f: (a: NoInfer<A>, i: number) => Option.Option<B>): (self: Iterable<A>) => Option.Option<[B, number]>
  <A, B extends A>(refinement: (a: NoInfer<A>, i: number) => a is B): (self: Iterable<A>) => Option.Option<[B, number]>
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => Option.Option<[A, number]>
  <A, B>(self: Iterable<A>, f: (a: A, i: number) => Option.Option<B>): Option.Option<[B, number]>
  <A, B extends A>(self: Iterable<A>, refinement: (a: A, i: number) => a is B): Option.Option<[B, number]>
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Option.Option<[A, number]>
} = dual(
  2,
  <A>(
    self: Iterable<A>,
    f: ((a: A, i: number) => boolean) | ((a: A, i: number) => Option.Option<A>)
  ): Option.Option<[A, number]> => {
    let i = 0
    for (const a of self) {
      const o = f(a, i)
      if (typeof o === "boolean") {
        if (o) {
          return Option.some([a, i])
        }
      } else {
        if (Option.isSome(o)) {
          return Option.some([o.value, i])
        }
      }
      i++
    }
    return Option.none()
  }
)

/**
 * Returns the last element matching a predicate, refinement, or mapping
 * function, wrapped in `Option`.
 *
 * **When to use**
 *
 * Use to find the last matching element from the end of an array.
 *
 * **Details**
 *
 * - Searches from the end of the array.
 * - Returns `Option.none()` if no element matches.
 *
 * **Example** (Finding the last match)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.findLast([1, 2, 3, 4, 5], (n) => n % 2 === 0)) // Option.some(4)
 * ```
 *
 * @see {@link findFirst} — search from the start
 * @see {@link findLastIndex} — get the index instead
 *
 * @category elements
 * @since 2.0.0
 */
export const findLast: {
  <A, B>(f: (a: NoInfer<A>, i: number) => Option.Option<B>): (self: Iterable<A>) => Option.Option<B>
  <A, B extends A>(refinement: (a: NoInfer<A>, i: number) => a is B): (self: Iterable<A>) => Option.Option<B>
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => Option.Option<A>
  <A, B>(self: Iterable<A>, f: (a: A, i: number) => Option.Option<B>): Option.Option<B>
  <A, B extends A>(self: Iterable<A>, refinement: (a: A, i: number) => a is B): Option.Option<B>
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Option.Option<A>
} = dual(
  2,
  <A>(
    self: Iterable<A>,
    f: ((a: A, i: number) => boolean) | ((a: A, i: number) => Option.Option<A>)
  ): Option.Option<A> => {
    const input = fromIterable(self)
    for (let i = input.length - 1; i >= 0; i--) {
      const a = input[i]
      const o = f(a, i)
      if (typeof o === "boolean") {
        if (o) {
          return Option.some(a)
        }
      } else {
        if (Option.isSome(o)) {
          return o
        }
      }
    }
    return Option.none()
  }
)

/**
 * Inserts an element at the specified index safely, returning a new `NonEmptyArray`
 * wrapped in an `Option`.
 *
 * **When to use**
 *
 * Use to insert a single element at a specific position in an array.
 *
 * **Details**
 *
 * - Valid indices: `0` to `length` (inclusive — inserting at `length` appends).
 *
 * **Example** (Inserting at an index)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.insertAt(["a", "b", "c", "e"], 3, "d")) // Option.some(["a", "b", "c", "d", "e"])
 * ```
 *
 * @see {@link replace} — replace an existing element
 * @see {@link modify} — transform an element at an index
 *
 * @category elements
 * @since 2.0.0
 */
export const insertAt: {
  <B>(i: number, b: B): <A>(self: Iterable<A>) => Option.Option<NonEmptyArray<A | B>>
  <A, B>(self: Iterable<A>, i: number, b: B): Option.Option<NonEmptyArray<A | B>>
} = dual(3, <A, B>(self: Iterable<A>, i: number, b: B): Option.Option<NonEmptyArray<A | B>> => {
  const out: Array<A | B> = Array.from(self) // copy because `splice` mutates the array
  if (i < 0 || i > out.length) {
    return Option.none()
  }
  out.splice(i, 0, b)
  return Option.some(out as any)
})

/**
 * Replaces the element at the specified index safely with a new value, returning the
 * updated array in `Option.some`.
 *
 * **When to use**
 *
 * Use to set a fixed replacement value at a specific index.
 *
 * **Details**
 *
 * - Returns `Option.none()` when the index is out of bounds.
 *
 * **Example** (Replacing an element)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.replace([1, 2, 3], 1, 4)) // Option.some([1, 4, 3])
 * ```
 *
 * @see {@link modify} — transform an element with a function
 * @see {@link insertAt} — insert without removing
 *
 * @category elements
 * @since 2.0.0
 */
export const replace: {
  <B>(i: number, b: B): <A, S extends Iterable<A> = Iterable<A>>(
    self: S
  ) => Option.Option<ReadonlyArray.With<S, ReadonlyArray.Infer<S> | B>>
  <A, B, S extends Iterable<A> = Iterable<A>>(
    self: S,
    i: number,
    b: B
  ): Option.Option<ReadonlyArray.With<S, ReadonlyArray.Infer<S> | B>>
} = dual(
  3,
  <A, B>(self: Iterable<A>, i: number, b: B): Option.Option<Array<A | B>> => modify(self, i, () => b)
)

/**
 * Applies a function to the element at the specified index safely, returning the
 * updated array in `Option.some`.
 *
 * **When to use**
 *
 * Use to derive a replacement value from the current element at a specific
 * index while leaving the other elements unchanged.
 *
 * **Details**
 *
 * - Returns `Option.none()` when the index is out of bounds.
 *
 * **Example** (Modifying an element)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.modify([1, 2, 3, 4], 2, (n) => n * 2)) // Option.some([1, 2, 6, 4])
 * console.log(Array.modify([1, 2, 3, 4], 5, (n) => n * 2)) // Option.none()
 * ```
 *
 * @see {@link replace} — set a fixed value at an index
 * @see {@link modifyHeadNonEmpty} — modify the first element
 * @see {@link modifyLastNonEmpty} — modify the last element
 *
 * @category elements
 * @since 2.0.0
 */
export const modify: {
  <A, B, S extends Iterable<A> = Iterable<A>>(
    i: number,
    f: (a: ReadonlyArray.Infer<S>) => B
  ): (self: S) => Option.Option<ReadonlyArray.With<S, ReadonlyArray.Infer<S> | B>>
  <A, B, S extends Iterable<A> = Iterable<A>>(
    self: S,
    i: number,
    f: (a: ReadonlyArray.Infer<S>) => B
  ): Option.Option<ReadonlyArray.With<S, ReadonlyArray.Infer<S> | B>>
} = dual(3, <A, B>(self: Iterable<A>, i: number, f: (a: A) => B): Option.Option<Array<A | B>> => {
  const arr = Array.from(self)
  if (isOutOfBounds(i, arr)) {
    return Option.none()
  }
  const out: Array<A | B> = arr
  const b = f(arr[i])
  out[i] = b
  return Option.some(out)
})

/**
 * Removes the element at the specified index, returning a new array. If the
 * index is out of bounds, returns a copy of the original.
 *
 * **When to use**
 *
 * Use to remove a single element at a known index.
 *
 * **Example** (Removing an element)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.remove([1, 2, 3, 4], 2)) // [1, 2, 4]
 * console.log(Array.remove([1, 2, 3, 4], 5)) // [1, 2, 3, 4]
 * ```
 *
 * @see {@link insertAt} — insert an element
 * @see {@link filter} — remove elements by predicate
 *
 * @category elements
 * @since 2.0.0
 */
export const remove: {
  (i: number): <A>(self: Iterable<A>) => Array<A>
  <A>(self: Iterable<A>, i: number): Array<A>
} = dual(2, <A>(self: Iterable<A>, i: number): Array<A> => {
  const out = Array.from(self)
  if (isOutOfBounds(i, out)) {
    return out
  }
  out.splice(i, 1)
  return out
})

/**
 * Reverses an iterable into a new array.
 *
 * **When to use**
 *
 * Use to reverse the order of elements without mutating the original input.
 *
 * **Details**
 *
 * - Preserves `NonEmptyArray` in the return type.
 *
 * **Example** (Reversing an array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.reverse([1, 2, 3, 4])) // [4, 3, 2, 1]
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const reverse = <S extends Iterable<any>>(
  self: S
): S extends NonEmptyReadonlyArray<infer A> ? NonEmptyArray<A> : S extends Iterable<infer A> ? Array<A> : never =>
  Array.from(self).reverse() as any

/**
 * Sorts an array by the given `Order`, returning a new array.
 *
 * **When to use**
 *
 * Use to sort an array using a single `Order` comparator.
 *
 * **Details**
 *
 * - Preserves `NonEmptyArray` in the return type.
 * - Use {@link sortWith} to sort by a derived key, or {@link sortBy} for
 *   multi-key sorting.
 *
 * **Example** (Sorting numbers)
 *
 * ```ts
 * import { Array, Order } from "effect"
 *
 * console.log(Array.sort([3, 1, 4, 1, 5], Order.Number)) // [1, 1, 3, 4, 5]
 * ```
 *
 * @see {@link sortWith} — sort by a mapping function
 * @see {@link sortBy} — sort by multiple orders
 *
 * @category sorting
 * @since 2.0.0
 */
export const sort: {
  <B>(
    O: Order.Order<B>
  ): <A extends B, S extends Iterable<A>>(self: S) => ReadonlyArray.With<S, ReadonlyArray.Infer<S>>
  <A extends B, B>(self: NonEmptyReadonlyArray<A>, O: Order.Order<B>): NonEmptyArray<A>
  <A extends B, B>(self: Iterable<A>, O: Order.Order<B>): Array<A>
} = dual(2, <A extends B, B>(self: Iterable<A>, O: Order.Order<B>): Array<A> => {
  const out = Array.from(self)
  out.sort(O)
  return out
})

/**
 * Sorts an array by a derived key using a mapping function and an `Order` for
 * that key.
 *
 * **When to use**
 *
 * Use when values need to be sorted by a derived key, such as a string length
 * or object field, while the output should keep the original values.
 *
 * **Details**
 *
 * - Equivalent to `sort(Order.mapInput(order, f))` but more convenient.
 *
 * **Example** (Sorting strings by length)
 *
 * ```ts
 * import { Array, Order } from "effect"
 *
 * console.log(Array.sortWith(["aaa", "b", "cc"], (s) => s.length, Order.Number))
 * // ["b", "cc", "aaa"]
 * ```
 *
 * @see {@link sort} for sorting with an `Order` that compares the elements directly
 * @see {@link sortBy} for sorting with multiple `Order`s applied in sequence
 *
 * @category elements
 * @since 2.0.0
 */
export const sortWith: {
  <S extends Iterable<any>, B>(
    f: (a: ReadonlyArray.Infer<S>) => B,
    order: Order.Order<B>
  ): (self: S) => ReadonlyArray.With<S, ReadonlyArray.Infer<S>>
  <A, B>(self: NonEmptyReadonlyArray<A>, f: (a: A) => B, O: Order.Order<B>): NonEmptyArray<A>
  <A, B>(self: Iterable<A>, f: (a: A) => B, order: Order.Order<B>): Array<A>
} = dual(
  3,
  <A, B>(self: Iterable<A>, f: (a: A) => B, order: Order.Order<B>): Array<A> =>
    Array.from(self).map((a) => [a, f(a)] as const).sort(([, a], [, b]) => order(a, b)).map(([_]) => _)
)

/**
 * Sorts an array by multiple `Order`s applied in sequence: the first order is
 * used first; ties are broken by the second order, and so on.
 *
 * **When to use**
 *
 * Use to sort by multiple criteria where later orders break ties from earlier
 * ones.
 *
 * **Details**
 *
 * - Data-last only (returns a function).
 * - Preserves `NonEmptyArray` in the return type.
 *
 * **Example** (Multi-key sorting)
 *
 * ```ts
 * import { Array, Order, pipe } from "effect"
 *
 * const users = [
 *   { name: "Alice", age: 30 },
 *   { name: "Bob", age: 25 },
 *   { name: "Charlie", age: 30 }
 * ]
 *
 * const result = pipe(
 *   users,
 *   Array.sortBy(
 *     Order.mapInput(Order.Number, (user: (typeof users)[number]) => user.age),
 *     Order.mapInput(Order.String, (user: (typeof users)[number]) => user.name)
 *   )
 * )
 * console.log(result)
 * // [{ name: "Bob", age: 25 }, { name: "Alice", age: 30 }, { name: "Charlie", age: 30 }]
 * ```
 *
 * @see {@link sort} — sort by a single `Order`
 * @see {@link sortWith} — sort by a derived key
 *
 * @category sorting
 * @since 2.0.0
 */
export const sortBy = <S extends Iterable<any>>(
  ...orders: ReadonlyArray<Order.Order<ReadonlyArray.Infer<S>>>
) => {
  const sortByAll = sort(Order.combineAll(orders))
  return (
    self: S
  ): S extends NonEmptyReadonlyArray<infer A> ? NonEmptyArray<A> : S extends Iterable<infer A> ? Array<A> : never => {
    const input = fromIterable(self)
    if (isReadonlyArrayNonEmpty(input)) {
      return sortByAll(input) as any
    }
    return [] as any
  }
}

/**
 * Pairs elements from two iterables by position. If the iterables differ in
 * length, the extra elements from the longer one are discarded.
 *
 * **When to use**
 *
 * Use to pair corresponding elements from two iterables when you need simple pairs without a custom combiner.
 *
 * **Details**
 *
 * - Returns `NonEmptyArray` when both inputs are non-empty.
 *
 * **Example** (Zipping two arrays)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.zip([1, 2, 3], ["a", "b"])) // [[1, "a"], [2, "b"]]
 * ```
 *
 * @see {@link zipWith} — zip with a combiner function
 * @see {@link unzip} — inverse operation
 *
 * @category zipping
 * @since 2.0.0
 */
export const zip: {
  <B>(that: NonEmptyReadonlyArray<B>): <A>(self: NonEmptyReadonlyArray<A>) => NonEmptyArray<[A, B]>
  <B>(that: Iterable<B>): <A>(self: Iterable<A>) => Array<[A, B]>
  <A, B>(self: NonEmptyReadonlyArray<A>, that: NonEmptyReadonlyArray<B>): NonEmptyArray<[A, B]>
  <A, B>(self: Iterable<A>, that: Iterable<B>): Array<[A, B]>
} = dual(
  2,
  <A, B>(self: Iterable<A>, that: Iterable<B>): Array<[A, B]> => zipWith(self, that, Tuple.make)
)

/**
 * Combines elements from two iterables pairwise using a function. If the
 * iterables differ in length, extra elements are discarded.
 *
 * **Example** (Zipping with addition)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.zipWith([1, 2, 3], [4, 5, 6], (a, b) => a + b)) // [5, 7, 9]
 * ```
 *
 * @see {@link zip} — zip into tuples
 *
 * @category zipping
 * @since 2.0.0
 */
export const zipWith: {
  <B, A, C>(that: NonEmptyReadonlyArray<B>, f: (a: A, b: B) => C): (self: NonEmptyReadonlyArray<A>) => NonEmptyArray<C>
  <B, A, C>(that: Iterable<B>, f: (a: A, b: B) => C): (self: Iterable<A>) => Array<C>
  <A, B, C>(self: NonEmptyReadonlyArray<A>, that: NonEmptyReadonlyArray<B>, f: (a: A, b: B) => C): NonEmptyArray<C>
  <B, A, C>(self: Iterable<A>, that: Iterable<B>, f: (a: A, b: B) => C): Array<C>
} = dual(3, <B, A, C>(self: Iterable<A>, that: Iterable<B>, f: (a: A, b: B) => C): Array<C> => {
  const as = fromIterable(self)
  const bs = fromIterable(that)
  if (isReadonlyArrayNonEmpty(as) && isReadonlyArrayNonEmpty(bs)) {
    const out: NonEmptyArray<C> = [f(headNonEmpty(as), headNonEmpty(bs))]
    const len = Math.min(as.length, bs.length)
    for (let i = 1; i < len; i++) {
      out[i] = f(as[i], bs[i])
    }
    return out
  }
  return []
})

/**
 * Splits an array of pairs into two arrays. Inverse of {@link zip}.
 *
 * **Example** (Unzipping pairs)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.unzip([[1, "a"], [2, "b"], [3, "c"]])) // [[1, 2, 3], ["a", "b", "c"]]
 * ```
 *
 * @see {@link zip} — combine two arrays into pairs
 *
 * @category zipping
 * @since 2.0.0
 */
export const unzip: <S extends Iterable<readonly [any, any]>>(
  self: S
) => S extends NonEmptyReadonlyArray<readonly [infer A, infer B]> ? [NonEmptyArray<A>, NonEmptyArray<B>]
  : S extends Iterable<readonly [infer A, infer B]> ? [Array<A>, Array<B>]
  : never = (<A, B>(self: Iterable<readonly [A, B]>): [Array<A>, Array<B>] => {
    const input = fromIterable(self)
    if (isReadonlyArrayNonEmpty(input)) {
      const fa: NonEmptyArray<A> = [input[0][0]]
      const fb: NonEmptyArray<B> = [input[0][1]]
      for (let i = 1; i < input.length; i++) {
        fa[i] = input[i][0]
        fb[i] = input[i][1]
      }
      return [fa, fb]
    }
    return [[], []]
  }) as any

/**
 * Places a separator element between every pair of elements.
 *
 * **When to use**
 *
 * Use to insert a separator between elements, for example when preparing data for display or concatenation.
 *
 * **Details**
 *
 * - Preserves `NonEmptyArray` in the return type.
 * - An empty input produces an empty result.
 *
 * **Example** (Interspersing a separator)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.intersperse([1, 2, 3], 0)) // [1, 0, 2, 0, 3]
 * ```
 *
 * @see {@link join} — intersperse and join into a string
 *
 * @category elements
 * @since 2.0.0
 */
export const intersperse: {
  <B>(
    middle: B
  ): <S extends Iterable<any>>(self: S) => ReadonlyArray.With<S, ReadonlyArray.Infer<S> | B>
  <A, B>(self: NonEmptyReadonlyArray<A>, middle: B): NonEmptyArray<A | B>
  <A, B>(self: Iterable<A>, middle: B): Array<A | B>
} = dual(2, <A, B>(self: Iterable<A>, middle: B): Array<A | B> => {
  const input = fromIterable(self)
  if (isReadonlyArrayNonEmpty(input)) {
    const out: NonEmptyArray<A | B> = [headNonEmpty(input)]
    const tail = tailNonEmpty(input)
    for (let i = 0; i < tail.length; i++) {
      if (i < tail.length) {
        out.push(middle)
      }
      out.push(tail[i])
    }
    return out
  }
  return []
})

/**
 * Applies a function to the first element of a non-empty array, returning a
 * new array.
 *
 * **When to use**
 *
 * Use to transform the first element of a non-empty array while preserving the rest.
 *
 * **Example** (Modifying the head)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.modifyHeadNonEmpty([1, 2, 3], (n) => n * 10)) // [10, 2, 3]
 * ```
 *
 * @see {@link setHeadNonEmpty} — replace with a fixed value
 * @see {@link modifyLastNonEmpty} — modify the last element
 *
 * @category elements
 * @since 4.0.0
 */
export const modifyHeadNonEmpty: {
  <A, B>(f: (a: A) => B): (self: NonEmptyReadonlyArray<A>) => NonEmptyArray<A | B>
  <A, B>(self: NonEmptyReadonlyArray<A>, f: (a: A) => B): NonEmptyArray<A | B>
} = dual(
  2,
  <A, B>(
    self: NonEmptyReadonlyArray<A>,
    f: (a: A) => B
  ): NonEmptyArray<A | B> => [f(headNonEmpty(self)), ...tailNonEmpty(self)]
)

/**
 * Replaces the first element of a non-empty array with a new value.
 *
 * **Example** (Setting the head)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.setHeadNonEmpty([1, 2, 3], 10)) // [10, 2, 3]
 * ```
 *
 * @see {@link modifyHeadNonEmpty} — transform the head with a function
 * @see {@link setLastNonEmpty} — replace the last element
 *
 * @category elements
 * @since 4.0.0
 */
export const setHeadNonEmpty: {
  <B>(b: B): <A>(self: NonEmptyReadonlyArray<A>) => NonEmptyArray<A | B>
  <A, B>(self: NonEmptyReadonlyArray<A>, b: B): NonEmptyArray<A | B>
} = dual(
  2,
  <A, B>(self: NonEmptyReadonlyArray<A>, b: B): NonEmptyArray<A | B> => modifyHeadNonEmpty(self, () => b)
)

/**
 * Applies a function to the last element of a non-empty array, returning a
 * new array.
 *
 * **Example** (Modifying the last element)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.modifyLastNonEmpty([1, 2, 3], (n) => n * 2)) // [1, 2, 6]
 * ```
 *
 * @see {@link setLastNonEmpty} — replace with a fixed value
 * @see {@link modifyHeadNonEmpty} — modify the first element
 *
 * @category elements
 * @since 4.0.0
 */
export const modifyLastNonEmpty: {
  <A, B>(f: (a: A) => B): (self: NonEmptyReadonlyArray<A>) => NonEmptyArray<A | B>
  <A, B>(self: NonEmptyReadonlyArray<A>, f: (a: A) => B): NonEmptyArray<A | B>
} = dual(
  2,
  <A, B>(self: NonEmptyReadonlyArray<A>, f: (a: A) => B): NonEmptyArray<A | B> =>
    append(initNonEmpty(self), f(lastNonEmpty(self)))
)

/**
 * Replaces the last element of a non-empty array with a new value.
 *
 * **Example** (Setting the last element)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.setLastNonEmpty([1, 2, 3], 4)) // [1, 2, 4]
 * ```
 *
 * @see {@link modifyLastNonEmpty} — transform the last element with a function
 * @see {@link setHeadNonEmpty} — replace the first element
 *
 * @category elements
 * @since 4.0.0
 */
export const setLastNonEmpty: {
  <B>(b: B): <A>(self: NonEmptyReadonlyArray<A>) => NonEmptyArray<A | B>
  <A, B>(self: NonEmptyReadonlyArray<A>, b: B): NonEmptyArray<A | B>
} = dual(
  2,
  <A, B>(self: NonEmptyReadonlyArray<A>, b: B): NonEmptyArray<A | B> => modifyLastNonEmpty(self, () => b)
)

/**
 * Transforms an array by rotating it `n` steps. Positive `n` rotates right; negative `n`
 * rotates left.
 *
 * **When to use**
 *
 * Use when elements should wrap around the end of the array rather than being
 * dropped.
 *
 * **Details**
 *
 * - `n` is rounded to the nearest integer before rotating.
 * - Preserves `NonEmptyArray` in the return type.
 * - Returns a copy for empty arrays or when the normalized rotation is `0`.
 *
 * **Example** (Rotating elements)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.rotate(["a", "b", "c", "d"], 2)) // ["c", "d", "a", "b"]
 * ```
 *
 * @see {@link take} for taking a fixed number of elements from the start
 * @see {@link drop} for dropping a fixed number of elements from the start
 *
 * @category elements
 * @since 2.0.0
 */
export const rotate: {
  (n: number): <S extends Iterable<any>>(self: S) => ReadonlyArray.With<S, ReadonlyArray.Infer<S>>
  <A>(self: NonEmptyReadonlyArray<A>, n: number): NonEmptyArray<A>
  <A>(self: Iterable<A>, n: number): Array<A>
} = dual(2, <A>(self: Iterable<A>, n: number): Array<A> => {
  const input = fromIterable(self)
  if (isReadonlyArrayNonEmpty(input)) {
    const len = input.length
    const m = Math.round(n) % len
    if (isOutOfBounds(Math.abs(m), input) || m === 0) {
      return copy(input)
    }
    if (m < 0) {
      const [f, s] = splitAtNonEmpty(input, -m)
      return appendAll(s, f)
    } else {
      return rotate(self, m - len)
    }
  }
  return []
})

/**
 * Returns a membership-test function using a custom equivalence.
 *
 * **When to use**
 *
 * Use when checking membership with caller-provided equality instead of
 * `Equal.equivalence()`.
 *
 * **Example** (Custom equality check)
 *
 * ```ts
 * import { Array, pipe } from "effect"
 *
 * const containsNumber = Array.containsWith((a: number, b: number) => a === b)
 * console.log(pipe([1, 2, 3, 4], containsNumber(3))) // true
 * ```
 *
 * @see {@link contains} for the `Equal.equivalence()` variant
 *
 * @category elements
 * @since 2.0.0
 */
export const containsWith = <A>(isEquivalent: (self: A, that: A) => boolean): {
  (a: A): (self: Iterable<A>) => boolean
  (self: Iterable<A>, a: A): boolean
} =>
  dual(2, (self: Iterable<A>, a: A): boolean => {
    for (const i of self) {
      if (isEquivalent(a, i)) {
        return true
      }
    }
    return false
  })

/**
 * Checks whether an array contains a value, using `Equal.equivalence()` for
 * comparison.
 *
 * **When to use**
 *
 * Use to check membership with Effect's default equality instead of providing a
 * comparison function.
 *
 * **Example** (Checking membership)
 *
 * ```ts
 * import { Array, pipe } from "effect"
 *
 * console.log(pipe(["a", "b", "c", "d"], Array.contains("c"))) // true
 * ```
 *
 * @see {@link containsWith} — use custom equality
 *
 * @category elements
 * @since 2.0.0
 */
export const contains: {
  <A>(a: A): (self: Iterable<A>) => boolean
  <A>(self: Iterable<A>, a: A): boolean
} = containsWith(Equal.asEquivalence())

/**
 * Applies a function repeatedly to consume prefixes of the array and collect
 * the values it produces.
 *
 * **When to use**
 *
 * Use when the grouping logic is custom and each step needs to return both a
 * value and the remaining input.
 *
 * **Details**
 *
 * - The function receives a `NonEmptyReadonlyArray` and returns
 *   `[value, rest]`.
 * - Continues until the remaining array is empty.
 * - Useful for custom splitting/grouping logic.
 *
 * **Example** (Chopping an array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.chop(
 *   [1, 2, 3, 4, 5],
 *   (as): [number, Array<number>] => [as[0] * 2, as.slice(1)]
 * )
 * console.log(result) // [2, 4, 6, 8, 10]
 * ```
 *
 * @see {@link chunksOf} — split into fixed-size chunks
 * @see {@link splitAt} — split at an index
 *
 * @category elements
 * @since 2.0.0
 */
export const chop: {
  <S extends Iterable<any>, B>(
    f: (as: NonEmptyReadonlyArray<ReadonlyArray.Infer<S>>) => readonly [B, ReadonlyArray<ReadonlyArray.Infer<S>>]
  ): (self: S) => ReadonlyArray.With<S, ReadonlyArray.Infer<S>>
  <A, B>(
    self: NonEmptyReadonlyArray<A>,
    f: (as: NonEmptyReadonlyArray<A>) => readonly [B, ReadonlyArray<A>]
  ): NonEmptyArray<B>
  <A, B>(
    self: Iterable<A>,
    f: (as: NonEmptyReadonlyArray<A>) => readonly [B, ReadonlyArray<A>]
  ): Array<B>
} = dual(2, <A, B>(
  self: Iterable<A>,
  f: (as: NonEmptyReadonlyArray<A>) => readonly [B, ReadonlyArray<A>]
): Array<B> => {
  const input = fromIterable(self)
  if (isReadonlyArrayNonEmpty(input)) {
    const [b, rest] = f(input)
    const out: NonEmptyArray<B> = [b]
    let next: ReadonlyArray<A> = rest
    while (internalArray.isArrayNonEmpty(next)) {
      const [b, rest] = f(next)
      out.push(b)
      next = rest
    }
    return out
  }
  return []
})

/**
 * Splits an iterable into two arrays at the given index.
 *
 * **When to use**
 *
 * Use to divide an array into a prefix and suffix at a specific position.
 *
 * **Details**
 *
 * - `n` can be `0` (all elements in the second array).
 * - `n` is floored to an integer.
 *
 * **Example** (Splitting at an index)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.splitAt([1, 2, 3, 4, 5], 3)) // [[1, 2, 3], [4, 5]]
 * ```
 *
 * @see {@link splitAtNonEmpty} — for non-empty arrays
 * @see {@link splitWhere} — split at a predicate boundary
 *
 * @category splitting
 * @since 2.0.0
 */
export const splitAt: {
  (n: number): <A>(self: Iterable<A>) => [beforeIndex: Array<A>, fromIndex: Array<A>]
  <A>(self: Iterable<A>, n: number): [beforeIndex: Array<A>, fromIndex: Array<A>]
} = dual(2, <A>(self: Iterable<A>, n: number): [Array<A>, Array<A>] => {
  const input = Array.from(self)
  const _n = Math.floor(n)
  if (isReadonlyArrayNonEmpty(input)) {
    if (_n >= 1) {
      return splitAtNonEmpty(input, _n)
    }
    return [[], input]
  }
  return [input, []]
})

/**
 * Splits a non-empty array into two parts at the given index. The first part
 * is guaranteed to be non-empty (`n` is clamped to >= 1).
 *
 * **Example** (Splitting a non-empty array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.splitAtNonEmpty(["a", "b", "c", "d", "e"], 3))
 * // [["a", "b", "c"], ["d", "e"]]
 * ```
 *
 * @see {@link splitAt} — for possibly-empty arrays
 *
 * @category splitting
 * @since 4.0.0
 */
export const splitAtNonEmpty: {
  (n: number): <A>(self: NonEmptyReadonlyArray<A>) => [beforeIndex: NonEmptyArray<A>, fromIndex: Array<A>]
  <A>(self: NonEmptyReadonlyArray<A>, n: number): [beforeIndex: NonEmptyArray<A>, fromIndex: Array<A>]
} = dual(2, <A>(self: NonEmptyReadonlyArray<A>, n: number): [NonEmptyArray<A>, Array<A>] => {
  const _n = Math.max(1, Math.floor(n))
  return _n >= self.length ?
    [copy(self), []] :
    [prepend(self.slice(1, _n), headNonEmpty(self)), self.slice(_n)]
})

/**
 * Splits an iterable into `n` roughly equal-sized chunks.
 *
 * **When to use**
 *
 * Use to distribute elements across a fixed number of groups, such as when splitting work across threads.
 *
 * **Details**
 *
 * - Uses `chunksOf(ceil(length / n))` internally.
 * - The last chunk may be shorter.
 *
 * **Example** (Splitting into groups)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.split([1, 2, 3, 4, 5, 6, 7, 8], 3)) // [[1, 2, 3], [4, 5, 6], [7, 8]]
 * ```
 *
 * @see {@link chunksOf} — split into fixed-size chunks
 *
 * @category splitting
 * @since 2.0.0
 */
export const split: {
  (n: number): <A>(self: Iterable<A>) => Array<Array<A>>
  <A>(self: Iterable<A>, n: number): Array<Array<A>>
} = dual(2, <A>(self: Iterable<A>, n: number) => {
  const input = fromIterable(self)
  return chunksOf(input, Math.ceil(input.length / Math.floor(n)))
})

/**
 * Splits an iterable at the first element matching the predicate. The matching
 * element is included in the second array.
 *
 * **When to use**
 *
 * Use to split an array at a condition boundary when you know which element marks the transition point.
 *
 * **Example** (Splitting at a condition)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.splitWhere([1, 2, 3, 4, 5], (n) => n > 3)) // [[1, 2, 3], [4, 5]]
 * ```
 *
 * @see {@link span} — splits at the first element that fails the predicate
 * @see {@link splitAt} — split at a fixed index
 *
 * @category splitting
 * @since 2.0.0
 */
export const splitWhere: {
  <A>(
    predicate: (a: NoInfer<A>, i: number) => boolean
  ): (self: Iterable<A>) => [beforeMatch: Array<A>, fromMatch: Array<A>]
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): [beforeMatch: Array<A>, fromMatch: Array<A>]
} = dual(
  2,
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): [beforeMatch: Array<A>, fromMatch: Array<A>] =>
    span(self, (a: A, i: number) => !predicate(a, i))
)

/**
 * Creates a shallow copy of an array.
 *
 * **When to use**
 *
 * Use to create a distinct array reference for an existing array, for example
 * before mutating the returned array.
 *
 * **Details**
 *
 * - Preserves `NonEmptyArray` in the return type.
 * - Useful when you need a distinct reference (e.g. before mutating).
 *
 * **Example** (Copying an array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const original = [1, 2, 3]
 * const copied = Array.copy(original)
 * console.log(copied) // [1, 2, 3]
 * console.log(original === copied) // false
 * ```
 *
 * @see {@link fromIterable} — returns the same reference for arrays
 *
 * @category elements
 * @since 2.0.0
 */
export const copy: {
  <A>(self: NonEmptyReadonlyArray<A>): NonEmptyArray<A>
  <A>(self: ReadonlyArray<A>): Array<A>
} = (<A>(self: ReadonlyArray<A>): Array<A> => self.slice()) as any

/**
 * Pads or truncates an array to exactly `n` elements, filling with `fill`
 * if the array is shorter, or slicing if longer.
 *
 * **When to use**
 *
 * Use to ensure an array has a specific length, padding with a fill value or truncating as needed.
 *
 * **Details**
 *
 * - Returns an empty array when `n <= 0`.
 *
 * **Example** (Padding an array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.pad([1, 2, 3], 6, 0)) // [1, 2, 3, 0, 0, 0]
 * ```
 *
 * @see {@link take} — truncate without padding
 * @see {@link replicate} — create an array of a single repeated value
 *
 * @category elements
 * @since 3.8.4
 */
export const pad: {
  <A, T>(
    n: number,
    fill: T
  ): (
    self: Array<A>
  ) => Array<A | T>
  <A, T>(self: Array<A>, n: number, fill: T): Array<A | T>
} = dual(3, <A, T>(self: Array<A>, n: number, fill: T): Array<A | T> => {
  if (self.length >= n) {
    return take(self, n)
  }
  return appendAll(
    self,
    makeBy(n - self.length, () => fill)
  )
})

/**
 * Splits an iterable into chunks of length `n`. The last chunk may be shorter
 * if `n` does not evenly divide the length.
 *
 * **When to use**
 *
 * Use to divide an iterable into non-overlapping chunks with a maximum chunk
 * size.
 *
 * **Details**
 *
 * - `chunksOf(n)([])` is `[]`, not `[[]]`.
 * - Each chunk is a `NonEmptyArray`.
 * - Preserves `NonEmptyArray` in the outer return type.
 *
 * **Example** (Chunking an array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.chunksOf([1, 2, 3, 4, 5], 2)) // [[1, 2], [3, 4], [5]]
 * ```
 *
 * @see {@link split} — split into a given number of groups
 * @see {@link window} — sliding windows
 *
 * @category splitting
 * @since 2.0.0
 */
export const chunksOf: {
  (
    n: number
  ): <S extends Iterable<any>>(
    self: S
  ) => ReadonlyArray.With<S, NonEmptyArray<ReadonlyArray.Infer<S>>>
  <A>(self: NonEmptyReadonlyArray<A>, n: number): NonEmptyArray<NonEmptyArray<A>>
  <A>(self: Iterable<A>, n: number): Array<NonEmptyArray<A>>
} = dual(2, <A>(self: Iterable<A>, n: number): Array<NonEmptyArray<A>> => {
  const input = fromIterable(self)
  if (isReadonlyArrayNonEmpty(input)) {
    return chop(input, splitAtNonEmpty(n))
  }
  return []
})

/**
 * Creates overlapping sliding windows of size `n`.
 *
 * **When to use**
 *
 * Use to process sequences with a moving window, such as for computing running averages or detecting patterns.
 *
 * **Details**
 *
 * - Returns an empty array if `n <= 0` or the array has fewer than `n` elements.
 * - Each window is a tuple of exactly `n` elements.
 *
 * **Example** (Sliding windows)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.window([1, 2, 3, 4, 5], 3)) // [[1, 2, 3], [2, 3, 4], [3, 4, 5]]
 * console.log(Array.window([1, 2, 3, 4, 5], 6)) // []
 * ```
 *
 * @see {@link chunksOf} — non-overlapping chunks
 *
 * @category splitting
 * @since 3.13.2
 */
export const window: {
  <N extends number>(n: N): <A>(self: Iterable<A>) => Array<TupleOf<N, A>>
  <A, N extends number>(self: Iterable<A>, n: N): Array<TupleOf<N, A>>
} = dual(2, <A>(self: Iterable<A>, n: number): Array<Array<A>> => {
  const input = fromIterable(self)
  if (n > 0 && isReadonlyArrayNonEmpty(input)) {
    return Array.from(
      { length: input.length - (n - 1) },
      (_, index) => input.slice(index, index + n)
    )
  }
  return []
})

/**
 * Groups consecutive equal elements using a custom equivalence function.
 *
 * **When to use**
 *
 * Use when a non-empty array is already arranged so matching elements are
 * adjacent and you need a custom equivalence function.
 *
 * **Details**
 *
 * - Only groups **adjacent** elements — non-adjacent duplicates stay separate.
 * - Requires a `NonEmptyReadonlyArray`.
 *
 * **Example** (Grouping consecutive equal elements)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.groupWith(["a", "a", "b", "b", "b", "c", "a"], (x, y) => x === y))
 * // [["a", "a"], ["b", "b", "b"], ["c"], ["a"]]
 * ```
 *
 * @see {@link group} for grouping adjacent elements with `Equal.equivalence()`
 * @see {@link groupBy} for grouping all elements into a record by key, regardless of adjacency
 *
 * @category grouping
 * @since 2.0.0
 */
export const groupWith: {
  <A>(isEquivalent: (self: A, that: A) => boolean): (self: NonEmptyReadonlyArray<A>) => NonEmptyArray<NonEmptyArray<A>>
  <A>(self: NonEmptyReadonlyArray<A>, isEquivalent: (self: A, that: A) => boolean): NonEmptyArray<NonEmptyArray<A>>
} = dual(
  2,
  <A>(self: NonEmptyReadonlyArray<A>, isEquivalent: (self: A, that: A) => boolean): NonEmptyArray<NonEmptyArray<A>> =>
    chop(self, (as) => {
      const h = headNonEmpty(as)
      const out: NonEmptyArray<A> = [h]
      let i = 1
      for (; i < as.length; i++) {
        const a = as[i]
        if (isEquivalent(a, h)) {
          out.push(a)
        } else {
          break
        }
      }
      return [out, as.slice(i)]
    })
)

/**
 * Groups consecutive equal elements using `Equal.equivalence()`.
 *
 * **When to use**
 *
 * Use when equal values are already adjacent and Effect's default equality is
 * the right comparison.
 *
 * **Details**
 *
 * - Only groups **adjacent** elements.
 *
 * **Example** (Grouping adjacent equal elements)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.group([1, 1, 2, 2, 2, 3, 1])) // [[1, 1], [2, 2, 2], [3], [1]]
 * ```
 *
 * @see {@link groupWith} — use custom equality
 * @see {@link groupBy} — group by a key function into a record
 *
 * @category grouping
 * @since 2.0.0
 */
export const group: <A>(self: NonEmptyReadonlyArray<A>) => NonEmptyArray<NonEmptyArray<A>> = groupWith(
  Equal.asEquivalence()
)

/**
 * Groups elements into a record by a key-returning function. Each key maps
 * to a `NonEmptyArray` of elements that produced that key.
 *
 * **When to use**
 *
 * Use to build buckets of elements indexed by a computed string or symbol key.
 *
 * **Details**
 *
 * - Unlike {@link group}/{@link groupWith}, elements do not need to be
 *   adjacent to be grouped together.
 * - Key function must return a `string` or `symbol`.
 *
 * **Example** (Grouping by a property)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const people = [
 *   { name: "Alice", group: "A" },
 *   { name: "Bob", group: "B" },
 *   { name: "Charlie", group: "A" }
 * ]
 *
 * const result = Array.groupBy(people, (person) => person.group)
 * console.log(result)
 * // { A: [{ name: "Alice", group: "A" }, { name: "Charlie", group: "A" }], B: [{ name: "Bob", group: "B" }] }
 * ```
 *
 * @see {@link group} — group adjacent equal elements
 * @see {@link groupWith} — group adjacent elements by custom equality
 *
 * @category grouping
 * @since 2.0.0
 */
export const groupBy: {
  <A, K extends string | symbol>(
    f: (a: A) => K
  ): (self: Iterable<A>) => Record<Record.ReadonlyRecord.NonLiteralKey<K>, NonEmptyArray<A>>
  <A, K extends string | symbol>(
    self: Iterable<A>,
    f: (a: A) => K
  ): Record<Record.ReadonlyRecord.NonLiteralKey<K>, NonEmptyArray<A>>
} = dual(2, <A, K extends string | symbol>(
  self: Iterable<A>,
  f: (a: A) => K
): Record<Record.ReadonlyRecord.NonLiteralKey<K>, NonEmptyArray<A>> => {
  const out: Record<string | symbol, NonEmptyArray<A>> = {}
  for (const a of self) {
    const k = f(a)
    if (Object.hasOwn(out, k)) {
      out[k].push(a)
    } else {
      out[k] = [a]
    }
  }
  return out
})

/**
 * Computes the union of two arrays using a custom equivalence, removing
 * duplicates.
 *
 * **When to use**
 *
 * Use when you need the union of two arrays but duplicate detection must use a
 * custom equivalence instead of the default `Equal.equivalence()`.
 *
 * **Example** (Union with custom equality)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.unionWith([1, 2], [2, 3], (a, b) => a === b)) // [1, 2, 3]
 * ```
 *
 * @see {@link union} for the `Equal.equivalence()` variant
 * @see {@link intersectionWith} for keeping elements present in both arrays
 * @see {@link differenceWith} for keeping elements present only in the first array
 *
 * @category elements
 * @since 2.0.0
 */
export const unionWith: {
  <S extends Iterable<any>, T extends Iterable<any>>(
    that: T,
    isEquivalent: (self: ReadonlyArray.Infer<S>, that: ReadonlyArray.Infer<T>) => boolean
  ): (self: S) => ReadonlyArray.OrNonEmpty<S, T, ReadonlyArray.Infer<S> | ReadonlyArray.Infer<T>>
  <A, B>(
    self: NonEmptyReadonlyArray<A>,
    that: Iterable<B>,
    isEquivalent: (self: A, that: B) => boolean
  ): NonEmptyArray<A | B>
  <A, B>(
    self: Iterable<A>,
    that: NonEmptyReadonlyArray<B>,
    isEquivalent: (self: A, that: B) => boolean
  ): NonEmptyArray<A | B>
  <A, B>(self: Iterable<A>, that: Iterable<B>, isEquivalent: (self: A, that: B) => boolean): Array<A | B>
} = dual(3, <A>(self: Iterable<A>, that: Iterable<A>, isEquivalent: (self: A, that: A) => boolean): Array<A> => {
  const a = fromIterable(self)
  const b = fromIterable(that)
  if (isReadonlyArrayNonEmpty(a)) {
    if (isReadonlyArrayNonEmpty(b)) {
      const dedupe = dedupeWith(isEquivalent)
      return dedupe(appendAll(a, b))
    }
    return a
  }
  return b
})

/**
 * Computes the union of two arrays, removing duplicates using
 * `Equal.equivalence()`.
 *
 * **Example** (Array union)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.union([1, 2], [2, 3])) // [1, 2, 3]
 * ```
 *
 * @see {@link unionWith} — use custom equality
 * @see {@link intersection} — elements in both arrays
 * @see {@link difference} — elements only in the first array
 *
 * @category elements
 * @since 2.0.0
 */
export const union: {
  <T extends Iterable<any>>(
    that: T
  ): <S extends Iterable<any>>(
    self: S
  ) => ReadonlyArray.OrNonEmpty<S, T, ReadonlyArray.Infer<S> | ReadonlyArray.Infer<T>>
  <A, B>(self: NonEmptyReadonlyArray<A>, that: ReadonlyArray<B>): NonEmptyArray<A | B>
  <A, B>(self: ReadonlyArray<A>, that: NonEmptyReadonlyArray<B>): NonEmptyArray<A | B>
  <A, B>(self: Iterable<A>, that: Iterable<B>): Array<A | B>
} = dual(
  2,
  <A, B>(self: Iterable<A>, that: Iterable<B>): Array<A | B> => unionWith(self, that, Equal.asEquivalence<A | B>())
)

/**
 * Computes the intersection of two arrays using a custom equivalence. Order is
 * determined by the first array.
 *
 * **When to use**
 *
 * Use when keeping only values present in both arrays and equality must be
 * defined by a custom comparator, such as matching objects by id.
 *
 * **Example** (Intersection with custom equality)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const array1 = [{ id: 1 }, { id: 2 }, { id: 3 }]
 * const array2 = [{ id: 3 }, { id: 4 }, { id: 1 }]
 * const isEquivalent = (a: { id: number }, b: { id: number }) => a.id === b.id
 * console.log(Array.intersectionWith(isEquivalent)(array2)(array1)) // [{ id: 1 }, { id: 3 }]
 * ```
 *
 * @see {@link intersection} for the `Equal.equivalence()` variant
 * @see {@link unionWith} for keeping values from either array with custom equality
 * @see {@link differenceWith} for keeping values only from the first array with custom equality
 *
 * @category elements
 * @since 2.0.0
 */
export const intersectionWith = <A>(isEquivalent: (self: A, that: A) => boolean): {
  (that: Iterable<A>): (self: Iterable<A>) => Array<A>
  (self: Iterable<A>, that: Iterable<A>): Array<A>
} => {
  const has = containsWith(isEquivalent)
  return dual(
    2,
    (self: Iterable<A>, that: Iterable<A>): Array<A> => {
      const thatArray = fromIterable(that)
      return fromIterable(self).filter((a) => has(thatArray, a))
    }
  )
}

/**
 * Computes the intersection of two arrays using `Equal.equivalence()`. Order is
 * determined by the first array.
 *
 * **Example** (Array intersection)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.intersection([1, 2, 3], [3, 4, 1])) // [1, 3]
 * ```
 *
 * @see {@link intersectionWith} — use custom equality
 * @see {@link union} — elements in either array
 * @see {@link difference} — elements only in the first array
 *
 * @category elements
 * @since 2.0.0
 */
export const intersection: {
  <B>(that: Iterable<B>): <A>(self: Iterable<A>) => Array<A & B>
  <A, B>(self: Iterable<A>, that: Iterable<B>): Array<A & B>
} = intersectionWith(Equal.asEquivalence())

/**
 * Computes elements in the first array that are not in the second, using a
 * custom equivalence.
 *
 * **When to use**
 *
 * Use when keeping only values from the first array and equality must be
 * defined by a custom comparator, such as matching objects by id.
 *
 * **Example** (Difference with custom equality)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const diff = Array.differenceWith<number>((a, b) => a === b)([1, 2, 3], [2, 3, 4])
 * console.log(diff) // [1]
 * ```
 *
 * @see {@link difference} for the `Equal.equivalence()` variant
 * @see {@link unionWith} for keeping values from either array with custom equality
 * @see {@link intersectionWith} for keeping values present in both arrays with custom equality
 *
 * @category elements
 * @since 2.0.0
 */
export const differenceWith = <A>(isEquivalent: (self: A, that: A) => boolean): {
  (that: Iterable<A>): (self: Iterable<A>) => Array<A>
  (self: Iterable<A>, that: Iterable<A>): Array<A>
} => {
  const has = containsWith(isEquivalent)
  return dual(
    2,
    (self: Iterable<A>, that: Iterable<A>): Array<A> => {
      const thatArray = fromIterable(that)
      return fromIterable(self).filter((a) => !has(thatArray, a))
    }
  )
}

/**
 * Computes elements in the first array that are not in the second, using
 * `Equal.equivalence()`.
 *
 * **When to use**
 *
 * Use when you need to keep values from the first array that are absent from
 * the second and the default `Equal.equivalence()` comparison is appropriate.
 *
 * **Example** (Array difference)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.difference([1, 2, 3], [2, 3, 4])) // [1]
 * ```
 *
 * @see {@link differenceWith} — use custom equality
 * @see {@link union} — elements in either array
 * @see {@link intersection} — elements in both arrays
 *
 * @category elements
 * @since 2.0.0
 */
export const difference: {
  <A>(that: Iterable<A>): (self: Iterable<A>) => Array<A>
  <A>(self: Iterable<A>, that: Iterable<A>): Array<A>
} = differenceWith(Equal.asEquivalence())

/**
 * Creates an empty array.
 *
 * **When to use**
 *
 * Use to create a typed empty array without allocating placeholder elements.
 *
 * **Example** (Creating an empty array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.empty<number>()
 * console.log(result) // []
 * ```
 *
 * @see {@link of} — create a single-element array
 * @see {@link make} — create from multiple values
 *
 * @category constructors
 * @since 2.0.0
 */
export const empty: <A = never>() => Array<A> = () => []

/**
 * Wraps a single value in a `NonEmptyArray`.
 *
 * **Example** (Creating a single-element array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.of(1)) // [1]
 * ```
 *
 * @see {@link make} — create from multiple values
 * @see {@link empty} — create an empty array
 *
 * @category constructors
 * @since 2.0.0
 */
export const of = <A>(a: A): NonEmptyArray<A> => [a]

/**
 * Utility types for working with `ReadonlyArray` at the type level. Use these
 * to infer element types, preserve non-emptiness, and flatten nested arrays.
 *
 * @since 2.0.0
 */
export declare namespace ReadonlyArray {
  /**
   * Infers the element type of an iterable.
   *
   * **Example** (Inferring an element type)
   *
   * ```ts
   * import type { Array } from "effect"
   *
   * type StringArrayType = Array.ReadonlyArray.Infer<ReadonlyArray<string>>
   * // StringArrayType is string
   * ```
   *
   * @category types
   * @since 2.0.0
   */
  export type Infer<S extends Iterable<any>> = S extends ReadonlyArray<infer A> ? A
    : S extends Iterable<infer A> ? A
    : never

  /**
   * Constructs an array type preserving non-emptiness.
   *
   * **Example** (Preserving non-emptiness)
   *
   * ```ts
   * import type { Array } from "effect"
   *
   * type Result = Array.ReadonlyArray.With<readonly [number], string>
   * // Result is NonEmptyArray<string>
   * ```
   *
   * @category types
   * @since 2.0.0
   */
  export type With<S extends Iterable<any>, A> = S extends NonEmptyReadonlyArray<any> ? NonEmptyArray<A>
    : Array<A>

  /**
   * Creates a non-empty array if either input is non-empty.
   *
   * **Example** (Preserving non-emptiness from either input)
   *
   * ```ts
   * import type { Array } from "effect"
   *
   * type Result = Array.ReadonlyArray.OrNonEmpty<
   *   readonly [number],
   *   ReadonlyArray<string>,
   *   number
   * >
   * // Result is NonEmptyArray<number>
   * ```
   *
   * @category types
   * @since 2.0.0
   */
  export type OrNonEmpty<
    S extends Iterable<any>,
    T extends Iterable<any>,
    A
  > = S extends NonEmptyReadonlyArray<any> ? NonEmptyArray<A>
    : T extends NonEmptyReadonlyArray<any> ? NonEmptyArray<A>
    : Array<A>

  /**
   * Creates a non-empty array only if both inputs are non-empty.
   *
   * **Example** (Preserving non-emptiness from both inputs)
   *
   * ```ts
   * import type { Array } from "effect"
   *
   * type Result = Array.ReadonlyArray.AndNonEmpty<
   *   readonly [number],
   *   readonly [string],
   *   boolean
   * >
   * // Result is NonEmptyArray<boolean>
   * ```
   *
   * @category types
   * @since 2.0.0
   */
  export type AndNonEmpty<
    S extends Iterable<any>,
    T extends Iterable<any>,
    A
  > = S extends NonEmptyReadonlyArray<any> ? T extends NonEmptyReadonlyArray<any> ? NonEmptyArray<A>
    : Array<A>
    : Array<A>

  /**
   * Flattens a nested array type.
   *
   * **Example** (Flattening nested array types)
   *
   * ```ts
   * import type { Array } from "effect"
   *
   * type Nested = ReadonlyArray<ReadonlyArray<number>>
   * type Flattened = Array.ReadonlyArray.Flatten<Nested>
   * // Flattened is Array<number>
   * ```
   *
   * @category types
   * @since 2.0.0
   */
  export type Flatten<T extends ReadonlyArray<ReadonlyArray<any>>> = T extends
    NonEmptyReadonlyArray<NonEmptyReadonlyArray<any>> ? NonEmptyArray<T[number][number]>
    : Array<T[number][number]>
}

/**
 * Transforms each element using a function, returning a new array.
 *
 * **When to use**
 *
 * Use to transform each element independently while preserving the array shape.
 *
 * **Details**
 *
 * - The function receives `(element, index)`.
 * - Preserves `NonEmptyArray` in the return type.
 *
 * **Example** (Doubling values)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.map([1, 2, 3], (x) => x * 2)) // [2, 4, 6]
 * ```
 *
 * @see {@link flatMap} — map and flatten
 *
 * @category mapping
 * @since 2.0.0
 */
export const map: {
  <S extends ReadonlyArray<any>, B>(
    f: (a: ReadonlyArray.Infer<S>, i: number) => B
  ): (self: S) => ReadonlyArray.With<S, B>
  <S extends ReadonlyArray<any>, B>(self: S, f: (a: ReadonlyArray.Infer<S>, i: number) => B): ReadonlyArray.With<S, B>
} = dual(2, <A, B>(self: ReadonlyArray<A>, f: (a: A, i: number) => B): Array<B> => self.map(f))

/**
 * Maps each element to an array and flattens the results into a single array.
 *
 * **When to use**
 *
 * Use to map each element to zero or more values and concatenate the results in
 * one pass.
 *
 * **Details**
 *
 * - The function receives `(element, index)`.
 * - Returns `NonEmptyArray` when both input and mapped arrays are non-empty.
 *
 * **Example** (FlatMapping an array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.flatMap([1, 2, 3], (x) => [x, x * 2])) // [1, 2, 2, 4, 3, 6]
 * ```
 *
 * @see {@link map} — transform without flattening
 * @see {@link flatten} — flatten without mapping
 *
 * @category sequencing
 * @since 2.0.0
 */
export const flatMap: {
  <S extends ReadonlyArray<any>, T extends ReadonlyArray<any>>(
    f: (a: ReadonlyArray.Infer<S>, i: number) => T
  ): (self: S) => ReadonlyArray.AndNonEmpty<S, T, ReadonlyArray.Infer<T>>
  <A, B>(self: NonEmptyReadonlyArray<A>, f: (a: A, i: number) => NonEmptyReadonlyArray<B>): NonEmptyArray<B>
  <A, B>(self: ReadonlyArray<A>, f: (a: A, i: number) => ReadonlyArray<B>): Array<B>
} = dual(
  2,
  <A, B>(self: ReadonlyArray<A>, f: (a: A, i: number) => ReadonlyArray<B>): Array<B> => {
    if (isReadonlyArrayEmpty(self)) {
      return []
    }
    const out: Array<B> = []
    for (let i = 0; i < self.length; i++) {
      const inner = f(self[i], i)
      for (let j = 0; j < inner.length; j++) {
        out.push(inner[j])
      }
    }
    return out
  }
)

/**
 * Flattens a nested array of arrays into a single array.
 *
 * **When to use**
 *
 * Use to collapse one level of nested arrays when no per-element mapping is
 * needed.
 *
 * **Example** (Flattening nested arrays)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.flatten([[1, 2], [], [3, 4], [], [5, 6]])) // [1, 2, 3, 4, 5, 6]
 * ```
 *
 * @see {@link flatMap} — map then flatten in one step
 *
 * @category sequencing
 * @since 2.0.0
 */
export const flatten: <const S extends ReadonlyArray<ReadonlyArray<any>>>(self: S) => ReadonlyArray.Flatten<S> =
  flatMap(identity) as any

/**
 * Extracts all `Some` values from an iterable of `Option`s, discarding `None`s.
 *
 * **When to use**
 *
 * Use to collect only present values from `Option` values while discarding
 * `None` values.
 *
 * **Example** (Extracting Some values)
 *
 * ```ts
 * import { Array, Option } from "effect"
 *
 * console.log(Array.getSomes([Option.some(1), Option.none(), Option.some(2)])) // [1, 2]
 * ```
 *
 * @see {@link fromOption} — convert a single Option
 * @see {@link getSuccesses} — extract successes from Results
 *
 * @category filtering
 * @since 2.0.0
 */

export const getSomes: <T extends Iterable<Option.Option<X>>, X = any>(
  self: T
) => Array<Option.Option.Value<ReadonlyArray.Infer<T>>> = (self: any) => {
  const out: Array<any> = []
  for (const a of self) {
    if (Option.isSome(a)) {
      out.push(a.value)
    }
  }
  return out
}

/**
 * Extracts all failure values from an iterable of `Result`s, discarding
 * successes.
 *
 * **When to use**
 *
 * Use to collect only failure values from `Result` values while discarding
 * successes.
 *
 * **Example** (Extracting failures)
 *
 * ```ts
 * import { Array, Result } from "effect"
 *
 * console.log(Array.getFailures([Result.succeed(1), Result.fail("err"), Result.succeed(2)]))
 * // ["err"]
 * ```
 *
 * @see {@link getSuccesses} — extract success values
 * @see {@link separate} — split into failures and successes
 *
 * @category filtering
 * @since 4.0.0
 */
export const getFailures = <T extends Iterable<Result.Result<any, any>>>(
  self: T
): Array<Result.Result.Failure<ReadonlyArray.Infer<T>>> => {
  const out: Array<any> = []
  for (const a of self) {
    if (Result.isFailure(a)) {
      out.push(a.failure)
    }
  }

  return out
}

/**
 * Extracts all success values from an iterable of `Result`s, discarding
 * failures.
 *
 * **When to use**
 *
 * Use to collect only success values from `Result` values while discarding
 * failures.
 *
 * **Example** (Extracting successes)
 *
 * ```ts
 * import { Array, Result } from "effect"
 *
 * console.log(Array.getSuccesses([Result.succeed(1), Result.fail("err"), Result.succeed(2)]))
 * // [1, 2]
 * ```
 *
 * @see {@link getFailures} — extract failure values
 * @see {@link separate} — split into failures and successes
 *
 * @category filtering
 * @since 4.0.0
 */
export const getSuccesses = <T extends Iterable<Result.Result<any, any>>>(
  self: T
): Array<Result.Result.Success<ReadonlyArray.Infer<T>>> => {
  const out: Array<any> = []
  for (const a of self) {
    if (Result.isSuccess(a)) {
      out.push(a.success)
    }
  }

  return out
}

/**
 * Keeps transformed values for elements where a `Filter` succeeds.
 *
 * **When to use**
 *
 * Use to transform elements with a `Result`-returning filter while discarding
 * failures.
 *
 * **Details**
 *
 * - The filter receives `(element, index)`.
 * - Failures are discarded.
 *
 * **Example** (Filter and transform)
 *
 * ```ts
 * import { Array, Result } from "effect"
 *
 * console.log(Array.filterMap([1, 2, 3, 4], (n) => n % 2 === 0 ? Result.succeed(n * 10) : Result.failVoid))
 * // [20, 40]
 * ```
 *
 * @see {@link filter} — keep original elements matching a predicate
 * @see {@link partition} for keeping both failures and successes
 *
 * @category filtering
 * @since 2.0.0
 */
export const filterMap: {
  <A, B, X>(f: (input: NoInfer<A>, i: number) => Result.Result<B, X>): (self: Iterable<A>) => Array<B>
  <A, B, X>(self: Iterable<A>, f: (input: A, i: number) => Result.Result<B, X>): Array<B>
} = dual(2, <A, B, X>(self: Iterable<A>, f: (input: A, i: number) => Result.Result<B, X>): Array<B> => {
  const as = fromIterable(self)
  const out: Array<B> = []
  for (let i = 0; i < as.length; i++) {
    const result = f(as[i], i)
    if (Result.isSuccess(result)) {
      out.push(result.success)
    }
  }
  return out
})

/**
 * Keeps only elements satisfying a predicate (or refinement).
 *
 * **When to use**
 *
 * Use to keep original elements that satisfy a boolean predicate or refinement.
 *
 * **Details**
 *
 * - The predicate receives `(element, index)`.
 * - Supports refinements for type narrowing.
 *
 * **Example** (Filtering even numbers)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.filter([1, 2, 3, 4], (x) => x % 2 === 0)) // [2, 4]
 * ```
 *
 * @see {@link partition} — split into matching and non-matching
 * @see {@link filterMap} for transforming while filtering
 *
 * @category filtering
 * @since 2.0.0
 */
export const filter: {
  <A, B extends A>(refinement: (a: NoInfer<A>, i: number) => a is B): (self: Iterable<A>) => Array<B>
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => Array<A>
  <A, B extends A>(self: Iterable<A>, refinement: (a: A, i: number) => a is B): Array<B>
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Array<A>
} = dual(
  2,
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Array<A> => {
    const as = fromIterable(self)
    const out: Array<A> = []
    for (let i = 0; i < as.length; i++) {
      if (predicate(as[i], i)) {
        out.push(as[i])
      }
    }
    return out
  }
)

/**
 * Splits an iterable using a `Filter` into failures and successes.
 *
 * **When to use**
 *
 * Use to evaluate each element with a `Result`-returning filter and keep both
 * failure and success values.
 *
 * **Details**
 *
 * - Returns `[excluded, satisfying]`.
 * - The filter receives `(element, index)`.
 *
 * **Example** (Partitioning with a filter)
 *
 * ```ts
 * import { Array, Result } from "effect"
 *
 * console.log(Array.partition([1, -2, 3], (n, i) =>
 *   n > 0 ? Result.succeed(n + i) : Result.fail(`negative:${n}`)
 * ))
 * // [["negative:-2"], [1, 5]]
 * ```
 *
 * @see {@link filter} — keep only matching elements
 * @see {@link filterMap} for discarding failures
 * @see {@link separate} — split an iterable of `Result` values
 *
 * @category filtering
 * @since 2.0.0
 */
export const partition: {
  <A, Pass, Fail>(
    f: (input: NoInfer<A>, i: number) => Result.Result<Pass, Fail>
  ): (self: Iterable<A>) => [excluded: Array<Fail>, satisfying: Array<Pass>]
  <A, Pass, Fail>(
    self: Iterable<A>,
    f: (input: A, i: number) => Result.Result<Pass, Fail>
  ): [excluded: Array<Fail>, satisfying: Array<Pass>]
} = dual(
  2,
  <A, Pass, Fail>(
    self: Iterable<A>,
    f: (input: A, i: number) => Result.Result<Pass, Fail>
  ): [excluded: Array<Fail>, satisfying: Array<Pass>] => {
    const excluded: Array<Fail> = []
    const satisfying: Array<Pass> = []
    let i = 0
    for (const a of self) {
      const result = f(a, i++)
      if (Result.isSuccess(result)) {
        satisfying.push(result.success)
      } else {
        excluded.push(result.failure)
      }
    }
    return [excluded, satisfying]
  }
)

/**
 * Separates an iterable of `Result`s into failure values and success values.
 *
 * **When to use**
 *
 * Use to split existing `Result` values into failure and success arrays.
 *
 * **Details**
 *
 * - Returns `[failures, successes]`.
 * - Equivalent to `partition(identity)`.
 *
 * **Example** (Separating Results)
 *
 * ```ts
 * import { Array, Result } from "effect"
 *
 * const [failures, successes] = Array.separate([
 *   Result.succeed(1), Result.fail("error"), Result.succeed(2)
 * ])
 * console.log(failures) // ["error"]
 * console.log(successes) // [1, 2]
 * ```
 *
 * @see {@link getFailures} — extract only failures
 * @see {@link getSuccesses} — extract only successes
 * @see {@link partition} for computing `Result` values while splitting
 *
 * @category filtering
 * @since 2.0.0
 */
export const separate: <T extends Iterable<Result.Result<any, any>>>(
  self: T
) => [
  failures: Array<Result.Result.Failure<ReadonlyArray.Infer<T>>>,
  successes: Array<Result.Result.Success<ReadonlyArray.Infer<T>>>
] = partition(identity)

/**
 * Folds an iterable from left to right into a single value.
 *
 * **When to use**
 *
 * Use to combine all elements into one accumulated value from left to right.
 *
 * **Details**
 *
 * - The function receives `(accumulator, element, index)`.
 *
 * **Example** (Summing an array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.reduce([1, 2, 3], 0, (acc, n) => acc + n)) // 6
 * ```
 *
 * @see {@link reduceRight} — fold from right to left
 * @see {@link scan} — fold keeping intermediate values
 *
 * @category folding
 * @since 2.0.0
 */
export const reduce: {
  <B, A>(b: B, f: (b: B, a: A, i: number) => B): (self: Iterable<A>) => B
  <A, B>(self: Iterable<A>, b: B, f: (b: B, a: A, i: number) => B): B
} = dual(
  3,
  <B, A>(self: Iterable<A>, b: B, f: (b: B, a: A, i: number) => B): B =>
    fromIterable(self).reduce((b, a, i) => f(b, a, i), b)
)

/**
 * Folds an iterable from right to left into a single value.
 *
 * **When to use**
 *
 * Use when folding order matters and values must be combined from right to
 * left.
 *
 * **Details**
 *
 * - The function receives `(accumulator, element, index)`.
 *
 * **Example** (Right-to-left fold)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.reduceRight([1, 2, 3], 0, (acc, n) => acc + n)) // 6
 * ```
 *
 * @see {@link reduce} — fold from left to right
 * @see {@link scanRight} — fold keeping intermediate values
 *
 * @category folding
 * @since 2.0.0
 */
export const reduceRight: {
  <B, A>(b: B, f: (b: B, a: A, i: number) => B): (self: Iterable<A>) => B
  <A, B>(self: Iterable<A>, b: B, f: (b: B, a: A, i: number) => B): B
} = dual(
  3,
  <A, B>(self: Iterable<A>, b: B, f: (b: B, a: A, i: number) => B): B =>
    fromIterable(self).reduceRight((b, a, i) => f(b, a, i), b)
)

/**
 * Lifts a predicate into an array: returns `[value]` if the predicate holds,
 * `[]` otherwise.
 *
 * **Example** (Conditional wrapping)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const isEven = (n: number) => n % 2 === 0
 * const to = Array.liftPredicate(isEven)
 * console.log(to(1)) // []
 * console.log(to(2)) // [2]
 * ```
 *
 * @see {@link liftOption} — lift an Option-returning function
 *
 * @category lifting
 * @since 2.0.0
 */
export const liftPredicate: { // Note: I intentionally avoid using the NoInfer pattern here.
  <A, B extends A>(refinement: Predicate.Refinement<A, B>): (a: A) => Array<B>
  <A>(predicate: Predicate.Predicate<A>): <B extends A>(b: B) => Array<B>
} = <A>(predicate: Predicate.Predicate<A>) => <B extends A>(b: B): Array<B> => predicate(b) ? [b] : []

/**
 * Lifts an `Option`-returning function into one that returns an array:
 * `Some(a)` becomes `[a]`, `None` becomes `[]`.
 *
 * **Example** (Lifting an Option function)
 *
 * ```ts
 * import { Array, Option } from "effect"
 *
 * const parseNumber = Array.liftOption((s: string) => {
 *   const n = Number(s)
 *   return isNaN(n) ? Option.none() : Option.some(n)
 * })
 * console.log(parseNumber("123")) // [123]
 * console.log(parseNumber("abc")) // []
 * ```
 *
 * @see {@link liftPredicate} — lift a boolean predicate
 * @see {@link liftResult} — lift a Result-returning function
 *
 * @category lifting
 * @since 2.0.0
 */
export const liftOption = <A extends Array<unknown>, B>(
  f: (...a: A) => Option.Option<B>
) =>
(...a: A): Array<B> => fromOption(f(...a))

/**
 * Converts a nullable value to an array: `null`/`undefined` becomes `[]`,
 * anything else becomes `[value]`.
 *
 * **When to use**
 *
 * Use to treat a nullable single value as zero or one array element.
 *
 * **Example** (Nullable to array)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.fromNullishOr(1)) // [1]
 * console.log(Array.fromNullishOr(null)) // []
 * console.log(Array.fromNullishOr(undefined)) // []
 * ```
 *
 * @see {@link liftNullishOr} — lift a nullable-returning function
 * @see {@link fromOption} — convert from Option
 *
 * @category converting
 * @since 4.0.0
 */
export const fromNullishOr = <A>(a: A): Array<NonNullable<A>> => a == null ? empty() : [a as NonNullable<A>]

/**
 * Lifts a nullable-returning function into one that returns an array:
 * `null`/`undefined` becomes `[]`, anything else becomes `[value]`.
 *
 * **Example** (Lifting a nullable function)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const parseNumber = Array.liftNullishOr((s: string) => {
 *   const n = Number(s)
 *   return isNaN(n) ? null : n
 * })
 * console.log(parseNumber("123")) // [123]
 * console.log(parseNumber("abc")) // []
 * ```
 *
 * @see {@link fromNullishOr} — convert a single nullable value
 * @see {@link liftOption} — lift an Option-returning function
 *
 * @category lifting
 * @since 4.0.0
 */
export const liftNullishOr = <A extends Array<unknown>, B>(
  f: (...a: A) => B
): (...a: A) => Array<NonNullable<B>> =>
(...a) => fromNullishOr(f(...a))

/**
 * Maps each element with a nullable-returning function, keeping only non-null /
 * non-undefined results.
 *
 * **When to use**
 *
 * Use when mapping and filtering in one step, where the mapper can return
 * `null` or `undefined` to skip elements.
 *
 * **Example** (FlatMapping with nullable)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.flatMapNullishOr([1, 2, 3], (n) => (n % 2 === 0 ? null : n)))
 * // [1, 3]
 * ```
 *
 * @see {@link flatMap} for mapping each element to an array and flattening
 * @see {@link fromNullishOr} for converting a single nullable value to an array
 *
 * @category sequencing
 * @since 4.0.0
 */
export const flatMapNullishOr: {
  <A, B>(f: (a: A) => B): (self: ReadonlyArray<A>) => Array<NonNullable<B>>
  <A, B>(self: ReadonlyArray<A>, f: (a: A) => B): Array<NonNullable<B>>
} = dual(
  2,
  <A, B>(self: ReadonlyArray<A>, f: (a: A) => B): Array<NonNullable<B>> => flatMap(self, (a) => fromNullishOr(f(a)))
)

/**
 * Lifts a `Result`-returning function into one that returns an array: failures
 * produce `[]`, successes produce `[value]`.
 *
 * **Example** (Lifting a Result function)
 *
 * ```ts
 * import { Array, Result } from "effect"
 *
 * const parseNumber = (s: string): Result.Result<number, Error> =>
 *   isNaN(Number(s))
 *     ? Result.fail(new Error("Not a number"))
 *     : Result.succeed(Number(s))
 *
 * const liftedParseNumber = Array.liftResult(parseNumber)
 * console.log(liftedParseNumber("42")) // [42]
 * console.log(liftedParseNumber("not a number")) // []
 * ```
 *
 * @see {@link liftOption} — lift an Option-returning function
 * @see {@link liftPredicate} — lift a boolean predicate
 *
 * @category lifting
 * @since 4.0.0
 */
export const liftResult = <A extends Array<unknown>, E, B>(
  f: (...a: A) => Result.Result<B, E>
) =>
(...a: A): Array<B> => {
  const e = f(...a)
  return Result.isFailure(e) ? [] : [e.success]
}

/**
 * Checks whether all elements satisfy the predicate. Supports refinements for
 * type narrowing.
 *
 * **When to use**
 *
 * Use to check that all elements satisfy a predicate, including
 * refinement-based type narrowing.
 *
 * **Example** (Testing all elements)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.every([2, 4, 6], (x) => x % 2 === 0)) // true
 * console.log(Array.every([2, 3, 6], (x) => x % 2 === 0)) // false
 * ```
 *
 * @see {@link some} — test if any element matches
 *
 * @category elements
 * @since 2.0.0
 */
export const every: {
  <A, B extends A>(
    refinement: (a: NoInfer<A>, i: number) => a is B
  ): (self: ReadonlyArray<A>) => self is ReadonlyArray<B>
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: ReadonlyArray<A>) => boolean
  <A, B extends A>(self: ReadonlyArray<A>, refinement: (a: A, i: number) => a is B): self is ReadonlyArray<B>
  <A>(self: ReadonlyArray<A>, predicate: (a: A, i: number) => boolean): boolean
} = dual(
  2,
  <A, B extends A>(self: ReadonlyArray<A>, refinement: (a: A, i: number) => a is B): self is ReadonlyArray<B> =>
    self.every(refinement)
)

/**
 * Checks whether at least one element satisfies the predicate. Narrows the type
 * to `NonEmptyReadonlyArray` on success.
 *
 * **Example** (Testing for any match)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.some([1, 3, 4], (x) => x % 2 === 0)) // true
 * console.log(Array.some([1, 3, 5], (x) => x % 2 === 0)) // false
 * ```
 *
 * @see {@link every} — test if all elements match
 * @see {@link contains} — test for a specific value
 *
 * @category elements
 * @since 2.0.0
 */
export const some: {
  <A>(
    predicate: (a: NoInfer<A>, i: number) => boolean
  ): (self: ReadonlyArray<A>) => self is NonEmptyReadonlyArray<A>
  <A>(self: ReadonlyArray<A>, predicate: (a: A, i: number) => boolean): self is NonEmptyReadonlyArray<A>
} = dual(
  2,
  <A>(self: ReadonlyArray<A>, predicate: (a: A, i: number) => boolean): self is NonEmptyReadonlyArray<A> =>
    self.some(predicate)
)

/**
 * Applies a function to each suffix of the array (starting from each index),
 * collecting the results.
 *
 * **When to use**
 *
 * Use when a computation depends on every suffix of an array, such as
 * cumulative aggregations from each position.
 *
 * **Details**
 *
 * - For index `i`, the function receives `self.slice(i)`.
 *
 * **Example** (Suffix lengths)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.extend([1, 2, 3], (as) => as.length)) // [3, 2, 1]
 * ```
 *
 * @see {@link scan} for keeping intermediate accumulator values during a fold
 *
 * @category mapping
 * @since 2.0.0
 */
export const extend: {
  <A, B>(f: (as: ReadonlyArray<A>) => B): (self: ReadonlyArray<A>) => Array<B>
  <A, B>(self: ReadonlyArray<A>, f: (as: ReadonlyArray<A>) => B): Array<B>
} = dual(
  2,
  <A, B>(self: ReadonlyArray<A>, f: (as: ReadonlyArray<A>) => B): Array<B> => self.map((_, i, as) => f(as.slice(i)))
)

/**
 * Returns the minimum element of a non-empty array according to the given
 * `Order`.
 *
 * **Example** (Finding the minimum)
 *
 * ```ts
 * import { Array, Order } from "effect"
 *
 * console.log(Array.min([3, 1, 2], Order.Number)) // 1
 * ```
 *
 * @see {@link max} — find the maximum
 * @see {@link sort} — sort the entire array
 *
 * @category elements
 * @since 2.0.0
 */
export const min: {
  <A>(O: Order.Order<A>): (self: NonEmptyReadonlyArray<A>) => A
  <A>(self: NonEmptyReadonlyArray<A>, O: Order.Order<A>): A
} = dual(2, <A>(self: NonEmptyReadonlyArray<A>, O: Order.Order<A>): A => self.reduce(Order.min(O)))

/**
 * Returns the maximum element of a non-empty array according to the given
 * `Order`.
 *
 * **Example** (Finding the maximum)
 *
 * ```ts
 * import { Array, Order } from "effect"
 *
 * console.log(Array.max([3, 1, 2], Order.Number)) // 3
 * ```
 *
 * @see {@link min} — find the minimum
 * @see {@link sort} — sort the entire array
 *
 * @category elements
 * @since 2.0.0
 */
export const max: {
  <A>(O: Order.Order<A>): (self: NonEmptyReadonlyArray<A>) => A
  <A>(self: NonEmptyReadonlyArray<A>, O: Order.Order<A>): A
} = dual(2, <A>(self: NonEmptyReadonlyArray<A>, O: Order.Order<A>): A => self.reduce(Order.max(O)))

/**
 * Builds an array by repeatedly applying a function to a seed value. The
 * function returns `Option.some([element, nextSeed])` to continue, or
 * `Option.none()` to stop.
 *
 * **Example** (Generating a sequence)
 *
 * ```ts
 * import { Array, Option } from "effect"
 *
 * console.log(Array.unfold(1, (n) => n <= 5 ? Option.some([n, n + 1]) : Option.none()))
 * // [1, 2, 3, 4, 5]
 * ```
 *
 * @see {@link makeBy} — generate from index
 * @see {@link range} — generate a numeric range
 *
 * @category constructors
 * @since 2.0.0
 */
export const unfold = <B, A>(b: B, f: (b: B) => Option.Option<readonly [A, B]>): Array<A> => {
  const out: Array<A> = []
  let next: B = b
  while (true) {
    const o = f(next)
    if (Option.isNone(o)) {
      break
    }
    const [a, b] = o.value
    out.push(a)
    next = b
  }
  return out
}

/**
 * Creates an `Order` for arrays based on an element `Order`. Arrays are
 * compared element-wise; if all compared elements are equal, shorter arrays
 * come first.
 *
 * **Example** (Comparing arrays)
 *
 * ```ts
 * import { Array, Order } from "effect"
 *
 * const arrayOrder = Array.makeOrder(Order.Number)
 * console.log(arrayOrder([1, 2], [1, 3])) // -1
 * ```
 *
 * @see {@link makeEquivalence} — create an equivalence for arrays
 *
 * @category instances
 * @since 4.0.0
 */
export const makeOrder: <A>(O: Order.Order<A>) => Order.Order<ReadonlyArray<A>> = Order.Array

/**
 * Creates an `Equivalence` for arrays based on an element `Equivalence`. Two
 * arrays are equivalent when they have the same length and all elements are
 * pairwise equivalent.
 *
 * **Example** (Comparing arrays for equality)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const eq = Array.makeEquivalence<number>((a, b) => a === b)
 * console.log(eq([1, 2, 3], [1, 2, 3])) // true
 * ```
 *
 * @see {@link makeOrder} — create an ordering for arrays
 *
 * @category instances
 * @since 4.0.0
 */
export const makeEquivalence: <A>(
  isEquivalent: Equivalence.Equivalence<A>
) => Equivalence.Equivalence<ReadonlyArray<A>> = Equivalence.Array

/**
 * Runs a side-effect for each element. The callback receives `(element, index)`.
 *
 * **When to use**
 *
 * Use to iterate over an array for side-effects only, when no transformed
 * result is needed.
 *
 * **Example** (Iterating with side-effects)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * Array.forEach([1, 2, 3], (n) => console.log(n)) // 1, 2, 3
 * ```
 *
 * @see {@link map} for transforming each element into a new array
 *
 * @category elements
 * @since 2.0.0
 */
export const forEach: {
  <A>(f: (a: A, i: number) => void): (self: Iterable<A>) => void
  <A>(self: Iterable<A>, f: (a: A, i: number) => void): void
} = dual(2, <A>(self: Iterable<A>, f: (a: A, i: number) => void): void => fromIterable(self).forEach((a, i) => f(a, i)))

/**
 * Removes duplicates using a custom equivalence, preserving the order of the
 * first occurrence.
 *
 * **When to use**
 *
 * Use to remove all duplicate elements with a custom equivalence when default
 * equality is not appropriate.
 *
 * **Example** (Deduplicating with custom equality)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.dedupeWith([1, 2, 2, 3, 3, 3], (a, b) => a === b)) // [1, 2, 3]
 * ```
 *
 * @see {@link dedupe} — uses default equality
 * @see {@link dedupeAdjacentWith} — only dedupes consecutive elements
 *
 * @category elements
 * @since 2.0.0
 */
export const dedupeWith: {
  <S extends Iterable<any>>(
    isEquivalent: (self: ReadonlyArray.Infer<S>, that: ReadonlyArray.Infer<S>) => boolean
  ): (self: S) => ReadonlyArray.With<S, ReadonlyArray.Infer<S>>
  <A>(self: NonEmptyReadonlyArray<A>, isEquivalent: (self: A, that: A) => boolean): NonEmptyArray<A>
  <A>(self: Iterable<A>, isEquivalent: (self: A, that: A) => boolean): Array<A>
} = dual(
  2,
  <A>(self: Iterable<A>, isEquivalent: (self: A, that: A) => boolean): Array<A> => {
    const input = fromIterable(self)
    if (isReadonlyArrayNonEmpty(input)) {
      const out: NonEmptyArray<A> = [headNonEmpty(input)]
      const rest = tailNonEmpty(input)
      for (const r of rest) {
        if (out.every((a) => !isEquivalent(r, a))) {
          out.push(r)
        }
      }
      return out
    }
    return []
  }
)

/**
 * Removes duplicates using `Equal.equivalence()`, preserving the order of the
 * first occurrence.
 *
 * **When to use**
 *
 * Use to remove repeated values from an iterable when Effect's default equality
 * is the right comparison, preserving the first occurrence.
 *
 * **Example** (Removing duplicates)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.dedupe([1, 2, 1, 3, 2, 4])) // [1, 2, 3, 4]
 * ```
 *
 * @see {@link dedupeWith} — use custom equality
 * @see {@link dedupeAdjacent} — only dedupes consecutive elements
 *
 * @category elements
 * @since 2.0.0
 */
export const dedupe = <S extends Iterable<any>>(
  self: S
): S extends NonEmptyReadonlyArray<infer A> ? NonEmptyArray<A> : S extends Iterable<infer A> ? Array<A> : never =>
  dedupeWith(self, Equal.asEquivalence()) as any

/**
 * Removes consecutive duplicate elements using a custom equivalence.
 *
 * **When to use**
 *
 * Use when consecutive duplicates should be collapsed using a custom
 * equivalence, while equivalent values that appear later should remain in the
 * result.
 *
 * **Details**
 *
 * - Non-adjacent duplicates are preserved.
 *
 * **Example** (Deduplicating adjacent elements)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.dedupeAdjacentWith([1, 1, 2, 2, 3, 3], (a, b) => a === b))
 * // [1, 2, 3]
 * ```
 *
 * @see {@link dedupeAdjacent} — uses default equality
 * @see {@link dedupeWith} — dedupes all duplicates, not just adjacent
 *
 * @category elements
 * @since 2.0.0
 */
export const dedupeAdjacentWith: {
  <A>(isEquivalent: (self: A, that: A) => boolean): (self: Iterable<A>) => Array<A>
  <A>(self: Iterable<A>, isEquivalent: (self: A, that: A) => boolean): Array<A>
} = dual(2, <A>(self: Iterable<A>, isEquivalent: (self: A, that: A) => boolean): Array<A> => {
  const out: Array<A> = []
  let lastA: Option.Option<A> = Option.none()
  for (const a of self) {
    if (Option.isNone(lastA) || !isEquivalent(a, lastA.value)) {
      out.push(a)
      lastA = Option.some(a)
    }
  }
  return out
})

/**
 * Removes consecutive duplicate elements using `Equal.equivalence()`.
 *
 * **When to use**
 *
 * Use when you need to collapse consecutive duplicates while preserving later
 * non-consecutive repeats, and the default equality is sufficient.
 *
 * **Example** (Removing adjacent duplicates)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.dedupeAdjacent([1, 1, 2, 2, 3, 3])) // [1, 2, 3]
 * ```
 *
 * @see {@link dedupeAdjacentWith} — use custom equality
 * @see {@link dedupe} — remove all duplicates
 *
 * @category elements
 * @since 2.0.0
 */
export const dedupeAdjacent: <A>(self: Iterable<A>) => Array<A> = dedupeAdjacentWith(Equal.asEquivalence())

/**
 * Joins string elements with a separator.
 *
 * **Example** (Joining strings)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * console.log(Array.join(["a", "b", "c"], "-")) // "a-b-c"
 * ```
 *
 * @see {@link intersperse} — insert separator elements without joining
 *
 * @category folding
 * @since 2.0.0
 */
export const join: {
  (sep: string): (self: Iterable<string>) => string
  (self: Iterable<string>, sep: string): string
} = dual(2, (self: Iterable<string>, sep: string): string => fromIterable(self).join(sep))

/**
 * Maps over an array while threading an accumulator through each step, returning both the final state and the mapped array.
 *
 * **When to use**
 *
 * Use when mapping needs state threaded through each element and the final state
 * is also needed.
 *
 * **Details**
 *
 * - Combines `map` and `reduce` in a single pass.
 * - The callback receives the current state, element, and index, and returns `[nextState, mappedValue]`.
 * - Returns `[finalState, mappedArray]`.
 * - Dual: can be used in both data-first and data-last style.
 *
 * **Example** (Running sum alongside mapped values)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.mapAccum([1, 2, 3], 0, (acc, n) => [acc + n, acc + n])
 * console.log(result) // [6, [1, 3, 6]]
 * ```
 *
 * @see {@link scan} — when you only need the accumulated results (not the final state)
 * @see {@link reduce} — when you only need the final accumulated value
 *
 * @category folding
 * @since 2.0.0
 */
export const mapAccum: {
  <S, A, B, I extends Iterable<A> = Iterable<A>>(
    s: S,
    f: (s: S, a: ReadonlyArray.Infer<I>, i: number) => readonly [S, B]
  ): (self: I) => [state: S, mappedArray: ReadonlyArray.With<I, B>]
  <S, A, B, I extends Iterable<A> = Iterable<A>>(
    self: I,
    s: S,
    f: (s: S, a: ReadonlyArray.Infer<I>, i: number) => readonly [S, B]
  ): [state: S, mappedArray: ReadonlyArray.With<I, B>]
} = dual(
  3,
  <S, A, B>(self: Iterable<A>, s: S, f: (s: S, a: A, i: number) => [S, B]): [state: S, mappedArray: Array<B>] => {
    let i = 0
    let s1 = s
    const out: Array<B> = []
    for (const a of self) {
      const r = f(s1, a, i)
      s1 = r[0]
      out.push(r[1])
      i++
    }
    return [s1, out]
  }
)

/**
 * Computes the cartesian product of two arrays, applying a combiner to each pair.
 *
 * **When to use**
 *
 * Use to compute every combination from two arrays and immediately transform
 * each pair into a custom result.
 *
 * **Details**
 *
 * - Produces every combination of an element from `self` with an element from `that`.
 * - Result length is `self.length * that.length`.
 * - Order: iterates `that` for each element of `self`.
 *
 * **Example** (Combining numbers and letters)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.cartesianWith([1, 2], ["a", "b"], (a, b) => `${a}-${b}`)
 * console.log(result) // ["1-a", "1-b", "2-a", "2-b"]
 * ```
 *
 * @see {@link cartesian} for returning tuples instead of applying a combiner
 *
 * @category elements
 * @since 2.0.0
 */
export const cartesianWith: {
  <A, B, C>(that: ReadonlyArray<B>, f: (a: A, b: B) => C): (self: ReadonlyArray<A>) => Array<C>
  <A, B, C>(self: ReadonlyArray<A>, that: ReadonlyArray<B>, f: (a: A, b: B) => C): Array<C>
} = dual(
  3,
  <A, B, C>(self: ReadonlyArray<A>, that: ReadonlyArray<B>, f: (a: A, b: B) => C): Array<C> =>
    flatMap(self, (a) => map(that, (b) => f(a, b)))
)

/**
 * Computes the cartesian product of two arrays, returning all pairs as tuples.
 *
 * **When to use**
 *
 * Use when you need every `[a, b]` pair from two arrays as tuples.
 *
 * **Details**
 *
 * - Produces every `[a, b]` combination of an element from `self` with an element from `that`.
 * - Result length is `self.length * that.length`.
 *
 * **Example** (All pairs of two arrays)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.cartesian([1, 2], ["a", "b"])
 * console.log(result) // [[1, "a"], [1, "b"], [2, "a"], [2, "b"]]
 * ```
 *
 * @see {@link cartesianWith} — apply a combiner to each pair
 *
 * @category elements
 * @since 2.0.0
 */
export const cartesian: {
  <B>(that: ReadonlyArray<B>): <A>(self: ReadonlyArray<A>) => Array<[A, B]>
  <A, B>(self: ReadonlyArray<A>, that: ReadonlyArray<B>): Array<[A, B]>
} = dual(
  2,
  <A, B>(self: ReadonlyArray<A>, that: ReadonlyArray<B>): Array<[A, B]> => cartesianWith(self, that, (a, b) => [a, b])
)

// -------------------------------------------------------------------------------------
// do notation
// -------------------------------------------------------------------------------------

/**
 * Provides the starting point for the "do simulation" — an array comprehension pattern.
 *
 * **When to use**
 *
 * Use when begin a pipeline with `Do`, then use {@link bind} to introduce array variables and {@link let_ let} for plain values.
 * - Each `bind` produces the cartesian product of all bound variables (like nested loops).
 * - Use `filter` and `map` in the pipeline to add conditions and transformations.
 *
 * **Example** (Array comprehension with do notation)
 *
 * ```ts
 * import { Array, pipe } from "effect"
 *
 * const result = pipe(
 *   Array.Do,
 *   Array.bind("x", () => [1, 3, 5]),
 *   Array.bind("y", () => [2, 4, 6]),
 *   Array.filter(({ x, y }) => x < y),
 *   Array.map(({ x, y }) => [x, y] as const)
 * )
 * console.log(result) // [[1, 2], [1, 4], [1, 6], [3, 4], [3, 6], [5, 6]]
 * ```
 *
 * @see {@link bind} — introduce an array variable into the scope
 * @see {@link bindTo} — start a pipeline by naming the first array
 * @see {@link let_ let} — introduce a plain computed value
 *
 * @category do notation
 * @since 3.2.0
 */
export const Do: ReadonlyArray<{}> = of({})

/**
 * Adds a new array variable to a do-notation scope, producing the cartesian product with all previous bindings.
 *
 * **When to use**
 *
 * Use to add another array-producing binding to an `Array.Do` pipeline, pairing
 * each existing scope with every value returned by the callback.
 *
 * **Details**
 *
 * - Each `bind` call adds a named property to the accumulated object.
 * - The callback receives the current scope and must return an array.
 * - Equivalent to `flatMap` + merging the new value into the scope object.
 *
 * **Example** (Binding two arrays)
 *
 * ```ts
 * import { Array, pipe } from "effect"
 *
 * const result = pipe(
 *   Array.Do,
 *   Array.bind("x", () => [1, 2]),
 *   Array.bind("y", () => ["a", "b"])
 * )
 * console.log(result)
 * // [{ x: 1, y: "a" }, { x: 1, y: "b" }, { x: 2, y: "a" }, { x: 2, y: "b" }]
 * ```
 *
 * @see {@link Do} — start a do-notation pipeline
 * @see {@link bindTo} — name the first array in a pipeline
 * @see {@link let_ let} — add a plain computed value
 *
 * @category do notation
 * @since 3.2.0
 */
export const bind: {
  <A extends object, N extends string, B>(
    tag: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => ReadonlyArray<B>
  ): (
    self: ReadonlyArray<A>
  ) => Array<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }>
  <A extends object, N extends string, B>(
    self: ReadonlyArray<A>,
    tag: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => ReadonlyArray<B>
  ): Array<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }>
} = internalDoNotation.bind<ReadonlyArrayTypeLambda>(map, flatMap) as any

/**
 * Wraps each array element in an object with the given key, starting a do-notation scope.
 *
 * **When to use**
 *
 * Use when you already have an array and want to start a do-notation pipeline
 * by naming each element.
 *
 * **Details**
 *
 * - Equivalent to `Array.map(self, (a) => ({ [tag]: a }))`.
 * - Alternative to starting with `Do` + `bind`; useful when you already have an array.
 *
 * **Example** (Naming an existing array)
 *
 * ```ts
 * import { Array, pipe } from "effect"
 *
 * const result = pipe(
 *   [1, 2, 3],
 *   Array.bindTo("x")
 * )
 * console.log(result) // [{ x: 1 }, { x: 2 }, { x: 3 }]
 * ```
 *
 * @see {@link Do} — start with an empty scope
 * @see {@link bind} — add another array variable to the scope
 *
 * @category do notation
 * @since 3.2.0
 */
export const bindTo: {
  <N extends string>(tag: N): <A>(self: ReadonlyArray<A>) => Array<{ [K in N]: A }>
  <A, N extends string>(self: ReadonlyArray<A>, tag: N): Array<{ [K in N]: A }>
} = internalDoNotation.bindTo<ReadonlyArrayTypeLambda>(map) as any

const let_: {
  <N extends string, B, A extends object>(
    tag: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => B
  ): (self: ReadonlyArray<A>) => Array<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }>
  <N extends string, A extends object, B>(
    self: ReadonlyArray<A>,
    tag: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => B
  ): Array<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }>
} = internalDoNotation.let_<ReadonlyArrayTypeLambda>(map) as any

export {
  /**
   * Adds a computed plain value to the do-notation scope without introducing a new array dimension.
   *
   * **Details**
   *
   * - Unlike {@link bind}, the callback returns a single value (not an array), so no cartesian product occurs.
   * - Useful for derived or intermediate values that depend on previously bound variables.
   *
   * **Example** (Adding a computed value)
   *
   * ```ts
   * import { Array, pipe } from "effect"
   *
   * const result = pipe(
   *   Array.Do,
   *   Array.bind("x", () => [1, 2, 3]),
   *   Array.let("doubled", ({ x }) => x * 2)
   * )
   * console.log(result)
   * // [{ x: 1, doubled: 2 }, { x: 2, doubled: 4 }, { x: 3, doubled: 6 }]
   * ```
   *
   * @see {@link Do} — start a do-notation pipeline
   * @see {@link bind} — introduce an array variable (produces cartesian product)
   *
   * @category do notation
   * @since 3.2.0
   */
  let_ as let
}

const reducer = Reducer.make((a, b) => a.concat(b), [] as any)

/**
 * Returns a `Reducer` that combines `ReadonlyArray` values by concatenation.
 *
 * @see {@link makeReducerConcat} — mutable `Array` variant
 *
 * @category folding
 * @since 4.0.0
 */
export function getReadonlyReducerConcat<A>(): Reducer.Reducer<ReadonlyArray<A>> {
  return reducer
}

/**
 * Returns a `Reducer` that combines `Array` values by concatenation.
 *
 * @see {@link getReadonlyReducerConcat} — readonly variant
 *
 * @category folding
 * @since 4.0.0
 */
export function makeReducerConcat<A>(): Reducer.Reducer<Array<A>> {
  return reducer
}

/**
 * Computes the number of elements in an iterable that satisfy a predicate.
 *
 * **When to use**
 *
 * Use to count how many elements satisfy a predicate when you only need the
 * number of matches instead of the matching elements.
 *
 * **Details**
 *
 * - The predicate receives both the element and its index.
 * - Returns `0` for an empty iterable.
 *
 * **Example** (Counting even numbers)
 *
 * ```ts
 * import { Array } from "effect"
 *
 * const result = Array.countBy([1, 2, 3, 4, 5], (n) => n % 2 === 0)
 * console.log(result) // 2
 * ```
 *
 * @see {@link filter} — when you need the matching elements, not just the count
 *
 * @category folding
 * @since 3.16.0
 */
export const countBy: {
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => number
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): number
} = dual(
  2,
  <A>(
    self: Iterable<A>,
    f: (a: A, i: number) => boolean
  ): number => {
    let count = 0
    const as = fromIterable(self)
    for (let i = 0; i < as.length; i++) {
      const a = as[i]
      if (f(a, i)) {
        count++
      }
    }
    return count
  }
)
