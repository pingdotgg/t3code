import { assert, describe, it } from "@effect/vitest"
import { type Cause, Deferred, Effect, Exit, Fiber, Queue, Schema, Stream } from "effect"
import { Entity, ShardingConfig } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { CallerId, ContextBleedEntity, ContextBleedLayer, TestEntity, TestEntityLayer, User } from "./TestEntity.ts"

const StreamEntity = Entity.make("StreamEntity", [
  Rpc.make("Watch", {
    success: Schema.Number,
    stream: true
  })
])

const FatalDefectEntity = Entity.make("FatalDefectEntity", [
  Rpc.make("Hold", { success: Schema.Number }),
  Rpc.make("Bad", { error: Schema.String })
])

const snapshot = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? { _tag: "Success", value: exit.value }
    : {
      _tag: "Failure",
      reasons: exit.cause.reasons.map((reason) =>
        reason._tag === "Die"
          ? { _tag: reason._tag, defect: reason.defect }
          : reason._tag === "Fail"
          ? { _tag: reason._tag, error: reason.error }
          : { _tag: reason._tag }
      )
    }

const observeFatalDefect = (disableFatalDefects: boolean | undefined, defecting: boolean, separateIds = false) =>
  Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const layer = FatalDefectEntity.toLayer({
      Hold: () =>
        Effect.gen(function*() {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return 42
        }),
      Bad: () => defecting ? Effect.die("fixture defect") : Effect.fail("typed failure")
    }, {
      concurrency: "unbounded",
      ...(disableFatalDefects === undefined ? {} : { disableFatalDefects })
    })
    const clientFor = yield* Entity.makeTestClient(FatalDefectEntity, layer)
    const holdClient = yield* clientFor("one")
    const badClient = yield* clientFor(separateIds ? "two" : "one")
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    const good = yield* Effect.forkChild(holdClient.Hold())
    yield* Deferred.await(entered)
    const badExit = yield* Effect.exit(badClient.Bad())
    yield* Deferred.succeed(release, undefined)
    const goodExit = yield* Fiber.await(good)
    return { badExit: snapshot(badExit), goodExit: snapshot(goodExit) }
  }).pipe(Effect.provide(ShardingConfig.layerDefaults), Effect.timeout("5 seconds"))

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

    for (const flag of [true, false, undefined]) {
      const label = flag === undefined ? "omitted" : String(flag)
      it.live(`isolates defects when disableFatalDefects is ${label}`, () =>
        Effect.gen(function*() {
          const actual = yield* observeFatalDefect(flag, true)
          assert.deepEqual(actual.badExit, snapshot(Exit.die("fixture defect")), "Bad preserves the original defect")
          assert.deepEqual(
            actual.goodExit,
            snapshot(flag === true ? Exit.succeed(42) : Exit.die("fixture defect")),
            "Hold isolation follows the registered flag"
          )
        }))

      it.live(`keeps typed failures request-local when disableFatalDefects is ${label}`, () =>
        Effect.gen(function*() {
          const actual = yield* observeFatalDefect(flag, false)
          assert.deepEqual(actual.badExit, snapshot(Exit.fail("typed failure")))
          assert.deepEqual(actual.goodExit, snapshot(Exit.succeed(42)))
        }))
    }

    it.live("does not send fatal defects across entity IDs", () =>
      Effect.gen(function*() {
        const actual = yield* observeFatalDefect(false, true, true)
        assert.deepEqual(actual.badExit, snapshot(Exit.die("fixture defect")))
        assert.deepEqual(actual.goodExit, snapshot(Exit.succeed(42)))
      }))
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
