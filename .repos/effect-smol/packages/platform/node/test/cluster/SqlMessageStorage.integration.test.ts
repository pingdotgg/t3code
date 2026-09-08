import { NodeCrypto, NodeFileSystem } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Latch, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import {
  Entity,
  EntityAddress,
  EntityId,
  EntityType,
  Envelope,
  Message,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  ShardId,
  Sharding,
  ShardingConfig,
  Snowflake,
  SqlMessageStorage
} from "effect/unstable/cluster"
import { SqlClient } from "effect/unstable/sql"
import { MysqlContainer } from "../fixtures/mysql2-utils.ts"
import { PgContainer } from "../fixtures/pg-utils.ts"
import {
  GetUserRpc,
  LongKeyRpc,
  makeAckChunk,
  makeChunkReply,
  makeReply,
  makeRequest,
  PrimaryKeyTest,
  StreamRpc
} from "./MessageStorageTest.ts"

const TestEntity = Entity.make("test", [GetUserRpc])
const TestEntityLayer = TestEntity.toLayer({
  GetUser: () => Effect.void
})

const StorageLayer = SqlMessageStorage.layer.pipe(
  Layer.provideMerge(Snowflake.layerGenerator),
  Layer.provide([ShardingConfig.layerDefaults, NodeCrypto.layer])
)

const truncate = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM cluster_replies`
  yield* sql`DELETE FROM cluster_messages`
})

describe("SqlMessageStorage", () => {
  ;([
    ["pg", Layer.orDie(PgContainer.layerClient)],
    ["mysql", Layer.orDie(MysqlContainer.layerClient)],
    ["sqlite", Layer.orDie(SqliteLayer)]
  ] as const).forEach(([label, layer]) => {
    it.layer(StorageLayer.pipe(Layer.provideMerge(layer)), {
      timeout: 120000
    })(label, (it) => {
      if (label === "pg") {
        it.effect("creates an index for insertion-ordered message reads", () =>
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const indexes = yield* sql<{ indexname: string }>`
              SELECT indexname
              FROM pg_indexes
              WHERE tablename = 'cluster_messages'
              AND indexname = 'cluster_messages_rowid_idx'
            `
            expect(indexes).toHaveLength(1)
          }))
      }

      it.effect("saveRequest", () =>
        Effect.gen(function*() {
          const storage = yield* MessageStorage.MessageStorage
          const request = yield* makeRequest({ payload: { id: 1 } })
          const result = yield* storage.saveRequest(request)
          expect(result._tag).toEqual("Success")

          for (let i = 2; i <= 5; i++) {
            yield* storage.saveRequest(yield* makeRequest({ payload: { id: i } }))
          }

          yield* storage.saveReply(yield* makeReply(request))

          let messages = yield* storage.unprocessedMessages([request.envelope.address.shardId])
          expect(messages).toHaveLength(4)
          expect(messages.map((m: any) => m.envelope.payload.id)).toEqual([2, 3, 4, 5])

          for (let i = 6; i <= 10; i++) {
            yield* storage.saveRequest(yield* makeRequest({ payload: { id: i } }))
          }
          messages = yield* storage.unprocessedMessages([request.envelope.address.shardId])
          expect(messages).toHaveLength(5)
          expect(messages.map((m: any) => m.envelope.payload.id)).toEqual([6, 7, 8, 9, 10])
        }))

      it.effect("saveReply + saveRequest duplicate", () =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const storage = yield* MessageStorage.MessageStorage
          const request = yield* makeRequest({
            rpc: StreamRpc,
            payload: StreamRpc.payloadSchema.make({ id: 123 })
          })
          let result = yield* storage.saveRequest(request)
          expect(result._tag).toEqual("Success")

          let chunk = yield* makeChunkReply(request, 0)
          yield* storage.saveReply(chunk)
          const ackChunk = yield* makeAckChunk(request, chunk)
          yield* storage.saveEnvelope(ackChunk)

          chunk = yield* makeChunkReply(request, 1)
          yield* storage.saveReply(chunk)

          result = yield* storage.saveRequest(
            yield* makeRequest({
              rpc: StreamRpc,
              payload: StreamRpc.payloadSchema.make({ id: 123 })
            })
          )
          assert(result._tag === "Duplicate" && Option.isSome(result.lastReceivedReply))
          expect(result.lastReceivedReply.value._tag).toEqual("Chunk")

          // get the un-acked chunk
          const replies = yield* storage.repliesFor([request])
          expect(replies).toHaveLength(1)

          yield* storage.saveReply(yield* makeReply(request))

          result = yield* storage.saveRequest(
            yield* makeRequest({
              rpc: StreamRpc,
              payload: StreamRpc.payloadSchema.make({ id: 123 })
            })
          )
          assert(result._tag === "Duplicate" && Option.isSome(result.lastReceivedReply))
          expect(result.lastReceivedReply.value._tag).toEqual("WithExit")

          // duplicate WithExit
          const fiber = yield* storage.saveReply(yield* makeReply(request)).pipe(Effect.forkChild)
          yield* TestClock.adjust(1)
          while (!fiber.pollUnsafe()) {
            yield* sql`SELECT 1`
            yield* TestClock.adjust(1000)
          }
          const error = yield* Effect.flip(Fiber.join(fiber))
          expect(error._tag).toEqual("PersistenceError")
        }))

      it.effect("detects duplicates", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          yield* storage.saveRequest(
            yield* makeRequest({
              rpc: PrimaryKeyTest,
              payload: PrimaryKeyTest.payloadSchema.make({ id: 123 })
            })
          )
          const result = yield* storage.saveRequest(
            yield* makeRequest({
              rpc: PrimaryKeyTest,
              payload: PrimaryKeyTest.payloadSchema.make({ id: 123 })
            })
          )
          expect(result._tag).toEqual("Duplicate")
        }))

      it.effect("hashes primary keys longer than the message_id column", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          const longId = "long-key-".repeat(50)
          const request = yield* makeRequest({
            rpc: LongKeyRpc,
            payload: LongKeyRpc.payloadSchema.make({ id: longId })
          })
          const result = yield* storage.saveRequest(request)
          expect(result._tag).toEqual("Success")

          const duplicate = yield* storage.saveRequest(
            yield* makeRequest({
              rpc: LongKeyRpc,
              payload: LongKeyRpc.payloadSchema.make({ id: longId })
            })
          )
          expect(duplicate._tag).toEqual("Duplicate")

          const requestId = yield* storage.requestIdForPrimaryKey({
            address: request.envelope.address,
            tag: request.envelope.tag,
            id: longId
          })
          expect(requestId).toEqual(Option.some(request.envelope.requestId))

          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{ message_id: string }>`SELECT message_id FROM cluster_messages`
          expect(rows).toHaveLength(1)
          expect(rows[0].message_id).toMatch(/^[0-9a-f]{64}$/)
        }))

      it.effect("keeps primary keys within the column width as plaintext", () =>
        Effect.gen(function*() {
          yield* truncate

          const sql = yield* SqlClient.SqlClient
          const storage = yield* MessageStorage.MessageStorage
          const request = yield* makeRequest({
            rpc: PrimaryKeyTest,
            payload: PrimaryKeyTest.payloadSchema.make({ id: 456 })
          })
          yield* storage.saveRequest(request)

          // rows written by previous versions store the plaintext composed
          // key, so short keys must stay byte-identical to keep deduplicating
          const plaintext = Envelope.primaryKey(request.envelope)!
          const rows = yield* sql<{ message_id: string }>`SELECT message_id FROM cluster_messages`
          expect(rows).toHaveLength(1)
          expect(rows[0].message_id).toEqual(plaintext)

          const result = yield* storage.saveRequest(
            yield* makeRequest({
              rpc: PrimaryKeyTest,
              payload: PrimaryKeyTest.payloadSchema.make({ id: 456 })
            })
          )
          assert(result._tag === "Duplicate")
          expect(result.originalId).toEqual(request.envelope.requestId)

          const requestId = yield* storage.requestIdForPrimaryKey({
            address: request.envelope.address,
            tag: request.envelope.tag,
            id: "456"
          })
          expect(requestId).toEqual(Option.some(request.envelope.requestId))
        }))

      if (label === "sqlite") {
        // sqlite's TEXT message_id column stored over-long plaintext keys
        // before hashing, so the legacy fallback must also cover keys longer
        // than the 255-character limit of the width-enforcing dialects
        it.effect("detects duplicates for legacy long-key plaintext rows", () =>
          Effect.gen(function*() {
            yield* truncate

            const sql = yield* SqlClient.SqlClient
            const storage = yield* MessageStorage.MessageStorage
            const longId = "legacy-long-key-".repeat(30)
            const request = yield* makeRequest({
              rpc: LongKeyRpc,
              payload: LongKeyRpc.payloadSchema.make({ id: longId })
            })
            yield* storage.saveRequest(request)

            // simulate a row written before message_id values were hashed
            const plaintext = Envelope.primaryKey(request.envelope)!
            expect(plaintext.length).toBeGreaterThan(255)
            yield* sql`UPDATE cluster_messages SET message_id = ${plaintext} WHERE id = ${
              String(request.envelope.requestId)
            }`

            const result = yield* storage.saveRequest(
              yield* makeRequest({
                rpc: LongKeyRpc,
                payload: LongKeyRpc.payloadSchema.make({ id: longId })
              })
            )
            assert(result._tag === "Duplicate")
            expect(result.originalId).toEqual(request.envelope.requestId)

            const requestId = yield* storage.requestIdForPrimaryKey({
              address: request.envelope.address,
              tag: request.envelope.tag,
              id: longId
            })
            expect(requestId).toEqual(Option.some(request.envelope.requestId))
          }))
      }

      it.effect("unprocessedMessages", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          const request = yield* makeRequest()
          yield* storage.saveRequest(request)
          let messages = yield* storage.unprocessedMessages([request.envelope.address.shardId])
          expect(messages).toHaveLength(1)
          messages = yield* storage.unprocessedMessages([request.envelope.address.shardId])
          expect(messages).toHaveLength(0)
          yield* storage.saveRequest(yield* makeRequest())
          messages = yield* storage.unprocessedMessages([request.envelope.address.shardId])
          expect(messages).toHaveLength(1)
        }))

      it.effect("unprocessedMessages honors the limit and claims only returned rows", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          const shardId = ShardId.make("default", 1)
          for (let i = 1; i <= 5; i++) {
            yield* storage.saveRequest(yield* makeRequest({ payload: { id: i }, entityId: String(i) }))
          }
          const limited = yield* storage.unprocessedMessages([shardId], { limit: 3 })
          expect(limited).toHaveLength(3)
          expect(limited.map((m: any) => m.envelope.payload.id)).toEqual([1, 2, 3])

          // rows beyond the limit were not claimed and are returned by the
          // next read
          const rest = yield* storage.unprocessedMessages([shardId])
          expect(rest.map((m: any) => m.envelope.payload.id)).toEqual([4, 5])
        }))

      it.effect("unprocessedMessages filters by address", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          const shardId = ShardId.make("default", 1)
          const address = (entityId: string) =>
            EntityAddress.make({
              shardId,
              entityType: EntityType.make("test"),
              entityId: EntityId.make(entityId)
            })
          for (let i = 1; i <= 4; i++) {
            yield* storage.saveRequest(yield* makeRequest({ payload: { id: i }, entityId: String(i) }))
          }
          const filtered = yield* storage.unprocessedMessages([shardId], {
            addresses: [address("2"), address("4")]
          })
          expect(filtered.map((m: any) => m.envelope.payload.id)).toEqual([2, 4])

          // the filtered read must not claim the other addresses
          const rest = yield* storage.unprocessedMessages([shardId])
          expect(rest.map((m: any) => m.envelope.payload.id)).toEqual([1, 3])
        }))

      it.effect("unprocessedMessages filters addresses by shard", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          const shardOne = ShardId.make("default", 1)
          const shardTwo = ShardId.make("default", 2)
          yield* storage.saveRequest(yield* makeRequest({ payload: { id: 1 }, shardId: shardOne }))
          yield* storage.saveRequest(yield* makeRequest({ payload: { id: 2 }, shardId: shardTwo }))

          const messages = yield* storage.unprocessedMessages([shardOne, shardTwo], {
            addresses: [EntityAddress.make({
              shardId: shardOne,
              entityType: EntityType.make("test"),
              entityId: EntityId.make("1")
            })]
          })
          expect(messages.map((message: any) => message.envelope.payload.id)).toEqual([1])

          const rest = yield* storage.unprocessedMessages([shardOne, shardTwo])
          expect(rest.map((message: any) => message.envelope.payload.id)).toEqual([2])
        }))

      it.effect("encoded unprocessedMessages fails closed for empty addresses", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          const request = yield* makeRequest()
          yield* storage.saveRequest(request)
          const encoded = yield* SqlMessageStorage.makeEncoded().pipe(Effect.provide(NodeCrypto.layer))
          const shardId = request.envelope.address.shardId.toString()
          const messages = yield* encoded.unprocessedMessages([shardId], Date.now(), { addresses: [] })
          expect(messages).toHaveLength(0)

          const unfiltered = yield* encoded.unprocessedMessages([shardId], Date.now())
          expect(unfiltered).toHaveLength(1)
        }))

      it.effect("encoded resetAddresses fails closed for an empty address list", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          const request = yield* makeRequest()
          yield* storage.saveRequest(request)
          const encoded = yield* SqlMessageStorage.makeEncoded().pipe(Effect.provide(NodeCrypto.layer))
          const shardId = request.envelope.address.shardId.toString()
          const claimed = yield* encoded.unprocessedMessages([shardId], Date.now())
          expect(claimed).toHaveLength(1)

          yield* encoded.resetAddresses([])
          const messages = yield* encoded.unprocessedMessages([shardId], Date.now())
          expect(messages).toHaveLength(0)
        }))

      it.effect("resetAddresses releases claims in one batch", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          const shardId = ShardId.make("default", 1)
          const address = (entityId: string) =>
            EntityAddress.make({
              shardId,
              entityType: EntityType.make("test"),
              entityId: EntityId.make(entityId)
            })
          for (let i = 1; i <= 4; i++) {
            yield* storage.saveRequest(yield* makeRequest({ payload: { id: i }, entityId: String(i) }))
          }
          yield* storage.unprocessedMessages([shardId], { limit: 3 })
          yield* storage.resetAddresses([address("1"), address("3")])

          const messages = yield* storage.unprocessedMessages([shardId])
          expect(messages.map((m: any) => m.envelope.payload.id)).toEqual([1, 3, 4])
        }))

      it.effect("unprocessedMessages excludes complete requests", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          const request = yield* makeRequest()
          yield* storage.saveRequest(request)
          yield* storage.saveReply(yield* makeReply(request))
          const messages = yield* storage.unprocessedMessages([request.envelope.address.shardId])
          expect(messages).toHaveLength(0)
        }))

      it.effect("repliesFor", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          const request = yield* makeRequest()
          yield* storage.saveRequest(request)
          let replies = yield* storage.repliesFor([request])
          expect(replies).toHaveLength(0)
          yield* storage.saveReply(yield* makeReply(request))
          replies = yield* storage.repliesFor([request])
          expect(replies).toHaveLength(1)
          expect(replies[0].requestId).toEqual(request.envelope.requestId)
        }))

      it.effect("registerReplyHandler", () =>
        Effect.gen(function*() {
          const storage = yield* MessageStorage.MessageStorage
          const latch = yield* Latch.make()
          const request = yield* makeRequest()
          yield* storage.saveRequest(request)
          const fiber = yield* storage.registerReplyHandler(
            new Message.OutgoingRequest({
              ...request,
              respond: () => latch.open
            })
          ).pipe(Effect.forkChild)
          yield* TestClock.adjust(1)
          yield* storage.saveReply(yield* makeReply(request))
          yield* latch.await
          yield* Fiber.await(fiber)
        }))

      it.effect("unprocessedMessagesById", () =>
        Effect.gen(function*() {
          yield* truncate

          const storage = yield* MessageStorage.MessageStorage
          const request = yield* makeRequest()
          yield* storage.saveRequest(request)
          let messages = yield* storage.unprocessedMessagesById([request.envelope.requestId])
          expect(messages).toHaveLength(1)
          yield* storage.saveReply(yield* makeReply(request))
          messages = yield* storage.unprocessedMessagesById([request.envelope.requestId])
          expect(messages).toHaveLength(0)
        }))
    })
  })

  it.effect("keeps held messages readable while entity layers build", () =>
    Effect.gen(function*() {
      const config = ShardingConfig.layer({
        entityRegistrationTimeout: 6000,
        entityTerminationTimeout: 0,
        entityMessagePollInterval: 100,
        refreshAssignmentsInterval: 0
      })
      const delayedEnv = TestEntityLayer.pipe(
        Layer.provide(Layer.effectDiscard(Effect.sleep(10_000))),
        Layer.provideMerge(Sharding.layer),
        Layer.provide(RunnerStorage.layerMemory),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provide(Runners.layerNoop),
        Layer.provide(config)
      )
      const storage = yield* MessageStorage.MessageStorage
      const request = yield* makeRequest()
      yield* storage.saveRequest(request)

      const fiber = yield* Effect.never.pipe(
        Effect.provide(delayedEnv),
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )

      yield* TestClock.adjust(7500)
      expect(yield* storage.repliesFor([request])).toHaveLength(0)

      yield* TestClock.adjust(2500)
      yield* TestClock.adjust(100)
      expect(yield* storage.repliesFor([request])).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(StorageLayer.pipe(
      Layer.provideMerge(SqliteLayer)
    ))), { timeout: 15_000 })
})

const SqliteLayer = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  return SqliteClient.layer({
    filename: dir + "/test.db"
  })
}).pipe(Layer.unwrap, Layer.provide(NodeFileSystem.layer))
