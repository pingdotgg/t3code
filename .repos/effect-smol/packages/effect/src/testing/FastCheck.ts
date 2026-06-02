/**
 * This module provides a re-export of the fast-check library for property-based testing.
 * Fast-check is a property-based testing framework that generates random test cases
 * to validate that properties hold true for a wide range of inputs.
 *
 * Property-based testing is a testing methodology where you specify properties that
 * should hold true for your functions, and the framework generates many random test
 * cases to try to find counterexamples.
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
 * ```ts
 * import { FastCheck } from "effect/testing"
 *
 * // Property: reverse of reverse should equal original
 * const reverseProp = FastCheck.property(
 *   FastCheck.array(FastCheck.integer()),
 *   (arr: Array<number>) => {
 *     const reversed = arr.slice().reverse()
 *     const doubleReversed = reversed.slice().reverse()
 *     return JSON.stringify(arr) === JSON.stringify(doubleReversed)
 *   }
 * )
 *
 * // Run the property test
 * FastCheck.assert(reverseProp)
 * ```
 *
 * **Example** (Checking string concatenation properties)
 *
 * ```ts
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
 * FastCheck.assert(concatProp)
 * ```
 *
 * **Example** (Generating record data for properties)
 *
 * ```ts
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
 * FastCheck.assert(validPersonProp)
 * ```
 *
 * @category re-exports
 * @since 3.10.0
 */
export * from "fast-check"
