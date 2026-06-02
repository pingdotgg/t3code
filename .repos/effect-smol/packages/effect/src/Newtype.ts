/**
 * Lightweight wrapper types that prevent accidental mixing of structurally
 * identical values (e.g. `UserId` vs `OrderId`, both `string` at runtime).
 *
 * **Mental model**
 *
 * - **Newtype** — a compile-time wrapper around a **carrier** type (the
 *   underlying primitive or object). At runtime the value is unchanged; the
 *   tag exists only in the type system.
 * - **Key** — a unique string literal that distinguishes one newtype from
 *   another (e.g. `"Label"`, `"UserId"`).
 * - **Carrier** — the underlying type the newtype wraps (e.g. `string`,
 *   `number`).
 * - **Iso** — a lossless two-way conversion between a newtype and its carrier,
 *   created with {@link makeIso}. Use `iso.set(carrier)` to wrap and
 *   `iso.get(newtype)` to unwrap.
 *
 * **Common tasks**
 *
 * - Define a newtype → declare an `interface` extending
 *   `Newtype.Newtype<Key, Carrier>`
 * - Wrap / unwrap values → {@link makeIso} (returns an `Optic.Iso`)
 * - Unwrap only → {@link value}
 * - Lift an `Equivalence` → {@link makeEquivalence}
 * - Lift an `Order` → {@link makeOrder}
 * - Lift a `Combiner` → {@link makeCombiner}
 * - Lift a `Reducer` → {@link makeReducer}
 *
 * **Gotchas**
 *
 * - Newtypes are **purely compile-time**. There is zero runtime overhead;
 *   `value` and `makeIso` use identity casts.
 * - Two newtypes sharing the same key string will be assignable to each other.
 *   Choose unique key strings.
 * - A newtype value is **not** assignable to its carrier type without
 *   explicitly unwrapping via {@link value} or an iso.
 *
 * **Quickstart**
 *
 * **Example** (defining and using a newtype)
 *
 * ```ts
 * import { Newtype } from "effect"
 *
 * // 1. Define a newtype
 * interface Label extends Newtype.Newtype<"Label", string> {}
 *
 * // 2. Create an iso for wrapping/unwrapping
 * const labelIso = Newtype.makeIso<Label>()
 *
 * // 3. Wrap a raw string
 * const myLabel: Label = labelIso.set("hello")
 *
 * // 4. Unwrap back to string
 * const raw: string = labelIso.get(myLabel) // "hello"
 * ```
 *
 * **See also**
 *
 * - {@link Newtype} (the tagged interface)
 * - {@link makeIso} (wrap and unwrap)
 * - {@link value} (unwrap only)
 *
 * @since 4.0.0
 */
import type * as Combiner from "./Combiner.ts"
import type * as Equivalence from "./Equivalence.ts"
import { cast } from "./Function.ts"
import * as Optic from "./Optic.ts"
import type * as Order from "./Order.ts"
import type * as Reducer from "./Reducer.ts"

const TypeId = "~effect/Newtype"

/**
 * A tagged interface that wraps a carrier type under a unique key, preventing
 * accidental interchange of structurally identical values.
 *
 * **When to use**
 *
 * Use to define a newtype as an `interface` extending
 * `Newtype<"MyKey", CarrierType>` when structurally identical carrier types
 * should remain distinct in TypeScript.
 *
 * **Details**
 *
 * The tag is compile-time only, so no runtime wrapper is allocated. Use
 * {@link makeIso} to create a two-way conversion, or {@link value} to unwrap.
 *
 * **Example** (Defining a newtype)
 *
 * ```ts
 * import { Newtype } from "effect"
 *
 * interface UserId extends Newtype.Newtype<"UserId", number> {}
 * interface OrderId extends Newtype.Newtype<"OrderId", number> {}
 *
 * // UserId and OrderId are not assignable to each other
 * // even though both wrap `number`.
 * ```
 *
 * @see {@link makeIso} — create an iso to wrap and unwrap
 * @see {@link value} — unwrap a newtype value
 *
 * @category models
 * @since 4.0.0
 */
export interface Newtype<in out Key extends string, out Carrier> {
  readonly [TypeId]: {
    readonly key: Key
    readonly carrier: Carrier
  }
}

/**
 * Namespace containing type-level helpers for `Newtype` values, including
 * constraints and utilities for extracting a newtype's key and carrier type.
 *
 * **When to use**
 *
 * Use to access generic constraints and type-level utilities for `Newtype`
 * values.
 *
 * @since 4.0.0
 */
export declare namespace Newtype {
  /**
   * A type that matches any `Newtype`, useful as a generic constraint:
   * `<N extends Newtype.Any>`.
   *
   * **When to use**
   *
   * Use as a generic constraint when a type parameter can be any `Newtype`.
   *
   * @see {@link Newtype} — the base tagged interface
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Any = Newtype<any, unknown>

  /**
   * Extracts the key literal type from a newtype.
   *
   * **When to use**
   *
   * Use to inspect or constrain a newtype's key in generic code.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Key<N extends Any> = N extends Newtype<infer Key, unknown> ? Key : never

  /**
   * Extracts the carrier (underlying) type from a newtype.
   *
   * **When to use**
   *
   * Use when you need to refer to the wrapped type in generic utilities.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Carrier<N extends Any> = N extends Newtype<infer _Key, infer Carrier> ? Carrier : never
}

/**
 * Unwraps a newtype value, returning the underlying carrier value.
 *
 * **When to use**
 *
 * Use when you only need to read the inner value and do not need to wrap
 * new values. For both wrapping and unwrapping, prefer {@link makeIso}.
 *
 * **Details**
 *
 * This has zero runtime cost because it is an identity cast.
 *
 * **Example** (Unwrapping a newtype)
 *
 * ```ts
 * import { Newtype } from "effect"
 *
 * interface Label extends Newtype.Newtype<"Label", string> {}
 *
 * const iso = Newtype.makeIso<Label>()
 * const label = iso.set("hello")
 *
 * const raw: string = Newtype.value(label) // "hello"
 * ```
 *
 * @see {@link makeIso} — two-way conversion (wrap and unwrap)
 *
 * @category getters
 * @since 4.0.0
 */
export const value: <N extends Newtype.Any>(newtype: N) => Newtype.Carrier<N> = cast

/**
 * Creates an `Optic.Iso` for a newtype, providing both wrapping (`set`) and
 * unwrapping (`get`).
 *
 * **When to use**
 *
 * Use as the primary way to construct and deconstruct newtype values.
 *
 * **Details**
 *
 * The returned iso composes with other optics via the standard `Optic` API.
 * Both directions have zero runtime cost because they are identity casts.
 *
 * **Example** (Wrapping and unwrapping with an iso)
 *
 * ```ts
 * import { Newtype } from "effect"
 *
 * interface Label extends Newtype.Newtype<"Label", string> {}
 *
 * const labelIso = Newtype.makeIso<Label>()
 *
 * const label: Label = labelIso.set("world")
 * const str: string = labelIso.get(label) // "world"
 * ```
 *
 * @see {@link value} — unwrap only
 *
 * @category constructors
 * @since 4.0.0
 */
export function makeIso<N extends Newtype.Any>(): Optic.Iso<N, Newtype.Carrier<N>> {
  return Optic.makeIso(value, cast)
}

/**
 * Lifts an `Equivalence` for the carrier type into an `Equivalence` for the
 * newtype.
 *
 * **When to use**
 *
 * Use when you need to compare two newtype values for equality.
 *
 * **Details**
 *
 * The returned equivalence delegates to the provided carrier equivalence and
 * has zero runtime cost beyond the underlying equivalence check.
 *
 * **Example** (Comparing newtypes)
 *
 * ```ts
 * import { Equivalence, Newtype } from "effect"
 *
 * interface Label extends Newtype.Newtype<"Label", string> {}
 *
 * const eq = Newtype.makeEquivalence<Label>(Equivalence.String)
 * const iso = Newtype.makeIso<Label>()
 *
 * eq(iso.set("a"), iso.set("a")) // true
 * eq(iso.set("a"), iso.set("b")) // false
 * ```
 *
 * @see {@link makeOrder} — lift an `Order` for the carrier
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeEquivalence: <N extends Newtype.Any>(
  equivalence: Equivalence.Equivalence<Newtype.Carrier<N>>
) => Equivalence.Equivalence<N> = cast

/**
 * Lifts an `Order` for the carrier type into an `Order` for the newtype.
 *
 * **When to use**
 *
 * Use when you need to sort or compare newtype values.
 *
 * **Details**
 *
 * The returned order delegates to the provided carrier order.
 *
 * **Example** (Ordering newtypes)
 *
 * ```ts
 * import { Newtype, Order } from "effect"
 *
 * interface Score extends Newtype.Newtype<"Score", number> {}
 *
 * const ord = Newtype.makeOrder<Score>(Order.Number)
 * const iso = Newtype.makeIso<Score>()
 *
 * ord(iso.set(1), iso.set(2)) // -1
 * ```
 *
 * @see {@link makeEquivalence} — lift an `Equivalence` for the carrier
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeOrder: <N extends Newtype.Any>(order: Order.Order<Newtype.Carrier<N>>) => Order.Order<N> = cast

/**
 * Lifts a `Combiner` for the carrier type into a `Combiner` for the newtype.
 *
 * **When to use**
 *
 * Use when you need to combine newtype values.
 *
 * **Details**
 *
 * The returned combiner delegates to the provided carrier combiner.
 *
 * **Example** (Combining newtypes)
 *
 * ```ts
 * import { Combiner, Newtype } from "effect"
 *
 * interface Amount extends Newtype.Newtype<"Amount", number> {}
 *
 * const sum = Combiner.make<number>((a, b) => a + b)
 * const combiner = Newtype.makeCombiner<Amount>(sum)
 * const iso = Newtype.makeIso<Amount>()
 *
 * const total = combiner.combine(iso.set(10), iso.set(20))
 * Newtype.value(total) // 30
 * ```
 *
 * @see {@link makeReducer} — lift a `Reducer` for the carrier
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeCombiner: <N extends Newtype.Any>(
  combiner: Combiner.Combiner<Newtype.Carrier<N>>
) => Combiner.Combiner<N> = cast

/**
 * Lifts a `Reducer` for the carrier type into a `Reducer` for the newtype.
 *
 * **When to use**
 *
 * Use when you need to fold or reduce over a collection of newtype
 * values.
 *
 * **Details**
 *
 * The returned reducer delegates to the provided carrier reducer.
 *
 * **Example** (Reducing newtypes)
 *
 * ```ts
 * import { Newtype, Reducer } from "effect"
 *
 * interface Score extends Newtype.Newtype<"Score", number> {}
 *
 * const sum = Reducer.make<number>((a, b) => a + b, 0)
 * const reducer = Newtype.makeReducer<Score>(sum)
 * const iso = Newtype.makeIso<Score>()
 *
 * const total = reducer.combineAll([iso.set(1), iso.set(2), iso.set(3)])
 * Newtype.value(total) // 6
 * ```
 *
 * @see {@link makeCombiner} — lift a `Combiner` for the carrier
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeReducer: <N extends Newtype.Any>(reducer: Reducer.Reducer<Newtype.Carrier<N>>) => Reducer.Reducer<N> =
  cast
