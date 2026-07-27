/**
 * Controls how long resources stay open.
 *
 * A scope is a lifetime boundary. Code can register cleanup effects on it, and
 * closing the scope runs those cleanups with the `Exit` value that ended the
 * work. Most application code uses higher-level APIs such as `Effect.scoped`
 * and `Layer`, while this module is useful when code needs to create, provide,
 * fork, close, or inspect scopes directly.
 *
 * @since 2.0.0
 */

import type * as Context from "./Context.ts"
import type { Effect } from "./Effect.ts"
import type { Exit } from "./Exit.ts"
import * as effect from "./internal/effect.ts"

const TypeId = effect.ScopeTypeId
const CloseableTypeId = effect.ScopeCloseableTypeId

/**
 * A `Scope` represents a context where resources can be acquired and
 * automatically cleaned up when the scope is closed. Scopes can use
 * either sequential or parallel finalization strategies.
 *
 * **Example** (Managing scoped resources)
 *
 * ```ts
 * import { Effect, Exit, Scope } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const scope = yield* Scope.make("sequential")
 *
 *   // Scope has a strategy and state
 *   console.log(scope.strategy) // "sequential"
 *   console.log(scope.state._tag) // "Open"
 *
 *   // Close the scope
 *   yield* Scope.close(scope, Exit.void)
 *   console.log(scope.state._tag) // "Closed"
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Scope {
  readonly [TypeId]: typeof TypeId
  readonly strategy: "sequential" | "parallel"
  state: State.Open | State.Closed | State.Empty
}
/**
 * A `Closeable` scope extends the base `Scope` interface with the ability
 * to be closed, executing all registered finalizers.
 *
 * **Example** (Closing a scope)
 *
 * ```ts
 * import { Console, Effect, Exit, Scope } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const scope = yield* Scope.make()
 *
 *   // Add a finalizer
 *   yield* Scope.addFinalizer(scope, Console.log("Cleanup!"))
 *
 *   // Scope can be closed
 *   yield* Scope.close(scope, Exit.void)
 * })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Closeable extends Scope {
  readonly [CloseableTypeId]: typeof CloseableTypeId
}

/**
 * The `State` namespace contains the concrete states of a scope: `Empty`
 * before any finalizers are registered, `Open` with registered finalizers, and
 * `Closed` with the exit value used to close the scope.
 *
 * **Example** (Checking scope states)
 *
 * ```ts
 * import { Effect, Exit, Scope } from "effect"
 *
 * // Example of checking scope states
 * const program = Effect.gen(function*() {
 *   const scope = yield* Scope.make()
 *
 *   // When open, the scope accepts finalizers
 *   if (scope.state._tag === "Open") {
 *     console.log("Scope is open")
 *   }
 *
 *   yield* Scope.close(scope, Exit.void)
 *
 *   // When closed, the scope no longer accepts finalizers
 *   if (scope.state._tag === "Closed") {
 *     console.log("Scope is closed")
 *   }
 * })
 * ```
 *
 * @since 4.0.0
 */
export declare namespace State {
  /**
   * Represents an open scope with no registered finalizers yet.
   *
   * **Details**
   *
   * Adding the first finalizer transitions the scope to `Open`; closing an
   * empty scope transitions directly to `Closed` without producing a finalizer
   * effect.
   *
   * **Example** (Inspecting an empty scope state)
   *
   * ```ts
   * import { Scope } from "effect"
   *
   * const scope = Scope.makeUnsafe()
   *
   * // When scope is open, you can check its state
   * if (scope.state._tag === "Open") {
   *   console.log("Scope is open and accepting finalizers")
   *   console.log(scope.state.finalizers.size) // Number of registered finalizers
   * }
   * ```
   *
   * @category models
   * @since 4.0.0
   */
  export type Empty = {
    readonly _tag: "Empty"
  }
  /**
   * Represents an open scope state where finalizers can be added and
   * the scope is still accepting new resources.
   *
   * **Example** (Inspecting an open scope state)
   *
   * ```ts
   * import { Scope } from "effect"
   *
   * const scope = Scope.makeUnsafe()
   *
   * // When scope is open, you can check its state
   * if (scope.state._tag === "Open") {
   *   console.log("Scope is open and accepting finalizers")
   *   console.log(scope.state.finalizers.size) // Number of registered finalizers
   * }
   * ```
   *
   * @category models
   * @since 4.0.0
   */
  export type Open = {
    readonly _tag: "Open"
    readonly finalizers: Map<{}, (exit: Exit<any, any>) => Effect<void>>
  }
  /**
   * Represents a closed scope state where finalizers have been executed
   * and the scope is no longer accepting new resources.
   *
   * **Example** (Inspecting a closed scope state)
   *
   * ```ts
   * import { Effect, Exit, Scope } from "effect"
   *
   * const program = Effect.gen(function*() {
   *   const scope = yield* Scope.make()
   *
   *   // Close the scope
   *   yield* Scope.close(scope, Exit.succeed("Done"))
   *
   *   // Check if scope is closed
   *   if (scope.state._tag === "Closed") {
   *     console.log("Scope is closed")
   *     console.log(scope.state.exit) // The exit value used to close the scope
   *   }
   * })
   * ```
   *
   * @category models
   * @since 4.0.0
   */
  export type Closed = {
    readonly _tag: "Closed"
    readonly exit: Exit<any, any>
  }
}

/**
 * Service tag for the active resource lifetime.
 *
 * **When to use**
 *
 * Use to access the active lifetime when registering finalizers or sharing
 * resources with the surrounding scope.
 *
 * **Example** (Accessing the scope service)
 *
 * ```ts
 * import { Effect, Scope } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Access the scope from the context
 *   const scope = yield* Scope.Scope
 *
 *   // Use the scope for resource management
 *   yield* Scope.addFinalizer(scope, Effect.log("Cleanup"))
 * })
 *
 * // Provide a scope to the program
 * const scoped = Effect.scoped(program)
 * ```
 *
 * @category services
 * @since 2.0.0
 */
export const Scope: Context.Service<Scope, Scope> = effect.scopeTag

/**
 * Creates a new `Scope` with the specified finalizer strategy.
 *
 * **Example** (Creating a scope)
 *
 * ```ts
 * import { Console, Effect, Exit, Scope } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a scope with sequential cleanup
 *   const scope = yield* Scope.make("sequential")
 *
 *   // Add finalizers
 *   yield* Scope.addFinalizer(scope, Console.log("Cleanup 1"))
 *   yield* Scope.addFinalizer(scope, Console.log("Cleanup 2"))
 *
 *   // Close the scope (finalizers run in reverse order)
 *   yield* Scope.close(scope, Exit.void)
 *   // Output: "Cleanup 2", then "Cleanup 1"
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const make: (finalizerStrategy?: "sequential" | "parallel") => Effect<Closeable> = effect.scopeMake

/**
 * Creates a new `Scope` synchronously without wrapping it in an `Effect`.
 * This is useful when you need a scope immediately but should be used with caution
 * as it doesn't provide the same safety guarantees as the `Effect`-wrapped version.
 *
 * **When to use**
 *
 * Use when a scope must be allocated synchronously and the caller will close it
 * manually.
 *
 * **Example** (Creating a scope synchronously)
 *
 * ```ts
 * import { Console, Effect, Exit, Scope } from "effect"
 *
 * // Create a scope immediately
 * const scope = Scope.makeUnsafe("sequential")
 *
 * // Use it in an Effect program
 * const program = Effect.gen(function*() {
 *   yield* Scope.addFinalizer(scope, Console.log("Cleanup"))
 *   yield* Scope.close(scope, Exit.void)
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeUnsafe: (finalizerStrategy?: "sequential" | "parallel") => Closeable = effect.scopeMakeUnsafe

/**
 * Provides a concrete `Scope` to an effect.
 *
 * **When to use**
 *
 * Use to run an effect that requires `Scope` with a scope managed by the
 * caller.
 *
 * **Details**
 *
 * Providing the scope removes the `Scope` requirement from the effect context.
 *
 * **Example** (Providing a scope)
 *
 * ```ts
 * import { Console, Effect, Scope } from "effect"
 *
 * // An effect that requires a Scope
 * const program = Effect.gen(function*() {
 *   const scope = yield* Scope.Scope
 *   yield* Scope.addFinalizer(scope, Console.log("Cleanup"))
 *   yield* Console.log("Working...")
 * })
 *
 * // Provide a scope to the program
 * const withScope = Effect.gen(function*() {
 *   const scope = yield* Scope.make()
 *   yield* Scope.provide(scope)(program)
 * })
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const provide: {
  (value: Scope): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, Scope>>
  <A, E, R>(self: Effect<A, E, R>, value: Scope): Effect<A, E, Exclude<R, Scope>>
} = effect.provideScope

/**
 * Registers an exit-aware finalizer on a scope.
 *
 * **When to use**
 *
 * Use when cleanup needs to know whether the scope closed with success,
 * failure, or interruption.
 *
 * **Details**
 *
 * If the scope is open, the finalizer runs when the scope closes and receives
 * the scope's exit value. If the scope is already closed, the finalizer runs
 * immediately with the stored exit value.
 *
 * **Example** (Adding an exit-aware finalizer)
 *
 * ```ts
 * import { Console, Effect, Exit, Scope } from "effect"
 *
 * const withResource = Effect.gen(function*() {
 *   const scope = yield* Scope.make()
 *
 *   // Add a finalizer for cleanup
 *   yield* Scope.addFinalizerExit(
 *     scope,
 *     (exit) =>
 *       Console.log(
 *         `Cleaning up resource. Exit: ${
 *           Exit.isSuccess(exit) ? "Success" : "Failure"
 *         }`
 *       )
 *   )
 *
 *   // Use the resource
 *   yield* Console.log("Using resource")
 *
 *   // Close the scope
 *   yield* Scope.close(scope, Exit.void)
 * })
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const addFinalizerExit: (scope: Scope, finalizer: (exit: Exit<any, any>) => Effect<unknown>) => Effect<void> =
  effect.scopeAddFinalizerExit

/**
 * Registers a finalizer effect on a scope.
 *
 * **Details**
 *
 * If the scope is open, the finalizer runs when the scope closes, regardless of
 * whether the scope closes successfully or with an error. If the scope is
 * already closed, the finalizer runs immediately.
 *
 * **Example** (Adding finalizers)
 *
 * ```ts
 * import { Console, Effect, Exit, Scope } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const scope = yield* Scope.make()
 *
 *   // Add simple finalizers
 *   yield* Scope.addFinalizer(scope, Console.log("Cleanup task 1"))
 *   yield* Scope.addFinalizer(scope, Console.log("Cleanup task 2"))
 *   yield* Scope.addFinalizer(scope, Effect.log("Cleanup task 3"))
 *
 *   // Do some work
 *   yield* Console.log("Doing work...")
 *
 *   // Close the scope
 *   yield* Scope.close(scope, Exit.void)
 * })
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const addFinalizer: (scope: Scope, finalizer: Effect<unknown>) => Effect<void> = effect.scopeAddFinalizer

/**
 * Creates a closeable child scope registered with a parent scope.
 *
 * **Details**
 *
 * Closing the parent closes the child with the same exit value, and closing the
 * child detaches it from the parent. The optional finalizer strategy configures
 * the child scope and defaults to `"sequential"` when omitted.
 *
 * **Example** (Creating a child scope)
 *
 * ```ts
 * import { Console, Effect, Exit, Scope } from "effect"
 *
 * const nestedScopes = Effect.gen(function*() {
 *   const parentScope = yield* Scope.make("sequential")
 *
 *   // Add finalizer to parent
 *   yield* Scope.addFinalizer(parentScope, Console.log("Parent cleanup"))
 *
 *   // Create child scope
 *   const childScope = yield* Scope.fork(parentScope, "parallel")
 *
 *   // Add finalizer to child
 *   yield* Scope.addFinalizer(childScope, Console.log("Child cleanup"))
 *
 *   // Close child first, then parent
 *   yield* Scope.close(childScope, Exit.void)
 *   yield* Scope.close(parentScope, Exit.void)
 * })
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const fork: (
  scope: Scope,
  finalizerStrategy?: "sequential" | "parallel"
) => Effect<Closeable> = effect.scopeFork

/**
 * Creates a closeable child scope synchronously and registers it with a parent scope.
 *
 * **When to use**
 *
 * Use when a child scope must be created synchronously and the caller controls
 * both parent and child scope lifetimes.
 *
 * **Details**
 *
 * Closing the parent closes the child with the same exit value, and closing the
 * child detaches it from the parent. The optional finalizer strategy configures
 * the child scope and defaults to `"sequential"` when omitted.
 *
 * **Example** (Creating a child scope synchronously)
 *
 * ```ts
 * import { Console, Effect, Exit, Scope } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const parentScope = Scope.makeUnsafe("sequential")
 *   const childScope = Scope.forkUnsafe(parentScope, "parallel")
 *
 *   // Add finalizers to both scopes
 *   yield* Scope.addFinalizer(parentScope, Console.log("Parent cleanup"))
 *   yield* Scope.addFinalizer(childScope, Console.log("Child cleanup"))
 *
 *   // Close child first, then parent
 *   yield* Scope.close(childScope, Exit.void)
 *   yield* Scope.close(parentScope, Exit.void)
 * })
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const forkUnsafe: (scope: Scope, finalizerStrategy?: "sequential" | "parallel") => Closeable =
  effect.scopeForkUnsafe

/**
 * Closes a scope and runs its registered finalizers.
 *
 * **When to use**
 *
 * Use to close a scope manually with a specific exit value.
 *
 * **Details**
 *
 * Finalizers run in the scope's configured order and receive the supplied
 * `Exit`.
 *
 * **Example** (Running scope finalizers)
 *
 * ```ts
 * import { Console, Effect, Exit, Scope } from "effect"
 *
 * const resourceManagement = Effect.gen(function*() {
 *   const scope = yield* Scope.make("sequential")
 *
 *   // Add multiple finalizers
 *   yield* Scope.addFinalizer(scope, Console.log("Close database connection"))
 *   yield* Scope.addFinalizer(scope, Console.log("Close file handle"))
 *   yield* Scope.addFinalizer(scope, Console.log("Release memory"))
 *
 *   // Do some work...
 *   yield* Console.log("Performing operations...")
 *
 *   // Close scope - finalizers run in reverse order of registration
 *   yield* Scope.close(scope, Exit.succeed("Success!"))
 *   // Output: "Release memory", "Close file handle", "Close database connection"
 * })
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const close: <A, E>(self: Scope, exit: Exit<A, E>) => Effect<void> = effect.scopeClose

/**
 * Closes a scope unsafely with the provided exit value.
 *
 * **When to use**
 *
 * Use when implementing lower-level scope machinery that must transition a
 * scope to `Closed` immediately and can run the returned finalizer effect when
 * one is produced.
 *
 * **Details**
 *
 * Returns an effect that runs registered finalizers, or `undefined` when the
 * scope was already closed or no finalizers need to run.
 *
 * **Gotchas**
 *
 * Ignoring the returned effect skips registered finalizers.
 *
 * @see {@link close} for the usual effectful close operation that always returns an `Effect`
 *
 * @category unsafe
 * @since 4.0.0
 */
export const closeUnsafe: <A, E>(self: Scope, exit_: Exit<A, E>) => Effect<void, never, never> | undefined =
  effect.scopeCloseUnsafe

/**
 * Runs an effect with the provided closeable scope in its context and closes
 * that scope when the effect exits.
 *
 * **When to use**
 *
 * Use when you already have a `Closeable` scope and want to run an effect that
 * requires `Scope` while automatically closing that scope when the effect exits.
 *
 * **Details**
 *
 * The scope is closed with the same exit value as the effect, so registered
 * finalizers can observe whether the effect succeeded, failed, or was
 * interrupted.
 *
 * @see `provide` for providing a scope without closing it automatically
 * @see `Effect.scoped` for creating and closing a fresh scope around a workflow
 *
 * @category combinators
 * @since 2.0.0
 */
export const use: {
  (scope: Closeable): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, Scope>>
  <A, E, R>(self: Effect<A, E, R>, scope: Closeable): Effect<A, E, Exclude<R, Scope>>
} = effect.scopeUse
