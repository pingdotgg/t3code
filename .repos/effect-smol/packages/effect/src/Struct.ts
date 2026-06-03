/**
 * Utilities for creating, transforming, and comparing plain TypeScript objects
 * (structs). Every function produces a new object — inputs are never mutated.
 *
 * ## Mental model
 *
 * - **Struct**: A plain JS object with a fixed set of known keys (e.g.,
 *   `{ name: string; age: number }`). Not a generic key-value record.
 * - **Dual API**: Most functions accept arguments in both data-first
 *   (`Struct.pick(obj, keys)`) and data-last (`pipe(obj, Struct.pick(keys))`)
 *   style.
 * - **Immutability**: All operations return a new object; the original is
 *   never modified.
 * - **Lambda**: A type-level function interface (`~lambda.in` / `~lambda.out`)
 *   used by {@link map}, {@link mapPick}, and {@link mapOmit} so the compiler
 *   can track how value types change.
 * - **Evolver pattern**: {@link evolve}, {@link evolveKeys}, and
 *   {@link evolveEntries} let you selectively transform values, keys, or both
 *   while leaving untouched properties unchanged.
 *
 * ## Common tasks
 *
 * - Access a property in a pipeline → {@link get}
 * - List string keys with proper types → {@link keys}
 * - Subset / remove properties → {@link pick}, {@link omit}
 * - Merge two structs (second wins) → {@link assign}
 * - Rename keys → {@link renameKeys}
 * - Transform selected values → {@link evolve}
 * - Transform selected keys → {@link evolveKeys}
 * - Transform both keys and values → {@link evolveEntries}
 * - Map all values with a typed lambda → {@link map}, {@link mapPick},
 *   {@link mapOmit}
 * - Compare structs → {@link makeEquivalence}, {@link makeOrder}
 * - Combine / reduce structs → {@link makeCombiner}, {@link makeReducer}
 * - Flatten intersection types → {@link Simplify}
 * - Strip `readonly` modifiers → {@link Mutable}
 *
 * ## Gotchas
 *
 * - {@link keys} only returns `string` keys; symbol keys are excluded.
 * - {@link pick} and {@link omit} iterate with `for...in`, which includes
 *   inherited enumerable properties but excludes non-enumerable ones.
 * - {@link assign} spreads with `...`; property order follows standard
 *   JS spread rules.
 * - {@link map}, {@link mapPick}, {@link mapOmit} require a {@link Lambda}
 *   value created with {@link lambda}; a plain function won't type-check.
 *
 * ## Quickstart
 *
 * **Example** (Picking, renaming, and evolving struct properties)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * const user = { firstName: "Alice", lastName: "Smith", age: 30, admin: false }
 *
 * const result = pipe(
 *   user,
 *   Struct.pick(["firstName", "age"]),
 *   Struct.evolve({ age: (n) => n + 1 }),
 *   Struct.renameKeys({ firstName: "name" })
 * )
 *
 * console.log(result) // { name: "Alice", age: 31 }
 * ```
 *
 * ## See also
 *
 * - {@link Equivalence} – building equivalence relations for structs
 * - `Order` – ordering structs by their fields
 * - {@link Combiner} – combining two values of the same type
 * - {@link Reducer} – combining with an initial value
 *
 * @since 2.0.0
 */

import * as Combiner from "./Combiner.ts"
import * as Equivalence from "./Equivalence.ts"
import { dual } from "./Function.ts"
import * as order from "./Order.ts"
import * as Reducer from "./Reducer.ts"

/**
 * Flattens intersection types into a single object type for readability.
 *
 * **When to use**
 *
 * Use when hovering over a type shows `A & B & C` instead of the merged shape.
 *
 * **Details**
 *
 * This helper is purely cosmetic at the type level and has no runtime effect.
 * It preserves `readonly` modifiers; use {@link Mutable} to strip them.
 *
 * **Example** (Flattening an intersection)
 *
 * ```ts
 * import type { Struct } from "effect"
 *
 * type Original = { a: string } & { b: number }
 *
 * // Without Simplify, the type displays as `{ a: string } & { b: number }`
 * type Simplified = Struct.Simplify<Original>
 * // { a: string; b: number }
 * ```
 *
 * @see {@link Mutable} – also flattens but removes `readonly`
 * @see {@link Assign} – merges two types with right-side precedence
 * @category Type-Level Programming
 * @since 4.0.0
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {}

/**
 * Removes `readonly` modifiers from all properties of an object type.
 *
 * **When to use**
 *
 * Use when you need a mutable version of a readonly interface.
 *
 * **Details**
 *
 * This helper is purely cosmetic at the type level and has no runtime effect.
 * It also flattens intersections like {@link Simplify}.
 *
 * **Example** (Making a readonly type mutable)
 *
 * ```ts
 * import type { Struct } from "effect"
 *
 * type ReadOnly = { readonly a: string; readonly b: number }
 * type Writable = Struct.Mutable<ReadOnly>
 * // { a: string; b: number }
 * ```
 *
 * @see {@link Simplify} – flattens intersections without removing `readonly`
 * @category Type-Level Programming
 * @since 4.0.0
 */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] } & {}

/**
 * Merges two object types with properties from `U` taking precedence over `T`
 * on overlapping keys (like `Object.assign` at the type level).
 *
 * **When to use**
 *
 * Use when you need the type-level equivalent of `{ ...T, ...U }`.
 *
 * **Details**
 *
 * When no keys overlap, this returns a simple intersection for efficiency.
 * When keys overlap, the type from `U` wins.
 *
 * **Example** (Merging two types with overlapping keys)
 *
 * ```ts
 * import type { Struct } from "effect"
 *
 * type A = { a: string; b: number }
 * type B = { b: boolean; c: string }
 * type Merged = Struct.Assign<A, B>
 * // { a: string; b: boolean; c: string }
 * ```
 *
 * @see {@link assign} – the runtime equivalent
 * @see {@link Simplify} – flatten the resulting intersection
 * @category Type-Level Programming
 * @since 4.0.0
 */
export type Assign<T, U> = Simplify<keyof T & keyof U extends never ? T & U : Omit<T, keyof T & keyof U> & U>

/**
 * Retrieves the value at `key` from a struct.
 *
 * **When to use**
 *
 * Use to extract a single property in a pipeline.
 *
 * **Details**
 *
 * The return type is narrowed to `S[K]`.
 *
 * **Example** (Extracting a property in a pipeline)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * const name = pipe({ name: "Alice", age: 30 }, Struct.get("name"))
 * console.log(name) // "Alice"
 * ```
 *
 * @see {@link keys} – list all string keys of a struct
 * @see {@link pick} – extract multiple properties into a new struct
 * @category getters
 * @since 2.0.0
 */
export const get: {
  <S extends object, const K extends keyof S>(key: K): (self: S) => S[K]
  <S extends object, const K extends keyof S>(self: S, key: K): S[K]
} = dual(2, <S extends object, const K extends keyof S>(self: S, key: K): S[K] => self[key])

/**
 * Returns the string keys of a struct as a properly typed `Array<keyof S & string>`.
 *
 * **When to use**
 *
 * Use when you use instead of `Object.keys` when you want the return type narrowed to the
 * known keys of the struct.
 *
 * **Gotchas**
 *
 * Symbol keys are excluded; only string keys are returned.
 *
 * **Example** (Typed keys)
 *
 * ```ts
 * import { Struct } from "effect"
 *
 * const user = { name: "Alice", age: 30, [Symbol.for("id")]: 1 }
 *
 * const k: Array<"name" | "age"> = Struct.keys(user)
 * console.log(k) // ["name", "age"]
 * ```
 *
 * @see {@link get} – access a single key's value
 * @see {@link pick} – select a subset of keys into a new struct
 * @category Key utilities
 * @since 3.6.0
 */
export const keys = <S extends object>(self: S): Array<(keyof S) & string> =>
  Object.keys(self) as Array<(keyof S) & string>

/**
 * Creates a new struct containing only the specified keys.
 *
 * **When to use**
 *
 * Use to narrow a struct down to a subset of its properties.
 *
 * **Gotchas**
 *
 * Keys not present in the struct are silently ignored.
 *
 * **Example** (Selecting specific properties)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * const user = { name: "Alice", age: 30, admin: true }
 * const nameAndAge = pipe(user, Struct.pick(["name", "age"]))
 * console.log(nameAndAge) // { name: "Alice", age: 30 }
 * ```
 *
 * @see {@link omit} – the inverse (exclude keys instead)
 * @see {@link get} – extract a single value
 * @category filtering
 * @since 2.0.0
 */
export const pick: {
  <S extends object, const Keys extends ReadonlyArray<keyof S>>(
    keys: Keys
  ): (self: S) => Simplify<Pick<S, Keys[number]>>
  <S extends object, const Keys extends ReadonlyArray<keyof S>>(self: S, keys: Keys): Simplify<Pick<S, Keys[number]>>
} = dual(
  2,
  <S extends object, const Keys extends ReadonlyArray<keyof S>>(self: S, keys: Keys) => {
    return buildStruct(self, (k, v) => (keys.includes(k) ? [k, v] : undefined))
  }
)

/**
 * Creates a new struct with the specified keys removed.
 *
 * **When to use**
 *
 * Use to exclude sensitive or irrelevant fields from a struct.
 *
 * **Gotchas**
 *
 * Keys not present in the struct are silently ignored.
 *
 * **Example** (Removing a property)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * const user = { name: "Alice", age: 30, password: "secret" }
 * const safe = pipe(user, Struct.omit(["password"]))
 * console.log(safe) // { name: "Alice", age: 30 }
 * ```
 *
 * @see {@link pick} – the inverse (keep only specified keys)
 * @category filtering
 * @since 2.0.0
 */
export const omit: {
  <S extends object, const Keys extends ReadonlyArray<keyof S>>(
    keys: Keys
  ): (self: S) => Simplify<Omit<S, Keys[number]>>
  <S extends object, const Keys extends ReadonlyArray<keyof S>>(self: S, keys: Keys): Simplify<Omit<S, Keys[number]>>
} = dual(
  2,
  <S extends object, Keys extends ReadonlyArray<keyof S>>(self: S, keys: Keys) => {
    return buildStruct(self, (k, v) => (!keys.includes(k) ? [k, v] : undefined))
  }
)

/**
 * Merges two structs into a new struct. When both structs share a key, the
 * value from `that` (the second struct) wins.
 *
 * **When to use**
 *
 * Use when you want `{ ...self, ...that }` with proper types.
 *
 * **Details**
 *
 * The result type is `Simplify<Assign<S, O>>`.
 *
 * **Example** (Merging structs with overlapping keys)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * const defaults = { theme: "light", lang: "en" }
 * const overrides = { theme: "dark", fontSize: 14 }
 * const config = pipe(defaults, Struct.assign(overrides))
 * console.log(config) // { theme: "dark", lang: "en", fontSize: 14 }
 * ```
 *
 * @see {@link Assign} – the type-level equivalent
 * @see {@link evolve} – transform individual values instead of replacing them
 * @category combining
 * @since 4.0.0
 */
export const assign: {
  <O extends object>(that: O): <S extends object>(self: S) => Assign<S, O>
  <O extends object, S extends object>(self: S, that: O): Assign<S, O>
} = dual(
  2,
  <O extends object, S extends object>(self: S, that: O) => {
    return { ...self, ...that }
  }
)

type Evolver<S> = { readonly [K in keyof S]?: (a: S[K]) => unknown }

type Evolved<S, E> = Simplify<
  { [K in keyof S]: K extends keyof E ? (E[K] extends (...a: any) => infer R ? R : S[K]) : S[K] }
>

/**
 * Transforms values of a struct selectively using per-key functions. Keys
 * without a corresponding function are copied unchanged.
 *
 * **When to use**
 *
 * Use when you want to update specific fields while keeping the rest intact.
 *
 * **Details**
 *
 * Each transform function receives the current value and returns the new value;
 * the return type can differ from the input type.
 *
 * **Example** (Transforming selected values)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * const result = pipe(
 *   { name: "alice", age: 30, active: true },
 *   Struct.evolve({
 *     name: (s) => s.toUpperCase(),
 *     age: (n) => n + 1
 *   })
 * )
 * console.log(result) // { name: "ALICE", age: 31, active: true }
 * ```
 *
 * @see {@link evolveKeys} – transform keys instead of values
 * @see {@link evolveEntries} – transform both keys and values
 * @see {@link map} – apply the same transformation to all values
 * @category transforming
 * @since 2.0.0
 */
export const evolve: {
  <S extends object, E extends Evolver<S>>(e: E): (self: S) => Evolved<S, E>
  <S extends object, E extends Evolver<S>>(self: S, e: E): Evolved<S, E>
} = dual(
  2,
  <S extends object, E extends Evolver<S>>(self: S, e: E): Evolved<S, E> => {
    return buildStruct(self, (k, v) => [k, Object.hasOwn(e, k) ? (e as any)[k](v) : v])
  }
)

type KeyEvolver<S> = { readonly [K in keyof S]?: (k: K) => PropertyKey }

type KeyEvolved<S, E> = Simplify<
  { [K in keyof S as K extends keyof E ? (E[K] extends ((k: K) => infer R extends PropertyKey) ? R : K) : K]: S[K] }
>

/**
 * Transforms keys of a struct selectively using per-key functions. Keys without
 * a corresponding function are copied unchanged.
 *
 * **When to use**
 *
 * Use when you need computed key names, such as uppercasing or prefixing.
 *
 * **Details**
 *
 * Each transform function receives the key name and must return a new
 * `PropertyKey`.
 *
 * **Example** (Renaming keys with functions)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * const result = pipe(
 *   { name: "Alice", age: 30 },
 *   Struct.evolveKeys({
 *     name: (k) => k.toUpperCase()
 *   })
 * )
 * console.log(result) // { NAME: "Alice", age: 30 }
 * ```
 *
 * @see {@link renameKeys} – rename keys with a static mapping
 * @see {@link evolve} – transform values instead of keys
 * @see {@link evolveEntries} – transform both keys and values
 * @category Key utilities
 * @since 4.0.0
 */
export const evolveKeys: {
  <S extends object, E extends KeyEvolver<S>>(e: E): (self: S) => KeyEvolved<S, E>
  <S extends object, E extends KeyEvolver<S>>(self: S, e: E): KeyEvolved<S, E>
} = dual(
  2,
  <S extends object, E extends KeyEvolver<S>>(self: S, e: E): KeyEvolved<S, E> => {
    return buildStruct(self, (k, v) => [Object.hasOwn(e, k) ? (e as any)[k](k) : k, v])
  }
)

type EntryEvolver<S> = { readonly [K in keyof S]?: (k: K, v: S[K]) => [PropertyKey, unknown] }

type EntryEvolved<S, E> = {
  [
    K in keyof S as K extends keyof E ?
      E[K] extends ((k: K, v: S[K]) => [infer NK extends PropertyKey, infer _V]) ? NK : K
      : K
  ]: K extends keyof E ? E[K] extends ((k: K, v: S[K]) => [infer _NK, infer V]) ? V
    : S[K] :
    S[K]
}

/**
 * Transforms both keys and values of a struct selectively. Each per-key
 * function receives `(key, value)` and must return a `[newKey, newValue]`
 * tuple. Keys without a corresponding function are copied unchanged.
 *
 * **When to use**
 *
 * Use when you need to rename a key and change its value in one step.
 *
 * **Details**
 *
 * The return type is fully tracked at the type level.
 *
 * **Example** (Transforming keys and values together)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * const result = pipe(
 *   { amount: 100, label: "total" },
 *   Struct.evolveEntries({
 *     amount: (k, v) => [`${k}Cents`, v * 100],
 *     label: (k, v) => [k, v.toUpperCase()]
 *   })
 * )
 * console.log(result) // { amountCents: 10000, label: "TOTAL" }
 * ```
 *
 * @see {@link evolve} – transform values only
 * @see {@link evolveKeys} – transform keys only
 * @category utils
 * @since 4.0.0
 */
export const evolveEntries: {
  <S extends object, E extends EntryEvolver<S>>(e: E): (self: S) => EntryEvolved<S, E>
  <S extends object, E extends EntryEvolver<S>>(self: S, e: E): EntryEvolved<S, E>
} = dual(
  2,
  <S extends object, E extends EntryEvolver<S>>(self: S, e: E): EntryEvolved<S, E> => {
    return buildStruct(self, (k, v) => (Object.hasOwn(e, k) ? (e as any)[k](k, v) : [k, v]))
  }
)

/**
 * Renames keys in a struct using a static `{ oldKey: newKey }` mapping. Keys
 * not mentioned in the mapping are copied unchanged.
 *
 * **When to use**
 *
 * Use when you need simple, declarative key renaming without custom logic.
 *
 * **Details**
 *
 * For computed key names, use {@link evolveKeys} instead.
 *
 * **Example** (Renaming keys)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * const result = pipe(
 *   { firstName: "Alice", lastName: "Smith", age: 30 },
 *   Struct.renameKeys({ firstName: "first", lastName: "last" })
 * )
 * console.log(result) // { first: "Alice", last: "Smith", age: 30 }
 * ```
 *
 * @see {@link evolveKeys} – rename keys using functions
 * @see {@link evolveEntries} – rename keys and transform values
 * @category Key utilities
 * @since 4.0.0
 */
export const renameKeys: {
  <S extends object, const M extends { readonly [K in keyof S]?: PropertyKey }>(
    mapping: M
  ): (self: S) => { [K in keyof S as K extends keyof M ? M[K] extends PropertyKey ? M[K] : K : K]: S[K] }
  <S extends object, const M extends { readonly [K in keyof S]?: PropertyKey }>(
    self: S,
    mapping: M
  ): { [K in keyof S as K extends keyof M ? M[K] extends PropertyKey ? M[K] : K : K]: S[K] }
} = dual(2, <S extends object, const M extends { readonly [K in keyof S]?: PropertyKey }>(self: S, mapping: M) => {
  return buildStruct(self, (k, v) => [Object.hasOwn(mapping, k) ? mapping[k]! : k, v])
})

/**
 * Creates an `Equivalence` for a struct by providing an `Equivalence` for each
 * property. Two structs are equivalent when all their corresponding properties
 * are equivalent.
 *
 * **When to use**
 *
 * Use when you need to compare structs property-by-property.
 *
 * **Details**
 *
 * This is an alias of `Equivalence.Struct`. Each property's equivalence is
 * checked independently; all must return `true` for the overall result to be
 * `true`.
 *
 * **Example** (Comparing structs for equivalence)
 *
 * ```ts
 * import { Equivalence, Struct } from "effect"
 *
 * const PersonEquivalence = Struct.makeEquivalence({
 *   name: Equivalence.strictEqual<string>(),
 *   age: Equivalence.strictEqual<number>()
 * })
 *
 * console.log(PersonEquivalence({ name: "Alice", age: 30 }, { name: "Alice", age: 30 }))
 * // true
 * console.log(PersonEquivalence({ name: "Alice", age: 30 }, { name: "Bob", age: 30 }))
 * // false
 * ```
 *
 * @see {@link makeOrder} – create an `Order` for structs
 * @category Equivalence
 * @since 4.0.0
 */
export const makeEquivalence = Equivalence.Struct

/**
 * Creates an `Order` for a struct by providing an `Order` for each property.
 * Properties are compared in the order they appear in the fields object; the
 * first non-zero comparison determines the result.
 *
 * **When to use**
 *
 * Use to sort or compare structs by multiple fields with lexicographic
 * priority.
 *
 * **Details**
 *
 * This is an alias of `Order.Struct`. The order of keys in the `fields` object
 * determines comparison priority.
 *
 * **Example** (Ordering structs by name then age)
 *
 * ```ts
 * import { Number, String, Struct } from "effect"
 *
 * const PersonOrder = Struct.makeOrder({
 *   name: String.Order,
 *   age: Number.Order
 * })
 *
 * console.log(PersonOrder({ name: "Alice", age: 30 }, { name: "Bob", age: 25 }))
 * // -1 (Alice comes before Bob)
 * ```
 *
 * @see {@link makeEquivalence} – create an `Equivalence` for structs
 * @category Ordering
 * @since 4.0.0
 */
export const makeOrder = order.Struct

/**
 * Interface for type-level functions used by {@link map}, {@link mapPick}, and
 * {@link mapOmit}.
 *
 * **When to use**
 *
 * Use when you use this interface when defining a typed function for {@link map},
 * {@link mapPick}, or {@link mapOmit}.
 *
 * **Details**
 *
 * Extend this interface with concrete `~lambda.in` and `~lambda.out` types to
 * describe how a function transforms values at the type level. At runtime,
 * create lambda values with {@link lambda}.
 *
 * **Example** (Defining a lambda type)
 *
 * ```ts
 * import type { Struct } from "effect"
 *
 * interface ToString extends Struct.Lambda {
 *   readonly "~lambda.out": string
 * }
 * ```
 *
 * @see {@link Apply} – apply a Lambda to a concrete type
 * @see {@link lambda} – create a runtime lambda value
 * @see {@link map} – use a lambda to transform all struct values
 * @category Lambda
 * @since 4.0.0
 */
export interface Lambda {
  readonly "~lambda.in": unknown
  readonly "~lambda.out": unknown
}

/**
 * Applies a {@link Lambda} type-level function to a value type `V`, producing
 * the output type.
 *
 * **When to use**
 *
 * Use when you need to compute what type a Lambda would produce for a
 * given input.
 *
 * **Details**
 *
 * This works by intersecting the Lambda with `{ "~lambda.in": V }` and reading
 * `"~lambda.out"`.
 *
 * **Example** (Computing the output type of a lambda)
 *
 * ```ts
 * import type { Struct } from "effect"
 *
 * interface ToString extends Struct.Lambda {
 *   readonly "~lambda.out": string
 * }
 *
 * // Result is `string`
 * type Result = Struct.Apply<ToString, number>
 * ```
 *
 * @see {@link Lambda} – the base interface
 * @category Lambda
 * @since 4.0.0
 */
export type Apply<L extends Lambda, V> = (L & { readonly "~lambda.in": V })["~lambda.out"]

/**
 * Wraps a plain function as a {@link Lambda} value so it can be used with
 * {@link map}, {@link mapPick}, and {@link mapOmit}.
 *
 * **When to use**
 *
 * Use to create a typed lambda for struct mapping APIs that need type-level
 * input and output tracking.
 *
 * **Details**
 *
 * The type parameter `L` encodes both the input and output types at the type
 * level, allowing the compiler to track how struct value types change. At
 * runtime, the returned value is the same function; `lambda` only adjusts the
 * type.
 *
 * **Example** (Wrapping values in arrays)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * interface AsArray extends Struct.Lambda {
 *   <A>(self: A): Array<A>
 *   readonly "~lambda.out": Array<this["~lambda.in"]>
 * }
 *
 * const asArray = Struct.lambda<AsArray>((a) => [a])
 * const result = pipe({ x: 1, y: "hello" }, Struct.map(asArray))
 * console.log(result) // { x: [1], y: ["hello"] }
 * ```
 *
 * @see {@link Lambda} – the type-level interface
 * @see {@link map} – apply a lambda to all struct values
 * @category Lambda
 * @since 4.0.0
 */
export const lambda = <L extends (a: any) => any>(
  f: (a: Parameters<L>[0]) => ReturnType<L>
): L => f as any

/**
 * Applies a {@link Lambda} transformation to every value in a struct.
 *
 * **When to use**
 *
 * Use when you want to apply the same function to every value in a struct.
 *
 * **Details**
 *
 * The lambda must be created with {@link lambda} so the compiler can track the
 * output types.
 *
 * **Example** (Wrapping every value in an array)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * interface AsArray extends Struct.Lambda {
 *   <A>(self: A): Array<A>
 *   readonly "~lambda.out": Array<this["~lambda.in"]>
 * }
 *
 * const asArray = Struct.lambda<AsArray>((a) => [a])
 * const result = pipe({ width: 10, height: 20 }, Struct.map(asArray))
 * console.log(result) // { width: [10], height: [20] }
 * ```
 *
 * @see {@link mapPick} – apply a lambda only to selected keys
 * @see {@link mapOmit} – apply a lambda to all keys except selected ones
 * @see {@link evolve} – apply different functions to different keys
 * @category mapping
 * @since 4.0.0
 */
export const map: {
  <L extends Lambda>(
    lambda: L
  ): <S extends object>(self: S) => { [K in keyof S]: Apply<L, S[K]> }
  <S extends object, L extends Lambda>(
    self: S,
    lambda: L
  ): { [K in keyof S]: Apply<L, S[K]> }
} = dual(
  2,
  <S extends object, L extends Function>(self: S, lambda: L) => {
    return buildStruct(self, (k, v) => [k, lambda(v)])
  }
)

/**
 * Applies a {@link Lambda} transformation only to the specified keys; all
 * other keys are copied unchanged.
 *
 * **When to use**
 *
 * Use when you want to apply the same transformation to a subset of properties.
 *
 * **Example** (Wrapping only selected values in arrays)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * interface AsArray extends Struct.Lambda {
 *   <A>(self: A): Array<A>
 *   readonly "~lambda.out": Array<this["~lambda.in"]>
 * }
 *
 * const asArray = Struct.lambda<AsArray>((a) => [a])
 * const result = pipe(
 *   { x: 1, y: 2, z: 3 },
 *   Struct.mapPick(["x", "z"], asArray)
 * )
 * console.log(result) // { x: [1], y: 2, z: [3] }
 * ```
 *
 * @see {@link map} – apply a lambda to all keys
 * @see {@link mapOmit} – apply a lambda to all keys except selected ones
 * @category mapping
 * @since 4.0.0
 */
export const mapPick: {
  <S extends object, const Keys extends ReadonlyArray<keyof S>, L extends Lambda>(
    keys: Keys,
    lambda: L
  ): (
    self: S
  ) => { [K in keyof S]: K extends Keys[number] ? Apply<L, S[K]> : S[K] }
  <S extends object, const Keys extends ReadonlyArray<keyof S>, L extends Lambda>(
    self: S,
    keys: Keys,
    lambda: L
  ): { [K in keyof S]: K extends Keys[number] ? Apply<L, S[K]> : S[K] }
} = dual(
  3,
  <S extends object, const Keys extends ReadonlyArray<keyof S>, L extends Function>(
    self: S,
    keys: Keys,
    lambda: L
  ) => {
    return buildStruct(self, (k, v) => [k, keys.includes(k) ? lambda(v) : v])
  }
)

/**
 * Applies a {@link Lambda} transformation to all keys except the specified
 * ones; the excluded keys are copied unchanged.
 *
 * **When to use**
 *
 * Use when most keys should be transformed but a few should be preserved.
 *
 * **Example** (Wrapping all values except one in arrays)
 *
 * ```ts
 * import { pipe, Struct } from "effect"
 *
 * interface AsArray extends Struct.Lambda {
 *   <A>(self: A): Array<A>
 *   readonly "~lambda.out": Array<this["~lambda.in"]>
 * }
 *
 * const asArray = Struct.lambda<AsArray>((a) => [a])
 * const result = pipe(
 *   { x: 1, y: 2, z: 3 },
 *   Struct.mapOmit(["y"], asArray)
 * )
 * console.log(result) // { x: [1], y: 2, z: [3] }
 * ```
 *
 * @see {@link map} – apply a lambda to all keys
 * @see {@link mapPick} – apply a lambda only to selected keys
 * @category mapping
 * @since 4.0.0
 */
export const mapOmit: {
  <S extends object, const Keys extends ReadonlyArray<keyof S>, L extends Lambda>(
    keys: Keys,
    lambda: L
  ): (
    self: S
  ) => { [K in keyof S]: K extends Keys[number] ? S[K] : Apply<L, S[K]> }
  <S extends object, const Keys extends ReadonlyArray<keyof S>, L extends Lambda>(
    self: S,
    keys: Keys,
    lambda: L
  ): { [K in keyof S]: K extends Keys[number] ? S[K] : Apply<L, S[K]> }
} = dual(
  3,
  <S extends object, const Keys extends ReadonlyArray<keyof S>, L extends Function>(
    self: S,
    keys: Keys,
    lambda: L
  ) => {
    return buildStruct(self, (k, v) => [k, !keys.includes(k) ? lambda(v) : v])
  }
)

/**
 * Walk `source`; for each key decide what to emit via the small callback.
 *
 * The callback returns either
 *   • `undefined`  → nothing is copied, or
 *   • `[newKey, newVal]`
 *
 * so every public API just supplies a different callback.
 */
function buildStruct<
  S extends object,
  f extends (k: keyof S, v: S[keyof S]) => [PropertyKey, unknown] | undefined
>(
  source: S,
  f: f
): any {
  const out: Record<PropertyKey, unknown> = {}
  for (const k in source) {
    const res = f(k, source[k])
    if (res) {
      const [nk, nv] = res
      out[nk] = nv
    }
  }
  return out
}

/**
 * Creates a `Combiner` for a struct shape by providing a `Combiner` for each
 * property. When two structs are combined, each property is merged using its
 * corresponding combiner.
 *
 * **When to use**
 *
 * Use when you need to merge two structs of the same shape, such as summing
 * counters or concatenating strings.
 *
 * **Details**
 *
 * Pass `omitKeyWhen` to drop properties whose merged value matches a predicate,
 * such as omitting zero counters.
 *
 * **Example** (Combining struct properties)
 *
 * ```ts
 * import { Number, String, Struct } from "effect"
 *
 * const C = Struct.makeCombiner<{ readonly n: number; readonly s: string }>({
 *   n: Number.ReducerSum,
 *   s: String.ReducerConcat
 * })
 *
 * const result = C.combine({ n: 1, s: "hello" }, { n: 2, s: " world" })
 * console.log(result) // { n: 3, s: "hello world" }
 * ```
 *
 * @see {@link makeReducer} – like `makeCombiner` but with an initial value
 * @category combining
 * @since 4.0.0
 */
export function makeCombiner<A>(
  combiners: { readonly [K in keyof A]: Combiner.Combiner<A[K]> },
  options?: {
    readonly omitKeyWhen?: ((a: A[keyof A]) => boolean) | undefined
  }
): Combiner.Combiner<A> {
  const omitKeyWhen = options?.omitKeyWhen ?? (() => false)
  return Combiner.make((self, that) => {
    const keys = Reflect.ownKeys(combiners) as Array<keyof A>
    const out = {} as A
    for (const key of keys) {
      const merge = combiners[key].combine(self[key], that[key])
      if (omitKeyWhen(merge)) continue
      out[key] = merge
    }
    return out
  })
}

/**
 * Creates a `Reducer` for a struct shape by providing a `Reducer` for each
 * property. The initial value is derived from each property's
 * `Reducer.initialValue`. When reducing a collection of structs, each property
 * is combined independently.
 *
 * **When to use**
 *
 * Use to fold a collection of structs into a single summary struct.
 *
 * **Details**
 *
 * Pass `omitKeyWhen` to drop properties whose reduced value matches a
 * predicate.
 *
 * **Example** (Reducing a collection of structs)
 *
 * ```ts
 * import { Number, String, Struct } from "effect"
 *
 * const R = Struct.makeReducer<{ readonly n: number; readonly s: string }>({
 *   n: Number.ReducerSum,
 *   s: String.ReducerConcat
 * })
 *
 * const result = R.combineAll([
 *   { n: 1, s: "a" },
 *   { n: 2, s: "b" },
 *   { n: 3, s: "c" }
 * ])
 * console.log(result) // { n: 6, s: "abc" }
 * ```
 *
 * @see {@link makeCombiner} – like `makeReducer` but without an initial value
 * @category folding
 * @since 4.0.0
 */
export function makeReducer<A>(
  reducers: { readonly [K in keyof A]: Reducer.Reducer<A[K]> },
  options?: {
    readonly omitKeyWhen?: ((a: A[keyof A]) => boolean) | undefined
  }
): Reducer.Reducer<A> {
  const combine = makeCombiner(reducers, options).combine
  const initialValue = {} as A
  for (const key of Reflect.ownKeys(reducers) as Array<keyof A>) {
    const iv = reducers[key].initialValue
    if (options?.omitKeyWhen?.(iv)) continue
    initialValue[key] = iv
  }
  return Reducer.make(combine, initialValue)
}

/**
 * Creates a record with the given keys and value.
 *
 * **When to use**
 *
 * Use to build an object where each provided key receives the same value.
 *
 * **Example** (Creating a record)
 *
 * ```ts
 * import { Struct } from "effect"
 *
 * const record = Struct.Record(["a", "b"], "value")
 * console.log(record) // { a: "value", b: "value" }
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export function Record<const Keys extends ReadonlyArray<string | symbol>, Value>(
  keys: Keys,
  value: Value
): Record<Keys[number], Value> {
  const out: any = {}
  for (const key of keys) {
    out[key] = value
  }
  return out
}
