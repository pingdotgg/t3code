import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import {
  ClusterSchema,
  Entity,
  MessageRetention,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig
} from "effect/cluster"
import { Rpc } from "effect/rpc"
import { TestClock } from "effect/testing"

const Hit = Rpc.make("Hit", {
  payload: { id: Schema.String },
  success: Schema.Number,
  primaryKey: ({ id }) => id
})

const RetentionSharding = Sharding.layer.pipe(
  Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop, Runners.layerNoop]),
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provide(ShardingConfig.layer({
    entityMailboxCapacity: 10,
    entityTerminationTimeout: 0,
    entityMessagePollInterval: 5000,
    sendRetryInterval: 100,
    refreshAssignmentsInterval: 0
  }))
)

describe("MessageRetention", { concurrent: false }, () => {
  it.effect("forgets completed requests of entities registered with MessageRetention", () =>
    Effect.gen(function*() {
      const Retained = Entity.make("Retained", [Hit]).annotateRpcs(ClusterSchema.Persisted, true)
      const Unretained = Entity.make("Unretained", [Hit]).annotateRpcs(ClusterSchema.Persisted, true)
      const runs = { retained: 0, unretained: 0 }
      const layer = Layer.mergeAll(
        Retained.toLayer({ Hit: () => Effect.sync(() => ++runs.retained) }),
        MessageRetention.make({ entity: Retained, retention: "10 minutes", interval: "1 minute" }),
        Unretained.toLayer({ Hit: () => Effect.sync(() => ++runs.unretained) })
      ).pipe(Layer.provideMerge(RetentionSharding))

      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const retained = (yield* Retained.client)("one")
        const unretained = (yield* Unretained.client)("one")
        const hitBoth = Effect.all([retained.Hit({ id: "a" }), unretained.Hit({ id: "a" })])
        yield* hitBoth

        // the reply is younger than the retention, so the duplicate is still answered from storage
        yield* TestClock.adjust("5 minutes")
        yield* hitBoth
        expect(runs).toEqual({ retained: 1, unretained: 1 })

        yield* TestClock.adjust("6 minutes")
        yield* hitBoth
        expect(runs).toEqual({ retained: 2, unretained: 1 })
      }).pipe(Effect.provide(layer))
    }))
})
