/**
 * Register effects that should have one active owner in an Effect cluster.
 *
 * `Singleton.make` wraps `Sharding.registerSingleton` in a `Layer`. When the
 * local runner owns the shard for the singleton's name and shard group,
 * sharding starts the effect; when ownership moves or the layer scope closes,
 * the running fiber is interrupted and the registration is removed.
 *
 * **Mental model**
 *
 * A singleton is still placed on a shard. Its name and optional shard group
 * determine the shard id, and the runner that acquires that shard lock is the
 * only runner allowed to execute it. Failover is handled by shard ownership, so
 * another runner can resume the singleton after the previous owner leaves.
 *
 * **Common tasks**
 *
 * - Start one scheduler, consumer, polling loop, or maintenance process for a
 *   whole cluster
 * - Register that process as part of application wiring with `Layer`
 * - Choose a `shardGroup` when singleton ownership should be coordinated with a
 *   specific group of clustered work
 *
 * **Gotchas**
 *
 * - Design the effect to be interruptible and idempotent; ownership can move
 *   while work is in flight.
 * - Duplicate singleton names in the same shard group fail during registration.
 * - Handle expected failures inside the effect when it should keep running,
 *   because unhandled failures are surfaced as defects by sharding.
 *
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import type { Scope } from "../../Scope.ts"
import { Sharding } from "./Sharding.ts"

/**
 * Creates a layer that registers a singleton effect with `Sharding` under the
 * specified name and optional shard group.
 *
 * **When to use**
 *
 * Use to register a cluster-wide background effect as a `Layer`, so the effect
 * is started only by the runner that currently owns the singleton's shard.
 *
 * **Details**
 *
 * The returned layer requires `Sharding` and the services needed by `run`,
 * except for `Scope`. The registration is scoped to the layer; closing the
 * layer removes the singleton registration and stops the singleton fiber if it
 * is running.
 *
 * **Gotchas**
 *
 * - Registering the same singleton name in the same shard group more than once
 *   dies during registration.
 * - A `run` effect that completes normally is kept alive until the registration
 *   scope closes or shard ownership moves.
 * - Failures from `run` are converted to defects, so handle expected failures
 *   inside `run` when the singleton should keep running.
 *
 * @see {@link Sharding} for the lower-level service that registers singletons and manages shard ownership
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <E, R>(
  name: string,
  run: Effect.Effect<void, E, R>,
  options?: {
    readonly shardGroup?: string | undefined
  }
): Layer.Layer<never, never, Sharding | Exclude<R, Scope>> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const sharding = yield* Sharding
    yield* sharding.registerSingleton(name, run, options)
  }))
