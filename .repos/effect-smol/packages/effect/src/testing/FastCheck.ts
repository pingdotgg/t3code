/**
 * Re-exports `fast-check` for property-based testing.
 *
 * Property-based tests describe a rule that should hold for many inputs, and
 * `fast-check` generates random examples to look for counterexamples. This
 * module exposes the library from `effect/testing` so tests can use it alongside
 * the other Effect testing helpers.
 *
 * @since 3.10.0
 */

/**
 * Re-exports all functionality from the fast-check library, providing access to
 * property-based testing utilities including arbitraries, property testing,
 * and random data generation.
 *
 * Fast-check allows you to write tests by specifying properties that should hold
 * true for your functions, rather than writing specific test cases. The library
 * then generates many random inputs to verify these properties.
 *
 * **Example** (Checking an array reversal property)
 *
 * ```ts import.meta.vitest
 * import { FastCheck } from "effect/testing"
 *
 * // Property: reverse of reverse should equal original
 * const reverseProp = FastCheck.property(
 *   FastCheck.array(FastCheck.integer()),
 *   (arr: Array<number>) => {
 *     const reversed = arr.slice().reverse()
 *     const doubleReversed = reversed.slice().reverse()
 *     return arr.length === doubleReversed.length &&
 *       arr.every((value, index) => value === doubleReversed[index])
 *   }
 * )
 *
 * // Run the property test
 * FastCheck.assert(reverseProp, { seed: 1, numRuns: 100 }) // => undefined
 * ```
 *
 * **Example** (Checking string concatenation properties)
 *
 * ```ts import.meta.vitest
 * import { FastCheck } from "effect/testing"
 *
 * // Test string concatenation properties
 * const concatProp = FastCheck.property(
 *   FastCheck.string(),
 *   FastCheck.string(),
 *   (a: string, b: string) => {
 *     const result = a + b
 *     return result.length === a.length + b.length &&
 *       result.startsWith(a) &&
 *       result.endsWith(b)
 *   }
 * )
 *
 * FastCheck.assert(concatProp, { seed: 2, numRuns: 100 }) // => undefined
 * ```
 *
 * **Example** (Generating record data for properties)
 *
 * ```ts import.meta.vitest
 * import { FastCheck } from "effect/testing"
 *
 * // Generate random data for testing
 * const personArbitrary = FastCheck.record({
 *   name: FastCheck.string({ minLength: 1 }),
 *   age: FastCheck.integer({ min: 0, max: 120 }),
 *   email: FastCheck.emailAddress()
 * })
 *
 * // Use in property tests
 * const validPersonProp = FastCheck.property(
 *   personArbitrary,
 *   (person: { name: string; age: number; email: string }) => {
 *     return person.name.length > 0 &&
 *       person.age >= 0 &&
 *       person.age <= 120 &&
 *       person.email.includes("@")
 *   }
 * )
 *
 * FastCheck.assert(validPersonProp, { seed: 3, numRuns: 100 }) // => undefined
 * ```
 *
 * @category re-exports
 * @since 3.10.0
 */
export * from "fast-check"
