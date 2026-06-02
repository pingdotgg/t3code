/**
 * Internal utilities for the Effect ecosystem's generator-based syntax and
 * higher-kinded type machinery.
 *
 * ## Mental model
 *
 * - **SingleShotGen** — an `IterableIterator` wrapper that yields its value
 *   exactly once. Used internally by `[Symbol.iterator]()` on Effect, Option,
 *   Result, and other yieldable types so they work inside generator functions.
 * - **Gen** — a type-level signature for generator-based monadic composition
 *   (`gen` functions). Parametric over any `TypeLambda` so each module
 *   (Effect, Option, Result, ...) can expose its own `gen` with correct types.
 * - **Variance** — a type-level marker that encodes the variance (covariant,
 *   contravariant, invariant) of a `TypeLambda`'s type parameters.
 *   Used by {@link Gen} for type inference.
 *
 * ## Common tasks
 *
 * - Make a type yieldable in generators -> implement `[Symbol.iterator]()` returning a {@link SingleShotGen}
 * - Define a generator-based API for a new TypeLambda -> type it as {@link Gen}`<MyTypeLambda>`
 * - Encode variance for a higher-kinded type -> use {@link Variance}
 *
 * ## Gotchas
 *
 * - {@link SingleShotGen} yields its value only on the first `.next()` call.
 *   Calling `.next()` again returns `{ done: true }`. Iterating the same
 *   instance twice will skip the value on the second pass; call
 *   `[Symbol.iterator]()` to get a fresh iterator.
 * - {@link Gen} and {@link Variance} are pure type-level constructs — they
 *   have no runtime representation.
 *
 * ## Quickstart
 *
 * **Example** (Using SingleShotGen to make a type yieldable)
 *
 * ```ts
 * import { Utils } from "effect"
 *
 * class MyWrapper<A> {
 *   constructor(readonly value: A) {}
 *   [Symbol.iterator]() {
 *     return new Utils.SingleShotGen<MyWrapper<A>, A>(this)
 *   }
 * }
 *
 * const w = new MyWrapper(42)
 * const iter = w[Symbol.iterator]()
 * console.log(iter.next(undefined as any))
 * // { value: MyWrapper { value: 42 }, done: false }
 * console.log(iter.next(42))
 * // { value: 42, done: true }
 * ```
 *
 * @see {@link SingleShotGen}
 * @see {@link Gen}
 * @see {@link Variance}
 *
 * @since 2.0.0
 */
import type { Kind, TypeLambda } from "./HKT.ts"
import type * as Types from "./Types.ts"

/**
 * Yields its wrapped value exactly once through an `IterableIterator`.
 *
 * **When to use**
 *
 * Use to implement `[Symbol.iterator]()` on Effect-like types so they can be
 * `yield*`-ed inside generator functions, such as `Effect.gen` and
 * `Option.gen`.
 *
 * **Details**
 *
 * The first call to `next()` returns `{ value: self, done: false }`. Every
 * subsequent call returns `{ value: a, done: true }` where `a` is the argument
 * passed to `next()`. `[Symbol.iterator]()` returns a **new** `SingleShotGen`
 * wrapping the same value, so the outer type can be iterated multiple times.
 *
 * **Example** (Yielding a wrapped value in a generator)
 *
 * ```ts
 * import { Utils } from "effect"
 *
 * const gen = new Utils.SingleShotGen<string, number>("hello")
 *
 * // First call yields the wrapped value
 * console.log(gen.next(0))
 * // { value: "hello", done: false }
 *
 * // Second call signals completion with the provided value
 * console.log(gen.next(42))
 * // { value: 42, done: true }
 * ```
 *
 * @see {@link Gen} for the type-level signature that relies on `SingleShotGen`
 * @category constructors
 * @since 2.0.0
 */
export class SingleShotGen<T, A> implements IterableIterator<T, A> {
  private called = false
  readonly self: T

  constructor(self: T) {
    this.self = self
  }

  /**
   * Yields the stored value once, then completes with the value sent back in.
   *
   * **When to use**
   *
   * Use to advance a `SingleShotGen` through its single yield and completion
   * step.
   *
   * @since 2.0.0
   */
  next(a: A): IteratorResult<T, A> {
    return this.called ?
      ({
        value: a,
        done: true
      }) :
      (this.called = true,
        ({
          value: this.self,
          done: false
        }))
  }

  /**
   * Creates a fresh single-shot iterator over the stored value.
   *
   * **When to use**
   *
   * Use to iterate the wrapped value again without reusing the consumed
   * iterator state.
   *
   * @since 2.0.0
   */
  [Symbol.iterator](): IterableIterator<T, A> {
    return new SingleShotGen<T, A>(this.self)
  }
}

/**
 * Type-level marker encoding the variance of a `TypeLambda`'s type
 * parameters.
 *
 * **When to use**
 *
 * Use to define variance constraints for a higher-kinded type so that
 * {@link Gen} can correctly infer `R`, `O`, and `E` from yielded values.
 *
 * **Details**
 *
 * `F` is invariant and must match exactly. `R` is contravariant in the input
 * or environment position. `O` and `E` are covariant in the output and error
 * positions. This is a pure type-level construct with no runtime
 * representation.
 *
 * **Example** (Declaring variance for a TypeLambda)
 *
 * ```ts
 * import type { Option, Utils } from "effect"
 *
 * declare const variance: Utils.Variance<
 *   Option.OptionTypeLambda,
 *   never,
 *   never,
 *   never
 * >
 * ```
 *
 * @see {@link Gen} for the type-level signature that uses `Variance`
 * @category models
 * @since 2.0.0
 */
export interface Variance<in out F extends TypeLambda, in R, out O, out E> {
  readonly _F: Types.Invariant<F>
  readonly _R: Types.Contravariant<R>
  readonly _O: Types.Covariant<O>
  readonly _E: Types.Covariant<E>
}

/**
 * Type-level signature for generator-based monadic composition over any
 * `TypeLambda`.
 *
 * **When to use**
 *
 * Use to type the `gen` function of a module that supports generator syntax,
 * such as `Option.gen`, `Result.gen`, and `Effect.gen`.
 *
 * **Details**
 *
 * This is a pure type alias with no runtime behavior. It infers `R`, `O`, and
 * `E` from the yielded values via {@link Variance} or `Kind` constraints. The
 * generator's return type `A` becomes the output's `A` parameter.
 *
 * **Example** (Typing a gen function for Option)
 *
 * ```ts
 * import type { Option, Utils } from "effect"
 *
 * declare const gen: Utils.Gen<Option.OptionTypeLambda>
 * ```
 *
 * @see {@link Variance} for encoding the variance used for inference
 * @see {@link SingleShotGen} for the iterator protocol that makes yielding work
 * @category models
 * @since 2.0.0
 */
export type Gen<F extends TypeLambda> = <
  Self,
  K extends Variance<F, any, any, any> | Kind<F, any, any, any, any>,
  A
>(
  ...args:
    | [
      self: Self,
      body: (this: Self) => Generator<K, A, never>
    ]
    | [
      body: () => Generator<K, A, never>
    ]
) => Kind<
  F,
  [K] extends [Variance<F, infer R, any, any>] ? R
    : [K] extends [Kind<F, infer R, any, any, any>] ? R
    : never,
  [K] extends [Variance<F, any, infer O, any>] ? O
    : [K] extends [Kind<F, any, infer O, any, any>] ? O
    : never,
  [K] extends [Variance<F, any, any, infer E>] ? E
    : [K] extends [Kind<F, any, any, infer E, any>] ? E
    : never,
  A
>

const InternalTypeId = "~effect/Utils/internal"

const standard = {
  [InternalTypeId]: <A>(body: () => A) => {
    return body()
  }
}

const forced = {
  [InternalTypeId]: <A>(body: () => A) => {
    try {
      return body()
    } finally {
      //
    }
  }
}

const isNotOptimizedAway = standard[InternalTypeId](() => new Error().stack)?.includes(InternalTypeId) === true

/** @internal */
export const internalCall = isNotOptimizedAway ? standard[InternalTypeId] : forced[InternalTypeId]
