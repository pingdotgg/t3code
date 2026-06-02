/**
 * The `TestConsole` module provides a test implementation of the Effect
 * `Console` service. When {@link layer} is provided, calls made through the
 * Effect console APIs are captured in memory instead of being written to the
 * host console, so tests can assert on logged values deterministically.
 *
 * This module is intentionally small: it gives tests a console layer, helpers
 * for reading captured `Console.log` and `Console.error` arguments, and a way
 * to access the provided test console service directly.
 *
 * **Mental model**
 *
 * - {@link layer} replaces the current `Console` service with a fresh
 *   in-memory test console for the effect it is provided to
 * - Code under test must call Effect's `Console` APIs; direct calls to
 *   `globalThis.console` are outside the service and are not captured
 * - {@link logLines} returns the values passed to `Console.log` in call order
 * - {@link errorLines} returns the values passed to `Console.error` in call
 *   order
 * - {@link testConsoleWith} gives direct access to the current `TestConsole`
 *   service when a test needs to inspect or call it manually
 *
 * **Common tasks**
 *
 * - Capture console output by providing {@link layer}
 * - Assert on logged values with {@link logLines}
 * - Assert on error output with {@link errorLines}
 * - Construct a standalone test console service with {@link make}
 * - Access the provided service with {@link testConsoleWith}
 *
 * **Gotchas**
 *
 * - Captured log and error values are the original arguments, not formatted
 *   strings
 * - `logLines` and `errorLines` expose `Console.log` and `Console.error`
 *   output; other console methods are implemented for compatibility but do not
 *   have dedicated accessor effects in this module
 *
 * @since 4.0.0
 */
import * as Array from "../Array.ts"
import * as Console from "../Console.ts"
import * as Effect from "../Effect.ts"
import * as Layer from "../Layer.ts"

/**
 * A `TestConsole` provides a testable implementation of the Console interface.
 * It captures all console output for testing purposes while maintaining full
 * compatibility with the standard Console API.
 *
 * **When to use**
 *
 * Use to provide a console implementation that records calls for assertions in
 * tests.
 *
 * **Details**
 *
 * This interface extends the standard Console interface and adds methods to
 * retrieve logged messages for verification in tests.
 *
 * **Example** (Capturing console output in tests)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 * import { TestConsole } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("Hello, World!")
 *   yield* Console.error("An error occurred")
 *
 *   const logs = yield* TestConsole.logLines
 *   const errors = yield* TestConsole.errorLines
 *
 *   console.log(logs) // [["Hello, World!"]]
 *   console.log(errors) // [["An error occurred"]]
 * }).pipe(Effect.provide(TestConsole.layer))
 * ```
 *
 * @see {@link layer} for providing `TestConsole` to an effect
 * @see {@link logLines} for reading captured `Console.log` calls
 * @see {@link errorLines} for reading captured `Console.error` calls
 *
 * @category models
 * @since 4.0.0
 */
export interface TestConsole extends Console.Console {
  /**
   * Returns an array of all items that have been logged by the program using
   * `Console.log` thus far.
   *
   * **When to use**
   *
   * Use to inspect captured `Console.log` calls through a `TestConsole`
   * instance.
   */
  readonly logLines: Effect.Effect<ReadonlyArray<unknown>>
  /**
   * Returns an array of all items that have been logged by the program using
   * `Console.error` thus far.
   *
   * **When to use**
   *
   * Use to inspect captured `Console.error` calls through a `TestConsole`
   * instance.
   */
  readonly errorLines: Effect.Effect<ReadonlyArray<unknown>>
}

/**
 * The `TestConsole` namespace provides types and utilities for working with
 * test console implementations.
 *
 * **When to use**
 *
 * Use when referring to types nested under the `TestConsole` namespace.
 *
 * @since 4.0.0
 */
export declare namespace TestConsole {
  /**
   * Represents a console method name that can be invoked on the TestConsole.
   * This type includes all methods available on the Console interface.
   *
   * **When to use**
   *
   * Use to type the console method name recorded in a captured test console
   * entry.
   *
   * **Example** (Typing captured console methods)
   *
   * ```ts
   * import type { TestConsole } from "effect/testing"
   *
   * const method: TestConsole.TestConsole.Method = "log"
   *
   * console.log(method) // "log"
   * ```
   *
   * @category models
   * @since 4.0.0
   */
  export type Method = keyof Console.Console

  /**
   * Represents a single console method invocation captured by the TestConsole.
   * Each entry contains the method name and the parameters passed to it.
   *
   * **When to use**
   *
   * Use to inspect or type one captured console invocation.
   *
   * **Example** (Typing captured console entries)
   *
   * ```ts
   * import type { TestConsole } from "effect/testing"
   *
   * const entry: TestConsole.TestConsole.Entry = {
   *   method: "error",
   *   parameters: ["not found"]
   * }
   *
   * console.log(entry.method) // "error"
   * console.log(entry.parameters) // ["not found"]
   * ```
   *
   * @category models
   * @since 4.0.0
   */
  export interface Entry {
    readonly method: Method
    readonly parameters: ReadonlyArray<unknown>
  }
}

/**
 * Creates a new TestConsole instance that captures all console output.
 * The returned TestConsole implements the Console interface and provides
 * additional methods to retrieve logged messages.
 *
 * **When to use**
 *
 * Use to construct a test console service value directly.
 *
 * **Example** (Creating a test console)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 * import { TestConsole } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("Debug message")
 *   yield* Console.error("Error occurred")
 *
 *   const logs = yield* TestConsole.logLines
 *   const errors = yield* TestConsole.errorLines
 *
 *   console.log("Captured logs:", logs)
 *   console.log("Captured errors:", errors)
 * }).pipe(Effect.provide(TestConsole.layer))
 * ```
 *
 * @see {@link layer} for providing a `TestConsole` as a `Layer`
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.gen(function*() {
  const entries: Array<TestConsole.Entry> = []

  function createEntryUnsafe(method: TestConsole.Method) {
    return (...parameters: ReadonlyArray<any>): void => {
      entries.push({ method, parameters })
    }
  }

  const logLines = Effect.sync(() => Array.flatMap(entries, (entry) => entry.method === "log" ? entry.parameters : []))

  const errorLines = Effect.sync(() =>
    Array.flatMap(entries, (entry) => entry.method === "error" ? entry.parameters : [])
  )

  return {
    assert: createEntryUnsafe("assert"),
    clear: createEntryUnsafe("clear"),
    count: createEntryUnsafe("count"),
    countReset: createEntryUnsafe("countReset"),
    debug: createEntryUnsafe("debug"),
    dir: createEntryUnsafe("dir"),
    dirxml: createEntryUnsafe("dirxml"),
    error: createEntryUnsafe("error"),
    group: createEntryUnsafe("group"),
    groupCollapsed: createEntryUnsafe("groupCollapsed"),
    groupEnd: createEntryUnsafe("groupEnd"),
    info: createEntryUnsafe("info"),
    log: createEntryUnsafe("log"),
    table: createEntryUnsafe("table"),
    time: createEntryUnsafe("time"),
    timeEnd: createEntryUnsafe("timeEnd"),
    timeLog: createEntryUnsafe("timeLog"),
    trace: createEntryUnsafe("trace"),
    warn: createEntryUnsafe("warn"),
    logLines,
    errorLines
  } as TestConsole
})

/**
 * Retrieves the `TestConsole` service for this test and uses it to run the
 * specified workflow.
 *
 * **When to use**
 *
 * Use to access the provided test console service inside an effect.
 *
 * **Example** (Accessing the test console service)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { TestConsole } from "effect/testing"
 *
 * const program = TestConsole.testConsoleWith((testConsole) =>
 *   Effect.gen(function*() {
 *     testConsole.log("Test message")
 *     testConsole.error("Test error")
 *
 *     const logs = yield* testConsole.logLines
 *     const errors = yield* testConsole.errorLines
 *
 *     console.log("Logs:", logs) // [["Test message"]]
 *     console.log("Errors:", errors) // [["Test error"]]
 *   })
 * ).pipe(Effect.provide(TestConsole.layer))
 * ```
 *
 * @see {@link layer} for providing the test console service
 * @see {@link logLines} for reading captured `Console.log` calls directly
 * @see {@link errorLines} for reading captured `Console.error` calls directly
 *
 * @category utils
 * @since 4.0.0
 */
export const testConsoleWith = <A, E, R>(f: (console: TestConsole) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Console.consoleWith((console) => f(console as TestConsole))

/**
 * Creates a `Layer` which constructs a `TestConsole`.
 * This layer can be used to provide a TestConsole implementation
 * for testing purposes.
 *
 * **When to use**
 *
 * Use to run an effect with console calls captured by `TestConsole`.
 *
 * **Example** (Providing a test console layer)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 * import { TestConsole } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("This will be captured")
 *   yield* Console.error("This error will be captured")
 *
 *   const logs = yield* TestConsole.logLines
 *   const errors = yield* TestConsole.errorLines
 *
 *   console.log("Captured logs:", logs)
 *   console.log("Captured errors:", errors)
 * }).pipe(Effect.provide(TestConsole.layer))
 * ```
 *
 * @see {@link make} for constructing the service value directly
 * @see {@link testConsoleWith} for accessing the provided test console service
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<TestConsole> = Layer.effect(Console.Console)(make) as any

/**
 * Returns an array of all items that have been logged by the program using
 * `Console.log` thus far.
 *
 * **When to use**
 *
 * Use to assert on captured `Console.log` output from a program provided with
 * `TestConsole.layer`.
 *
 * **Example** (Reading captured log lines)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 * import { TestConsole } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("First message")
 *   yield* Console.log("Second message", { key: "value" })
 *   yield* Console.log("Third message", 42, true)
 *
 *   const logs = yield* TestConsole.logLines
 *
 *   console.log(logs)
 *   // [
 *   //   ["First message"],
 *   //   ["Second message", { key: "value" }],
 *   //   ["Third message", 42, true]
 *   // ]
 * }).pipe(Effect.provide(TestConsole.layer))
 * ```
 *
 * @see {@link errorLines} for reading captured `Console.error` output
 * @see {@link layer} for capturing console calls during a test
 *
 * @category utils
 * @since 4.0.0
 */
export const logLines: Effect.Effect<ReadonlyArray<unknown>, never, never> = testConsoleWith(
  (console) => console.logLines
)

/**
 * Returns an array of all items that have been logged by the program using
 * `Console.error` thus far.
 *
 * **When to use**
 *
 * Use to assert on captured `Console.error` output from a program provided
 * with `TestConsole.layer`.
 *
 * **Example** (Reading captured error lines)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 * import { TestConsole } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.error("Error message")
 *   yield* Console.error("Another error", new Error("Something went wrong"))
 *
 *   const errors = yield* TestConsole.errorLines
 *
 *   console.log(errors)
 *   // [
 *   //   ["Error message"],
 *   //   ["Another error", Error: Something went wrong]
 *   // ]
 * }).pipe(Effect.provide(TestConsole.layer))
 * ```
 *
 * @see {@link logLines} for reading captured `Console.log` output
 * @see {@link layer} for capturing console calls during a test
 *
 * @category utils
 * @since 4.0.0
 */
export const errorLines: Effect.Effect<ReadonlyArray<unknown>, never, never> = testConsoleWith(
  (console) => console.errorLines
)
