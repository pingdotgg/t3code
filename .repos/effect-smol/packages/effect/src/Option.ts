/**
 * Models a value that may be present or absent.
 *
 * An `Option<A>` is `Some<A>` when a value is available and `None` when it is
 * not. This lets code handle missing values explicitly instead of relying on
 * `null` or `undefined`. The module includes helpers for creating, checking,
 * transforming, combining, and extracting optional values, plus conversions to
 * and from common nullable or result-like shapes. It also includes `Option.gen`
 * for writing small generator-based computations that stop at the first `None`.
 *
 * @since 2.0.0
 */
import * as Combiner from "./Combiner.ts"
import * as Equal from "./Equal.ts"
import * as Equivalence from "./Equivalence.ts"
import type * as Filter from "./Filter.ts"
import type { LazyArg } from "./Function.ts"
import { constNull, constUndefined, dual, identity } from "./Function.ts"
import type { TypeLambda } from "./HKT.ts"
import type { Inspectable } from "./Inspectable.ts"
import * as doNotation from "./internal/doNotation.ts"
import * as option from "./internal/option.ts"
import * as InternalRecord from "./internal/record.ts"
import * as result from "./internal/result.ts"
import type { Order } from "./Order.ts"
import * as order from "./Order.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { Predicate, Refinement } from "./Predicate.ts"
import { isFunction } from "./Predicate.ts"
import * as Reducer from "./Reducer.ts"
import type { Result } from "./Result.ts"
import type { Covariant, NoInfer, NotFunction } from "./Types.ts"
import type * as Unify from "./Unify.ts"
import type * as Gen from "./Utils.ts"

const TypeId = "~effect/data/Option"

/**
 * The `Option` data type represents optional values. An `Option<A>` is either
 * `Some<A>`, containing a value of type `A`, or `None`, representing absence.
 *
 * **When to use**
 *
 * Use to represent initial values that may not yet exist
 * - Returning from partial functions (not defined for all inputs)
 * - Managing optional fields in data structures
 *
 * @see {@link some} for creating a `Some`
 * @see {@link none} for creating a `None`
 * @see {@link match} for pattern matching
 *
 * @category models
 * @since 2.0.0
 */
export type Option<A> = None<A> | Some<A>

/**
 * Represents the absence of a value within an {@link Option}.
 *
 * **When to use**
 *
 * Use as a type guard target when narrowing via {@link isNone}
 *
 * **Details**
 *
 * - `_tag` is always `"None"`
 * - Implements `Pipeable`, `Inspectable`, and structural equality
 *
 * @see {@link isNone} to check if an `Option` is `None`
 * @see {@link none} to construct a `None`
 *
 * @category models
 * @since 2.0.0
 */
export interface None<out A> extends Pipeable, Inspectable {
  readonly _tag: "None"
  readonly _op: "None"
  readonly valueOrUndefined: undefined
  readonly [TypeId]: {
    readonly _A: Covariant<A>
  }
  [Symbol.iterator](): OptionIterator<Option<A>>
  [Unify.typeSymbol]?: unknown
  [Unify.unifySymbol]?: OptionUnify<this>
  [Unify.ignoreSymbol]?: OptionUnifyIgnore
}

/**
 * Iterator protocol used to yield an `Option` inside {@link gen}, returning the
 * contained value type back to the generator.
 *
 * **When to use**
 *
 * Use when defining or typing `[Symbol.iterator]()` for `Option` values so
 * `yield*` can pass the contained value type back into `Option.gen`.
 *
 * @see {@link gen} for writing generator-based `Option` code that consumes this iterator protocol
 *
 * @category generators
 * @since 4.0.0
 */
export interface OptionIterator<T extends Option<any>> {
  next(
    ...args: ReadonlyArray<any>
  ): IteratorResult<T, Option.Value<T>>
}

/**
 * Represents the presence of a value within an {@link Option}.
 *
 * **When to use**
 *
 * Use as a type guard target when narrowing via {@link isSome}
 * - Access the inner value via `.value`
 *
 * **Details**
 *
 * - `_tag` is always `"Some"`
 * - `.value` holds the contained value of type `A`
 * - Implements `Pipeable`, `Inspectable`, and structural equality
 *
 * @see {@link isSome} to check if an `Option` is `Some`
 * @see {@link some} to construct a `Some`
 *
 * @category models
 * @since 2.0.0
 */
export interface Some<out A> extends Pipeable, Inspectable {
  readonly _tag: "Some"
  readonly _op: "Some"
  readonly value: A
  readonly valueOrUndefined: A
  readonly [TypeId]: {
    readonly _A: Covariant<A>
  }
  [Symbol.iterator](): OptionIterator<Option<A>>
  [Unify.typeSymbol]?: unknown
  [Unify.unifySymbol]?: OptionUnify<this>
  [Unify.ignoreSymbol]?: OptionUnifyIgnore
}

/**
 * Type-level unification support for `Option` values.
 *
 * **When to use**
 *
 * Use when extending Effect's type-level unification support for `Option`.
 *
 * **Details**
 *
 * This is used by Effect's `Unify` machinery to preserve the contained value
 * type when generic code returns or combines `Option` values. Users normally
 * do not need to reference this interface directly.
 *
 * @category models
 * @since 2.0.0
 */
export interface OptionUnify<A extends { [Unify.typeSymbol]?: any }> {
  Option?: () => A[Unify.typeSymbol] extends Option<infer A0> | infer _ ? Option<A0> : never
}

/**
 * Namespace containing utility types for `Option`.
 *
 * **When to use**
 *
 * Use to access type-level helpers associated with `Option`.
 *
 * @since 2.0.0
 */
export declare namespace Option {
  /**
   * Extracts the type of the value contained in an `Option`.
   *
   * **When to use**
   *
   * Use to infer the inner value type from an existing `Option` type.
   *
   * **Example** (Extracting the value type)
   *
   * ```ts
   * import type { Option } from "effect"
   *
   * declare const myOption: Option.Option<string>
   *
   * //      ┌─── string
   * //      ▼
   * type MyType = Option.Option.Value<typeof myOption>
   * ```
   *
   * @category Type-level Utils
   * @since 2.0.0
   */
  export type Value<T extends Option<any>> = [T] extends [Option<infer _A>] ? _A : never
}

/**
 * Marker interface used by Effect's `Unify` machinery for `Option` values.
 *
 * **When to use**
 *
 * Use when marking generic code so `Option` unification should be ignored.
 *
 * **Details**
 *
 * This supports type-level unification behavior for `Option`. Users normally
 * do not need to reference this interface directly.
 *
 * @category models
 * @since 2.0.0
 */
export interface OptionUnifyIgnore {}

/**
 * Type lambda interface for higher-kinded type encodings with `Option`.
 *
 * **When to use**
 *
 * Use when defining higher-kinded abstractions that must accept optional-value
 * types as one of their type-lambda inputs.
 *
 * @category type lambdas
 * @since 2.0.0
 */
export interface OptionTypeLambda extends TypeLambda {
  readonly type: Option<this["Target"]>
}

/**
 * Creates an `Option` representing the absence of a value.
 *
 * **When to use**
 *
 * Use to represent a missing or uninitialized value, such as returning "no
 * result" from a function.
 *
 * **Details**
 *
 * - Returns `Option<never>`, which is a subtype of `Option<A>` for any `A`
 * - Always returns the same singleton instance
 *
 * **Example** (Creating an empty Option)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * //      ┌─── Option<never>
 * //      ▼
 * const noValue = Option.none()
 *
 * console.log(noValue)
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link some} for the opposite operation.
 *
 * @category constructors
 * @since 2.0.0
 */
export const none = <A = never>(): Option<A> => option.none

/**
 * Wraps the given value into an `Option` to represent its presence.
 *
 * **When to use**
 *
 * Use to wrap a known present value as `Option`
 * - Returning a successful result from a partial function
 *
 * **Details**
 *
 * - Always returns `Some<A>`
 * - Does not filter `null` or `undefined`; use {@link fromNullishOr} for that
 *
 * **Example** (Wrapping a value)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * //      ┌─── Option<number>
 * //      ▼
 * const value = Option.some(1)
 *
 * console.log(value)
 * // Output: { _id: 'Option', _tag: 'Some', value: 1 }
 * ```
 *
 * @see {@link none} for the opposite operation.
 *
 * @category constructors
 * @since 2.0.0
 */
export const some: <A>(value: A) => Option<A> = option.some

/**
 * Determines whether the given value is an `Option`.
 *
 * **When to use**
 *
 * Use to validate unknown values at runtime boundaries, such as type-narrowing
 * in union types.
 *
 * **Details**
 *
 * - Returns `true` for both `Some` and `None` instances
 * - Acts as a type guard, narrowing the input to `Option<unknown>`
 *
 * **Example** (Checking if a value is an Option)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.isOption(Option.some(1)))
 * // Output: true
 *
 * console.log(Option.isOption(Option.none()))
 * // Output: true
 *
 * console.log(Option.isOption({}))
 * // Output: false
 * ```
 *
 * @see {@link isNone} to check for `None` specifically
 * @see {@link isSome} to check for `Some` specifically
 *
 * @category guards
 * @since 2.0.0
 */
export const isOption: (input: unknown) => input is Option<unknown> = option.isOption

/**
 * Checks whether an `Option` is `None` (absent).
 *
 * **When to use**
 *
 * Use when you need to branch on an absent `Option` before accessing `.value`.
 *
 * **Details**
 *
 * - Acts as a type guard, narrowing to `None<A>`
 *
 * **Example** (Checking for None)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.isNone(Option.some(1)))
 * // Output: false
 *
 * console.log(Option.isNone(Option.none()))
 * // Output: true
 * ```
 *
 * @see {@link isSome} for the opposite check.
 *
 * @category guards
 * @since 2.0.0
 */
export const isNone: <A>(self: Option<A>) => self is None<A> = option.isNone

/**
 * Checks whether an `Option` contains a value (`Some`).
 *
 * **When to use**
 *
 * Use when you need to branch on a present `Option` before accessing `.value`.
 *
 * **Details**
 *
 * - Acts as a type guard, narrowing to `Some<A>`
 *
 * **Example** (Checking for Some)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.isSome(Option.some(1)))
 * // Output: true
 *
 * console.log(Option.isSome(Option.none()))
 * // Output: false
 * ```
 *
 * @see {@link isNone} for the opposite check.
 *
 * @category guards
 * @since 2.0.0
 */
export const isSome: <A>(self: Option<A>) => self is Some<A> = option.isSome

/**
 * Pattern-matches on an `Option`, handling both `None` and `Some` cases.
 *
 * **When to use**
 *
 * Use when you need to handle both `Some` and `None` in one expression and
 * transform an `Option` into a plain value.
 *
 * **Details**
 *
 * - If `None`, calls `onNone` and returns its result
 * - If `Some`, calls `onSome` with the value and returns its result
 * - Supports the `dual` API (data-last and data-first)
 *
 * **Example** (Matching on an Option)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const message = Option.match(Option.some(1), {
 *   onNone: () => "Option is empty",
 *   onSome: (value) => `Option has a value: ${value}`
 * })
 *
 * console.log(message)
 * // Output: "Option has a value: 1"
 * ```
 *
 * @see {@link getOrElse} for unwrapping with a default
 *
 * @category pattern matching
 * @since 2.0.0
 */
export const match: {
  <B, A, C = B>(options: {
    readonly onNone: LazyArg<B>
    readonly onSome: (a: A) => C
  }): (self: Option<A>) => B | C
  <A, B, C = B>(self: Option<A>, options: {
    readonly onNone: LazyArg<B>
    readonly onSome: (a: A) => C
  }): B | C
} = dual(
  2,
  <A, B, C = B>(self: Option<A>, { onNone, onSome }: {
    readonly onNone: LazyArg<B>
    readonly onSome: (a: A) => C
  }): B | C => isNone(self) ? onNone() : onSome(self.value)
)

/**
 * Converts an `Option`-returning function into a type guard (refinement).
 *
 * **When to use**
 *
 * Use when you need to turn an `Option`-returning parser into a type-narrowing
 * predicate, such as for `Array.prototype.filter`.
 *
 * **Details**
 *
 * - Returns `true` when the original function returns `Some`
 * - Returns `false` when the original function returns `None`
 * - Narrows the input type to `B` on success
 *
 * **Example** (Converting a parser to a type guard)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * type MyData = string | number
 *
 * const parseString = (data: MyData): Option.Option<string> =>
 *   typeof data === "string" ? Option.some(data) : Option.none()
 *
 * //      ┌─── (a: MyData) => a is string
 * //      ▼
 * const isString = Option.toRefinement(parseString)
 *
 * console.log(isString("a"))
 * // Output: true
 *
 * console.log(isString(1))
 * // Output: false
 * ```
 *
 * @see {@link liftPredicate} for the reverse direction
 *
 * @category converting
 * @since 2.0.0
 */
export const toRefinement = <A, B extends A>(f: (a: A) => Option<B>): (a: A) => a is B => (a: A): a is B => isSome(f(a))

/**
 * Wraps the first element of an `Iterable` in a `Some`, or returns `None` if
 * the iterable is empty.
 *
 * **When to use**
 *
 * Use when you need to safely extract the head of a collection, including
 * generators or lazy iterables.
 *
 * **Details**
 *
 * - Only consumes the first element; does not iterate the rest
 * - Returns `None` for empty iterables
 *
 * **Example** (Getting the first element)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.fromIterable([1, 2, 3]))
 * // Output: { _id: 'Option', _tag: 'Some', value: 1 }
 *
 * console.log(Option.fromIterable([]))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link toArray} for the inverse direction
 *
 * @category constructors
 * @since 2.0.0
 */
export const fromIterable = <A>(collection: Iterable<A>): Option<A> => {
  for (const a of collection) {
    return some(a)
  }
  return none()
}

/**
 * Converts a `Result` into an `Option`, keeping only the success value.
 *
 * **When to use**
 *
 * Use when you need to discard a `Result` failure and keep only the success
 * value as an `Option`.
 *
 * **Details**
 *
 * - `Success` becomes `Some` with the success value
 * - `Failure` becomes `None` and the failure value is discarded
 *
 * **Example** (Extracting the success side)
 *
 * ```ts
 * import { Option, Result } from "effect"
 *
 * console.log(Option.getSuccess(Result.succeed("ok")))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'ok' }
 *
 * console.log(Option.getSuccess(Result.fail("err")))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link getFailure} for the opposite operation.
 *
 * @category converting
 * @since 4.0.0
 */
export const getSuccess: <A, E>(self: Result<A, E>) => Option<A> = result.getSuccess

/**
 * Converts a `Result` into an `Option`, keeping only the failure value.
 *
 * **When to use**
 *
 * Use when you need to discard a `Result` success and keep only the failure
 * value as an `Option`.
 *
 * **Details**
 *
 * - `Failure` becomes `Some` with the failure value
 * - `Success` becomes `None` and the success value is discarded
 *
 * **Example** (Extracting the failure side)
 *
 * ```ts
 * import { Option, Result } from "effect"
 *
 * console.log(Option.getFailure(Result.succeed("ok")))
 * // Output: { _id: 'Option', _tag: 'None' }
 *
 * console.log(Option.getFailure(Result.fail("err")))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'err' }
 * ```
 *
 * @see {@link getSuccess} for the opposite operation.
 *
 * @category converting
 * @since 4.0.0
 */
export const getFailure: <A, E>(self: Result<A, E>) => Option<E> = result.getFailure

/**
 * Extracts the value from a `Some`, or evaluates a fallback thunk on `None`.
 *
 * **When to use**
 *
 * Use when providing a default value for an absent `Option`
 * - Unwrapping with lazy evaluation of the fallback
 *
 * **Details**
 *
 * - `Some` → returns the inner value
 * - `None` → calls `onNone()` and returns its result
 * - `onNone` is only called when needed (lazy)
 *
 * **Example** (Unwrapping with a fallback)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.some(1).pipe(Option.getOrElse(() => 0)))
 * // Output: 1
 *
 * console.log(Option.none().pipe(Option.getOrElse(() => 0)))
 * // Output: 0
 * ```
 *
 * @see {@link getOrNull} to fall back to `null`
 * @see {@link getOrUndefined} to fall back to `undefined`
 * @see {@link getOrThrow} to throw on `None`
 *
 * @category getters
 * @since 2.0.0
 */
export const getOrElse: {
  <B>(onNone: LazyArg<B>): <A>(self: Option<A>) => B | A
  <A, B>(self: Option<A>, onNone: LazyArg<B>): A | B
} = dual(
  2,
  <A, B>(self: Option<A>, onNone: LazyArg<B>): A | B => isNone(self) ? onNone() : self.value
)

/**
 * Returns the fallback `Option` if `self` is `None`; otherwise returns `self`.
 *
 * **When to use**
 *
 * Use when you need a lazy fallback `Option`, such as when building priority
 * chains of optional values.
 *
 * **Details**
 *
 * - `Some` → returns `self` unchanged
 * - `None` → evaluates and returns `that()`
 * - `that` is lazily evaluated
 *
 * **Example** (Providing a fallback Option)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.none().pipe(Option.orElse(() => Option.some("b"))))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'b' }
 *
 * console.log(Option.some("a").pipe(Option.orElse(() => Option.some("b"))))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'a' }
 * ```
 *
 * @see {@link orElseSome} to wrap the fallback value in `Some` automatically
 * @see {@link firstSomeOf} to pick the first `Some` from a collection
 *
 * @category error handling
 * @since 2.0.0
 */
export const orElse: {
  <B>(that: LazyArg<Option<B>>): <A>(self: Option<A>) => Option<B | A>
  <A, B>(self: Option<A>, that: LazyArg<Option<B>>): Option<A | B>
} = dual(
  2,
  <A, B>(self: Option<A>, that: LazyArg<Option<B>>): Option<A | B> => isNone(self) ? that() : self
)

/**
 * Returns `Some` of the fallback value if `self` is `None`; otherwise returns
 * `self`.
 *
 * **When to use**
 *
 * Use when providing a default plain value (not an `Option`) as fallback
 *
 * **Details**
 *
 * - `Some` → returns `self` unchanged
 * - `None` → calls `onNone()`, wraps result in `Some`, and returns it
 *
 * **Example** (Providing a fallback value)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.none().pipe(Option.orElseSome(() => "b")))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'b' }
 *
 * console.log(Option.some("a").pipe(Option.orElseSome(() => "b")))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'a' }
 * ```
 *
 * @see {@link orElse} when the fallback is itself an `Option`
 *
 * @category error handling
 * @since 2.0.0
 */
export const orElseSome: {
  <B>(onNone: LazyArg<B>): <A>(self: Option<A>) => Option<B | A>
  <A, B>(self: Option<A>, onNone: LazyArg<B>): Option<A | B>
} = dual(
  2,
  <A, B>(self: Option<A>, onNone: LazyArg<B>): Option<A | B> => isNone(self) ? some(onNone()) : self
)

/**
 * Returns the first available value and marks whether it came from the fallback.
 *
 * **When to use**
 *
 * Use when you need to know whether a present value came from the primary or
 * fallback `Option`.
 *
 * **Details**
 *
 * - `self` is `Some` → `Some(Result.fail(value))` (value from primary)
 * - `self` is `None`, `that()` is `Some` → `Some(Result.succeed(value))` (value from fallback)
 * - Both `None` → `None`
 *
 * **Example** (Tracking value source)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.orElseResult(Option.some("primary"), () => Option.some("fallback")))
 * // Output: { _id: 'Option', _tag: 'Some', value: { _tag: 'Failure', value: 'primary' } }
 *
 * console.log(Option.orElseResult(Option.none(), () => Option.some("fallback")))
 * // Output: { _id: 'Option', _tag: 'Some', value: { _tag: 'Success', value: 'fallback' } }
 * ```
 *
 * @see {@link orElse} for the simpler variant without source tracking
 *
 * @category error handling
 * @since 4.0.0
 */
export const orElseResult: {
  <B>(that: LazyArg<Option<B>>): <A>(self: Option<A>) => Option<Result<B, A>>
  <A, B>(self: Option<A>, that: LazyArg<Option<B>>): Option<Result<B, A>>
} = dual(
  2,
  <A, B>(self: Option<A>, that: LazyArg<Option<B>>): Option<Result<B, A>> =>
    isNone(self) ? map(that(), result.succeed) : map(self, result.fail)
)

/**
 * Returns the first `Some` found in an iterable of `Option`s, or `None` if
 * all are `None`.
 *
 * **When to use**
 *
 * Use when you need the first available `Some` value from a priority list.
 *
 * **Details**
 *
 * - Short-circuits on the first `Some`
 * - Returns `None` only when every element is `None`
 *
 * **Example** (Finding the first Some)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.firstSomeOf([
 *   Option.none(),
 *   Option.some(1),
 *   Option.some(2)
 * ]))
 * // Output: { _id: 'Option', _tag: 'Some', value: 1 }
 * ```
 *
 * @see {@link orElse} for a two-option fallback
 *
 * @category error handling
 * @since 2.0.0
 */
export const firstSomeOf = <T, C extends Iterable<Option<T>> = Iterable<Option<T>>>(
  collection: C
): [C] extends [Iterable<Option<infer A>>] ? Option<A> : never => {
  let out: Option<unknown> = none()
  for (out of collection) {
    if (isSome(out)) {
      return out as any
    }
  }
  return out as any
}

/**
 * Converts a nullable value (`null` or `undefined`) into an `Option`.
 *
 * **When to use**
 *
 * Use when you need JavaScript nullish values to become absence at an API
 * boundary while all other values, including falsy ones, remain present.
 *
 * **Details**
 *
 * - `null` or `undefined` → `None`
 * - Any other value → `Some` (typed as `NonNullable<A>`)
 *
 * **Example** (Converting nullable values to an Option)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.fromNullishOr(undefined))
 * // Output: { _id: 'Option', _tag: 'None' }
 *
 * console.log(Option.fromNullishOr(null))
 * // Output: { _id: 'Option', _tag: 'None' }
 *
 * console.log(Option.fromNullishOr(1))
 * // Output: { _id: 'Option', _tag: 'Some', value: 1 }
 * ```
 *
 * @see {@link fromNullOr} to only treat `null` as absent
 * @see {@link fromUndefinedOr} to only treat `undefined` as absent
 * @see {@link liftNullishOr} to lift a nullable-returning function
 *
 * @category converting
 * @since 4.0.0
 */
export const fromNullishOr = <A>(
  a: A
): Option<NonNullable<A>> => (a == null ? none() : some(a as NonNullable<A>))

/**
 * Converts a possibly `undefined` value into an `Option`, leaving `null`
 * as a valid `Some`.
 *
 * **When to use**
 *
 * Use when you want to treat only `undefined` as absent while preserving `null`
 * as a meaningful value.
 *
 * **Details**
 *
 * - `undefined` → `None`
 * - Any other value (including `null`) → `Some`
 *
 * **Example** (Converting possibly undefined values to an Option)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.fromUndefinedOr(undefined))
 * // Output: { _id: 'Option', _tag: 'None' }
 *
 * console.log(Option.fromUndefinedOr(null))
 * // Output: { _id: 'Option', _tag: 'Some', value: null }
 *
 * console.log(Option.fromUndefinedOr(42))
 * // Output: { _id: 'Option', _tag: 'Some', value: 42 }
 * ```
 *
 * @see {@link fromNullishOr} to treat both `null` and `undefined` as absent
 * @see {@link fromNullOr} to only treat `null` as absent
 *
 * @category converting
 * @since 4.0.0
 */
export const fromUndefinedOr = <A>(
  a: A
): Option<Exclude<A, undefined>> => (a === undefined ? none() : some(a as Exclude<A, undefined>))

/**
 * Converts a possibly `null` value into an `Option`, leaving `undefined`
 * as a valid `Some`.
 *
 * **When to use**
 *
 * Use when you want to treat only `null` as absent while preserving
 * `undefined` as a meaningful value.
 *
 * **Details**
 *
 * - `null` → `None`
 * - Any other value (including `undefined`) → `Some`
 *
 * **Example** (Converting possibly null values to an Option)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.fromNullOr(null))
 * // Output: { _id: 'Option', _tag: 'None' }
 *
 * console.log(Option.fromNullOr(undefined))
 * // Output: { _id: 'Option', _tag: 'Some', value: undefined }
 *
 * console.log(Option.fromNullOr(42))
 * // Output: { _id: 'Option', _tag: 'Some', value: 42 }
 * ```
 *
 * @see {@link fromNullishOr} to treat both `null` and `undefined` as absent
 * @see {@link fromUndefinedOr} to only treat `undefined` as absent
 *
 * @category converting
 * @since 4.0.0
 */
export const fromNullOr = <A>(
  a: A
): Option<Exclude<A, null>> => (a === null ? none() : some(a as Exclude<A, null>))

/**
 * Lifts a function that may return `null` or `undefined` into one that returns
 * an `Option`.
 *
 * **When to use**
 *
 * Use to wrap existing nullable-returning functions for use in `Option` pipelines
 *
 * **Details**
 *
 * - Calls the original function with the given arguments
 * - Wraps the result via {@link fromNullishOr}
 *
 * **Example** (Lifting a parser)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const parse = (s: string): number | undefined => {
 *   const n = parseFloat(s)
 *   return isNaN(n) ? undefined : n
 * }
 *
 * const parseOption = Option.liftNullishOr(parse)
 *
 * console.log(parseOption("1"))
 * // Output: { _id: 'Option', _tag: 'Some', value: 1 }
 *
 * console.log(parseOption("not a number"))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link fromNullishOr} for converting a single value
 * @see {@link liftThrowable} for functions that throw instead
 *
 * @category converting
 * @since 4.0.0
 */
export const liftNullishOr = <A extends ReadonlyArray<unknown>, B>(
  f: (...a: A) => B
): (...a: A) => Option<NonNullable<B>> =>
(...a) => fromNullishOr(f(...a))

/**
 * Extracts the value from a `Some`, or returns `null` for `None`.
 *
 * **When to use**
 *
 * Use when you need to pass absent `Option` values to APIs that expect `null`.
 *
 * **Details**
 *
 * - `Some` → the inner value
 * - `None` → `null`
 *
 * **Example** (Unwrapping to null)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.getOrNull(Option.some(1)))
 * // Output: 1
 *
 * console.log(Option.getOrNull(Option.none()))
 * // Output: null
 * ```
 *
 * @see {@link getOrUndefined} to return `undefined` instead
 * @see {@link getOrElse} for a custom fallback
 *
 * @category getters
 * @since 2.0.0
 */
export const getOrNull: <A>(self: Option<A>) => A | null = getOrElse(constNull)

/**
 * Extracts the value from a `Some`, or returns `undefined` for `None`.
 *
 * **When to use**
 *
 * Use when you need to pass absent `Option` values to APIs that expect
 * `undefined`.
 *
 * **Details**
 *
 * - `Some` → the inner value
 * - `None` → `undefined`
 *
 * **Example** (Unwrapping to undefined)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.getOrUndefined(Option.some(1)))
 * // Output: 1
 *
 * console.log(Option.getOrUndefined(Option.none()))
 * // Output: undefined
 * ```
 *
 * @see {@link getOrNull} to return `null` instead
 * @see {@link getOrElse} for a custom fallback
 *
 * @category getters
 * @since 2.0.0
 */
export const getOrUndefined: <A>(self: Option<A>) => A | undefined = getOrElse(constUndefined)

/**
 * Lifts a function that may throw into one that returns an `Option`.
 *
 * **When to use**
 *
 * Use to wrap exception-throwing APIs (e.g. `JSON.parse`) for safe usage
 *
 * **Details**
 *
 * - If the function returns normally → `Some` with the result
 * - If the function throws → `None` (exception is swallowed)
 *
 * **Example** (Lifting JSON.parse)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const parse = Option.liftThrowable(JSON.parse)
 *
 * console.log(parse("1"))
 * // Output: { _id: 'Option', _tag: 'Some', value: 1 }
 *
 * console.log(parse(""))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link liftNullishOr} for nullable-returning functions
 *
 * @category converting
 * @since 2.0.0
 */
export const liftThrowable = <A extends ReadonlyArray<unknown>, B>(
  f: (...a: A) => B
): (...a: A) => Option<B> =>
(...a) => {
  try {
    return some(f(...a))
  } catch {
    return none()
  }
}

/**
 * Extracts the value from a `Some`, or throws a custom error for `None`.
 *
 * **When to use**
 *
 * Use when you need fail-fast unwrapping of an `Option` for unexpected absence
 * and want to provide a descriptive debugging error.
 *
 * **Details**
 *
 * - `Some` → returns the inner value
 * - `None` → throws the value returned by `onNone()`
 *
 * **Example** (Throwing a custom error)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.getOrThrowWith(Option.some(1), () => new Error("missing")))
 * // Output: 1
 *
 * Option.getOrThrowWith(Option.none(), () => new Error("missing"))
 * // throws Error: missing
 * ```
 *
 * @see {@link getOrThrow} for a version with a default error
 * @see {@link getOrElse} for a non-throwing alternative
 *
 * @category converting
 * @since 2.0.0
 */
export const getOrThrowWith: {
  (onNone: () => unknown): <A>(self: Option<A>) => A
  <A>(self: Option<A>, onNone: () => unknown): A
} = dual(2, <A>(self: Option<A>, onNone: () => unknown): A => {
  if (isSome(self)) {
    return self.value
  }
  throw onNone()
})

/**
 * Extracts the value from a `Some`, or throws a default `Error` for `None`.
 *
 * **When to use**
 *
 * Use when you need quick fail-fast unwrapping of an `Option` and a generic
 * error is acceptable.
 *
 * **Details**
 *
 * - `Some` → returns the inner value
 * - `None` → throws `new Error("getOrThrow called on a None")`
 *
 * **Example** (Throwing a default error)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.getOrThrow(Option.some(1)))
 * // Output: 1
 *
 * Option.getOrThrow(Option.none())
 * // throws Error: getOrThrow called on a None
 * ```
 *
 * @see {@link getOrThrowWith} for a custom error
 * @see {@link getOrElse} for a non-throwing alternative
 *
 * @category converting
 * @since 2.0.0
 */
export const getOrThrow: <A>(self: Option<A>) => A = getOrThrowWith(() => new Error("getOrThrow called on a None"))

/**
 * Transforms the value inside a `Some` using the provided function, leaving
 * `None` unchanged.
 *
 * **When to use**
 *
 * Use to apply a pure transformation to an `Option`'s present value, especially
 * when chaining transformations in a pipeline.
 *
 * **Details**
 *
 * - `Some` → applies `f` and wraps the result in a new `Some`
 * - `None` → returns `None` unchanged
 *
 * **Example** (Mapping over an Option)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.map(Option.some(2), (n) => n * 2))
 * // Output: { _id: 'Option', _tag: 'Some', value: 4 }
 *
 * console.log(Option.map(Option.none(), (n: number) => n * 2))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link flatMap} when `f` returns an `Option`
 * @see {@link as} to replace the value with a constant
 *
 * @category mapping
 * @since 2.0.0
 */
export const map: {
  <A, B>(f: (a: A) => B): (self: Option<A>) => Option<B>
  <A, B>(self: Option<A>, f: (a: A) => B): Option<B>
} = dual(
  2,
  <A, B>(self: Option<A>, f: (a: A) => B): Option<B> => isNone(self) ? none() : some(f(self.value))
)

/**
 * Replaces the value inside a `Some` with a constant, leaving `None` unchanged.
 *
 * **When to use**
 *
 * Use when you need to replace a present `Option` value while preserving
 * whether it was `Some` or `None`.
 *
 * **Example** (Replacing a value)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.as(Option.some(42), "new value"))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'new value' }
 *
 * console.log(Option.as(Option.none(), "new value"))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link asVoid} to replace with `undefined`
 * @see {@link map} for a general transformation
 *
 * @category mapping
 * @since 2.0.0
 */
export const as: {
  <B>(b: B): <X>(self: Option<X>) => Option<B>
  <X, B>(self: Option<X>, b: B): Option<B>
} = dual(2, <X, B>(self: Option<X>, b: B): Option<B> => map(self, () => b))

/**
 * Replaces the value inside a `Some` with `void` (`undefined`), leaving `None`
 * unchanged.
 *
 * **When to use**
 *
 * Use when you need to discard a present `Option` value while preserving
 * whether it was `Some` or `None`.
 *
 * **Example** (Voiding the value)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.asVoid(Option.some(42)))
 * // Output: { _id: 'Option', _tag: 'Some', value: undefined }
 *
 * console.log(Option.asVoid(Option.none()))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link as} to replace with a specific constant
 *
 * @category mapping
 * @since 2.0.0
 */
export const asVoid: <_>(self: Option<_>) => Option<void> = as(undefined)

const void_: Option<void> = some(undefined)
export {
  /**
   * Provides a pre-built `Some(undefined)` constant.
   *
   * **When to use**
   *
   * Use to return a "success with no meaningful value" from an `Option`-returning function
   *
   * **Example** (Referencing Option.void)
   *
   * ```ts
   * import { Option } from "effect"
   *
   * console.log(Option.void)
   * // Output: { _id: 'Option', _tag: 'Some', value: undefined }
   * ```
   *
   * @see {@link asVoid} to convert an existing `Option` to `Option<void>`
   *
   * @category constructors
   * @since 2.0.0
   */
  void_ as void
}

/**
 * Applies a function that returns an `Option` to the value of a `Some`,
 * flattening the result. Returns `None` if the input is `None`.
 *
 * **When to use**
 *
 * Use when you need to chain dependent `Option` computations where each step
 * may return `None`.
 *
 * **Details**
 *
 * - `Some` → applies `f` to the value and returns its `Option` result
 * - `None` → returns `None` without calling `f`
 * - Equivalent to `map` followed by {@link flatten}
 *
 * **Example** (Chaining optional lookups)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * interface User {
 *   readonly name: string
 *   readonly address: Option.Option<{ readonly street: Option.Option<string> }>
 * }
 *
 * const user: User = {
 *   name: "John",
 *   address: Option.some({ street: Option.some("123 Main St") })
 * }
 *
 * const street = user.address.pipe(
 *   Option.flatMap((addr) => addr.street)
 * )
 *
 * console.log(street)
 * // Output: { _id: 'Option', _tag: 'Some', value: '123 Main St' }
 * ```
 *
 * @see {@link map} when `f` returns a plain value
 * @see {@link andThen} for a more flexible variant
 * @see {@link flatten} to unwrap a nested `Option<Option<A>>`
 *
 * @category sequencing
 * @since 2.0.0
 */
export const flatMap: {
  <A, B>(f: (a: A) => Option<B>): (self: Option<A>) => Option<B>
  <A, B>(self: Option<A>, f: (a: A) => Option<B>): Option<B>
} = dual(
  2,
  <A, B>(self: Option<A>, f: (a: A) => Option<B>): Option<B> => isNone(self) ? none() : f(self.value)
)

/**
 * Chains a second computation onto an `Option`. The second value can be a
 * plain value, an `Option`, or a function returning either.
 *
 * **When to use**
 *
 * Use when you need to chain an `Option` with a next step that may be another
 * `Option`, a plain value, or a function.
 *
 * **Details**
 *
 * - If `self` is `None`, returns `None` immediately
 * - If `f` is a function, calls it with the `Some` value
 * - If `f` returns an `Option`, returns it as-is; if a plain value, wraps in `Some`
 * - If `f` is not a function, uses it directly (same wrapping rules)
 *
 * **Example** (Chaining with andThen)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * // Chain with a function returning Option
 * console.log(Option.andThen(Option.some(5), (x) => Option.some(x * 2)))
 * // Output: { _id: 'Option', _tag: 'Some', value: 10 }
 *
 * // Chain with a static value
 * console.log(Option.andThen(Option.some(5), "hello"))
 * // Output: { _id: 'Option', _tag: 'Some', value: "hello" }
 *
 * // Chain with None - skips
 * console.log(Option.andThen(Option.none(), (x) => Option.some(x * 2)))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link flatMap} for the standard monadic bind
 * @see {@link map} when you always return a plain value
 *
 * @category sequencing
 * @since 2.0.0
 */
export const andThen: {
  <A, B>(f: (a: A) => Option<B>): (self: Option<A>) => Option<B>
  <B>(f: Option<B>): <A>(self: Option<A>) => Option<B>
  <A, B>(f: (a: A) => B): (self: Option<A>) => Option<B>
  <B>(f: NotFunction<B>): <A>(self: Option<A>) => Option<B>
  <A, B>(self: Option<A>, f: (a: A) => Option<B>): Option<B>
  <A, B>(self: Option<A>, f: Option<B>): Option<B>
  <A, B>(self: Option<A>, f: (a: A) => B): Option<B>
  <A, B>(self: Option<A>, f: NotFunction<B>): Option<B>
} = dual(
  2,
  <A, B>(self: Option<A>, f: (a: A) => Option<B> | Option<B>): Option<B> =>
    flatMap(self, (a) => {
      const b = isFunction(f) ? f(a) : f
      return isOption(b) ? b : some(b)
    })
)

/**
 * Combines {@link flatMap} with {@link fromNullishOr}: applies a function that
 * may return `null`/`undefined` to the value of a `Some`.
 *
 * **When to use**
 *
 * Use when you need to chain optional computations that use `null` or
 * `undefined` instead of `Option`, such as nested property access.
 *
 * **Details**
 *
 * - `None` → `None`
 * - `Some` → applies `f`, then wraps via {@link fromNullishOr}
 *
 * **Example** (Navigating optional properties)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * interface Employee {
 *   company?: { address?: { street?: { name?: string } } }
 * }
 *
 * const emp: Employee = {
 *   company: { address: { street: { name: "high street" } } }
 * }
 *
 * console.log(
 *   Option.some(emp).pipe(
 *     Option.flatMapNullishOr((e) => e.company?.address?.street?.name)
 *   )
 * )
 * // Output: { _id: 'Option', _tag: 'Some', value: 'high street' }
 * ```
 *
 * @see {@link flatMap} when the function already returns `Option`
 * @see {@link fromNullishOr} for single-value conversion
 *
 * @category sequencing
 * @since 4.0.0
 */
export const flatMapNullishOr: {
  <A, B>(f: (a: A) => B): (self: Option<A>) => Option<NonNullable<B>>
  <A, B>(self: Option<A>, f: (a: A) => B): Option<NonNullable<B>>
} = dual(
  2,
  <A, B>(self: Option<A>, f: (a: A) => B): Option<NonNullable<B>> =>
    isNone(self) ? none() : fromNullishOr(f(self.value))
)

/**
 * Flattens a nested `Option<Option<A>>` into `Option<A>`.
 *
 * **When to use**
 *
 * Use when you need to remove one layer of nested `Option`.
 *
 * **Details**
 *
 * - `Some(Some(value))` → `Some(value)`
 * - `Some(None)` → `None`
 * - `None` → `None`
 *
 * **Example** (Flattening nested Options)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.flatten(Option.some(Option.some("value"))))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'value' }
 *
 * console.log(Option.flatten(Option.some(Option.none())))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link flatMap} which is `map` + `flatten`
 *
 * @category sequencing
 * @since 2.0.0
 */
export const flatten: <A>(self: Option<Option<A>>) => Option<A> = flatMap(identity)

/**
 * Sequences two `Option`s, keeping the value from the second if both are `Some`.
 *
 * **When to use**
 *
 * Use when you need two `Option` values to both be `Some`, then keep only the
 * second value.
 *
 * **Details**
 *
 * - Both `Some` → returns `that`
 * - Either `None` → returns `None`
 *
 * **Example** (Keeping the second value)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.zipRight(Option.some(1), Option.some("hello")))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'hello' }
 *
 * console.log(Option.zipRight(Option.none(), Option.some("hello")))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link zipLeft} to keep the first value instead
 * @see {@link zipWith} to combine both values
 *
 * @category zipping
 * @since 2.0.0
 */
export const zipRight: {
  <B>(that: Option<B>): <_>(self: Option<_>) => Option<B>
  <X, B>(self: Option<X>, that: Option<B>): Option<B>
} = dual(2, <X, B>(self: Option<X>, that: Option<B>): Option<B> => flatMap(self, () => that))

/**
 * Sequences two `Option`s, keeping the value from the first if both are `Some`.
 *
 * **When to use**
 *
 * Use when you need two `Option` values to both be `Some`, then keep only the
 * first value.
 *
 * **Details**
 *
 * - Both `Some` → returns `self`
 * - Either `None` → returns `None`
 *
 * **Example** (Keeping the first value)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.zipLeft(Option.some("hello"), Option.some(1)))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'hello' }
 *
 * console.log(Option.zipLeft(Option.some("hello"), Option.none()))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link zipRight} to keep the second value instead
 * @see {@link zipWith} to combine both values
 *
 * @category zipping
 * @since 2.0.0
 */
export const zipLeft: {
  <_>(that: Option<_>): <A>(self: Option<A>) => Option<A>
  <A, X>(self: Option<A>, that: Option<X>): Option<A>
} = dual(2, <A, X>(self: Option<A>, that: Option<X>): Option<A> => tap(self, () => that))

/**
 * Composes two `Option`-returning functions into a single function that chains
 * them together.
 *
 * **When to use**
 *
 * Use when you need to compose two functions that each return an `Option`, so
 * `None` short-circuits without calling the next function.
 *
 * **Details**
 *
 * - Calls `afb(a)`, then if `Some`, calls `bfc` with its value
 * - Short-circuits to `None` if either function returns `None`
 *
 * **Example** (Composing parsers)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const parse = (s: string): Option.Option<number> =>
 *   isNaN(Number(s)) ? Option.none() : Option.some(Number(s))
 *
 * const double = (n: number): Option.Option<number> =>
 *   n > 0 ? Option.some(n * 2) : Option.none()
 *
 * const parseAndDouble = Option.composeK(parse, double)
 *
 * console.log(parseAndDouble("42"))
 * // Output: { _id: 'Option', _tag: 'Some', value: 84 }
 *
 * console.log(parseAndDouble("not a number"))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link flatMap} for single-step chaining
 *
 * @category sequencing
 * @since 2.0.0
 */
export const composeK: {
  <B, C>(bfc: (b: B) => Option<C>): <A>(afb: (a: A) => Option<B>) => (a: A) => Option<C>
  <A, B, C>(afb: (a: A) => Option<B>, bfc: (b: B) => Option<C>): (a: A) => Option<C>
} = dual(2, <A, B, C>(afb: (a: A) => Option<B>, bfc: (b: B) => Option<C>) => (a: A): Option<C> => flatMap(afb(a), bfc))

/**
 * Runs a side-effecting `Option`-returning function on the value of a `Some`,
 * returning the original `Option` if the function returns `Some`, or `None`
 * if it returns `None`.
 *
 * **When to use**
 *
 * Use to validate an `Option`'s present value without transforming it, such as
 * adding a side-condition check in a pipeline.
 *
 * **Details**
 *
 * - `None` → `None`
 * - `Some` → calls `f(value)`; if result is `Some`, returns original `self`; if `None`, returns `None`
 *
 * **Example** (Validating without transforming)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const getInteger = (n: number) =>
 *   Number.isInteger(n) ? Option.some(n) : Option.none()
 *
 * console.log(Option.tap(Option.some(1), getInteger))
 * // Output: { _id: 'Option', _tag: 'Some', value: 1 }
 *
 * console.log(Option.tap(Option.some(1.14), getInteger))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link flatMap} when you want to transform the value
 * @see {@link filter} for predicate-based filtering
 *
 * @category sequencing
 * @since 2.0.0
 */
export const tap: {
  <A, X>(f: (a: A) => Option<X>): (self: Option<A>) => Option<A>
  <A, X>(self: Option<A>, f: (a: A) => Option<X>): Option<A>
} = dual(2, <A, X>(self: Option<A>, f: (a: A) => Option<X>): Option<A> => flatMap(self, (a) => map(f(a), () => a)))

/**
 * Combines two `Option`s into a `Some` containing a tuple `[A, B]` if both
 * are `Some`.
 *
 * **When to use**
 *
 * Use when you need to require two `Option` values to both be `Some` and keep
 * both values as a tuple.
 *
 * **Details**
 *
 * - Both `Some` → `Some([a, b])`
 * - Either `None` → `None`
 *
 * **Example** (Pairing two Options)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.product(Option.some("hello"), Option.some(42)))
 * // Output: { _id: 'Option', _tag: 'Some', value: ['hello', 42] }
 *
 * console.log(Option.product(Option.none(), Option.some(42)))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link zipWith} to combine with a function instead of a tuple
 * @see {@link all} to combine many `Option`s
 *
 * @category combining
 * @since 2.0.0
 */
export const product = <A, B>(self: Option<A>, that: Option<B>): Option<[A, B]> =>
  isSome(self) && isSome(that) ? some([self.value, that.value]) : none()

/**
 * Combines a primary `Option` with an iterable of `Option`s into a tuple if
 * all are `Some`.
 *
 * **When to use**
 *
 * Use when you need several `Option` values of the same type to all be `Some`
 * and return them as a non-empty tuple.
 *
 * **Details**
 *
 * - All `Some` → `Some([self.value, ...rest])`
 * - Any `None` → `None`
 *
 * **Example** (Combining many Options)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const first = Option.some(1)
 * const rest = [Option.some(2), Option.some(3)]
 *
 * console.log(Option.productMany(first, rest))
 * // Output: { _id: 'Option', _tag: 'Some', value: [1, 2, 3] }
 *
 * console.log(Option.productMany(first, [Option.some(2), Option.none()]))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link product} for combining exactly two
 * @see {@link all} for tuples, structs, and iterables
 *
 * @category combining
 * @since 2.0.0
 */
export const productMany = <A>(
  self: Option<A>,
  collection: Iterable<Option<A>>
): Option<[A, ...Array<A>]> => {
  if (isNone(self)) {
    return none()
  }
  const out: [A, ...Array<A>] = [self.value]
  for (const o of collection) {
    if (isNone(o)) {
      return none()
    }
    out.push(o.value)
  }
  return some(out)
}

/**
 * Combines a structure of `Option`s (tuple, struct, or iterable) into a single
 * `Option` containing the unwrapped structure.
 *
 * **When to use**
 *
 * Use when you need to combine multiple `Option` values into one while
 * preserving the input shape, with any `None` making the result `None`.
 *
 * **Details**
 *
 * - Tuple input → `Option` of a tuple with the same length
 * - Struct input → `Option` of a struct with the same keys
 * - Iterable input → `Option` of an `Array`
 * - Any `None` in the input → entire result is `None`
 *
 * **Example** (Combining a tuple and a struct)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const maybeName: Option.Option<string> = Option.some("John")
 * const maybeAge: Option.Option<number> = Option.some(25)
 *
 * //      ┌─── Option<[string, number]>
 * //      ▼
 * const tuple = Option.all([maybeName, maybeAge])
 * console.log(tuple)
 * // Output:
 * // { _id: 'Option', _tag: 'Some', value: [ 'John', 25 ] }
 *
 * //      ┌─── Option<{ name: string; age: number; }>
 * //      ▼
 * const struct = Option.all({ name: maybeName, age: maybeAge })
 * console.log(struct)
 * // Output:
 * // { _id: 'Option', _tag: 'Some', value: { name: 'John', age: 25 } }
 * ```
 *
 * @see {@link product} for combining exactly two
 * @see {@link productMany} for a homogeneous collection
 *
 * @category combining
 * @since 2.0.0
 */
// @ts-expect-error
export const all: <const I extends Iterable<Option<any>> | Record<string, Option<any>>>(
  input: I
) => [I] extends [ReadonlyArray<Option<any>>] ? Option<
    { -readonly [K in keyof I]: [I[K]] extends [Option<infer A>] ? A : never }
  >
  : [I] extends [Iterable<Option<infer A>>] ? Option<Array<A>>
  : Option<{ -readonly [K in keyof I]: [I[K]] extends [Option<infer A>] ? A : never }> = (
    input: Iterable<Option<any>> | Record<string, Option<any>>
  ): Option<any> => {
    if (Symbol.iterator in input) {
      const out: Array<Option<any>> = []
      for (const o of (input as Iterable<Option<any>>)) {
        if (isNone(o)) {
          return none()
        }
        out.push(o.value)
      }
      return some(out)
    }

    const out: Record<string, any> = {}
    for (const key of Object.keys(input)) {
      const o = input[key]
      if (isNone(o)) {
        return none()
      }
      InternalRecord.assignProperty(out, key, o.value)
    }
    return some(out)
  }

/**
 * Combines two `Option`s using a provided function.
 *
 * **When to use**
 *
 * Use when you need to combine two present `Option` values into a computed
 * result.
 *
 * **Details**
 *
 * - Both `Some` → applies `f(a, b)` and wraps in `Some`
 * - Either `None` → `None`
 *
 * **Example** (Combining with a function)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const person = Option.zipWith(
 *   Option.some("John"),
 *   Option.some(25),
 *   (name, age) => ({ name: name.toUpperCase(), age })
 * )
 *
 * console.log(person)
 * // Output:
 * // { _id: 'Option', _tag: 'Some', value: { name: 'JOHN', age: 25 } }
 * ```
 *
 * @see {@link product} to combine into a tuple instead
 * @see {@link lift2} to lift a binary function
 *
 * @category zipping
 * @since 2.0.0
 */
export const zipWith: {
  <B, A, C>(that: Option<B>, f: (a: A, b: B) => C): (self: Option<A>) => Option<C>
  <A, B, C>(self: Option<A>, that: Option<B>, f: (a: A, b: B) => C): Option<C>
} = dual(
  3,
  <A, B, C>(self: Option<A>, that: Option<B>, f: (a: A, b: B) => C): Option<C> =>
    map(product(self, that), ([a, b]) => f(a, b))
)

/**
 * Reduces an iterable of `Option`s to a single value, skipping `None` entries.
 *
 * **When to use**
 *
 * Use when you need to aggregate values from a collection where some may be
 * absent.
 *
 * **Details**
 *
 * - Iterates through the collection, applying `f` only to `Some` values
 * - `None` values are skipped entirely
 * - Returns the accumulated result
 *
 * **Example** (Summing present values)
 *
 * ```ts
 * import { Option, pipe } from "effect"
 *
 * const items = [Option.some(1), Option.none(), Option.some(2), Option.none()]
 *
 * console.log(pipe(items, Option.reduceCompact(0, (b, a) => b + a)))
 * // Output: 3
 * ```
 *
 * @category reducing
 * @since 2.0.0
 */
export const reduceCompact: {
  <B, A>(b: B, f: (b: B, a: A) => B): (self: Iterable<Option<A>>) => B
  <A, B>(self: Iterable<Option<A>>, b: B, f: (b: B, a: A) => B): B
} = dual(
  3,
  <A, B>(self: Iterable<Option<A>>, b: B, f: (b: B, a: A) => B): B => {
    let out: B = b
    for (const oa of self) {
      if (isSome(oa)) {
        out = f(out, oa.value)
      }
    }
    return out
  }
)

/**
 * Converts an `Option` into an `Array`.
 *
 * **When to use**
 *
 * Use when you need to pass an `Option` to array-based APIs or spread optional
 * values into collections.
 *
 * **Details**
 *
 * - `Some` → single-element array `[value]`
 * - `None` → empty array `[]`
 *
 * **Example** (Converting to an array)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.toArray(Option.some(1)))
 * // Output: [1]
 *
 * console.log(Option.toArray(Option.none()))
 * // Output: []
 * ```
 *
 * @see {@link fromIterable} for the inverse direction
 *
 * @category converting
 * @since 2.0.0
 */
export const toArray = <A>(self: Option<A>): Array<A> => isNone(self) ? [] : [self.value]

/**
 * Splits an `Option` into two `Option`s using a function that returns a `Result`.
 *
 * **When to use**
 *
 * Use when you need to split an optional value into "left" and "right"
 * channels using a `Result`-returning function.
 *
 * **Details**
 *
 * - `None` → `[None, None]`
 * - `Some` where `f` returns `Err` → `[Some(error), None]`
 * - `Some` where `f` returns `Ok` → `[None, Some(value)]`
 *
 * **Example** (Partitioning by Result)
 *
 * ```ts
 * import { Option, Result } from "effect"
 *
 * const parseNumber = (s: string): Result.Result<number, string> => {
 *   const n = Number(s)
 *   return isNaN(n) ? Result.fail("Not a number") : Result.succeed(n)
 * }
 *
 * console.log(Option.partitionMap(Option.some("42"), parseNumber))
 * // Output: [{ _id: 'Option', _tag: 'None' }, { _id: 'Option', _tag: 'Some', value: 42 }]
 *
 * console.log(Option.partitionMap(Option.some("abc"), parseNumber))
 * // Output: [{ _id: 'Option', _tag: 'Some', value: 'Not a number' }, { _id: 'Option', _tag: 'None' }]
 *
 * console.log(Option.partitionMap(Option.none(), parseNumber))
 * // Output: [{ _id: 'Option', _tag: 'None' }, { _id: 'Option', _tag: 'None' }]
 * ```
 *
 * @see {@link filter} for simple predicate-based filtering
 *
 * @category filtering
 * @since 2.0.0
 */
export const partitionMap: {
  <A, B, C>(f: (a: A) => Result<C, B>): (self: Option<A>) => [left: Option<B>, right: Option<C>]
  <A, B, C>(self: Option<A>, f: (a: A) => Result<C, B>): [left: Option<B>, right: Option<C>]
} = dual(2, <A, B, C>(
  self: Option<A>,
  f: (a: A) => Result<C, B>
): [excluded: Option<B>, satisfying: Option<C>] => {
  if (isNone(self)) {
    return [none(), none()]
  }
  const e = f(self.value)
  return result.isFailure(e) ? [some(e.failure), none()] : [none(), some(e.success)]
})

/**
 * Transforms and filters an `Option` using a `Filter` callback.
 *
 * **When to use**
 *
 * Use to transform an `Option`'s present value and discard it when the `Filter`
 * fails.
 *
 * **Details**
 *
 * The callback returns a `Result`: `Result.succeed` keeps and transforms the
 * value, while `Result.fail` discards it.
 *
 * **Example** (Filtering and transforming)
 *
 * ```ts
 * import { Option, Result } from "effect"
 *
 * console.log(Option.filterMap(
 *   Option.some(2),
 *   (n) => (n % 2 === 0 ? Result.succeed(`Even: ${n}`) : Result.failVoid)
 * ))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'Even: 2' }
 * ```
 *
 * @see {@link filter} for predicate-based filtering
 *
 * @category filtering
 * @since 2.0.0
 */
export const filterMap: {
  <A, B, X>(f: Filter.Filter<A, B, X>): (self: Option<A>) => Option<B>
  <A, B, X>(self: Option<A>, f: Filter.Filter<A, B, X>): Option<B>
} = dual(2, <A, B, X>(self: Option<A>, f: Filter.Filter<A, B, X>): Option<B> => {
  if (isNone(self)) {
    return none()
  }
  const next = f(self.value)
  return result.isSuccess(next) ? some(next.success) : none()
})

/**
 * Filters an `Option` using a predicate. Returns `None` if the predicate is
 * not satisfied or the input is `None`.
 *
 * **When to use**
 *
 * Use when you need to discard an `Option`'s present value when it does not
 * meet a condition, while narrowing the type via a refinement predicate.
 *
 * **Details**
 *
 * - `None` → `None`
 * - `Some` where `predicate(value)` is `true` → `Some(value)`
 * - `Some` where `predicate(value)` is `false` → `None`
 * - Supports refinements for type narrowing
 *
 * **Example** (Filtering with a predicate)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const removeEmpty = (input: Option.Option<string>) =>
 *   Option.filter(input, (value) => value !== "")
 *
 * console.log(removeEmpty(Option.some("hello")))
 * // Output: { _id: 'Option', _tag: 'Some', value: 'hello' }
 *
 * console.log(removeEmpty(Option.some("")))
 * // Output: { _id: 'Option', _tag: 'None' }
 *
 * console.log(removeEmpty(Option.none()))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link filterMap} to transform and filter simultaneously
 * @see {@link exists} to test without filtering
 *
 * @category filtering
 * @since 2.0.0
 */
export const filter: {
  <A, B extends A>(refinement: Refinement<A, B>): (self: Option<A>) => Option<B>
  <A>(predicate: Predicate<A>): <B extends A>(self: Option<B>) => Option<B>
  <A, B extends A>(self: Option<A>, refinement: Refinement<A, B>): Option<B>
  <A>(self: Option<A>, predicate: Predicate<A>): Option<A>
} = dual(
  2,
  <A>(self: Option<A>, predicate: Predicate<A>): Option<A> =>
    isNone(self) ? none() : predicate(self.value) ? some(self.value) : none()
)

/**
 * Creates an `Equivalence` for `Option<A>` from an `Equivalence` for `A`.
 *
 * **When to use**
 *
 * Use when you need equality to treat two `None` values as equal and compare
 * two `Some` values with a supplied equality rule.
 *
 * **Details**
 *
 * - `None` vs `None` → `true`
 * - `Some` vs `None` (or vice versa) → `false`
 * - `Some(a)` vs `Some(b)` → delegates to the provided `Equivalence`
 *
 * **Example** (Comparing Options)
 *
 * ```ts
 * import { Equivalence, Option } from "effect"
 *
 * const eq = Option.makeEquivalence(Equivalence.strictEqual<number>())
 *
 * console.log(eq(Option.some(1), Option.some(1)))
 * // Output: true
 *
 * console.log(eq(Option.some(1), Option.some(2)))
 * // Output: false
 *
 * console.log(eq(Option.none(), Option.none()))
 * // Output: true
 * ```
 *
 * @category instances
 * @since 4.0.0
 */
export const makeEquivalence = <A>(isEquivalent: Equivalence.Equivalence<A>): Equivalence.Equivalence<Option<A>> =>
  Equivalence.make((x, y) => isNone(x) ? isNone(y) : isNone(y) ? false : isEquivalent(x.value, y.value))

/**
 * Creates an `Order` for `Option<A>` from an `Order` for `A`.
 *
 * **When to use**
 *
 * Use when you need to sort `Some` and `None` values, with `None` ordered
 * before present values and present values compared by a supplied ordering
 * rule.
 *
 * **Details**
 *
 * - `None` is considered less than any `Some`
 * - Two `Some` values are compared using the provided `Order`
 * - Two `None` values are equal (returns `0`)
 *
 * **Example** (Ordering Options)
 *
 * ```ts
 * import { Number as N, Option } from "effect"
 *
 * const ord = Option.makeOrder(N.Order)
 *
 * console.log(ord(Option.none(), Option.some(1)))
 * // Output: -1
 *
 * console.log(ord(Option.some(1), Option.none()))
 * // Output: 1
 *
 * console.log(ord(Option.some(1), Option.some(2)))
 * // Output: -1
 * ```
 *
 * @category sorting
 * @since 4.0.0
 */
export const makeOrder = <A>(O: Order<A>): Order<Option<A>> =>
  order.make((self, that) => isSome(self) ? (isSome(that) ? O(self.value, that.value) : 1) : -1)

/**
 * Lifts a binary function to operate on two `Option` values.
 *
 * **When to use**
 *
 * Use when you need to reuse an existing binary function with two `Option`
 * values.
 *
 * **Details**
 *
 * - Both `Some` → applies `f` and wraps in `Some`
 * - Either `None` → `None`
 *
 * **Example** (Lifting addition)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const addOptions = Option.lift2((a: number, b: number) => a + b)
 *
 * console.log(addOptions(Option.some(2), Option.some(3)))
 * // Output: { _id: 'Option', _tag: 'Some', value: 5 }
 *
 * console.log(addOptions(Option.some(2), Option.none()))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link zipWith} for a non-lifted variant
 *
 * @category lifting
 * @since 2.0.0
 */
export const lift2 = <A, B, C>(f: (a: A, b: B) => C): {
  (that: Option<B>): (self: Option<A>) => Option<C>
  (self: Option<A>, that: Option<B>): Option<C>
} => dual(2, (self: Option<A>, that: Option<B>): Option<C> => zipWith(self, that, f))

/**
 * Lifts a `Predicate` or `Refinement` into the `Option` context: returns
 * `Some(value)` when the predicate holds, `None` otherwise.
 *
 * **When to use**
 *
 * Use to convert a boolean check into an `Option`-returning function
 * - Validating input and wrapping it in `Option`
 *
 * **Details**
 *
 * - `predicate(value)` is `true` → `Some(value)`
 * - `predicate(value)` is `false` → `None`
 * - Supports refinements for type narrowing
 *
 * **Example** (Validating positive numbers)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const parsePositive = Option.liftPredicate((n: number) => n > 0)
 *
 * console.log(parsePositive(1))
 * // Output: { _id: 'Option', _tag: 'Some', value: 1 }
 *
 * console.log(parsePositive(-1))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link filter} to apply a predicate to an existing `Option`
 * @see {@link toRefinement} for the inverse direction
 *
 * @category lifting
 * @since 2.0.0
 */
export const liftPredicate: { // Note: I intentionally avoid using the NoInfer pattern here.
  <A, B extends A>(refinement: Refinement<A, B>): (a: A) => Option<B>
  <B extends A, A = B>(predicate: Predicate<A>): (b: B) => Option<B>
  <A, B extends A>(
    self: A,
    refinement: Refinement<A, B>
  ): Option<B>
  <B extends A, A = B>(
    self: B,
    predicate: Predicate<A>
  ): Option<B>
} = dual(
  2,
  <B extends A, A = B>(b: B, predicate: Predicate<A>): Option<B> => predicate(b) ? some(b) : none()
)

/**
 * Checks whether an `Option` contains a value equivalent to the given one, using a
 * custom `Equivalence`.
 *
 * **When to use**
 *
 * Use when you need to test whether an `Option` contains a value using a
 * custom equality check.
 *
 * **Details**
 *
 * - `Some` where `isEquivalent(value, a)` is `true` → `true`
 * - `Some` where not equivalent, or `None` → `false`
 *
 * **Example** (Checking with custom equivalence)
 *
 * ```ts
 * import { Equivalence, Option } from "effect"
 *
 * const check = Option.containsWith(Equivalence.strictEqual<number>())
 *
 * console.log(Option.some(2).pipe(check(2)))
 * // Output: true
 *
 * console.log(Option.some(1).pipe(check(2)))
 * // Output: false
 *
 * console.log(Option.none().pipe(check(2)))
 * // Output: false
 * ```
 *
 * @see {@link contains} for a version using default equality
 *
 * @category elements
 * @since 2.0.0
 */
export const containsWith = <A>(isEquivalent: (self: A, that: A) => boolean): {
  (a: A): (self: Option<A>) => boolean
  (self: Option<A>, a: A): boolean
} => dual(2, (self: Option<A>, a: A): boolean => isNone(self) ? false : isEquivalent(self.value, a))

/**
 * Checks whether an `Option` contains a value equal to the given one, using default
 * structural equality.
 *
 * **When to use**
 *
 * Use when you need a quick membership test for an `Option` value using
 * standard equality.
 *
 * **Details**
 *
 * - `Some` where `Equal.equals(value, a)` is `true` → `true`
 * - `Some` where not equal, or `None` → `false`
 *
 * **Example** (Checking containment)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * console.log(Option.some(2).pipe(Option.contains(2)))
 * // Output: true
 *
 * console.log(Option.some(1).pipe(Option.contains(2)))
 * // Output: false
 *
 * console.log(Option.none().pipe(Option.contains(2)))
 * // Output: false
 * ```
 *
 * @see {@link containsWith} for custom equality
 * @see {@link exists} to test with a predicate
 *
 * @category elements
 * @since 2.0.0
 */
export const contains: {
  <A>(a: A): (self: Option<A>) => boolean
  <A>(self: Option<A>, a: A): boolean
} = containsWith(Equal.asEquivalence())

/**
 * Checks whether the value in a `Some` satisfies a predicate or refinement.
 *
 * **When to use**
 *
 * Use to check a condition on an optional value without unwrapping
 *
 * **Details**
 *
 * - `None` → `false`
 * - `Some` where `predicate(value)` is `true` → `true`
 * - `Some` where `predicate(value)` is `false` → `false`
 * - With a refinement, narrows the `Option` type on `true`
 *
 * **Example** (Testing a condition)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const isEven = (n: number) => n % 2 === 0
 *
 * console.log(Option.some(2).pipe(Option.exists(isEven)))
 * // Output: true
 *
 * console.log(Option.some(1).pipe(Option.exists(isEven)))
 * // Output: false
 *
 * console.log(Option.none().pipe(Option.exists(isEven)))
 * // Output: false
 * ```
 *
 * @see {@link filter} to keep or discard based on a predicate
 * @see {@link contains} to test for a specific value
 *
 * @category elements
 * @since 2.0.0
 */
export const exists: {
  <A, B extends A>(refinement: Refinement<NoInfer<A>, B>): (self: Option<A>) => self is Option<B>
  <A>(predicate: Predicate<NoInfer<A>>): (self: Option<A>) => boolean
  <A, B extends A>(self: Option<A>, refinement: Refinement<A, B>): self is Option<B>
  <A>(self: Option<A>, predicate: Predicate<A>): boolean
} = dual(
  2,
  <A, B extends A>(self: Option<A>, refinement: Refinement<A, B>): self is Option<B> =>
    isNone(self) ? false : refinement(self.value)
)

// -------------------------------------------------------------------------------------
// do notation
// -------------------------------------------------------------------------------------

/**
 * Gives a name to the value of an `Option`, creating a single-key record
 * inside `Some`. Starting point for the do notation pipeline.
 *
 * **When to use**
 *
 * Use when you need to start an `Option` do notation chain by naming the first
 * value.
 *
 * **Example** (Starting do notation)
 *
 * ```ts
 * import { Option, pipe } from "effect"
 * import * as assert from "node:assert"
 *
 * const result = pipe(
 *   Option.some(2),
 *   Option.bindTo("x"),
 *   Option.bind("y", () => Option.some(3)),
 *   Option.let("sum", ({ x, y }) => x + y)
 * )
 * assert.deepStrictEqual(result, Option.some({ x: 2, y: 3, sum: 5 }))
 * ```
 *
 * @see {@link Do} for starting with an empty record
 * @see {@link bind} to add `Option` values
 * @see {@link let_ let} to add plain values
 *
 * @category do notation
 * @since 2.0.0
 */
export const bindTo: {
  <N extends string>(name: N): <A>(self: Option<A>) => Option<{ [K in N]: A }>
  <A, N extends string>(self: Option<A>, name: N): Option<{ [K in N]: A }>
} = doNotation.bindTo<OptionTypeLambda>(map)

const let_: {
  <N extends string, A extends object, B>(
    name: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => B
  ): (self: Option<A>) => Option<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }>
  <A extends object, N extends string, B>(
    self: Option<A>,
    name: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => B
  ): Option<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }>
} = doNotation.let_<OptionTypeLambda>(map)

export {
  /**
   * Adds a computed plain value to the do notation record.
   *
   * **When to use**
   *
   * Use when you need to bind a derived non-`Option` value in an `Option` do
   * notation pipeline.
   *
   * **Example** (Adding a computed value)
   *
   * ```ts
   * import { Option, pipe } from "effect"
   * import * as assert from "node:assert"
   *
   * const result = pipe(
   *   Option.Do,
   *   Option.bind("x", () => Option.some(2)),
   *   Option.bind("y", () => Option.some(3)),
   *   Option.let("sum", ({ x, y }) => x + y)
   * )
   * assert.deepStrictEqual(result, Option.some({ x: 2, y: 3, sum: 5 }))
   * ```
   *
   * @see {@link Do} for starting the chain
   * @see {@link bind} to add `Option` values
   * @see {@link bindTo} to start by naming an existing `Option`
   *
   * @category do notation
   * @since 2.0.0
   */
  let_ as let
}

/**
 * Adds an `Option` value to the do notation record under a given name. If the
 * `Option` is `None`, the whole pipeline short-circuits to `None`.
 *
 * **When to use**
 *
 * Use when you need to sequence `Option` computations in do notation.
 *
 * **Example** (Binding Option values)
 *
 * ```ts
 * import { Option, pipe } from "effect"
 * import * as assert from "node:assert"
 *
 * const result = pipe(
 *   Option.Do,
 *   Option.bind("x", () => Option.some(2)),
 *   Option.bind("y", () => Option.some(3)),
 *   Option.let("sum", ({ x, y }) => x + y),
 *   Option.filter(({ x, y }) => x * y > 5)
 * )
 * assert.deepStrictEqual(result, Option.some({ x: 2, y: 3, sum: 5 }))
 * ```
 *
 * @see {@link Do} for starting the chain
 * @see {@link let_ let} to add plain values
 * @see {@link bindTo} to start by naming an existing `Option`
 *
 * @category do notation
 * @since 2.0.0
 */
export const bind: {
  <N extends string, A extends object, B>(
    name: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => Option<B>
  ): (self: Option<A>) => Option<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }>
  <A extends object, N extends string, B>(
    self: Option<A>,
    name: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => Option<B>
  ): Option<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }>
} = doNotation.bind<OptionTypeLambda>(map, flatMap)

/**
 * Provides an `Option` containing an empty record `{}`, used as the starting point for
 * do notation chains.
 *
 * **When to use**
 *
 * Use when you need to start an `Option` do notation pipeline before adding
 * bindings.
 *
 * **Example** (Building Option pipelines with do notation)
 *
 * ```ts
 * import { Option, pipe } from "effect"
 * import * as assert from "node:assert"
 *
 * const result = pipe(
 *   Option.Do,
 *   Option.bind("x", () => Option.some(2)),
 *   Option.bind("y", () => Option.some(3)),
 *   Option.let("sum", ({ x, y }) => x + y),
 *   Option.filter(({ x, y }) => x * y > 5)
 * )
 * assert.deepStrictEqual(result, Option.some({ x: 2, y: 3, sum: 5 }))
 * ```
 *
 * @see {@link bind} to add `Option` values
 * @see {@link let_ let} to add plain values
 * @see {@link bindTo} to start by naming an existing `Option`
 *
 * @category do notation
 * @since 2.0.0
 */
export const Do: Option<{}> = some({})

/**
 * Provides generator-based syntax for `Option`, similar to `async`/`await` but for
 * optional values. Yielding a `None` short-circuits the generator to `None`.
 *
 * **When to use**
 *
 * Use when you need generator syntax for a sequence of `Option` steps that
 * should short-circuit on `None`.
 *
 * **Details**
 *
 * - Each `yield*` unwraps a `Some` value or short-circuits to `None`
 * - The return value is wrapped in `Some`
 * - No `Effect` runtime is needed
 *
 * **Example** (Sequencing Option computations with generator syntax)
 *
 * ```ts
 * import { Option } from "effect"
 *
 * const maybeName: Option.Option<string> = Option.some("John")
 * const maybeAge: Option.Option<number> = Option.some(25)
 *
 * const person = Option.gen(function*() {
 *   const name = (yield* maybeName).toUpperCase()
 *   const age = yield* maybeAge
 *   return { name, age }
 * })
 *
 * console.log(person)
 * // Output:
 * // { _id: 'Option', _tag: 'Some', value: { name: 'JOHN', age: 25 } }
 * ```
 *
 * @see {@link Do} / {@link bind} for the do notation alternative
 *
 * @category generators
 * @since 2.0.0
 */
export const gen: Gen.Gen<OptionTypeLambda> = (...args) => {
  const f = args.length === 1 ? args[0] : args[1].bind(args[0])
  const iterator = f()
  let state: IteratorResult<any> = iterator.next()
  while (!state.done) {
    const current = state.value
    if (isNone(current)) {
      return current
    }
    state = iterator.next(current.value as never)
  }
  return some(state.value)
}

/**
 * Creates a `Reducer` for `Option<A>` that prioritizes the first non-`None`
 * value and combines values when both are `Some`.
 *
 * **When to use**
 *
 * Use to build an `Option` reducer that falls back to the first available value
 * when either side may be absent.
 *
 * **Details**
 *
 * - `None` + `None` → `None`
 * - `Some(a)` + `None` → `Some(a)`
 * - `None` + `Some(b)` → `Some(b)`
 * - `Some(a)` + `Some(b)` → `Some(combine(a, b))`
 * - Initial value is `None`
 *
 * **Example** (Reducing with first-wins semantics)
 *
 * ```ts
 * import { Number, Option } from "effect"
 *
 * const reducer = Option.makeReducer(Number.ReducerSum)
 * console.log(reducer.combineAll([Option.some(1), Option.none(), Option.some(2)]))
 * // Output: { _id: 'Option', _tag: 'Some', value: 3 }
 * ```
 *
 * @see {@link makeReducerFailFast} for fail-fast semantics
 *
 * @category Reducer
 * @since 4.0.0
 */
export function makeReducer<A>(combiner: Combiner.Combiner<A>): Reducer.Reducer<Option<A>> {
  return Reducer.make((self, that) => {
    if (isNone(self)) return that
    if (isNone(that)) return self
    return some(combiner.combine(self.value, that.value))
  }, none())
}

/**
 * Creates a `Combiner` for `Option<A>` with fail-fast semantics: returns `None`
 * if either operand is `None`.
 *
 * **When to use**
 *
 * Use when you need an `Option` combiner that returns `None` unless both
 * operands are `Some`.
 *
 * **Details**
 *
 * - `None` + anything → `None`
 * - anything + `None` → `None`
 * - `Some(a)` + `Some(b)` → `Some(combine(a, b))`
 *
 * **Example** (Fail-fast combining)
 *
 * ```ts
 * import { Number, Option } from "effect"
 *
 * const combiner = Option.makeCombinerFailFast(Number.ReducerSum)
 * console.log(combiner.combine(Option.some(1), Option.some(2)))
 * // Output: { _id: 'Option', _tag: 'Some', value: 3 }
 *
 * console.log(combiner.combine(Option.some(1), Option.none()))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link makeReducerFailFast} to get a full `Reducer`
 *
 * @category Combiner
 * @since 4.0.0
 */
export function makeCombinerFailFast<A>(combiner: Combiner.Combiner<A>): Combiner.Combiner<Option<A>> {
  return Combiner.make((self, that) => {
    if (isNone(self) || isNone(that)) return none()
    return some(combiner.combine(self.value, that.value))
  })
}

/**
 * Creates a `Reducer` for `Option<A>` by lifting an existing `Reducer` with
 * fail-fast semantics.
 *
 * **When to use**
 *
 * Use when you need to reduce `Option` values with fail-fast semantics, where
 * any `None` aborts the entire result instead of being skipped.
 *
 * **Details**
 *
 * - Initial value is `Some(reducer.initialValue)`
 * - Combines only when both operands are `Some`
 * - Any `None` causes the result to become `None` immediately
 *
 * **Example** (Fail-fast reducing)
 *
 * ```ts
 * import { Number, Option } from "effect"
 *
 * const reducer = Option.makeReducerFailFast(Number.ReducerSum)
 * console.log(reducer.combineAll([Option.some(1), Option.some(2)]))
 * // Output: { _id: 'Option', _tag: 'Some', value: 3 }
 *
 * console.log(reducer.combineAll([Option.some(1), Option.none()]))
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link makeCombinerFailFast} for just the combiner
 * @see {@link makeReducer} for non-fail-fast semantics
 *
 * @category Reducer
 * @since 4.0.0
 */
export function makeReducerFailFast<A>(reducer: Reducer.Reducer<A>): Reducer.Reducer<Option<A>> {
  const combine = makeCombinerFailFast(reducer).combine
  const initialValue = some(reducer.initialValue)
  return Reducer.make(combine, initialValue, (collection) => {
    let out = initialValue
    for (const value of collection) {
      out = combine(out, value)
      if (isNone(out)) return out
    }
    return out
  })
}
