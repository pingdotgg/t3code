/**
 * The `Symbol` module contains the runtime predicate for JavaScript primitive
 * `symbol` values. It is most useful at boundaries where a value is `unknown`
 * and must be narrowed before it can be used as a symbol key, identifier, or
 * discriminant.
 *
 * **Mental model**
 *
 * - {@link isSymbol} checks `typeof value === "symbol"`
 * - Symbols created with `globalThis.Symbol()` or `globalThis.Symbol.for(...)`
 *   satisfy the predicate
 * - Boxed symbols such as `Object(globalThis.Symbol())` are objects, so they do
 *   not satisfy the predicate
 *
 * **Example** (Narrowing unknown input)
 *
 * ```ts
 * import { Symbol } from "effect"
 *
 * const describe = (value: unknown) =>
 *   Symbol.isSymbol(value) ? value.description : "not a symbol"
 * ```
 *
 * @since 2.0.0
 */

import * as predicate from "./Predicate.ts"

/**
 * Checks whether a value is a `symbol`.
 *
 * **When to use**
 *
 * Use to validate unknown input before treating it as a JavaScript `symbol`.
 *
 * **Example** (Checking for symbols)
 *
 * ```ts
 * import { Symbol } from "effect"
 *
 * console.log(Symbol.isSymbol(globalThis.Symbol.for("a"))) // true
 * console.log(Symbol.isSymbol("a")) // false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isSymbol: (u: unknown) => u is symbol = predicate.isSymbol
