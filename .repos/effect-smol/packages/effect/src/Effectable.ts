/**
 * The `Effectable` module provides low-level building blocks for defining
 * custom values that behave like `Effect`s. It is primarily used by library
 * authors who need domain-specific effect-like data types, such as service
 * keys, configuration descriptions, prompts, or other declarative programs
 * that can be yielded inside `Effect.gen`.
 *
 * **Mental model**
 *
 * - `Effectable` does not run effects by itself; it provides prototypes that
 *   implement the internal Effect protocol.
 * - {@link Prototype} creates a primitive Effect prototype with a custom
 *   evaluation function that receives the current `Fiber`.
 * - {@link Class} is an abstract base class for defining custom classes whose
 *   instances are also `Effect` values.
 * - The success, error, and service requirements of the custom type are
 *   preserved through the `Effect.Effect<A, E, R>` type parameters.
 *
 * **Common tasks**
 *
 * - Build an effect-like interface around a declarative data structure.
 * - Implement a custom `evaluate` hook that interprets the value in terms of
 *   the current fiber and returns the underlying `Effect`.
 * - Extend {@link Class} when a nominal class-based API is more convenient
 *   than manually wiring a prototype.
 *
 * **Gotchas**
 *
 * - This module is intentionally low-level; most application code should use
 *   `Effect` constructors and combinators instead.
 * - `evaluate` must return an `Effect` with the same success, error, and
 *   service types as the custom value.
 * - Because these APIs participate in the internal Effect protocol, keep
 *   implementations small and follow existing modules such as `Config` and
 *   `Context` when adding new effect-like types.
 *
 * @since 4.0.0
 */
import type * as Effect from "./Effect.ts"
import type * as Fiber from "./Fiber.ts"
import { evaluate, makePrimitiveProto } from "./internal/core.ts"

/**
 * Create a low-level `Effect` prototype.
 *
 * **When to use**
 *
 * Use when you need to create a custom Effect-like value without extending a
 * class, by providing a label and an evaluate function that receives the
 * current fiber.
 *
 * **Details**
 *
 * When the effect is evaluated, it calls `evaluate` with the current fiber.
 *
 * @see {@link Class} for a class-based approach to defining custom Effect values
 *
 * @category prototypes
 * @since 4.0.0
 */
export const Prototype = <A extends Effect.Effect<any, any, any>>(options: {
  readonly label: string
  readonly evaluate: (
    this: A,
    fiber: Fiber.Fiber<any, any>
  ) => Effect.Effect<Effect.Success<A>, Effect.Error<A>, Effect.Services<A>>
}): Effect.Effect<Effect.Success<A>, Effect.Error<A>, Effect.Services<A>> =>
  makePrimitiveProto({
    op: options.label,
    [evaluate]: options.evaluate
  }) as any

const Base: new<A, E, R>() => Effect.Effect<A, E, R> = (() => {
  const Base = function() {}
  Base.prototype = Prototype({
    label: "Effectable",
    evaluate(_) {
      return this
    }
  })
  return Base as any
})()

/**
 * Provides an abstract class that can be extended to create an `Effect`.
 *
 * **When to use**
 *
 * Use as an abstract base class to define custom classes whose instances behave
 * as `Effect` values.
 *
 * @see {@link Prototype} for a lower-level primitive approach to creating custom Effect-like values without a class
 * @category constructors
 * @since 2.0.0
 */
export abstract class Class<A, E = never, R = never> extends Base<A, E, R> {
  abstract override: Effect.Effect<A, E, R>
}
