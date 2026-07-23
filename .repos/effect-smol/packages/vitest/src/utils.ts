/**
 * Assertion helpers used by `@effect/vitest` tests.
 *
 * This module extends Node and Vitest assertions with Effect-aware checks for
 * values commonly returned by the library: `Option`, `Result`, and `Exit`. The
 * helpers are synchronous assertions except `throwsAsync`, and are intended to
 * be used after a test has already produced the value to inspect.
 *
 * **Mental model**
 *
 * `@effect/vitest` supplies the test runner integration, while this module
 * supplies small value-level assertions. Use `it.effect` to run Effects and
 * then call these helpers on yielded results; use ordinary Vitest tests for pure
 * synchronous code.
 *
 * **Common tasks**
 *
 * Use `assertEquals` when equality should follow Effect's `Equal` trait, Node
 * `strictEqual` or `deepStrictEqual` for JavaScript equality, `assertSome` and
 * `assertNone` for `Option`, `assertSuccess` and `assertFailure` for `Result`,
 * and `assertExitSuccess` or `assertExitFailure` when an Effect has been run to
 * an `Exit`.
 *
 * **Gotchas**
 *
 * These helpers throw assertion errors; they do not run Effects, provide test
 * services, or advance `TestClock`. Failed `assertEquals` checks first delegate
 * to `deepStrictEqual` so Vitest can show a structural diff before reporting the
 * `Equal.equals` mismatch.
 *
 * @since 4.0.0
 */
import type * as Cause from "effect/Cause"
import * as Equal from "effect/Equal"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as assert from "node:assert"
import { assert as vassert } from "vitest"

// ----------------------------
// Primitives
// ----------------------------

/**
 * Fails the current test with the provided error message.
 *
 * @category testing
 * @since 4.0.0
 */
export function fail(message: string) {
  assert.fail(message)
}

/**
 * Asserts that `actual` is deeply strictly equal to `expected` using Node's `assert.deepStrictEqual`.
 *
 * @category testing
 * @since 4.0.0
 */
export function deepStrictEqual<A>(actual: A, expected: A, message?: string, ..._: Array<never>) {
  assert.deepStrictEqual(actual, expected, message)
}

/**
 * Asserts that `actual` is not deeply strictly equal to `expected` using Node's `assert.notDeepStrictEqual`.
 *
 * @category testing
 * @since 4.0.0
 */
export function notDeepStrictEqual<A>(actual: A, expected: A, message?: string, ..._: Array<never>) {
  assert.notDeepStrictEqual(actual, expected, message)
}

/**
 * Asserts that `actual` is strictly equal to `expected` using Node's `assert.strictEqual`.
 *
 * @category testing
 * @since 4.0.0
 */
export function strictEqual<A>(actual: A, expected: A, message?: string, ..._: Array<never>) {
  assert.strictEqual(actual, expected, message)
}

/**
 * Asserts that `actual` is equal to `expected` using the `Equal.equals` trait.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertEquals<A>(actual: A, expected: A, message?: string, ..._: Array<never>) {
  if (!Equal.equals(actual, expected)) {
    deepStrictEqual(actual, expected, message) // show diff
    fail(message ?? "Expected values to be Equal.equals")
  }
}

/**
 * Asserts that `thunk` does not throw an error.
 *
 * @category testing
 * @since 4.0.0
 */
export function doesNotThrow(thunk: () => void, message?: string, ..._: Array<never>) {
  assert.doesNotThrow(thunk, message)
}

// ----------------------------
// Derived
// ----------------------------

/**
 * Asserts that `value` is an instance of `constructor`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertInstanceOf<C extends abstract new(...args: any) => any>(
  value: unknown,
  constructor: C,
  message?: string,
  ..._: Array<never>
): asserts value is InstanceType<C> {
  vassert.instanceOf(value, constructor as any, message)
}

/**
 * Asserts that `self` is `true`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertTrue(self: unknown, message?: string, ..._: Array<never>): asserts self {
  strictEqual(self, true, message)
}

/**
 * Asserts that `self` is `false`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertFalse(self: boolean, message?: string, ..._: Array<never>) {
  strictEqual(self, false, message)
}

/**
 * Asserts that `actual` includes `expected`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertInclude(actual: string | undefined, expected: string, ..._: Array<never>) {
  if (typeof expected === "string") {
    if (!actual?.includes(expected)) {
      fail(`Expected\n\n${actual}\n\nto include\n\n${expected}`)
    }
  }
}

/**
 * Asserts that `actual` matches `regExp`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertMatch(actual: string, regExp: RegExp, ..._: Array<never>) {
  if (!regExp.test(actual)) {
    fail(`Expected\n\n${actual}\n\nto match\n\n${regExp}`)
  }
}

/**
 * Asserts that `thunk` throws, optionally checking the thrown value against an expected `Error` or validation function.
 *
 * @category testing
 * @since 4.0.0
 */
export function throws(thunk: () => void, error?: Error | ((u: unknown) => undefined), ..._: Array<never>) {
  try {
    thunk()
    fail("Expected to throw an error")
  } catch (e) {
    if (error !== undefined) {
      if (Predicate.isFunction(error)) {
        error(e)
      } else if (error) {
        deepStrictEqual(e, error)
      } else {
        throw e
      }
    }
  }
}

/**
 * Asserts that `thunk` throws or returns a rejected promise, optionally checking the failure value against an expected `Error` or validation function.
 *
 * @category testing
 * @since 4.0.0
 */
export async function throwsAsync(
  thunk: () => Promise<void>,
  error?: Error | ((u: unknown) => undefined),
  ..._: Array<never>
) {
  try {
    await thunk()
    fail("Expected to throw an error")
  } catch (e) {
    if (error !== undefined) {
      if (Predicate.isFunction(error)) {
        error(e)
      } else {
        deepStrictEqual(e, error)
      }
    }
  }
}

// ----------------------------
// Option
// ----------------------------

/**
 * Asserts that `option` is `None`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertNone<A>(option: Option.Option<A>, ..._: Array<never>): asserts option is Option.None<never> {
  deepStrictEqual(option, Option.none())
}

/**
 * Asserts that `a` is not `undefined`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertDefined<A>(
  a: A | undefined,
  ..._: Array<never>
): asserts a is Exclude<A, undefined> {
  if (a === undefined) {
    fail("Expected value to be defined")
  }
}

/**
 * Asserts that `a` is `undefined`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertUndefined<A>(
  a: A | undefined,
  ..._: Array<never>
): asserts a is undefined {
  if (a !== undefined) {
    fail("Expected value to be undefined")
  }
}

/**
 * Asserts that `option` is `Some` and contains a value equal to `expected`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertSome<A>(
  option: Option.Option<A>,
  expected: A,
  ..._: Array<never>
): asserts option is Option.Some<A> {
  deepStrictEqual(option, Option.some(expected))
}

// ----------------------------
// Result
// ----------------------------

/**
 * Asserts that `result` is `Success` and contains a value equal to `expected`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertSuccess<A, E>(
  result: Result.Result<A, E>,
  expected: A,
  ..._: Array<never>
): asserts result is Result.Success<A, never> {
  deepStrictEqual(result, Result.succeed(expected))
}

/**
 * Asserts that `result` is `Failure` and contains an error equal to `expected`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertFailure<A, E>(
  result: Result.Result<A, E>,
  expected: E,
  ..._: Array<never>
): asserts result is Result.Failure<never, E> {
  deepStrictEqual(result, Result.fail(expected))
}

// ----------------------------
// Exit
// ----------------------------

/**
 * Asserts that `exit` is a failure with a cause equal to `expected`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertExitFailure<A, E>(
  exit: Exit.Exit<A, E>,
  expected: Cause.Cause<E>,
  ..._: Array<never>
): asserts exit is Exit.Failure<never, E> {
  deepStrictEqual(exit, Exit.failCause(expected))
}

/**
 * Asserts that `exit` is a success with a value equal to `expected`.
 *
 * @category testing
 * @since 4.0.0
 */
export function assertExitSuccess<A, E>(
  exit: Exit.Exit<A, E>,
  expected: A,
  ..._: Array<never>
): asserts exit is Exit.Success<A, never> {
  deepStrictEqual(exit, Exit.succeed(expected))
}
