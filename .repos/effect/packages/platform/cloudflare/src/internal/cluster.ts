/**
 * Shared cluster handle types without the Alchemy dependency graph.
 *
 * @since 4.1.3
 */
import type * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

/**
 * The handle returned by `AlchemyCloudflareCluster.make`.
 *
 * **Gotchas**
 *
 * Namespace bindings and `context` are available only in the deployed runtime.
 * Reading them during plan evaluation throws a diagnostic; `provide` and
 * `wake` remain inert during planning.
 *
 * @category models
 * @since 4.1.3
 */
export interface Cluster<in R = never> {
  /**
   * Attaches the built cluster context to a user Effect, for the Worker's
   * `fetch` handler and other entrypoints. Only provides the already-built
   * Context; it does not open a new Scope.
   */
  readonly provide: <A, E, R2>(effect: Effect.Effect<A, E, R2>) => Effect.Effect<A, E, Exclude<R2, R>>
  /**
   * A handler that wakes the named singleton, for `Cloudflare.Workers.cron`.
   * The name is the singleton name without the `Singleton/` prefix, and the
   * returned handler is already context-provided. A `ClusterCron` fires only
   * once its seed singleton is woken; get its name from
   * `CloudflareCluster.clusterCronSingletonName`.
   */
  readonly wake: (name: string) => () => Effect.Effect<void>
  /**
   * The native namespace binding of the cluster entity class.
   */
  readonly entityNamespace: DurableObjectNamespace
  /**
   * The native namespace binding of the workflow class.
   */
  readonly workflowNamespace: DurableObjectNamespace
  /**
   * The native namespace binding of the durable queue class.
   */
  readonly queueNamespace: DurableObjectNamespace
  /**
   * The native namespace binding of the singleton class.
   */
  readonly singletonNamespace: DurableObjectNamespace
  /**
   * The Context built from the cluster layer and the user layer into the
   * isolate-lifetime Scope.
   */
  readonly context: Context.Context<R>
}
