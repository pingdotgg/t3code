/**
 * Tools for working with JavaScript regular expressions from the Effect module
 * namespace. The module exposes the native `RegExp` constructor, a guard for
 * narrowing unknown values, and escaping for literal text that will be embedded
 * in a pattern.
 *
 * Reach for `RegExp` when you need to build a regular expression from user or
 * data-driven text, check whether an unknown value is already a `RegExp`, or
 * access the native constructor without leaving the Effect namespace.
 *
 * **Common tasks**
 *
 * - Construct expressions with the native constructor: {@link RegExp}
 * - Narrow unknown input to `RegExp`: {@link isRegExp}
 * - Escape literal text before interpolating it into a pattern: {@link escape}
 *
 * **Gotchas**
 *
 * - {@link escape} only escapes regular expression metacharacters in a string.
 *   It does not add anchors, flags, grouping, or validation for a full pattern.
 *
 * **Quickstart**
 *
 * **Example** (Matching literal text)
 *
 * ```ts
 * import { RegExp } from "effect"
 *
 * const literal = "a+b.txt"
 * const expression = new RegExp.RegExp(`^${RegExp.escape(literal)}$`)
 *
 * console.log(expression.test("a+b.txt")) // true
 * console.log(expression.test("aaab.txt")) // false
 * console.log(RegExp.isRegExp(expression)) // true
 * ```
 *
 * @since 2.0.0
 */
import * as predicate from "./Predicate.ts"

/**
 * Exposes the JavaScript regular expression constructor from `globalThis`.
 *
 * **When to use**
 *
 * Use to construct JavaScript regular expressions through the Effect module
 * namespace.
 *
 * **Example** (Creating a regular expression)
 *
 * ```ts
 * import { RegExp } from "effect"
 *
 * // Create a regular expression using Effect's RegExp constructor
 * const pattern = new RegExp.RegExp("hello", "i")
 *
 * // Test the pattern
 * console.log(pattern.test("Hello World")) // true
 * console.log(pattern.test("goodbye")) // false
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const RegExp = globalThis.RegExp

/**
 * Checks whether a value is a `RegExp`.
 *
 * **When to use**
 *
 * Use to validate unknown input before treating it as a regular expression.
 *
 * **Example** (Checking for regular expressions)
 *
 * ```ts
 * import { RegExp } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(RegExp.isRegExp(/a/), true)
 * assert.deepStrictEqual(RegExp.isRegExp("a"), false)
 * ```
 *
 * @category guards
 * @since 3.9.0
 */
export const isRegExp: (input: unknown) => input is RegExp = predicate.isRegExp

/**
 * Escapes special characters in a regular expression pattern.
 *
 * **When to use**
 *
 * Use to turn literal text into a safe regular expression pattern fragment.
 *
 * **Example** (Escaping a pattern string)
 *
 * ```ts
 * import { RegExp } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(RegExp.escape("a*b"), "a\\*b")
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const escape = (string: string): string => string.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")
