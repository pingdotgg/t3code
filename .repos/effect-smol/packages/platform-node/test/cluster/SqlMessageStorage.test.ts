import { NodeFileSystem } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Latch, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { Message, MessageStorage, ShardingConfig, Snowflake, SqlMessageStorage } from "effect/unstable/cluster"
import { SqlClient } from "effect/unstable/sql"
import { MysqlContainer } from "../fixtures/mysql2-utils.ts"
import { PgContainer } from "../fixtures/pg-utils.ts"
import {
  makeAckChunk,
  makeChunkReply,
  makeReply,
  makeRequest,
  PrimaryKeyTest,
  StreamRpc
} from "./MessageStorageTest.ts"

const StorageLive = SqlMessageStorage.layer.pipe(
  Layer.provideMerge(Snowflake.layerGenerator),
  Layer.provide(ShardingConfig.layerDefaults)
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
    it.layer(StorageLive.pipe(Layer.provideMerge(layer)), {
      timeout: 120000
    })(label, (it) => {
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
})

const SqliteLayer = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  return SqliteClient.layer({
    filename: dir + "/test.db"
  })
}).pipe(Layer.unwrap, Layer.provide(NodeFileSystem.layer))
