import { assert, describe, expect, it } from "@effect/vitest"
import { Array, Cause, Clock, Context, Effect, Exit, Fiber, Layer, MutableRef, Option, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  ClusterMetrics,
  EntityId,
  MachineId,
  MessageStorage,
  Runner,
  RunnerAddress,
  RunnerHealth,
  Runners,
  RunnerStorage,
  ShardId,
  Sharding,
  ShardingConfig,
  Snowflake
} from "effect/unstable/cluster"
import {
  CallerId,
  ContextBleedEntity,
  ContextBleedLayer,
  TestEntity,
  TestEntityNoState,
  TestEntityState,
  User
} from "./TestEntity.ts"

describe.concurrent("Sharding", () => {
  it.effect("delivers volatile requests directly to the entity", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust(1)
      const makeClient = yield* TestEntity.client
      const client = makeClient("1")
      const user = yield* client.GetUserVolatile({ id: 1 })
      expect(user).toEqual(new User({ id: 1, name: "User 1" }))
    }).pipe(Effect.provide(TestSharding)))

  it.effect("does not freeze the first caller's context into the entity server", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust(1)
      const makeClient = yield* ContextBleedEntity.client
      const client = makeClient("1")

      const first = yield* client.ReadCaller().pipe(Effect.provideService(CallerId, "A"))
      expect(first).toEqual("A")

      const second = yield* client.ReadCaller()
      expect(second).toEqual("none")

      const durable = yield* client.ReadCallerPersisted()
      expect(durable).toEqual("none")
    }).pipe(Effect.provide(ContextBleedSharding)))

  it.effect("persists durable requests until the entity replies", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust(1)
      const driver = yield* MessageStorage.MemoryDriver
      const makeClient = yield* TestEntity.client
      const client = makeClient("1")
      const user = yield* client.GetUser({ id: 1 })
      expect(user).toEqual(new User({ id: 1, name: "User 1" }))
      expect(driver.journal.length).toEqual(1)
      expect(driver.unprocessed.size).toEqual(0)
    }).pipe(Effect.provide(TestSharding)))

  it.effect("routes durable interrupts through storage", () =>
    Effect.gen(function*() {
      const driver = yield* MessageStorage.MemoryDriver
      const state = yield* TestEntityState
      const makeClient = yield* TestEntity.client
      yield* TestClock.adjust(1)
      const client = makeClient("1")

      const fiber = yield* client.Never().pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(1)
      yield* Fiber.interrupt(fiber)

      yield* TestClock.adjust(1)
      expect(driver.journal.length).toEqual(2)
      expect(driver.replyIds.size).toEqual(1)
      expect(Queue.sizeUnsafe(state.interrupts)).toEqual(1)
    }).pipe(Effect.provide(TestSharding)))

  it.effect("interrupts aren't sent for durable messages on shutdown", () =>
    Effect.gen(function*() {
      let driver!: MessageStorage.MemoryDriver["Service"]
      yield* Effect.gen(function*() {
        driver = yield* MessageStorage.MemoryDriver
        const makeClient = yield* TestEntity.client
        yield* TestClock.adjust(1)
        const client = makeClient("1")
        yield* client.Never().pipe(Effect.forkChild)
        yield* TestClock.adjust(1)
      }).pipe(Effect.provide(TestSharding))

      // request, client interrupt is dropped
      expect(driver.journal.length).toEqual(1)
      // server interrupt is not sent
      expect(driver.replyIds.size).toEqual(0)
    }))

  it.effect("interrupts are sent for volatile messages on shutdown", () =>
    Effect.gen(function*() {
      let interrupted = false
      const testClock = (yield* Clock.Clock) as TestClock.TestClock

      yield* Effect.gen(function*() {
        const makeClient = yield* TestEntity.client
        const client = makeClient("1")
        const fiber = yield* client.NeverVolatile().pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(1)
        const config = yield* ShardingConfig.ShardingConfig
        ;(config as any).runnerAddress = Option.some(RunnerAddress.make("localhost", 1234))
        fiber.currentDispatcher.scheduleTask(() => {
          fiber.interruptUnsafe()
          Effect.runFork(testClock.adjust(30000))
        }, 0)
      }).pipe(
        Effect.provide(TestShardingWithoutRunners.pipe(
          Layer.provide(
            Layer.effect(Runners.Runners)(
              Effect.gen(function*() {
                const runners = yield* Runners.makeNoop
                return {
                  ...runners,
                  send(options) {
                    if (options.message.envelope._tag === "Interrupt") {
                      interrupted = true
                      return Effect.void
                    }
                    return runners.send(options)
                  }
                }
              })
            )
          ),
          Layer.provide([MessageStorage.layerMemory, Snowflake.layerGenerator]),
          Layer.provideMerge(ShardingConfig.layer({
            entityMailboxCapacity: 10,
            entityTerminationTimeout: 30000,
            entityMessagePollInterval: 5000,
            sendRetryInterval: 100,
            refreshAssignmentsInterval: 100
          }))
        ))
      )

      assert.isTrue(interrupted)
    }))

  it.effect("malformed message in storage", () =>
    Effect.gen(function*() {
      const driver = yield* MessageStorage.MemoryDriver
      const makeClient = yield* TestEntity.client
      yield* TestClock.adjust(1)
      const client = makeClient("1")

      const fiber = yield* client.Never().pipe(Effect.forkChild)
      yield* TestClock.adjust(1)

      const request = driver.journal[0]
      yield* driver.encoded.saveEnvelope({
        envelope: {
          id: "boom",
          _tag: "Interrupt",
          requestId: request.requestId,
          address: {
            shardId: request.address.shardId
          } as any
        },
        primaryKey: null,
        deliverAt: null
      })

      // wait for storage to poll
      yield* TestClock.adjust(5000)

      const exit = fiber.pollUnsafe()
      assert(exit && Exit.isFailure(exit) && Cause.hasDies(exit.cause))

      // malformed message should be left in the database
      expect(driver.journal.length).toEqual(2)
      // defect reply should be sent
      expect(driver.replyIds.size).toEqual(1)

      const reply = driver.requests.get(request.requestId)!.replies[0]
      assert(reply._tag === "WithExit" && reply.exit._tag === "Failure" && reply.exit.cause[0]._tag === "Die")
    }).pipe(Effect.provide(TestSharding)))

  it.effect("fails volatile requests immediately when the mailbox is full", () =>
    Effect.gen(function*() {
      const makeClient = yield* TestEntity.client
      yield* TestClock.adjust(1)
      const client = makeClient("1")

      yield* client.NeverVolatile().pipe(Effect.forkChild, Effect.replicateEffect(10))
      yield* TestClock.adjust(1)
      const error = yield* client.NeverVolatile().pipe(Effect.flip)
      assert.strictEqual(error._tag, "MailboxFull")
    }).pipe(Effect.provide(TestSharding)))

  it.effect("durable messages are retried when mailbox is full", () =>
    Effect.gen(function*() {
      const requestedIds = yield* Queue.make<Array<Snowflake.Snowflake>>()
      yield* Effect.gen(function*() {
        const state = yield* TestEntityState
        const makeClient = yield* TestEntity.client
        yield* TestClock.adjust(1)
        const client = makeClient("1")

        const fibers = yield* client.NeverFork().pipe(Effect.forkChild, Effect.replicateEffect(11))
        yield* TestClock.adjust(1)

        // wait for entity to go into resume mode and request ids
        const ids = yield* Queue.take(requestedIds)
        assert.strictEqual(ids.length, 1)

        // test entity should still only have 10 requests
        assert.deepStrictEqual(Queue.sizeUnsafe(state.envelopes), 10)

        // interrupt first request
        yield* Fiber.interrupt(fibers[0])
        yield* TestClock.adjust(100) // let retry happen

        // last request should come through
        assert.deepStrictEqual(Queue.sizeUnsafe(state.envelopes), 11)

        // interrupt second request, now the entity should be back in the main storage loop
        yield* Fiber.interrupt(fibers[1])

        // send another request within mailbox capacity
        yield* client.NeverFork().pipe(Effect.forkChild)
        yield* TestClock.adjust(1)
        yield* Fiber.interruptAll(fibers)
        yield* TestClock.adjust(100)

        // no more ids should have been requested from entity catch up
        assert.deepStrictEqual(Queue.sizeUnsafe(requestedIds), 0)
      }).pipe(Effect.provide(TestShardingWithoutStorage.pipe(
        Layer.updateService(MessageStorage.MessageStorage, (storage) => ({
          ...storage,
          unprocessedMessagesById(messageIds) {
            Queue.offerUnsafe(requestedIds, Array.fromIterable(messageIds))
            return storage.unprocessedMessagesById(messageIds)
          }
        })),
        Layer.provide(MessageStorage.layerMemory),
        Layer.provide(TestShardingConfig)
      )))
    }))

  it.effect("interrupt for future request works while mailbox is full", () =>
    Effect.gen(function*() {
      const state = yield* TestEntityState
      const makeClient = yield* TestEntity.client
      yield* TestClock.adjust(1)
      const client = makeClient("1")

      const fibers = yield* client.NeverFork().pipe(
        Effect.forkChild({ startImmediately: true }),
        Effect.replicateEffect(12)
      )
      yield* TestClock.adjust(1)

      assert.deepStrictEqual(Queue.sizeUnsafe(state.envelopes), 10)

      // interrupt 11th request
      yield* Fiber.interrupt(fibers[10])
      yield* TestClock.adjust(100) // let retry happen
      // interrupt first request, and let the 11th request come through
      yield* Fiber.interrupt(fibers[0])
      yield* TestClock.adjust(100) // let retry happen

      assert.deepStrictEqual(Queue.sizeUnsafe(state.envelopes), 12)
      // second interrupt should be sent
      assert.deepStrictEqual(Queue.sizeUnsafe(state.interrupts), 2)
    }).pipe(Effect.provide(TestSharding)))

  it.effect("delivers durable streams and acknowledges each chunk", () =>
    Effect.gen(function*() {
      const driver = yield* MessageStorage.MemoryDriver
      yield* TestClock.adjust(1)
      const makeClient = yield* TestEntity.client
      const client = makeClient("1")
      const users = yield* client.GetAllUsers({ ids: [1, 2, 3] }).pipe(
        Stream.runCollect
      )
      expect(users).toEqual([
        new User({ id: 1, name: "User 1" }),
        new User({ id: 2, name: "User 2" }),
        new User({ id: 3, name: "User 3" })
      ])

      // 1 request, 3 acks, 4 replies
      expect(driver.journal.length).toEqual(4)
      expect(driver.replyIds.size).toEqual(4)
    }).pipe(Effect.provide(TestSharding)))

  it.effect("durable stream while mailbox is full", () =>
    Effect.gen(function*() {
      const requestedIds = yield* Queue.make<Array<Snowflake.Snowflake>>()
      yield* Effect.gen(function*() {
        const state = yield* TestEntityState
        const makeClient = yield* TestEntity.client
        const client = makeClient("1")

        const fibers = yield* client.NeverFork().pipe(
          Effect.forkChild({ startImmediately: true }),
          Effect.replicateEffect(10)
        )
        yield* TestClock.adjust(1)

        const fiber = yield* client.GetAllUsers({ ids: [1, 2, 3] }).pipe(
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )

        // make sure entity doesn't leave resume mode
        yield* client.NeverFork().pipe(Effect.forkChild({ startImmediately: true }))
        yield* client.NeverFork().pipe(Effect.forkChild({ startImmediately: true }))

        // wait for entity to go into resume mode and request ids
        const ids = yield* Queue.take(requestedIds)
        assert.strictEqual(ids.length, 3)
        assert.deepStrictEqual(Queue.sizeUnsafe(state.envelopes), 10)

        // interrupt first request
        yield* Fiber.interrupt(fibers[0])
        yield* TestClock.adjust(500) // let retry happen

        // last request + NeverFork should come through
        assert.deepStrictEqual(Queue.sizeUnsafe(state.envelopes), 12)

        // acks should be allowed to be sent
        const users = yield* Fiber.join(fiber)
        expect(users).toEqual([
          new User({ id: 1, name: "User 1" }),
          new User({ id: 2, name: "User 2" }),
          new User({ id: 3, name: "User 3" })
        ])

        const driver = yield* MessageStorage.MemoryDriver
        // 13 requests, 3 acks, 1 interrupt, 5 replies
        assert.strictEqual(driver.journal.length, 13 + 3 + 1)
        assert.strictEqual(driver.replyIds.size, 1 + 4)
      }).pipe(Effect.provide(TestShardingWithoutStorage.pipe(
        Layer.provideMerge(Layer.effect(MessageStorage.MemoryDriver)(MessageStorage.MemoryDriver)),
        Layer.updateService(MessageStorage.MessageStorage, (storage) => ({
          ...storage,
          unprocessedMessagesById(messageIds) {
            Queue.offerUnsafe(requestedIds, Array.fromIterable(messageIds))
            return storage.unprocessedMessagesById(messageIds)
          }
        })),
        Layer.provide(MessageStorage.layerMemory),
        Layer.provide(TestShardingConfig)
      )))
    }))

  it.effect("durable messages are retried on restart", () =>
    Effect.gen(function*() {
      const EnvLayer = TestShardingWithoutState.pipe(
        Layer.provide(Runners.layerNoop),
        Layer.provide(TestShardingConfig)
      )
      const driver = yield* MessageStorage.MemoryDriver
      const state = yield* TestEntityState

      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* TestEntity.client
        const client = makeClient("1")
        yield* Effect.forkChild(client.RequestWithKey({ key: "abc" }))
        yield* TestClock.adjust(1)
      }).pipe(
        Effect.provide(EnvLayer),
        Effect.scoped
      )

      // only the request should be in the journal
      expect(driver.journal.length).toEqual(1)
      expect(driver.replyIds.size).toEqual(0)
      expect(driver.unprocessed.size).toEqual(1)

      // add response
      yield* Queue.offer(state.messages, void 0)

      // Let the shards get assigned and storage poll
      yield* TestClock.adjust(5000).pipe(
        Effect.provide(EnvLayer),
        Effect.scoped
      )

      expect(driver.journal.length).toEqual(1)
      expect(driver.replyIds.size).toEqual(1)
      expect(driver.unprocessed.size).toEqual(0)

      // the client should read the result from storage
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* TestEntity.client
        const client = makeClient("1")
        const result = yield* client.RequestWithKey({ key: "abc" })
        expect(result).toEqual(void 0)
      }).pipe(
        Effect.provide(EnvLayer),
        Effect.scoped
      )

      // the request should not hit the entity
      expect(driver.journal.length).toEqual(1)
      expect(driver.replyIds.size).toEqual(1)
      expect(driver.unprocessed.size).toEqual(0)
    }).pipe(Effect.provide(MessageStorage.layerMemory.pipe(
      Layer.provide(TestShardingConfig),
      Layer.merge(TestEntityState.layer)
    ))))

  it.effect("durable streams are resumed on restart", () =>
    Effect.gen(function*() {
      const EnvLayer = TestShardingWithoutState.pipe(
        Layer.provide(Runners.layerNoop),
        Layer.provide(TestShardingConfig)
      )
      const driver = yield* MessageStorage.MemoryDriver
      const state = yield* TestEntityState

      // first chunk
      yield* Queue.offerAll(state.streamMessages, [void 0, void 0])

      yield* Effect.gen(function*() {
        yield* TestClock.adjust(2000)
        const makeClient = yield* TestEntity.client
        const client = makeClient("1")
        yield* Effect.forkChild(Stream.runDrain(client.StreamWithKey({ key: "abc" })))
        yield* TestClock.adjust(2000)
        // second chunk
        yield* Queue.offer(state.streamMessages, void 0)
        yield* TestClock.adjust(2000)
      }).pipe(
        Effect.provide(EnvLayer),
        Effect.scoped
      )

      // 1 request, 2 acks, 2 replies
      expect(driver.journal.length).toEqual(1 + 2)
      expect(driver.replyIds.size).toEqual(2)
      expect(driver.unprocessed.size).toEqual(1)

      // third chunk
      yield* Queue.offerAll(state.streamMessages, [void 0, void 0])
      yield* Queue.end(state.streamMessages)

      // the client should resume
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(5000) // let the shards get assigned and storage poll
        const makeClient = yield* TestEntity.client
        const client = makeClient("1")

        // let the reply loop run
        yield* TestClock.adjust(500).pipe(Effect.forkChild)

        const results = yield* Stream.runCollect(client.StreamWithKey({ key: "abc" }))
        expect(results).toEqual([3, 4])
      }).pipe(
        Effect.provide(EnvLayer),
        Effect.scoped
      )

      // 1 request, 3 acks, 4 replies (3 chunks + WithExit)
      expect(driver.journal.length).toEqual(1 + 3)
      expect(driver.replyIds.size).toEqual(4)
      expect(driver.unprocessed.size).toEqual(0)
    }).pipe(Effect.provide(MessageStorage.layerMemory.pipe(
      Layer.provide(TestShardingConfig),
      Layer.merge(TestEntityState.layer)
    ))))

  it.effect("client discard stores durable requests without waiting for replies", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust(1)
      const driver = yield* MessageStorage.MemoryDriver
      const makeClient = yield* TestEntity.client
      const client = makeClient("1")
      const result = yield* client.GetUser({ id: 123 }, { discard: true })
      expect(result).toEqual(void 0)
      yield* TestClock.adjust(1)
      expect(driver.journal.length).toEqual(1)
      expect(driver.unprocessed.size).toEqual(0)
    }).pipe(Effect.provide(TestSharding)))

  it.effect("client discard returns while the durable request keeps processing", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust(1)
      const driver = yield* MessageStorage.MemoryDriver
      const makeClient = yield* TestEntity.client
      const client = makeClient("1")
      const result = yield* client.Never(void 0, { discard: true })
      expect(result).toEqual(void 0)
      yield* TestClock.adjust(1)
      expect(driver.journal.length).toEqual(1)
      // should still be processing
      expect(driver.unprocessed.size).toEqual(1)
    }).pipe(Effect.provide(TestSharding)))

  it.effect("defects when a durable request has no MessageStorage", () =>
    Effect.gen(function*() {
      const makeClient = yield* TestEntity.client
      const client = makeClient("1")
      const cause = yield* client.Never().pipe(
        Effect.sandbox,
        Effect.flip
      )
      assert(Cause.hasDies(cause))
    }).pipe(Effect.provide(TestShardingWithoutStorage.pipe(
      Layer.provide(MessageStorage.layerNoop)
    ))))

  it.effect("restarts the entity layer after a handler defect", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust(1)
      const state = yield* TestEntityState
      const makeClient = yield* TestEntity.client
      const client = makeClient("1")
      MutableRef.set(state.defectTrigger, true)
      const result = yield* client.GetUser({ id: 123 })
      expect(result).toEqual(new User({ id: 123, name: "User 123" }))
      expect(state.layerBuilds.current).toEqual(2)
    }).pipe(Effect.provide(TestSharding)))

  it.effect("replays in-flight requests when restarting after a defect", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust(1)
      const state = yield* TestEntityState
      const makeClient = yield* TestEntity.client
      const client = makeClient("1")

      yield* client.NeverFork().pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(1)
      assert.strictEqual(Queue.sizeUnsafe(state.envelopes), 1)

      MutableRef.set(state.defectTrigger, true)
      const result = yield* client.GetUser({ id: 123 })
      assert.deepStrictEqual(result, new User({ id: 123, name: "User 123" }))
      assert.strictEqual(state.layerBuilds.current, 2)

      yield* TestClock.adjust(1)
      assert.strictEqual(Queue.sizeUnsafe(state.envelopes), 4)
    }).pipe(Effect.provide(TestSharding)))

  it.effect("WithTransaction is propagated to the entity handler", () =>
    Effect.gen(function*() {
      let isTransaction = false
      let transactionOpen = false
      yield* Effect.gen(function*() {
        const makeClient = yield* TestEntity.client
        yield* TestClock.adjust(1)
        const client = makeClient("1")

        const result = yield* client.WithTransaction({ id: 1 })
        assert.strictEqual(result, true)
        assert.strictEqual(isTransaction, true)
      }).pipe(Effect.provide(TestShardingWithoutStorage.pipe(
        Layer.updateService(MessageStorage.MessageStorage, (storage) => ({
          ...storage,
          withTransaction(effect) {
            return Effect.suspend(() => {
              transactionOpen = true
              return storage.withTransaction(effect)
            }).pipe(
              Effect.ensuring(Effect.sync(() => {
                transactionOpen = false
              }))
            )
          },
          saveReply(reply) {
            return MessageStorage.MemoryTransaction.use((isTransaction_) => {
              isTransaction = isTransaction_
              assert.strictEqual(transactionOpen, true)
              return storage.saveReply(reply)
            })
          }
        })),
        Layer.provide(MessageStorage.layerMemory),
        Layer.provide(TestShardingConfig)
      )))
    }))
})

describe("Sharding shard lock failover", () => {
  it.effect("interrupts entities and reacquires shards after lock storage recovers", () =>
    Effect.gen(function*() {
      const storageState = makeFailoverStorageState()
      const runnerStorage = Layer.effect(
        RunnerStorage.RunnerStorage,
        Effect.map(Clock.Clock, (clock) => makeFailoverStorage(storageState, clock))
      )
      const config = ShardingConfig.layer({
        runnerAddress: Option.some(RunnerAddress.make("localhost", 1234)),
        shardsPerGroup: 1,
        shardLockExpiration: 300,
        shardLockRefreshInterval: 1000,
        entityTerminationTimeout: 30_000,
        entityMessagePollInterval: 10,
        refreshAssignmentsInterval: 10,
        sendRetryInterval: 10
      })
      const layer = TestEntityNoState.pipe(
        Layer.provideMerge(Sharding.layer),
        Layer.provide(runnerStorage),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provideMerge(TestEntityState.layer),
        Layer.provide(Runners.layerNoop),
        Layer.provide([MessageStorage.layerMemory, Snowflake.layerGenerator]),
        Layer.provide(config)
      )

      yield* Effect.gen(function*() {
        const sharding = yield* Sharding.Sharding
        const entityState = yield* TestEntityState
        const makeClient = yield* TestEntity.client
        const client = makeClient("1")
        const shardId = sharding.getShardId(EntityId.make("1"), "default")

        while (!sharding.hasShardId(shardId)) {
          yield* TestClock.adjust(10)
        }
        while (!storageState.refreshCalls.some((call) => call.shards.length > 0)) {
          yield* TestClock.adjust(100)
        }

        const entityFiber = yield* client.NeverVolatile().pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust(1)
        assert.strictEqual(Queue.sizeUnsafe(entityState.envelopes), 1)

        const acquireCount = storageState.acquireCalls.length
        const partitionedAt = yield* Clock.currentTimeMillis
        storageState.blackholed = true

        yield* TestClock.adjust(201)

        assert.isFalse(sharding.hasShardId(shardId))
        assert.isFalse(yield* sharding.isShutdown)
        const entityExit = entityFiber.pollUnsafe()
        assert(entityExit && Exit.hasInterrupts(entityExit))
        assert.strictEqual(ClusterMetrics.shards.valueUnsafe(Context.empty()).value, BigInt(0))

        const failedRefreshes = storageState.refreshCalls.filter((call) =>
          call.at >= partitionedAt && call.shards.length > 0
        )
        assert.isAtMost(failedRefreshes.length, 2)

        yield* TestClock.adjust(1000)
        assert.strictEqual(storageState.acquireCalls.length, acquireCount)
        assert(storageState.refreshCalls.some((call) => call.at >= partitionedAt && call.shards.length === 0))
        assert(
          storageState.refreshCalls
            .filter((call) => call.at >= partitionedAt + 200)
            .every((call) => call.shards.length === 0)
        )

        storageState.blackholed = false
        yield* TestClock.adjust(101)
        while (!sharding.hasShardId(shardId)) {
          yield* TestClock.adjust(10)
        }

        assert.isAbove(storageState.acquireCalls.length, acquireCount)
        assert(storageState.acquireCalls.at(-1)!.shards.some((shard) => shard.id === shardId.id))
        assert.deepStrictEqual(yield* client.GetUserVolatile({ id: 2 }), new User({ id: 2, name: "User 2" }))
        assert.strictEqual(Queue.sizeUnsafe(entityState.envelopes), 2)
      }).pipe(Effect.provide(layer), Effect.scoped)
    }))

  it.effect("keeps the graceful timeout for normal shard reassignment", () =>
    Effect.gen(function*() {
      const storageState = makeFailoverStorageState()
      const runnerStorage = Layer.effect(
        RunnerStorage.RunnerStorage,
        Effect.map(Clock.Clock, (clock) => makeFailoverStorage(storageState, clock))
      )
      const config = ShardingConfig.layer({
        runnerAddress: Option.some(RunnerAddress.make("localhost", 1234)),
        shardsPerGroup: 1,
        shardLockExpiration: 3000,
        shardLockRefreshInterval: 100,
        entityTerminationTimeout: 1000,
        entityMessagePollInterval: 10,
        refreshAssignmentsInterval: 10,
        sendRetryInterval: 10
      })
      const layer = TestEntityNoState.pipe(
        Layer.provideMerge(Sharding.layer),
        Layer.provide(runnerStorage),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provideMerge(TestEntityState.layer),
        Layer.provide(Runners.layerNoop),
        Layer.provide([MessageStorage.layerMemory, Snowflake.layerGenerator]),
        Layer.provide(config)
      )

      yield* Effect.gen(function*() {
        const sharding = yield* Sharding.Sharding
        const makeClient = yield* TestEntity.client
        const client = makeClient("1")
        const shardId = sharding.getShardId(EntityId.make("1"), "default")

        while (!sharding.hasShardId(shardId)) {
          yield* TestClock.adjust(10)
        }
        const entityFiber = yield* client.NeverVolatile().pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust(1)

        storageState.assignSelf = false
        while (sharding.hasShardId(shardId)) {
          yield* TestClock.adjust(10)
        }
        while ((yield* sharding.activeEntityCount) > 0) {
          yield* TestClock.adjust(1)
        }

        assert.isUndefined(entityFiber.pollUnsafe())
        assert.strictEqual(storageState.releaseCalls.length, 0)
        yield* TestClock.adjust(900)
        assert.isUndefined(entityFiber.pollUnsafe())
        assert.strictEqual(storageState.releaseCalls.length, 0)

        for (let i = 0; i < 20 && entityFiber.pollUnsafe() === undefined; i++) {
          yield* TestClock.adjust(10)
        }
        const entityExit = entityFiber.pollUnsafe()
        assert(entityExit && Exit.hasInterrupts(entityExit))
        assert.strictEqual(storageState.releaseCalls.length, 1)
      }).pipe(Effect.provide(layer), Effect.scoped)
    }))

  it.effect("does not wait for entity construction before a forced shard release", () =>
    Effect.gen(function*() {
      const storageState = makeFailoverStorageState()
      const runnerStorage = Layer.effect(
        RunnerStorage.RunnerStorage,
        Effect.map(Clock.Clock, (clock) => makeFailoverStorage(storageState, clock))
      )
      const config = ShardingConfig.layer({
        runnerAddress: Option.some(RunnerAddress.make("localhost", 1234)),
        shardsPerGroup: 1,
        shardLockExpiration: 300,
        shardLockRefreshInterval: 1000,
        entityTerminationTimeout: 0,
        entityMessagePollInterval: 10,
        refreshAssignmentsInterval: 10,
        sendRetryInterval: 10
      })
      const layer = TestEntityNoState.pipe(
        Layer.provideMerge(Sharding.layer),
        Layer.provide(runnerStorage),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provideMerge(TestEntityState.layer),
        Layer.provide(Runners.layerNoop),
        Layer.provide([MessageStorage.layerMemory, Snowflake.layerGenerator]),
        Layer.provide(config)
      )

      yield* Effect.gen(function*() {
        const sharding = yield* Sharding.Sharding
        const entityState = yield* TestEntityState
        const makeClient = yield* TestEntity.client
        const client = makeClient("1")
        const shardId = sharding.getShardId(EntityId.make("1"), "default")

        while (!sharding.hasShardId(shardId)) {
          yield* TestClock.adjust(10)
        }
        while (!storageState.refreshCalls.some((call) => call.shards.length > 0)) {
          yield* TestClock.adjust(100)
        }

        yield* Effect.gen(function*() {
          entityState.buildLatch.closeUnsafe()
          const entityFiber = yield* client.GetUserVolatile({ id: 1 }).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          while (entityState.layerBuilds.current === 0) {
            yield* TestClock.adjust(1)
          }

          storageState.blackholed = true
          yield* TestClock.adjust(201)
          assert.isFalse(sharding.hasShardId(shardId))

          storageState.blackholed = false
          yield* TestClock.adjust(1000)

          assert.strictEqual(storageState.releaseAllCalls.length, 1)
          entityState.buildLatch.openUnsafe()
          yield* TestClock.adjust(1)
          yield* Fiber.interrupt(entityFiber)
        }).pipe(Effect.ensuring(entityState.buildLatch.open))
      }).pipe(
        Effect.provide(layer),
        Effect.scoped
      )
    }))

  it.effect("does not acquire shards while a forced release is pending", () =>
    Effect.gen(function*() {
      const shardsPerGroup = 4
      const storageState = makeFailoverStorageState({
        otherRunnerHealthy: true,
        releaseAllDuration: 500
      })
      const runnerStorage = Layer.effect(
        RunnerStorage.RunnerStorage,
        Effect.map(Clock.Clock, (clock) => makeFailoverStorage(storageState, clock))
      )
      const config = ShardingConfig.layer({
        runnerAddress: Option.some(RunnerAddress.make("localhost", 1234)),
        shardsPerGroup,
        shardLockExpiration: 300,
        shardLockRefreshInterval: 1000,
        entityTerminationTimeout: 0,
        entityMessagePollInterval: 10,
        refreshAssignmentsInterval: 10,
        sendRetryInterval: 10
      })
      const layer = TestEntityNoState.pipe(
        Layer.provideMerge(Sharding.layer),
        Layer.provide(runnerStorage),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provideMerge(TestEntityState.layer),
        Layer.provide(Runners.layerNoop),
        Layer.provide([MessageStorage.layerMemory, Snowflake.layerGenerator]),
        Layer.provide(config)
      )

      yield* Effect.gen(function*() {
        const sharding = yield* Sharding.Sharding
        const allShards = Array.makeBy(shardsPerGroup, (i) => ShardId.make("default", i + 1))
        const ownedCount = () => allShards.filter((shardId) => sharding.hasShardId(shardId)).length

        // the other runner holds part of the ring, so this runner starts with a
        // strict subset of the shards
        while (ownedCount() === 0) {
          yield* TestClock.adjust(10)
        }
        assert.isBelow(ownedCount(), shardsPerGroup)
        while (!storageState.refreshCalls.some((call) => call.shards.length > 0)) {
          yield* TestClock.adjust(100)
        }

        const acquiresBeforeOutage = storageState.acquireCalls.length
        storageState.blackholed = true
        yield* TestClock.adjust(201)
        assert.strictEqual(ownedCount(), 0)

        // the other runner's shards are reassigned to this runner during the
        // outage, so they are not part of the forced release set
        storageState.otherRunnerHealthy = false
        yield* TestClock.adjust(100)
        assert.strictEqual(storageState.releaseAllCalls.length, 0)

        // recovery runs the forced release, which stays in flight for
        // `releaseAllDuration`
        storageState.blackholed = false
        while (storageState.releaseAllCalls.length === 0) {
          yield* TestClock.adjust(10)
        }
        while (!storageState.releaseAllCalls[0].completed) {
          yield* TestClock.adjust(10)
        }
        // keep shutdown from blocking on the finalizer release
        storageState.releaseAllDuration = 0

        while (ownedCount() < shardsPerGroup) {
          yield* TestClock.adjust(10)
        }

        // `releaseAll` drops every lock held by this runner, so nothing may be
        // acquired before it has completed
        assert.strictEqual(storageState.releaseAllCalls.length, 1)
        assert(
          storageState.acquireCalls
            .slice(acquiresBeforeOutage)
            .every((call) => call.completedReleaseAlls > 0)
        )
      }).pipe(Effect.provide(layer), Effect.scoped)
    }))
})

interface FailoverStorageState {
  blackholed: boolean
  assignSelf: boolean
  otherRunnerHealthy: boolean
  /** Test clock duration `releaseAll` stays in flight for. */
  releaseAllDuration: number
  runner: Runner.Runner | undefined
  readonly acquireCalls: Array<{
    readonly shards: Array<ShardId.ShardId>
    readonly completedReleaseAlls: number
  }>
  readonly refreshCalls: Array<{
    readonly at: number
    readonly shards: Array<ShardId.ShardId>
  }>
  readonly releaseCalls: Array<ShardId.ShardId>
  readonly releaseAllCalls: Array<{ completed: boolean }>
}

const makeFailoverStorageState = (
  overrides?: Partial<FailoverStorageState>
): FailoverStorageState => ({
  blackholed: false,
  assignSelf: true,
  otherRunnerHealthy: false,
  releaseAllDuration: 0,
  runner: undefined,
  acquireCalls: [],
  refreshCalls: [],
  releaseCalls: [],
  releaseAllCalls: [],
  ...overrides
})

const makeFailoverStorage = (state: FailoverStorageState, clock: Clock.Clock) =>
  RunnerStorage.RunnerStorage.of({
    getRunners: Effect.sync(() => {
      if (!state.runner) return []
      if (!state.assignSelf) return [[state.runner, false], [otherRunner, true]]
      return state.otherRunnerHealthy ? [[state.runner, true], [otherRunner, true]] : [[state.runner, true]]
    }),
    register: (runner) =>
      Effect.sync(() => {
        state.runner = runner
        return MachineId.make(1)
      }),
    unregister: () => Effect.void,
    setRunnerHealth: () => Effect.void,
    acquire: (_address, shardIds) =>
      Effect.sync(() => {
        const shards = globalThis.Array.from(shardIds)
        state.acquireCalls.push({
          shards,
          completedReleaseAlls: state.releaseAllCalls.filter((call) => call.completed).length
        })
        return shards
      }),
    refresh: (_address, shardIds) =>
      Effect.suspend(() => {
        const shards = globalThis.Array.from(shardIds)
        state.refreshCalls.push({
          at: clock.currentTimeMillisUnsafe(),
          shards
        })
        return state.blackholed ? Effect.never : Effect.succeed(shards)
      }),
    release: (_address, shardId) =>
      Effect.sync(() => {
        state.releaseCalls.push(shardId)
      }),
    releaseAll: () =>
      Effect.suspend(() => {
        const call = { completed: false }
        state.releaseAllCalls.push(call)
        return Effect.andThen(
          Effect.sleep(state.releaseAllDuration),
          Effect.sync(() => {
            call.completed = true
          })
        )
      })
  })

const otherRunner = Runner.make({
  address: RunnerAddress.make("localhost", 5678),
  groups: ["default"],
  weight: 1
})

const TestShardingConfig = ShardingConfig.layer({
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 5000,
  sendRetryInterval: 100,
  refreshAssignmentsInterval: 0
})

const TestShardingWithoutState = TestEntityNoState.pipe(
  Layer.provideMerge(Sharding.layer),
  Layer.provide(RunnerStorage.layerMemory),
  Layer.provide(RunnerHealth.layerNoop)
  // Layer.provide(Logger.minimumLogLevel(LogLevel.All)),
  // Layer.provideMerge(Logger.pretty)
)

const TestShardingWithoutRunners = TestShardingWithoutState.pipe(
  Layer.provideMerge(TestEntityState.layer)
)

const TestShardingWithoutStorage = TestShardingWithoutRunners.pipe(
  Layer.provide(Runners.layerNoop),
  Layer.provide(TestShardingConfig)
)

const TestSharding = TestShardingWithoutStorage.pipe(
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provide(TestShardingConfig)
)

const ContextBleedSharding = ContextBleedLayer.pipe(Layer.provideMerge(TestSharding))
