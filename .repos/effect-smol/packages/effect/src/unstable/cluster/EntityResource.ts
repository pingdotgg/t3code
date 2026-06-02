/**
 * The `EntityResource` module provides helpers for acquiring resources inside a
 * cluster entity and keeping them available across entity restarts. It is useful
 * for long-lived resources tied to an entity address, such as external
 * processes, network clients, Kubernetes Pods, or other handles that should not
 * be torn down during routine shard movement.
 *
 * **Common tasks**
 *
 * - Create a reusable entity-scoped resource with {@link make}
 * - Keep an entity alive while the resource is acquired
 * - Explicitly release the resource with `EntityResource.close`
 * - Attach cleanup work to the resource close scope with {@link CloseScope}
 * - Create and manage a Kubernetes Pod resource with {@link makeK8sPod}
 *
 * **Lifecycle gotchas**
 *
 * - Resources are retained by an `RcRef` and are only fully released after
 *   `idleTimeToLive` expires or `close` is called
 * - The default idle time to live is infinite, so resources remain alive until
 *   explicitly closed
 * - `CloseScope` is separate from the caller scope and is not closed by entity
 *   restarts, shard movement, or node shutdown finalization
 *
 * @since 4.0.0
 */
import type * as v1 from "kubernetes-types/core/v1.d.ts"
import * as Context from "../../Context.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import { identity } from "../../Function.ts"
import * as RcRef from "../../RcRef.ts"
import * as Scope from "../../Scope.ts"
import * as Entity from "./Entity.ts"
import * as K8sHttpClient from "./K8sHttpClient.ts"
import type { Sharding } from "./Sharding.ts"

/**
 * Type identifier used to brand `EntityResource` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~effect/cluster/EntityResource"

/**
 * Literal type of the `EntityResource` type identifier.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~effect/cluster/EntityResource"

/**
 * A resource acquired inside a cluster entity and kept alive across restarts.
 *
 * **Details**
 *
 * `get` acquires or reuses the resource in the caller's scope, while `close`
 * invalidates it so its close scope can be released.
 *
 * @category models
 * @since 4.0.0
 */
export interface EntityResource<out A, out E = never> {
  readonly [TypeId]: TypeId
  readonly get: Effect.Effect<A, E, Scope.Scope>
  readonly close: Effect.Effect<void>
}

/**
 * Context service for a Scope that is only closed when the resource is explicitly closed.
 *
 * **Gotchas**
 *
 * It is not closed during restarts, due to shard movement or node shutdowns.
 *
 * @category resource management
 * @since 4.0.0
 */
export class CloseScope extends Context.Service<
  CloseScope,
  Scope.Scope
>()("effect/cluster/EntityResource/CloseScope") {}

/**
 * Creates an `EntityResource` that can be acquired inside a cluster entity.
 *
 * **Details**
 *
 * The resource will only be fully released when the idle time to live is
 * reached, or when the `close` effect is called.
 *
 * **Gotchas**
 *
 * By default, the `idleTimeToLive` is infinite, meaning the resource will only
 * be released when `close` is called.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: <A, E, R>(options: {
  readonly acquire: Effect.Effect<A, E, R>
  readonly idleTimeToLive?: Duration.Input | undefined
  readonly acquireEagerly?: boolean | undefined
}) => Effect.Effect<
  EntityResource<A, E>,
  E,
  Scope.Scope | Exclude<R, CloseScope> | Sharding | Entity.CurrentAddress
> = Effect.fnUntraced(function*<A, E, R>(options: {
  readonly acquire: Effect.Effect<A, E, R>
  readonly idleTimeToLive?: Duration.Input | undefined
  readonly acquireEagerly?: boolean | undefined
}) {
  let shuttingDown = false

  const ref = yield* RcRef.make({
    acquire: Effect.gen(function*() {
      yield* Entity.keepAlive(true)

      const closeable = yield* Scope.make()

      yield* Effect.addFinalizer(
        Effect.fnUntraced(function*(exit) {
          if (shuttingDown) return
          yield* Scope.close(closeable, exit)
          yield* Entity.keepAlive(false)
        })
      )

      return yield* options.acquire.pipe(
        Effect.provideService(CloseScope, closeable)
      )
    }),
    idleTimeToLive: options.idleTimeToLive ?? Duration.infinity
  })

  yield* Effect.addFinalizer(() => {
    shuttingDown = true
    return Effect.void
  })

  if (options.acquireEagerly) {
    // Initialize the resource
    yield* Effect.scoped(RcRef.get(ref))
  }

  return identity<EntityResource<A, E>>({
    [TypeId]: TypeId,
    get: RcRef.get(ref),
    close: RcRef.invalidate(ref)
  })
})

/**
 * Creates an `EntityResource` backed by a Kubernetes Pod.
 *
 * **Details**
 *
 * The pod is created and waited on through `K8sHttpClient`, and is kept alive
 * until the resource is closed or its idle time to live expires.
 *
 * @category Kubernetes
 * @since 4.0.0
 */
export const makeK8sPod: (
  spec: v1.Pod,
  options?: {
    readonly idleTimeToLive?: Duration.Input | undefined
  } | undefined
) => Effect.Effect<
  EntityResource<K8sHttpClient.PodStatus>,
  never,
  Scope.Scope | Sharding | Entity.CurrentAddress | K8sHttpClient.K8sHttpClient
> = Effect.fnUntraced(function*(spec: v1.Pod, options?: {
  readonly idleTimeToLive?: Duration.Input | undefined
}) {
  const createPod = yield* K8sHttpClient.makeCreatePod
  return yield* make({
    ...options,
    acquire: Effect.gen(function*() {
      const scope = yield* CloseScope
      return yield* createPod(spec).pipe(
        Scope.provide(scope)
      )
    })
  })
})
