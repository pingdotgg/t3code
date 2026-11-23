/**
 * Deploys the Cloudflare cluster with Alchemy v2 ("Infrastructure as
 * Effects").
 *
 * `make` runs inside an Effect-native `Cloudflare.Worker` init program. It
 * registers the four cluster Durable Object classes on the hosting Worker
 * (bindings, class exports, and SQLite migrations are all owned by Alchemy),
 * builds the cluster layer together with the user's handler layer into the
 * isolate-lifetime scope, and returns a handle for wiring the built context
 * into the Worker's handlers. The user never declares or re-exports Durable
 * Object classes.
 *
 * The Wrangler path (`CloudflareDurableObjects` + `CloudflareCluster.layer`)
 * never imports this module; `@alchemy.run/cloudflare` is an optional peer
 * dependency needed only here.
 *
 * **Example** (Declaring a cluster)
 *
 * ```ts
 * import * as Cloudflare from "@alchemy.run/cloudflare"
 * import { Effect, Layer } from "effect"
 * import { make } from "@effect/platform-cloudflare/AlchemyCloudflareCluster"
 * import { CloudflareCluster } from "@effect/platform-cloudflare"
 *
 * export default Cloudflare.Worker("MyApp", {
 *   main: import.meta.url
 * }, Effect.gen(function*() {
 *   const cluster = yield* make({
 *     entities: [Counter],
 *     layer: Layer.mergeAll(CounterLayer, MaintenanceLayer, NightlyReport)
 *   })
 *
 *   yield* Cloudflare.Workers.cron("0 * * * *", cluster.wake("hourly-maintenance"))
 *   // A ClusterCron fires only after a Cron Trigger wakes its seed singleton
 *   yield* Cloudflare.Workers.cron(
 *     "30 * * * *",
 *     cluster.wake(CloudflareCluster.clusterCronSingletonName("nightly-report"))
 *   )
 *
 *   return {
 *     fetch: cluster.provide(handler)
 *   }
 * }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive)))
 * ```
 *
 * @stability experimental
 * @since 4.1.3
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Entity from "effect/cluster/Entity"
import type { Sharding } from "effect/cluster/Sharding"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type { PersistedQueueFactory } from "effect/persistence/PersistedQueue"
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine"
import {
  type DurableObjectProgramState,
  makeClusterDurableQueueProgram,
  makeClusterEntityProgram,
  makeClusterSingletonProgram,
  makeClusterWorkflowProgram
} from "./CloudflareDurableObjectPrograms.ts"
import { inertClusterHandle, makeClusterHandle } from "./internal/alchemyCluster.ts"
import type { Cluster } from "./internal/cluster.ts"

declare global {
  // Set by Alchemy's bundler in deployed Workers; unset while planning.
  // Declared by `alchemy/Phase` too, which this module does not import.
  var __ALCHEMY_RUNTIME__: boolean | undefined
}

/**
 * The services `make` builds on top of the user layer: the cluster `Sharding`
 * service, the workflow engine, and the persisted queue factory.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export type ClusterServices = Sharding | WorkflowEngine | PersistedQueueFactory

export type {
  /**
   * The handle returned by {@link make}.
   *
   * **Gotchas**
   *
   * Namespace bindings and `context` are available only in the deployed runtime.
   * Reading them during plan evaluation throws a diagnostic; `provide` and
   * `wake` remain inert during planning.
   *
   * @stability experimental
   * @category models
   * @since 4.1.3
   */
  Cluster
} from "./internal/cluster.ts"

/**
 * The entity definitions and handler layer the cluster is built from.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export interface MakeOptions<ROut, E, RIn> {
  /**
   * The complete set of entity definitions the Worker serves, as in
   * `CloudflareCluster.LayerOptions`.
   */
  readonly entities: ReadonlyArray<Entity.Entity<any, any>>
  /**
   * The user's merged handler layers: entity handlers, singletons, workflow
   * handlers, and any services they need.
   */
  readonly layer: Layer.Layer<ROut, E, RIn>
  /**
   * Interval of the entity keep-alive heartbeat alarm, as in
   * `CloudflareCluster.LayerOptions`. Defaults to 30 seconds.
   */
  readonly keepAliveHeartbeat?: Duration.Input | undefined
}

// One alchemy Durable Object class per cluster program. The outer effect
// resolves the instance state; the inner effect runs per activation, under
// alchemy's blockConcurrencyWhile, once the shared isolate init (and so the
// user's handler registrations) has completed. The program handle is the RPC
// shape: every method returns an Effect and `alarm` matches alchemy's hook.
// `fetch` is omitted on purpose: cluster RPCs use the native bindings, so
// alchemy's default 404 stands in for the Wrangler classes' rejection.
const durableObject = <Shape extends Record<string, (...args: Array<any>) => Effect.Effect<any>>>(
  className: string,
  program: (state: DurableObjectProgramState) => Effect.Effect<Shape>
) =>
  Cloudflare.DurableObject<Shape>()(
    className,
    Effect.map(Cloudflare.DurableObjectState, (state) => program(state.raw as DurableObjectProgramState))
  )

const ClusterEntity = durableObject("ClusterEntity", makeClusterEntityProgram)
const ClusterWorkflow = durableObject("ClusterWorkflow", makeClusterWorkflowProgram)
const ClusterDurableQueue = durableObject("ClusterDurableQueue", makeClusterDurableQueueProgram)
const ClusterSingleton = durableObject("ClusterSingleton", makeClusterSingletonProgram)

const makeUnsafe = Effect.fnUntraced(function*(options: MakeOptions<any, any, any>) {
  // Register the four Durable Object classes on the hosting Worker. At plan
  // time this declares the bindings and class exports Alchemy deploys; at
  // runtime it resolves the same bindings in every isolate, Worker and
  // Durable Object alike.
  yield* ClusterEntity
  yield* ClusterWorkflow
  yield* ClusterDurableQueue
  yield* ClusterSingleton

  if (!globalThis.__ALCHEMY_RUNTIME__) {
    // Plan/deploy evaluation only discovers the declarations above.
    return inertClusterHandle()
  }

  const env = yield* Cloudflare.WorkerEnvironment
  return yield* makeClusterHandle({
    entities: options.entities,
    layer: options.layer,
    env,
    keepAliveHeartbeat: options.keepAliveHeartbeat
  })
})

/**
 * Builds the Cloudflare cluster inside an Effect-native Alchemy Worker.
 *
 * **Details**
 *
 * Always registers all four Durable Object classes (entity, workflow, durable
 * queue, singleton) on the hosting Worker, so Alchemy owns their bindings and
 * SQLite migrations across deploys. At runtime it builds
 * `CloudflareCluster.layer` merged with the user's handler layer into the
 * isolate-lifetime Scope — the Scope is never closed, so do not wrap the
 * Worker init program in `Effect.provide(layer)` for cluster services.
 *
 * The returned handle exposes `provide` for the Worker's handlers, `wake` for
 * user-declared Cron Triggers
 * (`Cloudflare.Workers.cron(expr, cluster.wake("name"))`), and the four
 * native namespace bindings as escape hatches.
 *
 * A `ClusterCron` fires only after a Cron Trigger wakes its seed singleton.
 * Pass `CloudflareCluster.clusterCronSingletonName(name)` to `wake` for it.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.3
 */
export const make: <ROut, E, RIn>(
  options: MakeOptions<ROut, E, RIn>
) => Effect.Effect<
  Cluster<ROut | ClusterServices>,
  E,
  Cloudflare.Worker | Exclude<RIn, ClusterServices>
> = makeUnsafe as any
