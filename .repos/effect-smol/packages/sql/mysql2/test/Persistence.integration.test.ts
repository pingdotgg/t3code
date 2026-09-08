import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as PersistedCacheTest from "effect-test/unstable/persistence/PersistedCacheTest"
import * as PersistedQueueTest from "effect-test/unstable/persistence/PersistedQueueTest"
import * as SqlCleanupTest from "effect-test/unstable/persistence/SqlCleanupTest"
import { TestClock } from "effect/testing"
import { PersistedQueue, Persistence } from "effect/unstable/persistence"
import { SqlClient } from "effect/unstable/sql"
import { MysqlContainer } from "./utils.ts"

it.layer(MysqlContainer.layerClient, { timeout: "90 seconds" })("Persistence", (it) => {
  PersistedCacheTest.suiteWith("sql-mysql2-multi", Persistence.layerSqlMultiTable, it)

  PersistedCacheTest.suiteWith("sql-mysql2-single", Persistence.layerSql, it)

  PersistedQueueTest.suiteWith("sql-mysql2", PersistedQueue.layerStoreSql(), it)

  it.effect("deletes expired entries in batches", () =>
    Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const table = sql("effect_persistence")
      const expiredCount = sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM ${table} WHERE store_id = 'expired'
      `.pipe(Effect.map((rows) => Number(rows[0].count)))
      // Reset the table left by the single-table cache suite so cleanup builds its own schema and index.
      yield* sql`DROP TABLE IF EXISTS ${table}`
      yield* sql`
        CREATE TABLE ${table} (
          store_id VARCHAR(191) NOT NULL,
          id VARCHAR(191) NOT NULL,
          value TEXT NOT NULL,
          expires BIGINT,
          PRIMARY KEY (store_id, id)
        )
      `

      const entries = Array.from({ length: SqlCleanupTest.expiredEntryCount }, (_, i) => ({
        store_id: "expired",
        id: String(i),
        value: "{}",
        expires: SqlCleanupTest.expiredAtEpoch
      }))
      yield* sql`INSERT INTO ${table} ${sql.insert(entries)}`.unprepared
      yield* sql`
        INSERT INTO ${table} (store_id, id, value, expires)
        VALUES ('live', 'live', '{}', NULL), ('live', 'future', '{}', ${SqlCleanupTest.futureExpiresAt})
      `

      yield* Layer.build(Persistence.layerBackingSql).pipe(TestClock.withLive)

      const expired = yield* SqlCleanupTest.waitForCount(expiredCount, (count) => count === 0)
      assert.strictEqual(expired, 0)
      const live = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM ${table} WHERE store_id = 'live'
      `
      assert.strictEqual(Number(live[0].count), 2)

      const indexes = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'effect_persistence'
          AND index_name = 'effect_persistence_expires_idx'
      `
      assert.strictEqual(Number(indexes[0].count), 1)
    }), { timeout: SqlCleanupTest.testTimeout })
})
