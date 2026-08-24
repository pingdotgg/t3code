/**
 * Wraps console operations in Effect.
 *
 * The `Console` service exposes common console methods such as logging,
 * warnings, errors, groups, counters, tables, and timers. Because console access
 * goes through a service, programs can use custom console implementations in
 * tests or other environments. This module also includes scoped helpers that
 * close console groups or timers automatically.
 *
 * @since 2.0.0
 */
import type * as Context from "./Context.ts"
import type * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import * as core from "./internal/core.ts"
import * as effect from "./internal/effect.ts"
import type { Scope } from "./Scope.ts"

/**
 * Represents a console interface for logging, debugging, timing, and grouping output.
 *
 * @category models
 * @since 2.0.0
 */
export interface Console {
  assert(condition: boolean, ...args: ReadonlyArray<any>): void
  clear(): void
  count(label?: string): void
  countReset(label?: string): void
  debug(...args: ReadonlyArray<any>): void
  dir(item: any, options?: any): void
  dirxml(...args: ReadonlyArray<any>): void
  error(...args: ReadonlyArray<any>): void
  group(...args: ReadonlyArray<any>): void
  groupCollapsed(...args: ReadonlyArray<any>): void
  groupEnd(): void
  info(...args: ReadonlyArray<any>): void
  log(...args: ReadonlyArray<any>): void
  table(tabularData: any, properties?: ReadonlyArray<string>): void
  time(label?: string): void
  timeEnd(label?: string): void
  timeLog(label?: string, ...args: ReadonlyArray<any>): void
  trace(...args: ReadonlyArray<any>): void
  warn(...args: ReadonlyArray<any>): void
}

/**
 * Context reference for the current console service in the Effect system, allowing access to the active console implementation from within the Effect context.
 *
 * **When to use**
 *
 * Use when you need an effect to run against a provided console implementation,
 * such as tests or alternate runtimes, rather than the default console.
 *
 * **Details**
 *
 * When no override is provided, the reference resolves to `globalThis.console`.
 *
 * **Example** (Accessing the current console)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Console.consoleWith((console) =>
 *   Effect.sync(() => {
 *     console.log("Hello from current console!")
 *   })
 * )
 * ```
 *
 * @see {@link consoleWith} for using the current console service inside an effect
 *
 * @category references
 * @since 2.0.0
 */
export const Console: Context.Reference<Console> = effect.ConsoleRef

/**
 * Creates an Effect that provides access to the current console service and lets you perform operations with it within an Effect context.
 *
 * **Example** (Accessing the current console service)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Console.consoleWith((console) =>
 *   Effect.sync(() => {
 *     console.log("Hello, world!")
 *     console.error("This is an error message")
 *   })
 * )
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const consoleWith = <A, E, R>(f: (console: Console) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  core.withFiber((fiber) => f(fiber.getRef(Console)))

/**
 * Writes the supplied assertion message to the console as an error when `condition` is false; when `condition` is true, no console output is produced.
 *
 * **Example** (Logging failed assertions)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.assert(2 + 2 === 4, "Math is working correctly")
 *   yield* Console.assert(2 + 2 === 5, "This will be logged as an error")
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const assert = (condition: boolean, ...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.assert(condition, ...args)
    })
  )

/**
 * Runs the current console service's clear operation.
 *
 * **When to use**
 *
 * Use to request that the active console implementation clear its visible
 * output.
 *
 * **Gotchas**
 *
 * The clearing behavior depends on the active console implementation and host
 * environment.
 *
 * **Example** (Clearing console output)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("This will be cleared")
 *   yield* Console.clear
 *   yield* Console.log("This appears after clearing")
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const clear: Effect.Effect<void> = consoleWith((console) =>
  effect.sync(() => {
    console.clear()
  })
)

/**
 * Logs and increments the counter associated with `label`, using the console's default counter when no label is provided.
 *
 * **Example** (Counting repeated calls)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.count("my-counter")
 *   yield* Console.count("my-counter") // Will show: my-counter: 2
 *   yield* Console.count() // Default counter
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const count = (label?: string): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.count(label)
    })
  )

/**
 * Resets the counter associated with the specified label back to zero.
 *
 * **Example** (Resetting a counter)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.count("my-counter")
 *   yield* Console.count("my-counter") // Will show: my-counter: 2
 *   yield* Console.countReset("my-counter")
 *   yield* Console.count("my-counter") // Will show: my-counter: 1
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const countReset = (label?: string): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.countReset(label)
    })
  )

/**
 * Writes a debug message through the current `Console` service.
 *
 * **Details**
 *
 * The arguments are passed to the service's `debug` method when the returned
 * Effect is executed. Any filtering behavior depends on the active console
 * implementation.
 *
 * **Example** (Writing debug messages)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.debug("Debug info:", { userId: 123, action: "login" })
 *   yield* Console.debug("Processing step", 1, "of", 5)
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const debug = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.debug(...args)
    })
  )

/**
 * Displays an interactive list of the properties of the specified object, optionally using console-specific inspection options for debugging complex data structures.
 *
 * **Example** (Inspecting an object)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const obj = { name: "John", age: 30, nested: { city: "New York" } }
 *   yield* Console.dir(obj)
 *   yield* Console.dir(obj, { depth: 2, colors: true })
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const dir = (item: any, options?: any): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.dir(item, options)
    })
  )

/**
 * Displays an interactive tree of descendant XML or HTML elements, which is particularly useful for inspecting DOM elements in browser environments.
 *
 * **Example** (Inspecting XML-like data)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.dirxml("<user id=\"1\">Ada</user>")
 * })
 *
 * Effect.runSync(program)
 * // <user id="1">Ada</user>
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const dirxml = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.dirxml(...args)
    })
  )

/**
 * Writes an error-level message to the console, typically displayed with error
 * styling by the active console implementation.
 *
 * **Example** (Writing error messages)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.error("Something went wrong!")
 *   yield* Console.error("Error details:", {
 *     code: 500,
 *     message: "Internal Server Error"
 *   })
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const error = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.error(...args)
    })
  )

/**
 * Creates a scoped console group, optionally collapsed and labeled, and closes it automatically when the Effect scope is finalized.
 *
 * **Example** (Grouping scoped output)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       yield* Console.group({ label: "User Processing" })
 *       yield* Console.log("Loading user data...")
 *       yield* Console.log("Validating user...")
 *       yield* Console.log("User processed successfully")
 *     })
 *   )
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const group = (
  options?: { label?: string | undefined; collapsed?: boolean | undefined } | undefined
): Effect.Effect<void, never, Scope> =>
  consoleWith((console) =>
    effect.acquireRelease(
      effect.sync(() => {
        if (options?.collapsed) {
          console.groupCollapsed(options.label)
        } else {
          console.group(options?.label)
        }
      }),
      () =>
        effect.sync(() => {
          console.groupEnd()
        })
    )
  )

/**
 * Writes an informational message to the console, typically displayed with info
 * styling by the active console implementation.
 *
 * **Example** (Writing informational messages)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.info("Application started successfully")
 *   yield* Console.info("Server configuration:", {
 *     port: 3000,
 *     env: "development"
 *   })
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const info = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.info(...args)
    })
  )

/**
 * Logs a general-purpose message to the console.
 *
 * **Example** (Writing log messages)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("Hello, world!")
 *   yield* Console.log("User data:", { name: "John", age: 30 })
 *   yield* Console.log("Processing", 42, "items")
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const log = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.log(...args)
    })
  )

/**
 * Displays tabular data as a formatted table in the console, optionally limited to selected properties.
 *
 * **Example** (Displaying tabular data)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const users = [
 *     { name: "John", age: 30, city: "New York" },
 *     { name: "Jane", age: 25, city: "London" },
 *     { name: "Bob", age: 35, city: "Paris" }
 *   ]
 *   yield* Console.table(users)
 *   yield* Console.table(users, ["name", "age"]) // Only show specific columns
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const table = (tabularData: any, properties?: ReadonlyArray<string>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.table(tabularData, properties)
    })
  )

/**
 * Starts a scoped timer for `label` and automatically ends it when the Effect scope is finalized.
 *
 * **Example** (Timing scoped work)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       yield* Console.time("operation-timer")
 *       yield* Effect.sleep("1 second")
 *       yield* Console.log("Operation completed")
 *       // Timer ends automatically when scope closes
 *     })
 *   )
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const time = (label?: string | undefined): Effect.Effect<void, never, Scope> =>
  consoleWith((console) =>
    effect.acquireRelease(
      effect.sync(() => {
        console.time(label)
      }),
      () =>
        effect.sync(() => {
          console.timeEnd(label)
        })
    )
  )

/**
 * Logs the elapsed time for an existing timer without stopping it, allowing progress reports for long-running operations.
 *
 * **Example** (Logging timer progress)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       yield* Console.time("long-operation")
 *       yield* Effect.sleep("500 millis")
 *       yield* Console.timeLog("long-operation", "Halfway done")
 *       yield* Effect.sleep("500 millis")
 *       // Timer ends when scope closes
 *     })
 *   )
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const timeLog = (label?: string, ...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.timeLog(label, ...args)
    })
  )

/**
 * Writes the current stack trace to the console to show how the current point in
 * the code was reached.
 *
 * **Example** (Writing stack traces)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.trace("Debug trace point")
 *   yield* Console.trace("Function call:", { functionName: "processData" })
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const trace = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.trace(...args)
    })
  )

/**
 * Writes a warning-level message to the console, typically displayed with
 * warning styling by the active console implementation.
 *
 * **Example** (Writing warning messages)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.warn("This feature is deprecated")
 *   yield* Console.warn("Performance warning:", {
 *     slowQuery: "SELECT * FROM large_table"
 *   })
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const warn = (...args: ReadonlyArray<any>): Effect.Effect<void> =>
  consoleWith((console) =>
    effect.sync(() => {
      console.warn(...args)
    })
  )

/**
 * Runs an Effect inside an optionally labeled or collapsed console group, starting the group before execution and ending it after the Effect completes.
 *
 * **Example** (Wrapping an effect in a group)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.withGroup(
 *     Effect.gen(function*() {
 *       yield* Console.log("Step 1: Initialize")
 *       yield* Console.log("Step 2: Process")
 *       yield* Console.log("Step 3: Complete")
 *     }),
 *     { label: "Processing Steps", collapsed: false }
 *   )
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const withGroup = dual<
  (
    options?: {
      readonly label?: string | undefined
      readonly collapsed?: boolean | undefined
    }
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    options?: {
      readonly label?: string | undefined
      readonly collapsed?: boolean | undefined
    }
  ) => Effect.Effect<A, E, R>
>((args) => core.isEffect(args[0]), (self, options) =>
  consoleWith((console) =>
    effect.acquireUseRelease(
      effect.sync(() => {
        if (options?.collapsed) {
          console.groupCollapsed(options.label)
        } else {
          console.group(options?.label)
        }
      }),
      () => self,
      () =>
        effect.sync(() => {
          console.groupEnd()
        })
    )
  ))

/**
 * Runs an Effect with a console timer, starting the timer before execution and ending it after the Effect completes.
 *
 * **Example** (Timing an effect)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.withTime(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("1 second")
 *       yield* Console.log("Operation completed")
 *     }),
 *     "my-operation"
 *   )
 * })
 * ```
 *
 * @category accessors
 * @since 2.0.0
 */
export const withTime = dual<
  (label?: string) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  <A, E, R>(self: Effect.Effect<A, E, R>, label?: string) => Effect.Effect<A, E, R>
>((args) => core.isEffect(args[0]), (self, label) =>
  consoleWith((console) =>
    effect.acquireUseRelease(
      effect.sync(() => {
        console.time(label)
      }),
      () => self,
      () =>
        effect.sync(() => {
          console.timeEnd(label)
        })
    )
  ))
