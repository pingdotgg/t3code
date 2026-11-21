/**
 * The alchemy-free half of `AlchemyCloudflareCluster.make`: building the
 * cluster handle from resolved namespace bindings. Kept separate so it can be
 * exercised without importing `alchemy`, whose runtime must match the
 * published `effect` release rather than this workspace.
 *
 * @internal
 */
import type * as Entity from "effect/cluster/Entity"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as CloudflareCluster from "../CloudflareCluster.ts"
import type { SingletonWakeResult } from "../CloudflareDurableObjectPrograms.ts"
import type { Cluster } from "./cluster.ts"
import { boundedRetry, callDurableObject } from "./transport.ts"

interface SingletonStub {
  // An object still on an older deploy resolves `undefined` on success.
  readonly wake: () => Promise<SingletonWakeResult | undefined>
}

/** @internal */
export interface ClusterHandleOptions {
  readonly entities: ReadonlyArray<Entity.Entity<any, any>>
  readonly layer: Layer.Layer<never, any, any>
  readonly env: Record<string, unknown>
  readonly keepAliveHeartbeat?: Duration.Input | undefined
}

/** @internal */
export const makeClusterHandle = Effect.fnUntraced(function*(options: ClusterHandleOptions) {
  const entityNamespace = options.env.ClusterEntity as DurableObjectNamespace
  const workflowNamespace = options.env.ClusterWorkflow as DurableObjectNamespace
  const queueNamespace = options.env.ClusterDurableQueue as DurableObjectNamespace
  const singletonNamespace = options.env.ClusterSingleton as DurableObjectNamespace

  // The isolate-lifetime scope. workerd has no isolate-teardown hook, so it
  // is never closed; the built services live for the isolate, exactly like
  // the Wrangler path's `setInitializer` build.
  const scope = Scope.makeUnsafe()
  const context = yield* Layer.buildWithScope(
    options.layer.pipe(
      Layer.provideMerge(CloudflareCluster.layer({
        entities: options.entities,
        entityNamespace,
        workflowNamespace,
        queueNamespace,
        singletonNamespace,
        keepAliveHeartbeat: options.keepAliveHeartbeat
      }))
    ),
    scope
  ).pipe(
    // Drop the build's memo map so a Layer the user provides inside a
    // handler builds per event instead of sharing one instance pinned to
    // the first request's IoContext.
    Effect.map(Context.omit(Layer.CurrentMemoMap))
  )

  const handle: Cluster<never> = {
    provide: (effect) => Effect.provideContext(effect, context),
    // Only a transport failure rejects `wake()`, so retrying never reruns a
    // failed singleton. A failed run still fails the Cron Trigger.
    wake: (name) => () =>
      callDurableObject({
        resolve: () => singletonNamespace.getByName(`Singleton/${name}`) as unknown as SingletonStub,
        call: (stub) => stub.wake(),
        retry: boundedRetry
      }).pipe(
        Effect.orDie,
        Effect.flatMap((result) =>
          result?._tag === "Failure"
            ? Effect.die(new Error(`Singleton "${name}" failed: ${result.message}`))
            : Effect.void
        )
      ),
    entityNamespace,
    workflowNamespace,
    queueNamespace,
    singletonNamespace,
    context
  }
  return handle
})

/**
 * The plan-time handle: the deploy-machine evaluation only discovers the
 * Durable Object declarations, and nothing returned from the Worker init
 * program runs outside the deployed isolate.
 *
 * @internal
 */
export const inertClusterHandle = (): Cluster<never> => ({
  provide: (effect) => effect,
  wake: () => () => Effect.void,
  get entityNamespace() {
    return planTimeOnly("entityNamespace")
  },
  get workflowNamespace() {
    return planTimeOnly("workflowNamespace")
  },
  get queueNamespace() {
    return planTimeOnly("queueNamespace")
  },
  get singletonNamespace() {
    return planTimeOnly("singletonNamespace")
  },
  get context() {
    return planTimeOnly("context")
  }
})

const planTimeOnly = (field: string): never => {
  throw new Error(
    `AlchemyCloudflareCluster: '${field}' is only available at runtime, not during plan evaluation`
  )
}
