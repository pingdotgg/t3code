import { assert, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Latch, Layer, Schema } from "effect"
import * as PersistedCacheTest from "effect-test/unstable/persistence/PersistedCacheTest"
import * as PersistedQueueTest from "effect-test/unstable/persistence/PersistedQueueTest"
import { TestClock } from "effect/testing"
import { PersistedQueue, Persistence } from "effect/unstable/persistence"
import { SqlClient } from "effect/unstable/sql"
import { PgContainer } from "./utils.ts"

PersistedCacheTest.suite(
  "sql-pg-multi",
  Persistence.layerSqlMultiTable.pipe(Layer.provide(PgContainer.layerClient))
)

PersistedCacheTest.suite(
  "sql-pg-single",
  Persistence.layerSql.pipe(Layer.provide(PgContainer.layerClient))
)

PersistedQueueTest.suite(
  "sql-pg",
  PersistedQueue.layerStoreSql().pipe(Layer.provide(PgContainer.layerClient))
)

it.layer(PgContainer.layerClient, { timeout: "30 seconds" })("PersistedQueue SQL locks", (it) => {
  it.effect("refreshes locks for acquired elements", () =>
    Effect.gen(function*() {
      const options = {
        tableName: "effect_queue_lock_refresh",
        pollInterval: "10 millis",
        lockRefreshInterval: "100 millis",
        lockExpiration: "1 second"
      } as const
      const store1 = yield* PersistedQueue.makeStoreSql(options)
      const store2 = yield* PersistedQueue.makeStoreSql(options)
      const element = { message: "hello" }

      yield* store1.offer({
        name: "lock-refresh",
        id: crypto.randomUUID(),
        element,
        isCustomId: false
      })

      const acquired = Latch.makeUnsafe()
      const first = yield* Effect.scoped(Effect.gen(function*() {
        yield* store1.take({ name: "lock-refresh", maxAttempts: 10 })
        yield* acquired.open
        return yield* Effect.never
      })).pipe(Effect.forkScoped)

      yield* acquired.await

      const second = yield* Effect.scoped(
        store2.take({ name: "lock-refresh", maxAttempts: 10 })
      ).pipe(Effect.forkScoped)

      yield* Effect.sleep("1500 millis")
      assert.isUndefined(second.pollUnsafe())

      yield* Fiber.interrupt(first)
      const received = yield* Fiber.join(second)
      assert.deepStrictEqual(received.element, element)
    }).pipe(TestClock.withLive))

  it.effect("counts malformed JSON as an attempt and continues", () =>
    Effect.gen(function*() {
      const tableName = "effect_queue_invalid_json"
      const store = yield* PersistedQueue.makeStoreSql({
        tableName,
        pollInterval: "10 millis"
      })
      const factory = yield* PersistedQueue.makeFactory.pipe(
        Effect.provideService(PersistedQueue.PersistedQueueStore, store)
      )
      const queue = yield* factory.make({
        name: "invalid-json",
        schema: Schema.String
      })
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const table = sql(tableName)
      const poisonId = crypto.randomUUID()

      yield* store.offer({
        name: "invalid-json",
        id: poisonId,
        element: "poison",
        isCustomId: false
      })
      yield* sql`UPDATE ${table} SET element = ${"{"} WHERE id = ${poisonId}`
      yield* queue.offer("valid")

      const malformed = yield* Effect.exit(queue.take(Effect.succeed, { maxAttempts: 1 }))
      assert.isTrue(Exit.isFailure(malformed))

      const rows = yield* sql<{
        readonly attempts: number
        readonly last_failure: string | null
      }>`SELECT attempts, last_failure FROM ${table} WHERE id = ${poisonId}`
      assert.strictEqual(rows[0].attempts, 1)
      assert.isNotNull(rows[0].last_failure)

      const value = yield* queue.take(Effect.succeed, { maxAttempts: 1 })
      assert.strictEqual(value, "valid")
    }).pipe(TestClock.withLive))
})
