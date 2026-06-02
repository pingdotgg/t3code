/**
 * The `Resource` module provides refreshable, scoped values. A
 * `Resource<A, E>` stores the latest successful or failed acquisition result and
 * can be read with {@link get}, refreshed manually with {@link refresh}, or
 * refreshed automatically with {@link auto}.
 *
 * **Mental model**
 *
 * - A `Resource` wraps an acquisition `Effect` whose result is kept in a
 *   `ScopedRef`
 * - Each refresh re-runs acquisition and replaces the stored `Exit`
 * - Replacing the stored value releases resources associated with the previous
 *   scoped value
 * - Reading a resource returns the current acquired value or fails with the
 *   current acquisition error
 *
 * **Common tasks**
 *
 * - Create a manually refreshed resource with {@link manual}
 * - Create a schedule-driven resource with {@link auto}
 * - Read the current value with {@link get}
 * - Force a reload with {@link refresh}
 * - Check whether an unknown value is a resource with {@link isResource}
 *
 * **Gotchas**
 *
 * - Creating a resource requires a `Scope`; when the scope closes, scoped
 *   values held by the resource are released
 * - Failed acquisitions are stored too, so subsequent {@link get} calls fail
 *   until a refresh succeeds
 * - Automatic refreshes run in the resource scope and stop when that scope is
 *   closed
 *
 * @since 2.0.0
 */
import * as Context from "./Context.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import { identity } from "./Function.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import type { Pipeable } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type * as Schedule from "./Schedule.ts"
import type * as Scope from "./Scope.ts"
import * as ScopedRef from "./ScopedRef.ts"

const TypeId = "~effect/Resource" as const

/**
 * A `Resource` is a value loaded into memory that can be refreshed manually or
 * automatically according to a schedule.
 *
 * **When to use**
 *
 * Use to model a scoped value whose latest acquisition result is kept available
 * for repeated reads and can be refreshed manually or on a schedule.
 *
 * @see {@link manual} for creating a resource refreshed by the caller
 * @see {@link auto} for creating a resource refreshed according to a schedule
 * @see {@link get} for reading the currently stored acquisition result
 * @see {@link refresh} for forcing a new acquisition
 *
 * @category models
 * @since 2.0.0
 */
export interface Resource<in out A, in out E = never> extends Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly scopedRef: ScopedRef.ScopedRef<Exit.Exit<A, E>>
  readonly acquire: Effect.Effect<A, E>
}

/**
 * Returns `true` if the specified value is a `Resource`.
 *
 * **When to use**
 *
 * Use to validate unknown values at runtime boundaries before treating them as
 * `Resource` values.
 *
 * **Details**
 *
 * This predicate narrows the input to `Resource<unknown, unknown>`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isResource: (u: unknown) => u is Resource<unknown, unknown> = (
  u: unknown
): u is Resource<unknown, unknown> => hasProperty(u, TypeId)

const Proto = {
  ...PipeInspectableProto,
  [TypeId]: TypeId,
  toJSON() {
    return {
      _id: "Resource"
    }
  }
}

const makeUnsafe = <A, E>(
  scopedRef: ScopedRef.ScopedRef<Exit.Exit<A, E>>,
  acquire: Effect.Effect<A, E>
): Resource<A, E> => {
  const self = Object.create(Proto)
  self.scopedRef = scopedRef
  self.acquire = acquire
  return self
}

/**
 * Creates a `Resource` that must be refreshed manually.
 *
 * **When to use**
 *
 * Use when you need to control the timing of resource refreshes yourself rather
 * than relying on an automatic schedule.
 *
 * @see {@link auto} for schedule-driven automatic refreshes
 * @see {@link refresh} to manually trigger a resource refresh
 * @category constructors
 * @since 2.0.0
 */
export const manual = <A, E, R>(
  acquire: Effect.Effect<A, E, R>
): Effect.Effect<Resource<A, E>, never, Scope.Scope | R> =>
  Effect.contextWith((context: Context.Context<R>) => {
    const providedAcquire = Effect.updateContext(
      acquire,
      (input: Context.Context<never>) => Context.merge(context, input)
    )
    return Effect.map(
      ScopedRef.fromAcquire(Effect.exit(providedAcquire)),
      (scopedRef) => makeUnsafe(scopedRef, providedAcquire)
    )
  })

/**
 * Creates a `Resource` that refreshes automatically according to the supplied
 * schedule.
 *
 * **When to use**
 *
 * Use when a resource should refresh in the background according to a schedule
 * for the lifetime of its scope.
 *
 * @see {@link manual} for caller-controlled refresh timing
 * @see {@link refresh} to trigger a refresh explicitly
 *
 * @category constructors
 * @since 2.0.0
 */
export const auto = <A, E, R, Out, E2, R2>(
  acquire: Effect.Effect<A, E, R>,
  policy: Schedule.Schedule<Out, unknown, E2, R2>
): Effect.Effect<Resource<A, E>, never, R | R2 | Scope.Scope> =>
  Effect.tap(
    manual(acquire),
    (self) => Effect.forkScoped(Effect.repeat(refresh(self), policy))
  )

/**
 * Retrieves the current value stored in this resource.
 *
 * **When to use**
 *
 * Use to read the value currently cached by a `Resource`.
 *
 * **Gotchas**
 *
 * If the resource currently stores a failed acquisition result, the returned
 * effect fails with the stored error.
 *
 * @see {@link refresh} to re-run acquisition and update the stored value before a later read
 *
 * @category getters
 * @since 2.0.0
 */
export const get = <A, E>(self: Resource<A, E>): Effect.Effect<A, E> =>
  Effect.flatMap(ScopedRef.get(self.scopedRef), identity)

/**
 * Re-runs this resource's acquisition effect and updates the current value.
 *
 * **When to use**
 *
 * Use to force an existing `Resource` to reacquire its value at a
 * caller-controlled point.
 *
 * **Details**
 *
 * When acquisition succeeds, refreshing replaces the value stored in the
 * resource's scoped reference and releases resources associated with the
 * previous value.
 *
 * **Gotchas**
 *
 * If acquisition fails, the returned effect fails and the previously stored
 * result is left as what `get` reads.
 *
 * @see {@link get} for reading the current stored value
 * @see {@link manual} for resources refreshed only by caller action
 * @see {@link auto} for schedule-driven automatic refreshes
 *
 * @category utils
 * @since 2.0.0
 */
export const refresh = <A, E>(self: Resource<A, E>): Effect.Effect<void, E> =>
  ScopedRef.set(self.scopedRef, Effect.map(self.acquire, Exit.succeed))
