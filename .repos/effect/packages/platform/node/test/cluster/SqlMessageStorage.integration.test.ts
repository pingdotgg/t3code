import { NodeCrypto, NodeFileSystem } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, FileSystem, Latch, Layer, Option } from "effect"
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
} from "effect/cluster"
import { Reactivity } from "effect/reactivity"
import { SqlClient, Statement } from "effect/sql"
import { TestClock } from "effect/testing"
import { MssqlContainer } from "../fixtures/mssql-utils.ts"
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
  Layer.provide([ShardingConfig.layerDefaults, NodeCrypto.layerDigest])
)

const truncate = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM cluster_replies`
  yield* sql`DELETE FROM cluster_messages`
})

// Waits until another connection is paused in a test trigger's pg_sleep.
const waitForPgSleep = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  while (true) {
    const waiting = yield* sql`
      SELECT 1 FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep'
    `
    if (waiting.length > 0) return
    yield* Effect.sleep("10 millis")
  }
}).pipe(Effect.timeout("5 seconds"))

// Waits until another connection is paused in a test trigger's SLEEP.
const waitForMysqlSleep = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  while (true) {
    const waiting = yield* sql`
      SELECT 1 FROM information_schema.PROCESSLIST
      WHERE ID <> CONNECTION_ID() AND STATE = 'User sleep'
    `
    if (waiting.length > 0) return
    yield* Effect.sleep("10 millis")
  }
}).pipe(Effect.timeout("5 seconds"))

describe("SqlMessageStorage", () => {
  it.effect("preserves ids above 2^53 with a number-returning SQLite driver", () => {
    let id = 9007199254740993n
    return Effect.gen(function*() {
      const storage = yield* MessageStorage.MessageStorage
      const request = yield* makeRequest({
        rpc: PrimaryKeyTest,
        payload: PrimaryKeyTest.payloadSchema.make({ id: 123 })
      })
      const requestId = request.envelope.requestId
      yield* storage.saveRequest(request)
      const shards = [request.envelope.address.shardId]
      const messages = yield* storage.unprocessedMessages(shards)
      assert.strictEqual(messages.length, 1)
      assert.strictEqual(messages[0].envelope.requestId, requestId)
      assert.deepStrictEqual(yield* storage.unprocessedMessages(shards), [])

      const reply = yield* makeReply(request)
      yield* storage.saveReply(reply)
      assert.deepStrictEqual(yield* storage.repliesFor([request]), [reply.reply])
      yield* storage.resetShards(shards)
      assert.deepStrictEqual(yield* storage.unprocessedMessages(shards), [])

      const duplicate = yield* storage.saveRequest(
        yield* makeRequest({ rpc: PrimaryKeyTest, payload: request.envelope.payload })
      )
      assert(duplicate._tag === "Duplicate")
      assert.strictEqual(duplicate.originalId, requestId)
      assert.deepStrictEqual(duplicate.lastReceivedReply, Option.some(reply.reply))
      assert.deepStrictEqual(
        yield* storage.requestIdForPrimaryKey({
          address: request.envelope.address,
          tag: request.envelope.tag,
          id: "123"
        }),
        Option.some(requestId)
      )
    }).pipe(
      Effect.provide(SqlMessageStorage.layer.pipe(
        Layer.provide(NumberSqliteLayer),
        Layer.provide([ShardingConfig.layerDefaults, NodeCrypto.layer])
      )),
      Effect.provideService(Snowflake.Generator, {
        nextUnsafe: () => {
          const next = Snowflake.Snowflake(id)
          id += 2n
          return next
        },
        setMachineId: () => Effect.void
      })
    )
  })
  const backends: ReadonlyArray<readonly ["pg" | "mysql" | "mssql" | "sqlite", Layer.Layer<SqlClient.SqlClient>]> = [
    ["pg", Layer.orDie(PgContainer.layerClient)],
    ["mysql", Layer.orDie(MysqlContainer.layerClient)],
    ["mssql", Layer.orDie(MssqlContainer.layerClient)],
    ["sqlite", Layer.orDie(SqliteLayer)]
  ]
  backends.forEach(([label, layer]) => {
    // Tests truncate this backend's shared tables.
    it.layer(StorageLayer.pipe(Layer.provideMerge(layer)), {
      concurrent: false,
      timeout: 120000
    })(label, (it) => {
      if (label === "pg") {
        for (const reset of ["resetShards", "resetAddresses"] as const) {
          it.effect(`${reset} does not deadlock with a concurrent message claim`, () =>
            Effect.gen(function*() {
              yield* truncate
              const sql = yield* SqlClient.SqlClient
              const storage = yield* SqlMessageStorage.makeEncoded().pipe(Effect.provide(NodeCrypto.layerDigest))
              // Heap order is the reverse of the claim query's rowid order.
              yield* sql`
                INSERT INTO cluster_messages
                  (id, rowid, shard_id, entity_type, entity_id, kind, tag, payload, headers, processed, request_id)
                VALUES
                  (2, 2, 'default:1', 'test', '1', 0, 'GetUser', '{}', '{}', FALSE, 2),
                  (1, 1, 'default:1', 'test', '1', 0, 'GetUser', '{}', '{}', FALSE, 1)
              `
              // Pause after the reset locks row 2, so the claim can lock row 1.
              yield* sql`
                CREATE FUNCTION cluster_test_slow_reset() RETURNS trigger AS $$
                BEGIN
                  IF NEW.last_read IS NULL AND NEW.rowid = 2 THEN
                    PERFORM pg_sleep(2);
                  END IF;
                  RETURN NEW;
                END $$ LANGUAGE plpgsql
              `
              yield* sql`
                CREATE TRIGGER cluster_test_slow_reset BEFORE UPDATE ON cluster_messages
                FOR EACH ROW EXECUTE FUNCTION cluster_test_slow_reset()
              `
              yield* Effect.gen(function*() {
                const resetFiber = yield* Effect.gen(function*() {
                  // Make the unordered UPDATE use heap order regardless of indexes.
                  yield* sql`SET LOCAL enable_indexscan = off`
                  yield* sql`SET LOCAL enable_bitmapscan = off`
                  yield* reset === "resetShards"
                    ? storage.resetShards(["default:1"])
                    : storage.resetAddresses([EntityAddress.make({
                      shardId: ShardId.make("default", 1),
                      entityType: EntityType.make("test"),
                      entityId: EntityId.make("1")
                    })])
                }).pipe(sql.withTransaction, Effect.exit, Effect.forkChild)
                yield* Effect.gen(function*() {
                  while (true) {
                    const waiting = yield* sql`
                      SELECT 1 FROM pg_stat_activity
                      WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep'
                      AND query LIKE '%cluster_messages%'
                    `
                    if (waiting.length > 0) return
                    yield* Effect.sleep("10 millis")
                  }
                }).pipe(Effect.timeout("5 seconds"))
                const claim = yield* Effect.exit(storage.unprocessedMessages(["default:1"], Date.now()))
                const resetResult = yield* Fiber.join(resetFiber)
                expect(Exit.isSuccess(resetResult)).toBe(true)
                assert(Exit.isSuccess(claim), String(claim))
                expect(claim.value.map((message) => message.envelope.requestId)).toEqual(["1", "2"])
                expect(yield* storage.unprocessedMessages(["default:1"], Date.now())).toHaveLength(0)
              }).pipe(Effect.ensuring(
                Effect.gen(function*() {
                  yield* sql`DROP TRIGGER cluster_test_slow_reset ON cluster_messages`
                  yield* sql`DROP FUNCTION cluster_test_slow_reset()`
                  yield* truncate
                }).pipe(Effect.orDie)
              ))
            }).pipe(TestClock.withLive))
        }

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

        it.effect("saveRequest keeps a duplicate whose original is deleted mid-save", () =>
          Effect.gen(function*() {
            yield* truncate
            const sql = yield* SqlClient.SqlClient
            const storage = yield* MessageStorage.MessageStorage
            const cutoff = Date.UTC(2026, 0, 1)
            const request = makeRequest({ rpc: PrimaryKeyTest, payload: PrimaryKeyTest.payloadSchema.make({ id: 1 }) })
            const expired = yield* request
            yield* storage.saveRequest(expired)
            yield* storage.saveReply(yield* makeReply(expired, cutoff - 1))
            // Pause after the duplicate's insert hits the conflict, before it reads the existing row.
            yield* sql`
              CREATE FUNCTION cluster_test_slow_insert() RETURNS trigger AS $$
              BEGIN
                PERFORM pg_sleep(2);
                RETURN NULL;
              END $$ LANGUAGE plpgsql
            `
            yield* sql`
              CREATE TRIGGER cluster_test_slow_insert AFTER INSERT ON cluster_messages
              FOR EACH STATEMENT EXECUTE FUNCTION cluster_test_slow_insert()
            `
            yield* Effect.gen(function*() {
              const resend = yield* request
              const save = yield* storage.saveRequest(resend).pipe(Effect.forkChild)
              yield* waitForPgSleep
              expect(
                yield* storage.deleteProcessed({
                  entityType: "test",
                  completedBefore: cutoff,
                  limit: 100
                })
              )
                .toEqual(1)
              const result = yield* Fiber.join(save)
              if (result._tag === "Duplicate") {
                assert(Option.isSome(result.lastReceivedReply))
              } else {
                // a reported Success must have stored the request
                const messages = yield* storage.unprocessedMessages([resend.envelope.address.shardId])
                expect(messages.map((message) => message.envelope.requestId)).toEqual([resend.envelope.requestId])
              }
            }).pipe(Effect.ensuring(
              Effect.gen(function*() {
                yield* sql`DROP TRIGGER cluster_test_slow_insert ON cluster_messages`
                yield* sql`DROP FUNCTION cluster_test_slow_insert()`
                yield* truncate
              }).pipe(Effect.orDie)
            ))
          }).pipe(TestClock.withLive), { timeout: 30_000 })

        it.effect(
          "guarded clearReplies preserves a concurrently saved reply in either lock order",
          () =>
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              const storage = yield* MessageStorage.MessageStorage
              for (const saveFirst of [false, true]) {
                yield* truncate
                const request = yield* makeRequest()
                const oldReply = yield* makeReply(request)
                const newReply = yield* makeReply(request)
                yield* storage.saveRequest(request)
                yield* storage.saveReply(oldReply)
                const reset = storage.clearReplies(request.envelope.requestId, { expectedReplyId: oldReply.reply.id })
                const save = storage.saveReply(newReply)
                // A competing runner resets the old completion before saving its new reply.
                const [first, second] = saveFirst ? [Effect.andThen(reset, save), reset] : [reset, save]
                // Hold the first operation's lock while the second connection starts.
                const fiber = yield* Effect.andThen(first, sql`SELECT pg_sleep(2)`).pipe(
                  sql.withTransaction,
                  Effect.forkChild
                )
                yield* waitForPgSleep
                yield* second
                yield* Fiber.join(fiber)
                const replies = yield* storage.repliesFor([request])
                assert.strictEqual(replies.at(-1)?.id, newReply.reply.id)
                assert.deepStrictEqual(yield* storage.unprocessedMessages([request.envelope.address.shardId]), [])
              }
            }).pipe(TestClock.withLive),
          { timeout: 30_000 }
        )

        it.effect("clearReplies does not deadlock with a concurrent deleteProcessed", () =>
          Effect.gen(function*() {
            yield* truncate
            const sql = yield* SqlClient.SqlClient
            const storage = yield* MessageStorage.MessageStorage
            const cutoff = Date.UTC(2026, 0, 1)
            const request = yield* makeRequest()
            yield* storage.saveRequest(request)
            yield* storage.saveReply(yield* makeReply(request, cutoff - 1))
            // Pause clearReplies after it deletes the final reply, only in the transaction that opts in.
            yield* sql`
              CREATE FUNCTION cluster_test_slow_clear() RETURNS trigger AS $$
              BEGIN
                IF current_setting('cluster_test.slow_clear', true) = 'on' THEN
                  PERFORM pg_sleep(2);
                END IF;
                RETURN OLD;
              END $$ LANGUAGE plpgsql
            `
            yield* sql`
              CREATE TRIGGER cluster_test_slow_clear AFTER DELETE ON cluster_replies
              FOR EACH ROW EXECUTE FUNCTION cluster_test_slow_clear()
            `
            yield* Effect.gen(function*() {
              const clearFiber = yield* Effect.gen(function*() {
                yield* sql`SET LOCAL cluster_test.slow_clear = 'on'`
                yield* storage.clearReplies(request.envelope.requestId)
              }).pipe(sql.withTransaction, Effect.exit, Effect.forkChild)
              yield* waitForPgSleep
              const cleanup = yield* Effect.exit(
                storage.deleteProcessed({
                  entityType: "test",
                  completedBefore: cutoff,
                  limit: 100
                })
              )
              const cleared = yield* Fiber.join(clearFiber)
              assert(Exit.isSuccess(cleared), String(cleared))
              assert(Exit.isSuccess(cleanup), String(cleanup))
              // the reset started first, so the request is kept and delivered again
              expect(cleanup.value).toEqual(0)
              const messages = yield* storage.unprocessedMessages([request.envelope.address.shardId])
              expect(messages.map((message) => message.envelope.requestId)).toEqual([request.envelope.requestId])
            }).pipe(Effect.ensuring(
              Effect.gen(function*() {
                yield* sql`DROP TRIGGER cluster_test_slow_clear ON cluster_replies`
                yield* sql`DROP FUNCTION cluster_test_slow_clear()`
                yield* truncate
              }).pipe(Effect.orDie)
            ))
          }).pipe(TestClock.withLive))
      }

      if (label === "mysql") {
        it.effect("a late AckChunk does not deadlock with a concurrent deleteProcessed", () =>
          Effect.gen(function*() {
            yield* truncate
            const sql = yield* SqlClient.SqlClient
            const storage = yield* MessageStorage.MessageStorage
            const cutoff = Date.UTC(2026, 0, 1)
            const request = yield* makeRequest({ rpc: StreamRpc, payload: StreamRpc.payloadSchema.make({ id: 1 }) })
            const chunk = yield* makeChunkReply(request)
            yield* storage.saveRequest(request)
            yield* storage.saveReply(chunk)
            yield* storage.saveReply(yield* makeReply(request, cutoff - 1))
            // Pause the acknowledgement after it updates the chunk reply, only on the connection that opts in.
            yield* sql`
              CREATE TRIGGER cluster_test_slow_ack AFTER UPDATE ON cluster_replies
              FOR EACH ROW BEGIN
                IF @cluster_test_slow_ack = 1 THEN
                  DO SLEEP(2);
                END IF;
              END
            `.unprepared
            yield* Effect.gen(function*() {
              const ackFiber = yield* Effect.gen(function*() {
                yield* sql`SET @cluster_test_slow_ack = 1`
                yield* storage.saveEnvelope(yield* makeAckChunk(request, chunk)).pipe(
                  Effect.ensuring(Effect.orDie(sql`SET @cluster_test_slow_ack = NULL`))
                )
              }).pipe(sql.withTransaction, Effect.exit, Effect.forkChild)
              yield* waitForMysqlSleep
              const cleanup = yield* Effect.exit(
                storage.deleteProcessed({
                  entityType: "test",
                  completedBefore: cutoff,
                  limit: 100
                })
              )
              const acked = yield* Fiber.join(ackFiber)
              assert(Exit.isSuccess(acked), String(acked))
              assert(Exit.isSuccess(cleanup), String(cleanup))
              // cleanup either deletes the whole family, including the new AckChunk, or leaves it for a later tick
              const remaining = yield* sql<{ kind: number }>`
                SELECT kind FROM cluster_messages WHERE request_id = ${String(request.envelope.requestId)}
              `
              expect(remaining.map((row) => Number(row.kind)).sort()).toEqual(cleanup.value === 1 ? [] : [0, 1])
            }).pipe(Effect.ensuring(
              Effect.gen(function*() {
                yield* sql`DROP TRIGGER cluster_test_slow_ack`.unprepared
                yield* truncate
              }).pipe(Effect.orDie)
            ))
          }).pipe(TestClock.withLive), { timeout: 30_000 })

        it.effect(
          "a stream reply does not deadlock with deleteProcessed of another request",
          () =>
            Effect.gen(function*() {
              yield* truncate
              const sql = yield* SqlClient.SqlClient
              const storage = yield* MessageStorage.MessageStorage
              const cutoff = Date.UTC(2026, 0, 1)
              for (let id = 1; id <= 20; id++) {
                const expired = yield* makeRequest({ payload: { id } })
                yield* storage.saveRequest(expired)
                yield* storage.saveReply(yield* makeReply(expired, cutoff - id))
              }
              // an incomplete stream, which deleteProcessed must not select
              const streaming = yield* makeRequest({
                rpc: StreamRpc,
                payload: StreamRpc.payloadSchema.make({ id: 21 }),
                entityId: "2"
              })
              yield* storage.saveRequest(streaming)
              yield* storage.saveReply(yield* makeChunkReply(streaming, 0))
              // Pause saveReply after it updates the request row, before it inserts the reply, only on the
              // connection that opts in.
              yield* sql`
            CREATE TRIGGER cluster_test_slow_reply AFTER UPDATE ON cluster_messages
            FOR EACH ROW BEGIN
              IF @cluster_test_slow_reply = 1 THEN
                DO SLEEP(2);
              END IF;
            END
          `.unprepared
              yield* Effect.gen(function*() {
                const replyFiber = yield* Effect.gen(function*() {
                  yield* sql`SET @cluster_test_slow_reply = 1`
                  yield* storage.saveReply(yield* makeChunkReply(streaming, 1)).pipe(
                    Effect.ensuring(Effect.orDie(sql`SET @cluster_test_slow_reply = NULL`))
                  )
                }).pipe(sql.withTransaction, Effect.exit, Effect.forkChild)
                yield* waitForMysqlSleep
                const cleanup = yield* Effect.exit(
                  storage.deleteProcessed({
                    entityType: "test",
                    completedBefore: cutoff,
                    limit: 100
                  })
                )
                const replied = yield* Fiber.join(replyFiber)
                assert(Exit.isSuccess(replied), String(replied))
                assert(Exit.isSuccess(cleanup), String(cleanup))
                expect(cleanup.value).toEqual(20)
              }).pipe(Effect.ensuring(
                Effect.gen(function*() {
                  yield* sql`DROP TRIGGER cluster_test_slow_reply`.unprepared
                  yield* truncate
                }).pipe(Effect.orDie)
              ))
            }).pipe(TestClock.withLive),
          { timeout: 30_000 }
        )

        it.effect("fails the migrations when the retention index cannot be created", () =>
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            // A messages table that predates the migrations and lacks the
            // last_reply_id column. 0001 keeps it, so 0005's CREATE INDEX
            // fails on a missing column, not a duplicate index name.
            yield* sql`
              CREATE TABLE brokenidx_messages (
                id BIGINT NOT NULL,
                entity_type VARCHAR(150) NOT NULL,
                processed BOOLEAN NOT NULL DEFAULT FALSE
              )
            `
            const exit = yield* Effect.exit(
              SqlMessageStorage.makeEncoded({ prefix: "brokenidx" }).pipe(Effect.provide(NodeCrypto.layer))
            )
            expect(Exit.isFailure(exit)).toBe(true)
          }))
      }

      if (label === "mssql") {
        it.effect("a stream acknowledgement does not deadlock with deleteProcessed of another request", () =>
          Effect.gen(function*() {
            yield* truncate
            const sql = yield* SqlClient.SqlClient
            const storage = yield* MessageStorage.MessageStorage
            const cutoff = Date.UTC(2026, 0, 1)
            const expired = yield* makeRequest({ payload: { id: 1 } })
            yield* storage.saveRequest(expired)
            yield* storage.saveReply(yield* makeReply(expired, cutoff - 1))
            // an incomplete stream, which deleteProcessed must not select
            const streaming = yield* makeRequest({
              rpc: StreamRpc,
              payload: StreamRpc.payloadSchema.make({ id: 2 }),
              entityId: "2"
            })
            const chunk = yield* makeChunkReply(streaming)
            yield* storage.saveRequest(streaming)
            yield* storage.saveReply(chunk)
            // Pause the acknowledgement after it updates the chunk reply, only on the session that opts in.
            yield* sql`
              CREATE TRIGGER cluster_test_slow_ack ON cluster_replies AFTER UPDATE AS
              IF SESSION_CONTEXT(N'cluster_test_slow_ack') = 1 WAITFOR DELAY '00:00:02'
            `.unprepared
            yield* Effect.gen(function*() {
              const ackFiber = yield* Effect.gen(function*() {
                yield* sql`EXEC sp_set_session_context @key = N'cluster_test_slow_ack', @value = 1`
                yield* storage.saveEnvelope(yield* makeAckChunk(streaming, chunk)).pipe(
                  Effect.ensuring(
                    Effect.orDie(sql`EXEC sp_set_session_context @key = N'cluster_test_slow_ack', @value = NULL`)
                  )
                )
              }).pipe(sql.withTransaction, Effect.exit, Effect.forkChild)
              yield* Effect.gen(function*() {
                while (true) {
                  const waiting = yield* sql`
                    SELECT 1 FROM sys.dm_exec_requests
                    WHERE session_id <> @@SPID AND wait_type = 'WAITFOR'
                  `
                  if (waiting.length > 0) return
                  yield* Effect.sleep("10 millis")
                }
              }).pipe(Effect.timeout("5 seconds"))
              const cleanup = yield* Effect.exit(
                storage.deleteProcessed({
                  entityType: "test",
                  completedBefore: cutoff,
                  limit: 100
                })
              )
              const acked = yield* Fiber.join(ackFiber)
              assert(Exit.isSuccess(acked), String(acked))
              assert(Exit.isSuccess(cleanup), String(cleanup))
              expect(cleanup.value).toEqual(1)
            }).pipe(Effect.ensuring(
              Effect.gen(function*() {
                yield* sql`DROP TRIGGER cluster_test_slow_ack`.unprepared
                yield* truncate
              }).pipe(Effect.orDie)
            ))
          }).pipe(TestClock.withLive))

        it.effect("rejects duplicate exit replies when another table has the same index name", () =>
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`CREATE TABLE collision_other (id INT)`
            yield* sql`CREATE INDEX collision_replies_one_exit ON collision_other (id)`
            const storage = yield* SqlMessageStorage.makeEncoded({ prefix: "collision" }).pipe(
              Effect.provide(NodeCrypto.layer)
            )
            const exit = { _tag: "WithExit", requestId: "1", exit: { _tag: "Success", value: null } } as const
            yield* storage.saveReply({ ...exit, id: "1" })
            const error = yield* Effect.flip(storage.saveReply({ ...exit, id: "2" }))
            expect(error._tag).toEqual("PersistenceError")
          }))

        it.effect("acknowledges and cleans up when another table has the lookup index names", () =>
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`CREATE TABLE collision_idx_other (id INT)`
            yield* sql`CREATE INDEX collision_idx_messages_request_id_idx ON collision_idx_other (id)`
            yield* sql`CREATE INDEX collision_idx_replies_request_lookup_idx ON collision_idx_other (id)`
            const migrate = SqlMessageStorage.makeEncoded({ prefix: "collision_idx" }).pipe(
              Effect.provide(NodeCrypto.layer)
            )
            yield* migrate
            // Recreate a schema migrated before this change: the lookup indexes
            // are missing from the storage tables and only migrations 1-3 ran.
            for (
              const [index, table] of [
                ["collision_idx_messages_request_id_idx", "collision_idx_messages"],
                ["collision_idx_replies_request_lookup_idx", "collision_idx_replies"]
              ]
            ) {
              yield* sql`
                IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = ${index} AND object_id = OBJECT_ID(${table}))
                DROP INDEX ${sql(index)} ON ${sql(table)}
              `
            }
            yield* sql`DELETE FROM collision_idx_migrations WHERE migration_id > 3`
            const storage = yield* MessageStorage.makeEncoded(yield* migrate)

            const cutoff = Date.UTC(2026, 0, 1)
            const request = yield* makeRequest({ rpc: StreamRpc, payload: StreamRpc.payloadSchema.make({ id: 1 }) })
            const chunk = yield* makeChunkReply(request)
            yield* storage.saveRequest(request)
            yield* storage.saveReply(chunk)
            yield* storage.saveEnvelope(yield* makeAckChunk(request, chunk))
            yield* storage.saveReply(yield* makeReply(request, cutoff - 1))
            expect(
              yield* storage.deleteProcessed({
                entityType: "test",
                completedBefore: cutoff,
                limit: 100
              })
            ).toEqual(1)
          }))
      }

      it.effect("resetRequests with no IDs leaves existing claims untouched", () =>
        Effect.gen(function*() {
          yield* truncate
          const storage = yield* MessageStorage.MessageStorage
          const request = yield* makeRequest()
          yield* storage.saveRequest(request)
          expect(yield* storage.unprocessedMessages([request.envelope.address.shardId])).toHaveLength(1)
          yield* storage.resetRequests([])
          expect(yield* storage.unprocessedMessages([request.envelope.address.shardId])).toHaveLength(0)
        }))

      it.effect("resetRequests releases only the selected request at a shared address", () =>
        Effect.gen(function*() {
          yield* truncate
          const storage = yield* MessageStorage.MessageStorage
          const selected = yield* makeRequest()
          const unrelated = yield* makeRequest()
          yield* storage.saveRequest(selected)
          yield* storage.saveRequest(unrelated)
          const shards = [selected.envelope.address.shardId]
          expect(yield* storage.unprocessedMessages(shards)).toHaveLength(2)
          yield* storage.resetRequests([selected.envelope.requestId])
          const messages = yield* storage.unprocessedMessages(shards)
          expect(messages.map((message) => message.envelope.requestId)).toEqual([selected.envelope.requestId])
          expect(yield* storage.unprocessedMessages(shards)).toHaveLength(0)
        }))

      it.effect("resetRequests preserves chunk replies, exit replies, and completed state", () =>
        Effect.gen(function*() {
          yield* truncate
          const storage = yield* MessageStorage.MessageStorage
          const streaming = yield* makeRequest({ rpc: StreamRpc, payload: StreamRpc.payloadSchema.make({ id: 123 }) })
          const completed = yield* makeRequest()
          yield* storage.saveRequest(streaming)
          yield* storage.saveRequest(completed)
          const shards = [streaming.envelope.address.shardId]
          expect(yield* storage.unprocessedMessages(shards)).toHaveLength(2)
          yield* storage.saveReply(yield* makeChunkReply(streaming))
          yield* storage.saveReply(yield* makeReply(completed))
          const replies = yield* storage.repliesFor([streaming, completed])
          expect(replies).toHaveLength(2)
          expect(yield* storage.unprocessedMessages(shards)).toHaveLength(0)
          const sql = yield* SqlClient.SqlClient
          const processed = yield* sql`SELECT processed FROM cluster_messages ORDER BY rowid`
          yield* storage.resetRequests([streaming.envelope.requestId, completed.envelope.requestId])
          const messages = yield* storage.unprocessedMessages(shards)
          // Replies keep both requests out of the SQL read loop.
          expect(messages).toHaveLength(0)
          expect(yield* storage.repliesFor([streaming, completed])).toEqual(replies)
          expect(yield* sql`SELECT processed FROM cluster_messages ORDER BY rowid`).toEqual(processed)
          yield* truncate
        }))

      it.effect("clearReplies requeues the request without replaying consumed interrupts", () =>
        Effect.gen(function*() {
          yield* truncate
          const storage = yield* MessageStorage.MessageStorage
          const snowflake = yield* Snowflake.Generator
          const request = yield* makeRequest()
          const reply = yield* makeReply(request)
          const interrupt = () =>
            Message.OutgoingEnvelope.interrupt({
              id: snowflake.nextUnsafe(),
              requestId: request.envelope.requestId,
              address: request.envelope.address
            })
          yield* storage.saveRequest(request)
          yield* storage.saveEnvelope(interrupt())
          yield* storage.saveReply(reply)
          // An interrupt received after completion belongs to the next execution.
          const pending = interrupt()
          yield* storage.saveEnvelope(pending)
          yield* storage.clearReplies(request.envelope.requestId, { expectedReplyId: reply.reply.id })
          // A duplicate reset must not remove that pending interrupt either.
          yield* storage.clearReplies(request.envelope.requestId, { expectedReplyId: reply.reply.id })
          assert.deepStrictEqual(yield* storage.repliesFor([request]), [])
          const messages = yield* storage.unprocessedMessages([request.envelope.address.shardId])
          assert.deepStrictEqual(
            messages.map(({ envelope }) => envelope._tag === "Request" ? envelope.requestId : envelope.id),
            [request.envelope.requestId, pending.envelope.id]
          )
        }))

      it.effect("clearReplies with a stale expected reply preserves a newer completion and processed state", () =>
        Effect.gen(function*() {
          yield* truncate
          const sql = yield* SqlClient.SqlClient
          const storage = yield* MessageStorage.MessageStorage
          const request = yield* makeRequest({ rpc: StreamRpc, payload: StreamRpc.payloadSchema.make({ id: 123 }) })
          const oldReply = yield* makeChunkReply(request)
          const completed = yield* makeReply(request)
          yield* storage.saveRequest(request)
          yield* storage.saveReply(oldReply)
          yield* storage.saveReply(completed)
          const before = yield* sql`SELECT processed, last_reply_id FROM cluster_messages WHERE id = ${
            String(request.envelope.requestId)
          }`.pipe(Effect.provideService(SqlClient.SafeIntegers, true))
          yield* storage.clearReplies(request.envelope.requestId, { expectedReplyId: oldReply.reply.id })
          expect((yield* storage.repliesFor([request])).map((r) => r.id)).toEqual([
            oldReply.reply.id,
            completed.reply.id
          ])
          expect(
            yield* sql`SELECT processed, last_reply_id FROM cluster_messages WHERE id = ${
              String(request.envelope.requestId)
            }`.pipe(Effect.provideService(SqlClient.SafeIntegers, true))
          ).toEqual(before)
          expect(yield* storage.unprocessedMessages([request.envelope.address.shardId])).toHaveLength(0)
          yield* truncate
        }))

      it.effect("deleteProcessed forgets request families completed before the cutoff", () =>
        Effect.gen(function*() {
          yield* truncate
          const sql = yield* SqlClient.SqlClient
          const storage = yield* MessageStorage.MessageStorage
          const snowflake = yield* Snowflake.Generator
          const cutoff = Date.UTC(2026, 0, 1)
          const request = (id: number, entityType?: string) =>
            makeRequest({ rpc: StreamRpc, payload: StreamRpc.payloadSchema.make({ id }), entityType })
          const expired = yield* request(1)
          const recent = yield* request(2)
          const reset = yield* request(3)
          const otherType = yield* request(4, "other")
          for (const r of [expired, recent, reset, otherType]) {
            yield* storage.saveRequest(r)
          }
          const chunk = yield* makeChunkReply(expired)
          yield* storage.saveReply(chunk)
          yield* storage.saveEnvelope(yield* makeAckChunk(expired, chunk))
          yield* storage.saveEnvelope(Message.OutgoingEnvelope.interrupt({
            id: snowflake.nextUnsafe(),
            requestId: expired.envelope.requestId,
            address: expired.envelope.address
          }))
          yield* storage.saveReply(yield* makeReply(expired, cutoff - 1))
          yield* storage.saveReply(yield* makeReply(recent, cutoff + 1))
          yield* storage.saveReply(yield* makeReply(reset, cutoff - 2))
          yield* storage.clearReplies(reset.envelope.requestId)
          yield* storage.saveReply(yield* makeReply(otherType, cutoff - 3))

          const deleted = yield* storage.deleteProcessed({ entityType: "test", completedBefore: cutoff, limit: 100 })
          expect(deleted).toEqual(1)

          const expiredId = String(expired.envelope.requestId)
          expect(yield* sql`SELECT id FROM cluster_messages WHERE request_id = ${expiredId}`).toEqual([])
          expect(yield* sql`SELECT id FROM cluster_replies WHERE request_id = ${expiredId}`).toEqual([])
          expect((yield* storage.saveRequest(yield* request(1)))._tag).toEqual("Success")
          for (const [id, kept] of [[2, recent], [3, reset], [4, otherType]] as const) {
            const result = yield* storage.saveRequest(yield* request(id, kept.envelope.address.entityType))
            expect(result._tag).toEqual("Duplicate")
          }
          expect(yield* storage.repliesForUnfiltered([recent.envelope.requestId, otherType.envelope.requestId]))
            .toHaveLength(2)
        }).pipe(Effect.ensuring(Effect.orDie(truncate))))

      it.effect("does not store an AckChunk or Interrupt for a request deleteProcessed removed", () =>
        Effect.gen(function*() {
          yield* truncate
          const sql = yield* SqlClient.SqlClient
          const storage = yield* MessageStorage.MessageStorage
          const snowflake = yield* Snowflake.Generator
          const cutoff = Date.UTC(2026, 0, 1)
          const request = yield* makeRequest({ rpc: StreamRpc, payload: StreamRpc.payloadSchema.make({ id: 1 }) })
          const chunk = yield* makeChunkReply(request)
          yield* storage.saveRequest(request)
          yield* storage.saveReply(chunk)
          yield* storage.saveReply(yield* makeReply(request, cutoff - 1))
          expect(yield* storage.deleteProcessed({ entityType: "test", completedBefore: cutoff, limit: 100 }))
            .toEqual(1)

          // a late acknowledgement and cancellation, such as ones that waited behind the delete
          yield* storage.saveEnvelope(yield* makeAckChunk(request, chunk))
          yield* storage.saveEnvelope(Message.OutgoingEnvelope.interrupt({
            id: snowflake.nextUnsafe(),
            requestId: request.envelope.requestId,
            address: request.envelope.address
          }))
          expect(yield* storage.unprocessedMessages([request.envelope.address.shardId])).toEqual([])
          const requestId = String(request.envelope.requestId)
          expect(yield* sql`SELECT id FROM cluster_messages WHERE request_id = ${requestId}`).toEqual([])
        }).pipe(Effect.ensuring(Effect.orDie(truncate))))

      it.effect("deleteProcessed takes an unbounded, extreme or fractional cutoff", () =>
        Effect.gen(function*() {
          yield* truncate
          const storage = yield* MessageStorage.MessageStorage
          const completedAt = Date.UTC(2026, 0, 1)
          for (let id = 1; id <= 6; id++) {
            const request = yield* makeRequest({ payload: { id } })
            yield* storage.saveRequest(request)
            yield* storage.saveReply(yield* makeReply(request, completedAt + id - 1))
          }
          // completed before the Snowflake epoch, so its reply id is negative
          const preEpoch = yield* makeRequest({ payload: { id: 0 } })
          yield* storage.saveRequest(preEpoch)
          yield* storage.saveReply(yield* makeReply(preEpoch, Snowflake.constEpochMillis - 1))
          const makeRunning = makeRequest({
            rpc: PrimaryKeyTest,
            payload: PrimaryKeyTest.payloadSchema.make({ id: 7 })
          })
          // still running, so never eligible
          yield* storage.saveRequest(yield* makeRunning)
          const deleteProcessed = (completedBefore: number) =>
            storage.deleteProcessed({ entityType: "test", completedBefore, limit: 2 })
          // MessageRetention's cutoffs for an infinite, huge, sub-millisecond,
          // negative huge and negative infinite retention
          expect(yield* deleteProcessed(-Infinity)).toEqual(0)
          expect(yield* deleteProcessed(-Number.MAX_VALUE)).toEqual(0)
          expect(yield* deleteProcessed(Snowflake.constEpochMillis)).toEqual(1)
          expect(yield* deleteProcessed(completedAt + 0.5)).toEqual(1)
          expect(yield* deleteProcessed(Number.MAX_VALUE)).toEqual(2)
          expect(yield* deleteProcessed(Infinity)).toEqual(2)
          expect(yield* deleteProcessed(Infinity)).toEqual(1)
          const running = yield* storage.saveRequest(yield* makeRunning)
          expect(running._tag).toEqual("Duplicate")
        }).pipe(Effect.ensuring(Effect.orDie(truncate))))

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
          const encoded = yield* SqlMessageStorage.makeEncoded().pipe(Effect.provide(NodeCrypto.layerDigest))
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
          const encoded = yield* SqlMessageStorage.makeEncoded().pipe(Effect.provide(NodeCrypto.layerDigest))
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
          const request = yield* makeRequest({
            rpc: StreamRpc,
            payload: StreamRpc.payloadSchema.make({ id: 123 })
          })
          yield* storage.saveRequest(request)
          let messages = yield* storage.unprocessedMessagesById([request.envelope.requestId])
          expect(messages).toHaveLength(1)

          const chunk = yield* makeChunkReply(request)
          yield* storage.saveReply(chunk)
          const ack = yield* makeAckChunk(request, chunk)
          yield* storage.saveEnvelope(ack)

          const encoded = yield* SqlMessageStorage.makeEncoded().pipe(Effect.provide(NodeCrypto.layerDigest))
          const acknowledgements = yield* encoded.unprocessedMessagesById([ack.envelope.id], 0)
          expect(acknowledgements).toHaveLength(1)
          assert(acknowledgements[0].envelope._tag === "AckChunk")
          expect(acknowledgements[0].envelope.replyId).toEqual(String(chunk.reply.id))

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

const NumberSqliteLayer = Layer.effect(
  SqlClient.SqlClient,
  Effect.gen(function*() {
    const sqlite = yield* SqliteClient.make({ filename: ":memory:" })
    const connection = yield* sqlite.reserve
    // Model drivers such as Durable Objects that return INTEGERs as numbers, even with SafeIntegers.
    const roundRows = (rows: ReadonlyArray<Record<string, unknown>>) =>
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value])
        )
      )
    return yield* SqlClient.make({
      driver: "sqlite-number",
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [],
      acquirer: Effect.succeed({
        ...connection,
        execute: (...args) => connection.execute(...args).pipe(Effect.map(roundRows)),
        executeUnprepared: (...args) => connection.executeUnprepared(...args).pipe(Effect.map(roundRows))
      })
    })
  })
).pipe(Layer.provide(Reactivity.layer))
