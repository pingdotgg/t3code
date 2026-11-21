import { PgliteClient } from "@effect/sql-pglite"
import { assert, describe, layer } from "@effect/vitest"
import { Effect } from "effect"
import { PersistedQueue } from "effect/persistence"
import { SqlClient } from "effect/sql"

const ClientLayer = PgliteClient.layer({})

describe("PersistedQueue SQL migrations", () => {
  layer(ClientLayer, { timeout: "30 seconds" })((it) => {
    it.effect("runs fresh-install migrations once", () =>
      Effect.gen(function*() {
        const sql = (yield* SqlClient.SqlClient).withoutTransforms()
        const tableName = "PersistedQueue_migration_test"

        yield* PersistedQueue.makeStoreSql({ tableName })
        const store = yield* PersistedQueue.makeStoreSql({ tableName })

        const migrations = yield* sql<{
          readonly migration_id: number
          readonly name: string
        }>`SELECT migration_id, name FROM ${sql(`${tableName}_migrations`)} ORDER BY migration_id`
        assert.deepStrictEqual(migrations, [
          { migration_id: 1, name: "create_table" },
          { migration_id: 2, name: "upgrade_schema" },
          { migration_id: 3, name: "widen_sequence" }
        ])

        const indexes = yield* sql<{ readonly indexname: string }>`
          SELECT indexname FROM pg_indexes
          WHERE tablename = ${tableName}
          ORDER BY indexname
        `
        assert.deepStrictEqual(indexes.map((row) => row.indexname), [
          `${tableName}_pkey`,
          `idx_${tableName}_id`,
          `idx_${tableName}_take`,
          `idx_${tableName}_update`
        ])

        yield* sql`SELECT setval(pg_get_serial_sequence(${`"${tableName}"`}, 'sequence'), 2147483647)`
        yield* store.offer({ name: "test", id: "boundary", element: "value", isCustomId: true })
        const rows = yield* sql<{ readonly sequence: string }>`SELECT sequence::text FROM ${sql(tableName)}`
        assert.deepStrictEqual(rows, [{ sequence: "2147483648" }])
      }))
  })
})
