/// <reference types="@cloudflare/workers-types" />
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as AlchemyCloudflareCluster from "@effect/platform-cloudflare/AlchemyCloudflareCluster"
import { Entity, Singleton } from "effect/cluster"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import { Rpc } from "effect/rpc"
import * as Schema from "effect/Schema"
import { describe, expect, test } from "tstyche"

const Counter = Entity.make("Counter", [
  Rpc.make("Increment", { success: Schema.Number })
])

const CounterLayer = Counter.toLayer(
  Effect.sync(() =>
    Counter.of({
      Increment: () => Effect.succeed(1)
    })
  )
)

const MaintenanceLayer = Singleton.make("hourly-maintenance", Effect.void)

class UserService extends Context.Service<UserService, "user">()("UserService") {}

const made = AlchemyCloudflareCluster.make({
  entities: [Counter],
  layer: Layer.mergeAll(CounterLayer, MaintenanceLayer)
})

declare const cluster: Effect.Success<typeof made>

describe("make", () => {
  test("a layer needing only cluster services leaves just the Worker requirement", () => {
    expect(made).type.toBe<
      Effect.Effect<
        AlchemyCloudflareCluster.Cluster<AlchemyCloudflareCluster.ClusterServices>,
        never,
        Cloudflare.Worker
      >
    >()
  })

  test("unsatisfied user layer requirements surface on the init program", () => {
    const withService = AlchemyCloudflareCluster.make({
      entities: [Counter],
      layer: Layer.effectDiscard(Effect.gen(function*() {
        yield* UserService
      })).pipe(Layer.provideMerge(CounterLayer))
    })
    expect(withService).type.toBe<
      Effect.Effect<
        AlchemyCloudflareCluster.Cluster<AlchemyCloudflareCluster.ClusterServices>,
        never,
        Cloudflare.Worker | UserService
      >
    >()
  })

  test("user layer outputs join the handle context", () => {
    const withOutput = AlchemyCloudflareCluster.make({
      entities: [Counter],
      layer: Layer.succeed(UserService, "user")
    })
    expect(withOutput).type.toBe<
      Effect.Effect<
        AlchemyCloudflareCluster.Cluster<UserService | AlchemyCloudflareCluster.ClusterServices>,
        never,
        Cloudflare.Worker
      >
    >()
  })
})

describe("Cluster handle", () => {
  test("provide eliminates the cluster services from user Effects", () => {
    const handler = Effect.gen(function*() {
      const makeCounter = yield* Counter.client
      const value = yield* Effect.orDie(makeCounter("counter-1").Increment(void 0))
      return HttpServerResponse.text(String(value))
    })
    expect(cluster.provide(handler)).type.toBe<
      Effect.Effect<HttpServerResponse.HttpServerResponse>
    >()
  })

  test("wake produces a handler acceptable to Cloudflare.Workers.cron", () => {
    expect(cluster.wake("hourly-maintenance")).type.toBe<() => Effect.Effect<void>>()
    expect(Cloudflare.Workers.cron).type.toBeCallableWith(
      "0 * * * *",
      cluster.wake("hourly-maintenance")
    )
  })
})

describe("binding wiring", () => {
  const app = Cloudflare.Worker(
    "EffectCluster",
    {
      main: "./worker.ts"
    },
    Effect.gen(function*() {
      const cluster = yield* made
      yield* Cloudflare.Workers.cron("0 * * * *", cluster.wake("hourly-maintenance"))
      return {
        fetch: cluster.provide(Effect.succeed(HttpServerResponse.empty()))
      }
    }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive))
  )

  test("the worker init program satisfies the Effect-native Worker contract", () => {
    expect(app).type.not.toBe<any>()
    expect<Effect.Success<typeof app>>().type.toBeAssignableTo<Cloudflare.Worker>()
  })
})
