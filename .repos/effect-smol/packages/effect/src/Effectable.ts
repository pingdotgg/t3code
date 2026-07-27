/**
 * Low-level helpers for making custom values behave like Effects. The module
 * exposes a prototype builder and an abstract base class that let
 * domain-specific values, such as service keys or configuration descriptions,
 * be evaluated by Effect and yielded inside `Effect.gen`.
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
