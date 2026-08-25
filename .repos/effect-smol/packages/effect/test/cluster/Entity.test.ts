import { assert, describe, it } from "@effect/vitest"
import { type Cause, Effect, Queue, Schema, Stream } from "effect"
import { Entity, ShardingConfig } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc/index"
import { CallerId, ContextBleedEntity, ContextBleedLayer, TestEntity, TestEntityLayer, User } from "./TestEntity.ts"

const StreamEntity = Entity.make("StreamEntity", [
  Rpc.make("Watch", {
    success: Schema.Number,
    stream: true
  })
])

describe.concurrent("Entity", () => {
  describe("makeTestClient", () => {
    it.effect("creates an in-memory client for an entity layer", () =>
      Effect.gen(function*() {
        const makeClient = yield* Entity.makeTestClient(TestEntity, TestEntityLayer)
        const client = yield* makeClient("123")
        const user = yield* client.GetUser({ id: 1 })
        assert.deepEqual(user, new User({ id: 1, name: "User 1" }))
      }).pipe(Effect.provide(TestShardingConfig)))

    it.effect("does not freeze the acquiring fiber's context into the entity server", () =>
      Effect.gen(function*() {
        const makeClient = yield* Entity.makeTestClient(ContextBleedEntity, ContextBleedLayer)

        const client = yield* makeClient("1").pipe(Effect.provideService(CallerId, "A"))

        const observed = yield* client.ReadCaller()
        assert.strictEqual(observed, "none")
      }).pipe(Effect.provide(TestShardingConfig)))
  })

  describe("toLayerQueue", () => {
    it.effect("replies to a streaming RPC with a Stream", () =>
      Effect.gen(function*() {
        const layer = StreamEntity.toLayerQueue((mailbox, replier) =>
          Effect.gen(function*() {
            while (true) {
              const req = yield* Queue.take(mailbox)
              yield* replier.succeed(req, Stream.make(1, 2, 3))
            }
          })
        )

        const makeClient = yield* Entity.makeTestClient(StreamEntity, layer)
        const client = yield* makeClient("entity-1")
        const results: Array<number> = []
        yield* client.Watch().pipe(
          Stream.take(3),
          Stream.runForEach((n) => Effect.sync(() => results.push(n)))
        )
        assert.deepEqual(results, [1, 2, 3])
      }).pipe(Effect.provide(TestShardingConfig)))

    it.effect("replies to a streaming RPC with a Dequeue", () =>
      Effect.gen(function*() {
        const layer = StreamEntity.toLayerQueue((mailbox, replier) =>
          Effect.gen(function*() {
            while (true) {
              const req = yield* Queue.take(mailbox)
              const q = yield* Queue.make<number, Cause.Done>()
              yield* replier.succeed(req, q)
              yield* Queue.offer(q, 1)
              yield* Queue.offer(q, 2)
              yield* Queue.offer(q, 3)
              yield* Queue.end(q)
            }
          }) as Effect.Effect<never>
        )

        const makeClient = yield* Entity.makeTestClient(StreamEntity, layer)
        const client = yield* makeClient("entity-1")
        const results: Array<number> = []
        yield* client.Watch().pipe(
          Stream.take(3),
          Stream.runForEach((n) => Effect.sync(() => results.push(n)))
        )
        assert.deepEqual(results, [1, 2, 3])
      }).pipe(Effect.provide(TestShardingConfig)))
  })
})

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 5000,
  sendRetryInterval: 100
})
