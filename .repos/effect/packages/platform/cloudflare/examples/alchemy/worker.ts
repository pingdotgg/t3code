/**
 * Minimal Alchemy deployment of the Cloudflare cluster: one entity, one
 * singleton, and one user-declared Cron Trigger.
 *
 * Deploy with `alchemy deploy` from this directory (see `alchemy.run.ts`).
 *
 * @stability experimental
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as AlchemyCloudflareCluster from "@effect/platform-cloudflare/AlchemyCloudflareCluster"
import { Entity, Singleton } from "effect/cluster"
import * as Effect from "effect/Effect"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import { Rpc } from "effect/rpc"
import * as Schema from "effect/Schema"

const Counter = Entity.make("Counter", [
  Rpc.make("Increment", { success: Schema.Number })
])

// Handlers are built once per entity Durable Object wake; this count is
// in-memory demo state, not durable storage.
const CounterLayer = Counter.toLayer(
  Effect.sync(() => {
    let count = 0
    return Counter.of({
      Increment: () => Effect.sync(() => ++count)
    })
  })
)

const MaintenanceLayer = Singleton.make(
  "hourly-maintenance",
  Effect.logInfo("Running hourly maintenance")
)

/**
 * @stability experimental
 */
export default Cloudflare.Worker(
  "EffectCluster",
  {
    main: import.meta.url
  },
  Effect.gen(function*() {
    const cluster = yield* AlchemyCloudflareCluster.make({
      entities: [Counter],
      layer: Layer.mergeAll(CounterLayer, MaintenanceLayer)
    })

    yield* Cloudflare.Workers.cron("0 * * * *", cluster.wake("hourly-maintenance"))

    return {
      fetch: cluster.provide(Effect.gen(function*() {
        const request = yield* HttpServerRequest
        const makeCounter = yield* Counter.client
        const counterId = new URL(request.url, "http://cluster").pathname.slice(1) || "default"
        const value = yield* Effect.orDie(makeCounter(counterId).Increment(void 0))
        return HttpServerResponse.text(String(value))
      }))
    }
  }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive))
)
